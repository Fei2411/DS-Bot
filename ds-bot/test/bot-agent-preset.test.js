import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A Bot may run its own DSH Agent preset: the pick is stored on the Bot, every Session
// it speaks from is made with it, and a changed pick moves those Sessions on to fresh
// parts (a Session keeps the composition it was made with). The standard default stays
// for Bots without a pick, and the group's own relay Session keeps it too.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  workspaceId: 'w1',
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const ROSTER = [{ id: 'standard', name: 'Standard', description: 'Everyday work' }, { id: 'research', name: 'Research' }]

let rt
// Enough of DSH for Bot Sessions, with the preset roster, the recorded preset of each
// Session (its header), and a switch that can be told to fail.
function start({ presets = ROSTER, team = TEAM, home: reuse } = {}) {
  const home = reuse ?? mkdtempSync(join(tmpdir(), 'ds-bot-bot-preset-'))
  if (reuse === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const services = {}
  const headers = new Map()
  // Presets whose composition replaces the Bot's own prompt (a complete persona).
  const complete = new Set()
  // `presets: null` is a profile that mounts no Agent preset roster at all.
  if (presets !== null) services.agentPresets = {
    list: async () => presets,
    // The preset a Session records, as the registry reads it from a live Session.
    presetForSession: session => headers.get(session?.id) ?? null,
    // A preset mount's own services; this harness composes none.
    serviceFor: () => undefined,
    // The public scope lease and prompt assembly the compatibility check uses.
    acquireScope: async id => ({ key: { id }, [Symbol.asyncDispose]: async () => {} }),
    defaultId: 'standard',
  }
  services.systemPrompt = {
    assemble: async ({ scope }) => ({
      sections: complete.has(scope?.id) ? [{ name: 'minimal-persona' }] : [{ name: 'harness:identity' }, { name: 'bot-identity' }],
    }),
  }
  const ctx = fakeContext({ services })
  const warnings = []
  ctx.logger = { warn: (...args) => warnings.push(format(...args)), info() {} }
  const created = []
  const archived = []
  const agents = new Map()
  const sent = []
  const teamPath = join(home, 'workspace')
  // Session ids keep growing across a restart on the same home, so a reused id is never
  // mistaken for a part the earlier host made.
  let sessions = reuse === undefined ? 0 : 100
  const fail = { create: 0 }
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const agent = {
        id: sessionId,
        session: { id: sessionId, header: { cwd: teamPath }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: () => () => {}, restrict: () => {} } },
        status: 'idle',
        calls,
        followup(message) { calls.push(['followup', message]); sent.push({ sessionId, message }) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        send() {},
        cancel() {},
        async whenIdle() {
          while (agent.status !== 'idle') await new Promise(resolve => setTimeout(resolve, 5))
        },
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          prepend(target, message) { (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(message) },
          append(target, message) { (target === 'next-turn' ? this.nextTurn : this.nextStep).push(message) },
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) {
                list.splice(at, 1)
                return true
              }
            }
            return false
          },
        },
      }
      agents.set(sessionId, agent)
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: teamPath } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
      unarchiveSession: async () => {},
    },
    sessionController: {
      create: async (options) => {
        if (fail.create > 0) {
          fail.create -= 1
          throw new Error('disk full')
        }
        const sessionId = `s${++sessions}`
        created.push({ sessionId, ...options })
        headers.set(sessionId, options.agentPreset)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  // DS Bot's own pre-step listener (parts.js registers it last): a turn starting in a
  // Session checks the preset that Session runs.
  const startTurn = async (sessionId) => {
    const listener = (ctx.listeners.get('agent/pre-step') ?? []).at(-1)
    assert.ok(listener !== undefined, 'no pre-step listener')
    return listener({ agent: agentOf(sessionId), messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => 'next')
  }
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, call, state, stop, startTurn, chatOf: id => rt.chatOf(id), created, archived, headers, agentOf, fail, warnings, sent, teamPath, complete, presetService: services.agentPresets }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 15))
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await settle()
  }
}
const text = message => (message.content ?? []).map(block => block.text ?? '').join('\n')

