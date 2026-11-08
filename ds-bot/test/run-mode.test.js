import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntime } from '../index.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { probeSignIn } from '../src/host/local-agents/discover.js'
import { agentAvatar, badgeOf, isLocalRoute, modelsFor } from '../src/client/agent-routes.js'
import { avatarAfter, createPayload, runModeNotes, startModel } from '../src/client/bot-draft.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, what = 'the condition') => {
  const end = Date.now() + 4000
  while (!await check()) {
    if (Date.now() > end) throw new Error(`until: ${what} did not hold within 4 s`)
    await settle()
  }
}
const textOf = message => message.content.map(block => block.text ?? '').join('')

const DS = 'ds/flash'
const CLI = 'local-acp-fake/default'
const CLI2 = 'local-acp-other/default'

const team = (bots = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, model: DS, appliedModel: DS },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, model: DS, appliedModel: DS },
    ...bots,
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } },
    r2: { id: 'r2', name: 'Dev', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb2' } },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  localAgents: {
    custom: [
      { id: 'fake', name: 'Fake Agent', command: process.execPath, args: [FIXTURE('counting-acp.mjs'), '__STARTS__'] },
      { id: 'other', name: 'Other Agent', command: process.execPath, args: [FIXTURE('counting-acp.mjs'), '__STARTS__'] },
    ],
    sessions: {},
  },
})

// DSH's provider registry, as far as these rules use it: one model provider, and the
// routes the local agent adapter registers.
function fakeLlm() {
  const routes = new Map()
  return {
    calls: 0,
    async *stream() {
      this.calls += 1
      throw new Error('a switch of run mode makes no model call')
    },
    listProviders: () => [{ id: 'ds', name: 'DS' }, ...[...routes.keys()].map(id => ({ id, name: routes.get(id).providerInfo(id).name }))],
    listModels: async (provider) => {
      if (provider === 'ds') return [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }]
      if (!routes.has(provider)) throw new Error(`no adapter for ${provider}`)
      return routes.get(provider).listModels(provider)
    },
    resolveModelInfo: async (provider, model) => (routes.has(provider) ? routes.get(provider).resolveModel(provider, model) : {}),
    registerAdapter(list, adapter) {
      const put = (next) => { routes.clear(); for (const route of next) routes.set(route, adapter) }
      put(list)
      const handle = () => routes.clear()
      handle.replace = put
      return handle
    },
    routes,
  }
}

async function start(t, { saved = team() } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-run-mode-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const starts = join(root, 'starts.log')
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved).replaceAll('__STARTS__', starts.replaceAll('\\', '\\\\')))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const llm = fakeLlm()
  const ctx = fakeContext({})
  const created = []
  const archived = []
  const selected = []
  // What each Session's last request went to, which requestHeader() folds from the log.
  const lastRoute = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId, header: { cwd: workspace },
          requestHeader: () => (lastRoute.has(sessionId) ? { config: lastRoute.get(sessionId) } : undefined),
          deriveMessages: () => [],
        },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        send(message, target) { calls.push(['send', message, target]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(queued => queued.id === id)
              if (at !== -1) list.splice(at, 1)
            }
          },
          prepend(target, queued) { (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(queued) },
        },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: workspace, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm,
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(entry => entry.path === path),
      create: async (path) => { const entry = { id: 'w-new', path, title: 'DS Bot' }; registry.set(entry.id, entry); return entry },
      archiveSession: async (id, options) => { archived.push([id, options]) },
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        return { sessionId }
      },
      prompt: async () => ({ accepted: true }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async ({ sessionId, provider, model }) => {
        if (provider !== 'ds' && !llm.routes.has(provider)) throw new Error(`no adapter for ${provider}`)
        selected.push([sessionId, `${provider}/${model}`])
      },
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
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // `modelSelection`: where the step is about to go, as DSH captured it for the step.
  const preStep = (sessionId, messages = [], step = 1, modelSelection) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000), ...(modelSelection === undefined ? {} : { modelSelection }) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const handoffOf = sessionId => agentOf(sessionId).calls.filter(([kind, message]) => kind === 'followup' && message.source?.role === 'handoff').map(([, message]) => textOf(message)).at(-1)
  const startCount = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').length : 0)
  await tool('list_bots', {}, 'a')
  // Everything a route could not register for until the state load has finished.
  await until(() => llm.routes.has('local-acp-fake'), 'the custom routes')
  return { rt, ctx, llm, call, tool, preStep, state, agentOf, handoffOf, created, archived, selected, lastRoute, starts, startCount, root }
}

