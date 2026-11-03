import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readStartFrame, writeStartFrame } from '../src/start-frame.mjs'
import {
  acceptsAct, centred, clampInto, clockMs, cubicBezier, detailsText, explainOf, failureReason, fallbackMs, CROSSFADE, handoffBox, HOLD_MS, TEAM_HANDOFF, TEAM_WAIT_MS,
  isStartPage, landingOf, MAIN_SIZE, mainRect, OPEN_MS, PAINT_WAIT_MS, START_ACT, START_ACTS, START_STATE, startSize, startSnapshot, startUrl, StartWindow,
  TEAM_VIEW_MS, WATCHDOG_MS,
} from '../src/start-window.mjs'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

test('the start window is 720 × 540, and 720 × 500 on a work area under 588 high', () => {
  assert.deepEqual(startSize(AREA), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 588 }), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 587 }), { width: 720, height: 500 })
})

test('the start window is centred on the work area under the cursor', () => {
  assert.deepEqual(centred(startSize(AREA), AREA), { x: 600, y: 250, width: 720, height: 540 })
  // A second display left of the first, below a taskbar at the top.
  assert.deepEqual(centred({ width: 720, height: 540 }, { x: -1280, y: 40, width: 1280, height: 984 }), { x: -1000, y: 262, width: 720, height: 540 })
})

test('the team window is centred on the start window and stays inside the work area', () => {
  const start = centred(startSize(AREA), AREA)
  assert.deepEqual(mainRect(start, AREA), { x: 300, y: 90, ...MAIN_SIZE })
  // Dragged to the top left corner: the team window keeps to the work area.
  assert.deepEqual(mainRect({ x: 10, y: 5, width: 720, height: 540 }, AREA), { x: 0, y: 0, ...MAIN_SIZE })
  assert.deepEqual(mainRect({ x: 1190, y: 495, width: 720, height: 540 }, AREA), { x: 600, y: 180, ...MAIN_SIZE })
  // A laptop's work area smaller than the team window: it fills the work area.
  assert.deepEqual(mainRect({ x: 323, y: 94, width: 720, height: 540 }, { x: 0, y: 0, width: 1366, height: 728 }), { x: 23, y: 0, width: 1320, height: 728 })
  assert.deepEqual(clampInto({ x: -50, y: 900, width: 2000, height: 300 }, AREA), { x: 0, y: 740, width: 1920, height: 300 })
})

test('the easing is CSS cubic-bezier()', () => {
  const ease = cubicBezier(0.25, 0.1, 0.25, 1)
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3)
  assert.equal(ease(0), 0)
  assert.equal(ease(1), 1)
})

test('the team window shows by itself after 2.5 s on a first start or a celebration, else 0.8 s', () => {
  assert.equal(fallbackMs({ start: 'first', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'first', celebrate: false }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: false }), 800)
})

test('a failure gets one of the six reasons of the failure page', () => {
  const coded = (code, message) => Object.assign(new Error(message), { code })
  assert.equal(failureReason(coded('EACCES', 'EACCES: permission denied, mkdir \'D:\\data\\profiles\'')), 'permission')
  assert.equal(failureReason(new Error('EPERM: operation not permitted, open \'x\'')), 'permission')
  assert.equal(failureReason(coded('ENOSPC', 'ENOSPC: no space left on device, write')), 'space')
  assert.equal(failureReason(new Error('There is not enough space on the disk.')), 'space')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: Cannot find module \'@deepseek-ai/dsh-base\'')), 'files')
  assert.equal(failureReason(new Error('The app could not load its own bundles:\nds-bot: missing')), 'files')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: EACCES: permission denied, open \'state.json\'')), 'permission')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 3221225477)')), 'engine')
  assert.equal(failureReason(new Error('The profile in D:\\x does not start the engine\'s web server and connection.')), 'engine')
  assert.equal(failureReason(new Error('DS Bot: no free port on 127.0.0.1')), 'other')
  assert.equal(failureReason('a string'), 'other')
  assert.equal(failureReason(undefined), 'other')
})

test('only a missing file of the app\'s own says that the install is incomplete', () => {
  const program = join(tmpdir(), 'DS Bot')
  const where = { program: [join(tmpdir(), 'electron'), program] }
  const missing = (path, message) => Object.assign(new Error(message), { code: 'ENOENT', path })
  const exe = join(program, 'DS Bot.exe')
  assert.equal(failureReason(missing(exe, `spawn ${exe} ENOENT`), where), 'files')
  assert.equal(failureReason(missing(exe, `spawn ${exe} ENOENT`)), 'other')
  // A saved data folder on a drive that is gone: its own reason, with what to do about it.
  const data = join(tmpdir(), 'gone', 'DS Bot', 'data', 'profiles', 'ds-bot')
  assert.equal(failureReason(missing(data, `ENOENT: no such file or directory, mkdir '${data}'`), where), 'missing')
  // A Host that stopped: its error output names the missing file.
  const bundle = join(program, 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'index.js')
  assert.equal(failureReason(new Error(`The DSH Host stopped (exit 1):\nError: ENOENT: no such file or directory, open '${bundle}'`), where), 'files')
  assert.equal(failureReason(new Error(`The DSH Host stopped (exit 1):\nError: ENOENT: no such file or directory, open '${join(data, 'state.json')}'`), where), 'engine')
})

