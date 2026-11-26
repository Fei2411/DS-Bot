import { AppState, Platform } from 'react-native'
import { listComputers, readPrefs } from '../store.ts'
import type { ChatTarget } from '../screens/TeamList.tsx'
import { t } from '../ui/i18n.ts'
import {
  formatNoticeNotification,
  notificationTagFor,
  readNotifyPrefsFromRecord,
  shouldPostSystemNotification,
  type NoticeEntry,
} from './notifications.ts'
import {
  cancelNotificationTag,
  ensureNotificationChannels,
  getBackgroundStatus,
  isAndroidNotificationsAvailable,
  postNativeNotification,
  setBackgroundDeliveryConfig,
  updateBackgroundStatusText,
} from './notifications-native'
import { recordNoticeSeen } from './notice-cursor-store.ts'

const onlineHosts = new Set<string>()
const hostPushStates = new Map<string, 'unknown' | 'synced' | 'failed'>()
const pushSyncListeners = new Set<() => void>()
const hostDeliveryQueues = new Map<string, Promise<unknown>>()

function enqueueHostDelivery<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  const key = hostId || 'default'
  const prev = hostDeliveryQueues.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.then(() => {}, () => {})
  hostDeliveryQueues.set(key, tail)
  void tail.finally(() => {
    if (hostDeliveryQueues.get(key) === tail) hostDeliveryQueues.delete(key)
  })
  return next
}

function setHostPushSyncState(hostId: string, state: 'unknown' | 'synced' | 'failed'): void {
  if (!hostId) return
  if (hostPushStates.get(hostId) === state) return
  hostPushStates.set(hostId, state)
  pushSyncListeners.forEach(fn => fn())
}

export function resetHostPushSyncState(hostId?: string): void {
  if (!hostId) {
    if (hostPushStates.size === 0) return
    hostPushStates.clear()
    pushSyncListeners.forEach(fn => fn())
    return
  }
  setHostPushSyncState(hostId, 'unknown')
}

export function setForegroundLinkOnline(hostId: string, online: boolean): void {
  if (!hostId) return
  if (online) onlineHosts.add(hostId)
  else onlineHosts.delete(hostId)
}

export function isForegroundLinkOnline(): boolean {
  return onlineHosts.size > 0
}

export function getHostPushSyncState(hostId?: string): 'unknown' | 'synced' | 'failed' {
  if (!hostId) return 'unknown'
  return hostPushStates.get(hostId) ?? 'unknown'
}

export function subscribeHostPushSyncState(listener: () => void): () => void {
  pushSyncListeners.add(listener)
  return () => { pushSyncListeners.delete(listener) }
}

export async function deliverSystemNotice(
  notice: NoticeEntry,
  options: {
    hostId: string
    hostName?: string
    boot?: string
    activeChat?: ChatTarget | null
    appActive?: boolean
    dedupe?: boolean
  },
): Promise<boolean> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable()) return false
  return enqueueHostDelivery(options.hostId, async () => {
    const prefs = readNotifyPrefsFromRecord(await readPrefs())
    const appActive = options.appActive ?? (AppState.currentState === 'active')
    const classified = shouldPostSystemNotification(notice, prefs, {
      appActive,
      activeChat: options.activeChat ?? null,
      hostId: options.hostId,
    })
    if (classified === null) {
      // Still advance persisted cursor for filtered background notices so periodic sync
      // does not repeatedly re-fetch them.
      if (!appActive && options.dedupe !== false) {
        await recordNoticeSeen(options.hostId, options.boot, notice.seq)
      }
      return false
    }
    if (options.dedupe !== false) {
      const fresh = await recordNoticeSeen(options.hostId, options.boot, notice.seq)
      if (!fresh) return false
    }
    const multiHost = options.hostName
      ? await listComputers().then(res => res.computers.length > 1).catch(() => false)
      : false
    const copy = formatNoticeNotification(notice, {
      preview: prefs.preview,
      hostName: multiHost ? options.hostName : undefined,
    })
    return postNativeNotification({
      tag: classified.tag,
      title: copy.title,
      body: copy.body,
      channel: classified.channel,
      targetKind: classified.target.kind === 'room' ? 'room' : 'bot',
      targetId: classified.target.id,
      hostId: options.hostId,
    })
  })
}

export async function clearChatNotifications(hostId: string, target: ChatTarget | null | undefined): Promise<void> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable() || !target?.id) return
  await cancelNotificationTag(notificationTagFor(hostId, target))
}

export async function applyBackgroundDeliveryPrefs(computerName?: string): Promise<void> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable()) return
  await ensureNotificationChannels()
  const prefs = readNotifyPrefsFromRecord(await readPrefs())
  const mode = prefs.enabled ? prefs.bgMode : 'off'
  const subtitle = computerName
    ? t('Connected to {name}', { name: computerName })
    : t('Background notifications active')
  await setBackgroundDeliveryConfig({
    mode,
    title: 'DS Bot',
    subtitle,
  }).catch(() => {})
}

export async function syncBackgroundConnectionSubtitle(online: boolean, computerName?: string): Promise<void> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable()) return
  const prefs = readNotifyPrefsFromRecord(await readPrefs())
  if (!prefs.enabled || prefs.bgMode !== 'instant') return
  const text = online
    ? (computerName ? t('Connected to {name}', { name: computerName }) : t('Connected'))
    : t('Reconnecting…')
  await updateBackgroundStatusText(text)
}

export async function registerHostPushEndpoint(
  hostId: string,
  call: (endpoint: string, payload?: unknown) => Promise<unknown>,
  endpoint: string,
): Promise<void> {
  try {
    await call('push-register', { kind: 'unifiedpush', endpoint })
    setHostPushSyncState(hostId, 'synced')
  } catch {
    setHostPushSyncState(hostId, 'failed')
  }
}

export async function unregisterHostPushEndpoint(
  hostId: string,
  call: (endpoint: string, payload?: unknown) => Promise<unknown>,
): Promise<void> {
  await call('push-unregister', {}).catch(() => {})
  setHostPushSyncState(hostId, 'unknown')
}

export async function syncPushEndpointWithHost(
  hostId: string,
  call: (endpoint: string, payload?: unknown) => Promise<unknown>,
  capabilities: string[] | undefined,
): Promise<void> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable()) return
  if (!Array.isArray(capabilities) || !capabilities.includes('push-register')) return
  const status = await getBackgroundStatus()
  if (status === null) return
  if (status.unifiedPushEndpoint) {
    await registerHostPushEndpoint(hostId, call, status.unifiedPushEndpoint)
  } else if (status.unifiedPushDisabled) {
    // Clean up any stale registration on a computer that was offline when UnifiedPush was turned off.
    await unregisterHostPushEndpoint(hostId, call)
  }
}

export async function sendTestNotification(hostId: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !isAndroidNotificationsAvailable()) return false
  await ensureNotificationChannels()
  return postNativeNotification({
    tag: `${hostId || 'default'}:test`,
    title: 'DS Bot',
    body: t('Notifications are working on this phone.'),
    channel: 'needs_you',
    targetKind: 'needs',
    targetId: '',
    hostId,
  })
}
