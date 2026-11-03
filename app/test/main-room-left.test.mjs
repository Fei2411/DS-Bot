// A later start whose drive still has more than a fifth of the free space it had when the data
// went there shows no place line (start-window §5). That free space stays with the data's folder
// when the team workspace changes, and the move from Settings (ds-bot:move-data) still asks,
// copies and starts again on the new folder, which keeps its own. The Electron parts are test
// doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, startWindows, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const saved = () => JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8'))

test('a later start with room to spare shows no place line; Settings still moves the data', async () => {
  const { home } = await startApp({ saved: { freeAtStart: 1 } })
  await waitFor(() => startWindows().length === 1, 'open the start window')
  const start = startWindows()[0]
  await waitFor(() => window() !== undefined, 'build the team window')
  hostState.release()
  await handOff()
  const snapshots = start.webContents.sent.filter(([channel]) => channel === 'ds-bot:start-state').map(([, snapshot]) => snapshot)
  assert.ok(snapshots.length > 0)
  assert.ok(snapshots.every(snapshot => snapshot.place === undefined), 'no place line')
  assert.equal(saved().freeAtStart, 1)

  // A new team workspace keeps the free space the data's folder had.
  const win = window()
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const workspace = join(home, 'other-workspace')
  state.ipc.get('ds-bot:team-workspace')(event, workspace)
  assert.deepEqual({ workspace: saved().workspace, freeAtStart: saved().freeAtStart }, { workspace, freeAtStart: 1 })

  // The move from Settings: its picker and its question.
  const to = join(mkdtempSync(join(tmpdir(), 'ds-bot-move-')), 'data')
  state.openAnswer = { canceled: false, filePaths: [to] }
  state.dialogAnswer = { response: 0 }
  assert.equal(await state.ipc.get('ds-bot:move-data')(event, workspace), true)
  assert.equal(state.relaunches.length, 1)
  assert.ok(existsSync(to), 'the data was copied')
  assert.equal(saved().dataDir, to)
  assert.ok(saved().freeAtStart > 1, 'the new folder keeps its own free space')
})
