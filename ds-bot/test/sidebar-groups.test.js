import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The same stand-in React as the sidebar-switch tests: components run as plain
// functions, so a room's member rows are read by invoking RoomRow on its node.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: () => ({ current: null }),
  useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useId: () => 'id', useCallback: fn => fn,
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280 },
})
const { TeamSidebar } = module.exports

const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
const named = (node, name) => node.type?.name === name
// Components are plain functions here: run a RoomRow once to unwrap its row
// button and member list, then walk the result without running anything else —
// deeper components (BotRow, avatars) must survive as element nodes.
const unwrapRoom = node => node.type(node.props)

function sidebar({ activeId = null, roster }) {
  const calls = []
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession'].map(name => [name, id => { calls.push([name, id]); return id }]))
  for (const name of ['openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread', 'landOn']) actions[name] = () => {}
  const statusMap = new Map()
  const retain = (id, pick) => pick(id === activeId ? { retainedBy: { mainView: 1 } } : null)
  const tree = TeamSidebar({
    wide: true, actions,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap), useSessionRetainInfo: retain,
    useActivity: pick => pick({}), useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  return {
    calls,
    // The top of the list, as row ids: bots by id, rooms by "room:<id>". Rows are
    // executed so a hidden row that would render nothing is not counted; the list
    // is sorted because the tests care about membership, not recency order.
    top: () => {
      const rows = []
      walk(tree, (node) => {
        if (!named(node, 'BotRow') && !named(node, 'RoomRow')) return
        const rendered = typeof node.type === 'function' ? node.type(node.props) : node
        if (rendered === null || rendered === undefined) return
        rows.push(named(node, 'BotRow') ? node.props.bot.id : `room:${node.props.room.id}`)
      })
      return rows.sort()
    },
    // The member BotRows an open group row carries.
    membersOf: (roomId) => {
      const found = []
      walk(tree, (node) => {
        if (!named(node, 'RoomRow') || node.props.room.id !== roomId) return
        walk(unwrapRoom(node), inner => {
          if (named(inner, 'BotRow')) found.push(inner.props.bot.id)
        })
      })
      return found
    },
    memberRow: (roomId, botId) => {
      let row = null
      walk(tree, (node) => {
        if (!named(node, 'RoomRow') || node.props.room.id !== roomId) return
        walk(unwrapRoom(node), inner => { if (named(inner, 'BotRow') && inner.props.bot.id === botId) row = inner })
      })
      return row
    },
  }
}

const writerBot = { id: 'writer', name: 'Writer', createdAt: 1 }
const painterBot = { id: 'painter', name: 'Painter', createdAt: 2 }
const rosterWith = (rooms, bots = [writerBot, painterBot]) => ({
  bots, rooms, agents: [], byId: Object.fromEntries(bots.map(bot => [bot.id, bot])),
  mainBotId: 'chief', ready: true, exchangeTurns: {},
})
const chief = { id: 'chief', name: 'Chief', createdAt: 0 }

test('a Bot that joins a group leaves the top of the list and returns when it leaves', () => {
  const joined = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer'], createdAt: 2 }]) })
  // Painter was never in a group and keeps its top row; Writer lives under the group now.
  assert.deepEqual(joined.top(), ['painter', 'room:room'])
  const left = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: [], createdAt: 2 }]) })
  assert.deepEqual(left.top(), ['painter', 'room:room', 'writer'])
})

test('a hidden group hides no one: its members keep their top rows', () => {
  const side = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer'], hidden: true, createdAt: 2 }]) })
  assert.deepEqual(side.top(), ['painter', 'writer'])
})

test('an open group shows its members under its row and a member row opens the Bot chat', () => {
  const side = sidebar({
    activeId: 'room',
    roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'painter'], createdAt: 2 }]),
  })
  assert.deepEqual(side.membersOf('room'), ['writer', 'painter'])
  side.memberRow('room', 'writer').props.actions.openSession('picked')
  assert.deepEqual(side.calls, [['openSession', 'picked']])
})

test('a closed group keeps its members folded', () => {
  const side = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer'], createdAt: 2 }]) })
  assert.deepEqual(side.membersOf('room'), [])
})

test('a pinned member keeps its own top row and stays out of the member list', () => {
  const pinned = { ...writerBot, pinned: true }
  const side = sidebar({
    activeId: 'room',
    roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'painter'], createdAt: 2 }], [pinned, painterBot]),
  })
  // Writer pins to the top despite its membership; painter, a plain member, lives
  // under the group alone.
  assert.deepEqual(side.top(), ['room:room', 'writer'])
  assert.deepEqual(side.membersOf('room'), ['painter'])
})

test('the Main Bot never joins the member list, however many groups it is in', () => {
  const side = sidebar({
    activeId: 'room',
    roster: rosterWith([
      { id: 'room', name: 'Team', members: ['chief', 'writer'], createdAt: 2 },
      { id: 'room2', name: 'Ops', members: ['chief'], createdAt: 3 },
    ], [chief, writerBot, painterBot]),
  })
  assert.deepEqual(side.membersOf('room'), ['writer'])
  assert.deepEqual(side.membersOf('room2'), [])
  // The Main Bot keeps its own row at the top of the list whatever it belongs to.
  assert.deepEqual(side.top(), ['chief', 'painter', 'room:room', 'room:room2'])
})

test('a Bot in two groups shows under each group in turn', () => {
  const rooms = [
    { id: 'room', name: 'Team', members: ['writer'], createdAt: 2 },
    { id: 'room2', name: 'Ops', members: ['writer'], createdAt: 3 },
  ]
  const inTeam = sidebar({ activeId: 'room', roster: rosterWith(rooms) })
  assert.deepEqual(inTeam.membersOf('room'), ['writer'])
  assert.deepEqual(inTeam.membersOf('room2'), [])
  assert.deepEqual(inTeam.top(), ['painter', 'room:room', 'room:room2'])
  const inOps = sidebar({ activeId: 'room2', roster: rosterWith(rooms) })
  assert.deepEqual(inOps.membersOf('room2'), ['writer'])
  assert.deepEqual(inOps.membersOf('room'), [])
})

test('a member who is gone from the roster is not listed, and a stale membership keeps no one from the top', () => {
  const side = sidebar({ activeId: 'room', roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'gone'], createdAt: 2 }], [writerBot]) })
  assert.deepEqual(side.membersOf('room'), ['writer'])
  assert.deepEqual(side.top(), ['room:room'])
})
