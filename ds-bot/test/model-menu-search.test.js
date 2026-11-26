import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Same harness as model-menu.test.js: bundle the client module, stub React.
const bundle = await build({
  stdin: {
    contents: "export * from './src/client/model-menu.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const sandbox = {
  document: { activeElement: null, body: {} },
  module, exports: module.exports,
  require: name => {
    const platform = {
      react: {
        Fragment: 'fragment', useState: initial => [initial, () => {}], useEffect: () => {},
        useLayoutEffect: () => {},
        useRef: initial => ({ current: initial }), useMemo: make => make(), useCallback: fn => fn,
        createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ children }) => children; return ctx },
        useContext: ctx => ctx.value, useId: () => 'dv-id',
        useSyncExternalStore: (_sub, get) => get(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      },
      'react-dom': { createPortal: tree => tree },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error('no platform module ' + name)
    return platform[name]
  },
}
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { filterModelGroups, groupModels, ModelRows, installLocale } = module.exports

// A tiny locale service that translates only the CLI-default label, so nameOf yields a
// label that differs from the raw catalog name and the Devin bug can be exercised: a
// query in the translated label must still keep the local default in the results.
const LOCAL_DEFAULT_LABEL = 'CLI 默认'
installLocale({
  register: () => () => {},
  bind: () => (key) => (key === 'CLI default' ? LOCAL_DEFAULT_LABEL : key),
  getLocale: () => ({ active: 'zh', locales: [] }),
})

// The models, including a local CLI default whose raw catalog name is the English
// "CLI default" but whose displayed label (through nameOf) is LOCAL_DEFAULT_LABEL.
const models = [
  { ref: 'a/glm-5.3', name: 'GLM-5.3', provider: 'a', providerName: 'Alpha' },
  { ref: 'a/glm-5.3-flash', name: 'GLM-5.3-Flash', provider: 'a', providerName: 'Alpha' },
  { ref: 'a/kimi-k3', name: 'Kimi K3', provider: 'a', providerName: 'Alpha' },
  { ref: 'b/deepseek-v4', name: 'DeepSeek-V4-Pro', provider: 'b', providerName: 'Beta' },
  { ref: 'b/deepseek-flash', name: 'DeepSeek Flash', provider: 'b', providerName: 'Beta' },
  // A local CLI default: id 'default', ref under a local route, raw name 'CLI default'.
  { ref: 'local-codex-cli/default', name: 'CLI default', provider: 'local-codex-cli', providerName: 'Codex', id: 'default' },
]
const TOTAL = models.length

// The groups come from the bundle's realm, whose arrays are not this one's
// (see model-menu.test.js:114). Copy the values out before deepStrictEqual.
const plain = value => JSON.parse(JSON.stringify(value))
const refs = query => plain(filterModelGroups(models, query).flatMap(([, list]) => list.map(m => m.ref)))

test('an empty query keeps every model and every provider group', () => {
  assert.equal(filterModelGroups(models, '').length, groupModels(models).length)
  assert.equal(refs('').length, TOTAL)
  assert.equal(refs('   ').length, TOTAL)
})

test('one token matches the model name', () => {
  assert.deepEqual(refs('glm'), ['a/glm-5.3', 'a/glm-5.3-flash'])
})

test('every token must match (AND), not just one', () => {
  assert.deepEqual(refs('glm flash'), ['a/glm-5.3-flash'])
  assert.deepEqual(refs('glm kimi'), [])
})

test('the ref, provider id and provider display name are searchable', () => {
  assert.deepEqual(refs('a/glm'), ['a/glm-5.3', 'a/glm-5.3-flash'])
  assert.equal(refs('beta').length, 2)
})

test('matching is case insensitive and whitespace tolerant', () => {
  assert.deepEqual(refs('KIMI'), ['a/kimi-k3'])
  assert.deepEqual(refs('  glm   flash  '), ['a/glm-5.3-flash'])
})

test('groups with no match are dropped, never left as a bare heading', () => {
  assert.deepEqual(plain(filterModelGroups(models, 'beta').map(([p]) => p)), ['Beta'])
  assert.deepEqual(plain(filterModelGroups(models, 'zz-no-such-model')), [])
})

test('a missing or non-string query is treated as empty', () => {
  assert.equal(refs(undefined).length, TOTAL)
  assert.equal(refs(null).length, TOTAL)
  assert.equal(refs(42).length, TOTAL)
  assert.equal(refs({}).length, TOTAL)
})

test('a local default is found by its translated label, not only its raw name', () => {
  // The Devin bug: nameOf translates "CLI default" to LOCAL_DEFAULT_LABEL; a query in
  // that label must keep the local default, and the raw English name must too.
  assert.deepEqual(refs(LOCAL_DEFAULT_LABEL), ['local-codex-cli/default'])
  assert.deepEqual(refs('默认'), ['local-codex-cli/default'])
  assert.deepEqual(refs('cli default'), ['local-codex-cli/default'])
})

test('ModelRows passes filtering=true when a query is active and renders empty status on zero matches', () => {
  const active = ModelRows({ roster: { models }, current: 'a/glm-5.3', onPick: () => {}, query: 'flash' })
  assert.equal(active.props.filtering, true)
  assert.equal(plain(active.props.groups).length, 2)

  const empty = ModelRows({ roster: { models }, current: 'a/glm-5.3', onPick: () => {}, query: 'zz-none' })
  assert.equal(empty.type, 'div')
  assert.equal(empty.props.role, 'status')
})
