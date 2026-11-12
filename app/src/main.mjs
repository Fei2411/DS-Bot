// Electron main process: a small start window while the app's own DSH Host boots, then one window
// for the Bot team. The team window loads the Host's loopback address as DSH Web does: DSH's
// sign-in sends the page's origin as the address the browser comes back to, and accepts only a
// loopback one. It loads hidden and shows once the team view is ready (start-window.mjs). Closing
// the team window hides it; the tray brings it back and its Quit ends the app (shell.mjs). Only
// what the start window and the tray need is imported up front; the rest loads once the start
// window is up (docs/plans/2026-10-26-start-window.md §11).
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, shell as electronShell, systemPreferences, Tray, WebContentsView } from 'electron'
import { createComputerIndicator, indicatorHtml } from './computer-indicator.mjs'
import { createComputerCursor } from './computer-cursor.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { canonicalExecPath } from './canonical-path.mjs'
import { disk } from './copy-tree.mjs'
import { configureIdentity } from './legacy.mjs'
import { hostPort } from './host-port.mjs'
import { captureStdio, LogFile } from './logs.mjs'
import { Pickers } from './picker-host.mjs'
import { currentRootOf, driveOf, formatBytes, freeSpace, isEmptyTree, pickFrom, placeOf, rootOf, runningLow } from './place.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { readStartFrame, writeStartFrame } from './start-frame.mjs'
import { explainOf, StartWindow } from './start-window.mjs'
import { langOf } from './start/text.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { CAPTION_HEIGHT, cssColor, frameOptions, framelessOn, keepVibrancy, materialOf, nativeThemeSource } from './window-frame.mjs'

const { rm } = disk.promises

const IPC = {
  caption: 'ds-bot:caption-colors', nativeTheme: 'ds-bot:native-theme', fullscreen: 'ds-bot:fullscreen',
  dataLocation: 'ds-bot:data-location', moveData: 'ds-bot:move-data', teamWorkspace: 'ds-bot:team-workspace',
  ready: 'ds-bot:ready', handoffReady: 'ds-bot:handoff-ready', motion: 'ds-bot:motion',
  card: 'ds-bot:app-card', cardShown: 'ds-bot:app-card-shown', cardAnswer: 'ds-bot:app-card-answer',
  browserAcquire: 'ds-bot:browser-acquire', browserRelease: 'ds-bot:browser-release', browserForget: 'ds-bot:browser-forget',
  browserViewChanged: 'ds-bot:browser-view-changed', browserViewCreate: 'ds-bot:browser-view-create',
  browserViewSync: 'ds-bot:browser-view-sync', browserViewPlace: 'ds-bot:browser-view-place',
  browserViewNavigate: 'ds-bot:browser-view-navigate', browserViewCommand: 'ds-bot:browser-view-command',
  browserViewFocus: 'ds-bot:browser-view-focus', browserViewRead: 'ds-bot:browser-view-read',
  browserViewClose: 'ds-bot:browser-view-close', browserViewHold: 'ds-bot:browser-view-hold',
  browserImportSources: 'ds-bot:browser-import-sources', browserImportPick: 'ds-bot:browser-import-pick',
  browserImportLive: 'ds-bot:browser-import-live', browserImportApply: 'ds-bot:browser-import-apply',
  browserImportCancel: 'ds-bot:browser-import-cancel',
  appUpdateState: 'ds-bot:app-update-state', appUpdateCheck: 'ds-bot:app-update-check',
  appUpdateInstall: 'ds-bot:app-update-install', appUpdateOpen: 'ds-bot:app-update-open',
  appUpdateChanged: 'ds-bot:app-update-changed',
  idleSeconds: 'ds-bot:idle-seconds', computer: 'ds-bot:computer', computerAction: 'ds-bot:computer-action', computerCursor: 'ds-bot:computer-cursor',
}
// A cookie export larger than this is not a cookie export.
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const MOVE_PROBLEMS = { drive: 'dialog.move.drive', nested: 'dialog.move.nested', workspace: 'dialog.move.workspace', program: 'dialog.move.inProgram', notEmpty: 'dialog.move.notEmpty' }
// The same problems as the start page's 「这里放不了」 reasons (reason.place.*).
const MOVE_REASONS = { drive: 'drive', nested: 'nested', workspace: 'workspace', dsh: 'dsh', program: 'program', notEmpty: 'foreign' }
// A team window that does not say within this time that it shows a card cannot show one.
const CARD_SHOWN_MS = 2000
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000
// Under this, the start page notes the drive's free space for the first 10 s (onboarding §3).
const SHORT_DRIVE_BYTES = 5e9

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// The tray icon of this platform: Windows takes the .ico, macOS the template and its @2x,
// Linux the plain png.
const trayIconFile = () => join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
// Windows 11 draws Mica behind the page and macOS its sidebar vibrancy; material.css lets it
// through the sidebar.
const material = materialOf(process.platform, release())
configureIdentity(app)
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)
const frameFile = join(app.getPath('userData'), 'start-frame.json')

// Loaded once the start window is up (loadModules).
let BotBrowserGuests, partitionOf, BotViews, isBotId, importFromBrowser, listSources, applyCookies, CookieImports, parseCookieFile
let downloadSaver, chooseLocations, defaultPlaces, lang, pickerLabels, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx, HostProcess
let copySessions, findTeam, importTeam, restoreSessions, teamInUse, teamSizes, userDshHome, copyData, copyReason, moveProblem, BUNDLES, CHECK_PROFILE, PROFILE, ImportFlow
let watchReleases, watchUpdates, RELEASE_PAGE, getDshRuntimeVersion, electronUpdater

let mainWindow
// Settles once the hidden team window exists.
let mainCreated
let startWindow
let logs
// Writers to the console that bypass the log: the Host's output goes into the log on its own.
let rawOutput
let host
// The Host's loopback origin, which the window loads.
let origin
let port
let hostStop
let updates
let updatesStarted = false
let stopping = false
let stopped = false
let failed = false
let places
// Which of the places this start made, so that 「换个位置…」 can take them away again.
let made = { dataDir: false, workspace: false, root: false }
// A bundle of the app installed into the profile's own dependencies shadows the bundled copy
// for good (#1305). The card about it is asked once per run, however the start retries.
let shadowedAsked = false
// The folder picker of 「换个位置…」 is open, and the root it proposed on the 「会放在…」 card.
let picking = false
let proposed
// The folder a later start's move card asks about.
let moveTo
// Takes the answer of the card that askCard() put up, and that card's kind.
let answering
let asked
// The new version that the failure page's update banner offers.
let offered
// A retry or a start over is stopping the old engine: no second one starts meanwhile.
let restarting = false
// The team in the user's own DSH that the first run offers, until the import card has its
// answer, and the import that runs meanwhile (import-flow.mjs).
let importOffer
let importFlow
// Each boot of the engine; a retry starts a new one, and what an old one still reports is dropped.
let attempt = 0
// Aborted when the start begins again in another folder: the import card of the boot before goes.
let bootAbort = new AbortController()
// The Host answered and the window may talk to it without the launch URL.
let hostReady = false
// The Host's launch URL: the first window trades it for the Host's cookie.
let launchUrl
// The first load of the Host, which mints that cookie. It ends when the first load came
// through (true) or when it never did (false).
let bootstrap
// The launch URL is good for one use only: once a browser has carried it, no browser
// carries it again.
let tokenSpent = false
// The download handler of the app's session is bound once, not once per window.
let downloadsBound = false
// Quitting during the first run's import (its card or its copy) or a data move waits for it to
// stop at a safe point, so that it leaves no half team and no temporary copy.
let copying
const copyAbort = new AbortController()
let browserGuests
let botViews
let cookieImports
// The app's own folder and file picker, on the page of the window that asks (picker-host.mjs).
const pickers = new Pickers({ ipcMain, getPath: name => app.getPath(name) })

