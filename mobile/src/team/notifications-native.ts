import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

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

interface NativeNotifications {
  ensureChannels(): Promise<boolean>
  areNotificationsEnabled(): Promise<boolean>
  setUiState(mounted: boolean, foreground: boolean): Promise<boolean>
  notify(payload: NativeNoticePayload): Promise<boolean>
  cancelTag(tag: string): Promise<boolean>
  openChannelSettings(channel: string | null): Promise<boolean>
  requestIgnoreBatteryOptimizations(): Promise<boolean>
  setBackgroundConfig(config: { mode: BackgroundMode; title: string; subtitle: string }): Promise<{ serviceStarted: boolean; jobScheduled: boolean }>
  updateBackgroundStatus(subtitle: string): Promise<boolean>
  registerUnifiedPush(distributorPackage: string): Promise<boolean>
  unregisterUnifiedPush(): Promise<boolean>
  getBackgroundStatus(): Promise<BackgroundStatus>
  addListener?(eventName: string): void
  removeListeners?(count: number): void
}

function mod(): NativeNotifications | null {
  if (Platform.OS !== 'android') return null
  return (NativeModules.DsBotNotifications as NativeNotifications | undefined) ?? null
}

export function isAndroidNotificationsAvailable(): boolean {
  return mod() !== null
}

export async function ensureNotificationChannels(): Promise<void> {
  const m = mod()
  if (m !== null) await m.ensureChannels().catch(() => {})
}

export async function areSystemNotificationsEnabled(): Promise<boolean> {
  const m = mod()
  if (m === null) return false
  return m.areNotificationsEnabled().catch(() => false)
}

export async function setNativeUiState(mounted: boolean, foreground: boolean): Promise<void> {
  const m = mod()
  if (m === null) return
  await m.setUiState(mounted, foreground).catch(() => {})
}

export async function postNativeNotification(payload: NativeNoticePayload): Promise<boolean> {
  const m = mod()
  if (m === null) return false
  return m.notify(payload).catch(() => false)
}

export async function cancelNotificationTag(tag: string): Promise<void> {
  const m = mod()
  if (m !== null) await m.cancelTag(tag).catch(() => {})
}

export async function openNotificationChannelSettings(channel: 'needs_you' | 'replies' | 'background' | null = null): Promise<void> {
  const m = mod()
  if (m !== null) await m.openChannelSettings(channel).catch(() => {})
}

export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  const m = mod()
  if (m !== null) await m.requestIgnoreBatteryOptimizations().catch(() => {})
}

export async function setBackgroundDeliveryConfig(config: { mode: BackgroundMode; title: string; subtitle: string }): Promise<{ serviceStarted: boolean; jobScheduled: boolean }> {
  const m = mod()
  if (m === null) return { serviceStarted: false, jobScheduled: false }
  return m.setBackgroundConfig(config)
}

export async function updateBackgroundStatusText(subtitle: string): Promise<void> {
  const m = mod()
  if (m !== null) await m.updateBackgroundStatus(subtitle).catch(() => {})
}

export async function registerUnifiedPush(distributorPackage: string): Promise<void> {
  const m = mod()
  if (m === null) throw new Error('UnifiedPush is unavailable')
  await m.registerUnifiedPush(distributorPackage)
}

export async function unregisterUnifiedPush(): Promise<void> {
  const m = mod()
  if (m === null) return
  await m.unregisterUnifiedPush()
}

export async function getBackgroundStatus(): Promise<BackgroundStatus | null> {
  const m = mod()
  if (m === null) return null
  return m.getBackgroundStatus().catch(() => null)
}

export function onUnifiedPushEvent(listener: (event: UnifiedPushEvent) => void): () => void {
  const m = mod()
  if (m === null) return () => {}
  const emitter = new NativeEventEmitter(m as never)
  const sub = emitter.addListener('dsbotUnifiedPushEvent', (raw: unknown) => {
    const event = raw as Partial<UnifiedPushEvent> | null
    if (event && typeof event.type === 'string') listener(event as UnifiedPushEvent)
  })
  return () => sub.remove()
}

export function onStopKeepalive(listener: () => void): () => void {
  const m = mod()
  if (m === null) return () => {}
  const emitter = new NativeEventEmitter(m as never)
  const sub = emitter.addListener('dsbotStopKeepalive', () => listener())
  return () => sub.remove()
}
