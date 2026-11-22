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
  'cells.js': 'export const Bubbles = ({ texts }) => texts.join(" ")\nexport const ChatRows = (props) => ({ type: "chat-rows", props: { ...props, children: [] } })\nexport const Shimmer = () => null\n',
  'model-menu.js': 'export const ModelChoiceDock = () => null\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
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
const defaultCall = async () => ({ sessionId: 'b1', items: [], cursor: null })
const sandbox = {
  module, exports: module.exports,
  __testCall: defaultCall,
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
}
runInNewContext(outputFiles[0].text, sandbox)
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
    unmount() {
      for (const cell of instance.slots) cell?.stop?.()
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
const view = (prefs, ready = true, question, { ui = {} } = {}) => {
  const listeners = new Set()
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
      useUi: select => select(ui),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }
  const instance = mount({ sessionId: 'b1', team })
  textarea(instance.render()).props.onChange({ target: { value: 'hi' } })
  return { sent, answered, emit: (event, data) => { for (const listener of listeners) listener(event, data) }, tree: () => instance.render() }
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


test('a parallel part cannot write or clear the viewed part stream', async () => {
  const { emit, tree } = view({})
  await tick()
  const text = node => JSON.stringify(node)
  emit('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'front', phase: 'start' })
  emit('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'front', text: 'foreground reply' })
  emit('stream', { botId: 'b1', sessionId: 'background', attemptId: 'back', phase: 'start' })
  emit('stream', { botId: 'b1', sessionId: 'background', attemptId: 'back', text: 'background reply' })
  assert.match(text(tree()), /foreground reply/)
  assert.doesNotMatch(text(tree()), /background reply/)
  emit('message', { botId: 'b1', sessionId: 'background', item: { kind: 'bot', text: 'done', time: 100 } })
  assert.match(text(tree()), /foreground reply/)
})

function mountRoom(callImpl) {
  sandbox.__testCall = callImpl
  const listeners = new Set()
  const sent = []
  const roster = {
    ready: true,
    prefs: { enterToSend: true },
    byId: {
      b1: { id: 'b1', name: 'Alpha', color: 'blue' },
      b2: { id: 'b2', name: 'Beta', color: 'green' },
    },
    roomsById: { r1: { id: 'r1', name: 'Design', members: ['b1', 'b2'], admin: 'b1' } },
    questions: {},
  }
  const team = {
    actions: {
      noteSent() {},
      send: async (sessionId, text) => { sent.push([sessionId, text]) },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }
  const instance = mount({ sessionId: 'r1', team })
  instance.render()
  const rowsOf = () => {
    const t = instance.render()
    const rows = all(t, child => child.type === 'chat-rows')
    const main = rows[0]?.props.items ?? []
    const pending = rows[1]?.props.items ?? []
    return { tree: t, main, pending }
  }
  return {
    sent,
    instance,
    rowsOf,
    emit: (event, data) => { for (const listener of listeners) listener(event, data) },
    unmount: () => { instance.unmount(); sandbox.__testCall = defaultCall },
  }
}

test('group chat adapts room-chat bot/event items to post/relay and preserves earlier pages across room SSE refreshes', async () => {
  let latestItems = [
    { id: '3', kind: 'bot', botId: 'b1', name: 'Alpha', color: 'blue', text: 'First', time: 300 },
    { id: '4', kind: 'event', event: 'done', botId: 'b1', name: 'Alpha', color: 'blue', time: 400 },
  ]
  const earlierItems = [
    { id: '1', kind: 'user', text: 'Older prompt', time: 100 },
    { id: '2', kind: 'bot', botId: 'b2', name: 'Beta', color: 'green', text: 'Older reply', time: 200 },
  ]
  const room = mountRoom(async (name, body) => {
    assert.equal(name, 'room-chat')
    if (body.cursor) return { roomId: 'r1', items: earlierItems, cursor: null }
    return { roomId: 'r1', items: latestItems, cursor: { part: 0, beforeSeq: 3 } }
  })
  try {
    await tick()
    let { tree, main } = room.rowsOf()
    assert.deepEqual(plain(main.map(i => [i.id, i.kind])), [['3', 'post'], ['4', 'relay']])
    assert.equal(main[0].botId, 'b1')
    assert.equal(main[1].reply.kind, 'done')

    // User loads earlier page: items become [1, 2, 3, 4] and cursor becomes null.
    const loadEarlierBtn = all(tree, child => child.type === 'button' && child.props?.className === 'bt-soft')[0]
    assert.ok(loadEarlierBtn, 'Load earlier button should show while cursor is present')
    loadEarlierBtn.props.onClick()
    await tick()
    ;({ tree, main } = room.rowsOf())
    assert.deepEqual(plain(main.map(i => i.id)), ['1', '2', '3', '4'])
    assert.equal(all(tree, child => child.type === 'button' && child.props?.className === 'bt-soft').length, 0, 'cursor is null after loading all history')

    // A room SSE event arrives with a new reply on the newest page -> earlier items [1, 2]
    // and cursor (null) MUST be preserved, not overwritten.
    latestItems = [
      ...latestItems,
      { id: '5', kind: 'bot', botId: 'b2', name: 'Beta', color: 'green', text: 'New reply', time: 500 },
    ]
    room.emit('room', { roomId: 'r1' })
    await tick()
    ;({ tree, main } = room.rowsOf())
    assert.deepEqual(plain(main.map(i => i.id)), ['1', '2', '3', '4', '5'])
    assert.equal(all(tree, child => child.type === 'button' && child.props?.className === 'bt-soft').length, 0, 'SSE refresh must not rewind cursor')
  } finally {
    room.unmount()
  }
})

test('group chat cancels queued reload when unmounted during an in-flight request', async () => {
  let calls = 0
  let resolveFirst
  const room = mountRoom(() => {
    calls += 1
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve })
    return Promise.resolve({ roomId: 'r1', items: [], cursor: null })
  })
  try {
    assert.equal(calls, 1)
    // Emit room SSE while first load is still in flight -> sets reloadQueued = true.
    room.emit('room', { roomId: 'r1' })
    // Unmount BEFORE first load resolves.
    room.unmount()
    resolveFirst({ roomId: 'r1', items: [{ id: '1', kind: 'user', text: 'hi', time: 100 }], cursor: null })
    await tick()
    await tick()
    assert.equal(calls, 1, 'unmounted component must not fire queued reload in finally')
  } finally {
    sandbox.__testCall = defaultCall
  }
})

test('group chat pending dedup does not drop repeated short messages like "继续" against older history or other copies', async () => {
  let serverItems = [
    { id: '10', kind: 'user', text: '继续', time: 1000 },
  ]
  const room = mountRoom(async () => ({ roomId: 'r1', items: serverItems, cursor: null }))
  try {
    await tick()
    room.rowsOf()

    // Send "继续" twice while an older "继续" (id: 10) already exists in history.
    const sendText = async (value) => {
      const t = room.rowsOf().tree
      textarea(t).props.onChange({ target: { value } })
      sendButton(room.rowsOf().tree).props.onClick()
      await tick()
    }
    await sendText('继续')
    await sendText('继续')
    assert.equal(room.rowsOf().pending.length, 2, 'both newly sent messages start pending')

    // SSE refresh arrives before either new message lands (only old id 10 + bot reply exist).
    serverItems = [...serverItems, { id: '11', kind: 'bot', botId: 'b1', name: 'Alpha', text: 'working', time: 2000 }]
    room.emit('room', { roomId: 'r1' })
    await tick()
    assert.equal(room.rowsOf().pending.length, 2, 'historical "继续" must not clear newly sent pending messages')

    // First new "继续" lands (id: 15) -> clears exactly ONE pending entry.
    serverItems = [...serverItems, { id: '15', kind: 'user', text: '继续', time: 3000 }]
    room.emit('room', { roomId: 'r1' })
    await tick()
    assert.equal(room.rowsOf().pending.length, 1, 'one server message must clear only one matching pending entry')

    // Another unrelated SSE refresh before second "继续" lands -> remaining pending entry stays.
    serverItems = [...serverItems, { id: '16', kind: 'bot', botId: 'b2', name: 'Beta', text: 'step', time: 3500 }]
    room.emit('room', { roomId: 'r1' })
    await tick()
    assert.equal(room.rowsOf().pending.length, 1, 'already-matched id 15 must not clear the second pending entry')

    // Second new "继续" lands (id: 17) -> clears remaining pending entry.
    serverItems = [...serverItems, { id: '17', kind: 'user', text: '继续', time: 4000 }]
    room.emit('room', { roomId: 'r1' })
    await tick()
    assert.equal(room.rowsOf().pending.length, 0, 'second server message clears second pending entry')
  } finally {
    room.unmount()
  }
})
