// Contract tests for local-agent model catalog parsing (#2145). The recorded
// fixture is what agy acp 1.5.17 actually answers: session/new with the full
// catalog, the set_config_option(model) reply, the config_option_update notices
// it emits (config only, no models key), and the matching `agy models` stdout.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { AcpEngine, modelsFromProbe, parseModelListing } from '../src/host/local-agents/acp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/recorded/antigravity-models-1.5.17.json', import.meta.url)), 'utf8'))
const FIXTURE_ACP = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function collect(stream) {
  const out = { text: '', thinking: '', calls: [], finish: undefined }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'reasoning-delta') out.thinking += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.calls.push(chunk.block)
    else if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}

test('parseModelListing reads the recorded `agy models` output into all 27 concrete entries', () => {
  const entries = parseModelListing(fixture.modelsOutput)
  assert.equal(entries.length, 27)
  assert.deepEqual(entries.slice(0, 4).map(entry => entry.modelId), [
    'gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low',
  ])
  assert.equal(entries.find(entry => entry.modelId === 'gemini-4-carbon-low')?.name, 'Gemini 4 Carbon (Low)')
  assert.ok(entries.some(entry => entry.modelId === 'gpt-oss-120b-medium'))
  assert.ok(entries.some(entry => entry.modelId === 'gemini-pro-orchestrator'))
})

test('parseModelListing drops headers, progress lines and noise', () => {
  const entries = parseModelListing([
    'Fetching available models...',
    'Available models',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'claude-opus-5-5-high  Claude Opus 5.5 (High)',
    'plainword',
    'some sentence about models',
    'gpt-oss-120b-medium',
    'gemini-4-neon-high\tduplicate id',
    '',
  ].join('\n'))
  assert.deepEqual(entries, [
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    { modelId: 'gpt-oss-120b-medium', name: 'gpt-oss-120b-medium' },
  ])
})

