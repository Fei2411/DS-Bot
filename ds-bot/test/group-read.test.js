import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const messages = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => {
  const seq = first + index
  return { who: 'User', text: `message-${seq}.`, seq }
})
const cursorOf = (value) => {
  const match = /Next read: after_seq=(\d+)/.exec(value)
  assert.ok(match, 'the result must tell the caller where to continue')
  return Number(match[1])
}

async function start(t, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-read-'))
  const contexts = []
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    bots: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { id, name: id, sessionId: id, createdAt: 1 }])),
    rooms: {
      r1: { id: 'r1', name: 'Ops', named: true, members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {}, ...room },
      r2: { id: 'r2', name: 'Other', named: true, members: ['c'], sessions: { c: 'gc' }, log: messages(1, 1), seq: 1 },
    },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  t.after(async () => {
    for (const ctx of contexts) await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const boot = async () => {
    const ctx = fakeContext()
    Object.assign(ctx, {
      llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined },
      sessionController: { resolveAgent: async id => ({ agent: ctx.scopeAgent(id) }) },
      sessions: { flush: async () => {} },
    })
    contexts.push(ctx)
    const rt = createRuntime(ctx, { home })
    await rt.load()
    const read = (args = {}, sessionId = 'a') => rt.teamTools.find(tool => tool.name === 'read_group_chat')
      .execute({ group: 'Ops', ...args }, { agent: { id: sessionId } })
    return { rt, read, restart: async () => { await rt.save(); await ctx.dispose(); return boot() } }
  }
  return boot()
}

test('a default group read keeps the latest thirty messages and gives a continuation cursor', async (t) => {
  const host = await start(t, { log: messages(1, 40), seq: 40 })
  const read = await host.read()
  assert.match(read, /^Latest in "Ops" \(oldest first\):\nUser: message-11\./)
  assert.doesNotMatch(read, /message-10\./)
  assert.match(read, /message-40\./)
  assert.equal(cursorOf(read), 40)
})

test('reusing a group cursor returns no old message bodies', async (t) => {
  const host = await start(t, { log: messages(1, 3), seq: 3, seen: { b: 1 } })
  const read = await host.read({ after_seq: 3 })
  assert.match(read, /No new messages/)
  assert.doesNotMatch(read, /message-/)
  assert.equal(cursorOf(read), 3)
  assert.deepEqual(host.rt.state.rooms.r1.seen, { b: 1 })
})

test('group readers keep independent cursors while new lines arrive', async (t) => {
  const host = await start(t, { log: messages(1, 3), seq: 3 })
  const before = cursorOf(await host.read())
  host.rt.logRoom(host.rt.state.rooms.r1, { who: 'User', text: 'message-4.' })
  const next = await host.read({ after_seq: before })
  assert.match(next, /message-4\./)
  assert.doesNotMatch(next, /message-[123]\./)
  assert.equal(cursorOf(next), 4)
  const other = await host.read({ after_seq: 1 }, 'b')
  assert.match(other, /message-2\./)
  assert.match(other, /message-3\./)
  assert.match(other, /message-4\./)
  assert.doesNotMatch(other, /message-1\./)
  assert.deepEqual(host.rt.state.rooms.r1.seen, {})
})

test('incremental group reads page from the oldest unread line without skipping updates', async (t) => {
  for (const count of [31, 60]) {
    await t.test(`${count} unread messages`, async (t) => {
      const host = await start(t, { log: messages(1, count), seq: count })
      const first = await host.read({ after_seq: 0 })
      assert.match(first, /message-1\./)
      assert.match(first, /message-30\./)
      assert.doesNotMatch(first, /message-31\./)
      assert.match(first, /More messages/)
      assert.equal(cursorOf(first), 30)
      const second = await host.read({ after_seq: cursorOf(first) })
      assert.match(second, /message-31\./)
      assert.match(second, new RegExp(`message-${count}\\.`))
      assert.doesNotMatch(second, /message-30\./)
      assert.doesNotMatch(second, /More messages/)
      assert.equal(cursorOf(second), count)
    })
  }
})

test('new group messages between pages are read after the previous page cursor', async (t) => {
  const host = await start(t, { log: messages(1, 31), seq: 31 })
  const first = await host.read({ after_seq: 0 })
  host.rt.logRoom(host.rt.state.rooms.r1, { who: 'User', text: 'message-32.' })
  const second = await host.read({ after_seq: cursorOf(first) })
  assert.match(second, /message-31\./)
  assert.match(second, /message-32\./)
  assert.doesNotMatch(second, /message-30\./)
  assert.equal(cursorOf(second), 32)
})

test('a group write during a read is either returned or left after its cursor', async (t) => {
  const host = await start(t, { log: messages(1, 2), seq: 2 })
  const pending = host.read({ after_seq: 2 })
  host.rt.logRoom(host.rt.state.rooms.r1, { who: 'User', text: 'message-3.' })
  const first = await pending
  const next = await host.read({ after_seq: cursorOf(first) })
  assert.equal([first, next].filter(read => /message-3\./.test(read)).length, 1)
  assert.equal(cursorOf(next), 3)
})

