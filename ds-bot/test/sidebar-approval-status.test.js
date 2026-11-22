import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar, botPendingOf } from './src/client/sidebar.js'", resolveDir: PLUGIN },
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
  document: { body: {}, documentElement: { hasAttribute: () => false }, querySelector: () => null },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : {}),
})
const { TeamSidebar, botPendingOf } = module.exports

const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const classes = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)

const noopActions = Object.fromEntries(
  ['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread', 'openTaskDeck', 'saveSection', 'beginSectionRename', 'endSectionRename', 'reportError'].map(name => [name, () => {}]),
)

function renderSidebar({
  bots = [],
  rooms = [],
  sections = [],
  rosterExtra = {},
  work = { waiting: {}, rooms: {}, approvals: [] },
  computer = { asks: {} },
  activity = {},
  statusMap = new Map(),
  activeSession = null,
  wide = true,
} = {}) {
  const byId = Object.fromEntries(bots.flatMap(bot => [[bot.id, bot], ...(bot.sessionId ? [[bot.sessionId, bot]] : [])]))
  const roomsById = Object.fromEntries(rooms.flatMap(room => [[room.id, room], ...(room.sessionId ? [[room.sessionId, room]] : [])]))
  const roster = {
    bots, rooms, agents: [], sections, byId, roomsById, agentsById: {},
    exchangeTurns: {}, questions: {}, views: {}, learning: {},
    secretRequests: {}, connectorRequests: {}, mailRequests: {},
    ready: true, ...rosterExtra,
  }
  const tree = TeamSidebar({
    actions: noopActions,
    useSidebarPref: () => (wide ? 'open' : 'rail'),
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread: {} }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: activeSession ? [activeSession] : [], byId: activeSession ? { [activeSession]: { id: activeSession, retainedBy: { mainView: 1 } } } : {} }),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap),
    useSessionRetainInfo: (id, pick) => pick(id === activeSession ? { retainedBy: { mainView: 1 } } : {}),
    useActivity: pick => pick(activity),
    useWork: pick => pick(work),
    useComputer: pick => pick(computer),
  })
  return expand(tree)
}

test('botPendingOf detects learning proposals, pending request cards, questions and views on current part', () => {
  const bot = { id: 'reviewer', sessionId: 'reviewer-p2', name: 'Reviewer' }
  const plain = value => ({ ...value })
  assert.deepEqual(plain(botPendingOf({}, bot)), { learning: false, cardApproval: false, question: false })
  assert.deepEqual(plain(botPendingOf({ learning: { reviewer: [{ id: 'p1', kind: 'skill', name: 's1' }] } }, bot)), { learning: true, cardApproval: false, question: false })
  assert.deepEqual(plain(botPendingOf({ learning: { reviewer: [] } }, bot)), { learning: false, cardApproval: false, question: false })
  assert.deepEqual(plain(botPendingOf({ secretRequests: { reviewer: [{ id: 's1', status: 'answered' }] } }, bot)), { learning: false, cardApproval: false, question: false })
  assert.deepEqual(plain(botPendingOf({ secretRequests: { reviewer: [{ id: 's1', status: 'pending' }] } }, bot)), { learning: false, cardApproval: true, question: false })
  assert.deepEqual(plain(botPendingOf({ connectorRequests: { reviewer: [{ id: 'c1', status: 'pending' }] } }, bot)), { learning: false, cardApproval: true, question: false })
  assert.deepEqual(plain(botPendingOf({ mailRequests: { reviewer: [{ id: 'm1', status: 'pending' }] } }, bot)), { learning: false, cardApproval: true, question: false })
  assert.deepEqual(plain(botPendingOf({ questions: { 'reviewer-p2': { id: 'q1' } } }, bot)), { learning: false, cardApproval: false, question: true })
  assert.deepEqual(plain(botPendingOf({ views: { 'reviewer-p2': { id: 'v1' } } }, bot)), { learning: false, cardApproval: false, question: true })
  // An old part's question does not mark the current part.
  assert.deepEqual(plain(botPendingOf({ questions: { reviewer: { id: 'q0' } } }, bot)), { learning: false, cardApproval: false, question: false })
})

