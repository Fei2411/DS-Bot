import { Platform } from 'react-native'
import { openPushEnvelope, parsePushEnvelope } from '../../../link/src/index.ts'
import { callBot, openLink } from '../connection.ts'
import { listComputers, loadComputer, loadIdentity, readPrefs } from '../store.ts'
import { setLang, t } from '../ui/i18n.ts'
import { createNoticeCursor, type NoticeCursorAnswer } from './notices.ts'
import { loadNoticeCursor, saveNoticeCursor } from './notice-cursor-store.ts'
import { deliverSystemNotice } from './notification-bridge.ts'
import { readNotifyPrefsFromRecord, type NoticeEntry } from './notifications.ts'
import { updateBackgroundStatusText } from './notifications-native'

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
  if (computer === undefined) return
  const opened = openPushEnvelope(identity.privateKey, identity.publicKey, envelope)
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
    const nextBoot = typeof answer.boot === 'string' ? answer.boot : hello.boot
    if (answer.reset === true) {
      await saveNoticeCursor(computer.hostDeviceId, nextBoot, typeof answer.seq === 'number' ? answer.seq : hello.seq)
      return
    }
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

export function stopHeadlessKeepalive(): void {
  keepaliveAbort?.abort()
  keepaliveAbort = null
}

async function handleKeepalive(): Promise<void> {
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
      const { sameBoot, since } = cursor.connect(hello)
      const closed = new Promise<void>(resolve => {
        client!.onClose(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      })

      client.onEvent(({ event, data }: { event: string; data: unknown }) => {
        if (signal.aborted || event !== 'notice') return
        if (!cursor.acceptLive(hello.boot, data)) return
        void deliverSystemNotice(data as NoticeEntry, {
          hostId: computer.hostDeviceId,
          hostName: computer.name,
          boot: hello.boot,
          appActive: false,
          dedupe: true,
        })
      })

      if (saved === null) {
        await saveNoticeCursor(computer.hostDeviceId, hello.boot, hello.seq)
      } else {
        const answer = await callBot<NoticeCursorAnswer>(client, 'notices', { boot: hello.boot, since }).catch(() => null)
        if (answer !== null && !signal.aborted) {
          const { reset, replay } = cursor.acceptCatchUp(hello.boot, sameBoot, answer)
          if (!reset) {
            for (const entry of replay) {
              await deliverSystemNotice(entry as NoticeEntry, {
                hostId: computer.hostDeviceId,
                hostName: computer.name,
                boot: hello.boot,
                appActive: false,
                dedupe: true,
              })
            }
          }
          await saveNoticeCursor(computer.hostDeviceId, hello.boot, typeof answer.seq === 'number' ? answer.seq : hello.seq)
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
