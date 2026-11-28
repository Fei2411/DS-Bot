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
    require: name => (name === 'react' ? react : {}),
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
