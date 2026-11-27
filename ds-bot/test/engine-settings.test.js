import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { install as installChannel } from '../src/host/channel.js'
import { install as installEngineSettings } from '../src/host/engine-settings.js'
import { remoteAccessError } from '../src/host/phone.js'
import { createRemoteService } from '../src/host/remote.js'

function fakeContext(overrides = {}) {
  const services = new Map(Object.entries(overrides.services ?? {}))
  const routes = new Map()
  return {
    get: name => services.get(name),
    effect: (fn) => { fn?.(); return () => {} },
    on: () => () => {},
    connection: {
      fetch: {
        register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path) },
      },
    },
    workspaceRegistry: overrides.workspaceRegistry ?? {
      archivedSessionIds: [],
      list: () => [],
      unarchiveSession: async () => {},
    },
    sessionController: overrides.sessionController ?? {
      list: async () => ({ items: [] }),
    },
    ...overrides.extra,
  }
}

function makeHarness({ readOnly = undefined, services = {}, workspaceRegistry, sessionController, agents = {} } = {}) {
  const ctx = fakeContext({ services, workspaceRegistry, sessionController })
  const state = {
    revision: 1,
    bots: {},
    rooms: {},
    agents,
    prefs: {},
    questions: {},
    views: {},
    exchangeTurns: {},
    exchanges: [],
    sections: [],
  }
  const adopted = []
  const rt = {
    ctx,
    state,
    config: { version: '0.4.0' },
    readOnly: () => readOnly,
    refresh: async () => {},
    load: async () => {},
    save: async () => {},
    bootstrap: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    cachedCatalog: () => [],
    cachedDefault: () => null,
    defaultRef: () => null,
    secretsView: () => [],
    secretStoreStatus: () => ({}),
    capabilityLibraryView: () => ({}),
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => [],
    memoryNews: () => ({}),
    memoryReviews: () => ({}),
    learningView: () => ({}),
    learningSettledView: () => ({}),
    connectorsView: () => [],
    capabilityStatusesView: () => ({}),
    phoneView: () => ({}),
    mcpView: () => ({}),
    phoneServe: () => {},
    subscribeFeed: () => () => {},
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => undefined,
    agentOf: sid => Object.values(state.agents).find(a => a.sessions?.includes(sid)),
    pastOwners: new Map(),
    adoptAgentSession: async (agentId, sessionId) => {
      adopted.push({ agentId, sessionId })
      state.agents[agentId].sessions.push(sessionId)
      return sessionId
    },
    noteFailure: () => {},
  }
  installEngineSettings(rt)
  installChannel(rt)
  return { rt, ctx, state, adopted }
}

