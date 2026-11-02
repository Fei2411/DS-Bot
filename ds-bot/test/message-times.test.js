import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// cells.js and user-message.js import react; the client tests bundle them and stub
// react, as the other client tests do.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: {
    contents: "export { AssistantCell } from './src/client/cells.js'\nexport { UserMessageCell } from './src/client/user-message.js'",
    resolveDir: root,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }),
        useMemo: make => make(), useCallback: fn => fn, useId: () => 'mt-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null, projectUserText: text => text },
    }
    if (!(name in platform)) throw new Error('no platform module ' + name)
    return platform[name]
  },
})
const { AssistantCell, UserMessageCell } = module.exports

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
const times = (node, names = []) => find(expand(node, names), item => item.props?.className === 'bt-utime')

const roster = { bots: [], byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {}, exchangeTurns: {} }
const userProps = (data = {}, sessionId = 'b') => ({
  node: { kind: 'message', data: { content: [{ type: 'text', text: 'hello' }], time: 1_700_000_000_000, ...data } },
  sessionId,
  useRoster: select => select(roster),
  actions: {},
})

test('a user message shows when it was sent, in its own chat as in a group', () => {
  for (const [sessionId, where] of [['b', 'own chat'], ['room-1', 'group']]) {
    const [when] = times(UserMessageCell(userProps({}, sessionId)))
    assert.equal(when.props.className, 'bt-utime', where)
    assert.equal(typeof when.props.title, 'string', where)
    assert.equal(typeof when.children[0], 'string', where)
  }
})

test('a user message without a real time draws no time node', () => {
  assert.equal(times(UserMessageCell(userProps({ time: undefined }))).length, 0)
  assert.equal(times(UserMessageCell(userProps({ time: 'later' }))).length, 0)
})

const assistantProps = (data = {}, rosterPrefs) => ({
  node: {
    key: 'n10',
    location: { kind: 'step', turn: { turn: 3, status: 'closed', end: { time: 2_000 } } },
    data: { turn: 3, step: 1, seq: 10, status: 'done', time: 1_700_000_000_000, blocks: [{ kind: 'text', text: 'Done.' }], ...data },
  },
  sessionId: 'b',
  useRoster: select => select({ ...roster, prefs: rosterPrefs }),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
})
const bubbles = node => expand(node, ['Bubbles', 'Bubble', 'SpeakerHead'])

test('a Bot reply in its own chat shows when it went out under the bubbles', () => {
  const [when] = times(bubbles(AssistantCell(assistantProps())))
  assert.equal(when.props.className, 'bt-utime')
  assert.equal(typeof when.props.title, 'string')
  assert.equal(typeof when.children[0], 'string')
})

test('a reply without a real time, and the flat layout whose head already shows one, draw no extra time', () => {
  assert.equal(times(bubbles(AssistantCell(assistantProps({ time: undefined })))).length, 0)
  const flat = bubbles(AssistantCell(assistantProps({}, { layout: 'flat' })))
  // The speaker head keeps the turn's one time; nothing repeats it under the bubbles.
  assert.equal(find(flat, node => node.props?.className === 'bt-group-time').length, 1)
  assert.equal(times(flat).length, 0)
})
