import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The activity row and the diagnostics it reports into, bundled once and run with a
// minimal React stand-in; the row's DOM helpers only read `document` at call time.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { findHost, rowVisible, freshInputAt } from './src/client/activity-row.js'",
      "export { clientErrors } from './src/client/diagnostics.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: fn => setTimeout(fn, 0),
  cancelAnimationFrame: id => clearTimeout(id),
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { findHost, rowVisible, freshInputAt, clientErrors } = module.exports

test('the activity row mounts at the running slot even under an extra wrapper', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow><div class="wrap"><div data-chat-running id="slot"></div></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'slot')
})

test('without the running slot the row mounts at the flow tail', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow id="flow"><div data-chat-flow-key="1"></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'flow')
})

test('a missing chat flow is reported once per page, not on every retry', () => {
  dom.window.document.body.innerHTML = '<div></div>'
  const before = clientErrors().filter(entry => entry.text.startsWith('activity row:')).length
  assert.equal(findHost(), null)
  assert.equal(findHost(), null)
  const entries = clientErrors().filter(entry => entry.text.startsWith('activity row:'))
  assert.equal(entries.length, before + 1)
  assert.match(entries.at(-1).text, /activity row:/)
})

// The row hides while a reply streams — but a turn that streams first and runs a
// tool after keeps the row once the tool starts.
test('the row shows while a turn runs, also when text streamed before a tool', () => {
  const bot = {}
  const cases = [
    [{ running: true, streaming: false, tools: [], relaying: false, bot }, true],
    [{ running: true, streaming: true, tools: [], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: true, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: false, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [], relaying: false }, false],
    [{ running: true, streaming: false, tools: [], relaying: false, room: {} }, true],
  ]
  for (const [input, expected] of cases) assert.equal(rowVisible(input), expected, JSON.stringify(input))
})

// A queued message waits for the next turn; a transcript or steering send counts
// as fresh input, and a steer the host saw counts from when it landed.
test('fresh input ignores queued sends and takes the newest of the rest', () => {
  const submissions = [
    { placement: 'queued', time: 300 },
    { placement: 'steering', time: 100 },
    { placement: 'transcript', time: 200 },
  ]
  assert.equal(freshInputAt(submissions, undefined), 200)
  assert.equal(freshInputAt(submissions, 400), 400)
  assert.equal(freshInputAt(submissions, 50), 200)
  assert.equal(freshInputAt([{ placement: 'queued', time: 300 }], undefined), 0)
  assert.equal(freshInputAt(undefined, 400), 400)
  assert.equal(freshInputAt([], undefined), 0)
})
