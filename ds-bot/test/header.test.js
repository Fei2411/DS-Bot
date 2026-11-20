import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { headerNavigation, installHeaderNavigation } from '../src/client/header-navigation.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/header.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: fn => { effects.push(fn) }, useRef: current => ({ current }), useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment' },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { HeaderPill } = module.exports

const roster = { byId: { a: { id: 'a', name: 'Chief', sessionId: 'a' } }, roomsById: {}, bots: [], exchangeTurns: {}, questions: {} }
const hook = value => select => select(value)
const header = (actions, navigation = {}) => HeaderPill({
  sessionId: 'a',
  useRoster: hook(roster),
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useSession: hook({}),
  useActivity: hook({}),
  useMemoryNews: hook({}),
  useTurnClock: hook({}),
  useUi: hook({}),
  useLive: hook({}),
  actions,
  ...navigation,
})
const sideButton = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-bt-right-sidebar'] !== undefined) return node
  for (const child of node.children ?? []) {
    const found = sideButton(child)
    if (found) return found
  }
  return null
}

// 公开#456: the Bot header carries no right-sidebar toggle — the drawer and the
// column never share the window, and the way in sits in the drawer instead.
test('the Bot header has no right sidebar button', () => {
  assert.equal(sideButton(header({ hasRightSidebar: () => true, toggleRightSidebar: () => {} })), null)
  assert.equal(sideButton(header({})), null)
})

test('a Bot in another Conversation View can return to chat without changing its draft', () => {
  const state = { view: 'study-workspace', draft: 'Keep this draft', viewRequest: null }
  const views = [{ id: 'chat' }, { id: 'study-workspace' }]
  let details = 0
  const navigation = {
    useStore: hook(state), useConversationViews: hook(views),
    selectView: view => { state.view = view },
  }
  const actions = { toggleDetails: () => { details += 1 } }
  const pill = header(actions, navigation).children[0]
  assert.equal(pill.props['aria-label'], 'Back to chat')
  assert.equal(pill.props['aria-expanded'], undefined)
  assert.equal(pill.props.title, 'Chief')
  pill.props.onClick()
  assert.equal(state.view, 'chat')
  assert.equal(state.draft, 'Keep this draft')
  assert.equal(details, 0)
  const restored = header(actions, navigation).children[0]
  assert.equal(restored.props['aria-label'], 'View conversation details')
  restored.props.onClick()
  assert.equal(details, 1)
})

test('a missing View or navigation face keeps the ordinary Bot header', () => {
  const views = [{ id: 'chat' }, { id: 'trajectory' }]
  for (const view of [null, 'chat', 'uninstalled-plugin']) {
    const pill = header({}, { useStore: hook({ view }), useConversationViews: hook(views), selectView() {} }).children[0]
    assert.equal(pill.props['aria-label'], 'View conversation details')
  }
  assert.equal(header({}).children[0].props['aria-label'], 'View conversation details')
})

test('the replacement header shares DSH\'s store and navigation injection without declaring its children again', () => {
  const store = {}
  const views = { getSnapshot: () => [{ id: 'chat' }] }
  const roster = {}
  const picked = []
  const bound = { setView: view => picked.push(view) }
  const source = { options: {},
    store,
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    inject: (sessionId, actions) => ({ hooks: { conversationViews: views }, selectView: view => { assert.equal(sessionId, 'a'); actions.setView(view) } }),
  }
  const own = { actions: { openMemory() {} }, hooks: { roster } }
  const options = headerNavigation([{ options: {} }, source], () => own)
  assert.equal(options.store, store)
  assert.equal(options.children, undefined)
  const injected = options.inject('a', bound)
  assert.equal(injected.hooks.conversationViews, views)
  assert.equal(injected.hooks.roster, roster)
  assert.equal(injected.actions, own.actions)
  injected.selectView('chat')
  assert.deepEqual(picked, ['chat'])
  const absent = headerNavigation([], () => own)
  assert.equal(absent.store, undefined)
  assert.deepEqual(absent.inject('a'), own)
})

test('the Bot header follows a later host header registration and releases its subscription', () => {
  const entries = []
  const listeners = new Set()
  let registrations = 0
  const slots = {
    entries: () => entries,
    subscribe: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    register: ({ priority, store, inject }, component) => {
      registrations += 1
      const entry = { options: { priority }, store, inject, component }
      entries.push(entry)
      return () => { const at = entries.indexOf(entry); if (at !== -1) entries.splice(at, 1) }
    },
  }
  const changed = () => { for (const listener of listeners) listener() }
  const own = { hooks: {}, actions: {} }
  const stop = installHeaderNavigation(slots, () => own, HeaderPill, -100)
  assert.equal(entries[0].store, undefined)
  const store = {}
  const host = { options: { priority: 0 }, component() {}, store, inject: () => ({ selectView() {} }) }
  entries.push(host)
  changed()
  assert.equal(entries.find(entry => entry.component === HeaderPill).store, store)
  assert.equal(registrations, 2)
  changed()
  assert.equal(registrations, 2, 'the replacement does not react to its own registration')
  entries.splice(entries.indexOf(host), 1)
  changed()
  assert.equal(entries[0].store, undefined, 'a removed host releases its old navigation face')
  stop()
  assert.equal(entries.length, 0)
  assert.equal(listeners.size, 0)
})

