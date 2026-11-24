// Toggling automatic updates from the About page persists to userData, stops auto-download
// and auto-install-on-quit, cancels queued update cards, and still allows manual check/download.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { handOff, startApp, startState, trayMenu, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

Object.defineProperty(process, 'platform', { value: 'win32' })

const winEvent = (win) => {
  win.webContents.mainFrame.url = win.url
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame }
}

test('saved autoUpdate=false skips startup check, lets manual check/download run without quit-install, and toggling persists', async () => {
  mkdirSync(paths.userData, { recursive: true })
  writeFileSync(join(paths.userData, 'update-prefs.json'), JSON.stringify({ autoUpdate: false }))

  updater.checkForUpdates = () => {
    updaterState.checks += 1
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '9.9.9' })
    return Promise.resolve({
      isUpdateAvailable: true,
      updateInfo: { version: '9.9.9' },
      downloadPromise: updater.autoDownload ? Promise.resolve(['installer.exe']) : null,
    })
  }
  updater.downloadUpdate = () => {
    updaterState.downloads += 1
    updater.emit('update-downloaded', { version: '9.9.9' })
    return Promise.resolve(['installer.exe'])
  }

  await startApp()
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  await handOff()

  assert.equal(updaterState.checks, 0, 'no startup check when autoUpdate is off')
  assert.equal(updaterState.autoDownload, false)
  assert.equal(updaterState.autoInstallOnAppQuit, false)
  const initial = await state.ipc.get('ds-bot:app-update-state')(winEvent(win))
  assert.deepEqual(initial, { phase: 'idle', autoUpdate: false })

  // Manual check finds the version without auto-downloading.
  await state.ipc.get('ds-bot:app-update-check')(winEvent(win))
  await waitFor(() => updaterState.checks === 1, 'run manual check')
  const available = await state.ipc.get('ds-bot:app-update-state')(winEvent(win))
  assert.deepEqual(available, { phase: 'available', version: '9.9.9', canDownload: true, autoUpdate: false })
  assert.equal(updaterState.downloads, 0)
  assert.deepEqual(windowCards(win), [], 'manual check does not pop an update card')

  // Manual download downloads without arming auto-install-on-quit or popping a card.
  await state.ipc.get('ds-bot:app-update-download')(winEvent(win))
  await waitFor(() => updaterState.downloads === 1, 'run manual download')
  const downloaded = await state.ipc.get('ds-bot:app-update-state')(winEvent(win))
  assert.deepEqual(downloaded, { phase: 'downloaded', version: '9.9.9', autoInstall: false, autoUpdate: false })
  assert.deepEqual(windowCards(win), [])

  // Turning automatic updates back on persists and updates electron-updater flags, while keeping
  // autoInstall honest (false because the download happened while autoInstallOnAppQuit was off).
  const enabled = await state.ipc.get('ds-bot:app-update-auto')(winEvent(win), true)
  assert.deepEqual(enabled, { phase: 'downloaded', version: '9.9.9', autoInstall: false, autoUpdate: true })
  assert.equal(updaterState.autoDownload, true)
  assert.equal(updaterState.autoInstallOnAppQuit, true)
  assert.deepEqual(JSON.parse(readFileSync(join(paths.userData, 'update-prefs.json'), 'utf8')), { autoUpdate: true })

  // Turning it off while a prompt is queued clears the queued prompt before the window returns.
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  updater.emit('update-downloaded', { version: '10.0.0' })
  await new Promise(resolve => { setTimeout(resolve, 20) })
  const disabled = await state.ipc.get('ds-bot:app-update-auto')(winEvent(win), false)
  assert.deepEqual(disabled, { phase: 'downloaded', version: '10.0.0', autoInstall: false, autoUpdate: false })
  assert.equal(updaterState.autoInstallOnAppQuit, false)
  assert.deepEqual(JSON.parse(readFileSync(join(paths.userData, 'update-prefs.json'), 'utf8')), { autoUpdate: false })

  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window again')
  await new Promise(resolve => { setTimeout(resolve, 40) })
  assert.deepEqual(windowCards(win), [], 'cleared prompt must not pop when the window returns')

  // Rejects non-boolean payloads without mutating state.
  assert.throws(() => state.ipc.get('ds-bot:app-update-auto')(winEvent(win), 'yes'), /boolean/)
  assert.equal((await state.ipc.get('ds-bot:app-update-state')(winEvent(win))).autoUpdate, false)

  // Persistence failure does not mutate in-memory autoUpdate state.
  const prefsPath = join(paths.userData, 'update-prefs.json')
  rmSync(prefsPath, { force: true })
  mkdirSync(prefsPath)
  assert.throws(() => state.ipc.get('ds-bot:app-update-auto')(winEvent(win), true))
  assert.equal((await state.ipc.get('ds-bot:app-update-state')(winEvent(win))).autoUpdate, false)
  assert.equal(updaterState.autoDownload, false)
  rmSync(prefsPath, { recursive: true, force: true })

  // A Host failure while autoUpdate is off must never auto-install a downloaded update.
  hostState.crash(new Error('host crashed'))
  await waitFor(() => startState()?.view === 'failed', 'show the failure page')
  await new Promise(resolve => { setTimeout(resolve, 60) })
  assert.equal(startState()?.update, undefined, 'no update banner when autoUpdate is off')
  assert.deepEqual(updaterState.quitAndInstall, [], 'must not install when autoUpdate is off')
})

test('the app ends cleanly', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
