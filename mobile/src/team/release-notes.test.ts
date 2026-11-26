import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'

import type { MobileReleaseNotesEntry } from './release-notes.ts'

let hooks: ReturnType<typeof registerHooks> | undefined
let mod: typeof import('./release-notes.ts')

const SAMPLE_RELEASES: MobileReleaseNotesEntry[] = [
  { version: '0.3.10', date: '2026-11-22', notes: { zh: { items: ['十'] }, en: { items: ['ten'] } } },
  { version: '0.3.9', date: '2026-11-21', notes: { zh: { items: ['九'] }, en: { items: ['nine'] } } },
  { version: '0.3.8', date: '2026-11-16', notes: { en: { items: ['eight'] } } },
]

function memoryStorage(initial: Record<string, string> = {}, { failWrite = false } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async getItemAsync(key: string) { return map.get(key) ?? null },
    async setItemAsync(key: string, value: string) {
      if (failWrite) throw new Error('storage write failed')
      map.set(key, value)
    },
  }
}

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react' || specifier === '../storage') {
        return { url: `mock:rn:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:rn:react') {
        return { format: 'module', shortCircuit: true, source: 'export const useState = x => [x, () => {}]; export const useEffect = () => {}' }
      }
      if (url === 'mock:rn:../storage') {
        return {
          format: 'module',
          shortCircuit: true,
          source: 'export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1; export async function getItemAsync() { return null }; export async function setItemAsync() {}',
        }
      }
      return nextLoad(url, context)
    },
  })
  mod = await import('./release-notes.ts')
})

after(() => { hooks?.deregister() })

test('fresh install records current version silently without showing modal', async () => {
  const storage = memoryStorage()
  const result = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: false,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(result, { show: false, current: '0.3.10', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')
})

test('existing user upgrading from build without seen key sees only current release once', async () => {
  const storage = memoryStorage()
  const first = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(first, { show: true, current: '0.3.10', versions: ['0.3.10'] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')

  const second = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(second, { show: false, current: '0.3.10', versions: [] })
})

test('multi-version upgrade merges intermediate releases and downgrade stays silent without rolling back', async () => {
  const storage = memoryStorage({ [mod.RELEASE_NOTES_SEEN_KEY]: '0.3.8' })
  const multi = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(multi, { show: true, current: '0.3.10', versions: ['0.3.10', '0.3.9'] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')

  const downgrade = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.8',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(downgrade, { show: false, current: '0.3.8', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')
})

test('storage write failure suppresses popup and keeps unseen for retry', async () => {
  const storage = memoryStorage({ [mod.RELEASE_NOTES_SEEN_KEY]: '0.3.9' }, { failWrite: true })
  const failed = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(failed, { show: false, current: '0.3.10', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.9')
})
