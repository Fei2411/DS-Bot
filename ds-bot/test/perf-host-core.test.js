import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { PNG } from 'pngjs'
import { createRuntime } from '../index.js'
import { install as installAgentCommands } from '../src/host/agent-commands.js'
import { install as installApprovals } from '../src/host/approvals.js'
import { install as installBtw } from '../src/host/btw.js'
import { install as installCapabilities } from '../src/host/capabilities.js'
import { install as installChannel } from '../src/host/channel.js'
import { install as installChatIndex } from '../src/host/chat-index.js'
import { install as installDelivery } from '../src/host/delivery.js'
import { install as installFeed } from '../src/host/feed.js'
import { install as installFolders } from '../src/host/folders.js'
import { install as installGroups } from '../src/host/groups.js'
import { install as installHandoffs } from '../src/host/handoffs.js'
import { install as installImages } from '../src/host/images.js'
import { install as installLedger } from '../src/host/ledger.js'
import { install as installMcpServer, mcpHttpServer, closeServer } from '../src/host/mcp-server.js'
import { install as installMemory } from '../src/host/memory.js'
import { avatarRef, clearAvatarRefCache, install as installMobile } from '../src/host/mobile.js'
import { install as installModels } from '../src/host/models.js'
import { install as installParts } from '../src/host/parts.js'
import { install as installPermissions } from '../src/host/permissions.js'
import { install as installPrivacy } from '../src/host/privacy.js'
import { install as installRequests } from '../src/host/requests.js'
import { install as installSecrets, redactDeep, redactor } from '../src/host/secrets.js'
import { install as installStore } from '../src/host/store.js'
import { install as installTasks } from '../src/host/tasks.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installUsage } from '../src/host/usage.js'
import { fakeContext } from './fake-ctx.js'

const tempDir = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  return dir
}

const seedState = (extra = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  views: {},
  closedCards: {},
  prefs: {},
  revision: 1,
  ...extra,
})

const minimalCtx = (services = {}) => {
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        status: 'idle',
        session: {
          id: sessionId,
          seq: 1,
          header: {},
          requestHeader: () => ({}),
          snapshotEvents: () => [],
          deriveMessages: () => [],
          toolHistory: () => [],
        },
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s-${Math.random().toString(36).slice(2, 8)}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  return { ctx, agents, agentOf }
}

const makeLargePng = (width = 800, height = 800) => {
  const png = new PNG({ width, height })
  // Fill with pseudo-random bytes so zlib compression stays well above PREVIEW_MIN_BYTES (100 KB).
  let x = 0x12345678
  for (let i = 0; i < png.data.length; i += 4) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    png.data[i] = x & 0xff
    png.data[i + 1] = (x >>> 8) & 0xff
    png.data[i + 2] = (x >>> 16) & 0xff
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

test('store.js coalesces queued saves, rejects coalesced required:true on READ_ONLY_RESULT, and skips redundant onStoreSync', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-store-')
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seedState()))
  const ctx = fakeContext()
  const rt = { ctx, home, statePath, warn() {} }
  installStore(rt)
  t.after(() => ctx.dispose())
  await rt.load()

  let savedCount = 0
  rt.onSaved(() => { savedCount += 1 })

  // Burst 10 concurrent saves: at most 2 disk writes (the in-flight one + 1 coalesced follow-up).
  const revBefore = rt.state.revision
  const burst = Array.from({ length: 10 }, (_, i) => {
    rt.state.prefs.step = i
    return rt.save()
  })
  await Promise.all(burst)
  assert.equal(savedCount <= 2, true, `expected at most 2 coalesced writes, got ${savedCount}`)
  assert.equal(rt.state.revision - revBefore, savedCount)
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).prefs.step, 9)

  // Conditional notifyStoreSync on refresh: unchanged poll must NOT trigger sync listeners.
  let syncCalls = 0
  rt.onStoreSync = () => { syncCalls += 1 }
  await rt.refresh()
  await rt.refresh()
  assert.equal(syncCalls, 0, 'unchanged refresh should not invoke onStoreSync')

  // Coalesced save hitting READ_ONLY_RESULT: remove lock and write a newer-version file so
  // the first save triggers adoptAfterReclaim (turning host read-only via `stuck`), and a
  // second coalesced save with `required: true` joins `pendingSave` and MUST reject while
  // the non-required save resolves.
  const lockPath = join(home, 'state.lock')
  unlinkSync(lockPath)
  writeFileSync(statePath, JSON.stringify({ version: 99, revision: 999 }))
  const nonRequired = rt.save({ required: false })
  const requiredCoalesced = rt.save({ required: true })
  await nonRequired
  await assert.rejects(() => requiredCoalesced, /cannot save the Bot team.*newer DS Bot/)

  // Restore a valid v1 state owned by another host to verify read-only refresh behavior.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 999_999, host: 'other-host', at: Date.now() }))
  writeFileSync(statePath, JSON.stringify(seedState({ revision: rt.state.revision + 5, prefs: { fromOther: true } })))
  syncCalls = 0
  await rt.refresh()
  assert.equal(syncCalls, 1, 'refresh after lock loss / state adopt invokes onStoreSync once')
  assert.equal(rt.state.prefs.fromOther, true)
  // Another unchanged poll while read-only stays silent.
  await rt.refresh()
  assert.equal(syncCalls, 1, 'subsequent unchanged read-only refresh must not fire onStoreSync')

  // Required save rejects when read-only; non-required save resolves.
  await assert.rejects(() => rt.save({ required: true }), /cannot save the Bot team/)
  await rt.save()
})

test('agent-commands.js skips command resync on unrelated saves and resyncs on coverage change or commands/change', () => {
  const scoped = new Map()
  let registerCalls = 0
  const globalDefs = [{ name: 'compact', description: 'global compact' }]
  const listeners = new Map()
  const emit = (event, payload) => { for (const fn of listeners.get(event) ?? []) fn(payload) }
  const childCommands = (sessionId) => ({
    list: () => [...globalDefs, ...(scoped.get(sessionId)?.values() ?? [])],
    register(def) {
      registerCalls += 1
      const map = scoped.get(sessionId) ?? new Map()
      map.set(def.name, def)
      scoped.set(sessionId, map)
      emit('commands/change', {})
      return () => { map.delete(def.name); emit('commands/change', {}) }
    },
  })
  const ctx = {
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    get: name => (name === 'agents' ? { list: () => [] } : undefined),
    effect: () => {},
  }
  const savedListeners = new Set()
  const covered = new Set(['a'])
  const rt = {
    ctx,
    state: { rooms: {}, bots: { a: { id: 'a', sessionId: 'a' } } },
    chatOwners: covered,
    chatOf: () => undefined,
    roomOf: () => undefined,
    onSaved: fn => { savedListeners.add(fn); return () => savedListeners.delete(fn) },
  }
  installAgentCommands(rt)

  const commands = childCommands('a')
  const agent = {
    id: 'a',
    session: { id: 'a' },
    ctx: {
      plugin(def) {
        def.apply({ commands, get: name => (name === 'commands' ? commands : undefined) })
        return { dispose() {} }
      },
    },
  }
  emit('agent/created', { agent })
  assert.equal(registerCalls, 1)

  // Unrelated saves keep the same coverage: must NOT re-register.
  for (const fn of savedListeners) fn()
  for (const fn of savedListeners) fn()
  assert.equal(registerCalls, 1, 'unrelated state saves must not churn command registrations')

  // Coverage drops -> unmount; coverage returns -> register again.
  covered.delete('a')
  for (const fn of savedListeners) fn()
  assert.equal(scoped.get('a')?.size ?? 0, 0)
  covered.add('a')
  for (const fn of savedListeners) fn()
  assert.equal(registerCalls, 2)

  // commands/change still triggers full resync.
  emit('commands/change', {})
  assert.equal(registerCalls, 3)
})

test('capabilities.js skips unrelated saves, tracks active bot.tasks settlement, and retries after transient loadInputs failure', async () => {
  let reconcileCalls = 0
  let failNextLoadSecrets = false
  const agent = { id: 'a', session: { id: 'a' } }
  const ctx = fakeContext({
    services: {
      mcp: { listServers: () => [], getServerTools: () => [] },
      agents: { list: () => [agent], get: id => (id === 'a' ? agent : undefined) },
    },
  })
  const rt = {
    ctx,
    state: {
      bots: {
        a: {
          id: 'a',
          sessionId: 'a',
          capabilities: [],
          packs: [],
          tasks: [{ id: 't1', sessionId: 'a-task-1', status: 'running' }],
        },
      },
      rooms: {},
      capabilities: { items: {}, packs: {} },
    },
    home: tmpdir(),
    load: async () => {},
    loadSecrets: async () => {
      reconcileCalls += 1
      if (failNextLoadSecrets) {
        failNextLoadSecrets = false
        throw new Error('transient secrets read error')
      }
    },
    readOnly: () => undefined,
    chatOwners: new Map([['a', 'a'], ['a-task-1', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    taskOwners: new Map([['a-task-1', { botId: 'a', taskId: 't1' }]]),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    selfOf: id => (id === 'a' || id === 'a-task-1' ? 'a' : undefined),
    isBotSession: id => rt.chatOwners.has(id),
    hasSecret: () => false,
    warn() {},
  }
  installCapabilities(rt)
  await rt.ensureCapabilities('a')
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  const baseline = reconcileCalls

  // Unrelated state saves keep identical fingerprint -> skip reconcile.
  rt.capabilitiesStateSaved()
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reconcileCalls, baseline, 'unrelated state save should skip capability reconcile')

  // Settling an active background task changes capabilityFingerprint() and triggers reconcile!
  rt.state.bots.a.tasks[0].status = 'done'
  rt.chatOwners.delete('a-task-1')
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reconcileCalls, baseline + 1, 'settling a background task must change fingerprint and trigger reconcile')

  // Transient loadInputs() failure must NOT advance lastReconcileFingerprint: next save retries!
  failNextLoadSecrets = true
  rt.state.bots.a.capabilities.push('cap-1')
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reconcileCalls, baseline + 2, 'first attempt runs and fails transiently')
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reconcileCalls, baseline + 3, 'subsequent save must retry after transient loadInputs failure')

  // Once succeeded, repeating save with same state is skipped again.
  rt.capabilitiesStateSaved()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reconcileCalls, baseline + 3)
  await ctx.dispose()
})

