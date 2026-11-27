import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import type { AndroidReleaseInfo } from './app-update.ts'

let hooks: ReturnType<typeof registerHooks> | undefined
let updateStore: typeof import('./app-update-store.ts')

const SAMPLE_RELEASE: AndroidReleaseInfo = {
  version: '0.4.0',
  apkName: 'ds-bot-0.4.0-arm64.apk',
  sha256: 'a'.repeat(64),
  size: 40_000_000,
  downloadUrls: ['https://example.com/ds-bot-0.4.0-arm64.apk'],
  releasePageUrl: 'https://github.com/Fei2411/DS-Bot/releases/tag/v0.4.0',
  notes: 'Bug fixes',
}

interface StoreMocks {
  prefs: Record<string, string>
  checkImpl: (args: any) => Promise<any>
  downloadImpl: (url: string, fileName: string, sha256: string, size: number) => Promise<any>
  cancelCalls: number
  cleanupCalls: (string | null)[]
  cachedApk: { path: string; size: number; sha256: string } | null
  canInstall: boolean
  progressListeners: Set<(p: any) => void>
}

const mocks: StoreMocks = {
  prefs: {},
  checkImpl: async () => ({ status: 'available', release: SAMPLE_RELEASE, etag: '"e1"' }),
  downloadImpl: async () => ({ path: '/cache/updates/ds-bot-0.4.0-arm64.apk', size: 40_000_000, sha256: 'a'.repeat(64) }),
  cancelCalls: 0,
  cleanupCalls: [],
  cachedApk: null,
  canInstall: true,
  progressListeners: new Set(),
}

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === 'react'
        || specifier === 'react-native'
        || specifier === 'expo-constants'
        || specifier === '../store.ts'
        || specifier === './app-update.ts'
        || specifier === './app-update-native'
      ) {
        return { url: `mock:upd:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:upd:react') {
        return { format: 'module', shortCircuit: true, source: `export const useState = (x) => [x, () => {}]; export const useEffect = () => {}` }
      }
      if (url === 'mock:upd:react-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const Platform = { OS: 'android' }
            export const AppState = { addEventListener: () => ({ remove() {} }) }
          `,
        }
      }
      if (url === 'mock:upd:expo-constants') {
        return { format: 'module', shortCircuit: true, source: `export default { expoConfig: { version: '0.3.10' } }` }
      }
      if (url === 'mock:upd:../store.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export async function readPrefs() { return { ...globalThis.__updMocks.prefs } }
            export async function writePrefs(patch) { Object.assign(globalThis.__updMocks.prefs, patch) }
          `,
        }
      }
      if (url === 'mock:upd:./app-update.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const AUTO_CHECK_INTERVAL_MS = 21600000
            export const checkAndroidUpdate = (args) => globalThis.__updMocks.checkImpl(args)
            export const isNewerVersion = (a, b) => a !== b && a > b
            export const normalizeMirrorBase = (raw) => {
              const trimmed = raw.trim().replace(/\\/+$/, '')
              if (!trimmed) return ''
              return trimmed.startsWith('https://') ? trimmed : null
            }
          `,
        }
      }
      if (url === 'mock:upd:./app-update-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const isAndroidUpdaterAvailable = () => true
            export const canInstallPackages = async () => globalThis.__updMocks.canInstall
            export const getCachedApk = async () => globalThis.__updMocks.cachedApk
            export const downloadApk = (...args) => globalThis.__updMocks.downloadImpl(...args)
            export const cancelApkDownload = async () => { globalThis.__updMocks.cancelCalls += 1 }
            export const installApk = async () => true
            export const cleanupUpdateCache = async (keep) => { globalThis.__updMocks.cleanupCalls.push(keep) }
            export const openInstallPermissionSettings = async () => {}
            export const onUpdateDownloadProgress = (fn) => {
              globalThis.__updMocks.progressListeners.add(fn)
              return () => globalThis.__updMocks.progressListeners.delete(fn)
            }
          `,
        }
      }
      return nextLoad(url, context)
    },
  })
  ;(globalThis as any).__updMocks = mocks
  updateStore = await import('./app-update-store.ts')
})

after(() => {
  hooks?.deregister()
  delete (globalThis as any).__updMocks
})

function resetMocks() {
  mocks.prefs = {}
  mocks.cancelCalls = 0
  mocks.cleanupCalls = []
  mocks.cachedApk = null
  mocks.canInstall = true
  mocks.progressListeners.clear()
  mocks.checkImpl = async () => ({ status: 'available', release: SAMPLE_RELEASE, etag: '"e1"' })
  mocks.downloadImpl = async () => ({ path: '/cache/updates/ds-bot-0.4.0-arm64.apk', size: 40_000_000, sha256: 'a'.repeat(64) })
  updateStore.resetAppUpdateStoreForTest()
}

test('cancel followed by immediate redownload uses generation tokens so stale cancel cannot clobber the new download', async () => {
  resetMocks()
  await updateStore.checkForAppUpdate({ manual: true })
  assert.equal(updateStore.getAppUpdateState().phase, 'available')

  let rejectFirst!: (err: Error) => void
  let resolveSecond!: (val: any) => void
  let attempts = 0
  mocks.downloadImpl = () => {
    attempts += 1
    if (attempts === 1) {
      return new Promise((_res, rej) => { rejectFirst = rej })
    }
    return new Promise((res) => { resolveSecond = res })
  }

  const first = updateStore.downloadAppUpdate()
  // Phase flips synchronously before any await; rapid double-tap is ignored.
  assert.equal(updateStore.getAppUpdateState().phase, 'downloading')
  await updateStore.downloadAppUpdate()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 1)

  // Cancel transitions immediately to available and calls native cancel.
  await updateStore.cancelAppUpdateDownload()
  assert.equal(mocks.cancelCalls, 1)
  assert.equal(updateStore.getAppUpdateState().phase, 'available')

  // Immediately start a second download BEFORE the first native promise unwinds.
  const second = updateStore.downloadAppUpdate()
  assert.equal(updateStore.getAppUpdateState().phase, 'downloading')
  await new Promise(resolve => setImmediate(resolve))

  // Now the stale first download rejects with a network error or CANCELLED; it MUST NOT clobber the active second download!
  rejectFirst(Object.assign(new Error('Download cancelled'), { code: 'CANCELLED' }))
  await first
  assert.equal(updateStore.getAppUpdateState().phase, 'downloading', 'stale cancel rejection must not overwrite active redownload')

  resolveSecond({ path: '/cache/updates/ds-bot-0.4.0-arm64.apk', size: 40_000_000, sha256: 'a'.repeat(64) })
  await second
  assert.equal(updateStore.getAppUpdateState().phase, 'ready')
  assert.equal(attempts, 2)
})

test('saving a new mirror invalidates an in-flight update check and prevents stale overwrite', async () => {
  resetMocks()
  let resolveStaleCheck!: (val: any) => void
  mocks.checkImpl = () => new Promise(res => { resolveStaleCheck = res })

  const firstCheck = updateStore.checkForAppUpdate({ manual: true })
  assert.equal(updateStore.getAppUpdateState().phase, 'checking')
  await new Promise(resolve => setImmediate(resolve))

  const saved = await updateStore.saveUpdateMirror('https://mirror.example.com/ds-bot/')
  assert.deepEqual(saved, { ok: true, value: 'https://mirror.example.com/ds-bot' })
  assert.equal(updateStore.getAppUpdateState().phase, 'idle')

  // Stale check finishes later: must be completely ignored.
  resolveStaleCheck({ status: 'available', release: SAMPLE_RELEASE, etag: '"old"' })
  await firstCheck
  assert.equal(updateStore.getAppUpdateState().phase, 'idle')
  assert.equal(updateStore.getAppUpdateState().release, null)
})

test('cold-start check hydrates persisted verified APK snapshot without re-fetching inside throttle window, and cleans cache after upgrade', async () => {
  resetMocks()
  let networkCalls = 0
  mocks.checkImpl = async () => { networkCalls += 1; return { status: 'up-to-date' } }
  mocks.cachedApk = { path: '/cache/updates/ds-bot-0.4.0-arm64.apk', size: 40_000_000, sha256: 'a'.repeat(64) }
  mocks.prefs = {
    updateMirror: '',
    updateSnapshot: JSON.stringify({
      appVersion: '0.3.10',
      mirror: '',
      checkedAt: Date.now() - 10_000,
      status: 'available',
      release: SAMPLE_RELEASE,
      etag: '"e1"',
    }),
  }

  await updateStore.checkForAppUpdate({ manual: false })
  assert.equal(networkCalls, 0)
  assert.equal(updateStore.getAppUpdateState().phase, 'ready')
  assert.equal(updateStore.getAppUpdateState().cached?.path, '/cache/updates/ds-bot-0.4.0-arm64.apk')

  // Simulate upgrading installed version to 0.4.0: stale snapshot ignored, leftover cache cleaned immediately.
  resetMocks()
  mocks.prefs = { autoUpdate: 'off', updateCacheVersion: '0.3.10' }
  updateStore.resetAppUpdateStoreForTest({ currentVersion: '0.4.0' })
  await updateStore.checkForAppUpdate({ manual: false })
  assert.deepEqual(mocks.cleanupCalls, [null])
  assert.equal(mocks.prefs.updateCacheVersion, '0.4.0')
})
