import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { bundleClient, bundleOffice } from '../scripts/build-client.mjs'
import { READ_LIMITS } from '../src/client/read-page.js'
import { legacyKeys, STORAGE } from '../src/client/storage.js'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const committedOffice = () => readFileSync(new URL('../office.js', import.meta.url), 'utf8')
const platform = {
  'react': { Component: class {}, createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(), createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value },
  'react-dom': { createPortal: node => node },
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
}

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
})

test('office.js is the build of src/office', async () => {
  assert.equal(await bundleOffice(), committedOffice(), 'office.js is stale: run `npm run build` and commit it')
})

test('the startup client bundle stays under 2.5 MiB', () => {
  const bytes = Buffer.byteLength(committed())
  assert.ok(bytes < 2.5 * 1024 * 1024, `client.js is ${bytes} bytes; the startup budget is 2.5 MiB`)
})

// dsh runs client.js as a classic script that hands a factory to the module loader; the
// factory's `require` answers only the shell's platform modules.
test('client.js registers a factory that exports apply and inject', () => {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  assert.equal(registrations.length, 1)
  const [{ id, factory, ...rest }] = registrations
  assert.equal(id, 'ds-bot')
  assert.deepEqual(Object.keys(rest), [])

  const requested = []
  const exports = factory((specifier) => {
    requested.push(specifier)
    if (!(specifier in platform)) throw new Error(`no platform module ${specifier}`)
    return platform[specifier]
  })
  assert.deepEqual([...new Set(requested)].sort(), Object.keys(platform).sort())
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
  assert.deepEqual(Object.keys(exports), ['apply', 'inject'])
  assert.equal(typeof exports.apply, 'function')
  // No `configForms`: the client never writes the user's DSH settings, such as the
  // work-details mode it once held at `verbose`.
  assert.deepEqual(Array.from(exports.inject), ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout'])
})

test('the shipped page reader can run without the client bundle scope', () => {
  const sources = []
  const client = createContext({
    recordSource: source => sources.push(source),
    window: { __ModuleLoader__: { load: ({ factory }) => factory(specifier => platform[specifier]) } },
  })
  runInContext(`
    const serialize = Function.prototype.toString
    Function.prototype.toString = function () {
      const source = serialize.call(this)
      recordSource(source)
      return source
    }
  `, client)
  runInContext(committed(), client)
  const readers = sources.filter(source => source.includes('getSelection()'))
  assert.equal(readers.length, 1, 'expected the client to serialize one page reader')
  const page = runInNewContext(`(${readers[0]})(${JSON.stringify(READ_LIMITS)})`, {
    document: {
      body: { nodeType: 3, data: 'Sample page text' },
      documentElement: { lang: 'en' },
      querySelector: () => null,
      title: 'Sample',
    },
    getSelection: () => '',
    location: { href: 'https://example.com/' },
    performance,
  })
  assert.equal(page.text, 'Sample page text')
})

test('the shipped client migrates preferences and browser tabs from either legacy key', () => {
  const entries = new Map()
  const localStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  }
  let apply
  runInNewContext(committed(), {
    localStorage,
    window: { __ModuleLoader__: { load: ({ factory }) => { ({ apply } = factory(specifier => platform[specifier])) } } },
  })
  const stop = new Error('stop after storage migration')
  const ctx = { effect() {}, get() { throw stop } }
  const prefs = '{"theme":"paper"}'
  const page = { url: 'https://example.com/' }
  const browsers = JSON.stringify({ a: { tabs: [{ id: 'v1-a', ...page, title: '' }], active: 'v1-a' } })

  for (const [i, key] of legacyKeys(STORAGE.browsers).entries()) {
    entries.clear()
    entries.set(key, JSON.stringify({ a: page }))
    entries.set(legacyKeys(STORAGE.prefs)[i], prefs)
    assert.throws(() => apply(ctx), error => error === stop)
    assert.deepEqual(Object.fromEntries(entries), { [STORAGE.prefs]: prefs, [STORAGE.browsers]: browsers })
  }
})
