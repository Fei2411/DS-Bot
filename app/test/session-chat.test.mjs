import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const fixture = JSON.parse(readFileSync(
  new URL('../../ds-bot/test/fixtures/recorded/dsh-follow-0.2.2-rc.1.json', import.meta.url),
  'utf8',
))

const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const deepViewReact = fileURLToPath(import.meta.resolve('deep-view/react'))
const stubs = {
  'cells.js': `
    export const Bubbles = ({ texts, streaming, msgKey }) => ({ type: 'bubbles', props: { texts, streaming, msgKey, children: texts } })
    export const ThinkingRow = ({ text, live, ms, viewKey }) => ({ type: 'thinking', props: { text, live, ms, viewKey, children: [text] } })
    export const EarlierParts = ({ sessionId }) => ({ type: 'earlier-parts', props: { sessionId, children: ['earlier-parts:' + sessionId] } })
    export const PartLine = ({ time }) => ({ type: 'part-line', props: { time, children: [] } })
    export const ChatRows = (props) => ({ type: 'chat-rows', props: { ...props, children: [] } })
    export const Shimmer = ({ children }) => ({ type: 'shimmer', props: { children: [children] } })
    export const Elapsed = () => null
    export const workPhrase = () => ''
    export const isBotTool = name => ['show_view', 'ask_user', 'request_secret', 'message_bot', 'cua', 'computer_handoff'].includes(name)
    export const ToolCell = ({ node, sessionId, useHeldCards }) => {
      const root = node?.data?.root
      const heldCards = useHeldCards?.(state => state?.[sessionId])
      const name = root?.name || root?.call?.name
      if (name === 'show_view') {
        return {
          type: 'widget-cell',
          props: { callId: root.callId, title: root.args?.text?.('title'), done: root.kind === 'tool-result', isError: root.isError === true, heldCards, children: ['widget:' + (root.args?.text?.('title') ?? root.callId)] },
        }
      }
      return { type: 'bot-tool-cell', props: { toolName: name, callId: root?.callId, sessionId, heldCards, children: ['bot-tool:' + name] } }
    }
  `,
  'widget-cell.js': `
    export const WidgetCell = ({ callId, args, done, isError, heldCards }) => ({
      type: 'widget-cell',
      props: { callId, title: args?.text?.('title'), done, isError, heldCards, children: ['widget:' + (args?.text?.('title') ?? callId)] },
    })
    export const WidgetDock = ({ sessionId, useHeldCards }) => ({ type: 'widget-dock', props: { sessionId, hasHeldHook: typeof useHeldCards === 'function', children: [] } })
    export const AnsweredReply = ({ node }) => ({
      type: 'answered-reply',
      props: { data: node?.data, children: ['answered:' + (node?.data?.questions?.[0]?.question ?? node?.data?.views?.[0]?.title ?? 'ok')] },
    })
    export const ViewCard = () => null
  `,
  'model-menu.js': 'export const ModelChoiceDock = () => null\nexport const ModelKeyCard = () => null\nexport const ModelMenu = () => null\nexport const Caret = () => null\nexport const useAnchoredMenu = () => ({ open: false, setOpen() {}, triggerRef: { current: null }, menuRef: { current: null }, style: {} })\nexport const modelOf = () => null\nexport const manageModels = () => undefined\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const FishLogo = ({ size, className }) => ({ type: 'fish-logo', props: { size, className, children: [] } })
    export const MarkdownText = ({ text }) => ({ type: 'markdown', props: { text, children: [text] } })
    export const writeClipboard = async () => true
    export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
    export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
  `,
}

// Bundle all DM session modules together so we test the real client code (including real
// `session-log.js`, `@deepseek-ai/dsh-llm/assistant-stream`, and `@deepseek-ai/dsh-util-values`).
const entryCode = `
  export { applyFrame, addPage, emptyLog, transcriptOf, writingBlocks } from '../ds-bot/src/client/session-log.js'
  export { openSessionFollow } from './ui/src/api.js'
  export { createSlotRegistry, SlotErrorBoundary, TOOL_VIEW_SLOT, CHAT_NODE_SLOT } from './ui/src/slots.js'
  export { buildSessionRows, makeToolArgs, splitReasoning, streamReasoningMs } from './ui/src/session-transcript.js'
  export { ToolCallCard, argSummary, clipLongText, formatArgs, formatResult } from './ui/src/tool-card.js'
  export { SessionTranscript, useSessionFollow } from './ui/src/session-chat.js'
  export { Chat } from './ui/src/chat.js'
  export { createTeam } from './ui/src/team.js'
`
const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'session-chat-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^deep-view\/react$/ }, () => ({ path: deepViewReact }))
      bundler.onResolve({ filter: /(src\/client\/(cells|widget-cell|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'session-chat-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|widget-cell|model-menu|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'session-chat-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'session-chat-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

// Lightweight React stand-in supporting per-component-path hook slots (like Fiber),
// class error boundaries, React.memo objects, and subscriptions.
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
const field = {
  style: {}, scrollHeight: 400, scrollTop: 0, clientHeight: 400, selectionStart: 0, selectionEnd: 0,
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
  useId: () => slot(() => ({ id: 'id' })).id,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createContext: value => ({ _default: value, Provider: ({ children }) => children }),
  useContext: ctx => ctx?._default,
}

function createFetchControl() {
  let impl = null
  const calls = []
  const streams = []
  const encoder = new TextEncoder()
  const reset = () => {
    for (const s of streams) s.close()
    streams.length = 0
    calls.length = 0
    impl = null
  }
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (impl) return impl(url, opts)
    const queue = []
    let waiter = null
    let closed = false
    let cancelled = false
    const finish = () => {
      if (closed) return
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
    }
    opts.signal?.addEventListener?.('abort', finish)
    const entry = {
      url,
      aborted: () => Boolean(opts.signal?.aborted),
      cancelled: () => cancelled,
      pushRaw(raw) {
        if (closed) return
        const chunk = encoder.encode(raw)
        if (waiter) { const w = waiter; waiter = null; w({ value: chunk, done: false }) }
        else queue.push(chunk)
      },
      push(event, data) { this.pushRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
      close: finish,
    }
    streams.push(entry)
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => { waiter = resolve })
          },
          cancel: () => { cancelled = true; finish(); return Promise.resolve() },
        }),
      },
    }
  }
  return {
    fetch, calls, streams, reset,
    setImpl: (fn) => { impl = fn },
    latest: () => streams.at(-1),
  }
}

const fetchCtrl = createFetchControl()
const recordedTimers = []
const portalTargets = []
const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  __testCall: async () => ({ records: [], hasMore: false }),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node, target) => { portalTargets.push(target); return node } }
    throw new Error(`no platform module ${name}`)
  },
  AbortController, TextDecoder, URLSearchParams,
  console: { error() {}, warn() {}, log() {} },
  window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800 },
  document: { querySelector: () => null, body: { toggleAttribute() {}, removeAttribute() {} }, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
  setTimeout: (fn, ms, ...args) => { recordedTimers.push(ms); return setTimeout(fn, ms, ...args) },
  clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: (...args) => fetchCtrl.fetch(...args),
}
runInNewContext(outputFiles[0].text, sandbox)
const {
  applyFrame, addPage, emptyLog,
  openSessionFollow,
  createSlotRegistry, TOOL_VIEW_SLOT,
  buildSessionRows, makeToolArgs, argSummary, clipLongText, ToolCallCard,
  SessionTranscript, useSessionFollow, Chat, createTeam,
} = module.exports

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
        const cell = slot(() => ({ inst: new fn(node.props) }))
        const inst = cell.inst
        if (typeof fn.getDerivedStateFromProps === 'function') {
          const patch = fn.getDerivedStateFromProps(node.props, inst.state)
          if (patch) inst.state = { ...inst.state, ...patch }
        }
        inst.props = node.props
        try {
          return expand(inst.render(), id)
        } catch (error) {
          if (typeof fn.getDerivedStateFromError === 'function') {
            inst.state = { ...inst.state, ...fn.getDerivedStateFromError(error) }
            inst.componentDidCatch?.(error)
            return expand(inst.render(), id)
          }
          throw error
        }
      }
      return expand(fn(node.props), id)
    } finally {
      current.fiber = prev
    }
  }
  return { ...node, props: { ...node.props, children: node.props.children.map((child, idx) => expand(child, `${path}.${idx}`)) } }
}

const mount = (Component, props) => {
  const instance = {
    fibers: new Map(), fiber: null, effects: [], props,
    render(next = instance.props) {
      instance.props = next
      current = instance
      const out = expand(react.createElement(Component, next), 'root')
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
  return [...(check(node) ? [node] : []), ...all(node.props?.children, check)]
}
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

test('real recorded DSH 0.2.2-rc.1 replay projects user, thinking, streaming, flicker-free tool lifecycle, and replies cleanly', () => {
  let log = emptyLog()
  const snapshots = {}
  for (let i = 0; i < fixture.live.length; i += 1) {
    const entry = fixture.live[i]
    assert.equal(entry.event, 'frame')
    const res = applyFrame(log, entry.data)
    assert.equal(res.reopen, false, `frame ${i} should not gap-reopen`)
    log = res.log
    if (i === 16 || i === 19 || i === 23 || i === 36 || i === 40 || i === 41 || i === 42 || i === 43 || i === 56) {
      snapshots[i] = buildSessionRows(log, { sessionId: 'session-main' })
    }
  }

  // Frame 16: streaming reasoning live, no text yet, all 4 DSH system injections filtered out.
  assert.deepEqual(plain(snapshots[16].map(r => r.kind)), ['user', 'assistant'])
  assert.equal(snapshots[16][0].text, '想想下一步')
  assert.equal(snapshots[16][1].streaming, true)
  assert.equal(snapshots[16][1].thinkingLive, true)
  assert.match(snapshots[16][1].reasoning, /目标、约束、下一步/)
  assert.deepEqual(plain(snapshots[16][1].texts), [])

  // Frame 19: streaming reply text arrived -> thinkingLive switches off.
  assert.equal(snapshots[19][1].streaming, true)
  assert.equal(snapshots[19][1].thinkingLive, false)
  assert.match(snapshots[19][1].texts[0], /建议分三步走/)

  // Frame 23: committed assistant/message replaces live stream without duplication.
  assert.deepEqual(plain(snapshots[23].map(r => r.kind)), ['user', 'assistant'])
  assert.equal(snapshots[23][1].streaming, false)
  assert.equal(typeof snapshots[23][1].reasoningMs, 'number')
  assert.match(snapshots[23][1].reasoning, /目标、约束、下一步/)
  assert.match(snapshots[23][1].texts[0], /建议分三步走/)

  // Frames 36 -> 40 -> 41 -> 42 -> 43: tool call stays mounted under `call:call-2-0`
  // across the committed `assistant/message` (frame 40) and stream end (frame 41) gap
  // with zero unmount flicker before `tool/call` (frame 42) and `tool/result` (frame 43).
  for (const frameIndex of [36, 40, 41]) {
    const tools = snapshots[frameIndex].filter(r => r.kind === 'tool')
    assert.equal(tools.length, 1, `frame ${frameIndex} must keep tool card mounted`)
    assert.equal(tools[0].key, 'call:call-2-0')
    assert.equal(tools[0].toolName, 'list_bots')
    assert.equal(tools[0].phase, 'preparing')
  }

  const startTools = snapshots[42].filter(r => r.kind === 'tool')
  assert.equal(startTools.length, 1)
  assert.equal(startTools[0].key, 'call:call-2-0')
  assert.equal(startTools[0].phase, 'start')

  const doneTools = snapshots[43].filter(r => r.kind === 'tool')
  assert.equal(doneTools.length, 1)
  assert.equal(doneTools[0].key, 'call:call-2-0')
  assert.equal(doneTools[0].phase, 'result')
  assert.equal(doneTools[0].block.kind, 'tool-result')
  assert.equal(doneTools[0].block.call?.name, 'list_bots')
  assert.equal(doneTools[0].block.callTime, 1795239010695)
  assert.equal(doneTools[0].block.isError, false)
  assert.match(doneTools[0].block.content[0].text, /Chief/)

  // Frame 56: complete two-turn transcript with zero system injections or duplicates (including turn-tail anchors).
  assert.deepEqual(plain(snapshots[56].map(r => r.kind)), ['user', 'assistant', 'turn-tail', 'user', 'tool', 'assistant', 'turn-tail'])
  assert.equal(snapshots[56][3].text, '看看团队')
  assert.match(snapshots[56][5].texts[0], /Chief/)

  // Reconnect + page pagination merges seqs 10..16 without leaking system prompts.
  let reconnected = emptyLog()
  for (const entry of fixture.reconnect) reconnected = applyFrame(reconnected, entry.data).log
  const beforeRows = buildSessionRows(reconnected)
  const paged = addPage(reconnected, fixture.page)
  const afterRows = buildSessionRows(paged)
  assert.equal(paged.events[0].seq, 10)
  assert.equal(paged.hasMore, true)
  assert.deepEqual(plain(afterRows.map(r => r.key)), plain(beforeRows.map(r => r.key)))
})

test('buildSessionRows obeys real DSH PTC contract, settles interrupted calls, and projects compaction + card answers', () => {
  const answerPayload = JSON.stringify({
    kind: 'answer_to_pending_question',
    tool: 'ask_user',
    callId: 'ask-1',
    questions: [{ id: 'q1', question: 'Pick one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    answers: [{ id: 'q1', selected: ['Alpha'] }],
  })
  const snapshot = {
    type: 'snapshot',
    header: { id: 's1', cwd: '/repo' },
    cursor: 20,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'compaction/summary', seq: 0, time: 1000, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'Earlier summary' }], shadowedSeqs: [1, 2, 3, 4], shadowedTokenCount: 1200 } } },
      { type: 'event', event: { type: 'user/message', seq: 1, time: 1000, surfaceOp: 'replace', data: { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'Earlier summary' }] } } },
      // Turn 2 is hidden (Bot-to-Bot exchange turn).
      { type: 'event', event: { type: 'turn/start', seq: 2, time: 2000, data: { turn: 2 } } },
      { type: 'event', event: { type: 'assistant/message', seq: 3, time: 2001, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'internal reply' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 4, time: 2002, data: { turn: 2, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } } },
      // Turn 3: real DSH PTC contract (`tool/call` root + `tool/ptc-dispatch-start` & `tool/ptc-dispatch`
      // keyed by `subCallId`), plus truncated-start `tool/ptc-dispatch`, orphan `tool/result`,
      // an interrupted in-flight `tool/call`, and an undispatched `preparing` tool call.
      { type: 'event', event: { type: 'turn/start', seq: 5, time: 3000, data: { turn: 3 } } },
      { type: 'event', event: { type: 'step/start', seq: 6, time: 3001, data: { turn: 3, step: 1 } } },
      { type: 'event', event: { type: 'user/message', seq: 7, time: 3002, data: { source: { kind: 'user-question-reply', callId: 'ask-1', outcome: 'answered' }, content: [{ type: 'text', text: answerPayload }] } } },
      { type: 'event', event: { type: 'tool/result', seq: 8, time: 3005, data: { turn: 3, step: 1, meta: { lines: 2 }, message: { source: { kind: 'tool', callId: 'orphan-1' }, toolCallId: 'orphan-1', content: [{ type: 'text', text: 'stale output' }], isError: true, error: { code: 'TIMEOUT' } } } } },
      { type: 'event', event: { type: 'tool/call', seq: 9, time: 3010, data: { turn: 3, step: 1, callId: 'root-1', name: 'run_code', arguments: '{"code":"list()"}' } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch-start', seq: 10, time: 3011, data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:ptc:0', name: 'read_file', arguments: { path: 'a.txt' } } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch', seq: 11, time: 3012, data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:ptc:0', name: 'read_file', arguments: { path: 'a.txt' }, content: [{ type: 'text', text: 'hello' }], isError: false, meta: { bytes: 5 } } } },
      // Truncated-start PTC dispatch still attaches to parent with name & arguments preserved.
      { type: 'event', event: { type: 'tool/ptc-dispatch', seq: 12, time: 3013, data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:ptc:1', name: 'grep', arguments: { pattern: 'foo' }, content: [{ type: 'text', text: 'match' }], isError: false, meta: { count: 1 } } } },
      { type: 'event', event: { type: 'tool/result', seq: 13, time: 3020, data: { turn: 3, step: 1, meta: { exitCode: 0 }, message: { source: { kind: 'tool', callId: 'root-1' }, toolCallId: 'root-1', content: [{ type: 'text', text: 'done' }], isError: false } } } },
      // Open tool/call + undispatched preparing call when turn is interrupted.
      { type: 'event', event: { type: 'assistant/message', seq: 14, time: 3021, data: { turn: 3, step: 1, message: { content: [{ type: 'tool-call', id: 'never-ran', name: 'bash', arguments: '{"cmd":"sleep 9"}' }] } } } },
      { type: 'event', event: { type: 'tool/call', seq: 15, time: 3022, data: { turn: 3, step: 1, callId: 'stuck-1', name: 'bash', arguments: '{"cmd":"tail"}' } } },
      { type: 'event', event: { type: 'turn/end', seq: 16, time: 3025, data: { turn: 3, reason: { kind: 'interrupted' } } } },
      // Turn 4: signed-out hook abort.
      { type: 'event', event: { type: 'turn/start', seq: 17, time: 4000, data: { turn: 4 } } },
      { type: 'event', event: { type: 'turn/end', seq: 18, time: 4005, data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } } } } },
    ],
  }
  const { log } = applyFrame(emptyLog(), snapshot)
  const rows = buildSessionRows(log, { roster: { exchangeTurns: { s1: [2] } }, sessionId: 's1' })

  // Undispatched `never-ran` preparing call was removed on turn/end; `stuck-1` settled as Interrupted.
  assert.deepEqual(plain(rows.map(r => r.kind)), ['compaction', 'answer', 'tool', 'tool', 'tool', 'turn-error', 'turn-tail', 'turn-error', 'turn-tail'])
  assert.equal(rows[0].shadowedItemCount, 4)
  assert.equal(rows[0].summary, 'Earlier summary')
  assert.equal(rows[1].data.questions[0].question, 'Pick one?')

  // Orphan tool result keeps call: null, meta, and error flag.
  assert.equal(rows[2].callId, 'orphan-1')
  assert.equal(rows[2].block.call, null)
  assert.equal(rows[2].block.isError, true)
  assert.deepEqual(plain(rows[2].block.meta), { lines: 2 })

  // Root PTC call holds pure ToolCallBlock[] directly in `block.subCalls` (both normal and truncated-start).
  const root = rows[3]
  assert.equal(root.callId, 'root-1')
  assert.equal(root.phase, 'result')
  assert.deepEqual(plain(root.block.meta), { exitCode: 0 })
  assert.equal(root.block.subCalls.length, 2)
  assert.equal(root.block.subCalls[0].kind, 'tool-result')
  assert.equal(root.block.subCalls[0].callId, 'root-1:ptc:0')
  assert.equal(root.block.subCalls[0].name, 'read_file')
  assert.equal(root.block.subCalls[0].callTime, 3011)
  assert.equal(root.block.subCalls[0].args.text('path'), 'a.txt')
  assert.deepEqual(plain(root.block.subCalls[0].meta), { bytes: 5 })
  assert.equal(root.block.subCalls[1].callId, 'root-1:ptc:1')
  assert.equal(root.block.subCalls[1].name, 'grep')
  assert.equal(root.block.subCalls[1].callTime, null)
  assert.equal(root.block.subCalls[1].args.text('pattern'), 'foo')
  assert.deepEqual(plain(root.block.subCalls[1].meta), { count: 1 })

  // Interrupted open `tool/call` settled to error instead of remaining Running forever.
  assert.equal(rows[4].callId, 'stuck-1')
  assert.equal(rows[4].phase, 'result')
  assert.equal(rows[4].block.isError, true)
  assert.equal(rows[4].block.error.code, 'interrupted')

  assert.equal(rows[5].error.code, 'INTERRUPTED')
  assert.equal(rows[7].error.code, 'ACCOUNT_SIGNED_OUT')
})

test('slots support React.memo, orphan tools skip unkeyed slots, streaming PartialArguments summarizes incomplete JSON, and errors isolate with Retry', () => {
  // Streaming partial JSON still produces a summary via real PartialArguments.
  const partialArgs = makeToolArgs('{"command":"git status --sh', { sealed: false })
  assert.equal(argSummary(partialArgs), 'git status --sh')

  // Long result folding (>12 lines).
  const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n')
  const clipped = clipLongText(manyLines)
  assert.equal(clipped.folded, true)
  assert.equal(clipped.lines, 20)
  assert.match(clipped.shown, /line-12\n…$/)

  const registry = createSlotRegistry()
  const received = []
  let shouldThrow = false
  // Register an unkeyed slot AND a React.memo keyed slot.
  registry.register({ name: TOOL_VIEW_SLOT }, () => react.createElement('div', null, 'UNKEYED_SHOULD_NOT_HIT_ORPHAN'))
  const MemoListView = react.memo((props) => {
    if (shouldThrow) throw new Error('plugin boom')
    const disc = props.useDisclosure()
    received.push({ callId: props.callId, toolName: props.toolName, cwd: props.cwd, phase: props.phase, keys: Object.keys(disc).sort() })
    return react.createElement('div', { className: 'custom-slot' }, `custom:${props.toolName}:${disc.expanded}`)
  })
  registry.register({ name: TOOL_VIEW_SLOT, key: 'list_bots' }, MemoListView)

  const listEntry = {
    key: 'call:c1', callId: 'c1', toolName: 'list_bots', phase: 'result',
    block: { kind: 'tool-result', phase: 'result', callId: 'c1', name: 'list_bots', args: makeToolArgs('{}'), call: { name: 'list_bots', argsRaw: '{}' }, callTime: 1000, time: 2500, content: [{ type: 'text', text: 'ok' }], isError: false, subCalls: [] },
  }
  const orphanEntry = {
    key: 'call:o1', callId: 'o1', toolName: '', phase: 'result',
    block: { kind: 'tool-result', phase: 'result', callId: 'o1', name: '', args: makeToolArgs(''), call: null, callTime: null, time: 2500, content: [{ type: 'text', text: 'orphan result' }], isError: false, subCalls: [] },
  }
  const otherEntry = {
    key: 'call:c2', callId: 'c2', toolName: 'bash', phase: 'result',
    block: { kind: 'tool-result', phase: 'result', callId: 'c2', name: 'bash', args: makeToolArgs('{"cmd":"echo hi"}'), call: { name: 'bash', argsRaw: '{"cmd":"echo hi"}' }, callTime: 1000, time: 3000, content: [{ type: 'text', text: manyLines }], isError: false, subCalls: [] },
  }

  // Memoized custom slot receives DSH ToolCallOwnerProps + outer anchor wrapper.
  const customMount = mount(ToolCallCard, { entry: listEntry, cwd: '/repo', registry })
  const customTree = customMount.render()
  assert.match(textOf(customTree), /custom:list_bots:false/)
  assert.equal(customTree.props['data-chat-anchor-key'], 'call:c1')
  assert.equal(customTree.props['data-chat-call-id'], 'c1')
  assert.deepEqual(plain(received[0]), { callId: 'c1', toolName: 'list_bots', cwd: '/repo', phase: 'result', keys: ['expanded', 'setExpanded', 'toggle'] })

  // Throwing slot is isolated by SlotErrorBoundary and recovers on Retry.
  shouldThrow = true
  const errTree = customMount.render()
  assert.match(textOf(errTree), /This view could not be shown/)
  const retryBtn = all(errTree, n => n.type === 'button' && textOf(n) === 'Retry')[0]
  assert.ok(retryBtn)
  shouldThrow = false
  retryBtn.props.onClick()
  assert.match(textOf(customMount.render()), /custom:list_bots:false/)

  // Orphan tool/result with empty toolName never matches an unkeyed slot registration.
  const orphanMount = mount(ToolCallCard, { entry: orphanEntry, cwd: '/repo', registry })
  const orphanTree = orphanMount.render()
  assert.doesNotMatch(textOf(orphanTree), /UNKEYED_SHOULD_NOT_HIT_ORPHAN/)
  assert.match(textOf(orphanTree), /Tool call · o1/)

  // Unregistered tool falls back to GenericToolCard with expand + long-result fold toggle.
  const genericMount = mount(ToolCallCard, { entry: otherEntry, cwd: '/repo', registry })
  let tree = genericMount.render()
  assert.match(textOf(tree), /bash/)
  assert.match(textOf(tree), /echo hi/)
  assert.match(textOf(tree), /2s/)
  const head = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0]
  head.props.onClick()
  tree = genericMount.render()
  assert.match(textOf(tree), /line-12/)
  assert.doesNotMatch(textOf(tree), /line-20/)
  const foldBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-fold')[0]
  assert.ok(foldBtn)
  assert.match(textOf(foldBtn), /Show all \(20 lines\)/)
  foldBtn.props.onClick()
  tree = genericMount.render()
  assert.match(textOf(tree), /line-20/)
})

test('openSessionFollow handles split CRLF frames, reader cancel on end, backoff on SSE errors, and reopen() inside terminal error callback', async () => {
  fetchCtrl.reset()
  recordedTimers.length = 0
  const events = []
  let reopenedOnTerminal = false
  let cursor = -1
  let handle
  handle = openSessionFollow({ sessionId: 'b1', max: 20, after: () => cursor }, (event, data) => {
    events.push([event, data])
    // Verify reopen() called synchronously inside a terminal HTTP error callback is NOT swallowed.
    if (event === 'error' && data?.code === 'bot/not-found' && !reopenedOnTerminal) {
      reopenedOnTerminal = true
      handle.reopen()
    }
  })
  try {
    await tick()
    assert.equal(fetchCtrl.calls.length, 1)
    assert.match(fetchCtrl.calls[0].url, /^api\/bot\/session\?id=b1&max=20$/)

    // Deliver split CRLF frame, then `event: end` -> cancels underlying reader.
    fetchCtrl.latest().pushRaw('event: frame\r\ndata: {"type":"snap')
    await tick()
    fetchCtrl.latest().pushRaw('shot","cursor":1,"records":[]}\r\n\r\n')
    await tick()
    await tick()
    assert.equal(events[0][0], 'frame')
    assert.equal(events[0][1].type, 'snapshot')
    cursor = 7

    // Non-terminal SSE error followed by stream close must NOT reset backoff to 500ms on next drop.
    const firstStream = fetchCtrl.latest()
    firstStream.push('end', {})
    await tick()
    await tick()
    assert.equal(firstStream.cancelled(), true, 'early return on end must cancel reader')

    // Immediate reopen() moves to attempt 2.
    handle.reopen()
    await tick()
    await tick()
    assert.equal(fetchCtrl.calls.length, 2)
    assert.match(fetchCtrl.calls[1].url, /after=7/, 'a reconnect carries the cursor held when it starts')

    // Attempt 2: HTTP 200 SSE returns non-terminal `bot/internal` error without any `frame`, then closes -> backoff 500ms.
    recordedTimers.length = 0
    fetchCtrl.latest().push('error', { code: 'bot/internal', message: 'boom' })
    fetchCtrl.latest().close()
    await tick()
    await tick()
    assert.equal(recordedTimers[0], 500)

    // Wait for backoff to trigger attempt 3 -> another `bot/internal` without frame must back off to 1000ms (not reset to 500ms!).
    await new Promise(resolve => setTimeout(resolve, 540))
    assert.equal(fetchCtrl.calls.length, 3)
    fetchCtrl.latest().push('error', { code: 'bot/internal', message: 'boom again' })
    fetchCtrl.latest().close()
    await tick()
    await tick()
    assert.equal(recordedTimers[1], 1000, 'non-terminal SSE error must keep escalating backoff')

    // Next attempt returns HTTP 400 / terminal bot/not-found; callback calls reopen() synchronously once,
    // which must trigger attempt 5 instead of being swallowed, then attempt 5 stops terminally.
    let terminalCount = 0
    fetchCtrl.setImpl(async () => {
      terminalCount += 1
      return { ok: false, status: 404, json: async () => ({ error: { code: 'bot/not-found', message: 'gone' } }) }
    })
    handle.reopen()
    await tick()
    await tick()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(terminalCount, 2, 'reopen() inside terminal error callback must restart once, then stay stopped')
  } finally {
    handle.close()
    fetchCtrl.reset()
  }
})


test('useSessionFollow resyncs once without the stale cursor and replaces rows with fresh history', async () => {
  fetchCtrl.reset()
  let view
  const Probe = () => {
    view = useSessionFollow({ sessionId: 'b1', enabled: true })
    return null
  }
  const inst = mount(Probe, {})
  try {
    inst.render()
    await tick()
    assert.equal(fetchCtrl.calls.length, 1)
    const staleEvent = { type: 'user/message', seq: 10, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'stale row' }] } }
    fetchCtrl.latest().push('frame', {
      type: 'snapshot', header: { id: 'b1', cwd: '/repo' }, cursor: 10, hasMore: true,
      records: [{ type: 'event', event: staleEvent }], assistantStream: { revision: 0 },
    })
    await tick()
    await tick()
    inst.render()
    assert.equal(view.log.cursor, 10)
    assert.equal(view.historyReloaded, false)

    fetchCtrl.latest().push('error', { code: 'bot/stale', message: 'history no longer reaches cursor' })
    await tick()
    await tick()
    assert.equal(fetchCtrl.calls.length, 2, 'stale triggers exactly one intentional resync')
    assert.equal(fetchCtrl.calls[1].url.includes('after='), false, 'resync never reuses the stale cursor')
    assert.equal(view.terminalError, null)

    // If even the no-cursor resync is refused as stale, it becomes terminal instead of looping.
    const before = fetchCtrl.calls.length
    fetchCtrl.latest().push('error', { code: 'bot/stale', message: 'still stale' })
    await tick()
    await tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(fetchCtrl.calls.length, before, 'a repeated stale during resync does not loop')
    inst.render()
    assert.equal(view.terminalError?.code, 'bot/stale')

    // A later manual retry still resyncs without a cursor; the fresh opening replaces rows.
    view.retry()
    await tick()
    await tick()
    assert.equal(fetchCtrl.calls.length, before + 1)
    assert.equal(fetchCtrl.calls.at(-1).url.includes('after='), false)
    const freshEvents = [3, 4, 5].map(seq => ({ type: 'assistant/message', seq, time: seq, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: `fresh ${seq}` }] } } }))
    fetchCtrl.latest().push('frame', {
      type: 'snapshot', header: { id: 'b1', cwd: '/repo' }, cursor: 5, hasMore: true,
      records: freshEvents.map(event => ({ type: 'event', event })), assistantStream: { revision: 0 },
    })
    await tick()
    await tick()
    inst.render()
    assert.equal(view.log.cursor, 5)
    assert.deepEqual(plain(view.log.events.map(event => event.seq)), [3, 4, 5])
    assert.equal(view.historyReloaded, true)
    assert.equal(view.terminalError, null)
  } finally {
    inst.unmount()
    fetchCtrl.reset()
  }
})

test('Chat DM renders real recorded session, show_view via WidgetCell, legacy reactions, EarlierParts across rollover, pagination, and pending dedup', async () => {
  fetchCtrl.reset()
  const listeners = new Set()
  const liveNotes = []
  const turnTimes = []
  const pageCalls = []
  sandbox.__testCall = async (name, body) => {
    pageCalls.push([name, body])
    return fixture.page
  }

  // `bot.parts` holds ONLY earlier segments (host/channel.js), not current `bot.sessionId`.
  const uiState = { reactions: { 'session-main:1795239010163': { 0: ['👍'] } } }
  const heldState = { 'session-main': { 'view:v1': 1 } }
  const roster = {
    ready: true,
    readOnly: 'The Bot team is open in another dsh',
    prefs: { enterToSend: true, thinking: true },
    bots: [{ id: 'session-main', name: 'Chief', color: 'blue', parts: ['part-0'] }],
    byId: { 'session-main': { id: 'session-main', name: 'Chief', color: 'blue', parts: ['part-0'] } },
    rooms: [],
    roomsById: {},
    questions: {},
    views: {},
    exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {},
      noteLive: (sid, key, value) => liveNotes.push([sid, key, value]),
      noteCards() {},
      noteTurnTime: (sid, turn, key, time) => turnTimes.push([sid, turn, key, time]),
      earlier: async () => ({ items: [], cursor: null }),
      send: async () => {},
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select(uiState),
      useCards: select => select({}),
      useHeldCards: select => select(heldState),
      useTurnClock: select => select({}),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }

  const inst = mount(Chat, { sessionId: 'session-main', team })
  try {
    // Before opening snapshot arrives (`log.header === null`), EarlierParts must NOT mount prematurely.
    const initialTree = inst.render()
    assert.equal(all(initialTree, n => n.type === 'earlier-parts').length, 0, 'EarlierParts must wait for opening snapshot')
    assert.equal(all(initialTree, n => n.type === 'widget-dock' && n.props.hasHeldHook).length, 1, 'WidgetDock must receive useHeldCards')
    await tick()
    assert.equal(fetchCtrl.calls.length, 1)

    // Push the real recorded DSH stream through SSE.
    for (const entry of fixture.live) fetchCtrl.latest().push(entry.event, entry.data)
    await tick()
    await tick()
    let tree = inst.render()
    const rendered = textOf(tree)
    assert.match(rendered, /想想下一步/)
    assert.match(rendered, /目标、约束、下一步/)
    assert.match(rendered, /建议分三步走/)
    assert.match(rendered, /list_bots/)
    // Once snapshot landed with `hasMore: false` and `bot.parts` has 1 earlier segment, EarlierParts mounts.
    assert.equal(all(tree, n => n.type === 'earlier-parts').length, 1, 'EarlierParts must mount when bot.parts.length === 1')
    // Legacy saved reaction key `${sessionId}:${time}` is preserved on Turn 1's Bubbles.
    const bubbles = all(tree, n => n.type === 'bubbles')
    assert.equal(bubbles[0].props.msgKey, 'session-main:1795239010163')
    // Turn timestamps were synced from `log.events` (`turn/start` & `turn/end`).
    assert.ok(turnTimes.some(([, turn, key]) => turn === 1 && key === 'first'))
    assert.ok(turnTimes.some(([, turn, key]) => turn === 2 && key === 'end'))

    // Read-only window: composer is locked AND feed `revision` event triggers reopen() of api/bot/session.
    assert.equal(all(tree, n => n.type === 'textarea')[0].props.disabled, true, 'read-only window disables composer')
    for (const listener of listeners) listener('revision', {})
    await tick()
    await tick()
    assert.equal(fetchCtrl.calls.length, 2)

    // Snapshot with a gap past seq 34 (`hasMore: true`), historical "继续", a display-only `show_view`,
    // and a settled `user-question-reply`.
    const viewArgs = JSON.stringify({ title: 'Compare', view: { type: 'text', text: 'A vs B' } })
    const qReply = JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user', callId: 'a1', questions: [{ id: 'q1', question: 'Ready?', options: [{ label: 'Yes' }] }], answers: [{ id: 'q1', selected: ['Yes'] }] })
    fetchCtrl.latest().push('frame', {
      type: 'snapshot',
      header: { id: 'session-main', cwd: '/bench/bot/workspace' },
      cursor: 48,
      hasMore: true,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 45, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } } },
        { type: 'event', event: { type: 'tool/call', seq: 46, time: 1010, data: { turn: 4, step: 1, callId: 'v1', name: 'show_view', arguments: viewArgs } } },
        { type: 'event', event: { type: 'tool/result', seq: 47, time: 1011, data: { turn: 4, step: 1, message: { toolCallId: 'v1', content: [{ type: 'text', text: 'shown' }], isError: false } } } },
        { type: 'event', event: { type: 'user/message', seq: 48, time: 1020, data: { source: { kind: 'user-question-reply', callId: 'a1', outcome: 'answered' }, content: [{ type: 'text', text: qReply }] } } },
      ],
    })
    await tick()
    await tick()
    tree = inst.render()
    assert.ok(all(tree, n => n.type === 'widget-cell' && n.props.title === 'Compare' && n.props.heldCards?.['view:v1'] === 1).length === 1, 'show_view renders via WidgetCell with heldCards')
    assert.ok(all(tree, n => n.type === 'answered-reply').length === 1, 'user-question-reply renders via AnsweredReply')

    // Click "Load earlier" -> calls `session-page` with beforeSeq: 45.
    const earlierBtn = all(tree, n => n.type === 'button' && n.props?.className === 'bt-soft')[0]
    assert.ok(earlierBtn, 'Load earlier button should appear when hasMore is true')
    earlierBtn.props.onClick()
    await tick()
    await tick()
    assert.deepEqual(plain(pageCalls[0]), ['session-page', { sessionId: 'session-main', beforeSeq: 45, maxMessages: 40 }])

    // Unlock read-only mode (null), then send "继续" twice -> both stay pending; a gap-reopen user/message must NOT clear pending early.
    roster.readOnly = null
    inst.render()
    const sendText = async (value) => {
      const ta = all(inst.render(), n => n.type === 'textarea')[0]
      ta.props.onChange({ target: { value } })
      const btn = all(inst.render(), n => n.type === 'button' && n.props?.className === 'dsb-send')[0]
      btn.props.onClick()
      await tick()
    }
    const pendingCount = () => {
      const pendingRows = all(inst.render(), n => n.type === 'div' && n.props?.className === 'dsb-pending')
      return pendingRows[0] ? all(pendingRows[0], n => n.type === 'div' && n.props?.className === 'bt-umsg').length : 0
    }
    await sendText('继续')
    await sendText('继续')
    assert.equal(pendingCount(), 2)

    // Out-of-order seq 99 (gap!) triggers reopen without prematurely clearing pending bubbles.
    fetchCtrl.latest().push('frame', {
      type: 'event',
      event: { type: 'user/message', seq: 99, time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    })
    await tick()
    await tick()
    assert.equal(pendingCount(), 2, 'gap-reopen user/message must not clear optimistic pending bubble')

    // Reopen snapshot delivers seq 48 cleanly, then contiguous 49 & 50 clear one-for-one.
    fetchCtrl.latest().push('frame', {
      type: 'snapshot',
      header: { id: 'session-main', cwd: '/bench/bot/workspace' },
      cursor: 48,
      hasMore: false,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 45, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } } },
      ],
    })
    fetchCtrl.latest().push('frame', {
      type: 'event',
      event: { type: 'user/message', seq: 49, time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    })
    await tick()
    await tick()
    assert.equal(pendingCount(), 1)

    fetchCtrl.latest().push('frame', {
      type: 'event',
      event: { type: 'user/message', seq: 50, time: 6000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    })
    await tick()
    await tick()
    assert.equal(pendingCount(), 0)

    // Streaming text marks session-reply live, then clears on commit.
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a9', revision: 1, turn: 5, step: 1, startedAfterSeq: 50 } })
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a9', revision: 2, index: 0, time: 6010, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a9', revision: 3, index: 1, time: 6011, chunk: { type: 'text-delta', index: 0, text: 'streaming now' } } })
    await tick()
    await tick()
    inst.render()
    assert.ok(liveNotes.some(([, key, val]) => key === 'session-reply' && val?.text === true))
    fetchCtrl.latest().push('frame', { type: 'event', event: { type: 'assistant/message', seq: 51, time: 6020, data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'streaming now' }] } } } })
    await tick()
    await tick()
    inst.render()
    assert.deepEqual(plain(liveNotes.at(-1)), ['session-main', 'session-reply', null])
  } finally {
    inst.unmount()
    fetchCtrl.reset()
  }
})

test('createTeam wires heldCards store so WidgetDock noteHeldCard updates cleanly without throwing', () => {
  const store = new Map()
  sandbox.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => { store.set(key, String(val)) },
    removeItem: key => { store.delete(key) },
  }
  const team = createTeam()
  assert.equal(typeof team.hooks.useHeldCards, 'function')
  assert.equal(typeof team.actions.noteHeldCard, 'function')

  // Focus/pointer interaction on WidgetDock calls noteHeldCard(+1) and release calls (-1).
  team.actions.noteHeldCard('s1', 'view', 'v1', 1)
  const Probe = () => {
    const held = team.hooks.useHeldCards(state => state)
    return react.createElement('div', { held }, JSON.stringify(held))
  }
  const probeMount = mount(Probe, {})
  assert.deepEqual(plain(probeMount.render().props.held), { s1: { '["view","v1"]': 1 } })
  team.actions.noteHeldCard('s1', 'view', 'v1', -1)
  assert.deepEqual(plain(probeMount.render().props.held), { s1: {} })
  assert.equal(typeof team.hooks.useComputer, 'function')
  assert.equal(typeof team.hooks.useBrowserHolds, 'function')
  assert.equal(typeof team.actions.stopChat, 'function')
  assert.equal(typeof team.actions.stageFile, 'function')
  assert.equal(typeof team.actions.stageImage, 'function')
})

test('SessionTranscript routes DS Bot tools (including inside PTC run_code) via ToolCell and loads user image thumbnails', async () => {
  const imageCalls = []
  sandbox.__testCall = async (endpoint, payload) => {
    if (endpoint === 'image') {
      imageCalls.push(payload)
      return { mime: 'image/png', data: 'iVBORw0KGgo=' }
    }
    return {}
  }
  const log = applyFrame(emptyLog(), {
    type: 'snapshot',
    header: { id: 'b1', cwd: '/repo' },
    cursor: 5,
    hasMore: false,
    records: [
      {
        type: 'event',
        event: {
          seq: 1,
          time: 1000,
          type: 'user/message',
          data: {
            source: { kind: 'user' },
            content: [
              { type: 'image', attachment: { attachmentId: 'att-img-1', name: 'chart.png', width: 100, height: 80 } },
              { type: 'text', text: 'check this chart' },
            ],
          },
        },
      },
      {
        type: 'event',
        event: {
          seq: 2,
          time: 1010,
          type: 'tool/call',
          data: { turn: 1, callId: 'ptc-1', name: 'run_code', arguments: '{"code":"ask_user(...)"}' },
        },
      },
      {
        type: 'event',
        event: {
          seq: 3,
          time: 1015,
          type: 'tool/ptc-dispatch-start',
          data: { turn: 1, subCallId: 'sub-ask-1', parentCallId: 'ptc-1', rootCallId: 'ptc-1', name: 'ask_user', arguments: '{"question":"Pick one"}' },
        },
      },
      {
        type: 'event',
        event: {
          seq: 4,
          time: 1020,
          type: 'tool/ptc-dispatch',
          data: { turn: 1, subCallId: 'sub-ask-1', parentCallId: 'ptc-1', rootCallId: 'ptc-1', name: 'ask_user', isError: false, content: [] },
        },
      },
      {
        type: 'event',
        event: {
          seq: 5,
          time: 1030,
          type: 'tool/result',
          data: { turn: 1, message: { toolCallId: 'ptc-1', isError: false, content: [{ type: 'text', text: 'done' }] } },
        },
      },
    ],
  }).log
  const roster = {
    bots: [{ id: 'b1', name: 'Chief', color: 'blue' }],
    byId: { b1: { id: 'b1', name: 'Chief', color: 'blue' } },
    rooms: [],
    roomsById: {},
    prefs: {},
    exchangeTurns: {},
  }
  const inst = mount(SessionTranscript, {
    log,
    sessionId: 'b1',
    bot: roster.byId.b1,
    roster,
    actions: { openSession() {}, noteTurnTime() {} },
  })
  try {
    inst.render()
    await tick()
    const tree = inst.render()
    assert.deepEqual(plain(imageCalls), [{ sessionId: 'b1', attachmentId: 'att-img-1', preview: true }])
    const imgs = all(tree, n => n.type === 'img' && n.props?.className === 'dsb-uimg')
    assert.equal(imgs.length, 1)
    assert.equal(imgs[0].props.src, 'data:image/png;base64,iVBORw0KGgo=')
    const botCells = all(tree, n => n.type === 'bot-tool-cell' && n.props?.toolName === 'ask_user')
    assert.equal(botCells.length, 1)

    // Lightbox opens via createPortal(..., document.body), registers on shared Escape stack, and closes cleanly.
    portalTargets.length = 0
    const keydownHandlers = new Set()
    sandbox.window.addEventListener = (ev, fn) => { if (ev === 'keydown') keydownHandlers.add(fn) }
    sandbox.window.removeEventListener = (ev, fn) => { if (ev === 'keydown') keydownHandlers.delete(fn) }
    const imgBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-uimg-btn')[0]
    imgBtn.props.onClick()
    await tick()
    const openTree = inst.render()
    assert.equal(all(openTree, n => n.props?.className === 'dsb-lightbox').length, 1)
    assert.equal(portalTargets.includes(sandbox.document.body), true, 'Lightbox must portal to document.body')
    assert.equal(keydownHandlers.size, 1, 'Lightbox registers on shared useEscape stack')
    let prevented = false
    let stopped = false
    for (const fn of [...keydownHandlers]) {
      fn({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    }
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    assert.equal(all(inst.render(), n => n.props?.className === 'dsb-lightbox').length, 0)
  } finally {
    inst.unmount()
    sandbox.__testCall = async () => ({})
    sandbox.window.addEventListener = () => {}
    sandbox.window.removeEventListener = () => {}
  }
})

test('createTeam pull() syncs browserHolds, computerLive, and readOnly transitions across unchanged-revision polls', async () => {
  const store = new Map()
  sandbox.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => { store.set(key, String(val)) },
    removeItem: key => { store.delete(key) },
  }
  let pollStep = 0
  let intervalFn = null
  sandbox.setInterval = (fn) => { intervalFn = fn; return 1 }
  sandbox.clearInterval = () => {}
  sandbox.__testCall = async (endpoint) => {
    if (endpoint === 'state') {
      pollStep += 1
      if (pollStep === 1) {
        return {
          revision: 1,
          liveKey: 'lk-1',
          bots: [],
          rooms: [],
          readOnly: 'Opened in another dsh',
          browserHolds: { b1: { by: 'bot', callId: 'c1', reason: 'login' } },
          computerLive: { active: true },
        }
      }
      // Same revision, unchanged: true -> readOnly clears to null without bumping revision!
      return {
        revision: 1,
        unchanged: true,
        liveKey: 'lk-2',
        readOnly: null,
        browserHolds: {},
        computerLive: { active: false },
      }
    }
    return {}
  }
  const team = createTeam()
  const stop = team.start()
  try {
    await tick()
    await tick()
    const Probe = () => {
      const holds = team.hooks.useBrowserHolds(s => s)
      const comp = team.hooks.useComputer(s => s)
      const ro = team.hooks.useRoster(s => s.readOnly)
      return react.createElement('div', { holds, comp, ro })
    }
    const probe = mount(Probe, {})
    let rendered = probe.render()
    assert.deepEqual(plain(rendered.props.holds), { b1: { by: 'bot', callId: 'c1', reason: 'login' } })
    assert.deepEqual(plain(rendered.props.comp), { active: true })
    assert.equal(rendered.props.ro, 'Opened in another dsh')

    // Trigger next catch-up poll with unchanged: true -> readOnly must transition to null live.
    intervalFn()
    await tick()
    await tick()
    rendered = probe.render()
    assert.equal(rendered.props.ro, null)
    assert.deepEqual(plain(rendered.props.holds), {})
  } finally {
    stop()
    sandbox.__testCall = async () => ({})
    fetchCtrl.reset()
  }
})

test('DM SessionTranscript projects workspace/changes into ChangesCard wired to actions.openChanges', async () => {
  const opened = []
  sandbox.__testCall = async (endpoint, body) => {
    if (endpoint === 'workspace-changes' && body.sessionId === 's1' && body.seq === 2) {
      return {
        sessionId: 's1', seq: 2, turn: 1, total: 1, added: 5, deleted: 2,
        files: [{ index: 0, path: 'src/app.js', display: 'src/app.js', added: 5, deleted: 2 }],
      }
    }
    return {}
  }
  const snapshot = {
    type: 'snapshot',
    header: { id: 's1', cwd: '/repo' },
    cursor: 3,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } },
      { type: 'event', event: { type: 'workspace/changes', seq: 2, time: 1005, data: { turn: 1 } } },
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1010, data: { turn: 1, reason: { kind: 'done' } } } },
    ],
  }
  const { log } = applyFrame(emptyLog(), snapshot)
  const rows = buildSessionRows(log, { roster: {}, sessionId: 's1' })
  assert.equal(rows.some(r => r.kind === 'changes' && r.seq === 2 && r.turn === 1), true)

  const inst = mount(SessionTranscript, {
    log,
    sessionId: 's1',
    bot: { id: 'b1', name: 'Chief', sessionId: 's1' },
    roster: { bots: [], rooms: [], byId: {}, roomsById: {}, prefs: {} },
    actions: { openChanges: value => opened.push(value) },
  })
  try {
    inst.render()
    await tick()
    const tree = inst.render()
    const btn = all(tree, n => n.type === 'button' && n.props?.['data-bt-changes'] === '')[0]
    assert.ok(btn, 'DM transcript must render ChangesCard for workspace/changes')
    btn.props.onClick()
    assert.equal(opened.length, 1)
    assert.equal(opened[0].sessionId, 's1')
    assert.equal(opened[0].seq, 2)
  } finally {
    inst.unmount()
    sandbox.__testCall = async () => ({})
  }
})

test('createTeam populates useUpdate from host update-check and dsBotApp.updates and wires checkUpdate cleanly', async () => {
  const seenCalls = []
  let unsubscribed = false
  let pushOwnApp = null
  const ownAppCalls = []
  sandbox.dsBotApp = {
    updates: {
      state: async () => ({ phase: 'current', version: '0.3.10' }),
      subscribe: (listener) => {
        pushOwnApp = listener
        return () => { unsubscribed = true }
      },
      check: async () => { ownAppCalls.push('check') },
      install: async () => { ownAppCalls.push('install') },
      open: async () => { ownAppCalls.push('open') },
      download: async () => { ownAppCalls.push('download') },
      setAutoUpdate: async (enabled) => { ownAppCalls.push(['auto', enabled]) },
    },
  }
  sandbox.__testCall = async (endpoint, body) => {
    seenCalls.push([endpoint, body])
    if (endpoint === 'state') {
      return { revision: 1, modelsKey: 'm1', bots: [], rooms: [], prefs: {} }
    }
    if (endpoint === 'update-check') {
      return {
        name: 'ds-bot',
        current: '0.3.10',
        latest: body?.fresh ? '0.3.11' : null,
        available: Boolean(body?.fresh),
        source: 'app',
        repoUrl: 'https://github.com/Fei2411/DS-Bot',
        notesUrl: 'https://github.com/Fei2411/DS-Bot/releases',
        phase: 'idle',
        dsh: { current: '0.2.2-rc.1', phase: 'idle', available: false },
      }
    }
    return {}
  }

  const team = createTeam()
  const stop = team.start()
  try {
    await tick()
    await tick()
    const Probe = () => react.createElement('div', { update: team.hooks.useUpdate(s => s) })
    const probe = mount(Probe, {})
    let snap = plain(probe.render().props.update)
    assert.equal(snap.current, '0.3.10', 'About page receives live DS Bot version from host update-check')
    assert.equal(snap.repoUrl, 'https://github.com/Fei2411/DS-Bot')
    assert.equal(snap.dsh?.current, '0.2.2-rc.1')
    assert.deepEqual(snap.ownApp, { phase: 'current', version: '0.3.10' })

    // Live ownApp bridge push updates state without losing host fields.
    pushOwnApp({ phase: 'downloaded', version: '0.3.11' })
    snap = plain(probe.render().props.update)
    assert.equal(snap.current, '0.3.10')
    assert.deepEqual(snap.ownApp, { phase: 'downloaded', version: '0.3.11' })

    // Explicit checkUpdate queries `{ fresh: true }` and preserves ownApp.
    await team.actions.checkUpdate()
    snap = plain(probe.render().props.update)
    assert.equal(snap.latest, '0.3.11')
    assert.equal(snap.available, true)
    assert.deepEqual(snap.ownApp, { phase: 'downloaded', version: '0.3.11' })

    await team.actions.checkOwnApp()
    await team.actions.installOwnApp()
    await team.actions.openOwnApp()
    await team.actions.downloadOwnApp()
    await team.actions.setOwnAppAutoUpdate(false)
    await team.actions.setOwnAppAutoUpdate(true)
    assert.deepEqual(ownAppCalls, ['check', 'install', 'open', 'download', ['auto', false], ['auto', true]])
    assert.equal(seenCalls.some(([ep, body]) => ep === 'update-check' && body?.fresh === false), true)
    assert.equal(seenCalls.some(([ep, body]) => ep === 'update-check' && body?.fresh === true), true)
    probe.unmount()
  } finally {
    stop()
    delete sandbox.dsBotApp
    sandbox.__testCall = async () => ({})
    fetchCtrl.reset()
  }
  assert.equal(unsubscribed, true, 'stopping team unsubscribes from dsBotApp.updates')
})

test('createTeam propagates live api/apiVia on unchanged revision, wires browserImport.openPermission, and SessionTranscript attributes API messages', async () => {
  let stateCalls = 0
  let permissionOpened = 0
  let intervalFn = null
  const prevSetInterval = sandbox.setInterval
  const prevClearInterval = sandbox.clearInterval
  sandbox.setInterval = (fn) => { intervalFn = fn; return 1 }
  sandbox.clearInterval = () => {}
  sandbox.dsBotApp = {
    browser: {
      acquire: async () => 'lease-1',
      release: async () => {},
      forget: async () => {},
      onOpenRequested: () => () => {},
      importSources: async () => [],
      importPick: async () => ({ canceled: true }),
      importOpenPermission: async () => { permissionOpened += 1; return { opened: true } },
      importLive: async () => ({ canceled: true }),
      importApply: async () => ({}),
      importCancel: async () => {},
    },
  }
  sandbox.__testCall = async (endpoint) => {
    if (endpoint === 'state') {
      stateCalls += 1
      if (stateCalls === 1) {
        return {
          revision: 3,
          modelsKey: 'm1',
          bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1', parts: ['b1'] }],
          rooms: [],
          prefs: {},
          api: { enabled: false, tokens: [] },
          apiVia: {},
        }
      }
      return {
        unchanged: true,
        revision: 3,
        modelsKey: 'm1',
        api: { enabled: true, tokens: [{ keyId: 'k1', name: 'CI Runner' }] },
        apiVia: { b1: { 2: 'Deploy Bot' } },
      }
    }
    return {}
  }

  const team = createTeam()
  const stop = team.start()
  try {
    await tick()
    await tick()
    const Probe = () => react.createElement('div', { roster: team.hooks.useRoster(s => s) })
    const probe = mount(Probe, {})
    assert.equal(plain(probe.render().props.roster).api?.enabled, false)

    // Triggering a catch-up poll with unchanged revision must propagate updated api and apiVia.
    assert.equal(typeof intervalFn, 'function')
    intervalFn()
    await tick()
    await tick()
    const updated = plain(probe.render().props.roster)
    assert.equal(updated.api?.enabled, true, 'live api changes propagate on unchanged revision')
    assert.equal(updated.api?.tokens?.[0]?.name, 'CI Runner')
    assert.deepEqual(updated.apiVia, { b1: { 2: 'Deploy Bot' } }, 'live apiVia changes propagate on unchanged revision')

    // browserImport.openPermission is wired from dsBotApp.browser.importOpenPermission.
    assert.equal(typeof team.actions.browserImport?.openPermission, 'function')
    await team.actions.browserImport.openPermission()
    assert.equal(permissionOpened, 1)

    // SessionTranscript resolves both rpcId token name via roster.api and roster.apiVia override.
    const snapshot = {
      type: 'snapshot',
      header: { id: 'b1', cwd: '/repo' },
      cursor: 2,
      hasMore: false,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 1, time: 1_700_000_000_000, data: { source: { kind: 'user', rpcId: 'api:k1' }, content: [{ type: 'text', text: 'From token lookup' }] } } },
        { type: 'event', event: { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'From apiVia map' }] } } },
      ],
    }
    const { log } = applyFrame(emptyLog(), snapshot)
    const rows = buildSessionRows(log, { roster: updated, sessionId: 'b1' })
    assert.equal(rows[0]?.via, 'api:CI Runner')
    assert.equal(rows[1]?.via, 'api:Deploy Bot')
    probe.unmount()
  } finally {
    stop()
    sandbox.setInterval = prevSetInterval
    sandbox.clearInterval = prevClearInterval
    delete sandbox.dsBotApp
    sandbox.__testCall = async () => ({})
    fetchCtrl.reset()
  }
})

test('SessionTranscript in classic DSH mode renders unboxed Markdown prose, soft DSH user bubbles, hover actions, and zero iMessage date separators while keeping Bot DM unchanged', async () => {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'agent-s1', cwd: '/repo' },
    cursor: 5,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'user/message', seq: 1, time: 1_700_000_000_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the repo layout.' }] } } },
      { type: 'event', event: { type: 'turn/start', seq: 2, time: 1_700_000_001_000, data: { turn: 1 } } },
      { type: 'event', event: { type: 'assistant/message', seq: 3, time: 1_700_000_002_000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Here is the summary:\n\n- `app/`\n- `ds-bot/`' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 4, time: 1_700_000_003_000, data: { turn: 1, reason: { kind: 'done' } } } },
    ],
  }
  const { log } = applyFrame(emptyLog(), snapshot)
  const baseProps = {
    log,
    sessionId: 'agent-s1',
    bot: undefined,
    roster: { bots: [], rooms: [], byId: {}, roomsById: {}, prefs: {} },
    actions: {},
  }

  // Classic DSH Agent mode: unboxed Markdown prose, soft DSH user bubble, zero bt-time-sep / bt-umsg / Bubbles.
  const classicInst = mount(SessionTranscript, { ...baseProps, classic: true })
  try {
    const tree = classicInst.render()
    assert.equal(all(tree, n => n.props?.className === 'bt-time-sep').length, 0, 'classic DSH transcript omits iMessage date separators')
    assert.equal(all(tree, n => n.props?.className === 'bt-umsg').length, 0, 'classic DSH user prompt does not render DS Bot bubble')
    assert.equal(all(tree, n => n.props?.className === 'dsb-dsh-user-bubble').length, 1, 'classic DSH user prompt renders soft-tinted DSH bubble')
    assert.equal(all(tree, n => n.props?.className === 'dsb-dsh-user-actions').length, 1, 'classic DSH user prompt provides hover action bar')
    assert.equal(all(tree, n => n.props?.className === 'dsb-dsh-asst').length, 1, 'classic DSH assistant reply renders unboxed editorial container')
    assert.equal(all(tree, n => n.type === 'markdown').length, 1, 'classic DSH assistant reply renders MarkdownText directly without Bot Bubbles')
    assert.equal(all(tree, n => n.type === 'bubbles').length, 0, 'classic DSH assistant reply does not wrap prose in DS Bot Bubbles')
    assert.equal(all(tree, n => n.props?.className === 'dsb-dsh-asst-actions').length, 1, 'classic DSH assistant reply renders subtle tail action bar')
    assert.equal(all(tree, n => String(n.props?.className ?? '').includes('dsb-dsh-asst-time')).length, 1, 'classic DSH assistant timestamp is hover-scoped')
  } finally {
    classicInst.unmount()
  }

  // Bot DM mode (classic: false): preserves iMessage date separator, DS Bot user bubble, and Bubbles.
  const botInst = mount(SessionTranscript, { ...baseProps, classic: false })
  try {
    const tree = botInst.render()
    assert.equal(all(tree, n => n.props?.className === 'bt-time-sep').length, 1, 'Bot DM keeps time separator')
    assert.equal(all(tree, n => n.props?.className === 'bt-umsg').length, 1, 'Bot DM keeps DS Bot user bubble')
    assert.equal(all(tree, n => n.type === 'bubbles').length, 1, 'Bot DM keeps DS Bot assistant Bubbles')
    assert.equal(all(tree, n => n.props?.className === 'dsb-dsh-asst').length, 0)
  } finally {
    botInst.unmount()
  }
})

test('buildSessionRows preserves closed/superseded ask_user and show_view cards in hidden Bot-to-Bot turns (#2242)', () => {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'writer', cwd: '/repo' },
    cursor: 14,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 2 } } },
      { type: 'event', event: { type: 'step/start', seq: 2, time: 1001, data: { turn: 2, step: 1 } } },
      // Regular tool in a hidden Bot-to-Bot turn must stay hidden.
      { type: 'event', event: { type: 'tool/call', seq: 3, time: 1002, data: { turn: 2, step: 1, callId: 'c-bash', name: 'bash', arguments: { command: 'ls' } } } },
      { type: 'event', event: { type: 'tool/result', seq: 4, time: 1003, data: { turn: 2, step: 1, callId: 'c-bash', message: { content: [{ type: 'text', text: 'ok' }] } } } },
      // Closed/superseded ask_user in hidden turn must be kept and settled without INTERRUPTED_ERROR.
      { type: 'event', event: { type: 'tool/call', seq: 5, time: 1004, data: { turn: 2, step: 1, callId: 'c-ask-closed', name: 'ask_user', arguments: { question: 'Pick a name?', options: [{ label: 'Alpha' }] } } } },
      { type: 'event', event: { type: 'tool/result', seq: 6, time: 1005, data: { turn: 2, step: 1, callId: 'c-ask-closed', message: { content: [{ type: 'text', text: 'The question is on screen.' }] } } } },
      // Still-open (unclosed) ask_user in hidden turn stays out of transcript (rendered in dock).
      { type: 'event', event: { type: 'tool/call', seq: 7, time: 1006, data: { turn: 2, step: 1, callId: 'c-ask-open', name: 'ask_user', arguments: { question: 'Still open?', options: [{ label: 'Yes' }] } } } },
      { type: 'event', event: { type: 'tool/result', seq: 8, time: 1007, data: { turn: 2, step: 1, callId: 'c-ask-open', message: { content: [{ type: 'text', text: 'The question is on screen.' }] } } } },
      // Closed show_view dispatched via PTC inside a hidden turn (parent run_code skipped).
      { type: 'event', event: { type: 'tool/call', seq: 9, time: 1008, data: { turn: 2, step: 1, callId: 'c-ptc-root', name: 'run_code', arguments: { code: 'show_view(...)' } } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch-start', seq: 10, time: 1009, data: { parentCallId: 'c-ptc-root', rootCallId: 'c-ptc-root', subCallId: 'c-view-closed', name: 'show_view', arguments: { title: 'Pick view', view: {} } } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch', seq: 11, time: 1010, data: { parentCallId: 'c-ptc-root', rootCallId: 'c-ptc-root', subCallId: 'c-view-closed', name: 'show_view', content: [{ type: 'text', text: 'The view is on screen.' }], isError: false } } },
      // Paginated PTC closed show_view where dispatch-start fell before the loaded window.
      { type: 'event', event: { type: 'tool/ptc-dispatch', seq: 12, time: 1011, data: { parentCallId: 'c-ptc-older', rootCallId: 'c-ptc-older', subCallId: 'c-view-paged', name: 'show_view', arguments: { title: 'Earlier view', view: {} }, content: [{ type: 'text', text: 'The view is on screen.' }], isError: false } } },
      { type: 'event', event: { type: 'step/end', seq: 13, time: 1012, data: { turn: 2, step: 1 } } },
      { type: 'event', event: { type: 'turn/end', seq: 14, time: 1013, data: { turn: 2, reason: { kind: 'completed' } } } },
    ],
  }
  const { log } = applyFrame(emptyLog(), snapshot)
  const roster = {
    exchangeTurns: { writer: [2] },
    closedCards: {
      writer: {
        'c-ask-closed': 'dismissed',
        'c-view-closed': 'dismissed',
        'c-view-paged': 'replied',
      },
    },
  }
  const rows = buildSessionRows(log, { roster, sessionId: 'writer' })
  const toolRows = rows.filter(r => r.kind === 'tool')
  assert.deepEqual(plain(toolRows.map(r => r.block.callId)), ['c-ask-closed', 'c-view-closed', 'c-view-paged'])
  for (const row of toolRows) {
    assert.equal(row.block.phase, 'result', `${row.block.callId} must settle as result`)
    assert.equal(row.block.isError, false, `${row.block.callId} must not be marked INTERRUPTED_ERROR on step/turn end`)
  }
})

test('createTeam rescues unsubmitted question drafts on external question removal and avoids double roster.set on revision change', async () => {
  let stateCalls = 0
  let rosterRenders = 0
  let intervalFn = null
  const prevSetInterval = sandbox.setInterval
  const prevClearInterval = sandbox.clearInterval
  sandbox.setInterval = (fn) => { intervalFn = fn; return 1 }
  sandbox.clearInterval = () => {}
  sandbox.__testCall = async (endpoint) => {
    if (endpoint === 'state') {
      stateCalls += 1
      if (stateCalls === 1) {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1', parts: ['b1'] }],
          rooms: [],
          prefs: {},
          questions: { b1: { id: 'q1', callId: 'c1', question: 'Thoughts?' } },
          speech: false,
        }
      }
      return {
        revision: 2,
        modelsKey: 'm1',
        bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1', parts: ['b1'] }],
        rooms: [],
        prefs: {},
        questions: {},
        speech: true,
      }
    }
    return {}
  }

  const team = createTeam()
  const stop = team.start()
  try {
    await tick()
    await tick()
    const Probe = () => {
      rosterRenders += 1
      const roster = team.hooks.useRoster(s => s)
      const rescued = team.hooks.useRescuedDrafts(s => s)
      return react.createElement('div', { roster, rescued })
    }
    const probe = mount(Probe, {})
    probe.render()
    rosterRenders = 0

    // User types a custom answer into question q1 before the question is superseded/cancelled.
    team.actions.noteQuestionDraft({ kind: 'ask_user', id: 'q1', sessionId: 'b1', text: 'My half-typed custom answer' })
    assert.equal(team.actions.readQuestionDraft('ask_user', 'q1'), 'My half-typed custom answer')

    // Next poll advances revision (q1 disappears) AND changes live field `speech`.
    intervalFn()
    await tick()
    await tick()
    const props = probe.render().props
    assert.equal(plain(props.rescued).b1, 'My half-typed custom answer', 'question draft is rescued when question vanishes externally')
    assert.equal(plain(props.roster).revision, 2)
    assert.equal(plain(props.roster).speech, true)
    assert.equal(rosterRenders, 1, 'revision change with live field update must commit roster once')

    team.actions.consumeRescuedDraft('b1', 'b1', 'My half-typed custom answer')
    assert.equal(plain(probe.render().props.rescued).b1, undefined)
    probe.unmount()
  } finally {
    stop()
    sandbox.setInterval = prevSetInterval
    sandbox.clearInterval = prevClearInterval
    sandbox.__testCall = async () => ({})
    fetchCtrl.reset()
  }
})

test('buildSessionRows keeps committed row objects identical across 50 stream chunks and rebuilds only on real changes', () => {
  // A committed history of two turns, then one active attempt streaming text chunks.
  const history = {
    type: 'snapshot',
    header: { id: 's1', cwd: '/repo' },
    cursor: 6,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } },
      { type: 'event', event: { type: 'user/message', seq: 2, time: 1001, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'first question' }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 3, time: 1002, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first answer' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 4, time: 1003, data: { turn: 1, reason: { kind: 'completed' } } } },
      { type: 'event', event: { type: 'turn/start', seq: 5, time: 1100, data: { turn: 2 } } },
      { type: 'event', event: { type: 'user/message', seq: 6, time: 1101, data: { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] } } },
    ],
  }
  const roster = { bots: [], byId: {}, roomsById: {}, prefs: {}, exchangeTurns: {} }
  let log = applyFrame(emptyLog(), history).log
  const committedCount = buildSessionRows(log, { roster, sessionId: 's1' }).length

  const start = { type: 'assistant-stream', frame: { type: 'start', attemptId: 'att-1', revision: 1, turn: 2, step: 1, startedAfterSeq: 6 } }
  log = applyFrame(log, start).log
  let revision = 1
  let index = 0
  const chunkFrame = (chunk) => {
    revision += 1
    const frame = { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att-1', revision, index, time: 2000 + revision, chunk } }
    index += 1
    return frame
  }

  // 50 text chunks of one growing text block (block-start once, then deltas). The
  // writing row only appears once real text exists, so the baseline builds after word0.
  log = applyFrame(log, chunkFrame({ type: 'block-start', index: 0, blockType: 'text' })).log
  assert.equal(buildSessionRows(log, { roster, sessionId: 's1' }).length, committedCount, 'an empty text block renders no writing row yet')
  log = applyFrame(log, chunkFrame({ type: 'text-delta', index: 0, text: 'word0 ' })).log
  const first = buildSessionRows(log, { roster, sessionId: 's1' })
  assert.equal(first.length, committedCount + 1, 'the live writing row trails the committed rows')
  const committed = first.slice(0, committedCount)
  let live = first.at(-1)
  assert.equal(live.streaming, true)
  assert.equal(live.key, 'writing:att-1')

  let drift = 0
  for (let piece = 1; piece < 50; piece += 1) {
    log = applyFrame(log, chunkFrame({ type: 'text-delta', index: 0, text: `word${piece} ` })).log
    const rows = buildSessionRows(log, { roster, sessionId: 's1' })
    assert.equal(rows.length, committedCount + 1)
    for (let at = 0; at < committedCount; at += 1) {
      if (rows[at] !== committed[at]) drift += 1
    }
    const current = rows.at(-1)
    if (piece === 1) {
      // The writing row itself is rebuilt per chunk; only the committed rows hold still.
      assert.notEqual(current, live)
    }
    live = current
  }
  assert.equal(drift, 0, 'every committed row object is identical across all 50 chunks')
  assert.match(live.texts[0], /word48/, 'the live row carries the whole streamed text')

  // The same rows again when the exact same log builds twice (cache hit even with no new frame).
  const again = buildSessionRows(log, { roster, sessionId: 's1' })
  for (let at = 0; at < committedCount; at += 1) assert.equal(again[at], committed[at])

  // A new events array (a real event lands) rebuilds the committed rows.
  const seq7 = { type: 'event', event: { type: 'assistant/message', seq: 7, time: 1200, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: live.texts[0] }] } } } }
  log = applyFrame(log, seq7).log
  const settled = buildSessionRows(log, { roster, sessionId: 's1' })
  assert.notEqual(settled[2], committed[2], 'a new events array invalidates the committed cache')
  assert.equal(settled.filter(row => row.kind === 'assistant').at(-1).streaming, false, 'the settled message replaces the live row')

  // The cache validates on the options: a different roster or session id never reuses rows.
  const otherRoster = { ...roster, exchangeTurns: { s1: [2] } }
  const hiddenRows = buildSessionRows(log, { roster: otherRoster, sessionId: 's1' })
  assert.equal(hiddenRows.some(row => row.kind === 'assistant' && row.turn === 2), false, 'hidden exchange turn rows vanish under a changed roster')
  assert.equal(hiddenRows.length, settled.length - 1, 'only the hidden assistant row drops out')
  const otherSession = buildSessionRows(log, { roster, sessionId: 'elsewhere' })
  assert.equal(otherSession.length, settled.length, 'another session id builds fresh rows')
  for (let at = 0; at < committedCount; at += 1) assert.notEqual(otherSession[at], committed[at], 'rows differ under another session id')
  // ...and the original cache entry still serves the original caller afterwards.
  const backAgain = buildSessionRows(log, { roster, sessionId: 's1' })
  assert.equal(backAgain[0], settled[0], 'the original entry survives foreign lookups')
})

test('createTeam followWork marks activeRooms running before member turns start and clears once idle', async () => {
  const prevSetInterval = sandbox.setInterval
  const prevClearInterval = sandbox.clearInterval
  let pollStep = 0
  let intervalFn = null
  sandbox.setInterval = (fn) => { intervalFn = fn; return 1 }
  sandbox.clearInterval = () => {}
  sandbox.__testCall = async (endpoint) => {
    if (endpoint !== 'state') return {}
    pollStep += 1
    if (pollStep === 1) {
      return {
        revision: 1,
        liveKey: 'ar-1',
        bots: [{ id: 'b1', name: 'Bot', sessionId: 'b1' }],
        rooms: [{ id: 'r1', name: 'Group', sessionId: 'r1', members: ['b1'] }],
        work: { bots: {}, rooms: {}, activeRooms: ['r1'], approvals: [] },
      }
    }
    return {
      revision: 1,
      unchanged: true,
      liveKey: 'ar-2',
      work: { bots: {}, rooms: {}, activeRooms: [], approvals: [] },
    }
  }
  const team = createTeam()
  const stop = team.start()
  try {
    await tick()
    await tick()
    assert.equal(team.snapshots.status().get('r1')?.running, true, 'active round with empty member work must mark group running')
    intervalFn()
    await tick()
    await tick()
    assert.equal(team.snapshots.status().get('r1')?.running, false, 'idle/paused group must clear running')
  } finally {
    stop()
    sandbox.setInterval = prevSetInterval
    sandbox.clearInterval = prevClearInterval
    sandbox.__testCall = async () => ({})
    fetchCtrl.reset()
  }
})
