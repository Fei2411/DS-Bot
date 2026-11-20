import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createChatQueue, detectImageMediaType, fileExtension,
  isHttpUrl, readCappedBytes,
} from '../src/host/im/platforms/media.js'

test('detectImageMediaType strictly matches DSH-accepted image magic bytes only', () => {
  assert.equal(detectImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(detectImageMediaType(Buffer.from('GIF87a')), 'image/gif')
  assert.equal(detectImageMediaType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(detectImageMediaType(Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1')), 'image/webp')
  // Unsupported or invalid bytes must return undefined, never guess image/jpeg.
  assert.equal(detectImageMediaType(Buffer.from('GIF8')), undefined)
  assert.equal(detectImageMediaType(Buffer.from('BM\x00\x00\x00\x00')), undefined)
  assert.equal(detectImageMediaType(Buffer.from('<svg></svg>')), undefined)
  assert.equal(detectImageMediaType(Buffer.from('<html>502 Bad Gateway</html>')), undefined)
  assert.equal(detectImageMediaType(Buffer.alloc(0)), undefined)
})

test('isHttpUrl and fileExtension reject unsafe schemes and extensionless names', () => {
  assert.equal(isHttpUrl('https://cdn.example.com/a.png'), true)
  assert.equal(isHttpUrl('http://127.0.0.1:8080/a.png'), true)
  assert.equal(isHttpUrl('data:image/png;base64,AAAA'), false)
  assert.equal(isHttpUrl('file:///etc/passwd'), false)
  assert.equal(isHttpUrl(''), false)
  assert.equal(fileExtension('png'), '')
  assert.equal(fileExtension('shot.PNG'), 'png')
  assert.equal(fileExtension('archive.tar.gz'), 'gz')
})

test('readCappedBytes cancels oversized chunked streams and oversized content-length responses', async () => {
  let cancelledDeclared = false
  const declaredResp = {
    headers: new Headers({ 'content-length': '100' }),
    body: { cancel: async () => { cancelledDeclared = true } },
  }
  const overDeclared = await readCappedBytes(declaredResp, 10)
  assert.deepEqual(overDeclared, { overLimit: true })
  assert.equal(cancelledDeclared, true)

  let cancelledStream = false
  let pulls = 0
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]))
    },
    cancel() {
      cancelledStream = true
    },
  })
  const overStream = await readCappedBytes({ headers: new Headers(), body: stream }, 10)
  assert.deepEqual(overStream, { overLimit: true })
  assert.equal(cancelledStream, true)
  assert.ok(pulls <= 3, 'stopped pulling once limit exceeded')
})

test('createChatQueue preserves order and emits no unhandledRejection when a task throws', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const inOrder = createChatQueue()
    const seen = []
    const first = inOrder('c1', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      seen.push('first-fail')
      throw new Error('boom')
    })
    const second = inOrder('c1', async () => {
      seen.push('second-ok')
      return 'done'
    })
    await assert.rejects(first, /boom/)
    assert.equal(await second, 'done')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(seen, ['first-fail', 'second-ok'])
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
