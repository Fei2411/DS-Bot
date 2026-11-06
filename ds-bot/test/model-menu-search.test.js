import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Same harness as model-menu.test.js: bundle the client module, stub React.
const bundle = await build({
  stdin: {
    contents: "export * from './src/client/model-menu.js'",
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
const { filterModelGroups, groupModels } = module.exports

const models = [
  { ref: 'a/glm-5.3',       name: 'GLM-5.3',        provider: 'a', providerName: 'Alpha' },
  { ref: 'a/glm-5.3-flash', name: 'GLM-5.3-Flash',  provider: 'a', providerName: 'Alpha' },
  { ref: 'a/kimi-k3',       name: 'Kimi K3',        provider: 'a', providerName: 'Alpha' },
  { ref: 'b/deepseek-v4',   name: 'DeepSeek-V4-Pro',provider: 'b', providerName: 'Beta' },
  { ref: 'b/deepseek-flash',name: 'DeepSeek Flash', provider: 'b', providerName: 'Beta' },
]

// The groups come from the bundle's realm, whose arrays are not this one's
// (see model-menu.test.js:114). Copy the values out before deepStrictEqual.
const plain = value => JSON.parse(JSON.stringify(value))
const refs = query => plain(filterModelGroups(models, query).flatMap(([, list]) => list.map(m => m.ref)))

test('an empty query keeps every model and every provider group', () => {
  assert.equal(filterModelGroups(models, '').length, groupModels(models).length)
  assert.equal(refs('').length, 5)
  assert.equal(refs('   ').length, 5)
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
  assert.equal(refs(undefined).length, 5)
  assert.equal(refs(null).length, 5)
  assert.equal(refs(42).length, 5)
  assert.equal(refs({}).length, 5)
})