test('engine-settings-list redacts secrets and engine-settings-mutate preserves them with conflict handling', async () => {
  const schema = Schema.object({
    maxTurns: Schema.number().default(30),
    enabled: Schema.boolean().default(true),
    apiKey: Schema.string().role('secret'),
  })
  const stored = { maxTurns: 30, enabled: true, apiKey: 'sk-super-secret' }
  let revision = 3
  const describeCalls = []
  const settings = {
    writable: true,
    describe(options) {
      describeCalls.push(options)
      const redacted = { maxTurns: stored.maxTurns, enabled: stored.enabled }
      return [{
        ns: 'agent-loop',
        autoGenerate: true,
        schema,
        value: options?.redactSecrets ? redacted : stored,
        applies: 'live',
        revision,
        secrets: [{ path: ['apiKey'], set: Boolean(stored.apiKey) }],
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'agent-loop')
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error('Revision mismatch'), { code: 'SETTINGS_CONFLICT', expected: expectedRevision, actual: revision })
      }
      for (const op of ops) {
        if (op.op === 'set') stored[op.path[0]] = op.value
        else if (op.op === 'unset') delete stored[op.path[0]]
      }
      revision += 1
    },
  }

  const { rt } = makeHarness({ services: { settings } })
  const listed = await rt.channelCall('engine-settings-list', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.value.available, true)
  assert.equal(listed.value.writable, true)
  assert.equal(describeCalls[0]?.redactSecrets, true)
  const ns = listed.value.namespaces[0]
  assert.equal(ns.ns, 'agent-loop')
  assert.equal(ns.value.apiKey, undefined)
  assert.deepEqual(ns.secrets, [{ path: ['apiKey'], set: true }])
  assert.equal(typeof ns.schema.uid, 'number')
  assert.equal(typeof ns.schema.refs, 'object')

  const mutated = await rt.channelCall('engine-settings-mutate', {
    ns: 'agent-loop',
    ops: [{ op: 'set', path: ['maxTurns'], value: 50 }],
    expectedRevision: 3,
  })
  assert.equal(mutated.ok, true)
  assert.equal(mutated.value.value.maxTurns, 50)
  assert.equal(mutated.value.revision, 4)
  assert.equal(stored.apiKey, 'sk-super-secret', 'redacted secret stays intact across non-secret path mutations')

  const conflict = await rt.channelCall('engine-settings-mutate', {
    ns: 'agent-loop',
    ops: [{ op: 'set', path: ['maxTurns'], value: 60 }],
    expectedRevision: 3,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'bot/stale')

  const protoAttack = await rt.channelCall('engine-settings-mutate', {
    ns: 'agent-loop',
    ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }],
  })
  assert.equal(protoAttack.ok, false)
  assert.equal(protoAttack.error.code, 'bot/invalid')

  const missingVal = await rt.channelCall('engine-settings-mutate', {
    ns: 'agent-loop',
    ops: [{ op: 'set', path: ['maxTurns'] }],
  })
  assert.equal(missingVal.ok, false)
  assert.equal(missingVal.error.code, 'bot/invalid')
})

test('engine-account endpoints never access credentials and enforce loopback callback origins', async () => {
  let leakedCredRead = false
  let lastSignIn = null
  const deepseekAccount = {
    async getState() {
      return {
        status: 'credential-stored',
        links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
        attempt: null,
      }
    },
    async getProfile() {
      return { status: 'ready', value: { id: 'u1', name: 'Alice', contact: 'a***@example.com' } }
    },
    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: '12.50' }], bonusWallets: [] }
    },
    async startSignIn(client, callbackOrigin, loginSource) {
      lastSignIn = { client, callbackOrigin, loginSource }
      return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: { id: 'att-1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/oauth' } }
    },
    async cancelSignIn(id) {
      return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: { id, phase: 'cancelled' } }
    },
    async signOut() {
      return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }
    },
    async getPlatformSession() { leakedCredRead = true; return { token: 'SECRET' } },
    async resolveToken() { leakedCredRead = true; return 'SECRET' },
  }

  const { rt } = makeHarness({ services: { deepseekAccount } })
  const stateRes = await rt.channelCall('engine-account-state', { locale: 'zh-CN' })
  assert.equal(stateRes.ok, true)
  assert.equal(stateRes.value.profile.value.name, 'Alice')
  assert.equal(stateRes.value.balance.value[0].balance, '12.50')
  assert.equal(leakedCredRead, false)

  const evilSignIn = await rt.channelCall('engine-account-signin', { callbackOrigin: 'https://evil.example/cb' })
  assert.equal(evilSignIn.ok, false)
  assert.equal(evilSignIn.error.code, 'bot/refused')

  const okSignIn = await rt.channelCall('engine-account-signin', { callbackOrigin: 'http://127.0.0.1:41901' })
  assert.equal(okSignIn.ok, true)
  assert.equal(lastSignIn.callbackOrigin, 'http://127.0.0.1:41901')
  assert.equal(lastSignIn.loginSource, 'desktop')

  // Custom Electron scheme falls back to the host request's own loopback HTTP origin.
  const fallbackSignIn = await rt.channelCall('engine-account-signin', {}, undefined, { requestOrigin: 'http://127.0.0.1:41902' })
  assert.equal(fallbackSignIn.ok, true)
  assert.equal(lastSignIn.callbackOrigin, 'http://127.0.0.1:41902')

  const cancelled = await rt.channelCall('engine-account-cancel', { attemptId: 'att-1' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.value.view.attempt.phase, 'cancelled')

  const signedOut = await rt.channelCall('engine-account-signout', {})
  assert.equal(signedOut.ok, true)
  assert.equal(signedOut.value.view.status, 'signed-out')
})

