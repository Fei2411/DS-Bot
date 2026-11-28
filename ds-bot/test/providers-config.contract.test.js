import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config as DeepSeekConfig, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { install as installModels } from '../src/host/models.js'
import { install as installProviders } from '../src/host/providers.js'
import { isComputerOnlyEndpoint, isTeamEndpoint } from '../src/shared/remote-endpoints.js'
import { BROWSER_ALLOWED } from '../src/shared/browser-endpoints.js'

const REAL_DEEPSEEK_SCHEMA = DeepSeekConfig.toJSON()
const REAL_PI_AI_SCHEMA = PiAiConfig.toJSON()

function createRealSchemaHost({
  keys = {},
  sources = {},
  masked = {},
  readOnlyKeys = [],
  settingsWritable = true,
  windowReadOnly = undefined,
  deepseekUser = {},
  deepseekBase = {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text'] },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 128000, maxTokens: 65536, inputModalities: ['text', 'image'], imagePixelBudget: 'low', imageMaxBytes: 1048576 },
    ],
  },
  piUser = {},
  piBase = {},
  catalog = {
    openai: {
      models: ['gpt-5', 'gpt-4o'],
      defaultBaseURL: 'https://api.openai.com/v1',
      nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
    },
    anthropic: {
      models: ['claude-sonnet-4-5'],
      defaultBaseURL: 'https://api.anthropic.com',
      nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: false },
    },
    moonshotai: {
      models: ['kimi-k2.5'],
      defaultBaseURL: 'https://api.moonshot.ai/v1',
      nativeAuth: { env: ['MOONSHOT_API_KEY'], oauth: false },
    },
  },
} = {}) {
  const store = { ...keys }
  const writes = []
  const revisions = { 'llm-deepseek': 1, 'llm-pi-ai': 1 }
  let dsUser = structuredClone(deepseekUser)
  let piAiUser = structuredClone(piUser)

  const deepseekEffective = () => ({ ...structuredClone(deepseekBase), ...structuredClone(dsUser) })
  const piAiEffective = () => {
    const merged = structuredClone(piBase.providers ?? {})
    for (const [id, profile] of Object.entries(piAiUser.providers ?? {})) {
      merged[id] = { ...merged[id], ...structuredClone(profile) }
    }
    return { providers: merged }
  }
  const routes = () => Object.keys(piAiEffective().providers)

  const applyOps = (target, ops) => {
    const next = structuredClone(target)
    for (const op of ops) {
      if (op.op === 'set') {
        const parent = op.path.slice(0, -1).reduce((cur, key) => {
          if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {}
          return cur[key]
        }, next)
        parent[op.path.at(-1)] = structuredClone(op.value)
      } else if (op.op === 'unset') {
        const parent = op.path.slice(0, -1).reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), next)
        if (parent && typeof parent === 'object') delete parent[op.path.at(-1)]
      }
    }
    return next
  }

  const services = {
    settings: {
      writable: settingsWritable,
      describe: () => [
        {
          ns: 'llm-deepseek',
          revision: revisions['llm-deepseek'],
          schema: REAL_DEEPSEEK_SCHEMA,
          value: deepseekEffective(),
          user: structuredClone(dsUser),
          base: structuredClone(deepseekBase),
        },
        {
          ns: 'llm-pi-ai',
          revision: revisions['llm-pi-ai'],
          schema: REAL_PI_AI_SCHEMA,
          value: piAiEffective(),
          user: structuredClone(piAiUser),
          base: structuredClone(piBase),
        },
      ],
      mutate: async (ns, ops, expected) => {
        if (!settingsWritable) throw new Error('Settings are read-only')
        if (expected !== undefined && expected !== revisions[ns]) {
          throw Object.assign(new Error(`settings namespace "${ns}" changed`), {
            code: 'SETTINGS_CONFLICT',
            expected,
            actual: revisions[ns],
          })
        }
        if (ns === 'llm-deepseek') {
          const nextUser = applyOps(dsUser, ops)
          const effective = { ...structuredClone(deepseekBase), ...nextUser }
          // Validate with real DSH DeepSeek schema + resolver!
          const { apiKeyEnv: _ignored, ...adapterFields } = effective
          DeepSeekConfig(adapterFields)
          resolveAdapterOptions(adapterFields)
          dsUser = nextUser
        } else if (ns === 'llm-pi-ai') {
          const nextUser = applyOps(piAiUser, ops)
          const merged = structuredClone(piBase.providers ?? {})
          for (const [id, profile] of Object.entries(nextUser.providers ?? {})) {
            merged[id] = { ...merged[id], ...structuredClone(profile) }
          }
          // Validate with real DSH pi-ai schema!
          PiAiConfig({ providers: merged })
          piAiUser = nextUser
        } else {
          throw new Error(`Unknown namespace ${ns}`)
        }
        writes.push([ns, ops])
        revisions[ns] += 1
      },
    },
    credentials: {
      describe: async (ref) => {
        const configured = ref in store
        return {
          configured,
          ...(configured ? { source: sources[ref] ?? 'file' } : {}),
          writable: !readOnlyKeys.includes(ref),
          ...(configured && masked[ref] ? { masked: masked[ref] } : configured ? { masked: 'sk-***' } : {}),
        }
      },
      set: async (ref, value) => {
        writes.push(['cred:set', ref])
        store[ref] = value
        sources[ref] = 'file'
      },
      unset: async (ref) => {
        writes.push(['cred:unset', ref])
        delete store[ref]
        delete sources[ref]
      },
    },
  }

  const ctx = {
    on: () => () => {},
    get: name => services[name],
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        ...routes().map(id => ({ id, name: piAiEffective().providers[id]?.displayName ?? id })),
      ],
      listModels: async (id) => {
        if (id === 'deepseek-official') {
          return (deepseekEffective().models ?? []).map(m => ({ id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities }))
        }
        const profile = piAiEffective().providers[id]
        return profile?.models ?? (catalog[id]?.models ?? []).map(m => ({ id: m, name: m }))
      },
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        ...Object.entries(catalog).map(([id, meta]) => ({
          provider: id,
          displayName: id,
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', id],
          declared: false,
          defaultBaseURL: meta.defaultBaseURL,
          nativeAuth: meta.nativeAuth,
        })),
        ...routes().filter(id => !(id in catalog)).map(id => ({
          provider: id,
          displayName: piAiEffective().providers[id]?.displayName ?? id,
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', id],
          declared: true,
        })),
      ],
      discoverModels: async (_ns, request) => {
        if (request.provider && catalog[request.provider]) {
          return catalog[request.provider].models.map(id => ({ id, name: id, contextWindow: 128000, inputModalities: ['text', 'image'] }))
        }
        return [
          { id: 'discovered-1', name: 'Discovered One', contextWindow: 256000, maxTokens: 16384, inputModalities: ['text', 'image'] },
          { id: 'discovered-2', name: 'Discovered Two' },
        ]
      },
    },
  }

  const rt = {
    ctx,
    state: { bots: {} },
    readOnly: () => windowReadOnly,
  }
  installModels(rt)
  installProviders(rt)
  return { rt, ctx, store, writes, revisions, deepseekEffective, piAiEffective }
}

