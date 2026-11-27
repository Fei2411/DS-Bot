import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

export interface CachedApk {
  path: string
  size: number
  sha256: string
}

export interface DownloadProgress {
  bytesWritten: number
  totalBytes: number
  progress: number
}

interface NativeUpdater {
  canInstallPackages(): Promise<boolean>
  openInstallPermissionSettings(): Promise<boolean>
  getCachedApk(fileName: string, expectedSha256: string): Promise<CachedApk | null>
  downloadApk(url: string, fileName: string, expectedSha256: string, expectedSize: number): Promise<CachedApk>
  cancelDownload(): Promise<boolean>
  installApk(filePath: string, expectedSha256: string): Promise<boolean>
  cleanupCache(keepFileName: string | null): Promise<boolean>
  addListener?(eventName: string): void
  removeListeners?(count: number): void
}

function mod(): NativeUpdater | null {
  if (Platform.OS !== 'android') return null
  return (NativeModules.DsBotUpdater as NativeUpdater | undefined) ?? null
}

export function isAndroidUpdaterAvailable(): boolean {
  return mod() !== null
}

export async function canInstallPackages(): Promise<boolean> {
  const m = mod()
  if (m === null) return false
  return m.canInstallPackages()
}

export async function openInstallPermissionSettings(): Promise<boolean> {
  const m = mod()
  if (m === null) return false
  return m.openInstallPermissionSettings()
}

export async function getCachedApk(fileName: string, expectedSha256: string): Promise<CachedApk | null> {
  const m = mod()
  if (m === null) return null
  return m.getCachedApk(fileName, expectedSha256)
}

export async function downloadApk(url: string, fileName: string, expectedSha256: string, expectedSize: number): Promise<CachedApk> {
  const m = mod()
  if (m === null) throw new Error('Android updater is unavailable')
  return m.downloadApk(url, fileName, expectedSha256, expectedSize)
}

export async function cancelApkDownload(): Promise<void> {
  const m = mod()
  if (m === null) return
  await m.cancelDownload()
}

export async function installApk(filePath: string, expectedSha256: string): Promise<boolean> {
  const m = mod()
  if (m === null) throw new Error('Android updater is unavailable')
  return m.installApk(filePath, expectedSha256)
}

export async function cleanupUpdateCache(keepFileName: string | null = null): Promise<void> {
  const m = mod()
  if (m === null) return
  await m.cleanupCache(keepFileName).catch(() => {})
}

export function onUpdateDownloadProgress(listener: (progress: DownloadProgress) => void): () => void {
  const m = mod()
  if (m === null) return () => {}
  const emitter = new NativeEventEmitter(m as never)
  const sub = emitter.addListener('dsbotUpdateProgress', (event: Partial<DownloadProgress>) => {
    listener({
      bytesWritten: typeof event.bytesWritten === 'number' ? event.bytesWritten : 0,
      totalBytes: typeof event.totalBytes === 'number' ? event.totalBytes : 0,
      progress: typeof event.progress === 'number' ? event.progress : -1,
    })
  })
  return () => sub.remove()
}