test('the main process takes only its own acts, each in its own views', () => {
  assert.deepEqual([...START_ACTS].sort(), ['answer', 'copyDetails', 'handoffDone', 'handoffShow', 'importModel', 'importOption', 'installUpdate', 'manualDownload', 'painted', 'pick', 'reloadView', 'retry', 'saveLog', 'wait'])
  // The import card's model and options, on a card only. The copy has no stop of its own.
  for (const name of ['importModel', 'importOption']) {
    assert.equal(acceptsAct(name, 'card'), true, name)
    for (const view of ['boot', 'failed', 'watchdog', 'handoff', 'moving']) assert.equal(acceptsAct(name, view), false, `${name} in ${view}`)
  }
  assert.equal(acceptsAct('handoffShow', 'handoff'), true)
  // 「换个位置…」 while the start boots and 〔重新选〕 on its cards; a card's answer only on a card.
  assert.equal(acceptsAct('pick', 'boot'), true)
  assert.equal(acceptsAct('pick', 'card'), true)
  assert.equal(acceptsAct('pick', 'watchdog'), true)
  assert.equal(acceptsAct('pick', 'failed'), false)
  assert.equal(acceptsAct('pick', 'viewFailed'), false)
  assert.equal(acceptsAct('answer', 'card'), true)
  assert.equal(acceptsAct('answer', 'boot'), false)
  assert.equal(acceptsAct('handoffShow', 'boot'), false)
  assert.equal(acceptsAct('handoffDone', 'handoff'), true)
  assert.equal(acceptsAct('retry', 'failed'), true)
  assert.equal(acceptsAct('retry', 'watchdog'), true)
  assert.equal(acceptsAct('retry', 'boot'), false)
  assert.equal(acceptsAct('retry', 'handoff'), false)
  assert.equal(acceptsAct('wait', 'watchdog'), true)
  assert.equal(acceptsAct('wait', 'failed'), false)
  assert.equal(acceptsAct('reloadView', 'viewFailed'), true)
  assert.equal(acceptsAct('reloadView', 'failed'), false)
  // The failure page's update banner.
  for (const name of ['installUpdate', 'manualDownload']) {
    assert.equal(acceptsAct(name, 'failed'), true)
    for (const view of ['boot', 'card', 'viewFailed', 'watchdog', 'handoff', 'moving']) assert.equal(acceptsAct(name, view), false, `${name} in ${view}`)
  }
  for (const view of ['boot', 'failed', 'viewFailed', 'watchdog', 'handoff', 'moving']) {
    assert.equal(acceptsAct('copyDetails', view), true)
    assert.equal(acceptsAct('saveLog', view), true)
  }
  // The cards of later pull requests, and names that are not acts at all.
  for (const name of ['reload', 'toggleDetails', 'freshStart', 'stopCopy', 'keepCopying', 'importModel', 'importOption', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(acceptsAct(name, 'failed'), false, name)
  }
  assert.equal(acceptsAct(undefined, 'failed'), false)
  assert.equal(acceptsAct(42, 'failed'), false)
})

test('acts come only from the start page that was loaded', () => {
  // A Windows path is a file URL only on Windows.
  const win32 = process.platform === 'win32'
  const page = win32 ? 'C:\\Program Files\\DS Bot\\resources\\app.asar\\src\\start\\start.html' : '/opt/DS Bot/resources/app.asar/src/start/start.html'
  const loaded = startUrl(page, 'first')
  assert.equal(loaded, win32 ? 'file:///C:/Program%20Files/DS%20Bot/resources/app.asar/src/start/start.html?start=first' : 'file:///opt/DS%20Bot/resources/app.asar/src/start/start.html?start=first')
  assert.equal(isStartPage(loaded, loaded), true)
  assert.equal(isStartPage(`${loaded}#x`, loaded), false)
  assert.equal(isStartPage(loaded.replace('first', 'later'), loaded), false)
  assert.equal(isStartPage(loaded.replace('start.html', 'other.html'), loaded), false)
  assert.equal(isStartPage('http://127.0.0.1:52817/src/start/start.html?start=first', loaded), false)
  assert.equal(isStartPage('not a url', loaded), false)
  assert.equal(isStartPage(undefined, loaded), false)
})

const state = (change = {}) => ({
  lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', done: [], celebrate: true,
  explain: explainOf(), clock: { base: 0, from: 1000, running: true }, hint: undefined, failure: undefined, ...change,
})

test('the snapshot carries the phase, the stages done and the clock', () => {
  const now = 1_700_000_000_000
  const booting = startSnapshot(state({ clock: { base: 0, from: now - 6400, running: true } }), now)
  assert.deepEqual(booting, {
    v: 1, lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', phases: ['data', 'engine', 'team'], phase: 'data', done: [],
    clock: { ms: 6400, at: now, running: true, rate: 1 },
    explain: { mode: 'new', nextStep: true, previewNotice: true }, celebrate: true, shown: false,
  })
  assert.equal(startSnapshot(state({ done: ['data'] }), now).phase, 'engine')
  const ready = startSnapshot(state({ view: 'handoff', done: ['team', 'data', 'engine'] }), now)
  assert.equal(ready.phase, 'team')
  assert.deepEqual(ready.done, ['data', 'engine', 'team'])
  // A paused clock (a dialog, the 180 s question, a failure) stays where it stopped.
  assert.deepEqual(startSnapshot(state({ view: 'watchdog', clock: { base: 180_000, from: 5, running: false } }), now).clock, { ms: 180_000, at: now, running: false, rate: 1 })
  assert.equal(clockMs({ base: 1000, from: now - 500, running: true }, now), 1500)
  assert.equal(clockMs({ base: 1000, from: now + 500, running: true }, now), 1000)
  const failed = startSnapshot(state({ view: 'failed', failure: { reason: 'engine', log: ['a', 'b'] } }), now)
  assert.deepEqual(failed.failure, { reason: 'engine', log: ['a', 'b'] })
  assert.equal('card' in failed, false)
  assert.equal('hint' in failed, false)
  assert.deepEqual(startSnapshot(state({ hint: { drive: 'C', free: '1.2 GB' } }), now).hint, { drive: 'C', free: '1.2 GB' })
  assert.equal('place' in startSnapshot(state(), now), false)
  assert.deepEqual(startSnapshot(state({ place: { drive: 'C', free: '412 GB' } }), now).place, { drive: 'C', free: '412 GB' })
  assert.deepEqual(startSnapshot(state({ view: 'card', card: { kind: 'picked', path: 'D:\\DS Bot' } }), now).card, { kind: 'picked', path: 'D:\\DS Bot' })
  // The page gets copies: it cannot change the main process's state.
  const source = state({ failure: { reason: 'other', log: ['x'] } })
  const sent = startSnapshot(source, now)
  sent.explain.mode = 'import'
  sent.failure.log.push('y')
  assert.equal(source.explain.mode, 'new')
  assert.deepEqual(source.failure.log, ['x'])
})

test('what the hint row can prepare for: a new team, a reinstall or an import', () => {
  // DSH shows its preview notice on a data folder without a team, which has no Session yet.
  assert.deepEqual(explainOf(), { mode: 'new', nextStep: true, previewNotice: true })
  assert.deepEqual(explainOf({ team: { bots: 6, rooms: 2 } }), { mode: 'reinstall', bots: 6, groups: 2, nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true }), { mode: 'import', nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true, team: { bots: 1, rooms: 0 } }).mode, 'import')
  // The greeting names the kept team's first Main Bot; without a readable name it names none.
  const state = { mainBotIds: ['b2', 'b1'], bots: { b1: { name: 'Chief' }, b2: { name: ' Ada ' } } }
  assert.equal(explainOf({ team: { bots: 2, rooms: 0, team: state } }).name, 'Ada')
  assert.equal(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotId: 'b1', bots: state.bots } } }).name, 'Chief')
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['gone'], bots: {} } } }), 'name'), false)
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['b1'], bots: { b1: { name: '  ' } } } } }), 'name'), false)
})

