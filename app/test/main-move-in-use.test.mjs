// A move that finds another DSH on the data says so on a card on the moving page instead of a
// message box, and goes on by itself once that DSH is closed (start-window §5). The Electron
// parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { messageBoxes, moveFromStart, startState, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('a move waits on a card while another DSH uses the data, and goes on once it is closed', async () => {
  const to = join(mkdtempSync(join(tmpdir(), 'ds-bot-move-')), 'data')
  const lock = home => join(home, 'bot', 'state.lock')
  const { home } = await moveFromStart(to, {
    before: ({ home: dataDir }) => {
      mkdirSync(join(dataDir, 'bot'), { recursive: true })
      writeFileSync(lock(dataDir), JSON.stringify({ host: hostname(), pid: process.pid }))
    },
  })
  await waitFor(() => startState().card?.kind === 'moveFailed', 'say that another DSH uses the data')
  assert.equal(startState().start, 'moving')
  assert.deepEqual(startState().card, { kind: 'moveFailed', dataDir: home, why: 'inUse' })
  assert.equal(existsSync(to), false, 'nothing is copied meanwhile')
  assert.equal(state.relaunches.length, 0)

  rmSync(lock(home))
  await waitFor(() => state.relaunches.length === 1, 'go on with the move once the data is free')
  assert.ok(existsSync(to), 'the data was copied')
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')).dataDir, to)
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})