test('engine-plugins, engine-presets, engine-archived, and engine-classic-sessions honor real contracts', async () => {
  const calls = []
  let selectedDefault = 'default'
  let presetRev = 2
  const archived = ['s-archived-1']

  const pluginManager = {
    async listBundles() {
      return [{ name: '@example/bundle', official: false, availability: 'profile', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true, updatable: true, rows: [] }]
    },
    async listPlugins() {
      return [{ id: 'p1', moduleName: '@example/plugin', enabled: true, status: 'active' }]
    },
    async setBundleEnabled(name, enabled) { calls.push(['bundle', name, enabled]); return { changed: true, application: 'applied', stage: 'enable', target: name, enabled } },
    async setPluginEnabled(id, enabled) { calls.push(['plugin', id, enabled]); return { changed: true, application: 'restart-required', stage: 'enable', target: id, enabled } },
    async installBundle(spec, opts) { calls.push(['install', spec, opts.enabled]); return { changed: true, application: 'applied', stage: 'install', target: spec, bundle: spec } },
    async removeBundle(name) { calls.push(['remove', name]); return { changed: true, application: 'applied', stage: 'remove', target: name } },
  }
  const agentPresets = {
    async remoteExportList() {
      return {
        presets: [
          { id: 'default', name: 'Default', isDefault: selectedDefault === 'default' },
          { id: 'minimal', name: 'Minimal', isDefault: selectedDefault === 'minimal' },
          { id: 'bad', name: 'Broken', isDefault: false, broken: 'missing plugin' },
        ],
      }
    },
    async readDocument(id) {
      if (id === 'minimal') return { agentPreset: 'minimal', content: '- name: terminal\n' }
      const err = new Error(`Unknown agent preset: ${id}`)
      err.code = 'agent-preset/not-found'
      throw err
    },
  }
  const settings = {
    writable: true,
    describe: () => [{ ns: 'agent-preset-registry', autoGenerate: false, schema: {}, value: { selectedDefault }, applies: 'live', revision: presetRev, secrets: [] }],
    async mutate(ns, ops) {
      assert.equal(ns, 'agent-preset-registry')
      const op = ops[0]
      selectedDefault = op.op === 'unset' ? 'default' : op.value
      presetRev += 1
    },
  }
  const workspaceRegistry = {
    get archivedSessionIds() { return archived },
    list: () => [{ id: 'ws-1', sessionIds: ['s-classic-1'] }],
    async unarchiveSession(id) {
      const idx = archived.indexOf(id)
      if (idx >= 0) archived.splice(idx, 1)
    },
  }
  const sessionController = {
    async list() {
      return {
        items: [
          { sessionId: 's-classic-1', updatedAt: 1700000100000, running: false, blank: false, projections: { values: { title: 'Debug build' } } },
          { sessionId: 's-archived-1', updatedAt: 1700000000000, running: false, blank: false, cwd: '/work', projections: { values: { title: 'Old analysis' } } },
        ],
      }
    },
  }

  const { rt, adopted } = makeHarness({
    services: { pluginManager, agentPresets, settings },
    workspaceRegistry,
    sessionController,
    agents: { a1: { id: 'a1', name: 'DSH Agent', sessions: ['s-classic-1'] } },
  })

  const plist = await rt.channelCall('engine-plugins-list', {})
  assert.equal(plist.ok, true)
  assert.equal(plist.value.bundles.length, 1)
  assert.equal(plist.value.plugins.length, 1)

  const badInstall = await rt.channelCall('engine-plugins-install', { spec: 'bad\x00spec' })
  assert.equal(badInstall.ok, false)
  assert.equal(badInstall.error.code, 'bot/invalid')

  await rt.channelCall('engine-plugins-toggle-bundle', { name: '@example/bundle', enabled: false })
  await rt.channelCall('engine-plugins-toggle-plugin', { id: 'p1', enabled: false })
  await rt.channelCall('engine-plugins-install', { spec: '@example/new', enabled: true })
  await rt.channelCall('engine-plugins-remove', { name: '@example/bundle' })
  assert.deepEqual(calls, [
    ['bundle', '@example/bundle', false],
    ['plugin', 'p1', false],
    ['install', '@example/new', true],
    ['remove', '@example/bundle'],
  ])

  const brokenPreset = await rt.channelCall('engine-presets-default', { id: 'bad' })
  assert.equal(brokenPreset.ok, false)
  assert.equal(brokenPreset.error.code, 'bot/refused')

  const switchedPreset = await rt.channelCall('engine-presets-default', { id: 'minimal', expectedRevision: 2 })
  assert.equal(switchedPreset.ok, true)
  assert.equal(switchedPreset.value.presets.find(p => p.id === 'minimal').isDefault, true)

  const readPreset = await rt.channelCall('engine-presets-read', { id: 'minimal' })
  assert.equal(readPreset.ok, true)
  assert.equal(readPreset.value.id, 'minimal')
  assert.equal(readPreset.value.content, '- name: terminal\n')

  const missingPreset = await rt.channelCall('engine-presets-read', { id: 'does-not-exist' })
  assert.equal(missingPreset.ok, false)
  assert.equal(missingPreset.error.code, 'bot/not-found')

  const classic = await rt.channelCall('engine-classic-sessions', {})
  assert.equal(classic.ok, true)
  assert.deepEqual(classic.value.sessions, [{
    id: 's-classic-1',
    title: 'Debug build',
    updatedAt: 1700000100000,
    running: false,
    blank: false,
    workspaceId: 'ws-1',
  }])

  const archList = await rt.channelCall('engine-archived-list', {})
  assert.equal(archList.ok, true)
  assert.equal(archList.value.sessions[0].id, 's-archived-1')
  assert.equal(archList.value.sessions[0].title, 'Old analysis')

  const restored = await rt.channelCall('engine-archived-unarchive', { sessionId: 's-archived-1' })
  assert.equal(restored.ok, true)
  assert.equal(restored.value.restored, true)
  assert.equal(restored.value.adoptedAgentId, 'a1')
  assert.deepEqual(adopted, [{ agentId: 'a1', sessionId: 's-archived-1' }])
})