test('the copied details name the version and the reason before the log', () => {
  assert.equal(detailsText({ version: '0.2.2', platform: 'win32', arch: 'x64', reason: 'engine', lines: ['l1', 'l2'] }), 'DS Bot 0.2.2 (win32 x64)\nreason: engine\n\nl1\nl2')
})

test('the start window remembers the theme and the motion tier in its own file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-start-frame-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'start-frame.json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), true)
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), false)
  assert.equal(writeStartFrame(file, { motion: 'lively', themeSource: 'moonlight' }), true)
  assert.deepEqual(readStartFrame(file), { themeSource: 'dark', motion: 'lively' })
  assert.deepEqual(readdirSync(dir), ['start-frame.json'])
  writeFileSync(file, '{"themeSource":"neon","motion":7}')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  writeFileSync(file, 'not json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
})

// Onboarding acceptance: no dialog during the first start without a window it belongs to.
test('every dialog belongs to a window', () => {
  const src = new URL('../src/', import.meta.url)
  const files = readdirSync(src).filter(name => /\.m?js$/u.test(name))
  const loose = files.flatMap((name) => {
    const code = readFileSync(new URL(name, src), 'utf8')
    return [...code.matchAll(/dialog\.(show\w+)\(\s*(\{|\))/gu)].map(match => `${name}: dialog.${match[1]}`)
  })
  assert.deepEqual(loose, [])
  assert.ok(files.every(name => !readFileSync(new URL(name, src), 'utf8').includes('showErrorBox')))
})

// Just enough of Electron for StartWindow: windows that record what is done to them, and the
// start page's act channel.
function fakeElectron() {
  const windows = []
  let act
  class Contents extends EventEmitter {
    sent = []
    reloads = 0
    mainFrame = { url: '' }
    other = []
    send(channel, state) { if (channel === START_STATE) this.sent.push(state); else this.other.push([channel, state]) }
    setWindowOpenHandler() {}
    toggleDevTools() {}
    reload() { this.reloads += 1; this.emit('dom-ready') }
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    calls = []
    destroyed = false
    minimized = false
    focused = true
    constructor({ x = 0, y = 0, width = 800, height = 600, show = true } = {}) {
      super()
      this.bounds = { x, y, width, height }
      this.visible = show
      windows.push(this)
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
    setContentBounds(rect) { this.bounds = { ...rect } }
    setBounds(rect) { this.bounds = { ...rect }; this.calls.push('setBounds') }
    getBounds() { return { ...this.bounds } }
    getContentBounds() { return { ...this.bounds } }
    getNormalBounds() { return { ...this.bounds } }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    isMinimized() { return this.minimized }
    isFocused() { return this.focused }
    restore() { this.minimized = false }
    minimize() { this.minimized = true; this.calls.push('minimize') }
    show() { this.visible = true; this.calls.push('show') }
    showInactive() { this.visible = true; this.calls.push('showInactive') }
    hide() { this.visible = false; this.calls.push('hide') }
    focus() { this.calls.push('focus') }
    flashFrame(on) { this.calls.push(`flash ${String(on)}`) }
    setSkipTaskbar(skip) { this.calls.push(`skipTaskbar ${String(skip)}`) }
    setTitleBarOverlay() {}
    setBackgroundColor() {}
    getMediaSourceId() { return 'window:1:0' }
    moveAbove() {}
    moveTop() { this.calls.push('moveTop') }
    setOpacity(value) { this.opacity = value; if (value === 0 || value === 1) this.calls.push(`opacity ${String(value)}`) }
  }
  const display = { workArea: AREA }
  const electron = {
    BrowserWindow: Window,
    ipcMain: { handle: (channel, handler) => { if (channel === START_ACT) act = handler } },
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getPrimaryDisplay: () => display },
    shell: { openPath: async () => '' },
    clipboard: { writeText() {} },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
  }
  return { electron, windows, act: (event, name, payload) => act(event, name, payload) }
}

function startWindow(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  t.mock.method(console, 'log', () => {})
  const fake = fakeElectron()
  const main = new fake.electron.BrowserWindow({ show: false })
  const calls = { retry: 0, reload: 0, close: 0, pick: [], answer: [], update: [], saveAs: [], saveTo: undefined }
  const start = new StartWindow({
    electron: fake.electron, page: join(tmpdir(), 'start', 'start.html'), preload: 'preload.cjs', icon: 'icon.ico', mica: false, devTools: false,
    lang: () => 'en', motion: 'normal', version: '0.0.0', program: [], log: { dir: 'logs', tail: () => ['a log line'] },
    mainWindow: () => main,
    onRetry: () => { calls.retry += 1 }, onReload: () => { calls.reload += 1 }, onClose: () => { calls.close += 1 },
    onPick: (value) => { calls.pick.push(value) }, onAnswer: (value) => { calls.answer.push(value) }, onUpdate: (name) => { calls.update.push(name) },
    saveAs: (win, name) => { calls.saveAs.push(name); return Promise.resolve(calls.saveTo) },
  })
  const win = () => fake.windows.at(-1)
  const page = () => ({ sender: win().webContents, senderFrame: win().webContents.mainFrame })
  return {
    start, main, calls, win,
    tick: (ms) => { t.mock.timers.tick(ms) },
    state: () => win().webContents.sent.at(-1),
    act: (name, payload, event = page()) => fake.act(event, name, payload),
    other: () => new fake.electron.BrowserWindow(),
  }
}

test('the start window takes acts only from its own page, each in its own view', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  const own = s.win()
  const ownFrame = { sender: own.webContents, senderFrame: own.webContents.mainFrame }
  const other = s.other()
  assert.equal(s.act('saveLog', undefined, { sender: other.webContents, senderFrame: other.webContents.mainFrame }), false)
  assert.equal(s.act('saveLog', undefined, { sender: own.webContents, senderFrame: { url: own.webContents.mainFrame.url } }), false)
  const loaded = own.webContents.mainFrame.url
  own.webContents.mainFrame.url = loaded.replace('first', 'later')
  assert.equal(s.act('saveLog', undefined, ownFrame), false)
  own.webContents.mainFrame.url = loaded
  assert.equal(s.act('saveLog', undefined, ownFrame), true)
  assert.equal(s.act('retry', undefined, ownFrame), false)
  assert.equal(s.act('freshStart', undefined, ownFrame), false)
  assert.equal(s.calls.retry, 0)
})

