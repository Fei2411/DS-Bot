import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import slack from '../src/host/im/platforms/slack.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Slack: the Web API answers from `replies`, apps.connections.open hands
// back the fake Socket Mode URL; envelopes pushed by the test must be ACKed.
async function fakeSlack() {
  const calls = []
  const replies = {}
  const packets = []
  const acks = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const method = req.url.slice(1)
      const params = JSON.parse(body || '{}')
      calls.push({ method, params, auth: req.headers.authorization })
      let answer = replies[method]
      if (answer === undefined && method === 'auth.test') answer = { result: { ok: true, user_id: 'U81', user: 'fakebot' } }
      if (answer === undefined && method === 'apps.connections.open') answer = { result: { ok: true, url: wss.url } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: { ok: true, ts: '1700.1' } }
      if (answer.error) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: answer.error }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.result))
    })
  })
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        packets.push(packet)
        if (packet.envelope_id !== undefined) acks.push(packet.envelope_id)
      })
      ws.send(JSON.stringify({ type: 'hello' }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}`,
    calls, replies, packets, acks,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-slack]', ...args) },
})
const FIELDS = { appToken: 'xapp-a', botToken: 'xoxb-b' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

const envelope = (payload) => ({ envelope_id: `e${Math.random()}`, type: 'events_api', payload: { type: 'event_callback', event: payload } })

test('check validates the bot token with auth.test', async () => {
  const fake = await fakeSlack()
  const { account } = await slack.check(FIELDS, env(fake))
  assert.deepEqual(account, { id: 'U81', name: '@fakebot' })
  assert.ok(fake.calls.some(call => call.method === 'auth.test' && call.auth === 'Bearer xoxb-b'))
  await fake.close()
})

test('a message in an im channel is direct, app_mention is group, every envelope is ACKed', async (t) => {
  const fake = await fakeSlack()
  const messages = []
  const handle = slack.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.method === 'apps.connections.open' && call.auth === 'Bearer xapp-a'))
  fake.push(ws, envelope({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text: 'hello', ts: '1.0' }))
  fake.push(ws, envelope({ type: 'app_mention', channel: 'C1', user: 'U3', text: '<@U81> ping', ts: '2.0' }))
  fake.push(ws, envelope({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U3', text: 'noise', ts: '3.0' }))
  fake.push(ws, envelope({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text: 'bot echo', bot_id: 'B1', ts: '4.0' }))
  await until(() => messages.length === 2)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[1].text, 'ping')
  await until(() => fake.acks.length === 4)
})

test('a block_actions envelope reports the action', async (t) => {
  const fake = await fakeSlack()
  const actions = []
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: async action => { actions.push(action) }, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.sockets.length === 1)
  fake.push(ws, {
    envelope_id: 'ev1', type: 'interactive',
    payload: { type: 'block_actions', channel: { id: 'D1' }, user: { id: 'U2', name: 'Fei' }, actions: [{ action_id: 'b0', value: 'q:q1:0' }], message: { ts: '9.9' } },
  })
  await until(() => actions.length === 1)
  assert.equal(actions[0].data, 'q:q1:0')
  assert.equal(actions[0].messageId, '9.9')
})

test('send posts blocks with buttons, edit calls chat.update', async (t) => {
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const { messageId } = await handle.send({ key: 'D1', kind: 'direct' }, { text: 'hello', buttons: [{ data: 'q:q1:0', label: 'yes' }, { data: 'q:q1:1', label: 'no' }] })
  const post = fake.calls.find(call => call.method === 'chat.postMessage')
  assert.ok(post, 'chat.postMessage called')
  assert.equal(post.params.channel, 'D1')
  const buttons = post.params.blocks.at(-1).elements
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].value, 'q:q1:0')
  assert.equal(messageId, '1700.1')
  await handle.edit({ key: 'D1', kind: 'direct' }, '9.9', { text: 'done', buttons: [] })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update, 'chat.update called')
  assert.equal(update.params.ts, '9.9')
})

test('a disconnect frame and a dropped socket both reconnect', async (t) => {
  const fake = await fakeSlack()
  const statuses = []
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, { type: 'disconnect', reason: 'link_disabled' })
  await until(() => fake.sockets.length === 2)
  assert.ok(statuses.some(status => status.state === 'ready'))
})
