import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { panelHasStrip, stripMenuKeys } from '../src/client/side-model.js'
import { teamActions } from '../src/client/team-actions.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-tasks.js', import.meta.url))],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Map,
  Set,
  Math,
  JSON,
  Promise,
  window: { addEventListener: () => {}, removeEventListener: () => {} },
  document: {},
  require: (name) => {
    const platform = {
      react: {
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value,
        useId: () => 't-id',
        useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: current => ({ current }),
        useLayoutEffect: () => {},
        useMemo: make => make(),
        useCallback: fn => fn,
        Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: ({ text }) => ({ type: 'md', props: { text }, children: [text] }) },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})

const {
  DetailsTaskList,
  SidebarTaskPill,
  TaskIslandPanel,
  TaskIslandPod,
  isActiveTask,
  taskCountsOf,
  taskDeckItems,
  tasksForChat,
} = module.exports

function renderTree(node) {
  if (node == null || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(renderTree)
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props, children: node.children }))
  return [{ ...node, children: (node.children ?? []).flatMap(renderTree) }]
}

function collectText(nodes) {
  return nodes.map(n => (typeof n === 'string' ? n : collectText(n.children ?? []))).join(' ')
}

function findAll(nodes, match) {
  const out = []
  for (const n of nodes) {
    if (n && typeof n === 'object') {
      if (match(n)) out.push(n)
      out.push(...findAll(n.children ?? [], match))
    }
  }
  return out
}

function fakeSource(initial) {
  let state = initial
  return {
    getSnapshot: () => state,
    set: (updater) => { state = typeof updater === 'function' ? updater(state) : updater },
  }
}

test('tasksForChat, taskCountsOf, and taskDeckItems scope DM vs group tasks and order approvals first', () => {
  const botA = {
    id: 'a',
    name: 'Chief',
    tasks: [
      { id: 'k_done', title: 'Old done', status: 'completed', updatedAt: 300, startedAt: 100 },
      { id: 'k_run', title: 'Build index', status: 'running', updatedAt: 200, startedAt: 150 },
      { id: 'k_apv', title: 'Deploy', status: 'waiting_approval', updatedAt: 180, startedAt: 120 },
      { id: 'k_grp', title: 'Group audit', roomId: 'r1', status: 'running', updatedAt: 250, startedAt: 210 },
    ],
  }
  const botB = {
    id: 'b',
    name: 'Helper',
    tasks: [
      { id: 'k_grp2', title: 'Group test', roomId: 'r1', status: 'waiting_approval', updatedAt: 260, startedAt: 220 },
    ],
  }
  const room = { id: 'r1', name: 'DevGroup', members: ['a', 'b'] }
  const roster = { byId: { a: botA, b: botB }, roomsById: { r1: room } }

  const dmTasks = tasksForChat({ bot: botA })
  assert.deepEqual(Array.from(dmTasks, item => item.id), ['k_apv', 'k_run', 'k_done'])

  const grpTasks = tasksForChat({ room, roster })
  assert.deepEqual(Array.from(grpTasks, item => item.id), ['k_grp2', 'k_grp'])

  assert.deepEqual({ ...taskCountsOf({ bot: botA }) }, { active: 2, waitingApproval: 1, total: 3 })
  assert.deepEqual({ ...taskCountsOf({ room, roster }) }, { active: 2, waitingApproval: 1, total: 2 })
  assert.equal(isActiveTask(botA.tasks[0]), false)
  assert.equal(isActiveTask(botA.tasks[1]), true)

  const approvals = [
    { kind: 'tool', id: 'apv-1', botId: 'a', bot: botA, at: 500, approval: { id: 'apv-1', taskId: 'k_apv', taskTitle: 'Deploy', tool: 'bash', reason: 'Run deploy' } },
  ]
  const deck = taskDeckItems({ bot: botA, roster, approvals })
  assert.equal(deck.length, 2)
  assert.equal(deck[0].kind, 'approval')
  assert.equal(deck[0].task.id, 'k_apv')
  assert.equal(deck[1].kind, 'task')
  assert.equal(deck[1].task.id, 'k_run')
})

