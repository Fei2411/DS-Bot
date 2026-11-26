import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { API_ACTOR } from '../src/host/roster.js'
import { createApiRoutes } from '../src/host/api/routes.js'
import { agentAvatar } from '../src/client/agent-routes.js'

// DSH's settings and credentials for a DeepSeek route that takes an API key. A key set
// or removed is announced the way DSH announces it. `records` are the stored records
// (an account sign-in's), announced by the test.
function keyed(ctx, stored, records) {
  return {
    settings: { describe: () => [{ ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: {} }] },
    credentials: {
      describe: async ref => ({ configured: stored.has(ref), writable: true }),
      set: async (ref) => { stored.add(ref); ctx.emit('credentials/reference-updated', ref) },
      unset: async (ref) => { stored.delete(ref); ctx.emit('credentials/reference-updated', ref) },
      describeRecord: async key => ({ configured: records.has(key), writable: true }),
    },
  }
}

// Enough of the dsh services for the roster to make Sessions; kickoff messages are dropped.
// With `keys`, the models' route takes an API key and these are the ones set.
let rt
function start(team, { home: existingHome, keepHome = false, inflight, models = [], reasoning = {}, archiveError, keys, selection, lock, lost = new Set(), listed, schedules, flush } = {}) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-roster-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  if (inflight !== undefined) writeFileSync(join(home, 'inflight.json'), JSON.stringify(inflight))
  // A lock another dsh holds, written before this host loads the team.
  if (lock !== undefined) writeFileSync(join(home, 'state.lock'), JSON.stringify(lock))
  const services = {}
  if (listed !== undefined) {
    services.sessionQuery = {
      listSessions: async () => [...listed].map(id => ({ header: { id }, persisted: true, live: false })),
    }
  }
  if (schedules !== undefined) services.schedule = schedules
  const ctx = fakeContext({ services })
  const records = new Set()
  if (keys !== undefined) Object.assign(services, keyed(ctx, new Set(keys), records))
  if (selection !== undefined) {
    const baseGet = ctx.get
    ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => selection } : baseGet(name)
  }
  const workspaces = new Map()
  const sent = []
  const injected = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    let inbox = inboxes.get(sessionId)
    if (inbox === undefined) {
      inbox = { nextStep: [], nextTurn: [] }
      inboxes.set(sessionId, inbox)
    }
    return inbox
  }
  const selected = []
  // Every selection asked for, including the ones a lost Session refused.
  const attempts = []
  const archived = []
  const warnings = []
  let sessions = 0
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
      ...(keys === undefined ? {} : { listConfigurableProviders: () => [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }] }),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId, options) => {
        if (archiveError !== undefined) throw archiveError
        archived.push([sessionId, options])
      },
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      // A Session the `lost` set names is gone from the library: resolving its agent and
      // selecting its model answer the same `session/not-found` the real controller does.
      resolveAgent: async sessionId => (lost.has(sessionId)
        ? { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
        : {
            agent: {
              session: { id: sessionId },
              inbox: inboxOf(sessionId),
              followup: message => sent.push({ sessionId, message }),
              inject: (message) => {
                inboxOf(sessionId).nextStep.push(message)
                injected.push({ sessionId, message })
              },
            },
          }),
      selectModel: async (request) => {
        attempts.push(request)
        if (lost.has(request.sessionId)) throw Object.assign(new Error(`session "${request.sessionId}" not found`), { code: 'session/not-found' })
        selected.push(request)
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: flush ?? (async () => {}) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, rt, sent, injected, selected, attempts, ctx, archived, warnings, records }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
// A greeting goes out after the team is saved, which can take longer than one settle() on a
// busy machine.
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}

test('API-created Bots retain a non-user creator across persistence and receive no Main rights', async t => {
  const { stop, home, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await rt.load()
  await rt.bootstrap()
  const bot = await rt.createBot({ name: 'API worker', main: true, createdBy: null }, API_ACTOR)
  assert.equal(bot.createdBy, 'api:external')
  assert.equal(rt.isMain(bot.id), false)
  assert.equal(rt.isMain(bot.createdBy), false)
  await rt.save()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots[bot.id]
  assert.equal(saved.createdBy, 'api:external')
  await until(() => sent.some(entry => entry.sessionId === bot.id))
  const kickoff = sent.find(entry => entry.sessionId === bot.id).message
  assert.equal(kickoff.source.senderName, 'External API')
  assert.equal(kickoff.source.senderSessionId, 'api:external')
  assert.match(JSON.stringify(kickoff.content), /external API.*created you/)
  await assert.rejects(rt.updateBot(bot.id, { private: true }, API_ACTOR), /Only the user/)
  await assert.rejects(rt.updateBot(bot.id, { browserGrants: [] }, API_ACTOR), /Only the user/)
})

test('the first Main Bot waits for the user to pick a model, then greets', async (t) => {
  const { call, stop, sent, selected } = start(undefined, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  let team = (await call('state', {})).value
  let main = team.bots.find(bot => bot.id === team.mainBotId)
  await settle()
  assert.equal(main.model, undefined)
  assert.equal(main.waiting, true)
  assert.equal(main.kickoff, undefined)
  assert.equal(sent.length, 0)
  assert.equal(selected.length, 0)
  assert.deepEqual(team.models.map(model => model.ref), ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
  assert.equal(team.defaultModel, 'deepseek/deepseek-v4-flash')

  assert.equal((await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-pro' })).ok, true)
  await until(() => sent.length > 0)
  team = (await call('state', {})).value
  main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.model, 'deepseek/deepseek-v4-pro')
  assert.equal(main.waiting, undefined)
  assert.deepEqual(selected.map(({ sessionId, model }) => [sessionId, model]), [[main.id, 'deepseek-v4-pro']])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, main.id)
  assert.equal(sent[0].message.source.role, 'kickoff')

  // A later model change does not greet again.
  await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, 1)
})

test('other Bots start on the default model and greet at once', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.length > 0)
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(sent.map(entry => entry.sessionId), [writer.id])
})

test('a new name must be one "@" can call; a name saved before the rule still saves', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  for (const name of ['a@b', 'All', '所有人']) assert.equal((await call('create-bot', { name })).ok, false, name)
  const writer = (await call('create-bot', { name: 'Writer 2' })).value
  assert.equal((await call('update-bot', { id: writer.id, name: 'Writer@home' })).ok, false)
  assert.equal((await call('update-bot', { id: writer.id, name: '新 Writer' })).ok, true)
})

// The kickoff arrives as a user message, so it must not name a question tool the Bot's
// instructions can rule out, and it gives way to those instructions.
for (const kind of ['main', 'copy', 'made by a Main Bot', 'made by the user']) {
  test(`the ${kind} kickoff asks in plain text and gives way to the Bot's instructions`, async (t) => {
    const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
    t.after(stop)
    const chief = (await call('state', { locale: 'zh-CN' })).value.mainBotId
    const instructions = 'Use only plain text. Never call ask_user or ask_user_question.'
    let bot
    if (kind === 'main') {
      bot = (await call('update-bot', { id: chief, instructions, model: 'deepseek/deepseek-v4-flash' })).value
    } else if (kind === 'copy') {
      const original = (await call('create-bot', { name: 'Writer', instructions })).value
      await until(() => sent.some(entry => entry.sessionId === original.id))
      bot = (await call('duplicate-bot', { id: original.id })).value
    } else if (kind === 'made by a Main Bot') {
      await rt.teamTools.find(d => d.name === 'create_bot').execute({ name: 'Writer', role: 'Writer', instructions, brief: 'Review the team notes.' }, { agent: { id: chief } })
      bot = (await call('state', {})).value.bots.find(entry => entry.name === 'Writer')
    } else {
      bot = (await call('create-bot', { name: 'Writer', instructions })).value
    }
    await until(() => sent.some(entry => entry.sessionId === bot.id && entry.message.source.role === 'kickoff'))
    const greetings = sent.filter(entry => entry.sessionId === bot.id && entry.message.source.role === 'kickoff')
    assert.equal(greetings.length, 1)
    const { message } = greetings[0]
    const text = message.content[0].text
    assert.equal(message.source.role, 'kickoff')
    assert.equal(bot.instructions, instructions)
    assert.doesNotMatch(text, /\b(?:ask_user(?:_question)?|allowCustom)\b/)
    assert.match(text, /ask in one short question/)
    assert.match(text, /Where your instructions say otherwise, follow them\./)
    assert.match(text, /Write in Chinese \(简体中文\)\./)
    if (kind === 'copy') assert.match(text, /copy of Writer/)
    if (kind === 'made by a Main Bot') assert.match(text, /Why you exist: Review the team notes\./)
  })
}

test('a greeting whose model wait fails still goes out, with no unhandled rejection', async (t) => {
  const { call, stop, sent, warnings } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  await call('state', {})
  rt.waitForModel = async () => { throw new Error('providers unreadable') }
  const bot = (await call('create-bot', { name: 'Writer' })).value
  await until(() => warnings.some(line => line.includes('model for Writer not ready')))
  await until(() => sent.some(entry => entry.sessionId === bot.id))
  await settle()
  assert.deepEqual(unhandled, [])
})

test('a first message from the user is helped with, not replaced by an opening question', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  const brief = 'Review the team notes and list the next tasks.'
  const bot = (await call('create-bot', { name: 'Writer', brief })).value
  await until(() => sent.some(entry => entry.sessionId === bot.id))
  const text = sent.find(entry => entry.sessionId === bot.id).message.content[0].text
  assert.ok(text.includes(brief))
  assert.match(text, /then help with it\./)
  assert.doesNotMatch(text, /\b(?:ask_user(?:_question)?|allowCustom)\b/)
})

