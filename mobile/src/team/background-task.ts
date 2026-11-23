import { Platform } from 'react-native'
import { openPushEnvelope, parsePushEnvelope } from '../../../link/src/index.ts'
import { callBot, openLink } from '../connection.ts'
import { listComputers, loadComputer, loadIdentity, readPrefs } from '../store.ts'
import { setLang, t } from '../ui/i18n.ts'
import { createNoticeCursor, type NoticeCursorAnswer } from './notices.ts'
import { loadNoticeCursor, saveNoticeCursor } from './notice-cursor-store.ts'
import { deliverSystemNotice, isForegroundLinkOnline } from './notification-bridge.ts'
import { readNotifyPrefsFromRecord, type NoticeEntry } from './notifications.ts'
import { onStopKeepalive, updateBackgroundStatusText } from './notifications-native'

const DEMO = process.env.EXPO_PUBLIC_DSB_DEMO === '1'

function isValidWsServerUrl(server: string | undefined): boolean {
  if (!server) return false
  try {
    const parsed = new URL(server)
    return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.host.length > 0
  } catch {
    return false
  }
}

export interface BackgroundTaskParams {
  kind?: 'push' | 'sync' | 'keepalive'
  rawPayload?: string
}

async function applyStoredLanguage(): Promise<void> {
  const prefs = await readPrefs().catch(() => ({} as Record<string, string>))
  const lang = prefs.lang === 'zh' || prefs.lang === 'en' ? prefs.lang : 'system'
  setLang(lang)
}

async function handlePushWakeup(rawPayload?: string): Promise<void> {
  if (!rawPayload) return
  const envelope = parsePushEnvelope(rawPayload)
  if (envelope === null) return
  const [identity, { computers }] = await Promise.all([loadIdentity(), listComputers()])
  const computer = computers.find(item => item.hostDeviceId === envelope.h)
  if (computer === undefined || !computer.hostKey) return
  // Verifies both E2E confidentiality and host static-key sender authentication.
  const opened = openPushEnvelope(identity.privateKey, identity.publicKey, computer.hostKey, envelope)
  await deliverSystemNotice(opened.payload.notice, {
    hostId: opened.hostDeviceId,
    hostName: opened.payload.hostName || computer.name,
    boot: opened.payload.boot,
    appActive: false,
    dedupe: true,
  })
}

async function handlePeriodicSync(): Promise<void> {
  if (DEMO) return
  // Never open a second socket with the same phone identity while keepalive or UI link is already connected.
  if (keepaliveAbort !== null || isForegroundLinkOnline()) return
  const prefs = readNotifyPrefsFromRecord(await readPrefs().catch(() => ({} as Record<string, string>)))
  if (!prefs.enabled || prefs.bgMode === 'off') return
  const [identity, computer] = await Promise.all([loadIdentity(), loadComputer()])
  if (computer === undefined || !isValidWsServerUrl(computer.server)) return

  const client = await openLink(computer, identity)
  try {
    const hello = await callBot<{ api: number | null; boot: string; seq: number }>(client, 'hello', {})
    if (hello.api === null) return
    const saved = await loadNoticeCursor(computer.hostDeviceId)
    if (saved === null) {
      // First sync seeds the watermark so historical notices do not flood the phone.
      await saveNoticeCursor(computer.hostDeviceId, hello.boot, hello.seq)
      return
    }
    const answer = await callBot<NoticeCursorAnswer>(client, 'notices', { boot: saved.boot, since: saved.seq })
    const nextBoot = typeof answer.boot === 'string' && answer.boot.length > 0 ? answer.boot : hello.boot
    // Both same-boot gaps and post-restart resets on an already-tracked host carry retained notices to deliver.
    const list = Array.isArray(answer.notices) ? (answer.notices as NoticeEntry[]) : []
    for (const entry of list) {
      await deliverSystemNotice(entry, {
        hostId: computer.hostDeviceId,
        hostName: computer.name,
        boot: nextBoot,
        appActive: false,
        dedupe: true,
      })
    }
    const finalSeq = typeof answer.seq === 'number' ? answer.seq : hello.seq
    await saveNoticeCursor(computer.hostDeviceId, nextBoot, finalSeq)
  } finally {
    await client.close().catch(() => {})
  }
}

let keepaliveAbort: AbortController | null = null
let stopSubAttached = false

export function stopHeadlessKeepalive(): void {
  keepaliveAbort?.abort()
  keepaliveAbort = null
}

