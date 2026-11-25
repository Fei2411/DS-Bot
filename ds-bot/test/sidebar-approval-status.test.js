import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { watchBotCompletions } from '../src/client/bot-completions.js'
import { createSource } from '../src/client/sources.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'; export { waitsOf, waitLineOf } from './src/client/inbox.js'", resolveDir: PLUGIN },
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
const { TeamSidebar, waitsOf, waitLineOf } = module.exports

// What waits for the user, as the host's inbox lists it (src/host/inbox.js; its items'
// shape is pinned by test/inbox.test.js against the state each module writes).
const GROUPS = { learning: 'suggest', blocked: 'fix', model: 'fix', paused: 'fix', 'room-paused': 'fix' }
const waiting = (...entries) => {
  const items = entries.map(([kind, ref, place], index) => ({ id: `${kind}:${ref}`, kind, group: GROUPS[kind] ?? 'decide', ref, at: index + 1, ...place }))
  const counts = { decide: 0, fix: 0, suggest: 0 }
  for (const item of items) counts[item.group] += 1
  return { inbox: { count: items.length, counts, items } }
}

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
  botCompletions,
  projectionsBySession,
  unread = {},
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
  const list = { ids: activeSession ? [activeSession] : [], byId: activeSession ? { [activeSession]: { id: activeSession, retainedBy: { mainView: 1 } } } : {}, projectionsBySession }
  if (botCompletions === undefined) {
    const snapshot = createSource({})
    watchBotCompletions({ roster: createSource(roster), sessions: createSource(list), statuses: createSource(statusMap), unread: snapshot })()
    botCompletions = snapshot.getSnapshot()
  }
  const tree = TeamSidebar({
    actions: noopActions,
    useSidebarPref: () => (wide ? 'open' : 'rail'),
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick(list),
    useBotCompletions: pick => pick(botCompletions),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap),
    useSessionRetainInfo: (id, pick) => pick(id === activeSession ? { retainedBy: { mainView: 1 } } : {}),
    useActivity: pick => pick(activity),
    useWork: pick => pick(work),
    useComputer: pick => pick(computer),
  })
  return expand(tree)
}

test('only a visible completion sets the Bot row unread dot', () => {
  const part = 'writer-p2'
  const bot = { id: 'writer', sessionId: part, name: 'Writer', createdAt: 1 }
  const visible = { turn: 1, prompt: 'Earlier question', response: 'Earlier reply' }
  const hidden = { turn: 2, prompt: 'Bot question', response: 'Private reply' }
  const reply = { turn: 3, prompt: 'User question', response: 'User reply' }
  const rowState = (turnOutline, status = { completionUnread: true }, extra = {}) => {
    const tree = renderSidebar({
      bots: [bot],
      rosterExtra: { exchangeTurns: { [part]: [hidden.turn] } },
      projectionsBySession: { [part]: { values: { turnOutline } } },
      statusMap: new Map([[part, status]]),
      ...extra,
    })
    const [row] = walk(tree, node => node.props?.['data-bot-id'] === bot.id)
    assert.ok(row)
    return {
      dot: walk(row, node => node.props?.className === 'bt-unread').length === 1,
      preview: textOf(walk(row, node => classes(node).includes('bt-row-preview'))[0]),
    }
  }
  assert.deepEqual(rowState([hidden]), { dot: false, preview: '' })
  assert.deepEqual(rowState([visible, hidden]), { dot: false, preview: 'Earlier reply' })
  assert.deepEqual(rowState([visible, hidden, reply]), { dot: true, preview: 'User reply' })
  assert.equal(rowState([visible, hidden, reply], { completionUnread: false }, { activeSession: part }).dot, false)
  assert.equal(rowState([hidden], { completionUnread: true, pendingInteraction: {} }).dot, true)
  assert.equal(rowState([hidden], { completionUnread: false }, { unread: { [bot.id]: true } }).dot, true)
})