// The team window and the tray: closing the window hides it, the tray is the way back to it and
// the tray's Quit is the one ordinary way out. Until the hand-off the start window is the one
// showing, and the way back leads there.
const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => shellText(),
  trayImage: () => trayImage(),
  window: () => mainWindow,
  build: () => rebuildWindow(),
  reveal: (target) => {
    if (startWindow?.focus() || failed) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
  },
  quit: () => { app.quit() },
  // A tray entry's Stop (or Stop all) goes back to the page, which owns the actions.
  computer: (kind, botId) => { mainWindow?.webContents.send(IPC.computerAction, { kind, botId }) },
  busy: () => copying !== undefined,
  // Before the first run has chosen its places there is no window to show, and before the
  // first load of the Host there is no address to load.
  ready: () => places !== undefined && origin !== undefined && bootstrap !== undefined,
  // The one-time notice is a card in the team window; a page that cannot show it lets the window
  // go to the tray, which is what the notice would have said.
  // A second close while the card is up brings the window, and so the card, to the front.
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: options => boxInWindow(options, 0), focus: () => { toFront(mainWindow) } },
  // Without a tray the close asks whether the app should end; unasked, the window minimizes.
  fallback: { show: options => boxInWindow(options, options.cancelId) },
})
// The tray icon goes away with the app, and a late answer to the close notice hides nothing.
app.once('will-quit', () => { shell.dispose(); botViews?.dispose(); updates?.stop() })

// A packaged app started through an 8.3 short path or a junction restarts once on the
// canonical path: the lock below and every path the Host sees then agree with the long
// form, and the profile patch layer stops mixing the two.
const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  logs = new LogFile({ dir: join(app.getPath('userData'), 'logs') })
  rawOutput = captureStdio(logs)
  app.once('will-quit', () => { logs.flush() })
  console.log(`DS Bot ${app.getVersion()} (${process.platform} ${process.arch}), Electron ${process.versions.electron}`)
  startWindow = new StartWindow({
    electron: { BrowserWindow, ipcMain, screen, shell: electronShell, clipboard, nativeTheme, systemPreferences },
    // 〔保存日志…〕 on the start window's failure cards.
    saveAs: (win, name) => askPicker(win, { mode: 'save', title: tx('dialog.saveLog'), start: knownFolder('desktop'), name }),
    page: join(here, 'start', 'start.html'), preload: join(here, 'preload.cjs'), icon: iconFile, material, devTools: !app.isPackaged,
    css: readFileSync(join(here, 'page-card.css'), 'utf8'),
    // On Windows the locale is known only once the app is ready.
    lang: () => langOf(app.getLocale()), motion: readStartFrame(frameFile).motion,
    version: app.getVersion(), program: [dirname(process.execPath), process.resourcesPath, app.getAppPath()], log: logs, mainWindow: () => mainWindow,
    onRetry: () => { retry().catch(fail) },
    onReload: () => { mainWindow?.webContents.reload() },
    // Closing the start window before the hand-off quits: there is no team window yet to stay in
    // the tray with.
    onClose: () => { app.quit() },
    // 「换个位置…」: a first start picks the place again; a later start moves the data there.
    onPick: () => {
      // The question about a shadowing plugin copy has to be answered first.
      if (asked === 'shadowed') return
      // On the import card and the cards of its own picker, the import picks the place itself.
      if (answering !== undefined && ['import', 'importSpace', 'rejected', 'picked'].includes(asked)) { answering('pick'); return }
      (startWindow.kind === 'later' ? moveFromStart() : changePlace()).catch(fail)
    },
    onAnswer: (value) => {
      if (answering !== undefined) { answering(value); return }
      (startWindow.kind === 'later' ? moveAnswer(value) : placeAnswer(value)).catch(fail)
    },
    onUpdate: (name) => { updateAct(name) },
    onImport: (name, value) => { importFlow?.act(name, value) },
  })
  // A second launch shows the window that is showing: the start window until the hand-off
  // (also after a failed start), then the team window, built anew when it is gone.
  app.on('second-instance', () => { if (!startWindow.focus()) shell.open() })
  // An error that nothing caught would get Electron's own message box (start-window §7: nothing
  // native). Until the team window shows, the failure page says it; after that it is logged, and
  // the team goes on.
  process.on('uncaughtException', (error) => {
    if (startWindow.revealed) console.error(error)
    else void fail(error)
  })
  app.on('before-quit', (event) => {
    if (copying !== undefined) {
      // A copy is under way: it stops at a safe point, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    // The app is on its way out: the window may close for good.
    shell.beginQuit()
    if (stopped || host === undefined) return
    event.preventDefault()
    // The Host is already stopping: the quit follows it.
    if (stopping) { void (hostStop ?? Promise.resolve()).then(() => { app.quit() }); return }
    void stopHost().then(() => { app.quit() })
  })
  app.whenReady().then(async () => { shell.install(); await start() }).catch(fail)
}

function stopHost() {
  stopping = true
  hostStop ??= (host?.stop() ?? Promise.resolve()).catch((error) => { console.error(error) }).finally(() => { stopped = true })
  return hostStop
}

// A throwaway run (DS_BOT_HOME) asks nothing and shows what a later start shows.
const startKind = () => (process.env.DS_BOT_HOME || existsSync(join(app.getPath('userData'), 'locations.json')) ? 'later' : 'first')

async function start() {
  setMenu()
  nativeTheme.themeSource = readStartFrame(frameFile).themeSource
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  await prepare()
  run()
}

// What the boot needs; a retry after a failure here does what is still missing.
async function prepare() {
  // Before the windows: the team window's page is told the Host's origin.
  if (port === undefined) {
    port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
    origin = `http://127.0.0.1:${String(port)}`
  }
  startWindow.open(startKind())
  if (browserGuests === undefined) {
    await loadModules()
    handleIpc()
  }
  // The team window is made once the start window has painted, already on its final rect, and
  // made again when it is gone for good (a cancelled shutdown kept the app without one), so
  // that the next engine has a window to load into.
  if (mainCreated === undefined || (await mainCreated, mainWindow === undefined)) mainCreated = startWindow.painted.then(createWindow)
}

