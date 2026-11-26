import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import telegram from '../src/host/im/platforms/telegram.js'
import { fakeContext } from './fake-ctx.js'

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

test('Telegram removes only standalone addressing mentions and preserves emails and domains', async (t) => {
  const api = await fakeApi()
  const messages = []
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onMessage: msg => messages.push(msg), onAction: () => {}, onStatus: () => {},
  })
  t.after(() => { handle.stop(); api.close() })
  const cases = [
    ['1 3 @fakebot', '1 3 '],
    ['V3 1 3 @fakebot', 'V3 1 3 '],
    ['/card@fakebot V3 1 3', '/card@fakebot V3 1 3'],
    ['/CaRd@FAKEBOT V3 1 3', '/CaRd@FAKEBOT V3 1 3'],
    ['@fakebot !card V3 1 3', '!card V3 1 3'],
    ['!card V3 1 3 @fakebot', '!card V3 1 3 '],
    ['/stop @fakebot', '/stop '],
    ['@fakebot look', 'look'],
    ['@fakebot email alice@fakebot.example', 'email alice@fakebot.example'],
    ['@fakebot domain https://@fakebot.example/path', 'domain https://@fakebot.example/path'],
    ['@fakebot domain docs.@fakebot', 'domain docs.@fakebot'],
    ['@fakebot @fakebot-dev.example', '@fakebot-dev.example'],
    ['@fakebot @@fakebot', '@@fakebot'],
    ['@fakebot name@fakebot', 'name@fakebot'],
    ['@fakebot @fakebot_extra', '@fakebot_extra'],
  ]
  for (const [index, [text]] of cases.entries()) {
    api.updates.push({ update_id: index + 1, message: {
      message_id: index + 1, chat: { id: -8, type: 'supergroup' }, from: { id: 9 }, text,
    } })
  }
  await until(() => messages.length === cases.length)
  assert.deepEqual(messages.map(msg => msg.text), cases.map(([, expected]) => expected))
  assert.ok(messages.every(msg => msg.mentioned))
})

test('a multiline Telegram group mention answers a token form without losing field lines', async (t) => {
  const api = await fakeApi()
  const home = mkdtempSync(join(tmpdir(), 'dsb-tg-form-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const prompts = []
  const followups = []
  const ctx = fakeContext()
  const agent = {
    id: 'a', session: { id: 'a', requestHeader: () => undefined },
    followup: message => followups.push(message), cancel() {},
    inbox: { nextStep: [], nextTurn: [], remove: () => false }, async whenIdle() {},
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async request => { prompts.push(request); return { ok: true } },
      resolveAgent: async () => ({ agent }), selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  rt.config.im = { telegram: { api: api.api } }
  t.after(async () => {
    await ctx.dispose()
    api.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'TOKEN' } })
  const saved = rt.state.im.connections[conn.id]
  saved.paired.push({ id: '9', name: 'Ann', at: 1 })
  saved.chats['-8'] = { kind: 'group', target: { botId: 'a' }, at: 1 }
  await rt.save()
  await until(() => rt.imStatusView()[conn.id]?.state === 'ready')
  const message = (id, text) => ({ update_id: id, message: {
    message_id: id, chat: { id: -8, type: 'supergroup', title: 'Crew' },
    from: { id: 9, first_name: 'Ann' }, text,
    entities: [{ type: 'mention', offset: 0, length: 8 }],
  } })
  api.updates.push(message(100, '@fakebot show a form'))
  await until(() => prompts.length === 1)
  const emit = (type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: 'a' }, { type, data, time: Date.now() })
    }
  }
  emit('turn/start', { turn: 1 })
  emit('user/message', { source: { kind: 'user', rpcId: prompts[0].requestId }, content: [{ type: 'text', text: 'show a form' }] })
  await rt.teamTools.find(tool => tool.name === 'show_view').execute({ view: {
    type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }, { id: 'notes', label: 'Notes', multiline: true }],
  } }, { agent, concludeTurn() {} })
  const viewId = rt.state.views.a.id
  const card = await until(() => api.calls.find(call => call.method === 'sendMessage' && /Card V\d+/.test(call.params.text)))
  const code = /Card (V\d+)/.exec(card.params.text)[1]
  api.updates.push(message(101, `@fakebot !CaRd ${code}\n1: Alice  Smith\tJr\n2: first  line\n  second\tline @fakebot\nlast\t `))
  await until(() => followups.length === 1)
  assert.equal(rt.state.views.a, undefined)
  assert.equal(prompts.length, 1, 'the answer is consumed rather than relayed as ordinary chat')
  assert.deepEqual(JSON.parse(followups[0].content[0].text).answers[0], {
    id: viewId, action: 'details', values: { fields: { name: 'Alice  Smith\tJr', notes: 'first  line\n  second\tline @fakebot\nlast\t ' } },
  })
  await rt.teamTools.find(tool => tool.name === 'ask_user').execute({
    question: 'Which letters?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true,
  }, { agent, concludeTurn() {} })
  await until(() => api.calls.some(call => call.method === 'sendMessage' && call.params.text.includes('Which letters?')))
  api.updates.push(message(102, '1 3 @fakebot'))
  await until(() => followups.length === 2)
  assert.equal(rt.state.questions.a, undefined)
  assert.match(followups[1].content[0].text, /A/)
  assert.match(followups[1].content[0].text, /C/)
  let stopped = false
  rt.stopChat = async botId => { assert.equal(botId, 'a'); stopped = true; return true }
  api.updates.push(message(103, '/stop @fakebot'))
  await until(() => stopped)
  assert.equal(prompts.length, 1, 'trailing-mention answers and commands are not ordinary prompts')
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

