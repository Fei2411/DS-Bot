import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolBatchExecutionError, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { installBotCodeMode } from '../src/host/bot-code-mode.js'
import { fakeContext } from './fake-ctx.js'

const missingExecutors = ['@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-tool-executor-ptc'].filter(name => {
  try {
    import.meta.resolve(name)
    return false
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return true
  }
})
const skip = missingExecutors.length > 0 && `code-mode requires DSH >= 0.2.2-rc.1; host lacks ${missingExecutors.join(', ')}`
const test = (name, fn) => nodeTest(name, { skip }, fn)
const { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } = skip ? {} : await import('@deepseek-ai/dsh-agent-loop-testkit')
const [{ PtcRuntime }, { NativeToolExecutor }, { renderToolsSdk }, { CodeModeExecutor, Config, capResultText, renderCompactSdk }, codeMode] = skip
  ? [{}, {}, {}, {}, {}]
  : await Promise.all([
    import('@deepseek-ai/dsh-ptc-runtime'),
    import('@deepseek-ai/dsh-tool-executor-native'),
    import('@deepseek-ai/dsh-tool-executor-ptc'),
    import('../src/host/code-mode.js'),
    import('../code-mode.js'),
  ])

nodeTest('the main plugin loads without the optional code-mode entry', async () => {
  const plugin = await import('../plugin.js')
  assert.equal(typeof plugin.apply, 'function')
})

nodeTest('the code-mode entry loads or reports its minimum host and missing packages', async () => {
  if (!skip) {
    assert.equal(typeof codeMode.apply, 'function')
    return
  }
  await assert.rejects(import('../code-mode.js'), error => {
    assert.match(error.message, /code-mode requires DSH >= 0\.2\.2-rc\.1/)
    for (const name of missingExecutors) assert.ok(error.message.includes(name))
    assert.notEqual(error.code, 'ERR_MODULE_NOT_FOUND')
    return true
  })
  const plugin = await import('../plugin.js')
  await assert.rejects(plugin.apply({}, { codeMode: { enabled: true } }), /code-mode requires DSH >= 0\.2\.2-rc\.1/)
})

const fixture = JSON.parse(readFileSync(new URL('./fixtures/code-mode-tools.json', import.meta.url)))
const definitions = fixture.map(tool => ({ ...tool, output: { schema: tool.output, render: () => [] } }))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const TestRuntime = PtcRuntime && class TestRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'test'
  resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: 120000 } }
  async run(spec) {
    const logs = []
    const bindings = spec.bindings.find(binding => binding.global === 'tools').functions
    try {
      const value = await new AsyncFunction('tools', 'console', spec.program)(bindings, { log: value => logs.push(String(value)) })
      return { logs, ...(value === undefined ? {} : { value }) }
    } catch (error) {
      return { logs, error: { kind: 'exception', message: error.message } }
    }
  }
}

async function boot(t, config, dependencies) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, dependencies)
  await ctx.plugin(TestRuntime)
  await provideWorkingDirectoryFixture(ctx)
  const executor = new CodeModeExecutor(ctx, config)
  const events = []
  const agent = { ctx, session: { id: 'code-mode-test', header: { cwd: process.cwd() }, append(type, data) { const event = { seq: events.length, type, data }; events.push(event); return event } } }
  const register = (name, execute = async () => 'ok', options = {}) => ctx.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute,
  }), options)
  const run = (calls, options = {}) => executor.execute({ calls, agent, log: { turn: 1, step: 1 }, signal: new AbortController().signal, ...options })
  return { ctx, executor, events, agent, register, run }
}

const call = (name, args = {}, id = name) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const program = code => call('run_code', { code, description: 'Test code mode' })
const content = result => result.results[0].result.content.map(block => block.text ?? '').join('\n')

test('missing PTC runtime starts the team with a logged, user-visible fallback diagnosis', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-code-mode-startup-'))
  const ctx = fakeContext({ services: { tools: {}, systemPrompt: {} } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const logged = t.mock.method(console, 'error', () => {})
  let route
  ctx.connection.fetch.register = definition => {
    if (definition.path === '/api/bot') route = definition
    return () => {}
  }
  // Like Cordis, a child with an unmet required injection never runs apply.
  ctx.plugin = async definition => {
    if (definition.inject.some(name => ctx.get(name) === undefined)) return
    await definition.apply(ctx)
  }
  const entry = await import('../plugin.js')
  await entry.apply(ctx, { home, diagnosticsFile: false, codeMode: { enabled: true } })
  assert.ok(route, 'the Bot team API must start even without ctx.ptcRuntime')
  const response = await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint: 'diagnostics' }),
  }))
  const report = await response.json()
  assert.equal(report.ok, true)
  for (const pattern of [/code mode needs the PTC runtime/, /enable ptc-runtime/, /turn off bot.config.codeMode.enabled/, /normal executor/]) {
    assert.match(report.value.markdown, pattern)
    assert.ok(logged.mock.calls.some(call => call.arguments.some(value => pattern.test(String(value)))))
  }
  assert.equal(ctx.registeredTools.has('run_code'), false)
})

