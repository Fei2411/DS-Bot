import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// The sidebar's row components run as plain functions over a minimal React stand-in,
// as in sidebar-switch.test.js.
const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'", resolveDir: PLUGIN },
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
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, window: { innerWidth: 1280 },
  require: name => (name === 'react' ? react : {}),
})
const { TeamSidebar } = module.exports

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const classes = node => String(node.props?.className ?? '').split(' ')

// The DSH Agent row as the sidebar draws it, run one level down into its own elements.
function agentRow(wide) {
  const agent = { id: 'agent', sessions: ['session'], createdAt: 3 }
  const roster = { bots: [], rooms: [], agents: [agent], byId: {}, roomsById: {}, ready: true }
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'toggleSidebar'].map(name => [name, () => {}]))
  // The column's own preference decides rail or open; the viewport stays at 1280.
  const tree = TeamSidebar({
    actions, useSidebarPref: () => (wide ? 'open' : 'rail'),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
  })
  const [row] = walk(tree, node => node.type?.name === 'AgentRow')
  assert.ok(row !== undefined, 'the sidebar draws the DSH Agent row')
  return row.type(row.props)
}

test('on the rail the DSH Agent wrapper holds only the icon row, so the list can centre it', () => {
  const root = agentRow(false)
  assert.ok(classes(root).includes('bt-agent'))
  const children = root.props.children.flat().filter(Boolean)
  assert.equal(children.length, 1)
  assert.ok(classes(children[0]).includes('bt-row'))
  assert.deepEqual(walk(root, node => classes(node).includes('bt-agent-sub')), [])
  // The hidden Session list also had buttons the keyboard could land on.
  assert.deepEqual(walk(root, node => node.type === 'button' && classes(node).includes('bt-agent-sub-row')), [])
})

test('in the open column the DSH Agent row keeps its Session list under the row', () => {
  const root = agentRow(true)
  const [sub] = walk(root, node => classes(node).includes('bt-agent-sub'))
  assert.ok(sub !== undefined)
  const [newSession] = walk(sub, node => node.type === 'button' && classes(node).includes('bt-agent-new'))
  assert.ok(newSession !== undefined)
  // Closed until the Agent is the open conversation.
  assert.equal(sub.props['data-open'], undefined)
})