test('a network failure before the first reply is retried until the Bot API answers (#1119)', async (t) => {
  const api = await fakeApi()
  const statuses = []
  const base = env(api.api)
  let down = true
  let requests = 0
  const fetch = async (...args) => {
    requests += 1
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = telegram.connect({ token: 'TOKEN' }, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  const tried = requests
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 120)
  assert.ok(requests > tried, 'a new request went out after the failure')
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1)
})

test('a refused token stops at once instead of retrying (#1119)', async (t) => {
  const api = await fakeApi()
  api.replies.getMe = () => ({ error: 401, description: 'Unauthorized' })
  const statuses = []
  const handle = telegram.connect({ token: 'bad' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  await new Promise(done => setTimeout(done, 400))
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1, 'a refused token is not retried')
})

test('a drop after getMe succeeds is retried, not reported as an error (#1119)', async (t) => {
  const api = await fakeApi()
  const statuses = []
  const base = env(api.api)
  let down = true
  let polls = 0
  const fetch = async (url, ...rest) => {
    if (String(url).includes('/getUpdates')) {
      polls += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = telegram.connect({ token: 'TOKEN' }, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  assert.ok(statuses.indexOf(failed) > statuses.findIndex(status => status.state === 'ready'), 'getMe already made the connection ready')
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 120)
  assert.ok(ready !== undefined, 'polling became ready again after the retry')
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1, 'the identity is not fetched again')
  assert.ok(polls >= 2, 'a new long poll went out after the failure')
  assert.equal(statuses.filter(status => status.state === 'error').length, 0, 'a network drop is not shown as an error while it retries')
})

test('video, animation and video_note are fetched and passed as files (#1603)', async (t) => {
  const api = await fakeApi()
  const got = { messages: [] }
  api.replies.getFile = ({ file_id }) => {
    if (file_id === 'v1') return { result: { file_id, file_path: 'videos/clip.mp4' } }
    if (file_id === 'a1') return { result: { file_id, file_path: 'animations/loop.mp4' } }
    if (file_id === 'vn1') return { result: { file_id, file_path: 'video_notes/round.mp4' } }
    return { result: { file_id, file_path: 'photos/p1.jpg' } }
  }
  api.files['videos/clip.mp4'] = Buffer.from('video-bytes')
  api.files['animations/loop.mp4'] = Buffer.from('anim-bytes')
  api.files['video_notes/round.mp4'] = Buffer.from('note-bytes')
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onMessage: msg => got.messages.push(msg),
    onAction: () => {},
    onStatus: () => {},
  })
  t.after(() => { handle.stop(); api.close() })
  api.updates.push({
    update_id: 10,
    message: { message_id: 21, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 11 } },
  })
  api.updates.push({
    update_id: 11,
    message: {
      message_id: 22,
      chat: { id: 5, type: 'private' },
      from: { id: 9, first_name: 'Ann' },
      // Telegram populates document alongside animation for backward compatibility.
      animation: { file_id: 'a1', file_name: 'loop.mp4', file_size: 10 },
      document: { file_id: 'a1', file_name: 'loop.mp4', file_size: 10 },
    },
  })
  api.updates.push({
    update_id: 12,
    message: { message_id: 23, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, video_note: { file_id: 'vn1', file_size: 10 } },
  })
  await until(() => got.messages.length >= 3)
  const [vid, anim, vnote] = got.messages
  assert.equal(vid.files.length, 1)
  assert.equal(vid.files[0].name, 'clip.mp4')
  assert.deepEqual(Buffer.from(vid.files[0].data), Buffer.from('video-bytes'))
  assert.equal(anim.files.length, 1)
  assert.equal(anim.files[0].name, 'loop.mp4')
  assert.deepEqual(Buffer.from(anim.files[0].data), Buffer.from('anim-bytes'))
  assert.equal(api.calls.filter(call => call.method === 'getFile' && call.params.file_id === 'a1').length, 1, 'animation is fetched once even when document is also set')
  assert.equal(vnote.files.length, 1)
  assert.equal(vnote.files[0].name, 'round.mp4')
  assert.deepEqual(Buffer.from(vnote.files[0].data), Buffer.from('note-bytes'))
})

