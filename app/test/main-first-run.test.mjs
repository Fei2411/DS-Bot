// The first run asks where the app keeps its data. A quit while it asks ends the app
// even when the dialog never answers it (#401), and the places stay unwritten.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  // The first-run dialog never answers.
  state.dialogAnswer = () => new Promise(() => {})
  await startApp({ firstRun: true })
})

after(() => { app.emit('will-quit') })

test('a quit while the first run is asking ends the app even when the dialog never answers', async () => {
  await waitFor(() => state.dialogs.length > 0, 'ask for the places')
  app.quit()
  assert.equal(state.quitPrevented, true, 'the quit waits for the first run')
  await waitFor(() => state.exits.length > 0, 'leave anyway')
  assert.equal(state.exits[0], 0)
})

test('the first run that is quit wrote nothing', () => {
  assert.equal(existsSync(join(paths.userData, 'locations.json')), false)
})
