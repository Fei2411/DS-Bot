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
const stubs = {
  'cells.js': `
    export const Bubbles = ({ texts, streaming }) => ({ type: 'bubbles', props: { texts, streaming, children: texts } })
    export const ThinkingRow = ({ text, live, ms }) => ({ type: 'thinking', props: { text, live, ms, children: [text] } })
    export const ChatRows = (props) => ({ type: 'chat-rows', props: { ...props, children: [] } })
    export const Shimmer = ({ children }) => ({ type: 'shimmer', props: { children: [children] } })
  `,
  'model-menu.js': 'export const ModelChoiceDock = () => null\nexport const ModelKeyCard = () => null\nexport const manageModels = () => undefined\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const writeClipboard = async () => true
    export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
    export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
  `,
}

// Bundle all DM session modules together so we test the real client code (including real
// `session-log.js` + `@deepseek-ai/dsh-llm/assistant-stream`) under a deterministic harness.
const entryCode = `
  export { applyFrame, addPage, emptyLog, transcriptOf, writingBlocks } from '../ds-bot/src/client/session-log.js'
  export { openSessionFollow } from './ui/src/api.js'
  export { createSlotRegistry, SlotOutlet, SlotErrorBoundary, TOOL_VIEW_SLOT, CHAT_NODE_SLOT } from './ui/src/slots.js'
  export { buildSessionRows, makeToolArgs, splitReasoning, streamReasoningMs } from './ui/src/session-transcript.js'
  export { ToolCallCard, GenericToolCard, argSummary, clipLongText, formatArgs, formatResult } from './ui/src/tool-card.js'
  export { SessionTranscript, useSessionFollow } from './ui/src/session-chat.js'
  export { Chat } from './ui/src/chat.js'
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
      bundler.onResolve({ filter: /(src\/client\/(cells|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'session-chat-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'session-chat-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

// Lightweight React stand-in supporting per-component-path hook slots (like Fiber),
// class error boundaries, and subscriptions.
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
const react = {
  Component: TestComponent,
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
  useId: () => slot(() => ({ id: 'id' })).id,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
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
    const finish = () => {
      if (closed) return
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
    }
    opts.signal?.addEventListener?.('abort', finish)
    const entry = {
      url,
      aborted: () => Boolean(opts.signal?.aborted),
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
          cancel: () => { finish(); return Promise.resolve() },
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
const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  __testCall: async () => ({ records: [], hasMore: false }),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`no platform module ${name}`)
  },
  AbortController, TextDecoder, URLSearchParams,
  console: { error() {}, warn() {}, log() {} },
  window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800 },
  document: { querySelector: () => null, body: { toggleAttribute() {}, removeAttribute() {} }, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
  setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: (...args) => fetchCtrl.fetch(...args),
}
runInNewContext(outputFiles[0].text, sandbox)
const {
  applyFrame, addPage, emptyLog,
  openSessionFollow,
  createSlotRegistry, TOOL_VIEW_SLOT,
  buildSessionRows, clipLongText, ToolCallCard,
  Chat,
} = module.exports

const expand = (node, path = 'root') => {
  if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${child?.props?.key ?? idx}]`))
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const id = `${path}/${node.type.name || 'fn'}:${node.props?.key ?? ''}`
    let bucket = current.fibers.get(id)
    if (!bucket) { bucket = { slots: [], index: 0 }; current.fibers.set(id, bucket) }
    bucket.index = 0
    const prev = current.fiber
    current.fiber = bucket
    try {
      if (node.type.prototype instanceof TestComponent) {
        const cell = slot(() => ({ inst: new node.type(node.props) }))
        const inst = cell.inst
        if (typeof node.type.getDerivedStateFromProps === 'function') {
          const patch = node.type.getDerivedStateFromProps(node.props, inst.state)
          if (patch) inst.state = { ...inst.state, ...patch }
        }
        inst.props = node.props
        try {
          return expand(inst.render(), id)
        } catch (error) {
          if (typeof node.type.getDerivedStateFromError === 'function') {
            inst.state = { ...inst.state, ...node.type.getDerivedStateFromError(error) }
            inst.componentDidCatch?.(error)
            return expand(inst.render(), id)
          }
          throw error
        }
      }
      return expand(node.type(node.props), id)
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

test('real recorded DSH 0.2.2-rc.1 replay projects user, thinking, streaming, tool lifecycle, and replies cleanly', () => {
  let log = emptyLog()
  const snapshots = {}
  for (let i = 0; i < fixture.live.length; i += 1) {
    const entry = fixture.live[i]
    assert.equal(entry.event, 'frame')
    const res = applyFrame(log, entry.data)
    assert.equal(res.reopen, false, `frame ${i} should not gap-reopen`)
    log = res.log
    if (i === 16 || i === 19 || i === 23 || i === 36 || i === 42 || i === 43 || i === 56) {
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

  // Frame 36: streaming tool-call preparing block with stable call key.
  const prepTool = snapshots[36].find(r => r.kind === 'tool')
  assert.ok(prepTool)
  assert.equal(prepTool.key, 'call:call-2-0')
  assert.equal(prepTool.toolName, 'list_bots')
  assert.equal(prepTool.phase, 'preparing')
  assert.equal(prepTool.block.args.raw, '{}')

  // Frame 42: committed tool/call transitions the same key to `start` (no duplicate row).
  const startTools = snapshots[42].filter(r => r.kind === 'tool')
  assert.equal(startTools.length, 1)
  assert.equal(startTools[0].key, 'call:call-2-0')
  assert.equal(startTools[0].phase, 'start')

  // Frame 43: tool/result pairs in place under the same key with call metadata + content.
  const doneTools = snapshots[43].filter(r => r.kind === 'tool')
  assert.equal(doneTools.length, 1)
  assert.equal(doneTools[0].key, 'call:call-2-0')
  assert.equal(doneTools[0].phase, 'result')
  assert.equal(doneTools[0].block.kind, 'tool-result')
  assert.equal(doneTools[0].block.call?.name, 'list_bots')
  assert.equal(doneTools[0].block.callTime, 1795239010695)
  assert.equal(doneTools[0].block.isError, false)
  assert.match(doneTools[0].block.content[0].text, /Chief/)

  // Frame 56: complete two-turn transcript with zero system injections or duplicates.
  assert.deepEqual(plain(snapshots[56].map(r => r.kind)), ['user', 'assistant', 'user', 'tool', 'assistant'])
  assert.equal(snapshots[56][2].text, '看看团队')
  assert.match(snapshots[56][4].texts[0], /Chief/)

  // Reconnect + page pagination from the real recorded fixture merges seqs 10..16 (all system
  // injections + request metadata) without leaking any system prompt into visible chat rows.
  let reconnected = emptyLog()
  for (const entry of fixture.reconnect) reconnected = applyFrame(reconnected, entry.data).log
  const beforeRows = buildSessionRows(reconnected)
  const paged = addPage(reconnected, fixture.page)
  const afterRows = buildSessionRows(paged)
  assert.equal(paged.events[0].seq, 10)
  assert.equal(paged.hasMore, true)
  assert.deepEqual(plain(afterRows.map(r => r.key)), plain(beforeRows.map(r => r.key)))
})

test('buildSessionRows handles compaction, hidden exchange turns, orphan tool results, PTC sub-calls, and turn-end failures', () => {
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
      // Turn 3: orphan tool result + parent tool call with nested PTC sub-call + interrupted turn.
      { type: 'event', event: { type: 'turn/start', seq: 5, time: 3000, data: { turn: 3 } } },
      { type: 'event', event: { type: 'tool/result', seq: 6, time: 3005, data: { turn: 3, message: { toolCallId: 'orphan-1', content: [{ type: 'text', text: 'stale output' }], isError: true, error: { code: 'TIMEOUT' } } } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch-start', seq: 7, time: 3010, data: { turn: 3, callId: 'ptc-1', name: 'run_script', arguments: '{"cmd":"ls"}' } } },
      { type: 'event', event: { type: 'tool/call', seq: 8, time: 3011, data: { turn: 3, callId: 'sub-1', parentCallId: 'ptc-1', name: 'read_file', arguments: '{"path":"a.txt"}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 9, time: 3012, data: { turn: 3, message: { toolCallId: 'sub-1', content: [{ type: 'text', text: 'hello' }], isError: false } } } },
      { type: 'event', event: { type: 'tool/ptc-dispatch-end', seq: 10, time: 3020, data: { turn: 3, message: { toolCallId: 'ptc-1', content: [{ type: 'text', text: 'done' }], isError: false } } } },
      { type: 'event', event: { type: 'turn/end', seq: 11, time: 3025, data: { turn: 3, reason: { kind: 'interrupted' } } } },
      // Turn 4: signed-out hook abort.
      { type: 'event', event: { type: 'turn/start', seq: 12, time: 4000, data: { turn: 4 } } },
      { type: 'event', event: { type: 'turn/end', seq: 13, time: 4005, data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } } } } },
    ],
  }
  const { log } = applyFrame(emptyLog(), snapshot)
  const rows = buildSessionRows(log, { roster: { exchangeTurns: { s1: [2] } }, sessionId: 's1' })

  assert.deepEqual(plain(rows.map(r => r.kind)), ['compaction', 'tool', 'tool', 'turn-error', 'turn-error'])
  assert.equal(rows[0].shadowedItemCount, 4)
  assert.equal(rows[0].summary, 'Earlier summary')

  // Orphan tool result keeps call: null and error flag.
  assert.equal(rows[1].callId, 'orphan-1')
  assert.equal(rows[1].block.call, null)
  assert.equal(rows[1].block.isError, true)

  // Parent PTC call carries nested sub-call in subCalls instead of duplicating at top level.
  assert.equal(rows[2].callId, 'ptc-1')
  assert.equal(rows[2].phase, 'result')
  assert.equal(rows[2].block.subCalls.length, 1)
  assert.equal(rows[2].block.subCalls[0].callId, 'sub-1')
  assert.equal(rows[2].block.subCalls[0].phase, 'result')

  // Interrupted & signed-out turn endings produce standard failure codes.
  assert.equal(rows[3].error.code, 'INTERRUPTED')
  assert.equal(rows[4].error.code, 'ACCOUNT_SIGNED_OUT')
})

test('tool.call.toolview slot overrides matching tool with DSH contract, isolates throws with Retry, and folds long output', () => {
  // Long result folding (>12 lines).
  const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n')
  const clipped = clipLongText(manyLines)
  assert.equal(clipped.folded, true)
  assert.equal(clipped.lines, 20)
  assert.match(clipped.shown, /line-12\n…$/)

  const registry = createSlotRegistry()
  const received = []
  let shouldThrow = false
  registry.register({ name: TOOL_VIEW_SLOT, key: 'list_bots' }, (props) => {
    if (shouldThrow) throw new Error('plugin boom')
    const disc = props.useDisclosure()
    received.push({ callId: props.callId, toolName: props.toolName, cwd: props.cwd, phase: props.phase, keys: Object.keys(disc).sort() })
    return react.createElement('div', { className: 'custom-slot' }, `custom:${props.toolName}:${disc.expanded}`)
  })

  const listEntry = {
    key: 'call:c1', callId: 'c1', toolName: 'list_bots', phase: 'result',
    block: { kind: 'tool-result', callId: 'c1', name: 'list_bots', call: { name: 'list_bots', argsRaw: '{}' }, callTime: 1000, time: 2500, content: [{ type: 'text', text: 'ok' }], isError: false, subCalls: [] },
  }
  const otherEntry = {
    key: 'call:c2', callId: 'c2', toolName: 'bash', phase: 'result',
    block: { kind: 'tool-result', callId: 'c2', name: 'bash', args: { raw: '{"cmd":"echo hi"}', text: k => (k === 'cmd' ? 'echo hi' : undefined), parsed: () => ({ cmd: 'echo hi' }) }, call: { name: 'bash', argsRaw: '{"cmd":"echo hi"}' }, callTime: 1000, time: 3000, content: [{ type: 'text', text: manyLines }], isError: false, subCalls: [] },
  }

  // Custom slot receives DSH ToolCallOwnerProps + UseDisclosure ({ expanded, setExpanded, toggle }).
  const customMount = mount(ToolCallCard, { entry: listEntry, cwd: '/repo', registry })
  const customTree = customMount.render()
  assert.match(textOf(customTree), /custom:list_bots:false/)
  assert.deepEqual(received[0], { callId: 'c1', toolName: 'list_bots', cwd: '/repo', phase: 'result', keys: ['expanded', 'setExpanded', 'toggle'] })

  // Throwing slot is isolated by SlotErrorBoundary and recovers on Retry.
  shouldThrow = true
  const errTree = customMount.render()
  assert.match(textOf(errTree), /This view could not be shown/)
  const retryBtn = all(errTree, n => n.type === 'button' && textOf(n) === 'Retry')[0]
  assert.ok(retryBtn)
  shouldThrow = false
  retryBtn.props.onClick()
  assert.match(textOf(customMount.render()), /custom:list_bots:false/)

  // Unregistered tool falls back to GenericToolCard with expand + long-result fold toggle.
  const genericMount = mount(ToolCallCard, { entry: otherEntry, cwd: '/repo', registry })
  let tree = genericMount.render()
  assert.match(textOf(tree), /bash/)
  assert.match(textOf(tree), /echo hi/)
  assert.match(textOf(tree), /2s/)
  // Click header to expand arguments + result.
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

test('openSessionFollow handles split CRLF frames, immediate reopen(), and stops retrying on terminal errors', async () => {
  fetchCtrl.reset()
  const events = []
  const handle = openSessionFollow({ sessionId: 'b1', max: 20 }, (event, data) => events.push([event, data]))
  try {
    await tick()
    assert.equal(fetchCtrl.calls.length, 1)
    assert.match(fetchCtrl.calls[0].url, /^api\/bot\/session\?id=b1&max=20$/)

    // Deliver one SSE frame split across two chunks with CRLF endings.
    fetchCtrl.latest().pushRaw('event: frame\r\ndata: {"type":"snap')
    await tick()
    fetchCtrl.latest().pushRaw('shot","cursor":1,"records":[]}\r\n\r\n')
    await tick()
    await tick()
    assert.equal(events.length, 1)
    assert.equal(events[0][0], 'frame')
    assert.equal(events[0][1].type, 'snapshot')

    // reopen() aborts the active stream and immediately opens a new connection.
    const firstStream = fetchCtrl.latest()
    handle.reopen()
    await tick()
    await tick()
    assert.equal(firstStream.aborted(), true)
    assert.equal(fetchCtrl.calls.length, 2)

    // Terminal error (`bot/not-found`) notifies caller and stops reconnecting.
    fetchCtrl.latest().push('error', { code: 'bot/not-found', message: 'gone' })
    fetchCtrl.latest().close()
    await tick()
    await tick()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.ok(events.some(([ev, d]) => ev === 'error' && d?.code === 'bot/not-found'))
    assert.equal(fetchCtrl.calls.length, 2, 'must not reconnect after terminal bot/not-found error')
  } finally {
    handle.close()
    fetchCtrl.reset()
  }
})

test('Chat DM renders real recorded session, supports Load earlier, read-only feed reopen, live note, and repeated pending dedup', async () => {
  fetchCtrl.reset()
  const listeners = new Set()
  const liveNotes = []
  const pageCalls = []
  sandbox.__testCall = async (name, body) => {
    pageCalls.push([name, body])
    return fixture.page
  }

  let roster = {
    ready: true,
    readOnly: true,
    prefs: { enterToSend: true, thinking: true },
    bots: [{ id: 'session-main', name: 'Chief', color: 'blue' }],
    byId: { 'session-main': { id: 'session-main', name: 'Chief', color: 'blue' } },
    rooms: [],
    roomsById: {},
    questions: {},
    exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {},
      noteLive: (sid, key, value) => liveNotes.push([sid, key, value]),
      noteTurnTime() {},
      send: async () => {},
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useTurnClock: select => select({}),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }

  const inst = mount(Chat, { sessionId: 'session-main', team })
  try {
    inst.render()
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

    // Read-only window: feed `revision` event triggers reopen() of api/bot/session.
    for (const listener of listeners) listener('revision', {})
    await tick()
    await tick()
    assert.equal(fetchCtrl.calls.length, 2)

    // Snapshot with a gap past seq 34 (so join resets to the new tail window with `hasMore: true`)
    // and an existing historical "继续" message at seq 45.
    fetchCtrl.latest().push('frame', {
      type: 'snapshot',
      header: { id: 'session-main', cwd: '/bench/bot/workspace' },
      cursor: 45,
      hasMore: true,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 45, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } } },
      ],
    })
    await tick()
    await tick()
    tree = inst.render()

    // Click "Load earlier" -> calls `session-page` with beforeSeq: 45 and merges older page.
    const earlierBtn = all(tree, n => n.type === 'button' && n.props?.className === 'bt-soft')[0]
    assert.ok(earlierBtn, 'Load earlier button should appear when hasMore is true')
    earlierBtn.props.onClick()
    await tick()
    await tick()
    assert.deepEqual(plain(pageCalls[0]), ['session-page', { sessionId: 'session-main', beforeSeq: 45, maxMessages: 40 }])

    // Send "继续" twice -> both stay pending even though seq 45 already had "继续".
    const sendText = async (value) => {
      const ta = all(inst.render(), n => n.type === 'textarea')[0]
      ta.props.onChange({ target: { value } })
      const btn = all(inst.render(), n => n.type === 'button' && n.props?.className === 'dsb-send')[0]
      btn.props.onClick()
      await tick()
    }
    const pendingCount = () => {
      const pendingRows = all(inst.render(), n => n.type === 'div' && n.props?.className === 'dsb-pending')
      return pendingRows[0] ? all(pendingRows[0], n => n.type === 'chat-rows')[0].props.items.length : 0
    }
    await sendText('继续')
    await sendText('继续')
    assert.equal(pendingCount(), 2)

    // First new user/message clears exactly ONE pending entry.
    fetchCtrl.latest().push('frame', {
      type: 'event',
      event: { type: 'user/message', seq: 46, time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    })
    await tick()
    await tick()
    assert.equal(pendingCount(), 1)

    // Second new user/message clears the remaining pending entry.
    fetchCtrl.latest().push('frame', {
      type: 'event',
      event: { type: 'user/message', seq: 47, time: 6000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    })
    await tick()
    await tick()
    assert.equal(pendingCount(), 0)

    // Streaming text marks session-reply live, then clears on commit.
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a9', revision: 1, turn: 5, step: 1, startedAfterSeq: 47 } })
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a9', revision: 2, index: 0, time: 6010, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    fetchCtrl.latest().push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a9', revision: 3, index: 1, time: 6011, chunk: { type: 'text-delta', index: 0, text: 'streaming now' } } })
    await tick()
    await tick()
    inst.render()
    assert.ok(liveNotes.some(([, key, val]) => key === 'session-reply' && val?.text === true))
    fetchCtrl.latest().push('frame', { type: 'event', event: { type: 'assistant/message', seq: 48, time: 6020, data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'streaming now' }] } } } })
    await tick()
    await tick()
    inst.render()
    assert.deepEqual(plain(liveNotes.at(-1)), ['session-main', 'session-reply', null])
  } finally {
    inst.unmount()
    fetchCtrl.reset()
  }
})
