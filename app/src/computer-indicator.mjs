// The floating computer-use indicator: a small always-on-top bar at the top of the
// screen that shows which Bots hold a computer lease and offers Stop, Stop all and
// "Let it continue". It is `focusable: false` so it never steals the cursor, and
// `setContentProtection(true)` keeps it out of the Bots' own screenshots.

/**
 * @param {{
 *   BrowserWindow: new (options: object) => object,
 *   screen: { getPrimaryDisplay: () => { workAreaSize: { width: number, height: number }, workArea: { x: number, y: number } } },
 *   html: (entries: object[]) => string,
 *   ipcMain?: { on: (channel: string, listener: (event: { sender: object }, ...args: any[]) => void) => void },
 *   preload?: string,
 *   onAction?: (action: string, botId: string | null) => void,
 *   log?: Pick<Console, 'warn'>,
 * }} options injected Electron surface and a renderer for the bar
 * @returns {{ update: (entries: object[]) => void, dispose: () => void }}
 */
export function createComputerIndicator({ BrowserWindow, screen, html, ipcMain, preload, onAction = () => {}, log = console }) {
  let win = null
  // One listener for the indicator's whole life: a listener per open() would
  // multiply each click on reopen. The check pins it to the current window.
  ipcMain?.on?.('ds-bot:computer-indicator:act', (event, action, botId) => {
    if (event?.sender !== win?.webContents) return
    onAction(String(action ?? ''), botId === '' || botId === undefined || botId === null ? null : String(botId))
  })
  let entries = []
  let labels = {}
  // Fit the transparent window to the pill: only the pill is painted, so the
  // window shrinks to its width and stays centered on the primary work area.
  const fit = async () => {
    try {
      const width = await win?.webContents?.executeJavaScript("document.querySelector('.bar')?.scrollWidth ?? 0")
      if (win === null || typeof width !== 'number' || width <= 0) return
      const area = screen.getPrimaryDisplay()
      const full = Math.ceil(width) + 24
      win.setBounds({ width: full, height: 48, x: Math.round(area.workArea.x + (area.workAreaSize.width - full) / 2), y: area.workArea.y + 8 })
    } catch {}
  }
  const open = () => {
    if (win !== null) return
    const area = screen.getPrimaryDisplay()
    const width = area.workAreaSize.width - 64
    win = new BrowserWindow({
      width,
      height: 48,
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
      webPreferences: { sandbox: true, preload },
    })
    // The bar must never appear inside a screenshot the provider hands a Bot.
    try { win.setContentProtection(true) } catch (error) { log.warn(`DS Bot: the indicator could not hide from screenshots: ${error instanceof Error ? error.message : String(error)}`) }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (error) { log.warn(`DS Bot: the indicator could not join every workspace: ${error instanceof Error ? error.message : String(error)}`) }
    win.once('ready-to-show', () => { win?.showInactive() })
    win.on('closed', () => { win = null })
    const page = html(entries, labels)
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).then(fit).catch((error) => {
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
      entries = (Array.isArray(next?.rows) ? next.rows : []).map(sanitizeEntry)
      labels = next?.labels ?? {}
      if (entries.length === 0) { close(); return }
      if (win === null) { open(); return }
      try { win.webContents?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(entries, labels))}`).then(fit) } catch (error) { log.warn(`DS Bot: the indicator did not update: ${error instanceof Error ? error.message : String(error)}`) }
    },
    dispose() {
      entries = []
      close()
    },
  }
}

// The bar's own page: the same glass pill the in-app indicator wears, themed by
// the system appearance. Only the pill is painted; the window is transparent.
export function indicatorHtml(entries, labels = {}) {
  const avatar = (entry) => entry.avatar !== undefined
    ? `<img class="ava" src="${escapeHtml(entry.avatar)}" alt="">`
    : `<span class="ava dot" style="background:${escapeHtml(entry.color ?? '#888')}">${escapeHtml(String(entry.name ?? entry.label ?? 'B').slice(0, 1))}</span>`
  const stopBtn = entry => `<button class="stop" data-act="stop:${escapeHtml(entry.botId ?? '')}" aria-label="${escapeHtml(labels.stop ?? 'Stop')}" title="${escapeHtml(labels.stop ?? 'Stop')}"><span class="sq"></span></button>`
  const row = (entry) => `
    <span class="entry">${avatar(entry)}<span class="text"><b>${escapeHtml(entry.name ?? entry.label)}</b>${entry.app !== undefined ? `<i>${escapeHtml(entry.app)}</i>` : ''}</span>${stopBtn(entry)}</span>`
  const waiting = (entry) => `
    <span class="entry">${avatar(entry)}<span class="text"><b>${escapeHtml(entry.name ?? entry.label)}</b>${entry.app !== undefined ? `<i>${escapeHtml(entry.app)}</i>` : ''}</span><button class="go" data-act="letgo:${escapeHtml(entry.botId ?? '')}">${escapeHtml(labels.letGo ?? 'Let it continue')}</button></span>`
  const rows = entries.map((entry, index) => `${index > 0 ? '<span class="sep"></span>' : ''}${entry.waiting ? waiting(entry) : row(entry)}`).join('')
  const stopAll = entries.filter(entry => !entry.waiting).length > 1
    ? `<button class="all" data-act="stopall:">${escapeHtml(labels.stopAll ?? 'Stop all')}</button>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}
body{margin:0;background:transparent;overflow:hidden;font:12.5px -apple-system,sans-serif;-webkit-app-region:no-drag;user-select:none}
.bar{display:inline-flex;align-items:center;gap:8px;height:36px;white-space:nowrap;padding:0 12px;margin:4px 12px;border-radius:999px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-size:12.5px}
@media (prefers-color-scheme:light){.bar{background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 6px 24px rgba(0,0,0,.14);color:#1c1c1e}.bar i,.go{color:#555}}
@media (prefers-color-scheme:dark){.bar{background:rgba(30,30,32,.88);border:1px solid rgba(255,255,255,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 6px 24px rgba(0,0,0,.4);color:#f2f2f7}.bar i{color:#aaa}.go{color:#0a84ff}}
.live{flex:none;width:7px;height:7px;border-radius:50%;background:#ff453a;box-shadow:0 0 0 3px rgba(255,69,58,.24)}
.sep{flex:none;width:1px;height:14px;background:currentColor;opacity:.2}
.entry{display:flex;align-items:center;gap:6px;min-width:0}
.ava{flex:none;width:16px;height:16px;border-radius:50%;object-fit:cover}
.ava.dot{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:600}
.text{display:flex;align-items:baseline;gap:5px;min-width:0;overflow:hidden}
.text b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.text i{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px;opacity:.75}
.stop{flex:none;width:22px;height:22px;border:0;border-radius:50%;background:rgba(128,128,128,.2);color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.sq{width:8px;height:8px;border-radius:2px;background:currentColor}
.stop:hover{background:#ff453a;color:#fff}
.go,.all{flex:none;border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;border:1px solid transparent}
.go{background:rgba(10,132,255,.16);border-color:rgba(10,132,255,.32);color:#0a84ff}
.all{background:rgba(255,69,58,.12);border-color:rgba(255,69,58,.3);color:#ff453a}
</style></head><body onclick="const a=event.target.closest('[data-act]')?.dataset?.act;if(a&&window.computerIndicator){const i=a.indexOf(':');computerIndicator.act(a.slice(0,i),a.slice(i+1)||null)}"><div class="bar"><span class="live"></span>${rows}${stopAll}</div></body></html>`
}

// What the client may put on a row: ids and text, a hex color, an optional
// bounded data-URL avatar. Anything else is dropped before it reaches the page.
export function sanitizeEntry(entry) {
  if (entry === null || typeof entry !== 'object') return { label: '' }
  const clean = {}
  for (const key of ['botId', 'label', 'name', 'app']) if (entry[key] !== undefined) clean[key] = String(entry[key])
  if (entry.waiting === true) clean.waiting = true
  if (typeof entry.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.color)) clean.color = entry.color
  if (typeof entry.avatar === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(entry.avatar) && entry.avatar.length <= 12000) clean.avatar = entry.avatar
  return clean
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