async function loadModules() {
  const [browser, views, sources, cookies, cookieFiles, downloads, firstRun, hostProcess, imports, flows, moves, profile, updatesModule, boot, updater] = await Promise.all([
    import('./bot-browser.mjs'), import('./bot-views.mjs'), import('./browser-sources.mjs'), import('./cookie-import.mjs'),
    import('./cookie-parse.mjs'), import('./downloads.mjs'), import('./first-run.mjs'), import('./host-process.mjs'),
    import('./import.mjs'), import('./import-flow.mjs'), import('./move-data.mjs'), import('./profile.mjs'), import('./updates.mjs'),
    import('@deepseek-ai/dsh-app-boot'), import('electron-updater'),
  ])
  ;({ BotBrowserGuests, partitionOf } = browser)
  ;({ BotViews, isBotId } = views)
  ;({ importFromBrowser, listSources } = sources)
  ;({ applyCookies, CookieImports } = cookies)
  ;({ parseCookieFile } = cookieFiles)
  ;({ downloadSaver } = downloads)
  ;({ chooseLocations, defaultPlaces, lang, pickerLabels, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx } = firstRun)
  ;({ HostProcess } = hostProcess)
  ;({ copySessions, findTeam, importTeam, restoreSessions, teamInUse, teamSizes, userDshHome } = imports)
  ;({ ImportFlow } = flows)
  ;({ copyData, copyReason, moveProblem } = moves)
  ;({ BUNDLES, CHECK_PROFILE, PROFILE } = profile)
  ;({ watchReleases, watchUpdates, RELEASE_PAGE } = updatesModule)
  ;({ getDshRuntimeVersion } = boot)
  electronUpdater = updater.default
  browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
  botViews = new BotViews({
    window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
    statePath: join(app.getPath('userData'), 'bot-views.json'),
    onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
  })
  cookieImports = new CookieImports()
}

function run() {
  bootAbort = new AbortController()
  const mine = (attempt += 1)
  boot(mine).catch((error) => { if (mine === attempt) void fail(error) })
}

// The engine starts again after a failure or the 180 s question; the places stay. A first run's
// copy goes on to its end first: an engine started beside it would run on a half-copied team.
async function retry() {
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    await copying?.catch(() => {})
    if (copyAbort.signal.aborted || stopping || mine !== attempt) return
    await stopOld()
    if (stopping || mine !== attempt) return
    await prepare()
  } finally {
    restarting = false
  }
  if (!stopping && mine === attempt) run()
}

// The handshake of the Host that goes: a window rebuilt before the next engine answers must not
// load against a Host that is stopped, nor take its cookie for the new one's.
function forgetHost() {
  hostReady = false
  bootstrap = undefined
}

// The Host stays known while it stops, so that a quit meanwhile waits for it.
async function stopOld(options) {
  const old = host
  if (old === undefined) return
  await old.stop(options).catch((error) => { console.error(error) })
  if (host === old) host = undefined
}

// The dialogs of the first run belong to the start window and stop its clock.
const ui = () => ({ owner: () => startWindow.owner(), asking: answer => startWindow.asking(answer), pick: request => askPicker(startWindow.owner(), request) })

/**
 * A card on the start page that waits for the user, in place of a message box: the value of the
 * button they click. 'settled' when `settle` comes first (what the card waited for happened by
 * itself); undefined when the card cannot show, the app quits, or the failure page takes its
 * place. The card stays up for the caller to replace or take away.
 * @param {{ kind: string }} card @param {{ signal?: AbortSignal, settle?: Promise<unknown> }} [options]
 * @returns {Promise<string | undefined>}
 */
function askCard(card, { signal, settle } = {}) {
  answering?.(undefined)
  return new Promise((resolve) => {
    const done = (value) => {
      if (answering !== done) return
      answering = undefined
      asked = undefined
      signal?.removeEventListener('abort', gone)
      resolve(value)
    }
    const gone = () => { done(undefined) }
    answering = done
    asked = card.kind
    if (signal?.aborted || !startWindow.card(card)) { gone(); return }
    signal?.addEventListener('abort', gone, { once: true })
    void settle?.then(() => { done('settled') }, gone)
  })
}

/** Resolves once `check` holds, looking every 2 s, or never once `signal` stops it. */
async function until(check, signal) {
  while (!signal.aborted && !check()) await sleep(2000, undefined, { signal }).catch(() => {})
  if (signal.aborted) await new Promise(() => {})
}

// The data folder (with the first run's question on a first start), the engine, then the team
// view in the hidden team window.
async function boot(mine) {
  if (places === undefined) {
    const first = startWindow.kind === 'first'
    if (first) {
      const teams = teamsAt()
      startWindow.explain(explainOf(teams))
      // A reinstall goes on with its data where it is; a new or copied team can still move.
      if (teams.team === undefined) tellPlace(defaultPlaces().dataDir)
    }
    const where = chooseLocations()
    setPlaces({ dataDir: where.dataDir, workspace: where.workspace })
    importOffer = where.offer
    if (first) startWindow.explain(explainOf({ offered: importOffer !== undefined, team: teamIn(where.dataDir) }))
    else tellLowSpace(where.freeAtStart)
  }
  // Also the check that the data folder can be written.
  mkdirSync(profileDir(), { recursive: true })
  startWindow.done('data')
  const engine = await startEngine(mine)
  if (engine === undefined || mine !== attempt) return
  startWindow.done('engine')
  await mainCreated
  if (mine !== attempt || mainWindow === undefined) return
  startWindow.teamLoading()
  // The launch URL trades its token for the Host's cookie and goes on to the page. The cookie
  // is there once that load came through. The token is good for one browser only: it is spent
  // as soon as a window carries it. Each engine has a token of its own.
  const win = mainWindow
  launchUrl = engine.url
  tokenSpent = true
  hostReady = false
  bootstrap = win.loadURL(engine.url).then(() => {
    if (mine === attempt) hostReady = true
    return true
  }).catch(() => false)
}

function setPlaces(next) {
  places = next
  const root = currentRootOf(places.dataDir, places.workspace)
  made = { dataDir: !existsSync(places.dataDir), workspace: places.workspace !== undefined && !existsSync(places.workspace), root: root !== undefined && !existsSync(root) }
}

// The line on the start page that says where the data goes and how much room is left, and the
// short drive's note for the first 10 s, both only on a short drive (start-window §2, §4).
function tellPlace(dataDir) {
  const free = freeSpace(dataDir)
  const drive = driveOf(dataDir)
  const short = drive !== undefined && free !== undefined && free < SHORT_DRIVE_BYTES
  // The page has no words while the start goes well: the line shows only when room runs short.
  startWindow.place(short ? placeOf(dataDir, { free, lang: lang() }) : undefined)
  startWindow.hint(short ? { drive, free: formatBytes(free, lang()) } : undefined)
}

// A later start shows the line again once the drive is down to a fifth of the free space it had
// when the data went there (start-window §5). Places saved before that was kept keep it from
// now on; a failed write costs only the line.
function tellLowSpace(freeAtStart) {
  if (process.env.DS_BOT_HOME) return
  if (freeAtStart === undefined) {
    try {
      saveLocations(places)
    } catch (error) {
      console.error(error)
    }
    return
  }
  const free = freeSpace(places.dataDir)
  if (runningLow(free, freeAtStart)) startWindow.place(placeOf(places.dataDir, { free, lang: lang() }))
}

