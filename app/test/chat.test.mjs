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
const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const deepViewReact = fileURLToPath(import.meta.resolve('deep-view/react'))
const stubs = {
  'cells.js': 'export const Bubbles = ({ texts }) => ({ type: "bubbles", props: { texts, children: texts } })\nexport const ThinkingRow = ({ text, live }) => ({ type: "thinking", props: { text, live, children: [text] } })\nexport const EarlierParts = () => null\nexport const PartLine = () => null\nexport const ChatRows = (props) => ({ type: "chat-rows", props: { ...props, children: [] } })\nexport const Shimmer = () => null\nexport const Elapsed = () => null\nexport const workPhrase = () => ""\nexport const ToolCell = (props) => ({ type: "tool-cell", props: { ...props, children: [] } })\nexport const isBotTool = name => ["show_view", "ask_user", "request_secret", "message_bot", "computer_handoff"].includes(name)\n',
  'widget-cell.js': 'export const WidgetCell = () => null\nexport const WidgetDock = () => null\nexport const AnsweredReply = () => null\nexport const ViewCard = () => null\n',
  'model-menu.js': 'export const ModelChoiceDock = () => null\nexport const ModelKeyCard = () => null\nexport const ModelMenu = () => null\nexport const Caret = () => null\nexport const useAnchoredMenu = () => ({ open: false, setOpen() {}, triggerRef: { current: null }, menuRef: { current: null }, style: {} })\nexport const modelOf = () => null\nexport const manageModels = () => undefined\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': 'export const FishLogo = ({ size, className }) => ({ type: "fish-logo", props: { size, className, children: [] } })\nexport const MarkdownText = ({ text }) => ({ type: "markdown", props: { text, children: [text] } })\nexport const writeClipboard = async () => true\nexport const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ""))?.[1] ?? ""\nexport const fileSizeText = bytes => (Number.isFinite(bytes) ? `${bytes} B` : "")\n',
}
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../ui/src/chat.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'app-chat-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^deep-view\/react$/ }, () => ({ path: deepViewReact }))
      bundler.onResolve({ filter: /(src\/client\/(cells|widget-cell|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'app-chat-stub' }
      })
      // Sibling modules inside `ds-bot/src/client/` import `./cells.js`, `./widget-cell.js`,
      // `./model-menu.js`, `./api.js` relatively; stub those too without intercepting `app/ui/src/api.js`.
      bundler.onResolve({ filter: /^\.\/(cells|widget-cell|model-menu|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'app-chat-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'app-chat-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
let current
const slot = (make) => {
  const bucket = current.fiber
  const index = bucket.index++
  return bucket.slots[index] ??= make()
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
class TestComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
}
const MEMO_TYPE = Symbol.for('react.memo')
const react = {
  Component: TestComponent,
  Fragment: 'fragment',
  memo: fn => ({ $$typeof: MEMO_TYPE, type: fn }),
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
  createContext: value => ({ _default: value, Provider: ({ children }) => children }),
  useContext: ctx => ctx?._default,
}
const module = { exports: {} }
const defaultCall = async () => ({ sessionId: 'b1', items: [], cursor: null })
// Controllable SSE stream for `openSessionFollow` (`/api/bot/session?...`).
function createSseControl() {
  const streams = new Map()
  const encoder = new TextEncoder()
  const fetch = async (url, { signal } = {}) => {
    const parsed = new URL(url, 'http://localhost')
    const id = parsed.searchParams.get('id') ?? ''
    const queue = []
    let waiter = null
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
    }
    signal?.addEventListener?.('abort', finish)
    const entry = {
      url,
      push(event, data) {
        if (closed) return
        const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        if (waiter) { const w = waiter; waiter = null; w({ value: chunk, done: false }) }
        else queue.push(chunk)
      },
      close: finish,
    }
    streams.set(id, entry)
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => { waiter = resolve })
          },
          cancel: () => { finish(); return Promise.resolve() },
        }),
      },
    }
  }
  return { fetch, get: id => streams.get(id), clear: () => { for (const s of streams.values()) s.close(); streams.clear() } }
}
const sse = createSseControl()
const sandbox = {
  module, exports: module.exports,
  __testCall: defaultCall,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`no platform module ${name}`)
  },
  AbortController, TextDecoder, URLSearchParams, console,
  window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800 },
  document: { querySelector: () => null, body: { toggleAttribute() {}, removeAttribute() {} }, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
  setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: (...args) => sse.fetch(...args),
}
runInNewContext(outputFiles[0].text, sandbox)
const { Chat } = module.exports