// -----------------------------------------------------------------------------
// Who may change what a Bot runs on.

test('a Bot cannot move itself or another Bot across run modes', async (t) => {
  const env = await start(t)
  const own = await env.tool('update_bot', { model: CLI }, 'b')
  assert.match(own, /Only the user can change what Writer runs on/)
  const other = await env.tool('update_bot', { bot: 'Writer', model: CLI }, 'a')
  assert.match(other, /Only the user can change what Writer runs on/)
  assert.equal(env.state().bots.b.model, DS)
})

test('a model inside the same run mode stays an ordinary change', async (t) => {
  const env = await start(t)
  assert.match(await env.tool('update_bot', { model: 'ds/pro' }, 'b'), /Updated Writer/)
  assert.equal(env.state().bots.b.model, 'ds/pro')
  assert.equal(env.state().bots.b.sessionId, 'b')
  assert.deepEqual(env.created, [])
})

test('the user has to confirm a change of run mode', async (t) => {
  const env = await start(t)
  const refused = await env.call('update-bot', { id: 'b', model: CLI })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /needs a confirmation/)
  assert.equal(env.state().bots.b.model, DS)
  // Between two CLIs too.
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  assert.equal((await env.call('update-bot', { id: 'b', model: CLI2 })).ok, false)
  assert.equal(env.state().bots.b.model, CLI)
})

test('a Bot without a model of its own still moves to a CLI only by the user, confirmed', async (t) => {
  const env = await start(t, { saved: team({
    c: { id: 'c', name: 'Unset', role: '', sessionId: 'c', createdAt: 3, appliedModel: DS },
    d: { id: 'd', name: 'Fresh', role: '', sessionId: 'd', createdAt: 4 },
  }) })
  for (const name of ['Unset', 'Fresh']) {
    assert.match(await env.tool('update_bot', { bot: name, model: CLI }, 'a'), new RegExp(`Only the user can change what ${name} runs on`))
  }
  for (const id of ['c', 'd']) {
    const refused = await env.call('update-bot', { id, model: CLI })
    assert.equal(refused.ok, false)
    assert.match(refused.error.message, /needs a confirmation/)
  }
  assert.equal(env.state().bots.c.model, undefined)
  assert.equal(env.state().bots.d.model, undefined)
  // A model of DS Bot's own is an ordinary pick.
  assert.equal((await env.call('update-bot', { id: 'd', model: 'ds/pro' })).ok, true)
  assert.equal(env.state().bots.d.model, 'ds/pro')
})

test('a Bot on a CLI keeps a model of it', async (t) => {
  const env = await start(t, { saved: team({ c: { id: 'c', name: 'Local', role: '', sessionId: 'c', createdAt: 3, model: CLI, appliedModel: CLI } }) })
  const cleared = await env.call('update-bot', { id: 'c', model: null })
  assert.equal(cleared.ok, false)
  assert.match(cleared.error.message, /keeps a model of it/)
  assert.equal(env.state().bots.c.model, CLI)
})

// -----------------------------------------------------------------------------
// The switch.