test('a group the user makes without a first message opens with its admin asking what it is for', async (t) => {
  const { call, stop, sent, ctx, home } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  sent.length = 0
  await call('create-room', { members: [chief, writer.id], admin: writer.id })
  assert.equal(sent.length, 0)
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id, greet: true })).value
  assert.deepEqual(sent.map(entry => [entry.sessionId, entry.message.source.role]), [[room.id, 'kickoff']])

  // The relay gives the admin alone a turn, and the cue adds no line to the group.
  for (const listener of ctx.listeners.get('session/event')) listener({ id: room.id }, { type: 'user/message', data: sent[0].message })
  const relay = rt.teamTools.find(d => d.name === 'group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: new AbortController().signal })
    .then(value => afterRound(rt, room.id, value))
  await until(() => sent.length > 1)
  rt.stopRoomRound(room.id)
  const result = await relay
  const turns = sent.slice(1)
  assert.equal(turns.length, 1)
  const text = turns[0].message.content[0].text
  assert.match(text, /^\[Group chat "[^"]+" · the group was just created\]\n/)
  assert.match(text, /The user just created this group/)
  assert.doesNotMatch(text, /This round so far|Nothing new in this round/)
  assert.deepEqual(result.passed, ['Writer'])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(saved.sessions[writer.id], turns[0].sessionId)
  assert.deepEqual(saved.log, [])
})

test('a Bot takes a thinking level its model serves, applied with the model', async (t) => {
  const reasoning = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal((await call('update-bot', { id: chief, effort: 'low' })).ok, true)
  await settle()
  const main = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(main.effort, 'low')
  assert.equal(main.appliedEffort, 'low')
  assert.equal(selected.at(-1).reasoningEffort, 'low')

  // A level the model does not serve is refused; null clears the pick.
  assert.equal((await call('update-bot', { id: chief, effort: 'max' })).ok, false)
  assert.equal((await call('update-bot', { id: chief, effort: null })).ok, true)
  await settle()
  const cleared = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(cleared.effort, undefined)
  assert.equal(cleared.appliedEffort, undefined)

  // Creating a Bot with a level stores and applies it.
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'high' })).value
  await settle()
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')
})

test('a new Bot inherits the profile default thinking level', async (t) => {
  const reasoning = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } }
  const selection = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning, selection })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')

  // An explicit level still wins, and a level the model does not serve is dropped.
  const coder = (await call('create-bot', { name: 'Coder', effort: 'low' })).value
  assert.equal(coder.effort, 'low')

  // An explicit Default pick (null) stays on the model's own level, and so does a
  // copy of a Bot that has no level of its own.
  const plain = (await call('create-bot', { name: 'Plain', effort: null })).value
  assert.equal(plain.effort, undefined)
  const copy = (await call('duplicate-bot', { id: plain.id })).value
  assert.equal(copy.effort, undefined)

  const other = { provider: 'deepseek', model: 'other', reasoningEffort: 'max' }
  const { call: call2, stop: stop2 } = start(undefined, { models: ['deepseek/deepseek-v4-flash'], reasoning, selection: other })
  t.after(stop2)
  const tester = (await call2('create-bot', { name: 'Tester' })).value
  assert.equal(tester.effort, undefined)
})

test('the state reports a changed model list without a new revision', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const first = (await call('state', {})).value
  assert.equal((await call('state', { since: first.revision, models: first.modelsKey })).value.unchanged, true)
  assert.equal((await call('state', { since: first.revision, models: 'stale' })).value.unchanged, undefined)
})

test('an unchanged state answer skips the live fields a window already holds', async (t) => {
  const { call, stop, ctx } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const first = (await call('state', {})).value
  assert.equal(typeof first.liveKey, 'string')
  // The window echoes the live key it holds; while it still names the answer,
  // the live fields stay out.
  const quiet = (await call('state', { since: first.revision, models: first.modelsKey, live: first.liveKey })).value
  assert.equal(quiet.unchanged, true)
  assert.equal(quiet.liveKey, first.liveKey)
  assert.equal(quiet.activity, undefined)
  assert.equal(quiet.work, undefined)
  assert.equal(quiet.connectors, undefined)
  // A key that names an older answer still gets the fields with the current one.
  const stale = (await call('state', { since: first.revision, models: first.modelsKey, live: 'an older answer' })).value
  assert.equal(stale.unchanged, true)
  assert.equal(stale.liveKey, first.liveKey)
  assert.equal(typeof stale.activity, 'object')
  assert.equal(typeof stale.work, 'object')
  // Live state that changes without a new revision moves the key.
  const chief = first.bots.find(bot => bot.id === first.mainBotId)
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    listener({ id: chief.sessionId ?? chief.id }, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  }
  const working = (await call('state', { since: first.revision, models: first.modelsKey, live: first.liveKey })).value
  assert.equal(working.unchanged, true)
  assert.notEqual(working.liveKey, first.liveKey)
  assert.equal(Object.keys(working.work?.bots ?? {}).length, 1)
  // And once it holds that answer, the next poll is small again.
  const again = (await call('state', { since: first.revision, models: first.modelsKey, live: working.liveKey })).value
  assert.equal(again.unchanged, true)
  assert.equal(again.activity, undefined)
})

test('a window holding live state gets fresh fields after the host restarts at the same revision', async (t) => {
  const first = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief' } } })
  t.after(first.stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  // Start working before the first poll, so both runs' first live answer would
  // have counter 1 even though one is working and the other is idle.
  for (const listener of first.ctx.listeners.get('session/event') ?? []) {
    listener({ id: 'chief' }, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  }
  const held = (await first.call('state', {})).value
  assert.equal(Object.keys(held.work.bots).length, 1)
  await first.ctx.dispose()
  const saved = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  const second = start(saved)
  t.after(second.stop)
  const now = (await second.call('state', { since: held.revision, models: held.modelsKey, live: held.liveKey })).value
  assert.equal(now.unchanged, true)
  assert.equal(now.revision, held.revision)
  assert.deepEqual(now.work?.bots, {})
  assert.deepEqual(now.activity, {})
  assert.notEqual(now.liveKey, held.liveKey)
  const quiet = (await second.call('state', { since: now.revision, models: held.modelsKey, live: now.liveKey })).value
  assert.equal(quiet.liveKey, now.liveKey)
  assert.equal(quiet.work, undefined)
  assert.equal(quiet.activity, undefined)
})

test('a new team starts with a DeepSeek-blue whale as its Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const team = (await call('state', {})).value
  assert.equal(team.mainBotIds.length, 1)
  const main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.name, 'Chief')
  assert.equal(main.color, 'deepseek')
  assert.deepEqual(main.avatar, { shape: 'whale' })

  // Other Bots keep no stored look, so the client picks one from the id.
  const writer = (await call('create-bot', { name: 'Writer', role: '写作' })).value
  assert.equal(writer.color, undefined)
  assert.equal(writer.avatar, undefined)
  // Making a Bot a Main Bot later does not change how it looks.
  await call('set-main', { id: writer.id, main: true })
  const after = (await call('state', {})).value.bots.find(bot => bot.id === writer.id)
  assert.equal(after.color, undefined)
  assert.equal(after.avatar, undefined)
})

const OLD_TEAM = {
  version: 1,
  mainBotIds: ['m1', 'w2'],
  revision: 4,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1, color: 'red' },
    w2: { id: 'w2', sessionId: 'w2', name: 'Writer', role: '写作', lab: 'kimi', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('a team from before the whale was stored gets it once, on its first Main Bot only', async (t) => {
  const { call, stop, home } = start(OLD_TEAM)
  t.after(stop)
  const bots = async () => Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.id, bot]))
  let team = await bots()
  // A color the user picked stays; the missing shape becomes the whale.
  assert.equal(team.m1.color, 'red')
  assert.deepEqual(team.m1.avatar, { shape: 'whale' })
  assert.equal(team.w2.avatar, undefined)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).whaleStored, true)

  // The whale is now an ordinary look: it does not pass on when its Bot is deleted.
  assert.equal((await call('set-main', { id: 'm1', main: false })).ok, true)
  assert.equal((await call('delete-bot', { id: 'm1' })).ok, true)
  team = await bots()
  assert.equal(team.w2.avatar, undefined)
  assert.equal(team.w2.color, undefined)
})

test('another Bot takes the Main Bot place in one step', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.deepEqual(team.mainBotIds, [writer.id])
  assert.equal(team.mainBotId, writer.id)
  // The whale stays with the Bot it was given to.
  assert.deepEqual(team.bots.find(bot => bot.id === chief).avatar, { shape: 'whale' })
  // The old Main Bot can now be deleted, and no new Chief is made in its place.
  assert.equal((await call('delete-bot', { id: chief })).ok, true)
  const after = (await call('state', {})).value
  assert.deepEqual(after.mainBotIds, [writer.id])
  assert.deepEqual(after.bots.map(bot => bot.id), [writer.id])
})

test('a Main Bot moves to the front and the others keep their order', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.deepEqual((await call('set-main', { id: writer.id, main: true })).value.mainBotIds, [chief, writer.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: true, primary: true })).value.mainBotIds, [writer.id, chief])
  assert.deepEqual((await call('set-main', { id: reader.id, main: true })).value.mainBotIds, [writer.id, chief, reader.id])
  // Replacing a Main Bot that is not first keeps its place; one already a Main Bot moves into it.
  assert.deepEqual((await call('set-main', { id: reader.id, main: true, replace: chief })).value.mainBotIds, [writer.id, reader.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: false })).value.mainBotIds, [reader.id])
})

test('set-main keeps one Main Bot and replaces only a Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.equal((await call('set-main', { id: chief, main: false })).ok, false)
  assert.equal((await call('set-main', { id: writer.id, main: true, replace: reader.id })).ok, false)
  assert.equal((await call('set-main', { id: 'nope', main: true })).ok, false)
  assert.equal((await call('set-main', { id: reader.id, main: false })).ok, true)
  assert.deepEqual((await call('state', {})).value.mainBotIds, [chief])
})

test('deleting a Bot or group chat stops its Session, so its tasks are removed', async (t) => {
  const { call, stop, archived } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id })).value
  archived.length = 0
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  assert.equal((await call('delete-room', { id: room.id })).ok, true)
  // `stopActivity` lets DSH's session-stop hook drop the Session's armed
  // scheduled tasks; without it the archive is refused and they keep
  // delivering into the deleted Session.
  assert.deepEqual(archived, [
    [writer.id, { stopActivity: true }],
    [room.id, { stopActivity: true }],
  ])
})