test('TaskIslandPod, SidebarTaskPill, DetailsTaskList, and TaskIslandPanel render expected controls and fire actions', () => {
  const bot = {
    id: 'a',
    name: 'Chief',
    color: 'blue',
    tasks: [
      { id: 'k_1', title: 'Compile release', brief: 'Build all targets', status: 'running', startedAt: Date.now() - 5000, updatedAt: Date.now(), origin: 'fg-handoff' },
      { id: 'k_2', title: 'Run migration', status: 'waiting_approval', startedAt: Date.now() - 10000, updatedAt: Date.now() },
    ],
  }
  const roster = { byId: { a: bot }, roomsById: {}, prefs: {} }
  const approvals = [
    { kind: 'tool', id: 'apv-2', botId: 'a', bot, at: Date.now(), approval: { id: 'apv-2', botId: 'a', taskId: 'k_2', taskTitle: 'Run migration', tool: 'bash', reason: 'Apply SQL', detail: { code: 'npm run migrate' }, answerable: true, at: Date.now() } },
  ]

  const toggled = []
  const islandTree = renderTree(TaskIslandPod({ bot, roster, tasks: tasksForChat({ bot }), approvals, open: false, targetId: 'a', actions: { toggleTaskDeck: id => toggled.push(id) } }))
  const bar = findAll(islandTree, n => n.props?.className === 'bt-task-bar')
  assert.equal(bar.length, 1)
  assert.equal(bar[0].props['data-approval'], true)
  bar[0].props.onClick()
  assert.deepEqual(toggled, ['a'])

  const pillTree = renderTree(SidebarTaskPill({ active: 2, waitingApproval: 1 }))
  assert.match(collectText(pillTree), /2/)
  assert.equal(findAll(pillTree, n => n.props?.className === 'bt-task-pill')[0].props['data-approval'], true)

  const detailsTree = renderTree(DetailsTaskList({ tasks: tasksForChat({ bot }), sessionId: 'a', actions: {} }))
  const detailsText = collectText(detailsTree)
  assert.match(detailsText, /Compile release/)
  assert.match(detailsText, /Run migration/)
  assert.equal(findAll(detailsTree, n => n.props?.className === 'bt-task-row-stop').length, 2)

  // Approval item focused in inline Dynamic Island TaskIslandPanel with Left/Right arrows + compact stepper
  const answered = []
  const panelTree = renderTree(TaskIslandPanel({
    bot,
    roster,
    approvals,
    targetId: 'a',
    actions: { answerApproval: (id, c) => answered.push([id, c]), sendTask: () => {} },
  }))
  const panelText = collectText(panelTree)
  assert.match(panelText, /1\/2/)
  assert.match(panelText, /Run migration/)
  assert.match(panelText, /npm run migrate/)
  assert.equal(findAll(panelTree, n => n.props?.className === 'bt-task-stepper').length, 1)
  assert.equal(findAll(panelTree, n => n.props?.className === 'bt-task-arrow').length, 2)
  const allowBtn = findAll(panelTree, n => n.type === 'button' && collectText([n]).trim() === 'Allow once')[0]
  assert.ok(allowBtn)
  allowBtn.props.onClick()
  assert.deepEqual(answered, [['apv-2', 'allow']])

  // Active non-approval task shows Stop + View details + inline follow-up bar
  const activePanelTree = renderTree(TaskIslandPanel({
    bot,
    roster,
    approvals: [],
    focusTaskId: 'k_1',
    targetId: 'a',
    actions: { sendTask: () => {} },
  }))
  const activeText = collectText(activePanelTree)
  assert.match(activeText, /Compile release/)
  assert.match(activeText, /View details/)
  assert.match(activeText, /Stop/)
  assert.equal(findAll(activePanelTree, n => n.props?.className === 'bt-btask-reply').length, 1)
})