test('secrets.js avoids rt.save in noteUsed via shellEnv.resolve, skips reload on unchanged read-only sync, and zero-allocates in redactDeep', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-secrets-')
  let registeredShellEnv = null
  const shellEnv = {
    register(spec) {
      registeredShellEnv = spec
      return () => { if (registeredShellEnv === spec) registeredShellEnv = null }
    },
  }
  const ctx = fakeContext({ services: { shellEnv } })
  let saveCalls = 0
  let secretsChangedCalls = 0
  let readOnlyReason
  const rt = {
    ctx,
    home,
    state: { bots: { a: { id: 'a', name: 'Chief', sessionId: 'a' } }, rooms: {} },
    teamTools: [],
    readOnly: () => readOnlyReason,
    hasLoaded: () => true,
    botOf: id => rt.state.bots[id],
    selfOf: id => id,
    isBotSession: id => id === 'a',
    secretsChanged: () => { secretsChangedCalls += 1 },
    save: async () => { saveCalls += 1 },
    load: async () => {},
    warn() {},
  }
  installSecrets(rt)
  t.after(() => ctx.dispose())

  await rt.secretEndpoint('secret-set', { name: 'API_TOKEN', value: 'super-secret-value-12345' })
  assert.ok(registeredShellEnv, 'secrets.js must register shellEnv contribution')
  const savesAfterSet = saveCalls

  // Trigger real noteUsed() through shellEnv.resolve and advance fake timers past USED_SAVE_MS (5000ms).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const envVars = registeredShellEnv.resolve({ agent: { id: 'a' }, arguments: { command: 'echo $DSH_SECRET_API_TOKEN' } })
  assert.equal(envVars.DSH_SECRET_API_TOKEN, 'super-secret-value-12345')
  t.mock.timers.tick(5_500)
  t.mock.timers.reset()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(saveCalls, savesAfterSet, 'noteUsed timer firing must persist secrets.json without calling rt.save()')
  const persistedSecrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))
  assert.equal(typeof persistedSecrets.secrets[0].lastUsedAt, 'number', 'noteUsed persisted lastUsedAt to secrets.json')

  // Unchanged objects/arrays in redactDeep return identical reference (zero allocation).
  const redact = redactor([{ name: 'API_TOKEN', value: 'super-secret-value-12345' }])
  const unchangedObj = { role: 'user', content: [{ type: 'text', text: 'plain hello' }] }
  assert.equal(redactDeep(unchangedObj, redact), unchangedObj)

  // Changed values redact cleanly without mutating the original.
  const secretObj = { role: 'user', content: [{ type: 'text', text: 'token is super-secret-value-12345' }] }
  const redacted = redactDeep(secretObj, redact)
  assert.notEqual(redacted, secretObj)
  assert.match(redacted.content[0].text, /\[secret:API_TOKEN\]/)
  assert.equal(secretObj.content[0].text, 'token is super-secret-value-12345')

  // Read-only host with unchanged secrets.json short-circuits onStoreSync (0 reloads / 0 secretsChanged).
  readOnlyReason = 'Another host'
  const changedBeforePoll = secretsChangedCalls
  rt.onStoreSync()
  rt.onStoreSync()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(secretsChangedCalls, changedBeforePoll, 'unchanged read-only onStoreSync must not reload or emit secretsChanged')

  // Externally changing secrets.json DOES trigger reload and secretsChanged on next onStoreSync.
  const updatedPayload = {
    version: 1,
    secrets: [
      ...persistedSecrets.secrets,
      { name: 'EXTRA_KEY', value: 'extra-value-99999', purpose: 'ext', scope: 'all', createdAt: 2, updatedAt: 2 },
    ],
  }
  writeFileSync(join(home, 'secrets.json'), JSON.stringify(updatedPayload))
  rt.onStoreSync()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(secretsChangedCalls, changedBeforePoll + 1, 'modified secrets.json must trigger reload on read-only onStoreSync')
  assert.ok(rt.secretsView().some(item => item.name === 'EXTRA_KEY'))
})

test('channel.js forwards AbortSignal to computerEndpoint and bounds staged images with cleanup on dispose', async (t) => {
  const { ctx } = minimalCtx()
  let receivedSignal
  let route
  const origRegister = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return origRegister(options) }
  const rt = {
    ctx,
    home: tempDir(t, 'ds-bot-perf-channel-'),
    state: seedState(),
    load: async () => {},
    refresh: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    selfOf: id => id,
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    taskOwners: new Map(),
    cachedCatalog: () => [],
    cachedDefault: () => undefined,
    chatTail: () => undefined,
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    turnsView: () => ({}),
    steeredView: () => ({}),
    approvalsView: () => [],
    switchJobs: () => [],
    phoneServe: () => {},
    computerEndpoint: async (_name, _body, signal) => { receivedSignal = signal; return { ok: true } },
    warn() {},
  }
  installChannel(rt)
  t.after(() => ctx.dispose())
  const call = async (endpoint, payload, signal) => {
    const req = new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }), ...(signal ? { signal } : {}) })
    return (await route.fetch(req)).json()
  }

  const ac = new AbortController()
  await call('computer-wait', { clientId: 'c1' }, ac.signal)
  assert.ok(receivedSignal instanceof AbortSignal, 'computerEndpoint receives AbortSignal')

  // Staging 25 images evicts the oldest 5 (max 20 entries).
  const ids = []
  for (let i = 0; i < 25; i += 1) {
    const res = await call('stage-image', { mediaType: 'image/png', data: 'AAAA' })
    assert.equal(res.ok, true)
    ids.push(res.value.id)
  }
  const staleRes = await call('send', { sessionId: 'a', images: [ids[0]] })
  assert.equal(staleRes.ok, false)
  assert.equal(staleRes.error.code, 'bot/stale')

  // Dispose clears staged map so even the newest staged photo is gone afterward.
  await ctx.dispose()
  const afterDispose = await call('send', { sessionId: 'a', images: [ids[24]] })
  assert.equal(afterDispose.ok, false)
  assert.equal(afterDispose.error.code, 'bot/stale')
})

test('usage.js journal() uses revision-keyed cache before scanning book.owners()', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-usage-')
  let listCalls = 0
  const ctx = fakeContext({
    services: {
      sessionQuery: { listSessions: async () => { listCalls += 1; return [] } },
    },
  })
  const rt = {
    ctx,
    home,
    state: seedState({ revision: 3 }),
    config: {},
    load: async () => {},
    readOnly: () => undefined,
    cachedCatalog: () => [],
    chatOf: id => id,
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    roomOwners: new Map(),
    pastOwners: new Map(),
    taskOwners: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    agentOf: () => undefined,
    warn() {},
  }
  installUsage(rt)
  t.after(() => ctx.dispose())

  let loadCalls = 0
  rt.load = async () => { loadCalls += 1 }
  const [onStream] = ctx.listeners.get('llm/stream')
  const makeStream = () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  })()
  const drain = async (iter) => {
    let count = 0
    for await (const chunk of iter) if (chunk !== undefined) count += 1
    return count
  }
  const msgs1 = rt.tagUsage([], { sessionId: 'a', kind: 'memory' })
  assert.equal(await drain(onStream({ sessionId: 'a', messages: msgs1, provider: 'deepseek', model: 'deepseek-chat' }, () => makeStream())), 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  const loadsAfterFirst = loadCalls

  const msgs2 = rt.tagUsage([], { sessionId: 'a', kind: 'memory' })
  assert.equal(await drain(onStream({ sessionId: 'a', messages: msgs2, provider: 'deepseek', model: 'deepseek-chat' }, () => makeStream())), 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(loadCalls, loadsAfterFirst, 'second noteSession at same revision hits fast-path journaled cache')

  const view = await rt.usageView({ range: '7d' })
  assert.equal(view.rows.reduce((sum, row) => sum + row[8], 0), 2)
  assert.equal(listCalls, 0)
})

