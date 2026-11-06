// The import's copy has no stop button (start-window §6): quitting the app, or closing the start
// window, is how a copy is stopped. The quit waits for the copy to stop at a safe point, then
// goes through, and nothing of the copy is left. The home and the DSH home are throwaway
// folders, so the test never sees the user's own; the Electron parts and the Host are test doubles.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { hold, state as hostState } from './helpers/fake-host-process.mjs'
import { startAct, startState, startWindows, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

const home = mkdtempSync(join(tmpdir(), 'ds-bot-import-quit-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
delete process.env.DS_BOT_HOME
delete process.env.DS_BOT_WORKSPACE

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const dsh = process.env.DSH_HOME
write(join(dsh, 'bot', 'state.json'), JSON.stringify({ bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1' } }, rooms: {} }))
write(join(dsh, 'sessions', 'g', 's1', 'notes.txt'), 'one')

await installHooks()

test('quitting during the copy stops it, then quits, and leaves no team behind', async () => {
  mkdirSync(paths.userData, { recursive: true })
  writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  // The Host waits: the chats' check, and with it the copy, stays under way until the quit.
  hold()
  await import('../src/main.mjs')
  await waitFor(() => startState()?.card?.kind === 'import', 'offer the team on the import card')
  await startAct('answer', 'copy')
  await waitFor(() => startState().card?.kind === 'copying', 'start the copy')

  app.quit()
  assert.equal(state.quitPrevented, true, 'the quit waits for the copy to stop')
  await waitFor(() => state.quits >= 2 && state.quitPrevented === false, 'quit once the copy has stopped')
  hostState.release()
  await waitFor(() => startWindows().every(win => win.destroyed), 'close the start window')

  const data = join(home, '.ds-bot')
  assert.equal(existsSync(join(data, 'bot', 'imported.json')), false, 'no copied team')
  // The check's folder goes once its Host, held until now, has stopped.
  const left = () => (existsSync(data) ? readdirSync(data).filter(name => name.startsWith('.import-')) : [])
  await waitFor(() => left().length === 0, `leave no copy or check folder behind (${left().join(', ')})`)
})
