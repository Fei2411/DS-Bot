import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { install } from '../src/host/local-agents/index.js'
import { ENGINES } from '../src/host/local-agents/engines.js'
import { refreshSearchDirs } from '../src/host/local-agents/discover.js'
import { fakeContext } from './fake-ctx.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { install as modelsInstall } from '../src/host/models.js'

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const makeEngine = (kind, args = []) => new (kind === 'acp' ? AcpEngine : CodexEngine)(
  'local-test', { name: 'Test CLI', command: process.execPath, args: [fixture('fake-local-startup.mjs'), ...args] },
  { findExecutable: path => path },
)

async function localHost(t) {
  await refreshSearchDirs()
  for (const [route, spec] of Object.entries(ENGINES)) {
    ENGINES[route] = { ...spec, command: process.execPath, commands: [process.execPath] }
    t.after(() => { ENGINES[route] = spec })
  }
  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  const warnings = []
  const rt = { ctx, state: { bots: {}, localAgents: { custom: [], sessions: {} } }, warn: (...args) => warnings.push(args), save: async () => {} }
  t.after(async () => { await ctx.dispose(); await owner.fiber.dispose() })
  return { llm, rt, warnings }
}

test('startup skips a taken CLI route and registers the other routes (#1390)', async (t) => {
  const { llm, rt, warnings } = await localHost(t)
  const other = new LlmAdapter()
  other.providerInfo = id => ({ id, name: 'Other adapter' })
  llm.registerAdapter(['local-opencode'], other)
  assert.doesNotThrow(() => install(rt))
  await setImmediate()
  assert.equal(llm.listProviders().find(p => p.id === 'local-opencode').name, 'Other adapter')
  assert.ok(llm.listProviders().some(p => p.id === 'local-codex-cli'))
  assert.ok(warnings.some(args => args.join(' ').includes('local-opencode')))
})

test('OpenCode provider and detected local OpenCode CLI coexist (#1390)', async (t) => {
  const { llm, rt } = await localHost(t)
  llm.registerAdapter(['opencode'], new LlmAdapter())
  install(rt)
  await setImmediate()
  assert.ok(llm.listProviders().some(p => p.id === 'opencode'))
  assert.ok(llm.listProviders().some(p => p.id === 'local-opencode'))
})

test('replace skips a newly taken custom route and retains its own routes (#1390)', async (t) => {
  const { llm, rt } = await localHost(t)
  install(rt)
  await setImmediate()
  llm.registerAdapter(['local-acp-taken'], new LlmAdapter())
  rt.state.localAgents.custom.push({ id: 'taken', name: 'Taken', command: process.execPath, args: [] }, { id: 'remove', name: 'Remove', command: process.execPath, args: [] })
  await assert.doesNotReject(rt.localAgentsEndpoint('local-agent-remove', { id: 'remove' }))
  assert.ok(llm.listProviders().some(p => p.id === 'local-codex-cli'))
  assert.equal(llm.listProviders().find(p => p.id === 'local-acp-taken').name, 'local-acp-taken')
})

test('startup with every detected route taken leaves the other adapter intact (#1390)', async (t) => {
  const { llm, rt } = await localHost(t)
  llm.registerAdapter(Object.keys(ENGINES), new LlmAdapter())
  install(rt)
  await setImmediate()
  assert.deepEqual(llm.listProviders().map(p => p.id), Object.keys(ENGINES))
  assert.ok(llm.listProviders().every(p => p.name === p.id))
})

test('initial scan failures are logged rather than unhandled (#1390)', async (t) => {
  const { llm, rt, warnings } = await localHost(t)
  t.mock.method(llm, 'registerAdapter', () => { throw new Error('registry unavailable') })
  install(rt)
  await setImmediate()
  assert.ok(warnings.some(args => args.join(' ').includes('registry unavailable')))
})

test('synchronous route registration failures do not abort installation (#1390)', async (t) => {
  const { llm, rt, warnings } = await localHost(t)
  rt.state.bots.saved = { model: 'local-acp-saved/default' }
  t.mock.method(llm, 'registerAdapter', () => { throw new Error('registry unavailable') })
  assert.doesNotThrow(() => install(rt))
  await setImmediate()
  assert.ok(warnings.some(args => args.join(' ').includes('registry unavailable')))
  assert.equal(typeof rt.localAgentsEndpoint, 'function')
})

