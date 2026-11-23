import { useEffect, useState } from 'react'
import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import { readPrefs, writePrefs } from '../store.ts'
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

const currentAppVersion = (): string =>
  String(Constants.expoConfig?.version ?? (Constants as { manifest?: { version?: string } }).manifest?.version ?? '0.0.0')

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
const listeners = new Set<() => void>()

function emit(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
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

export async function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<void> {
  if (!state.supported) return
  if (state.phase === 'checking' || state.phase === 'downloading') return
  const prefs = await readPrefs()
  const now = Date.now()
  if (options.manual !== true) {
    if (prefs.autoUpdate === 'off') return
    const lastCheck = Number(prefs.updateCheckAt ?? 0)
    if (Number.isFinite(lastCheck) && lastCheck > 0 && now - lastCheck < AUTO_CHECK_INTERVAL_MS) return
  }

  emit({ phase: 'checking', error: null })
  try {
    const customMirror = prefs.updateMirror ?? ''
    const allowLoopbackHttp = typeof __DEV__ !== 'undefined' && __DEV__ === true
    const result = await checkAndroidUpdate({
      currentVersion: state.currentVersion,
      customMirror,
      etag: options.manual === true ? undefined : lastEtag,
      allowLoopbackHttp,
    })
    const checkedAt = Date.now()
    void writePrefs({ updateCheckAt: String(checkedAt) }).catch(() => {})

    if (result.status === 'unchanged') {
      emit({ phase: state.release !== null ? (state.cached !== null ? 'ready' : 'available') : 'up-to-date', checkedAt })
      return
    }
    if (result.etag) lastEtag = result.etag

    if (result.status === 'up-to-date') {
      void cleanupUpdateCache(null)
      emit({ phase: 'up-to-date', release: null, cached: null, checkedAt, error: null })
      return
    }

    const canInstall = await canInstallPackages().catch(() => false)
    const cached = await getCachedApk(result.release.apkName, result.release.sha256).catch(() => null)
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
    const message = failure instanceof Error ? failure.message : String(failure)
    emit({ phase: 'error', error: message, checkedAt: Date.now() })
  }
}

export async function downloadAppUpdate(): Promise<void> {
  if (!state.supported || state.release === null) return
  if (state.phase === 'downloading') return
  const release = state.release
  const cached = await getCachedApk(release.apkName, release.sha256).catch(() => null)
  if (cached !== null) {
    const canInstall = await canInstallPackages().catch(() => false)
    emit({ phase: 'ready', cached, canInstall, progress: 1, bytesWritten: cached.size, totalBytes: cached.size, error: null })
    return
  }

  emit({ phase: 'downloading', bytesWritten: 0, totalBytes: release.size, progress: 0, error: null })
  const unsub = onUpdateDownloadProgress((p) => {
    if (state.phase !== 'downloading') return
    emit({ bytesWritten: p.bytesWritten, totalBytes: p.totalBytes || release.size, progress: p.progress })
  })

  try {
    let lastError: unknown = null
    for (const url of release.downloadUrls) {
      try {
        const downloaded = await downloadApk(url, release.apkName, release.sha256, release.size)
        const canInstall = await canInstallPackages().catch(() => false)
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
        const code = (err as { code?: string } | null)?.code
        if (code === 'CANCELLED') {
          emit({ phase: 'available', bytesWritten: 0, progress: -1, error: null })
          return
        }
        lastError = err
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'Download failed')
    emit({ phase: 'error', error: message })
  } finally {
    unsub()
  }
}

export async function cancelAppUpdateDownload(): Promise<void> {
  if (!state.supported) return
  await cancelApkDownload()
  if (state.phase === 'downloading') {
    emit({ phase: state.release !== null ? 'available' : 'idle', bytesWritten: 0, progress: -1, error: null })
  }
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
  await writePrefs({ updateMirror: normalized })
  lastEtag = undefined
  return { ok: true, value: normalized }
}

/** Called once on Android boot to clean stale APKs and perform throttled background check. */
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
