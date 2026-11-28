// The handshake of the Host: the first window trades the launch URL for the Host's cookie,
// and the token of that URL is good for one use only. When the first load never came
// through, no window carries the token again.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startAct, startApp, startState, startWindows, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  // No page of the browser comes through: the first load of the Host fails.
  state.rejectLoads = true
  await startApp()
})

test('a first load that never came through does not carry the token again, including on reload', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const first = window()
  hostState.release()
  await waitFor(() => first.loaded.some(url => url.includes('token=')), 'try the Host')
  await waitFor(() => startState()?.view === 'viewFailed', 'enter viewFailed immediately on loadURL failure')
  assert.equal(state.cookies.length, 0, 'the Host left no cookie')
  // Electron leaves webContents.getURL() at the failed ?token= launch URL.
  assert.ok(first.webContents.getURL().includes('token='), 'failed launch URL stays on webContents.getURL()')

  // Clicking reload after a failed initial ?token= load must go through connectHost (${origin}/)
  // rather than wc.reload(), so the spent one-time launch token is never replayed.
  const loadedBeforeReload = first.loaded.length
  await startAct('reloadView')
  await waitFor(() => first.loaded.length > loadedBeforeReload, 'reload via connectHost')
  await waitFor(() => startState()?.view === 'viewFailed', 'enter viewFailed again when reload loadURL fails')
  assert.equal(first.webContents.reloads, 0, 'must not call wc.reload() on a failed initial ?token= URL')
  assert.equal(first.loaded.at(-1).includes('token='), false, 'connectHost reload must load plain origin without token')

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
  const start = startWindows().at(-1)
  if (!start.webContents.mainFrame.url && start.loaded[0]) start.webContents.mainFrame.url = start.loaded[0]
  const win = window()
  await waitFor(() => startState()?.view === 'viewFailed', 'wait for viewFailed before establishing host cookie')
  // Establish an authenticated Host cookie so connectHost marks hostReady = true and loads ${origin}/.
  const originUrl = `${win.loaded[0].split('?')[0]}`
  state.cookies.push({ name: 'dsh-auth', value: 'cookie', domain: '127.0.0.1', path: '/' })
  const loadsBeforeCookie = win.loaded.length
  await startAct('reloadView')
  await waitFor(() => win.loaded.length > loadsBeforeCookie, 'connectHost with cookie')
  await waitFor(() => startState()?.view === 'viewFailed', 'return to viewFailed when loadURL rejects')
  assert.equal(win.webContents.getURL(), originUrl)
  assert.equal(win.webContents.reloads, 0)

  // Now hostReady is true and webContents.getURL() is ${origin}/: reloadView must use wc.reload()
  // and watch did-fail-load for immediate main-frame failure reporting.
  state.rejectLoads = false
  await startAct('reloadView')
  assert.equal(win.webContents.reloads, 1, 'connected window reload should call wc.reload()')
  assert.equal(startState()?.view, 'boot')
  // Subframe failures and ERR_ABORTED (-3) are ignored; main-frame connection errors fail immediately.
  win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', originUrl, false)
  assert.equal(startState()?.view, 'boot')
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', originUrl, true)
  assert.equal(startState()?.view, 'boot')
  win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', originUrl, true)
  await waitFor(() => startState()?.view === 'viewFailed', 'enter viewFailed immediately on reload did-fail-load')
})

test('the app ends', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