test('the Bot switch scopes code-mode to owned Bot Agents and restores native execution on removal or unload', async t => {
  const { ctx, agent, register } = await boot(t)
  const fallback = ctx.tools.selectExecutor(agent)
  const owned = new Set([agent.session.id])
  const botScope = createScope(ctx, agent)
  agent.ctx = botScope.ctx
  t.after(() => botScope.dispose())
  const outsider = { session: { id: 'ordinary' } }
  const outsiderScope = createScope(ctx, outsider)
  outsider.ctx = outsiderScope.ctx
  t.after(() => outsiderScope.dispose())
  const groupRoom = { session: { id: 'group-room' } }
  const groupRoomScope = createScope(ctx, groupRoom)
  groupRoom.ctx = groupRoomScope.ctx
  t.after(() => groupRoomScope.dispose())
  register('read')
  let rt
  const mount = () => ctx.plugin({
    inject: codeMode.inject,
    apply(child) {
      rt = { ctx: child, isBotSession: id => owned.has(id), roomOf: id => id === 'group-room' ? {} : undefined, onSaved: () => () => {} }
      installBotCodeMode(rt, { ctx: child, plugin: codeMode, config: Config({}) })
    },
  })
  const fiber = mount()
  await fiber
  assert.doesNotThrow(() => rt.scopeCodeMode(undefined))
  rt.scopeCodeMode(outsider)
  assert.equal(ctx.tools.selectExecutor(outsider), fallback)
  assert.equal(ctx.tools.selectExecutor(agent), fallback)
  // Relay-only group room sessions stay on the ordinary native executor.
  rt.scopeCodeMode(groupRoom)
  assert.equal(ctx.tools.selectExecutor(groupRoom), fallback)
  rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof CodeModeExecutor)
  const executor = ctx.tools.selectExecutor(agent)
  rt.scopeCodeMode(agent)
  assert.equal(ctx.tools.selectExecutor(agent), executor)
  assert.equal(ctx.tools.selectExecutor(undefined), fallback)
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(prompt.tools.map(tool => tool.name).sort(), ['read', 'run_code'])
  owned.add('missing-scope')
  assert.throws(() => rt.scopeCodeMode({ ctx, session: { id: 'missing-scope' } }), /Agent registration scope/)
  owned.delete('missing-scope')
  // Losing Bot ownership restores native execution on the same live Session.
  owned.clear()
  await rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof NativeToolExecutor)
  const nativePrompt = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(nativePrompt.tools.map(tool => tool.name), ['read'])
  assert.equal(nativePrompt.sections.some(section => section.name === 'tools:code-mode'), false)
  const afterRemove = await ctx.tools.execute({ calls: [call('read')], agent, signal: new AbortController().signal })
  assert.equal(content(afterRemove), 'ok')
  // Re-acquiring Bot ownership re-mounts CodeModeExecutor on the same live Session.
  owned.add(agent.session.id)
  rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof CodeModeExecutor)
  // Unloading the plugin restores native execution on the same live Session.
  await fiber.dispose()
  assert.ok(ctx.tools.selectExecutor(agent) instanceof NativeToolExecutor)
  const afterUnload = await ctx.tools.execute({ calls: [call('read')], agent, signal: new AbortController().signal })
  assert.equal(content(afterUnload), 'ok')
  assert.equal(rt.scopeCodeMode, undefined)
  // Reloading code-mode cleanly takes over again from the restored native fallback.
  const reloaded = mount()
  await reloaded
  rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof CodeModeExecutor)
  await reloaded.dispose()
  assert.ok(ctx.tools.selectExecutor(agent) instanceof NativeToolExecutor)
})

