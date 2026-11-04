// A start that fails while a new version downloads offers it on the failure page's update banner
// instead of a message box (start-window §7): the download's progress, 〔重试〕 after a failed
// download, 「手动下载」, then the install. The Electron parts are test doubles: no display, no
// DSH, no data of the user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { messageBoxes, startAct, startApp, startState, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// Exercise the Windows installer on every runner; macOS and Linux debs open a release page.
Object.defineProperty(process, 'platform', { value: 'win32' })

const MB = 1024 * 1024

test('a failed start offers the downloading update on its banner and installs it', async () => {
  // Each check finds 9.9.9 and starts its download, which the test settles.
  const downloads = []
  updater.checkForUpdates = () => {
    updaterState.checks += 1
    const download = {}
    download.promise = new Promise((resolve, reject) => { Object.assign(download, { resolve, reject }) })
    downloads.push(download)
    return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' }, downloadPromise: download.promise })
  }
  await startApp()
  await waitFor(() => updaterState.checks === 1, 'check for an update')
  updater.emit('download-progress', { percent: 37.4, transferred: 78 * MB, total: 212 * MB })

  // The Host does not start: the failure page, with the download on its banner.
  hostState.fail = true
  hostState.release()
  await waitFor(() => startState()?.view === 'failed', 'show the failure page')
  await waitFor(() => startState().update !== undefined, 'offer the update')
  assert.deepEqual(startState().update, { state: 'downloading', version: '9.9.9', percent: 37, received: 78, total: 212 })

  // The download fails: 〔重试〕 checks again, and the new download shows its progress.
  downloads[0].reject(new Error('download failed'))
  updater.emit('error', new Error('download failed'))
  await waitFor(() => startState().update?.state === 'failed', 'say that the download failed')
  assert.equal(await startAct('installUpdate'), true)
  await waitFor(() => updaterState.checks === 2, 'check again')
  updater.emit('update-available', { version: '9.9.9' })
  updater.emit('download-progress', { percent: 64.2, transferred: 136 * MB, total: 212 * MB })
  await waitFor(() => startState().update?.percent === 64, 'show the new download')
  assert.equal(startState().update.state, 'downloading')

  // 「手动下载」 opens the release page.
  assert.equal(await startAct('manualDownload'), true)
  await waitFor(() => (state.opened ?? []).length === 1, 'open the release page')
  assert.deepEqual(state.opened, ['https://github.com/Fei2411/DS-Bot/releases/latest'])

  // Downloaded: it installs, and the Host's stop comes first.
  downloads[1].resolve()
  await waitFor(() => updaterState.quitAndInstall.length === 1, 'install the update')
  assert.equal(startState().update.state, 'installing')
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})

test('the app ends after the update', async () => {
  let left = false
  app.once('will-quit', () => { left = true })
  app.quit()
  await waitFor(() => left, 'leave')
})