test('providersView exposes real DSH schema metadata: writable, reasoningLevels, retryDefaults, editableModels, credentialChecks', async () => {
  const { rt } = createRealSchemaHost({
    keys: { DEEPSEEK_API_KEY: 'sk-ds', OPENAI_API_KEY: 'sk-env' },
    sources: { DEEPSEEK_API_KEY: 'file', OPENAI_API_KEY: 'env' },
    masked: { DEEPSEEK_API_KEY: 'sk-***ds' },
    readOnlyKeys: ['OPENAI_API_KEY'],
  })
  const view = await rt.providersView()
  assert.equal(view.writable, true)
  assert.ok(Array.isArray(view.reasoningLevels) && view.reasoningLevels.includes('low') && view.reasoningLevels.includes('high') && view.reasoningLevels.includes('off'))

  const ds = view.providers.find(p => p.id === 'deepseek-official')
  assert.ok(ds)
  assert.equal(ds.family, 'deepseek')
  assert.equal(ds.editable, true)
  assert.equal(ds.modelsOverridden, false)
  assert.equal(ds.editableModels.length, 2)
  assert.equal(ds.key.source, 'file')
  assert.equal(ds.key.masked, 'sk-***ds')
  assert.ok(ds.retryDefaults && Array.isArray(ds.retryDefaults.modes) && ds.retryDefaults.modes.includes('normal') && ds.retryDefaults.modes.includes('always'))

  const openai = view.addable.find(p => p.id === 'openai')
  assert.ok(openai)
  assert.equal(openai.defaultBaseURL, 'https://api.openai.com/v1')
  assert.deepEqual(openai.nativeAuth, { env: ['OPENAI_API_KEY'], oauth: false })
  assert.equal(openai.credentialChecks?.OPENAI_API_KEY?.configured, true)
  assert.equal(openai.credentialChecks?.OPENAI_API_KEY?.source, 'env')
})