test('read-only windows can read engine settings but cannot mutate; phone and remote reject all engine-* endpoints', async () => {
  const { rt } = makeHarness({
    readOnly: 'Another dsh holds this team',
    services: {
      agentPresets: {
        async remoteExportList() { return { presets: [{ id: 'standard', isDefault: true }] } },
        async readDocument(id) { return { agentPreset: id, content: '- name: core\n' } },
      },
    },
  })
  for (const [readEp, body] of [
    ['engine-settings-list', {}],
    ['engine-account-state', {}],
    ['engine-plugins-list', {}],
    ['engine-presets-list', {}],
    ['engine-presets-read', { id: 'standard' }],
    ['engine-archived-list', {}],
    ['engine-classic-sessions', {}],
  ]) {
    const res = await rt.channelCall(readEp, body)
    assert.equal(res.ok, true, `${readEp} should be allowed read-only`)
  }
  for (const writeEp of ['engine-settings-mutate', 'engine-account-signin', 'engine-plugins-install', 'engine-presets-default', 'engine-archived-unarchive']) {
    const res = await rt.channelCall(writeEp, {})
    assert.equal(res.ok, false, `${writeEp} must be refused read-only`)
    assert.equal(res.error.code, 'bot/read-only')
  }

  for (const ep of ['engine-settings-list', 'engine-settings-mutate', 'engine-account-state', 'engine-classic-sessions', 'plugins-list', 'plugins-install', 'plugins-custom-save', 'plugins-source-save']) {
    assert.equal(remoteAccessError({ deviceId: 'p1', kind: 'phone' }, ep).code, 'bot/refused')
    assert.equal(remoteAccessError({ deviceId: 'b1', kind: 'browser' }, ep).code, 'bot/refused')
  }

  const RemoteService = createRemoteService(rt)
  const fakeRemote = Object.create(RemoteService.prototype)
  for (const ep of ['engine-settings-list', 'plugins-list', 'plugins-install', 'plugins-custom-save']) {
    const rpcRes = await fakeRemote.call(ep, {})
    assert.equal(rpcRes.ok, false, `${ep} must be refused on remote RPC`)
    assert.equal(rpcRes.error.code, 'bot/refused')
  }

  // Remote RPC strips `data` from `folders` so host data paths never leak remotely.
  const folderRemote = createRemoteService({
    ...rt,
    channelCall: async (name) => (name === 'folders'
      ? { ok: true, value: { team: '/tmp/team', data: '/tmp/secret-data', picker: null, folders: [] } }
      : { ok: false }),
  })
  const folderClient = Object.create(folderRemote.prototype)
  const folderRes = await folderClient.call('folders', {})
  assert.equal(folderRes.ok, true)
  assert.equal(folderRes.value.team, '/tmp/team')
  assert.equal('data' in folderRes.value, false, 'remote folders must strip protected data path')
})

