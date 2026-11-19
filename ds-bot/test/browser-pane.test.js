import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { rectsOverlap } from '../src/client/browser-overlap.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-pane.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const mod = { exports: {} }
const stubReact = {
  createElement: () => null,
  createContext: (v) => ({ Provider: () => null, _currentValue: v }),
  useContext: (ctx) => ctx?._currentValue,
  useEffect() {},
  useLayoutEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  memo: (c) => c,
  forwardRef: (c) => c,
  Fragment: Symbol('Fragment'),
}
runInNewContext(outputFiles[0].text, {
  module: mod,
  exports: mod.exports,
  require: (name) => (name === 'react' ? stubReact : name === 'react-dom' ? { createPortal: () => null } : {}),
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  document: {},
  localStorage: { getItem: () => null, setItem() {} },
  performance: { now: () => 0 },
})
const { orderImportSources, siteMatchesHost } = mod.exports

test('overlay coverage requires positive rectangle intersection', () => {
  const panel = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 }
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 150, bottom: 160, width: 100, height: 100 }), true)
  assert.equal(rectsOverlap(panel, { left: 110, top: 20, right: 150, bottom: 60, width: 40, height: 40 }), false)
  assert.equal(rectsOverlap(panel, { left: 200, top: 200, right: 250, bottom: 250, width: 50, height: 50 }), false)
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 50, bottom: 90, width: 0, height: 30 }), false)
})

test('siteMatchesHost matches exact, parent, subdomain, and shared registrable domains', () => {
  assert.equal(siteMatchesHost('github.com', 'github.com'), true)
  assert.equal(siteMatchesHost('github.com', 'gist.github.com'), true)
  assert.equal(siteMatchesHost('api.github.com', 'github.com'), true)
  assert.equal(siteMatchesHost('auth.github.com', 'gist.github.com'), true)
  assert.equal(siteMatchesHost('login.example.co.uk', 'app.example.co.uk'), true)
  assert.equal(siteMatchesHost('other.co.uk', 'app.example.co.uk'), false)
  assert.equal(siteMatchesHost('github.com', 'notgithub.com'), false)
  assert.equal(siteMatchesHost('localhost', 'localhost'), true)
  assert.equal(siteMatchesHost('127.0.0.1', '127.0.0.1'), true)
  assert.equal(siteMatchesHost('127.0.0.1', '127.0.0.2'), false)
})

test('orderImportSources pins the last-used profile to the top without mutating input', () => {
  const list = [
    { id: 'chrome:Default', label: 'Chrome — Default' },
    { id: 'edge:Profile 1', label: 'Edge — Work' },
    { id: 'firefox:abc', label: 'Firefox' },
  ]
  const ordered = orderImportSources(list, 'edge:Profile 1')
  assert.deepEqual(Array.from(ordered, (s) => s.id), ['edge:Profile 1', 'chrome:Default', 'firefox:abc'])
  assert.deepEqual(list.map((s) => s.id), ['chrome:Default', 'edge:Profile 1', 'firefox:abc'])
  assert.deepEqual(Array.from(orderImportSources(list, 'missing'), (s) => s.id), list.map((s) => s.id))
  assert.deepEqual(Array.from(orderImportSources(null, 'chrome:Default')), [])
})