test('a group chat header mounts the approval bar in the top island and answers tool and computer approvals in place (#1623)', () => {
  const room = { id: 'r1', name: 'Ops', members: ['a', 'b'] }
  const groupRoster = {
    byId: { a: { id: 'a', name: 'Chief', sessionId: 'a' }, b: { id: 'b', name: 'Scout', sessionId: 'b' } },
    roomsById: { r1: room },
    bots: [], exchangeTurns: {}, questions: {},
  }
  const work = {
    rooms: {},
    approvals: [{ id: 'ap1', botId: 'a', roomId: 'r1', answerable: true, tool: 'bash', reason: 'Run check', detail: { code: 'npm test' }, at: 100 }],
  }
  const computer = {
    asks: { ca1: { id: 'ca1', botId: 'b', roomId: 'r1', sessionId: 'r1-b', appName: 'Notes', at: 200 } },
  }
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
    return { ...node, children: (node.children ?? []).map(expand) }
  }
  const findAll = (node, match, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { node.forEach(item => findAll(item, match, out)); return out }
    if (match(node)) out.push(node)
    for (const child of node.children ?? []) findAll(child, match, out)
    return out
  }
  const calls = []
  const actions = {
    beginVisit() {}, endVisit() {},
    toggleApproval: id => calls.push(['toggleApproval', id]),
    answerApproval: (id, choice) => { calls.push(['answerApproval', id, choice]); return Promise.resolve() },
    computerAppAnswer: (id, choice) => { calls.push(['computerAppAnswer', id, choice]); return Promise.resolve() },
  }
  const renderRoom = (uiState) => expand(HeaderPill({
    sessionId: 'r1',
    useRoster: hook(groupRoster),
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map()),
    useSession: hook({}),
    useActivity: hook({}),
    useMemoryNews: hook({}),
    useTurnClock: hook({}),
    useUi: hook(uiState),
    useLive: hook({}),
    useWork: hook(work),
    useComputer: hook(computer),
    actions,
  }))

  // Closed island shows the approval bar even without a Goal.
  const closed = renderRoom({ approvalOpen: null })
  const bars = findAll(closed, node => node.props?.className === 'bt-apv-bar')
  assert.equal(bars.length, 1)
  bars[0].props.onClick()
  assert.deepEqual(calls, [['toggleApproval', 'r1']])

  // Open island renders both the DSH tool approval card and the computer-use consent card in place.
  calls.length = 0
  const opened = renderRoom({ approvalOpen: 'r1' })
  const panels = findAll(opened, node => node.props?.className === 'bt-apv-panel')
  assert.equal(panels.length, 1)
  const btns = findAll(panels[0], node => node.type === 'button')
  const byLabel = text => btns.find(btn => (btn.children ?? []).join('') === text)
  byLabel('Allow once').props.onClick()
  byLabel('This time').props.onClick()
  assert.deepEqual(calls, [
    ['answerApproval', 'ap1', 'allow'],
    ['computerAppAnswer', 'ca1', 'once'],
  ])

  // When all approvals finish while approvalOpen is still set, HeaderPill closes approvalOpen.
  const closedCalls = []
  const emptyWork = { rooms: {}, approvals: [] }
  const emptyComputer = { asks: {} }
  effects.length = 0
  expand(HeaderPill({
    sessionId: 'r1',
    useRoster: hook(groupRoster),
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map()),
    useSession: hook({}),
    useActivity: hook({}),
    useMemoryNews: hook({}),
    useTurnClock: hook({}),
    useUi: hook({ approvalOpen: 'r1' }),
    useLive: hook({}),
    useWork: hook(emptyWork),
    useComputer: hook(emptyComputer),
    actions: { ...actions, closeApproval: () => closedCalls.push('closeApproval') },
  }))
  const cleanups = []
  for (const run of effects) {
    try {
      const clean = run()
      if (typeof clean === 'function') cleanups.push(clean)
    } catch { /* DOM-only effects are ignored in this node harness */ }
  }
  for (const clean of cleanups) { try { clean() } catch {} }
  assert.deepEqual(closedCalls, ['closeApproval'])

  // A Bot's own chat header also mounts the approval island for background-task approvals (#783).
  calls.length = 0
  const taskWork = {
    rooms: {},
    approvals: [{ id: 'ap-task', botId: 'a', taskId: 'k_1', taskTitle: 'Deploy check', tool: 'bash', reason: 'Run deploy script', answerable: true, at: 100 }],
  }
  const renderBot = (uiState) => expand(HeaderPill({
    sessionId: 'a',
    useRoster: hook(groupRoster),
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map()),
    useSession: hook({}),
    useActivity: hook({}),
    useMemoryNews: hook({}),
    useTurnClock: hook({}),
    useUi: hook(uiState),
    useLive: hook({}),
    useWork: hook(taskWork),
    useComputer: hook(emptyComputer),
    actions,
  }))
  const botClosed = renderBot({ approvalOpen: null })
  const botBars = findAll(botClosed, node => node.props?.className === 'bt-apv-bar')
  assert.equal(botBars.length, 1)
  botBars[0].props.onClick()
  assert.deepEqual(calls, [['toggleApproval', 'a']])

  calls.length = 0
  const botOpened = renderBot({ approvalOpen: 'a' })
  const botPanels = findAll(botOpened, node => node.props?.className === 'bt-apv-panel')
  assert.equal(botPanels.length, 1)
  const botBtns = findAll(botPanels[0], node => node.type === 'button')
  botBtns.find(btn => (btn.children ?? []).join('') === 'Allow once').props.onClick()
  botBtns.find(btn => (btn.children ?? []).join('') === 'Reject').props.onClick()
  assert.deepEqual(calls, [
    ['answerApproval', 'ap-task', 'allow'],
    ['answerApproval', 'ap-task', 'reject'],
  ])
})
