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

export const isAndroidUpdaterAvailable = () => false
export const canInstallPackages = async () => false
export const openInstallPermissionSettings = async () => false
export const getCachedApk = async (_fileName: string, _expectedSha256: string): Promise<CachedApk | null> => null
export const downloadApk = async (): Promise<CachedApk> => { throw new Error('Android updater is unavailable on web') }
export const cancelApkDownload = async () => {}
export const installApk = async (): Promise<boolean> => { throw new Error('Android updater is unavailable on web') }
export const cleanupUpdateCache = async () => {}
export const onUpdateDownloadProgress = (_listener: (progress: DownloadProgress) => void) => () => {}
