import { useEffect, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { readPrefs, writePrefs } from '../store.ts'
import { currentAppVersion } from './app-version.ts'
import {
  AUTO_CHECK_INTERVAL_MS,
  checkAndroidUpdate,
  isNewerVersion,
  normalizeMirrorBase,
  type AndroidReleaseInfo,
} from './app-update.ts'
import {
  cancelApkDownload,
  canInstallPackages,
  cleanupUpdateCache,
  downloadApk,
  getCachedApk,
  installApk,
  isAndroidUpdaterAvailable,
  onUpdateDownloadProgress,
  openInstallPermissionSettings,
  type CachedApk,
} from './app-update-native'

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface AppUpdateState {
  supported: boolean
  currentVersion: string
  phase: AppUpdatePhase
  release: AndroidReleaseInfo | null
  cached: CachedApk | null
  bytesWritten: number
  totalBytes: number
  progress: number
  canInstall: boolean
  waitingForPermission: boolean
  error: string | null
  checkedAt: number | null
}

interface PersistedUpdateSnapshot {
  appVersion: string
  mirror: string
  checkedAt: number
  status: 'up-to-date' | 'available'
  release: AndroidReleaseInfo | null
  etag?: string
}

let state: AppUpdateState = {
  supported: Platform.OS === 'android' && isAndroidUpdaterAvailable(),
  currentVersion: currentAppVersion(),
  phase: 'idle',
  release: null,
  cached: null,
  bytesWritten: 0,
  totalBytes: 0,
  progress: -1,
  canInstall: true,
  waitingForPermission: false,
  error: null,
  checkedAt: null,
}

let lastEtag: string | undefined
let bootChecked = false
let checkGen = 0
let activeCheckGen = 0
let downloadGen = 0
const listeners = new Set<() => void>()

function emit(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
}

/** Resets module-level store state (for deterministic unit tests). */
export function resetAppUpdateStoreForTest(overrides: Partial<AppUpdateState> = {}): void {
  lastEtag = undefined
  bootChecked = false
  checkGen = 0
  activeCheckGen = 0
  downloadGen = 0
  state = {
    supported: Platform.OS === 'android' && isAndroidUpdaterAvailable(),
    currentVersion: currentAppVersion(),
    phase: 'idle',
    release: null,
    cached: null,
    bytesWritten: 0,
    totalBytes: 0,
    progress: -1,
    canInstall: true,
    waitingForPermission: false,
    error: null,
    checkedAt: null,
    ...overrides,
  }
}

function parseSnapshot(raw: string | undefined, appVersion: string, mirror: string): PersistedUpdateSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedUpdateSnapshot>
    if (parsed.appVersion !== appVersion || (parsed.mirror ?? '') !== mirror) return null
    if (typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) return null
    if (parsed.status === 'up-to-date') {
      return { appVersion, mirror, checkedAt: parsed.checkedAt, status: 'up-to-date', release: null, etag: parsed.etag }
    }
    if (parsed.status === 'available' && parsed.release && typeof parsed.release.version === 'string' && typeof parsed.release.sha256 === 'string') {
      if (!isNewerVersion(parsed.release.version, appVersion)) return null
      return { appVersion, mirror, checkedAt: parsed.checkedAt, status: 'available', release: parsed.release, etag: parsed.etag }
    }
  } catch { /* ignore corrupted snapshot */ }
  return null
}

function persistSnapshot(snapshot: PersistedUpdateSnapshot | null): void {
  void writePrefs({
    updateCheckAt: snapshot ? String(snapshot.checkedAt) : '',
    updateSnapshot: snapshot ? JSON.stringify(snapshot) : '',
  }).catch(() => {})
}

