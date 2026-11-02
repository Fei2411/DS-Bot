// The first run asks where the app keeps its data, on the start page. A quit while it asks
// ends the app even when the page never answers it (#401).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp({ firstRun: true }) })

after(() => { app.emit('will-quit') })

const isStart = win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start='))

test('a quit while the first run is up ends the app', async () => {
  await waitFor(() => state.windows.some(isStart), 'the start window')
  app.quit()
  // An un-prevented quit tears the windows down; a held one quits again once the hold lifts.
  await waitFor(() => state.windows.every(win => win.destroyed), 'leave anyway')
})
