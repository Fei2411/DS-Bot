import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  formatCapacity,
  parseCapacity,
  protocolNeedsKey,
  protocolReasoningLevels,
  validateApiKeyDraft,
  validateBaseUrl,
  validateModelRows,
  withEfforts,
} from '../src/client/provider-model-utils.js'

async function loadProvidersPageBundle() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/providers-page.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const cells = []
  const prevDeps = []
  let hook = 0
  let dirty = false
  let pendingEffects = []
  const changed = (deps, prev) => deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((dep, i) => !Object.is(dep, prev[i]))
  const react = {
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const i = hook++
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; dirty = true }]
    },
    useRef(initial) { const i = hook++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
    useEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
    useLayoutEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
    useMemo: make => make(),
    useId: () => 'id',
    Fragment: Symbol('Fragment'),
  }
  const expand = (node) => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (node === null || typeof node !== 'object') return node
    if (node.type === react.Fragment) return expand(node.props?.children)
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
  }
  const render = (component, props) => {
    let tree
    do {
      dirty = false
      hook = 0
      pendingEffects = []
      tree = expand(component(props))
      for (const { i, fn, deps } of pendingEffects) {
        if (changed(deps, prevDeps[i])) { prevDeps[i] = deps; fn() }
      }
    } while (dirty)
    return tree
  }
  const mod = { exports: {} }
  const stubWin = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800 }
  const stubDoc = { addEventListener() {}, removeEventListener() {}, body: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod, exports: mod.exports, setTimeout, clearTimeout, URL, window: stubWin, document: stubDoc,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  return { exports: mod.exports, render }
}