test('an expired group cursor names the missing range and still pages the retained lines', async (t) => {
  const host = await start(t, { log: messages(41, 100), seq: 100 })
  const first = await host.read({ after_seq: 10 })
  assert.match(first, /11[–-]40.*no longer.*latest 60/)
  assert.match(first, /message-41\./)
  assert.match(first, /message-70\./)
  assert.doesNotMatch(first, /message-71\./)
  assert.equal(cursorOf(first), 70)
  const second = await host.read({ after_seq: 70 })
  assert.doesNotMatch(second, /no longer/)
  assert.match(second, /message-71\./)
  assert.match(second, /message-100\./)
  assert.equal(cursorOf(second), 100)
})

test('empty group reads return a usable zero cursor', async (t) => {
  const host = await start(t)
  assert.equal(cursorOf(await host.read()), 0)
  const read = await host.read({ after_seq: 0 })
  assert.match(read, /No new messages/)
  assert.equal(cursorOf(read), 0)
})

test('invalid group cursors are rejected before any history is returned', async (t) => {
  const host = await start(t, { log: messages(1, 2), seq: 2 })
  for (const after_seq of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    const read = await host.read({ after_seq })
    assert.match(read, /after_seq must be a non-negative safe integer/)
    assert.doesNotMatch(read, /message-/)
  }
  for (const after_seq of [1.5, '1', null, NaN, Infinity]) {
    await assert.rejects(async () => host.read({ after_seq }), { code: 'INVALID_ARGS' })
  }
})

test('a group cursor cannot be combined with a single-message read', async (t) => {
  const host = await start(t, { log: messages(1, 2), seq: 2 })
  const read = await host.read({ seq: 1, after_seq: 0 })
  assert.match(read, /either seq or after_seq, not both/)
  assert.doesNotMatch(read, /message-/)
})

test('a cursor ahead of the group offers recovery instead of silently skipping future lines', async (t) => {
  const host = await start(t, { log: messages(1, 2), seq: 2 })
  const read = await host.read({ after_seq: 100 })
  assert.match(read, /ahead.*latest seq 2/)
  assert.match(read, /without after_seq/)
  assert.doesNotMatch(read, /message-/)
})

test('incremental reads keep the long-line limit and single-seq full reads', async (t) => {
  const long = `start-${'x'.repeat(21_000)}-end`
  const host = await start(t, { log: [{ who: 'User', text: long, seq: 1 }], seq: 1 })
  const read = await host.read({ after_seq: 0 })
  assert.match(read, /start-/)
  assert.match(read, /cut; 21010 characters in all; read_group_chat with seq 1 reads it whole/)
  assert.ok(read.length < 2300)
  assert.equal(cursorOf(read), 1)
  const whole = await host.read({ seq: 1 })
  assert.match(whole, /^User: start-/)
  assert.ok(whole.length > 20_000 && whole.length < 20_200)
  assert.doesNotMatch(whole, /Next read:/)
})

test('textless group events advance the cursor and keep their meaning', async (t) => {
  const host = await start(t, {
    log: [{ who: 'b', botId: 'b', kind: 'stopped', seq: 1 }, ...messages(2, 2)],
    seq: 2,
  })
  const read = await host.read({ after_seq: 0 })
  assert.match(read, /\[The user stopped b's work here\]/)
  assert.match(read, /message-2\./)
  assert.equal(cursorOf(read), 2)
})

test('incremental reads enforce the same group visibility as other reads', async (t) => {
  const host = await start(t, { log: messages(1, 1), seq: 1 })
  assert.match(await host.read({ after_seq: 0 }, 'b'), /message-1\./)
  assert.match(await host.read({ group: 'Other', after_seq: 0 }), /message-1\./)
  assert.match(await host.read({ after_seq: 0 }, 'c'), /No group chat called "Ops" that you can see/)
  assert.match(await host.read({ after_seq: 0 }, 'outsider'), /Only Bots on the team/)
})

test('the group cursor continues after a runtime restart', async (t) => {
  const host = await start(t, { log: messages(1, 3), seq: 3 })
  const before = cursorOf(await host.read())
  host.rt.logRoom(host.rt.state.rooms.r1, { who: 'User', text: 'message-4.' })
  const again = await host.restart()
  const read = await again.read({ after_seq: before })
  assert.match(read, /message-4\./)
  assert.doesNotMatch(read, /message-[123]\./)
  assert.equal(cursorOf(read), 4)
})

test('unversioned group logs gain sequence numbers before incremental reads', async (t) => {
  const host = await start(t, { log: [{ who: 'User', text: 'legacy-one' }, { who: 'User', text: 'legacy-two' }], seq: undefined })
  const read = await host.read({ after_seq: 1 })
  assert.doesNotMatch(read, /legacy-one/)
  assert.match(read, /legacy-two/)
  assert.equal(cursorOf(read), 2)
})