// The page's whale and ring come about 1 s after the window: shown at once, it was an empty panel.
// Windows draws a window it has just shown a few frames before its page, under its own opening
// transition: the window shows see-through and turns opaque OPEN_MS later, and only then does the
// snapshot say `shown`, which starts the whale's entrance (start.js).
test('the start window shows once its page says it has painted, see-through until OPEN_MS', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  assert.equal(s.win().visible, false)
  s.tick(PAINT_WAIT_MS - 1)
  assert.equal(s.win().visible, false)
  assert.equal(s.act('painted'), true)
  assert.equal(s.win().visible, true)
  assert.deepEqual(s.win().calls.filter(call => call === 'show' || call.startsWith('opacity')), ['opacity 0', 'show'])
  s.tick(OPEN_MS - 1)
  assert.notEqual(s.state()?.shown, true)
  assert.equal(s.win().opacity, 0)
  s.tick(1)
  assert.equal(s.win().opacity, 1)
  assert.equal(s.state().shown, true)
  // The page's fallback and a second 'painted' change nothing.
  s.tick(PAINT_WAIT_MS)
  s.act('painted')
  assert.deepEqual(s.win().calls.filter(call => call === 'show' || call.startsWith('opacity')), ['opacity 0', 'show', 'opacity 1'])
})

test('a start page that never says it painted is shown anyway, opaque at once', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.tick(PAINT_WAIT_MS)
  assert.equal(s.win().visible, true)
  assert.equal(s.state().shown, true)
  assert.equal(s.win().calls.includes('opacity 0'), false)
})

test('a dialog of the start window shows it at once: it never opens over nothing', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  assert.equal(s.start.owner(), s.win())
  assert.equal(s.win().visible, true)
  assert.equal(s.state().shown, true)
})

