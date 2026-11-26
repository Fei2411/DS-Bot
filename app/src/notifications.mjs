// System notifications from the shell's main process: the one thing a window that
// is not in front can use to say a Bot has answered or a card is waiting (#1504).
// The notification never takes focus; only a click brings the window forward and
// opens the Session it names.

const MAX_LIVE = 50
const LIVE_TTL_MS = 10 * 60_000

/**
 * @param {{
 *   Notification: new (options: object) => { on: (event: string, run: () => void) => void, show: () => void, close?: () => void },
 *   systemPreferences?: { getNotificationSettings?: () => { authorizationStatus?: string } },
 *   platform?: string,
 *   isSupported?: () => boolean,
 *   maxLive?: number,
 *   ttlMs?: number,
 *   log?: Pick<Console, 'warn'>,
 * }} options the shell's Electron surface, injectable for tests
 */
export function createNotifications({ Notification, systemPreferences, platform = process.platform, isSupported, maxLive = MAX_LIVE, ttlMs = LIVE_TTL_MS, log = console }) {
  const live = new Map()
  const supported = () => (typeof isSupported === 'function' ? isSupported() : Notification.isSupported?.() !== false)
  const drop = (notification) => {
    const timer = live.get(notification)
    if (timer !== undefined) clearTimeout(timer)
    live.delete(notification)
  }

  /**
   * Whether the operating system will show a notification at all. `unknown` means the
   * platform does not report it (Windows, Linux): the first show asks there.
   */
  function status() {
    if (!supported()) return 'unsupported'
    let authorizationStatus
    try { authorizationStatus = systemPreferences?.getNotificationSettings?.()?.authorizationStatus } catch { authorizationStatus = undefined }
    if (authorizationStatus === 'denied') return 'denied'
    if (authorizationStatus === 'restricted') return 'denied'
    return 'unknown'
  }

  /**
   * Show one notification. A click runs `open`, exactly once, and closes the banner.
   * @param {{ sessionId?: string, title: string, body: string }} notice
   * @param {{ open?: () => void, focused?: () => boolean }} hooks `focused` answers
   *   whether the window is in front; a focused window needs no reminder
   * @returns {boolean} whether a notification was handed to the system
   */
  function show(notice, { open, focused } = {}) {
    if (!supported()) return false
    if (typeof focused === 'function' && focused() === true) return false
    if (status() === 'denied') return false
    const title = String(notice?.title ?? '').slice(0, 120)
    const body = String(notice?.body ?? '').slice(0, 200)
    if (title === '' && body === '') return false
    let notification
    try {
      notification = new Notification({ title, body, silent: false })
    } catch (error) {
      log.warn?.('ds-bot: notification failed: %s', error?.message ?? error)
      return false
    }
    while (live.size >= maxLive && maxLive > 0) {
      const oldest = live.keys().next().value
      if (oldest === undefined) break
      drop(oldest)
    }
    let timer
    if (Number.isFinite(ttlMs) && ttlMs > 0) {
      timer = setTimeout(() => { drop(notification) }, ttlMs)
      timer.unref?.()
    }
    live.set(notification, timer)
    let settled = false
    const done = () => { drop(notification) }
    notification.on('close', done)
    notification.on('failed', done)
    notification.on('click', () => {
      // One banner opens one Session: a second click, or a click after close, is nothing.
      if (settled) return
      settled = true
      done()
      try { open?.() } catch (error) { log.warn?.('ds-bot: notification open failed: %s', error?.message ?? error) }
    })
    notification.show()
    return true
  }

  /** Close every banner this shell put up (the window came to the front). */
  function clear() {
    for (const [notification, timer] of [...live]) {
      if (timer !== undefined) clearTimeout(timer)
      live.delete(notification)
      try { notification.close?.() } catch { /* already gone */ }
    }
  }

  return { status, show, clear, supported }
}

/**
 * The badge a dock or taskbar shows: the number of conversations with something new.
 * macOS and Linux read `setBadgeCount`; Windows has none and keeps the tray tooltip.
 * @param {number} count
 * @returns {number} the count actually set
 */
export function badgeCount(count) {
  const value = Math.max(0, Math.trunc(Number(count) || 0))
  return value > 99 ? 99 : value
}
