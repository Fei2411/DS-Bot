import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
  useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment',
}
const require = (name) => {
  const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null } }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const bundled = async (entry) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams })
  return module.exports
}
const goal = await bundled('goal.js')
const header = await bundled('header.js')
const cells = await bundled('cells.js')
const { goalView, goalEventText, canSetGoal, hasGoalAdmin } = goal
const { HeaderPill } = header
const { TriggerCell } = cells

// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))
const hook = value => select => select(value)

const all = (node, cls, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), cls, out)
  if ((node.props?.className ?? '').split(' ').includes(cls)) out.push(node)
  for (const child of node.children ?? []) all(child, cls, out)
  return out
}
const find = (node, cls) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (typeof node.type === 'function') return find(node.type(node.props), cls)
  if ((node.props?.className ?? '').split(' ').includes(cls)) return node
  for (const child of node.children ?? []) {
    const found = find(child, cls)
    if (found) return found
  }
  return null
}
const text = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return text(node.type(node.props))
  return (node.children ?? []).map(text).join('')
}

const names = { a: 'Chief', b: 'Flint', c: 'Prism', d: 'Quill' }
const team = goalValue => ({
  byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name, sessionId: id }])),
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c', 'd'], admin: 'a', goal: goalValue } },
  bots: [], exchangeTurns: {}, questions: {},
})
const stages = (second = {}) => [
  { title: 'First', acceptance: 'a1', status: 'passed', tasks: [{ botId: 'a', task: 'done a', status: 'done' }], evidence: 'first evidence', reworks: 0 },
  { title: 'Second', acceptance: 'a2', status: 'active', reworks: 1, feedback: 'tighten the scope', tasks: [
    { botId: 'b', task: 'do b', status: 'working' },
    { botId: 'c', task: 'do c', status: 'pending', note: 'needs the plan first' },
  ], ...second },
  { title: 'Third', acceptance: 'a3', status: 'pending', tasks: [{ botId: 'd', task: 'do d', status: 'pending' }] },
  { title: 'Fourth', acceptance: 'a4', status: 'pending', tasks: [{ botId: 'b', task: 'do b later', status: 'pending' }] },
]
const running = (over = {}) => ({
  id: 'g1', revision: 1, status: 'active', title: 'Ship it', objective: 'obj', acceptance: 'acc',
  constraints: ['rule one'], stages: stages(), current: 1, ...over,
})

test('goalView reads an active goal into bar label, segments, faces and stage rows', () => {
  const view = goalView(running(), { roster: team(), roomWork: [{ botId: 'c', since: 1 }] })
  assert.equal(view.status, 'active')
  assert.equal(view.barLabel, 'Second')
  assert.equal(view.number, 2)
  assert.equal(view.count, 4)
  assert.deepEqual(view.segments, ['done', 'current', 'todo', 'todo'])
  // c is reported pending but at work in this room, so its face animates.
  assert.deepEqual(plain(view.faces.map(face => [face.bot.name, face.working])), [['Flint', true], ['Prism', true]])
  assert.equal(view.stages[1].kind, 'current')
  assert.equal(view.stages[1].reworks, 1)
  assert.equal(view.stages[1].feedback, 'tighten the scope')
  assert.equal(view.stages[0].evidence, 'first evidence')
  assert.deepEqual(plain(view.stages[1].tasks[1]), { bot: { id: 'c', name: 'Prism', sessionId: 'c' }, task: 'do c', status: 'pending' })
})