test('images.js skips repeated idle offload scans, handles tool/result message.content, and WeakSet-tracks agent.session across dispose', async (t) => {
  const ctx = fakeContext()
  ctx.sessions = {
    messageProjections: [{ type: 'image/offload' }],
    flush: async () => {},
  }
  let surfaceWalks = 0
  const makeSession = () => ({
    id: 'a',
    seq: 2,
    surface: {
      get nodes() { surfaceWalks += 1; return [] },
    },
    eventAt: () => undefined,
    deriveEventMessage: event => event?.data?.derived ?? event?.data,
  })
  const session1 = makeSession()
  const agent1 = { id: 'a', session: session1 }
  const rt = {
    ctx,
    home: tempDir(t, 'ds-bot-perf-images-'),
    config: {},
    state: seedState(),
    readOnly: () => undefined,
    isBotSession: id => id === 'a',
    botOf: id => rt.state.bots[id],
    selfOf: id => id,
    warn() {},
  }
  installImages(rt)
  t.after(() => ctx.dispose())

  const [onStatus] = ctx.listeners.get('agent/status')
  const [onEvent] = ctx.listeners.get('session/event')
  const [onDisposed] = ctx.listeners.get('agent/disposed')

  // First idle scans surface.nodes once.
  onStatus({ agent: agent1, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(surfaceWalks, 1)

  // Repeated idles without any new image skip the surface walk entirely.
  onStatus({ agent: agent1, status: 'idle' })
  onStatus({ agent: agent1, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(surfaceWalks, 1, 'subsequent idle with no new image must skip offloadTargets surface walk')

  // tool/result with non-image data.content must NOT short-circuit before inspecting data.message.content.
  onEvent(session1, {
    type: 'tool/result',
    data: {
      content: [{ type: 'text', text: 'raw tool output' }],
      message: { content: [{ type: 'image', attachment: { attachmentId: 'att-tool' } }] },
    },
  })
  onStatus({ agent: agent1, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(surfaceWalks, 2, 'tool/result image in data.message.content must re-arm offloadTargets scan')

  // Dispose immediately after queueing idle check: setImmediate finishes on session1,
  // but a newly loaded session2 for the same sessionId is NOT in checkedSessions WeakSet.
  onEvent(session1, { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: 'att-2' } }] } })
  onStatus({ agent: agent1, status: 'idle' })
  onDisposed({ agent: agent1 })
  await new Promise(resolve => setImmediate(resolve))
  const walksAfterDispose = surfaceWalks
  const session2 = makeSession()
  onStatus({ agent: { id: 'a', session: session2 }, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(surfaceWalks, walksAfterDispose + 1, 'new agent.session instance after agent/disposed must not be skipped by WeakSet')
})

test('privacy.js catches newly created/redirected symlinks without bumping state.revision and deduplicates per-call realBeyond', async (t) => {
  const base = tempDir(t, 'ds-bot-perf-privacy-')
  const home = join(base, 'data')
  const privDir = join(base, 'private-work')
  const openDir = join(base, 'open-work')
  const realSecretTarget = join(base, 'vault-target')
  const symlinkAlias = join(openDir, 'innocent-link')
  mkdirSync(home, { recursive: true })
  mkdirSync(privDir, { recursive: true })
  mkdirSync(openDir, { recursive: true })
  mkdirSync(realSecretTarget, { recursive: true })
  writeFileSync(join(privDir, 'diary.txt'), 'top secret')
  writeFileSync(join(realSecretTarget, 'vault.txt'), 'vault secret')

  const { ctx } = minimalCtx()
  const adoptListeners = new Set()
  const rt = {
    ctx,
    home,
    config: { workspace: openDir },
    dshHome: join(base, 'dsh'),
    statePath: join(home, 'state.json'),
    state: seedState({
      revision: 1,
      bots: {
        a: { id: 'a', name: 'Chief', sessionId: 'a', workDir: openDir },
        'bot-secret-1': { id: 'bot-secret-1', name: 'Secret', sessionId: 'bot-secret-1', private: true, workDir: privDir },
      },
    }),
    onAdopted: fn => { adoptListeners.add(fn); return () => adoptListeners.delete(fn) },
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => id,
    groupSessionsOf: () => [],
    selfOf: id => id,
    isBotSession: id => id === 'a' || id === 'bot-secret-1',
    warn() {},
  }
  installFolders(rt)
  let realCalls = 0
  const realBeyondActual = rt.realBeyond
  rt.realBeyond = async (p) => { realCalls += 1; return realBeyondActual(p) }
  installPrivacy(rt)
  t.after(() => ctx.dispose())

  const [toolGuard] = ctx.listeners.get('tools/execute')
  const callRead = async (filePath) => {
    try {
      return await toolGuard({ name: 'read', arguments: { file_path: filePath }, agent: { id: 'a', session: { id: 'a' } } }, async () => 'allowed')
    } catch (error) {
      return error.message
    }
  }

  // 1. Reading an open path succeeds at revision 1.
  writeFileSync(join(openDir, 'notes.txt'), 'public')
  assert.equal(await callRead(join(openDir, 'notes.txt')), 'allowed')

  // 2. Externally create a symlink from openDir -> privDir WITHOUT bumping state.revision!
  // Privacy fence MUST catch it immediately via live realpath resolution.
  symlinkSync(privDir, symlinkAlias)
  const blockedViaSymlink = await callRead(join(symlinkAlias, 'diary.txt'))
  assert.match(String(blockedViaSymlink), /private/, 'symlink into private dir must be blocked without revision bump')

  // 3. Replace privDir itself with a symlink pointing to realSecretTarget WITHOUT bumping state.revision!
  // Reading realSecretTarget directly MUST be blocked because regionsOf resolves live realpath!
  rmSync(privDir, { recursive: true, force: true })
  symlinkSync(realSecretTarget, privDir)
  const blockedTarget = await callRead(join(realSecretTarget, 'vault.txt'))
  assert.match(String(blockedTarget), /private/, 'redirected private workDir symlink target must be blocked without revision bump')

  // 4. Per-call memo deduplication: a `glob` call checking both `path` and `pattern` resolves
  // private regions/shared files ONCE per call instead of twice!
  const beforeSingle = realCalls
  await toolGuard({ name: 'glob', arguments: { path: openDir }, agent: { id: 'a', session: { id: 'a' } } }, async () => 'ok')
  const singleCalls = realCalls - beforeSingle
  const beforeDouble = realCalls
  await toolGuard({ name: 'glob', arguments: { path: openDir, pattern: join(openDir, '*.txt') }, agent: { id: 'a', session: { id: 'a' } } }, async () => 'ok')
  const doubleCalls = realCalls - beforeDouble
  assert.equal(doubleCalls <= singleCalls + 1, true, `expected per-call memo to deduplicate glob path+pattern (${doubleCalls} vs single ${singleCalls})`)
})

test('memory.js shares one deriveMessages() across groupSnapshot + autoRecall, sees same-tick topic edits, and handles vanishing topic replacement', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-memory-')
  const ctx = fakeContext()
  const rt = {
    ctx,
    home,
    config: { memoryReview: false, memoryTidy: false },
    state: seedState({
      rooms: {
        r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', sessions: { a: 'ga', b: 'gb' } },
      },
    }),
    load: async () => {},
    readOnly: () => undefined,
    teamTools: [],
    chatOwners: new Map([['a', 'a'], ['b', 'b']]),
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
    pastOwners: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    sessionOfRoom: room => room.sessionId ?? room.id,
    groupSessionsOf: id => (id === 'a' ? ['ga'] : id === 'b' ? ['gb'] : []),
    selfOf: id => (id === 'ga' ? 'a' : id === 'gb' ? 'b' : id),
    isBotSession: id => ['a', 'b', 'ga', 'gb'].includes(id),
    isMain: id => id === 'a',
    isPrivate: () => false,
    warn() {},
  }
  installMemory(rt)
  t.after(() => ctx.dispose())

  await rt.memoryAdd({ botId: 'a', scope: 'own', topic: 'deploy', text: 'Always run smoke checks before deploy' })
  await rt.memoryAdd({ botId: 'a', roomId: 'r1', scope: 'group', text: 'Ops deploys on Tuesdays' })
  let deriveCalls = 0
  const agent = {
    id: 'ga',
    session: {
      id: 'ga',
      deriveMessages: () => {
        deriveCalls += 1
        return []
      },
    },
  }
  const [preStep] = ctx.listeners.get('agent/pre-step')
  const triggerMessage = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'How should we run deploy smoke checks?' }],
  }
  const decision = await preStep({ agent, step: 1, messages: [triggerMessage] }, async () => ({ kind: 'enter', messages: [triggerMessage] }))
  assert.equal(deriveCalls, 1, 'agent/pre-step must call deriveMessages exactly once across groupSnapshot + autoRecall')
  const sources = decision.messages.map(m => m.source?.kind)
  assert.ok(sources.includes('ds-bot-group-memory'), 'groupSnapshot actually ran')
  assert.ok(sources.includes('ds-bot-memory-recall'), 'autoRecall actually ran and recalled matching topic')
  const recallText = decision.messages.find(m => m.source?.kind === 'ds-bot-memory-recall').content[0].text
  assert.match(recallText, /Always run smoke checks before deploy/)

  // Same-tick external topic creation and deletion must be visible immediately (no stale dirNamesCache).
  const botMemDir = join(home, 'memory', 'bots', 'a')
  writeFileSync(join(botMemDir, 'alpha.md'), '# alpha\n\n- [2026-11-24] alpha deployment checklist\n')
  writeFileSync(join(botMemDir, 'beta.md'), '# beta\n\n- [2026-11-24] beta rollback procedure\n')
  const recallTool = rt.teamTools.find(tool => tool.name === 'bot_recall')
  const foundBeta = await recallTool.execute({ query: 'beta rollback', scope: 'own' }, { agent: { id: 'a' } })
  assert.match(String(foundBeta), /beta rollback procedure/)

  // Same-length topic replacement where the new topic file vanishes (dangling symlink `gamma.md`
  // replaces deleted `beta.md`): `recallEntries` MUST NOT return deleted `beta`!
  unlinkSync(join(botMemDir, 'beta.md'))
  symlinkSync(join(botMemDir, 'does-not-exist.md'), join(botMemDir, 'gamma.md'))
  const afterReplace = await recallTool.execute({ query: 'beta rollback', scope: 'own' }, { agent: { id: 'a' } })
  assert.doesNotMatch(String(afterReplace), /beta rollback procedure/, 'deleted topic beta must not leak via recallCache when replaced by missing file of same list length')

  await rt.archiveBotMemory('a')
  await rt.archiveGroupMemory(rt.state.rooms.r1)
})

test('memory-review.js does not cancel pending review timer on agent/disposed', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-review-')
  const { ctx } = minimalCtx()
  let partLinesCalls = 0
  let llmCalls = 0
  const rt = {
    ctx,
    home,
    config: { memoryReview: true, memoryReviewDelayMs: 35, memoryTidy: false },
    state: seedState(),
    load: async () => {},
    readOnly: () => undefined,
    teamTools: [],
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    sessionOfRoom: room => room.sessionId ?? room.id,
    groupSessionsOf: () => [],
    selfOf: id => id,
    isBotSession: id => id === 'a',
    isMain: id => id === 'a',
    isPrivate: () => false,
    partsOfThread: () => [{ sessionId: 'a' }],
    async *partLines() {
      partLinesCalls += 1
      yield { seq: 1, who: 'user', text: 'Remember that we always ship with tests.' }
    },
    desiredModel: async () => 'deepseek/deepseek-chat',
    defaultModel: async () => 'deepseek/deepseek-chat',
    tagUsage: msgs => msgs,
    assembleLlm: async () => {
      llmCalls += 1
      return { finish: { kind: 'stop' }, blocks: () => [{ type: 'text', text: '[]' }] }
    },
    warn() {},
  }
  installMemory(rt)
  t.after(() => ctx.dispose())

  const [onStatus] = ctx.listeners.get('agent/status')
  const [onDisposed] = ctx.listeners.get('agent/disposed')

  // Turn runs then goes idle -> schedules 35ms review timer.
  onStatus({ agent: { id: 'a' }, status: 'running' })
  onStatus({ agent: { id: 'a' }, status: 'idle' })
  assert.equal(rt.memoryReviews(), 1, 'review timer scheduled on idle')

  // Agent is disposed (e.g. segment switch or idle cold-unload) while timer is still pending!
  onDisposed({ agent: { id: 'a' } })
  assert.equal(rt.memoryReviews(), 1, 'agent/disposed must NOT cancel pending memory review timer')

  // Wait for timer to fire and run the review.
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(partLinesCalls >= 1, true, 'final turn memory review actually executed after agent/disposed')
  assert.equal(llmCalls >= 1, true, 'review LLM call ran after agent/disposed')
})