test('over-20MB files and download failures produce a note instead of dropping silently (#1603)', async (t) => {
  const api = await fakeApi()
  const got = { messages: [] }
  const cloudBase = env(api.api)
  const cloudEnv = {
    ...cloudBase,
    config: {},
    fetch: (url, init) => cloudBase.fetch(String(url).replace('https://api.telegram.org', api.api), init),
  }
  api.replies.getFile = ({ file_id }) => {
    if (file_id === 'too-big-unknown') return { error: 400, description: 'Bad Request: file is too big' }
    return { result: { file_id, file_path: 'photos/missing.jpg' } }
  }
  const handle = telegram.connect({ token: 'TOKEN' }, cloudEnv, {
    onMessage: msg => got.messages.push(msg),
    onAction: () => {},
    onStatus: () => {},
  })
  t.after(() => { handle.stop(); api.close() })
  api.updates.push({
    update_id: 20,
    message: { message_id: 31, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, video: { file_id: 'big-vid', file_name: 'movie.mp4', file_size: 25 * 1024 * 1024 } },
  })
  api.updates.push({
    update_id: 21,
    message: { message_id: 32, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, caption: 'check this', document: { file_id: 'too-big-unknown', file_name: 'archive.zip' } },
  })
  api.updates.push({
    update_id: 22,
    message: { message_id: 33, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, photo: [{ file_id: 'missing-photo', file_size: 500 }] },
  })
  await until(() => got.messages.length >= 3)
  const [bigVid, bigDoc, missingPhoto] = got.messages
  assert.equal(bigVid.files.length, 0)
  assert.match(bigVid.text, /movie\.mp4/)
  assert.match(bigVid.text, /20 MB/)
  assert.equal(api.calls.some(call => call.method === 'getFile' && call.params.file_id === 'big-vid'), false, 'cloud API skips getFile when file_size exceeds 20 MB')
  assert.equal(bigDoc.files.length, 0)
  assert.match(bigDoc.text, /^check this\n/)
  assert.match(bigDoc.text, /archive\.zip/)
  assert.match(bigDoc.text, /20 MB/)
  assert.equal(missingPhoto.images.length, 0)
  assert.match(missingPhoto.text, /photo/i)
  assert.match(missingPhoto.text, /404/)
})