test('taken routes cannot be selected or probed as local agents (#1390)', async (t) => {
  const { llm, rt } = await localHost(t)
  const other = new LlmAdapter()
  other.listModels = async provider => [{ provider, id: 'other-model', name: 'Other model' }]
  llm.registerAdapter(['local-opencode', 'local-acp-taken'], other)
  rt.state.localAgents.custom.push({ id: 'taken', name: 'Taken', command: process.execPath, args: [] })
  const probes = []
  t.mock.method(LocalAgentAdapter.prototype, 'probeModels', async route => {
    probes.push(route)
    return [{ provider: route, id: 'cli-model', name: 'CLI model' }]
  })
  install(rt)
  modelsInstall(rt)
  await setImmediate()
  await t.test('model probes skip routes owned by another adapter', async () => {
    assert.deepEqual(await rt.localAgentModels('local-opencode'), [])
    assert.deepEqual(await rt.localAgentModels('local-acp-taken'), [])
    assert.deepEqual(probes, [])
    assert.equal((await rt.localAgentModels('local-codex-cli'))[0].id, 'cli-model')
  })
  await t.test('resolution rejects both the other adapter and CLI models', async () => {
    await assert.rejects(rt.resolveModel('local-opencode/other-model'), /not available/)
    await assert.rejects(rt.resolveModel('local-acp-taken/cli-model'), /not available/)
    assert.equal(await rt.resolveModel('local-codex-cli/default'), 'local-codex-cli/default')
    const catalog = await rt.catalog()
    assert.ok(!catalog.some(entry => entry.provider === 'local-opencode'))
    assert.ok(!catalog.some(entry => entry.provider === 'local-acp-taken'))
  })
  await t.test('local agent lists hide taken built-ins but retain custom agents for management', async () => {
    const list = await rt.localAgentsEndpoint('local-agents', {})
    assert.ok(!list.detected.some(entry => entry.route === 'local-opencode'))
    assert.equal(list.custom[0].id, 'taken')
    assert.equal(list.custom[0].available, false)
    assert.ok(list.detected.some(entry => entry.route === 'local-codex-cli'))
    await rt.localAgentsEndpoint('local-agent-update', { id: 'taken', name: 'Renamed' })
    assert.equal(rt.state.localAgents.custom[0].name, 'Renamed')
    await rt.localAgentsEndpoint('local-agent-remove', { id: 'taken' })
    assert.deepEqual(rt.state.localAgents.custom, [])
  })
})

for (const kind of ['acp', 'codex']) {
  test(`${kind}: concurrent opens wait for the same initialization (#1222)`, async (t) => {
    const engine = makeEngine(kind)
    t.after(() => engine.close())
    const [first, second] = await Promise.all([
      engine.open('one', { cwd: process.cwd() }),
      engine.open('two', { cwd: process.cwd() }),
    ])
    assert.notEqual(first, second)
    assert.ok(kind === 'acp' ? first.acpSessionId : first.threadId)
    assert.ok(kind === 'acp' ? second.acpSessionId : second.threadId)
  })

  test(`${kind}: rejected initialization clears the process and allows a retry (#1222)`, async (t) => {
    const engine = makeEngine(kind, ['--reject-initialize'])
    t.after(() => engine.close())
    await assert.rejects(engine.ensure(), /initialization refused/)
    assert.equal(engine.peer, undefined)
    assert.equal(engine.child, undefined)
    engine.engine.args.pop()
    await engine.ensure()
    assert.ok(engine.peer)
  })

  test(`${kind}: closing during initialization does not clear a replacement process (#1222)`, async (t) => {
    const engine = makeEngine(kind)
    t.after(() => engine.close())
    const starting = engine.ensure()
    const refused = assert.rejects(starting)
    const child = engine.child
    const exited = once(child, 'exit')
    await engine.close()
    await refused
    const peer = await engine.ensure()
    await exited
    assert.equal(engine.peer, peer)
    assert.notEqual(engine.child, child)
  })
}