test('a Bot with a pending skill learning proposal shows alert badge, approval status text, and wait dot', () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const learning = { reviewer: [{ id: 'p1', kind: 'skill', name: 'stateful-regression-review' }] }

  // Inactive in wide sidebar: avatar ? badge, "Waiting for your approval" line, and amber wait dot.
  const inactiveWide = renderSidebar({ bots: [reviewer], rosterExtra: { learning } })
  const [row] = walk(inactiveWide, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.ok(row !== undefined)
  assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1)
  const [preview] = walk(row, node => classes(node).includes('bt-row-preview'))
  assert.ok(preview !== undefined)
  assert.ok(classes(preview).includes('bt-row-preview-wait'))
  assert.equal(textOf(preview), 'Waiting for your approval')
  assert.equal(walk(row, node => classes(node).includes('bt-unread-wait')).length, 1)

  // Active in wide sidebar: still shows avatar ? badge and "Waiting for your approval", hides unread dot.
  const activeWide = renderSidebar({ bots: [reviewer], rosterExtra: { learning }, activeSession: 'reviewer' })
  const [activeRow] = walk(activeWide, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(activeRow, node => classes(node).includes('bt-badge-alert')).length, 1)
  assert.equal(textOf(walk(activeRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your approval')
  assert.equal(walk(activeRow, node => classes(node).includes('bt-unread-wait')).length, 0)

  // Inactive on narrow rail: amber wait dot.
  const rail = renderSidebar({ bots: [reviewer], rosterExtra: { learning }, wide: false })
  const [railRow] = walk(rail, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(railRow, node => classes(node).includes('bt-dot-wait')).length, 1)
})

test('a Bot running a new turn while a non-blocking learning proposal waits keeps live work text and amber wait dot', () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const tree = renderSidebar({
    bots: [reviewer],
    rosterExtra: { learning: { reviewer: [{ id: 'p1', kind: 'agents' }] } },
    activity: { reviewer: 'working' },
    statusMap: new Map([['reviewer', { running: true }]]),
  })
  const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'reviewer')
  const [preview] = walk(row, node => classes(node).includes('bt-row-preview'))
  assert.ok(!classes(preview).includes('bt-row-preview-wait'))
  assert.match(textOf(preview), /^.+…$/)
  assert.equal(walk(row, node => classes(node).includes('bt-unread-wait')).length, 1)
})

test('a running Bot paused on a tool approval shows "Waiting for your approval", never "On it…"', () => {
  const bot = { id: 'coder', name: 'Coder', createdAt: 1 }
  const tree = renderSidebar({
    bots: [bot],
    activity: { coder: 'alert' },
    statusMap: new Map([['coder', { running: true }]]),
    work: { waiting: {}, rooms: {}, approvals: [{ id: 'a1', botId: 'coder' }] },
  })
  const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'coder')
  assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1)
  const [preview] = walk(row, node => classes(node).includes('bt-row-preview-wait'))
  assert.equal(textOf(preview), 'Waiting for your approval')

  // Unanswerable approvals do not mark the Bot, Room, or collapsed Section as waiting for approval,
  // even when host activityView() reports 'alert' for that Bot.
  const room = { id: 'r1', name: 'Ops Room', members: ['coder'], sectionId: 'sec-1', createdAt: 2 }
  const unanswerable = renderSidebar({
    bots: [{ ...bot, sectionId: 'sec-1' }],
    rooms: [room],
    sections: [{ id: 'sec-1', name: 'Ops', collapsed: true }],
    activity: { coder: 'alert' },
    statusMap: new Map([['coder', { running: true }]]),
    work: {
      waiting: {},
      rooms: {},
      approvals: [
        { id: 'a2', botId: 'coder', answerable: false },
        { id: 'a3', botId: 'coder', roomId: 'r1', answerable: false },
      ],
    },
  })
  const [quietRow] = walk(unanswerable, node => node.props?.['data-bot-id'] === 'coder')
  const [quietRoom] = walk(unanswerable, node => node.props?.['data-room-id'] === 'r1')
  assert.equal(walk(quietRow, node => classes(node).includes('bt-badge-alert')).length, 0)
  assert.equal(walk(quietRow, node => classes(node).includes('bt-row-preview-wait')).length, 0)
  assert.equal(walk(quietRoom, node => classes(node).includes('bt-row-preview-wait')).length, 0)
  assert.equal(walk(quietRoom, node => classes(node).includes('bt-unread-wait')).length, 0)
  const [secStatus] = walk(unanswerable, node => classes(node).includes('bt-sec-status'))
  assert.equal(secStatus?.props?.['data-kind'], 'working')
})

test('a group approval does not leak alert badge onto a running DM Bot that also has a non-blocking learning proposal', () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const room = { id: 'r1', name: 'Review Group', members: ['reviewer'], createdAt: 2 }
  const tree = renderSidebar({
    bots: [reviewer],
    rooms: [room],
    rosterExtra: { learning: { reviewer: [{ id: 'p1', kind: 'skill', name: 's1' }] } },
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
    work: { waiting: {}, rooms: {}, approvals: [{ id: 'a1', botId: 'reviewer', roomId: 'r1' }] },
  })
  const [botRow] = walk(tree, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(botRow, node => classes(node).includes('bt-badge-alert')).length, 0)
  assert.equal(walk(botRow, node => classes(node).includes('bt-badge-working')).length, 1)
})

