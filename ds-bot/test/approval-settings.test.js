import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/permissions.js'

function setup() {
  const agents = new Map()
  const policies = new Map()
  const modes = new Map()
  const cancelled = []
  const closed = []
  const bot = { id: 'b', permission: 'danger-full-access' }
  const room = { id: 'r', sessions: { b: 'g' } }
  const preset = {
    // A profile may offer full access only; review still supplies its own sandbox.
    catalog: () => ({ defaultPreset: 'danger-full-access', options: [{ value: 'danger-full-access' }, { value: 'auto' }] }),
    resolve: name => {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error('unknown preset')
      return { approval: name === 'danger-full-access' ? 'never' : 'ask', sandbox: name }
    },
    set(session, name) { modes.set(session.id, name); policies.set(session.id, this.resolve(name).approval) },
  }
  const approval = {
    effectivePolicy: session => policies.get(session.id) ?? 'never',
    setPolicy(agent, policy) { policies.set(agent.id, policy) },
  }
  const sandboxPolicy = { resolve: ({ session }) => ({ mode: modes.get(session.id) ?? 'danger-full-access' }) }
  const rt = { state: {}, ctx: { get: name => ({ approval, permissionPresets: preset, sandboxPolicy })[name] },
    groupOwners: new Map([['g', { roomId: 'r', botId: 'b' }]]), chatOwners: new Map([['b', 'b']]),
    botOf: id => id === 'b' ? bot : undefined, roomOf: id => id === 'r' ? room : undefined,
    chatOf: () => 'b', groupSessionsOf: () => ['g'], warn() {},
    cancelApprovalReviews: owner => cancelled.push(owner),
    closeLocalAgentSession: async id => closed.push(id),
    resolveAgent: async id => {
      if (!agents.has(id)) agents.set(id, { id, session: { id, header: {}, append(type, data) { assert.equal(type, 'sandbox/mode'); modes.set(id, data.mode) } } })
      return agents.get(id)
    },
  }
  install(rt)
  return { rt, bot, room, modes, policies, agents, cancelled, closed }
}

test('review is a mutually exclusive mode even in a full-access-only catalog', async () => {
  const { rt, bot, modes, policies } = setup()
  assert.deepEqual(rt.permissionCatalog().options.map(option => option.value), ['danger-full-access', 'review'])
  await rt.setPermission(bot, 'review')
  assert.equal(bot.permission, 'review')
  assert.equal(policies.get('b'), 'ask')
  assert.equal(modes.get('b'), 'workspace-write')
  await rt.setPermission(bot, 'danger-full-access')
  assert.equal(policies.get('b'), 'never')
  assert.equal(modes.get('b'), 'danger-full-access')
  await rt.setPermission(bot, 'review')
  await rt.setPermission(bot, 'read-only')
  assert.equal(policies.get('b'), 'ask')
  assert.equal(modes.get('b'), 'read-only')
  assert.equal(bot.permission, 'read-only')
})

test('groups inherit member review unless they select a shared mode', async () => {
  const { rt, bot, room, policies, modes, cancelled } = setup()
  await rt.setPermission(bot, 'review')
  assert.equal(policies.get('g'), 'ask')
  assert.equal(modes.get('g'), 'workspace-write')
  assert.deepEqual(cancelled, [{ botId: 'b' }, { botId: 'b', roomId: 'r' }])
  await rt.setRoomPermission(room, 'danger-full-access')
  assert.equal(policies.get('g'), 'never')
  await rt.setPermission(bot, 'read-only')
  assert.equal(modes.get('g'), 'danger-full-access')
  await rt.setRoomPermission(room, 'review')
  await rt.applyPermission(bot, 'fresh-group', room)
  assert.equal(policies.get('fresh-group'), 'ask')
  assert.equal(modes.get('fresh-group'), 'workspace-write')
  assert.equal(modes.get('b'), 'read-only')
  await rt.setRoomPermission(room, null)
  assert.equal(modes.get('g'), 'read-only')
  await rt.setPermission(bot, 'review')
  await rt.applyPermission(bot, 'fresh-private')
  assert.equal(modes.get('fresh-private'), 'workspace-write')
})