// 「换个位置…」 on the start page and 〔重新选〕 on its cards: the system picker, then the root rule
// (windows-onboarding §3, 一个位置). The root is used at once when it is the folder picked; a
// layer the app added is confirmed on the 「会放在…」 card; a place that cannot be used says why.
// A cancelled picker leaves things as they were: the line, or the card it came from. Not during
// the first run's copy, whose team would be left behind.
async function changePlace() {
  if (startWindow.kind !== 'first' || places === undefined || copying !== undefined || picking || restarting || stopping || failed) return
  picking = true
  try {
    // One wait for the picker and what follows it: a team view that becomes ready meanwhile
    // hands over only once the start knows where it goes on.
    await startWindow.asking(pickAndPlace())
  } finally {
    picking = false
  }
}

// A cancelled picker, or the place the data is in now, is no change: the line stays, and a card
// that led here goes, since the start goes on where it was.
async function pickAndPlace() {
  const picked = await pickRoot(pickFrom(places.dataDir), copyAbort.signal, ui())
  if (stopping || startWindow.owner() === undefined) return
  const root = picked === undefined ? { same: true } : rootOf(picked, { dshHome: userDshHome(), program: app.isPackaged ? programFolder() : undefined, current: places })
  if (root.same) {
    proposed = undefined
    startWindow.card(undefined)
    return
  }
  if (root.reason !== undefined) {
    console.log(`DS Bot: the place ${root.at} cannot be used (${root.reason})`)
    proposed = undefined
    startWindow.card({ kind: 'rejected', reason: root.reason, path: root.at })
    return
  }
  if (root.added) {
    proposed = root
    startWindow.card({ kind: 'picked', path: root.root })
    return
  }
  await startOver(root)
}

async function placeAnswer(value) {
  if (value !== 'use' || proposed === undefined || picking || restarting) return
  const root = proposed
  proposed = undefined
  await startOver(root)
}

// The start begins again in the root R (start-window §7): the whale sinks at once, the engine
// that may be up on the default folder stops, what this start made there goes, and the boot runs
// again. The places are saved at once: the import question has been answered by now.
async function startOver(root) {
  bootAbort.abort()
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    // restart() also takes the card away, without letting a held hand-off of the old engine go;
    // the line names the new place from here on. The Host on the old folder is ended at once:
    // neither its boot nor an orderly shutdown of a folder about to go is of any use, and either
    // would keep the whale under water for up to 10 s.
    startWindow.restart()
    tellPlace(root.dataDir)
    await stopOld({ now: true })
    if (stopping || mine !== attempt) return
    await removeMade()
    if (stopping || mine !== attempt) return
    setPlaces({ dataDir: root.dataDir, workspace: root.workspace })
    saveLocations(places)
    console.log(`DS Bot: the data goes to ${places.dataDir}`)
  } finally {
    restarting = false
  }
  run()
}

// What this start made at the place it leaves: the data folder it created (the engine may have
// put a blank team there), the team workspace while nothing has been written into it, and the
// root above them once it is empty.
async function removeMade() {
  const gone = []
  if (made.dataDir && existsSync(places.dataDir)) gone.push(places.dataDir)
  if (made.workspace && existsSync(places.workspace) && isEmptyTree(places.workspace)) gone.push(places.workspace)
  for (const folder of gone) await rm(folder, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  const root = currentRootOf(places.dataDir, places.workspace)
  if (made.root && root !== undefined && existsSync(root) && isEmptyTree(root)) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
}

const profileDir = () => join(places.dataDir, 'profiles', PROFILE)
const pnpmEntry = () => join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const runtimeDir = () => app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime')
const hostOutput = (stream, chunk) => {
  logs.write('engine', chunk)
  rawOutput[stream](chunk)
}

function newHost() {
  // A Host of an attempt that a retry has replaced no longer stands for the start.
  const mine = attempt
  return new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir(),
    env: { ...process.env, DSH_HOME: places.dataDir, DS_BOT_PORT: String(port), DS_BOT_APP: '1', DS_BOT_USER_DSH_HOME: userDshHome(), DS_BOT_RUNTIME_DIR: runtimeDir(), ...(app.isPackaged && process.platform === 'darwin' ? { DS_BOT_COMPUTER_HELPER_HOME: join(app.getPath('userData'), 'computer-use') } : {}), ...(places.workspace ? { DS_BOT_WORKSPACE: places.workspace } : {}) },
    pnpm: pnpmEntry(),
    onFailure: (error) => { if (mine === attempt) void fail(error) },
    output: hostOutput,
  })
}

// A failed check is not a failed start: start() rejects, and the copy goes on unchecked.
function newCheck(home, list) {
  const cwd = join(home, 'profiles', CHECK_PROFILE)
  mkdirSync(cwd, { recursive: true })
  return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list, DS_BOT_RUNTIME_DIR: runtimeDir() }, pnpm: pnpmEntry(), onFailure: () => {}, output: hostOutput })
}

/**
 * @returns {Promise<{ url: string } | undefined>} the Host's launch URL; none when the app quits
 *   during the copy, or when a retry during the copy starts the engine itself
 */
async function startEngine(mine) {
  let warm
  if (importOffer !== undefined) {
    const imported = await importStep(mine)
    if (imported === undefined || mine !== attempt) return undefined
    warm = imported.warm
  }
  // Not during the import, which a restart would cut short; before the Host, so that an
  // update can still come when this version's Host does not start.
  if (!updatesStarted) {
    updatesStarted = true
    updates = startUpdates()
    updates?.subscribe((state) => { mainWindow?.webContents.send(IPC.appUpdateChanged, state) })

  }
  // Before a new Host, which reads the Sessions; the engine warmed on an import that was not
  // taken has nothing left out.
  if (warm === undefined) {
    await restoreSessions(places.dataDir).then(({ copied, newer }) => {
      if (copied.length > 0) console.log(`DS Bot: copied ${copied.join(', ')}, which the import left out`)
      if (newer.length > 0) console.warn(`DS Bot: this DSH cannot read ${newer.join(', ')}, which the import left out`)
    }, (error) => { console.error('DS Bot: the Sessions the import left out were not copied:', error) })
  }
  if (!shadowedAsked) {
    const { shadowedBundles, removeShadowed } = await import('./profile-shadow.mjs')
    const shadowed = shadowedBundles(profileDir(), BUNDLES)
    if (shadowed.length > 0 && mine === attempt) {
      const names = shadowed.map(({ name, version }) => `${name} ${version}`).join(', ')
      console.warn(`DS Bot: the profile carries its own ${names}, which shadows the bundled copy`)
      if (await askCard({ kind: 'shadowed', names }) === 'remove' && mine === attempt) {
        // A failed removal stops the start with the reason, and the next try asks again.
        await removeShadowed(profileDir(), shadowed.map(entry => entry.name)).catch((error) => {
          throw new Error(`Could not remove ${names} from the profile: ${error?.message ?? error}`, { cause: error })
        })
      }
    }
    shadowedAsked = true
  }
  host = warm?.host ?? newHost()
  host.onMessage(message => {
    if (message?.type !== 'ds-bot:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
    const downloadRoots = message.downloadRoots
    if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
      return
    }
    void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, url })
    }).catch(() => host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
  })
  const engine = await (warm?.up ?? host.start())
  // The copying card stays on 「启动团队」 until the engine of the copied team is up.
  if (mine === attempt) startWindow.card(undefined)
  return engine
}

