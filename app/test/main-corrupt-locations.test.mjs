import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { hold, state as hostState } from './helpers/fake-host-process.mjs'
import { startState, startWindows, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

process.env.HOME = paths.root
process.env.USERPROFILE = paths.root
process.env.DSH_HOME = join(paths.root, 'dsh')
delete process.env.DS_BOT_HOME

const bot = join(process.env.DSH_HOME, 'bot')
mkdirSync(bot, { recursive: true })
writeFileSync(join(bot, 'state.json'), JSON.stringify({ bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1' } }, rooms: {} }))

await installHooks()

test('a corrupt locations file remains unsaved when startup quits before the import answer', async (t) => {
  const file = join(paths.userData, 'locations.json')
  const corrupt = '{"dataDir":'
  writeFileSync(file, corrupt)
  writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  hold()
  await import('../src/main.mjs')
  t.after(() => { app.emit('will-quit') })
  await waitFor(() => startState()?.card?.kind === 'import', 'offer the team on the import card')
  assert.equal(readFileSync(file, 'utf8'), corrupt, 'do not save default locations while the offer is pending')
  assert.ok(startWindows()[0].url.endsWith('?start=first'), 'show the first-start window')

  app.quit()
  hostState.release()
  await waitFor(() => state.tray?.destroyed === true, 'end the app')
  assert.equal(readFileSync(file, 'utf8'), corrupt, 'the next startup must still offer the team')
})