// 〔保存日志…〕 asks the app's own picker (main.mjs saveAs) where, never a system box.
test('〔保存日志…〕 writes the log where the app\'s picker says, and nothing when it is cancelled', async (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-log-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  assert.equal(s.act('saveLog'), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(s.calls.saveAs, ['DS-Bot-log.txt'])
  assert.deepEqual(readdirSync(dir), [])
  s.calls.saveTo = join(dir, 'log.txt')
  s.act('saveLog')
  const saved = () => (readdirSync(dir).length > 0 ? readFileSync(join(dir, 'log.txt'), 'utf8') : '')
  for (let i = 0; i < 500 && !saved().includes('a log line'); i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.match(saved(), /^DS Bot 0\.0\.0 \([\s\S]*a log line/u)
})

test('a dialog of the start window turns it opaque while it waits see-through', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.act('painted')
  assert.equal(s.start.owner(), s.win())
  assert.equal(s.win().opacity, 1)
  assert.equal(s.state().shown, true)
})

test('the 180 s question comes on the start\'s clock while the engine is not up', async (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  // A dialog stops the clock: the user's thinking time is not the engine's.
  let answer
  const asked = s.start.asking(new Promise((resolve) => { answer = resolve }))
  s.tick(WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
  answer()
  await asked
  s.tick(WATCHDOG_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.state().clock.running, false)
  // 〔继续等待〕: another 180 s on the clock.
  assert.equal(s.act('wait'), true)
  assert.equal(s.state().view, 'boot')
  s.tick(WATCHDOG_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  // The engine comes up meanwhile: the question goes, and does not come back.
  s.start.done('engine')
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, ['data', 'engine'])
  s.tick(2 * WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
})

// The copy is a stage of its own, between the data and the engine (§6), from the moment it runs:
// the ring has three arcs while the import card asks, keeps the fourth once the copy is done, and
// goes back to three when the copy stops. The engine that warmed up while the card waited stops
// for the copy: its stage is open again until the copied team's engine is up.
test("the copy is a stage of its own, and the engine's stage waits for the copied team's engine", (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.explain(explainOf({ offered: true }))
  assert.deepEqual(s.state().phases, ['data', 'engine', 'team'])
  s.start.done('data')
  s.start.card({ kind: 'import', bots: 4, groups: 0 })
  s.start.done('engine')
  assert.deepEqual(s.state().phases, ['data', 'engine', 'team'], 'three arcs while the card asks')
  const copying = (step, arc) => ({ kind: 'copying', step, fraction: 0, arc, steps: [{}, {}, {}] })
  s.start.card(copying(1, 0))
  assert.deepEqual(s.state().phases, ['data', 'import', 'engine', 'team'])
  assert.equal(s.state().phase, 'import')
  s.start.card(undefined)
  assert.deepEqual(s.state().phases, ['data', 'engine', 'team'], 'a copy that ends without the team goes back to three')
  s.start.card(copying(2, 0.15))
  s.start.engineDown()
  assert.deepEqual(s.state().done, ['data'])
  s.start.ready()
  assert.notEqual(s.state().view, 'handoff', 'no hand-off while no engine is up')
  s.start.done('import')
  assert.equal(s.state().phase, 'engine')
  s.start.card(undefined)
  assert.equal(s.state().phases.length, 4, 'a done copy keeps its arc')
  s.start.done('engine')
  assert.deepEqual(s.state().done, ['data', 'import', 'engine'])
  s.start.ready()
  assert.equal(s.state().view, 'handoff')
  assert.deepEqual(s.state().done, ['data', 'import', 'engine', 'team'])
})

// start-window §7: the stage that failed is the one the snapshot is at, and the page turns its arc
// red: the data folder when it cannot be made or written, the engine when it or the Host stops.
// §6: a failed copy keeps the copy's arc (the page turns it red); 〔先不带团队开始〕 takes the card
// away and the ring goes back to three.
test('a failed copy keeps its arc on the ring until the start goes on without the team', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.explain(explainOf({ offered: true }))
  s.start.done('data')
  s.start.card({ kind: 'copying', step: 2, fraction: 0.4, arc: 0.5, steps: [{}, {}, {}] })
  s.start.card({ kind: 'importFailed', reason: 'inUse', log: ['EBUSY: resource busy or locked'] })
  assert.deepEqual(s.state().phases, ['data', 'import', 'engine', 'team'])
  assert.equal(s.state().phase, 'import')
  assert.deepEqual(s.state().card.log, ['EBUSY: resource busy or locked'])
  s.start.card(undefined)
  assert.deepEqual(s.state().phases, ['data', 'engine', 'team'])
})

test('a data folder that cannot be written fails at the data stage, a stopped engine at the engine', async (t) => {
  for (const [error, reason, phase, done] of [
    [Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' }), 'permission', 'data', []],
    [Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }), 'space', 'data', []],
    [new Error('The DSH Host stopped (exit 1)'), 'engine', 'engine', ['data']],
  ]) {
    await t.test(reason, (st) => {
      const s = startWindow(st)
      s.start.open('first')
      for (const stage of done) s.start.done(stage)
      s.start.fail(error)
      assert.equal(s.state().view, 'failed')
      assert.equal(s.state().failure.reason, reason)
      assert.equal(s.state().phase, phase)
      assert.ok(Array.isArray(s.state().failure.log), 'the log goes with it')
    })
  }
})

test('a retry after the engine was up guards the new engine, while the whale keeps its stop', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  assert.equal(s.state().view, 'failed')
  assert.equal(s.state().failure.reason, 'engine')
  assert.equal(s.act('retry'), true)
  assert.equal(s.calls.retry, 1)
  assert.deepEqual(s.state().done, ['data', 'engine'])
  assert.equal(s.state().phase, 'team')
  // The old team view cannot hand over before the new engine is up.
  s.start.ready()
  assert.equal(s.state().view, 'boot')
  s.tick(WATCHDOG_MS)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.act('retry'), true)
  s.start.done('engine')
  s.tick(2 * WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
  s.start.ready()
  assert.equal(s.state().view, 'handoff')
  // The first success after a retry celebrates.
  assert.equal(s.state().celebrate, true)
})

test('the team view has 20 s to call ready(); a late ready() hands over without a celebration', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  s.tick(TEAM_VIEW_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'viewFailed')
  assert.deepEqual(s.state().failure, { reason: 'other', log: ['a log line'] })
  // 〔重新载入〕: the hidden team view loads again and has another 20 s.
  assert.equal(s.act('reloadView'), true)
  assert.equal(s.calls.reload, 1)
  assert.equal(s.state().view, 'boot')
  s.tick(TEAM_VIEW_MS)
  assert.equal(s.state().view, 'viewFailed')
  s.start.ready()
  assert.equal(s.state().view, 'handoff')
  assert.equal(s.state().celebrate, false)
  assert.equal('failure' in s.state(), false)
})

for (const [kind, wait] of [['first', 2500], ['later', 800]]) {
  test(`without handoffShow the team window shows by itself after ${String(wait)} ms on a ${kind} start`, async (t) => {
    const s = startWindow(t)
    s.start.open(kind)
    s.start.done('data')
    s.start.done('engine')
    s.start.ready()
    s.tick(wait - 1)
    assert.equal(s.main.calls.includes('opacity 1'), false)
    s.tick(1)
    // It waited see-through under the start window; the two cross-fade.
    assert.ok(s.main.calls.includes('skipTaskbar false'))
    assert.ok(s.win().calls.includes('skipTaskbar true'))
    await s.start.teamShown
    const start = s.win()
    for (let ms = 0; ms <= CROSSFADE.duration; ms += CROSSFADE.step) s.tick(CROSSFADE.step)
    assert.equal(s.main.opacity, 1)
    assert.equal(start.destroyed, true)
    assert.equal(s.main.calls.at(-1), 'focus')
    // Gone after the hand-off, the start window does not quit the app.
    assert.equal(s.calls.close, 0)
  })
}

