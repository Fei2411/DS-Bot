// Network proxy preferences persist in userData, configure Electron sessions on boot and on live
// IPC changes, and expose the loopback proxy bridge to the DSH Host environment.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const winEvent = (win) => {
  win.webContents.mainFrame.url = win.url
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame }
}

test('saved proxy settings apply on startup, inject Host proxy env, and update live over IPC', async () => {
  mkdirSync(paths.userData, { recursive: true })
  writeFileSync(join(paths.userData, 'proxy-prefs.json'), JSON.stringify({
    mode: 'custom',
    url: 'http://127.0.0.1:7890',
    bypass: '.corp.local',
  }))

  await startApp()
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  await handOff()

  // Startup applied saved custom proxy to defaultSession with loopback bypass.
  const initialSessionProxy = state.proxyConfigs[0]
  assert.equal(initialSessionProxy?.mode, 'fixed_servers')
  assert.equal(initialSessionProxy?.proxyRules, 'http=127.0.0.1:7890;https=127.0.0.1:7890')
  assert.match(initialSessionProxy?.proxyBypassRules ?? '', /127\.0\.0\.1/)
  assert.match(initialSessionProxy?.proxyBypassRules ?? '', /\.corp\.local/)

  // Host child process received loopback proxy bridge env vars without ALL_PROXY.
  const hostEnv = hostState.envs.at(-1)
  assert.ok(hostEnv, 'host process launched')
  assert.match(hostEnv.HTTP_PROXY ?? '', /^http:\/\/dsbot:[0-9a-f]+@127\.0\.0\.1:\d+$/u)
  assert.equal(hostEnv.HTTPS_PROXY, hostEnv.HTTP_PROXY)
  assert.equal('ALL_PROXY' in hostEnv, false)

  // IPC get returns saved settings.
  const got = await state.ipc.get('ds-bot:proxy-get')(winEvent(win))
  assert.deepEqual(got, { mode: 'custom', url: 'http://127.0.0.1:7890', bypass: '.corp.local' })

  // Switching to direct via IPC updates disk and re-applies Chromium session proxy live.
  const direct = await state.ipc.get('ds-bot:proxy-set')(winEvent(win), { mode: 'direct', url: 'http://127.0.0.1:7890', bypass: '.corp.local' })
  assert.deepEqual(direct, { mode: 'direct', url: 'http://127.0.0.1:7890', bypass: '.corp.local' })
  assert.deepEqual(state.proxyConfigs.at(-1), { mode: 'direct' })
  assert.deepEqual(JSON.parse(readFileSync(join(paths.userData, 'proxy-prefs.json'), 'utf8')), direct)

  // Switching to system updates disk and restores Chromium system proxy mode.
  const sys = await state.ipc.get('ds-bot:proxy-set')(winEvent(win), { mode: 'system', url: 'http://127.0.0.1:7890', bypass: '' })
  assert.deepEqual(sys, { mode: 'system', url: 'http://127.0.0.1:7890', bypass: '' })
  assert.deepEqual(state.proxyConfigs.at(-1), { mode: 'system' })

  // Invalid custom URL is rejected without overwriting persisted settings.
  await assert.rejects(() => state.ipc.get('ds-bot:proxy-set')(winEvent(win), { mode: 'custom', url: 'ftp://bad:21', bypass: '' }))
  assert.deepEqual(await state.ipc.get('ds-bot:proxy-get')(winEvent(win)), sys)
})

test('the app ends cleanly', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
