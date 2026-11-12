// The main process of the app, with the Electron parts as a test double: the window, the
// tray and the Host, without a display, without DSH and without the data of the user.
// The loader (test/helpers/loader.mjs) puts the test doubles in place of "electron".
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, state } from './fake-electron.mjs'
import { hold } from './fake-host-process.mjs'

/** Wait until the app has done something, so that the test does not guess a moment. */
export const waitFor = async (check, what, timeout = 10_000) => {
  const until = Date.now() + timeout
  for (;;) {
    if (check()) return
    if (Date.now() > until) throw new Error(`the app did not ${what}`)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

/**
 * Start the app on throwaway folders: the places are chosen already and the one-time notice
 * is answered, so that the app asks nothing. The Host answers when the test lets it.
 * @param {{ packaged?: boolean, saved?: object, acknowledged?: boolean, firstRun?: boolean }} options
 *   whether the app is a packaged one, with an updater; what else locations.json keeps beside the
 *   places; whether the tray notice was answered already; a first run keeps its places unchosen,
 *   so that it asks
 */
export const startApp = async ({ packaged = true, saved = {}, acknowledged = true, firstRun = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-main-home-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
  if (!firstRun) writeFileSync(join(paths.userData, 'locations.json'), JSON.stringify({ dataDir: home, workspace, ...saved }))
  if (acknowledged) writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  hold()
  await import('../../src/main.mjs')
  // The app is a packaged one, so that it has an updater. The flag comes after the start,
  // because a packaged app starts on the canonical path of its own.
  state.packaged = packaged
  // A Linux build updates itself only from inside an AppImage; outside one the app asks about
  // the newest GitHub release, which a test must never fetch. The faked electron-updater
  // answers for the AppImage, as it does on Windows.
  if (process.platform === 'linux') process.env.APPIMAGE ??= '/tmp/ds-bot.AppImage'
  return { home, workspace }
}

// The start window, which shows while the Host boots and hands over to the team window.
const isStart = win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start='))

/** The start windows the app opened. */
export const startWindows = () => state.windows.filter(isStart)

/** The team windows the app built, the start window left out. */
export const teamWindows = () => state.windows.filter(win => !isStart(win))

/** The team window of the app: the last one it built. */
export const window = () => teamWindows().at(-1)

/**
 * The team view has mounted (ds-bot calls dsBotApp.ready()): the start window hands over and the
 * team window shows.
 */
export const handOff = async () => {
  const win = window()
  await waitFor(() => win.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'load the team view')
  win.webContents.mainFrame.url = win.url
  state.ipc.get('ds-bot:ready')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  await waitFor(() => win.visible === true, 'show the team window')
  // It shows see-through under the start window from ready() on (start-window §8): the hand-off
  // is over once the start window is gone.
  await waitFor(() => startWindows().every(start => start.destroyed), 'hand over to the team window')
}

/** The entries of the tray's menu: Open, a line, Quit. */
export const trayMenu = () => state.tray.menu.template

/** The last state the start window sent its page. */
export const startState = (start = startWindows().at(-1)) => start?.webContents.sent.filter(([channel]) => channel === 'ds-bot:start-state').at(-1)?.[1]

/** A click on the start page: the act with its button's detail, on a later task, as a click is. */
export const startAct = async (name, value, start = startWindows().at(-1)) => {
  await new Promise((resolve) => { setImmediate(resolve) })
  start.webContents.mainFrame.url = start.url
  return state.ipc.get('ds-bot:start-act')({ sender: start.webContents, senderFrame: start.webContents.mainFrame }, name, value === undefined ? undefined : { value })
}

/** The cards the app sent the team window in place of message boxes (preload.cjs showCard). */
export const windowCards = (win = window()) => win.webContents.sent.filter(([channel]) => channel === 'ds-bot:app-card').map(([, card]) => card)

/**
 * The team window's page shows its last card and the user clicks the button `index` on it, as
 * preload.cjs reports both.
 */
export const answerCard = (index, win = window()) => {
  const card = windowCards(win).at(-1)
  win.webContents.mainFrame.url = win.url
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  state.ipc.get('ds-bot:app-card-shown')(event, card.id)
  state.ipc.get('ds-bot:app-card-answer')(event, card.id, index)
  return card
}

/** The message boxes the app showed; the pickers have no message. */
export const messageBoxes = () => state.dialogs.filter(options => 'message' in options)

/**
 * A later start whose drive runs low, and its place line's 〔换个位置…〕 to `to`, answered with
 * 〔移动并重启〕: the start window becomes the move's. `picked` runs once the move card is up.
 * @returns {Promise<{ home: string, workspace: string }>}
 */
export const moveFromStart = async (to, { before = () => {}, picked = () => {} } = {}) => {
  const places = await startApp({ saved: { freeAtStart: Number.MAX_SAFE_INTEGER } })
  before(places)
  await waitFor(() => startState()?.place !== undefined, 'show the place line')
  state.openAnswer = { canceled: false, filePaths: [to] }
  await startAct('pick', 'changePlace')
  await waitFor(() => startState().card?.kind === 'move', 'ask about the move')
  picked()
  await startAct('answer', 'move')
  await waitFor(() => startWindows()[0].url.endsWith('?start=moving'), 'turn the start window into the move\'s')
  return places
}
