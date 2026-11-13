import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import matrix from '../src/host/im/platforms/matrix.js'

// A fake Matrix homeserver: /sync answers with whatever the test queued, joins,
// sends and uploads record their calls, and the media endpoint returns fixed bytes.
async function fakeMatrix() {
  const calls = []
  const batches = []
  const MEDIA = Buffer.from('file-bytes')
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const url = String(req.url ?? '')
      calls.push({ method: req.method, path: url, body, auth: req.headers.authorization })
      const json = payload => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.startsWith('/_matrix/client/v3/account/whoami')) return json({ user_id: '@bot:example.org' })
      if (url.includes('/account_data/m.direct')) return json({})
      if (url.startsWith('/_matrix/client/v3/sync')) {
        const batch = batches.length > 1 ? batches.shift() : batches[0]
        if (url.includes('timeout=0')) return json({ next_batch: 'first', rooms: {} })
        return json(batch ?? { next_batch: 'empty' })
      }
      if (url.startsWith('/_matrix/client/v3/join/')) return json({ room_id: decodeURIComponent(url.split('/join/')[1]) })
      if (url.startsWith('/_matrix/client/v3/rooms/') && url.includes('/send/m.room.message/')) return json({ event_id: '$sent' })
      if (url.startsWith('/_matrix/media/v3/upload')) return json({ content_uri: 'mxc://example.org/up1' })
      if (url.startsWith('/_matrix/client/v1/media/download/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(MEDIA)
        return undefined
      }
      return json({})
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    calls, batches, MEDIA,
    close: () => { http.closeAllConnections?.(); http.close() },
  }
}

const FIELDS = () => ({ homeserver: '', userId: '@bot:example.org', accessToken: 'tok' })
const envOf = () => ({
  fetch: globalThis.fetch,
  config: {},
  runtime: { get: () => ({}), set: () => {} },
  log: { warn: () => {} },
})

const until = async (fn, tries = 100) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 20))
  }
  return undefined
}

const message = (over = {}) => ({
  type: 'm.room.message',
  event_id: `$m${Math.random().toString(16).slice(2)}`,
  sender: '@ada:example.org',
  content: { msgtype: 'm.text', body: 'hello' },
  ...over,
})

const room = ({ members = [], events = [], name } = {}) => ({
  state: {
    events: [
      ...(name === undefined ? [] : [{ type: 'm.room.name', content: { name } }]),
      ...members.map(user => ({ type: 'm.room.member', state_key: user, content: { membership: 'join' } })),
    ],
  },
  timeline: { events },
})

async function connected(fake, fields = FIELDS()) {
  const seen = []
  const statuses = []
  const handle = matrix.connect({ ...fields, homeserver: fake.url }, envOf(fake), {
    onMessage: async msg => { seen.push(msg) },
    onStatus: status => { statuses.push(status) },
  })
  await until(async () => statuses.some(status => status.state === 'ready'))
  return { handle, seen, statuses }
}

test('check names the account from the homeserver', async () => {
  const fake = await fakeMatrix()
  try {
    const { account } = await matrix.check({ ...FIELDS(), homeserver: fake.url }, envOf(fake))
    assert.equal(account.id, '@bot:example.org')
    assert.equal(fake.calls[0].auth, 'Bearer tok')
  } finally { fake.close() }
})

test('a two-member room reads as a direct chat', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({ next_batch: 'n1', rooms: { join: { '!dm:example.org': room({ members: ['@bot:example.org', '@ada:example.org'], events: [message()] }) } } })
  try {
    const { handle, seen } = await connected(fake)
    const got = await until(async () => seen[0])
    assert.equal(got.chat.kind, 'direct')
    assert.equal(got.chat.key, '!dm:example.org')
    assert.equal(got.text, 'hello')
    assert.equal(got.sender.id, '@ada:example.org')
    handle.stop()
  } finally { fake.close() }
})

