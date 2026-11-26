// The Bot menu's way out of a wait: only a Bot that is waiting on a hand-off offers to
// give one up, one item per open wait, and the item asks the host to give it up.
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
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'id',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: initial => [initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {},
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
const menuitems = tree => nodes(tree, node => node.type === 'button')
const menuFor = (waiting) => {
  const calls = []
  const actions = { closeMenu() {}, reportError() {}, setFlags() {}, markUnread() {}, abandonWork: id => calls.push(id) }
  const useWork = selector => selector({ waiting })
  const tree = ContextMenu({ menu: { kind: 'bot', id: 'b', x: 10, y: 10 }, roster, actions, useWork })
  return { calls, buttons: menuitems(tree) }
}
const labelOf = button => button.children.find(child => child?.props?.className === 'bt-menu-label')?.children?.[0]

test('a waiting Bot offers one way out per open wait', () => {
  const { buttons, calls } = menuFor({
    b: { bots: ['c', 'd'], rooms: [], for: ['a'], waits: [{ id: 'w1', to: 'c', name: 'Tester' }, { id: 'w2', to: 'd', name: 'Editor' }] },
  })
  const giveUps = buttons.filter(button => String(labelOf(button)).startsWith('Give up waiting for'))
  assert.deepEqual(giveUps.map(labelOf), ['Give up waiting for Tester', 'Give up waiting for Editor'])
  giveUps[1].props.onClick()
  assert.deepEqual(calls, ['w2'])
})

test('a Bot that is not waiting has no such item', () => {
  for (const waiting of [undefined, {}, { b: { bots: [], rooms: [], for: [], waits: [] } }]) {
    const { buttons } = menuFor(waiting)
    assert.equal(buttons.some(button => String(labelOf(button)).startsWith('Give up waiting for')), false)
  }
})
