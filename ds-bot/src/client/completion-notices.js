import { t } from './i18n.js'

export async function completionPermission() {
  if (globalThis.dsBotApp?.notifications) return await globalThis.dsBotApp.notifications.supported() ? 'granted' : 'unavailable'
  if (typeof Notification !== 'function') return 'unavailable'
  return Notification.permission
}

export async function requestCompletionPermission() {
  const permission = await completionPermission()
  return permission === 'default' ? Notification.requestPermission() : permission
}

export function noticeCompletions({ roster, shownSession, openSession, markUnread, claim, storage = globalThis.localStorage, bridge = globalThis.dsBotApp?.notifications, since = Date.now() }) {
  const handled = new Set()
  let monitorSeen = {}
  try {
    const saved = JSON.parse(storage.getItem('ds-bot-monitor-seen') ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) monitorSeen = saved
  } catch {}
  let stopped = false
  let clientId
  try {
    clientId = storage.getItem('ds-bot-notification-client')
    if (!clientId) { clientId = crypto.randomUUID(); storage.setItem('ds-bot-notification-client', clientId) }
  } catch { clientId = crypto.randomUUID() }
  const notify = () => {
    bridge?.current(shownSession())
    const snapshot = roster.getSnapshot()
    const latest = new Map()
    for (const result of snapshot.monitorResults ?? (snapshot.completions ?? []).filter(entry => entry.kind === 'monitor')) latest.set(result.botId, result)
    for (const [botId, result] of latest) {
      if (!snapshot.byId[botId] || (Object.hasOwn(monitorSeen, botId) && monitorSeen[botId] === result.id)) continue
      monitorSeen[botId] = result.id
      const foreground = document.visibilityState === 'visible' && document.hasFocus() && shownSession() === result.sessionId
      if (!foreground) markUnread(botId)
      try { storage.setItem('ds-bot-monitor-seen', JSON.stringify(monitorSeen)) } catch {}
    }
    for (const entry of snapshot.completions ?? []) {
      if (!snapshot.byId[entry.botId] || handled.has(entry.id) || entry.time < since) continue
      handled.add(entry.id)
      const foreground = document.visibilityState === 'visible' && document.hasFocus() && shownSession() === entry.sessionId
      if (foreground || bridge || snapshot.byId[entry.botId]?.notifyCompletion === false || typeof Notification !== 'function' || Notification.permission !== 'granted') continue
      void claim(entry.id, clientId).then(allowed => {
        if (!allowed || stopped) return
        const note = new Notification(snapshot.byId[entry.botId]?.name ?? t('A Bot'), { body: t('Task completed'), tag: `ds-bot-completion-${entry.id}` })
        note.onclick = () => { window.focus(); openSession(entry.botId); note.close() }
      }).catch(() => {})
    }
  }
  const unsubscribe = roster.subscribe(notify)
  const open = bridge?.onOpen(openSession)
  const timer = bridge ? setInterval(() => bridge.current(shownSession()), 500) : undefined
  notify()
  return () => { stopped = true; unsubscribe(); open?.(); clearInterval(timer) }
}
