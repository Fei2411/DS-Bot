import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import discord from '../src/host/im/platforms/discord.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Discord: REST answers from `replies`, the gateway sends an op-10 hello
// and READY on identify, and lets the test push dispatch packets.
async function fakeDiscord() {
  const calls = []
  const replies = {}
  const packets = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      const call = { method: req.method, path: req.url, params }
      calls.push(call)
      let answer = replies[req.url]
      if (answer === undefined && req.url === '/api/v10/users/@me') answer = { result: { id: '81', username: 'fakebot', bot: true } }
      if (answer === undefined && req.url === '/api/v10/gateway/bot') answer = { result: { url: wss.url } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: { id: '900' } }
      if (answer.error) {
        res.writeHead(answer.error, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: answer.description ?? 'failed', retry_after: answer.retry_after }))
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
        if (packet.op === 2) {
          ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', resume_gateway_url: wss.url, user: { id: '81', username: 'fakebot' } } }))
        }
        if (packet.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 9, d: {} }))
        if (packet.op === 1) ws.send(JSON.stringify({ op: 11, d: null }))
      })
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}/api/v10`,
    gateway: wss.url,
    calls, replies, packets,
    sockets: wss.sockets,
    push: (ws, packet) => ws.send(JSON.stringify(packet)),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api, gateway: fake.gateway },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-discord]', ...args) },
})

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('check validates the bot token and names the account', async () => {
  const fake = await fakeDiscord()
  const { account } = await discord.check({ token: 'tok' }, env(fake))
  assert.deepEqual(account, { id: '81', name: '@fakebot' })
  assert.ok(fake.calls.some(call => call.path === '/api/v10/users/@me'))
  await fake.close()
})

test('a DM is direct, a guild message is a mention when the bot is in mentions', async (t) => {
  const fake = await fakeDiscord()
  const messages = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: async (msg) => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '10', channel_id: 'dm1', content: 'hello', author: { id: 'u1', username: 'Fei' } } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: '11', channel_id: 'g1', guild_id: 'w1', content: 'hey <@81> ping', author: { id: 'u2', username: 'Yan' }, mentions: [{ id: '81' }] } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: '12', channel_id: 'g1', guild_id: 'w1', content: 'noise', author: { id: 'u2', username: 'Yan' }, mentions: [] } })
  await until(() => messages.length === 3)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[1].text, 'hey  ping')
  assert.equal(messages[2].mentioned, false)
})

test('stop and card commands pass through direct messages and mentioned group messages alike', async (t) => {
  const fake = await fakeDiscord()
  const messages = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: msg => messages.push(msg), onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  const commands = ['/stop', '!card V3\n1: first  line\nsecond\tline', '/card V3 1,3']
  let sequence = 1
  for (const text of commands) {
    fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: ++sequence, d: { id: String(sequence), channel_id: 'dm1', content: text, author: { id: 'u1' } } })
    fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: ++sequence, d: { id: String(sequence), channel_id: 'g1', guild_id: 'w1', content: `<@81> ${text}`, author: { id: 'u1' }, mentions: [{ id: '81' }] } })
  }
  await until(() => messages.length === commands.length * 2)
  for (const text of commands) {
    assert.ok(messages.some(msg => msg.chat.kind === 'direct' && msg.text === text && !msg.mentioned))
    assert.ok(messages.some(msg => msg.chat.kind === 'group' && msg.text === text && msg.mentioned))
  }
})

test('a conversation is titled by its channel, a DM by the person', async (t) => {
  const fake = await fakeDiscord()
  fake.replies['/api/v10/channels/g1'] = { result: { id: 'g1', name: 'general', type: 0 } }
  fake.replies['/api/v10/channels/g2'] = { error: 403, description: 'Missing Access' }
  const messages = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: async (msg) => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '20', channel_id: 'dm1', content: 'hi', author: { id: 'u1', username: 'Fei' } } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: '21', channel_id: 'g1', guild_id: 'w1', content: 'x', author: { id: 'u2', username: 'Yan' }, mentions: [] } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: '22', channel_id: 'g2', guild_id: 'w1', content: 'y', author: { id: 'u2', username: 'Yan' }, mentions: [] } })
  fake.push(ws, { op: 0, t: 'MESSAGE_CREATE', s: 5, d: { id: '23', channel_id: 'g1', guild_id: 'w1', content: 'z', author: { id: 'u2', username: 'Yan' }, mentions: [] } })
  await until(() => messages.length === 4)
  const byId = id => messages.find(msg => msg.messageId === id)
  assert.equal(byId('20').chat.title, 'Fei', 'a DM is titled by the person')
  assert.equal(byId('21').chat.title, 'general', 'a named channel is titled by the name behind its channel_id')
  assert.equal(byId('22').chat.title, '', 'a channel the bot cannot read keeps no title')
  assert.equal(byId('23').chat.title, 'general', 'a channel read once keeps its name')
  assert.equal(byId('21').chat.kind, 'group')
  assert.equal(byId('20').chat.kind, 'direct')
  const lookups = fake.calls.filter(call => call.method === 'GET' && /channels\/g1$/.test(call.path))
  assert.equal(lookups.length, 1, 'the channel name is read once per connection')
})

test('a component press is deferred and reports the action', async (t) => {
  const fake = await fakeDiscord()
  const actions = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: async (action) => { actions.push(action) }, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.packets.some(packet => packet.op === 2))
  fake.push(ws, { op: 0, t: 'INTERACTION_CREATE', s: 2, d: { type: 3, id: 'i1', token: 'it', channel_id: 'dm1', user: { id: 'u1', username: 'Fei' }, data: { custom_id: 'q:q1:0' }, message: { id: '77' } } })
  await until(() => actions.length === 1)
  assert.equal(actions[0].data, 'q:q1:0')
  assert.ok(fake.calls.some(call => /interactions\/i1\/it\/callback/.test(call.path) && call.params.type === 6))
})

test('send chunks long text, buttons go on the last chunk, edit patches', async (t) => {
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const { messageId } = await handle.send({ key: 'dm1', kind: 'direct' }, { text: 'x'.repeat(4500), buttons: [{ data: 'q:q1:0', label: 'yes' }, { data: 'q:q1:1', label: 'no' }] })
  const posts = fake.calls.filter(call => /messages$/.test(call.path) && call.method === 'POST')
  assert.equal(posts.length, 3)
  assert.ok(posts.every(call => call.params.content.length <= 2000))
  assert.equal(posts[0].params.components.length, 0)
  assert.equal(posts[2].params.components[0].components.length, 2)
  assert.equal(messageId, '900')
  await handle.edit({ key: 'dm1', kind: 'direct' }, '55', { text: 'done', buttons: [] })
  assert.ok(fake.calls.some(call => call.method === 'PATCH' && /messages\/55$/.test(call.path)))
})

test('a chunk of emoji fits Discord\'s 2000-unit limit', async (t) => {
  // The cut is measured in code points, but Discord counts UTF-16 units and a 400 there is
  // permanent: a chunk of 2000 code points holding astral characters is longer than 2000
  // units, so the message is rejected and the rest of the reply never goes out.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = `a${'\u{1F600}'.repeat(1200)}`
  assert.ok(text.length > 2000, `fixture is ${text.length} units`)
  await handle.send({ key: 'dm1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => /messages$/.test(call.path) && call.method === 'POST')
  assert.ok(posts.length > 1, 'the reply spans several messages')
  for (const post of posts) {
    const content = post.params.content
    assert.ok(content.length <= 2000, `chunk is ${content.length} units`)
    assert.ok(!/[\uD800-\uDBFF]$/.test(content), 'a chunk must not end on a lone high surrogate')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(content), 'a chunk must not start on a lone low surrogate')
  }
  assert.equal(posts.map(post => post.params.content).join(''), text, 'every code point arrives')
})

test('a dropped socket reconnects and resumes the session', async (t) => {
  const fake = await fakeDiscord()
  const statuses = []
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => statuses.push(status) })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => statuses.some(status => status.state === 'ready'))
  ws.close()
  await until(() => fake.sockets.length === 2)
  await until(() => fake.packets.some(packet => packet.op === 6))
  assert.ok(statuses.some(status => status.state === 'connecting'))
})

test('edit keeps the Markdown send put in the message', async (t) => {
  // Discord renders Markdown in `content`, so an edit that goes through `toPlain` drops
  // every emphasis and code fence: a streamed reply looked formatted while it was being
  // sent and plain as soon as it was edited.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = '**Status:** pending\n\n```js\nconst a = 1\n```'
  await handle.edit({ key: 'dm1', kind: 'direct' }, '55', { text, buttons: [] })
  const patch = fake.calls.find(call => call.method === 'PATCH' && /messages\/55$/.test(call.path))
  assert.ok(patch, 'PATCH called')
  assert.equal(patch.params.content, text)
  assert.equal(patch.params.components.length, 0)
})

test('edit rewrites the chunk the message holds, not the head of the reply', async (t) => {
  // `send` spreads a long reply over several messages and returns the last one. An edit
  // that rebuilt the first chunk wrote the head of the reply into that last message, on
  // top of its own tail: the reply then read 1 2 3 1 instead of 1 2 3.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = Array.from({ length: 120 }, (_, index) => `line ${index} ${'z'.repeat(30)}`).join('\n')
  assert.ok(text.length > 2000, `fixture is ${text.length} characters`)
  const { messageId } = await handle.send({ key: 'dm1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => /messages$/.test(call.path) && call.method === 'POST')
  assert.ok(posts.length > 1, 'the reply spans several messages')
  const held = posts.at(-1).params.content
  await handle.edit({ key: 'dm1', kind: 'direct' }, messageId, { text, sentLength: text.length })
  const patch = fake.calls.find(call => call.method === 'PATCH' && call.path.endsWith(`/messages/${messageId}`))
  assert.ok(patch, 'PATCH called on the message send returned')
  assert.equal(patch.params.content, held, 'the edit keeps the chunk that message already showed')
})

test('an emoji-heavy reply settles inside the 2000-unit limit', async (t) => {
  // Discord counts UTF-16 units and rejects an oversize body permanently. The chunker
  // already measures in units, but the append path used to add the answer in code points:
  // a nearly full card answered with one emoji produced a 2,001-unit PATCH that Discord
  // rejected, so the old card with its buttons stayed on screen while the dispatcher had
  // already marked it edited.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = `a${'\u{1F600}'.repeat(1001)}`
  assert.ok(text.length > 2000, `fixture is ${text.length} units`)
  const { messageId } = await handle.send({ key: 'dm1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => /messages$/.test(call.path) && call.method === 'POST')
  assert.ok(posts.length > 1, 'the reply spans several messages')
  for (const post of posts) assert.ok(post.params.content.length <= 2000, `POST is ${post.params.content.length} units`)
  await handle.edit({ key: 'dm1', kind: 'direct' }, messageId, { text: `${text}\n— Yes`, sentLength: text.length })
  const patch = fake.calls.find(call => call.method === 'PATCH' && call.path.endsWith(`/messages/${messageId}`))
  assert.ok(patch, 'PATCH called on the message send returned')
  assert.ok(patch.params.content.length <= 2000, `PATCH is ${patch.params.content.length} units`)
  assert.ok(patch.params.content.endsWith('\n— Yes'), 'the answer is the last thing in the message')
  const kept = patch.params.content.slice(0, -'\n— Yes'.length)
  assert.ok(!/[\uD800-\uDBFF]$/.test(kept), 'no lone high surrogate before the answer')
  assert.ok(text.endsWith(kept), 'the edit shows a suffix of the reply, so no head is repeated')
})

test('a settled card near the limit keeps its body', async (t) => {
  // Cutting the combined text again moved every boundary: a 1,999-unit card answered
  // "Yes" came back as the answer alone, so the question the user answered vanished.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const card = `Which branch?\n${'z'.repeat(1985)}`
  assert.equal(card.length, 1999, 'the card nearly fills the message')
  await handle.edit({ key: 'dm1', kind: 'direct' }, '77', { text: `${card}\n— Yes`, sentLength: card.length })
  const patch = fake.calls.find(call => call.method === 'PATCH' && /messages\/77$/.test(call.path))
  assert.ok(patch, 'PATCH called')
  assert.ok(patch.params.content.includes('Which branch?'), 'the card keeps its body')
  assert.ok(patch.params.content.endsWith('— Yes'), 'the answer still shows')
  assert.ok(patch.params.content.length <= 2000, `PATCH is ${patch.params.content.length} units`)
})

test('a fenced near-limit card does not swallow the answer', async (t) => {
  // Reserving room for the answer by trimming the settled chunk cut off the closing
  // fence and part of the code line: the answer rendered inside an unclosed code block.
  const fake = await fakeDiscord()
  const handle = discord.connect({ token: 'tok' }, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const fenced = '\n```js\nflag = "**FLAGS**"\n```'
  const prefix = 'Which branch?\n'
  const card = prefix + 'z'.repeat(1999 - prefix.length - fenced.length) + fenced
  assert.equal(card.length, 1999, 'the card nearly fills the message')
  await handle.edit({ key: 'dm1', kind: 'direct' }, '78', { text: `${card}\n— Yes`, sentLength: card.length })
  const patch = fake.calls.find(call => call.method === 'PATCH' && /messages\/78$/.test(call.path))
  assert.ok(patch, 'PATCH called')
  const body = patch.params.content
  assert.ok(body.length <= 2000, `PATCH is ${body.length} units`)
  assert.ok(body.includes('Which branch?'), 'the question stays')
  assert.ok(body.endsWith('\n— Yes'), 'the answer stays outside the code block')
  assert.ok(!/```/.test(body.slice(0, -'\n— Yes'.length)), 'no half-open fence is left behind')
  assert.ok(!body.includes('"**FLAG"'), 'the code line is not cut mid-literal')
})
