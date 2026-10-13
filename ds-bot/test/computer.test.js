import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const CUA = ['cua_driver_native__list_windows', 'cua_driver_native__get_window_state', 'cua_driver_native__click', 'cua_driver_native__type_text']

// Chief and Dev, with Dev also in the group Session 'gb1'. The agents service knows
// 'sub1', a subagent Dev started, 'sub2', one that sub1 started, and 'free', a
// subagent of a Session that is not a Bot.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: '', instructions: '', createdAt: 1 },
    b1: { id: 'b1', sessionId: 'b1', name: 'Dev', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['m1', 'b1'], mode: 'admin', admin: 'm1', named: true, sessions: { b1: 'gb1' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
}

const agentFor = (id, parentSession) => ({ id, session: { id, header: { id, ...(parentSession ? { parentSession } : {}) } } })

function start({ provider = 'cua-driver-native', policy = 'ask' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const known = new Map([['sub1', agentFor('sub1', 'b1')], ['sub2', agentFor('sub2', 'sub1')], ['free', agentFor('free', 'plain')]])
  const ctx = fakeContext({
    services: {
      computerUse: provider === null ? undefined : { providerName: provider },
      agents: { get: id => known.get(id) },
      approval: { effectivePolicy: () => policy },
    },
  })
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'read', ...CUA].map(name => ({ name }))
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'sx' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, ctx: { tools: { restrict: () => () => {} } }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const gate = (name, id = 'b1') => ctx.listeners.get('tools/pre-execute')[0]({ name, agent: known.get(id) ?? agentFor(id) }, async () => ({ kind: 'allow' }))
  const step = agent => ctx.listeners.get('agent/pre-step')[0]({ agent }, async () => 'next')
  const stop = () => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) }
  return { ctx, call, gate, step, stop }
}

test('a Bot with computer use off is denied every computer-use tool', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  assert.equal((await gate('cua_driver_native__list_windows')).kind, 'deny')
  assert.equal((await gate('mcp__cua-driver-mcp__click')).kind, 'deny')
})

test('look-only allows reading tools and denies actions; act asks before actions', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  assert.equal((await call('update-bot', { id: 'b1', computerUse: 'view' })).ok, true)
  assert.equal((await gate('cua_driver_native__get_window_state')).kind, 'allow')
  assert.equal((await gate('cua_driver_native__click')).kind, 'deny')
  await call('update-bot', { id: 'b1', computerUse: 'act' })
  assert.equal((await gate('cua_driver_native__get_window_state')).kind, 'allow')
  assert.deepEqual(await gate('cua_driver_native__type_text'), { kind: 'ask', reason: 'Dev wants to use the computer: type_text' })
})

test('a Bot acts only in its own chat; its group Sessions and subagents only look', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  await call('update-bot', { id: 'b1', computerUse: 'act' })
  for (const id of ['gb1', 'sub1', 'sub2']) {
    assert.equal((await gate('cua_driver_native__list_windows', id)).kind, 'allow', id)
    const denied = await gate('cua_driver_native__click', id)
    assert.equal(denied.kind, 'deny', id)
    assert.match(denied.reason, /only in its own chat/)
  }
})

test('a subagent works under the mode of the Bot that started it', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  assert.equal((await gate('cua_driver_native__list_windows', 'sub2')).kind, 'deny')
  await call('update-bot', { id: 'b1', computerUse: 'view' })
  assert.equal((await gate('cua_driver_native__list_windows', 'sub2')).kind, 'allow')
  // A subagent of a Session that is not a Bot is not the team's to limit.
  assert.equal((await gate('cua_driver_native__click', 'free')).kind, 'allow')
})

test('with approval prompts off, an action is denied with the reason, not asked', async (t) => {
  const { call, gate, stop } = start({ policy: 'never' })
  t.after(stop)
  await call('state', {})
  await call('update-bot', { id: 'b1', computerUse: 'act' })
  const denied = await gate('cua_driver_native__click')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /turns approval prompts off/)
  assert.equal((await gate('cua_driver_native__list_windows')).kind, 'allow')
})

test('tools of other Sessions and other plugins pass through', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  assert.equal((await gate('cua_driver_native__click', 'someone-else')).kind, 'allow')
  assert.equal((await gate('read')).kind, 'allow')
})

test('update-bot keeps only known modes and the view reports the provider', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  await call('state', {})
  // A refused mode changes nothing else in the same patch.
  assert.equal((await call('update-bot', { id: 'b1', computerUse: 'everything', role: 'Coder' })).ok, false)
  let view = (await call('state', {})).value
  assert.equal(view.bots.find(bot => bot.id === 'b1').role, '')
  await call('update-bot', { id: 'b1', computerUse: 'act' })
  view = (await call('state', {})).value
  assert.equal(view.computer, true)
  assert.equal(view.bots.find(bot => bot.id === 'b1').computerUse, 'act')
  await call('update-bot', { id: 'b1', computerUse: 'off' })
  view = (await call('state', {})).value
  assert.equal(view.bots.find(bot => bot.id === 'b1').computerUse, undefined)
})

test('a Bot cannot turn on computer use with update_bot', async (t) => {
  const { ctx, call, gate, stop } = start()
  t.after(stop)
  await call('state', {})
  await ctx.registeredTools.get('update_bot').execute({ computerUse: 'act' }, { agent: { id: 'b1' } }).catch(() => {})
  await ctx.registeredTools.get('update_bot').execute({ bot: 'Dev', computerUse: 'act' }, { agent: { id: 'm1' } }).catch(() => {})
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === 'b1').computerUse, undefined)
  assert.equal((await gate('cua_driver_native__list_windows')).kind, 'deny')
})

test('without a provider the view offers no mode', async (t) => {
  const { call, stop } = start({ provider: null })
  t.after(stop)
  assert.equal((await call('state', {})).value.computer, false)
})

test('a provider whose tools DS Bot cannot tell apart gets no mode', async (t) => {
  const { ctx, call, stop } = start({ provider: 'other-driver' })
  t.after(stop)
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  assert.equal((await call('state', {})).value.computer, false)
  await call('state', {})
  assert.equal(warnings.filter(line => line.includes('provider other-driver is not supported')).length, 1)
})

test('each step hides the tools the mode does not allow, and a change undoes it', async (t) => {
  const { call, step, stop } = start()
  t.after(stop)
  await call('state', {})
  const denied = []
  let undone = 0
  const agent = { id: 'b1', ctx: { tools: { restrict: ({ deny }) => { denied.push(deny); return () => { undone += 1 } } } } }
  assert.equal(await step(agent), 'next')
  assert.deepEqual(denied.at(-1), CUA)
  await step(agent)
  assert.equal(denied.length, 1)
  // The change applies before the next step starts, not one step later.
  await call('update-bot', { id: 'b1', computerUse: 'view' })
  assert.equal(undone, 1)
  assert.deepEqual(denied.at(-1), ['cua_driver_native__click', 'cua_driver_native__type_text'])
  await call('update-bot', { id: 'b1', computerUse: 'act' })
  assert.equal(undone, 2)
  await step(agent)
  assert.equal(denied.length, 2)

  // In a group Session the same Bot keeps only the tools that look.
  const group = { id: 'gb1', ctx: { tools: { restrict: ({ deny }) => { denied.push(deny); return () => {} } } } }
  await step(group)
  assert.deepEqual(denied.at(-1), ['cua_driver_native__click', 'cua_driver_native__type_text'])
})