test('custom Bot API server is not restricted by the 20 MB cloud pre-check (#1603)', async (t) => {
  const api = await fakeApi()
  const got = { messages: [] }
  api.replies.getFile = ({ file_id }) => ({ result: { file_id, file_path: 'videos/large.mp4' } })
  api.files['videos/large.mp4'] = Buffer.from('local-server-video')
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onMessage: msg => got.messages.push(msg),
    onAction: () => {},
    onStatus: () => {},
  })
  t.after(() => { handle.stop(); api.close() })
  api.updates.push({
    update_id: 25,
    message: { message_id: 35, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, video: { file_id: 'local-big', file_name: 'large.mp4', file_size: 25 * 1024 * 1024 } },
  })
  await until(() => got.messages.length >= 1)
  assert.equal(got.messages[0].files.length, 1)
  assert.equal(got.messages[0].files[0].name, 'large.mp4')
  assert.deepEqual(Buffer.from(got.messages[0].files[0].data), Buffer.from('local-server-video'))
  assert.equal(got.messages[0].text, '')
})

test('IM runtime forwards captionless video and notifies Bot when >20MB Telegram file fails (#1603)', async (t) => {
  const api = await fakeApi()
  const home = mkdtempSync(join(tmpdir(), 'dsb-tg-e2e-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }))
  const prompts = []
  const uploads = []
  const ctx = fakeContext({
    services: {
      fileUploads: {
        async uploadStream({ sessionId, data, name }) {
          const chunks = []
          for await (const chunk of data) chunks.push(chunk)
          uploads.push({ sessionId, name, bytes: Buffer.concat(chunks) })
          return { receiptId: `rcpt-${uploads.length}` }
        },
      },
    },
  })
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, requestHeader: () => undefined }, followup() {}, cancel() {}, inbox: { nextStep: [], nextTurn: [], remove: () => false }, async whenIdle() {} } }),
      selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  rt.config.im = { telegram: { api: api.api } }
  t.after(async () => {
    await ctx.dispose()
    api.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  api.replies.getFile = ({ file_id }) => {
    if (file_id === 'v-ok') return { result: { file_id, file_path: 'videos/demo.mp4' } }
    if (file_id === 'doc-big') return { error: 400, description: 'Bad Request: file is too big' }
    return { result: { file_id, file_path: 'photos/p1.jpg' } }
  }
  api.files['videos/demo.mp4'] = Buffer.from('mp4-payload')
  const conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'TOKEN' } })
  rt.state.im.connections[conn.id].paired.push({ id: '9', name: '@ann', at: 1 })
  await rt.save()
  await until(() => rt.imStatusView()[conn.id]?.state === 'ready')

  api.updates.push({
    update_id: 30,
    message: { message_id: 41, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann', username: 'ann' }, video: { file_id: 'v-ok', file_name: 'demo.mp4', file_size: 11 } },
  })
  api.updates.push({
    update_id: 31,
    message: { message_id: 42, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann', username: 'ann' }, document: { file_id: 'doc-big', file_name: 'huge.tar.gz', file_size: 25 * 1024 * 1024 } },
  })

  await until(() => prompts.length >= 2)
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].name, 'demo.mp4')
  assert.deepEqual(uploads[0].bytes, Buffer.from('mp4-payload'))
  assert.deepEqual(prompts[0].content, [{ type: 'file', receiptId: 'rcpt-1' }])
  assert.equal(prompts[1].content.length, 1)
  assert.equal(prompts[1].content[0].type, 'text')
  assert.match(prompts[1].content[0].text, /huge\.tar\.gz/)
  assert.match(prompts[1].content[0].text, /20 MB/)
})