test('a hidden exchange preserves a preceding unread reply in the Bot row and collapsed section until viewed', (t) => {
  const id = 'writer'
  const bot = { id, name: 'Writer', createdAt: 1 }
  const exchangeTurns = { [id]: [2, 3] }
  const visible = { turn: 1, response: 'Earlier unread reply' }
  const hidden = { turn: 2, response: 'Private reply' }
  const laterHidden = { turn: 3, response: 'Later private reply' }
  const roster = createSource({ bots: [bot], exchangeTurns })
  const sessions = createSource({ byId: {}, projectionsBySession: { [id]: { values: { turnOutline: [] } } } })
  const statuses = createSource(new Map())
  const unread = createSource({})
  t.after(watchBotCompletions({ roster, sessions, statuses, unread }))
  const show = (turnOutline, active = false) => sessions.set({
    byId: { [id]: { retainedBy: active ? { mainView: 1 } : {} } },
    projectionsBySession: { [id]: { values: { turnOutline } } },
  })
  const setStatus = (running, completionUnread) => statuses.set(new Map([[id, { running, completionUnread }]]))
  const dots = () => {
    const props = {
      bots: [bot],
      rosterExtra: { exchangeTurns },
      projectionsBySession: sessions.getSnapshot().projectionsBySession,
      statusMap: statuses.getSnapshot(),
      botCompletions: unread.getSnapshot(),
    }
    const row = renderSidebar(props)
    const section = renderSidebar({
      ...props,
      bots: [{ ...bot, sectionId: 'section' }],
      sections: [{ id: 'section', name: 'Section', collapsed: true }],
    })
    return [
      walk(row, node => node.props?.className === 'bt-unread').length,
      walk(section, node => node.props?.['data-kind'] === 'unread').length,
    ]
  }

  setStatus(true, false)
  show([visible])
  setStatus(false, true)
  assert.deepEqual(dots(), [1, 1])
  setStatus(true, false)
  show([visible, { ...hidden, response: '' }])
  show([visible, hidden])
  setStatus(false, true)
  assert.deepEqual(dots(), [1, 1])

  show([visible, hidden], true)
  setStatus(false, false)
  show([visible, hidden])
  assert.deepEqual(dots(), [0, 0])
  setStatus(true, false)
  show([visible, hidden, { ...laterHidden, response: '' }])
  setStatus(false, true)
  show([visible, hidden, laterHidden])
  assert.deepEqual(dots(), [0, 0])
})

test('a collapsed section does not show a completion dot for a hidden exchange', () => {
  const id = 'writer'
  const props = {
    bots: [{ id, name: 'Writer', createdAt: 1, sectionId: 'section' }],
    sections: [{ id: 'section', name: 'Section', collapsed: true }],
    rosterExtra: { exchangeTurns: { [id]: [1] } },
    projectionsBySession: { [id]: { values: { turnOutline: [{ turn: 1, response: 'Private reply' }] } } },
    statusMap: new Map([[id, { completionUnread: true }]]),
  }
  const unreadDots = extra => walk(renderSidebar({ ...props, ...extra }), node => node.props?.['data-kind'] === 'unread').length
  assert.equal(unreadDots({}), 0)
  for (const extra of [
    { statusMap: new Map([[id, { completionUnread: true, pendingInteraction: {} }]]) },
    { unread: { [id]: true } },
  ]) {
    assert.equal(unreadDots(extra), 1)
  }
})