test('the whale the start page hands over is put in the team page\'s own coordinates', () => {
  const team = { x: 300, y: 90, width: 1280, height: 860 }
  const start = { x: 580, y: 250 }
  assert.deepEqual(handoffBox({ x: 304, y: 147, size: 112 }, { start, team, viewportWidth: 1280 }), { x: 584, y: 307, size: 112 })
  // A team page zoomed to 125 %: its CSS px are larger than DIP.
  assert.deepEqual(handoffBox({ x: 304, y: 147, size: 112 }, { start, team, viewportWidth: 1024 }), { x: 467, y: 245.5, size: 89.5 })
  for (const whale of [undefined, null, 'whale', { x: 1 }, { x: 1, y: 1, size: 4 }, { x: Number.NaN, y: 1, size: 112 }]) {
    assert.equal(handoffBox(whale, { start, team, viewportWidth: 1280 }), undefined, JSON.stringify(whale))
  }
})

// The start window never resizes: the team window, see-through under it since ready(), takes the
// whale, and the two windows cross-fade.
function handingOver(t, { focused = true } = {}) {
  const s = startWindow(t)
  s.start.open('later')
  s.win().focused = focused
  s.start.placeMain()
  s.start.done('data')
  s.start.done('engine')
  s.start.ready(AVATAR)
  return s
}

test('the team window waits see-through under the start window from ready() on', (t) => {
  const s = handingOver(t)
  assert.deepEqual(s.main.calls.slice(-3), ['skipTaskbar true', 'opacity 0', 'showInactive'])
  assert.equal(s.win().calls.at(-1), 'moveTop')
  assert.equal(s.main.visible, true)
})

test('at handoffShow the team page gets the whale, and the windows cross-fade once it has drawn it', (t) => {
  const s = handingOver(t)
  const from = s.win().getBounds()
  assert.equal(s.act('handoffShow', { whale: { x: 304, y: 147, size: 112 } }), true)
  const [[channel, box]] = s.main.webContents.other
  assert.equal(channel, TEAM_HANDOFF)
  assert.equal(box.hold, HOLD_MS)
  assert.deepEqual({ x: box.x, y: box.y, size: box.size }, handoffBox({ x: 304, y: 147, size: 112 }, { start: from, team: s.main.bounds, viewportWidth: AVATAR.viewportWidth }))
  assert.equal(s.main.calls.includes('skipTaskbar false'), false, 'it shows before the team page has the whale')
  s.start.teamReady()
  assert.ok(s.main.calls.includes('skipTaskbar false'))
  const start = s.win()
  s.tick(CROSSFADE.duration / 2)
  assert.ok(start.opacity > 0 && start.opacity < 1, 'the start window does not fade')
  assert.ok(s.main.opacity > 0 && s.main.opacity < 1, 'the team window does not fade in')
  assert.equal(s.main.calls.includes('focus'), false)
  s.tick(CROSSFADE.duration)
  assert.equal(start.opacity, 0)
  assert.equal(s.main.opacity, 1)
  assert.equal(start.destroyed, true)
  assert.equal(s.main.calls.at(-1), 'focus')
  // It never resized.
  assert.equal(start.calls.includes('setBounds'), false)
  assert.equal(s.calls.close, 0)
})

test('the cross-fade starts anyway when the team page does not say it drew the whale', (t) => {
  const s = handingOver(t)
  s.act('handoffShow', { whale: { x: 304, y: 147, size: 112 } })
  s.tick(TEAM_WAIT_MS - 1)
  assert.equal(s.main.calls.includes('skipTaskbar false'), false)
  s.tick(1)
  assert.ok(s.main.calls.includes('skipTaskbar false'))
})

test('without a whale to hand over (a dive, or no box) the windows cross-fade at once', (t) => {
  for (const payload of [undefined, { whale: { x: 1 } }]) {
    const s = handingOver(t)
    s.act('handoffShow', payload)
    assert.deepEqual(s.main.webContents.other, [])
    assert.ok(s.main.calls.includes('skipTaskbar false'))
    // A second handoffShow does nothing.
    assert.equal(s.act('handoffShow'), true)
    assert.equal(s.main.calls.filter(call => call === 'showInactive').length, 1)
    t.mock.timers.reset()
  }
})

for (const how of ['behind', 'minimized']) {
  test(`the team window comes up ${how} when the start window is`, (t) => {
    const s = startWindow(t)
    s.start.open('later')
    if (how === 'behind') s.win().focused = false
    else s.win().minimized = true
    s.start.done('data')
    s.start.done('engine')
    s.start.ready()
    s.act('handoffShow')
    for (let step = 0; step < 60 && !s.main.calls.includes('flash true'); step += 1) s.tick(CROSSFADE.step)
    // Behind: it waited under the start window and fades in; minimized: it comes up minimized.
    assert.deepEqual(s.main.calls.slice(-2), how === 'behind' ? ['opacity 1', 'flash true'] : ['minimize', 'flash true'])
    assert.equal(s.main.calls.includes('focus'), false)
  })
}

test('closing the start window before the hand-off quits, and its timers go with it', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  const sent = s.win().webContents.sent.length
  s.win().destroy()
  assert.equal(s.calls.close, 1)
  s.tick(WATCHDOG_MS + TEAM_VIEW_MS)
  assert.equal(s.win().webContents.sent.length, sent)
  assert.equal(s.start.owner(), undefined)
})

