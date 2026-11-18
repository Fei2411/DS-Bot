import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { CodeModeExecutor, Config, capResultText, renderCompactSdk } from '../src/host/code-mode.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/code-mode-tools.json', import.meta.url)))
const definitions = fixture.map(tool => ({ ...tool, output: { schema: tool.output, render: () => [] } }))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

class TestRuntime extends PtcRuntime {
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

async function boot(t, config) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
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

test('compact SDK is smaller than stock on the same 23 tool schemas', () => {
  assert.equal(fixture.length, 23)
  const stock = renderToolsSdk(fixture)
  for (const mode of ['hybrid', 'code-only']) {
    const compact = renderCompactSdk(definitions, mode)
    console.log(`SDK bytes (${mode}, same 23 tools): stock=${Buffer.byteLength(stock)} compact=${Buffer.byteLength(compact)}`)
    assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(stock) * 0.65)
    assert.ok(!compact.includes('ToolOutputMap'))
    assert.ok(compact.includes('never raw dumps'))
    assert.ok(compact.includes('description: string'), 'a parameter named description is not removed')
    assert.equal(compact.includes('"subagent"(args:'), mode === 'code-only')
    assert.equal(compact.includes('"workflow"(args:'), mode === 'code-only')
  }
  const extra = [...definitions, { name: 'mcp__catalog__lookup', description: 'Look up an item', parameters: { type: 'object' } }, { name: 'message_bot', parameters: { type: 'object' } }]
  assert.ok(renderCompactSdk(extra).includes('"mcp__catalog__lookup"'))
  assert.ok(!renderCompactSdk(extra).includes('"message_bot"'))
  assert.ok(renderCompactSdk([], 'hybrid', 'vm-script').includes('final expression'))
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
