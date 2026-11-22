import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The "New session" menu bundled with a React stand-in, as the composer's "+" test does:
// React needs the same hooks on every render, and the menu's open state is seeded so a
// call can read the rows without a browser.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/new-part-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}],
  useRef: current => ({ current }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { body: {} }, console,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { NewPartMenu, newPartChoices } = module.exports

const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}
const find = (node, match, out = []) => {
  if (Array.isArray(node)) { for (const child of node) find(child, match, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  for (const child of node.children ?? []) find(child, match, out)
  return out
}

// A render with the menu open: the anchored hook's anchor and place, then the rows.
function render({ busy = false, actions, run } = {}) {
  const place = { left: 0, width: 240, top: 40, maxHeight: 200 }
  let states = 0
  react.useState = (initial) => {
    states += 1
    if (states === 1) return [true, () => {}]
    if (states === 2) return [place, () => {}]
    return [initial, () => {}]
  }
  try {
    return NewPartMenu({ botId: 'a', busy, actions, run })
  } finally {
    react.useState = initial => [initial, () => {}]
  }
}

test('a new session offers a blank part and a handoff, and each asks the host once', () => {
  const asked = []
  const ran = []
  const actions = { newPart: (botId, options) => { asked.push([botId, options.blank === true, options.handoff === true]); return Promise.resolve() } }
  const tree = render({ actions, run: (promise) => { ran.push(promise); return promise } })
  const items = find(tree, node => node.props?.role === 'menuitem')
  assert.deepEqual(items.map(textOf), ['Blank session', 'Continue with handoff'])
  for (const item of items) item.props.onClick()
  assert.deepEqual(asked, [['a', true, false], ['a', false, true]])
  // Every pick goes through the drawer's `run`, which refreshes the roster afterwards.
  assert.equal(ran.length, 2)
})

test('a working Bot offers no new session: it has one conversation at a time', () => {
  const asked = []
  const actions = { newPart: (botId, options) => { asked.push([botId, options.blank === true]); return Promise.resolve() } }
  const tree = render({ busy: true, actions })
  assert.deepEqual(find(tree, node => node.props?.role === 'menuitem'), [])
  const [trigger] = find(tree, node => node.props?.className === 'bt-agent-sessions-new')
  assert.equal(trigger.props.disabled, true)
  assert.deepEqual(asked, [])
})

test('the trigger is the drawer\'s New session button and opens a menu', () => {
  const tree = render({ actions: {} })
  const [trigger] = find(tree, node => node.props?.className === 'bt-agent-sessions-new')
  assert.ok(trigger)
  assert.equal(trigger.props['aria-haspopup'], 'menu')
  assert.equal(textOf(trigger), 'New session')
})

test('the two ways are named the same for a caller that only has the choices', () => {
  const asked = []
  const choices = newPartChoices({ botId: 'a', actions: { newPart: (botId, options) => { asked.push([botId, options.blank === true, options.handoff === true]) } } })
  assert.deepEqual([...choices].map(choice => choice.label), ['Blank session', 'Continue with handoff'])
  for (const choice of choices) choice.start()
  assert.deepEqual(asked, [['a', true, false], ['a', false, true]])
})