test('saveProviderConfig edits DeepSeek models (ID/name/order/capacities/inputModalities/reset) and passes real DeepSeekConfig validation', async () => {
  const { rt, deepseekEffective } = createRealSchemaHost({ keys: { DEEPSEEK_API_KEY: 'sk-ds' } })
  const before = await rt.providersView()
  const ds = before.providers.find(p => p.id === 'deepseek-official')

  const afterEdit = await rt.saveProviderConfig({
    provider: 'deepseek-official',
    revision: ds.revision,
    baseURL: 'https://proxy.example.com/anthropic',
    models: [
      { id: 'deepseek-reasoner', name: 'Reasoner Custom', contextWindow: 256000, maxTokens: 32768, inputModalities: ['text'], imagePixelBudget: 'low', imageMaxBytes: 1048576 },
      { id: 'deepseek-chat', name: 'Chat Custom', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] },
      { id: 'deepseek-extra', name: 'Extra', contextWindow: 64000 },
    ],
  })
  const updatedDs = afterEdit.providers.find(p => p.id === 'deepseek-official')
  assert.equal(updatedDs.modelsOverridden, true)
  assert.equal(updatedDs.baseURL, 'https://proxy.example.com/anthropic')
  assert.deepEqual(updatedDs.editableModels.map(m => m.id), ['deepseek-reasoner', 'deepseek-chat', 'deepseek-extra'])
  // Removing 'image' from inputModalities must clear imagePixelBudget & imageMaxBytes so DeepSeekConfig accepts it.
  assert.equal(deepseekEffective().models[0].imagePixelBudget, undefined)
  assert.equal(deepseekEffective().models[0].imageMaxBytes, undefined)

  // Reset models restores inherited catalog via unset.
  const afterReset = await rt.saveProviderConfig({
    provider: 'deepseek-official',
    revision: updatedDs.revision,
    resetModels: true,
    baseURL: null,
  })
  const resetDs = afterReset.providers.find(p => p.id === 'deepseek-official')
  assert.equal(resetDs.modelsOverridden, false)
  assert.equal(resetDs.baseURL, undefined)
  assert.deepEqual(resetDs.editableModels.map(m => m.id), ['deepseek-chat', 'deepseek-reasoner'])
})