// The import card while the engine warms up on the new data location (windows-onboarding §4,
// start-window §6). The places are saved once the card has its answer. Undefined when this start
// gives way (a quit, another place, the failure page); else the engine that warmed up, when the
// start goes on with it: 〔先不复制〕 takes it as it is, without a restart.
async function importStep(mine) {
  const offer = importOffer
  const where = { ...places }
  const signal = AbortSignal.any([copyAbort.signal, bootAbort.signal])
  const warm = newHost()
  host = warm
  let warmStopped = false
  const up = warm.start()
  // The engine's arc fills once it is up and the import's has filled; the team's waits for the answer.
  up.then(() => { if (mine === attempt && !warmStopped) startWindow.done('engine') }, () => {})
  const sizes = await teamSizes(offer.from, offer.team).catch((error) => { console.error(error); return { sessions: 0 } })
  let result
  for (;;) {
    if (signal.aborted || mine !== attempt) return undefined
    const flow = new ImportFlow({
      offer: { from: offer.from, bots: offer.bots, rooms: offer.rooms, names: botNames(offer.team), sessions: sizes.sessions, sizes, profiles: offer.profiles },
      ask: (card, options) => askCard(card, { signal, ...options }),
      show: (card) => { startWindow.card(card) },
      room: () => ({ free: freeSpace(where.dataDir), drive: driveOf(where.dataDir) }),
      inUse: () => teamInUse(offer.from),
      until,
      check: (checkSignal, onProgress) => checkTeam(where, checkSignal, onProgress),
      // The copy goes into the data location that the engine has started on once, and with the
      // engine stopped.
      warmed: async () => {
        await up
        warmStopped = true
        await warm.stop()
        if (host === warm) host = undefined
        if (mine === attempt) startWindow.engineDown()
      },
      copy: options => importTeam({ from: offer.from, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), ...options }),
      reasonOf: copyReason,
      progress: setProgress,
      lang: lang(),
      signal,
    })
    importFlow = flow
    // The card's and the copy's time is not the engine's: the start's clock stands still, and
    // the 180 s question with it.
    copying = startWindow.asking(flow.run())
    try {
      result = await copying
    } finally {
      copying = undefined
      importFlow = undefined
    }
    if (result.outcome !== 'pick') break
    if (await importElsewhere(signal)) return undefined
  }
  if (result.outcome === 'gone' || signal.aborted || mine !== attempt) return undefined
  importOffer = undefined
  saveLocations(where)
  if (result.outcome === 'copied') {
    startWindow.done('import')
    const { summary } = result
    console.log(`DS Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
    // The team lives here now; moving it is Settings' job (the data move).
    startWindow.place(undefined)
    return {}
  }
  startWindow.card(undefined)
  return { warm: warmStopped ? undefined : { host: warm, up } }
}

const botNames = team => Object.values(team.bots ?? {}).map(bot => bot?.name).filter(name => typeof name === 'string' && name !== '')

// 〔选择其他位置…〕 on the import's space card, or 「换个位置…」 while the import card is up: the
// picker and the root rule as for 「换个位置…」 (changePlace), asked on cards that this import
// waits for. True once the start begins again in the new root; false to go back to the import
// card.
async function importElsewhere(signal) {
  for (;;) {
    const picked = await pickRoot(pickFrom(places.dataDir), signal, ui())
    if (signal.aborted || picked === undefined) return false
    const root = rootOf(picked, { dshHome: userDshHome(), program: app.isPackaged ? programFolder() : undefined, current: places })
    if (root.same) return false
    if (root.reason !== undefined) {
      console.log(`DS Bot: the place ${root.at} cannot be used (${root.reason})`)
      if (await askCard({ kind: 'rejected', reason: root.reason, path: root.at }, { signal }) === 'pick') continue
      return false
    }
    if (root.added) {
      const answer = await askCard({ kind: 'picked', path: root.root }, { signal })
      if (answer === 'pick') continue
      if (answer !== 'use') return false
    }
    await startOver(root)
    return true
  }
}

function handleIpc() {

  // A throwaway run (DS_BOT_HOME) keeps its folders where it was told.
  const fixed = Boolean(process.env.DS_BOT_HOME)
  // The team view has mounted (ds-bot calls dsBotApp.ready()): the start window hands over.
  const computerIndicator = createComputerIndicator({
    BrowserWindow, screen, html: indicatorHtml, ipcMain,
    preload: join(here, 'computer-indicator-preload.cjs'),
    onAction: (kind, botId) => { mainWindow?.webContents.send(IPC.computerAction, { kind, botId }) },
    log: logs,
  })
  ipcMain.on(IPC.computer, (event, entries) => {
    if (!fromWindow(event)) return
    const list = Array.isArray(entries?.rows) ? entries.rows.filter(entry => entry && typeof entry.label === 'string').slice(0, 12) : []
    const labels = entries?.labels ?? {}
    computerIndicator.update({ rows: list, labels })
    shell.setComputer(list)
  })
  ipcMain.handle(IPC.idleSeconds, (event) => (fromWindow(event) ? powerMonitor.getSystemIdleTime() : 0))
  const computerCursor = createComputerCursor({ BrowserWindow, screen, platform: process.platform, log: logs })
  ipcMain.on(IPC.computerCursor, (event, entry) => {
    if (!fromWindow(event)) return
    void computerCursor.update(entry)
  })
  app.on('before-quit', () => { computerIndicator.dispose(); computerCursor.dispose() })
  ipcMain.on(IPC.ready, (event, report) => { if (fromWindow(event)) startWindow.ready(report) })
  // It has drawn the whale the start window hands over: the windows cross-fade.
  ipcMain.on(IPC.handoffReady, (event) => { if (fromWindow(event)) startWindow.teamReady() })
  ipcMain.on(IPC.cardShown, (event, id) => { if (fromWindow(event)) cards.get(id)?.shown() })
  ipcMain.on(IPC.cardAnswer, (event, id, index) => { if (fromWindow(event)) cards.get(id)?.settle(Number.isInteger(index) ? index : -1) })
  // The start window takes the app's theme and the Bot animation tier at the next start, before
  // the team view has loaded; Mica and the caption buttons follow the theme at once.
  ipcMain.on(IPC.nativeTheme, (event, source) => {
    const value = nativeThemeSource(source)
    if (!fromWindow(event) || value === undefined) return
    nativeTheme.themeSource = value
    writeStartFrame(frameFile, { themeSource: value })
  })
  ipcMain.on(IPC.motion, (event, tier) => { if (fromWindow(event)) writeStartFrame(frameFile, { motion: tier }) })
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  // ds-bot's Bot browsers: one webview per lease, in the storage of the Bot's key.
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  // Cookie imports: a file or an installed browser's profile is parsed or harvested into a
  // pending set first; only apply (the user's confirm) writes into the Bot's partition.
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    // Any file: a cookie export can have any name, and the parser says what it is.
    const picked = await askPicker(mainWindow, { mode: 'file', title: tx('dialog.pickCookies'), start: knownFolder('downloads') })
    if (picked === undefined) return { canceled: true }
    const buffer = await readFile(picked)
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(picked) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('DS Bot: an unknown browser profile')
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error('DS Bot: a Bot storage key is required')
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error('DS Bot: this import is no longer pending')
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  // The app's own update state, for the About row. `updates` exists once the engine's first
  // start created it; before that (and in runs without an updater) the state is null.
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await updates.install()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
    const state = updates?.state()
    if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
      void electronShell.openExternal(state.page)
    }
  })
  // The plugin keeps the team workspace; the app remembers it for its own checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
  })
  if (process.platform === 'win32') {
    // Windows ignores the alpha of the caption buttons' color, so they take the opaque color
    // of the surface under them, which the page measures.
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }
}

// The window that a dialog belongs to: the start window while it shows, then the team window.
const owner = () => startWindow.owner() ?? mainWindow
const setProgress = (value) => { owner()?.setProgressBar(value) }

// Before the copy, the app's own DSH reads every chat of the team once, in a DSH home of its own
// so that nothing of the check stays in the data: a newer DSH can write records that this one
// refuses while the log format stays the same. The number of chats it cannot read; a check that
// fails lets the copy go on unchecked. `onProgress` counts the chats copied for it.
async function checkTeam(where, signal, onProgress) {
  // A run that was killed can leave its temporary check home behind.
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(importOffer?.from ?? userDshHome())
    const ids = found === undefined ? [] : await copySessions(found.from, found.team, home, signal, onProgress)
    if (ids.length === 0) return 0
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(ids))
    const check = newCheck(home, list)
    const stop = () => { void check.stop() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const { unreadable } = await check.start()
      if (unreadable.length > 0) console.warn(`DS Bot: this DSH cannot read ${unreadable.join(', ')}`)
      return unreadable.length
    } finally {
      signal.removeEventListener('abort', stop)
      await check.stop()
    }
  } catch (error) {
    if (!signal.aborted) console.error('DS Bot: the chats were not checked before the copy:', error)
    return 0
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (copying !== undefined || stopping || mainWindow === undefined) return false
  const to = await askMove(workspace)
  if (to === undefined) return false
  await runMove(to, workspace)
  return true
}

// 〔换个位置…〕 on a later start's place line (start-window §5): the same move, asked on the start
// page's cards instead of message boxes. Only the folder picker is a system window; while it or
// a card is open, the clock stands still and the hand-off waits.
async function moveFromStart() {
  if (startWindow.kind !== 'later' || places === undefined || copying !== undefined || picking || restarting || stopping || failed) return
  picking = true
  try {
    await startWindow.asking(pickMove())
  } finally {
    picking = false
  }
}

// 「这里放不了」 with the reason, or 「搬到这个文件夹？」. A cancelled picker is no change: the card
// that led here goes, and the start goes on.
async function pickMove() {
  const picked = await askPicker(owner(), { mode: 'folder', title: tx('dialog.pickMove'), start: dirname(places.dataDir) })
  if (stopping || startWindow.owner() === undefined) return
  moveTo = undefined
  if (picked === undefined) {
    startWindow.card(undefined)
    return
  }
  moveCard(resolve(picked))
}

function moveCard(to) {
  const reason = moveReason(to)
  if (reason !== undefined) {
    console.log(`DS Bot: the data cannot move to ${to} (${reason})`)
    startWindow.card({ kind: 'rejected', reason, path: to })
    return
  }
  moveTo = to
  startWindow.card({ kind: 'move', path: to, dataDir: places.dataDir })
}

// A folder the checks cannot read counts as one without permission, as on a first start.
function moveReason(to, workspace = places.workspace) {
  try {
    const problem = moveProblemOf(to, workspace)
    return problem === undefined ? undefined : MOVE_REASONS[problem]
  } catch (error) {
    console.error(error)
    return 'permission'
  }
}

// 〔移动并重启〕 checks the folder again (the team workspace can move while the card is open);
// then the start window becomes the move's before a hand-off that waited can go, and the boot it
// showed gives way. 〔取消〕 goes back to the start.
async function moveAnswer(value) {
  if (startWindow.kind !== 'later' || moveTo === undefined || picking || copying !== undefined || stopping || failed) return
  const to = moveTo
  moveTo = undefined
  if (value !== 'move') {
    startWindow.card(undefined)
    return
  }
  if (moveReason(to) !== undefined) {
    moveCard(to)
    return
  }
  attempt += 1
  forgetHost()
  startWindow.moving()
  await runMove(to, places.workspace)
}

// The folder picker, the checks and the question of a move from Settings: the folder, or none.
// The picker, the question and a refusal are all on the team window's page.
async function askMove(workspace) {
  const picked = await askPicker(owner(), { mode: 'folder', title: tx('dialog.pickMove'), start: dirname(places.dataDir) })
  if (picked === undefined) return undefined
  const to = resolve(picked)
  if (await moveRefused(to, workspace)) return undefined
  const answer = await askInWindow({ message: tx('dialog.move.confirm', { to }), detail: tx('dialog.move.detail', { from: places.dataDir }), buttons: [{ label: tx('btn.move'), primary: true }, { label: tx('btn.cancel') }], cancel: 1 })
  if (answer !== 0 || stopping || await moveRefused(to, workspace)) return undefined
  return to
}

// The team workspace can move while a dialog is open; the window tells the latest one.
function moveProblemOf(to, workspace) {
  const dshHome = userDshHome()
  for (const current of new Set([workspace, places.workspace])) {
    const problem = moveProblem({ from: places.dataDir, to, workspace: current, dshHome, program: app.isPackaged ? programFolder() : undefined })
    if (problem !== undefined) return problem
  }
  return undefined
}

async function moveRefused(to, workspace) {
  const problem = moveProblemOf(to, workspace)
  if (problem === undefined) return false
  await askInWindow({ message: problem === 'dsh' ? tx('dialog.move.inDsh', { home: userDshHome() }) : tx(MOVE_PROBLEMS[problem]), buttons: [{ label: tx('btn.ok'), primary: true }], cancel: 0 })
  return true
}

// The move itself, on the start window's moving page. What keeps it from going through is said on
// a card there, 「没有搬成」, and the app starts again on the old folder: a folder that cannot be
// used after all, another DSH on the data (the move goes on by itself once it is closed), a copy
// that failed (〔重试〕 copies again). Quitting meanwhile stops it without a new start.
async function runMove(to, workspace) {
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the team workspace from here on; the
    // start window shows the move meanwhile.
    void mainWindow?.loadURL('about:blank').catch(() => {})
    mainWindow?.hide()
    startWindow.open('moving')
    await stopHost()
    const from = places.dataDir
    const stay = { kind: 'moveFailed', dataDir: from }
    // The app may have heard of a team workspace change while the Host stopped.
    const reason = moveReason(to, workspace)
    if (reason !== undefined) {
      await askCard({ ...stay, why: 'place', place: reason, path: to }, { signal })
      if (!signal.aborted) app.relaunch()
      return
    }
    // Another DSH on the same data would go on writing while the copy is made.
    if (teamInUse(from)) {
      const free = new AbortController()
      const answer = await askCard({ ...stay, why: 'inUse' }, { signal, settle: until(() => !teamInUse(from), free.signal) })
      free.abort()
      if (answer !== 'settled') {
        if (!signal.aborted) app.relaunch()
        return
      }
      startWindow.card(undefined)
    }
    for (;;) {
      setProgress(2)
      try {
        await copyData(from, to, signal)
        try {
          saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
        } catch (error) {
          // Unused, the copy would only keep the folder from being chosen again.
          await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
          throw error
        }
        break
      } catch (error) {
        if (signal.aborted) return
        console.error(error)
        setProgress(-1)
        const message = error instanceof Error ? error.message : String(error)
        const answer = await askCard({ ...stay, why: 'copy', reason: copyReason(error), log: message.split('\n') }, { signal })
        if (signal.aborted) return
        if (answer !== 'retry') break
        startWindow.card(undefined)
      } finally {
        setProgress(-1)
      }
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
}

// Windows and a Linux AppImage update themselves; macOS and a Linux deb ask to download the new
// version. Throwaway runs check only a given feed and never ask.
function startUpdates() {
  const feed = process.env.DS_BOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
      asset: version => `DS-Bot-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    // The update ends the app: the window closes for good, and the Host stops before the
    // installer replaces its files.
    return watchUpdates({
      updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : (version) => restartPrompt.prompt(version),
      beforeInstall: () => { shell.beginQuit(); return stopHost() },
    })
  }
  return undefined
}

