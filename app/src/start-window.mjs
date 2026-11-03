// The start window (docs/plans/2026-10-26-start-window.md §1, §8, §11; windows-onboarding §3): the
// app's own small window that shows start/start.html while the engine boots. It holds the
// start's state and sends the page the whole of it on every change; at the end it grows into the
// team window's rect, and the hidden team window shows on the same rect. The rect maths, the
// growth, the snapshot and the checks are plain functions, so the tests run without Electron.
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { within } from './copy-tree.mjs'

export const START_STATE = 'ds-bot:start-state'
export const START_ACT = 'ds-bot:start-act'

export const START_SIZE = { width: 720, height: 540 }
export const SHORT_START_SIZE = { width: 720, height: 500 }
// Work areas lower than this get the short start window.
const SHORT_WORK_AREA = 588
export const MAIN_SIZE = { width: 1320, height: 860 }
export const PHASES = ['data', 'engine', 'team']
// A start that copies a team from DSH gets a stage of its own for the copy once the copy runs
// (§6): the ring has three arcs while the import card asks, and goes back to three when the copy
// stops or the start goes on without it.
export const IMPORT_PHASES = ['data', 'import', 'engine', 'team']
const COPY_CARDS = ['copying', 'importFailed']
export const phasesOf = state => (state.done.includes('import') || COPY_CARDS.includes(state.card?.kind) ? IMPORT_PHASES : PHASES)
export const START_KINDS = ['first', 'later', 'moving']
export const WATCHDOG_MS = 180_000
export const TEAM_VIEW_MS = 20_000
export const DESTROY_AFTER_MS = 300
// The hand-off (§8): the start window does not resize (stepped setBounds repaints only now and
// then, and the whale in it stutters). The team window, already under it, fades in while the
// start window fades out; window opacity is the compositor's. The team page gets the whale at the
// top of its jump and holds it there through the fade, then glides it onto the avatar.
export const CROSSFADE = { duration: 220, step: 16 }
export const HOLD_MS = CROSSFADE.duration + 40
// How long the team page may take to draw the whale it is handed before the fade starts anyway.
export const TEAM_WAIT_MS = 150
export const TEAM_HANDOFF = 'ds-bot:handoff'
export const FAILURE_LINES = 200
// 〔保存日志…〕 saves this many of the latest log lines, after the same header as the copied details.
export const SAVED_LINES = 5000
// The DeepSeek theme's --bt-main and --bt-ink (ui-standard 2.1), as in start.css: the window's
// own background and caption symbols, which show before the page paints and where Mica is not.
const COLORS = { light: { main: '#fcfcfc', ink: '#141414' }, dark: { main: '#141414', ink: '#f2f2f2' } }
const CAPTION_HEIGHT = 40
export const PAINT_WAIT_MS = 3000
// A window that Windows has just shown is drawn a few frames before its page is (and its own
// opening transition runs over them): the start window shows see-through and turns opaque
// this long after.
export const OPEN_MS = 200
const sinceLaunch = () => String(Math.round(process.uptime() * 1000))

// What the page may ask, and in which views (null: in any). The cards of later pull requests
// send other names, which are refused.
const ACT_VIEWS = {
  handoffShow: ['handoff'],
  handoffDone: ['handoff'],
  retry: ['failed', 'watchdog'],
  wait: ['watchdog'],
  reloadView: ['viewFailed'],
  // 「换个位置…」 on the page (also under the 180 s question), and the cards it leads to
  // (「会放在…」, a place that cannot be used).
  pick: ['boot', 'card', 'watchdog'],
  answer: ['card'],
  // The import card's model and options, and the copying card's stop (windows-onboarding §4).
  importModel: ['card'],
  importOption: ['card'],
  // The failure page's update banner: 〔下载〕 or 〔重试〕 on it, and 「手动下载」.
  installUpdate: ['failed'],
  manualDownload: ['failed'],
  copyDetails: null,
  saveLog: null,
  // The page has drawn its first frame: the window shows.
  painted: null,
}
export const START_ACTS = Object.freeze(Object.keys(ACT_VIEWS))

/** Whether the main process takes this act from the start page in this view. */
export function acceptsAct(name, view) {
  if (typeof name !== 'string' || !Object.hasOwn(ACT_VIEWS, name)) return false
  const views = ACT_VIEWS[name]
  return views === null || views.includes(view)
}

/** Whether a frame shows exactly the start page that was loaded. */
export function isStartPage(frameUrl, loadedUrl) {
  try {
    const frame = new URL(frameUrl)
    return frame.protocol === 'file:' && frame.href === new URL(loadedUrl).href
  } catch {
    return false
  }
}

export const startUrl = (page, kind) => `${pathToFileURL(page).href}?start=${kind}`

/** The start window's content size on a display's work area. */
export const startSize = workArea => ({ ...(workArea.height < SHORT_WORK_AREA ? SHORT_START_SIZE : START_SIZE) })