test('saveProviderConfig edits custom pi-ai route (models, reasoningEfforts, input, capacities, retryPolicy) and validates with real PiAiConfig', async () => {
  const { rt, piAiEffective } = createRealSchemaHost({
    piUser: {
      providers: {
        'my-gw': {
          displayName: 'My Gateway',
          api: 'openai-completions',
          baseURL: 'https://gw.example/v1',
          apiKeyEnv: 'MY_GW_API_KEY',
          models: [{ id: 'm1', name: 'Model 1', contextWindow: 64000, input: ['text'] }],
        },
      },
    },
    keys: { MY_GW_API_KEY: 'sk-gw' },
  })
  const view = await rt.providersView()
  const gw = view.providers.find(p => p.id === 'my-gw')
  assert.equal(gw.family, 'pi-ai')
  assert.equal(gw.editable, true)

  const retryPolicy = {
    mode: 'normal',
    maxRetries: 3,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT'],
    backoff: { initialDelayMs: 250, maxDelayMs: 4000, jitterRatio: 0.2 },
  }
  assert.doesNotThrow(() => resolveRetryPolicy(retryPolicy, 'test'))

  const next = await rt.saveProviderConfig({
    provider: 'my-gw',
    revision: gw.revision,
    displayName: 'Renamed Gateway',
    baseURL: 'https://gw2.example/v1',
    api: 'openai-responses',
    retryPolicy,
    models: [
      {
        id: 'm2',
        name: 'Model 2',
        contextWindow: 256000,
        maxTokens: 16384,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high-custom' },
      },
      {
        id: 'm1',
        name: 'Model 1 Renamed',
        contextWindow: 128000,
        input: ['text'],
      },
    ],
  })
  const saved = next.providers.find(p => p.id === 'my-gw')
  assert.equal(saved.name, 'Renamed Gateway')
  assert.equal(saved.api, 'openai-responses')
  assert.deepEqual(saved.editableModels.map(m => m.id), ['m2', 'm1'])
  assert.deepEqual(saved.editableModels[0].reasoningEfforts, { off: null, low: 'low', high: 'high-custom' })
  assert.deepEqual(saved.retryPolicy, retryPolicy)
  assert.equal(piAiEffective().providers['my-gw'].baseURL, 'https://gw2.example/v1')
})

test('saveProviderConfig enforces stale revision conflict and read-only protections', async () => {
  const { rt } = createRealSchemaHost({
    piUser: {
      providers: {
        'my-gw': { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'm1' }] },
      },
    },
  })
  await assert.rejects(
    rt.saveProviderConfig({ provider: 'my-gw', revision: 999, baseURL: 'https://other.example/v1' }),
    error => error.code === 'bot/stale',
  )

  const readOnlyProfile = createRealSchemaHost({ settingsWritable: false })
  const roView = await readOnlyProfile.rt.providersView()
  assert.equal(roView.writable, false)
  await assert.rejects(
    readOnlyProfile.rt.saveProviderConfig({ provider: 'deepseek-official', baseURL: 'https://x.example' }),
    /read-only/i,
  )

  const readOnlyWindow = createRealSchemaHost({ windowReadOnly: 'Another window holds the lock' })
  const rwView = await readOnlyWindow.rt.providersView()
  assert.equal(rwView.writable, false)
  await assert.rejects(
    readOnlyWindow.rt.saveProviderConfig({ provider: 'deepseek-official', baseURL: 'https://x.example' }),
    error => error.code === 'bot/read-only',
  )
})

test('provider-config-save is strictly computer-only (denied to phone, browser, API, MCP)', () => {
  assert.equal(isComputerOnlyEndpoint('provider-config-save'), true)
  assert.equal(isTeamEndpoint('provider-config-save'), false)
  assert.equal(BROWSER_ALLOWED.has('provider-config-save'), false)
})