test('confirmed, the own chat and every group move on at once, with a handoff and no model call', async (t) => {
  const env = await start(t)
  for (const id of ['b', 'gb', 'gb2']) env.lastRoute.set(id, { provider: 'ds', model: 'flash' })
  const done = await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  assert.equal(done.ok, true)
  await until(() => env.created.length === 3, 'three fresh parts')
  await until(() => env.archived.length === 3, 'the earlier parts archived')
  const saved = env.state()
  const bot = saved.bots.b
  assert.equal(bot.segments.at(-1).sessionId, 'b')
  assert.equal(bot.segments.at(-1).fallback, 'engine')
  assert.notEqual(bot.sessionId, 'b')
  assert.equal(saved.rooms.r1.segments.b.at(-1).sessionId, 'gb')
  assert.notEqual(saved.rooms.r1.sessions.b, 'gb')
  assert.equal(saved.rooms.r2.segments.b.at(-1).sessionId, 'gb2')
  assert.equal(env.llm.calls, 0)
  for (const fresh of [bot.sessionId, saved.rooms.r1.sessions.b, saved.rooms.r2.sessions.b]) {
    assert.match(env.handoffOf(fresh), /the user changed what you run on, to Fake Agent/)
    assert.match(env.handoffOf(fresh), /You now run on Fake Agent\./)
    assert.ok(env.selected.some(([sessionId, ref]) => sessionId === fresh && ref === CLI), `${fresh} runs on the CLI`)
  }
  // The other member is left alone.
  assert.equal(saved.bots.a.segments, undefined)
})

test('a group conversation that never made a request needs no new part', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'flash' })
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  await until(() => env.created.length === 1, 'one fresh part')
  await settle()
  assert.equal(env.state().rooms.r1.sessions.b, 'gb')
  assert.ok(env.selected.some(([sessionId, ref]) => sessionId === 'gb' && ref === CLI))
})

test('a running turn moves on at its next step and keeps its input', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'flash' })
  env.agentOf('b').status = 'running'
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  await settle()
  assert.deepEqual(env.created, [])
  const input = createUserMessage({ content: [{ type: 'text', text: 'still needed' }], source: { kind: 'user' } })
  const step = await env.preStep('b', [input], 2)
  assert.deepEqual(step, { kind: 'reject' })
  // A fresh part is made before the state names it.
  await until(() => env.archived.some(([id]) => id === 'b'), 'the fresh part')
  const fresh = env.state().bots.b.sessionId
  await until(() => env.agentOf(fresh).calls.some(([, message]) => textOf(message) === 'still needed'), 'the carried input')
  assert.match(env.handoffOf(fresh) ?? '', /./)
})

test('coming back to the same run mode moves on again, in both directions', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'flash' })
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  // The state names the fresh part before its handoff goes out; the earlier part is
  // archived only once the move has finished.
  await until(() => env.archived.some(([id]) => id === 'b'), 'the move to the CLI')
  const onCli = env.state().bots.b.sessionId
  env.lastRoute.set(onCli, { provider: 'local-acp-fake', model: 'default' })
  await env.call('update-bot', { id: 'b', model: DS, changeEngine: true })
  await until(() => env.archived.some(([id]) => id === onCli), 'the move back')
  const back = env.state().bots.b.sessionId
  assert.match(env.handoffOf(back), /to the model ds\/flash/)
  assert.equal(env.state().bots.b.segments.length, 2)
})

test('an earlier part of the other run mode, opened again, moves on at its next step', async (t) => {
  const env = await start(t, { saved: team({ c: { id: 'c', name: 'Old', role: '', sessionId: 'c', createdAt: 3, model: CLI, appliedModel: CLI } }) })
  env.lastRoute.set('c', { provider: 'ds', model: 'flash' })
  const step = await env.preStep('c', [], 1)
  assert.deepEqual(step, { kind: 'enter', messages: [] })
  await until(() => env.state().bots.c.sessionId !== 'c', 'the fresh part')
})

test('a part already on the Bot\'s run mode just goes on', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'pro' })
  assert.equal(await env.preStep('b'), 'next')
  assert.deepEqual(env.created, [])
})

