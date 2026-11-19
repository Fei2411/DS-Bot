import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function setup(eventsConfig = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-events-tools-'))
  const privDir = join(home, 'priv-dir')
  mkdirSync(privDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
      w1: { id: 'w1', sessionId: 'w1', name: 'Dev', role: 'Engineer', instructions: '', createdAt: 2 },
      p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', instructions: '', createdAt: 3, private: true, workDir: privDir },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext()
  const delivered = []
  ctx.sessionController = {
    resolveAgent: async (sessionId) => ({
      agent: {
        id: sessionId,
        status: 'idle',
        session: { id: sessionId },
        followup(msg) { delivered.push({ sessionId, msg }) },
        steer(msg) { delivered.push({ sessionId, msg }) },
      },
    }),
  }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { get: () => undefined }

  const rt = createRuntime(ctx, { home, events: { disableTimers: true, ...eventsConfig } })
  return {
    home,
    rt,
    delivered,
    async cleanup() {
      await rt.eventPush.stop()
      await rt.ledger.flush()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('Bot watch/list_watches/read_event/unwatch tools work end-to-end with private isolation', async () => {
  const env = setup()
  try {
    await env.rt.load()
    const tool = name => env.rt.teamTools.find(t => t.name === name)
    const watchReply = await tool('watch').execute({
      name: 'Track release',
      thread_key: 'github:Fei2411/DS-Bot#99',
      mandate: 'Summarize CI results only',
    }, { agent: { id: 'w1' } })
    assert.match(watchReply, /Subscribed \(sub_/)

    const listed = await tool('list_watches').execute({}, { agent: { id: 'w1' } })
    assert.match(listed, /Track release/)
    const subId = /sub_[a-f0-9]+/.exec(listed)[0]

    const ev = await env.rt.acceptEvent({
      source: { kind: 'github', id: 'gh', name: 'GitHub', actor: 'alice' },
      trust: 'external',
      threadKey: 'github:Fei2411/DS-Bot#99',
      eventType: 'github.CheckRunEvent',
      summary: 'CI failed on macOS',
      body: 'Full stack trace line 1\nline 2',
    })
    assert.equal(env.delivered.length, 1)

    const full = await tool('read_event').execute({ id: ev.eventId }, { agent: { id: 'w1' } })
    assert.match(full, /Full stack trace line 1/)

    // Private Bot event is invisible to other Bots via read_event.
    const privEv = await env.rt.acceptEvent({
      source: { kind: 'mail', id: 'm', name: 'Personal', actor: 'doctor@example.com' },
      trust: 'external',
      threadKey: 'mail:health',
      summary: 'Lab result',
      body: 'Private details',
    }, { privateBotId: 'p1' })
    const denied = await tool('read_event').execute({ id: privEv.eventId }, { agent: { id: 'w1' } })
    assert.match(denied, /not found/)
    const ownRead = await tool('read_event').execute({ id: privEv.eventId }, { agent: { id: 'p1' } })
    assert.match(ownRead, /Private details/)

    const removed = await tool('unwatch').execute({ id: subId }, { agent: { id: 'w1' } })
    assert.match(removed, /Removed subscription/)
    assert.equal(await tool('list_watches').execute({}, { agent: { id: 'w1' } }), 'No active watches.')
  } finally {
    await env.cleanup()
  }
})

test('Mail watcher filters self-sent emails and honors fromFilter after first baseline', async () => {
  let step = 1
  const listMail = async () => ({
    accountAddress: 'me@example.com',
    messages: step === 1
      ? [{ uid: '1', from: 'old@example.com', subject: 'Old', snippet: 'old' }]
      : [
          { uid: '1', from: 'old@example.com', subject: 'Old', snippet: 'old' },
          { uid: '2', from: 'me@example.com', subject: 'My own sent copy', snippet: 'loop' },
          { uid: '3', from: 'spam@other.com', subject: 'Promo', snippet: 'ignore' },
          { uid: '4', from: 'alerts@broker.com', subject: 'Earnings Alert', snippet: 'NVDA beat' },
        ],
  })
  const env = setup({ listMail })
  try {
    await env.rt.load()
    const w = env.rt.eventWatchers.saveWatcher({
      name: 'Broker alerts',
      kind: 'mail',
      target: { kind: 'bot', botId: 'w1' },
      config: { account: 'me@example.com', fromFilter: 'broker.com' },
    }, { isUser: true })

    await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(env.delivered.length, 0)
    step = 2
    const res = await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(res.count, 1)
    assert.equal(env.delivered.length, 1)
    assert.match(env.delivered[0].msg.content[0].text, /Earnings Alert/)
  } finally {
    await env.cleanup()
  }
})

test('channelCall events-* endpoints and read-only host guard behave safely', async () => {
  const env = setup()
  try {
    await env.rt.load()
    const v0 = await env.rt.channelCall('events-view', {})
    assert.equal(v0.ok, true)
    assert.deepEqual(v0.value.watchers, [])

    const saved = await env.rt.channelCall('events-watcher-save', {
      name: 'RSS',
      kind: 'http',
      target: { kind: 'bot', botId: 'w1' },
      config: { url: 'https://example.com/rss.xml' },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.watchers.length, 1)

    const inbox = await env.rt.channelCall('events-inbox', {})
    assert.equal(inbox.ok, true)
    assert.equal(inbox.value.count, 0)

    // Simulate read-only host (another window holds state.lock): writes are refused cleanly.
    const origReadOnly = env.rt.readOnly
    env.rt.readOnly = () => 'Another window holds this team.'
    try {
      const denied = await env.rt.channelCall('events-watcher-check-now', { id: saved.value.watchers[0].id })
      assert.equal(denied.ok, false)
      assert.match(denied.error.message, /Another window holds|read-only/i)
    } finally {
      env.rt.readOnly = origReadOnly
    }
  } finally {
    await env.cleanup()
  }
})
