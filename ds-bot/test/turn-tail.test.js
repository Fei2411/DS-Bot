import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: (run) => { effects.push(run) }, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, TurnTailCell, ThinkingRow } = module.exports

// Renders the named components of an element tree, leaving the rest as elements.
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: node.children.map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}

const roster = { bots: [], byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {}, exchangeTurns: {} }
const finished = { turn: 3, status: 'closed', end: { time: 2_000 } }
function cellProps({ closingSeq = 10, turn = finished } = {}) {
  const asked = []
  const links = { resolve: () => undefined }
  const props = {
    node: {
      key: 'n10',
      location: { kind: 'step', turn },
      data: { turn: 3, step: 1, seq: 10, status: 'done', finalNode: { seq: 10 }, blocks: [{ kind: 'text', text: 'The brief is in `/work/brief.md`.' }] },
    },
    sessionId: 'b',
    openFile: () => {},
    fileMentions: (owner) => { asked.push(owner); return links },
    useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: closingSeq } } } : undefined),
    useRoster: select => select(roster),
    useUi: () => null,
    useTurnSteps: () => [],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  }
  return { props, asked, links }
}
const markdownOf = props => find(expand(AssistantCell(props), ['Bubbles', 'Bubble']), node => node.type === MarkdownText)

test('a reply that closes its turn links the files the turn changed or delivered', () => {
  const { props, asked, links } = cellProps()
  const [markdown] = markdownOf(props)
  assert.equal(markdown.props.fileMentions, links)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].turn, finished)
  assert.equal(asked[0].seq, 10)
  assert.equal(asked[0].openFile, props.openFile)
})

test('a reply that does not close its turn, or one still running, links nothing', () => {
  const earlier = cellProps({ closingSeq: 12 })
  assert.equal(markdownOf(earlier.props)[0].props.fileMentions, undefined)
  const running = cellProps({ turn: { turn: 3, status: 'open' } })
  assert.equal(markdownOf(running.props)[0].props.fileMentions, undefined)
  assert.equal(earlier.asked.length + running.asked.length, 0)
})

test('the turn tail entry notes when the turn ended and shows the pause before the next one', () => {
  effects.length = 0
  const noted = []
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 60 * 1000 } } }
  const out = TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime: (...args) => noted.push(args) },
  })
  for (const run of effects) run()
  assert.deepEqual(noted, [['b', 3, 'end', 2_000]])
  assert.equal(find(out, node => node.props?.className === 'bt-time-sep').length, 1)
})

// #206: the user reads a Bot's reply in its own chat, so it folds only where rendering
// all of it would slow the chat down.
test('a Bot reply in its own chat stays whole up to 20,000 characters', () => {
  const reply = text => {
    const { props } = cellProps()
    props.node.data.blocks = [{ kind: 'text', text }]
    return markdownOf(props)[0].props.text
  }
  const long = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of a long answer.`).join('\n')
  assert.equal(reply(long), long)
  assert.equal(reply('w'.repeat(25_000)), 'w'.repeat(600))
})

// #465: the thinking row stays a switchable extra, and the one activity row is
// never given up to it.
test('the thinking row shows only with its switch on, and the activity row is never yielded to it', () => {
  const cell = (prefs, blocks, steps) => {
    effects.length = 0
    const noted = []
    const { props } = cellProps()
    props.node.data = { turn: 3, step: 1, seq: 10, status: 'running', finalNode: { seq: 10 }, blocks }
    props.useTurnSteps = () => steps
    props.actions = { noteLive: (sessionId, id) => noted.push(id) }
    const useRoster = select => select({ ...roster, prefs })
    const out = expand(AssistantCell({ ...props, useRoster }), [])
    for (const run of effects) run()
    return { out, noted }
  }
  const reason = [{ kind: 'reasoning', text: 'Weighing it' }]
  const thinking = { turn: 3, step: 1, status: 'running', blocks: reason }
  // Off: a thinking step draws nothing and notes nothing.
  const off = cell({}, reason, [thinking])
  assert.equal(off.out, null)
  assert.deepEqual(off.noted, [])
  // On: the live row shows — and still notes nothing, so the activity row stays.
  const on = cell({ thinking: true }, reason, [thinking])
  assert.equal(find(on.out, node => node.type === ThinkingRow).length, 1)
  assert.equal(on.noted.filter(id => id.startsWith('think:')).length, 0)
  assert.deepEqual(on.noted, [])
  // A reply streaming in does give the activity row its one note, on or off.
  const replying = { turn: 3, step: 1, status: 'running', blocks: [{ kind: 'reasoning', text: 'Weighing it' }, { kind: 'text', text: 'Done' }] }
  for (const prefs of [{}, { thinking: true }]) {
    const { noted } = cell(prefs, replying.blocks, [replying])
    assert.ok(noted.every(id => id.startsWith('text:')))
  }
})