test('a part whose new route cannot be selected does not move on at every step', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'flash' })
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  await until(() => env.state().bots.b.sessionId !== 'b', 'the fresh part')
  // The next pre-step of a part that made its request elsewhere stays put once it failed to follow.
  const fresh = env.state().bots.b.sessionId
  const select = env.ctx.sessionController.selectModel
  env.ctx.sessionController.selectModel = async () => { throw new Error('no route') }
  env.lastRoute.set(fresh, { provider: 'ds', model: 'flash' })
  assert.deepEqual(await env.preStep(fresh), { kind: 'enter', messages: [] })
  await until(() => env.state().bots.b.sessionId !== fresh, 'the second part')
  const stuck = env.state().bots.b.sessionId
  env.ctx.sessionController.selectModel = select
  env.lastRoute.set(stuck, { provider: 'ds', model: 'flash' })
  // Meanwhile it takes no step on the other side: its input waits in its inbox.
  const input = createUserMessage({ content: [{ type: 'text', text: 'wait for me' }], source: { kind: 'user' } })
  assert.deepEqual(await env.preStep(stuck, [input]), { kind: 'enter', messages: [] })
  assert.deepEqual(env.agentOf(stuck).inbox.nextTurn.map(textOf), ['wait for me'])
  assert.equal(env.state().bots.b.sessionId, stuck)
  // After the wait it tries again, and the input goes along.
  const now = Date.now.bind(Date)
  t.mock.method(Date, 'now', () => now() + 600_000)
  assert.deepEqual(await env.preStep(stuck), { kind: 'enter', messages: [] })
  await until(() => env.state().bots.b.sessionId !== stuck, 'the next try')
  const next = env.state().bots.b.sessionId
  await until(() => env.agentOf(next).calls.some(([, message]) => textOf(message) === 'wait for me'), 'the kept input')
})

test('a fresh part whose run mode did not apply waits instead of running on the other side', async (t) => {
  const env = await start(t)
  env.lastRoute.set('b', { provider: 'ds', model: 'flash' })
  const select = env.ctx.sessionController.selectModel
  // The fresh parts (s1, s2, …) cannot select the CLI.
  env.ctx.sessionController.selectModel = async (options) => {
    if (/^s\d+$/.test(options.sessionId) && options.provider === 'local-acp-fake') throw new Error('no route')
    return select(options)
  }
  await env.call('update-bot', { id: 'b', model: CLI, changeEngine: true })
  await until(() => env.state().bots.b.sessionId !== 'b', 'the fresh part')
  const fresh = env.state().bots.b.sessionId
  // It never made a request; the step it is about to take would go to a model.
  const input = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  assert.deepEqual(await env.preStep(fresh, [input], 1, { provider: 'ds', model: 'flash' }), { kind: 'enter', messages: [] })
  assert.deepEqual(env.agentOf(fresh).inbox.nextTurn.map(textOf), ['hello'])
  assert.equal(env.state().bots.b.sessionId, fresh)
  // A step to what the Bot runs on goes on.
  assert.equal(await env.preStep(fresh, [], 1, { provider: 'local-acp-fake', model: 'default' }), 'next')
})

// -----------------------------------------------------------------------------
// No Bot lands on a local agent, or leaves one, by itself.

test('a fallback never crosses the line, in either direction', async (t) => {
  const env = await start(t, { saved: { ...team({ c: { id: 'c', name: 'Local', role: '', sessionId: 'c', createdAt: 3, model: 'local-acp-gone/default', appliedModel: 'local-acp-gone/default' } }) } })
  const { rt } = env
  // A CLI that is gone stays the Bot's own.
  assert.equal(await rt.desiredModel(rt.botOf('c')), 'local-acp-gone/default')
  // A model that is gone falls to a model, not to a CLI it last ran on.
  const lost = { id: 'x', model: 'ds/gone', appliedModel: CLI }
  assert.equal(await rt.desiredModel(lost), DS)
  // Nothing picks a CLI as a default.
  assert.equal(await rt.defaultModel(), DS)
  await env.call('set-prefs', { defaultBotModel: 'ds/pro' })
  assert.equal(await rt.defaultBotModel(), 'ds/pro')
  env.rt.state.prefs.defaultBotModel = CLI
  assert.equal(await rt.defaultBotModel(), DS)
})

