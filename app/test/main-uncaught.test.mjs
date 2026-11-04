// An error that nothing in the main process caught: Electron would show its own message box.
// Before the hand-off the start window's failure page says it instead, and no box opens. The
// Electron parts and the Host are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { messageBoxes, startApp, startState, startWindows, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('an error nothing caught shows the failure page, not a message box', async () => {
  const before = new Set(process.listeners('uncaughtException'))
  await startApp()
  await waitFor(() => startWindows().length === 1, 'open the start window')
  // The app's own listener (the test runner has one too, which must not see this error).
  const listener = process.listeners('uncaughtException').find(entry => !before.has(entry))
  assert.ok(listener, 'the app listens for uncaught errors')
  listener(Object.assign(new Error('EACCES: permission denied, open \'state.json\''), { code: 'EACCES' }))
  await waitFor(() => startState()?.view === 'failed', 'show the failure page')
  assert.equal(startState().failure.reason, 'permission')
  assert.deepEqual(messageBoxes(), [], 'no message box')
  assert.equal(state.dialogs.length, 0, 'no dialog of any kind')
  app.quit()
  await waitFor(() => state.tray?.destroyed === true || startWindows().every(win => win.destroyed), 'end the app')
})