// A prompt that belongs to a window is not asked while the window is hidden or minimized: it
// waits for the window to be on the screen again.
function windowShown() {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}

// The update questions wait for the team window: the start window goes at the hand-off, and a
// question on it would go with it. After a failed start, fail() takes the update over.
const afterHandoff = async () => { await startWindow.teamShown; return !failed }

// An update question that the page cannot show counts as 「以后再说」: the update installs at the
// next quit, and the About row still offers it.
async function askRestartNow(version) {
  if (failed || !await afterHandoff()) return false
  return await askInWindow({ message: tx('dialog.update.ready', { version }), detail: tx('dialog.update.readyDetail'), buttons: [{ label: tx('btn.restart'), primary: true }, { label: tx('btn.notNowRestart') }], cancel: 1 }) === 0
}

async function askDownloadNow(version) {
  if (failed || !await afterHandoff()) return false
  return await askInWindow({ message: tx('dialog.update.available', { version }), detail: tx('dialog.update.availableDetail'), buttons: [{ label: tx('btn.download'), primary: true }, { label: tx('btn.notNowDownload') }], cancel: 1 }) === 0
}

// The cards that the team window shows, by id, until they have their answer.
const cards = new Map()
let cardCount = 0
// Pickers open on the team window; the Bot browser views wait until the last one goes.
let pickerCount = 0