test('parts.js and turns.js preserve active session state on cold-unload agent/disposed and clean up archived sessions', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-parts-turns-')
  const { ctx } = minimalCtx()
  let tailPageCalls = 0
  ctx.sessionController.page = async ({ address }) => {
    tailPageCalls += 1
    return {
      records: [{
        event: {
          seq: 1,
          type: 'user/message',
          time: 1234,
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: `tail-${address.sessionId}` }] },
        },
      }],
      hasMore: false,
    }
  }
  const rt = {
    ctx,
    home,
    config: {},
    state: seedState({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a-live', segments: [{ sessionId: 'a-old', endedAt: 1 }], createdAt: 1 },
      },
    }),
    load: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => rt.state.bots[id]?.sessionId ?? id,
    sessionOfRoom: room => room?.sessionId ?? room?.id,
    selfOf: id => (id === 'a-live' || id === 'a-old' ? 'a' : undefined),
    isBotSession: id => rt.chatOwners.has(id) || rt.groupOwners.has(id),
    chatOwners: new Map([['a-live', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map([['a-old', { botId: 'a' }]]),
    taskOwners: new Map(),
    teamTools: [],
    noteFailure() {},
    warn() {},
  }
  installParts(rt)
  installTurns(rt)
  t.after(() => ctx.dispose())

  // Populate `tails` in parts.js for both active and archived sessions.
  rt.chatTail('a-live')
  rt.chatTail('a-old')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.chatTail('a-live')?.preview, 'tail-a-live')
  assert.equal(rt.chatTail('a-old')?.preview, 'tail-a-old')
  const pagesAfterFill = tailPageCalls

  // Populate live entries for active bot session (with pending) and two archived sessions.
  const activeEntry = rt.liveOf('a-live')
  activeEntry.pending = { kind: 'bot', exchangeId: 'ex-1' }
  const archivedCarry = rt.liveOf('a-old')
  archivedCarry.carry = { info: { exchangeId: 'ex-2' }, texts: ['kept'], joined: [], later: [], shown: 0 }
  rt.liveOf('a-dead-empty')

  // Emit agent/disposed for active session (idle cold-unload) -> MUST preserve BOTH tails and live entry!
  for (const fn of ctx.listeners.get('agent/disposed') ?? []) fn({ agent: { id: 'a-live' } })
  assert.equal(rt.chatTail('a-live')?.preview, 'tail-a-live', 'active bot session tail must survive cold-unload agent/disposed')
  assert.equal(tailPageCalls, pagesAfterFill, 'active bot session tail was not evicted')
  assert.equal(rt.live.has('a-live'), true, 'active bot session live entry must survive cold-unload agent/disposed')
  assert.equal(rt.live.get('a-live').pending.exchangeId, 'ex-1')

  // Emit agent/disposed for archived session with carry -> parts.js clears tail, while turns.js preserves carry!
  for (const fn of ctx.listeners.get('agent/disposed') ?? []) fn({ agent: { id: 'a-old' } })
  assert.equal(rt.chatTail('a-old'), undefined, 'archived session tail must be evicted on agent/disposed')
  assert.equal(rt.live.has('a-old'), true, 'forgetSessionTurn must keep live entry when carry is set')
  assert.equal(rt.live.get('a-old').carry.texts[0], 'kept')

  // Emit agent/disposed for empty archived session -> cleaned up!
  for (const fn of ctx.listeners.get('agent/disposed') ?? []) fn({ agent: { id: 'a-dead-empty' } })
  assert.equal(rt.live.has('a-dead-empty'), false, 'archived empty session live entry is cleaned on agent/disposed')
})

test('chat-index.js configures WAL + busy_timeout, unlinks WAL/SHM on corruption, and survives SQLITE_BUSY without unlinking DB', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-chatindex-')
  const ctx = fakeContext()
  const rt = {
    ctx,
    home,
    state: seedState(),
    readOnly: () => undefined,
    load: async () => {},
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    partsOf: () => [],
    warn() {},
  }
  installChatIndex(rt)
  t.after(() => ctx.dispose())

  await rt.searchOwnChat('a', 'hello')
  const dbPath = join(home, 'chat-index.sqlite')
  const checkDb = new DatabaseSync(dbPath)
  try {
    const mode = checkDb.prepare('PRAGMA journal_mode').get()
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal')
  } finally {
    checkDb.close()
  }
  await ctx.dispose()

  // Corrupt the SQLite file along with stale -wal/-shm sidecars and verify rebuild removes them cleanly.
  writeFileSync(dbPath, 'not-a-valid-sqlite-database-header')
  writeFileSync(`${dbPath}-wal`, 'stale-wal-garbage')
  writeFileSync(`${dbPath}-shm`, 'stale-shm-garbage')
  const ctx2 = fakeContext()
  const rt2 = { ...rt, ctx: ctx2 }
  installChatIndex(rt2)
  t.after(() => ctx2.dispose())
  const res = await rt2.searchOwnChat('a', 'hello')
  assert.deepEqual(res.lines, [])
  const recovered = new DatabaseSync(dbPath)
  try {
    assert.ok(recovered.prepare('SELECT count(*) AS c FROM messages').get())
  } finally {
    recovered.close()
  }
  await ctx2.dispose()

  // SQLITE_BUSY must NEVER trigger unlink/rebuild: create a valid DB in rollback journal mode,
  // hold BEGIN EXCLUSIVE on a separate connection, and verify chat-index leaves the DB intact.
  const busyHome = tempDir(t, 'ds-bot-perf-chatindex-busy-')
  const busyDbPath = join(busyHome, 'chat-index.sqlite')
  const locker = new DatabaseSync(busyDbPath)
  t.after(() => { try { locker.close() } catch {} })
  locker.exec('CREATE TABLE sentinel (v TEXT); INSERT INTO sentinel VALUES (\'keep-me\');')
  locker.exec('BEGIN EXCLUSIVE')

  const ctx3 = fakeContext()
  const rt3 = { ...rt, ctx: ctx3, home: busyHome }
  installChatIndex(rt3)
  t.after(() => ctx3.dispose())
  const busyRes = await rt3.searchOwnChat('a', 'hello')
  assert.deepEqual(busyRes.lines, [])
  await ctx3.dispose()

  locker.exec('ROLLBACK')
  locker.close()
  const verifyDb = new DatabaseSync(busyDbPath)
  try {
    assert.equal(verifyDb.prepare('SELECT v FROM sentinel').get().v, 'keep-me', 'SQLITE_BUSY must never unlink or rebuild the database')
  } finally {
    verifyDb.close()
  }
})

test('mcp-server.js backs off EADDRINUSE with cooldown recovery, awaits stop on dispose, and aborts wait_for_reply on HTTP close', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-mcp-')
  const blocker = createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => blocker.close(() => resolve())))
  const busyPort = blocker.address().port

  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    version: 1,
    on: true,
    port: busyPort,
    clients: [{ id: 'c1', name: 'CLI', hash: '0'.repeat(64), bots: ['a'], rooms: [], createdAt: 1 }],
  }))
  const ctx = fakeContext()
  const rt = {
    ctx,
    home,
    mcpBindRetryCooldownMs: 120,
    state: seedState(),
    readOnly: () => undefined,
    load: async () => {},
    save: async () => {},
    warn() {},
  }
  installMcpServer(rt)
  t.after(() => ctx.dispose())

  // First settle hits EADDRINUSE and records error.
  await new Promise(resolve => setTimeout(resolve, 40))
  const first = rt.mcpView()
  assert.equal(first.status, 'off')
  assert.equal(first.error, `Port ${busyPort} is in use`)

  // Free the blocker port: polls INSIDE cooldown MUST NOT spin listen() immediately.
  await new Promise(resolve => blocker.close(resolve))
  for (let i = 0; i < 5; i += 1) {
    assert.equal(rt.mcpView().status, 'off', 'mcpView polls during bind cooldown must not hammer listen()')
  }

  // Once cooldown expires, next mcpView() self-heals automatically and binds the port!
  await new Promise(resolve => setTimeout(resolve, 140))
  rt.mcpView()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(rt.mcpView().status, 'on', 'mcp-server must auto-recover after bind retry cooldown expires')
  assert.equal(rt.mcpView().error, null)

  // Plugin dispose MUST await stop() so the port is immediately bindable right after ctx.dispose()!
  await ctx.dispose()
  const probe = createServer()
  await new Promise((resolve, reject) => probe.once('error', reject).listen(busyPort, '127.0.0.1', resolve))
  await new Promise(resolve => probe.close(resolve))

  // Real HTTP disconnect test: response.on('close') aborts an in-flight wait_for_reply immediately!
  let abortedObserved = false
  let callResolved = false
  const server = mcpHttpServer({
    authorize: token => (token === 'valid-tok' ? { id: 'c1', name: 'CLI' } : undefined),
    callFor: () => async (_name, _args, { signal }) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30_000)
        signal?.addEventListener('abort', () => {
          abortedObserved = true
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      callResolved = true
      return { done: false, working: true, messages: [], after: 0 }
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => closeServer(server))
  const { port } = server.address()

  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_reply', arguments: { bot: 'a', timeoutSeconds: 30 } } })
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-tok',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
  })
  req.on('error', () => {})
  req.write(payload)
  req.end()
  await new Promise(resolve => setTimeout(resolve, 40))
  req.destroy()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(abortedObserved, true, 'response close must abort AbortSignal passed to wait_for_reply')
  assert.equal(callResolved, true, 'wait_for_reply promise must settle immediately after client disconnect')
})

test('handoffs.js sweeps expired pairLoops, clears whole cache on adopt, and drops/retains result files based on persistedRevision', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-handoffs-')
  const ctx = fakeContext()
  const adoptListeners = new Set()
  let persistedRev = 2
  let persistOnSave = true
  const rt = {
    ctx,
    home,
    state: seedState({
      revision: 2,
      pairLoops: {
        'a:b': { idleBounces: 2, lastAt: 1 }, // expired
      },
    }),
    readOnly: () => undefined,
    load: async () => {},
    persistedRevision: () => persistedRev,
    onAdopted: fn => { adoptListeners.add(fn); return () => adoptListeners.delete(fn) },
    botOf: id => rt.state.bots[id],
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
    save: async () => {
      if (persistOnSave) {
        rt.state.revision += 1
        persistedRev = rt.state.revision
      }
    },
    warn() {},
  }
  installHandoffs(rt)
  t.after(() => ctx.dispose())

  // Sweeps expired pairLoops entry on write.
  rt.noteWorkCompleted('b', 'c', { worked: false, id: 'w1', text: 'hello' })
  assert.equal(rt.state.pairLoops['a:b'], undefined, 'expired pairLoops entry was swept')
  assert.ok(rt.state.pairLoops['b:c'])

  // 1. closeWork stores long result on disk; dropWork when save() does NOT advance persistedRevision
  // MUST retain the result file on disk.
  const longText = 'x'.repeat(25_000)
  rt.openWork('parent-retain', { from: 'user', to: 'a' })
  rt.openWork('w-retain', { from: 'a', to: 'b', parent: 'parent-retain' })
  rt.closeWork('w-retain', 'Writer', longText)
  await new Promise(resolve => setTimeout(resolve, 20))
  const retainedFile = rt.state.works['parent-retain'].results[0].file
  const retainedPath = join(home, 'handoff-results', retainedFile)
  assert.equal(existsSync(retainedPath), true, 'long result file written to disk')

  // onAdopted clears `whole` cache; answerText still reads full text from disk.
  for (const fn of adoptListeners) fn()
  assert.equal(rt.answerText('parent-retain', '', 'Chief').includes(longText), true)

  persistOnSave = false
  rt.dropWork('parent-retain')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(existsSync(retainedPath), true, 'result file must be retained when persistedRevision did not advance')

  // 2. When save() advances persistedRevision, closing/dropping parent deletes result file on disk
  // WITHOUT needing state.json to exist on disk!
  persistOnSave = true
  rt.openWork('parent-drop', { from: 'user', to: 'a' })
  rt.openWork('w-drop', { from: 'a', to: 'b', parent: 'parent-drop' })
  rt.closeWork('w-drop', 'Writer', longText)
  await new Promise(resolve => setTimeout(resolve, 20))
  const droppedFile = rt.state.works['parent-drop'].results[0].file
  const droppedPath = join(home, 'handoff-results', droppedFile)
  assert.equal(existsSync(droppedPath), true, 'second long result file written to disk')
  assert.equal(existsSync(join(home, 'state.json')), false, 'state.json does not exist on disk')

  rt.closeWork('parent-drop', 'Chief', 'all done')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(existsSync(droppedPath), false, 'closeWork on parent must delete result file once persistedRevision advances')
})

