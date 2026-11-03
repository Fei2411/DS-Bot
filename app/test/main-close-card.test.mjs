// The first close of the team window tells, once, that the app stays in the tray: on a card in
// the window's page, not in a message box. Only the card's answer lets the window go, and the
// answer is kept. The Electron parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { answerCard, handOff, messageBoxes, startApp, trayMenu, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp({ acknowledged: false }) })

test('a page that does not show the card does not hold the close', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  hostState.release()
  await handOff()
  const win = window()
  const silent = win.webContents.send
  win.webContents.send = () => {}
  try {
    win.close()
    await waitFor(() => win.visible === false, 'hide the window once the card is not shown in time', 5000)
  } finally {
    win.webContents.send = silent
  }
  assert.ok(!existsSync(join(paths.userData, 'tray-close-acknowledged')), 'the next close tells again')
  assert.deepEqual(messageBoxes(), [], 'no message box')
})

test('the close asks on a card in the window and hides it once the card is answered', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  // The window was pushed down behind another one: the close still asks where the user looks.
  win.minimize()
  const focused = win.focused
  win.close()
  await waitFor(() => windowCards(win).length === 1, 'tell about the tray on a card')
  assert.equal(win.minimized, false, 'the window comes back up with its card')
  assert.ok(win.focused > focused, 'the window with the card is brought to the front')
  const card = windowCards(win)[0]
  assert.match(card.message, /system tray/u)
  assert.deepEqual(card.buttons, [{ label: 'OK', primary: true }])
  assert.equal(card.cancel, undefined, 'only the answer lets the window go')
  assert.equal(win.visible, true, 'the window stays until the answer')
  // A second close while the card is up asks nothing more; it brings the card to the front.
  const again = win.focused
  win.close()
  assert.equal(windowCards(win).length, 1)
  assert.ok(win.focused > again, 'the second close brings the card forward')
  answerCard(0, win)
  await waitFor(() => win.visible === false, 'hide the window')
  assert.ok(existsSync(join(paths.userData, 'tray-close-acknowledged')), 'the answer is kept')
  assert.deepEqual(messageBoxes(), [], 'no message box')
})

test('later closes hide the window without asking', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  assert.equal(windowCards(win).length, 1, 'no second card')
})

test('the tray quit ends the app', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