test('replacement Agents before disposal and delayed old agent/disposed events preserve the newer scope', async t => {
  const { ctx, register } = await boot(t)
  register('read')
  const makeAgent = (id) => {
    const agent = { session: { id } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    t.after(() => scope.dispose())
    return agent
  }
  const oldAgent = makeAgent('bot-1')
  const newAgent = makeAgent('bot-1')
  let rt
  const fiber = ctx.plugin({
    inject: codeMode.inject,
    apply(child) {
      rt = { ctx: child, isBotSession: id => id === 'bot-1', onSaved: () => () => {} }
      installBotCodeMode(rt, { ctx: child, plugin: codeMode, config: Config({}) })
    },
  })
  await fiber
  t.after(() => fiber.dispose())
  rt.scopeCodeMode(oldAgent)
  assert.ok(ctx.tools.selectExecutor(oldAgent) instanceof CodeModeExecutor)
  // A newer Agent for the same Session replaces the old scope without throwing.
  assert.doesNotThrow(() => rt.scopeCodeMode(newAgent))
  const newExec = ctx.tools.selectExecutor(newAgent)
  assert.ok(newExec instanceof CodeModeExecutor)
  // Delayed disposal of the old Agent must not tear down the newer Agent's scope.
  ctx.emit('agent/disposed', { agent: oldAgent })
  assert.equal(ctx.tools.selectExecutor(newAgent), newExec)
  // Disposing the current Agent cleans up its scope without error.
  ctx.emit('agent/disposed', { agent: newAgent })
})

test('releaseEntry catches scope.dispose rejections, logs via rt.warn, and avoids unhandled rejections', async t => {
  const { ctx, register } = await boot(t)
  register('read')
  const agent = { session: { id: 'bot-dispose-fail' } }
  const agentScope = createScope(ctx, agent)
  agent.ctx = agentScope.ctx
  t.after(() => agentScope.dispose())
  const owned = new Set(['bot-dispose-fail'])
  const warnings = []
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  let rt
  let disposeCalled = false
  const plugin = {
    ...codeMode,
    apply(scopeCtx, config, options) {
      codeMode.apply(scopeCtx, config, options)
      const origDispose = scopeCtx.fiber.dispose.bind(scopeCtx.fiber)
      scopeCtx.fiber.dispose = async () => {
        disposeCalled = true
        await origDispose()
        throw new Error('dispose boom')
      }
    },
  }
  const fiber = ctx.plugin({
    inject: codeMode.inject,
    apply(child) {
      rt = {
        ctx: child,
        isBotSession: id => owned.has(id),
        onSaved: () => () => {},
        warn: (...args) => warnings.push(args.join(' ')),
      }
      installBotCodeMode(rt, { ctx: child, plugin, config: Config({}) })
    },
  })
  await fiber
  t.after(() => fiber.dispose())
  rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof CodeModeExecutor)
  // Fire-and-forget release (as in sync / hideBotUnusedTools) must not produce an unhandled rejection.
  owned.clear()
  void rt.scopeCodeMode(agent)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(disposeCalled, true)
  assert.equal(unhandled.length, 0)
  assert.ok(warnings.some(msg => msg.includes('dispose boom')))
  assert.ok(ctx.tools.selectExecutor(agent) instanceof NativeToolExecutor)
})

test('plugin.js mounts code-mode when ptcRuntime arrives asynchronously and keeps the team alive if ptcRuntime disposes', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-code-mode-async-ptc-'))
  const root = new Context()
  t.after(async () => { await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(root)
  await provideWorkingDirectoryFixture(root)
  root.tools.register(defineTool({
    name: 'read', description: 'read', parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => 'ok',
  }))
  const botAgent = { id: 'a', session: { id: 'a', header: { cwd: home }, requestHeader: () => undefined, deriveMessages: () => [] }, status: 'idle', followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } }
  let botScope
  await root.plugin({ inject: ['tools', 'systemPrompt'], apply(loopCtx) { botScope = createScope(loopCtx, botAgent) } })
  botAgent.ctx = botScope.ctx
  t.after(() => botScope.dispose())
  root.agents.register(botAgent)
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  let route
  for (const [svc, impl] of Object.entries({
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => ({ agent: botAgent }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: { get: () => undefined, list: () => [], resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    connection: { fetch: { register: def => { if (def.path === '/api/bot') route = def; return () => {} } } },
  })) {
    if (root.get(svc) === undefined) { root.provide(svc); root.set(svc, impl) }
  }
  const entry = await import('../plugin.js')
  const botFiber = root.plugin(entry, { home, diagnosticsFile: false, github: false, codeMode: { enabled: true } })
  await botFiber
  for (let i = 0; i < 50 && route === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20))
  // Team starts immediately even before ptcRuntime activates.
  assert.ok(route)
  const checkTeam = async () => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))).json()
  assert.equal((await checkTeam()).ok, true)
  assert.ok(root.tools.selectExecutor(botAgent) instanceof NativeToolExecutor)
  // Late async activation of ptcRuntime mounts code-mode automatically.
  const ptcFiber = root.plugin(TestRuntime)
  await ptcFiber
  for (let i = 0; i < 50 && !(root.tools.selectExecutor(botAgent) instanceof CodeModeExecutor); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(root.tools.selectExecutor(botAgent) instanceof CodeModeExecutor)
  // Disposing ptcRuntime unmounts only code-mode and restores native execution without tearing down the team.
  await ptcFiber.dispose()
  assert.equal((await checkTeam()).ok, true, 'Bot team API must remain operational when ptcRuntime disposes')
  assert.ok(root.tools.selectExecutor(botAgent) instanceof NativeToolExecutor)
  const res = await root.tools.execute({ calls: [call('read')], agent: botAgent, signal: new AbortController().signal })
  assert.equal(content(res), 'ok')
})