test('a chat\'s marks come from the inbox: what stops it, what does not, and its line', () => {
  const lines = (roster, place) => {
    const waits = waitsOf(roster, place)
    return [waitLineOf(waits.blocking), waitLineOf(waits.deferred), waits.any]
  }
  assert.deepEqual(lines({}, { botId: 'reviewer' }), [null, null, false])
  assert.deepEqual(lines(waiting(['learning', 'p1', { botId: 'reviewer' }]), { botId: 'reviewer' }), [null, 'Waiting for your approval', true])
  for (const kind of ['secret', 'connector', 'mail', 'approval', 'computer']) {
    assert.deepEqual(lines(waiting([kind, 'r1', { botId: 'reviewer' }]), { botId: 'reviewer' }), ['Waiting for your approval', null, true], kind)
  }
  for (const kind of ['question', 'view']) {
    assert.deepEqual(lines(waiting([kind, 'q1', { botId: 'reviewer', sessionId: 'reviewer-p2' }]), { botId: 'reviewer' }), ['Waiting for your answer', null, true], kind)
  }
  assert.deepEqual(lines(waiting(['handoff', 'call-1', { botId: 'reviewer' }]), { botId: 'reviewer' }), ['Waiting for you', null, true])
  assert.deepEqual(lines(waiting(['blocked', 'reviewer', { botId: 'reviewer' }]), { botId: 'reviewer' }), [null, 'Needs a fix', true])
  // A background task's card does not stop the chat.
  assert.deepEqual(lines(waiting(['question', 'q2', { botId: 'reviewer', taskId: 't1' }]), { botId: 'reviewer' }), [null, 'Waiting for your answer', true])
  // A card asked in a group marks the group, not the member's own chat (#1623).
  const group = waiting(['question', 'q3', { botId: 'reviewer', roomId: 'r1' }], ['room-paused', 'r1', { roomId: 'r1' }], ['goal', 'g1', { botId: 'reviewer', roomId: 'r1' }])
  assert.deepEqual(lines(group, { botId: 'reviewer' }), [null, null, false])
  assert.deepEqual(lines(group, { roomId: 'r1' }), ['Waiting for your answer', 'Paused', true])
})

test('a Bot with a pending skill learning proposal shows alert badge, approval status text, and wait dot', () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const learning = waiting(['learning', 'p1', { botId: 'reviewer' }])

  // Inactive in wide sidebar: avatar ? badge, "Waiting for your approval" line, and amber wait dot.
  const inactiveWide = renderSidebar({ bots: [reviewer], rosterExtra: learning })
  const [row] = walk(inactiveWide, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.ok(row !== undefined)
  assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1)
  const [preview] = walk(row, node => classes(node).includes('bt-row-preview'))
  assert.ok(preview !== undefined)
  assert.ok(classes(preview).includes('bt-row-preview-wait'))
  assert.equal(textOf(preview), 'Waiting for your approval')
  assert.equal(walk(row, node => classes(node).includes('bt-unread-wait')).length, 1)

  // Active in wide sidebar: still shows avatar ? badge and "Waiting for your approval", hides unread dot.
  const activeWide = renderSidebar({ bots: [reviewer], rosterExtra: learning, activeSession: 'reviewer' })
  const [activeRow] = walk(activeWide, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(activeRow, node => classes(node).includes('bt-badge-alert')).length, 1)
  assert.equal(textOf(walk(activeRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your approval')
  assert.equal(walk(activeRow, node => classes(node).includes('bt-unread-wait')).length, 0)

  // Inactive on narrow rail: amber wait dot.
  const rail = renderSidebar({ bots: [reviewer], rosterExtra: learning, wide: false })
  const [railRow] = walk(rail, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(railRow, node => classes(node).includes('bt-dot-wait')).length, 1)
})

test('a Bot running a new turn while a non-blocking learning proposal waits keeps live work text and amber wait dot', () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const tree = renderSidebar({
    bots: [reviewer],
    rosterExtra: waiting(['learning', 'p1', { botId: 'reviewer' }]),
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
    rosterExtra: waiting(['approval', 'a1', { botId: 'coder', sessionId: 'coder', tool: 'bash' }]),
  })
  const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'coder')
  assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1)
  const [preview] = walk(row, node => classes(node).includes('bt-row-preview-wait'))
  assert.equal(textOf(preview), 'Waiting for your approval')

  // Unanswerable approvals are not the user's (the inbox leaves them out), so nothing marks
  // the Bot, Room, or collapsed Section, even when host activityView() reports 'alert'.
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
    rosterExtra: waiting(['learning', 'p1', { botId: 'reviewer' }], ['approval', 'a1', { botId: 'reviewer', roomId: 'r1', tool: 'bash' }]),
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
  })
  const [botRow] = walk(tree, node => node.props?.['data-bot-id'] === 'reviewer')
  assert.equal(walk(botRow, node => classes(node).includes('bt-badge-alert')).length, 0)
  assert.equal(walk(botRow, node => classes(node).includes('bt-badge-working')).length, 1)
})