test('the presets endpoint lists what the profile serves, broken ones included', async (t) => {
  const host = start({ presets: [
    { id: 'standard', name: 'Standard', description: 'Everyday work', order: 1, isDefault: true },
    { id: 'ptc', name: 'PTC', broken: 'failed to start: missing service' },
  ] })
  t.after(host.stop)
  const answer = await host.call('presets')
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.deepEqual(answer.value, { presets: [
    { id: 'standard', name: 'Standard', description: 'Everyday work' },
    { id: 'ptc', name: 'PTC', broken: 'failed to start: missing service' },
  ] })
})

test('a profile without an agent-preset roster lists none and still makes Bots', async (t) => {
  const host = start({ presets: null })
  t.after(host.stop)
  assert.deepEqual((await host.call('presets')).value, { presets: [] })
  // The baseline DSH has nothing to check or name, so a Bot is made as before.
  const writer = (await host.call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.agentPreset, undefined)
  assert.equal(host.created.at(-1).agentPreset, undefined)
})

test('a preset whose composition turns complete is refused at once', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  assert.equal((await host.call('presets')).value.presets.find(row => row.id === 'research').broken, undefined)
  // The same id now composes a complete persona: the next check sees it, with no cache
  // holding the old answer.
  host.complete.add('research')
  assert.match((await host.call('presets')).value.presets.find(row => row.id === 'research').broken, /replaces/)
  const created = host.created.length
  const refused = await host.call('create-bot', { name: 'Writer', agentPreset: 'research' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /cannot be used for a Bot/)
  assert.equal(host.created.length, created)
})

test('with no usable standard, a default that replaces the Bot prompt is refused before a Session', async (t) => {
  const host = start({ presets: [{ id: 'research', name: 'Research' }] })
  t.after(host.stop)
  host.complete.add('research')
  host.presetService.defaultId = 'research'
  await host.call('state')
  const created = host.created.length
  const refused = await host.call('create-bot', { name: 'Writer' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /default agent preset "research" cannot be used for a Bot/)
  assert.equal(host.created.length, created)
})

test('with no usable standard, a compatible default is named for the new Session', async (t) => {
  const host = start({ presets: [{ id: 'research', name: 'Research' }] })
  t.after(host.stop)
  host.presetService.defaultId = 'research'
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.agentPreset, undefined)
  assert.equal(host.created.at(-1).agentPreset, 'research')
})

test('with no standard, clearing the pick follows the compatible default', async (t) => {
  const host = start({ presets: [{ id: 'research', name: 'Research' }, { id: 'custom', name: 'Custom' }] })
  t.after(host.stop)
  host.presetService.defaultId = 'research'
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'custom' })).value
  assert.equal(host.headers.get(writer.id), 'custom')
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: null })).ok, true)
  await until(() => host.chatOf(writer.id) !== writer.id)
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'research')
  assert.equal(host.state().bots[writer.id].agentPreset, undefined)
  assert.equal(host.state().bots[writer.id].agentPresetDefault, true)
})

test('with no standard, a failed clear to the default is retried on the next turn', async (t) => {
  const host = start({ presets: [{ id: 'research', name: 'Research' }, { id: 'custom', name: 'Custom' }] })
  t.after(host.stop)
  host.presetService.defaultId = 'research'
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'custom' })).value
  host.fail.create = 1
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: null })).ok, true)
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  assert.equal(host.chatOf(writer.id), writer.id)
  // The next turn resolves the same effective default and moves the part on.
  await host.startTurn(writer.id)
  await until(() => host.chatOf(writer.id) !== writer.id)
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'research')
})

test('a new Bot is made with the preset the user picked and keeps it', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'research' })).value
  assert.equal(writer.agentPreset, 'research')
  assert.deepEqual(host.created.at(-1), { sessionId: writer.id, workspaceId: 'w1', agentPreset: 'research' })
  assert.equal(host.state().bots[writer.id].agentPreset, 'research')
  const view = (await host.call('state')).value.bots.find(bot => bot.id === writer.id)
  assert.equal(view.agentPreset, 'research')
})

test('a Bot without a pick keeps the standard default and the team file gains no field', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.agentPreset, undefined)
  assert.equal(host.created.at(-1).agentPreset, 'standard')
  assert.equal(host.state().bots[writer.id].agentPreset, undefined)

  // A Bot saved before the feature (no field) moves on to the standard default too.
  await host.rt.newPart('chief')
  await until(() => host.state().bots.chief.sessionId !== 'chief')
  assert.equal(host.created.at(-1).agentPreset, 'standard')
  assert.equal(host.state().bots.chief.agentPreset, undefined)
})