test('goalView covers every status the bar can hold', () => {
  const roster = team()
  assert.equal(goalView(running({ status: 'drafting', stages: [], current: -1 }), { roster }).barLabel, 'Aligning the goal with you')
  const checking = running({ stages: stages({ status: 'active', tasks: [{ botId: 'b', task: 'do b', status: 'reported' }, { botId: 'c', task: 'do c', status: 'done' }] }) })
  const checkingView = goalView(checking, { roster })
  assert.deepEqual(checkingView.segments, ['done', 'checking', 'todo', 'todo'])
  assert.equal(checkingView.stages[1].kind, 'current')
  assert.equal(checkingView.barLabel, 'Checking · Second')
  const passed = running({ stages: stages().map(stage => ({ ...stage, status: 'passed' })), current: 4 })
  const passedView = goalView(passed, { roster })
  assert.equal(passedView.barLabel, 'Final check')
  assert.equal(passedView.number, 4)
  const idleView = goalView(running({ idle: true }), { roster })
  assert.equal(idleView.barLabel, 'Waiting for you · Second')
  const paused = goalView(running({ status: 'paused' }), { roster })
  assert.equal(paused.barLabel, 'Paused · Second')
  assert.equal(paused.number, 2)
  assert.deepEqual(paused.segments, ['done', 'paused', 'todo', 'todo'])
  const complete = goalView(running({ status: 'complete', stages: stages().map(stage => ({ ...stage, status: 'passed' })), current: 4 }), { roster })
  assert.equal(complete.barLabel, 'Goal reached')
  assert.equal(complete.number, 4)
  const stoppedView = goalView(running({ status: 'stopped' }), { roster })
  assert.equal(stoppedView.number, 1)
  assert.equal(goalView(running({ status: 'drafting', stages: [], current: -1 }), { roster }).number, undefined)
  assert.deepEqual(complete.segments, ['done', 'done', 'done', 'done'])
  const stopped = goalView(running({ status: 'stopped' }), { roster })
  assert.equal(stopped.barLabel, 'Stopped')
  assert.deepEqual(stopped.segments, ['done', 'todo', 'todo', 'todo'])
})

test('goalEventText writes one transcript line per goal event', () => {
  assert.equal(goalEventText({ event: 'draft' }), 'Setting a goal')
  assert.equal(goalEventText({ event: 'start', title: 'Ship it', count: 4 }), 'Goal set: Ship it · 4 stages')
  assert.equal(goalEventText({ event: 'pass', stage: 2, next: 'Third' }), 'Stage 2 passed · now stage 3: Third')
  assert.equal(goalEventText({ event: 'pass', stage: 4, count: 4 }), 'All 4 stages passed')
  assert.equal(goalEventText({ event: 'rework', stage: 2 }), 'Stage 2 sent back for rework')
  assert.equal(goalEventText({ event: 'revise' }), 'Goal updated')
  assert.equal(goalEventText({ event: 'pause' }), 'Goal paused')
  assert.equal(goalEventText({ event: 'resume' }), 'Goal resumed')
  assert.equal(goalEventText({ event: 'complete', title: 'Ship it' }), 'Goal reached: Ship it')
  assert.equal(goalEventText({ event: 'stop' }), 'Goal stopped')
})

test('the goal entry is only offered to a group whose admin is a member and whose goal is not in flight', () => {
  const roster = team()
  const room = roster.roomsById.r1
  assert.equal(hasGoalAdmin(room, roster), true)
  assert.equal(canSetGoal(room, roster), true)
  assert.equal(canSetGoal(undefined, roster), false)
  assert.equal(canSetGoal({ ...room, admin: 'd' }, roster), true)
  assert.equal(canSetGoal({ ...room, admin: 'zzz' }, roster), false)
  assert.equal(hasGoalAdmin({ ...room, admin: 'zzz' }, roster), false)
  assert.equal(canSetGoal({ ...room, goal: running() }, roster), false)
  assert.equal(canSetGoal({ ...room, goal: running({ status: 'paused' }) }, roster), false)
  assert.equal(canSetGoal({ ...room, goal: running({ status: 'drafting' }) }, roster), true)
  assert.equal(canSetGoal({ ...room, goal: running({ status: 'stopped' }) }, roster), true)
})

const renderHeader = (roster, ui = {}, work = {}, actions = {}) => HeaderPill({
  sessionId: 'r1',
  useRoster: hook(roster), useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()),
  useSession: hook({}), useActivity: hook({}), useMemoryNews: hook({}), useTurnClock: hook({}),
  useUi: hook(ui), useLive: hook({}), useWork: hook(work), actions,
})

test('a group without a goal renders today\'s pill with no island', () => {
  const roster = team()
  roster.roomsById.r1.goal = undefined
  const node = renderHeader(roster)
  assert.equal(find(node, 'bt-island'), null)
  assert.ok(find(node, 'bt-pill'))
  assert.equal(find(node, 'bt-goal-pod'), null)
})