test('hideBotUnusedTools isolates scopeCodeMode errors without aborting team tool scoping or masks', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-code-mode-isolate-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const ctx = fakeContext({ services: { tools: {}, systemPrompt: {} } })
  t.after(() => ctx.dispose())
  ctx.tools.schemas = () => [{ name: 'ask_user_question' }]
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, list: () => [], resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => ({}), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const { createRuntime } = await import('../index.js')
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false })
  await rt.load()
  const registered = []
  const restricted = []
  const agent = {
    id: 'a',
    session: { id: 'a', header: { cwd: home } },
    ctx: {
      tools: {
        register: def => { registered.push(def.name); return () => {} },
        restrict: filter => { restricted.push(...(filter.deny ?? [])); return () => {} },
      },
      effect: fn => fn?.(),
      on: () => () => {},
    },
  }
  const warned = []
  rt.warn = (...args) => warned.push(args.join(' '))
  rt.scopeCodeMode = () => { throw new Error('scope boom') }
  assert.doesNotThrow(() => rt.hideBotUnusedTools(agent))
  assert.ok(warned.some(msg => msg.includes('scope boom')))
  assert.ok(registered.includes('list_bots'), 'team tools must still be registered')
  assert.ok(restricted.includes('ask_user_question'), 'hidden tools must still be restricted')
})

test('hybrid describes all native tools plus run_code; code-only describes only run_code', async t => {
  const hybrid = await boot(t)
  assert.deepEqual(hybrid.executor.describe(definitions).schemas.map(tool => tool.name), [...fixture.map(tool => tool.name), 'run_code'])
  const only = await boot(t, { mode: 'code-only' })
  assert.deepEqual(only.executor.describe(definitions).schemas.map(tool => tool.name), ['run_code'])
  assert.equal(only.executor.describe([]).schemas[0].name, 'run_code')
  assert.ok(!hybrid.executor.sections.some(section => section.name === 'tools:ptc-only'))
  assert.deepEqual(Config({}), { mode: 'hybrid', maxResultChars: 8000 })
  for (const config of [{ mode: 'wrong' }, { maxResultChars: 0 }, { maxResultChars: 255 }, { maxResultChars: 1.5 }]) assert.throws(() => Config(config))
})

test('hybrid preserves hidden registered names for toolOrder without exposing their schemas', async t => {
  const { ctx, agent, register } = await boot(t, {}, { systemPrompt: { toolOrder: ['restricted', 'inactive', 'run_code', '<unlisted-tools>'] } })
  register('read')
  register('restricted')
  register('inactive', undefined, { when: () => false })
  const scope = createScope(ctx, agent)
  t.after(() => scope.dispose())
  await scope.ctx.plugin(codeMode, { mode: 'hybrid' })
  await scope.ctx.plugin({ inject: ['tools'], apply(ctx) { ctx.tools.restrict({ deny: ['restricted'] }) } })
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: {}, signal: new AbortController().signal })
  t.after(() => toolSet.dispose())
  const assembled = await ctx.systemPrompt.assemble({ scope: agent, toolSet })
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['run_code', 'read'])
})

test('hybrid unions explicit knownNames from both composed executors', async t => {
  const { executor } = await boot(t)
  executor.native.describe = () => ({ schemas: [], knownNames: ['hidden', 'shared'] })
  executor.program.describe = () => ({ schemas: [], knownNames: ['run_code', 'shared'] })
  assert.deepEqual(executor.describe([]).knownNames, ['hidden', 'shared', 'run_code'])
})

