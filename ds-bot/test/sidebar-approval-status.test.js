import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { watchBotCompletions } from '../src/client/bot-completions.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { waitsOf, waitLineOf } from './src/client/inbox.js'\nexport { HeaderPill } from './src/client/header.js'\nexport { DetailsDrawer } from './src/client/details-drawer.js'", resolveDir: PLUGIN },
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
const { TeamSidebar, HeaderPill, DetailsDrawer, waitsOf, waitLineOf } = module.exports

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
  computer = { asks: {}, holds: {} },
  browserHolds = {},
  markedUnread = {},
  activity = {},
  statusMap = new Map(),
  botCompletions,
  projectionsBySession,
  unread = {},
  activeSession = null,
  wide = true,
  actions = noopActions,
  sectionFolds,
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
    actions,
    useSidebarPref: () => (wide ? 'open' : 'rail'),
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread: { ...unread, ...markedUnread }, sectionFolds }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick(list),
    useBotCompletions: pick => pick(botCompletions),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap),
    useSessionRetainInfo: (id, pick) => pick(id === activeSession ? { retainedBy: { mainView: 1 } } : {}),
    useActivity: pick => pick(activity),
    useWork: pick => pick(work),
    useComputer: pick => pick(computer),
    useBrowserHolds: pick => pick(browserHolds),
  })
  return expand(tree)
}

