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

// Read text from a row by running the components it renders, as the sidebar-switch
// tests do: a row's own preview sits in the button, member rows below have their own.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const textIn = (node, className) => {
  const found = []
  walk(expand(node), inner => { if (inner.props?.className === className) found.push(textOf(inner)) })
  return found.join('|')
}
const ariaLabel = (node) => {
  let label = ''
  walk(expand(node), inner => { if (inner.type === 'button' && label === '') label = inner.props?.['aria-label'] ?? '' })
  return label
}

function sidebar({ activeId = null, roster, statuses = {}, activity = {}, work = { waiting: {}, rooms: {}, approvals: [] } }) {
  const calls = []
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession'].map(name => [name, id => { calls.push([name, id]); return id }]))
  for (const name of ['openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread', 'landOn']) actions[name] = () => {}
  const statusMap = new Map(Object.entries(statuses))
  const retain = (id, pick) => pick(id === activeId ? { retainedBy: { mainView: 1 } } : null)
  const tree = TeamSidebar({
    wide: true, actions,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap), useSessionRetainInfo: retain,
    useActivity: pick => pick(activity), useWork: pick => pick(work),
  })
  const rowOf = (roomId) => {
    let row = null
    walk(tree, (node) => { if (named(node, 'RoomRow') && node.props.room.id === roomId) row = node })
    return row
  }
  const buttonOf = (roomId) => unwrapRoom(rowOf(roomId)).props.children[0]
  const memberRowOf = (roomId, botId) => {
    let row = null
    walk(unwrapRoom(rowOf(roomId)), (inner) => { if (named(inner, 'BotRow') && inner.props.bot.id === botId) row = inner })
    return row
  }
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
      walk(unwrapRoom(rowOf(roomId)), inner => {
        if (named(inner, 'BotRow')) found.push(inner.props.bot.id)
      })
      return found
    },
    memberRow: (roomId, botId) => memberRowOf(roomId, botId),
    // A group row's own preview, read from its button — never from a member row.
    roomPreview: (roomId) => textIn(buttonOf(roomId), 'bt-row-preview'),
    roomLabel: (roomId) => ariaLabel(buttonOf(roomId)),
    memberPreview: (roomId, botId) => textIn(memberRowOf(roomId, botId), 'bt-row-preview'),
    memberLabel: (roomId, botId) => ariaLabel(memberRowOf(roomId, botId)),
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

test('a folded group says how many Bots it holds', () => {
  const side = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'painter'], createdAt: 2 }]) })
  assert.equal(side.roomPreview('room'), '2 members')
})

test('a folded group keeps the count beside its last message', () => {
  const side = sidebar({ roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'painter'], preview: '  On   it ', createdAt: 2 }]) })
  assert.equal(side.roomPreview('room'), '2 members · On it')
})

test('an open group leaves the member list to name its members', () => {
  const side = sidebar({ activeId: 'room', roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer', 'painter'], preview: 'On it', createdAt: 2 }]) })
  assert.equal(side.roomPreview('room'), 'On it')
})

test('a member row follows its own chat, not work in another group', () => {
  const rooms = [
    { id: 'room', name: 'Team', members: ['writer'], createdAt: 2 },
    { id: 'room2', name: 'Ops', members: ['writer'], createdAt: 3 },
  ]
  const side = sidebar({
    activeId: 'room',
    roster: rosterWith(rooms),
    work: { waiting: {}, approvals: [], rooms: { room2: [{ botId: 'writer', tool: 'grep' }] } },
  })
  // Writer works in Ops: the Ops row names it, and the member row under Team stays
  // quiet instead of claiming the Bot runs here.
  assert.match(side.roomPreview('room2'), /^Writer · /)
  assert.equal(side.memberPreview('room', 'writer'), '')
  assert.doesNotMatch(side.memberLabel('room', 'writer'), /Working/)
})

test('a member row still shows the Bot working in its own chat', () => {
  const side = sidebar({
    activeId: 'room',
    roster: rosterWith([{ id: 'room', name: 'Team', members: ['writer'], createdAt: 2 }]),
    statuses: { writer: { running: true } },
    activity: { writer: 'working' },
  })
  assert.match(side.memberPreview('room', 'writer'), /^.+…$/)
  assert.match(side.memberLabel('room', 'writer'), /Working/)
})

test('a group approval stays on its group row, while the own chat approval shows on the member row', () => {
  const rooms = [
    { id: 'room', name: 'Team', members: ['writer'], createdAt: 2 },
    { id: 'room2', name: 'Ops', members: ['writer'], createdAt: 3 },
  ]
  const inGroup = sidebar({
    activeId: 'room',
    roster: rosterWith(rooms),
    work: { waiting: {}, rooms: {}, approvals: [{ botId: 'writer', roomId: 'room2', tool: 'shell', reason: 'x' }] },
  })
  assert.match(inGroup.roomLabel('room2'), /Waiting for your approval/)
  assert.doesNotMatch(inGroup.memberLabel('room', 'writer'), /Waiting for your approval/)

  const ownChat = sidebar({
    activeId: 'room',
    roster: rosterWith(rooms),
    work: { waiting: {}, rooms: {}, approvals: [{ botId: 'writer', tool: 'shell', reason: 'x' }] },
  })
  assert.match(ownChat.memberLabel('room', 'writer'), /Waiting for your approval/)
})
