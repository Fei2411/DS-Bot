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
  // A client that went away before the held long poll answered, and one promise
  // per held poll (it resolves when that connection closes).
  const aborted = []
  const held = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization, headers: req.headers })
      // A raw body, for a proxy error page or any other non-JSON 200.
      if (replies.raw?.[req.url] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end(replies.raw[req.url])
        return
      }
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
        // A long poll the test holds open: it answers only when the client goes away,
        // which is how a stopped connection must end it.
        if (replies.holdUpdates === true) {
          const gone = new Promise(resolve => {
            res.on('close', () => {
              if (res.writableEnded) return
              aborted.push(req.url)
              resolve(true)
            })
          })
          held.push(gone)
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
    calls, replies, state, aborted, held,
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

test('a session start that keeps failing is shown once and still retried until it works', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ http: 500 }, { http: 500 }, { http: 500 }, { http: 500 }, { http: 500 }, { ret: 0 }]
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'), 200)
  const failed = statuses.find(status => status.state === 'error')
  assert.ok(failed, 'the connection reports the failure')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 0, 'no poll before the session starts')
  await until(() => statuses.some(status => status.state === 'ready'), 400)
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session started once the network came back')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 6)
  assert.ok(fake.calls.some(call => call.path === '/ilink/bot/getupdates'), 'polling starts after the session')
  assert.equal(statuses.filter(status => status.state === 'error').length, 1, 'the failure is shown once')
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

// iLink answers with the bare host and the request URL appends its path, so the
// connection base and the QR base must end in exactly one slash for every form the
// user, the scan or a copied URL can produce.
test('the QR base and the connection base end in exactly one slash', async (t) => {
  const fake = await fakeIlink()
  t.after(() => fake.close())
  const origin = fake.base.replace(/\/$/, '')
  for (const suffix of ['', '/', '///']) {
    const qrEnv = { ...env(fake), config: { qr: `${origin}${suffix}` } }
    await weixin.loginStart(qrEnv)
    const start = fake.calls.at(-1)
    assert.equal(start.path, '/ilink/bot/get_bot_qrcode?bot_type=3', `QR base ${JSON.stringify(suffix)}`)
    for (const api of [origin, `${origin}/`, `${origin}///`]) {
      const fields = { token: 'wx-tok', baseUrl: '' }
      const answer = await weixin.check({ ...fields, baseUrl: api }, { ...env(fake), config: { api } })
      assert.deepEqual(answer.account, { id: '', name: 'WeChat' })
      assert.equal(fake.calls.at(-1).path, '/ilink/bot/getupdates', `baseUrl ${JSON.stringify(api)}`)
    }
  }
})

test('check passes when the answer carries no ret, and a non-zero ret is still an error', async () => {
  const fake = await fakeIlink()
  try {
    fake.replies.updates = { msgs: [], sync_buf: 's1', get_updates_buf: 'c1' }
    const answer = await weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake))
    assert.equal(answer.account.name, 'WeChat')
    fake.replies.updates = { ret: -2, errmsg: 'bad token' }
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent === true && /answered -2/.test(error.message))
  } finally {
    await fake.close()
  }
})

test('an idle getupdates without ret is a success: ready, cursor and message', async (t) => {
  const fake = await fakeIlink()
  const runtime = {}
  const messages = []
  const statuses = []
  let polls = 0
  // The real idle answer has no ret at all; only errors carry one.
  fake.replies.updates = () => {
    polls += 1
    if (polls === 1) {
      return {
        msgs: [{ from_user_id: 'u1', client_id: 'm1', context_token: 'tok-u1', item_list: [{ type: 1, text_item: { text: 'hello without ret' } }] }],
        get_updates_buf: 'c2',
      }
    }
    return { msgs: [], get_updates_buf: 'c2' }
  }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, 'hello without ret')
  assert.equal(runtime.cursor, 'c2')
  assert.equal(runtime.contextTokens.u1, 'tok-u1')
  assert.ok(statuses.some(status => status.state === 'ready'), JSON.stringify(statuses))
})

test('a non-zero ret during the poll is still an error and 401 stops it', async (t) => {
  const fake = await fakeIlink()
  const statuses = []
  fake.replies.updates = { ret: 401 }
  const handle = weixin.connect(FIELDS, env(fake, {}), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  assert.match(statuses.find(status => status.state === 'error').error, /401/)
})

test('a network failure keeps its cause for diagnosis', async () => {
  const fake = await fakeIlink()
  try {
    const network = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
    const failing = { ...env(fake), fetch: async () => { throw network } }
    await assert.rejects(() => weixin.check({ token: 'wx-tok', baseUrl: '' }, failing), (error) => {
      assert.match(error.message, /ENOTFOUND/)
      assert.equal(error.cause, network)
      assert.equal(error.timeout, false)
      return true
    })
  } finally {
    await fake.close()
  }
})

// A missing ret only means success when the body is a real getupdates answer: a
// proxy error page (non-JSON) or an empty object must not read as an idle poll.
test('check refuses a non-JSON answer and an empty object without ret', async () => {
  const fake = await fakeIlink()
  try {
    fake.replies.raw = { '/ilink/bot/getupdates': '<html>bad gateway</html>' }
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent !== true && /unreadable/.test(error.message))
    delete fake.replies.raw
    fake.replies.updates = {}
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent !== true && /unreadable/.test(error.message))
  } finally {
    await fake.close()
  }
})

test('the poll never reports ready for a non-JSON or empty answer without ret', async () => {
  for (const answer of ['not json at all', {}]) {
    const fake = await fakeIlink()
    const statuses = []
    if (typeof answer === 'string') fake.replies.raw = { '/ilink/bot/getupdates': answer }
    else fake.replies.updates = answer
    const handle = weixin.connect(FIELDS, env(fake, {}), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
    try {
      await until(() => statuses.filter(status => status.state === 'connecting').length >= 2)
      await new Promise(done => setTimeout(done, 150))
      assert.ok(statuses.length >= 2, JSON.stringify(statuses))
      assert.ok(!statuses.some(status => status.state === 'ready'), `ready after ${JSON.stringify(answer)}: ${JSON.stringify(statuses)}`)
      assert.ok(statuses.some(status => status.state === 'connecting'), JSON.stringify(statuses))
    } finally {
      handle.stop()
      await fake.close()
    }
  }
})

// A quit must not leave the engine host alive: the getupdates long poll answers at
// the server's own pace (the request timeout is 50 s), so an un-aborted poll holds the
// process open after the connection is stopped.
test('stop ends an in-flight getupdates long poll instead of leaving it open', async (t) => {
  const fake = await fakeIlink()
  fake.replies.holdUpdates = true
  const handle = weixin.connect(FIELDS, env(fake, {}), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(async () => {
    handle.stop()
    await fake.close()
  })
  assert.ok(await until(() => fake.calls.some(call => call.path === '/ilink/bot/getupdates')), 'the long poll starts')
  assert.equal(fake.held.length, 1)
  handle.stop()
  const ended = await Promise.race([
    fake.held[0].then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1_500)),
  ])
  assert.equal(ended, true, 'the long poll must be ended by stop, not by its 50 s timeout')
  assert.deepEqual(fake.aborted, ['/ilink/bot/getupdates'])
})