test('an unselected hybrid executor does not make run_code a known native tool', async t => {
  const { ctx, agent } = await boot(t, {}, { systemPrompt: { toolOrder: ['run_code', '<unlisted-tools>'] } })
  await assert.rejects(ctx.systemPrompt.assemble({ scope: agent }), /toolOrder lists unregistered tool "run_code"/)
})

test('compact SDK is smaller than stock on the same 23 tool schemas', () => {
  assert.equal(fixture.length, 23)
  const stock = renderToolsSdk(fixture)
  for (const mode of ['hybrid', 'code-only']) {
    const compact = renderCompactSdk(definitions, mode)
    console.log(`SDK bytes (${mode}, same 23 tools): stock=${Buffer.byteLength(stock)} compact=${Buffer.byteLength(compact)}`)
    assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(stock) * 0.65)
    assert.ok(!compact.includes('ToolOutputMap'))
    assert.ok(compact.includes('never raw dumps'))
    assert.equal(compact.includes('description: string'), mode === 'code-only', 'argument types are only needed in code-only')
    assert.equal(compact.includes('"subagent"(args:'), mode === 'code-only')
    assert.equal(compact.includes('"workflow"(args:'), mode === 'code-only')
  }
  const extra = [...definitions, { name: 'mcp__catalog__lookup', description: 'Look up an item', parameters: { type: 'object' } }, { name: 'message_bot', parameters: { type: 'object' } }]
  assert.ok(renderCompactSdk(extra).includes('"mcp__catalog__lookup"'))
  assert.ok(!renderCompactSdk(extra).includes('"message_bot"'))
  assert.ok(renderCompactSdk([], 'hybrid', 'vm-script').includes('final expression'))
  const native = [{ name: 'read', description: 'UNIQUE_DESCRIPTION', parameters: { type: 'object', properties: { UNIQUE_ARGUMENT: { type: 'string' } } } }]
  const hybrid = renderCompactSdk(native)
  assert.ok(hybrid.includes('tools.<name>(args) takes the same arguments as the native tool <name>'))
  assert.ok(hybrid.includes('"read" -> { path: string; lines:'))
  assert.ok(!hybrid.includes('UNIQUE_DESCRIPTION'))
  assert.ok(!hybrid.includes('UNIQUE_ARGUMENT'))
  assert.ok(!hybrid.includes('(args:'))
  assert.ok(!renderCompactSdk([], 'hybrid').includes('"read" ->'))
})

test('code-only SDK preserves whitespace inside enum values, constants and quoted property names', () => {
  const tools = [{
    name: 'mcp__example',
    parameters: {
      type: 'object',
      properties: {
        'two  words': { type: 'string', enum: ['left  right', '  padded   value  '] },
        constant: { type: 'string', const: 'keep   these  spaces' },
        nested: { type: 'array', items: { type: 'string', const: 'nested  literal' } },
      },
      required: ['two  words', 'constant', 'nested'],
      additionalProperties: false,
    },
  }]
  const sdk = renderCompactSdk(tools, 'code-only')
  for (const literal of ['two  words', 'left  right', '  padded   value  ', 'keep   these  spaces', 'nested  literal']) {
    assert.ok(sdk.includes(JSON.stringify(literal)), `preserves ${JSON.stringify(literal)}`)
  }
})

test('both mounted executors assemble only the compact SDK, without stock PTC sections or instructions', async t => {
  for (const mode of ['hybrid', 'code-only']) {
    const { ctx, agent, register } = await boot(t)
    register('read')
    const scope = createScope(ctx, agent)
    t.after(() => scope.dispose())
    await scope.ctx.plugin(codeMode, { mode })
    const assembled = await ctx.systemPrompt.assemble({ scope: agent })
    assert.deepEqual(assembled.sections.filter(section => section.name.startsWith('tools:')).map(section => section.name), ['tools:code-mode'])
    const prompt = renderPrompt(assembled)
    assert.ok(prompt.includes('Program-only SDK'))
    assert.ok(!prompt.replaceAll('`', '').includes('run_code is the only tool you can call directly'))
    assert.ok(!prompt.includes('ToolOutputMap'))
    assert.deepEqual(assembled.tools.map(tool => tool.name).sort(), mode === 'hybrid' ? ['read', 'run_code'] : ['run_code'])
  }
})