test('a Bot with both a blocking question and a non-blocking learning proposal reports "Waiting for your answer" consistently', () => {
  const ops = { id: 'ops', name: 'Ops', createdAt: 1 }
  const tree = renderSidebar({
    bots: [ops],
    rosterExtra: waiting(['question', 'q1', { botId: 'ops', sessionId: 'ops', text: 'Confirm?' }], ['learning', 'p1', { botId: 'ops' }]),
  })
  const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(textOf(walk(row, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your answer')
  assert.match(row.props['aria-label'], /Waiting for your answer/)
  assert.doesNotMatch(row.props['aria-label'], /Waiting for your approval/)
})

test('a running Bot paused on a secret, connector, mail, question, or view card wears the alert mark and status line', () => {
  const bot = { id: 'ops', name: 'Ops', createdAt: 1 }
  const cases = [
    [waiting(['secret', 's1', { botId: 'ops', sessionId: 'ops' }]), 'Waiting for your approval'],
    [waiting(['connector', 'c1', { botId: 'ops', sessionId: 'ops' }]), 'Waiting for your approval'],
    [waiting(['mail', 'm1', { botId: 'ops', sessionId: 'ops' }]), 'Waiting for your approval'],
    [waiting(['question', 'q1', { botId: 'ops', sessionId: 'ops' }]), 'Waiting for your answer'],
    [waiting(['view', 'v1', { botId: 'ops', sessionId: 'ops' }]), 'Waiting for your answer'],
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
    work: { waiting: {}, rooms: { r1: [{ botId: 'reviewer', tool: 'bash' }] }, approvals: [] },
    rosterExtra: waiting(['approval', 'a1', { botId: 'reviewer', roomId: 'r1', tool: 'bash' }]),
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
    rosterExtra: waiting(['learning', 'p1', { botId: 'reviewer' }]),
  })
  const [status] = walk(wideTree, node => classes(node).includes('bt-sec-status'))
  assert.ok(status !== undefined)
  assert.equal(status.props['data-kind'], 'alert')

  const railTree = renderSidebar({
    bots: [bot],
    sections,
    rosterExtra: waiting(['secret', 's1', { botId: 'reviewer' }]),
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
    rosterExtra: waiting(['learning', 'p1', { botId: 'hidden-bot' }]),
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
    rosterExtra: waiting(['approval', 'a1', { botId: 'ops', taskId: 't1', tool: 'bash' }], ['question', 'q1', { botId: 'ops', sessionId: 'ops' }]),
    activity: { ops: 'alert' },
  })
  const [qRow] = walk(withQuestion, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(textOf(walk(qRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your answer')
  assert.match(qRow.props['aria-label'], /Waiting for your answer/)

  const idleBg = renderSidebar({
    bots: [ops],
    activity: { ops: 'alert' },
    rosterExtra: waiting(['approval', 'a1', { botId: 'ops', taskId: 't1', tool: 'bash' }]),
  })
  const [idleRow] = walk(idleBg, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(walk(idleRow, node => classes(node).includes('bt-badge-alert')).length, 1)
  assert.equal(textOf(walk(idleRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your approval')
})
