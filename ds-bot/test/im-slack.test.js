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

test('stop and card commands pass through direct messages and mentioned group messages alike', async (t) => {
  const fake = await fakeSlack()
  const messages = []
  const handle = slack.connect(FIELDS, env(fake), { onMessage: msg => messages.push(msg), onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const commands = ['/stop', '!card V3\n1: first  line\nsecond\tline', '/card V3 1,3']
  for (const text of commands) {
    fake.push(ws, envelope({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text }))
    fake.push(ws, envelope({ type: 'app_mention', channel: 'C1', user: 'U2', text: `<@U81> ${text}` }))
  }
  await until(() => messages.length === commands.length * 2)
  assert.deepEqual(messages.map(msg => msg.text), commands.flatMap(text => [text, text]))
  assert.deepEqual(messages.map(msg => msg.mentioned), commands.flatMap(() => [false, true]))
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

test('bold Markdown reaches Slack as bold, not as italic', async (t) => {
  // Slack writes bold as *text* and italic as _text_. The converter used to turn
  // **bold** into *bold* and then read that same *bold* as an italic phrase, so bold
  // text arrived italicised whenever it started a line or followed a space.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  await handle.send({ key: 'D1', kind: 'direct' }, { text: 'this is **important** and *emphatic* here' })
  const post = fake.calls.find(call => call.method === 'chat.postMessage')
  const rendered = post.params.blocks.map(block => block.text?.text ?? '').join('\n')
  assert.equal(rendered, 'this is *important* and _emphatic_ here')
  // A bold run that opens the message is the case the old order got wrong.
  fake.calls.length = 0
  await handle.send({ key: 'D1', kind: 'direct' }, { text: '**Start** of the line' })
  const first = fake.calls.find(call => call.method === 'chat.postMessage')
  assert.equal(first.params.blocks[0].text.text, '*Start* of the line')
})


test('a long message keeps every section block under Slack\'s 3000-character limit', async (t) => {
  // Slack rejects the whole message with invalid_blocks when a section's text runs past
  // 3000 characters, so a single 3500-character reply never reached the channel at all.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = Array.from({ length: 70 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n')
  assert.ok(text.length > 3000 && text.length < 4000, `fixture is ${text.length} characters`)
  await handle.send({ key: 'D1', kind: 'direct' }, { text, buttons: [{ data: 'q:q1:0', label: 'yes' }] })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  assert.ok(posts.length > 0, 'chat.postMessage called')
  for (const post of posts) {
    const sections = post.params.blocks.filter(block => block.type === 'section')
    for (const section of sections) {
      assert.ok(section.text.text.length <= 3000, `section text is ${section.text.text.length} characters`)
    }
    const joined = sections.map(section => section.text.text).join('\n')
    assert.ok(joined.includes('line 0 '), 'the first line still arrives')
    assert.ok(joined.includes('line 69 '), 'the last line still arrives')
  }
  assert.equal(posts.at(-1).params.blocks.at(-1).type, 'actions')
})

test('an edit rebuilds only the chunk it is updating', async (t) => {
  // `send` spreads a long card over several messages and answers with the last one. An
  // edit that rebuilt the whole card put every earlier section back into that message.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = Array.from({ length: 160 }, (_, index) => `line ${index} ${'y'.repeat(40)}`).join('\n')
  assert.ok(text.length > 4000, `fixture is ${text.length} characters`)
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.1', { text })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  assert.ok(update.params.text.length <= 4000, `text is ${update.params.text.length} characters`)
  const joined = update.params.blocks.filter(block => block.type === 'section').map(block => block.text.text).join('\n')
  assert.ok(joined.includes('line 159 '), 'the tail of the message is what the edit shows')
  assert.ok(!joined.includes('line 0 '), 'the earlier chunks keep their own messages')
})

test('a fenced block that spans sections is closed and reopened', async (t) => {
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const code = Array.from({ length: 200 }, (_, index) => `  return value${index};`).join('\n')
  const text = `before\n\`\`\`js\n${code}\n\`\`\`\nafter`
  assert.ok(text.length > 3000, `fixture is ${text.length} characters`)
  await handle.send({ key: 'D1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  const sections = posts.flatMap(post => post.params.blocks.filter(block => block.type === 'section'))
  assert.ok(sections.length > 1, 'the block spans several sections')
  for (const section of sections) {
    const body = section.text.text
    assert.ok(body.length <= 3000, `section text is ${body.length} characters`)
    const fences = body.split('\n').filter(line => line.trimStart().startsWith('```')).length
    assert.equal(fences % 2, 0, 'every section closes the fence it opens')
  }
  const bodies = sections.map(section => section.text.text)
  assert.ok(bodies[0].startsWith('before'), 'the section before the block keeps its text')
  assert.ok(bodies.slice(1).some(body => body.startsWith('```js')), 'a continued section reopens the fence')
  assert.ok(bodies.at(-1).includes('after'), 'the section after the block keeps its text')
})

test('a cut at the limit does not split an emoji', async (t) => {
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  // One ASCII character shifts every pair, so the limit itself lands inside an emoji.
  const text = `a${'\u{1F600}'.repeat(1600)}`
  await handle.send({ key: 'D1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  const sections = posts.flatMap(post => post.params.blocks.filter(block => block.type === 'section'))
  for (const section of sections) {
    const body = section.text.text
    assert.ok(body.length <= 3000, `section text is ${body.length} characters`)
    assert.ok(!/[\uD800-\uDBFF]$/.test(body), 'a section must not end on a lone high surrogate')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(body), 'a section must not start on a lone low surrogate')
  }
})

test('an answered card keeps its body when the answer pushes it past the limit', async (t) => {
  // Settling a card edits with the card plus `\n— <answer>`. Cutting that combined text
  // again moves the boundaries: a card that nearly filled the message came back as the
  // answer alone, so the card the user answered disappeared from the chat.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const card = `Which branch?\n${'z'.repeat(3985)}`
  assert.equal(card.length, 3999, 'the card nearly fills the limit')
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.1', { text: `${card}\n— Yes`, sentLength: card.length })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  const joined = update.params.blocks.filter(block => block.type === 'section').map(block => block.text.text).join('\n')
  assert.ok(joined.includes('Which branch?'), 'the card keeps its body')
  assert.ok(joined.endsWith('— Yes'), 'the answer still shows')
})

test('a fence that ends before the cut the split settles on is not closed', async (t) => {
  // Moving the cut back to make room for the reopened fence can land before the line that
  // opened it. The markers were read at the first cut, so that section got a closing
  // marker with nothing open and the next one a reopened block that was never entered.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = `${'x'.repeat(2989)}\n\`\`\`js\n${'z'.repeat(40)}\n\`\`\`\n` + 'tail\n'.repeat(900)
  assert.ok(text.length > 3000, `fixture is ${text.length} characters`)
  await handle.send({ key: 'D1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  const sections = posts.flatMap(post => post.params.blocks.filter(block => block.type === 'section'))
  for (const section of sections) {
    const body = section.text.text
    assert.ok(body.length <= 3000, `section text is ${body.length} characters`)
    const fences = body.split('\n').filter(line => line.trimStart().startsWith('```')).length
    assert.equal(fences % 2, 0, 'every section leaves the fence the way it found it')
  }
})

test('a fence line longer than a section still splits', async (t) => {
  // Reopening a fence costs a marker line out of the section's budget. A fence whose info
  // string is itself longer than the budget left no room, and prefixing it back grew the
  // pending text on every pass, so `sectionsOf` never finished.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = `\`\`\`${'i'.repeat(2500)}\nbody line\n`.repeat(3)
  await handle.send({ key: 'D1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  assert.ok(posts.length > 0, 'the reply still goes out')
  for (const post of posts) {
    for (const section of post.params.blocks.filter(block => block.type === 'section')) {
      assert.ok(section.text.text.length <= 3000, `section text is ${section.text.text.length} characters`)
    }
  }
})

test('an answered card keeps a fenced block, and the answer, out of each other', async (t) => {
  // Trimming the settled card to the 4,000-character message limit before rendering cut
  // the closing fence off a card that nearly filled it. `toMrkdwn` only keeps code verbatim
  // between matched fences, so the code was reformatted as prose (`**FLAGS**` became
  // `*FLAGS*`) and the answer was swallowed into the block that never closed.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const code = '```\nflag = "**FLAGS**"\n```'
  const card = `${'z'.repeat(3997 - code.length - 1)}\n${code}`
  assert.equal(card.length, 3997, 'the card leaves no room for the answer')
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.1', { text: `${card}\n— yes!!`, sentLength: card.length })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  assert.ok(update.params.text.length <= 4000, `text is ${update.params.text.length} characters`)
  const sections = update.params.blocks.filter(block => block.type === 'section').map(block => block.text.text)
  for (const body of sections) assert.ok(body.length <= 3000, `section text is ${body.length} characters`)
  const joined = sections.join('\n')
  assert.ok(joined.includes('flag = "**FLAGS**"'), 'the code block keeps its text verbatim')
  assert.ok(joined.endsWith('— yes!!'), 'the answer still shows')
  const answering = sections.filter(body => body.includes('— yes!!'))
  assert.equal(answering.length, 1, 'the answer lands in exactly one section')
  const fences = answering[0].split('\n').filter(line => line.trimStart().startsWith('```')).length
  assert.equal(fences % 2, 0, 'the answer is not inside a fence that never closes')
})

test('a settled card\'s fallback text names the question and the answer', async (t) => {
  // Slack shows the top-level `text` to screen readers and in notifications instead of the
  // blocks. Trimming the combined card plus answer to the 4,000-character field left the
  // answer alone — `— yes!!` — so the fallback named neither the question nor the card it
  // settled. The summary has to keep the head of the card and append the answer.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const card = `Deploy the release branch?\n${'z'.repeat(3970)}`
  assert.equal(card.length, 3997, 'the card leaves no room for the answer')
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.2', { text: `${card}\n— yes!!`, sentLength: card.length })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  assert.ok(update.params.text.length <= 4000, `text is ${update.params.text.length} characters`)
  assert.ok(update.params.text.startsWith('Deploy the release branch?'), 'the fallback keeps the question')
  assert.ok(update.params.text.endsWith('— yes!!'), 'the fallback ends with the answer')
})

test('a card sent as two messages keeps the answer in its fallback text', async (t) => {
  // `sentLength` counts the whole card, but an edit only rewrites the last message, so the
  // offset is longer than the chunk it is applied to. Comparing the two made the answer
  // look empty and the top-level `text` came out without it.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  // Two messages: 3,990 characters, then 3,996 more. The edit rewrites the second message
  // and appends the answer, which pushes it past the 4,000-character field.
  const card = `${'w'.repeat(3990)}\n${'v'.repeat(3996)}`
  assert.equal(card.length, 7987, `fixture is ${card.length} characters`)
  await handle.send({ key: 'D1', kind: 'direct' }, { text: card, buttons: [{ data: 'q:q1:0', label: 'yes' }] })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  assert.equal(posts.length, 2, `the card was sent as ${posts.length} messages`)
  const sent = posts.at(-1).params.blocks.filter(block => block.type === 'section').map(block => block.text.text).join('')
  assert.ok(sent.length > 3990, `the last message is ${sent.length} characters`)
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.3', { text: `${card}\n— yes!!`, sentLength: card.length })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  assert.ok(update.params.text.length <= 4000, `text is ${update.params.text.length} characters`)
  assert.ok(update.params.text.startsWith('v'.repeat(40)), 'the fallback keeps the head of the message it rewrites')
  assert.ok(update.params.text.endsWith('— yes!!'), 'the fallback ends with the answer')
})

test('blank edges the split strips do not shift the answer in the fallback text', async (t) => {
  // `chunkMarkdown` drops the blank first lines, so the chunk is shorter than the card and
  // an offset measured on the card lands inside the answer. That cut `— yes!!` down to its
  // last few characters in the field screen readers read.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const opening = '\n\n\n\nDeploy the release branch?\n'
  const card = `${opening}${'z'.repeat(3999 - opening.length)}`
  assert.equal(card.length, 3999, `fixture is ${card.length} characters`)
  await handle.edit({ key: 'D1', kind: 'direct' }, '1700.4', { text: `${card}\n— yes!!`, sentLength: card.length })
  const update = fake.calls.find(call => call.method === 'chat.update')
  assert.ok(update !== undefined, 'chat.update called')
  assert.ok(update.params.text.length <= 4000, `text is ${update.params.text.length} characters`)
  assert.ok(update.params.text.startsWith('Deploy the release branch?'), 'the fallback keeps the question')
  assert.ok(update.params.text.endsWith('— yes!!'), 'the fallback ends with the answer')
})

test('a one-line fenced snippet does not turn the text after it into code', async (t) => {
  // A backtick fence's info string may not contain a backtick, so ```npm test``` is
  // literal text, not an opening marker. Counting it as one made the split close the
  // section with a fence line of its own, and Slack rendered the rest of it as code.
  const fake = await fakeSlack()
  const handle = slack.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  const text = `Deploy notes\n\`\`\`npm test\`\`\`\n${'p'.repeat(3100)}`
  await handle.send({ key: 'D1', kind: 'direct' }, { text })
  const posts = fake.calls.filter(call => call.method === 'chat.postMessage')
  const sections = posts.flatMap(post => post.params.blocks.filter(block => block.type === 'section'))
  assert.ok(sections.length > 1, 'the answer spans several sections')
  for (const section of sections) {
    const body = section.text.text
    assert.ok(body.length <= 3000, `section text is ${body.length} characters`)
    assert.ok(!body.split('\n').some(line => line.trim() === '```'), 'no section carries a fence line the text never opened')
  }
})
