import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// No build step: `react` is not installed here, so a synchronous resolve hook gives
// these client modules a stand-in React. The hook runs on this thread, so the test
// can swap useState/useEffect while driving the page.
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  Fragment: Symbol('Fragment'), Component: class {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: initial => ({ current: initial }), useId: () => 'id',
}
globalThis.__DSB_TEST_REACT__ = react
const reactSource = `
export const createElement = (...a) => globalThis.__DSB_TEST_REACT__.createElement(...a)
export const Fragment = globalThis.__DSB_TEST_REACT__.Fragment
export const Component = globalThis.__DSB_TEST_REACT__.Component
export const useState = (...a) => globalThis.__DSB_TEST_REACT__.useState(...a)
export const useEffect = (...a) => globalThis.__DSB_TEST_REACT__.useEffect(...a)
export const useLayoutEffect = (...a) => globalThis.__DSB_TEST_REACT__.useLayoutEffect(...a)
export const useMemo = (...a) => globalThis.__DSB_TEST_REACT__.useMemo(...a)
export const useCallback = (...a) => globalThis.__DSB_TEST_REACT__.useCallback(...a)
export const useRef = (...a) => globalThis.__DSB_TEST_REACT__.useRef(...a)
export const useId = (...a) => globalThis.__DSB_TEST_REACT__.useId(...a)
`
const reactUrl = `data:text/javascript,${encodeURIComponent(reactSource)}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react') return { url: reactUrl, shortCircuit: true }
    return next(specifier, context)
  },
})

const { ServicesForm, DeepSeekServicesPage, SERVICES_CSS } = await import('../src/client/services-settings.js')

const Section = function Section() {}
const Row = function Row() {}
const Switch = function Switch() {}
const OPAQUE = new Set([Section, Row, Switch])

const walk = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  walk(node.props?.children, out)
  if (typeof node.type === 'function' && !OPAQUE.has(node.type)) walk(node.type(node.props), out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')

const status = (override = {}) => ({
  endpoint: 'https://api.deepseek.com',
  key: { ref: 'deepseek', configured: true, token: 'mock-key' },
  ocr: { supported: true, enabled: false, configured: true, reason: '' },
  preferences: { ocr: false },
  ...override,
})
const form = (extra = {}) => {
  const log = []
  const props = {
    status: status(), busy: false, saved: false, pluginsAvailable: true,
    save: patch => log.push(['save', patch]),
    onOpenModels: () => log.push(['models']), onOpenPlugins: () => log.push(['plugins']),
    Section, Row, Switch,
    ...extra,
  }
  return { tree: () => walk(ServicesForm(props)), log, props }
}

test('the page shows the real key state and never renders the key value', () => {
  const { tree } = form()
  const nodes = tree()
  assert.ok(nodes.some(node => node.props?.title === 'DeepSeek API'))
  assert.ok(nodes.some(node => node.props?.title === 'Image and document reading'))
  assert.ok(!nodes.some(node => node.props?.title === 'Text to speech'))
  assert.ok(!nodes.some(node => node.props?.title === 'Speech recognition'))
  const text = textOf(nodes)
  assert.ok(text.includes('Key set'))
  assert.ok(text.includes('https://api.deepseek.com'))
  assert.ok(!text.includes('mock-key'))
  assert.ok(nodes.some(node => node.props?.hint?.includes('upload selected files to DeepSeek')))
  const missing = form({ status: status({ key: { ref: 'deepseek', configured: false } }) }).tree()
  assert.ok(textOf(missing).includes('Needs an API key'))
})

test('an enabled preference with a missing key is never shown as ready', () => {
  const reason = 'Add a DeepSeek API key in Models first.'
  const nodes = form({ status: status({
    ocr: { supported: true, enabled: true, configured: false, reason },
  }) }).tree()
  assert.ok(!textOf(nodes).includes('Ready'))
  const missing = nodes.filter(node => node.props?.view?.state === 'missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].props.view.text, reason)
})

test('enabling OCR saves only the ocr preference', () => {
  const { tree, log } = form()
  const toggle = tree().find(node => node.type === Switch && node.props.label === 'Use DeepSeek to read images and documents')
  assert.equal(toggle.props.on, false)
  assert.equal(toggle.props.disabled, false)
  toggle.props.onChange(true)
  assert.deepEqual(log, [['save', { ocr: true }]])
})

test('the Web search row navigates with the existing Plugins action', () => {
  const { tree, log } = form()
  const row = tree().find(node => node.type === Row && node.props.label === 'DeepSeek Web Search API')
  assert.ok(row)
  assert.equal(row.props.hint, 'Find it in Plugins → Web search.')
  const button = walk(row).find(node => node.type === 'button' && textOf(node) === 'Open Plugins')
  button.props.onClick()
  assert.deepEqual(log, [['plugins']])
})

function withState(values) {
  const saved = react.useState
  let slot = 0
  react.useState = () => { const value = values[slot++]; return [value, () => {}] }
  return () => { react.useState = saved }
}
const run = promise => Promise.resolve(promise).then(() => true).catch(() => false)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('the page saves a patch through setDeepseekServices and opens the existing entries', async () => {
  const calls = []
  const actions = {
    deepseekServices: () => status(),
    setDeepseekServices: patch => { calls.push(['set', patch]); return status() },
    openModels: () => calls.push(['models']),
    openPlugins: () => calls.push(['plugins']),
    hasPlugins: () => true,
  }
  const restore = withState([status(), false, false, ''])
  try {
    const tree = walk(DeepSeekServicesPage({ actions, run, Section, Row, Switch }))
    const view = tree.find(node => node.type === ServicesForm)
    assert.ok(view)
    view.props.save({ ocr: true })
    view.props.onOpenModels()
    view.props.onOpenPlugins()
    await flush()
    assert.ok(calls.some(call => call[0] === 'set' && call[1].ocr === true))
    assert.ok(calls.some(call => call[0] === 'models'))
    assert.ok(calls.some(call => call[0] === 'plugins'))
  } finally { restore() }
})

test('opening the Plugins page closes the settings dialog first', () => {
  const calls = []
  const actions = {
    deepseekServices: () => status(),
    setDeepseekServices: () => status(),
    openModels: () => calls.push(['models']),
    openPlugins: () => calls.push(['plugins']),
    closeSettings: () => calls.push(['close']),
    hasPlugins: () => true,
  }
  const restore = withState([status(), false, false, ''])
  try {
    const tree = walk(DeepSeekServicesPage({ actions, run, Section, Row, Switch }))
    const view = tree.find(node => node.type === ServicesForm)
    view.props.onOpenPlugins()
    assert.deepEqual(calls, [['close'], ['plugins']])
  } finally { restore() }
})

test('the sections of the page are spaced apart', () => {
  assert.match(SERVICES_CSS, /\.bt-svc\{display:grid;gap:20px\}/)
})

test('the page ships its own CSS on --bt variables, with no hard-coded colors', () => {
  assert.ok(SERVICES_CSS.includes('--bt-ink-2'))
  assert.ok(!/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i.test(SERVICES_CSS))
  assert.ok(SERVICES_CSS.includes(':focus-visible'))
})

test('Settings wires the page into its nav, render switch and action gate', () => {
  const source = readFileSync(new URL('../src/client/settings.js', import.meta.url), 'utf8')
  assert.match(source, /\['deepseek-services', 'DeepSeek services'\]/)
  assert.match(source, /'deepseek-services': WaveIcon/)
  assert.match(source, /key !== 'deepseek-services' \|\| actions\.deepseekServices !== undefined/)
  assert.match(source, /shown === 'deepseek-services' \? h\(DeepSeekServicesPage/)
})