test('ledger.js bounds LRU, handles prepend rename TOCTOU, broken UTF-8 byte boundaries, torn recovery, and write-failure rollback', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-ledger-')
  let readOnly
  const writerCtx = fakeContext()
  const writerRt = { ctx: writerCtx, home, readOnly: () => undefined, warn() {} }
  installLedger(writerRt)
  t.after(() => writerCtx.dispose())

  // Write 40 distinct books and flush -> settled writes trigger LRU eviction down to 32.
  for (let i = 0; i < 40; i += 1) {
    writerRt.ledger.append(`group-r${i}`, { seq: 1, text: `book ${i}` })
  }
  await writerRt.ledger.flush()
  assert.equal(writerRt.ledger.cachedBooks() <= 32, true, `expected <= 32 cached books, got ${writerRt.ledger.cachedBooks()}`)

  // O(1) firstSeq, lastSeq, nextAnchor.
  writerRt.ledger.append('group-idx', { seq: 10, text: 'ten' })
  writerRt.ledger.append('group-idx', { event: 'anchor', id: 'anc-1', from: 10 })
  writerRt.ledger.append('group-idx', { seq: 11, text: 'eleven' })
  writerRt.ledger.append('group-idx', { event: 'anchor', id: 'anc-2', from: 12 })
  writerRt.ledger.append('group-idx', { seq: 12, text: 'twelve' })
  await writerRt.ledger.flush('group-idx')
  assert.equal(writerRt.ledger.firstSeq('group-idx'), 10)
  assert.equal(writerRt.ledger.lastSeq('group-idx'), 12)
  assert.equal(writerRt.ledger.nextAnchor('group-idx', 10, 'anc-1'), 12)
  assert.equal(writerRt.ledger.nextAnchor('group-idx', 12, 'anc-2'), undefined)

  // Read-only host reads incremental append on same inode, and falls back to full read on prepend rename.
  const readerCtx = fakeContext()
  const readerRt = { ctx: readerCtx, home, readOnly: () => readOnly, warn() {} }
  readOnly = 'another host'
  installLedger(readerRt)
  t.after(() => readerCtx.dispose())

  assert.deepEqual(readerRt.ledger.records('group-idx').map(r => r.seq).filter(Boolean), [10, 11, 12])
  writerRt.ledger.append('group-idx', { seq: 13, text: 'thirteen' })
  await writerRt.ledger.flush('group-idx')
  assert.deepEqual(readerRt.ledger.records('group-idx').map(r => r.seq).filter(Boolean), [10, 11, 12, 13])

  // Prepend rewrites via rename (new inode): reader detects inode change and falls back to full read.
  writerRt.ledger.prepend('group-idx', [{ seq: 5, text: 'five' }])
  await writerRt.ledger.flush('group-idx')
  assert.deepEqual(readerRt.ledger.records('group-idx').map(r => r.seq).filter(Boolean), [5, 10, 11, 12, 13])

  // Broken non-UTF-8 bytes in file: raw byte length `buf.length` MUST be tracked (not inflated U+FFFD length),
  // so subsequent incremental tail reads start at the exact byte offset without cutting the next JSON line!
  const utf8Path = join(home, 'ledger', 'group-badutf8.jsonl')
  writeFileSync(utf8Path, Buffer.concat([
    Buffer.from([0x80, 0x81, 0xff, 0x0a]),
    Buffer.from('{"seq":1,"text":"first"}\n', 'utf8'),
  ]))
  assert.deepEqual(readerRt.ledger.records('group-badutf8').map(r => r.seq), [1])
  appendFileSync(utf8Path, '{"seq":2,"text":"second"}\n', 'utf8')
  assert.deepEqual(readerRt.ledger.records('group-badutf8').map(r => r.seq), [1, 2], 'incremental tail must not drift after invalid UTF-8 bytes')

  // Torn file recovery: file ends mid-line without '\n' -> reader marks torn=true ->
  // once writer completes the line, reader MUST NOT return stale cached records even if size matches or grows.
  const tornPath = join(home, 'ledger', 'group-torn.jsonl')
  writeFileSync(tornPath, '{"seq":1,"text":"ok"}\n{"seq":2,"text":"par')
  assert.deepEqual(readerRt.ledger.records('group-torn').map(r => r.seq), [1])
  // Overwrite in-place with same byte count or append completion -> torn entry re-reads whole file!
  appendFileSync(tornPath, 'tial-done"}\n', 'utf8')
  assert.deepEqual(readerRt.ledger.records('group-torn').map(r => r.seq), [1, 2], 'torn read-only cache entry must re-read whole file to recover completed line')

  // Write failure rollback: make target path a directory so appendFile fails with EISDIR.
  const failPath = join(home, 'ledger', 'group-fail.jsonl')
  mkdirSync(failPath, { recursive: true })
  writerRt.ledger.append('group-fail', { seq: 1, text: 'cannot land' })
  await writerRt.ledger.flush('group-fail')
  assert.deepEqual(writerRt.ledger.records('group-fail'), [], 'failed append must roll back record from memory')
  assert.equal(writerRt.ledger.open('group-fail').size, -1, 'failed append must reset entry.size to -1')
})

test('delivery.js pairIndex WeakMap advances incrementally and resets cleanly on ledger rollback/reload', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-delivery-')
  const { ctx } = minimalCtx()
  const rt = {
    ctx,
    home,
    state: seedState(),
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => id,
    hideBotUnusedTools() {},
    warn() {},
  }
  installLedger(rt)
  installDelivery(rt)
  t.after(() => ctx.dispose())

  const book = 'pair-a-b'
  // 1. Append first message + delivered mark.
  rt.ledger.append(book, { id: 'm1', from: 'a', to: 'b', role: 'reply', replyTo: 'req-1', text: 'first reply' })
  rt.ledger.append(book, { event: 'delivered', id: 'm1' })
  assert.equal(rt.wasReplyDelivered('a', 'b', 'req-1'), true)
  assert.equal(rt.wasReplyDelivered('a', 'b', 'req-2'), false)

  // 2. Append second message + delivered mark -> WeakMap index advances incrementally.
  rt.ledger.append(book, { id: 'm2', from: 'a', to: 'b', role: 'reply', replyTo: 'req-2', text: 'second reply' })
  rt.ledger.append(book, { event: 'delivered', id: 'm2' })
  assert.equal(rt.wasReplyDelivered('a', 'b', 'req-2'), true)
  assert.equal(rt.exchangesOf('a', 'b').length, 2)

  // 3. Simulate ledger rollback / reload replacing records array (dropping m2) -> pairIndex resets cleanly!
  await rt.ledger.flush(book)
  const entry = rt.ledger.open(book)
  entry.records = entry.records.slice(0, 2)
  assert.equal(rt.wasReplyDelivered('a', 'b', 'req-1'), true)
  assert.equal(rt.wasReplyDelivered('a', 'b', 'req-2'), false, 'pairIndex WeakMap must reset when records array is replaced')
  assert.equal(rt.exchangesOf('a', 'b').length, 1)
})

test('groups.js read_group_chat opens ledger once outside loop and dropRoomStepEcho clears held step lines', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-groups-')
  const { ctx } = minimalCtx()
  const room = {
    id: 'r1',
    name: 'Ops',
    members: ['a', 'b'],
    admin: 'a',
    mode: 'everyone',
    seq: 21,
    sessions: { a: 'ga', b: 'gb' },
    log: [{ seq: 21, who: 'Chief', botId: 'a', text: 'latest message' }],
  }
  const rt = {
    ctx,
    home,
    state: seedState({ rooms: { r1: room } }),
    load: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    findRooms: ref => (ref === 'r1' || ref === 'Ops' ? [room] : []),
    pickRoom: ref => (ref === 'r1' || ref === 'Ops' ? { room } : { error: 'Unknown group' }),
    chatOf: id => id,
    sessionOfRoom: r => r.sessionId ?? r.id,
    selfOf: id => (id === 'ga' ? 'a' : id === 'gb' ? 'b' : id),
    isBotSession: id => ['a', 'b', 'ga', 'gb'].includes(id),
    isMain: id => id === 'a',
    isAdminOf: (r, id) => r.admin === id,
    chatOwners: new Map([['a', 'a'], ['b', 'b']]),
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
    pastOwners: new Map(),
    live: new Map([['ga', { turn: 1 }]]),
    roomProgress: new Map(),
    teamTools: [],
    warn() {},
  }
  installLedger(rt)
  installGroups(rt)
  t.after(() => ctx.dispose())

  // Populate 20 earlier non-member/event records (seq 2..20) + 1 member record at seq 1 in group ledger.
  const book = 'group-r1'
  rt.ledger.append(book, { seq: 1, who: 'Chief', botId: 'a', text: 'earliest real line' })
  for (let seq = 2; seq <= 20; seq += 1) {
    rt.ledger.append(book, { seq, kind: 'working', who: 'Chief', botId: 'a', text: `step ${seq}` })
  }
  await rt.ledger.flush(book)

  // Spy on rt.ledger.open and rt.ledger.record: read_group_chat opens book ONCE outside loop (0 record() calls).
  let openCalls = 0
  let recordCalls = 0
  const origOpen = rt.ledger.open
  const origRecord = rt.ledger.record
  rt.ledger.open = (name) => { openCalls += 1; return origOpen(name) }
  rt.ledger.record = (name, seq) => { recordCalls += 1; return origRecord(name, seq) }
  const readTool = rt.teamTools.find(tool => tool.name === 'read_group_chat')
  const out = await readTool.execute({ group: 'Ops' }, { agent: { id: 'ga' } })
  assert.match(String(out), /before_seq: 21/, 'read_group_chat detects earlier member line at seq 1')
  assert.equal(openCalls, 1, `read_group_chat must open ledger exactly once outside loop, got ${openCalls}`)
  assert.equal(recordCalls, 0, `read_group_chat must not call ledger.record() in a loop, got ${recordCalls}`)

  // dropRoomStepEcho clears buffered step lines so a suppressed/cut turn never leaks lines into next turn.
  const info = { role: 'room', roomId: 'r1', exchangeId: 'ex-1' }
  // First step flushes immediately (first === true); second step within ROOM_STEP_GAP_MS is buffered in entry.lines!
  await rt.roomStepText('ga', info, 'first step line', true).catch(() => {})
  await rt.roomStepText('ga', info, 'buffered stale step line', false)
  rt.dropRoomStepEcho('ga')
  assert.equal(rt.takeRoomSteps('ga'), '', 'dropRoomStepEcho must clear held step lines')
})