export function centred(size, area) {
  return {
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y + Math.round((area.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}

/** A rect moved, and shrunk if it must be, to lie inside an area. */
export function clampInto(rect, area) {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

/** The team window's rect: centred on the start window, inside the work area. */
export function mainRect(start, area, size = MAIN_SIZE) {
  const x = Math.round(start.x + start.width / 2 - size.width / 2)
  const y = Math.round(start.y + start.height / 2 - size.height / 2)
  return clampInto({ x, y, width: size.width, height: size.height }, area)
}

/** CSS's cubic-bezier() as a function of the time fraction. */
export function cubicBezier(x1, y1, x2, y2) {
  const curve = (p1, p2) => {
    const c = 3 * p1
    const b = 3 * (p2 - p1) - c
    const a = 1 - c - b
    return s => ((a * s + b) * s + c) * s
  }
  const x = curve(x1, x2)
  const y = curve(y1, y2)
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // x is monotonic for control points inside [0, 1], so halving finds its parameter.
    let low = 0
    let high = 1
    for (let step = 0; step < 40; step += 1) {
      const mid = (low + high) / 2
      if (x(mid) < t) low = mid
      else high = mid
    }
    return y((low + high) / 2)
  }
}
/**
 * Where the start page's whale lands at the hand-off (start-window §8): the Main Bot's avatar as
 * the team view reported it, in CSS px of that page, turned into DIP and then into the start
 * page's own coordinates once the start window has grown onto the team window's rect. The team
 * page may be zoomed, so its viewport's width gives the scale. Undefined unless the report is a
 * plausible box inside the team view.
 * @param {unknown} report { x, y, width, height, viewportWidth, viewportHeight }
 * @param {{ team: { x: number, y: number, width: number }, start: { x: number, y: number } }} content
 *   the team window's content rect, and the start window's content origin once it has grown
 */
export function landingOf(report, { team, start }) {
  if (report === null || typeof report !== 'object') return undefined
  const [x, y, width, height, viewportWidth, viewportHeight] = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'].map(key => Number(report[key]))
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || viewportWidth <= 0 || viewportHeight <= 0) return undefined
  if (width < 16 || height < 16 || x < 0 || y < 0 || x + width > viewportWidth || y + height > viewportHeight) return undefined
  const scale = team.width / viewportWidth
  const round = value => Math.round(value * 2) / 2
  return { x: round(team.x + x * scale - start.x), y: round(team.y + y * scale - start.y), size: round(((width + height) / 2) * scale) }
}

/**
 * The whale the start page hands over, in CSS px of the team page: the start page's own box
 * ({ x, y, size } in its CSS px, which are DIP) through both windows' content origins and the
 * team page's zoom. Undefined unless it is a plausible box.
 * @param {unknown} whale { x, y, size }
 * @param {{ start: { x: number, y: number }, team: { x: number, y: number, width: number }, viewportWidth: number }} windows
 */
export function handoffBox(whale, { start, team, viewportWidth }) {
  if (whale === null || typeof whale !== 'object') return undefined
  const [x, y, size] = ['x', 'y', 'size'].map(key => Number(whale[key]))
  if (![x, y, size, viewportWidth].every(Number.isFinite) || size < 16 || viewportWidth <= 0) return undefined
  const zoom = team.width / viewportWidth
  const round = value => Math.round(value * 2) / 2
  return { x: round((start.x + x - team.x) / zoom), y: round((start.y + y - team.y) / zoom), size: round(size / zoom) }
}

// When the page never sends handoffShow, the main process shows the team window itself. The page
// sends it about 0.72 s after ready on a celebrating hand-off and 0.22 s otherwise (start-window §8).
export const fallbackMs = ({ start, celebrate }) => (start === 'first' || celebrate ? 2500 : 800)

// The reasons of the failure page (windows-onboarding §3), most specific first: a Host that
// stopped says so and carries its own error output, which names the cause. A folder of the data's
// that is not there (a drive that is gone) is 'missing', after the program's own files.
const MISSING = /ENOENT: no such file or directory, (?:mkdir|open|access|stat|lstat|scandir|opendir|rename|copyfile) /u
const REASONS = [
  ['permission', /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted|access is denied/iu],
  ['space', /\b(?:ENOSPC|EDQUOT)\b|no space left|not enough space|disk (?:is )?full/iu],
  ['files', /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|cannot find (?:module|package)|could not load its own bundles|not a valid Win32 application|0xC0000135|3221225781/iu],
  ['engine', /DSH Host stopped|engine's web server/iu],
]

// Only a missing file of the program's own says that the install is incomplete: a data folder
// on a drive that is gone is missing too, and so is a workspace.
function missingOwnFile(error, text, program) {
  if (!/\bENOENT\b/u.test(text)) return false
  const paths = [error?.path, ...[...text.matchAll(/ENOENT: [^,\n]*, \w+ '([^'\n]+)'/gu)].map(match => match[1])]
  return paths.some(path => typeof path === 'string' && program.some(folder => within(path, folder)))
}

/**
 * @param {{ program?: string[] }} where `program`: the folders of the app's own files
 * @returns {'permission' | 'space' | 'files' | 'engine' | 'missing' | 'other'}
 */
export function failureReason(error, { program = [] } = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = `${code} ${message}`
  for (const [reason, pattern] of REASONS) {
    if (pattern.test(text) || (reason === 'files' && missingOwnFile(error, text, program))) return reason
  }
  return MISSING.test(text) ? 'missing' : 'other'
}

// The Main Bot that a kept team's sidebar shows first (ds-bot's channel.js: mainBotIds[0]; an
// older state.json has mainBotId), whose name the greeting says on a reinstall.
export function mainBotName(state) {
  const id = Array.isArray(state?.mainBotIds) ? state.mainBotIds[0] : state?.mainBotId
  const name = typeof id === 'string' ? state.bots?.[id]?.name : undefined
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

// What the start knows about the team it opens. The ring page no longer shows it (no greeting or
// hint lines since 2026-10-30); the snapshot keeps it for now. previewNotice: DSH shows its
// preview notice when the Session is ready and the main view has no non-empty Session, which a
// data folder without a team always has.
export function explainOf({ offered = false, team } = {}) {
  if (offered) return { mode: 'import', nextStep: false, previewNotice: false }
  if (team !== undefined) {
    const name = mainBotName(team.team)
    return { mode: 'reinstall', bots: team.bots, groups: team.rooms, ...(name === undefined ? {} : { name }), nextStep: false, previewNotice: false }
  }
  return { mode: 'new', nextStep: true, previewNotice: true }
}

export const clockMs = (clock, now) => clock.base + (clock.running ? Math.max(0, now - clock.from) : 0)

/** The whole state the page gets: the page computes the elapsed time from clock.ms at clock.at. */
export function startSnapshot(state, now) {
  const snapshot = {
    v: 1,
    lang: state.lang,
    start: state.start,
    motion: state.motion,
    // Windows draws the caption buttons over the page's band; macOS and Linux a system title bar.
    frame: state.frame,
    view: state.view,
    phases: [...phasesOf(state)],
    phase: phasesOf(state).find(phase => !state.done.includes(phase)) ?? 'team',
    done: phasesOf(state).filter(phase => state.done.includes(phase)),
    clock: { ms: Math.round(clockMs(state.clock, now)), at: now, running: state.clock.running, rate: 1 },
    explain: { ...state.explain },
    celebrate: state.celebrate,
    // The window is on screen: the page's entrance starts (start.js).
    shown: state.shown === true,
  }
  if (state.hint !== undefined) snapshot.hint = { ...state.hint }
  if (state.place !== undefined) snapshot.place = { ...state.place }
  if (state.card !== undefined) snapshot.card = { ...state.card }
  if (state.failure !== undefined) snapshot.failure = { reason: state.failure.reason, log: [...state.failure.log] }
  if (state.landing !== undefined) snapshot.landing = { ...state.landing }
  if (state.update !== undefined) snapshot.update = { ...state.update }
  return snapshot
}

export const detailsText = ({ version, platform, arch, reason, lines }) => [`DS Bot ${version} (${platform} ${arch})`, `reason: ${reason}`, '', ...lines].join('\n')

const note = message => { console.log(`DS Bot: start window: ${message}`) }
// The page sends a button's detail as { value }; anything else counts as none.
const valueOf = payload => (payload !== null && typeof payload === 'object' && typeof payload.value === 'string' ? payload.value.slice(0, 40) : undefined)
// An option of the import card: its name and whether it is ticked.
const optionOf = payload => (payload !== null && typeof payload === 'object' && typeof payload.option === 'string' ? { option: payload.option.slice(0, 40), value: payload.value === true } : undefined)

export class StartWindow {
  #o
  #window
  #url
  #painted = Promise.resolve()
  #state
  #explain = explainOf()
  #asks = 0
  #watchAt = WATCHDOG_MS
  #timers = {}
  #phaseAt = 0
  #readyAt = 0
  #showAt = 0
  #handing = false
  #under = false
  #revealed = false
  // Whether the engine of this attempt is up; the stages done say where the whale is, which a
  // retry never moves back.
  #engineUp = false
  // What a dialog of the window (the folder picker) or a card keeps waiting: the hand-off, which
  // would take the window and the dialog's owner away, and the 20 s check's verdict.
  #readyHeld = false
  // The Main Bot avatar's place that came with ready(), kept while the hand-off is held.
  #readyReport
  #heldAt = 0
  #viewLate = false
  #teamShown
  #showTeam

  /**
   * @param {{
   *   electron: { BrowserWindow: any, ipcMain: any, screen: any, shell: any, clipboard: any, nativeTheme: any, systemPreferences: any },
   *   page: string, preload: string, icon: string, mica: boolean, devTools: boolean, css?: string,
   *   lang: () => 'zh' | 'en', motion: string, version: string, program: string[],
   *   log: { dir: string, tail: (count: number) => string[] },
   *   mainWindow: () => any,
   *   onRetry: () => void, onReload: () => void, onClose: () => void,
   *   onPick?: (value?: string) => void, onAnswer?: (value?: string) => void,
   *   saveAs?: (win: any, name: string) => Promise<string | undefined>,
   *   onUpdate?: (name: 'installUpdate' | 'manualDownload') => void,
   *   onImport?: (name: 'importModel' | 'importOption', value: unknown) => void,
   * }} options `lang` is asked at each open; `program` names the folders of the app's own files;
   *   `onClose` runs when the user closes the start window before the hand-off; `onPick` when
   *   the page asks for the folder picker ('changePlace' from its place line, nothing from a
   *   card's 〔重新选〕; on a later start the line's button moves the data), `onAnswer` with a
   *   card's answer ('use' for 〔继续〕 on 「会放在…」), `onUpdate` with a button of the failure
   *   page's update banner, `onImport` with the import card's model and options and the copying
   *   card's stop.
   */
  constructor(options) {
    this.#o = options
    this.#teamShown = new Promise((resolve) => { this.#showTeam = resolve })
    options.electron.ipcMain.handle(START_ACT, (event, name, payload) => this.#act(event, name, payload))
  }

  get kind() { return this.#state?.start }

  /** Settles once the current window has painted its first frame (or has had time to). */
  get painted() { return this.#painted }

  /** Settles once the team window has shown at a hand-off. */
  get teamShown() { return this.#teamShown }

  /** Whether the team window has shown at this start's hand-off. */
  get revealed() { return this.#revealed }

  /** Opens the window, unless one is open, with a fresh state for this kind of start. */
  open(kind) {
    if (this.#open()) return
    const { BrowserWindow, screen, nativeTheme } = this.#o.electron
    const start = START_KINDS.includes(kind) ? kind : 'later'
    this.#reset(start)
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const win32 = process.platform === 'win32'
    const { mica } = this.#o
    const colors = this.#colors()
    const rect = centred(startSize(area), area)
    const win = new BrowserWindow({
      ...rect,
      useContentSize: true, resizable: false, maximizable: false, fullscreenable: false, minimizable: true,
      show: false, title: 'DS Bot', icon: this.#o.icon,
      backgroundColor: mica ? '#00000000' : colors.main,
      // Frameless with the system minimize and close buttons over the page's empty 40 px band.
      ...(win32 ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { height: CAPTION_HEIGHT, color: mica ? '#00000000' : colors.main, symbolColor: colors.ink },
        ...(mica ? { backgroundMaterial: 'mica' } : {}),
      } : {}),
      webPreferences: {
        preload: this.#o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
        // The page paces the whale and the hand-off on timers, which a covered or minimized
        // window would otherwise run once a second.
        backgroundThrottling: false,
        additionalArguments: [`--ds-bot-start=${pathToFileURL(this.#o.page).href}`],
      },
    })
    // At a fractional display scale, Electron 44 on Windows makes a frameless window a few pixels
    // larger than asked; setting the size again once it exists gives the size asked for.
    win.setContentBounds(rect)
    this.#window = win
    this.#url = startUrl(this.#o.page, start)
    const contents = win.webContents
    // The window shows once its page says it has drawn its first frame (the 'painted' act), so it
    // never opens on an empty panel: the page's whale and ring come about 1 s after the window.
    win.once('ready-to-show', () => { note(`the start page painted ${sinceLaunch()} ms after launch`) })
    this.#later('show', PAINT_WAIT_MS, () => { this.#showStart('the page did not say it painted', { now: true }) })
    this.#painted = new Promise((resolve) => {
      win.once('ready-to-show', resolve)
      contents.once('did-finish-load', resolve)
      setTimeout(resolve, PAINT_WAIT_MS)
    })
    win.on('page-title-updated', (event) => { event.preventDefault() })
    contents.on('will-navigate', (event) => { event.preventDefault() })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A reload loses what the preload kept, so the page gets the state again.
    // The page loads only its own files; the app's picker brings its sheet (page-card.css).
    contents.on('dom-ready', () => {
      if (this.#o.css) void contents.insertCSS(this.#o.css)
      this.#send()
    })
    contents.on('render-process-gone', (_event, details) => { note(`the page's renderer stopped (${String(details?.reason)})`) })
    if (this.#o.devTools) {
      contents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
      })
    }
    const recolor = () => {
      if (win.isDestroyed()) return
      const next = this.#colors()
      if (win32) win.setTitleBarOverlay({ color: mica ? '#00000000' : next.main, symbolColor: next.ink })
      if (!mica) win.setBackgroundColor(next.main)
    }
    nativeTheme.on('updated', recolor)
    win.once('closed', () => {
      nativeTheme.off('updated', recolor)
      if (this.#window !== win) return
      this.#window = undefined
      this.#clearTimers()
      if (!this.#revealed) this.#o.onClose()
    })
    void win.loadURL(this.#url).catch((error) => { note(`the start page did not load: ${error instanceof Error ? error.message : String(error)}`) })
  }

  /** The window that dialogs belong to, while it is the one showing; a dialog never opens over nothing. */
  owner() {
    if (!this.#open() || this.#revealed) return undefined
    this.#showStart('a dialog', { now: true })
    return this.#window
  }

  // Shown see-through, then opaque after OPEN_MS; `now` (a dialog, a page that never painted)
  // does not wait. The page starts the whale's entrance once the snapshot says `shown`.
  #showStart(why, { now = false } = {}) {
    this.#clear('show')
    const win = this.#window
    if (!this.#open()) return
    if (!win.isVisible()) {
      if (!now) win.setOpacity(0)
      win.show()
      note(`${this.#state.start} start window shown (${why}) ${sinceLaunch()} ms after launch`)
      if (!now) { this.#later('opaque', OPEN_MS, () => { this.#opaque() }); return }
    }
    if (now) this.#opaque()
  }

  #opaque() {
    this.#clear('opaque')
    if (!this.#open() || this.#state.shown) return
    this.#window.setOpacity(1)
    this.#update({ shown: true })
  }

  /** Brings the start window back while it is the one showing. */
  focus() {
    if (!this.#open() || this.#revealed) return false
    this.#showStart('focus', { now: true })
    const win = this.#window
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  explain(explain) {
    this.#explain = { ...explain }
    if (this.#open()) this.#update({ explain: this.#explain })
  }

  /**
   * The line that says where the data goes, with 「换个位置…」 (start-window §2; a first start, or a
   * later one whose drive runs low, §5): the drive and its free space, or the folder. Undefined
   * takes the line away.
   * @param {{ drive?: string, path?: string, free?: string } | undefined} place
   */
  place(place) {
    if (this.#open()) this.#update({ place: place === undefined ? undefined : { ...place } })
  }

  /** A short drive's one-line note for the first 10 s (§4), or none. */
  hint(hint) {
    if (this.#open()) this.#update({ hint: hint === undefined ? undefined : { ...hint } })
  }

  /**
   * A card on the sheet while the start boots or the data moves (the clock stands still), or
   * none: back to the boot or the move. The cards of a place (「会放在…」, a place that cannot be
   * used, a later start's 「搬到这个文件夹？」), of the first run's import and of a move that did
   * not go through.
   * @param {{ kind: string, [field: string]: unknown } | undefined} card
   * @returns {boolean} whether the window shows it: not on the failure page or at the hand-off
   */
  card(card) {
    if (!this.#open() || !['boot', 'card', 'watchdog', 'moving'].includes(this.#state.view)) return false
    if (card === undefined && this.#state.view !== 'card') return false
    // Back in the boot, a 180 s question that the card replaced comes straight back.
    const back = this.#state.start === 'moving' ? 'moving' : 'boot'
    this.#update(card === undefined ? { view: back, card: undefined } : { view: 'card', card: { ...card } })
    if (card === undefined) this.#resume()
    return true
  }

  /**
   * The start begins again in another folder (§7): the stages go back to the start, the whale
   * sinks and surfaces with its arcs emptied, and the clock starts from 0. The first success after
   * it celebrates, as after a retry.
   */
  restart() {
    if (!this.#open()) return
    note('starting over in another folder')
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#clear('teamView')
    this.#update({ view: 'boot', done: [], card: undefined, failure: undefined, update: undefined, celebrate: true, clock: { base: 0, from: Date.now(), running: true } })
  }

  /**
   * The data moves in the middle of a later start (「换个位置…」 on its place line, §5): the page
   * loads again as the move's start, and a hand-off that waited goes with the start it was for.
   */
  moving() {
    if (!this.#open()) return
    note('the data moves: the start window becomes the move\'s')
    this.#url = startUrl(this.#o.page, 'moving')
    this.#reset('moving')
    void this.#window.loadURL(this.#url).catch((error) => { note(`the start page did not load: ${error instanceof Error ? error.message : String(error)}`) })
  }

  /**
   * The clock stands still while the user answers a dialog: thinking time is not the engine's.
   * The hand-off and the 20 s check wait for the answer too (see ready()).
   */
  async asking(promise) {
    this.#asks += 1
    this.#refresh()
    try {
      return await promise
    } finally {
      this.#asks -= 1
      this.#refresh()
      this.#resume()
    }
  }

  // What waited for the dialogs to close and the card to go.
  #resume() {
    if (this.#asks > 0 || !this.#open() || this.#state.view !== 'boot') return
    if (this.#readyHeld) {
      this.#readyHeld = false
      note(`the hand-off waited ${String(Date.now() - this.#heldAt)} ms for the answer`)
      this.ready(this.#readyReport)
    } else if (this.#viewLate) {
      this.#viewLate = false
      this.#teamViewLate()
    }
  }

  #holdsOff() {
    if (this.#readyHeld) note(`the held hand-off is dropped after ${String(Date.now() - this.#heldAt)} ms: the start goes on elsewhere`)
    this.#readyHeld = false
    this.#readyReport = undefined
    this.#viewLate = false
  }

  /** The data folder, the import or the engine is ready; the engine also again after a retry. */
  done(phase) {
    if (!this.#open() || !['data', 'import', 'engine'].includes(phase)) return
    const again = this.#state.done.includes(phase)
    if (again && (phase !== 'engine' || this.#engineUp)) return
    if (phase === 'engine') this.#engineUp = true
    note(`${phase} took ${String(Date.now() - this.#phaseAt)} ms`)
    this.#phaseAt = Date.now()
    // The engine came up while the 180 s question was open: the question goes.
    this.#update({ ...(again ? {} : { done: [...this.#state.done, phase] }), ...(this.#state.view === 'watchdog' ? { view: 'boot' } : {}) })
  }

  /**
   * The engine that warmed up while the import card waited has stopped for the copy: its stage
   * is open again until the engine of the copied team is up.
   */
  engineDown() {
    if (!this.#open() || !this.#state.done.includes('engine')) return
    this.#engineUp = false
    this.#update({ done: this.#state.done.filter(phase => phase !== 'engine') })
  }

  /** The engine's page started loading in the hidden team window: it has 20 s to call ready(). */
  teamLoading() {
    if (!this.#open()) return
    this.#later('teamView', TEAM_VIEW_MS, () => { this.#teamViewLate() })
  }

  #teamViewLate() {
    if (!['boot', 'card'].includes(this.#state.view)) return
    // A dialog or a card is up: the verdict waits for the answer (#resume).
    if (this.#asks > 0 || this.#state.view === 'card') { this.#viewLate = true; return }
    note(`the team view did not call ready() within ${String(TEAM_VIEW_MS / 1000)} s`)
    this.#update({ view: 'viewFailed', failure: { reason: 'other', log: this.#o.log.tail(FAILURE_LINES) } })
  }

  /**
   * dsBotApp.ready() from the team view: the hand-off starts. While a dialog of the window or
   * a card is up (the folder picker, 「会放在…」), it waits: the hand-off would take the window,
   * and with it the dialog's owner, away while the user is still choosing where the data goes.
   */
  ready(report) {
    if (!this.#open() || !['boot', 'card', 'viewFailed'].includes(this.#state.view) || !this.#engineUp) return
    this.#clear('teamView')
    this.#readyReport = report
    if (this.#asks > 0 || this.#state.view === 'card') {
      if (!this.#readyHeld) {
        note('the team view is ready; the hand-off waits for the answer')
        this.#heldAt = Date.now()
      }
      this.#readyHeld = true
      return
    }
    this.#readyHeld = false
    const now = Date.now()
    note(`team took ${String(now - this.#phaseAt)} ms`)
    this.#readyAt = now
    // A team view that loads after its 20 s goes in without a celebration (§7).
    const celebrate = this.#state.celebrate && this.#state.view !== 'viewFailed'
    this.#update({ view: 'handoff', done: [...phasesOf(this.#state)], celebrate, failure: undefined, landing: this.#landing(report) })
    const main = this.#o.mainWindow()
    if (main !== undefined && !main.isDestroyed() && !this.#window.isMinimized()) this.#underlay(main)
    this.#later('fallback', fallbackMs(this.#state), () => {
      note('the page did not send handoffShow')
      this.#handoffShow({ grow: false })
    })
  }

  /**
   * The failure page: in this window, or in a new one when the team window was already showing.
   * @param {string} kind the kind of start when no start window has opened yet
   */
  fail(error, kind = 'later') {
    const showing = this.#revealed
    // The page's hand-off empties it for the growth and cannot be undone there: a fresh page
    // draws the failure.
    const emptied = !showing && this.#open() && this.#state.view === 'handoff'
    if (showing) {
      this.#destroy()
      const main = this.#o.mainWindow()
      if (main !== undefined && !main.isDestroyed()) main.hide()
    }
    if (!this.#open()) this.open(showing || this.#state === undefined ? kind : this.#state.start)
    this.#cancelHandoff()
    this.#holdsOff()
    this.#clear('teamView')
    this.#clear('fallback')
    this.#update({ view: 'failed', failure: { reason: failureReason(error, { program: this.#o.program }), log: this.#o.log.tail(FAILURE_LINES) } })
    if (emptied) this.#window.webContents.reload()
  }

  /**
   * The failure page's update banner (start-window §7), or none: a new version that may fix what
   * keeps this one from starting. A retry takes it away.
   * @param {{ state: 'available' | 'downloading' | 'installing' | 'failed', version: string, page?: boolean, percent?: number, received?: number, total?: number } | undefined} update
   *   `page`: the version installs from its release page, not by itself; `received` and `total` in MB
   */
  update(update) {
    if (!this.#open() || this.#state.view !== 'failed') return
    this.#update({ update: update === undefined ? undefined : { ...update } })
  }

  /** The team window's rect: centred on the start window, inside that display's work area. */
  mainBounds() {
    const { screen } = this.#o.electron
    if (!this.#open()) return centred(clampInto({ x: 0, y: 0, ...MAIN_SIZE }, screen.getPrimaryDisplay().workArea), screen.getPrimaryDisplay().workArea)
    const start = this.#window.getNormalBounds()
    return mainRect(start, screen.getDisplayMatching(start).workArea)
  }

  // The whale's landing for this hand-off: the team window goes on its rect now (handoffShow
  // places it again, in case the start window is dragged meanwhile), and the start window's frame
  // offset carries over to the rect it grows to. The team page measured itself at the size the
  // window had before that. The landing is optional: anything odd, and the whale dives. A
  // minimized start window does not grow, and its bounds would not say where it is.
  #landing(report) {
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed() || this.#window.isMinimized()) return undefined
    if (report === undefined) { note('no place to land: the whale dives'); return undefined }
    try {
      const measured = main.getContentBounds()
      const rect = this.placeMain(main)
      const team = main.getContentBounds()
      const outer = this.#window.getBounds()
      const inner = this.#window.getContentBounds()
      const landing = landingOf(report, { team: { x: team.x, y: team.y, width: measured.width }, start: { x: rect.x + inner.x - outer.x, y: rect.y + inner.y - outer.y } })
      const inside = landing !== undefined && landing.x >= 0 && landing.y >= 0 && landing.x + landing.size <= rect.width && landing.y + landing.size <= rect.height
      note(inside ? `the whale lands at ${String(landing.x)}, ${String(landing.y)} (${String(landing.size)} px)` : 'no place to land: the whale dives')
      return inside ? landing : undefined
    } catch (error) {
      note(`no place to land (${error instanceof Error ? error.message : String(error)}): the whale dives`)
      return undefined
    }
  }

  /**
   * Puts the hidden team window on its rect, also when made with it: the size it was made with
   * can be off by a few pixels (see open()), the one set afterwards is exact.
   * @returns the rect
   */
  placeMain(main = this.#o.mainWindow()) {
    const rect = this.mainBounds()
    if (main !== undefined && !main.isDestroyed()) main.setBounds(rect)
    return rect
  }

  #open() { return this.#window !== undefined && !this.#window.isDestroyed() }

  #colors() { return COLORS[this.#o.electron.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'] }

  #reset(start) {
    this.#clearTimers()
    this.#handing = false
    this.#under = false
    this.#revealed = false
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    const now = Date.now()
    this.#phaseAt = now
    this.#state = {
      lang: this.#o.lang(), start, motion: this.#o.motion, frame: process.platform === 'win32' ? 'band' : 'system',
      view: start === 'moving' ? 'moving' : 'boot',
      done: [], explain: this.#explain, celebrate: start === 'first', shown: false,
      clock: { base: 0, from: now, running: true },
      hint: undefined, place: undefined, card: undefined, failure: undefined, update: undefined,
    }
    this.#refresh()
  }

  // Applies a change, keeps the clock running only while the start is booting and nobody is
  // being asked, and sends the page the whole state.
  #update(change) {
    const now = Date.now()
    const next = { ...this.#state, ...change }
    const running = this.#asks === 0 && (next.view === 'boot' || next.view === 'moving')
    const clock = next.clock
    if (running !== clock.running) next.clock = { base: clockMs(clock, now), from: now, running }
    this.#state = next
    this.#armWatchdog()
    this.#send()
  }

  #refresh() { if (this.#state !== undefined) this.#update({}) }

  #send() {
    if (this.#open() && this.#state !== undefined) this.#window.webContents.send(START_STATE, startSnapshot(this.#state, Date.now()))
  }

  // 180 s on the start's clock without the engine: the whale asks whether to try again.
  #armWatchdog() {
    this.#clear('watchdog')
    const { start, view, clock } = this.#state
    if (start === 'moving' || view !== 'boot' || !clock.running || this.#engineUp) return
    this.#later('watchdog', this.#watchAt - clockMs(clock, Date.now()), () => {
      note(`no engine after ${String(Math.round(this.#watchAt / 1000))} s`)
      this.#update({ view: 'watchdog' })
    })
  }

  #act(event, name, payload) {
    const win = this.#window
    if (!this.#open() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || !isStartPage(event.senderFrame?.url, this.#url)) return false
    if (!acceptsAct(name, this.#state.view)) {
      note(`refused the act ${typeof name === 'string' ? name.slice(0, 40) : typeof name} in ${this.#state.view}`)
      return false
    }
    if (name === 'handoffShow') this.#handoffShow(payload)
    else if (name === 'handoffDone') note(`handoffDone at handoffShow + ${String(Date.now() - this.#showAt)} ms`)
    else if (name === 'retry') this.#retry()
    else if (name === 'wait') this.#wait()
    else if (name === 'reloadView') this.#reload()
    else if (name === 'copyDetails') this.#copyDetails()
    else if (name === 'saveLog') void this.#saveLog()
    else if (name === 'painted') this.#showStart('painted')
    else if (name === 'pick') this.#o.onPick?.(valueOf(payload))
    else if (name === 'answer') this.#o.onAnswer?.(valueOf(payload))
    else if (name === 'installUpdate' || name === 'manualDownload') this.#o.onUpdate?.(name)
    else if (name === 'importOption') this.#o.onImport?.(name, optionOf(payload))
    else if (name === 'importModel') this.#o.onImport?.(name, valueOf(payload))
    return true
  }

  // The failed stage, or the engine after the 180 s question, starts again; the stages already
  // done stay done, and the first success after this celebrates (§7). The engine starts again
  // in any case, so the 180 s question guards it again.
  #retry() {
    note(`retry from ${this.#state.view}`)
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#update({ view: 'boot', failure: undefined, update: undefined, celebrate: true, done: this.#state.done.filter(phase => phase !== 'team'), clock: { base: 0, from: Date.now(), running: true } })
    this.#o.onRetry()
  }

  // 〔继续等待〕: the question comes back after another 180 s on the clock.
  #wait() {
    this.#watchAt = clockMs(this.#state.clock, Date.now()) + WATCHDOG_MS
    this.#update({ view: 'boot' })
  }

  #reload() {
    note('reloading the team view')
    this.#update({ view: 'boot', failure: undefined })
    this.#o.onReload()
    this.teamLoading()
  }

  #copyDetails() {
    const { version } = this.#o
    const reason = this.#state.failure?.reason ?? 'other'
    const text = detailsText({ version, platform: process.platform, arch: process.arch, reason, lines: this.#o.log.tail(FAILURE_LINES) })
    void Promise.resolve(this.#o.electron.clipboard.writeText(text)).catch((error) => { note(`the details were not copied: ${error instanceof Error ? error.message : String(error)}`) })
  }

  // The app's own picker on the page (saveAs), not a system box.
  async #saveLog() {
    const { version, saveAs } = this.#o
    if (saveAs === undefined) return
    const reason = this.#state.failure?.reason ?? 'other'
    const text = detailsText({ version, platform: process.platform, arch: process.arch, reason, lines: this.#o.log.tail(SAVED_LINES) })
    try {
      const filePath = await saveAs(this.#window, 'DS-Bot-log.txt')
      if (!filePath) return
      await writeFile(filePath, text, 'utf8')
      note(`the log was saved to ${filePath}`)
    } catch (error) {
      note(`the log was not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The page's content has faded; with a landing it is at the top of its jump and says where.
  #handoffShow(payload) {
    if (this.#handing || this.#state.view !== 'handoff') return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#handing = true
    this.#clear('fallback')
    this.#showAt = Date.now()
    note(`handoffShow at ready + ${String(this.#showAt - this.#readyAt)} ms`)
    // The start window may have been dragged since the team window was placed.
    this.placeMain(main)
    const box = this.#state.landing === undefined || this.#readyReport === undefined ? undefined : this.#teamBox(main, payload)
    if (box === undefined || !this.#under) { this.#reveal(); return }
    main.webContents.send(TEAM_HANDOFF, { ...box, hold: HOLD_MS })
    this.#later('teamWait', TEAM_WAIT_MS, () => { note('the team page did not say it drew the whale'); this.#reveal() })
  }

  /** The team page has drawn the whale it was handed: the windows cross-fade. */
  teamReady() {
    if (!this.#handing || this.#revealed || this.#timers.teamWait === undefined) return
    note(`the team page drew the whale at handoffShow + ${String(Date.now() - this.#showAt)} ms`)
    this.#reveal()
  }

  #teamBox(main, payload) {
    try {
      const whale = payload !== null && typeof payload === 'object' ? payload.whale : undefined
      const start = this.#window.getContentBounds()
      const team = main.getContentBounds()
      return handoffBox(whale, { start, team, viewportWidth: Number(this.#readyReport.viewportWidth) })
    } catch (error) {
      note(`no whale to hand over (${error instanceof Error ? error.message : String(error)})`)
      return undefined
    }
  }

  // At ready() the team window shows, see-through, out of the taskbar and under the start window,
  // so that Windows' own opening transition has run by the reveal (shown at the reveal, it dims
  // the page for a few frames) and the team page is drawn and can take the whale.
  #underlay(main) {
    try {
      main.setSkipTaskbar(true)
      main.setOpacity(0)
      main.showInactive()
      this.#window.moveTop()
      this.#under = true
    } catch (error) {
      note(`the team window did not go under the start window: ${error instanceof Error ? error.message : String(error)}`)
      this.#unlay(main)
    }
  }

  #unlay(main) {
    this.#under = false
    if (main.isDestroyed()) return
    main.hide()
    main.setOpacity(1)
    main.setSkipTaskbar(false)
  }

  // The team window shows on its rect: with the focus when the start window had it; otherwise
  // behind nothing new, flashing its taskbar button; minimized when the start window was.
  #reveal() {
    if (this.#revealed || !this.#open()) return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#revealed = true
    this.#showTeam()
    this.#clear('fallback')
    this.#clear('teamWait')
    const win = this.#window
    const how = win.isMinimized() ? 'minimized' : win.isFocused() ? 'focused' : 'behind'
    if (this.#under && how !== 'minimized') { this.#crossfade(main, win, how); return }
    if (this.#under) this.#unlay(main)
    if (how === 'focused') {
      main.show()
      main.focus()
    } else if (how === 'minimized') {
      main.minimize()
    } else {
      main.showInactive()
      try { main.moveAbove(win.getMediaSourceId()) } catch { /* the order stays the system's */ }
    }
    if (how !== 'focused') {
      main.flashFrame(true)
      main.once('focus', () => { main.flashFrame(false) })
    }
    // Leaves the taskbar only now, so the app's button never goes away.
    win.setSkipTaskbar(true)
    note(`team window shown (${how}) at ready + ${String(Date.now() - this.#readyAt)} ms`)
    this.#later('destroy', DESTROY_AFTER_MS, () => { this.#destroy() })
  }

  // The team window, on its rect around and under the start window, fades in while the start
  // window fades out over it. With a whale handed over, the team page holds it where the start
  // page's whale is through this fade, so the two stay on each other.
  #crossfade(main, win, how) {
    // A team window hidden while it waited (closed to the tray) comes back for the fade.
    if (!main.isVisible()) main.showInactive()
    main.setSkipTaskbar(false)
    win.setSkipTaskbar(true)
    note(`cross-fade at ready + ${String(Date.now() - this.#readyAt)} ms`)
    const began = Date.now()
    const step = () => {
      if (!this.#open() || main.isDestroyed()) return
      const time = Math.min(1, (Date.now() - began) / CROSSFADE.duration)
      const eased = time * time * (3 - 2 * time)
      main.setOpacity(eased)
      win.setOpacity(1 - eased)
      if (time < 1) { this.#later('fade', CROSSFADE.step, step); return }
      if (how === 'focused') main.focus()
      else {
        main.flashFrame(true)
        main.once('focus', () => { main.flashFrame(false) })
      }
      note(`team window shown (${how}) at ready + ${String(Date.now() - this.#readyAt)} ms`)
      this.#destroy()
    }
    step()
  }

  #cancelHandoff() {
    const main = this.#o.mainWindow()
    if (this.#under && !this.#revealed && main !== undefined) this.#unlay(main)
    if (!this.#handing || this.#revealed) return
    this.#clear('teamWait')
    this.#handing = false
  }

  #destroy() {
    const win = this.#window
    if (win !== undefined && !win.isDestroyed()) win.destroy()
  }

  #later(name, ms, run) {
    this.#clear(name)
    this.#timers[name] = setTimeout(() => {
      delete this.#timers[name]
      run()
    }, Math.max(0, ms))
  }

  #clear(name) {
    clearTimeout(this.#timers[name])
    delete this.#timers[name]
  }

  #clearTimers() { for (const name of Object.keys(this.#timers)) this.#clear(name) }
}
