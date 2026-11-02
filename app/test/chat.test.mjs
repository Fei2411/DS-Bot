import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The app's composer shares the Enter preference with the plugin's: the voice
// buttons read it from the roster, and a plain Enter submits only while it says
// Enter sends; off, the field's own newline stands and the send button submits.
// Parts of the page outside the composer are stubbed: this checks the wiring
// from the chat's hooks down to the textarea and the plugin's voice buttons.
const stubs = {
  'cells.js': 'export const Bubbles = () => null\nexport const ChatRows = () => null\nexport const Shimmer = () => null\n',
  'model-menu.js': 'export const ModelChoiceDock = () => null\n',
  'api.js': "export const call = async () => ({ sessionId: 'b1', items: [], cursor: null })\n",
}
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../ui/src/chat.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'app-chat-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /src\/client\/(cells|model-menu|api)\.js$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'app-chat-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'app-chat-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
// Null refs get a field stand-in: the composer's own effects touch its style,
// focus and caret before the browser would have attached the real textarea.
const field = {
  style: {}, scrollHeight: 0, selectionStart: 0, selectionEnd: 0,
  focus() {}, closest: () => null, contains: () => false,
  addEventListener() {}, removeEventListener() {}, abort() {},
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial === null ? field : initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => slot(() => ({ id: 'card-id' })).id,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800 },
  document: { querySelector: () => null, body: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
  setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: () => { throw new Error('no fetch in test') },
})
const { Chat } = module.exports

// Function children stay inert in the React stand-in, so the tree is expanded by
// calling them: Composer, ComposerPlus and ComposerVoice really run, in order,
// sharing the hook slots the way React would.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: node.props.children.map(expand) } }
}
const mount = (props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = expand(Chat(next))
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
  }
  return instance
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props.children, check)]
}
const textarea = node => all(node, child => child.type === 'textarea' && child.props?.['data-composer-input'] !== undefined)[0]
const sendButton = node => all(node, child => child.type === 'button' && child.props?.className === 'dsb-send')[0]
const answerField = node => all(node, child => child.props?.className === 'bt-q-input')[0]
const enter = (extra = {}) => ({
  key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, prevented: false,
  preventDefault() { this.prevented = true }, ...extra,
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

// Mounts a Bot's chat with `prefs` in the roster, types a draft, and returns the
// send log plus the rendered tree accessor.
const view = (prefs, ready = true, question) => {
  const sent = []
  const answered = []
  const roster = { ready, prefs, byId: { b1: { id: 'b1', name: 'Bot' } }, roomsById: {}, questions: question ? { b1: question } : {} }
  const team = {
    actions: {
      noteSent() {},
      send: async (sessionId, text) => { sent.push([sessionId, text]) },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
      answerQuestion: async (sessionId, id, answer) => { answered.push([sessionId, id, answer]) },
      dismissQuestion() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: () => () => {} },
  }
  const instance = mount({ sessionId: 'b1', team })
  textarea(instance.render()).props.onChange({ target: { value: 'hi' } })
  return { sent, answered, tree: () => instance.render() }
}

test('with Enter sending on, a plain Enter sends the draft and clears it', async () => {
  const { sent, tree } = view({ enterToSend: true })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(sent), [['b1', 'hi']])
  assert.equal(textarea(tree()).props.value, '')
})

test('with Enter sending off, a plain Enter is a newline and the send button sends', async () => {
  const { sent, tree } = view({ enterToSend: false })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, false)
  assert.deepEqual(plain(sent), [])
  assert.equal(textarea(tree()).props.value, 'hi')
  // The explicit send control carries the same send.
  sendButton(tree()).props.onClick()
  await tick()
  assert.deepEqual(plain(sent), [['b1', 'hi']])
  assert.equal(textarea(tree()).props.value, '')
})

test('a roster without the flag keeps the default: Enter sends', async () => {
  const { sent, tree } = view({})
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(sent), [['b1', 'hi']])
})

// The Bot's ask_user card shares the composer preference: off, a plain Enter in
// the own-answer field is the field's newline and the card's Submit answers.
test('the ask_user own-answer field honors the Enter preference', async () => {
  const question = { id: 'q1', question: 'Pick?', options: ['Alpha', 'Beta'], allowCustom: true }
  const sending = view({ enterToSend: true }, true, question)
  answerField(sending.tree()).props.onChange({ target: { value: 'own' } })
  const on = enter()
  answerField(sending.tree()).props.onKeyDown(on)
  await tick()
  assert.equal(on.prevented, true)
  assert.deepEqual(plain(sending.answered), [['b1', 'q1', { selected: [], custom: 'own' }]])
  const keeping = view({ enterToSend: false }, true, question)
  answerField(keeping.tree()).props.onChange({ target: { value: 'own' } })
  const off = enter()
  answerField(keeping.tree()).props.onKeyDown(off)
  await tick()
  assert.equal(off.prevented, false)
  assert.deepEqual(plain(keeping.answered), [])
})

test('Shift+Enter and IME confirmation keep their default behavior', async () => {
  for (const extra of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }]) {
    const { sent, tree } = view({ enterToSend: true })
    const event = enter(extra)
    textarea(tree()).props.onKeyDown(event)
    await tick()
    assert.equal(event.prevented, false)
    assert.deepEqual(plain(sent), [])
  }
})