test('a group room answers only when the bot is mentioned', async () => {
  const fake = await fakeMatrix()
  const members = ['@bot:example.org', '@ada:example.org', '@bob:example.org']
  fake.batches.push({
    next_batch: 'n1',
    rooms: {
      join: {
        '!group:example.org': room({
          members,
          name: 'Team',
          events: [
            message({ event_id: '$quiet', content: { msgtype: 'm.text', body: 'no mention here' } }),
            message({
              event_id: '$loud',
              content: { msgtype: 'm.text', body: 'bot please answer', 'm.mentions': { user_ids: ['@bot:example.org'] } },
            }),
          ],
        }),
      },
    },
  })
  try {
    const { handle, seen } = await connected(fake)
    const got = await until(async () => seen.find(entry => entry.messageId === '$loud'))
    assert.equal(got.chat.kind, 'group')
    assert.equal(got.chat.title, 'Team')
    assert.equal(got.mentioned, true)
    // The adapter reports the mention; the channel is what drops an unmentioned group message.
    const quiet = await until(async () => seen.find(entry => entry.messageId === '$quiet'))
    assert.equal(quiet.mentioned, false)
    handle.stop()
  } finally { fake.close() }
})

test('an invite is joined right away', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({
    next_batch: 'n1',
    rooms: {
      invite: {
        '!new:example.org': {
          invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:example.org', content: { membership: 'invite' } }] },
        },
      },
    },
  })
  try {
    const { handle } = await connected(fake)
    const joined = await until(async () => fake.calls.find(call => call.path.startsWith('/_matrix/client/v3/join/')))
    assert.ok(joined.path.includes(encodeURIComponent('!new:example.org')))
    assert.equal(joined.method, 'POST')
    handle.stop()
  } finally { fake.close() }
})

test('send writes an m.text message, and stops at the room', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({ next_batch: 'n1', rooms: {} })
  try {
    const { handle } = await connected(fake)
    await handle.send({ key: '!dm:example.org', kind: 'direct', title: '' }, { text: 'ping' })
    const sent = fake.calls.find(call => call.path.includes('/send/m.room.message/'))
    assert.ok(sent.path.includes(encodeURIComponent('!dm:example.org')))
    assert.equal(sent.method, 'PUT')
    assert.deepEqual(JSON.parse(sent.body), { msgtype: 'm.text', body: 'ping' })
    handle.stop()
  } finally { fake.close() }
})

test('a file is uploaded first and then sent as m.file', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({ next_batch: 'n1', rooms: {} })
  try {
    const { handle } = await connected(fake)
    await handle.send({ key: '!dm:example.org', kind: 'direct', title: '' }, {
      text: '',
      files: [{ name: 'report.pdf', mediaType: 'application/pdf', data: Buffer.from('pdf') }],
    })
    const upload = fake.calls.find(call => call.path.startsWith('/_matrix/media/v3/upload'))
    assert.ok(upload.path.includes('filename=report.pdf'))
    const sent = JSON.parse(fake.calls.find(call => call.path.includes('/send/m.room.message/')).body)
    assert.equal(sent.msgtype, 'm.file')
    assert.equal(sent.body, 'report.pdf')
    assert.equal(sent.url, 'mxc://example.org/up1')
    assert.equal(sent.info.mimetype, 'application/pdf')
    handle.stop()
  } finally { fake.close() }
})

test('an attachment is downloaded through the authenticated media endpoint', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({
    next_batch: 'n1',
    rooms: {
      join: {
        '!dm:example.org': room({
          members: ['@bot:example.org', '@ada:example.org'],
          events: [
            message({
              event_id: '$file',
              content: { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://example.org/abc', info: { mimetype: 'text/plain' } },
            }),
          ],
        }),
      },
    },
  })
  try {
    const { handle, seen } = await connected(fake)
    const got = await until(async () => seen.find(entry => entry.messageId === '$file'))
    assert.equal(got.files.length, 1)
    assert.equal(got.files[0].name, 'notes.txt')
    assert.equal(String(got.files[0].data), String(fake.MEDIA))
    const download = fake.calls.find(call => call.path.startsWith('/_matrix/client/v1/media/download/'))
    assert.equal(download.auth, 'Bearer tok')
    handle.stop()
  } finally { fake.close() }
})
