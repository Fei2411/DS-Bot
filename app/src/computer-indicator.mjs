// The floating computer-use indicator: a small always-on-top bar at the top of the
// screen that shows which Bots hold a computer lease and offers Stop, Stop all and
// "Let it continue". It is `focusable: false` so it never steals the cursor, and
// `setContentProtection(true)` keeps it out of the Bots' own screenshots.

/**
 * @param {{
 *   BrowserWindow: new (options: object) => object,
 *   screen: { getPrimaryDisplay: () => { workAreaSize: { width: number, height: number }, workArea: { x: number, y: number } } },
 *   html: (entries: object[]) => string,
 *   onAction?: (action: string, botId: string | null) => void,
 *   log?: Pick<Console, 'warn'>,
 * }} options injected Electron surface and a renderer for the bar
 * @returns {{ update: (entries: object[]) => void, dispose: () => void }}
 */
export function createComputerIndicator({ BrowserWindow, screen, html, onAction = () => {}, log = console }) {
  let win = null
  let entries = []
  let labels = {}
  const open = () => {
    if (win !== null) return
    const area = screen.getPrimaryDisplay()
    const width = Math.min(520, area.workAreaSize.width - 64)
    const height = 40 + entries.length * 0
    win = new BrowserWindow({
      width,
      height,
      x: Math.round(area.workArea.x + (area.workAreaSize.width - width) / 2),
      y: area.workArea.y + 8,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true },
    })
    // The bar must never appear inside a screenshot the provider hands a Bot.
    try { win.setContentProtection(true) } catch (error) { log.warn(`DS Bot: the indicator could not hide from screenshots: ${error instanceof Error ? error.message : String(error)}`) }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (error) { log.warn(`DS Bot: the indicator could not join every workspace: ${error instanceof Error ? error.message : String(error)}`) }
    win.once('ready-to-show', () => { win?.showInactive() })
    win.on('closed', () => { win = null })
    // Button clicks in the bar page post a message back; the main process turns
    // them into client actions. The page is data: only, no preload.
    win.webContents?.on?.('console-message', (_event, _level, message) => {
      if (typeof message !== 'string' || !message.startsWith('dsbot-computer:')) return
      const [, action, botId] = message.split(':')
      onAction(action, botId === '' || botId === undefined ? null : botId)
    })
    const page = html(entries, labels)
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch((error) => {
      log.warn(`DS Bot: the indicator did not load: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const close = () => {
    if (win === null) return
    const closing = win
    win = null
    try { closing.close() } catch (error) { log.warn(`DS Bot: the indicator did not close: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return {
    /** Re-render the bar; empty entries hide the window, entries show it. */
    update(next) {
      entries = Array.isArray(next?.rows) ? next.rows : []
      labels = next?.labels ?? {}
      if (entries.length === 0) { close(); return }
      if (win === null) { open(); return }
      try { win.webContents?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(entries, labels))}`) } catch (error) { log.warn(`DS Bot: the indicator did not update: ${error instanceof Error ? error.message : String(error)}`) }
    },
    dispose() {
      entries = []
      close()
    },
  }
}

// The bar's own page: one row per entry, buttons that post a console message the
// main process listens for. Plain inline styles keep it self-contained.
export function indicatorHtml(entries, labels = {}) {
  const row = (entry) => `
    <span style="display:flex;align-items:center;gap:4px;min-width:0">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.label)}</span>
      <button data-act="stop:${escapeHtml(entry.botId ?? '')}" style="border:0;background:none;color:#2563eb;cursor:pointer;font:inherit;white-space:nowrap">${escapeHtml(labels.stop ?? 'Stop')}</button>
    </span>`
  const waiting = (entry) => `
    <span style="display:flex;align-items:center;gap:6px">
      <span style="white-space:nowrap">${escapeHtml(entry.label)}</span>
      <button data-act="letgo:${escapeHtml(entry.botId ?? '')}" style="border:0;background:none;color:#2563eb;cursor:pointer;font:inherit;white-space:nowrap">${escapeHtml(labels.letGo ?? 'Let it continue')}</button>
    </span>`
  const rows = entries.map(entry => entry.waiting ? waiting(entry) : row(entry)).join('')
  const stopAll = entries.filter(entry => !entry.waiting).length > 1
    ? `<button data-act="stopall:" style="border:0;background:none;color:#2563eb;cursor:pointer;font:inherit;white-space:nowrap">${escapeHtml(labels.stopAll ?? 'Stop all')}</button>` : ''
  return `<!doctype html><html><body style="margin:0;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-radius:20px;background:rgba(28,28,30,.92);color:#fff;font:12.5px -apple-system,sans-serif;-webkit-app-region:no-drag;user-select:none" onclick="const a=event.target.dataset&&event.target.dataset.act;if(a)console.log('dsbot-computer:'+a)">${rows}${stopAll}</body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
