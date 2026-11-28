// The handshake of the Host: the first window trades the launch URL for the Host's cookie,
// and the token of that URL is good for one use only. When the first load never came
// through, no window carries the token again.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startState, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  // No page of the browser comes through: the first load of the Host fails.
  state.rejectLoads = true
  await startApp()
})

test('a first load that never came through does not carry the token again', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const first = window()
  hostState.release()
  await waitFor(() => first.loaded.some(url => url.includes('token=')), 'try the Host')
  await waitFor(() => startState()?.view === 'viewFailed', 'enter viewFailed immediately on loadURL failure')
  assert.equal(state.cookies.length, 0, 'the Host left no cookie')

  // The window is gone for good; the tray builds a new one.
  first.destroy()
  trayMenu()[0].click()
  await waitFor(() => teamWindows().length === 2, 'build a new window')
  const second = window()
  await waitFor(() => second.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the Host')
  assert.equal(second.loaded.filter(url => url.includes('token=')).length, 0, 'the token is not used again')
  assert.equal(hostState.starts, 1, 'no second Host was started')
})

test('failed reload on an already-connected team window enters viewFailed via did-fail-load without waiting 20 s', async () => {
  const { startAct, startWindows } = await import('./helpers/app-harness.mjs')
  const start = startWindows().at(-1)
  if (!start.webContents.mainFrame.url && start.loaded[0]) start.webContents.mainFrame.url = start.loaded[0]
  const win = window()
  // Simulate a loaded Host page whose reload later fails with a main-frame connection error.
  win.webContents.url = `${win.loaded[0].split('?')[0]}`
  await startAct('reloadView')
  assert.equal(startState()?.view, 'boot')
  // Subframe failures and ERR_ABORTED (-3) are ignored; main-frame connection errors fail immediately.
  win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', win.webContents.url, false)
  assert.equal(startState()?.view, 'boot')
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', win.webContents.url, true)
  assert.equal(startState()?.view, 'boot')
  win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', win.webContents.url, true)
  await waitFor(() => startState()?.view === 'viewFailed', 'enter viewFailed immediately on reload did-fail-load')
})

test('the app ends', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
