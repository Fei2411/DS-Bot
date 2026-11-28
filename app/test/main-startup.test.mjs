// Startup critical path: the start window opens without touching OS secure storage (safeStorage /
// macOS Keychain) and logs per-step timing for start()/prepare() into main.log (#2436, #2415).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { startApp, startWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  state.encryptionAvailable = true
  await startApp()
})

test('startup opens the start window without touching safeStorage on the critical path', async () => {
  await waitFor(() => startWindows().length === 1, 'open the start window')
  await waitFor(() => window() !== undefined, 'create the hidden team window')
  assert.deepEqual(
    state.safeStorageCalls,
    [],
    'safeStorage must not be called on the startup critical path before ChatGPT sign-in is used',
  )
})

test('start() and prepare() log per-step timings to main.log', async () => {
  await waitFor(() => window() !== undefined, 'finish prepare()')
  // Flush the log buffer via will-quit after checking startup lines, or inspect after quit.
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  const log = readFileSync(join(paths.userData, 'logs', 'main.log'), 'utf8')
  for (const step of ['whenReady', 'shell.install', 'setMenu', 'startWindow.open', 'hostPort', 'loadModules', 'handleIpc']) {
    assert.match(log, new RegExp(`DS Bot: startup: ${step.replace('.', '\\.')} took \\d+ ms`, 'u'), `missing timing log for ${step}`)
  }
})