test('children inherit review, keep read-only boundaries and cap full access', async () => {
  const { rt, bot, policies, modes } = setup()
  await rt.setPermission(bot, 'review')
  for (const mode of ['read-only', 'danger-full-access']) {
    const child = await rt.resolveAgent(mode)
    child.session.header.parentSession = 'b'
    child.session.header.origin = 'subagent'
    modes.set(child.id, mode)
    await rt.applyReviewPolicy(child)
    assert.equal(policies.get(child.id), 'ask')
    assert.equal(modes.get(child.id), mode === 'read-only' ? mode : 'workspace-write')
  }
  await rt.setPermission(bot, 'danger-full-access')
  const child = await rt.resolveAgent('read-only')
  await rt.applyReviewPolicy(child)
  assert.equal(policies.get(child.id), 'never')
  assert.equal(modes.get(child.id), 'read-only')
  assert.equal(rt.state.approvalPolicies[child.id], undefined)
})

test('user forks and their children never inherit Bot review policy', async () => {
  const { rt, bot, policies, modes } = setup()
  await rt.setPermission(bot, 'review')
  const fork = await rt.resolveAgent('fork')
  fork.session.header = { parentSession: 'b', origin: 'user' }
  const child = await rt.resolveAgent('fork-child')
  child.session.header = { parentSession: 'fork', origin: 'subagent' }
  for (const agent of [fork, child]) {
    policies.set(agent.id, 'never')
    modes.set(agent.id, 'read-only')
    await rt.applyReviewPolicy(agent)
    assert.equal(policies.get(agent.id), 'never')
    assert.equal(modes.get(agent.id), 'read-only')
    assert.equal(rt.state.approvalPolicies?.[agent.id], undefined)
  }
})

test('a late resolution cannot stop a resumed CLI or apply an older mode', async () => {
  const { rt, bot, policies, modes, closed } = setup()
  const resolve = rt.resolveAgent
  let release
  rt.resolveAgent = async id => { if (!release) await new Promise(done => { release = done }); return resolve(id) }
  const first = rt.setPermission(bot, 'review')
  await rt.setPermission(bot, 'danger-full-access')
  closed.length = 0
  release()
  await first
  assert.deepEqual(closed, [], 'the superseded request leaves the newly resumed CLI alone')
  assert.equal(bot.permission, 'danger-full-access')
  assert.equal(modes.get('b'), 'danger-full-access')
  assert.equal(policies.get('b'), 'never')
})

test('a request superseded while its CLI closes cannot apply the old preset', async () => {
  const { rt, bot, policies, modes } = setup()
  let release
  let started
  const reached = new Promise(resolve => { started = resolve })
  const holding = new Promise(resolve => { release = resolve })
  let calls = 0
  rt.closeLocalAgentSession = async () => { if (++calls === 1) { started(); await holding } }
  const first = rt.setPermission(bot, 'review')
  await reached
  await rt.setPermission(bot, 'danger-full-access')
  release()
  await first
  assert.equal(modes.get('b'), 'danger-full-access')
  assert.equal(policies.get('b'), 'never')
})