test('a Bot with both a blocking question and a non-blocking learning proposal reports "Waiting for your answer" consistently', () => {
  const ops = { id: 'ops', name: 'Ops', createdAt: 1 }
  const tree = renderSidebar({
    bots: [ops],
    rosterExtra: {
      learning: { ops: [{ id: 'p1', kind: 'skill', name: 's1' }] },
      questions: { ops: { id: 'q1', question: 'Confirm?' } },
    },
  })
  const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(textOf(walk(row, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your answer')
  assert.match(row.props['aria-label'], /Waiting for your answer/)
  assert.doesNotMatch(row.props['aria-label'], /Waiting for your approval/)
})

test('a running Bot paused on a secret, connector, mail, question, or view card wears the alert mark and status line', () => {
  const bot = { id: 'ops', name: 'Ops', createdAt: 1 }
  const cases = [
    [{ secretRequests: { ops: [{ id: 's1', status: 'pending' }] } }, 'Waiting for your approval'],
    [{ connectorRequests: { ops: [{ id: 'c1', status: 'pending' }] } }, 'Waiting for your approval'],
    [{ mailRequests: { ops: [{ id: 'm1', status: 'pending' }] } }, 'Waiting for your approval'],
    [{ questions: { ops: { id: 'q1', question: 'Which env?' } } }, 'Waiting for your answer'],
    [{ views: { ops: { id: 'v1', title: 'Review' } } }, 'Waiting for your answer'],
  ]
  for (const [rosterExtra, expected] of cases) {
    // Host clears `activity` on ask_user / request_secret while the turn is still running.
    const tree = renderSidebar({
      bots: [bot],
      rosterExtra,
      activity: {},
      statusMap: new Map([['ops', { running: true }]]),
    })
    const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'ops')
    assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1, expected)
    assert.equal(textOf(walk(row, node => classes(node).includes('bt-row-preview-wait'))[0]), expected)
  }
})

test('a group approval shows "Waiting for your approval" on the group row without marking the member DM (#1623)', () => {
  const bot = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const room = { id: 'r1', name: 'Review Group', members: ['reviewer'], createdAt: 2 }
  const tree = renderSidebar({
    bots: [bot],
    rooms: [room],
    activity: { reviewer: 'alert' },
    work: { waiting: {}, rooms: { r1: [{ botId: 'reviewer', tool: 'bash' }] }, approvals: [{ id: 'a1', botId: 'reviewer', roomId: 'r1' }] },
  })
  const [botRow] = walk(tree, node => node.props?.['data-bot-id'] === 'reviewer')
  const [roomRow] = walk(tree, node => node.props?.['data-room-id'] === 'r1')
  assert.equal(walk(botRow, node => classes(node).includes('bt-badge-alert')).length, 0)
  assert.equal(walk(botRow, node => classes(node).includes('bt-row-preview-wait')).length, 0)
  assert.equal(textOf(walk(roomRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your approval')
  assert.equal(walk(roomRow, node => classes(node).includes('bt-unread-wait')).length, 1)
})

test('a collapsed sidebar section surfaces alert status for pending learning and request cards inside it', () => {
  const bot = { id: 'reviewer', name: 'Reviewer', sectionId: 'sec-1', createdAt: 1 }
  const sections = [{ id: 'sec-1', name: 'Review', collapsed: true }]
  const wideTree = renderSidebar({
    bots: [bot],
    sections,
    rosterExtra: { learning: { reviewer: [{ id: 'p1', kind: 'skill', name: 'stateful-regression-review' }] } },
  })
  const [status] = walk(wideTree, node => classes(node).includes('bt-sec-status'))
  assert.ok(status !== undefined)
  assert.equal(status.props['data-kind'], 'alert')

  const railTree = renderSidebar({
    bots: [bot],
    sections,
    rosterExtra: { secretRequests: { reviewer: [{ id: 's1', status: 'pending' }] } },
    wide: false,
  })
  const [railDot] = walk(railTree, node => classes(node).includes('bt-dot-wait'))
  assert.ok(railDot !== undefined)

  // An inactive hidden Bot with a pending card does not trigger an alert on its collapsed section.
  const hiddenOnly = renderSidebar({
    bots: [
      { id: 'hidden-bot', name: 'Hidden', sectionId: 'sec-1', hidden: true, createdAt: 1 },
      { id: 'visible-bot', name: 'Visible', sectionId: 'sec-1', createdAt: 2 },
    ],
    sections,
    rosterExtra: { learning: { 'hidden-bot': [{ id: 'p1', kind: 'skill', name: 's1' }] } },
  })
  assert.equal(walk(hiddenOnly, node => classes(node).includes('bt-sec-status')).length, 0)
})

test('a background task approval does not mask a foreground question, and still shows approval when idle', () => {
  const ops = {
    id: 'ops', name: 'Ops', createdAt: 1,
    tasks: [{ id: 't1', status: 'waiting_approval', title: 'Deploy' }],
  }
  const withQuestion = renderSidebar({
    bots: [ops],
    rosterExtra: { questions: { ops: { id: 'q1', question: 'Which env?' } } },
    activity: { ops: 'alert' },
    work: { waiting: {}, rooms: {}, approvals: [{ id: 'a1', botId: 'ops', taskId: 't1' }] },
  })
  const [qRow] = walk(withQuestion, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(textOf(walk(qRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your answer')
  assert.match(qRow.props['aria-label'], /Waiting for your answer/)

  const idleBg = renderSidebar({
    bots: [ops],
    activity: { ops: 'alert' },
    work: { waiting: {}, rooms: {}, approvals: [{ id: 'a1', botId: 'ops', taskId: 't1' }] },
  })
  const [idleRow] = walk(idleBg, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(walk(idleRow, node => classes(node).includes('bt-badge-alert')).length, 1)
  assert.equal(textOf(walk(idleRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your approval')
})