test('a CLI cannot become the team default model', async (t) => {
  const env = await start(t)
  const refused = await env.call('set-prefs', { defaultBotModel: CLI })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /cannot be the default model/)
})

test('a local Bot whose route is not registered yet keeps its applied model', async (t) => {
  const env = await start(t, { saved: team({ c: { id: 'c', name: 'Local', role: '', sessionId: 'c', createdAt: 3, model: CLI, appliedModel: CLI } }) })
  env.llm.routes.clear()
  await env.rt.applyModel(env.rt.botOf('c')).catch(() => {})
  assert.equal(env.rt.botOf('c').appliedModel, CLI)
  assert.equal(env.rt.botOf('c').model, CLI)
})

test('a route a Bot runs on stays registered when its CLI is gone', async (t) => {
  const env = await start(t, { saved: team({ c: { id: 'c', name: 'Local', role: '', sessionId: 'c', createdAt: 3, model: 'local-devin-cli/default', appliedModel: 'local-devin-cli/default' } }) })
  await until(() => env.llm.routes.has('local-devin-cli'), 'the route of the Bot')
  assert.ok((await env.rt.catalog({ fresh: true })).some(entry => entry.ref === 'local-devin-cli/default'))
})

test('a Bot created by a Bot on a CLI does not take that CLI', async (t) => {
  const env = await start(t, { saved: { ...team(), bots: { ...team().bots, a: { ...team().bots.a, model: CLI, appliedModel: CLI } } } })
  await env.tool('create_bot', { name: 'Fresh', role: 'New', instructions: 'Help.' }, 'a')
  const fresh = Object.values(env.state().bots).find(bot => bot.name === 'Fresh')
  assert.equal(fresh.model, DS)
})

test('a short name does not reach a CLI, a full ref does', async (t) => {
  const env = await start(t)
  await assert.rejects(env.rt.resolveModel('default'), /not available/)
  assert.equal(await env.rt.resolveModel(CLI), CLI)
  await assert.rejects(env.rt.resolveModel('local-acp-fake/not-there'), /not available/)
})

// -----------------------------------------------------------------------------
// Opening a menu is not slow.

test('state, models and a model menu start no CLI; a local Bot\'s menu starts its own, once', async (t) => {
  const env = await start(t)
  await env.call('state')
  await env.call('models')
  await env.tool('list_bot_models', {}, 'a')
  assert.equal(env.startCount(), 0, 'no CLI starts for the ordinary paths')
  const first = await env.call('local-agent-models', { route: 'local-acp-fake' })
  assert.deepEqual(first.value.map(model => model.id), ['default', 'fake-large', 'fake-small'])
  assert.equal(env.startCount(), 1)
  const second = await env.call('local-agent-models', { route: 'local-acp-fake' })
  assert.deepEqual(second.value, first.value)
  assert.equal(env.startCount(), 1, 'the second look reads what the CLI said')
  // What it said is now in the catalog, and a route nobody serves is not asked.
  assert.ok((await env.rt.catalog()).some(entry => entry.ref === 'local-acp-fake/fake-large'))
  assert.deepEqual((await env.call('local-agent-models', { route: 'nope' })).value, [])
})

// -----------------------------------------------------------------------------
// The adapter.

const message = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source })

function adapterFor(t, records = {}) {
  const engines = []
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE('fake-acp.mjs')] }, { findExecutable: path => path })
      engines.push(engine)
      return engine
    },
    usedModels: () => ['used-one'],
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())
  return { adapter, engines, records }
}
const send = async (adapter, sessionId, messages, extra = {}) => {
  let text = ''
  let finish
  for await (const chunk of adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId, messages, tools: [], signal: AbortSignal.timeout(30_000), ...extra })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, finish }
}