test('the whale lands on the avatar the team view reported, in the start page\'s own coordinates', () => {
  const team = { x: 300, y: 90, width: 1280, height: 860 }
  const avatar = { x: 98, y: 70, width: 60, height: 60, viewportWidth: 1280, viewportHeight: 860 }
  // Both windows frameless: the grown start page shares the team page\'s origin.
  assert.deepEqual(landingOf(avatar, { team, start: { x: 300, y: 90 } }), { x: 98, y: 70, size: 60 })
  // A team page zoomed to 125 %: its CSS px are larger than DIP.
  assert.deepEqual(landingOf({ x: 80, y: 56, width: 48, height: 48, viewportWidth: 1024, viewportHeight: 688 }, { team, start: { x: 300, y: 90 } }), { x: 100, y: 70, size: 60 })
  // A system title bar on the start window only: its content starts 32 px lower.
  assert.deepEqual(landingOf(avatar, { team, start: { x: 300, y: 122 } }), { x: 98, y: 38, size: 60 })
  // Nothing to land on: no box, a tiny one, one outside the page, or not numbers.
  for (const report of [undefined, null, 'avatar', { x: 1 }, { ...avatar, width: 8, height: 8 }, { ...avatar, x: 1250 }, { ...avatar, y: -4 }, { ...avatar, x: Number.NaN }, { ...avatar, viewportWidth: 0 }]) {
    assert.equal(landingOf(report, { team, start: { x: 300, y: 90 } }), undefined, JSON.stringify(report))
  }
})

const AVATAR = { x: 98, y: 70, width: 60, height: 60, viewportWidth: MAIN_SIZE.width, viewportHeight: MAIN_SIZE.height }
test('ready() with the avatar\'s place puts the landing in the hand-off snapshot; without one there is none', (t) => {
  for (const [report, landing] of [[AVATAR, { x: 98, y: 70, size: 60 }], [undefined, undefined], [{ ...AVATAR, x: MAIN_SIZE.width - 10 }, undefined]]) {
    const s = startWindow(t)
    s.start.open('first')
    // As in the app: the team window is made on its rect, and the page measures it there.
    s.start.placeMain()
    s.start.done('data')
    s.start.done('engine')
    s.start.ready(report)
    assert.equal(s.state().view, 'handoff')
    assert.deepEqual(s.state().landing, landing)
    t.mock.timers.reset()
  }
})

test('the landing takes the start window\'s title bar into account, and waits with a held hand-off', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  // macOS and Linux: a system title bar puts the start page 32 px below the window's top.
  const win = s.win()
  win.getContentBounds = () => ({ ...win.bounds, y: win.bounds.y + 32, height: win.bounds.height - 32 })
  s.start.placeMain()
  s.start.done('data')
  s.start.done('engine')
  s.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  s.start.ready(AVATAR)
  assert.equal(s.state().view, 'card')
  s.start.card(undefined)
  assert.equal(s.state().view, 'handoff')
  assert.deepEqual(s.state().landing, { x: 98, y: 38, size: 60 })
})

test('a minimized start window gets no landing', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.win().minimized = true
  s.start.ready(AVATAR)
  assert.equal(s.state().view, 'handoff')
  assert.equal(s.state().landing, undefined)
})

test('a failure during the hand-off draws the failure page on a fresh page', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.ready()
  s.tick(300)
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  assert.equal(s.state().view, 'failed')
  assert.equal(s.win().webContents.reloads, 1)
  // The team window that waited under the start window is hidden again.
  assert.deepEqual(s.win().bounds, centred(startSize(AREA), AREA))
  assert.equal(s.main.visible, false)
  assert.equal(s.main.opacity, 1)
  s.tick(5000)
  assert.equal(s.main.visible, false)
  assert.equal(s.act('handoffShow'), false)
})

test('a failure after the hand-off opens a fresh start window over the hidden team window', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.ready()
  s.tick(2500)
  const handed = s.win()
  assert.equal(s.main.visible, true)
  s.start.fail(new Error('The DSH Host stopped (exit 1)'), 'later')
  assert.equal(handed.destroyed, true)
  assert.notEqual(s.win(), handed)
  assert.equal(s.main.visible, false)
  assert.equal(s.state().view, 'failed')
  assert.equal(s.state().start, 'later')
  assert.equal(s.start.owner(), s.win())
  assert.equal(s.calls.close, 0)
})

test('the place line, its picker and its cards, and a start over in another folder', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  assert.equal('place' in s.state(), false)
  s.start.place({ drive: 'C', free: '412 GB' })
  assert.deepEqual(s.state().place, { drive: 'C', free: '412 GB' })
  // 「换个位置…」 from the line, with its detail; the picker's own wait is the main process's.
  assert.equal(s.act('pick', { value: 'changePlace' }), true)
  assert.deepEqual(s.calls.pick, ['changePlace'])
  assert.equal(s.act('answer', { value: 'use' }), false)
  // A layer the app added: the 「会放在…」 card waits for the answer, and the clock with it.
  s.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  assert.equal(s.state().view, 'card')
  assert.deepEqual(s.state().card, { kind: 'picked', path: 'D:\\DS Bot' })
  assert.equal(s.state().clock.running, false)
  assert.equal(s.act('pick', undefined), true)
  assert.deepEqual(s.calls.pick, ['changePlace', undefined])
  assert.equal(s.act('answer', { value: 'use' }), true)
  assert.equal(s.act('answer', 'use'), true)
  assert.deepEqual(s.calls.answer, ['use', undefined])
  s.start.card(undefined)
  assert.equal(s.state().view, 'boot')
  assert.equal('card' in s.state(), false)
  assert.equal(s.state().clock.running, true)
  // A rejected place names the reason and the path.
  s.start.card({ kind: 'rejected', reason: 'onedrive', path: 'C:\\Users\\me\\OneDrive' })
  assert.equal(s.state().card.reason, 'onedrive')
  s.start.card(undefined)
  // Under the 180 s question the place can still change; the question comes back after a card.
  s.tick(180_000)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.act('pick', { value: 'changePlace' }), true)
  s.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  assert.equal(s.state().view, 'card')
  s.start.card(undefined)
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  // Starting over: the stages go back, the clock starts from 0, the engine is guarded again,
  // and the place line stays for the new folder.
  s.start.done('engine')
  s.tick(30_000)
  s.start.restart()
  s.start.place({ drive: 'D', free: '412 GB' })
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, [])
  assert.equal(s.state().clock.ms, 0)
  assert.equal(s.state().celebrate, true)
  assert.deepEqual(s.state().place, { drive: 'D', free: '412 GB' })
  s.start.done('data')
  s.tick(180_000)
  assert.equal(s.state().view, 'watchdog')
  s.start.done('engine')
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, ['data', 'engine'])
  // No card after a failure: the failure page has its own buttons.
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  s.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  assert.equal(s.state().view, 'failed')
  assert.equal(s.act('pick', { value: 'changePlace' }), false)
})

