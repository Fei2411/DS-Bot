import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
const [{ PtcRuntime }, { renderToolsSdk }, { CodeModeExecutor, Config, capResultText, renderCompactSdk }, codeMode] = skip
  ? [{}, {}, {}, {}]
  : await Promise.all([
    import('@deepseek-ai/dsh-ptc-runtime'),
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

test('the Bot switch scopes code-mode to owned Agents and lifts it on removal or unload', async t => {
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
  const group = { session: { id: 'group' } }
  const groupScope = createScope(ctx, group)
  group.ctx = groupScope.ctx
  t.after(() => groupScope.dispose())
  register('read')
  let rt
  const fiber = ctx.plugin({
    inject: codeMode.inject,
    apply(child) {
      rt = { ctx: child, isBotSession: id => owned.has(id), roomOf: id => id === 'group' ? {} : undefined, onSaved: () => () => {} }
      installBotCodeMode(rt, { plugin: codeMode, config: Config({}) })
    },
  })
  await fiber
  assert.doesNotThrow(() => rt.scopeCodeMode(undefined))
  rt.scopeCodeMode(outsider)
  assert.equal(ctx.tools.selectExecutor(outsider), fallback)
  assert.equal(ctx.tools.selectExecutor(agent), fallback)
  rt.scopeCodeMode(agent)
  assert.ok(ctx.tools.selectExecutor(agent) instanceof CodeModeExecutor)
  const executor = ctx.tools.selectExecutor(agent)
  rt.scopeCodeMode(agent)
  assert.equal(ctx.tools.selectExecutor(agent), executor)
  assert.equal(ctx.tools.selectExecutor(undefined), fallback)
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(prompt.tools.map(tool => tool.name).sort(), ['read', 'run_code'])
  rt.scopeCodeMode(group)
  assert.ok(ctx.tools.selectExecutor(group) instanceof CodeModeExecutor)
  owned.add('missing-scope')
  assert.throws(() => rt.scopeCodeMode({ ctx, session: { id: 'missing-scope' } }), /Agent registration scope/)
  owned.clear()
  await rt.scopeCodeMode(agent)
  assert.throws(() => ctx.tools.selectExecutor(agent), /executor/i)
  owned.add(agent.session.id)
  rt.scopeCodeMode(agent)
  await fiber.dispose()
  assert.throws(() => ctx.tools.selectExecutor(agent), /executor/i)
  assert.throws(() => ctx.tools.selectExecutor(group), /executor/i)
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
