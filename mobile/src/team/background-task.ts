import { AppState, Platform } from 'react-native'
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
  // Never open a second socket with the same phone identity while keepalive or UI link is active.
  if (keepaliveAbort !== null || isForegroundLinkOnline() || AppState.currentState === 'active') return
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
    if (DEMO || isForegroundLinkOnline() || AppState.currentState === 'active') break
    const prefs = readNotifyPrefsFromRecord(await readPrefs().catch(() => ({} as Record<string, string>)))
    if (signal.aborted || !prefs.enabled || prefs.bgMode !== 'instant') break
    const [identity, computer] = await Promise.all([loadIdentity(), loadComputer()])
    if (signal.aborted || computer === undefined || !isValidWsServerUrl(computer.server)) break

    const cursor = createNoticeCursor()
    const saved = await loadNoticeCursor(computer.hostDeviceId)
    if (signal.aborted) break
    if (saved !== null) {
      cursor.connect({ boot: saved.boot, seq: saved.seq })
    }

    let client: Awaited<ReturnType<typeof openLink>> | undefined
    let offClose: (() => void) | undefined
    let offEvent: (() => void) | undefined
    let onAbort: (() => void) | undefined
    try {
      await updateBackgroundStatusText(t('Connecting…'))
      if (signal.aborted) break
      client = await openLink(computer, identity)

      // Bind close, abort, and event listeners immediately after openLink() so an early
      // socket drop or stopKeepalive signal during hello/notices can never leave await closed hung.
      let resolveClosed!: () => void
      const closed = new Promise<void>(resolve => { resolveClosed = resolve })
      let socketClosed = false
      const markClosed = () => {
        if (socketClosed) return
        socketClosed = true
        resolveClosed()
      }
      onAbort = () => {
        markClosed()
        void client?.close().catch(() => {})
      }
      offClose = client.onClose(markClosed)
      if (signal.aborted) {
        onAbort()
        break
      }
      signal.addEventListener('abort', onAbort, { once: true })

      let catchingUp = true
      let activeBoot = ''
      const bufferedLive: NoticeEntry[] = []

      const deliverLive = (entry: NoticeEntry) => {
        if (!cursor.acceptLive(activeBoot, entry)) return
        void deliverSystemNotice(entry, {
          hostId: computer.hostDeviceId,
          hostName: computer.name,
          boot: activeBoot,
          appActive: false,
          dedupe: true,
        })
      }

      offEvent = client.onEvent(({ event, data }: { event: string; data: unknown }) => {
        if (signal.aborted || socketClosed || event !== 'notice') return
        const entry = data as NoticeEntry
        if (catchingUp) {
          bufferedLive.push(entry)
          return
        }
        deliverLive(entry)
      })

      const hello = await callBot<{ api: number | null; boot: string; seq: number }>(client, 'hello', {})
      if (signal.aborted || hello.api === null) break
      if (!socketClosed) {
        activeBoot = hello.boot
        await updateBackgroundStatusText(computer.name ? t('Connected to {name}', { name: computer.name }) : t('Connected'))
        if (signal.aborted) break
      }

      if (!socketClosed) {
        if (saved === null) {
          cursor.connect(hello)
          await saveNoticeCursor(computer.hostDeviceId, hello.boot, hello.seq)
          while (bufferedLive.length > 0 && !signal.aborted) {
            const entry = bufferedLive.shift()!
            if (!cursor.acceptLive(activeBoot, entry)) continue
            await deliverSystemNotice(entry, {
              hostId: computer.hostDeviceId,
              hostName: computer.name,
              boot: activeBoot,
              appActive: false,
              dedupe: true,
            })
          }
          catchingUp = false
        } else {
          const answer = await callBot<NoticeCursorAnswer>(client, 'notices', { boot: saved.boot, since: saved.seq }).catch(() => null)
          if (answer !== null && !signal.aborted) {
            const { sameBoot } = cursor.connect(hello)
            const nextBoot = typeof answer.boot === 'string' && answer.boot.length > 0 ? answer.boot : hello.boot
            activeBoot = nextBoot
            const list = Array.isArray(answer.notices) ? (answer.notices as NoticeEntry[]) : []
            let completedBatch = true
            for (const entry of list) {
              if (signal.aborted) {
                completedBatch = false
                break
              }
              await deliverSystemNotice(entry, {
                hostId: computer.hostDeviceId,
                hostName: computer.name,
                boot: nextBoot,
                appActive: false,
                dedupe: true,
              })
            }
            if (completedBatch && !signal.aborted) {
              cursor.acceptCatchUp(hello.boot, sameBoot, answer)
              const finalSeq = typeof answer.seq === 'number' ? answer.seq : hello.seq
              await saveNoticeCursor(computer.hostDeviceId, nextBoot, finalSeq)
              while (bufferedLive.length > 0 && !signal.aborted) {
                const entry = bufferedLive.shift()!
                if (!cursor.acceptLive(activeBoot, entry)) continue
                await deliverSystemNotice(entry, {
                  hostId: computer.hostDeviceId,
                  hostName: computer.name,
                  boot: activeBoot,
                  appActive: false,
                  dedupe: true,
                })
              }
              catchingUp = false
            }
          }
        }

        if (!signal.aborted && !socketClosed && !catchingUp) {
          await closed
        }
      }
    } catch {
      /* backoff before retry */
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      offClose?.()
      offEvent?.()
      await client?.close().catch(() => {})
    }

    if (signal.aborted) break
    await updateBackgroundStatusText(t('Reconnecting…'))
    if (signal.aborted) break
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 5_000)
      signal.addEventListener('abort', done, { once: true })
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
