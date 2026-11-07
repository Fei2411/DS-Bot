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
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization })
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
      if (req.url === '/ilink/bot/getupdates') {
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
    calls, replies,
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
