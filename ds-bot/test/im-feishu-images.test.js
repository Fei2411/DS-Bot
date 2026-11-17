import assert from 'node:assert/strict'
import { test } from 'node:test'
import feishu from '../src/host/im/platforms/feishu.js'
import { replyImages } from '../src/host/im/reply-images.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=', 'base64')

async function sender(t, { readImage, failSendAt, uploadFailure } = {}) {
  const reads = [], uploads = [], sent = [], sendAttempts = []
  let attempts = 0
  let rejectUpload = uploadFailure
  const handle = feishu.connect({ appId: 'test-app', appSecret: 'test-secret' }, {
    readImage: async (context, path) => {
      reads.push({ context, path })
      return readImage ? readImage(context, path) : { bytes: PNG.toString('base64'), mime: 'image/png' }
    },
    WebSocket: class { addEventListener() {} close() {} },
    fetch: async (url, options) => {
      if (url.includes('/auth/')) return Response.json({ tenant_access_token: 'test-token', expire: 7200 })
      if (url.includes('/bot/v3/info')) return Response.json({ bot: { open_id: 'ou_bot' } })
      if (url.includes('/callback/ws/endpoint')) return Response.json({ code: 0, data: { URL: 'wss://example.test/ws' } })
      if (url.endsWith('/im/v1/images')) {
        assert.equal(options.headers['content-type'], undefined, 'fetch must set the multipart boundary')
        assert.equal(options.body.get('image_type'), 'message')
        const file = options.body.get('image')
        assert.equal(file.type, 'image/png')
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
        if (rejectUpload) { rejectUpload = false; return Response.json({ code: 99991400, msg: 'try again' }, { status: 503 }) }
        const key = `img_uploaded_${uploads.length}`
        uploads.push(key)
        return Response.json({ code: 0, data: { image_key: key } })
      }
      assert.match(url, /\/im\/v1\/messages\?receive_id_type=chat_id$/)
      sendAttempts.push(JSON.parse(options.body))
      attempts += 1
      if (attempts === failSendAt) return Response.json({ code: 99991400, msg: 'try again' }, { status: 503 })
      const body = JSON.parse(options.body)
      sent.push({ ...body, content: JSON.parse(body.content) })
      return Response.json({ code: 0, data: { message_id: `om_${sent.length}` } })
    },
  }, { onMessage() {}, onAction() {}, onStatus() {} })
  t.after(() => handle.stop())
  return { handle, reads, uploads, sent, sendAttempts }
}