test('listing a route lists what DS Bot knows and starts nothing', async (t) => {
  const { adapter, engines } = adapterFor(t)
  const models = await adapter.listModels('local-acp-fake')
  assert.deepEqual(models.map(model => model.id), ['default', 'used-one'])
  assert.equal(engines.length, 0)
})

test('a probe that fails is tried again, and one that worked is not', async (t) => {
  const { adapter } = adapterFor(t)
  const asked = []
  adapter.engine = () => ({
    listModels: async () => {
      asked.push('asked')
      if (asked.length === 1) throw new Error('not yet')
      return [{ id: 'real', name: 'Real' }]
    },
  })
  assert.deepEqual((await adapter.probeModels('local-acp-fake')).map(model => model.id), ['default', 'used-one'])
  assert.deepEqual((await adapter.probeModels('local-acp-fake')).map(model => model.id), ['default', 'real', 'used-one'])
  await adapter.probeModels('local-acp-fake')
  assert.equal(asked.length, 2)
})

test('two looks at once ask the CLI once', async (t) => {
  const { adapter } = adapterFor(t)
  let asked = 0
  adapter.engine = () => ({ listModels: async () => { asked += 1; await settle(); return [] } })
  await Promise.all([adapter.probeModels('local-acp-fake'), adapter.probeModels('local-acp-fake')])
  assert.equal(asked, 1)
})

test('another model reopens the same CLI session and loses nothing of the answer', async (t) => {
  const { adapter, records } = adapterFor(t)
  const first = await send(adapter, 's1', [message('m1', 'hello')])
  assert.match(first.text, /^ok: /)
  const cliSession = records.s1.cliSessionId
  const second = await send(adapter, 's1', [message('m1', 'hello'), message('m2', 'again')], { model: 'fake-large' })
  assert.match(second.text, /ok: again/)
  assert.equal(second.finish.kind, 'stop')
  assert.equal(records.s1.cliSessionId, cliSession)
  assert.equal(records.s1.model, 'fake-large')
  assert.equal(adapter.live.get('s1').model, 'fake-large')
})

test('a model the CLI does not take fails the turn and does not count as applied', async (t) => {
  const { adapter, records } = adapterFor(t)
  await assert.rejects(send(adapter, 's1', [message('m1', 'hello')], { model: 'not-there' }), (error) => {
    assert.equal(error.code, 'LOCAL_AGENT_MODEL')
    assert.match(error.message, /did not switch to the model not-there/)
    return true
  })
  assert.equal(adapter.live.get('s1')?.engineSession, undefined)
  assert.equal(records.s1?.model, undefined)
  // A model it takes works in the same Session.
  const next = await send(adapter, 's1', [message('m1', 'hello')], { model: 'fake-large' })
  assert.match(next.text, /^ok: [^]*hello$/)
  assert.equal(records.s1.model, 'fake-large')
})

test('the process stopped for a reopen does not take the new one down', async (t) => {
  const { adapter } = adapterFor(t)
  await send(adapter, 's1', [message('m1', 'hello')])
  await send(adapter, 's1', [message('m1', 'hello'), message('m2', 'two')], { model: 'fake-large' })
  await new Promise(resolve => setTimeout(resolve, 200))
  const third = await send(adapter, 's1', [message('m1', 'hello'), message('m2', 'two'), message('m3', 'three')], { model: 'fake-large' })
  assert.match(third.text, /ok: three/)
})

test('a model change waits for the turn that runs', async (t) => {
  const { adapter } = adapterFor(t)
  const ended = send(adapter, 's1', [message('m1', 'hang')])
  await until(() => adapter.live.get('s1')?.state === 'running', 'the turn')
  const live = adapter.live.get('s1')
  assert.equal(await adapter.liveFor({ sessionId: 's1', provider: 'local-acp-fake', model: 'fake-large' }), live)
  await adapter.closeSession('s1')
  assert.equal(adapter.live.has('s1'), false)
  await Promise.race([ended, settle()])
})

