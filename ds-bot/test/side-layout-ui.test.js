import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/side-layout-ui.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useSyncExternalStore: (sub, get) => get(), useId: () => 'id', useCallback: fn => fn,
  createContext: value => ({ Provider: () => null, _currentValue: value }), useContext: context => context?._currentValue,
  memo: component => component, forwardRef: component => component,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  document: { hidden: false, body: {} }, localStorage: { getItem: () => null, setItem() {} },
  performance: { now: () => 0 }, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const ui = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

test('the menu lists the three layouts with the one in use checked, and nothing to reset by default', () => {
  const items = ui.layoutMenuItems({}, () => {})
  assert.deepEqual(plain(items.map(item => [item.key, item.label, item.checked])), [
    ['layout:docked', 'Docked right', true],
    ['layout:drawer', 'Drawer right', false],
    ['layout:centered', 'Centered', false],
  ])
  assert.equal(items.some(item => item.key === 'layout:reset'), false, 'a conversation with no choice of its own has nothing to reset')
})

test('picking a layout sends it once, and the current one sends nothing', () => {
  const sent = []
  const items = ui.layoutMenuItems({ sideLayoutInitial: 'drawer' }, layout => sent.push(layout))
  assert.equal(items.find(item => item.key === 'layout:drawer').checked, true, 'the layout it was made with is the current one')
  items.find(item => item.key === 'layout:drawer').onPick()
  assert.deepEqual(sent, [], 'choosing what is already shown changes nothing')
  items.find(item => item.key === 'layout:centered').onPick()
  assert.deepEqual(sent, ['centered'])
})

test('a conversation with its own choice shows it checked and offers Reset, which clears it', () => {
  const sent = []
  const items = ui.layoutMenuItems({ sideLayout: 'centered', sideLayoutInitial: 'drawer' }, layout => sent.push(layout))
  assert.equal(items.find(item => item.key === 'layout:centered').checked, true)
  assert.equal(items.find(item => item.key === 'layout:drawer').checked, false)
  const reset = items.find(item => item.key === 'layout:reset')
  assert.equal(reset.label, 'Reset to original layout')
  reset.onPick()
  assert.deepEqual(sent, [null], 'null clears the override so the conversation returns to how it was made')
})

test('what Reset returns to is the layout the conversation was made with, else docked', () => {
  assert.equal(ui.originalLayout({ sideLayoutInitial: 'centered' }), 'centered')
  assert.equal(ui.originalLayout({ sideLayout: 'drawer' }), 'docked', 'an older conversation resets to docked')
  assert.equal(ui.originalLayout({ sideLayoutInitial: 'nope' }), 'docked')
  assert.equal(ui.originalLayout(undefined), 'docked')
  assert.equal(ui.hasLayoutOverride({ sideLayout: 'drawer' }), true)
  assert.equal(ui.hasLayoutOverride({ sideLayoutInitial: 'drawer' }), false)
  assert.equal(ui.hasLayoutOverride({ sideLayout: 'sideways' }), false)
})

test('the panel that is open reads its own conversation\'s layout, group A apart from group B', () => {
  const roster = {
    byId: { writer: { id: 'writer', sideLayout: 'drawer' }, old: { id: 'old' } },
    roomsById: { ga: { id: 'ga', sideLayout: 'docked' }, gb: { id: 'gb', sideLayout: 'centered' }, gc: { id: 'gc', sideLayoutInitial: 'drawer' } },
  }
  assert.equal(ui.panelLayoutOf(roster, 'ga', 'details'), 'docked')
  assert.equal(ui.panelLayoutOf(roster, 'gb', 'details'), 'centered')
  assert.equal(ui.panelLayoutOf(roster, 'gc', 'canvas'), 'drawer')
  assert.equal(ui.panelLayoutOf(roster, 'writer', 'reader'), 'drawer')
  assert.equal(ui.panelLayoutOf(roster, 'old', 'details'), 'docked', 'a conversation with no record stays docked')
  assert.equal(ui.panelLayoutOf(roster, 'unknown', 'details'), 'docked')
  assert.equal(ui.panelLayoutOf(roster, 'gb', 'workspace'), 'docked', 'DSH\'s workspace view has no conversation behind it')
  assert.equal(ui.panelLayoutOf(undefined, 'gb', 'details'), 'docked')
})

test('the team default reads as docked unless it is a real layout', () => {
  assert.equal(ui.sideLayoutOf({ sideLayout: 'centered' }), 'centered')
  assert.equal(ui.sideLayoutOf({ sideLayout: 'drawer' }), 'drawer')
  assert.equal(ui.sideLayoutOf({}), 'docked')
  assert.equal(ui.sideLayoutOf({ sideLayout: 'diagonal' }), 'docked')
  assert.equal(ui.sideLayoutOf(undefined), 'docked')
})

test('every layout has a name, an icon and a one-line hint', () => {
  for (const id of ['docked', 'drawer', 'centered']) {
    assert.ok(ui.layoutName(id).length > 0)
    assert.ok(ui.layoutHint(id).endsWith('.'))
    assert.equal(typeof ui.LAYOUT_ICONS[id], 'function')
  }
  assert.notEqual(ui.layoutHint('drawer'), ui.layoutHint('centered'))
})