const TEAM_WITH_PART = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test("deleting a Bot also stops its past parts' Sessions, where tasks can stay armed", async (t) => {
  const { call, stop, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  archived.length = 0
  assert.equal((await call('delete-bot', { id: 'w1' })).ok, true)
  // A part switch can leave armed tasks on the old Session (w1); archiving only
  // the current one (w2) would orphan them exactly like a skipped archive.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
})

test('an archive failure on delete is warned instead of passing silently', async (t) => {
  const { call, stop, warnings } = start(undefined, { models: ['deepseek-v4-flash'], archiveError: new Error('archive refused') })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  await settle()
  assert.equal(warnings.filter(text => text.includes('not archived')).length, 1)
})

test('a hidden Bot made Main Bot shows again, and a replaced Chief drops its held greeting', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await call('set-flags', { id: writer.id, hidden: true })
  await settle()
  // Only Chief's messages count: Writer's own greeting can go out late on a busy machine.
  const toChief = () => sent.filter(item => item.sessionId === chief).length
  const greeted = toChief()
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.equal(team.bots.find(bot => bot.id === writer.id).hidden, undefined)
  assert.equal(team.bots.find(bot => bot.id === chief).waiting, undefined)
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(toChief(), greeted)
})

// A turn in a Bot Session as DSH reports it, to every listener.
const emitIn = (ctx, sessionId, event) => { for (const listener of ctx.listeners.get('session/event')) listener({ id: sessionId }, event) }
function runTurn(ctx, sessionId, turn, message, reason) {
  emitIn(ctx, sessionId, { type: 'turn/start', data: { turn } })
  emitIn(ctx, sessionId, { type: 'user/message', data: message })
  emitIn(ctx, sessionId, { type: 'turn/end', data: { turn, reason } })
}
const typed = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const failed = (code, extra = {}) => ({ kind: 'error', error: { code, message: `${code}: sk-12***34 was refused`, ...extra } })
const botIn = async (call, id) => (await call('state', {})).value.bots.find(bot => bot.id === id)

test('a model whose provider has no key is never given to a new Bot', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const team = (await call('state', {})).value
  assert.equal(team.models[0].needsKey, true)
  assert.equal(team.defaultModel, null)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.model, undefined)
  // A Main Bot on such a model passes it on to no Bot it creates.
  await call('update-bot', { id: team.mainBotId, model: 'deepseek/deepseek-v4-flash' })
  await rt.teamTools.find(tool => tool.name === 'create_bot').execute({ name: 'Editor', role: 'Editor', instructions: 'Edit.' }, { agent: { id: team.mainBotId } })
  await settle()
  const editor = (await call('state', {})).value.bots.find(bot => bot.name === 'Editor')
  assert.equal(editor.model, undefined)
  assert.deepEqual(sent.map(entry => entry.sessionId), [team.mainBotId])
  assert.equal((await botIn(call, writer.id)).waiting, true)

  assert.equal((await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })).ok, true)
  assert.equal((await call('state', {})).value.defaultModel, 'deepseek/deepseek-v4-flash')
  assert.equal((await call('create-bot', { name: 'Critic' })).value.model, 'deepseek/deepseek-v4-flash')
})

test('a message the user writes before the first Main Bot has a model is answered once it has one', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', { locale: 'zh-CN' })).value.mainBotId
  // The Session's own route has no key either, so that turn fails.
  runTurn(ctx, chief, 1, typed('hello?'), failed('MISSING_CREDENTIAL'))
  await settle()
  let main = await botIn(call, chief)
  assert.equal(main.waiting, true)
  assert.equal(main.blocked.code, 'MISSING_CREDENTIAL')

  // The key lifts the block; the greeting still waits for a model.
  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await settle()
  main = await botIn(call, chief)
  assert.equal(main.blocked, undefined)
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 0)

  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length > 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.source.role, 'kickoff')
  assert.equal(sent[0].message.content[0].text, [
    '[Bot team setup]',
    'You were just set up as the user\'s Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team. Write in Chinese (简体中文).',
    'Where your instructions say otherwise, follow them.',
  ].join('\n'))
})

test('a held greeting goes once a turn answered the user, and a Bot that can answer drops its own', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  // DSH's own default route answered the first Main Bot.
  runTurn(ctx, chief, 1, typed('hello?'), { kind: 'completed' })
  emitIn(ctx, writer.id, { type: 'user/message', data: typed('hi') })
  await settle()
  assert.equal((await botIn(call, chief)).waiting, undefined)
  assert.equal((await botIn(call, writer.id)).waiting, undefined)
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await call('update-bot', { id: writer.id, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, 0)
})

test('a greeting that fails on a key is held again and goes out once the key is set', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('MISSING_CREDENTIAL'))
  await settle()
  const main = await botIn(call, chief)
  assert.equal(main.waiting, true)
  assert.deepEqual(Object.keys(main.blocked).sort(), ['at', 'code', 'provider'])
  assert.equal(main.blocked.provider, 'deepseek')
  // Setting the same model again (or only a thinking level) fixes nothing, so the
  // greeting stays held.
  const same = await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(same.ok, true)
  assert.equal(sent.length, 1)
  assert.equal((await botIn(call, chief)).waiting, true)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)
  const after = await botIn(call, chief)
  assert.equal(after.blocked, undefined)
  assert.equal(after.waiting, undefined)
})

test('a Bot is blocked by the facts of a failure only the user can fix, until it is fixed', async (t) => {
  const { call, stop, ctx } = start(undefined, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  runTurn(ctx, chief, 1, typed('hi'), failed('QUOTA', { status: 402, requestId: 'req-1' }))
  await settle()
  const { blocked } = await botIn(call, chief)
  assert.deepEqual({ ...blocked, at: typeof blocked.at }, { code: 'QUOTA', status: 402, requestId: 'req-1', provider: 'deepseek', at: 'number' })
  // A failure a retry can fix leaves it as it is.
  runTurn(ctx, chief, 2, typed('again'), failed('SERVER', { status: 503 }))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'QUOTA')

  runTurn(ctx, chief, 3, typed('again'), { kind: 'completed' })
  await settle()
  assert.equal((await botIn(call, chief)).blocked, undefined)

  runTurn(ctx, chief, 4, typed('more'), failed('AUTH', { status: 401 }))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'AUTH')
  // A provider that registers or changes is no fix; a key is.
  ctx.emit('llm/adapters-updated')
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'AUTH')
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
  await settle()
  assert.equal((await botIn(call, chief)).blocked, undefined)

  runTurn(ctx, chief, 5, typed('more'), failed('ACCOUNT_SIGNED_OUT'))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'ACCOUNT_SIGNED_OUT')
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-pro' })
  assert.equal((await botIn(call, chief)).blocked, undefined)
})

test('Retry has the Bot answer the user\'s last message without sending it again, or sends a failed greeting again', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('QUOTA', { status: 402 }))
  await settle()
  assert.equal((await call('resume', { botId: 'nobody' })).error.code, 'bot/not-found')
  assert.equal((await call('resume', { botId: chief })).ok, true)
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)

  runTurn(ctx, chief, 2, sent[1].message, { kind: 'completed' })
  runTurn(ctx, chief, 3, typed('Plan my week'), failed('QUOTA', { status: 402 }))
  await settle()
  assert.equal((await call('resume', { botId: chief })).ok, true)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].sessionId, chief)
  assert.equal(sent[2].message.source.role, 'continue')
  assert.equal(sent[2].message.content[0].text, '[Retry after a failed turn]\nYour last turn failed (QUOTA) and the user has fixed it. Answer the user\'s last unanswered message.')
  assert.equal((await botIn(call, chief)).waiting, undefined)
})

// The record a DeepSeek account sign-in writes.
const ACCOUNT_RECORD = 'deepseek-account-platform/default'

test('a sign-in lifts what a lapsed sign-in blocked and sends the held greeting; a sign-out, a key or a provider does not', async (t) => {
  const { call, stop, sent, ctx, records } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  // The provider refuses the token, and its record goes while the turn still runs.
  records.add(ACCOUNT_RECORD)
  emitIn(ctx, chief, { type: 'turn/start', data: { turn: 1 } })
  emitIn(ctx, chief, { type: 'user/message', data: sent[0].message })
  records.delete(ACCOUNT_RECORD)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  emitIn(ctx, chief, { type: 'turn/end', data: { turn: 1, reason: failed('ACCOUNT_TOKEN_INVALID') } })
  await settle()
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
  ctx.emit('llm/adapters-updated')
  await settle()
  let main = await botIn(call, chief)
  assert.equal(main.blocked.code, 'ACCOUNT_TOKEN_INVALID')
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 1)

  records.add(ACCOUNT_RECORD)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)
  main = await botIn(call, chief)
  assert.equal(main.blocked, undefined)
  assert.equal(main.waiting, undefined)
})

test('a held greeting goes out again only on a change that can fix its block: never a balance, a key another provider reads or a key removed', async (t) => {
  const { call, stop, sent, ctx, records } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY', 'OTHER_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('QUOTA', { status: 402 }))
  await settle()
  // A key, a sign-in, a provider registering: none of it tops up a balance.
  records.add(ACCOUNT_RECORD)
  for (const ref of ['OTHER_API_KEY', 'DEEPSEEK_API_KEY']) ctx.emit('credentials/reference-updated', ref)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  ctx.emit('llm/adapters-updated')
  await settle()
  assert.equal(sent.length, 1)
  assert.equal((await botIn(call, chief)).blocked.code, 'QUOTA')

  // Retry sends it again, and this time the key is refused.
  await call('resume', { botId: chief })
  await until(() => sent.length === 2)
  runTurn(ctx, chief, 2, sent[1].message, failed('AUTH', { status: 401 }))
  await settle()
  ctx.emit('credentials/reference-updated', 'OTHER_API_KEY')
  await ctx.get('credentials').unset('DEEPSEEK_API_KEY')
  await settle()
  const main = await botIn(call, chief)
  assert.equal(main.blocked.code, 'AUTH')
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 2)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 3)
  assert.equal(sent[2].message.source.role, 'kickoff')
  assert.equal((await botIn(call, chief)).blocked, undefined)
})

