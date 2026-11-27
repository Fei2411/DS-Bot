import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The AssistantCell behavior of a local-agent turn: the aggregated actions row
// rides on thinking visibility, the live action feeds the activity row even
// while the transcript stays clean.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: {
    contents: "export { AssistantCell, AgentActivityRow } from './src/client/cells.js'",
    resolveDir: root,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: (effect) => { effects.push(effect) },
        useLayoutEffect: (effect) => { effects.push(effect) },
        useRef: current => ({ current }),
        useMemo: make => make(), useCallback: fn => fn, useId: () => 'act-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error('no platform module ' + name)
    return platform[name]
  },
})
const { AssistantCell, AgentActivityRow } = module.exports

const mount = () => {
  const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function')
  effects = []
  return () => { for (const cleanup of cleanups) cleanup() }
}
const findAll = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...findAll(node.children ?? node.props?.children, match)]
}

const bot = { id: 'b', name: 'Writer' }
const roster = { bots: [bot], byId: { b: bot }, roomsById: {}, exchangeTurns: {} }
// A step of a local-agent turn: thinking prose, then the CLI's activity lines.
const thinkStep = (over = {}) => ({
  turn: 3, step: 1, seq: 10, status: 'settled', time: 1_700_000_000_000,
  blocks: [
    { kind: 'reasoning', text: 'Looking at the request\n▸ search_tool(query: x)\n▸ Read src/a.js' },
    { kind: 'text', text: 'Done.' },
  ],
  ...over,
})
const propsFor = (data, prefs) => ({
  node: { key: 'n10', location: { kind: 'step', turn: { turn: 3, status: 'closed' } }, data },
  sessionId: 'b',
  useRoster: select => select({ ...roster, prefs }),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
})

test('with thinking shown, the actions collapse into one row apart from the reasoning', () => {
  const cell = AssistantCell(propsFor(thinkStep(), { thinking: true }))
  const rows = findAll(cell, node => node.type === AgentActivityRow)
  assert.equal(rows.length, 1)
  assert.deepEqual(Array.from(rows[0].props.lines), ['search_tool(query: x)', 'Read src/a.js'])
  // The activity lines leave the thinking prose.
  const thinkRows = findAll(cell, node => typeof node.type === 'function' && node.type.name === 'ThinkingRow')
  assert.equal(thinkRows.length, 1)
  assert.equal(thinkRows[0].props.text, 'Looking at the request')
})

test('with thinking hidden, no actions row stays in the transcript', () => {
  for (const prefs of [undefined, {}, { thinking: false }]) {
    const cell = AssistantCell(propsFor(thinkStep(), prefs))
    assert.equal(findAll(cell, node => node.type === AgentActivityRow).length, 0, JSON.stringify(prefs))
  }
})

test('a running step feeds its latest action to the activity row, transcript clean or not', () => {
  for (const prefs of [{ thinking: false }, { thinking: true }]) {
    const notes = []
    const props = {
      ...propsFor(thinkStep({ status: 'running', blocks: [{ kind: 'reasoning', text: '▸ Read src/a.js\n▸ edit `src/b.js`' }] }), prefs),
      actions: { noteLive: (sessionId, id, entry) => notes.push({ sessionId, id, entry }) },
    }
    AssistantCell(props)
    const unmount = mount()
    const agentNotes = notes.filter(note => note.id.startsWith('agent:') && note.entry)
    assert.equal(agentNotes.length, 1, JSON.stringify(notes))
    assert.equal(agentNotes[0].entry.label, 'Writing changes')
    assert.equal(agentNotes[0].entry.state, 'working')
    // A meta action whispers as generic work, never with its raw name.
    const metaProps = {
      ...props,
      node: { key: 'n11', location: { kind: 'step', turn: { turn: 4, status: 'closed' } }, data: thinkStep({ turn: 4, status: 'running', blocks: [{ kind: 'reasoning', text: '▸ search_tool(query: schedule)' }] }) },
    }
    notes.length = 0
    AssistantCell(metaProps)
    mount()
    const meta = notes.filter(note => note.id.startsWith('agent:') && note.entry)[0]
    assert.equal(meta.entry.label, null, JSON.stringify(notes))
    assert.equal(meta.entry.state, 'working')
    unmount()
  }
})

test('a running step whose reply text started feeds no local action', () => {
  const notes = []
  const props = {
    ...propsFor(thinkStep({ status: 'running', blocks: [{ kind: 'reasoning', text: '▸ Read src/a.js' }, { kind: 'text', text: 'Answering' }] }), { thinking: false }),
    actions: { noteLive: (sessionId, id, entry) => notes.push({ sessionId, id, entry }) },
  }
  AssistantCell(props)
  mount()
  assert.equal(notes.filter(note => note.id.startsWith('agent:') && note.entry).length, 0, JSON.stringify(notes))
  effects = []
})
