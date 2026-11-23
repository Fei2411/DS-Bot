import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'

let hooks: ReturnType<typeof registerHooks> | undefined
let storeMod: typeof import('./notice-cursor-store.ts')
const storage = new Map<string, string>()

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '../storage') {
        return { url: 'mock:cursor-storage', shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:cursor-storage') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1
            export async function getItemAsync(key) {
              await new Promise(resolve => setTimeout(resolve, 2))
              return globalThis.__cursorStorage.get(key) ?? null
            }
            export async function setItemAsync(key, value) {
              await new Promise(resolve => setTimeout(resolve, 2))
              globalThis.__cursorStorage.set(key, value)
            }
          `,
        }
      }
      return nextLoad(url, context)
    },
  })
  ;(globalThis as any).__cursorStorage = storage
  storeMod = await import('./notice-cursor-store.ts')
})

after(() => {
  hooks?.deregister()
  delete (globalThis as any).__cursorStorage
})

test('recordNoticeSeen serializes concurrent callers so duplicate seq only fires once', async () => {
  storage.clear()
  storeMod.resetNoticeCursorStoreForTest()

  const results = await Promise.all([
    storeMod.recordNoticeSeen('host-1', 'boot-a', 7),
    storeMod.recordNoticeSeen('host-1', 'boot-a', 7),
    storeMod.recordNoticeSeen('host-1', 'boot-a', 7),
  ])
  assert.deepEqual(results, [true, false, false])

  // Concurrent rising sequence numbers must persist the highest watermark without losing updates.
  const rising = await Promise.all([
    storeMod.recordNoticeSeen('host-1', 'boot-a', 8),
    storeMod.recordNoticeSeen('host-1', 'boot-a', 10),
    storeMod.recordNoticeSeen('host-1', 'boot-a', 9),
  ])
  assert.deepEqual(rising, [true, true, false])
  const saved = await storeMod.loadNoticeCursor('host-1')
  assert.equal(saved?.boot, 'boot-a')
  assert.equal(saved?.seq, 10)
})

test('delayed notice from an older known boot never rolls back the active boot cursor', async () => {
  storage.clear()
  storeMod.resetNoticeCursorStoreForTest()

  await storeMod.saveNoticeCursor('host-1', 'boot-1', 5)
  await storeMod.saveNoticeCursor('host-1', 'boot-2', 2)

  // Delayed notice seq=6 from boot-1 is unseen in boot-1 (so it can notify once),
  // but active cursor must remain on boot-2 seq=2.
  assert.equal(await storeMod.recordNoticeSeen('host-1', 'boot-1', 6), true)
  assert.equal(await storeMod.recordNoticeSeen('host-1', 'boot-1', 6), false)

  const cursor = await storeMod.loadNoticeCursor('host-1')
  assert.equal(cursor?.boot, 'boot-2')
  assert.equal(cursor?.seq, 2)
  assert.equal(cursor?.seenBoots?.['boot-1'], 6)

  // Fresh cold-read from storage preserves per-boot watermarks.
  storeMod.resetNoticeCursorStoreForTest()
  assert.equal(await storeMod.recordNoticeSeen('host-1', 'boot-1', 6), false)
  assert.equal(await storeMod.recordNoticeSeen('host-1', 'boot-2', 2), false)
  assert.equal(await storeMod.recordNoticeSeen('host-1', 'boot-2', 3), true)
})
