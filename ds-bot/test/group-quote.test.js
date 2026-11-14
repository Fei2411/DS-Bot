import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The group chat's Reply tool and the composer that receives its quote, bundled with a
// minimal React: components run as plain functions and the effects they ask for run on
// demand. #1343: a group whose public chat has split into a new Session keeps its room id,
// so a reply quoting the room id never reached the composer the user was typing in.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ChatRows } from './src/client/cells.js'",
      "export { ComposerVoice } from './src/client/composer.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let effects = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: h, Fragment,
  useEffect: effect => { effects.push(effect) },
  useLayoutEffect: effect => { effects.push(effect) },
  useMemo: make => make(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: current => ({ current }),
  useId: () => 'quote-id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), SpeechRecognition: undefined, webkitSpeechRecognition: undefined },
  document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } },
  navigator: { userAgent: 'test', clipboard: {} },
  // The composer focuses the shell's text box after it inserts, so the page has to know
  // what an element is and what a selection is.
  HTMLElement: class HTMLElement {},
  getSelection: () => ({ selectAllChildren() {}, collapseToEnd() {} }),
  Intl, Date, Math, JSON, console,
  setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
})
const { ChatRows, ComposerVoice } = module.exports

// Components run as plain functions, so a tree expands until only host elements are left.
function expand(node, out) {
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return }
  if (node === null || typeof node !== 'object') return
  if (typeof node.type === 'function') { expand(node.type(node.props), out); return }
  out.push(node)
  expand(node.props?.children, out)
}

// The elements a component draws, with its effects run once the expansion is done.
function render(component, props) {
  effects = []
  const out = []
  expand(component(props), out)
  for (const effect of effects) effect()
  return out
}

function replyButton(elements) {
  return elements.find(node => ['Reply', '回复'].includes(node.props?.['aria-label']))
}

const writers = {
  byId: { writer: { id: 'writer', name: 'Writer', color: 'gray' } },
  bots: [{ id: 'writer', name: 'Writer', color: 'gray' }],
  prefs: {},
}
// A group whose public chat is still its first Session, and one that split into part 2.
const INTACT = { id: 'group-a', sessionId: 'group-a', name: 'A', admin: null }
const SPLIT = { id: 'group-b', sessionId: 'group-b-part2', name: 'B', admin: null }

function rosterWith(room, sessionId) {
  return { ...writers, roomsById: { [sessionId]: room } }
}

// What the composer set receives: the Session the group chat on screen draws into.
function quotedFrom(room, sessionId) {
  const quoted = []
  const actions = { quote: (id, text) => quoted.push({ id, text }), openSession() {}, fileText: async () => '' }
  const roster = rosterWith(room, sessionId)
  const elements = render(ChatRows, {
    items: [{ kind: 'post', botId: 'writer', text: 'the plan is ready', texts: ['the plan is ready'], time: Date.UTC(2026, 0, 1, 9), seq: 7 }],
    sessionId, roster, actions, useUi: select => select({ reactions: {} }),
  })
  const button = replyButton(elements)
  assert.ok(button, 'the reply tool is on the row')
  button.props.onClick()
  assert.equal(quoted.length, 1, 'one quote')
  return quoted[0]
}

// The composer's own side: a quote addressed to its Session inserts its line.
function composerInserts(sessionId, quote) {
  const inserted = []
  const state = { quote }
  render(ComposerVoice, {
    sessionId,
    inputActions: { insertText: (text) => inserted.push(text), captureInsertion: () => ({}) },
    actions: { clearQuote() {}, speech: () => undefined },
    useUi: select => select(state),
    useRoster: select => select({ ...writers, prefs: {} }),
  })
  return inserted
}

test('a reply in a group that split its chat quotes into the Session on screen', () => {
  assert.deepEqual(quotedFrom(SPLIT, 'group-b-part2'), { id: 'group-b-part2', text: 'the plan is ready' })
  // The bug: the row sent the stable room id, while the composer listens for the Session.
  const room = SPLIT
  assert.notEqual(room.id, room.sessionId)
})

test('a reply in a group that never split quotes into its Session as before', () => {
  assert.deepEqual(quotedFrom(INTACT, 'group-a'), { id: 'group-a', text: 'the plan is ready' })
})

test('the quote reaches the composer of the chat it came from, in both groups', () => {
  for (const [room, sessionId] of [[INTACT, 'group-a'], [SPLIT, 'group-b-part2']]) {
    const quoted = quotedFrom(room, sessionId)
    const inserted = composerInserts(sessionId, { sessionId: quoted.id, text: quoted.text, token: 1 })
    assert.deepEqual(inserted, ['> the plan is ready\n\n'], `quoted into ${sessionId}`)
  }
})

test('a quote meant for another chat does not land in this composer', () => {
  assert.deepEqual(composerInserts('group-a', { sessionId: 'group-b-part2', text: 'from B', token: 1 }), [])
  assert.deepEqual(composerInserts('group-b-part2', { sessionId: 'group-b', text: 'the room id', token: 1 }), [],
    'the room id is not the Session the composer draws')
})