test('the first Main Bot keeps its greeting when the user writes while a key blocks it, and answers once the key is fixed', async (t) => {
  // The key is set but wrong, so its model counts as usable until a turn fails on it.
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('AUTH', { status: 401 }))
  runTurn(ctx, chief, 2, typed('hello?'), failed('AUTH', { status: 401 }))
  await settle()
  assert.equal((await botIn(call, chief)).waiting, true)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.match(sent[1].message.content[0].text, /^\[Bot team setup\]\nYou were just set up as the user's Main Bot\. The user wrote to you before your model could answer; their message above has no answer yet\./)
})

test('Retry right after a fix adds no turn while the greeting it released waits for its model, is queued or runs', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('MISSING_CREDENTIAL'))
  await settle()
  // The route is slow to list, so the greeting the key releases waits for its model.
  const listModels = ctx.llm.listModels
  let open
  const listed = new Promise((resolve) => { open = resolve })
  ctx.llm.listModels = async (id) => { await listed; return listModels(id) }
  await ctx.get('credentials').set('DEEPSEEK_API_KEY', 'sk-test-ok')
  await settle()
  assert.equal((await call('resume', { botId: chief })).ok, true)
  open()
  await until(() => sent.length === 2)
  assert.equal((await call('resume', { botId: chief })).ok, true)
  emitIn(ctx, chief, { type: 'turn/start', data: { turn: 2 } })
  emitIn(ctx, chief, { type: 'user/message', data: sent[1].message })
  assert.equal((await call('resume', { botId: chief })).ok, true)
  emitIn(ctx, chief, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()
  assert.deepEqual(sent.map(entry => entry.message.source.role), ['kickoff', 'kickoff'])
})

const takeover = (home, team) => {
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
}

test('a host that loses its lock to another dsh refuses changes instead of making a phantom Bot', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(stop)
  assert.equal((await call('state', {})).value.readOnly, null)
  let created = 0
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => { created += 1; return create(...args) }
  // Another live dsh takes the lock and writes its own team.
  takeover(home, { version: 1, revision: 9, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' }, other: { id: 'other', name: 'FromB' } } })
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/read-only')
  assert.equal(created, 0)
  // The file keeps the new owner's team, and this host now follows it.
  const team = (await call('state', {})).value
  assert.match(team.readOnly, /another dsh/)
  assert.ok(team.bots.some(bot => bot.name === 'FromB'))
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
})

test('a delete whose save fails still stops the Sessions, and the next save writes it', async (t) => {
  const { call, stop, home, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  const statePath = join(home, 'state.json')
  const writeFile = fsp.writeFile
  let failWrite = false
  fsp.writeFile = async (path, ...args) => {
    if (failWrite && String(path).startsWith(`${statePath}.`)) throw Object.assign(new Error('disk error'), { code: 'EISDIR' })
    return writeFile(path, ...args)
  }
  syncBuiltinESMExports()
  t.after(async () => {
    fsp.writeFile = writeFile
    syncBuiltinESMExports()
    await stop()
  })
  await call('state', {})
  archived.length = 0
  failWrite = true
  const answer = await call('delete-bot', { id: 'w1' })
  assert.equal(answer.ok, false)
  // The Bot is gone from the team, so nothing could stop its tasks later.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
  failWrite = false
  await call('set-prefs', { theme: 'dark' })
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.bots.w1, undefined)
})

test('a rolled-back Bot does not come back with a save queued before the rollback', async (t) => {
  const { call, stop, home } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(async () => {
    fsp.rename = rename
    syncBuiltinESMExports()
    await stop()
  })
  // The first Bot also saves the team's workspace; later ones save only themselves.
  await call('create-bot', { name: 'Warm' })
  const statePath = join(home, 'state.json')
  const rename = fsp.rename
  let entered
  let release
  const first = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let failed = false
  fsp.rename = async (from, to) => {
    if (to === statePath && !failed) {
      failed = true
      entered()
      await gate
      throw Object.assign(new Error('rename failed'), { code: 'EIO' })
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  const phantom = call('create-bot', { name: 'Phantom' })
  await first
  // A second Bot's save queues a snapshot that still holds Phantom.
  const kept = call('create-bot', { name: 'Kept' })
  await settle()
  release()
  assert.equal((await phantom).ok, false)
  assert.equal((await kept).ok, true)
  // The rollback queues a save after Kept's without waiting for it, and no later change may
  // be what drops Phantom, so wait for that save itself.
  const names = () => Object.values(JSON.parse(readFileSync(statePath, 'utf8')).bots).map(bot => bot.name).sort()
  await until(() => !names().includes('Phantom'))
  assert.deepEqual(names(), ['Chief', 'Kept', 'Warm'])
})

test('a write that fails at save time archives the Session it made', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  const statePath = join(home, 'state.json')
  const writeFile = fsp.writeFile
  let failWrite = false
  fsp.writeFile = async (path, ...args) => {
    if (failWrite && String(path).startsWith(`${statePath}.`)) throw Object.assign(new Error('disk error'), { code: 'EISDIR' })
    return writeFile(path, ...args)
  }
  syncBuiltinESMExports()
  t.after(async () => {
    fsp.writeFile = writeFile
    syncBuiltinESMExports()
    await stop()
  })
  await call('state', {})
  const created = []
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => {
    const made = await create(...args)
    created.push(made.sessionId)
    // The disk write fails after this request's refresh, before its save.
    failWrite = true
    return made
  }
  const archived = []
  const archive = ctx.workspaceRegistry.archiveSession
  ctx.workspaceRegistry.archiveSession = async (id) => { archived.push(id); return archive(id) }
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/internal')
  assert.deepEqual(archived, created)
  failWrite = false
  const team = (await call('state', {})).value
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(Object.values(saved.bots).some(bot => bot.name === 'Phantom'), false)
})

// 公开#178: "User" is how a group log names the user, so a Bot may not take it.
test('a Bot cannot be named or renamed like the user; one named so before keeps working', async (t) => {
  const team = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: '', instructions: '', sessionId: 'a', createdAt: 1 },
      u: { id: 'u', name: 'User', role: '', instructions: '', sessionId: 'u', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
  const { call, stop } = start(team)
  t.after(stop)
  const made = await call('create-bot', { name: 'user' })
  assert.equal(made.ok, false)
  assert.match(made.error.message, /stands for the user in a chat/)
  const renamed = await call('update-bot', { id: 'a', name: 'You' })
  assert.equal(renamed.ok, false)
  assert.match(renamed.error.message, /stands for the user in a chat/)
  assert.equal((await call('update-bot', { id: 'u', name: 'User', role: 'Tester' })).ok, true)
  assert.equal((await call('update-bot', { id: 'u', name: 'Helper' })).ok, true)
})

// Holds every new Session until `release`, so creates that start together are all
// waiting on it at once, as with a slow DSH.
const holdSessions = (ctx) => {
  const create = ctx.sessionController.create
  let open
  const gate = new Promise(resolve => { open = resolve })
  let waiting = 0
  ctx.sessionController.create = async (request) => {
    waiting += 1
    await gate
    return create(request)
  }
  return { waiting: () => waiting, release: () => { ctx.sessionController.create = create; open() } }
}

// 公开#148: two Main Bots that each made a "Coder" at the same time both got one.
test('Bots created with one name at the same time: one is made, the others are refused', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const sessions = holdSessions(ctx)
  const creates = [1, 2, 3].map(() => call('create-bot', { name: 'Coder' }))
  // A rename to a name a create is still working on is refused too.
  const chief = (await call('state', {})).value.mainBotId
  const rename = await call('update-bot', { id: chief, name: 'coder' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false, false])
  assert.match(results[1].error.message, /A Bot named Coder already exists/)
  assert.equal(rename.ok, false)
  const names = (await call('state', {})).value.bots.map(bot => bot.name)
  assert.equal(names.filter(name => name.toLowerCase() === 'coder').length, 1)
})

test('copies of one Bot made at the same time get different names', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const sessions = holdSessions(ctx)
  const copies = [1, 2, 3].map(() => call('duplicate-bot', { id: writer.id }))
  await until(() => sessions.waiting() === 3)
  sessions.release()
  const results = await Promise.all(copies)
  assert.deepEqual(results.map(result => result.ok), [true, true, true])
  assert.deepEqual(results.map(result => result.value.name).sort(), ['Writer copy', 'Writer copy 2', 'Writer copy 3'])
})

// 公开#199: two groups made with one name at the same time were both made, and from then
// on a Main Bot could reach neither by name.
test('groups created or renamed to one name at the same time: only one gets it', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const other = (await call('create-room', { members: [chief, writer.id], name: 'Docs' })).value
  const sessions = holdSessions(ctx)
  const creates = [1, 2].map(() => call('create-room', { members: [chief, writer.id], name: 'Ops' }))
  const rename = await call('update-room', { id: other.id, name: 'ops' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false])
  assert.match(results[1].error.message, /Another group chat is already called "Ops"/)
  assert.equal(rename.ok, false)
  const rooms = (await call('state', {})).value.rooms.map(room => room.name).sort()
  assert.deepEqual(rooms, ['Docs', 'Ops'])

  // Once the create ends, its name is no longer held for anyone else.
  const later = await call('create-room', { members: [chief, writer.id], name: 'Ops 2' })
  assert.equal(later.ok, true)
})

test('a create that fails lets its name go', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const create = ctx.sessionController.create
  ctx.sessionController.create = async () => { throw new Error('dsh is busy') }
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, false)
  ctx.sessionController.create = create
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, true)
})

// #99: the team tools take a Bot's thinking level. `effort` is optional, an empty
// string returns to the model's default, and a level the model does not serve is
// refused before anything about the Bot changes.
const TOOL_REASONING = {
  'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
}

