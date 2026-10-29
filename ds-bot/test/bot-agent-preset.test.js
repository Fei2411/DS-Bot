import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A Bot may pin an agent preset of its own (Fei2411/DeepSeek-Bot#341): its Sessions
// are then made with that composition. An unknown or broken pin falls back to
// `standard`, so the Bot keeps working.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamWith = bot => {
  const team = structuredClone(TEAM)
  team.bots[bot.id] = bot
  return team
}

function start({ presets, team } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-per-bot-preset-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team ?? TEAM))
  const services = presets === undefined ? {} : { agentPresets: { list: async () => presets } }
  const ctx = fakeContext({ services })
  const created = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => ({ agent: { id, session: { id } } }),
    },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, created, stop }
}

test('a Bot pinned to an agent preset makes its Session with that preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'standard' }, { id: 'researcher' }] })
  t.after(stop)
  await rt.load()
  const bot = await rt.createBot({ name: 'Scout', role: 'Scout', instructions: '', agentPreset: 'researcher' })
  assert.deepEqual(created.at(-1), { workspaceId: 'w1', agentPreset: 'researcher' })
  assert.equal(rt.botOf(bot.id).agentPreset, 'researcher')
})

test('creating a Bot with an unknown preset fails before a Session is made', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await assert.rejects(
    () => rt.createBot({ name: 'Scout', role: 'Scout', instructions: '', agentPreset: 'researcher' }),
    /No agent preset named researcher/,
  )
  assert.deepEqual(created, [])
})

test('a pinned preset the profile no longer serves falls back to standard', async (t) => {
  const { rt, created, stop } = start({
    presets: [{ id: 'standard' }],
    team: teamWith({ id: 'scout', sessionId: 'scout', name: 'Scout', role: 'Scout', instructions: '', agentPreset: 'researcher', createdAt: 1 }),
  })
  t.after(stop)
  await rt.load()
  await rt.createSession('Scout again', { agentPreset: rt.botOf('scout').agentPreset })
  assert.deepEqual(created.at(-1), { workspaceId: 'w1', agentPreset: 'standard' })
})

test('update_bot pins, changes and clears a Bot\'s agent preset', async (t) => {
  const { rt, stop } = start({ presets: [{ id: 'standard' }, { id: 'researcher' }, { id: 'coder' }] })
  t.after(stop)
  await rt.load()
  await rt.updateBot('chief', { agentPreset: 'researcher' })
  assert.equal(rt.botOf('chief').agentPreset, 'researcher')
  await rt.updateBot('chief', { agentPreset: 'coder' })
  assert.equal(rt.botOf('chief').agentPreset, 'coder')
  await assert.rejects(() => rt.updateBot('chief', { agentPreset: 'gone' }), /No agent preset named gone/)
  assert.equal(rt.botOf('chief').agentPreset, 'coder')
  await rt.updateBot('chief', { agentPreset: '' })
  assert.equal(rt.botOf('chief').agentPreset, undefined)
})

test('a Bot\'s later sessions pick up its pinned preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'standard' }, { id: 'researcher' }] })
  t.after(stop)
  await rt.load()
  await rt.updateBot('chief', { agentPreset: 'researcher' })
  await rt.createSession('Chief later', { agentPreset: rt.botOf('chief').agentPreset })
  assert.deepEqual(created.at(-1), { workspaceId: 'w1', agentPreset: 'researcher' })
})

test('list_presets lists the presets this profile serves', async (t) => {
  const { ctx, stop } = start({ presets: [{ id: 'standard' }, { id: 'researcher', broken: 'failed to start' }] })
  t.after(stop)
  const tool = ctx.registeredTools.get('list_presets')
  const text = await tool.execute({}, {})
  assert.match(text, /- standard, default/)
  assert.match(text, /- researcher \(broken\)/)
})

test('without the agentPresets service a Bot runs without a pinned preset', async (t) => {
  const { rt, created, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.createSession('Chief')
  assert.deepEqual(created, [{ workspaceId: 'w1' }])
  await assert.rejects(() => rt.updateBot('chief', { agentPreset: 'researcher' }), /No agent preset named researcher/)
})