test('closing a Session answers what its CLI waits on and lets the process go', async (t) => {
  const { adapter, engines, records } = adapterFor(t)
  const first = adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages: [message('m1', 'ask-permission')], tools: [], signal: AbortSignal.timeout(30_000) })
  for await (const chunk of first) if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'tool-calls')
  assert.equal(adapter.live.get('s1').pending.size, 1)
  const child = engines[0].child
  await adapter.closeSession('s1', 'moved on')
  assert.equal(adapter.live.has('s1'), false)
  assert.equal(engines[0].child, undefined)
  assert.notEqual(child.killed, false)
  // The record stays, so opening that part again resumes the CLI session.
  assert.ok(records.s1.cliSessionId)
})

test('a fresh CLI session gets a long handoff word for word', async (t) => {
  const { adapter } = adapterFor(t)
  const prompts = []
  const prompt = AcpEngine.prototype.prompt
  t.after(() => { AcpEngine.prototype.prompt = prompt })
  AcpEngine.prototype.prompt = function (session, blocks, options) {
    prompts.push(blocks.map(block => block.text).join(''))
    return prompt.call(this, session, blocks, options)
  }
  const long = `[Handoff · part 2]\n${'x'.repeat(40_000)}\nthe end`
  const old = Array.from({ length: 20 }, (_, index) => message(`o${index}`, `old ${index} ${'y'.repeat(3000)}`))
  await send(adapter, 's1', [message('h', long, { kind: 'ds-bot', handoff: true }), ...old, message('m1', 'and now')])
  assert.ok(prompts[0].includes(long), 'the handoff is whole')
  assert.ok(prompts[0].endsWith('User: and now'), 'the latest input is last')
  assert.ok(prompts[0].length < long.length + 30_000, 'the rest keeps its window')
})

// -----------------------------------------------------------------------------
// Sign-in.