test('addProviderConfig adds catalog and custom providers with full models and retryPolicy validated by real PiAiConfig', async () => {
  const { rt, piAiEffective } = createRealSchemaHost({
    keys: { OPENAI_API_KEY: 'sk-env-secret' },
    sources: { OPENAI_API_KEY: 'env' },
    readOnlyKeys: ['OPENAI_API_KEY'],
  })
  // Catalog provider with env-detected key, custom baseURL, models override, and retryPolicy
  const afterOpenAI = await rt.addProviderConfig({
    provider: 'openai',
    baseURL: 'https://openai-proxy.example/v1',
    models: [{ id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, maxTokens: 32000, input: ['text', 'image'] }],
    retryPolicy: {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT'],
      backoff: { initialDelayMs: 500, maxDelayMs: 15000, jitterRatio: 0.2 },
    },
  })
  const openai = afterOpenAI.providers.find(p => p.id === 'openai')
  assert.ok(openai)
  assert.equal(openai.baseURL, 'https://openai-proxy.example/v1')
  assert.equal(openai.key.source, 'env')
  assert.equal(openai.editableModels[0].id, 'gpt-5')
  assert.equal(openai.retryPolicy.maxRetries, 4)

  // Custom provider with full metadata & retryPolicy
  const afterCustom = await rt.addProviderConfig({
    custom: true,
    provider: 'acme-gw',
    name: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    key: 'sk-acme-123',
    models: [
      {
        id: 'acme-1',
        name: 'Acme One',
        contextWindow: 256000,
        maxTokens: 16384,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high' },
      },
    ],
    retryPolicy: {
      mode: 'always',
      backoff: { initialDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0.1 },
    },
  })
  const acme = afterCustom.providers.find(p => p.id === 'acme-gw')
  assert.ok(acme)
  assert.equal(acme.name, 'Acme Gateway')
  assert.equal(acme.retryPolicy.mode, 'always')
  assert.deepEqual(acme.editableModels[0].reasoningEfforts, { off: null, low: 'low', high: 'high' })
  assert.ok(piAiEffective().providers['acme-gw'])

  // Invalid retryPolicy rejected (initialDelayMs > maxDelayMs)
  await assert.rejects(
    rt.saveProviderConfig({
      provider: 'acme-gw',
      retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 5000, maxDelayMs: 1000 } },
    }),
    /initialDelayMs|maxDelayMs|delay/i,
  )
})

test('discoverProviderModels probes existing, catalog, and draft endpoints with unsaved baseURL/api/key', async () => {
  const seen = []
  const host = createRealSchemaHost({
    piUser: {
      providers: {
        'my-gw': { api: 'openai-completions', baseURL: 'https://saved.example/v1', models: [{ id: 'm1' }] },
      },
    },
  })
  host.ctx.llm.discoverModels = async (ns, req) => {
    seen.push({ ns, req })
    return [
      { id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, inputModalities: ['text', 'image'] },
      { id: 'm2', name: 'Model 2' },
    ]
  }
  const res1 = await host.rt.discoverProviderModels({
    provider: 'my-gw',
    baseURL: 'https://draft.example/v1',
    api: 'openai-responses',
    key: 'sk-draft-probe',
  })
  assert.equal(res1.length, 2)
  assert.equal(seen[0].ns, 'llm-pi-ai')
  assert.equal(seen[0].req.provider, 'my-gw')
  assert.equal(seen[0].req.baseURL, 'https://draft.example/v1')
  assert.equal(seen[0].req.api, 'openai-responses')
  assert.equal(seen[0].req.apiKey, 'sk-draft-probe')

  // Catalog provider not yet added
  const res2 = await host.rt.discoverProviderModels({
    provider: 'openai',
    key: 'sk-openai-draft',
  })
  assert.equal(res2.length, 2)
  assert.equal(seen[1].req.provider, 'openai')
  assert.equal(seen[1].req.apiKey, 'sk-openai-draft')
})

test('provider-config-add and provider-config-discover are strictly computer-only', () => {
  for (const ep of ['provider-config-add', 'provider-config-discover']) {
    assert.equal(isComputerOnlyEndpoint(ep), true)
    assert.equal(isTeamEndpoint(ep), false)
    assert.equal(BROWSER_ALLOWED.has(ep), false)
  }
})

