// OptChat memory plugin: store, import, and the plugin on the real DSH agent loop.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { closeNamespace, contextSource, openNamespace } from '../src/optchat/core.js'
import { importStore } from '../src/optchat/import.js'
import { buildAll } from '../src/optchat/summarize.js'
import { HISTORY_KIND, install } from '../src/optchat/plugin.js'

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function oldStore(dir, count) {
  mkdirSync(join(dir, 'main'), { recursive: true })
  mkdirSync(join(dir, 'tree'), { recursive: true })
  const rows = []
  for (let i = 0; i < count; i += 1) {
    const kind = i % 2 === 0 ? 'user' : 'talk'
    const text = `message ${i} ${i === 5 ? 'pineapple squat' : 'plain'}`
    rows.push({ i, kind, text, size: Buffer.byteLength(`${kind}: ${text}`), date: `2026-10-0${1 + (i % 3)}T10:00:0${i % 10}+07:00`, metadata: { chat_id: 'c1', message_id: String(100 + i) } })
  }
  writeFileSync(join(dir, 'main', '2026-10-01.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const leaf = i => ({ l: 0, i, text: `L${i}`, size: Buffer.byteLength(`L${i}`) })
  writeFileSync(join(dir, 'tree', '2026-10-01.jsonl'), [leaf(0), leaf(1), { l: 1, i: 0, text: 'P0', size: 2 }].map(row => JSON.stringify(row)).join('\n') + '\n')
  return rows
}

test('import keeps kind, date and provenance, and a second run adds nothing', t => {
  const root = temp(t)
  const rows = oldStore(join(root, 'src'), 8)
  const before = readFileSync(join(root, 'src', 'main', '2026-10-01.jsonl'), 'utf8')
  const dir = join(root, 'ns', 'bot-a')
  let ns = openNamespace(dir)
  const first = importStore(ns, join(root, 'src'), { label: 'optchat:test' })
  assert.deepEqual([first.source, first.added, first.skipped, first.aligned, first.nodes], [8, 8, 0, true, 3])
  closeNamespace(dir)
  ns = openNamespace(dir)
  const second = importStore(ns, join(root, 'src'), { label: 'optchat:test' })
  assert.deepEqual([second.added, second.skipped, second.nodes], [0, 8, 0])
  assert.equal(ns.events.length, 8)
  for (const row of rows) {
    const event = ns.events[row.i]
    assert.deepEqual([event.kind, event.text, event.date], [row.kind, row.text, row.date])
    assert.equal(event.metadata.message_id, row.metadata.message_id)
    assert.equal(event.metadata.import_source, 'optchat:test')
    assert.equal(event.metadata.import_id, String(row.i))
  }
  assert.equal(readFileSync(join(root, 'src', 'main', '2026-10-01.jsonl'), 'utf8'), before, 'source untouched')
  closeNamespace(dir)
})

test('search finds the exact message and zoom opens the same source', t => {
  const root = temp(t)
  oldStore(join(root, 'src'), 8)
  const dir = join(root, 'ns', 'bot-a')
  const ns = openNamespace(dir)
  t.after(() => closeNamespace(dir))
  importStore(ns, join(root, 'src'))
  const [hit] = ns.search('PINEAPPLE squat')
  assert.equal(hit.id, 5)
  assert.equal(ns.zoom(5, 1), `5+0|${contextSource(ns.events[5])}`)
  assert.match(ns.zoom(5, 1), /talk: \[source \{"chat_id":"c1"\}\] message 5 pineapple squat/)
  assert.equal(ns.zoom(0, 2), '0+1|L0\n1+1|L1')
  assert.throws(() => ns.zoom(4, 2), /not been summarized/)
  assert.throws(() => ns.zoom(3, 2), /No aligned binary range/)
})

test('a failing summarizer keeps every transcript record, and a later run completes the tree', async t => {
  const dir = join(temp(t), 'bot-a')
  const ns = openNamespace(dir)
  t.after(() => closeNamespace(dir))
  const long = 'x'.repeat(900)
  for (let i = 0; i < 4; i += 1) ns.append('user', `${long} ${i}`)
  await assert.rejects(buildAll(ns, async () => { throw new Error('model down') }, { nodeBytes: 256 }), /model down/)
  assert.equal(ns.nodes.size, 0)
  assert.equal(ns.events.length, 4)
  const lines = readdirSync(join(dir, 'main')).flatMap(name => readFileSync(join(dir, 'main', name), 'utf8').trim().split('\n'))
  assert.equal(lines.length, 4)
  assert.equal(await buildAll(ns, async (_text, bytes) => 's'.repeat(Math.min(bytes, 20)), { nodeBytes: 256 }), 7)
  closeNamespace(dir)
  const reopened = openNamespace(dir)
  assert.deepEqual([reopened.events.length, reopened.nodes.size], [4, 7])
})

// --- The plugin on the real DSH agent loop ---------------------------------------

async function boot(t, { failSummary = false, replaceAfterBytes = 400 } = {}) {
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  const requests = []
  class Mock extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(req) {
      const summary = typeof req.system === 'string' && req.system.startsWith('Summarize')
      if (!summary) requests.push(req.messages)
      if (summary && failSummary) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER', message: 'summary model down' } } }
        return
      }
      const text = summary ? `sum(${req.messages[0].content[0].text.length})` : `reply ${'r'.repeat(120)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['mock'], new Mock())
  await mountAgentLoopTestHarness(root)
  const owners = new Map()
  const listeners = new Set()
  const identity = {
    ownerOfSession: id => owners.get(id),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set(id, owner) { owners.set(id, owner); for (const listener of listeners) listener() },
  }
  const dir = temp(t)
  const handle = install(root, {
    root: dir,
    route: { provider: 'mock', model: 'm' },
    bots: { 'bot-a': true, 'bot-b': true },
    limits: { replaceAfterBytes, keepTurns: 1, nodeBytes: 256, retryMs: 60_000 },
  }, { identity, llm: root.llm, warn: () => {} })
  t.after(async () => { await handle.dispose(); await root.fiber.dispose() })
  const turn = async (agent, text) => {
    const done = new Promise(resolve => {
      const off = root.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
  }
  const agent = id => root.agentLoop.create(SessionId(id), { provider: 'mock', model: 'm' })
  return { root, identity, handle, dir, requests, turn, agent }
}

test('real loop: each Bot writes only its own namespace; unknown, conflicting or opted-out Sessions write nothing', async t => {
  const { identity, handle, turn, agent } = await boot(t)
  identity.set('a1', { botId: 'bot-a' })
  identity.set('a2', { botId: 'bot-a', roomId: 'room-1' })
  identity.set('b1', { botId: 'bot-b' })
  identity.set('c1', { botId: 'bot-c' })
  const [a1, a2, b1, c1, u1] = await Promise.all(['a1', 'a2', 'b1', 'c1', 'u1'].map(agent))
  await turn(a1, 'alpha secret one')
  await turn(a2, 'alpha in the group')
  await turn(b1, 'bravo secret two')
  await turn(c1, 'charlie not opted in')
  await turn(u1, 'unknown owner text')
  const a = handle.space('bot-a')
  const b = handle.space('bot-b')
  assert.deepEqual(a.events.map(event => event.kind), ['user', 'talk', 'user', 'talk'])
  assert.equal(a.events[2].metadata.room_id, 'room-1')
  assert.equal(a.events[0].metadata.session_id, 'a1')
  assert.deepEqual(b.events.map(event => event.text.slice(0, 16)), ['bravo secret two', 'reply rrrrrrrrrr'])
  assert.equal(a.search('bravo').length, 0)
  assert.equal(b.search('alpha').length, 0)
  assert.equal(handle.pending.get('u1')?.length, 2, 'unknown owner: held, not written')
  // Ownership resolved later flushes what was held, once.
  identity.set('u1', { botId: 'bot-b' })
  assert.equal(handle.pending.has('u1'), false)
  assert.equal(b.search('unknown owner').length, 1)
  identity.set('u1', { botId: 'bot-b' })
  assert.equal(b.events.length, 4)
})

test('real loop: tools answer from the caller\'s own namespace only', async t => {
  const { root, identity, turn, agent } = await boot(t)
  identity.set('a1', { botId: 'bot-a' })
  identity.set('b1', { botId: 'bot-b' })
  const [a1, b1] = await Promise.all(['a1', 'b1'].map(agent))
  await turn(a1, 'alpha mango')
  await turn(b1, 'bravo kiwi')
  const search = root.tools.get('optchat_search')
  const zoom = root.tools.get('optchat_zoom')
  assert.match(await search.execute({ query: 'mango' }, { agent: a1 }), /^0 \[.*\] user: alpha mango/)
  assert.equal(await search.execute({ query: 'mango' }, { agent: b1 }), 'No message has all of those words.')
  assert.match(await zoom.execute({ id: 0 }, { agent: b1 }), /^0\+0\|user: bravo kiwi\ndate: /)
  assert.equal(await search.execute({ query: 'mango' }, { agent: { id: 'nobody' } }), 'OptChat memory is not on for this Session.')
})

test('real loop: old turns are replaced on the surface by the summary view; the model sees it; the transcript keeps everything', async t => {
  const { identity, handle, turn, agent, requests } = await boot(t)
  identity.set('a1', { botId: 'bot-a' })
  const a1 = await agent('a1')
  for (let k = 0; k < 4; k += 1) {
    await turn(a1, `turn ${k} ${'w'.repeat(150)}`)
    await handle.idle()
  }
  const replacements = a1.session.snapshotEvents().filter(event => typeof event.surfaceOp === 'object')
  assert.ok(replacements.length >= 1, 'a replacement landed')
  const last = replacements.at(-1)
  assert.equal(last.data.source.kind, HISTORY_KIND)
  assert.match(last.data.content[0].text, /^\[OptChat memory: this Bot's transcript, messages 0-/)
  // Every shadowed surface node is cited.
  for (let seq = last.surfaceOp.startSeq; seq <= last.surfaceOp.endSeq; seq += 1) {
    if (a1.session.surface.nodes.includes(seq)) assert.fail('shadowed node still visible')
  }
  const seen = requests.at(-1).map(message => message.content.map(block => block.text ?? '').join(''))
  assert.ok(seen.some(text => text.startsWith('[OptChat memory')), 'model received the summary view')
  assert.ok(!seen.some(text => text.startsWith('turn 0 ')), 'turn 0 is no longer verbatim on the surface')
  assert.ok(seen.some(text => text.startsWith('turn 3 ')), 'the newest turn stays verbatim')
  // The transcript still holds every original message, and zoom returns it.
  const ns = handle.space('bot-a')
  assert.deepEqual(ns.events.filter(event => event.kind === 'user').map(event => event.text.slice(0, 6)), ['turn 0', 'turn 1', 'turn 2', 'turn 3'])
  assert.match(ns.zoom(0, 1), /^0\+0\|user: turn 0 w+$/)
})

test('real loop: with a failing summarizer nothing is replaced and the transcript is whole', async t => {
  const { identity, handle, turn, agent, requests } = await boot(t, { failSummary: true })
  identity.set('a1', { botId: 'bot-a' })
  const a1 = await agent('a1')
  // Longer than a leaf (256 bytes), so even leaves need the failing summarizer.
  for (let k = 0; k < 4; k += 1) {
    await turn(a1, `turn ${k} ${'w'.repeat(400)}`)
    await handle.idle()
  }
  assert.match(String(handle.errors.get('bot-a')?.message), /summary model down|stayed over/)
  assert.equal(a1.session.snapshotEvents().filter(event => typeof event.surfaceOp === 'object').length, 0)
  const seen = requests.at(-1).map(message => message.content.map(block => block.text ?? '').join(''))
  assert.ok(seen.some(text => text.startsWith('turn 0 ')), 'history stays verbatim')
  const ns = handle.space('bot-a')
  assert.equal(ns.events.length, 8)
  assert.equal(ns.has({ l: 0, i: 0 }), false, 'the over-size leaf stays unbuilt')
  assert.match(ns.zoom(0, 1), /^0\+0\|user: turn 0 w{400}$/)
})
