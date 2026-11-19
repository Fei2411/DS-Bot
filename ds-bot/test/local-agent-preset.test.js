import assert from 'node:assert/strict'
import { test } from 'node:test'
import { presetOf } from '../src/host/local-agents/index.js'
import { cliMode } from '../src/host/local-agents/engines.js'

// #1539: a Bot with no preset of its own runs on DSH's default preset, the one the user
// is shown (permissions.js keeps that applied to the Session). A hard-coded
// workspace-write opened the local agent in a stricter mode than the setting, so a Bash
// call went through the CLI's permission prompt and, with approvals off, was denied.
function runtime({ defaultPreset = 'danger-full-access', catalog = true } = {}) {
  const bots = { b: { id: 'b', name: 'Writer' } }
  return {
    bots,
    rt: {
      botOf: id => bots[id],
      selfOf: id => (id === 'g1' || id === 'chat' ? 'b' : undefined),
      groupOwners: new Map([['g1', { botId: 'b', roomId: 'r1' }]]),
      roomOf: id => (id === 'r1' ? { id: 'r1', name: 'Ops', permission: 'read-only' } : undefined),
      permissionCatalog: catalog ? () => ({ defaultPreset, options: [] }) : () => undefined,
    },
  }
}

test('a Bot without a preset runs a local agent on the profile default', () => {
  const { rt } = runtime()
  // The Bot's own chat: the profile's default, and the mode the CLI opens with.
  assert.equal(presetOf(rt, 'chat'), 'danger-full-access')
  assert.equal(cliMode('claude', presetOf(rt, 'chat')), 'bypassPermissions')
})

test('the group preset wins, then the Bot\'s own, then the profile default', () => {
  const { bots, rt } = runtime({ defaultPreset: 'workspace-write' })
  assert.equal(presetOf(rt, 'g1'), 'read-only')
  bots.b.permission = 'danger-full-access'
  assert.equal(presetOf(rt, 'chat'), 'danger-full-access')
  assert.equal(cliMode('claude', presetOf(rt, 'chat')), 'bypassPermissions')
})

test('without a permission service the old fallback stands', () => {
  const { rt } = runtime({ catalog: false })
  assert.equal(presetOf(rt, 'chat'), 'workspace-write')
  assert.equal(cliMode('claude', presetOf(rt, 'chat')), 'acceptEdits')
})
