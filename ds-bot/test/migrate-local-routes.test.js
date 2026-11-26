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

test('a plugin default named like the Qoder CLI keeps its model', () => {
  // The Qoder CLI shipped as `local-qoder`, so no bare `qoder` ref was ever the CLI.
  const state = team('qoder/default', { s1: { route: 'qoder' } })
  state.bots.b1.sessionId = 's1'
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'qoder/default')
  assert.equal(state.bots.b1.appliedModel, 'qoder/default')
})

test('a plugin provider that shares the Antigravity CLI name keeps its model', () => {
  // dsh-llm-antigravity-acp serves `antigravity/<model>`; the Antigravity CLI is
  // `antigravity` too. Without evidence that this Bot ran on the CLI, the ref belongs
  // to the plugin.
  for (const ref of ['antigravity/gemini-4-neon', 'antigravity/gemini-4.5-pro']) {
    const state = team(ref)
    assert.equal(migrateLocalRoutes(state), false, ref)
    assert.equal(state.bots.b1.model, ref, ref)
    assert.equal(state.bots.b1.appliedModel, ref, ref)
  }
})

test('a plugin default named like the Antigravity CLI keeps its model', () => {
  // The Antigravity CLI shipped as `local-antigravity`, so no bare `antigravity`
  // ref was ever the CLI.
  const state = team('antigravity/default', { s1: { route: 'antigravity' } })
  state.bots.b1.sessionId = 's1'
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'antigravity/default')
  assert.equal(state.bots.b1.appliedModel, 'antigravity/default')
})

test('a route already on local-antigravity is left alone', () => {
  for (const ref of ['local-antigravity/gemini-4-neon', 'local-antigravity/default']) {
    const state = team(ref)
    assert.equal(migrateLocalRoutes(state), false, ref)
    assert.equal(state.bots.b1.model, ref, ref)
    assert.equal(state.bots.b1.appliedModel, ref, ref)
  }
})

test('a CLI that no provider shares is still migrated for every Bot', () => {
  const state = team('codex-cli/gpt-5')
  assert.equal(migrateLocalRoutes(state), true)
  assert.equal(state.bots.b1.model, 'local-codex-cli/gpt-5')
})

test('a plugin provider that shares the Mistral Vibe CLI name keeps its model', () => {
  // llm-pi-ai can register a remote provider called `mistral-vibe`; the Mistral Vibe
  // CLI is `mistral-vibe` too (#2104). Without evidence that this Bot ran on the
  // CLI, the ref belongs to the provider.
  const state = team('mistral-vibe/deepseek-v4-1-flash-1017')
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'mistral-vibe/deepseek-v4-1-flash-1017')
  assert.equal(state.bots.b1.appliedModel, 'mistral-vibe/deepseek-v4-1-flash-1017')
})

test('a CLI added after the prefix never had an old route', () => {
  // Mistral Vibe shipped as `local-mistral-vibe`, so even its "CLI default" or a
  // CLI record under the bare name belongs to a provider called `mistral-vibe`.
  const state = team('mistral-vibe/default', { s1: { route: 'mistral-vibe' } })
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'mistral-vibe/default')
  assert.equal(state.bots.b1.appliedModel, 'mistral-vibe/default')
  assert.equal(state.localAgents.sessions.s1.route, 'mistral-vibe')
})

test('a ref saved after the team moved its routes is never migrated', () => {
  // Since the move, a local agent is only ever saved under `local-`, so an
  // unprefixed CLI name is a provider of the same name (#2104).
  const state = team('codex-cli/gpt-5')
  state.localRoutesMoved = true
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'codex-cli/gpt-5')
  assert.equal(state.bots.b1.appliedModel, 'codex-cli/gpt-5')
})

test('a migrated team is marked so later loads leave its refs alone', () => {
  const state = team('codex-cli/gpt-5')
  assert.equal(migrateLocalRoutes(state), true)
  assert.equal(state.localRoutesMoved, true)
  state.bots.b1.model = 'codex-cli/remote-model'
  assert.equal(migrateLocalRoutes(state), false)
  assert.equal(state.bots.b1.model, 'codex-cli/remote-model')
})