test('archived-list excludes Bot/group segments and archived-unarchive refuses restoring them', async () => {
  const unarchived = []
  const { rt } = makeHarness({
    workspaceRegistry: {
      archivedSessionIds: ['s-classic-arch', 's-bot-part', 's-room-part'],
      list: () => [],
      unarchiveSession: async sid => unarchived.push(sid),
    },
  })
  rt.roomOf = id => (id === 's-room-part' || id === 'r1' ? { id: 'r1', name: 'Ops' } : undefined)
  rt.pastOwners = new Map([['s-bot-part', { botId: 'b1' }]])

  const list = await rt.channelCall('engine-archived-list', {})
  assert.equal(list.ok, true)
  assert.deepEqual(list.value.sessions.map(entry => entry.id), ['s-classic-arch'])

  for (const ownedSid of ['s-bot-part', 's-room-part']) {
    const res = await rt.channelCall('engine-archived-unarchive', { sessionId: ownedSid })
    assert.equal(res.ok, false, `${ownedSid} must be refused`)
    assert.equal(res.error.code, 'bot/refused')
  }
  assert.deepEqual(unarchived, [], 'refused restore must not call workspaceRegistry.unarchiveSession')
})

test('Classic Agent approvals bridge into approvalsView without botId, and session-scoped stop-agent cancels only the targeted session', async () => {
  const { install: installApprovals } = await import('../src/host/approvals.js')
  const { install: installInbox } = await import('../src/host/inbox.js')
  const { install: installTurns } = await import('../src/host/turns.js')
  const { fakeContext } = await import('./fake-ctx.js')
  const ctx = fakeContext()
  const cancelled = []
  const rt = {
    ctx,
    state: { bots: {}, rooms: {}, agents: { a1: { id: 'a1', sessions: ['cs-1', 'cs-2'] } } },
    load: async () => {},
    warn: () => {},
    groupOwners: new Map(),
    taskOwners: new Map(),
    chatOwners: new Map(),
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => undefined,
    chatOf: () => undefined,
    agentById: id => (id === 'a1' ? { id: 'a1', sessions: ['cs-1', 'cs-2'] } : undefined),
    agentOf: sid => (sid === 'cs-1' || sid === 'cs-2' ? { id: 'a1', sessions: ['cs-1', 'cs-2'] } : undefined),
    resolveAgent: async sid => ({ cancel: reason => cancelled.push([sid, reason]) }),
    switchJobs: () => [],
  }
  installTurns(rt)
  installApprovals(rt)
  installInbox(rt)

  // Classic Agent approval request queues in approvalsView without botId, never reaches the Bot inbox or activity['undefined'].
  let nextCalled = false
  const approvalMiddleware = ctx.listeners.get('approval/request').at(-1)
  const outcomePromise = approvalMiddleware({
    agent: { id: 'cs-1', session: { id: 'cs-1' } },
    toolName: 'bash',
    reason: 'Run build script',
    callId: 'c1',
    signal: new AbortController().signal,
  }, () => {
    nextCalled = true
    return new Promise(() => {})
  })
  await Promise.resolve()
  assert.equal(nextCalled, true, 'Classic Agent approval still races DSH native card when present')
  const view = rt.approvalsView()
  assert.equal(view.length, 1)
  assert.equal(view[0].sessionId, 'cs-1')
  assert.equal('botId' in view[0], false)
  assert.equal(view[0].answerable, true)
  assert.equal(rt.inboxView().count, 0, 'A Classic Agent approval is not a Bot\'s: the inbox (and the phone notices it drives) leaves it out')
  assert.equal('undefined' in rt.activityView(), false, 'activityView must not gain an undefined key')

  rt.answerApproval(view[0].id, 'allow')
  assert.equal(await outcomePromise, 'allowed-once')
  assert.equal(rt.approvalsView().length, 0)

  // Session-scoped stopAgent cancels only cs-2 and leaves cs-1 running; unscoped stops remaining cs-1.
  rt.live.set('cs-1', { turn: 1, since: 100, texts: [], shown: 0 })
  rt.live.set('cs-2', { turn: 2, since: 200, texts: [], shown: 0 })
  assert.equal(await rt.stopAgent('a1', 'cs-2'), true)
  assert.deepEqual(cancelled, [['cs-2', { kind: 'user' }]])
  assert.equal(await rt.stopAgent('a1', 'foreign-session'), false)
  assert.deepEqual(cancelled, [['cs-2', { kind: 'user' }]])
  rt.live.delete('cs-2')
  assert.equal(await rt.stopAgent('a1'), true)
  assert.deepEqual(cancelled, [['cs-2', { kind: 'user' }], ['cs-1', { kind: 'user' }]])
})