/**
 * A question of the app in the team window, on a card over its page instead of a message box
 * (preload.cjs showCard, page-card.css): the index of the button the user clicks, -1 when a newer
 * card took its place, undefined when the page cannot show it (not loaded, gone, or silent for
 * CARD_SHOWN_MS) or goes away before the answer.
 * `front` brings the window to the front first: a close waits on the answer, so its card must
 * be where the user looks.
 * @param {{ message: string, detail?: string, buttons: { label: string, primary?: boolean }[], cancel?: number }} card
 * @param {{ front?: boolean }} [how]
 * @returns {Promise<number | undefined>}
 */
function askInWindow(card, { front = false } = {}) {
  const win = mainWindow
  const contents = win?.webContents
  if (win === undefined || win.isDestroyed() || contents.isLoading() || !contents.getURL().startsWith(`${origin}/`)) return Promise.resolve(undefined)
  if (front) toFront(win)
  const id = (cardCount += 1)
  return new Promise((resolve) => {
    let seen = false
    const settle = (value) => {
      if (!cards.has(id)) return
      cards.delete(id)
      clearTimeout(timer)
      contents.off('did-start-loading', away)
      contents.off('destroyed', away)
      if (cards.size === 0 && pickerCount === 0) botViews?.cover(false)
      resolve(value)
    }
    const away = () => { settle(undefined) }
    const timer = setTimeout(() => { if (!seen) away() }, CARD_SHOWN_MS)
    cards.set(id, { settle, shown: () => { seen = true } })
    // The Bot browser views are drawn above the page and would cover the card.
    botViews?.cover(true)
    contents.once('did-start-loading', away)
    contents.once('destroyed', away)
    contents.send(IPC.card, { id, ...card })
  })
}

// The shell's message-box questions (the tray notice, the close without a tray) on the team
// window's card; `unasked` is the answer when the page cannot show it.
async function boxInWindow(options, unasked) {
  const buttons = options.buttons.map((label, index) => ({ label, primary: index === options.defaultId }))
  const cancel = options.cancelId >= 0 ? options.cancelId : undefined
  const answer = await askInWindow({ message: options.message, detail: options.detail, buttons, cancel }, { front: true })
  return answer === undefined ? { response: unasked, unasked: true } : { response: answer }
}

/**
 * The app's own picker on `win`'s page: the chosen path, null when the user cancels, undefined
 * when the page cannot show it. The Bot browser views are drawn above the page and would cover
 * it, so they wait, as for a card.
 * @param {any} win
 * @param {{ mode: 'folder' | 'file' | 'save', title: string, start?: string, name?: string }} request
 * @returns {Promise<string | null | undefined>}
 */
async function pickOn(win, request) {
  if (win === undefined || win === null || win.isDestroyed()) return undefined
  const covers = win === mainWindow
  if (covers) { pickerCount += 1; botViews?.cover(true) }
  try {
    return await pickers.ask(win.webContents, { ...request, labels: pickerLabels() })
  } finally {
    if (covers && (pickerCount -= 1) === 0 && cards.size === 0) botViews?.cover(false)
  }
}

// app.getPath throws for a known folder that does not resolve; the picker then starts at home.
function knownFolder(name) {
  try { return app.getPath(name) } catch { return undefined }
}

/** The picker's path, or undefined when it was cancelled or could not be shown. */
const askPicker = async (win, request) => (await pickOn(win, request)) ?? undefined