test('an active goal wraps the pill in the island: title, count and the stage bar', () => {
  const node = renderHeader(team(running()), {}, { rooms: { r1: [{ botId: 'c', since: 1 }] }, bots: {}, approvals: [] })
  const island = find(node, 'bt-island')
  assert.ok(island)
  assert.equal(island.props['data-goal'], 'active')
  assert.equal(find(island, 'bt-pill-swap') !== null, true)
  assert.equal(text(find(island, 'bt-pill-title')), 'Ship it')
  assert.equal(text(find(island, 'bt-pill-count')), '2/4')
  const bar = find(island, 'bt-goal-bar')
  assert.ok(bar)
  assert.equal(text(bar).includes('Second'), true)
  assert.equal(find(island, 'bt-goal-panel'), null)
})

test('the open island draws a stepper, the current stage and the goal controls, no chips', () => {
  const node = renderHeader(team(running()), { goalOpen: 'r1' })
  const panel = find(node, 'bt-goal-panel')
  assert.ok(panel)
  assert.equal(find(panel, 'bt-goal-chip'), null)
  assert.equal(all(panel, 'bt-goal-step').length, 4)
  const content = text(panel)
  assert.equal(content.includes('Pause'), true)
  assert.equal(content.includes('Stop'), true)
  // The title line anchors the selected stage even when it is the current one.
  assert.equal(text(find(panel, 'bt-goal-btitle')), 'Second')
  assert.equal(find(panel, 'bt-goal-back'), null)
  assert.equal(content.includes('Sent back by Chief: tighten the scope'), true)
  assert.equal(content.includes('do b'), true)
  assert.equal(content.includes('Done when: a2'), true)
  assert.equal(content.includes('Goal and checks'), true)
})

test('a passed stage shows its evidence and the rework line grows with the count', () => {
  const node = renderHeader(team(running({ stages: stages({ reworks: 2, feedback: 'too wide' }) })), { goalOpen: 'r1' })
  const panel = find(node, 'bt-goal-panel')
  assert.equal(text(panel).includes('Sent back 2 times by Chief. Last time: too wide'), true)
  // Stage 1 is passed: selecting it shows its evidence as a run of text.
  const original = react.useState
  react.useState = initial => [initial === 1 ? 0 : initial, () => {}]
  try {
    const passed = find(renderHeader(team(running()), { goalOpen: 'r1' }), 'bt-goal-panel')
    assert.equal(text(find(passed, 'bt-goal-btitle')), 'First')
    assert.equal(text(passed).includes('Evidence: first evidence'), true)
    assert.equal(text(passed).includes('Back to current stage'), true)
  } finally { react.useState = original }
})

test('a stage other than the current one gets a title line and a way back', () => {
  // The realm's useState is inert, so the selection hook is seeded to stage 3
  // while the goal's current stays at 1 — the panel renders the non-current case.
  const original = react.useState
  react.useState = initial => [initial === 1 ? 2 : initial, () => {}]
  try {
    const node = renderHeader(team(running()), { goalOpen: 'r1' })
    const panel = find(node, 'bt-goal-panel')
    assert.equal(text(find(panel, 'bt-goal-btitle')), 'Third')
    assert.equal(text(find(panel, 'bt-goal-back')), 'Back to current stage')
    const rows = all(panel, 'bt-goal-task')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].props['data-task'], 'pending')
  } finally { react.useState = original }
})

test('task rows carry their state on the avatar: pulse, check badge, dimmed', () => {
  const node = renderHeader(team(running({ stages: stages({ status: 'active', tasks: [
    { botId: 'b', task: 'do b', status: 'working' },
    { botId: 'c', task: 'do c', status: 'reported' },
    { botId: 'd', task: 'do d', status: 'pending' },
  ] }) })), { goalOpen: 'r1' })
  const rows = all(find(node, 'bt-goal-panel'), 'bt-goal-task')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].props['data-task'], undefined)
  assert.equal(find(rows[0], 'bt-goal-tdone'), null)
  assert.ok(find(rows[1], 'bt-goal-tdone'))
  assert.equal(rows[2].props['data-task'], 'pending')
})