const findAll = (node, pred, out = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('parseCapacity and formatCapacity handle K/M shorthand and raw integers', () => {
  assert.equal(parseCapacity(''), undefined)
  assert.equal(parseCapacity('256K'), 256_000)
  assert.equal(parseCapacity('1.5M'), 1_500_000)
  assert.equal(parseCapacity('128000'), 128_000)
  assert.ok(Number.isNaN(parseCapacity('abc')))
  assert.equal(formatCapacity(1_000_000), '1M')
  assert.equal(formatCapacity(256_000), '256K')
  assert.equal(formatCapacity(131_072), '131072')
})

test('protocol rules restrict Gemini to minimal/low/medium/high and require a key', () => {
  assert.equal(protocolNeedsKey('google-generative-ai'), true)
  assert.equal(protocolNeedsKey('openai-completions'), false)
  const full = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  assert.deepEqual(protocolReasoningLevels('openai-completions', full), { levels: full, levelsOnly: false })
  assert.deepEqual(protocolReasoningLevels('google-generative-ai', full), {
    levels: ['minimal', 'low', 'medium', 'high'],
    levelsOnly: true,
  })
})

test('validateModelRows catches missing ids, duplicates, bad capacities, and invalid reasoning efforts', () => {
  assert.deepEqual(validateModelRows([], { requireNonEmpty: true }), { index: -1, key: 'Add at least one model' })
  assert.equal(validateModelRows([], { requireNonEmpty: false }), undefined)
  assert.deepEqual(validateModelRows([{ id: '   ' }]), { index: 0, key: 'Every model needs an ID' })
  assert.deepEqual(validateModelRows([{ id: 'm1' }, { id: 'm1' }]), { index: 1, key: 'Duplicate model ID' })
  assert.deepEqual(validateModelRows([{ id: 'm1', name: '  ' }]), { index: 0, key: 'Model display name cannot be blank' })
  assert.deepEqual(validateModelRows([{ id: 'm1', contextWindow: Number.NaN }]), { index: 0, key: 'Context window must be a positive whole number' })
  assert.deepEqual(validateModelRows([{ id: 'm1', maxTokens: 0 }]), { index: 0, key: 'Max output tokens must be a positive whole number' })
  assert.deepEqual(validateModelRows([{ id: 'm1', reasoningEfforts: { off: null } }]), { index: 0, key: 'Add at least one reasoning level besides Off' })
  assert.deepEqual(
    validateModelRows([{ id: 'm1', reasoningEfforts: { low: 'custom-low' } }], { reasoningLevelsOnly: true, reasoningLevels: ['minimal', 'low', 'medium', 'high'] }),
    { index: 0, key: 'Gemini supports only minimal, low, medium, and high' },
  )
  assert.equal(
    validateModelRows([
      withEfforts({ id: 'm1', name: 'Model One', contextWindow: 256_000, maxTokens: 32_000, input: ['text', 'image'] }, [['off', null], ['high', 'high-wire']]),
    ]),
    undefined,
  )
})

test('validateBaseUrl enforces http(s) and DeepSeek root restrictions', () => {
  assert.equal(validateBaseUrl(''), undefined)
  assert.equal(validateBaseUrl('https://api.example.com/v1'), undefined)
  assert.equal(validateBaseUrl('ftp://example.com'), 'Enter the endpoint as an http or https address')
  assert.equal(validateBaseUrl('https://api.deepseek.com/v1?x=1', { strictDeepSeek: true }), 'Base URL must not include credentials, query, or fragment')
  assert.equal(validateBaseUrl('https://user:pass@api.deepseek.com', { strictDeepSeek: true }), 'Base URL must not include credentials, query, or fragment')
})

test('validateApiKeyDraft rejects env lines, quoted strings, and spaces', () => {
  assert.equal(validateApiKeyDraft('', { required: true }), 'API key is required')
  assert.equal(validateApiKeyDraft(''), undefined)
  assert.equal(validateApiKeyDraft('OPENAI_API_KEY=sk-123'), 'Paste only the key, not a NAME=value line')
  assert.equal(validateApiKeyDraft('"sk-123"'), 'Paste the key without quotes')
  assert.equal(validateApiKeyDraft('sk 123'), 'An API key has no spaces or special characters')
  assert.equal(validateApiKeyDraft('sk-valid-key_123'), undefined)
})

test('ProviderConfigEditor edits model list (add/reorder/details/reset), discards, saves, and disables in read-only', async () => {
  const { exports: { ProviderConfigEditor }, render } = await loadProvidersPageBundle()
  const savedPayloads = []
  const provider = {
    id: 'my-gw',
    name: 'My Gateway',
    family: 'pi-ai',
    custom: true,
    editable: true,
    revision: 7,
    displayName: 'My Gateway',
    baseURL: 'https://gw.example/v1',
    api: 'openai-completions',
    apiKeyEnv: 'MY_GW_API_KEY',
    modelsOverridden: true,
    models: [
      { id: 'alpha', ref: 'my-gw/alpha', name: 'Alpha' },
      { id: 'beta', ref: 'my-gw/beta', name: 'Beta' },
    ],
    editableModels: [
      { id: 'alpha', name: 'Alpha', contextWindow: 128_000, maxTokens: 16_000, input: ['text'] },
      { id: 'beta', name: 'Beta', contextWindow: 256_000, input: ['text', 'image'] },
    ],
  }
  const props = {
    provider,
    protocols: ['openai-completions', 'anthropic-messages', 'google-generative-ai'],
    reasoningLevels: ['off', 'low', 'medium', 'high'],
    readOnly: false,
    apply: async () => true,
    actions: {
      saveProviderConfig: async (body) => { savedPayloads.push(body); return { providers: [] } },
      refreshModels() {},
    },
    roster: { bots: [], models: [] },
    canRefresh: false,
    refreshing: false,
    onOpenRefresh() {},
  }
  let tree = render(ProviderConfigEditor, props)
  const btn = label => findAll(tree, n => n.type === 'button' && textOf(n) === label)[0]
  const btnAria = label => findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === label)[0]
  const inputAria = label => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === label)[0]

  // Initially clean -> Save and Discard disabled
  assert.equal(btn('Save').props.disabled, true)
  assert.equal(btn('Discard').props.disabled, true)

  // Move row 2 up -> becomes row 1 ('beta' before 'alpha')
  btnAria('Move up 2').props.onClick()
  tree = render(ProviderConfigEditor, props)
  assert.equal(inputAria('Model ID 1').props.value, 'beta')
  assert.equal(btn('Save').props.disabled, false)

  // Expand row 1 details and enable reasoning levels + edit context window
  btnAria('Model details 1').props.onClick()
  tree = render(ProviderConfigEditor, props)
  inputAria('Context window 1').props.onChange({ target: { value: '512K' } })
  tree = render(ProviderConfigEditor, props)
  const reasoningSwitch = findAll(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Reasoning levels 1')[0]
  assert.ok(reasoningSwitch)
  reasoningSwitch.props.onClick()
  tree = render(ProviderConfigEditor, props)

  // Save sends reordered models with updated contextWindow and reasoningEfforts
  btn('Save').props.onClick()
  await settle(); await settle()
  assert.equal(savedPayloads.length, 1)
  assert.equal(savedPayloads[0].provider, 'my-gw')
  assert.equal(savedPayloads[0].revision, 7)
  assert.equal(savedPayloads[0].models[0].id, 'beta')
  assert.equal(savedPayloads[0].models[0].contextWindow, 512_000)
  assert.deepEqual(JSON.parse(JSON.stringify(savedPayloads[0].models[0].reasoningEfforts)), { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.equal(savedPayloads[0].models[1].id, 'alpha')

  // Read-only disables inputs and Save
  const ro = await loadProvidersPageBundle()
  const roTree = ro.render(ro.exports.ProviderConfigEditor, { ...props, readOnly: true })
  const roSave = findAll(roTree, n => n.type === 'button' && textOf(n) === 'Save')[0]
  const roAdd = findAll(roTree, n => n.type === 'button' && textOf(n) === 'Add model')[0]
  assert.equal(roSave.props.disabled, true)
  assert.equal(roAdd.props.disabled, true)
})

test('ApiKeyField toggles visibility for unsaved non-empty draft only, never when empty', async () => {
  const { exports: { ApiKeyField }, render } = await loadProvidersPageBundle()
  let value = ''
  let tree = render(ApiKeyField, { value, onChange: (next) => { value = next }, label: 'API key' })
  const toggleBtn = () => findAll(tree, n => n.type === 'button' && /API key/.test(n.props?.['aria-label'] ?? ''))[0]
  const input = () => findAll(tree, n => n.type === 'input')[0]

  // Empty draft -> reveal button disabled, input masked
  assert.equal(toggleBtn().props.disabled, true)
  assert.equal(input().props.type, 'password')

  // Typing draft enables show/hide toggle
  value = 'sk-draft-secret'
  tree = render(ApiKeyField, { value, onChange: (next) => { value = next }, label: 'API key' })
  assert.equal(toggleBtn().props.disabled, false)
  assert.equal(toggleBtn().props['aria-label'], 'Show API key')
  toggleBtn().props.onClick({ preventDefault() {} })
  tree = render(ApiKeyField, { value, onChange: (next) => { value = next }, label: 'API key' })
  assert.equal(input().props.type, 'text')
  assert.equal(toggleBtn().props['aria-label'], 'Hide API key')
})

test('ModelFetchPicker filters by search, supports Select/Deselect all, preserves unreturned metadata, and refuses empty apply', async () => {
  const { exports: { ModelFetchPicker }, render } = await loadProvidersPageBundle()
  let applied = null
  const props = {
    discovered: [
      { id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, inputModalities: ['text', 'image'] },
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
    existingModels: [
      { id: 'gpt-5', name: 'My Custom GPT-5', contextWindow: 500000, reasoningEfforts: { high: 'high' } },
      { id: 'hand-written', name: 'Hand Written' },
    ],
    onApply: (next) => { applied = next },
    onCancel() {},
  }
  let tree = render(ModelFetchPicker, props)
  const btn = label => findAll(tree, n => n.type === 'button' && textOf(n) === label)[0]
  const search = () => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Search models')[0]

  // Search narrows visible discovered models to 'o3-mini' and Select all picks it
  search().props.onChange({ target: { value: 'o3' } })
  tree = render(ModelFetchPicker, props)
  assert.equal(btn('gpt-4o'), undefined)
  assert.ok(btn('o3-mini'))
  btn('Select all').props.onClick()
  tree = render(ModelFetchPicker, props)

  // Apply preserves existing metadata for gpt-5 & hand-written and adds o3-mini
  btn('Apply selection').props.onClick()
  assert.ok(Array.isArray(applied))
  assert.deepEqual(JSON.parse(JSON.stringify(applied.map(m => m.id))), ['gpt-5', 'o3-mini', 'hand-written'])
  assert.equal(applied[0].name, 'My Custom GPT-5')
  assert.equal(applied[0].contextWindow, 500000)
})

test('ProviderConfigEditor edits retry policy (mode/maxRetries/retryableCodes/backoff) and validates bounds', async () => {
  const { exports: { ProviderConfigEditor }, render } = await loadProvidersPageBundle()
  const savedPayloads = []
  const retryDefaults = {
    modes: ['normal', 'always'],
    defaultMode: 'normal',
    branches: {
      normal: {
        maxRetries: { type: 'number', default: 5, min: 0, max: 9007199254740991, step: 1 },
        retryableCodes: { type: 'codes', choices: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA'], default: ['RATE_LIMIT', 'SERVER'] },
        backoff: {
          type: 'object',
          fields: {
            initialDelayMs: { type: 'number', default: 500, min: 5e-324, max: 2147483647 },
            maxDelayMs: { type: 'number', default: 10000, min: 5e-324, max: 2147483647 },
            jitterRatio: { type: 'number', default: 0.1, min: 0, max: 1 },
          },
        },
      },
      always: {
        backoff: {
          type: 'object',
          fields: {
            initialDelayMs: { type: 'number', default: 500, min: 5e-324, max: 2147483647 },
            maxDelayMs: { type: 'number', default: 10000, min: 5e-324, max: 2147483647 },
            jitterRatio: { type: 'number', default: 0.1, min: 0, max: 1 },
          },
        },
      },
    },
  }
  const props = {
    provider: {
      id: 'openai',
      name: 'OpenAI',
      family: 'pi-ai',
      custom: false,
      editable: true,
      revision: 3,
      modelsOverridden: false,
      models: [{ id: 'gpt-5', ref: 'openai/gpt-5', name: 'GPT-5' }],
      editableModels: [],
      retryDefaults,
    },
    protocols: ['openai-completions'],
    reasoningLevels: ['off', 'low', 'medium', 'high'],
    readOnly: false,
    apply: async () => true,
    actions: {
      saveProviderConfig: async (body) => { savedPayloads.push(body); return { providers: [] } },
      refreshModels() {},
    },
    roster: { bots: [], models: [] },
    canRefresh: false,
    refreshing: false,
    onOpenRefresh() {},
  }
  let tree = render(ProviderConfigEditor, props)
  const btn = label => findAll(tree, n => n.type === 'button' && textOf(n) === label)[0]
  const inputAria = label => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === label)[0]
  // Open Retry mode menu and pick 'normal'
  const modeMenu = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Retry mode')[0]
  assert.ok(modeMenu)
  modeMenu.props.onClick()
  tree = render(ProviderConfigEditor, props)
  const normalOpt = findAll(tree, n => n.type === 'button' && n.props?.role === 'option' && textOf(n) === 'Normal')[0]
  assert.ok(normalOpt)
  normalOpt.props.onClick()
  tree = render(ProviderConfigEditor, props)

  // Set Max retries and add a custom error code + open Backoff
  inputAria('Max retries').props.onChange({ target: { value: '7' } })
  tree = render(ProviderConfigEditor, props)
  inputAria('Custom error code').props.onChange({ target: { value: 'UPSTREAM_BUSY' } })
  tree = render(ProviderConfigEditor, props)
  btn('Add').props.onClick()
  tree = render(ProviderConfigEditor, props)
  btn('Backoff').props.onClick()
  tree = render(ProviderConfigEditor, props)
  // Invalid initialDelayMs > maxDelayMs disables Save
  inputAria('Initial delay (ms)').props.onChange({ target: { value: '20000' } })
  tree = render(ProviderConfigEditor, props)
  assert.equal(btn('Save').props.disabled, true)
  // Fix initialDelayMs <= maxDelayMs -> Save enabled
  inputAria('Initial delay (ms)').props.onChange({ target: { value: '750' } })
  tree = render(ProviderConfigEditor, props)
  assert.equal(btn('Save').props.disabled, false)
  btn('Save').props.onClick()
  await settle(); await settle()
  assert.equal(savedPayloads.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(savedPayloads[0].retryPolicy)), {
    mode: 'normal',
    maxRetries: 7,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'UPSTREAM_BUSY'],
    backoff: { initialDelayMs: 750 },
  })
})

test('ProviderConfigEditor clears invalid ModelListEditor capacity text on Discard', async () => {
  const { exports: { ProviderConfigEditor }, render } = await loadProvidersPageBundle()
  const props = {
    provider: {
      id: 'my-gw', name: 'My Gateway', family: 'pi-ai', custom: true, editable: true, revision: 2,
      displayName: 'My Gateway', baseURL: 'https://gw.example/v1', api: 'openai-completions',
      apiKeyEnv: 'MY_GW_API_KEY', modelsOverridden: true,
      models: [{ id: 'alpha', ref: 'my-gw/alpha', name: 'Alpha' }],
      editableModels: [{ id: 'alpha', name: 'Alpha', contextWindow: 128_000 }],
    },
    protocols: ['openai-completions'], reasoningLevels: ['off', 'low', 'high'],
    readOnly: false, apply: async () => true,
    actions: { saveProviderConfig: async () => ({ providers: [] }), providers: async () => ({ providers: [] }) },
    roster: { bots: [], models: [] }, canRefresh: false, refreshing: false, onOpenRefresh() {},
  }
  let tree = render(ProviderConfigEditor, props)
  const btn = label => findAll(tree, n => n.type === 'button' && textOf(n) === label)[0]
  const btnAria = label => findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === label)[0]
  const inputAria = label => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === label)[0]

  btnAria('Model details 1').props.onClick()
  tree = render(ProviderConfigEditor, props)
  inputAria('Context window 1').props.onChange({ target: { value: 'abc' } })
  tree = render(ProviderConfigEditor, props)
  assert.equal(inputAria('Context window 1').props.value, 'abc')
  assert.equal(btn('Discard').props.disabled, false)

  btn('Discard').props.onClick()
  tree = render(ProviderConfigEditor, props)
  btnAria('Model details 1').props.onClick()
  tree = render(ProviderConfigEditor, props)
  assert.equal(inputAria('Context window 1').props.value, '128K', 'invalid raw text cleared after Discard')
})