test('create_bot and update_bot advertise an optional thinking level without a fixed enum', async (t) => {
  const { stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  for (const name of ['create_bot', 'update_bot']) {
    const schema = rt.teamTools.find(d => d.name === name).parameters
    assert.equal(schema.properties.effort?.type, 'string')
    assert.equal(schema.required?.includes('effort') ?? false, false)
    assert.equal(schema.properties.effort.enum, undefined)
  }
})

test('update_bot sets, keeps and clears the thinking level', async (t) => {
  const { call, stop, selected, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const tool = args => rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Writer', ...args }, { agent: { id: chief } })
  const current = async () => (await call('state', {})).value.bots.find(bot => bot.id === writer.id)

  assert.equal(await tool({ effort: 'low' }), 'Updated Writer.')
  assert.equal((await current()).effort, 'low')
  await until(() => selected.at(-1)?.sessionId === writer.id && selected.at(-1).reasoningEffort === 'low')

  // Left out, the pick is kept; an empty string returns to the model's default.
  assert.equal(await tool({ instructions: 'Be concise' }), 'Updated Writer.')
  assert.equal((await current()).effort, 'low')
  assert.equal(await tool({ effort: '' }), 'Updated Writer.')
  assert.equal((await current()).effort, undefined)
})

test('update_bot checks a level against the model it names, and a failure changes nothing', async (t) => {
  const reasoning = {
    ...TOOL_REASONING,
    'deepseek/other': { reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] } },
  }
  const { call, stop, selected, sent } = start(undefined, { models: ['deepseek-v4-flash', 'other'], reasoning })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'low' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const tool = args => rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Writer', ...args }, { agent: { id: chief } })
  const current = async () => (await call('state', {})).value.bots.find(bot => bot.id === writer.id)

  // Model and level together resolve the level against the new model.
  assert.equal(await tool({ model: 'deepseek/other', effort: 'medium' }), 'Updated Writer.')
  assert.equal((await current()).model, 'deepseek/other')
  assert.equal((await current()).effort, 'medium')
  await until(() => selected.at(-1)?.sessionId === writer.id && selected.at(-1).reasoningEffort === 'medium')

  // A level the new model does not serve leaves name, model and level as they were.
  assert.match(await tool({ name: 'Renamed', model: 'deepseek/deepseek-v4-flash', effort: 'bogus' }), /^Could not update the Bot: Thinking level bogus is not available/)
  assert.equal((await current()).name, 'Writer')
  assert.equal((await current()).model, 'deepseek/other')
  assert.equal((await current()).effort, 'medium')
  // A level the kept model does not serve fails the same way.
  assert.match(await tool({ effort: 'low' }), /^Could not update the Bot: Thinking level low is not available/)
  assert.equal((await current()).effort, 'medium')
  // A model that is not served fails before anything changes too.
  assert.match(await tool({ name: 'Renamed', model: 'deepseek/nothing' }), /^Could not update the Bot: Model deepseek\/nothing is not available/)
  assert.equal((await current()).name, 'Writer')
})

test('create_bot stores a named thinking level and refuses one without a model', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  const create = args => rt.teamTools.find(d => d.name === 'create_bot').execute(args, exec)
  assert.match(await create({ name: 'Writer', role: 'Write', instructions: 'Write clearly', model: 'deepseek/deepseek-v4-flash', effort: 'low' }), /^Created Writer/)
  const writer = (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.equal(writer.effort, 'low')
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  // A level the model does not serve leaves no Bot behind.
  assert.match(await create({ name: 'Phantom', role: 'Write', instructions: 'Write', model: 'deepseek/deepseek-v4-flash', effort: 'bogus' }), /^Could not create the Bot: Thinking level bogus is not available/)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)
})

test('create_bot with a level but no resolvable model fails before a Session is made', async (t) => {
  // No models are served, so no model can be resolved and an effort has nothing to
  // resolve against.
  const { ctx, call, stop } = start(undefined, { models: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  let created = 0
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => { created += 1; return create(...args) }
  const answer = await rt.teamTools.find(d => d.name === 'create_bot').execute({ name: 'Phantom', role: 'Write', instructions: 'Write', effort: 'low' }, { agent: { id: chief } })
  assert.match(answer, /^Could not create the Bot: Pick a model before choosing a thinking level/)
  assert.equal(created, 0)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)
})

test('a non-Main Bot still cannot change another Bot\u2019s thinking level', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'high' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const exec = { agent: { id: writer.id } }
  assert.match(await rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Chief', effort: 'low' }, exec), /^Only a Main Bot can change another Bot/)
  // Its own level it may change.
  assert.equal(await rt.teamTools.find(d => d.name === 'update_bot').execute({ effort: 'low' }, exec), 'Updated Writer.')
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).effort, 'low')
})

test('list_bot_models names the thinking levels of the models a Bot runs on', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash', 'plain'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  const result = await rt.teamTools.find(d => d.name === 'list_bot_models').execute({}, { agent: { id: chief } })
  assert.match(result, /deepseek\/deepseek-v4-flash.*thinking: low, high \(default: high\)/)
  assert.doesNotMatch(result.split('\n').find(line => line.includes('deepseek/plain')), /thinking/)
})

// #320: create_bot and update_bot take a photo from a local path or a data URL, and
// store it in the same data URL the settings page writes.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

test('API Bot and group avatars use the roster raster validator and exact badge rules', async t => {
  const { stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await rt.load()
  await rt.bootstrap()
  const principal = {
    hasScope: () => true,
    assertBotAccess: () => ({ ok: true }), assertRoomAccess: () => ({ ok: true }),
    canAccessBot: () => true,
  }
  const routes = createApiRoutes(rt, { auth: {}, runs: {}, sseClients: new Set() })
  t.after(() => routes.dispose())
  const api = routes.service
  const bot = await api.createBot(principal, { name: 'Photo worker', avatar: { image: PNG_DATA_URL } })
  const members = [bot.id, rt.state.mainBotIds[0]]
  const group = await api.createGroup(principal, { name: 'Photo team', members, avatar: { image: PNG_DATA_URL } })
  assert.equal(rt.botOf(bot.id).avatar.image, PNG_DATA_URL)
  assert.equal(rt.roomOf(group.id).avatar.image, PNG_DATA_URL)
  const updateBot = avatar => api.updateBot(principal, bot.id, { avatar })
  const updateGroup = avatar => api.updateGroup(principal, group.id, { avatar })
  const badge = agentAvatar('local-acp-api-test').image
  const invalid = [
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
    badge,
  ]
  for (const image of invalid) {
    for (const update of [updateBot, updateGroup]) await assert.rejects(() => update({ image }), /PNG, JPEG, WebP, or GIF/)
    await assert.rejects(() => api.createBot(principal, { name: 'Bad photo', avatar: { image } }), /PNG, JPEG, WebP, or GIF/)
    await assert.rejects(() => api.createGroup(principal, { name: 'Bad group photo', members, avatar: { image } }), /PNG, JPEG, WebP, or GIF/)
  }
  for (const update of [updateBot, updateGroup]) {
    await update(null)
    await update({ image: PNG_DATA_URL })
    await update(undefined)
  }
  assert.equal(rt.botOf(bot.id).avatar.image, PNG_DATA_URL)
  assert.equal(rt.roomOf(group.id).avatar.image, PNG_DATA_URL)
  rt.botOf(bot.id).avatar = { image: badge }
  await updateBot({ image: badge })
  assert.equal(rt.botOf(bot.id).avatar.image, badge, 'an unchanged stored badge is not an upload')
  await assert.rejects(() => updateBot({ image: `${badge} ` }), /PNG, JPEG, WebP, or GIF/)
})
const tempAvatarDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-avatar-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('create_bot and update_bot advertise an optional photo', async (t) => {
  const { stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  for (const name of ['create_bot', 'update_bot']) {
    const schema = rt.teamTools.find(d => d.name === name).parameters
    assert.equal(schema.properties.avatar?.type, 'string')
    assert.equal(schema.required?.includes('avatar') ?? false, false)
    assert.match(schema.properties.avatar.description, /local image path.*data URL/)
    assert.doesNotMatch(schema.properties.avatar.description, /http/)
    assert.match(schema.properties.avatar.description, /256x256/)
  }
})

test('create_bot stores a photo, and update_bot changes and clears it', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const dir = tempAvatarDir(t)
  const photo = join(dir, 'photo.png')
  writeFileSync(photo, PNG_BYTES)
  const exec = { agent: { id: chief } }
  assert.match(await rt.teamTools.find(d => d.name === 'create_bot').execute({ name: 'Writer', role: 'Write', instructions: 'Write', avatar: photo }, exec), /^Created Writer/)
  const writer = async () => (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
  const writerId = (await writer()).id
  await until(() => sent.some(entry => entry.sessionId === writerId))

  const tool = args => rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Writer', ...args }, exec)
  // A mime that does not match the bytes is corrected, not stored as given.
  assert.equal(await tool({ avatar: `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}` }), 'Updated Writer.')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
  // An empty string removes the photo, so the Bot shows its character again.
  assert.equal(await tool({ avatar: '' }), 'Updated Writer.')
  assert.equal((await writer()).avatar, undefined)
  // The photo can be set again after it was cleared.
  assert.equal(await tool({ avatar: PNG_DATA_URL }), 'Updated Writer.')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
})

test('a photo through update_bot keeps the Bot\'s other avatar fields', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  assert.match(await rt.teamTools.find(d => d.name === 'create_bot').execute({ name: 'Writer', role: 'Write', instructions: 'Write' }, exec), /^Created Writer/)
  const writer = async () => (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  const writerId = (await writer()).id
  await until(() => sent.some(entry => entry.sessionId === writerId))
  await call('update-bot', { id: writerId, avatar: { shape: 'fox' } })
  const tool = args => rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Writer', ...args }, exec)
  // Setting a photo keeps the character; clearing the photo keeps it too.
  assert.equal(await tool({ avatar: PNG_DATA_URL }), 'Updated Writer.')
  assert.deepEqual((await writer()).avatar, { shape: 'fox', image: PNG_DATA_URL })
  assert.equal(await tool({ avatar: '' }), 'Updated Writer.')
  assert.deepEqual((await writer()).avatar, { shape: 'fox' })
})

test('a photo in the team\'s data is refused, and one in the team workspace there is read', async (t) => {
  const { ctx, call, stop, home } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  const tool = avatar => rt.teamTools.find(d => d.name === 'update_bot').execute({ avatar }, exec)
  writeFileSync(join(home, 'photo.png'), PNG_BYTES)
  assert.match(await tool(join(home, 'photo.png')), /is in DeepSeek Harness data, so it cannot be a Bot's photo/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar?.image, undefined)
  // The default team workspace lies in the team's data, and the Bots' own files are there.
  const workspace = ctx.workspaceRegistry.get((await call('state', {})).value.workspaceId)?.path ?? join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'photo.png'), PNG_BYTES)
  assert.match(await tool(join(workspace, 'photo.png')), /^Updated /)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar.image, PNG_DATA_URL)
})