// The picker is open when the team view becomes ready: the window, the picker's owner, stays.
test('the hand-off waits while the picker is open', async (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  let answer
  const asked = s.start.asking(new Promise((resolve) => { answer = resolve }))
  s.start.ready()
  assert.equal(s.state().view, 'boot')
  s.tick(2500)
  assert.equal(s.main.visible, false)
  answer()
  await asked
  assert.equal(s.state().view, 'handoff')
})

test('a card holds the hand-off the same way, and the ready is not lost when the card goes', (t) => {
  const c = startWindow(t)
  c.start.open('first')
  c.start.done('data')
  c.start.done('engine')
  c.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  c.start.ready()
  assert.equal(c.state().view, 'card')
  c.start.card(undefined)
  assert.equal(c.state().view, 'handoff')
})

test('a start over in another folder drops the old engine\'s held ready', (t) => {
  const o = startWindow(t)
  o.start.open('first')
  o.start.done('data')
  o.start.done('engine')
  o.start.card({ kind: 'picked', path: 'D:\\DS Bot' })
  o.start.ready()
  o.start.restart()
  assert.equal(o.state().view, 'boot')
  o.tick(3000)
  assert.equal(o.state().view, 'boot')
  o.start.done('data')
  o.start.done('engine')
  o.start.ready()
  assert.equal(o.state().view, 'handoff')
})

test('a move from a later start turns the start window into the move\'s and drops the held hand-off', async (t) => {
  const m = startWindow(t)
  m.start.open('later')
  m.start.done('data')
  m.start.place({ drive: 'C', free: '30 GB' })
  assert.deepEqual(m.state().place, { drive: 'C', free: '30 GB' })
  // The folder picker and the question: a team view that is ready meanwhile waits for them.
  let answer
  const asked = m.start.asking(new Promise((resolve) => { answer = resolve }))
  m.start.done('engine')
  m.start.ready()
  assert.equal(m.state().view, 'boot')
  m.start.moving()
  answer('D:\\Data')
  await asked
  assert.equal(m.start.kind, 'moving')
  assert.equal(m.state().view, 'moving')
  assert.equal('place' in m.state(), false)
  assert.match(m.win().webContents.mainFrame.url, /\?start=moving$/u)
  assert.equal(m.act('pick', { value: 'changePlace' }), false)
  assert.equal(m.act('saveLog'), true)
  m.tick(WATCHDOG_MS)
  assert.equal(m.state().view, 'moving')
  // A move that does not go through asks on a card of the moving page; the clock stands still
  // meanwhile, and taking the card away goes back to the move, not to a boot.
  assert.equal(m.start.card({ kind: 'moveFailed', why: 'inUse', dataDir: 'C:\\Data' }), true)
  assert.equal(m.state().view, 'card')
  assert.equal(m.state().clock.running, false)
  assert.equal(m.act('answer', { value: 'old' }), true)
  assert.deepEqual(m.calls.answer, ['old'])
  assert.equal(m.start.card(undefined), true)
  assert.equal(m.state().view, 'moving')
  assert.equal(m.state().clock.running, true)
  assert.equal('card' in m.state(), false)
})

test('the failure page carries the update banner until a retry', (t) => {
  const u = startWindow(t)
  u.start.open('first')
  // Not before the failure page.
  u.start.done('data')
  u.start.update({ state: 'available', version: '9.9.9', page: true })
  assert.equal('update' in u.state(), false)
  u.start.fail(new Error('the Host did not start'), 'first')
  u.start.update({ state: 'downloading', version: '9.9.9', percent: 37, received: 78, total: 212 })
  assert.deepEqual(u.state().update, { state: 'downloading', version: '9.9.9', percent: 37, received: 78, total: 212 })
  u.start.update({ state: 'installing', version: '9.9.9' })
  assert.deepEqual(u.state().update, { state: 'installing', version: '9.9.9' })
  assert.equal(u.act('installUpdate'), true)
  assert.equal(u.act('manualDownload'), true)
  assert.deepEqual(u.calls.update, ['installUpdate', 'manualDownload'])
  assert.equal(u.act('retry'), true)
  assert.equal('update' in u.state(), false)
  assert.equal(u.act('manualDownload'), false)
  assert.deepEqual(u.calls.update, ['installUpdate', 'manualDownload'])
})

test('a card shows only while the start boots or the data moves', (t) => {
  const c = startWindow(t)
  c.start.open('first')
  c.start.fail(new Error('the Host did not start'), 'first')
  assert.equal(c.start.card({ kind: 'importFailed', reason: 'other' }), false)
  assert.equal(c.state().view, 'failed')
  assert.equal(c.start.card(undefined), false)
})

test('the 20 s check\'s verdict waits for a card\'s answer instead of being lost', (t) => {
  const v = startWindow(t)
  v.start.open('first')
  v.start.done('data')
  v.start.done('engine')
  v.start.teamLoading()
  v.start.card({ kind: 'rejected', reason: 'onedrive', path: 'C:\\OneDrive' })
  v.tick(20_000)
  assert.equal(v.state().view, 'card')
  v.start.card(undefined)
  assert.equal(v.state().view, 'viewFailed')
})
