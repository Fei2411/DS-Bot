import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-board.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: {
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }),
        useLayoutEffect: () => {}, Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { TaskBoard } = module.exports

// Function components are invoked once here: the test renders outside React, so it has
// to stand in for the reconciliation that would call them.
const expand = (node) => {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(expand) }
}
const rendered = tree => expand(tree)

// The rendered text of an element tree, so a section and its row read as the user sees them.
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}
const findAll = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

const room = (tasks) => ({ id: 'r1', name: 'Ops', tasks })
const roster = { byId: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } } }
const actions = { taskNote: async () => {}, taskCancel: async () => {} }
const task = (id, botId, status, extra = {}) => ({
  id, botId, goal: `Goal ${id}`, status, startedAt: Number(id.slice(1)), updatedAt: Number(id.slice(1)), ...extra,
})

test('the board puts running work, work that waits, and history in that order', () => {
  const tree = TaskBoard({ room: room({
    t1: task('t1', 'a', 'active'),
    t2: task('t2', 'b', 'blocked', { blocked: { by: 'system', cause: 'stopped', from: 'active', at: 2 } }),
    t3: task('t3', 'a', 'done', { result: 'Shipped' }),
  }), roster, actions })
  const text = textOf(rendered(tree))
  const order = ['In progress', 'Needs you', 'History'].map(title => text.indexOf(title))
  assert.ok(order.every(at => at >= 0), text)
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections follow the order the user needs')
  // A row carries its state in words, not only in a colour.
  assert.match(text, /Goal t1/)
  assert.match(text, /Chief · In progress/)
  assert.match(text, /Stopped by the user/)
  assert.match(text, /Shipped/)
})

test('only a stopped row offers to continue, and it asks the owner through the note path', async () => {
  const sent = []
  const tree = TaskBoard({ room: room({
    t1: task('t1', 'a', 'active'),
    t2: task('t2', 'b', 'blocked', { blocked: { by: 'system', cause: 'failed', code: 'TRANSPORT', at: 2 } }),
  }), roster, actions: { ...actions, taskNote: async (roomId, id, text) => { sent.push([roomId, id, text]) } } })
  const buttons = findAll(rendered(tree), node => node.props?.className === 'bt-task-continue')
  assert.equal(buttons.length, 1, 'one row is stopped')
  assert.match(buttons[0].props['aria-label'], /Let it continue: Goal t2/)
  buttons[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, [['r1', 't2', 'Let it continue: Goal t2']])
})

test('an empty section says so, and history shows a few rows with a way to see the rest', () => {
  const tasks = {
    t1: task('t1', 'a', 'active'),
  }
  for (let i = 2; i <= 9; i += 1) tasks[`t${i}`] = task(`t${i}`, 'a', 'done')
  const text = textOf(rendered(TaskBoard({ room: room(tasks), roster, actions })))
  assert.match(text, /Nothing waits for you\./)
  assert.match(text, /Show all \(8\)/)
  // Five rows in the preview plus the one running.
  assert.equal((text.match(/Goal t/g) ?? []).length, 6)
})

test('a row waiting for review sits with the work that needs the user, and a cancelled task in history', () => {
  const tree = TaskBoard({ room: room({
    t1: task('t1', 'a', 'active'),
    t2: task('t2', 'b', 'review'),
    t3: task('t3', 'a', 'cancelled'),
  }), roster, actions })
  const text = textOf(rendered(tree))
  const needs = text.indexOf('Needs you')
  assert.ok(text.indexOf('Goal t2') > needs, 'review is not running work')
  assert.match(text, /Awaiting review/)
  const history = text.indexOf('History')
  assert.ok(text.indexOf('Goal t3') > history, 'cancelled is history')
  assert.match(text, /Cancelled/)
})

// React renders a type it cannot call (an element passed where a component belongs) as
// error #130 and takes the whole slot down with it, so every row of every state has to
// resolve to a node whose type is a tag after the components ran.
test('every state draws an icon the renderer can call, not a prebuilt element', () => {
  const tasks = {}
  const states = ['active', 'review', 'blocked', 'done', 'cancelled']
  states.forEach((status, i) => { tasks[`t${i + 1}`] = task(`t${i + 1}`, 'a', status) })
  const bad = findAll(rendered(TaskBoard({ room: room(tasks), roster, actions })), node => typeof node.type !== 'string')
  assert.deepEqual(bad.map(node => node.props?.className ?? node.type), [])
})

test('exactly five finished tasks need no way to show more', () => {
  const tasks = {}
  for (let i = 1; i <= 5; i += 1) tasks[`t${i}`] = task(`t${i}`, 'a', 'done')
  const text = textOf(rendered(TaskBoard({ room: room(tasks), roster, actions })))
  assert.match(text, /History/)
  assert.doesNotMatch(text, /Show all/)
})
