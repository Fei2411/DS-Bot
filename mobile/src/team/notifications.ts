// Pure mobile notification rules, preferences, formatting, and deep-link parsing.
// Kept React-Native-free so unit tests run directly under Node 24.

import { t } from '../ui/i18n.ts'
import type { ChatTarget } from '../screens/TeamList.tsx'

export type BackgroundDeliveryMode = 'off' | 'periodic' | 'instant'

export interface NoticeEntry {
  seq?: number
  kind?: string
  botId?: string
  name?: string
  roomId?: string | null
  title?: string
  sessionId?: string
  text?: string
  time?: number
}

export interface NotifyPrefs {
  enabled: boolean
  needsYou: boolean
  replies: boolean
  groups: boolean
  preview: boolean
  banners: boolean
  bgMode: BackgroundDeliveryMode
}

export interface ClassifiedNotice {
  channel: 'needs_you' | 'replies'
  category: 'needs_you' | 'replies' | 'groups'
  target: ChatTarget
  chatKey: string
  tag: string
}

export interface OpenChatLink {
  kind: 'bot' | 'room' | 'needs'
  id?: string
  hostId?: string
}

// What the host's inbox announces (ds-bot/src/host/mobile.js): each new item there, by
// its kind; `alert` is an item from a source the phone does not know by name.
export const NEEDS_YOU_NOTICE_KINDS = new Set([
  'approval',
  'question',
  'view',
  'secret',
  'connector',
  'handoff',
  'learning',
  'mail',
  'computer',
  'goal',
  'blocked',
  'paused',
  'alert',
])

export const REPLY_NOTICE_KINDS = new Set(['message', 'done'])
export const GROUP_NOTICE_KINDS = new Set(['group'])

export const ALL_NOTICE_KINDS = new Set([
  ...NEEDS_YOU_NOTICE_KINDS,
  ...REPLY_NOTICE_KINDS,
  ...GROUP_NOTICE_KINDS,
])

export function androidNotificationStatus(sdk: number, granted: boolean | undefined, systemEnabled?: boolean): 'Allowed' | 'Allow' | 'Off' | undefined {
  if (systemEnabled === false) {
    if (sdk >= 33 && granted === undefined) return undefined
    return sdk >= 33 && !granted ? 'Allow' : 'Off'
  }
  if (sdk < 33) return systemEnabled === true ? 'Allowed' : undefined
  if (granted === undefined) return undefined
  return granted ? 'Allowed' : 'Allow'
}

export function readNotifyPrefsFromRecord(prefs: Record<string, string>): NotifyPrefs {
  const rawMode = prefs.notifyBgMode
  const bgMode: BackgroundDeliveryMode = rawMode === 'instant' || rawMode === 'periodic' || rawMode === 'off'
    ? rawMode
    : 'periodic'
  return {
    enabled: prefs.notifyEnabled !== 'off',
    needsYou: prefs.notifyNeedsYou !== 'off',
    replies: prefs.notifyReplies !== 'off',
    groups: prefs.notifyGroups !== 'off',
    preview: prefs.notifyPreview !== 'off',
    banners: prefs.banners !== 'off',
    bgMode,
  }
}

export function chatNotificationKey(target: ChatTarget): string {
  return `${target.kind}:${target.id}`
}

export function notificationTagFor(hostId: string, target: ChatTarget): string {
  return `${hostId || 'default'}:${target.kind}:${target.id}`
}

export function classifyNotice(notice: NoticeEntry, hostId = ''): ClassifiedNotice | null {
  const kind = String(notice?.kind ?? '')
  if (!ALL_NOTICE_KINDS.has(kind)) return null
  const isRoom = typeof notice.roomId === 'string' && notice.roomId !== ''
  const target: ChatTarget = isRoom
    ? { kind: 'room', id: notice.roomId! }
    : { kind: 'bot', id: String(notice.botId ?? '') }
  if (!target.id) return null

  const needsYou = NEEDS_YOU_NOTICE_KINDS.has(kind)
  const channel = needsYou ? 'needs_you' : 'replies'
  const category = needsYou ? 'needs_you' : GROUP_NOTICE_KINDS.has(kind) ? 'groups' : 'replies'
  return {
    channel,
    category,
    target,
    chatKey: chatNotificationKey(target),
    tag: notificationTagFor(hostId, target),
  }
}