test('a photo that cannot be read changes nothing, and a non-Main Bot cannot set another Bot\'s', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const dir = tempAvatarDir(t)
  const notes = join(dir, 'notes.png')
  writeFileSync(notes, 'this is not an image')
  const exec = { agent: { id: chief } }
  assert.match(await rt.teamTools.find(d => d.name === 'create_bot').execute({ name: 'Phantom', role: 'Write', instructions: 'Write', avatar: notes }, exec), /^Could not create the Bot: The avatar must be a PNG, JPEG, WebP, or GIF image/)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)

  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const mine = { agent: { id: writer.id } }
  // Another Bot's photo is a Main Bot's to change, as its other settings are.
  assert.match(await rt.teamTools.find(d => d.name === 'update_bot').execute({ bot: 'Chief', avatar: PNG_DATA_URL }, mine), /^Only a Main Bot can change another Bot/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar?.image, undefined)
  // Its own it may set; a later bad photo leaves the good one alone.
  assert.equal(await rt.teamTools.find(d => d.name === 'update_bot').execute({ avatar: PNG_DATA_URL }, mine), 'Updated Writer.')
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).avatar.image, PNG_DATA_URL)
  assert.match(await rt.teamTools.find(d => d.name === 'update_bot').execute({ avatar: notes }, mine), /^Could not update the Bot: The avatar must be a PNG/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).avatar.image, PNG_DATA_URL)
})

test('old late-round and relay-limit fields of a group load away; calls it parked stay for the next round', async (t) => {
  const parked = [{ id: 'writer', name: 'Writer', note: 'Chief mentioned you', by: 'chief' }]
  const { call, stop, home } = start({
    version: 1,
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['chief', 'writer'], mode: 'admin', admin: 'chief', named: true,
        log: [], seq: 0, seen: {}, lateRounds: 7, quietNoticed: true, quietShown: true, relays: 5, relayLimit: 4, paused: parked,
      },
    },
  })
  t.after(stop)
  const shown = (await call('state', {})).value.rooms.find(room => room.id === 'r1')
  for (const key of ['lateRounds', 'quietNoticed', 'quietShown', 'relays', 'relayLimit', 'relayLimitDefault', 'paused']) assert.equal(key in shown, false, key)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1
  for (const key of ['lateRounds', 'relays', 'relayLimit']) assert.equal(key in saved, false, key)
  assert.deepEqual(saved.paused, parked)

  // A limit sent by an older client changes nothing.
  const set = await call('update-room', { id: 'r1', relayLimit: 4 })
  assert.equal(set.ok, true)
  assert.deepEqual(set.value.changes, [])
})

// #227: a team-level default model for new Bots. A create that names a model keeps it;
// the team's pick comes next, and only when it is still served. Without either, the Bot
// takes its creator's served model, as it always has.
const TEAM_MODEL = {
  version: 1,
  mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', instructions: '', createdAt: 1, model: 'deepseek/deepseek-v4-pro' } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const createBotAs = async (name, args = {}, exec = { agent: { id: 'chief' } }) =>
  rt.teamTools.find(d => d.name === 'create_bot').execute({ name, role: 'R', instructions: '', ...args }, exec)
const botNamed = async name => Object.values(rt.state.bots).find(bot => bot.name === name)

test('create_bot uses a named model, then the team default, then its creator’s', async (t) => {
  const { call, stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  await call('set-prefs', { defaultBotModel: 'deepseek/deepseek-v4-flash' })

  // An explicit model wins over the team default.
  assert.match(await createBotAs('Named', { model: 'deepseek/deepseek-v4-pro' }), /^Created Named/)
  assert.equal((await botNamed('Named')).model, 'deepseek/deepseek-v4-pro')

  // The team default beats the creator's model.
  assert.match(await createBotAs('Defaulted'), /^Created Defaulted/)
  assert.equal((await botNamed('Defaulted')).model, 'deepseek/deepseek-v4-flash')

  // A team default that is no longer served falls back to the creator's model.
  rt.state.prefs.defaultBotModel = 'gone/model'
  assert.match(await createBotAs('Inherited'), /^Created Inherited/)
  assert.equal((await botNamed('Inherited')).model, 'deepseek/deepseek-v4-pro')
})

// A Bot created from inside another Bot's turn is the one path a user reported as
// sharing history (#1196). Its Session, its greeting and its transcript stay its own.
test('a Bot created inside another Bot’s turn gets a Session of its own', async (t) => {
  const { call, stop, sent } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  const before = (await call('state', {})).value
  const chief = before.bots.find(bot => bot.id === before.mainBotId)
  assert.match(await createBotAs('Isolated'), /^Created Isolated/)

  const after = (await call('state', {})).value
  const created = after.bots.find(bot => bot.name === 'Isolated')
  const keptChief = after.bots.find(bot => bot.id === chief.id)
  // Its own chat, not the chat whose turn made it.
  assert.notEqual(created.id, chief.id)
  assert.equal(created.sessionId, created.id)
  assert.ok(!(created.parts ?? []).includes(chief.id))
  // The greeting goes to the new Bot's Session and nowhere else.
  await until(() => sent.length > 0)
  assert.deepEqual([...new Set(sent.map(entry => entry.sessionId))], [created.id])
  // The creator keeps its own chat, and the new Bot's Session is not part of it.
  assert.equal(keptChief.sessionId, chief.sessionId)
  assert.ok(!(keptChief.parts ?? []).includes(created.id))
  // Nothing of the creator's conversation is reachable from the new Bot's chat: it
  // answers with its own Session and no lines, never with the chat that made it.
  const chat = await call('chat', { botId: created.id })
  assert.ok(chat.value === undefined || chat.value.sessionId === created.id, `chat answered for ${chat.value?.sessionId}`)
  assert.deepEqual(chat.value?.items ?? [], [])
})

test('create_bot inherits the creator’s model when no team default is set', async (t) => {
  const { stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  assert.match(await createBotAs('Inherited'), /^Created Inherited/)
  assert.equal((await botNamed('Inherited')).model, 'deepseek/deepseek-v4-pro')
})

test('set-prefs stores a served default model, clears it, and refuses an unknown one', async (t) => {
  const { call, stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  assert.equal((await call('set-prefs', { defaultBotModel: 'deepseek/deepseek-v4-flash' })).value.defaultBotModel, 'deepseek/deepseek-v4-flash')
  // A bare model id resolves to its full ref.
  assert.equal((await call('set-prefs', { defaultBotModel: 'deepseek-v4-pro' })).value.defaultBotModel, 'deepseek/deepseek-v4-pro')
  const refused = await call('set-prefs', { defaultBotModel: 'gone/model' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Model gone\/model is not available/)
  assert.equal(rt.state.prefs.defaultBotModel, 'deepseek/deepseek-v4-pro')
  assert.equal('defaultBotModel' in (await call('set-prefs', { defaultBotModel: null })).value, false)
  assert.equal('defaultBotModel' in rt.state.prefs, false)
})

test('a model-less create-bot starts the Bot on the saved team default model', async (t) => {
  const { call, stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  await call('set-prefs', { defaultBotModel: 'deepseek/deepseek-v4-pro' })

  // The HTTP create names no model: the team's saved pick applies, not the DSH default.
  const defaulted = (await call('create-bot', { name: 'Defaulted' })).value
  assert.equal(defaulted.model, 'deepseek/deepseek-v4-pro')

  // An explicit model still wins over the team default.
  const named = (await call('create-bot', { name: 'Named', model: 'deepseek/deepseek-v4-flash' })).value
  assert.equal(named.model, 'deepseek/deepseek-v4-flash')

  // A saved pick the catalog no longer serves falls back to the DSH default…
  rt.state.prefs.defaultBotModel = 'gone/model'
  const stale = (await call('create-bot', { name: 'Stale' })).value
  assert.equal(stale.model, 'deepseek/deepseek-v4-flash')

  // …and so does a create once the pick is cleared.
  await call('set-prefs', { defaultBotModel: null })
  const plain = (await call('create-bot', { name: 'Plain' })).value
  assert.equal(plain.model, 'deepseek/deepseek-v4-flash')
})

// A window opened while the old dsh was still running reads the team read-only. When
// that dsh goes away this host takes the lock over on its next poll, and the answer's
// live fields say so: the window goes writable without a reload.
test('a window learns that the other dsh closed and takes the team over without a reload', async (t) => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.after(() => holder.kill())
  const { call, stop } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief' } } }, {
    models: ['deepseek-v4-flash'],
    lock: { pid: holder.pid, host: hostname(), token: 'other', since: Date.now() },
  })
  t.after(stop)

  const first = (await call('state', {})).value
  assert.match(first.readOnly ?? '', /open in another dsh/)
  const refused = await call('create-bot', { name: 'Refused' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/read-only')

  // The other dsh closes; the next poll takes the lock over and says so in the same
  // unchanged answer a window with this live key receives.
  const exited = new Promise(resolve => holder.once('exit', resolve))
  holder.kill()
  await exited
  const live = (await call('state', { since: first.revision, models: first.modelsKey, live: first.liveKey })).value
  assert.equal(live.unchanged, true)
  assert.equal(live.readOnly, null)
  assert.notEqual(live.liveKey, first.liveKey, 'a changed read-only notice moves the live key')
  assert.equal((await call('create-bot', { name: 'Took over' })).ok, true)
})

// #1929: a Bot's own Session can vanish from the Session library while its id stays
// pinned in the team state. Model syncing must not ask that id again on every sync, and
// missing-session recovery must work when there is no agent to move on from.
test('a Session gone from the library is marked once, and recover-session replaces it', async (t) => {
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        segments: [{ sessionId: 'earlier-ok', endedAt: 1 }],
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
  const movedSchedules = []
  const schedules = {
    catalog: async () => [{ id: 'sch-1', status: 'active', target: { kind: 'session', sessionId: 'gone-session' } }],
    edit: async (req) => { movedSchedules.push(req) },
  }
  const { call, stop, selected, attempts } = start(team, {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    lost: new Set(['gone-session']),
    schedules,
  })
  t.after(stop)

  // A model change is the sync that meets the lost Session first.
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  assert.deepEqual(attempts.filter(entry => entry.sessionId === 'gone-session').map(entry => entry.model), ['deepseek-v4-pro'])
  let chief = (await call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionMissing, 'gone-session')

  // The next sync skips the marked id instead of asking again.
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-flash' })).ok, true)
  assert.equal(attempts.filter(entry => entry.sessionId === 'gone-session').length, 1)

  // `recover-session` retires the missing Session cleanly without adding it to `segments`,
  // clears sessionMissing, preserves readable earlier segments, and retargets schedules.
  const recovered = await call('recover-session', { botId: 'chief' })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.value.recovered, true)
  chief = (await call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionId, recovered.value.sessionId)
  assert.notEqual(chief.sessionId, 'gone-session')
  assert.equal(chief.sessionMissing, undefined)
  assert.deepEqual(chief.parts, ['earlier-ok'])
  assert.equal(rt.chatOwners.has('gone-session'), false)
  assert.equal(rt.pastOwners.has('gone-session'), false)
  assert.deepEqual(movedSchedules, [{ id: 'sch-1', action: 'update', patch: { target: { kind: 'session', sessionId: chief.sessionId } } }])
  const fresh = selected.filter(entry => entry.sessionId === chief.sessionId)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].model, 'deepseek-v4-flash')

  // Calling recover-session on a healthy Session keeps it intact instead of replacing it.
  const healthy = await call('recover-session', { botId: 'chief' })
  assert.equal(healthy.ok, true)
  assert.equal(healthy.value.recovered, false)
  assert.equal(healthy.value.sessionId, chief.sessionId)

  // The replaced part is retired, so later syncs do not ask it either.
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  assert.equal(attempts.filter(entry => entry.sessionId === 'gone-session').length, 1)
})

test('recover-session refuses read-only windows and missing task Sessions skip retries without marking sessionMissing', async (t) => {
  // Missing active task Session is skipped after one not-found without setting bot.sessionMissing.
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'live-session',
        tasks: [{ id: 'task-1', sessionId: 'gone-task', status: 'running', title: 'Bg', startedAt: 1, updatedAt: 1 }],
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const { call, stop, attempts } = start(team, {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    lost: new Set(['gone-task']),
  })
  t.after(stop)

  await call('state', {})
  // Attach a live active task after boot (startup reconciles persisted running tasks as orphans).
  rt.botOf('chief').tasks = [{ id: 'task-1', sessionId: 'gone-task', status: 'running', title: 'Bg', startedAt: 1, updatedAt: 1 }]
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  assert.equal(attempts.filter(entry => entry.sessionId === 'gone-task').length, 1)
  const chief = (await call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionMissing, undefined)

  // Subsequent sync skips the gone task session; forgetSessionModel clears the remembered skip.
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-flash' })).ok, true)
  assert.equal(attempts.filter(entry => entry.sessionId === 'gone-task').length, 1)
  rt.forgetSessionModel('gone-task')
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  assert.equal(attempts.filter(entry => entry.sessionId === 'gone-task').length, 2)

  // Read-only window refuses recover-session before mutating anything.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.after(() => holder.kill())
  const roTeam = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        sessionMissing: 'gone-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const ro = start(roTeam, {
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
    lock: { pid: holder.pid, host: hostname(), token: 'other', since: Date.now() },
  })
  t.after(ro.stop)
  const denied = await ro.call('recover-session', { botId: 'chief' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'bot/read-only')
  await assert.rejects(rt.recoverMissingSession('chief'), { code: 'bot/read-only' })
})

test('concurrent model edit during missing-Session recovery is re-applied to the fresh Session', async (t) => {
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        sessionMissing: 'gone-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const { call, stop, ctx, selected } = start(team, {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    lost: new Set(['gone-session']),
  })
  t.after(stop)
  // Let bootstrap's model sync finish before recovery starts: a sync still in flight
  // would write the new model to the fresh Session on its own and hide the recheck.
  await call('state', {})
  await settle()

  // Hold the fresh Session's permission step: `picked` has already read the Bot's old
  // model and written it to the fresh Session, so the concurrent edit lands between
  // that read and the post-registration recheck.
  let freshId
  let permissionStarted
  let releasePermission
  const permissionReached = new Promise(resolve => { permissionStarted = resolve })
  const released = new Promise(resolve => { releasePermission = resolve })
  let held = false
  const origCreate = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => {
    const created = await origCreate(...args)
    freshId = created.sessionId
    return created
  }
  const origApplyPermission = rt.applyPermission
  rt.applyPermission = async (...args) => {
    if (!held && args[1] === freshId) {
      held = true
      permissionStarted()
      await released
    }
    return origApplyPermission(...args)
  }

  const recovering = call('recover-session', { botId: 'chief' })
  await permissionReached
  assert.deepEqual(selected.filter(entry => entry.sessionId === freshId).map(entry => entry.model), ['deepseek-v4-flash'])
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  releasePermission()
  assert.equal((await recovering).ok, true)

  // Read the runtime directly so a `state` refresh does not trigger another sync.
  const chief = rt.botOf('chief')
  assert.equal(chief.sessionId, freshId)
  const freshSelections = selected.filter(entry => entry.sessionId === freshId)
  assert.deepEqual(freshSelections.map(entry => entry.model), ['deepseek-v4-flash', 'deepseek-v4-pro'])
})

