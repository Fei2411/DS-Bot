// A group chat deletes from its menu only on the second click, and the first click
// keeps the menu open; Cancel goes back to the plain menu. A Bot keeps one click.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: "export { ContextMenu } from './src/client/context-menu.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
// Hooks keep their state between renders, so a click that flips `confirming` shows up
// in the tree rendered next.
const hookState = []
let hookIndex = 0
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = initial
    return [hookState[index], (next) => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next }]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: initial => ({ current: initial }),
}
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
}
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { ContextMenu } = module.exports

const bot = { id: 'b', name: 'Writer', createdAt: 1 }
const room = { id: 'r', name: 'Team', members: [], createdAt: 2 }
const roster = { bots: [bot], rooms: [room], byId: { b: bot }, roomsById: { r: room }, mainBotIds: [], sections: [] }

const nodes = (tree, match, found = []) => {
  if (Array.isArray(tree)) { for (const item of tree) nodes(item, match, found); return found }
  if (tree === null || typeof tree !== 'object') return found
  if (match(tree)) found.push(tree)
  for (const child of tree.children ?? []) nodes(child, match, found)
  return found
}
const labelOf = button => button.children.find(child => child?.props?.className === 'bt-menu-label')?.children?.[0]

function bench(kind = 'room', id = 'r') {
  const calls = { closed: 0, deletes: [] }
  const actions = {
    closeMenu: () => { calls.closed++ },
    reportError() {}, setFlags() {}, markUnread() {},
    deleteRoom: roomId => calls.deletes.push(['room', roomId]),
    deleteBot: botId => calls.deletes.push(['bot', botId]),
  }
  const render = () => { hookIndex = 0; return ContextMenu({ menu: { kind, id, x: 10, y: 10 }, roster, actions }) }
  const buttons = tree => nodes(tree, node => node.type === 'button')
  const find = (tree, label) => buttons(tree).find(button => labelOf(button) === label)
  return { calls, render, find }
}

test('the first click on Delete group only asks; the second one deletes', () => {
  hookState.length = 0
  const { calls, render, find } = bench()
  find(render(), 'Delete group').props.onClick()
  assert.equal(calls.closed, 0)
  assert.deepEqual(calls.deletes, [])
  const asked = render()
  assert.ok(find(asked, 'Delete group?'))
  assert.ok(find(asked, 'Cancel'))
  find(asked, 'Delete group?').props.onClick()
  assert.deepEqual(calls.deletes, [['room', 'r']])
  assert.equal(calls.closed, 1)
})

test('Cancel goes back to the plain menu and deletes nothing', () => {
  hookState.length = 0
  const { calls, render, find } = bench()
  find(render(), 'Delete group').props.onClick()
  find(render(), 'Cancel').props.onClick()
  const plain = render()
  assert.ok(find(plain, 'Delete group'))
  assert.equal(find(plain, 'Delete group?'), undefined)
  assert.deepEqual(calls.deletes, [])
  assert.equal(calls.closed, 0)
})

test('a Bot still deletes on one click', () => {
  hookState.length = 0
  const { calls, render, find } = bench('bot', 'b')
  find(render(), 'Delete').props.onClick()
  assert.deepEqual(calls.deletes, [['bot', 'b']])
  assert.equal(calls.closed, 1)
})