test('the bottom row offers the right controls per goal state', () => {
  const panel = state => find(renderHeader(team(running(state)), { goalOpen: 'r1' }), 'bt-goal-panel')
  const active = text(panel({}))
  assert.equal(active.includes('Pause'), true)
  assert.equal(active.includes('Resume'), false)
  const complete = text(panel({ status: 'complete', stages: stages().map(stage => ({ ...stage, status: 'passed' })), current: 4, summary: 'all done', evidence: 'ev' }))
  assert.equal(complete.includes('Clear'), true)
  assert.equal(complete.includes('all done'), true)
  assert.equal(complete.includes('Pause'), false)
  const drafting = text(panel({ status: 'drafting', stages: [], current: -1, brief: 'ship v2' }))
  assert.equal(drafting.includes('Cancel'), true)
  assert.equal(drafting.includes('ship v2'), true)
  assert.equal(all(panel({ status: 'drafting', stages: [], current: -1 }), 'bt-goal-step').length, 0)
})

test('a paused goal offers Resume in the panel and a stopped one Clear', () => {
  const paused = find(renderHeader(team(running({ status: 'paused' })), { goalOpen: 'r1' }), 'bt-goal-panel')
  assert.equal(text(paused).includes('Resume'), true)
  assert.equal(text(paused).includes('Stop current work too'), false)
  const stopped = find(renderHeader(team(running({ status: 'stopped' })), { goalOpen: 'r1' }), 'bt-goal-panel')
  assert.equal(text(stopped).includes('Clear'), true)
})

test('a paused group with members at work offers to stop the work too', () => {
  const actions = { stopRoomWork: (...args) => args }
  const panel = find(renderHeader(team(running({ status: 'paused' })), { goalOpen: 'r1' }, { rooms: { r1: [{ botId: 'b', since: 1 }] }, bots: {}, approvals: [] }, actions), 'bt-goal-panel')
  assert.equal(text(panel).includes('Stop current work too'), true)
})

test('composing a goal swaps the pod for the draft form', () => {
  const node = renderHeader(team(), { goalCompose: 'r1', goalOpen: 'r1' })
  const island = find(node, 'bt-island')
  assert.ok(island)
  assert.equal(island.props['data-goal'], 'compose')
  assert.ok(find(island, 'bt-goal-input'))
  const content = text(island)
  assert.equal(content.includes('What should this group achieve?'), true)
  assert.equal(content.includes('Start'), true)
  assert.equal(find(island, 'bt-goal-bar'), null)
})

test('a goal turn trigger draws nothing', () => {
  const roster = team()
  const node = TriggerCell({
    node: { data: { source: { kind: 'bot', role: 'goal', botId: 'a' }, turn: 1 }, location: {} },
    sessionId: 'r1', useRoster: hook(roster), useSessions: hook({ byId: {} }),
    useTurnClock: hook({}), useUi: hook({ visits: {} }), actions: {},
  })
  assert.equal(node?.type?.name, 'CellEmpty')
})

// A component node by name, evaluating function components on the way down.
const findComp = (node, name) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    if (node.type.name === name) return node
    return findComp(node.type(node.props), name)
  }
  for (const child of node.children ?? []) {
    const found = findComp(child, name)
    if (found) return found
  }
  return null
}

test('Enter during IME composition does not submit the goal brief', () => {
  const node = renderHeader(team(), { goalCompose: 'r1', goalOpen: 'r1' })
  const input = find(node, 'bt-goal-input')
  assert.ok(input)
  let prevented = false
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
})

test('Escape and outside clicks while composing clear compose and open together', () => {
  const calls = []
  const actions = { closeGoalCompose: () => calls.push('compose'), closeGoal: () => calls.push('open') }
  const node = renderHeader(team(), { goalCompose: 'r1', goalOpen: 'r1' }, {}, actions)
  const outside = findComp(node, 'GoalOutside')
  assert.ok(outside)
  outside.props.close()
  assert.deepEqual(calls, ['compose', 'open'])
})

test('the segment track shrinks for many stages instead of overflowing the bar', () => {
  const css = goal.GOAL_CSS
  assert.match(css, /\.bt-goal-segs\{[^}]*flex:0 1 auto[^}]*min-width:0/)
  assert.match(css, /\.bt-goal-segs i\{[^}]*width:14px[^}]*min-width:3px/)
  assert.match(css, /\.bt-goal-segs i\[data-seg=current\]\{[^}]*width:20px/)
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `S${i + 1}`, acceptance: 'x', status: 'pending', tasks: [], reworks: 0 }))
  const node = renderHeader(team(running({ stages: many, current: 3 })), {}, { rooms: { r1: [] }, bots: {}, approvals: [] })
  const segs = find(node, 'bt-goal-segs')
  assert.ok(segs)
  assert.equal(segs.children.length, 20)
})
