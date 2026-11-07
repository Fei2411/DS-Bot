import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub } from '../src/host/multi-device/hub.js'
import { createSessionSync } from '../src/host/multi-device/session-sync.js'
import { createSessionClient, replicaFile } from '../src/host/multi-device/session-client.js'
import { createWorker } from '../src/host/multi-device/worker.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-sync-${name}-`))

async function until(check, { timeout = 8000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

// A Bot team without DSH: `chatPage` is the conversation the center serves, `sendUser`
// is the one write path a node's message takes.
function fakeTeam({ items = [] } = {}) {
  const state = {
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Chief of Staff', sessionId: 's1' } },
    mainBotIds: ['b1'],
  }
  const chats = new Map([['b1', items]])
  const sent = []
  return {
    state,
    sent,
    async load() {},
    botOf: id => state.bots[id],
    async chatPage(botId) {
      return { sessionId: 's1', items: chats.get(botId) ?? [], cursor: null }
    },
    async sendUser({ sessionId, content }) {
      const text = content[0].text
      sent.push({ sessionId, text })
      chats.set(sessionId, [...(chats.get(sessionId) ?? []), { kind: 'user', text, seq: (chats.get(sessionId)?.length ?? 0) + 1 }])
    },
    readOnly: () => undefined,
    add(botId, item) {
      chats.set(botId, [...(chats.get(botId) ?? []), item])
    },
  }
}

async function bench(t, team = fakeTeam()) {
  const sync = createSessionSync({ rt: team })
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, sessionSync: sync, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const pair = async name => {
    const response = await fetch(`${hub.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: hub.issueCode().code, device: { name, os: 'darwin', hostname: name, agentVersion: 'test' } }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    return body
  }
  return { hub, sync, team, pair }
}

const getSession = async (hub, token, query = '') => {
  const response = await fetch(`${hub.url}/session?${query}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: response.status, body: await response.json() }
}

const sendSession = async (hub, token, payload) => {
  const response = await fetch(`${hub.url}/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

test('a node pulls an empty conversation and then the messages, by revision', async t => {
  const { hub, team, pair } = await bench(t)
  const a = await pair('node-a')

  const empty = await getSession(hub, a.token, 'bot=b1&wait=0')
  assert.equal(empty.status, 200)
  assert.equal(empty.body.epoch.length > 0, true)
  assert.equal(empty.body.botName, 'Chief')
  assert.deepEqual(empty.body.items, [])
  const first = empty.body.revision

  team.add('b1', { kind: 'user', text: 'hello from the Mac', seq: 1, time: '2026-11-08T10:00:00.000Z' })
  team.add('b1', { kind: 'bot', text: 'hello back', seq: 2, time: '2026-11-08T10:00:01.000Z' })

  const next = await getSession(hub, a.token, `bot=b1&since=${first}&epoch=${empty.body.epoch}&wait=0`)
  assert.ok(next.body.revision > first, 'a changed snapshot advances the revision')
  assert.deepEqual(next.body.items.map(item => item.text), ['hello from the Mac', 'hello back'])

  const same = await getSession(hub, a.token, `bot=b1&since=${next.body.revision}&epoch=${next.body.epoch}&wait=0`)
  assert.equal(same.body.unchanged, true)
  assert.equal(same.body.revision, next.body.revision)
})

test('a waiting pull wakes when the conversation changes, not on the next blind poll', async t => {
  const { hub, pair } = await bench(t)
  const a = await pair('node-a')
  const start = (await getSession(hub, a.token, 'bot=b1&wait=0')).body

  const startedAt = Date.now()
  const waiting = getSession(hub, a.token, `bot=b1&since=${start.revision}&epoch=${start.epoch}&wait=5000`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const pushed = await sendSession(hub, a.token, { botId: 'b1', text: 'wake up', messageId: 'm-wake' })
  assert.equal(pushed.status, 200)

  const answer = await waiting
  assert.equal(answer.body.unchanged, false)
  assert.ok(answer.body.items.some(item => item.text === 'wake up'))
  assert.ok(Date.now() - startedAt < 3000, 'the wait ended on the change, not the timeout')
})

test('a message pushed from a node lands on the center once, through one write path', async t => {
  const { hub, team, pair } = await bench(t)
  const a = await pair('node-a')

  const first = await sendSession(hub, a.token, { botId: 'b1', text: 'typed on node A', messageId: 'm-1' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.duplicate, undefined)
  assert.equal(first.body.botId, 'b1')
  assert.deepEqual(team.sent, [{ sessionId: 'b1', text: 'typed on node A' }])

  // The same message on a retry is not written twice.
  const again = await sendSession(hub, a.token, { botId: 'b1', text: 'typed on node A', messageId: 'm-1' })
  assert.equal(again.body.duplicate, true)
  assert.equal(team.sent.length, 1)

  const pulled = await getSession(hub, a.token, 'bot=b1&wait=0')
  assert.deepEqual(pulled.body.items.map(item => item.text), ['typed on node A'])
})

test('a second node catches up to what the first one sent', async t => {
  const { hub, pair } = await bench(t)
  const a = await pair('node-a')
  const b = await pair('node-b')

  const before = (await getSession(hub, b.token, 'bot=b1&wait=0')).body
  await sendSession(hub, a.token, { botId: 'b1', text: 'from A to everyone', messageId: 'm-a' })

  const caught = await getSession(hub, b.token, `bot=b1&since=${before.revision}&epoch=${before.epoch}&wait=0`)
  assert.ok(caught.body.revision > before.revision)
  assert.deepEqual(caught.body.items.map(item => item.text), ['from A to everyone'])
})

test('the session endpoints refuse a device the hub does not know', async t => {
  const { hub } = await bench(t)
  assert.equal((await getSession(hub, 'nope', 'bot=b1')).status, 401)
  assert.equal((await fetch(`${hub.url}/session/bots`, { headers: { authorization: 'Bearer nope' } })).status, 401)
  assert.equal((await sendSession(hub, 'nope', { botId: 'b1', text: 'x' })).status, 401)
  assert.equal((await fetch(`${hub.url}/session/bots`)).status, 401)
})

test('a hub without the Bot team says so instead of pretending', async t => {
  const hub = createHub({ dataDir: folder('plain'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const pair = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.issueCode().code, device: { name: 'node' } }),
  }).then(response => response.json())
  assert.equal((await getSession(hub, pair.token, 'bot=b1')).status, 503)
  const health = await fetch(`${hub.url}/health`).then(response => response.json())
  assert.equal(health.session, false)
})

test('revisions only move forward across changes', async t => {
  const { hub, team, pair } = await bench(t)
  const a = await pair('node-a')
  const seen = []
  for (const text of ['one', 'two', 'three']) {
    team.add('b1', { kind: 'user', text, seq: seen.length + 1 })
    const page = await getSession(hub, a.token, 'bot=b1&wait=0')
    seen.push(page.body.revision)
  }
  assert.deepEqual(seen, [...seen].sort((left, right) => left - right))
  assert.equal(new Set(seen).size, 3, 'each change is its own revision')
})

test('a hub restart tells a stale node to take a full snapshot', async t => {
  const team = fakeTeam()
  const first = createSessionSync({ rt: team })
  const hubA = createHub({ dataDir: folder('hub-a'), host: '127.0.0.1', port: 0, sessionSync: first, log: () => {} })
  await hubA.start()
  t.after(() => hubA.stop())
  const paired = await fetch(`${hubA.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hubA.issueCode().code, device: { name: 'node-a' } }),
  }).then(response => response.json())
  const before = (await getSession(hubA, paired.token, 'bot=b1&wait=0')).body

  // Same node token, new hub run: its epoch differs even though the node's cursor is
  // numerically usable, so the answer is a full snapshot with `reset`.
  const hubB = createHub({ dataDir: folder('hub-b'), host: '127.0.0.1', port: 0, sessionSync: first, log: () => {} })
  await hubB.start()
  t.after(() => hubB.stop())
  const moved = await fetch(`${hubB.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hubB.issueCode().code, device: { name: 'node-a' } }),
  }).then(response => response.json())
  assert.notEqual(moved.token, paired.token)
  assert.equal((await getSession(hubB, paired.token, 'bot=b1')).status, 401)

  const restarted = createSessionSync({ rt: team })
  assert.notEqual(restarted.epoch, before.epoch)
  const snapshot = await restarted.snapshot('b1', { since: before.revision, epoch: before.epoch, waitMs: 0 })
  assert.equal(snapshot.reset, true)
})

test('a node process keeps a read replica and sends through the hub', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node-data')
  // The session client is what the worker runs; using the same device token keeps the
  // proof about the protocol, not about a second pairing.
  const client = createSessionClient({ hubUrl: hub.url, dataDir, token: node.token, bot: 'main', pollMs: 100, waitMs: 300 })
  t.after(() => client.stop())
  await client.start()

  await until(() => client.info().revision !== undefined, { what: 'the first pull' })
  assert.equal(client.info().botName, 'Chief')
  assert.equal(client.view().items.length, 0)

  team.add('b1', { kind: 'user', text: 'the center speaks', seq: 1 })
  const pulled = await until(() => client.view().items.find(item => item.text === 'the center speaks'), { what: 'the center message to arrive' })
  assert.equal(pulled.kind, 'user')

  const sent = await client.send('the node answers')
  assert.equal(sent.duplicate, undefined)
  assert.deepEqual(team.sent, [{ sessionId: 'b1', text: 'the node answers' }])
  await until(() => client.view().items.some(item => item.text === 'the node answers'), { what: 'the node message to come back' })

  const persisted = readFileSync(replicaFile(dataDir, 'b1'), 'utf8')
  assert.equal(persisted.includes(node.token), false, 'the replica never holds the device token')
  assert.equal(JSON.parse(persisted).items.some(item => item.text === 'the node answers'), true)
})

test('a stopped node catches up from its saved cursor after reconnect', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node-data')
  const first = createSessionClient({ hubUrl: hub.url, dataDir, token: node.token, bot: 'main', pollMs: 100, waitMs: 300 })
  await first.start()
  await until(() => first.info().revision !== undefined, { what: 'the first pull' })
  const revision = first.info().revision
  await first.stop()

  team.add('b1', { kind: 'user', text: 'said while the node was away', seq: 1 })

  const second = createSessionClient({ hubUrl: hub.url, dataDir, token: node.token, bot: 'main', pollMs: 100, waitMs: 300 })
  t.after(() => second.stop())
  await second.start()
  const caught = await until(() => second.view()?.items.find(item => item.text === 'said while the node was away'), { what: 'the missed message to arrive' })
  assert.equal(caught.kind, 'user')
  assert.ok(second.info().revision > revision)
})

test('a worker with sync follows the Main Bot and stops cleanly', async t => {
  const team = fakeTeam({ items: [{ kind: 'user', text: 'already here', seq: 1 }] })
  const sync = createSessionSync({ rt: team })
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, sessionSync: sync, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const worker = createWorker({
    hubUrl: hub.url,
    dataDir: folder('node'),
    name: 'node-a',
    code: hub.issueCode().code,
    sync: true,
    log: () => {},
    reconnectMs: 50,
    maxReconnectMs: 200,
  })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })
  await until(() => worker.session()?.view()?.items.length === 1, { what: 'the worker replica' })
  assert.equal(worker.info().sync.botName, 'Chief')
  assert.equal(worker.info().sync.status, 'syncing')

  const sent = await worker.session().send('from the worker')
  assert.equal(sent.ok, true)
  await until(() => team.sent.some(entry => entry.text === 'from the worker'), { what: 'the center write' })
})