test('restoring a missing Session heals sessionMissing and re-applies the Bot model', async (t) => {
  const lost = new Set(['restored-session'])
  const listed = new Set()
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'restored-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const first = start(team, {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    lost,
    listed,
  })
  t.after(first.stop)

  // Model change while Session is missing marks sessionMissing without lying that the new model applied.
  assert.equal((await first.call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  let chief = (await first.call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionMissing, 'restored-session')
  const savedAfterMiss = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
  assert.equal(savedAfterMiss.bots.chief.appliedModel, 'deepseek/deepseek-v4-flash')

  // Simulate restart after the Session is restored into the library, even if appliedModel already matched.
  const restoredTeam = {
    ...savedAfterMiss,
    bots: {
      chief: {
        ...savedAfterMiss.bots.chief,
        appliedModel: 'deepseek/deepseek-v4-pro',
      },
    },
  }
  const restored = start(restoredTeam, {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    lost: new Set(),
    listed: new Set(['restored-session']),
  })
  t.after(restored.stop)

  await restored.call('state', {})
  await until(() => restored.selected.some(entry => entry.sessionId === 'restored-session' && entry.model === 'deepseek-v4-pro'))
  chief = (await restored.call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionMissing, undefined)
})

test('buffered silent notes survive missing-Session recovery onto the fresh Session', async (t) => {
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        sessionMissing: 'gone-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  let failFlush = true
  let flushes = 0
  const { call, stop, injected } = start(team, {
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
    flush: async () => {
      flushes += 1
      if (failFlush) {
        failFlush = false
        throw new Error('transient flush error')
      }
    },
  })
  t.after(stop)
  await call('state', {})

  // Persisted silent note restored onto the missing Session stays buffered while owned.
  const note = {
    id: 'silent-note-1',
    content: [{ type: 'text', text: '[Note from Peer · FYI only, no reply needed]\nKeep this note across recovery.' }],
    source: { kind: 'ds-bot', role: 'note', exchangeId: 'ex-silent-1' },
  }
  await rt.restoreSilentNotes({ 'gone-session': [{ message: note }] })
  assert.equal(injected.length, 0)

  // First flush fails during `recover-session`, leaving `state.switching['gone-session']`
  // with `missing: true` for `handOnHeld` retry; no note is dropped.
  const recovered = await call('recover-session', { botId: 'chief' })
  assert.equal(recovered.ok, true)
  const freshId = recovered.value.sessionId
  assert.notEqual(freshId, 'gone-session')
  assert.equal(rt.state.switching['gone-session']?.missing, true)
  assert.equal(flushes, 1)

  // Retry path (`handOnHeld`) flushes the migrated silent note onto the fresh Session
  // without duplicating it and clears the recovery record.
  await rt.heldBack()
  assert.equal(flushes, 2)
  const delivered = injected.filter(entry => entry.sessionId === freshId && entry.message?.source?.exchangeId === 'ex-silent-1')
  assert.equal(delivered.length, 1)
  assert.equal(rt.state.switching['gone-session'], undefined)

  // Direct recovery path (when flush succeeds immediately) also moves silent notes
  // before dropping the lost Session from `chatOwners`.
  const direct = start(team, {
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(direct.stop)
  await direct.call('state', {})
  await rt.restoreSilentNotes({ 'gone-session': [{ message: note }] })
  const directRecovered = await direct.call('recover-session', { botId: 'chief' })
  assert.equal(directRecovered.ok, true)
  assert.deepEqual(
    direct.injected.filter(entry => entry.sessionId === directRecovered.value.sessionId).map(entry => entry.message?.source?.exchangeId),
    ['ex-silent-1'],
  )
  assert.equal(rt.state.switching['gone-session'], undefined)
})

test('kickoff greeting is preserved while a Bot Session is missing and sent after recovery', async (t) => {
  const greeting = { text: 'Hello from kickoff', from: null, main: true }
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        kickoff: { ...greeting },
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const { call, stop, home, sent } = start(team, {
    models: ['deepseek-v4-pro'],
    lost: new Set(['gone-session']),
  })
  t.after(stop)

  // Picking a model while the Session is gone marks `sessionMissing` and must not consume `kickoff`.
  assert.equal((await call('update-bot', { id: 'chief', model: 'deepseek/deepseek-v4-pro' })).ok, true)
  await settle()
  let chief = (await call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.sessionMissing, 'gone-session')
  assert.equal(chief.waiting, true)
  const savedWhileMissing = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(savedWhileMissing.bots.chief.kickoff, greeting)
  assert.equal(sent.length, 0)

  // Replacing the missing Session clears `sessionMissing` and delivers the held greeting to the fresh Session.
  const recovered = await call('recover-session', { botId: 'chief' })
  assert.equal(recovered.ok, true)
  const freshId = recovered.value.sessionId
  await until(() => sent.some(entry => entry.sessionId === freshId && entry.message?.source?.role === 'kickoff'))
  chief = (await call('state', {})).value.bots.find(bot => bot.id === 'chief')
  assert.equal(chief.waiting, undefined)

  // Restoring/healing a missing Session also preserves and delivers the held greeting.
  const healedRun = start(savedWhileMissing, {
    models: ['deepseek-v4-pro'],
    lost: new Set(),
    listed: new Set(['gone-session']),
  })
  t.after(healedRun.stop)
  await healedRun.call('state', {})
  await until(() => healedRun.sent.some(entry => entry.sessionId === 'gone-session' && entry.message?.source?.role === 'kickoff'))
})

test('persisted silent notes survive missing-Session recovery when recovery runs before startup replay', async (t) => {
  const note = {
    id: 'silent-startup-race-1',
    content: [{ type: 'text', text: '[Note from Peer · FYI only, no reply needed]\nDo not lose me before startup replay.' }],
    source: { kind: 'ds-bot', role: 'note', exchangeId: 'ex-startup-race-1' },
  }
  const team = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        sessionMissing: 'gone-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roster-race-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())

  // Boot with the silent note ONLY persisted on disk under `gone-session` (not in memory).
  const first = start(team, {
    home,
    keepHome: true,
    inflight: { turns: {}, queued: {}, silent: { 'gone-session': [{ message: note }] } },
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(first.stop)

  await first.call('state', {})
  assert.equal(first.injected.length, 0, 'startup replay timer has not fired yet')

  // Trigger missing-Session recovery BEFORE the 3s startup replay timer fires.
  const recovered = await first.call('recover-session', { botId: 'chief' })
  assert.equal(recovered.ok, true)
  const freshId = recovered.value.sessionId
  assert.notEqual(freshId, 'gone-session')
  assert.deepEqual(
    first.injected.filter(entry => entry.sessionId === freshId).map(entry => entry.message?.source?.exchangeId),
    ['ex-startup-race-1'],
  )
  assert.equal(first.rt.state.switching['gone-session'], undefined)

  // Now let startup replay (`resumeAll` -> `restoreSilentNotes`) and `heldBack` fire:
  // the note must not be dropped or duplicated.
  t.mock.timers.tick(3500)
  await first.rt.flushInflight?.()
  t.mock.timers.reset()
  await settle()
  assert.deepEqual(
    first.injected.filter(entry => entry.sessionId === freshId).map(entry => entry.message?.source?.exchangeId),
    ['ex-startup-race-1'],
  )
  await first.stop()

  // A subsequent restart on the same home must not replay the already-delivered note.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = start(undefined, {
    home,
    keepHome: true,
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(second.stop)
  await second.call('state', {})
  t.mock.timers.tick(3500)
  t.mock.timers.reset()
  await settle()
  assert.equal(second.injected.length, 0)
})

test('missing-Session recovery commits replacement ownership before removing silent notes across crash boundaries', async (t) => {
  const note = {
    id: 'silent-crash-window-1',
    content: [{ type: 'text', text: '[Note from Peer · FYI only, no reply needed]\nSurvive any crash boundary.' }],
    source: { kind: 'ds-bot', role: 'note', exchangeId: 'ex-crash-window-1' },
  }
  const makeTeam = () => ({
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', name: 'Chief', role: '', instructions: '', createdAt: 1, sessionId: 'gone-session',
        sessionMissing: 'gone-session',
        model: 'deepseek/deepseek-v4-flash', appliedModel: 'deepseek/deepseek-v4-flash',
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  })

  // 1) Failure/crash BEFORE `rt.save()` commits: persisted silent notes must stay under
  //    `gone-session` (never deleted or moved onto an unowned replacement Session).
  const homeBeforeSave = mkdtempSync(join(tmpdir(), 'ds-bot-roster-crash-before-'))
  const statePathBeforeSave = join(homeBeforeSave, 'state.json')
  const origRename = fsp.rename
  let failStateRename = false
  fsp.rename = async (from, to) => {
    if (failStateRename && to === statePathBeforeSave) {
      throw Object.assign(new Error('simulated crash before state.json commit'), { code: 'EIO' })
    }
    return origRename(from, to)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.rename = origRename
    syncBuiltinESMExports()
    rmSync(homeBeforeSave, { recursive: true, force: true, maxRetries: 5 })
  })

  const beforeCrash = start(makeTeam(), {
    home: homeBeforeSave,
    keepHome: true,
    inflight: { turns: {}, queued: {}, silent: { 'gone-session': [{ message: note }] } },
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  await beforeCrash.call('state', {})
  failStateRename = true
  const failedRecover = await beforeCrash.call('recover-session', { botId: 'chief' })
  assert.equal(failedRecover.ok, false)
  assert.equal(beforeCrash.injected.length, 0, 'no silent note may flush to an uncommitted replacement Session')
  await beforeCrash.rt.flushInflight?.()
  const stateStillOld = JSON.parse(readFileSync(statePathBeforeSave, 'utf8'))
  assert.equal(stateStillOld.bots.chief.sessionId, 'gone-session')
  const inflightStillOld = JSON.parse(readFileSync(join(homeBeforeSave, 'inflight.json'), 'utf8'))
  assert.equal(inflightStillOld.silent?.['gone-session']?.length, 1)
  await beforeCrash.stop()

  // Restart after pre-save crash: `gone-session` is still owned, and recovery delivers the note once.
  failStateRename = false
  const afterPreSaveCrash = start(undefined, {
    home: homeBeforeSave,
    keepHome: true,
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(afterPreSaveCrash.stop)
  await afterPreSaveCrash.call('state', {})
  let diskStateAtMove
  const origMove = afterPreSaveCrash.rt.moveSilentNotes
  afterPreSaveCrash.rt.moveSilentNotes = (...args) => {
    diskStateAtMove = JSON.parse(readFileSync(statePathBeforeSave, 'utf8'))
    return origMove(...args)
  }
  const recoveredAfterRestart = await afterPreSaveCrash.call('recover-session', { botId: 'chief' })
  assert.equal(recoveredAfterRestart.ok, true)
  const freshAfterRestart = recoveredAfterRestart.value.sessionId
  assert.equal(diskStateAtMove?.bots?.chief?.sessionId, freshAfterRestart, 'state.json must own freshId before moveSilentNotes runs')
  assert.equal(diskStateAtMove?.switching?.['gone-session']?.missing, true, 'state.json must persist recovery lineage before moveSilentNotes runs')
  assert.deepEqual(
    afterPreSaveCrash.injected.filter(entry => entry.sessionId === freshAfterRestart).map(entry => entry.message?.source?.exchangeId),
    ['ex-crash-window-1'],
  )

  // 2) Crash AFTER `rt.save()` committed `fresh-committed` + `state.switching['gone-session']`,
  //    BEFORE `moveSilentNotes` removed `gone-session`'s persisted silent note.
  const postSaveTeam = {
    ...makeTeam(),
    bots: {
      chief: {
        ...makeTeam().bots.chief,
        sessionId: 'fresh-committed',
        sessionMissing: undefined,
      },
    },
    switching: { 'gone-session': { botId: 'chief', missing: true } },
  }

  // 2a) Restart where startup replay (`resumeAll` -> `restoreSilentNotes`) runs first:
  const homePostSaveReplay = mkdtempSync(join(tmpdir(), 'ds-bot-roster-crash-after-a-'))
  t.after(() => rmSync(homePostSaveReplay, { recursive: true, force: true, maxRetries: 5 }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const restartA = start(postSaveTeam, {
    home: homePostSaveReplay,
    keepHome: true,
    inflight: { turns: {}, queued: {}, silent: { 'gone-session': [{ message: note }] } },
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(restartA.stop)
  await restartA.call('state', {})
  t.mock.timers.tick(3500)
  t.mock.timers.reset()
  await until(() => restartA.injected.some(entry => entry.sessionId === 'fresh-committed'))
  await settle()
  assert.deepEqual(
    restartA.injected.filter(entry => entry.sessionId === 'fresh-committed').map(entry => entry.message?.source?.exchangeId),
    ['ex-crash-window-1'],
  )
  assert.equal(restartA.rt.state.switching['gone-session'], undefined)

  // 2b) Restart where `handOnHeld` runs BEFORE the 3s startup replay timer fires (e.g. schedules attach early):
  const homePostSaveHeld = mkdtempSync(join(tmpdir(), 'ds-bot-roster-crash-after-b-'))
  t.after(() => rmSync(homePostSaveHeld, { recursive: true, force: true, maxRetries: 5 }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const restartB = start(postSaveTeam, {
    home: homePostSaveHeld,
    keepHome: true,
    inflight: { turns: {}, queued: {}, silent: { 'gone-session': [{ message: note }] } },
    models: ['deepseek-v4-flash'],
    lost: new Set(['gone-session']),
  })
  t.after(restartB.stop)
  await restartB.call('state', {})
  await restartB.rt.heldBack()
  assert.deepEqual(
    restartB.injected.filter(entry => entry.sessionId === 'fresh-committed').map(entry => entry.message?.source?.exchangeId),
    ['ex-crash-window-1'],
  )
  assert.equal(restartB.rt.state.switching['gone-session'], undefined)
  t.mock.timers.tick(3500)
  t.mock.timers.reset()
  await settle()
  assert.deepEqual(
    restartB.injected.filter(entry => entry.sessionId === 'fresh-committed').map(entry => entry.message?.source?.exchangeId),
    ['ex-crash-window-1'],
  )
})