test('a sidebar section folds before the save finishes and opens again if saving fails', async () => {
  const sections = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]
  const roster = createSource({ sections })
  const ui = createSource({})
  const write = Promise.withResolvers()
  const sent = []
  const errors = []
  const actions = {
    ...noopActions,
    ...teamActions({
      roster, ui,
      call: (mode, payload) => { sent.push([mode, { ...payload }]); return write.promise },
      after: () => assert.fail('folding should not pull the roster again'),
    }),
    reportError: (error, where) => { errors.push([error.message, where]) },
  }
  const headers = () => walk(renderSidebar({
    actions, sections: roster.getSnapshot().sections, sectionFolds: ui.getSnapshot().sectionFolds,
  }), node => classes(node).includes('bt-sec-head'))
  headers()[0].props.onClick()
  assert.deepEqual(headers().map(header => header.props['aria-expanded']), [false, true])
  assert.equal(roster.getSnapshot().sections, sections)
  await Promise.resolve()
  assert.deepEqual(sent, [['section-save', { id: 'one', collapsed: true, withRevision: true }]])
  write.reject(new Error('save failed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(headers().map(header => header.props['aria-expanded']), [true, true])
  assert.deepEqual(errors, [['save failed', 'section']])
})

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

test('a Bot row shows between turns a failed turn, background tasks and an unread reply in its mark, with no badge', () => {
  const stateOf = (tree, id) => walk(tree, node => node.props?.['data-bot-id'] === id).flatMap(row => walk(row, node => node.props?.['data-state'] !== undefined))[0]?.props['data-state']
  const badges = (tree, id) => walk(walk(tree, node => node.props?.['data-bot-id'] === id)[0], node => classes(node).includes('bt-badge')).length
  // The host keeps a failed turn on the Bot, under the part it failed in (turns.js).
  const failed = { id: 'f', name: 'Failed', createdAt: 1, sessionId: 'f-2', failures: { 'f-2': { turn: 4, code: 'NETWORK', message: 'socket hang up', at: 1 } } }
  const stale = { id: 's', name: 'Stale', createdAt: 2, sessionId: 's-2', failures: { s: { turn: 9, code: 'NETWORK', message: 'old', at: 1 } } }
  const tasks = { id: 't', name: 'Tasks', createdAt: 3, tasks: [{ id: 'k1', status: 'running', title: 'Nightly report' }] }
  const done = { id: 'd', name: 'Done', createdAt: 4 }
  const tree = renderSidebar({ bots: [failed, stale, tasks, done], statusMap: new Map([['d', { running: false, completionUnread: true }]]) })
  assert.equal(stateOf(tree, 'f'), 'failed')
  assert.equal(stateOf(tree, 's'), 'idle', 'a failure in an earlier part of the chat no longer shows')
  assert.equal(stateOf(tree, 't'), 'background')
  assert.equal(stateOf(tree, 'd'), 'replied')
  for (const id of ['f', 't', 'd']) assert.equal(badges(tree, id), 0, `${id}: the motion says it, no badge`)
  // Running wins; an open chat has no unread reply.
  const running = renderSidebar({ bots: [failed, done], statusMap: new Map([['f-2', { running: true }], ['d', { running: false, completionUnread: true }]]), activeSession: 'd' })
  assert.equal(stateOf(running, 'f'), 'working')
  assert.equal(stateOf(running, 'd'), 'idle')
  // The roster with the failure is polled; the part's outline is live. Once it lists a
  // later turn (a retry under way, finished or stopped), the failure is behind it.
  const outline = turns => ({ 'f-2': { values: { turnOutline: turns } } })
  const failedTurn = { turn: 4, seq: 31, prompt: 'Check the inbox', response: '' }
  assert.equal(stateOf(renderSidebar({ bots: [failed], projectionsBySession: outline([failedTurn]) }), 'f'), 'failed')
  const retried = renderSidebar({ bots: [failed], projectionsBySession: outline([failedTurn, { turn: 5, seq: 40, prompt: '', response: 'Inbox is clear.' }]), activeSession: 'f-2' })
  assert.equal(stateOf(retried, 'f'), 'idle')
})

test('a running DM keeps its working shimmer line even if stale alert activity arrives alongside group, background-task, or unanswerable approvals', () => {
  const bot = { id: 'reviewer', name: 'Reviewer', createdAt: 1 }
  const room = { id: 'r1', name: 'Review Group', members: ['reviewer'], createdAt: 2 }

  // (a) Group approval + running DM (no learning) keeps runningLine shimmer.
  const groupOnly = renderSidebar({
    bots: [bot],
    rooms: [room],
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
    rosterExtra: waiting(['approval', 'a1', { botId: 'reviewer', roomId: 'r1' }]),
  })
  const [groupOnlyRow] = walk(groupOnly, node => node.props?.['data-bot-id'] === 'reviewer')
  const [groupOnlyPreview] = walk(groupOnlyRow, node => classes(node).includes('bt-row-preview'))
  assert.ok(groupOnlyPreview !== undefined)
  assert.ok(!classes(groupOnlyPreview).includes('bt-row-preview-wait'))
  assert.match(textOf(groupOnlyPreview), /^.+…$/)
  assert.equal(walk(groupOnlyRow, node => classes(node).includes('bt-badge-working')).length, 1)

  // (b) Group approval + running DM + learning keeps runningLine (not "Waiting for your approval").
  const groupAndLearning = renderSidebar({
    bots: [bot],
    rooms: [room],
    rosterExtra: waiting(['approval', 'a1', { botId: 'reviewer', roomId: 'r1' }], ['learning', 'p1', { botId: 'reviewer' }]),
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
  })
  const [glRow] = walk(groupAndLearning, node => node.props?.['data-bot-id'] === 'reviewer')
  const [glPreview] = walk(glRow, node => classes(node).includes('bt-row-preview'))
  assert.ok(glPreview !== undefined)
  assert.ok(!classes(glPreview).includes('bt-row-preview-wait'))
  assert.match(textOf(glPreview), /^.+…$/)
  assert.equal(walk(glRow, node => classes(node).includes('bt-badge-working')).length, 1)
  assert.equal(walk(glRow, node => classes(node).includes('bt-unread-wait')).length, 1)

  // (c) Background task approval + running DM keeps runningLine (not "Waiting for your approval").
  const bgRunning = renderSidebar({
    bots: [bot],
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
    rosterExtra: waiting(['approval', 'a2', { botId: 'reviewer', taskId: 't1' }]),
  })
  const [bgRow] = walk(bgRunning, node => node.props?.['data-bot-id'] === 'reviewer')
  const [bgPreview] = walk(bgRow, node => classes(node).includes('bt-row-preview'))
  assert.ok(bgPreview !== undefined)
  assert.ok(!classes(bgPreview).includes('bt-row-preview-wait'))
  assert.match(textOf(bgPreview), /^.+…$/)
  assert.equal(walk(bgRow, node => classes(node).includes('bt-badge-working')).length, 1)
  assert.equal(walk(bgRow, node => classes(node).includes('bt-unread-wait')).length, 1)

  // (d) Unanswerable approval + running DM keeps runningLine shimmer (the inbox omits unanswerable approvals).
  const unanswerableRunning = renderSidebar({
    bots: [bot],
    activity: { reviewer: 'alert' },
    statusMap: new Map([['reviewer', { running: true }]]),
    work: { waiting: {}, rooms: {}, approvals: [{ id: 'a3', botId: 'reviewer', answerable: false }] },
  })
  const [unansRow] = walk(unanswerableRunning, node => node.props?.['data-bot-id'] === 'reviewer')
  const [unansPreview] = walk(unansRow, node => classes(node).includes('bt-row-preview'))
  assert.ok(unansPreview !== undefined)
  assert.ok(!classes(unansPreview).includes('bt-row-preview-wait'))
  assert.match(textOf(unansPreview), /^.+…$/)
  assert.equal(walk(unansRow, node => classes(node).includes('bt-badge-alert')).length, 0)
  assert.equal(walk(unansRow, node => classes(node).includes('bt-badge-working')).length, 1)

  // (e) Turn-start poll lag (running: true, activity: {}) + non-blocking approval (learning or bgApproval)
  // still renders the working shimmer subtitle instead of falling through to amber approval text.
  for (const extra of [
    { rosterExtra: waiting(['learning', 'p1', { botId: 'reviewer' }]) },
    { rosterExtra: waiting(['approval', 'a4', { botId: 'reviewer', taskId: 't1' }]) },
  ]) {
    const lagTree = renderSidebar({
      bots: [bot],
      activity: {},
      statusMap: new Map([['reviewer', { running: true }]]),
      ...extra,
    })
    const [lagRow] = walk(lagTree, node => node.props?.['data-bot-id'] === 'reviewer')
    const [lagPreview] = walk(lagRow, node => classes(node).includes('bt-row-preview'))
    assert.ok(lagPreview !== undefined)
    assert.ok(!classes(lagPreview).includes('bt-row-preview-wait'))
    assert.equal(textOf(lagPreview), 'On it…')
    assert.equal(walk(lagRow, node => classes(node).includes('bt-badge-working')).length, 1)
    assert.equal(walk(lagRow, node => classes(node).includes('bt-unread-wait')).length, 1)
  }
})

test('browser_handoff and computer_handoff holds surface alert state on BotRow and collapsed SectionBlock, while manual takeovers do not', () => {
  const ops = { id: 'ops', name: 'Ops', sectionId: 'sec-1', createdAt: 1 }
  const sections = [{ id: 'sec-1', name: 'Ops', collapsed: true }]

  // Browser and computer handoffs in the host inbox surface alert on BotRow and collapsed SectionBlock.
  for (const surface of ['browser', 'computer']) {
    const tree = renderSidebar({
      bots: [ops],
      sections,
      rosterExtra: waiting(['handoff', `h-${surface}`, { botId: 'ops', surface }]),
      activity: { ops: 'working' },
      statusMap: new Map([['ops', { running: true }]]),
    })
    const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'ops')
    assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 1)
    assert.equal(textOf(walk(row, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for you')
    assert.equal(walk(row, node => classes(node).includes('bt-unread-wait')).length, 1)
    const [secStatus] = walk(tree, node => classes(node).includes('bt-sec-status'))
    assert.equal(secStatus?.props?.['data-kind'], 'alert')
  }

  // Manual browser/computer takeover or stop (excluded from the host inbox) does NOT alert.
  for (const extra of [
    { browserHolds: { ops: { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' } } },
    { computer: { asks: {}, holds: { ops: { id: 'ch-m', by: 'user', surface: 'computer', reason: 'takeover' } } } },
  ]) {
    const tree = renderSidebar({ bots: [ops], sections, ...extra })
    const [row] = walk(tree, node => node.props?.['data-bot-id'] === 'ops')
    assert.equal(walk(row, node => classes(node).includes('bt-badge-alert')).length, 0)
    assert.equal(walk(row, node => classes(node).includes('bt-row-preview-wait')).length, 0)
    assert.equal(walk(tree, node => classes(node).includes('bt-sec-status')).length, 0)
  }

  // Priority: earlier blocking question in the inbox takes precedence over a later handoff.
  const questionAndHandoff = renderSidebar({
    bots: [ops],
    rosterExtra: waiting(['question', 'q1', { botId: 'ops', at: 1 }], ['handoff', 'bh-1', { botId: 'ops', surface: 'browser', at: 2 }]),
  })
  const [qhRow] = walk(questionAndHandoff, node => node.props?.['data-bot-id'] === 'ops')
  assert.equal(textOf(walk(qhRow, node => classes(node).includes('bt-row-preview-wait'))[0]), 'Waiting for your answer')
})

test('Main Bot tile shows an amber wait dot when busy with a non-blocking approval and hides it when active or idle-alert', () => {
  const chief = { id: 'chief', name: 'Chief', role: 'Lead', createdAt: 1 }
  const learning = { mainBotId: 'chief', ...waiting(['learning', 'p1', { botId: 'chief' }]) }

  // Busy + non-blocking learning proposal + inactive: working avatar + amber .bt-dot-wait on tile.
  const busyTile = renderSidebar({
    bots: [chief],
    rosterExtra: learning,
    activity: { chief: 'working' },
    statusMap: new Map([['chief', { running: true }]]),
  })
  const [tileBtn] = walk(busyTile, node => classes(node).includes('bt-tile'))
  assert.ok(tileBtn !== undefined)
  assert.equal(walk(tileBtn, node => classes(node).includes('bt-badge-working')).length, 1)
  assert.equal(walk(tileBtn, node => classes(node).includes('bt-dot-wait')).length, 1)

  // Active: hides the amber tile dot.
  const activeTile = renderSidebar({
    bots: [chief],
    rosterExtra: learning,
    activity: { chief: 'working' },
    statusMap: new Map([['chief', { running: true }]]),
    activeSession: 'chief',
  })
  const [activeTileBtn] = walk(activeTile, node => classes(node).includes('bt-tile'))
  assert.equal(walk(activeTileBtn, node => classes(node).includes('bt-dot-wait')).length, 0)

  // Idle with approval: avatar wears '?' badge, no redundant corner dot.
  const idleTile = renderSidebar({
    bots: [chief],
    rosterExtra: learning,
  })
  const [idleTileBtn] = walk(idleTile, node => classes(node).includes('bt-tile'))
  assert.equal(walk(idleTileBtn, node => classes(node).includes('bt-badge-alert')).length, 1)
  assert.equal(walk(idleTileBtn, node => classes(node).includes('bt-dot-wait')).length, 0)
})

test('collapsed SectionBlock ignores running and unread state of inactive hidden Bots, while keeping active hidden Bots', () => {
  const hiddenBot = { id: 'hidden-bot', name: 'Hidden', sectionId: 'sec-1', hidden: true, createdAt: 1 }
  const visibleBot = { id: 'visible-bot', name: 'Visible', sectionId: 'sec-1', createdAt: 2 }
  const sections = [{ id: 'sec-1', name: 'Ops', collapsed: true }]

  // Inactive hidden Bot running + completionUnread + botCompletions + pendingInteraction + markedUnread: section stays quiet.
  const hiddenQuiet = renderSidebar({
    bots: [hiddenBot, visibleBot],
    sections,
    statusMap: new Map([['hidden-bot', { running: true, completionUnread: true, pendingInteraction: { id: 'i1' } }]]),
    botCompletions: { 'hidden-bot': true },
    markedUnread: { 'hidden-bot': true },
  })
  assert.equal(walk(hiddenQuiet, node => classes(node).includes('bt-sec-status')).length, 0)

  // Standalone botCompletions on an inactive hidden Bot also leaves collapsed section quiet.
  const hiddenCompletionQuiet = renderSidebar({
    bots: [hiddenBot, visibleBot],
    sections,
    botCompletions: { 'hidden-bot': true },
  })
  assert.equal(walk(hiddenCompletionQuiet, node => classes(node).includes('bt-sec-status')).length, 0)

  // Same in rail mode: no dot on collapsed folder.
  const hiddenQuietRail = renderSidebar({
    bots: [hiddenBot, visibleBot],
    sections,
    statusMap: new Map([['hidden-bot', { running: true, completionUnread: true }]]),
    botCompletions: { 'hidden-bot': true },
    markedUnread: { 'hidden-bot': true },
    wide: false,
  })
  const [railFolder] = walk(hiddenQuietRail, node => classes(node).includes('bt-rail-folder'))
  assert.ok(railFolder !== undefined)
  assert.equal(walk(railFolder, node => classes(node).includes('bt-dot')).length, 0)

  // Active hidden Bot that IS running: shownEntries includes it, so section shows working.
  const activeHiddenRunning = renderSidebar({
    bots: [hiddenBot, visibleBot],
    sections,
    statusMap: new Map([['hidden-bot', { running: true }]]),
    activeSession: 'hidden-bot',
  })
  const [status] = walk(activeHiddenRunning, node => classes(node).includes('bt-sec-status'))
  assert.equal(status?.props?.['data-kind'], 'working')
})

test('HeaderPill and DetailsDrawer surface alert mark state on browser and computer handoffs, not manual takeovers (#2305 review)', () => {
  const ops = { id: 'ops', name: 'Ops', createdAt: 1, sessionId: 'ops' }
  const roster = {
    ready: true, bots: [ops], rooms: [], byId: { ops }, roomsById: {},
    exchangeTurns: {}, learning: {}, secretRequests: {}, connectorRequests: {}, mailRequests: {}, questions: {}, views: {},
  }
  const hook = value => select => select(value)
  const markStates = tree => walk(tree, node => node.props?.['data-state'] !== undefined).map(node => node.props['data-state'])

  for (const [label, browserHolds, computer, expected] of [
    ['browser handoff', { ops: { by: 'bot', reason: 'login', callId: 'bh-1' } }, { asks: {}, holds: {} }, 'alert'],
    ['computer handoff', {}, { asks: {}, holds: { ops: { by: 'bot', reason: 'confirm' } } }, 'alert'],
    ['manual takeover', { ops: { by: 'user', reason: 'takeover' } }, { asks: {}, holds: { ops: { by: 'user', reason: 'takeover' } } }, 'idle'],
  ]) {
    const headerTree = expand(HeaderPill({
      sessionId: 'ops',
      useRoster: hook(roster),
      useSessions: hook({ byId: { ops: { title: 'Ops' } }, projectionsBySession: {} }),
      useSessionStatus: hook(new Map([['ops', { running: true }]])),
      useSession: hook({}),
      useActivity: hook({ ops: 'working' }),
      useMemoryNews: hook({}),
      useTurnClock: hook({}),
      useUi: hook({}),
      useLive: hook({}),
      useWork: hook({ waiting: {}, rooms: {}, approvals: [] }),
      useBrowserHolds: hook(browserHolds),
      useComputer: hook(computer),
      actions: {},
    }))
    const drawerTree = expand(DetailsDrawer({
      sessionId: 'ops',
      roster,
      actions: {},
      useSessions: hook({ byId: { ops: { title: 'Ops' } }, projectionsBySession: {} }),
      useSessionStatus: hook(new Map([['ops', { running: true }]])),
      useActivity: hook({ ops: 'working' }),
      useWork: hook({ waiting: {}, rooms: {}, approvals: [] }),
      useBrowserTabs: hook({}),
      useBrowserPages: hook({}),
      useBrowserHolds: hook(browserHolds),
      useComputer: hook(computer),
    }))
    const expectedRunning = expected === 'alert' ? 'alert' : 'working'
    assert.ok(markStates(headerTree).includes(expectedRunning), `HeaderPill ${label}: ${JSON.stringify(markStates(headerTree))}`)
    assert.ok(markStates(drawerTree).includes(expectedRunning), `DetailsDrawer ${label}: ${JSON.stringify(markStates(drawerTree))}`)
  }
})