test('local reply image links exclude fenced examples, inline code, remote URLs and network shares', () => {
  const text = 'Before ![screen](<output/a b.png>)\n`![code](secret.png)`\n```md\n![example](example.png)\n```\n![remote](https://example.test/a.png) ![share](//server/share.png)'
  const parsed = replyImages(text)
  assert.deepEqual(parsed.images, [{ path: 'output/a b.png', label: 'screen' }])
  assert.match(parsed.text, /`!\[code\]\(secret.png\)`/)
  assert.match(parsed.text, /!\[remote\]\(https:/)
  assert.doesNotMatch(parsed.text, /output\/a b.png/)
})

test('local image links accept relative, encoded, Windows and file URL paths', () => {
  assert.deepEqual(replyImages('![a](./a%20b.png) ![b](C:/work/b.png) ![c](file:///work/c.png)').images.map(x => x.path), ['./a%20b.png', 'C:/work/b.png', 'file:///work/c.png'])
})

test('literal images in code blocks, variable backtick spans and escaped markers are never uploaded', () => {
  for (const text of [
    '    ![example](secret.png)',
    '\t![example](secret.png)',
    '``literal ` ![example](secret.png)``',
    '\\![example](secret.png)',
    '````md\n![example](secret.png)\n````',
    '<!-- ![example](secret.png) -->',
  ]) {
    assert.deepEqual(replyImages(text).images, [], text)
    assert.equal(replyImages(text).text, text)
  }
})

test('balanced parenthesis and reference images are resolved as Markdown images', () => {
  const text = '![plot](output/plot(1).png)\n![plot][Chart]\n![Chart][]\n![Chart]\n\n[chart]: output/plot.png "Plot"'
  assert.deepEqual(replyImages(text).images.map(image => image.path), [
    'output/plot(1).png', 'output/plot.png', 'output/plot.png', 'output/plot.png',
  ])
})

test('replacing a real image does not edit the identical source in a code example', () => {
  const text = '`![same](same.png)` then ![same](same.png)'
  assert.equal(replyImages(text).text, '`![same](same.png)` then same')
})

test('undefined references and code-only definitions never trigger a read', () => {
  assert.deepEqual(replyImages('![unknown][missing]').images, [])
  assert.deepEqual(replyImages('![unknown][missing]\n\n    [missing]: secret.png').images, [])
})

test('reference-style remote images remain text', () => {
  const text = '![remote][image]\n\n[image]: https://example.test/image.png'
  assert.deepEqual(replyImages(text), { text, images: [] })
})

test('Bot reply images are read through the workspace endpoint, uploaded, then sent natively', async t => {
  const s = await sender(t)
  const job = { text: 'Here is ![screenshot](./output/screenshot.png)', imageContext: { sessionId: 'part-a' } }
  const result = await s.handle.send({ key: 'oc_origin' }, job)
  assert.deepEqual(s.reads, [{ context: { sessionId: 'part-a' }, path: './output/screenshot.png' }])
  assert.equal(s.uploads.length, 1)
  assert.equal(s.sent.length, 2)
  assert.equal(s.sent[1].receive_id, 'oc_origin')
  assert.equal(s.sent[1].msg_type, 'image')
  assert.deepEqual(s.sent[1].content, { image_key: 'img_uploaded_0' })
  assert.equal(result.messageId, 'om_2')
})

test('group reply image reads retain the member author context', async t => {
  const s = await sender(t)
  await s.handle.send({ key: 'oc_group' }, { text: '![screen](screen.png)', imageContext: { sessionId: 'group-part', botId: 'member' } })
  assert.deepEqual(s.reads[0].context, { sessionId: 'group-part', botId: 'member' })
  assert.equal(s.sent.at(-1).receive_id, 'oc_group')
})

test('a message without reply context never reads a local image', async t => {
  const s = await sender(t)
  await s.handle.send({ key: 'oc_chat' }, { text: '![untrusted](secret.png)' })
  assert.equal(s.reads.length, 0)
  assert.equal(s.uploads.length, 0)
})

test('retry resumes at the failed image without repeating earlier text, images or uploads', async t => {
  const s = await sender(t, { failSendAt: 3 })
  const job = { text: '![one](one.png) ![two](two.png)', imageContext: { sessionId: 'part-a' } }
  await assert.rejects(s.handle.send({ key: 'oc_chat' }, job), /try again/)
  assert.equal(s.sent.length, 2)
  const result = await s.handle.send({ key: 'oc_chat' }, job)
  assert.equal(s.uploads.length, 2)
  assert.equal(s.reads.length, 2)
  assert.equal(s.sent.length, 3)
  assert.equal(result.messageId, 'om_3')
  assert.equal(s.sendAttempts[2].uuid, s.sendAttempts[3].uuid)
  assert.notEqual(s.sendAttempts[1].uuid, s.sendAttempts[2].uuid)
})

test('a replacement connection resumes the same queued image job', async t => {
  const first = await sender(t, { failSendAt: 2 })
  const job = { text: '![screen](screen.png)', imageContext: { sessionId: 'part-a' } }
  await assert.rejects(first.handle.send({ key: 'oc_chat' }, job), /try again/)
  first.handle.stop()
  const second = await sender(t)
  await second.handle.send({ key: 'oc_chat' }, job)
  assert.equal(second.reads.length, 0)
  assert.equal(second.uploads.length, 0)
  assert.equal(second.sent.length, 1)
  assert.equal(second.sent[0].msg_type, 'image')
  assert.equal(first.sendAttempts[1].uuid, second.sendAttempts[0].uuid)
})

test('retry after upload failure does not repeat the already delivered caption', async t => {
  const s = await sender(t, { uploadFailure: true })
  const job = { text: '![screen](screen.png)', imageContext: { sessionId: 'part-a' } }
  await assert.rejects(s.handle.send({ key: 'oc_chat' }, job), /upload failed/)
  assert.equal(s.sent.length, 1)
  await s.handle.send({ key: 'oc_chat' }, job)
  assert.equal(s.sent.length, 2)
  assert.equal(s.sent.at(-1).msg_type, 'image')
})

test('denied or missing image paths are surfaced and never uploaded', async t => {
  const s = await sender(t, { readImage: async () => { throw new Error('Image outside workspace') } })
  await assert.rejects(s.handle.send({ key: 'oc_chat' }, { text: '![secret](../secret.png)', imageContext: { sessionId: 'part-a' } }), /outside workspace/)
  assert.equal(s.uploads.length, 0)
})

test('unsupported image bytes are refused rather than uploaded with a guessed MIME', async t => {
  const s = await sender(t, { readImage: async () => ({ bytes: Buffer.from('<svg/>').toString('base64'), mime: 'image/svg+xml' }) })
  await assert.rejects(s.handle.send({ key: 'oc_chat' }, { text: '![vector](a.svg)', imageContext: { sessionId: 'part-a' } }), /unsupported image format/)
  assert.equal(s.uploads.length, 0)
})