test('engine-web-providers and engine-model-catalog expose registered providers/models, allow read-only, and refuse remote', async () => {
  const web = {
    async listProviders() {
      return {
        search: [{ id: 'deepseek-search-api', title: 'DeepSeek Search API', available: true }],
        fetch: [{ id: 'http', title: 'Direct HTTP', available: true }],
      }
    },
  }
  const llm = {
    listProviders() {
      return [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'flaky', name: 'Flaky Provider' },
      ]
    },
    async listModels(providerId) {
      if (providerId === 'flaky') throw new Error('provider offline')
      return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]
    },
  }
  const { rt } = makeHarness({ readOnly: 'Another dsh holds this team', services: { web, llm } })

  const webRes = await rt.channelCall('engine-web-providers', {})
  assert.equal(webRes.ok, true)
  assert.equal(webRes.value.available, true)
  assert.deepEqual(webRes.value.search.map(p => p.id), ['deepseek-search-api'])
  assert.deepEqual(webRes.value.fetch.map(p => p.id), ['http'])

  const catRes = await rt.channelCall('engine-model-catalog', {})
  assert.equal(catRes.ok, true)
  assert.equal(catRes.value.available, true)
  assert.equal(catRes.value.partial, true, 'flaky provider failure sets partial=true while keeping healthy providers')
  assert.equal(catRes.value.groups.length, 1)
  assert.deepEqual(catRes.value.groups[0].models.map(m => m.id), ['deepseek-chat', 'deepseek-reasoner'])

  // Remote/phone access refuses both read endpoints.
  for (const ep of ['engine-web-providers', 'engine-model-catalog']) {
    assert.equal(remoteAccessError({ deviceId: 'p1', kind: 'phone' }, ep).code, 'bot/refused')
    assert.equal(remoteAccessError({ deviceId: 'b1', kind: 'browser' }, ep).code, 'bot/refused')
  }

  // Fallback to rt.cachedCatalog() when ctx.llm is absent.
  const { rt: fallbackRt } = makeHarness()
  fallbackRt.cachedCatalog = () => [
    { ref: 'openai/gpt-5', provider: 'openai', providerName: 'OpenAI', name: 'GPT-5' },
  ]
  const fbRes = await fallbackRt.channelCall('engine-model-catalog', {})
  assert.equal(fbRes.ok, true)
  assert.equal(fbRes.value.groups.length, 1)
  assert.equal(fbRes.value.groups[0].id, 'openai')
  assert.equal(fbRes.value.groups[0].models[0].id, 'gpt-5')
})
