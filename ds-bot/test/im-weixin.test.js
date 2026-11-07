import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import weixin from '../src/host/im/platforms/weixin.js'

// A fake iLink: the QR endpoints drive the login states the test wants, the
// getupdates long poll answers from a queued script, and sends are recorded.
async function fakeIlink() {
  const calls = []
  const replies = {}
  let updates = []
  const state = { notified: false }
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization, headers: req.headers })
      if (req.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        const answer = replies.qrcode ?? { qrcode: 'qr-tok-1', qrcode_img_content: 'weixin://qr/abc' }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
        return
      }
      if (req.url.startsWith('/ilink/bot/get_qrcode_status')) {
        const status = (replies.statuses ?? ['wait']).shift() ?? replies.lastStatus ?? 'wait'
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(typeof status === 'object' ? status : { status }))
        return
      }
      if (req.url === '/ilink/bot/msg/notifystart') {
        const scripted = replies.notifystartQueue?.shift() ?? { ret: 0 }
        const status = scripted.http ?? 200
        if (status === 200) state.notified = true
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200 ? (scripted.body ?? scripted) : {}))
        return
      }
      if (req.url === '/ilink/bot/getupdates') {
        // The real server refuses updates until the session is opened.
        if (replies.requireStart === true && !state.notified) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: -14, errmsg: 'session timeout' }))
          return
        }
        const answer = replies.updatesShift ?? updates.shift() ?? replies.updates ?? { ret: 0, msgs: [], get_updates_buf: 'c1' }
        if (typeof answer === 'function') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer(params))); return }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
        return
      }
      const answer = replies[req.url] ?? { ret: 0 }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${http.address().port}/`,
    calls, replies, state,
    queue: items => { updates = items },
    close: () => { http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.base, qr: fake.base },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-weixin]', ...args) },
})
// The same env, with the statuses and warnings kept for assertions.
const tracked = (fake, runtime = {}) => {
  const statuses = []
  const warns = []
  const watched = { ...env(fake, runtime), log: { warn: (...args) => warns.push(args.join(' ')) } }
  return { env: watched, statuses, warns }
}
const FIELDS = { token: 'wx-tok', baseUrl: '' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('login start returns a code, wait reports waiting then scanned then done with the owner', async () => {
  const fake = await fakeIlink()
  fake.replies.statuses = [
    'wait',
    'scaned',
    { status: 'confirmed', bot_token: 'wx-tok', baseurl: fake.base, ilink_bot_id: 'bot-9', ilink_user_id: 'owner-1' },
  ]
  const { loginId, qr, expiresAt } = await weixin.loginStart(env(fake))
  assert.equal(qr, 'weixin://qr/abc')
  assert.ok(expiresAt > Date.now())
  assert.equal((await weixin.loginWait(loginId, env(fake))).status, 'waiting')
  assert.equal((await weixin.loginWait(loginId, env(fake))).status, 'scanned')
  const done = await weixin.loginWait(loginId, env(fake))
  assert.equal(done.status, 'done')
  assert.deepEqual(done.owner, { id: 'owner-1', name: 'owner-1' })
  assert.equal(done.connection.secrets.token, 'wx-tok')
  assert.equal(done.connection.account.id, 'bot-9')
  assert.equal(done.connection.settings.baseUrl, fake.base)
  await fake.close()
})

test('getupdates keeps the cursor and context_token in runtime and delivers text and voice', async (t) => {
  const fake = await fakeIlink()
  const runtime = {}
  const messages = []
  fake.replies.updates = (params) => {
    if (params.get_updates_buf === 'c1') return { ret: 0, msgs: [], get_updates_buf: 'c1' }
    return {
      ret: 0, get_updates_buf: 'c1',
      msgs: [
        { from_user_id: 'u1', client_id: 'm1', context_token: 'tok-u1', item_list: [{ type: 1, text_item: { text: 'hello' } }] },
        { from_user_id: 'u1', client_id: 'm2', context_token: 'tok-u1', item_list: [{ type: 3, voice_item: { text: 'a voice transcript' } }] },
      ],
    }
  }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => messages.length === 2)
  assert.equal(runtime.cursor, 'c1')
  assert.deepEqual(runtime.contextTokens, { u1: 'tok-u1' })
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[0].text, 'hello')
  assert.equal(messages[1].text, 'a voice transcript')
})

test('send goes through sendmessage with the stored context_token, chunked at the limit', async (t) => {
  const fake = await fakeIlink()
  const runtime = { cursor: 'c1', contextTokens: { u1: 'tok-u1' } }
  fake.replies.updates = { ret: 0, msgs: [], get_updates_buf: 'c1' }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.calls.some(call => call.path === '/ilink/bot/getupdates'))
  const { messageId } = await handle.send({ key: 'u1', kind: 'direct' }, { text: 'x'.repeat(4000) })
  const sends = fake.calls.filter(call => call.path === '/ilink/bot/sendmessage')
  assert.ok(sends.length >= 2, 'chunked at the limit')
  assert.equal(sends[0].params.msg.to_user_id, 'u1')
  assert.equal(sends[0].params.msg.context_token, 'tok-u1')
  assert.equal(sends[0].params.msg.item_list[0].type, 1)
  assert.ok(messageId.startsWith('ds-bot-'))
})

test('a refused send is permanent, and the auth header carries the token', async (t) => {
  const fake = await fakeIlink()
  const runtime = { cursor: 'c1' }
  fake.replies.updates = { ret: 0, msgs: [] }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.calls.some(call => call.path === '/ilink/bot/getupdates'))
  fake.replies['/ilink/bot/sendmessage'] = { ret: -2, errmsg: 'msg out of window' }
  await assert.rejects(() => handle.send({ key: 'u1', kind: 'direct' }, { text: 'late' }),
    error => error.permanent === true && /window/.test(error.message))
  assert.equal(fake.calls[0].auth, 'Bearer wx-tok')
})

// The client identity iLink expects: app id "bot", client version 2.4.6 packed
// as 0x00MMNNPP, and X-WECHAT-UIN = base64 of a decimal uint32.
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const assertClientHeaders = (call) => {
  assert.equal(call.headers['ilink-app-id'], 'bot')
  assert.equal(call.headers['ilink-app-clientversion'], String(CLIENT_VERSION))
  assert.equal(call.headers.authorizationtype, 'ilink_bot_token')
  assert.equal(call.auth, 'Bearer wx-tok')
  const uin = Buffer.from(call.headers['x-wechat-uin'], 'base64').toString('utf8')
  assert.match(uin, /^\d+$/)
}

test('connect opens the session with msg/notifystart before polling', async (t) => {
  const fake = await fakeIlink()
  fake.replies.requireStart = true
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'ready'))
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session reached ready')
  const paths = fake.calls.map(call => call.path).filter(path => path.endsWith('notifystart') || path === '/ilink/bot/getupdates')
  assert.deepEqual(paths.slice(0, 2), ['/ilink/bot/msg/notifystart', '/ilink/bot/getupdates'])
  const start = fake.calls.find(call => call.path === '/ilink/bot/msg/notifystart')
  const poll = fake.calls.find(call => call.path === '/ilink/bot/getupdates')
  assertClientHeaders(start)
  assertClientHeaders(poll)
})

test('the QR login requests carry the same client identity', async () => {
  const fake = await fakeIlink()
  fake.replies.statuses = ['confirmed']
  const { loginId } = await weixin.loginStart(env(fake))
  await weixin.loginWait(loginId, env(fake))
  for (const path of ['/ilink/bot/get_bot_qrcode', '/ilink/bot/get_qrcode_status']) {
    const call = fake.calls.find(entry => entry.path.startsWith(path))
    assert.equal(call.headers['ilink-app-id'], 'bot')
    assert.equal(call.headers['ilink-app-clientversion'], String(CLIENT_VERSION))
  }
  await fake.close()
})

test('a transient session start failure is retried before polling', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ http: 503 }, { http: 503 }, { ret: 0 }]
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'ready'), 160)
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session started on a later attempt')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 3)
  assert.ok(fake.calls.some(call => call.path === '/ilink/bot/getupdates'), 'polling starts after the retries')
})

test('a session start that keeps failing is shown once and polling never starts', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ http: 500 }, { http: 500 }, { http: 500 }, { http: 500 }]
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'), 200)
  const failed = statuses.find(status => status.state === 'error')
  assert.ok(failed, 'the connection reports the failure')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 4)
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 0)
  assert.equal(warns.filter(line => /could not start the session/.test(line)).length, 1)
})

test('-14 on the session start is permanent, shown once, and polling never starts', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ errcode: -14, errmsg: 'session timeout' }]
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  const failed = statuses.find(status => status.state === 'error')
  assert.match(String(failed?.error), /session expired/i)
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 1)
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 0)
})

test('-14 in getupdates is shown as a session error and stops the poll', async (t) => {
  const fake = await fakeIlink()
  fake.replies.updates = { errcode: -14, errmsg: 'session timeout' }
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  const failed = statuses.find(status => status.state === 'error')
  assert.match(String(failed?.error), /session expired/i)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 1)
  assert.equal(warns.filter(line => /session expired/.test(line)).length, 1)
})

test('an answer without ret or errcode is not taken as a session error', async (t) => {
  const fake = await fakeIlink()
  fake.replies.updates = { msgs: [], get_updates_buf: 'c1' }
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  // iLink omits the error code on success; a missing code must never be read
  // as an expired session.
  await until(() => fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length >= 2, 200)
  assert.equal(statuses.some(status => status.state === 'error'), false)
  assert.equal(warns.some(line => /session expired/.test(line)), false)
})
