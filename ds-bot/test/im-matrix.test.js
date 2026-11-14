import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import matrix from '../src/host/im/platforms/matrix.js'

// A fake Matrix homeserver: /sync answers with whatever the test queued, joins,
// sends and uploads record their calls, and the media endpoint returns fixed bytes.
async function fakeMatrix() {
  const calls = []
  const batches = []
  let firstSync = null
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
        if (url.includes('timeout=0')) return json(firstSync ?? { next_batch: 'first', rooms: {} })
        const batch = batches.length > 1 ? batches.shift() : batches[0]
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
    setFirst: payload => { firstSync = payload },
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

const until = async (fn, tries = 120) => {
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

const members = (ids) => ids.map(user => ({ type: 'm.room.member', state_key: user, content: { membership: 'join' } }))

const room = ({ join = [], events = [], name } = {}) => ({
  state: { events: [...(name === undefined ? [] : [{ type: 'm.room.name', content: { name } }]), ...members(join)] },
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

test('a plain-http homeserver is refused, so the token never travels in the clear', async () => {
  await assert.rejects(
    () => matrix.check({ ...FIELDS(), homeserver: 'http://matrix.example.org' }, envOf()),
    /must start with https/,
  )
})

test('a two-member room reads as a direct chat', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({ next_batch: 'n1', rooms: { join: { '!dm:example.org': room({ join: ['@bot:example.org', '@ada:example.org'], events: [message()] }) } } })
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

test('the first sync delivers what arrived while the Bot was off', async () => {
  const fake = await fakeMatrix()
  fake.setFirst({
    next_batch: 'first',
    rooms: {
      join: {
        '!dm:example.org': room({
          join: ['@bot:example.org', '@ada:example.org'],
          events: [message({ event_id: '$offline', content: { msgtype: 'm.text', body: 'sent while you were off' } })],
        }),
      },
    },
  })
  fake.batches.push({ next_batch: 'n2', rooms: {} })
  try {
    const { handle, seen } = await connected(fake)
    const got = await until(async () => seen.find(entry => entry.messageId === '$offline'))
    assert.equal(got.text, 'sent while you were off')
    handle.stop()
  } finally { fake.close() }
})

test('a group room keeps its kind without member events, and needs a mention', async () => {
  const fake = await fakeMatrix()
  const team = ['@bot:example.org', '@ada:example.org', '@bob:example.org']
  fake.setFirst({ next_batch: 'first', rooms: { join: { '!group:example.org': room({ join: team, name: 'Team' }) } } })
  fake.batches.push({
    next_batch: 'n2',
    rooms: {
      join: {
        '!group:example.org': {
          timeline: {
            events: [
              message({ event_id: '$quiet', content: { msgtype: 'm.text', body: 'no mention here' } }),
              message({ event_id: '$loud', content: { msgtype: 'm.text', body: 'please answer', 'm.mentions': { user_ids: ['@bot:example.org'] } } }),
            ],
          },
        },
      },
    },
  })
  try {
    const { handle, seen } = await connected(fake)
    const loud = await until(async () => seen.find(entry => entry.messageId === '$loud'))
    const quiet = await until(async () => seen.find(entry => entry.messageId === '$quiet'))
    assert.equal(loud.chat.kind, 'group')
    assert.equal(loud.chat.title, 'Team')
    assert.equal(loud.mentioned, true)
    // The room stayed a group even though this batch carried no member events.
    assert.equal(quiet.chat.kind, 'group')
    assert.equal(quiet.mentioned, false)
    handle.stop()
  } finally { fake.close() }
})

test('a word that merely contains the Bot name is not a mention', async () => {
  const fake = await fakeMatrix()
  const team = ['@bot:example.org', '@ada:example.org', '@bob:example.org']
  fake.setFirst({ next_batch: 'first', rooms: { join: { '!group:example.org': room({ join: team }) } } })
  fake.batches.push({
    next_batch: 'n2',
    rooms: {
      join: {
        '!group:example.org': {
          timeline: {
            events: [
              message({ event_id: '$robot', content: { msgtype: 'm.text', body: 'the robot vacuum is broken' } }),
              message({ event_id: '$named', content: { msgtype: 'm.text', body: 'bot what do you think?' } }),
            ],
          },
        },
      },
    },
  })
  try {
    const { handle, seen } = await connected(fake)
    const named = await until(async () => seen.find(entry => entry.messageId === '$named'))
    const robot = await until(async () => seen.find(entry => entry.messageId === '$robot'))
    assert.equal(named.mentioned, true)
    assert.equal(robot.mentioned, false)
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
          join: ['@bot:example.org', '@ada:example.org'],
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

test('a stopped connection stops delivering', async () => {
  const fake = await fakeMatrix()
  fake.batches.push({ next_batch: 'n1', rooms: {} })
  try {
    const { handle, seen } = await connected(fake)
    handle.stop()
    fake.batches.push({
      next_batch: 'n2',
      rooms: { join: { '!dm:example.org': room({ join: ['@bot:example.org', '@ada:example.org'], events: [message({ event_id: '$late' })] }) } },
    })
    const leaked = await until(async () => seen.find(entry => entry.messageId === '$late'), 25)
    assert.equal(leaked, undefined)
  } finally { fake.close() }
})