test('mobile.js bounds string-only avatarRef cache with dispose cleanup and caches null previews without re-shrinking', async () => {
  clearAvatarRefCache()
  const img = `data:image/png;base64,${'A'.repeat(1024)}`
  const first = avatarRef(img)
  const second = avatarRef(img)
  assert.equal(first, second)
  assert.equal(first.length, 16)
  // Non-string Buffer input works without crashing or polluting string cache.
  const bufRef = avatarRef(Buffer.from('raw-avatar-bytes'))
  assert.equal(bufRef.length, 16)
  // Fill past 64-entry LRU cap cleanly.
  for (let i = 0; i < 80; i += 1) {
    assert.equal(avatarRef(`data:image/png;base64,img-${i}`).length, 16)
  }
  assert.equal(avatarRef(img), first)

  // Real mobileEndpoint('image', { preview: true }) test:
  // Call 1 returns a small PNG (< 100KB) -> previewImage returns null -> cached as null in `previews`.
  // Call 2 returns a large (> 100KB) valid shrinkable PNG for the SAME attachmentId ->
  // because `previews.has(key)` is true with null, mobile.js MUST skip previewImage and return the original PNG!
  const largePng = makeLargePng(800, 800)
  assert.equal(largePng.length > 100_000, true, 'fixture PNG exceeds PREVIEW_MIN_BYTES')
  let readCount = 0
  const attachments = {
    readImage: async () => {
      readCount += 1
      return { data: readCount === 1 ? Buffer.from('tiny-unshrinkable') : largePng }
    },
  }
  const { ctx } = minimalCtx({ attachments })
  ctx.sessionController.page = async () => ({
    records: [{
      event: {
        seq: 1,
        type: 'user/message',
        data: {
          content: [{
            type: 'image',
            attachment: { attachmentId: 'att-null-cache', mediaType: 'image/png', width: 800, height: 800 },
          }],
        },
      },
    }],
    hasMore: false,
  })
  const rt = {
    ctx,
    state: seedState(),
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => id,
    sessionOfRoom: r => r.id,
    partsOf: () => [{ sessionId: 'a' }],
    onApproval: () => () => {},
    warn() {},
  }
  installMobile(rt)

  const res1 = await rt.mobileEndpoint('image', { sessionId: 'a', attachmentId: 'att-null-cache', preview: true })
  assert.equal(res1.mime, 'image/png')
  assert.equal(res1.preview, undefined)

  const res2 = await rt.mobileEndpoint('image', { sessionId: 'a', attachmentId: 'att-null-cache', preview: true })
  assert.equal(res2.mime, 'image/png', 'cached null preview must skip previewImage instead of converting to image/jpeg')
  assert.equal(res2.preview, undefined)

  // Plugin dispose invokes clearAvatarRefCache cleanly.
  await ctx.dispose()
})

test('feed.js refreshes updatedAt on non-text chunks, protects active rt.live turns, evicts orphans, and clears taps on dispose', async (t) => {
  const ctx = fakeContext()
  const rt = {
    ctx,
    state: seedState(),
    live: new Map(),
    chatOwners: new Map([['a', 'a'], ['b', 'b']]),
    selfOf: id => id,
    onSaved: () => () => {},
    displayItems: () => [],
  }
  installFeed(rt)
  t.after(() => ctx.dispose())

  const [onStream] = ctx.listeners.get('agent/assistant-stream')
  const [onStatus] = ctx.listeners.get('agent/status')
  const [onDisposed] = ctx.listeners.get('agent/disposed')

  const replayedStreams = () => {
    const out = []
    const off = rt.subscribeFeed((ev, data) => { if (ev === 'stream') out.push(data) })
    off()
    return out
  }

  // 1. Evict on agent/status === 'idle'.
  onStream({ agent: { id: 'a' }, frame: { type: 'start', attemptId: 'att-1', turn: 1 } })
  onStream({ agent: { id: 'a' }, frame: { type: 'chunk', attemptId: 'att-1', chunk: { type: 'text-delta', text: 'hi' } } })
  onStatus({ agent: { id: 'a' }, status: 'idle' })
  assert.deepEqual(replayedStreams(), [])

  // 2. Evict on agent/disposed.
  onStream({ agent: { id: 'b' }, frame: { type: 'start', attemptId: 'att-2', turn: 1 } })
  onDisposed({ agent: { id: 'b' } })
  assert.deepEqual(replayedStreams(), [])

  // 3. thinking-delta refreshes updatedAt so entry survives past original 5-min window.
  t.mock.timers.enable({ apis: ['Date'] })
  onStream({ agent: { id: 'a' }, frame: { type: 'start', attemptId: 'att-think', turn: 2 } })
  t.mock.timers.tick(4 * 60_000)
  onStream({ agent: { id: 'a' }, frame: { type: 'chunk', attemptId: 'att-think', chunk: { type: 'thinking-delta', text: 'deep thought' } } })
  t.mock.timers.tick(2 * 60_000) // 6 min since start, only 2 min since thinking-delta!
  assert.equal(replayedStreams().some(item => item.attemptId === 'att-think'), true, 'thinking-delta must refresh updatedAt')

  // 4. Active rt.live turn is NOT evicted even after >5 min of total silence!
  rt.live.set('a', { turn: 2 })
  t.mock.timers.tick(6 * 60_000)
  assert.equal(replayedStreams().some(item => item.attemptId === 'att-think'), true, 'active rt.live turn must not be evicted past WRITING_TTL_MS')

  // 5. Once rt.live turn clears, truly orphaned entry past 5 min IS evicted.
  rt.live.delete('a')
  assert.deepEqual(replayedStreams(), [])

  // 6. Taps cleared on dispose.
  const tapEvents = []
  rt.feedTap((ev, data) => tapEvents.push([ev, data]))
  await ctx.dispose()
  rt.publishFeed('live', {})
  assert.equal(tapEvents.length, 0)
})

test('approvals.js removes abort listeners on normal settle and cleans up pending/listeners on dispose', async () => {
  const ctx = fakeContext()
  const rt = {
    ctx,
    groupOwners: new Map([['gb', { botId: 'b', roomId: 'r1' }]]),
    chatOwners: new Map([['a', 'a']]),
    roomOf: () => undefined,
    warn() {},
  }
  installApprovals(rt)

  let added = 0
  let removed = 0
  const signal = {
    aborted: false,
    addEventListener(type, fn) { if (type === 'abort' && typeof fn === 'function') added += 1 },
    removeEventListener(type, fn) { if (type === 'abort' && typeof fn === 'function') removed += 1 },
  }
  const [onApprovalReq] = ctx.listeners.get('approval/request')
  const pendingPromise = onApprovalReq({ agent: { id: 'gb' }, toolName: 'bash', reason: 'test', signal }, () => Promise.resolve('allowed-once'))
  assert.equal(added, 1)
  const open = rt.approvalsView()
  assert.equal(open.length, 1)
  rt.answerApproval(open[0].id, 'allow')
  assert.equal(await pendingPromise, 'allowed-once')
  assert.equal(removed, 1, 'abort listener must be removed after normal approval settle')

  let listenerCalls = 0
  rt.onApproval(() => { listenerCalls += 1 })
  const pending2 = onApprovalReq({ agent: { id: 'gb' }, toolName: 'bash', reason: 'test2' }, () => Promise.resolve('allowed-once'))
  await ctx.dispose()
  assert.equal(await pending2, 'cancelled')
  assert.equal(rt.approvalsView().length, 0)
  const callsAfterDispose = listenerCalls
  onApprovalReq({ agent: { id: 'gb' }, toolName: 'bash', reason: 'after' }, () => Promise.resolve('allowed-once'))
  assert.equal(listenerCalls, callsAfterDispose, 'approvalListeners cleared on dispose')
})

