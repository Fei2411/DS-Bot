import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { hold, state as hostState } from './helpers/fake-host-process.mjs'
import { waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

process.env.HOME = paths.root
process.env.USERPROFILE = paths.root
process.env.DSH_HOME = join(paths.root, 'dsh')
process.env.DS_BOT_UPDATE_URL = 'data:application/json,%5B%5D'
delete process.env.DS_BOT_HOME

await installHooks()

test('startup uses the defaults but keeps both corrupt location records', { timeout: 10_000 }, async (t) => {
  const file = join(paths.userData, 'locations.json')
  const defaults = { dataDir: join(paths.root, '.ds-bot'), workspace: join(paths.root, 'DS Bot') }
  const truncated = name => Buffer.from(`{\r\n"dataDir":${JSON.stringify(join(paths.root, name))},\r\n"workspace":${JSON.stringify(join(paths.root, `${name} work`))},\r\n"freeAtStart":`)
  const first = truncated('custom')
  const second = truncated('custom again')
  const timestamp = t.mock.method(Date, 'now', () => 123)
  const warn = t.mock.method(console, 'warn', () => {})
  const { chooseLocations } = await import('../src/first-run.mjs')

  writeFileSync(file, first)
  assert.deepEqual(chooseLocations(), defaults)
  writeFileSync(file, second)
  writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  hold()
  await import('../src/main.mjs')
  t.after(() => { app.emit('will-quit') })
  await waitFor(() => hostState.envs.length > 0, 'start the Host')
  timestamp.mock.restore()

  assert.equal(hostState.envs[0].DSH_HOME, defaults.dataDir)
  assert.equal(hostState.envs[0].DS_BOT_WORKSPACE, defaults.workspace)
  const { dataDir, workspace } = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual({ dataDir, workspace }, defaults)
  const backup = `${file}.corrupt-123`
  assert.deepEqual(readFileSync(backup), first)
  assert.deepEqual(readFileSync(`${backup}-1`), second)
  assert.ok(warn.mock.calls.some(({ arguments: args }) => args[0].includes(`${backup}-1`)), 'warn with the recovery copy path')

  app.quit()
  hostState.release()
  await waitFor(() => state.tray?.destroyed === true, 'end the app')
})