// Function children stay inert in the React stand-in, so the tree is expanded by
// calling them with per-component fiber buckets so dynamic siblings never shift hook slots.
const resolveType = type => (type && typeof type === 'object' && type.$$typeof === MEMO_TYPE ? type.type : type)

const expand = (node, path = 'root') => {
  if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${child?.props?.key ?? idx}]`))
  if (!node || typeof node !== 'object') return node
  const fn = resolveType(node.type)
  if (typeof fn === 'function') {
    const id = `${path}/${fn.name || 'fn'}:${node.props?.key ?? ''}`
    let bucket = current.fibers.get(id)
    if (!bucket) { bucket = { slots: [], index: 0 }; current.fibers.set(id, bucket) }
    bucket.index = 0
    const prev = current.fiber
    current.fiber = bucket
    try {
      if (fn.prototype instanceof TestComponent) {
        const comp = new fn(node.props)
        return expand(comp.render(), id)
      }
      return expand(fn(node.props), id)
    } finally {
      current.fiber = prev
    }
  }
  return { ...node, props: { ...node.props, children: node.props.children.map((child, idx) => expand(child, `${path}.${idx}`)) } }
}
const mount = (props) => {
  const instance = {
    fibers: new Map(), effects: [], props,
    render(next = instance.props) {
      instance.props = next
      current = instance
      const out = expand(react.createElement(Chat, next))
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
    unmount() {
      for (const bucket of instance.fibers.values()) {
        for (const cell of bucket.slots) cell?.stop?.()
      }
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
      useTurnClock: select => select({}),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }
  const instance = mount({ sessionId: 'b1', team })
  textarea(instance.render()).props.onChange({ target: { value: 'hi' } })
  return {
    sent,
    answered,
    emit: (event, data) => { for (const listener of listeners) listener(event, data) },
    pushFrame: (frame, id = 'b1') => sse.get(id)?.push('frame', frame),
    tree: () => instance.render(),
    unmount: () => instance.unmount(),
  }
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
  const { emit, pushFrame, tree, unmount } = view({})
  try {
    await tick()
    const text = node => JSON.stringify(node)
    pushFrame({ type: 'snapshot', header: { id: 'b1', cwd: '/tmp' }, cursor: 0, records: [], hasMore: false })
    pushFrame({ type: 'event', event: { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } } })
    pushFrame({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'front', revision: 1, turn: 1, step: 1, startedAfterSeq: 1 } })
    pushFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'front', revision: 2, index: 0, time: 110, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    pushFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'front', revision: 3, index: 1, time: 111, chunk: { type: 'text-delta', index: 0, text: 'foreground reply' } } })
    await tick()
    await tick()
    // Background part activity on the team feed cannot inject or clear the viewed session's stream.
    emit('stream', { botId: 'b1', sessionId: 'background', attemptId: 'back', phase: 'start' })
    emit('stream', { botId: 'b1', sessionId: 'background', attemptId: 'back', text: 'background reply' })
    assert.match(text(tree()), /foreground reply/)
    assert.doesNotMatch(text(tree()), /background reply/)
    emit('message', { botId: 'b1', sessionId: 'background', item: { kind: 'bot', text: 'done', time: 100 } })
    assert.match(text(tree()), /foreground reply/)
  } finally {
    unmount()
  }
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
    const pendingWrap = all(t, child => child.type === 'div' && child.props?.className === 'dsb-pending')[0]
    const pending = pendingWrap ? all(pendingWrap, child => child.type === 'div' && child.props?.className === 'bt-umsg') : []
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

test('composer supports file picker, clipboard paste, drag-drop, attachment-only send, failure recovery, and Stop button for DM and group', async () => {
  const createdUrls = []
  const revokedUrls = []
  sandbox.URL = {
    createObjectURL: (file) => {
      const url = `blob:test/${createdUrls.length + 1}/${file.name}`
      createdUrls.push(url)
      return url
    },
    revokeObjectURL: (url) => { revokedUrls.push(url) },
  }
  const stagedImages = []
  const stagedFiles = []
  const sentCalls = []
  const stoppedBots = []
  const stoppedRooms = []
  let failSendOnce = false
  const statusMap = new Map([['b1', { running: true }]])
  const roster = {
    ready: true,
    prefs: { enterToSend: true },
    bots: [{ id: 'b1', name: 'Chief', color: 'blue', sessionId: 'b1', parts: [] }],
    byId: { b1: { id: 'b1', name: 'Chief', color: 'blue', sessionId: 'b1', parts: [] } },
    rooms: [{ id: 'r1', name: 'Design', admin: 'b1', members: ['b1'] }],
    roomsById: { r1: { id: 'r1', name: 'Design', admin: 'b1', members: ['b1'] } },
    questions: {},
    views: {},
    exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {},
      noteLive() {},
      stageImage: async (mediaType, data) => {
        stagedImages.push({ mediaType, data })
        return { id: `img-${stagedImages.length}` }
      },
      stageFile: async (name, data, mediaType) => {
        stagedFiles.push({ name, data, mediaType })
        return { id: `file-${stagedFiles.length}` }
      },
      send: async (...args) => {
        if (failSendOnce) { failSendOnce = false; throw new Error('Network dropped') }
        sentCalls.push(args)
      },
      stopChat: async (botId) => { stoppedBots.push(botId) },
      stopRoomWork: async (roomId) => { stoppedRooms.push(roomId) },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(statusMap),
    },
    chat: { on: () => () => {} },
  }

  const dm = mount({ sessionId: 'b1', team })
  try {
    let tree = dm.render()
    // Hidden file input sits inside [data-composer-card] so ComposerPlus surfaces "Add files".
    const fileInputs = all(tree, n => n.type === 'input' && n.props?.type === 'file')
    assert.equal(fileInputs.length, 1)
    assert.equal(fileInputs[0].props.multiple, true)

    // Running DM shows Stop button and calls stopChat(bot.id).
    const stopBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-stop')[0]
    assert.ok(stopBtn, 'running DM renders Stop button')
    stopBtn.props.onClick()
    await tick()
    assert.deepEqual(stoppedBots, ['b1'])

    // Clipboard paste with an image attaches it and prevents default when no plain text.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const imageFile = { name: 'shot.png', type: 'image/png', size: pngBytes.length, arrayBuffer: async () => pngBytes.buffer }
    let prevented = false
    textarea(tree).props.onPaste({
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => imageFile }],
        getData: () => '',
      },
      preventDefault() { prevented = true },
    })
    assert.equal(prevented, true)

    // Drag-and-drop attaches a regular file AND rejects an oversized (>16MB) file with alert.
    const txtBytes = new TextEncoder().encode('hello attachment')
    const txtFile = { name: 'readme.txt', type: 'text/plain', size: txtBytes.length, arrayBuffer: async () => txtBytes.buffer }
    const hugeFile = { name: 'huge.bin', type: 'application/octet-stream', size: 17 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }
    const chatRoot = all(dm.render(), n => n.type === 'div' && n.props?.className === 'dsb-chat')[0]
    chatRoot.props.onDragEnter({ dataTransfer: { types: ['Files'] }, preventDefault() {} })
    assert.equal(all(dm.render(), n => n.type === 'div' && n.props?.className === 'dsb-dropzone').length, 1)
    chatRoot.props.onDrop({ dataTransfer: { files: [txtFile, hugeFile] }, preventDefault() {} })
    tree = dm.render()
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-dropzone').length, 0)
    assert.equal(all(tree, n => n.type === 'p' && n.props?.className === 'dsb-composer-error').length, 1, 'oversized file surfaces error')
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-thumb').length, 1)
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-chip').length, 1)

    // Attachment-only send is enabled even with empty text; failure restores both attachments cleanly!
    failSendOnce = true
    assert.equal(sendButton(tree).props.disabled, false)
    sendButton(tree).props.onClick()
    await tick()
    await tick()
    tree = dm.render()
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-thumb').length, 1, 'failed send restores image attachment')
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-chip').length, 1, 'failed send restores file attachment')
    assert.equal(revokedUrls.length, 0, 'failed send must not revoke restored preview URL')

    // Retry succeeds and stages image + file before calling actions.send.
    sendButton(tree).props.onClick()
    await tick()
    await tick()
    assert.equal(stagedImages.at(-1).mediaType, 'image/png')
    assert.equal(stagedFiles.at(-1).name, 'readme.txt')
    assert.deepEqual(JSON.parse(JSON.stringify(sentCalls.at(-1))), ['b1', '', { images: ['img-2'], files: ['file-2'] }])

    // Removing a staged image revokes its preview URL immediately.
    const img2 = { name: 'two.png', type: 'image/png', size: pngBytes.length, arrayBuffer: async () => pngBytes.buffer }
    fileInputs[0].props.onChange({ target: { files: [img2], value: 'x' } })
    tree = dm.render()
    const removeBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-attach-x')[0]
    removeBtn.props.onClick()
    assert.ok(revokedUrls.some(url => url.includes('two.png')))
  } finally {
    dm.unmount()
  }

  // Group chat running Stop button calls stopRoomWork(room.id) and passes renderUserAttachments to ChatRows.
  statusMap.set('r1', { running: true })
  const grp = mount({ sessionId: 'r1', team })
  try {
    const grpTree = grp.render()
    const stopBtn = all(grpTree, n => n.type === 'button' && n.props?.className === 'dsb-stop')[0]
    assert.ok(stopBtn, 'running group chat renders Stop button')
    stopBtn.props.onClick()
    await tick()
    assert.deepEqual(stoppedRooms, ['r1'])
    const rowsNode = all(grpTree, n => n.type === 'chat-rows')[0]
    assert.equal(typeof rowsNode?.props?.renderUserAttachments, 'function', 'group chat passes renderUserAttachments to ChatRows')
  } finally {
    grp.unmount()
  }
})

test('composer guards read-only mode, resets Stop on queued turns, preserves blob URL across rollover failure, and matches pending attachments by counts', async () => {
  const createdUrls = []
  const revokedUrls = []
  sandbox.URL = {
    createObjectURL: (file) => {
      const url = `blob:ro/${createdUrls.length + 1}/${file.name}`
      createdUrls.push(url)
      return url
    },
    revokeObjectURL: (url) => { revokedUrls.push(url) },
  }
  let resolveSend = null
  let rejectSend = null
  let stopCalls = 0
  const statusMap = new Map([['b1', { running: true }]])
  const roster = {
    ready: true,
    // Real host contract: non-empty explanatory string when locked, null when writable.
    readOnly: 'The Bot team is open in another dsh',
    prefs: { enterToSend: true },
    bots: [{ id: 'b1', name: 'Chief', color: 'blue', sessionId: 'b1', parts: [] }],
    byId: { b1: { id: 'b1', name: 'Chief', color: 'blue', sessionId: 'b1', parts: [] } },
    rooms: [],
    roomsById: {},
    questions: {},
    views: {},
    exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {},
      noteLive() {},
      stageImage: async () => ({ id: 'img-ro' }),
      stageFile: async () => ({ id: 'file-ro' }),
      send: () => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject }),
      stopChat: async () => { stopCalls += 1 },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(statusMap),
    },
    chat: { on: () => () => {} },
  }

  const inst = mount({ sessionId: 'b1', team })
  try {
    // Read-only window (reason string): textarea & send disabled, no Stop button, paste & drag-drop ignored.
    let tree = inst.render()
    assert.equal(textarea(tree).props.disabled, true)
    assert.equal(all(tree, n => n.type === 'button' && n.props?.className === 'dsb-stop').length, 0)
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const imageFile = { name: 'keep.png', type: 'image/png', size: pngBytes.length, arrayBuffer: async () => pngBytes.buffer }
    textarea(tree).props.onPaste({
      clipboardData: { items: [{ kind: 'file', getAsFile: () => imageFile }], getData: () => '' },
      preventDefault() {},
    })
    const chatRoot = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-chat')[0]
    chatRoot.props.onDrop({ dataTransfer: { files: [imageFile] }, preventDefault() {} })
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-thumb').length, 0, 'read-only blocks paste & drop')

    // Unlock read-only (null): Stop resolves while running stays true (queued turn) -> Stop button unlocks again!
    roster.readOnly = null
    tree = inst.render()
    const stopBtn1 = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-stop')[0]
    assert.equal(stopBtn1.props.disabled, false)
    stopBtn1.props.onClick()
    await tick()
    tree = inst.render()
    assert.equal(stopCalls, 1)
    assert.equal(all(tree, n => n.type === 'button' && n.props?.className === 'dsb-stop')[0].props.disabled, false, 'Stop must re-enable after resolving even while queued turn keeps running=true')

    // Batch staging budget (64 MB): selecting 5 x 14 MB files caps at 4 and reports an error so a batch cannot self-evict.
    const bigBatch = Array.from({ length: 5 }, (_, idx) => ({
      name: `doc-${idx}.bin`, type: 'application/octet-stream', size: 14 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0),
    }))
    all(tree, n => n.type === 'input' && n.props?.type === 'file')[0].props.onChange({ target: { files: bigBatch, value: '' } })
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-chip').length, 4, 'at most 4 x 14MB fit inside 64MB batch budget')
    assert.equal(all(tree, n => n.type === 'p' && n.props?.className === 'dsb-composer-error').length, 1)
    // Clear those 4 chips before the rollover test.
    for (const btn of all(tree, n => n.type === 'button' && n.props?.className === 'dsb-attach-x')) {
      btn.props.onClick()
      tree = inst.render()
    }

    // Foreground rollover while send is in flight and then fails -> restored preview URL must NOT be revoked!
    textarea(tree).props.onPaste({
      clipboardData: { items: [{ kind: 'file', getAsFile: () => imageFile }], getData: () => '' },
      preventDefault() {},
    })
    tree = inst.render()
    assert.equal(createdUrls.length, 1)
    sendButton(tree).props.onClick()
    await tick()
    // Session rolls over from b1 -> b1-p2 while send is still pending.
    roster.byId['b1-p2'] = { id: 'b1-p2', name: 'Chief', color: 'blue', sessionId: 'b1-p2', parts: ['b1'] }
    inst.render({ sessionId: 'b1-p2', team })
    assert.equal(revokedUrls.length, 0, 'unsettled pending preview URL must not be revoked on rollover')
    // Send now rejects -> Composer restores the image attachment with its live blob URL intact!
    rejectSend(new Error('offline'))
    await tick()
    await tick()
    tree = inst.render({ sessionId: 'b1-p2', team })
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-attach-thumb').length, 1)
    assert.equal(revokedUrls.length, 0, 'restored preview URL must still be unrevoked')

    // Fast SSE / rollover removes pending BEFORE actions.send resolves AND WITHOUT an intermediate render:
    // once actions.send resolves, entry.removed guarantees the blob URL is revoked exactly once!
    sendButton(tree).props.onClick()
    await tick()
    // Simulate rollover clearing pending before React re-renders, while send is still in flight.
    roster.byId['b1-p3'] = { id: 'b1-p3', name: 'Chief', color: 'blue', sessionId: 'b1-p3', parts: ['b1', 'b1-p2'] }
    inst.render({ sessionId: 'b1-p3', team })
    // Notice pendingRef was updated on render, OR even with fast SSE without re-render: resolveSend now settles!
    resolveSend()
    await tick()
    await tick()
    assert.equal(revokedUrls.filter(url => url.includes('keep.png')).length, 1, 'settled & already-removed preview URL is revoked exactly once')
  } finally {
    inst.unmount()
  }

  // Pending dedup distinguishes attachment-only sends by imageCount & fileCount.
  let serverItems = []
  const room = mountRoom(async () => ({ roomId: 'r1', items: serverItems, cursor: null }))
  try {
    await tick()
    room.rowsOf()
    const fileA = { name: 'a.txt', type: 'text/plain', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
    const imgA = { name: 'p.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
    // Send 1 file-only message and 1 image-only message (both with empty text '').
    let tree = room.rowsOf().tree
    all(tree, n => n.type === 'input' && n.props?.type === 'file')[0].props.onChange({ target: { files: [fileA], value: '' } })
    sendButton(room.rowsOf().tree).props.onClick()
    await tick()
    await tick()
    tree = room.rowsOf().tree
    all(tree, n => n.type === 'input' && n.props?.type === 'file')[0].props.onChange({ target: { files: [imgA], value: '' } })
    sendButton(room.rowsOf().tree).props.onClick()
    await tick()
    await tick()
    assert.equal(room.rowsOf().pending.length, 2)

    // Server settles ONLY the image message (text: '', images: 1) -> must NOT clear the file-only pending entry!
    serverItems = [{ id: '20', kind: 'user', text: '', images: 1, imageRefs: [{ attachmentId: 'att-img' }], time: Date.now() }]
    room.emit('room', { roomId: 'r1' })
    await tick()
    assert.equal(room.rowsOf().pending.length, 1)
    assert.equal(all(room.rowsOf().pending[0], n => n.props?.className === 'bt-ufile').length, 1, 'remaining pending entry is the file attachment')
  } finally {
    room.unmount()
  }

  // Fast SSE clears pending BEFORE actions.send resolves and WITHOUT an intermediate React render ->
  // once actions.send resolves, entry.removed guarantees the preview URL is still revoked exactly once!
  let fastResolve = null
  let fastItems = []
  const fastListeners = new Set()
  const fastRoster = {
    ready: true, readOnly: null, prefs: { enterToSend: true },
    bots: [{ id: 'b1', name: 'Alpha' }], byId: { b1: { id: 'b1', name: 'Alpha' } },
    rooms: [{ id: 'r2', name: 'Fast', members: ['b1'], sessionId: 'r2' }],
    roomsById: { r2: { id: 'r2', name: 'Fast', members: ['b1'], sessionId: 'r2' } },
    questions: {}, views: {}, exchangeTurns: {},
  }
  sandbox.__testCall = async () => ({ roomId: 'r2', items: fastItems, cursor: null })
  const fastTeam = {
    actions: {
      noteSent() {}, noteLive() {},
      stageImage: async () => ({ id: 'img-fast' }),
      send: () => new Promise(resolve => { fastResolve = resolve }),
      speech: () => undefined, openVoice() {}, clearQuote() {}, canReferenceChat: () => false,
    },
    hooks: {
      useRoster: s => s(fastRoster), useUi: s => s({}), useSessionStatus: s => s(new Map()),
    },
    chat: { on: fn => { fastListeners.add(fn); return () => fastListeners.delete(fn) } },
  }
  const fast = mount({ sessionId: 'r2', team: fastTeam })
  try {
    fast.render()
    await tick()
    const fastImg = { name: 'fast-sse.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
    all(fast.render(), n => n.type === 'input' && n.props?.type === 'file')[0].props.onChange({ target: { files: [fastImg], value: '' } })
    sendButton(fast.render()).props.onClick()
    await tick()
    // SSE echoes the image BEFORE fastResolve() and WITHOUT any intermediate fast.render()!
    fastItems = [{ id: '99', kind: 'user', text: '', images: 1, imageRefs: [{ attachmentId: 'att-fast' }], time: Date.now() }]
    for (const fn of fastListeners) fn('room', { roomId: 'r2' })
    await tick()
    await tick()
    assert.equal(revokedUrls.filter(url => url.includes('fast-sse.png')).length, 0, 'unsettled URL not revoked yet')
    fastResolve()
    await tick()
    await tick()
    assert.equal(revokedUrls.filter(url => url.includes('fast-sse.png')).length, 1, 'revoked once on settle even with no intermediate render')
  } finally {
    fast.unmount()
    sandbox.__testCall = defaultCall
  }
})

test('DSH Agent blank session renders AgentEmptyHero with workspace folder and full + composer menu', async () => {
  const openedFiles = []
  const openedTerminals = []
  const roster = {
    ready: true,
    readOnly: null,
    prefs: { enterToSend: true },
    bots: [],
    byId: {},
    rooms: [],
    roomsById: {},
    agents: [{ id: 'a1', name: 'DSH Agent', sessions: ['agent-s1'] }],
    agentsById: { a1: { id: 'a1', name: 'DSH Agent', sessions: ['agent-s1'] } },
    agentOf: { 'agent-s1': 'a1' },
    questions: {},
    views: {},
    exchangeTurns: {},
  }
  const sessionsState = { ids: ['agent-s1'], byId: { 'agent-s1': { id: 'agent-s1', blank: true } } }
  const team = {
    actions: {
      noteSent() {},
      noteLive() {},
      send: async () => {},
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
      openFiles: () => { openedFiles.push(true) },
      canOpenTerminal: () => true,
      newTerminal: () => { openedTerminals.push(true) },
    },
    hooks: {
      useRoster: s => s(roster),
      useSessions: s => s(sessionsState),
      useUi: s => s({}),
      useSessionStatus: s => s(new Map()),
    },
    chat: { on: () => () => {} },
  }

  const view = mount({ sessionId: 'agent-s1', team })
  try {
    let tree = view.render()
    await tick()
    sse.get('agent-s1')?.push('frame', {
      type: 'snapshot',
      header: { id: 'agent-s1', cwd: '/tmp/project-alpha' },
      records: [],
      nextSeq: 1,
      hasMore: false,
      activeAttempt: null,
    })
    await tick()
    await tick()
    tree = view.render()

    // Blank DSH Agent session renders the centered hero with official FishLogo and workspace pill.
    const hero = all(tree, n => n.props?.['data-agent-hero'] !== undefined)
    assert.equal(hero.length, 1, 'blank DSH Agent session renders AgentEmptyHero')
    const folderBtn = all(hero[0], n => n.type === 'button' && n.props?.className === 'dsb-agent-hero-folder')[0]
    assert.ok(folderBtn, 'hero renders clickable workspace folder pill')
    assert.equal(folderBtn.props.title, '/tmp/project-alpha')
    folderBtn.props.onClick()
    assert.equal(openedFiles.length, 1)

    // Composer exposes the "+" button for DSH Agent sessions, labels the input for DSH Agent,
    // marks the chat container as classic DSH, and omits DS Bot's live voice-call control.
    assert.equal(all(tree, n => String(n.props?.className ?? '').includes('dsb-classic-chat')).length, 1, 'DSH Agent chat adds .dsb-classic-chat scope')
    assert.equal(all(tree, n => n.type === 'voice').length, 0, 'DSH Agent composer omits DS Bot voice-call control')
    const plusBtns = all(tree, n => n.type === 'button' && n.props?.className === 'bt-plus')
    assert.equal(plusBtns.length, 1, 'DSH Agent composer renders the + trigger')
    assert.match(textarea(tree).props.placeholder, /DSH Agent/)

    // Clicking "+" opens the menu with Add files, Files, and Terminal.
    plusBtns[0].props.onClick()
    tree = view.render()
    const menuItems = all(tree, n => n.type === 'button' && n.props?.role === 'menuitem')
    assert.equal(menuItems.length, 3, 'DSH Agent + menu offers Add files, Files, and Terminal')
    menuItems[2].props.onClick()
    assert.equal(openedTerminals.length, 1)
  } finally {
    view.unmount()
  }
})

test('adaptRoomItem preserves presented files on group Bot messages for ChatRows', () => {
  const { adaptRoomItem } = module.exports
  const file = { name: 'report.pdf', path: '/work/report.pdf', description: 'Final', sessionId: 'm1', seq: 5, index: 0 }
  const adapted = adaptRoomItem({ id: 'r1:0', kind: 'bot', botId: 'b1', name: 'Writer', text: 'Ready.', time: 100, files: [file] })
  assert.equal(adapted.kind, 'post')
  assert.deepEqual(adapted.presented, [file])
})

test('composer stays editable when bot.waiting has a model, focuses on card click, and respects IME composition end', async () => {
  const sent = []
  const roster = {
    ready: true,
    readOnly: null,
    bots: [
      { id: 'b-with-model', name: 'Chief', color: 'blue', sessionId: 'b-with-model', waiting: true, model: 'deepseek/deepseek-chat' },
      { id: 'b-no-model', name: 'Newbie', color: 'green', sessionId: 'b-no-model', waiting: true },
    ],
    rooms: [],
    byId: {},
    roomsById: {},
    questions: {},
    views: {},
    exchangeTurns: {},
  }
  roster.byId['b-with-model'] = roster.bots[0]
  roster.byId['b-no-model'] = roster.bots[1]
  const team = {
    actions: {
      noteSent() {},
      noteLive() {},
      send: async (_sid, text) => { sent.push(text) },
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
    chat: { on: () => () => {} },
  }

  // 1. Bot waiting with no model still locks composer and asks to pick a model.
  const noModelInst = mount({ sessionId: 'b-no-model', team })
  try {
    const tree = noModelInst.render()
    assert.equal(textarea(tree).props.disabled, true)
    assert.match(textarea(tree).props.placeholder, /Pick a model/)
  } finally {
    noModelInst.unmount()
  }

  // 2. Bot waiting WITH a model (e.g. kickoff held after quota/auth failure) stays editable.
  const inst = mount({ sessionId: 'b-with-model', team })
  try {
    let tree = inst.render()
    const ta = textarea(tree)
    assert.equal(ta.props.disabled, false, 'waiting bot with an assigned model must keep composer enabled')
    assert.match(ta.props.placeholder, /Message Chief/)

    // Clicking padding on [data-composer-card] focuses the textarea; clicking a button, label,
    // slider, or a React portal child rendered outside currentTarget does not.
    let focused = 0
    ta.props.ref.current = { focus() { focused += 1 }, style: {}, scrollHeight: 30 }
    const card = all(tree, n => n.props?.['data-composer-card'] !== undefined)[0]
    assert.ok(card)
    let prevented = 0
    const insideTarget = { closest: () => null }
    const cardDom = { contains: el => el === insideTarget }
    card.props.onMouseDown({ button: 0, currentTarget: cardDom, target: insideTarget, preventDefault() { prevented += 1 } })
    assert.equal(focused, 1)
    assert.equal(prevented, 1)
    card.props.onMouseDown({ button: 0, currentTarget: { contains: () => true }, target: { closest: sel => (sel.includes('button') ? {} : null) }, preventDefault() { prevented += 1 } })
    assert.equal(focused, 1, 'clicking an interactive control inside composer card must not hijack focus')
    card.props.onMouseDown({ button: 0, currentTarget: { contains: () => true }, target: { closest: sel => (sel.includes('label') ? {} : null) }, preventDefault() { prevented += 1 } })
    assert.equal(focused, 1, 'clicking a label inside composer card must not hijack focus')
    card.props.onMouseDown({ button: 0, currentTarget: cardDom, target: { closest: () => null }, preventDefault() { prevented += 1 } })
    assert.equal(focused, 1, 'portal events bubbling from outside currentTarget DOM must not hijack focus')

    // Real IME order: compositionStart -> compositionEnd -> onChange -> immediate Enter must NOT submit;
    // Enter after Enter keyUp submits.
    textarea(tree).props.onCompositionStart()
    textarea(tree).props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    assert.equal(sent.length, 0, 'Enter during active IME composition must not submit')
    textarea(tree).props.onCompositionEnd()
    textarea(tree).props.onChange({ target: { value: '你好', selectionStart: 2 } })
    tree = inst.render()
    textarea(tree).props.onKeyUp({ key: 'a', target: { selectionStart: 2 } })
    textarea(tree).props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    assert.equal(sent.length, 0, 'Enter fired immediately after compositionend + onChange must not submit')
    textarea(tree).props.onKeyUp({ key: 'Enter', target: { selectionStart: 2 } })
    textarea(tree).props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    await tick()
    assert.deepEqual(sent, ['你好'])
  } finally {
    inst.unmount()
  }
})