test('a Bot keeps its preset and sidebar section through creation, copy and update', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const section = await host.rt.saveSection({ name: 'Research' })
  const created = await host.call('create-bot', { name: 'Writer', agentPreset: 'research', sectionId: section.id })
  assert.equal(created.ok, true, JSON.stringify(created))
  const writer = created.value
  assert.equal(writer.sectionId, section.id)
  assert.equal(host.headers.get(writer.id), 'research')
  const copied = await host.call('duplicate-bot', { id: writer.id })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  assert.equal(copied.value.sectionId, section.id)
  assert.equal(copied.value.agentPreset, 'research')
  const updated = await host.call('update-bot', { id: writer.id, agentPreset: 'standard', sectionId: null })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  await until(() => host.chatOf(writer.id) !== writer.id)
  assert.equal(host.state().bots[writer.id].sectionId, undefined)
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'standard')
})

test('an unknown or broken preset leaves no Bot and no Session behind', async (t) => {
  const cases = [
    [[{ id: 'standard' }, { id: 'research' }], 'nope', /not available/],
    [[{ id: 'standard' }, { id: 'ptc', broken: 'it cannot start' }], 'ptc', /cannot run: it cannot start/],
  ]
  for (const [presets, id, message] of cases) {
    const host = start({ presets })
    t.after(host.stop)
    await host.call('state')
    const before = host.created.length
    const answer = await host.call('create-bot', { name: 'Writer', agentPreset: id })
    assert.equal(answer.ok, false, JSON.stringify(answer))
    assert.match(answer.error.message, message)
    assert.equal(host.created.length, before, 'no Session is made for a refused preset')
    assert.equal((await host.call('state')).value.bots.some(bot => bot.name === 'Writer'), false)
  }
})

test('a copy keeps the pick, and a copy whose pick is gone fails visibly', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'research' })).value
  const copy = (await host.call('duplicate-bot', { id: writer.id })).value
  assert.equal(copy.agentPreset, 'research')
  assert.equal(host.created.at(-1).agentPreset, 'research')

  // The preset leaves the profile: the copy is refused, not started on another one.
  host.ctx.get('agentPresets').list = async () => [{ id: 'standard' }]
  const before = host.created.length
  const refused = await host.call('duplicate-bot', { id: writer.id })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /not available/)
  assert.equal(host.created.length, before)
  assert.equal((await host.call('state')).value.bots.filter(bot => bot.name.startsWith('Writer copy')).length, 1)
})

test('changing the pick moves the Bot\'s own chat and its group Session to fresh parts', async (t) => {
  const host = start()
  t.after(host.stop)
  const chief = (await host.call('state')).value.mainBotId
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'standard' })).value

  // A group round makes the member's group Session. The room's Session gets the user's
  // message as a session event, as DSH announces it; the admin (Writer) is the member
  // the round calls first.
  const room = (await host.call('create-room', { members: [chief, writer.id], admin: writer.id })).value
  const cue = { role: 'user', content: [{ type: 'text', text: 'Hello team' }], source: { kind: 'user' } }
  for (const listener of host.ctx.listeners.get('session/event') ?? []) listener({ id: room.id }, { type: 'user/message', data: cue })
  const controller = new AbortController()
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: controller.signal })
  await until(() => host.state().rooms[room.id]?.sessions?.[writer.id] !== undefined)
  controller.abort()
  await relay.catch(() => {})
  const memberBefore = host.state().rooms[room.id].sessions[writer.id]
  const ownBefore = writer.id
  // Input the member's group part has not taken up yet moves along with the switch.
  host.agentOf(memberBefore).inbox.nextTurn.push({
    id: 'held', role: 'user', content: [{ type: 'text', text: 'held for the group' }], source: { kind: 'user' },
  })

  const answer = await host.call('update-bot', { id: writer.id, agentPreset: 'research' })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  await until(() => host.chatOf(writer.id) !== ownBefore)
  await until(() => host.state().rooms[room.id].sessions[writer.id] !== memberBefore)

  const saved = host.state()
  assert.equal(saved.bots[writer.id].agentPreset, 'research')
  assert.deepEqual(saved.bots[writer.id].segments.map(segment => segment.sessionId), [ownBefore])
  assert.deepEqual(saved.rooms[room.id].segments[writer.id].map(segment => segment.sessionId), [memberBefore])
  // Every fresh part was made with the new pick; the group's own Session was not touched.
  const fresh = [saved.bots[writer.id].sessionId, saved.rooms[room.id].sessions[writer.id]]
  for (const sessionId of fresh) {
    assert.equal(host.headers.get(sessionId), 'research')
    const handoff = host.agentOf(sessionId).calls.filter(([kind]) => kind === 'followup').map(([, message]) => text(message)).join('\n')
    assert.match(handoff, /agent preset changed/)
  }
  // The group part's queued input went along.
  const carried = host.agentOf(fresh[1]).calls.map(([, message]) => text(message)).join('\n')
  assert.match(carried, /held for the group/)
  assert.deepEqual(host.agentOf(memberBefore).inbox.nextTurn, [])
  // The earlier parts were archived, not dropped.
  assert.deepEqual(host.archived.map(([sessionId]) => sessionId).sort(), [memberBefore, ownBefore].sort())
})