test('cap keeps a Unicode head and tail, reports the exact omission and respects the total budget', () => {
  for (const text of ['', 'short', 'a'.repeat(8000)]) assert.equal(capResultText(text, 8000), text)
  for (const text of ['H'.repeat(1500) + 'T'.repeat(1500), '😀'.repeat(1200), 'a'.repeat(10000)]) {
    const capped = capResultText(text, 256)
    assert.equal(Array.from(capped).length, 256)
    const marker = capped.match(/\n\[code-mode: (\d+) characters omitted\.[^\n]+\]\n/)
    assert.ok(marker)
    assert.equal(Number(marker[1]), Array.from(text).length - (Array.from(capped).length - marker[0].length))
    assert.ok(capped.startsWith(Array.from(text)[0]))
    assert.ok(capped.endsWith(Array.from(text).at(-1)))
    assert.ok(!capped.includes('\uFFFD'))
  }
})

test('hybrid native calls and nested program calls use the real policy pipeline and durable logs', async t => {
  const { ctx, register, run, events } = await boot(t)
  const seen = []
  register('read', async () => 'hello')
  ctx.on('tools/pre-execute', async (exec, next) => { seen.push([exec.name, Boolean(exec.parent)]); return next() })
  const native = await run([call('read')])
  assert.equal(content(native), 'hello')
  const nested = await run([program('return await tools.read({})')])
  assert.equal(content(nested), 'hello')
  assert.deepEqual(seen, [['read', false], ['run_code', false], ['read', true]])
  assert.ok(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'read'))
  ctx.tools.guard(exec => exec.name === 'read' ? 'read denied' : undefined)
  assert.match(content(await run([program('return await tools.read({})')])), /read denied/)
})

test('program bindings exclude native-only tools, respect step admission and observe cancellation', async t => {
  const { ctx, agent, register, run } = await boot(t)
  let calls = 0
  register('message_bot', async () => { calls++; return 'sent' })
  register('read', async () => { calls++; return 'read' }, { when: () => false })
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: {}, signal: new AbortController().signal })
  t.after(() => toolSet.dispose())
  assert.match(content(await run([program('return await tools.message_bot({})')])), /not a function/)
  assert.match(content(await run([program('return await tools.read({})')], { toolSet })), /not a function/)
  const cancelled = await run([call('message_bot'), program('return await tools.message_bot({})')], { signal: AbortSignal.abort() })
  assert.ok(cancelled.results.every(item => item.result.isError))
  assert.equal(calls, 0)
})

test('code-only exposes native-only capabilities inside code, but refuses direct calls', async t => {
  const { register, run } = await boot(t, { mode: 'code-only' })
  register('message_bot', async () => 'sent')
  assert.equal(content(await run([program('return await tools.message_bot({})')])), 'sent')
  assert.ok((await run([call('message_bot')])).results[0].result.isError)
})

test('program output and errors are capped before recording while intermediates remain usable', async t => {
  const { register, run, events } = await boot(t, { maxResultChars: 256 })
  register('read', async () => 'x'.repeat(12000))
  assert.equal(content(await run([program('const r = await tools.read({}); return r.length')])), '12000')
  const result = await run([program('return await tools.read({})')])
  assert.equal(Array.from(content(result)).length, 256)
  assert.match(content(result), /characters omitted/)
  const logged = events.filter(event => event.type === 'tool/result').at(-1)
  assert.equal(logged.data.message.content[0].text, content(result))
  const failure = await run([program('throw new Error("x".repeat(12000))')])
  assert.equal(failure.results[0].result.isError, true)
  assert.equal(Array.from(content(failure)).length, 256)
  assert.equal(content(await run([program('')])), '(run_code completed with no output)')
})

test('mixed batches retain native/program/native order and native results are not capped', async t => {
  const { register, run } = await boot(t, { maxResultChars: 256 })
  register('read', async () => 'x'.repeat(400))
  const result = await run([call('read', {}, 'a'), program('return "middle"'), call('read', {}, 'b')])
  assert.deepEqual(result.results.map(item => item.callId), ['a', 'run_code', 'b'])
  assert.equal(result.results[0].result.content[0].text.length, 400)
  assert.equal(result.results[1].result.content[0].text, 'middle')
})