function toFront(win) {
  if (win === undefined || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// What the updater does when the user says yes. The answer may come later, when the window
// is shown again; then the work is done here.
async function installUpdate() { await updates?.install() }

async function openUpdatePage() {
  const state = updates?.state()
  if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
    await electronShell.openExternal(state.page)
  }
}

const restartPrompt = createDeferredPrompt({ ask: askRestartNow, shown: windowShown, onYes: installUpdate })
const downloadPrompt = createDeferredPrompt({ ask: askDownloadNow, shown: windowShown, onYes: openUpdatePage })

async function flushDeferredUpdate() {
  await restartPrompt.flush()
  await downloadPrompt.flush()
}

// Hidden, on the rect the start window grows into; the start window shows it at the hand-off.
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const frameless = framelessOn(process.platform)
  const sidebarFill = () => (nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb')
  const win = new BrowserWindow({
    // The window never squeezes the chat: RAIL_WIDTH + MIN_CHAT from ds-bot's
    // src/client/frame-layout.js is the avatar rail plus the smallest chat column.
    ...startWindow.mainBounds(), minWidth: 508, minHeight: 480,
    title: 'DS Bot', show: false, icon: iconFile,
    backgroundColor: material ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the window controls overlay the page's band. On Windows the
    // caption buttons keep the sidebar's colors until the page sends the colors of the surface
    // under them.
    ...frameOptions(process.platform, material, { color: sidebarFill(), symbolColor: dark ? '#f9fafb' : '#0f1115' }),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-bot-origin=${origin}`, ...(frameless ? [`--ds-bot-caption=${String(CAPTION_HEIGHT)}`, ...(material ? [`--ds-bot-material=${material}`] : [])] : [])],
    },
  })
  if (material === 'vibrancy') keepVibrancy(win, sidebarFill)
  mainWindow = win
  startWindow.placeMain(win)
  // No ready-to-show here: the first window shows at the hand-off (start-window.mjs), a window
  // built anew when the shell opens it.
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = undefined
    // The Bot browsers' tabs belonged to this window; they wait for the next one.
    botViews.release()
  })
  // The window hides instead of closing; the shell decides when it really goes.
  shell.watch(win)
  browserGuests.bind(win)
  // The tabs that outlived the last window join this one.
  botViews.attach(win)
  const contents = win.webContents
  // The session is the same for every window of the app, so the handler is bound once.
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({
      window: () => mainWindow,
      ask: (name, folder) => pickOn(mainWindow, { mode: 'save', title: tx('dialog.saveAs'), start: folder, name }),
      staging: () => join(app.getPath('userData'), 'downloading'),
      getPath: name => app.getPath(name),
    }))
  }
  if (frameless) {
    // Fullscreen hides the window controls, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  for (const [on, file] of [[material !== undefined, 'material.css'], [process.platform === 'darwin', 'macos.css']]) {
    if (!on) continue
    const css = readFileSync(join(here, file), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(fonts) })
  const card = readFileSync(join(here, 'page-card.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(card) })
  contents.setWindowOpenHandler(({ url }) => {
    // DSH's sign-in opens a blank window during the click and sends it to the sign-in page later.
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  // The window that is shown again asks for the update that waited for it. A window that was
  // minimized asks for it when it comes back.
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  return win
}

// The window is gone for good: a new one takes its place and talks to the Host that runs.
function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch((error) => { console.error(error) })
  return win
}

// The window talks to the Host that runs. The first one trades the launch URL for the Host's
// cookie; the later ones use the plain address, which that cookie carries. The launch URL is
// used again only when no browser carried it at all, so that a token is never spent twice.
async function connectHost(win) {
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load of the Host decides how this window comes in.
  if (bootstrap !== undefined) await bootstrap
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load never came through. The cookie may be there anyway: it belongs to the
  // session of the browser, which outlives the window.
  if (await hostCookie()) {
    hostReady = true
    await win.loadURL(`${origin}/`)
    return
  }
  // There is no cookie: the launch URL is the one way in, and only while it was not used.
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    await win.loadURL(launchUrl)
    hostReady = true
    return
  }
  await win.loadURL(`${origin}/`)
}

// The Host's cookie: the launch URL trades its token for it. The app does not need to know
// its name, only whether the browser holds one for the Host's address.
async function hostCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${origin}/` })
    return cookies.length > 0
  } catch (error) {
    console.error(error)
    return false
  }
}

// The mark of the tray: the file of this platform, and on macOS the template that follows the
// colour of the menu bar.
function trayImage() {
  const file = trayIconFile()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
  if (process.platform === 'darwin') {
    const retina = nativeImage.createFromPath(join(assets, 'trayTemplate@2x.png'))
    const size = retina.getSize()
    if (!retina.isEmpty() && size.width > image.getSize().width) {
      image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG(), width: size.width, height: size.height })
    }
    image.setTemplateImage(true)
  }
  return image
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const t = shellText()
  // The application menu of macOS, without its Quit: the tray's Quit is the one ordinary way
  // out. Only when the tray is not there does the menu carry one, so that the app can still
  // be ended.
  const items = [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
  ]
  if (!shell.hasTray()) {
    items.push({ type: 'separator' }, { label: t.quit, click: () => { shell.quit() } })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: items },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
}

// The tray's and the menu's copy, in the app's language. On Windows the locale is known only once
// the app is ready.
function shellText() {
  return SHELL_TEXT[langOf(app.getLocale())]
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error('DS Bot: rejected IPC from an unknown page')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void electronShell.openExternal(url)
}

// The start window shows the failure page and stays. A new version may fix what keeps this one
// from starting: the page's update banner offers it.
async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const mine = attempt
  startWindow.fail(error, startKind())
  // The failure page takes the place of a card that waited.
  answering?.(undefined)
  await offerUpdate(mine).catch((failure) => { console.error(failure) })
}

// The update banner of the failure page (start-window §7): 〔下载〕 opens the release page of a
// version that cannot install itself (macOS, a Linux deb); one that can is downloading already,
// and installs once it is downloaded, unless the user has tried again meanwhile.
async function offerUpdate(mine) {
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  const still = () => failed && mine === attempt
  offered = found ?? undefined
  if (!found || !still()) return
  const { version } = found
  if (found.page) { startWindow.update({ state: 'available', version, page: true }); return }
  const progress = (state) => {
    if (still() && state.phase === 'downloading') startWindow.update({ state: 'downloading', version, percent: state.percent ?? 0, received: state.received ?? 0, total: state.total ?? 0 })
  }
  progress(updates.state())
  const unsubscribe = updates.subscribe(progress)
  const downloaded = await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS, undefined, { ref: false }).then(() => false)]).finally(unsubscribe)
  if (!still()) return
  if (!downloaded) { startWindow.update({ state: 'failed', version }); return }
  startWindow.update({ state: 'installing', version })
  await updates.install()
}

// The banner's buttons: 〔下载〕 and 「手动下载」 open the release page; 〔重试〕 after a failed
// download checks again.
function updateAct(name) {
  if (!failed) return
  if (name === 'manualDownload' || offered?.page) {
    const page = offered?.page ?? RELEASE_PAGE
    if (!process.env.DS_BOT_HOME) void electronShell.openExternal(page)
    return
  }
  if (updates === undefined || updates.state().phase !== 'failed') return
  updates.check()
  void offerUpdate(attempt).catch((error) => { console.error(error) })
}
