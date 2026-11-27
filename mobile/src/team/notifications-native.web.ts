export type BackgroundMode = 'off' | 'periodic' | 'instant'

export interface UnifiedPushDistributor {
  packageName: string
  label: string
}

export interface BackgroundStatus {
  notificationsEnabled: boolean
  ignoringBattery: boolean
  serviceRunning: boolean
  jobScheduled: boolean
  mode: BackgroundMode
  unifiedPushDistributors: UnifiedPushDistributor[]
  unifiedPushDistributor: string | null
  unifiedPushEndpoint: string | null
  unifiedPushError: string | null
  unifiedPushDisabled?: boolean
}

export interface NativeNoticePayload {
  tag: string
  title: string
  body: string
  channel: 'needs_you' | 'replies'
  targetKind: 'bot' | 'room' | 'needs'
  targetId: string
  hostId: string
  silent?: boolean
}

export interface UnifiedPushEvent {
  type: 'endpoint' | 'unregistered' | 'failed'
  endpoint?: string
  error?: string
}

export const isAndroidNotificationsAvailable = () => false
export const ensureNotificationChannels = async () => {}
export const areSystemNotificationsEnabled = async () => false
export const setNativeUiState = async (_mounted: boolean, _foreground: boolean) => {}
export const postNativeNotification = async (_payload: NativeNoticePayload) => false
export const cancelNotificationTag = async (_tag: string) => {}
export const openNotificationChannelSettings = async () => {}
export const requestIgnoreBatteryOptimizations = async () => {}
export const setBackgroundDeliveryConfig = async () => ({ serviceStarted: false, jobScheduled: false })
export const updateBackgroundStatusText = async () => {}
export const registerUnifiedPush = async () => {}
export const unregisterUnifiedPush = async () => {}
export const getBackgroundStatus = async (): Promise<BackgroundStatus | null> => null
export const onUnifiedPushEvent = (_listener: (event: UnifiedPushEvent) => void) => () => {}
export const onStopKeepalive = (_listener: () => void) => () => {}