test('pre-dispatch denials and post-policy replacements are capped without bypassing policy', async t => {
  const { ctx, run, events } = await boot(t, { maxResultChars: 256 })
  const unguard = ctx.tools.guard(exec => exec.name === 'run_code' ? 'denied '.repeat(1000) : undefined)
  const denied = await run([program('return "never"')])
  assert.equal(denied.results[0].result.isError, true)
  assert.equal(Array.from(content(denied)).length, 256)
  assert.equal(events.at(-1).data.message.content[0].text, content(denied))
  unguard()
  ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'run_code' ? { kind: 'accept', value: { logs: ['safe '.repeat(1000)] } } : next())
  const replaced = await run([program('return "original"')])
  assert.match(content(replaced), /^safe /)
  assert.ok(!content(replaced).includes('original'))
  assert.equal(Array.from(content(replaced)).length, 256)
  assert.deepEqual(await run([]), { results: [], additionalContexts: [], concluded: false })
})

test('execute enforces RangeError, unwraps ToolBatchExecutionError without double-wrapping, and leaves no dangling tool/call', async t => {
  const { executor, events, run } = await boot(t)
  // Invalid maxParallelToolCalls throws bare RangeError before any tool/call is logged.
  await assert.rejects(run([program('return 1')], { maxParallelToolCalls: 0 }), error => error instanceof RangeError)
  await assert.rejects(run([], { maxParallelToolCalls: -1 }), error => error instanceof RangeError)
  assert.equal(events.length, 0, 'pre-validation failure must not leave a dangling tool/call')

  // Sub-executor ToolBatchExecutionError is single-wrapped with the original root cause.
  const rootCause = new Error('scheduler exploded')
  executor.program.execute = async () => {
    throw new ToolBatchExecutionError(rootCause, { results: [], additionalContexts: [], concluded: false })
  }
  await assert.rejects(run([program('return 1')]), error => {
    assert.ok(error instanceof ToolBatchExecutionError)
    assert.equal(error.cause, rootCause, 'must unwrap inner ToolBatchExecutionError.cause instead of double-wrapping')
    return true
  })

  // Unexpected non-ToolBatchExecutionError with zero progress preserves error type and closes its tool/call.
  const beforeCalls = events.filter(event => event.type === 'tool/call').length
  const beforeResults = events.filter(event => event.type === 'tool/result').length
  const unexpected = new TypeError('unexpected pre-dispatch failure')
  executor.program.execute = async () => { throw unexpected }
  await assert.rejects(run([program('return 1')]), error => error === unexpected)
  const addedCalls = events.filter(event => event.type === 'tool/call').length - beforeCalls
  const addedResults = events.filter(event => event.type === 'tool/result').length - beforeResults
  assert.equal(addedCalls, addedResults, 'every appended tool/call must have a matching tool/result')
})

test('capResultText clamps tiny budgets, withoutDescriptions cleans prefixItems/$defs, and code-only filters hidden tools', async t => {
  assert.equal(capResultText('a'.repeat(100), 20).length, 20)
  assert.equal(capResultText('abc', 0), '')
  const nestedSchema = [{
    name: 'mcp__tuple',
    parameters: {
      type: 'object',
      $defs: { item: { type: 'string', description: 'SECRET_DEF_DESC' } },
      properties: { pair: { type: 'array', prefixItems: [{ type: 'string', description: 'SECRET_PREFIX_DESC' }] } },
    },
  }]
  const sdk = renderCompactSdk(nestedSchema, 'code-only')
  assert.ok(!sdk.includes('SECRET_DEF_DESC'))
  assert.ok(!sdk.includes('SECRET_PREFIX_DESC'))

  // code-only with filterTools omits hidden tools from both SDK text and program bindings.
  const { ctx, agent, register } = await boot(t)
  register('read', async () => 'ok')
  register('subagent', async () => 'hidden')
  register('create_bot', async () => 'admin-only')
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  const hidden = new Set(['subagent', 'create_bot'])
  await scope.ctx.plugin({
    inject: codeMode.inject,
    apply(child) {
      codeMode.apply(child, { mode: 'code-only' }, { filterTools: tools => tools.filter(tool => !hidden.has(tool.name)) })
    },
  })
  const assembled = await ctx.systemPrompt.assemble({ scope: agent })
  const section = assembled.sections.find(s => s.name === 'tools:code-mode')
  assert.ok(section.text.includes('"read"'))
  assert.ok(!section.text.includes('"subagent"'))
  assert.ok(!section.text.includes('"create_bot"'))
  const denied = await ctx.tools.execute({
    calls: [program('return await tools.subagent({})')],
    agent,
    signal: new AbortController().signal,
  })
  assert.match(content(denied), /not a function/)
})