test('the full recorded session/new parses into per-model thinking levels, carbon and hydrogen included', () => {
  const models = modelsFromProbe(fixture.sessionNew)
  assert.deepEqual(models.map(model => model.id), [
    'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen',
    'gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon',
    'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b-medium',
  ])
  const byId = Object.fromEntries(models.map(model => [model.id, model]))
  // #2145 symptom 2: carbon and hydrogen lost their levels while neon/argon kept theirs.
  assert.deepEqual(byId['gemini-4-neon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(byId['gemini-4-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['gemini-4-hydrogen'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(byId['gemini-4-argon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['gemini-3.8-flash'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['claude-opus-5-5'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['claude-sonnet-5-5'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  // Models the catalog lists once, without variants, stay untiered — including
  // gpt-oss-120b-medium, whose id ends in a level word it is not a variant of.
  assert.equal(byId['gpt-oss-120b-medium'].reasoning, undefined)
  assert.equal(byId['gemini-pro-orchestrator'].reasoning, undefined)
  assert.equal(byId['gemini-pro-orchestrator-neon'].reasoning, undefined)
  assert.equal(models.some(model => model.id === 'gpt-oss-120b'), false, 'no synthetic base for a level-word id')
})

test('every advertised thinking level maps back to the exact concrete variant id the CLI takes', () => {
  // agy accepts both the bare base id and the concrete `<base>-<level>` variant as
  // session/set_config_option model values (verified against agy acp 1.5.17). The
  // parse must only derive levels whose variant id exists in the evidence, so a
  // picked level always names a model the CLI knows.
  const evidence = new Set((fixture.sessionNew.models?.availableModels ?? []).map(entry => entry.modelId))
  for (const model of modelsFromProbe(fixture.sessionNew)) {
    for (const effort of model.reasoning?.efforts ?? []) {
      assert.ok(evidence.has(`${model.id}-${effort.id}`), `${model.id}-${effort.id} must be a real variant id`)
    }
  }
})

test('variant parsing keeps canonical level order however the catalog orders its entries', () => {
  // The recorded catalog lists carbon as medium, high, low; the picker order is canonical.
  const models = modelsFromProbe(fixture.sessionNew)
  const carbon = models.find(model => model.id === 'gemini-4-carbon')
  assert.deepEqual(carbon.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
})

test('a config_option_update notice parsed against remembered variants does not flatten the levels', () => {
  // #2145 mechanism: agy's notice after a model switch carries the config (thought
  // levels narrowed to the switched model's three) but no models key. Parsed alone
  // it would drop every per-model tier set; parsed against the remembered variants
  // (what the engine now does) the per-model levels survive exactly.
  const update = fixture.configOptionUpdates[0]
  assert.equal(update.models, undefined, 'the recorded notice carries no models key')
  const narrowed = update.configOptions.find(option => (option.category ?? option.id) === 'thought_level')
  assert.deepEqual((narrowed?.options ?? []).map(entry => entry.value), ['low', 'medium', 'high'])

  const variants = fixture.sessionNew.models
  const models = modelsFromProbe({ configOptions: update.configOptions, models: variants })
  const byId = Object.fromEntries(models.map(model => [model.id, model]))
  assert.deepEqual(byId['gemini-4-neon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(byId['gemini-4-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['gpt-oss-120b-medium'].reasoning, undefined)
  assert.equal(models.length, 11)

  // The regression this guards against: parsing the notice bare flattens every
  // model to the switched model's three levels — neon loses xhigh, and even the
  // untiered gpt-oss-120b-medium picks up levels the CLI never offered it.
  const bare = modelsFromProbe({ configOptions: update.configOptions })
  const bareById = Object.fromEntries(bare.map(model => [model.id, model]))
  assert.deepEqual(bareById['gemini-4-neon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'], 'bare parse wrongly flattens neon')
  assert.deepEqual(bareById['gpt-oss-120b-medium'].reasoning?.efforts?.map(effort => effort.id), ['low', 'medium', 'high'], 'bare parse wrongly tiers an untiered model')
})

test('a degraded session/new reply merged with the `agy models` listing yields the full catalog', () => {
  // #2145 symptom 1: the probe answer was a partial snapshot — two bases in the
  // config and only their variants — and the picker showed a tierless subset.
  // Merging the CLI's own listing restores the complete catalog: the missing
  // bases come back through their variant families, tiers included.
  const degraded = JSON.parse(JSON.stringify(fixture.sessionNew))
  const modelOption = degraded.configOptions.find(option => (option.category ?? option.id) === 'model')
  modelOption.options = modelOption.options.filter(entry => ['gemini-4-neon', 'gemini-4-argon'].includes(entry.value))
  degraded.models.availableModels = degraded.models.availableModels.filter(entry => entry.modelId.startsWith('gemini-4-neon') || entry.modelId.startsWith('gemini-4-argon'))

  // Control: the degraded reply alone shows exactly the reported symptom.
  const bare = modelsFromProbe(degraded)
  assert.deepEqual(bare.map(model => model.id), ['gemini-4-neon', 'gemini-4-argon'])
  assert.ok(bare.every(model => (model.reasoning?.efforts?.length ?? 0) > 0), 'the variant families present still tier')

  const listing = parseModelListing(fixture.modelsOutput)
  const seen = new Set(degraded.models.availableModels.map(entry => entry.modelId))
  const merged = {
    ...degraded,
    models: {
      ...degraded.models,
      availableModels: [...degraded.models.availableModels, ...listing.filter(entry => !seen.has(entry.modelId))],
    },
  }
  const models = modelsFromProbe(merged)
  const byId = Object.fromEntries(models.map(model => [model.id, model]))
  assert.deepEqual(byId['gemini-4-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['gemini-4-hydrogen'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(byId['gemini-3.8-flash'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(byId['claude-opus-5-5'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.ok(byId['gemini-pro-orchestrator'] !== undefined)
  assert.equal(byId['gpt-oss-120b-medium'].reasoning, undefined)
  assert.equal(byId['gemini-4-carbon'].name, 'Gemini 4 Carbon')
  assert.equal(models.filter(model => model.id === 'gpt-oss-120b-medium').length, 1, 'no duplicate concrete entry')
})

test('an empty-models reply merged with the listing still yields the full catalog', () => {
  const degraded = JSON.parse(JSON.stringify(fixture.sessionNew))
  delete degraded.models
  const merged = { ...degraded, models: { availableModels: parseModelListing(fixture.modelsOutput) } }
  const models = modelsFromProbe(merged)
  assert.equal(models.length, 11)
  const byId = Object.fromEntries(models.map(model => [model.id, model]))
  assert.deepEqual(byId['gemini-4-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.equal(byId['gemini-pro-orchestrator'].reasoning, undefined)
})

test('agents without a variant map keep the flat thinking-level fallback', () => {
  const models = modelsFromProbe({
    configOptions: [
      { id: 'model', category: 'model', options: [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }] },
      { id: 'thought_level', category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }] },
    ],
    models: { availableModels: [{ modelId: 'alpha', name: 'Alpha' }, { modelId: 'beta', name: 'Beta' }] },
  })
  assert.deepEqual(models.map(model => model.id), ['alpha', 'beta'])
  assert.deepEqual(models[0].reasoning.efforts.map(effort => effort.id), ['low', 'high'])
})

test('legacy agents without a model config list their entries verbatim', () => {
  const models = modelsFromProbe({
    models: { availableModels: [{ modelId: 'legacy-std', name: 'Legacy Standard' }, { modelId: 'legacy-fast', name: 'Legacy Fast' }] },
  })
  assert.deepEqual(models.map(model => model.id), ['legacy-std', 'legacy-fast'])
  assert.ok(models.every(model => model.reasoning === undefined))
})

// --- integration: the fake CLI serving agy's shapes ----------------------------

function makeAgyAdapter({ args = [], cwdPerProcess = false, records = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-agy-cwd-'))
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'agyfake', name: 'Agy Fake', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new AcpEngine(route, {
      ...spec,
      command: process.execPath,
      args: [FIXTURE_ACP, '--agy-catalog', ...args],
      modelsArgs: spec.modelsArgs === null ? undefined : [FIXTURE_ACP, 'models'],
      ...(cwdPerProcess ? { cwdPerProcess: true } : {}),
    }, { findExecutable: path => path }),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => 'workspace-write',
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [],
  })
  return adapter
}

for (const cwdPerProcess of [false, true]) {
  test(`a degraded ACP probe merged with the CLI listing restores the full catalog (cwdPerProcess=${cwdPerProcess})`, async (t) => {
    const adapter = makeAgyAdapter({ args: ['--degraded-catalog'], cwdPerProcess })
    t.after(() => adapter.dispose())

    const catalog = await adapter.probeModels('local-acp-agyfake')
    const ids = catalog.map(model => model.id)
    assert.deepEqual(ids, ['default', 'fake-large', 'fake-small', 'fake-carbon', 'fake-gpt-medium'])
    const byId = Object.fromEntries(catalog.map(model => [model.id, model]))
    assert.deepEqual(byId['fake-large'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
    assert.deepEqual(byId['fake-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
    assert.equal(byId['fake-carbon'].name, 'Fake Carbon')
    assert.equal(byId['fake-small'].reasoning, undefined)
    assert.equal(byId['fake-gpt-medium'].reasoning, undefined)
  })
}

test('without the listing command the same degraded probe still shows only the subset (control)', async (t) => {
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'agyfake', name: 'Agy Fake', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new AcpEngine(route, {
      ...spec,
      command: process.execPath,
      args: [FIXTURE_ACP, '--agy-catalog', '--degraded-catalog'],
    }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-agy-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-agy-probe-')),
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  const catalog = await adapter.probeModels('local-acp-agyfake')
  assert.deepEqual(catalog.map(model => model.id), ['default', 'fake-large', 'fake-small'], 'documents what the listing merge repairs')
})

test('a model switch notice does not flatten the cached catalog levels', async (t) => {
  const adapter = makeAgyAdapter({ args: ['--emit-config-update'] })
  t.after(() => adapter.dispose())

  const probed = await adapter.probeModels('local-acp-agyfake')
  assert.deepEqual(probed.find(model => model.id === 'fake-large')?.reasoning?.efforts?.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])

  const turn = await collect(adapter.stream({
    provider: 'local-acp-agyfake',
    model: 'fake-carbon',
    sessionId: 's1',
    messages: [user('m1', 'hello')],
    tools: [],
    signal: AbortSignal.timeout(30_000),
  }))
  assert.match(turn.text, /ok:/)

  // Let the config_option_update notice land; the catalog must keep per-model
  // levels instead of flattening to the switched model's three.
  await new Promise(resolve => setTimeout(resolve, 150))
  const catalog = await adapter.listModels('local-acp-agyfake')
  const byId = Object.fromEntries(catalog.map(model => [model.id, model]))
  assert.deepEqual(byId['fake-large'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(byId['fake-carbon'].reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.equal(byId['fake-gpt-medium'].reasoning, undefined)
})