export function getAppUpdateState(): AppUpdateState {
  return state
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export async function refreshInstallPermission(): Promise<boolean> {
  if (!state.supported) return false
  const allowed = await canInstallPackages().catch(() => false)
  const resumeInstall = allowed && state.waitingForPermission && state.cached !== null && state.release !== null
  emit({ canInstall: allowed, ...(allowed ? { waitingForPermission: false } : {}) })
  if (resumeInstall) {
    await installDownloadedUpdate()
  }
  return allowed
}

async function hydrateFromSnapshot(snapshot: PersistedUpdateSnapshot, gen: number): Promise<void> {
  if (snapshot.etag) lastEtag = snapshot.etag
  if (snapshot.status === 'up-to-date' || snapshot.release === null) {
    void cleanupUpdateCache(null)
    if (gen !== checkGen) return
    emit({ phase: 'up-to-date', release: null, cached: null, checkedAt: snapshot.checkedAt, error: null })
    return
  }
  const canInstall = await canInstallPackages().catch(() => false)
  const cached = await getCachedApk(snapshot.release.apkName, snapshot.release.sha256).catch(() => null)
  if (gen !== checkGen) return
  emit({
    phase: cached !== null ? 'ready' : 'available',
    release: snapshot.release,
    cached,
    canInstall,
    checkedAt: snapshot.checkedAt,
    error: null,
    bytesWritten: cached?.size ?? 0,
    totalBytes: snapshot.release.size || cached?.size || 0,
    progress: cached !== null ? 1 : -1,
  })
}

export async function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<void> {
  if (!state.supported) return
  if (activeCheckGen !== 0 || state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing') return
  const gen = ++checkGen
  activeCheckGen = gen
  if (options.manual === true) {
    // Flip phase synchronously before any await so rapid double-taps cannot start concurrent checks.
    emit({ phase: 'checking', error: null })
  }
  try {
    const prefs = await readPrefs()
    if (gen !== checkGen) return
    const customMirror = prefs.updateMirror ?? ''
    const snapshot = parseSnapshot(prefs.updateSnapshot, state.currentVersion, customMirror)
    const now = Date.now()

    if (options.manual !== true) {
      // Always restore any persisted update result (including already-downloaded APK) on cold start.
      if (snapshot !== null && state.phase === 'idle') {
        await hydrateFromSnapshot(snapshot, gen)
        if (gen !== checkGen) return
      } else if (prefs.updateCacheVersion && prefs.updateCacheVersion !== state.currentVersion) {
        // Clear leftover APK immediately after upgrading to a newer installed version.
        void cleanupUpdateCache(null)
        void writePrefs({ updateCacheVersion: state.currentVersion }).catch(() => {})
      }
      if (prefs.autoUpdate === 'off') return
      if (snapshot !== null && now - snapshot.checkedAt < AUTO_CHECK_INTERVAL_MS) return
      emit({ phase: 'checking', error: null })
    }

    const allowLoopbackHttp = typeof __DEV__ !== 'undefined' && __DEV__ === true
    const result = await checkAndroidUpdate({
      currentVersion: state.currentVersion,
      customMirror,
      etag: options.manual === true ? undefined : lastEtag,
      allowLoopbackHttp,
    })
    if (gen !== checkGen) return
    const checkedAt = Date.now()

    if (result.status === 'unchanged') {
      const nextStatus = state.release !== null ? 'available' : 'up-to-date'
      persistSnapshot({ appVersion: state.currentVersion, mirror: customMirror, checkedAt, status: nextStatus, release: state.release, etag: lastEtag })
      emit({ phase: state.release !== null ? (state.cached !== null ? 'ready' : 'available') : 'up-to-date', checkedAt })
      return
    }
    // Only preserve ETag when the response actually supplied one (custom mirror responses carry no GitHub ETag).
    lastEtag = result.etag

    if (result.status === 'up-to-date') {
      void cleanupUpdateCache(null)
      void writePrefs({ updateCacheVersion: state.currentVersion }).catch(() => {})
      persistSnapshot({ appVersion: state.currentVersion, mirror: customMirror, checkedAt, status: 'up-to-date', release: null, etag: lastEtag })
      emit({ phase: 'up-to-date', release: null, cached: null, checkedAt, error: null })
      return
    }

    const canInstall = await canInstallPackages().catch(() => false)
    const cached = await getCachedApk(result.release.apkName, result.release.sha256).catch(() => null)
    if (gen !== checkGen) return
    void writePrefs({ updateCacheVersion: state.currentVersion }).catch(() => {})
    persistSnapshot({ appVersion: state.currentVersion, mirror: customMirror, checkedAt, status: 'available', release: result.release, etag: lastEtag })
    emit({
      phase: cached !== null ? 'ready' : 'available',
      release: result.release,
      cached,
      canInstall,
      checkedAt,
      error: null,
      bytesWritten: cached?.size ?? 0,
      totalBytes: result.release.size || cached?.size || 0,
      progress: cached !== null ? 1 : -1,
    })
  } catch (failure) {
    if (gen !== checkGen) return
    const message = failure instanceof Error ? failure.message : String(failure)
    emit({ phase: 'error', error: message, checkedAt: Date.now() })
  } finally {
    if (activeCheckGen === gen) activeCheckGen = 0
  }
}

export async function downloadAppUpdate(): Promise<void> {
  if (!state.supported || state.release === null) return
  if (state.phase === 'downloading' || state.phase === 'installing') return
  const release = state.release
  const gen = ++downloadGen
  // Transition synchronously before any await so rapid double-taps cannot launch duplicate downloads.
  emit({ phase: 'downloading', bytesWritten: 0, totalBytes: release.size, progress: 0, error: null })

  const cached = await getCachedApk(release.apkName, release.sha256).catch(() => null)
  if (gen !== downloadGen) return
  if (cached !== null) {
    const canInstall = await canInstallPackages().catch(() => false)
    if (gen !== downloadGen) return
    emit({ phase: 'ready', cached, canInstall, progress: 1, bytesWritten: cached.size, totalBytes: cached.size, error: null })
    return
  }

  const unsub = onUpdateDownloadProgress((p) => {
    if (gen !== downloadGen || state.phase !== 'downloading') return
    emit({ bytesWritten: p.bytesWritten, totalBytes: p.totalBytes || release.size, progress: p.progress })
  })

  try {
    let lastError: unknown = null
    for (const url of release.downloadUrls) {
      if (gen !== downloadGen) return
      try {
        const downloaded = await downloadApk(url, release.apkName, release.sha256, release.size)
        if (gen !== downloadGen) return
        const canInstall = await canInstallPackages().catch(() => false)
        if (gen !== downloadGen) return
        emit({
          phase: 'ready',
          cached: downloaded,
          canInstall,
          bytesWritten: downloaded.size,
          totalBytes: downloaded.size,
          progress: 1,
          error: null,
        })
        return
      } catch (err) {
        if (gen !== downloadGen) return
        const code = (err as { code?: string } | null)?.code
        if (code === 'CANCELLED') {
          emit({ phase: 'available', bytesWritten: 0, progress: -1, error: null })
          return
        }
        lastError = err
      }
    }
    if (gen !== downloadGen) return
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'Download failed')
    emit({ phase: 'error', error: message })
  } finally {
    unsub()
  }
}

export async function cancelAppUpdateDownload(): Promise<void> {
  if (!state.supported) return
  downloadGen += 1
  if (state.phase === 'downloading') {
    emit({ phase: state.release !== null ? 'available' : 'idle', bytesWritten: 0, progress: -1, error: null })
  }
  await cancelApkDownload()
}

export async function installDownloadedUpdate(): Promise<void> {
  if (!state.supported || state.release === null || state.cached === null) return
  const allowed = await canInstallPackages().catch(() => false)
  if (!allowed) {
    emit({ canInstall: false, waitingForPermission: true, error: null })
    await openInstallPermissionSettings().catch(() => {})
    return
  }
  emit({ phase: 'installing', canInstall: true, waitingForPermission: false, error: null })
  try {
    await installApk(state.cached.path, state.release.sha256)
    emit({ phase: 'ready' })
  } catch (failure) {
    const code = (failure as { code?: string } | null)?.code
    if (code === 'INSTALL_PERMISSION_REQUIRED') {
      emit({ phase: 'ready', canInstall: false, waitingForPermission: true })
      await openInstallPermissionSettings().catch(() => {})
      return
    }
    if (code === 'CHECKSUM_MISMATCH' || code === 'INVALID_APK_PATH') {
      emit({ phase: 'available', cached: null, error: failure instanceof Error ? failure.message : String(failure) })
      return
    }
    emit({ phase: 'error', error: failure instanceof Error ? failure.message : String(failure) })
  }
}

export async function saveUpdateMirror(raw: string): Promise<{ ok: boolean; value?: string }> {
  const allowLoopbackHttp = typeof __DEV__ !== 'undefined' && __DEV__ === true
  const normalized = normalizeMirrorBase(raw, { allowLoopbackHttp })
  if (normalized === null) return { ok: false }
  // Invalidate any in-flight update check so stale mirror/GitHub results cannot overwrite this change.
  checkGen += 1
  activeCheckGen = 0
  await writePrefs({ updateMirror: normalized })
  lastEtag = undefined
  persistSnapshot(null)
  if (state.phase !== 'downloading' && state.phase !== 'installing') {
    emit({ phase: 'idle', release: null, cached: null, error: null, checkedAt: null, bytesWritten: 0, totalBytes: 0, progress: -1 })
  }
  return { ok: true, value: normalized }
}

/** Called once on Android boot to restore persisted update state, clean stale APKs, and run throttled check. */
export function startAppUpdateMonitor(): () => void {
  if (!state.supported) return () => {}
  if (!bootChecked) {
    bootChecked = true
    void checkForAppUpdate({ manual: false })
  }
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      void refreshInstallPermission()
    }
  })
  return () => sub.remove()
}

export function useAppUpdate(): AppUpdateState & {
  hasUpdate: boolean
  check: () => Promise<void>
  download: () => Promise<void>
  cancel: () => Promise<void>
  install: () => Promise<void>
} {
  const [snap, setSnap] = useState<AppUpdateState>(state)
  useEffect(() => subscribeAppUpdate(() => setSnap(state)), [])
  const hasUpdate = snap.release !== null && isNewerVersion(snap.release.version, snap.currentVersion)
  return {
    ...snap,
    hasUpdate,
    check: () => checkForAppUpdate({ manual: true }),
    download: downloadAppUpdate,
    cancel: cancelAppUpdateDownload,
    install: installDownloadedUpdate,
  }
}