test('real @deepseek-ai/dsh-ptc-runtime-node executes programs and honors privacy.js isolation', async t => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-real-ptc-')))
  const dshHome = join(rootDir, 'dsh')
  const botHome = join(dshHome, 'bot')
  const teamDir = join(botHome, 'workspace')
  const diaryDir = join(rootDir, 'diary')
  for (const dir of [teamDir, diaryDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(diaryDir, 'secret.txt'), 'top-secret-diary-entry')
  const privateId = 'd1a40000-1111-4222-8333-444444444444'
  writeFileSync(join(botHome, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, workDir: teamDir },
      [privateId]: { id: privateId, name: 'Diary', role: 'Notes', sessionId: privateId, createdAt: 2, workDir: diaryDir, private: true },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const [{ default: FsLocal }, { default: SubprocessLocal }, { default: SandboxLocal }, { default: SandboxPolicy }, { default: NodePtcRuntime }, privacy] = await Promise.all([
    import('@deepseek-ai/dsh-fs-local'),
    import('@deepseek-ai/dsh-subprocess-local'),
    import('@deepseek-ai/dsh-sandbox-local'),
    import('@deepseek-ai/dsh-sandbox-policy'),
    import('@deepseek-ai/dsh-ptc-runtime-node'),
    import('../src/host/privacy.js'),
  ])
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5 })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FsLocal)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(SandboxLocal)
  await ctx.plugin(SandboxPolicy, { defaultMode: 'workspace-write' })
  await ctx.plugin(NodePtcRuntime, { executionMode: 'per-call', timeoutMs: 30000 })
  await provideWorkingDirectoryFixture(ctx, { initial: teamDir })
  const state = JSON.parse(readFileSync(join(botHome, 'state.json'), 'utf8'))
  const rt = {
    ctx,
    dshHome,
    home: botHome,
    statePath: join(botHome, 'state.json'),
    state,
    botOf: id => state.bots[id],
    selfOf: id => (id in state.bots ? id : undefined),
    chatOf: id => state.bots[id]?.sessionId ?? id,
    groupSessionsOf: () => [],
    teamFolder: () => teamDir,
    defaultTeamFolder: () => teamDir,
    workDirOf: ({ botId }) => state.bots[botId]?.workDir ?? teamDir,
    sessionFolder: session => session?.header?.cwd ?? teamDir,
    realBeyond: async path => { try { return realpathSync.native(path) } catch { return path } },
    findBot: ref => Object.values(state.bots).find(bot => bot.id === ref || bot.name.toLowerCase() === ref.toLowerCase()),
    resolveAgent: async () => undefined,
  }
  privacy.install(rt)
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: async args => `content:${args.file_path}`,
  }))
  const executor = new CodeModeExecutor(ctx, { mode: 'hybrid' })
  const session = ctx.sessions.create('a', { meta: { cwd: teamDir } })
  const agent = { id: 'a', ctx, session }
  // 1. Real NodePtcRuntime runs TypeScript program and calls nested tool cleanly.
  const ok = await executor.execute({
    calls: [program("const text = await tools.read({ file_path: 'open.txt' }); return text.toUpperCase()")],
    agent,
    log: { turn: 1, step: 1 },
    signal: new AbortController().signal,
  })
  assert.equal(ok.results[0].result.isError, false, content(ok))
  assert.match(content(ok), /^CONTENT:OPEN\.TXT(?:\s+File sandbox enforcement is partial on this host\.)?$/)

  // 2. Direct node:fs read of a private Bot's file inside run_code is blocked by privacy.js before execution.
  const blockedDirect = await executor.execute({
    calls: [program(`const fs = await import('node:fs'); return fs.readFileSync(${JSON.stringify(join(diaryDir, 'secret.txt'))}, 'utf8')`)],
    agent,
    log: { turn: 1, step: 2 },
    signal: new AbortController().signal,
  })
  assert.equal(blockedDirect.results[0].result.isError, true)
  assert.match(content(blockedDirect), /private Bot/)
  assert.ok(!content(blockedDirect).includes('top-secret-diary-entry'))

  // 3. Nested tools.read of a private Bot's file via obfuscated path is still blocked by privacy.js on nested dispatch.
  const blockedNested = await executor.execute({
    calls: [program(`const p = [${JSON.stringify(diaryDir.slice(0, -3))}, ${JSON.stringify(diaryDir.slice(-3))}, '/secret.txt'].join(''); return await tools.read({ file_path: p })`)],
    agent,
    log: { turn: 1, step: 3 },
    signal: new AbortController().signal,
  })
  assert.equal(blockedNested.results[0].result.isError, true)
  assert.match(content(blockedNested), /private Bot/)
})
