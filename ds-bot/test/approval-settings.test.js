import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/permissions.js'

function setup() {
  const agents = new Map()
  const policies = new Map()
  const modes = new Map()
  const bot = { id: 'b', permission: 'danger-full-access' }
  const room = { id: 'r', sessions: { b: 'g' } }
  const preset = {
    catalog: () => ({ defaultPreset: 'workspace-write', options: [] }),
    resolve: name => ({ approval: name === 'danger-full-access' ? 'never' : 'ask', sandbox: name }),
    set(session, name) { modes.set(session.id, name); policies.set(session.id, this.resolve(name).approval) },
  }
  const approval = {
    effectivePolicy: session => policies.get(session.id) ?? 'never',
    setPolicy(agent, policy) { policies.set(agent.id, policy) },
  }
  const rt = { state: {}, ctx: { get: name => ({ approval, permissionPresets: preset })[name] },
    groupOwners: new Map([['g', { roomId: 'r', botId: 'b' }]]), chatOwners: new Map([['b', 'b']]),
    botOf: id => id === 'b' ? bot : undefined, roomOf: id => id === 'r' ? room : undefined,
    chatOf: () => 'b', groupSessionsOf: () => ['g'], warn() {},
    resolveAgent: async id => {
      if (!agents.has(id)) agents.set(id, { id, session: { id, header: {} } })
      return agents.get(id)
    },
  }
  install(rt)
  return { rt, bot, room, modes, policies, agents }
}

test('enabling review changes approval policy only; disabling restores it', async () => {
  const { rt, bot, modes, policies } = setup()
  await rt.applyPermission(bot, 'b')
  await rt.setAutoApprove(bot, true)
  assert.equal(policies.get('b'), 'ask')
  assert.equal(modes.get('b'), 'danger-full-access')
  await rt.setAutoApprove(bot, false)
  assert.equal(policies.get('b'), 'never')
  assert.equal(modes.get('b'), 'danger-full-access')
})

test('group review is independent of the private chat and survives a fresh session', async () => {
  const { rt, bot, room, policies, modes } = setup()
  await rt.setAutoApprove(bot, true)
  await rt.applyPermission(bot, 'g', room)
  assert.equal(policies.get('g'), 'never')
  await rt.setAutoApprove(room, true, true)
  assert.equal(policies.get('g'), 'ask')
  await rt.applyPermission(bot, 'fresh-group', room)
  assert.equal(policies.get('fresh-group'), 'ask')
  assert.equal(modes.get('fresh-group'), 'danger-full-access')
  await rt.setAutoApprove(bot, false)
  assert.equal(policies.get('g'), 'ask')
})

test('changing sandbox while reviewing keeps ask and restores the new preset policy', async () => {
  const { rt, bot, policies, modes } = setup()
  await rt.setAutoApprove(bot, true)
  await rt.setPermission(bot, 'workspace-write')
  assert.equal(policies.get('b'), 'ask')
  await rt.setAutoApprove(bot, false)
  assert.equal(policies.get('b'), 'ask')
  assert.equal(modes.get('b'), 'workspace-write')
})

test('a child inherits its owner review without changing its sandbox', async () => {
  const { rt, bot, policies, agents, modes } = setup()
  await rt.setAutoApprove(bot, true)
  const child = { id: 'child', session: { id: 'child', header: { parentSession: 'b' } } }
  agents.set('child', child)
  modes.set('child', 'read-only')
  await rt.applyAutoApproval(child)
  assert.equal(policies.get('child'), 'ask')
  assert.equal(modes.get('child'), 'read-only')
})