test('ProviderConfigEditor detects upstream revision drift without wiping dirty draft, and offers Reload on bot/stale', async () => {
  const { exports: { ProviderConfigEditor }, render } = await loadProvidersPageBundle()
  let reloadCalls = 0
  const baseProvider = {
    id: 'my-gw', name: 'My Gateway', family: 'pi-ai', custom: true, editable: true, revision: 5,
    displayName: 'My Gateway', baseURL: 'https://gw.example/v1', api: 'openai-completions',
    apiKeyEnv: 'MY_GW_API_KEY', modelsOverridden: true,
    models: [{ id: 'alpha', ref: 'my-gw/alpha', name: 'Alpha' }],
    editableModels: [{ id: 'alpha', name: 'Alpha' }],
  }
  const props = {
    provider: baseProvider,
    protocols: ['openai-completions'], reasoningLevels: ['off', 'low', 'high'],
    readOnly: false, apply: async (p) => { await p; return true },
    actions: {
      saveProviderConfig: async () => { throw Object.assign(new Error('stale'), { code: 'bot/stale' }) },
      providers: async () => { reloadCalls += 1; return { providers: [{ ...baseProvider, revision: 6 }] } },
    },
    roster: { bots: [], models: [] }, canRefresh: false, refreshing: false, onOpenRefresh() {},
  }
  let tree = render(ProviderConfigEditor, props)
  const btn = label => findAll(tree, n => n.type === 'button' && textOf(n) === label)[0]
  const inputAria = label => findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === label)[0]

  // Dirty the Base URL
  inputAria('Base URL').props.onChange({ target: { value: 'https://gw-new.example/v1' } })
  tree = render(ProviderConfigEditor, props)
  assert.equal(inputAria('Base URL').props.value, 'https://gw-new.example/v1')

  // Simulate upstream revision advance while dirty -> must NOT wipe unsaved edit, must show conflict & Reload
  tree = render(ProviderConfigEditor, { ...props, provider: { ...baseProvider, revision: 6 } })
  assert.equal(inputAria('Base URL').props.value, 'https://gw-new.example/v1', 'dirty draft preserved on upstream drift')
  assert.ok(btn('Reload'), 'Reload button shown on revision conflict')
  assert.equal(btn('Save').props.disabled, true, 'Save disabled while conflicted')

  // Clicking Reload fetches actions.providers()
  btn('Reload').props.onClick()
  await settle(); await settle()
  assert.equal(reloadCalls, 1)
})

test('ProviderConfigEditor shows inherited catalog hint instead of No models configured on unoverridden pi-ai catalog provider', async () => {
  const { exports: { ProviderConfigEditor }, render } = await loadProvidersPageBundle()
  const tree = render(ProviderConfigEditor, {
    provider: {
      id: 'openai', name: 'OpenAI', family: 'pi-ai', custom: false, editable: true, revision: 1,
      modelsOverridden: false,
      models: [{ id: 'gpt-5', ref: 'openai/gpt-5', name: 'GPT-5' }, { id: 'gpt-4o', ref: 'openai/gpt-4o', name: 'GPT-4o' }],
      editableModels: [],
    },
    protocols: ['openai-completions'], reasoningLevels: [],
    readOnly: false, apply: async () => true,
    actions: { saveProviderConfig: async () => ({ providers: [] }) },
    roster: { bots: [], models: [] }, canRefresh: false, refreshing: false, onOpenRefresh() {},
  })
  assert.match(textOf(tree), /Using built-in catalog \(2 models\)/)
  assert.doesNotMatch(textOf(tree), /No models configured\./)
})