test('keyless editable providers still expose a writable key editor and attach apiKeyEnv when a key is saved later', async () => {
  const { rt, store, piAiEffective } = createRealSchemaHost({
    piUser: {
      providers: {
        moonshotai: {},
        'local-custom': { api: 'openai-completions', baseURL: 'https://local.example/v1', models: [{ id: 'm1' }] },
        'gemini-custom': { api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta', models: [{ id: 'gemini-2.5-pro' }] },
      },
    },
    catalog: {
      moonshotai: { models: ['kimi-k2.5'], defaultBaseURL: 'https://api.moonshot.ai/v1', nativeAuth: { env: ['MOONSHOT_API_KEY'], oauth: false } },
      'oauth-only': { models: ['o1'], defaultBaseURL: 'https://oauth.example/v1', nativeAuth: { env: [], oauth: true } },
    },
  })
  // Add oauth-only route to piUser too via addProvider
  await rt.addProvider({ provider: 'oauth-only' })
  const view = await rt.providersView()
  const moonshot = view.providers.find(p => p.id === 'moonshotai')
  const custom = view.providers.find(p => p.id === 'local-custom')
  const gemini = view.providers.find(p => p.id === 'gemini-custom')
  const oauthOnly = view.providers.find(p => p.id === 'oauth-only')

  assert.equal(moonshot.key?.writable, true, 'keyless catalog provider exposes writable key')
  assert.equal(moonshot.key?.optional, true)
  assert.equal(custom.key?.writable, true, 'keyless custom provider exposes writable key')
  assert.equal(oauthOnly.key, null, 'oauth-only nativeAuth provider keeps key: null')
  assert.equal(gemini.refreshable, true, 'google-generative-ai route is listable/refreshable')

  // Saving a key later onto the keyless catalog provider attaches apiKeyEnv and stores secret
  await rt.setProviderKey('moonshotai', 'sk-moonshot-later')
  assert.equal(store.MOONSHOTAI_API_KEY, 'sk-moonshot-later')
  assert.equal(piAiEffective().providers.moonshotai.apiKeyEnv, 'MOONSHOTAI_API_KEY')
  const after = await rt.providersView()
  assert.equal(after.providers.find(p => p.id === 'moonshotai').key?.configured, true)
  assert.equal(after.providers.find(p => p.id === 'moonshotai').key?.optional, undefined)
})

test('providersView hydrates inherited defaultMode for hand-edited retryPolicy omitting mode, and addProviderConfig keyless catalog route allows adding key later', async () => {
  const handEdited = createRealSchemaHost({
    piUser: {
      providers: {
        moonshotai: { retryPolicy: { maxRetries: 3 } },
      },
    },
  })
  const view = await handEdited.rt.providersView()
  const moonshot = view.providers.find(p => p.id === 'moonshotai')
  assert.ok(moonshot)
  assert.equal(moonshot.retryPolicy?.mode, 'normal', 'hand-edited retryPolicy without mode hydrates inherited defaultMode')
  assert.equal(moonshot.retryPolicy?.maxRetries, 3)

  // Saving the hydrated retryPolicy heals the stored route so PiAiConfig accepts it
  const healed = await handEdited.rt.saveProviderConfig({
    provider: 'moonshotai',
    revision: moonshot.revision,
    retryPolicy: moonshot.retryPolicy,
  })
  assert.equal(healed.providers.find(p => p.id === 'moonshotai')?.retryPolicy?.mode, 'normal')

  const fresh = createRealSchemaHost()
  const afterAdd = await fresh.rt.addProviderConfig({ provider: 'anthropic' })
  const anthropic = afterAdd.providers.find(p => p.id === 'anthropic')
  assert.equal(anthropic?.key?.writable, true)
  assert.equal(anthropic?.key?.optional, true)
  await fresh.rt.setProviderKey('anthropic', 'sk-ant-later')
  assert.equal(fresh.store.ANTHROPIC_API_KEY, 'sk-ant-later')
})
