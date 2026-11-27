import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const deepViewReact = fileURLToPath(import.meta.resolve('deep-view/react'))

const stubs = {
  'cells.js': `
    export const Bubbles = ({ texts }) => ({ type: 'bubbles', props: { texts, children: texts } })
    export const ThinkingRow = ({ text }) => ({ type: 'thinking', props: { text, children: [text] } })
    export const EarlierParts = () => null
    export const PartLine = () => null
    export const ChatRows = (props) => ({ type: 'chat-rows', props: { ...props, children: [] } })
    export const Shimmer = () => null
    export const Elapsed = () => null
    export const workPhrase = () => ''
    export const ToolCell = () => null
    export const isBotTool = () => false
  `,
  'widget-cell.js': 'export const WidgetCell = () => null\nexport const WidgetDock = () => null\nexport const AnsweredReply = () => null\nexport const ViewCard = () => null\n',
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

const entryCode = `
  export { activeComposerTrigger, applyTriggerText, buildSlashCommands, buildComposerMenuItems, ComposerMenu } from './ui/src/composer-menus.js'
  export { foregroundApprovalsOf, ApprovalDock } from './ui/src/approval-dock.js'
  export { matchGlobalShortcut, ShortcutsDialog } from './ui/src/shortcuts.js'
  export { extractTurnFacts, buildSessionRows } from './ui/src/session-transcript.js'
  export { SessionTranscript } from './ui/src/session-chat.js'
  export { Chat } from './ui/src/chat.js'
  export { createTeam } from './ui/src/team.js'
  export { applyFrame, emptyLog } from '../ds-bot/src/client/session-log.js'
  export { forgetKeptFiles } from '../ds-bot/src/client/draft-keep.js'
  export { STORAGE } from '../ds-bot/src/client/storage.js'
  export { PASTE_LIMIT } from '../ds-bot/src/client/paste-card.js'
  export { installLocale } from '../ds-bot/src/client/i18n.js'
  export { createLocale } from './ui/src/locale.js'
  export { mentionSpans } from '../ds-bot/src/shared/mentions.js'
`

const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'chunk2-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^deep-view\/react$/ }, () => ({ path: deepViewReact }))
      bundler.onResolve({ filter: /(src\/client\/(cells|widget-cell|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'chunk2-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|widget-cell|model-menu|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'chunk2-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'chunk2-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
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
const field = {
  style: {}, scrollHeight: 0, selectionStart: 0, selectionEnd: 0, focused: false,
  focus() { this.focused = true },
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b },
  closest: () => null, contains: () => false,
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
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
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

const portalTargets = []
const storageMap = new Map()
const winListeners = new Map()
class FakeFile {
  constructor(parts, name, opts = {}) {
    this.parts = parts
    this.name = name
    this.type = opts.type ?? ''
    this.textContent = parts.map(p => String(p)).join('')
    this.size = Buffer.byteLength(this.textContent, 'utf8')
  }
  async arrayBuffer() { return new TextEncoder().encode(this.textContent).buffer }
}

const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  __testCall: async () => ({}),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node, target) => { portalTargets.push(target); return node } }
    throw new Error(`unexpected require ${name}`)
  },
  File: FakeFile,
  AbortController,
  TextDecoder,
  URL,
  URLSearchParams,
  TextEncoder,
  btoa: str => Buffer.from(str, 'binary').toString('base64'),
  localStorage: {
    getItem: key => storageMap.get(key) ?? null,
    setItem: (key, value) => { storageMap.set(key, String(value)) },
    removeItem: key => { storageMap.delete(key) },
  },
  window: {
    addEventListener(type, fn) {
      const list = winListeners.get(type) ?? []
      list.push(fn)
      winListeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type)
      if (list) winListeners.set(type, list.filter(item => item !== fn))
    },
    innerHeight: 800,
  },
  document: {
    body: { toggleAttribute() {}, removeAttribute() {} },
    visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {},
    documentElement: { addEventListener() {}, removeEventListener() {} },
  },
  navigator: { language: 'en', platform: 'MacIntel' },
  console: { error() {}, warn() {}, log() {} },
  setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: fn => { fn(); return 0 },
  cancelAnimationFrame() {},
  performance: { now: () => 0 },
  fetch: async () => ({ ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => Promise.resolve() }) } }),
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  activeComposerTrigger,
  applyTriggerText,
  buildComposerMenuItems,
  foregroundApprovalsOf,
  ApprovalDock,
  matchGlobalShortcut,
  ShortcutsDialog,
  extractTurnFacts,
  buildSessionRows,
  SessionTranscript,
  Chat,
  createTeam,
  applyFrame,
  emptyLog,
  forgetKeptFiles,
  STORAGE,
  PASTE_LIMIT,
  installLocale,
  createLocale,
  mentionSpans,
} = mod.exports

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
        cell.inst.props = node.props
        return expand(cell.inst.render(), id)
      }
      return expand(fn(node.props), id)
    } finally {
      current.fiber = prev
    }
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}.c`) } }
}

const mount = (Component, props) => {
  const inst = {
    fibers: new Map(), effects: [], props,
    render(next = inst.props) {
      inst.props = next
      current = inst
      const out = expand(react.createElement(Component, next))
      current = undefined
      for (const run of inst.effects.splice(0)) run()
      return out
    },
    unmount() {
      for (const bucket of inst.fibers.values()) {
        for (const cell of bucket.slots) cell?.stop?.()
      }
    },
  }
  return inst
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
const plain = v => JSON.parse(JSON.stringify(v))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('activeComposerTrigger and applyTriggerText parse @ mentions and leading / commands cleanly', () => {
  assert.deepEqual(plain(activeComposerTrigger('@wr', 3)), { kind: 'mention', start: 0, end: 3, query: 'wr' })
  assert.deepEqual(plain(activeComposerTrigger('hi @De', 6)), { kind: 'mention', start: 3, end: 6, query: 'De' })
  assert.equal(activeComposerTrigger('a@b.com', 7), null, 'email address must not trigger @ menu')
  assert.equal(activeComposerTrigger('@writer next', 12), null, 'space closes @ query')

  assert.deepEqual(plain(activeComposerTrigger('/sch', 4)), { kind: 'command', start: 0, end: 4, query: 'sch' })
  assert.equal(activeComposerTrigger('say /sch', 8), null, '/ only triggers at index 0')
  assert.equal(activeComposerTrigger('/sch extra', 10), null, 'space closes / command')

  const spliced = applyTriggerText('hi @wr please', { start: 3, end: 6 }, '@Writer ')
  assert.deepEqual(plain(spliced), { text: 'hi @Writer please', caret: 11 })

  // Mid-token caret replaces the whole mention without leaving trailing characters or double spaces.
  const midTrigger = activeComposerTrigger('Ask @Wr|iter for help'.replace('|', ''), 7)
  assert.deepEqual(plain(midTrigger), { kind: 'mention', start: 4, end: 11, query: 'Wr' })
  assert.deepEqual(plain(applyTriggerText('Ask @Writer for help', midTrigger, '@Writer ')), { text: 'Ask @Writer for help', caret: 12 })

  const midCmd = activeComposerTrigger('/shor', 3)
  assert.deepEqual(plain(midCmd), { kind: 'command', start: 0, end: 5, query: 'sh' })

  // Caret immediately before punctuation preserves the punctuation and following words.
  const beforeComma = activeComposerTrigger('Ask @Wr, please', 7)
  assert.deepEqual(plain(beforeComma), { kind: 'mention', start: 4, end: 7, query: 'Wr' })
  assert.equal(applyTriggerText('Ask @Wr, please', beforeComma, '@Writer ').text, 'Ask @Writer , please')
})

test('buildComposerMenuItems populates @ mentions, + -> Reference a chat, and / slash commands', () => {
  const ran = []
  const roster = {
    ready: true,
    bots: [
      { id: 'b1', name: 'Chief', role: 'Lead', sessionId: 'b1' },
      { id: 'b2', name: 'Writer', role: 'Docs', sessionId: 'b2' },
    ],
    byId: {
      b1: { id: 'b1', name: 'Chief', role: 'Lead', sessionId: 'b1' },
      b2: { id: 'b2', name: 'Writer', role: 'Docs', sessionId: 'b2' },
    },
    rooms: [{ id: 'r1', name: 'Launch', admin: 'b1', members: ['b1', 'b2'], sessionId: 'r1' }],
    roomsById: { r1: { id: 'r1', name: 'Launch', admin: 'b1', members: ['b1', 'b2'], sessionId: 'r1' } },
  }
  const actions = {
    openSettings: (page, id) => ran.push(['settings', page, id]),
    composeGoal: id => ran.push(['goal', id]),
    showDetails: id => ran.push(['details', id]),
    openShortcuts: () => ran.push(['shortcuts']),
  }

  // DM mentions exclude self.
  const dmMentions = buildComposerMenuItems({ mode: 'mention', query: '', roster, sessionId: 'b1', actions })
  assert.deepEqual(plain(dmMentions.map(i => i.title)), ['Writer'])
  assert.equal(dmMentions[0].insertText, '@Writer ')

  // Group mentions include members + Everyone, and localized non-English locales (e.g. French)
  // emit canonical "@everyone " so `mentionSpans` routes to every member while Chinese keeps "@所有人 ".
  const roomMentions = buildComposerMenuItems({ mode: 'mention', query: '', roster, sessionId: 'r1', actions })
  assert.deepEqual(plain(roomMentions.map(i => i.title)), ['Chief', 'Writer', 'Everyone'])
  const stopFr = installLocale(createLocale('fr'))
  try {
    const frRoom = buildComposerMenuItems({ mode: 'mention', query: '', roster, sessionId: 'r1', actions })
    const everyoneRow = frRoom.find(item => item.key === 'room:everyone')
    assert.equal(everyoneRow.insertText, '@everyone ')
    assert.equal(mentionSpans(everyoneRow.insertText, roster.bots).some(span => span.all === true), true)
  } finally {
    stopFr()
  }
  const stopZh = installLocale(createLocale('zh'))
  try {
    const zhRoom = buildComposerMenuItems({ mode: 'mention', query: '', roster, sessionId: 'r1', actions })
    const everyoneRow = zhRoom.find(item => item.key === 'room:everyone')
    assert.equal(everyoneRow.insertText, '@所有人 ')
    assert.equal(mentionSpans(everyoneRow.insertText, roster.bots).some(span => span.all === true), true)
  } finally {
    stopZh()
  }
  installLocale(createLocale('en'))

  // Reference a chat formats canonical dsh-session mention.
  const refs = buildComposerMenuItems({ mode: 'reference', query: '', roster, sessions: { ids: ['ext-1'], byId: { 'ext-1': { id: 'ext-1', title: 'External Chat', updatedAt: 1000 } } }, sessionId: 'b1', actions })
  assert.equal(refs.length, 2)
  assert.match(refs[0].insertText, /^@\[Chat with Writer\]\(dsh-session:/)
  assert.match(refs[1].insertText, /^@\[External Chat\]\(dsh-session:/)

  // Slash commands include /goal in group (with admin) and exclude /goal in DM,
  // and every command carries a 1-line subtitle so rows keep uniform height.
  const dmCmds = buildComposerMenuItems({ mode: 'command', query: '', roster, sessionId: 'b1', actions })
  assert.deepEqual(plain(dmCmds.map(c => c.code)), ['/scheduled-task', '/details', '/shortcuts'])
  assert.equal(dmCmds.every(c => typeof c.subtitle === 'string' && c.subtitle.trim().length > 0), true)
  const roomCmds = buildComposerMenuItems({ mode: 'command', query: '', roster, sessionId: 'r1', actions })
  assert.deepEqual(plain(roomCmds.map(c => c.code)), ['/scheduled-task', '/goal', '/details', '/shortcuts'])
  assert.equal(roomCmds.every(c => typeof c.subtitle === 'string' && c.subtitle.trim().length > 0), true)
  const agentRoster = { ...roster, agentOf: { 'a-s1': 'a1' } }
  const agentCmds = buildComposerMenuItems({
    mode: 'command',
    query: '',
    roster: agentRoster,
    sessionId: 'a-s1',
    actions: { ...actions, openFiles: () => {}, canOpenTerminal: () => true, newTerminal: () => {} },
  })
  assert.deepEqual(plain(agentCmds.map(c => c.code)), ['/files', '/terminal', '/shortcuts'])
  assert.equal(agentCmds.every(c => typeof c.subtitle === 'string' && c.subtitle.trim().length > 0), true)
  roomCmds.find(c => c.code === '/goal').run()
  roomCmds.find(c => c.code === '/scheduled-task').run()
  roomCmds.find(c => c.code === '/shortcuts').run()
  assert.deepEqual(plain(ran), [['goal', 'r1'], ['settings', 'schedules', 'room:r1'], ['shortcuts']])
})

test('ApprovalDock shows only foreground DM approvals and dispatches allow/reject with error handling', async () => {
  const decisions = []
  let failOnce = false
  const work = {
    approvals: [
      { id: 'a-fg', botId: 'b1', sessionId: 'b1', tool: 'bash', reason: 'Run deploy', detail: { code: 'npm run deploy' }, answerable: true },
      { id: 'a-task', botId: 'b1', sessionId: 't1', taskId: 'task-1', tool: 'bash', reason: 'Bg task', answerable: true },
      { id: 'a-room', botId: 'b1', roomId: 'r1', sessionId: 'g1', tool: 'bash', reason: 'Group', answerable: true },
      { id: 'a-other', botId: 'b2', sessionId: 'b2', tool: 'bash', reason: 'Other bot', answerable: true },
      { id: 'a-ro', botId: 'b1', sessionId: 'b1', tool: 'bash', reason: 'Unanswerable', answerable: false },
    ],
  }
  assert.deepEqual(plain(foregroundApprovalsOf(work.approvals, 'b1').map(e => e.id)), ['a-fg'])

  const actions = {
    answerApproval: async (id, choice) => {
      if (failOnce) { failOnce = false; throw new Error('Stale approval') }
      decisions.push([id, choice])
    },
  }
  const inst = mount(ApprovalDock, { botId: 'b1', useWork: s => s(work), actions, readOnly: false })
  try {
    let tree = inst.render()
    assert.match(textOf(tree), /Waiting for approval/)
    assert.match(textOf(tree), /npm run deploy/)
    assert.match(textOf(tree), /Run deploy/)

    // Failed answer surfaces inline alert and unlocks buttons.
    failOnce = true
    const btns = all(tree, n => n.type === 'button')
    assert.equal(btns[0].props.className, 'bt-q-btn')
    assert.equal(btns[1].props.className, 'bt-q-submit')
    btns[1].props.onClick() // Allow once
    await tick()
    tree = inst.render()
    assert.match(textOf(tree), /Stale approval/)
    assert.equal(all(tree, n => n.type === 'button')[1].props.disabled, false)

    // Synchronous double-click fires answerApproval exactly once.
    const liveBtns = all(tree, n => n.type === 'button')
    liveBtns[0].props.onClick()
    liveBtns[1].props.onClick()
    await tick()
    assert.deepEqual(decisions, [['a-fg', 'reject']])

    // Read-only disables buttons.
    const roTree = inst.render({ botId: 'b1', useWork: s => s(work), actions, readOnly: true })
    assert.equal(all(roTree, n => n.type === 'button').every(b => b.props.disabled === true), true)
  } finally {
    inst.unmount()
  }
})

test('matchGlobalShortcut and ShortcutsDialog respect platform, IME, settings Cmd+K, and Escape', () => {
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'k', code: 'KeyK' }, { mac: true, settingsOpen: false }), 'palette')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'k', code: 'KeyK' }, { mac: true, settingsOpen: true }), null)
  assert.equal(matchGlobalShortcut({ metaKey: true, key: ',', code: 'Comma' }, { mac: true }), 'settings')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'n', code: 'KeyN' }, { mac: true }), 'new-chat')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: '\\', code: 'Backslash' }, { mac: true }), 'sidebar')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: '/', code: 'Slash' }, { mac: true }), 'shortcuts')
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: 'k', code: 'KeyK' }, { mac: false }), 'palette')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'k', code: 'KeyK', nativeEvent: { isComposing: true } }, { mac: true }), null)

  let closed = 0
  portalTargets.length = 0
  let focusedPrev = 0
  const prevEl = { isConnected: true, focus() { focusedPrev += 1 } }
  const modalInput = { isConnected: true, focus() {} }
  sandbox.document.activeElement = prevEl
  const inst = mount(ShortcutsDialog, { open: true, enterToSend: false, onClose: () => { closed += 1 } })
  try {
    const tree = inst.render()
    assert.equal(portalTargets.includes(sandbox.document.body), true)
    assert.match(textOf(tree), /Keyboard shortcuts/)
    assert.match(textOf(tree), /Toggle sidebar/)
    // enterToSend: false displays Cmd+Enter for Send message.
    const sendRow = all(tree, n => n.props?.className === 'dsb-shortcuts-row' && /Send message/.test(textOf(n)))[0]
    assert.match(textOf(sendRow), /⌘.*Enter/)
    // Escape key dismisses the modal via shared overlay-hooks stack.
    for (const fn of winListeners.get('keydown') ?? []) {
      fn({ key: 'Escape', defaultPrevented: false, preventDefault() {}, stopPropagation() {} })
    }
    assert.equal(closed, 1)
    const closeBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-shortcuts-close'))[0]
    closeBtn.props.onClick()
    assert.equal(closed, 2)

    // Closing while another modal already took focus must NOT steal focus back to prevEl.
    sandbox.document.activeElement = modalInput
    inst.render({ open: false, enterToSend: false, onClose: () => { closed += 1 } })
    assert.equal(focusedPrev, 0, 'closing shortcuts must not steal focus from a newly opened modal')

    // Closing back to document.body restores focus to prevEl.
    sandbox.document.activeElement = prevEl
    inst.render({ open: true, enterToSend: false, onClose: () => { closed += 1 } })
    sandbox.document.activeElement = sandbox.document.body
    inst.render({ open: false, enterToSend: false, onClose: () => { closed += 1 } })
    assert.equal(focusedPrev, 1, 'closing shortcuts back to body restores previous focus')
  } finally {
    sandbox.document.activeElement = null
    inst.unmount()
  }
})

test('extractTurnFacts, turn-tail BtwTurnTail/LearningTurnTail, deliverables SaveFileAction, and createTeam turnFacts/watchTurns wire end-to-end', async () => {
  const calls = []
  sandbox.__testCall = async (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint === 'state') return { unchanged: true }
    return {}
  }
  const team = createTeam()
  let notified = 0
  const unwatch = team.actions.watchTurns('b1', () => { notified += 1 })
  try {
    // Verify actions.learningAnswer and shortcuts overlay cleanup on createTeam.
    await team.actions.learningAnswer('lp-pending', true)
    assert.deepEqual(plain(calls[0]), ['learning-answer', { id: 'lp-pending', approve: true }])
    team.actions.openShortcuts()
    team.actions.openSettings('general')
    const uiProbe = mount(() => {
      const shortcuts = team.hooks.useUi(s => s.shortcuts)
      return { type: 'probe', props: { shortcuts } }
    }, {})
    assert.equal(uiProbe.render().props.shortcuts, false, 'opening Settings clears shortcuts modal')
    uiProbe.unmount()

    const log = applyFrame(emptyLog(), {
      type: 'snapshot',
      header: { id: 'b1', cwd: '/repo' },
      cursor: 6,
      hasMore: false,
      records: [
        { type: 'event', event: { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } } },
        { type: 'event', event: { seq: 2, time: 1010, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Here is your report.' }] } } } },
        // First item is invalid (empty path); second item MUST retain original index=1 for present://file!
        { type: 'event', event: { seq: 3, time: 1015, type: 'deliverables/presented', data: { turn: 1, files: [{ path: '' }, { path: '/repo/out/summary.pdf', description: 'Q4 summary' }] } } },
        { type: 'event', event: { seq: 4, time: 1020, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } } },
        { type: 'event', event: { seq: 5, time: 2000, type: 'turn/start', data: { turn: 2 } } },
      ],
    }).log

    const facts = extractTurnFacts(log.events, { roster: { exchangeTurns: { b1: [99] } }, sessionId: 'b1' })
    assert.equal(facts.openTurn, 2)
    assert.deepEqual(plain(facts.turns.get(1)), { turn: 1, status: 'closed', start: { seq: 1, time: 1000 }, end: { seq: 4, time: 1020 } })
    assert.deepEqual(plain(facts.turns.get(2)), { turn: 2, status: 'open', start: { seq: 5, time: 2000 } })

    // Hidden internal exchange turns are excluded so learning proposals never strand on a hidden turn.
    const hiddenFacts = extractTurnFacts([
      ...log.events,
      { seq: 6, time: 1500, type: 'turn/start', data: { turn: 3 } },
      { seq: 7, time: 1520, type: 'turn/end', data: { turn: 3, reason: { kind: 'stop' } } },
    ], { roster: { exchangeTurns: { b1: [3] } }, sessionId: 'b1' })
    assert.equal(hiddenFacts.turns.has(3), false, 'hidden exchange turn must be excluded from turnFacts')

    const rows = buildSessionRows(log, { roster: { exchangeTurns: {} }, sessionId: 'b1' })
    assert.deepEqual(plain(rows.map(r => r.kind)), ['assistant', 'deliverables', 'turn-tail'])
    assert.equal(rows[1].files[0].index, 1, 'filtered deliverable preserves original array index')

    const roster = {
      ready: true,
      bots: [{ id: 'b1', name: 'Chief', sessionId: 'b1', parts: [] }],
      byId: { b1: { id: 'b1', name: 'Chief', sessionId: 'b1', parts: [] } },
      rooms: [], roomsById: {}, prefs: {}, exchangeTurns: {},
      btwCards: {
        b1: [
          { id: 'btw-1', partId: 'b1', question: 'Quick check?', answer: 'All good.', status: 'done', anchorSeq: 2 },
          { id: 'btw-2', partId: 'b1', question: 'Open turn aside?', answer: 'Still running.', status: 'done', anchorSeq: 5 },
        ],
      },
      learning: {
        b1: [
          { id: 'lp-pending', botId: 'b1', kind: 'skill', action: 'create', name: 'terse-replies', content: '# Terse\nKeep replies crisp.', why: 'Remember terse replies', at: 1030 },
        ],
      },
      learningSettled: {
        b1: [
          { id: 'lp-settled', botId: 'b1', kind: 'skill', action: 'create', name: 'cite-tests', content: '# Tests\nCite test commands.', at: 1025, settledAt: 1028, outcome: 'approved' },
        ],
      },
    }
    const inst = mount(SessionTranscript, {
      log,
      sessionId: 'b1',
      bot: roster.byId.b1,
      roster,
      useRoster: s => s(roster),
      actions: team.actions,
    })
    try {
      inst.render()
      assert.ok(notified >= 1, 'SessionTranscript syncs turnFacts to createTeam')
      assert.equal(team.actions.turnFacts('b1').openTurn, 2)
      const tree = inst.render()
      // Delivered file renders name, description, and SaveFileAction button with preserved original index=1.
      assert.match(textOf(tree), /summary\.pdf/)
      assert.match(textOf(tree), /Q4 summary/)
      const saveBtn = all(tree, n => n.type === 'button' && /Save/.test(textOf(n)))[0]
      assert.ok(saveBtn, 'Save button must render')
      calls.length = 0
      sandbox.__testCall = async (endpoint, body) => {
        calls.push([endpoint, body])
        if (endpoint === 'file-download') return { data: '', name: 'summary.pdf', eof: true }
        return {}
      }
      saveBtn.props.onClick()
      await tick()
      assert.equal(calls.some(([ep, body]) => ep === 'file-download' && body?.seq === 3 && body?.index === 1), true, 'SaveFileAction downloads original deliverable index=1')
      // BtwTurnTail renders the closed-turn side chat card right on Turn 1!
      assert.match(textOf(tree), /Quick check\?/)
      // LearningTurnTail renders BOTH pending and settled learning cards on closed Turn 1!
      assert.match(textOf(tree), /skills\/terse-replies/)
      assert.match(textOf(tree), /Remember terse replies/)
      assert.match(textOf(tree), /Approved · cite-tests/)
    } finally {
      inst.unmount()
    }
  } finally {
    unwatch()
  }
})

test('Composer persists drafts across switches, folds long pastes into PasteCard with Put back, and runs @ / reference menus', async () => {
  storageMap.clear()
  forgetKeptFiles()
  const listeners = new Set()
  const feed = {
    on: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    emit: (ev, data) => { for (const fn of listeners) fn(ev, data) },
  }
  const shortcutsOpened = []
  const sentMessages = []
  const roster = {
    ready: true,
    readOnly: null,
    prefs: { enterToSend: true },
    bots: [
      { id: 'b1', name: 'Chief', role: 'Lead', sessionId: 'b1', parts: [] },
      { id: 'b2', name: 'Writer', role: 'Docs', sessionId: 'b2', parts: [] },
    ],
    byId: {
      b1: { id: 'b1', name: 'Chief', role: 'Lead', sessionId: 'b1', parts: [] },
      b2: { id: 'b2', name: 'Writer', role: 'Docs', sessionId: 'b2', parts: [] },
    },
    rooms: [], roomsById: {}, questions: {}, views: {}, exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {}, noteLive() {}, send: async (sid, text) => { sentMessages.push([sid, text]) },
      speech: () => undefined, openVoice() {}, clearQuote() {},
      canReferenceChat: () => true,
      referenceChat: (sid, ins) => feed.emit('reference-chat', { sessionId: sid, insertion: ins }),
      openShortcuts: () => shortcutsOpened.push(true),
      turnFacts: () => ({ turns: undefined, openTurn: undefined }),
      watchTurns: () => () => {},
    },
    hooks: {
      useRoster: s => s(roster),
      useUi: s => s({}),
      useSessions: s => s({ ids: [], byId: {} }),
      useSessionStatus: s => s(new Map()),
    },
    chat: feed,
  }

  // 1. Long paste (> PASTE_LIMIT) folds into PasteCard, survives chat switch, and Put back inserts into box.
  const first = mount(Chat, { sessionId: 'b1', team })
  try {
    let tree = first.render()
    const ta = all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] !== undefined)[0]
    ta.props.onChange({ target: { value: 'draft text', selectionStart: 10 } })
    const longText = 'x'.repeat(PASTE_LIMIT + 50)
    let prevented = false
    all(first.render(), n => n.type === 'textarea')[0].props.onPaste({
      clipboardData: { items: [], files: [], getData: () => longText },
      preventDefault() { prevented = true },
    })
    assert.equal(prevented, true)
    tree = first.render()
    assert.equal(all(tree, n => n.props?.className === 'bt-paste-card').length, 1, 'long paste renders PasteCard')
    assert.ok(storageMap.get(STORAGE.drafts)?.includes('draft text'), 'draft text persisted to localStorage')
  } finally {
    first.unmount()
  }

  // 2. Remounting same chat restores BOTH draft text and PasteCard; clicking Put back moves text into textarea!
  const second = mount(Chat, { sessionId: 'b1', team })
  try {
    let tree = second.render()
    tree = second.render()
    assert.equal(all(tree, n => n.type === 'textarea')[0].props.value, 'draft text')
    assert.equal(all(tree, n => n.props?.className === 'bt-paste-card').length, 1)
    const putBackBtn = all(tree, n => n.type === 'button' && n.props?.className === 'bt-paste-put')[0]
    putBackBtn.props.onClick()
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'bt-paste-card').length, 0)
    assert.ok(all(tree, n => n.type === 'textarea')[0].props.value.length > PASTE_LIMIT)

    // 3. Typing "@Wr" opens @ mention listbox; Enter inserts "@Writer ".
    const ta = all(tree, n => n.type === 'textarea')[0]
    ta.props.onChange({ target: { value: 'ask @Wr', selectionStart: 7 } })
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 1)
    assert.match(textOf(all(tree, n => n.props?.className === 'dsb-cmenu')[0]), /Writer/)
    let enterPrevented = false
    all(tree, n => n.type === 'textarea')[0].props.onKeyDown({
      key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false },
      preventDefault() { enterPrevented = true },
    })
    assert.equal(enterPrevented, true)
    tree = second.render()
    assert.equal(all(tree, n => n.type === 'textarea')[0].props.value, 'ask @Writer ')

    // 4. Typing "/short" opens slash command menu; Enter executes /shortcuts and clears input.
    all(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: '/short', selectionStart: 6 } })
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 1)
    all(tree, n => n.type === 'textarea')[0].props.onKeyDown({
      key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {},
    })
    tree = second.render()
    assert.equal(shortcutsOpened.length, 1)
    assert.equal(all(tree, n => n.type === 'textarea')[0].props.value, '')

    // 5. Blur closes an open @ mention menu so it never sticks over other UI.
    all(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'hello @Wr', selectionStart: 9 } })
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 1)
    all(tree, n => n.type === 'textarea')[0].props.onBlur()
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 0, 'textarea blur closes @ menu')

    // 6. "+ -> Reference a chat" bus trigger opens chat reference menu and inserts dsh-session mention.
    team.actions.referenceChat('b1', { start: 0, end: 0 })
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 1)
    all(tree, n => n.props?.className === 'dsb-cmenu-row')[0].props.onClick()
    tree = second.render()
    assert.match(all(tree, n => n.type === 'textarea')[0].props.value, /^@\[Chat with Writer\]\(dsh-session:/)

    // 7. Cmd/Ctrl+Enter sends even when a composer suggestion menu is visible.
    all(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'ping @Wr', selectionStart: 8 } })
    tree = second.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cmenu').length, 1)
    all(tree, n => n.type === 'textarea')[0].props.onKeyDown({
      key: 'Enter', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false,
      nativeEvent: { isComposing: false }, preventDefault() {},
    })
    await tick()
    tree = second.render()
    assert.deepEqual(sentMessages, [['b1', 'ping @Wr']])
  } finally {
    second.unmount()
    storageMap.clear()
    forgetKeptFiles()
  }

  // 8. A late unmounted send failure must NOT overwrite a newer saved draft on the same chat.
  let rejectLateSend
  const lateTeam = {
    ...team,
    actions: {
      ...team.actions,
      send: () => new Promise((_, reject) => { rejectLateSend = reject }),
    },
  }
  const sending = mount(Chat, { sessionId: 'b1', team: lateTeam })
  try {
    let t1 = sending.render()
    all(t1, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'old send', selectionStart: 8 } })
    t1 = sending.render()
    all(t1, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
  } finally {
    sending.unmount()
  }
  const newer = mount(Chat, { sessionId: 'b1', team })
  try {
    let t2 = newer.render()
    all(t2, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'fresh draft', selectionStart: 11 } })
    newer.render()
    rejectLateSend(new Error('network down'))
    await tick()
    await tick()
    assert.equal(JSON.parse(storageMap.get(STORAGE.drafts)).b1.text, 'fresh draft', 'late failed send must not clobber newer draft')
  } finally {
    newer.unmount()
    storageMap.clear()
    forgetKeptFiles()
  }
})
