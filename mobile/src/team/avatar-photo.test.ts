import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avatarPhoto } from './avatar-photo.ts'

test('picked photos use the JPEG renderer instead of sending original MIME or bytes', async () => {
  for (const mimeType of ['image/heic', 'image/svg+xml', 'image/png', undefined]) {
    const asset = { uri: 'file:///photo', width: 1200, height: 800, mimeType, base64: 'original' }
    const image = await avatarPhoto(asset, async (uri, actions) => {
      assert.equal(uri, asset.uri)
      assert.deepEqual(actions, [
        { crop: { originX: 200, originY: 0, width: 800, height: 800 } },
        { resize: { width: 160, height: 160 } },
      ])
      return { base64: '/9j/2Q==' }
    })
    assert.equal(image, 'data:image/jpeg;base64,/9j/2Q==')
  }
})

test('photos need no picker base64, and portrait images crop from the center', async () => {
  const image = await avatarPhoto({ uri: 'file:///portrait', width: 400, height: 600 }, async (_uri, actions) => {
    assert.deepEqual(actions[0], { crop: { originX: 0, originY: 100, width: 400, height: 400 } })
    return { base64: '/9j/2Q==' }
  })
  assert.match(image, /^data:image\/jpeg;base64,/)
})

test('missing, oversized, and undecodable photos fail before an avatar can be sent', async () => {
  const asset = { uri: 'file:///photo', width: 160, height: 160 }
  for (const base64 of [undefined, '', 'a'.repeat(160000)]) {
    await assert.rejects(avatarPhoto(asset, async () => ({ base64 })))
  }
  const failure = new Error('Cannot decode this photo')
  await assert.rejects(avatarPhoto(asset, async () => { throw failure }), error => error === failure)
})
