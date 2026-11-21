// The window that is not being looked at says so: a Bot replied, or a card waits on the
// user (#1504). The switches live beside the window, the shell decides whether it is in
// front, and a click brings the window forward and opens that conversation.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { t } from './i18n.js'
import { NOTIFY_KEY, badgeOf, noticeText, notificationRows, notifyKind, readNotifyPrefs, writeNotifyPrefs } from './notify.js'

const shellNotify = notice => Promise.resolve(bridge()?.notify?.(notice)).catch(() => {})
const bridge = () => (typeof window === 'undefined' ? undefined : window.dsBotApp)
const prefsNow = () => readNotifyPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(NOTIFY_KEY))
const savePrefs = (next) => {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
  return next
}

/** The switches as this window holds them; a change reaches every listener here. */
const listeners = new Set()
let current = prefsNow()
export function useNotifyPrefs() {
  const [, bump] = useState(0)
  useEffect(() => {
    const run = () => bump(value => value + 1)
    listeners.add(run)
    return () => { listeners.delete(run) }
  }, [])
  return current
}
export function changeNotify(change) {
  current = savePrefs(writeNotifyPrefs(current, change))
  for (const run of listeners) run()
  return current
}

/**
 * Watch every conversation's status and say what the user cannot see: a reply finishing
 * in a chat that is not on screen, or a card starting to wait on them.
 */
export function NotificationWatcher({ useSessions, useSessionStatus, useRoster, useWork, actions }) {
  const work = useWork(value => value)
  const roster = useRoster(value => value)
  const statuses = useSessionStatus(map => map)
  const viewing = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const previous = useRef(new Map())
  const seeded = useRef(false)
  useEffect(() => {
    const shell = bridge()
    shell?.onOpenSession?.((sessionId) => { actions.openSession?.(sessionId) })
    return undefined
  }, [])
  useEffect(() => {
    const prefs = prefsNow()
    const open = document.hasFocus?.() !== false && document.visibilityState !== 'hidden'
    const rows = notificationRows({ statuses, roster, approvals: work.approvals })
    const next = new Map()
    for (const row of rows) {
      const { id, sessionId, name, group, status: after } = row
      // On first ready snapshot, record the baseline silently; afterwards, a newly created
      // Bot or group chat starts from an empty baseline so its first reply/question notifies.
      const before = previous.current.get(id) ?? (seeded.current ? {} : undefined)
      next.set(id, after)
      const kind = notifyKind({
        before, after,
        viewing: viewing === sessionId,
        focused: open,
        enabled: prefs.enabled,
        muted: prefs.muted[id] === true,
        group,
      })
      if (kind === undefined) continue
      void shellNotify({ sessionId: id, ...noticeText({ title: name, kind }) })
    }
    if (roster.ready !== false) seeded.current = true
    previous.current = next
    bridge()?.setBadge?.(badgeOf(rows))
  }, [statuses, viewing, roster, work])
  return null
}

export function NotificationsRow() {
  const prefs = useNotifyPrefs()
  const [permission, setPermission] = useState(undefined)
  useEffect(() => {
    let stopped = false
    void Promise.resolve(bridge()?.notifyStatus?.()).then((value) => { if (!stopped) setPermission(value) }).catch(() => {})
    return () => { stopped = true }
  }, [])
  const denied = permission === 'denied'
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, t('Notifications')),
      h('span', { className: 'bt-set-hint' }, t('Tell me when a Bot answers while I am looking elsewhere.')),
      denied ? h('span', { className: 'bt-set-hint bt-danger', role: 'alert' }, t('System notifications are turned off for DS Bot. Unread marks still show them.')) : null),
    h('div', { className: 'bt-set-control' }, h(Switch, {
      label: t('Notifications'), on: prefs.enabled === true,
      onChange: next => changeNotify({ enabled: next }),
    })))
}

/** Whether this conversation is muted, for the context menu's label. */
export function isMuted(id) {
  return prefsNow().muted[id] === true
}
export function toggleMuted(id) {
  return changeNotify({ mute: { id, on: !isMuted(id) } })
}