test('btw.js caps historical parts, prevents data loss when LRU evicts during async writePart, and never evicts in-memory mode', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-btw-')
  const btwDir = join(home, 'btw', 'a')
  mkdirSync(btwDir, { recursive: true })
  const targetCards = [
    { id: 'c1', status: 'done', question: 'q1', answer: 'a1' },
    { id: 'c2', status: 'done', question: 'q2', answer: 'a2' },
  ]
  writeFileSync(join(btwDir, 'a-old-0.json'), JSON.stringify(targetCards))

  const ctx = fakeContext()
  const rt = {
    ctx,
    home,
    state: seedState({ bots: { a: { id: 'a', sessionId: 'a-current' } } }),
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => rt.state.bots[id]?.sessionId,
    chatOwners: new Map([['a-current', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map([['a-old-0', { botId: 'a' }]]),
    readOnly: () => undefined,
    save: async () => {},
    warn() {},
  }
  installBtw(rt)
  t.after(() => rt.btwDispose())

  // Load target part first, then kick off async btwDelete('c1') WHILE 65 other historical
  // parts load concurrently to drive LRU eviction past MAX_HISTORICAL_PARTS (50)!
  await rt.btwPartCards('a', 'a-current')
  await rt.btwPartCards('a', 'a-old-0')
  const delPromise = rt.btwDelete({ sessionId: 'a-old-0', cardId: 'c1' })
  const flooding = []
  for (let i = 1; i <= 65; i += 1) {
    flooding.push(rt.btwPartCards('a', `a-old-${i}`))
  }
  const [delResult] = await Promise.all([delPromise, ...flooding])
  assert.deepEqual(delResult, { deleted: true })

  // Disk file MUST retain card c2 (NEVER overwritten with [] by evicted cache lookup!).
  const onDisk = JSON.parse(readFileSync(join(btwDir, 'a-old-0.json'), 'utf8'))
  assert.deepEqual(onDisk.map(c => c.id), ['c2'], 'remaining card c2 must be preserved on disk even under LRU pressure during writePart')
  assert.equal(rt.btwCachedParts() <= 52, true, `expected bounded cached btw parts, got ${rt.btwCachedParts()}`)

  // In-memory-only mode (cardsDir === undefined when rt.home is absent): MUST NOT evict!
  const memRt = {
    ctx: fakeContext(),
    state: seedState({ bots: { a: { id: 'a', sessionId: 'a-current' } } }),
    botOf: id => memRt.state.bots[id],
    chatOf: id => memRt.state.bots[id]?.sessionId,
    readOnly: () => undefined,
    warn() {},
  }
  installBtw(memRt)
  t.after(() => memRt.btwDispose())
  for (let i = 0; i < 65; i += 1) {
    await memRt.btwPartCards('a', `mem-part-${i}`)
  }
  assert.equal(memRt.btwCachedParts(), 65, 'in-memory mode (cardsDir === undefined) must not evict parts')
})

test('tasks.js caps task.notes to last 50 entries', async () => {
  const state = seedState({
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', sessions: { a: 'ga', b: 'gb' }, tasks: {} } },
  })
  const rt = {
    state,
    teamTools: [],
    load: async () => {},
    save: async () => {},
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => (id === 'gb' ? 'b' : 'a'),
    isMain: id => id === 'a',
    isAdminOf: (room, id) => room.admin === id,
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
  }
  installTasks(rt)
  const tool = rt.teamTools.find(d => d.name === 'group_task')
  await tool.execute({ action: 'open', goal: 'Long task' }, { agent: { id: 'gb' } })
  const taskId = Object.keys(state.rooms.r1.tasks)[0]
  for (let i = 0; i < 65; i += 1) rt.taskNote('r1', taskId, `note ${i}`)
  const notes = state.rooms.r1.tasks[taskId].notes
  assert.equal(notes.length, 50)
  assert.equal(notes[0].text, 'note 15')
  assert.equal(notes.at(-1).text, 'note 64')
})

test('requests.js, permissions.js, models.js, and roster.js clean up state maps on deleteBot and deleteRoom', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-lifecycle-')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedState({
    rooms: {
      r1: {
        id: 'r1',
        name: 'Ops',
        members: ['a', 'b'],
        admin: 'a',
        mode: 'admin',
        sessionId: 'r1-p2',
        parts: [{ sessionId: 'r1', endedAt: 10 }],
        sessions: { a: 'ga', b: 'gb' },
      },
    },
    questions: { 'r1-p2': { id: 'q1' }, r1: { id: 'q0' }, b: { id: 'qb' } },
    views: { 'r1-p2': { id: 'v1' }, r1: { id: 'v0' }, b: { id: 'vb' } },
    closedCards: { 'r1-p2': { c1: 'dismissed' }, r1: { c0: 'replied' }, b: { cb: 'replied' } },
    exchangeTurns: { 'r1-p2': [1], r1: [2], b: [3] },
    requests: {
      'b\u0000chat\u0000req-1': { fingerprint: 'f1', outcome: 'delivered', receipt: 'ok', at: 1 },
      'a\u0000chat\u0000req-2': { fingerprint: 'f2', outcome: 'delivered', receipt: 'ok', at: 1 },
    },
    sessionModelSelections: {
      'r1-p2': { requested: { provider: 'p', model: 'm' }, resolved: { provider: 'p', model: 'm' } },
      b: { requested: { provider: 'p', model: 'm' }, resolved: { provider: 'p', model: 'm' } },
      a: { requested: { provider: 'p', model: 'm' }, resolved: { provider: 'p', model: 'm' } },
    },
  })))
  const { ctx } = minimalCtx()
  const rt = createRuntime(ctx, { home })
  t.after(() => ctx.dispose())
  await rt.load()

  rt.liveOf('r1-p2')
  assert.equal(rt.live.has('r1-p2'), true)
  await rt.deleteRoom('r1')
  assert.equal(rt.state.questions['r1-p2'], undefined)
  assert.equal(rt.state.questions.r1, undefined)
  assert.equal(rt.state.views['r1-p2'], undefined)
  assert.equal(rt.state.closedCards['r1-p2'], undefined)
  assert.equal(rt.state.closedCards.r1, undefined)
  assert.equal(rt.state.exchangeTurns['r1-p2'], undefined)
  assert.equal(rt.state.sessionModelSelections['r1-p2'], undefined)
  assert.equal(rt.live.has('r1-p2'), false)

  await rt.deleteBot('b')
  assert.equal(rt.state.requests['b\u0000chat\u0000req-1'], undefined, 'deleted bot requests pruned')
  assert.ok(rt.state.requests['a\u0000chat\u0000req-2'], 'surviving bot requests preserved')
  assert.equal(rt.state.sessionModelSelections.b, undefined, 'deleted bot sessionModelSelections pruned')
  assert.ok(rt.state.sessionModelSelections.a, 'surviving bot sessionModelSelections preserved')
})

test('learning.js caps settled entries to settledMax and cleans bot state on deleteBot', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-learning-')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedState()))
  mkdirSync(join(home, 'learning'), { recursive: true })
  const proposals = {}
  for (let i = 0; i < 6; i += 1) {
    proposals[`p-${i}`] = {
      id: `p-${i}`,
      kind: 'skill',
      action: 'create',
      botId: 'a',
      at: 100 + i,
      name: `skill-${i}`,
      description: `desc ${i}`,
      content: `content ${i}`,
      why: 'test',
    }
  }
  proposals['p-b'] = {
    id: 'p-b',
    kind: 'skill',
    action: 'create',
    botId: 'b',
    at: 200,
    name: 'skill-b',
    description: 'desc b',
    content: 'content b',
    why: 'test',
  }
  writeFileSync(join(home, 'learning', 'state.json'), JSON.stringify({
    pending: { b: ['b'] },
    cursors: { b: 42, a: 10 },
    proposals,
    settled: {},
    declined: [],
    learned: { b: ['skill-b'] },
    agentsPending: {},
  }))
  const { ctx } = minimalCtx()
  const rt = createRuntime(ctx, { home, learningTimes: { settledMax: 3 } })
  t.after(() => ctx.dispose())
  await rt.load()

  for (let i = 0; i < 6; i += 1) {
    await rt.learningEndpoint('learning-answer', { id: `p-${i}`, approve: false })
  }
  const afterCap = JSON.parse(readFileSync(join(home, 'learning', 'state.json'), 'utf8'))
  assert.equal(Object.keys(afterCap.settled).length, 3, 'settled proposals capped at settledMax')

  await rt.deleteBot('b')
  const afterDelete = JSON.parse(readFileSync(join(home, 'learning', 'state.json'), 'utf8'))
  assert.equal(afterDelete.pending.b, undefined)
  assert.equal(afterDelete.learned.b, undefined)
  assert.equal(afterDelete.cursors.b, undefined)
  assert.equal(afterDelete.proposals['p-b'], undefined)
  assert.equal(afterDelete.cursors.a, 10)
})

test('models.js clears in-memory sessionSelections on agent/disposed and truly evicts expired reasoningCache entries', async (t) => {
  let infoCalls = 0
  let selectCalls = 0
  const ctx = fakeContext({
    services: {
      llm: {
        listProviders: () => [{ id: 'p', name: 'P' }],
        listModels: async () => [{ id: 'm1', name: 'M1', inputModalities: ['text', 'image'] }],
        resolveModelInfo: async () => { infoCalls += 1; return { reasoning: { efforts: [{ id: 'high', name: 'High' }] } } },
      },
    },
  })
  ctx.sessionController = {
    selectModel: async ({ provider, model }) => {
      selectCalls += 1
      return { selected: { provider, model } }
    },
  }
  const rt = {
    ctx,
    state: seedState(),
    save: async () => {},
    warn() {},
  }
  installModels(rt)
  t.after(() => ctx.dispose())

  // First selectRoomSession calls selectModel and caches in sessionSelections; second skips it.
  await rt.selectRoomSession('s1')
  assert.equal(selectCalls, 1)
  await rt.selectRoomSession('s1')
  assert.equal(selectCalls, 1, 'in-memory sessionSelections suppresses duplicate selectModel')

  // agent/disposed clears in-memory sessionSelections while keeping durable state.sessionModelSelections.
  for (const fn of ctx.listeners.get('agent/disposed') ?? []) fn({ agent: { id: 's1' } })
  assert.ok(rt.state.sessionModelSelections.s1, 'durable selection kept across agent/disposed')
  await rt.selectRoomSession('s1')
  assert.equal(selectCalls, 2, 'agent/disposed actually cleared in-memory sessionSelections so selectModel runs again')

  rt.forgetSessionModel('s1')
  assert.equal(rt.state.sessionModelSelections.s1, undefined)

  // Verify expired reasoningCache entry is ACTUALLY evicted during sweep:
  // insert p/m1 at t=10_000, sweep via p/m2 at t=25_000, then rewind Date.now to 15_000 (within
  // p/m1's original TTL!). If p/m1 was truly deleted from the Map, resolveModelInfo MUST run again!
  let fakeNow = 10_000
  const origNow = Date.now
  Date.now = () => fakeNow
  t.after(() => { Date.now = origNow })

  await rt.reasoningOf('p/m1')
  await rt.reasoningOf('p/m1')
  assert.equal(infoCalls, 1)

  fakeNow = 25_000
  await rt.reasoningOf('p/m2')
  assert.equal(infoCalls, 2)

  fakeNow = 15_000
  await rt.reasoningOf('p/m1')
  assert.equal(infoCalls, 3, 'p/m1 must have been physically evicted from reasoningCache during p/m2 sweep')
})

test('permissions.js forgetBotPermissions clears populated per-bot request state and requests.js prunes bot requests', async () => {
  const presets = new Map()
  let failResolve = false
  const ctx = fakeContext({
    services: {
      permissionPresets: {
        catalog: () => ({ defaultPreset: 'strict', options: [{ value: 'strict' }, { value: 'standard' }, { value: 'wide' }] }),
        resolve: name => name,
        set: (session, name) => { presets.set(session.id, name) },
      },
    },
  })
  const state = seedState()
  const rt = {
    ctx,
    state,
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
    readOnly: () => undefined,
    chatOf: id => id,
    groupSessionsOf: () => [],
    groupOwners: new Map(),
    taskOwners: new Map(),
    roomOf: () => undefined,
    resolveAgent: async (sessionId) => {
      if (failResolve) throw new Error('agent offline')
      return { id: sessionId, session: { id: sessionId } }
    },
    save: async () => {},
    warn() {},
  }
  installPermissions(rt)
  installRequests(rt)

  // Populate a real tracked permission request for bot 'b' (request.applied = 'standard').
  const botB = state.bots.b
  botB.permission = 'strict'
  await rt.setPermission(botB, 'standard')
  assert.equal(botB.permission, 'standard')
  assert.equal(presets.get('b'), 'standard')

  // Simulate state reset / bot re-creation with permission 'wide', then clear tracked request via forgetBotPermissions('b').
  botB.permission = 'wide'
  rt.forgetBotPermissions('b')

  // A failing setPermission now initializes a fresh request from botB.permission ('wide'), rolling back to 'wide'
  // (NOT stale 'standard' from the forgotten request!).
  failResolve = true
  await assert.rejects(() => rt.setPermission(botB, 'strict'), /agent offline/)
  assert.equal(botB.permission, 'wide', 'forgetBotPermissions cleared stale request.applied so rollback uses current permission')

  // requests.js forgetBotRequests removes deleted bot entries while preserving others.
  const reqA = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'k1', payload: { x: 1 } })
  const reqB = rt.requestIdentity({ caller: 'b', context: 'chat', name: 'k1', payload: { x: 1 } })
  await rt.admitRequest(reqA, async () => 'rA')
  await rt.admitRequest(reqB, async () => 'rB')
  rt.forgetBotRequests('b')
  assert.ok(rt.state.requests[reqA.key])
  assert.equal(rt.state.requests[reqB.key], undefined)
})

