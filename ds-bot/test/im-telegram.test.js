import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import telegram from '../src/host/im/platforms/telegram.js'

// A fake Bot API: requests are recorded and answered from `replies`; updates the
// adapter polls come from `updates`, newest first.
function fakeApi({ getMe = { id: 7, username: 'fakebot', is_bot: true } } = {}) {
  const calls = []
  const updates = []
  const replies = {}
  const files = {}
  let out
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/file/bot')) {
      const path = url.pathname.slice('/file/botTOKEN/'.length)
      const body = files[path]
      if (body === undefined) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(body)
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const [, , method] = url.pathname.split('/') // /bot<token>/<method>
      const params = JSON.parse(body || '{}')
      calls.push({ method, params })
      if (method === 'getUpdates' && out?.holdPoll === true && updates.length === 0) {
        out.heldPoll.push(res)
        return
      }
      let answer = replies[method]
      if (answer === undefined && method === 'getUpdates') answer = { result: updates.splice(0) }
      if (answer === undefined && method === 'getMe') answer = { result: getMe }
      if (answer === undefined && method === 'getFile') answer = { result: { file_id: params.file_id, file_path: 'photos/p1.jpg' } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: true }
      if (answer.error) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: answer.error, description: answer.description, parameters: answer.parameters }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: answer.result, message_id: answer.message_id ?? calls.length }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const api = `http://127.0.0.1:${server.address().port}`
    out = { api, calls, updates, replies, files, holdPoll: false, heldPoll: [], close: () => server.close() }
    resolve(out)
  }))
}

const env = (api, runtime = {}) => ({
  fetch: globalThis.fetch,
  config: { api },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-telegram]', ...args) },
})

const until = async (fn, tries = 60) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('timed out waiting')
}

test('check validates the token with getMe and names the account', async () => {
  const api = await fakeApi()
  try {
    const account = await telegram.check({ token: 'TOKEN' }, env(api.api))
    assert.deepEqual(account.account, { id: '7', name: '@fakebot' })
    assert.equal(api.calls[0].method, 'getMe')
    await assert.rejects(telegram.check({ token: 'bad' }, { ...env(api.api), fetch: async () => ({ json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }) }))
  } finally { api.close() }
})

test('private text, group mention and photo become adapter messages', async () => {
  const api = await fakeApi()
  const got = { messages: [], actions: [] }
  try {
    api.files['photos/p1.jpg'] = Buffer.from('jpeg-bytes')
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
      onMessage: msg => got.messages.push(msg),
      onAction: action => got.actions.push(action),
      onStatus: () => {},
    })
    api.updates.push({ update_id: 1, message: { message_id: 11, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann', username: 'ann' }, text: 'hi there' } })
    api.updates.push({ update_id: 2, message: { message_id: 12, chat: { id: -8, type: 'supergroup', title: 'Crew' }, from: { id: 9, first_name: 'Ann' }, text: '@fakebot look', entities: [{ type: 'mention', offset: 0, length: 8 }] } })
    api.updates.push({ update_id: 3, message: { message_id: 13, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, caption: 'see', photo: [{ file_id: 'sm', file_size: 10 }, { file_id: 'big', file_size: 99 }] } })
    await until(() => got.messages.length >= 3)
    const [dm, gm, photo] = got.messages
    assert.deepEqual({ key: dm.chat.key, kind: dm.chat.kind }, { key: '5', kind: 'direct' })
    assert.equal(dm.text, 'hi there')
    assert.deepEqual(dm.sender, { id: '9', name: '@ann' })
    assert.equal(gm.chat.kind, 'group')
    assert.equal(gm.mentioned, true)
    assert.equal(gm.text, 'look', 'the mention is stripped')
    assert.equal(photo.images.length, 1)
    assert.equal(photo.images[0].data, Buffer.from('jpeg-bytes').toString('base64'))
    assert.ok(api.calls.some(call => call.method === 'getFile' && call.params.file_id === 'big'))
    handle.stop()
  } finally { api.close() }
})

test('callback_query answers the query and reports the action', async () => {
  const api = await fakeApi()
  const got = { actions: [] }
  try {
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: action => got.actions.push(action), onStatus: () => {} })
    api.updates.push({ update_id: 4, callback_query: { id: 'cq1', from: { id: 9, first_name: 'Ann' }, data: 'a:x:allow', message: { message_id: 44, chat: { id: 5, type: 'private' } } } })
    await until(() => got.actions.length === 1)
    assert.equal(got.actions[0].data, 'a:x:allow')
    assert.equal(got.actions[0].messageId, 44)
    assert.ok(api.calls.some(call => call.method === 'answerCallbackQuery' && call.params.callback_query_id === 'cq1'))
    handle.stop()
  } finally { api.close() }
})

test('send renders HTML, chunks long text, buttons go on the last chunk', async () => {
  const api = await fakeApi()
  try {
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
    await handle.send({ key: '5' }, { text: '**bold** ' + 'word '.repeat(1500), buttons: [{ data: 'a:1:allow', label: 'Allow once' }] })
    const sends = api.calls.filter(call => call.method === 'sendMessage')
    assert.equal(sends.length, 2)
    for (const call of sends) assert.ok(call.params.text.length <= 4096, call.params.text.length)
    assert.equal(sends[0].params.parse_mode, 'HTML')
    assert.equal(sends[1].params.reply_markup.inline_keyboard[0][0].callback_data, 'a:1:allow')
    handle.stop()
  } finally { api.close() }
})

test('a chunk Telegram cannot parse goes again as plain text', async () => {
  const api = await fakeApi()
  try {
    let parsed = false
    api.replies.sendMessage = (params) => {
      if (params.parse_mode === 'HTML' && !parsed) { parsed = true; return { error: 400, description: "Bad Request: can't parse entities" } }
      return { result: { message_id: 7 } }
    }
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
    await handle.send({ key: '5' }, { text: 'plain < enough' })
    const sends = api.calls.filter(call => call.method === 'sendMessage')
    assert.equal(sends.length, 2)
    assert.equal(sends[1].params.parse_mode, undefined, 'resent without a parse mode')
    handle.stop()
  } finally { api.close() }
})

test('429 is honored with retry_after and 409 becomes a status error', async () => {
  const api = await fakeApi()
  try {
    let hits = 0
    api.replies.getUpdates = () => { hits += 1; return hits === 1 ? { error: 429, description: 'Too Many', parameters: { retry_after: 0 } } : { error: 409, description: 'Conflict' } }
    const statuses = []
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
    await until(() => statuses.some(next => next.state === 'error' && /webhook or another program/i.test(next.error ?? '')))
    handle.stop()
  } finally { api.close() }
})

test('stop ends a long poll promptly, and a send in flight does not kill it', async () => {
  const api = await fakeApi()
  api.holdPoll = true
  const handle = telegram.connect({ token: 'tok' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  await until(() => api.calls.some(call => call.method === 'getUpdates'))
  // A send while the poll waits goes on its own controller; the poll stays.
  await handle.send({ key: '1', kind: 'direct' }, { text: 'hi' })
  assert.ok(api.calls.some(call => call.method === 'sendMessage'))
  assert.equal(api.heldPoll.length, 1)
  const before = api.calls.length
  await handle.stop()
  await new Promise(done => setTimeout(done, 150))
  assert.equal(api.calls.length, before, 'stop aborts the poll instead of retrying')
  await api.close()
})
