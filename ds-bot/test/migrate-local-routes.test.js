import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateLocalRoutes } from '../src/host/store.js'

// The shape migrateLocalRoutes reads: a Bot's saved model ref and the CLI records
// of its Sessions.
const team = (model, sessions = {}) => ({
  bots: { b1: { id: 'b1', name: 'Bot', model, appliedModel: model } },
  rooms: {},
  localAgents: { sessions },
})

test('a plugin provider that shares its name with a local CLI keeps its model', () => {
  // dsh-connect-qoder serves `qoder/<model>`; the Qoder CLI is `qoder` too. Without
  // evidence that this Bot ran on the CLI, the ref belongs to the plugin.
  for (const ref of ['qoder/qmodel_latest', 'qoder/qmodel_latest_preview', 'qoder-global/dfmodel']) {
    const state = team(ref)
    assert.equal(migrateLocalRoutes(state), false, ref)
    assert.equal(state.bots.b1.model, ref, ref)
    assert.equal(state.bots.b1.appliedModel, ref, ref)
  }
})

test('a Bot that ran on the Qoder CLI still follows the route it moved to', () => {
  const state = team('qoder/qmodel_latest', { s1: { route: 'qoder' } })
  state.bots.b1.sessionId = 's1'
  assert.equal(migrateLocalRoutes(state), true)
  assert.equal(state.bots.b1.model, 'local-qoder/qmodel_latest')
  assert.equal(state.bots.b1.appliedModel, undefined)
})

test('the CLI default moves even without a Session of its own', () => {
  const state = team('qoder/default')
  assert.equal(migrateLocalRoutes(state), true)
  assert.equal(state.bots.b1.model, 'local-qoder/default')
})

test('a CLI that no provider shares is still migrated for every Bot', () => {
  const state = team('codex-cli/gpt-5')
  assert.equal(migrateLocalRoutes(state), true)
  assert.equal(state.bots.b1.model, 'local-codex-cli/gpt-5')
})