test('memory-review.js deleting a Bot while its review is queued does not reject or poison reviewChain', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-review-queue-')
  const { ctx } = minimalCtx()
  let releaseFirst
  const reviewed = []
  const state = seedState({
    bots: {
      a: { id: 'a', name: 'A', role: 'Lead', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'B', role: 'Mid', sessionId: 'b', createdAt: 2 },
      c: { id: 'c', name: 'C', role: 'End', sessionId: 'c', createdAt: 3 },
    },
  })
  const rt = {
    ctx,
    home,
    config: { memoryReview: true, memoryReviewDelayMs: 10, memoryTidy: false },
    state,
    load: async () => {},
    readOnly: () => undefined,
    teamTools: [],
    chatOwners: new Map([['a', 'a'], ['b', 'b'], ['c', 'c']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    sessionOfRoom: room => room.sessionId ?? room.id,
    groupSessionsOf: () => [],
    selfOf: id => id,
    isBotSession: id => ['a', 'b', 'c'].includes(id),
    isMain: id => id === 'a',
    isPrivate: () => false,
    partsOfThread: id => [{ sessionId: id }],
    async *partLines(id) {
      yield { seq: 1, who: 'user', text: `Fact for ${id}` }
    },
    desiredModel: async () => 'deepseek/deepseek-chat',
    defaultModel: async () => 'deepseek/deepseek-chat',
    tagUsage: msgs => msgs,
    assembleLlm: async (req) => {
      const text = JSON.stringify(req)
      const who = text.includes('Fact for a') ? 'a' : text.includes('Fact for b') ? 'b' : 'c'
      reviewed.push(who)
      if (who === 'a') await new Promise(resolve => { releaseFirst = resolve })
      return { finish: { kind: 'stop' }, blocks: () => [{ type: 'text', text: '[]' }] }
    },
    warn() {},
  }
  installMemory(rt)
  t.after(() => ctx.dispose())

  const [onStatus] = ctx.listeners.get('agent/status')
  // Start review for 'a' (blocks inside assembleLlm), then queue 'b' and 'c' behind it.
  onStatus({ agent: { id: 'a' }, status: 'running' })
  onStatus({ agent: { id: 'a' }, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(typeof releaseFirst, 'function', 'review for a is in-flight')

  onStatus({ agent: { id: 'b' }, status: 'running' })
  onStatus({ agent: { id: 'b' }, status: 'idle' })
  onStatus({ agent: { id: 'c' }, status: 'running' })
  onStatus({ agent: { id: 'c' }, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 35))

  // Delete 'b' while its review is queued -> archiveBotMemory calls forgetBotReview -> deletes from reviewQueue without poisoning reviewChain!
  await rt.archiveBotMemory('b')
  releaseFirst()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(reviewed, ['a', 'c'], 'deleted bot b is skipped cleanly and subsequent bot c review still runs')
})

test('btw.js readPart re-attaches byBot after concurrent LRU eviction and preserves answering->failed card on disk', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-btw-detach-')
  const ctx = fakeContext()
  const state = seedState({
    bots: {
      a: { id: 'a', name: 'A', role: 'Lead', sessionId: 'a-cur', createdAt: 1 },
      b: { id: 'b', name: 'B', role: 'Other', sessionId: 'b-cur', createdAt: 2 },
    },
  })
  const rt = {
    ctx,
    home,
    state,
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    load: async () => {},
    save: async () => {},
    warn() {},
  }
  installBtw(rt)
  t.after(() => ctx.dispose())

  // Seed historical part a-old (the bot's ONLY cached part) and a-cur (containing an 'answering' card on disk),
  // plus 55 historical parts on bot 'b' to force LRU eviction of a-old while readPart('a', 'a-cur') is awaiting readFile!
  mkdirSync(join(home, 'btw', 'a'), { recursive: true })
  mkdirSync(join(home, 'btw', 'b'), { recursive: true })
  writeFileSync(join(home, 'btw', 'a', 'a-old.json'), JSON.stringify([{ id: 'old-1', status: 'done', question: 'q', answer: 'a' }]))
  writeFileSync(join(home, 'btw', 'a', 'a-cur.json'), JSON.stringify([{ id: 'cur-1', status: 'answering', question: 'live?' }]))
  for (let i = 0; i < 55; i += 1) {
    writeFileSync(join(home, 'btw', 'b', `b-hist-${i}.json`), JSON.stringify([{ id: `bh-${i}`, status: 'done' }]))
  }

  // Load a-old first, then 49 historical parts on bot 'b' so historicalParts.size === 50 with a-old at the eviction head.
  await rt.btwPartCards('a', 'a-old')
  for (let i = 0; i < 49; i += 1) await rt.btwPartCards('b', `b-hist-${i}`)

  // Fire overflow reads on bot 'b' alongside readPart('a', 'a-cur') so a-old is evicted -> cards.delete('a') mid-read.
  const [curCards] = await Promise.all([
    rt.btwPartCards('a', 'a-cur'),
    ...Array.from({ length: 6 }, (_, i) => rt.btwPartCards('b', `b-hist-${49 + i}`)),
  ])
  assert.equal(curCards.length, 1)
  assert.equal(curCards[0].status, 'failed', 'answering card recovered to failed')

  // Disk file must hold the recovered card (NEVER overwritten with []), and btwView() must still see it!
  const onDisk = JSON.parse(readFileSync(join(home, 'btw', 'a', 'a-cur.json'), 'utf8'))
  assert.equal(onDisk.length, 1, 'detached byBot race must NOT overwrite a-cur.json with []')
  assert.equal(onDisk[0].id, 'cur-1')
  assert.equal(onDisk[0].status, 'failed')
  assert.equal(rt.btwView().a?.length, 1, 'btwView() must still expose current part cards after a-old eviction')
})

test('btw.js btwDelete never self-evicts or writes [] under 51 pinned writingParts and respects dropBot', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-btw-delete-')
  const ctx = fakeContext()
  const state = seedState({
    bots: {
      a: { id: 'a', name: 'A', role: 'Lead', sessionId: 'a-cur', createdAt: 1 },
      b: { id: 'b', name: 'B', role: 'Other', sessionId: 'b-cur', createdAt: 2 },
    },
  })
  const onDeleteHooks = []
  const rt = {
    ctx,
    home,
    state,
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    chatOf: id => state.bots[id]?.sessionId ?? id,
    chatOwners: new Map([['a-cur', 'a'], ['b-cur', 'b']]),
    groupOwners: new Map(),
    pastOwners: new Map([['a-target', { botId: 'a' }], ['b-target', { botId: 'b' }]]),
    onBotDelete: fn => onDeleteHooks.push(fn),
    load: async () => {},
    save: async () => {},
    warn() {},
  }
  installBtw(rt)
  t.after(() => ctx.dispose())

  mkdirSync(join(home, 'btw', 'a'), { recursive: true })
  mkdirSync(join(home, 'btw', 'b'), { recursive: true })
  writeFileSync(join(home, 'btw', 'a', 'a-cur.json'), '[]')
  writeFileSync(join(home, 'btw', 'a', 'a-target.json'), JSON.stringify([
    { id: 'c1', status: 'done', question: 'q1', answer: 'a1' },
    { id: 'c2', status: 'done', question: 'q2', answer: 'a2' },
  ]))
  // 51 historical parts with 'answering' cards so concurrent readPart queues 51 serialized writePart jobs pinned in writingParts.
  for (let i = 0; i < 51; i += 1) {
    writeFileSync(join(home, 'btw', 'a', `a-pin-${i}.json`), JSON.stringify([{ id: `p-${i}`, status: 'answering', question: 'pending' }]))
  }
  const pinnedReads = Promise.all(Array.from({ length: 51 }, (_, i) => rt.btwPartCards('a', `a-pin-${i}`)))
  await new Promise(resolve => setTimeout(resolve, 5))
  // Touching current part sweeps all 51 in-flight a-pin-* entries into historicalParts while writingParts still pins them.
  await rt.btwPartCards('a', 'a-cur')
  const delResult = await rt.btwDelete({ sessionId: 'a-target', cardId: 'c1' })
  await pinnedReads
  assert.deepEqual(delResult, { deleted: true })

  const targetOnDisk = JSON.parse(readFileSync(join(home, 'btw', 'a', 'a-target.json'), 'utf8'))
  assert.equal(targetOnDisk.length, 1, 'surviving card c2 must NOT be wiped to [] by trackPart self-eviction')
  assert.equal(targetOnDisk[0].id, 'c2')

  // Verify dropBot prevents btwDelete / readPart from resurrecting cached parts for a deleted bot.
  writeFileSync(join(home, 'btw', 'b', 'b-target.json'), JSON.stringify([
    { id: 'bc1', status: 'answering', question: 'q' },
    { id: 'bc2', status: 'done', question: 'q2', answer: 'a2' },
  ]))
  const dropPromise = Promise.all(onDeleteHooks.map(fn => fn('b')))
  const readB = rt.btwPartCards('b', 'b-target')
  await Promise.all([dropPromise, readB])
  assert.equal(rt.btwView().b, undefined, 'dropped bot must not appear in btwView')
  const cachedBefore = rt.btwCachedParts()
  await rt.btwPartCards('b', 'b-target')
  assert.equal(rt.btwCachedParts(), cachedBefore, 'dropped bot readPart must not re-populate cards cache')
})

test('mcp-server.js reconcilingKey clears even if readOnly flips before settle() runs', async (t) => {
  const home = tempDir(t, 'ds-bot-perf-mcp-flip-')
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))

  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    version: 1,
    on: true,
    port,
    clients: [{ id: 'c1', name: 'CLI', hash: '0'.repeat(64), bots: ['a'], rooms: [], createdAt: 1 }],
  }))
  let readOnlyReason = 'another host'
  const ctx = fakeContext()
  const rt = {
    ctx,
    home,
    state: seedState(),
    readOnly: () => readOnlyReason,
    load: async () => {},
    save: async () => {},
    warn() {},
  }
  installMcpServer(rt)
  t.after(() => ctx.dispose())

  // Queue reconcile while readOnly === 'another host' (keyA = 1:port:ro), then synchronously flip to writable (keyB)
  // BEFORE settle() executes -> settle() sees keyB and starts the server; reconcilingKey MUST still clear!
  rt.mcpView()
  readOnlyReason = undefined
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(rt.mcpView().status, 'on', 'server started after writable flip')

  // Now flip back to readOnly (keyA): if reconcilingKey stayed wedged on keyA, mcpView() would ignore it and keep serving!
  readOnlyReason = 'another host'
  rt.mcpView()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(rt.mcpView().status, 'off', 'mcp-server must stop cleanly when flipping back to readOnly')
})