test('a pick made while a part is moving is the one the fresh part runs', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'standard' })).value
  // The Bot is working: the first switch waits for it.
  host.agentOf(writer.id).status = 'running'
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: 'research' })).ok, true)
  await settle()
  // A second pick lands while that switch waits.
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: 'standard' })).ok, true)
  host.agentOf(writer.id).status = 'idle'
  await until(() => host.chatOf(writer.id) !== writer.id)
  await until(() => host.headers.get(host.chatOf(writer.id)) === 'standard')
  assert.equal(host.state().bots[writer.id].agentPreset, 'standard')
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'standard')
})

test('a switch that fails keeps the queued input, and the stored pick is applied later', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'standard' })).value
  host.agentOf(writer.id).inbox.nextTurn.push({
    id: 'held', role: 'user', content: [{ type: 'text', text: 'waiting input' }], source: { kind: 'user' },
  })
  host.fail.create = 1
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: 'research' })).ok, true)
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  // The warning is logged before the switch's own cleanup is saved: wait for the
  // persisted state to show it finished before asserting nothing is left behind.
  await until(() => host.state().switching[writer.id] === undefined)
  // Nothing was lost: the part stayed current with its input, and the pick is stored.
  assert.equal(host.chatOf(writer.id), writer.id)
  assert.equal(host.state().bots[writer.id].agentPreset, 'research')
  assert.deepEqual(host.agentOf(writer.id).inbox.nextTurn.map(message => text(message)), ['waiting input'])
  assert.equal(host.state().switching[writer.id], undefined)

  // The next turn in the part sees that it runs another preset and moves it on.
  await host.startTurn(writer.id)
  // The fresh part is recorded before its handoff and the queued input are moved, so
  // wait for those to land rather than only for the new id.
  const movedOn = () => {
    const fresh = host.chatOf(writer.id)
    return fresh !== writer.id
      && host.agentOf(fresh).calls.some(([, message]) => text(message) === 'waiting input')
      && host.agentOf(writer.id).inbox.nextTurn.length === 0
  }
  await until(movedOn)
  const fresh = host.chatOf(writer.id)
  assert.equal(host.headers.get(fresh), 'research')
  assert.match(host.agentOf(fresh).calls.map(([, message]) => text(message)).join('\n'), /waiting input/)
  assert.deepEqual(host.agentOf(writer.id).inbox.nextTurn, [])
})

test('a part left on an older preset catches up after a restart', async (t) => {
  const host = start({ team: {
    ...TEAM,
    bots: { ...TEAM.bots, writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2, agentPreset: 'research' } },
  } })
  t.after(host.stop)
  // The stored Session was made with standard before the pick was set.
  host.headers.set('writer', 'standard')
  await host.call('state')
  // The next turn in the part sees it runs another preset and moves it on.
  await host.startTurn('writer')
  // The new part is written to the team file together with the earlier segment; wait
  // for that record, not only for the in-memory id, which is set before the save.
  const settled = () => {
    const saved = host.state().bots.writer
    return saved.sessionId !== undefined && saved.sessionId !== 'writer'
      && Array.isArray(saved.segments) && saved.segments.length === 1 && saved.segments[0].sessionId === 'writer'
  }
  await until(settled)
  const fresh = host.state().bots.writer.sessionId
  assert.equal(host.headers.get(fresh), 'research')
  assert.deepEqual(host.state().bots.writer.segments.map(segment => segment.sessionId), ['writer'])
})

