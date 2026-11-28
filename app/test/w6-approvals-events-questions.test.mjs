import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { HeaderPill } from './ds-bot/src/client/header.js'
      export { ApprovalDock, foregroundApprovalsOf } from './app/ui/src/approval-dock.js'
      export { buildSessionRows } from './app/ui/src/session-transcript.js'
      export { SessionTranscript } from './app/ui/src/session-chat.js'
      export { adaptRoomItem } from './app/ui/src/chat-transcript.js'
      export { ChatRows, EarlierParts } from './ds-bot/src/client/cells.js'
      export { ClassicQuestionDock, clearClassicQuestionProgress } from './app/ui/src/classic-questions.js'
      export { ClassicPlanCard } from './app/ui/src/classic-plan-view.js'
      export { Composer } from './app/ui/src/composer-area.js'
    `,
    resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'w6-prd-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: 'as.js', namespace: 'prd-as' }))
      bundler.onLoad({ filter: /.*/, namespace: 'prd-as' }, () => ({
        contents: `export const assembleAssistantStream = () => null; export const createAssistantStreamAccumulator = () => ({ apply() {}, snapshot: () => null })`,
        loader: 'js',
      }))
      bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({ path: 'dp.js', namespace: 'prd-dp' }))
      bundler.onLoad({ filter: /.*/, namespace: 'prd-dp' }, () => ({
        contents: `
          import { createElement as h } from 'react'
          export const MarkdownText = ({ text }) => h('div', { className: 'md_markdown', 'data-md': '1' }, text)
          export const writeClipboard = async () => true
          export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
          export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
          export const CopyableText = ({ text }) => text
          export const Shimmer = ({ children }) => children
          export const Spinner = () => null
          export const FishLogo = () => null
          export const InlineNotice = ({ children }) => children
          export const Pill = ({ children }) => children
          export const Button = ({ children }) => children
          export const Tooltip = ({ children }) => children
          export const formatDuration = ms => ms + 'ms'
        `,
        loader: 'js',
      }))
    },
  }],
})

let current
let effects = []
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const depsChanged = (prev, next) => {
  if (!prev || !next || prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true
  }
  return false
}
class MiniComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
}
let idSeq = 0
const react = {
  Component: MiniComponent,
  Fragment: 'fragment',
  memo: fn => fn,
  createContext: value => ({ _v: value, Provider: ({ children }) => children }),
  useContext: ctx => ctx?._v,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
  useId: () => slot(() => `id-${++idSeq}`),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: (fn, deps) => {
    const cell = slot(() => ({ deps: null, cleanup: null }))
    if (cell.deps === null || deps === undefined || depsChanged(cell.deps, deps)) {
      cell.deps = deps ?? []
      effects.push(() => {
        cell.cleanup?.()
        const clean = fn()
        cell.cleanup = typeof clean === 'function' ? clean : null
      })
    }
  },
  useLayoutEffect: (fn, deps) => react.useEffect(fn, deps),
  useMemo: (make, deps) => {
    const cell = slot(() => ({ deps: null, value: undefined }))
    if (cell.deps === null || deps === undefined || depsChanged(cell.deps, deps)) {
      cell.deps = deps ?? []
      cell.value = make()
    }
    return cell.value
  },
  useCallback: (fn, deps) => react.useMemo(() => fn, deps),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`unexpected require ${name}`)
  },
  console: { ...console, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    body: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  window: {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  },
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  HeaderPill,
  ApprovalDock,
  buildSessionRows,
  SessionTranscript,
  adaptRoomItem,
  ChatRows,
  ClassicQuestionDock,
  clearClassicQuestionProgress,
  ClassicPlanCard,
  Composer,
} = mod.exports

function mount(Component, initialProps) {
  const states = new Map()
  let props = initialProps
  const runEffects = () => {
    const batch = effects
    effects = []
    for (const eff of batch) eff()
  }
  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map((item, idx) => expand(item, `${path}.${idx}`))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name || 'fn'}`
      const st = states.get(key) ?? { slots: [] }
      states.set(key, st)
      const prev = current
      current = { slots: st.slots, index: 0 }
      try {
        return expand(node.type(node.props), `${key}:fn`)
      } finally {
        current = prev
      }
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}:c`) } }
  }
  return {
    render(nextProps = props) {
      props = nextProps
      const tree = expand(react.createElement(Component, props), 'root')
      runEffects()
      return tree
    },
    unmount() {
      for (const st of states.values()) {
        for (const s of st.slots) s?.cleanup?.()
      }
      states.clear()
    },
  }
}

const all = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, match))
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...all(node.props?.children, match)]
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = v => JSON.parse(JSON.stringify(v))

test('W6 PR D: Bot DM foreground approvals belong only to ApprovalDock when dockOwnsForegroundApprovals is true; HeaderPill keeps background & group approvals', () => {
  const bot = { id: 'b1', name: 'Chief', sessionId: 'b1' }
  const room = { id: 'r1', name: 'Launch', members: ['b1'], sessionId: 'r1' }
  const roster = { ready: true, bots: [bot], byId: { b1: bot }, rooms: [room], roomsById: { r1: room }, prefs: {} }
  const work = {
    bots: {},
    approvals: [
      { id: 'fg-1', botId: 'b1', sessionId: 'b1', tool: 'bash', reason: 'Run build', answerable: true },
      { id: 'bg-1', botId: 'b1', sessionId: 't1', taskId: 'task-1', tool: 'bash', reason: 'Bg deploy', answerable: true },
      { id: 'rm-1', botId: 'b1', roomId: 'r1', sessionId: 'g1', tool: 'bash', reason: 'Group task', answerable: true },
    ],
  }
  const baseHeaderProps = {
    useRoster: s => s(roster),
    useSessions: s => s({ ids: [], byId: {} }),
    useSessionStatus: s => s(new Map()),
    useSession: s => s({}),
    useActivity: s => s({}),
    useTurnClock: s => s({}),
    useLive: s => s({}),
    useUi: s => s({}),
    useWork: s => s(work),
    useComputer: s => s({}),
    useConversationViews: s => s([]),
    selectView: () => {},
    actions: { beginVisit() {}, endVisit() {}, toggleDetails() {}, clearLive() {} },
  }

  // Desktop Bot DM: HeaderPill omits foreground approval when dockOwnsForegroundApprovals=true, keeps bg-1.
  const desktopDmOnlyFg = mount(HeaderPill, {
    ...baseHeaderProps,
    sessionId: 'b1',
    dockOwnsForegroundApprovals: true,
    useWork: s => s({ bots: {}, approvals: [work.approvals[0]] }),
  })
  const desktopTree = desktopDmOnlyFg.render()
  assert.equal(all(desktopTree, n => String(n.props?.className ?? '').includes('bt-approval-pod')).length, 0,
    'Desktop HeaderPill must NOT claim Bot DM foreground approvals owned by ApprovalDock')

  // ApprovalDock claims fg-1.
  const dock = mount(ApprovalDock, { botId: 'b1', sessionId: 'b1', useWork: s => s(work), actions: {}, readOnly: false })
  assert.match(textOf(dock.render()), /Run build/)

  // Desktop HeaderPill still renders background-task approval and group approval.
  const desktopDmBg = mount(HeaderPill, {
    ...baseHeaderProps,
    sessionId: 'b1',
    dockOwnsForegroundApprovals: true,
    useWork: s => s({ bots: {}, approvals: [work.approvals[1]] }),
  })
  assert.match(textOf(desktopDmBg.render()), /waiting for your approval/i)

  const desktopGroup = mount(HeaderPill, {
    ...baseHeaderProps,
    sessionId: 'r1',
    dockOwnsForegroundApprovals: true,
    useWork: s => s({ bots: {}, approvals: [work.approvals[2]] }),
  })
  assert.match(textOf(desktopGroup.render()), /waiting for your approval/i)

  // Plugin mode (default dockOwnsForegroundApprovals=false) still shows foreground approval in HeaderPill.
  const pluginDm = mount(HeaderPill, {
    ...baseHeaderProps,
    sessionId: 'b1',
    useWork: s => s({ bots: {}, approvals: [work.approvals[0]] }),
  })
  assert.match(textOf(pluginDm.render()), /waiting for your approval/i)
})

test('W6 PR D: current segment renders ask_back, answer, cancelled, note collaboration events; group adaptRoomItem forwards claims; group post msgKey uses (part.sessionId, seq)', () => {
  const bot1 = { id: 'b1', name: 'Chief', sessionId: 'b1' }
  const bot2 = { id: 'b2', name: 'Writer', sessionId: 'b2' }
  const room = { id: 'r1', name: 'Launch', members: ['b1', 'b2'], sessionId: 'r1' }
  const roster = { ready: true, bots: [bot1, bot2], byId: { b1: bot1, b2: bot2 }, rooms: [room], roomsById: { r1: room }, prefs: {} }

  const log = {
    header: { id: 'b1', cwd: '/repo' },
    events: [
      { type: 'user/message', seq: 1, time: 100, data: { turn: 1, source: { kind: 'bot', role: 'ask_back', senderSessionId: 'b2', senderName: 'Writer' }, content: [{ type: 'text', text: '?' }] } },
      { type: 'user/message', seq: 2, time: 200, data: { turn: 2, source: { kind: 'bot', role: 'answer', senderSessionId: 'b2', senderName: 'Writer' }, content: [{ type: 'text', text: '!' }] } },
      { type: 'user/message', seq: 3, time: 300, data: { turn: 3, source: { kind: 'bot', role: 'cancelled', senderSessionId: 'b2', senderName: 'Writer' }, content: [{ type: 'text', text: 'x' }] } },
      { type: 'user/message', seq: 4, time: 400, data: { turn: 4, source: { kind: 'bot', role: 'note', senderSessionId: 'b2', senderName: 'Writer' }, content: [{ type: 'text', text: 'n' }] } },
    ],
    writing: null,
  }
  const rows = buildSessionRows(log, roster, 'b1')
  assert.deepEqual(plain(rows.map(r => r.eventKind)), ['ask_back', 'answer', 'cancelled', 'note'])

  const tx = mount(SessionTranscript, {
    log,
    sessionId: 'b1',
    bot: bot1,
    roster,
    actions: { openExchange() {}, openFile() {} },
    useUi: s => s({}),
    useRoster: s => s(roster),
  })
  const txText = textOf(tx.render())
  assert.match(txText, /Question from/)
  assert.match(txText, /Answer from/)
  assert.match(txText, /Cancelled by/)
  assert.match(txText, /Note from/)

  // Group adaptRoomItem forwards claims.
  const adapted = adaptRoomItem({
    kind: 'bot',
    id: 5,
    sessionId: 'part-old',
    botId: 'b2',
    name: 'Writer',
    text: 'Done',
    time: 500,
    claims: [{ kind: 'file', path: 'out.md' }],
  })
  assert.deepEqual(plain(adapted.claims), [{ kind: 'file', path: 'out.md' }])

  // #2483 review finding: group post reaction msgKey uses (part.sessionId, seq) composite key to prevent rollover collisions.
  const reacted = []
  const rowsView = mount(ChatRows, {
    items: [
      { kind: 'post', sessionId: 'part-1', seq: 1, botId: 'b2', text: 'Part 1 reply', time: 1000 },
      { kind: 'post', sessionId: 'part-2', seq: 1, botId: 'b2', text: 'Part 2 reply', time: 2000 },
    ],
    sessionId: 'r1',
    roster,
    actions: { react: (msgKey, emoji) => reacted.push([msgKey, emoji]) },
    useUi: s => s({ reactions: { 'part-1:post:1': { 0: ['👍'] }, 'part-2:post:1': { 0: ['🎉'] } } }),
  })
  const groupTree = rowsView.render()
  const groupText = textOf(groupTree)
  assert.match(groupText, /👍/)
  assert.match(groupText, /🎉/)
})

test('W6 PR D: Classic question card persists progress across chat switches, renders Markdown detail, pre-selects Recommended, and single-select does not auto-submit on click', async () => {
  clearClassicQuestionProgress()
  const submitted = []
  const actions = {
    answerUserQuestion: async (sid, id, answers) => { submitted.push({ sid, id, answers }) },
    dismissUserQuestion: async () => {},
  }
  const entry = {
    id: 'q-1',
    callId: 'call-q1',
    sessionId: 's1',
    kind: 'question',
    mode: 'blocking',
    questions: [{
      id: 'item-1',
      header: 'Deploy',
      question: 'Choose target',
      detail: '**Important**: check `staging` first',
      options: [
        { label: 'Staging (Recommended)', description: 'Safe' },
        { label: 'Production', description: 'Live' },
      ],
    }],
  }
  const roster = { prefs: {} }
  const makeDock = sessionId => mount(ClassicQuestionDock, {
    sessionId,
    useUserQuestions: s => s([entry]),
    useRoster: s => s(roster),
    actions,
  })

  // Mount in s1: Recommended option is pre-selected, detail renders via MarkdownText.
  let dock1 = makeDock('s1')
  let tree = dock1.render()
  assert.equal(all(tree, n => n.props?.['data-md'] === '1').length, 1, 'detail must render via MarkdownText')
  let optBtns = all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')
  assert.equal(optBtns[0].props['aria-pressed'], true, 'Recommended option should be pre-selected')
  assert.equal(optBtns[1].props['aria-pressed'], false)

  // Clicking Production selects it WITHOUT auto-submitting on click.
  optBtns[1].props.onClick()
  tree = dock1.render()
  await tick()
  assert.equal(submitted.length, 0, 'single-select click must NOT auto-submit')
  optBtns = all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')
  assert.equal(optBtns[1].props['aria-pressed'], true)

  // Unmount (simulate switching to another chat) and remount -> selection survives!
  dock1.unmount()
  const dock2 = makeDock('s1')
  tree = dock2.render()
  optBtns = all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')
  assert.equal(optBtns[1].props['aria-pressed'], true, 'in-progress selection must survive chat switch')

  // Explicitly submitting sends Production.
  const form = all(tree, n => n.type === 'form')[0]
  form.props.onSubmit({ preventDefault() {} })
  await tick()
  assert.equal(submitted.length, 1)
  assert.deepEqual(plain(submitted[0].answers), [{ id: 'item-1', selected: ['Production'] }])
})

test('W6 PR D: ClassicPlanCard open state updates when status transitions, and Classic slash command ignores stale results after session switch', async () => {
  // 1. ClassicPlanCard auto-updates open state on status transition until user toggles manually.
  const planView = mount(ClassicPlanCard, {
    block: { phase: 'start', args: { text: () => '# Rollout\n\nStep 1' } },
  })
  let tree = planView.render()
  assert.equal(all(tree, n => n.props?.className === 'dsb-plan-card')[0].props['data-open'], '')

  // Transition pending -> dismissed (muted) collapses automatically.
  tree = planView.render({
    block: { phase: 'result', isError: false, args: { text: () => '# Rollout\n\nStep 1' }, content: [{ type: 'text', text: 'The user dismissed the plan review' }] },
  })
  tree = planView.render({
    block: { phase: 'result', isError: false, args: { text: () => '# Rollout\n\nStep 1' }, content: [{ type: 'text', text: 'The user dismissed the plan review' }] },
  })
  assert.equal(all(tree, n => n.props?.className === 'dsb-plan-card')[0].props['data-open'], undefined)

  // User manually opens it -> subsequent tone transition respects user's manual toggle.
  all(tree, n => n.type === 'button' && n.props?.className === 'dsb-plan-card-head')[0].props.onClick()
  tree = planView.render({
    block: { phase: 'result', isError: false, args: { text: () => '# Rollout\n\nStep 1' }, content: [{ type: 'text', text: 'The user dismissed the plan review' }] },
  })
  assert.equal(all(tree, n => n.props?.className === 'dsb-plan-card')[0].props['data-open'], '')

  // 2. Classic command race: switching sessions while runSessionCommand is pending ignores late error/notice.
  let rejectCmd
  const roster = { ready: true, bots: [], byId: {}, rooms: [], roomsById: {}, agentOf: { s1: 'a1', s2: 'a1' }, prefs: {} }
  const actions = {
    sessionControls: async () => ({}),
    sessionCommands: async () => ({ commands: [{ name: 'compact', description: 'Compact' }] }),
    runSessionCommand: () => new Promise((_, reject) => { rejectCmd = reject }),
    speech: () => null,
    canOpenFiles: () => false,
    canOpenTerminal: () => false,
  }
  const compProps = sid => ({
    sessionId: sid,
    placeholder: 'Message',
    disabled: false,
    running: false,
    onSend: async () => {},
    actions,
    useUi: s => s({}),
    useRoster: s => s(roster),
    useWork: s => s({ bots: {}, approvals: [] }),
    useSessions: s => s({ ids: [], byId: {} }),
    useSessionQueues: s => s({}),
  })
  const comp = mount(Composer, compProps('s1'))
  let cTree = comp.render()
  let ta = all(cTree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: '/compact', selectionStart: 8 } })
  cTree = comp.render()
  ta = all(cTree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  cTree = comp.render()
  ta = all(cTree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await tick()
  // Switch to s2 before command rejects!
  comp.render(compProps('s2'))
  rejectCmd(new Error('Late s1 failure'))
  await tick()
  await tick()
  cTree = comp.render(compProps('s2'))
  assert.equal(all(cTree, n => n.props?.className === 'dsb-composer-error').length, 0,
    'stale error from s1 command must NOT appear after switching to s2')
})