test('teamActions task deck, right-panel read-only task viewer, stopTask, sendTask, readTask, and panelHasStrip', async () => {
  const calls = []
  const ui = fakeSource({ details: null, view: 'details', task: null, taskDeck: null, approvalOpen: 'a', goalOpen: 'r1', goalCompose: null, menu: null, palette: null })
  const roster = fakeSource({ byId: { a: { id: 'a' } }, roomsById: {}, sideChats: {} })
  const actions = teamActions({
    call: async (name, body) => { calls.push([name, body]); return { ok: true } },
    after: p => p,
    partFor: id => id,
    roster,
    ui,
    live: fakeSource({}),
    cards: fakeSource({}),
    heldCards: fakeSource({}),
    turnClock: fakeSource({}),
  })

  assert.equal(panelHasStrip(false, 0, 0, true), true)
  assert.equal(panelHasStrip(false, 0, 0, false), false)
  assert.deepEqual(stripMenuKeys({ canBrowse: false, canSide: false, canTerminal: true, canFiles: false }), ['terminal'])
  assert.deepEqual(stripMenuKeys({ canBrowse: false, canSide: false, canTerminal: false, canFiles: false }), [])
  assert.deepEqual(stripMenuKeys({ canBrowse: true, canSide: true, canTerminal: true, canFiles: false }), ['new-tab', 'side', 'sep', 'terminal'])

  actions.openTaskDeck('a', 'k_1')
  assert.equal(ui.getSnapshot().taskDeck.targetId, 'a')
  assert.equal(ui.getSnapshot().taskDeck.taskId, 'k_1')
  assert.equal(ui.getSnapshot().approvalOpen, null)
  actions.openApproval('r1')
  assert.equal(ui.getSnapshot().approvalOpen, 'r1')
  assert.equal(ui.getSnapshot().taskDeck, null)
  actions.openTaskDeck('a', 'k_1')
  actions.toggleTaskDeck('a')
  assert.equal(ui.getSnapshot().taskDeck, null)
  actions.toggleTaskDeck('a')
  assert.equal(ui.getSnapshot().taskDeck.targetId, 'a')
  actions.toggleGoal('r1')
  assert.equal(ui.getSnapshot().taskDeck, null)
  assert.equal(ui.getSnapshot().goalOpen, 'r1')
  actions.closeTaskDeck()
  assert.equal(ui.getSnapshot().taskDeck, null)

  actions.openTask('dm-a', 'a', 'k_1')
  assert.equal(ui.getSnapshot().details, 'dm-a')
  assert.equal(ui.getSnapshot().view, 'task')
  assert.deepEqual(ui.getSnapshot().task, { botId: 'a', taskId: 'k_1' })

  // Returning to details tab without closing task, then switching chat via followPanel must clear task.
  actions.setPanelView('details')
  assert.equal(ui.getSnapshot().view, 'details')
  assert.deepEqual(ui.getSnapshot().task, { botId: 'a', taskId: 'k_1' })
  actions.followPanel('dm-b')
  assert.equal(ui.getSnapshot().details, 'dm-b')
  assert.equal(ui.getSnapshot().task, null)

  actions.openTask('dm-a', 'a', 'k_1')
  actions.closeTask()
  assert.equal(ui.getSnapshot().view, 'details')
  assert.equal(ui.getSnapshot().task, null)
  assert.equal(ui.getSnapshot().tab, 'tasks')

  await actions.stopTask('a', 'k_1')
  await actions.sendTask('a', 'k_1', 'Focus on API tests')
  await actions.readTask('a', 'k_1', null, true)
  assert.deepEqual(calls, [
    ['bot-stop-task', { botId: 'a', taskId: 'k_1' }],
    ['bot-task-send', { botId: 'a', taskId: 'k_1', text: 'Focus on API tests' }],
    ['bot-task-read', { botId: 'a', taskId: 'k_1', steps: true }],
  ])
})