test('a Bot cannot choose its own preset through update_bot', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer' })).value
  await assert.rejects(
    host.rt.updateBot(writer.id, { agentPreset: 'research' }, writer.id, writer.id),
    /Only the user can choose the agent preset/,
  )
  // The tool's own arguments do not carry the pick at all.
  const tool = rt.teamTools.find(entry => entry.name === 'update_bot')
  assert.equal(Object.hasOwn(tool.parameters, 'agentPreset'), false)
  assert.equal((await tool.execute({ agentPreset: 'research' }, { agent: { id: writer.id }, name: 'update_bot', callId: 'c1' })).includes('Updated'), true)
  assert.equal(host.state().bots[writer.id].agentPreset, undefined)
})

test('clearing the pick returns the next part to the default', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'research' })).value
  assert.equal(host.headers.get(writer.id), 'research')
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: null })).ok, true)
  await until(() => host.chatOf(writer.id) !== writer.id)
  assert.equal(host.state().bots[writer.id].agentPreset, undefined)
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'standard')
})

test('a cleared pick whose switch failed is retried on the next turn', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  const writer = (await host.call('create-bot', { name: 'Writer', agentPreset: 'research' })).value
  assert.equal(host.headers.get(writer.id), 'research')
  host.fail.create = 1
  assert.equal((await host.call('update-bot', { id: writer.id, agentPreset: null })).ok, true)
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  // The pick is gone, the default is now the user's own choice, and the part stayed put.
  assert.equal(host.chatOf(writer.id), writer.id)
  assert.equal(host.state().bots[writer.id].agentPreset, undefined)
  assert.equal(host.state().bots[writer.id].agentPresetDefault, true)
  // The next turn in the part sees it runs another preset and retries the switch.
  await host.startTurn(writer.id)
  await until(() => host.chatOf(writer.id) !== writer.id)
  assert.equal(host.headers.get(host.chatOf(writer.id)), 'standard')
})

test('a cleared pick whose switch failed is retried after a restart', async (t) => {
  const first = start()
  await first.call('state')
  const writer = (await first.call('create-bot', { name: 'Writer', agentPreset: 'research' })).value
  first.fail.create = 1
  assert.equal((await first.call('update-bot', { id: writer.id, agentPreset: null })).ok, true)
  await until(() => first.warnings.some(line => line.includes('did not move on to a fresh part')))
  await first.stop({ keep: true })

  // The intent survives the restart, so the next turn there catches up.
  const saved = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.equal(saved.bots[writer.id].agentPreset, undefined)
  assert.equal(saved.bots[writer.id].agentPresetDefault, true)
  const second = start({ home: first.home })
  t.after(second.stop)
  await second.call('state')
  await second.startTurn(writer.id)
  await until(() => second.chatOf(writer.id) !== writer.id)
  assert.equal(second.headers.get(second.chatOf(writer.id)), 'standard')
})

test('a team saved before presets existed keeps the parts it has', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state')
  // Chief has neither a pick nor a cleared-pick mark: its part is left as it was.
  host.headers.set('chief', 'ptc')
  await host.startTurn('chief')
  await settle()
  assert.equal(host.chatOf('chief'), 'chief')
  assert.equal(host.headers.get('chief'), 'ptc')
})

test('a corrupted stored pick falls back to the default instead of failing every Session', async (t) => {
  const host = start({ team: {
    ...TEAM,
    bots: { ...TEAM.bots, writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2, agentPreset: 7, agentPresetDefault: 'yes' } },
  } })
  t.after(host.stop)
  const team = (await host.call('state')).value
  const writer = team.bots.find(bot => bot.id === 'writer')
  assert.equal(writer.agentPreset, undefined)
  assert.equal(writer.agentPresetDefault, undefined)
  assert.equal(host.state().bots.writer.agentPreset, undefined)
  assert.equal(host.state().bots.writer.agentPresetDefault, undefined)
})