for (const stage of ['resolve', 'close']) for (const next of [null, 'read-only']) {
  test('superseded group update stops restarting members after ' + stage + ' before ' + next, async () => {
    const { rt, bot, room, modes, closed } = setup()
    const peer = { id: 'c', permission: 'workspace-write' }
    room.sessions.c = 'g2'
    rt.botOf = id => id === 'b' ? bot : id === 'c' ? peer : undefined
    let release
    let started
    const holding = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { started = resolve })
    const key = stage === 'resolve' ? 'resolveAgent' : 'closeLocalAgentSession'
    const original = rt[key]
    let calls = 0
    rt[key] = async (...args) => {
      if (++calls === 1) { started(); await holding }
      return original(...args)
    }
    const first = rt.setRoomPermission(room, 'review')
    await reached
    await rt.setRoomPermission(room, next)
    closed.length = 0
    release()
    await first
    assert.deepEqual(closed, stage === 'close' ? ['g'] : [], 'an already-started close may finish; no new close starts')
    assert.equal(room.permission, next ?? undefined)
    assert.equal(modes.get('g'), next ?? bot.permission)
    assert.equal(modes.get('g2'), next ?? peer.permission)
  })
}

for (const heldSession of ['b', 'g']) for (const inheritAgain of [false, true]) test('Bot update respects a newer group override at ' + heldSession + '; inherited again=' + inheritAgain, async () => {
  const { rt, bot, room, modes, closed } = setup()
  const original = rt.resolveAgent
  let release
  let started
  const reached = new Promise(resolve => { started = resolve })
  let held = false
  rt.resolveAgent = async id => {
    if (id === heldSession && !held) {
      held = true
      started()
      await new Promise(resolve => { release = resolve })
    }
    return original(id)
  }
  const first = rt.setPermission(bot, 'review')
  await reached
  await rt.setRoomPermission(room, 'read-only')
  if (inheritAgain) await rt.setRoomPermission(room, null)
  closed.length = 0
  release()
  await first
  assert.deepEqual(closed, heldSession === 'b' ? ['b'] : [], 'the Bot request must not close the CLI restarted by a newer group save')
  assert.equal(modes.get('g'), inheritAgain ? 'workspace-write' : 'read-only')
})

for (const heldSession of ['g0', 'g']) test('inherited group update respects a newer Bot update while resolving ' + heldSession, async () => {
  const { rt, bot, room, modes, closed } = setup()
  const peer = { id: 'c', permission: 'workspace-write' }
  room.sessions = { c: 'g0', b: 'g' }
  room.permission = 'review'
  rt.botOf = id => id === 'b' ? bot : id === 'c' ? peer : undefined
  const original = rt.resolveAgent
  let release
  let started
  const reached = new Promise(resolve => { started = resolve })
  let held = false
  rt.resolveAgent = async id => {
    if (id === heldSession && !held) {
      held = true
      started()
      await new Promise(resolve => { release = resolve })
    }
    return original(id)
  }
  const first = rt.setRoomPermission(room, null)
  await reached
  await rt.setPermission(bot, 'read-only')
  closed.length = 0
  release()
  await first
  assert.deepEqual(closed.filter(id => id === 'g'), [], 'the group request leaves the newly resumed member alone')
  assert.equal(modes.get('g'), 'read-only')
  assert.equal(modes.get('g0'), 'workspace-write')
})

test('mode changes reopen affected CLI sessions, ordinary turn setup keeps them', async () => {
  const { rt, bot, room, closed } = setup()
  await rt.setPermission(bot, 'review')
  assert.deepEqual(closed, ['b', 'g'])
  closed.length = 0
  await rt.applyPermission(bot, 'b')
  assert.deepEqual(closed, [])
  await rt.setRoomPermission(room, 'danger-full-access')
  assert.deepEqual(closed, ['g'])
  closed.length = 0
  await rt.setPermission(bot, 'workspace-write')
  assert.deepEqual(closed, ['b'])
})

test('applying an explicit mode clears legacy saved policy on that Session', async () => {
  const { rt, bot, policies } = setup()
  rt.state.approvalPolicies = { b: 'never' }
  await rt.setPermission(bot, 'workspace-write')
  await rt.applyReviewPolicy(await rt.resolveAgent('b'))
  assert.equal(policies.get('b'), 'ask')
  assert.equal(rt.state.approvalPolicies.b, undefined)
})