test('the sign-in check gives only yes, no or unknown', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-signin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = (name, line) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\necho '${line}'\n`)
    chmodSync(path, 0o755)
    return path
  }
  const check = { args: [] }
  if (process.platform !== 'win32') {
    assert.equal(await probeSignIn(script('in', 'Logged in using ChatGPT'), check), true)
    assert.equal(await probeSignIn(script('out', 'Not logged in.'), check), false)
    assert.equal(await probeSignIn(script('odd', 'token: secret-value'), check), null)
  }
  assert.equal(await probeSignIn(join(dir, 'missing'), check), null)
  assert.equal(await probeSignIn('x', undefined), null)
  // A credential file says yes; its absence says nothing; its content never leaves.
  mkdirSync(join(dir, '.tool'))
  writeFileSync(join(dir, '.tool', 'auth.json'), '{"token":"secret-value"}')
  assert.equal(await probeSignIn('x', { file: ['.tool', 'auth.json'] }, { home: dir }), true)
  assert.equal(await probeSignIn('x', { file: ['.tool', 'none.json'] }, { home: dir }), null)
})

// -----------------------------------------------------------------------------
// The form and the menus.

const CATALOG = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash' },
  { ref: 'ds/nokey', provider: 'ds', id: 'nokey', name: 'No key', needsKey: true },
  { ref: 'local-devin-cli/default', provider: 'local-devin-cli', id: 'default', name: 'CLI default' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default' },
  { ref: 'local-codex-cli/gpt', provider: 'local-codex-cli', id: 'gpt', name: 'GPT' },
  { ref: 'local-acp-x/default', provider: 'local-acp-x', id: 'default', name: 'CLI default' },
]

test('a menu lists only what its Bot may pick', () => {
  const refs = ref => modelsFor(CATALOG, ref).map(model => model.ref)
  assert.deepEqual(refs('ds/flash'), ['ds/flash', 'ds/nokey'])
  assert.deepEqual(refs(undefined), ['ds/flash', 'ds/nokey'])
  assert.deepEqual(refs('local-codex-cli/gpt'), ['local-codex-cli/default', 'local-codex-cli/gpt'])
  assert.deepEqual(refs('local-acp-x/default'), ['local-acp-x/default'])
  assert.deepEqual(modelsFor(undefined, 'ds/flash'), [])
})

test('the form never starts on a local agent', () => {
  assert.equal(startModel({ models: CATALOG, prefs: { defaultBotModel: 'local-codex-cli/gpt' }, defaultModel: 'local-devin-cli/default' }), 'ds/flash')
  assert.equal(startModel({ models: CATALOG.filter(model => model.provider !== 'ds') }), '')
})

test('a new local Bot wears its CLI\'s logo only when it has no look of its own', () => {
  const look = { shape: 'whale', color: 'blue' }
  const worn = createPayload({ name: 'A', look, image: null, model: 'local-codex-cli/gpt' })
  assert.equal(worn.avatar.image, agentAvatar('local-codex-cli').image)
  const own = createPayload({ name: 'B', look, image: null, model: 'local-codex-cli/gpt', ownLook: true })
  assert.equal(own.avatar.image, undefined)
  const photo = createPayload({ name: 'C', look, image: 'data:image/png;base64,AA', model: 'local-codex-cli/gpt' })
  assert.equal(photo.avatar.image, 'data:image/png;base64,AA')
  assert.equal(createPayload({ name: 'D', look, image: null, model: 'ds/flash' }).avatar.image, undefined)
})

test('a Bot wearing its old CLI\'s logo changes it along; its own picture stays', () => {
  const logo = agentAvatar('local-codex-cli').image
  const wearing = { engine: 'local-codex-cli', avatar: { shape: 'whale', image: logo } }
  assert.deepEqual(avatarAfter(wearing, 'ds/flash'), { avatar: { shape: 'whale' } })
  assert.deepEqual(avatarAfter({ engine: 'local-codex-cli', avatar: { image: logo } }, 'ds/flash'), { avatar: null })
  assert.equal(avatarAfter(wearing, 'local-devin-cli/default').avatar.image, agentAvatar('local-devin-cli').image)
  assert.deepEqual(avatarAfter({ engine: 'local-codex-cli', avatar: { image: 'data:image/png;base64,AA' } }, 'ds/flash'), {})
  assert.deepEqual(avatarAfter({ avatar: { shape: 'whale' } }, 'local-codex-cli/default'), {})
})

test('the confirmation says what the change does to this Bot', () => {
  const roster = { rooms: [{ members: ['b'] }, { members: ['b', 'a'] }, { members: ['a'] }] }
  const plain = runModeNotes({ bot: { id: 'c' }, roster, target: 'ds/flash' })
  assert.equal(plain.length, 2)
  assert.match(plain[0], /^Its own chat starts/)
  const full = runModeNotes({ bot: { id: 'b', capabilities: ['x'], private: true }, roster, target: 'local-codex-cli/default', agent: { name: 'Codex', signedIn: false } })
  assert.match(full[0], /2 group chats/)
  assert.ok(full.some(note => /MCP servers and skills/.test(note)))
  assert.ok(full.some(note => /Codex is not signed in/.test(note)))
  assert.ok(full.some(note => /privacy rules/.test(note)))
  const toModel = runModeNotes({ bot: { id: 'b', capabilities: ['x'], private: true }, roster, target: 'ds/flash' })
  assert.equal(toModel.length, 2)
})

// The page reads the run mode from the route's prefix, so a model of DSH's own
// OpenCode provider is not shown as a local agent (#1059).
test('only prefixed routes count as local agents on the page', () => {
  assert.equal(isLocalRoute('opencode/glm-5'), false)
  assert.equal(isLocalRoute('local-opencode/default'), true)
  assert.deepEqual(badgeOf('local-codex-cli'), ['CX', 'green'])
  assert.deepEqual(badgeOf('local-acp-a1'), ['AC', 'rose'])
  assert.equal(badgeOf('codex-cli'), undefined)
})