export function shouldPostSystemNotification(
  notice: NoticeEntry,
  prefs: NotifyPrefs,
  ctx: { appActive: boolean; activeChat: ChatTarget | null; hostId?: string },
): ClassifiedNotice | null {
  if (!prefs.enabled) return null
  const info = classifyNotice(notice, ctx.hostId ?? '')
  if (info === null) return null
  if (info.category === 'needs_you' && !prefs.needsYou) return null
  if (info.category === 'replies' && !prefs.replies) return null
  if (info.category === 'groups' && !prefs.groups) return null
  // While the app is active in foreground, in-app banners handle other chats and
  // the open chat already displays its own live stream and cards.
  if (ctx.appActive) return null
  return info
}

export function formatNoticeNotification(
  notice: NoticeEntry,
  options: { preview: boolean; hostName?: string },
): { title: string; body: string } {
  const kind = String(notice.kind ?? '')
  const botName = (notice.name ?? '').trim()
  const roomTitle = (notice.title ?? '').trim()
  const baseTitle = roomTitle && botName && roomTitle !== botName
    ? `${roomTitle} · ${botName}`
    : roomTitle || botName || 'DS Bot'
  const host = (options.hostName ?? '').trim()
  const title = host && host !== baseTitle && !baseTitle.includes(host)
    ? `${baseTitle} (${host})`
    : baseTitle
  const snippet = typeof notice.text === 'string' ? notice.text.trim() : ''
  const show = options.preview && snippet.length > 0

  switch (kind) {
    case 'approval':
      return { title, body: show ? t('Needs approval: {text}', { text: snippet }) : t('Needs your approval') }
    case 'question':
      return { title, body: show ? t('Question: {text}', { text: snippet }) : t('Waiting for your answer') }
    case 'view':
      return { title, body: show ? t('Card: {text}', { text: snippet }) : t('Waiting for your response') }
    case 'secret':
      return { title, body: show ? t('Asks for the secret {name}', { name: snippet }) : t('Waiting for a secret') }
    case 'connector':
      return { title, body: show ? t('Needs connector: {name}', { name: snippet }) : t('Needs connector sign-in') }
    case 'handoff':
      return { title, body: show ? t('Browser handoff: {text}', { text: snippet }) : t('Your turn in the browser') }
    case 'learning':
      return { title, body: show ? t('Learning proposal: {text}', { text: snippet }) : t('New learning proposal') }
    case 'mail':
      return { title, body: show ? t('Wants to send “{subject}”', { subject: snippet }) : t('Wants to send an email') }
    case 'computer':
      return { title, body: show ? t('Wants to use {app}', { app: snippet }) : t('Needs your approval') }
    case 'goal':
      return { title, body: show ? t('Waiting for you · {title}', { title: snippet }) : t('Waiting for you') }
    case 'blocked':
      return { title, body: t('Needs a fix') }
    case 'paused':
      return { title, body: show ? snippet : t('Paused') }
    case 'alert':
      return { title, body: show ? snippet : t('Waiting for you') }
    case 'done':
      return { title, body: t('Finished') }
    case 'group':
      return { title, body: show ? snippet : t('New group message') }
    default:
      return { title, body: show ? snippet : t('New reply') }
  }
}

export function parseOpenChatUrl(url: string | null | undefined): OpenChatLink | null {
  if (typeof url !== 'string' || !url.startsWith('dsbot://open')) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'dsbot:' || parsed.host !== 'open') return null
    const kind = parsed.searchParams.get('kind')
    const id = parsed.searchParams.get('id') ?? undefined
    const hostId = parsed.searchParams.get('host') ?? undefined
    if (kind === 'needs') return { kind: 'needs', ...(hostId ? { hostId } : {}) }
    if ((kind === 'bot' || kind === 'room') && id) {
      return { kind, id, ...(hostId ? { hostId } : {}) }
    }
    return null
  } catch {
    return null
  }
}
