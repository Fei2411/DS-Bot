import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAvatarResolver, sameRoster } from '../src/client/avatar-refs.js'

const state = refs => ({ revision: 1, bots: Object.entries(refs).map(([id, ref]) => ({ id, name: id, avatar: ref ? { shape: 'circle', imageRef: ref } : { shape: 'circle' } })) })

test('a photo is fetched once per ref and the ref stays out of the roster', async () => {
  const photos = { a: { ref: 'r1', image: 'data:a1' }, b: { ref: 'r2', image: 'data:b' } }
  const asked = []
  const resolve = createAvatarResolver(async (botId) => { asked.push(botId); return { botId, ...photos[botId] } })

  const first = await resolve(state({ a: 'r1', b: 'r2', c: null }))
  assert.deepEqual(first.bots.map(bot => bot.avatar), [{ shape: 'circle', image: 'data:a1' }, { shape: 'circle', image: 'data:b' }, { shape: 'circle' }])
  assert.deepEqual(asked, ['a', 'b'])

  await resolve(state({ a: 'r1', b: 'r2', c: null }))
  assert.deepEqual(asked, ['a', 'b'])

  photos.a = { ref: 'r3', image: 'data:a2' }
  const changed = await resolve(state({ a: 'r3', b: 'r2', c: null }))
  assert.equal(changed.bots[0].avatar.image, 'data:a2')
  assert.deepEqual(asked, ['a', 'b', 'a'])
})

test('an unchanged answer passes through and a failed fetch leaves the Bot without a photo', async () => {
  const resolve = createAvatarResolver(async () => { throw new Error('gone') })
  const unchanged = { revision: 1, unchanged: true }
  assert.equal(await resolve(unchanged), unchanged)
  const value = await resolve(state({ a: 'r1' }))
  assert.deepEqual(value.bots[0].avatar, { shape: 'circle' })
})

test('a photo that failed is reported missing until a later answer fetches it', async () => {
  let up = false
  const resolve = createAvatarResolver(async (botId) => {
    if (!up) throw new Error('busy')
    return { botId, ref: 'r1', image: 'data:a' }
  })
  await resolve(state({ a: 'r1' }))
  assert.equal(resolve.missing(), true)
  await resolve({ revision: 1, unchanged: true })
  assert.equal(resolve.missing(), true)
  up = true
  const value = await resolve(state({ a: 'r1' }))
  assert.equal(value.bots[0].avatar.image, 'data:a')
  assert.equal(resolve.missing(), false)
})

test('Bots that share a photo fetch it once', async () => {
  const asked = []
  const resolve = createAvatarResolver(async (botId) => { asked.push(botId); return { botId, ref: 'r1', image: 'data:logo' } })
  const value = await resolve(state({ a: 'r1', b: 'r1' }))
  assert.deepEqual(value.bots.map(bot => bot.avatar.image), ['data:logo', 'data:logo'])
  assert.deepEqual(asked, ['a'])
})

test('a full answer asked for to fetch missing photos is applied at the same revision', () => {
  const current = { revision: 4, modelsKey: 'm' }
  assert.equal(sameRoster({ revision: 4, modelsKey: 'm', bots: [] }, current), true)
  assert.equal(sameRoster({ revision: 4, modelsKey: 'm', bots: [] }, current, true), false)
  assert.equal(sameRoster({ revision: 4, unchanged: true }, current, true), true)
})

test('an older pull that finishes late keeps the newer pull\'s cache and missing count', async () => {
  let release
  const slow = new Promise(resolve => { release = resolve })
  const asked = []
  const resolve = createAvatarResolver(async (botId) => {
    asked.push(botId)
    if (botId === 'old') { await slow; throw new Error('busy') }
    return { botId, ref: 'r2', image: 'data:new' }
  })
  const older = resolve(state({ old: 'r1' }), 1)
  await resolve(state({ b: 'r2' }), 2)
  release()
  await older
  assert.equal(resolve.missing(), false)
  await resolve(state({ b: 'r2' }), 3)
  assert.deepEqual(asked, ['old', 'b'])
})

test('a Bot sharing a ref asks for its own photo when the shared answer has another ref', async () => {
  const photos = { a: { ref: 'r9', image: 'data:a-new' }, b: { ref: 'r1', image: 'data:logo' } }
  const resolve = createAvatarResolver(async (botId) => ({ botId, ...photos[botId] }))
  const value = await resolve(state({ a: 'r1', b: 'r1' }))
  assert.deepEqual(value.bots.map(bot => bot.avatar.image), ['data:a-new', 'data:logo'])
})