function ensureStopListener(): void {
  if (stopSubAttached || Platform.OS !== 'android') return
  stopSubAttached = true
  onStopKeepalive(() => stopHeadlessKeepalive())
}

async function handleKeepalive(): Promise<void> {
  ensureStopListener()
  stopHeadlessKeepalive()
  const controller = new AbortController()
  keepaliveAbort = controller
  const signal = controller.signal

  while (!signal.aborted) {
    if (DEMO) break
    const prefs = readNotifyPrefsFromRecord(await readPrefs().catch(() => ({} as Record<string, string>)))
    if (!prefs.enabled || prefs.bgMode !== 'instant') break
    const [identity, computer] = await Promise.all([loadIdentity(), loadComputer()])
    if (computer === undefined || !isValidWsServerUrl(computer.server)) break

    const cursor = createNoticeCursor()
    const saved = await loadNoticeCursor(computer.hostDeviceId)
    if (saved !== null) {
      cursor.connect({ boot: saved.boot, seq: saved.seq })
    }

    let client: Awaited<ReturnType<typeof openLink>> | undefined
    try {
      await updateBackgroundStatusText(t('Connecting…'))
      client = await openLink(computer, identity)
      if (signal.aborted) break
      const hello = await callBot<{ api: number | null; boot: string; seq: number }>(client, 'hello', {})
      if (signal.aborted || hello.api === null) break

      await updateBackgroundStatusText(computer.name ? t('Connected to {name}', { name: computer.name }) : t('Connected'))
      const closed = new Promise<void>(resolve => {
        client!.onClose(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      })

      // Buffer live notices while catch-up RPC is in flight so live arrivals never drop earlier catch-up items.
      let catchingUp = saved !== null
      const bufferedLive: NoticeEntry[] = []

      const deliverLive = (entry: NoticeEntry) => {
        if (!cursor.acceptLive(hello.boot, entry)) return
        void deliverSystemNotice(entry, {
          hostId: computer.hostDeviceId,
          hostName: computer.name,
          boot: hello.boot,
          appActive: false,
          dedupe: true,
        })
      }

      client.onEvent(({ event, data }: { event: string; data: unknown }) => {
        if (signal.aborted || event !== 'notice') return
        const entry = data as NoticeEntry
        if (catchingUp) {
          bufferedLive.push(entry)
          return
        }
        deliverLive(entry)
      })

      if (saved === null) {
        cursor.connect(hello)
        await saveNoticeCursor(computer.hostDeviceId, hello.boot, hello.seq)
      } else {
        const answer = await callBot<NoticeCursorAnswer>(client, 'notices', { boot: saved.boot, since: saved.seq }).catch(() => null)
        cursor.connect(hello)
        if (answer !== null && !signal.aborted) {
          const nextBoot = typeof answer.boot === 'string' && answer.boot.length > 0 ? answer.boot : hello.boot
          const list = Array.isArray(answer.notices) ? (answer.notices as NoticeEntry[]) : []
          for (const entry of list) {
            await deliverSystemNotice(entry, {
              hostId: computer.hostDeviceId,
              hostName: computer.name,
              boot: nextBoot,
              appActive: false,
              dedupe: true,
            })
          }
          await saveNoticeCursor(computer.hostDeviceId, nextBoot, typeof answer.seq === 'number' ? answer.seq : hello.seq)
        }
        catchingUp = false
        for (const entry of bufferedLive) {
          if (signal.aborted) break
          await deliverSystemNotice(entry, {
            hostId: computer.hostDeviceId,
            hostName: computer.name,
            boot: hello.boot,
            appActive: false,
            dedupe: true,
          })
        }
      }

      await closed
    } catch {
      /* backoff before retry */
    } finally {
      await client?.close().catch(() => {})
    }

    if (signal.aborted) break
    await updateBackgroundStatusText(t('Reconnecting…'))
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5_000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  if (keepaliveAbort === controller) keepaliveAbort = null
}

export async function runBackgroundTask(params: BackgroundTaskParams = {}): Promise<void> {
  if (Platform.OS !== 'android') return
  ensureStopListener()
  await applyStoredLanguage()
  try {
    if (params.kind === 'push') {
      await handlePushWakeup(params.rawPayload)
    } else if (params.kind === 'keepalive') {
      await handleKeepalive()
    } else {
      await handlePeriodicSync()
    }
  } catch {
    // Background tasks must never crash the process.
  }
}
