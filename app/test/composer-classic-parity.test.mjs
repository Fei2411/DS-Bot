import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const deepViewReact = fileURLToPath(import.meta.resolve('deep-view/react'))

// Lightweight stubs matching app/test/chat.test.mjs & composer-menus-and-tails.test.mjs
// while keeping ModelMenu / useAnchoredMenu interactive enough to verify compact classic props.
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
  'model-menu.js': `
    import { createElement as h, useState } from 'react'
    export const ModelChoiceDock = () => null
    export const ModelKeyCard = () => null
    export const ModelMenu = (props) => {
      globalThis.__lastModelMenuProps = props
      return h('button', {
        type: 'button',
        className: props.compact ? 'bt-model-btn dsb-model-compact' : 'bt-model-btn',
        'data-model-menu': '',
        'data-compact': props.compact ? '' : undefined,
        'data-align': props.align,
        'data-ref': props.bot?.model ?? '',
        'data-effort': props.bot?.effort ?? '',
        disabled: props.disabled,
        onClick: () => {
          props.onPick?.('deepseek/deepseek-reasoner')
          props.onPickEffort?.('high')
        },
      }, props.bot?.model ?? 'Model')
    }
    export const Caret = () => h('span', { className: 'bt-caret' })
    export const useAnchoredMenu = () => {
      const [isOpen, setOpen] = useState(false)
      return {
        isOpen,
        shownPlace: isOpen ? { left: 10, bottom: 48, minWidth: 264 } : null,
        leaving: false,
        button: { current: null },
        menu: { current: null },
        open: () => setOpen(true),
        close: () => setOpen(false),
      }
    }
    export const modelOf = () => null
    export const manageModels = () => undefined
  `,
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const FishLogo = ({ size, className }) => ({ type: 'fish-logo', props: { size, className, children: [] } })
    export const MarkdownText = ({ text }) => ({ type: 'markdown', props: { text, children: [text] } })
    export const writeClipboard = async (text) => { globalThis.__copiedText = text; return true }
    export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
    export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
  `,
}

const entryCode = `
  export { Chat, clearFailedSends, pruneFailedSends } from './ui/src/chat.js'
  export { ClassicControls, ClassicPermissionMenu, ClassicPlanChip, classicPresetLabel } from './ui/src/classic-controls.js'
  export { ClassicQuestionDock, ClassicPlanReviewDock, parseRecommendedLabel, extractPlanHeading, stripPlanHeading } from './ui/src/classic-questions.js'
  export { ClassicPlanCard, planStatusOf, registerClassicPlanView } from './ui/src/classic-plan-view.js'
  export { DesktopQueueDock, queueRowText } from './ui/src/queue-dock.js'
  export { FailedSendBar } from './ui/src/failed-send-bar.js'
  export { activeComposerTrigger, applyTriggerText, formatClassicFileMention, buildComposerMenuItems, ComposerMenu } from './ui/src/composer-menus.js'
  export { createSlotRegistry, TOOL_VIEW_SLOT } from './ui/src/slots.js'
  export { forgetKeptFiles } from '../ds-bot/src/client/draft-keep.js'
  export { STORAGE } from '../ds-bot/src/client/storage.js'
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
    name: 'parity-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^deep-view\/react$/ }, () => ({ path: deepViewReact }))
      bundler.onResolve({ filter: /(src\/client\/(cells|widget-cell|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'parity-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|widget-cell|model-menu|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'parity-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'parity-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
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

const storageMap = new Map()
const winListeners = new Map()
const createdUrls = []
const revokedUrls = []
class FakeFile {
  constructor(parts, name, opts = {}) {
    this.parts = parts
    this.name = name
    this.type = opts.type ?? ''
    this.size = parts.reduce((sum, p) => sum + (typeof p === 'string' ? Buffer.byteLength(p) : (p?.byteLength ?? p?.size ?? 0)), 0)
  }
  async arrayBuffer() { return new TextEncoder().encode(this.parts.join('')).buffer }
}

const docListeners = new Map()
const sandbox = {
  console, URL: Object.assign(URL, {
    createObjectURL: (f) => { const u = `blob:test/${createdUrls.length}/${f?.name ?? 'x'}`; createdUrls.push(u); return u },
    revokeObjectURL: (u) => { revokedUrls.push(u) },
  }),
  URLSearchParams, TextEncoder, TextDecoder, AbortController, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => new Promise(() => {}),
  requestAnimationFrame: fn => { fn(); return 1 },
  cancelAnimationFrame: () => {},
  File: FakeFile,
  localStorage: {
    getItem: key => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => { storageMap.set(key, String(value)) },
    removeItem: key => { storageMap.delete(key) },
    clear: () => { storageMap.clear() },
  },
  document: {
    body: { toggleAttribute() {}, removeAttribute() {} },
    documentElement: { dataset: {} },
    activeElement: null,
    querySelector: () => null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn) },
  },
  window: {
    innerWidth: 1280, innerHeight: 800,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn) },
  },
  navigator: {
    platform: 'MacIntel',
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  },
  MediaRecorder: function FakeMediaRecorder() {},
  __testCall: async () => ({}),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => ({ type: 'portal', props: { children: [node] } }) }
    throw new Error(`unexpected require: ${name}`)
  },
  exports: {},
}
sandbox.module = { exports: sandbox.exports }
sandbox.globalThis = sandbox
runInNewContext(outputFiles[0].text, sandbox)
const mod = sandbox.module.exports

function mount(Component, initialProps) {
  const fibers = new Map()
  let lastProps = initialProps
  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}.${idx}`))
    if (typeof node.type === 'function' || node.type?.$$typeof === MEMO_TYPE) {
      const fn = node.type?.$$typeof === MEMO_TYPE ? node.type.type : node.type
      const key = node.props?.key ?? path
      const fpath = `${path}:${fn.name || 'anon'}:${key}`
      const fiber = fibers.get(fpath) ?? { slots: [], index: 0 }
      fibers.set(fpath, fiber)
      fiber.index = 0
      const prev = current.fiber
      current.fiber = fiber
      const rendered = fn.prototype?.isReactComponent ? new fn(node.props).render() : fn(node.props)
      current.fiber = prev
      return expand(rendered, fpath)
    }
    const children = node.props?.children
    return { ...node, props: { ...node.props, children: expand(children, `${path}.c`) } }
  }
  const render = (props = lastProps) => {
    lastProps = props
    current = { fiber: null, effects: [] }
    const tree = expand({ type: Component, props }, 'root')
    const effects = current.effects
    for (const run of effects) run()
    return tree
  }
  const unmount = () => {
    for (const fiber of fibers.values()) {
      for (const cell of fiber.slots) cell?.stop?.()
    }
    fibers.clear()
  }
  return { render, unmount }
}

function all(tree, match, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const item of tree) all(item, match, out); return out }
  if (match(tree)) out.push(tree)
  if (tree.props?.children !== undefined) all(tree.props.children, match, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const plain = value => JSON.parse(JSON.stringify(value))

function makeTeam({ roster = {}, queues = {}, userQuestions = [], running = false, actions = {} } = {}) {
  const fullRoster = {
    ready: true,
    readOnly: null,
    prefs: { enterToSend: true },
    byId: {
      b1: { id: 'b1', name: 'Chief', sessionId: 'b1' },
      b2: { id: 'b2', name: 'Writer', sessionId: 'b2' },
    },
    roomsById: {},
    agentOf: { 'classic-1': 'a1', 'classic-2': 'a1' },
    agents: [{ id: 'a1', name: 'Agent', sessions: ['classic-1', 'classic-2'] }],
    models: [
      { ref: 'deepseek/deepseek-reasoner', provider: 'deepseek', name: 'Reasoner' },
    ],
    catalog: {
      providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-reasoner', name: 'Reasoner' }] }],
      voice: { stt: { ready: true }, tts: { ready: true } },
    },
    questions: {},
    ...roster,
  }
  const feedListeners = new Set()
  const baseActions = {
    noteSent() {},
    noteLive() {},
    send: async () => {},
    sessionControls: async () => ({
      sessionId: 'classic-1',
      model: { ref: 'deepseek/deepseek-reasoner', effort: 'medium', reasoning: { effort: ['low', 'medium', 'high'] } },
      permission: {
        current: 'workspace-write',
        defaultPreset: 'workspace-write',
        options: [
          { value: 'read-only', name: 'Read only', description: 'Inspect only' },
          { value: 'workspace-write', name: 'Workspace', description: 'Edit workspace' },
          { value: 'danger-full-access', name: 'Full access', description: 'No approval prompts' },
          { value: 'auto', name: 'Auto review', description: 'Session-only model review' },
        ],
      },
      plan: { active: true, pending: false, available: true },
      queue: [],
      questions: [],
    }),
    sessionCommands: async () => ({
      commands: [
        { name: 'plan', description: 'Plan before making changes', input: { hint: 'on | off' } },
        { name: 'compact', description: 'Compact conversation' },
        { name: 'feedback', description: 'Send feedback' },
      ],
    }),
    sessionSkills: async () => ({
      skills: [{ name: 'code-review', description: 'Review diff' }],
    }),
    sessionFiles: async (_sid, query) => ({
      files: [
        { path: 'README.md', kind: 'file' },
        { path: 'src', kind: 'directory' },
        { path: 'src/app.js', kind: 'file' },
        { path: 'docs/my notes.md', kind: 'file' },
      ].filter(f => !query || f.path.toLowerCase().includes(query.toLowerCase())),
    }),
    runSessionCommand: async () => ({ matched: true, result: { kind: 'success', text: 'Done' } }),
    selectSessionModel: async () => ({}),
    setSessionPermission: async () => ({}),
    answerUserQuestion: async () => ({ accepted: true }),
    dismissUserQuestion: async () => ({ accepted: true }),
    updateSessionQueue: async () => ({ accepted: true }),
    steerSessionQueue: async () => ({ accepted: true, steered: 1 }),
    openFiles() {},
    openShortcuts() {},
    canOpenTerminal: () => true,
    newTerminal() {},
    speech: () => ({}),
    hasPluginMic: () => false,
    canReferenceChat: () => false,
    ...actions,
  }
  return {
    roster: fullRoster,
    queues,
    userQuestions,
    actions: baseActions,
    feed: {
      on(fn) { feedListeners.add(fn); return () => feedListeners.delete(fn) },
      emit(event, data) { for (const fn of feedListeners) fn(event, data) },
    },
    hooks: {
      useRoster: pick => pick(fullRoster),
      useUi: pick => pick({}),
      useSessions: pick => pick({ list: [], byId: {} }),
      useSessionStatus: pick => pick(new Map([['classic-1', { running }], ['b1', { running }]])),
      useSessionQueues: pick => pick(queues),
      useUserQuestions: pick => pick(userQuestions),
      useRescuedDrafts: pick => pick({}),
      useWork: pick => pick({}),
      useTurnClock: pick => pick({}),
      useCards: pick => pick({}),
      useHeldCards: pick => pick({}),
      useComputer: pick => pick({}),
      useBrowserHolds: pick => pick({}),
      useBrowserTabs: pick => pick({}),
      useBrowserPages: pick => pick({}),
    },
  }
}

test('Classic composer renders compact ModelMenu, PermissionMenu with risk confirm, PlanChip, and dictation-only Voice button', async () => {
  storageMap.clear()
  mod.forgetKeptFiles()
  mod.clearFailedSends()
  const permCalls = []
  const cmdCalls = []
  const modelCalls = []
  const team = makeTeam({
    actions: {
      selectSessionModel: async (sid, ref, effort) => { modelCalls.push({ sid, ref, effort }); return null },
      setSessionPermission: async (sid, preset) => { permCalls.push({ sid, preset }); return null },
      runSessionCommand: async (sid, line) => { cmdCalls.push({ sid, line }); return { matched: true } },
    },
  })

  const inst = mount(mod.Chat, { sessionId: 'classic-1', team })
  try {
    let tree = inst.render()
    await tick()
    tree = inst.render()

    // 1. Compact ModelMenu receives session ref/effort, merged reasoning on `roster.models`, and EffortBar reset/rollback contract.
    const modelBtn = all(tree, n => n.props?.['data-model-menu'] === '')[0]
    assert.ok(modelBtn, 'Classic composer renders ModelMenu')
    assert.equal(modelBtn.props['data-compact'], '')
    assert.equal(modelBtn.props['data-align'], 'left')
    assert.equal(modelBtn.props['data-ref'], 'deepseek/deepseek-reasoner')
    assert.equal(modelBtn.props['data-effort'], 'medium')
    const mergedEntry = sandbox.__lastModelMenuProps.roster.models.find(m => m.ref === 'deepseek/deepseek-reasoner')
    assert.deepEqual(plain(mergedEntry?.reasoning), { effort: ['low', 'medium', 'high'] }, 'session reasoning merges into roster.models')

    // Resetting thinking effort passes `undefined` from EffortBar -> wire `effort: null` and resolves `true`.
    const resetOk = await sandbox.__lastModelMenuProps.onPickEffort(undefined)
    assert.equal(resetOk, true, 'successful onPickEffort resolves true for EffortBar')
    assert.deepEqual(plain(modelCalls.at(-1)), { sid: 'classic-1', ref: 'deepseek/deepseek-reasoner', effort: null })

    // Failed selectSessionModel resolves `false` so EffortBar rolls back the slider knob.
    const prevSelect = team.actions.selectSessionModel
    team.actions.selectSessionModel = async () => { throw new Error('rejected') }
    const failedOk = await sandbox.__lastModelMenuProps.onPickEffort('low')
    assert.equal(failedOk, false, 'failed onPickEffort resolves false so EffortBar rolls back')
    team.actions.selectSessionModel = prevSelect

    modelCalls.length = 0
    modelBtn.props.onClick()
    await tick()
    assert.deepEqual(plain(modelCalls), [
      { sid: 'classic-1', ref: 'deepseek/deepseek-reasoner' },
      { sid: 'classic-1', ref: 'deepseek/deepseek-reasoner', effort: 'high' },
    ])

    // 2. Voice mic button is present in Classic composer, while Bot-only voice-chat button is hidden.
    assert.equal(all(tree, n => n.type === 'button' && n.props?.className === 'bt-mic').length, 1, 'Classic has dictation mic')
    assert.equal(all(tree, n => n.type === 'button' && n.props?.className === 'bt-voice').length, 0, 'Classic hides Bot voice-chat button')

    // 3. Plan chip shows active plan mode and exits via `/plan off`.
    const planExit = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-plan-chip-x')[0]
    assert.ok(planExit, 'Plan mode chip shows exit button')
    planExit.props.onClick()
    await tick()
    assert.deepEqual(cmdCalls, [{ sid: 'classic-1', line: '/plan off' }])

    // 4. Permission menu switches safe preset immediately and opens RiskConfirmDialog for `danger-full-access`.
    const permTrigger = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-perm-btn'))[0]
    assert.ok(permTrigger)
    permTrigger.props.onClick()
    tree = inst.render()
    const rows = all(tree, n => n.type === 'button' && n.props?.role === 'menuitemradio')
    assert.equal(rows.length, 4, 'all 4 presets including session-only auto appear')

    // Pick safe preset: read-only
    rows[0].props.onClick()
    await tick()
    assert.deepEqual(permCalls, [{ sid: 'classic-1', preset: 'read-only' }])

    // Reopen and pick risky preset: danger-full-access -> requires risk confirmation checkbox
    tree = inst.render()
    all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-perm-btn'))[0].props.onClick()
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.role === 'menuitemradio')[2].props.onClick()
    tree = inst.render()
    const dialog = all(tree, n => n.props?.role === 'dialog' && n.props?.['aria-modal'] === 'true')[0]
    assert.ok(dialog, 'RiskConfirmDialog opens for danger-full-access')
    const confirmBtnBefore = all(dialog, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-q-submit'))[0]
    assert.equal(confirmBtnBefore.props.disabled, true, 'confirm button stays disabled before ack checkbox')
    const checkbox = all(dialog, n => n.type === 'input' && n.props?.type === 'checkbox')[0]
    checkbox.props.onChange({ target: { checked: true } })
    tree = inst.render()
    const confirmBtnAfter = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-q-submit'))[0]
    assert.equal(confirmBtnAfter.props.disabled, false)
    confirmBtnAfter.props.onClick()
    await tick()
    assert.deepEqual(permCalls.at(-1), { sid: 'classic-1', preset: 'danger-full-access' })
  } finally {
    inst.unmount()
  }
})

test('Classic / menu loads commands lazily, toggles /plan off when active, avoids redundant subtitles, quotes mid-path @ mentions, and preserves drafts during commands', async () => {
  storageMap.clear()
  mod.forgetKeptFiles()
  mod.clearFailedSends()
  assert.equal(mod.classicPresetLabel('custom'), 'Custom')
  assert.equal(mod.formatClassicFileMention({ path: 'src/app.js', kind: 'file' }), '@src/app.js')
  assert.equal(mod.formatClassicFileMention({ path: 'docs/my notes.md', kind: 'file' }), '@"docs/my notes.md"')
  assert.equal(mod.formatClassicFileMention({ path: 'src', kind: 'directory' }), '@src/')

  // Mid-path editing inside an existing quoted `@"..."` mention replaces through the closing quote without crossing newlines, a second mention, or deleting prose before later balanced quotes.
  const midQuoted = mod.activeComposerTrigger('see @"docs/my notes.md" please', 14, { fileMentions: true })
  assert.deepEqual(plain(midQuoted), { kind: 'mention', start: 4, end: 23, query: 'docs/my ', quoted: true })
  assert.equal(mod.applyTriggerText('see @"docs/my notes.md" please', midQuoted, '@"docs/other file.md"').text, 'see @"docs/other file.md" please')
  const midQuotedWithLaterQuotes = mod.activeComposerTrigger('see @"docs/my notes.md" and say "hi"', 14, { fileMentions: true })
  assert.equal(midQuotedWithLaterQuotes.end, 23, 'closed @"..." mention still replaces through its own closing quote when later balanced quotes exist')
  const unclosedBeforeProseQuotes = mod.activeComposerTrigger('Read @"REA and explain "hello"', 10, { fileMentions: true })
  assert.equal(unclosedBeforeProseQuotes.end, 10, 'unclosed @"..." does not swallow prose up to a later balanced quote')
  assert.equal(
    mod.applyTriggerText('Read @"REA and explain "hello"', unclosedBeforeProseQuotes, '@README.md').text,
    'Read @README.md and explain "hello"',
  )
  const twoQuoted = mod.activeComposerTrigger('a @"one.md and @"two.md"', 8, { fileMentions: true })
  assert.equal(twoQuoted.end, 8, 'unclosed quote does not swallow a later @"..." mention')

  const sent = []
  const ranCmds = []
  const cmdCatalogCalls = []
  const notices = []
  const team = makeTeam({
    actions: {
      send: async (_sid, text) => { sent.push(text) },
      notice: text => { notices.push(text) },
      sessionCommands: async (sid, opts) => {
        cmdCatalogCalls.push({ sid, opts })
        return {
          commands: [
            { name: 'plan', description: 'Plan before making changes', input: { hint: 'on | off' } },
            { name: 'compact', description: 'Compact conversation' },
            { name: 'feedback', description: 'Send feedback' },
          ],
        }
      },
      stageFile: async (name) => ({ id: `staged-${name}` }),
      runSessionCommand: async (_sid, line, extra) => {
        ranCmds.push({ line, extra })
        if (line === '/compact') return { matched: true, result: { kind: 'success', text: 'Compacted' } }
        return { matched: true, result: { kind: 'success', text: 'Plan mode off.' }, controls: { plan: { active: false, pending: false, available: true } } }
      },
    },
  })
  const inst = mount(mod.Chat, { sessionId: 'classic-1', team })
  try {
    let tree = inst.render()
    await tick()
    tree = inst.render()

    // Browsing a Classic session does NOT eagerly load sessionCommands (avoids waking cold Agents).
    assert.equal(cmdCatalogCalls.length, 0, 'sessionCommands is not called on mount')

    const ta = () => all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0]
    // Type `/` to open the Classic slash menu (triggers lazy load with wake: true).
    ta().props.onChange({ target: { value: '/', selectionStart: 1 } })
    tree = inst.render()
    await tick()
    tree = inst.render()

    assert.equal(cmdCatalogCalls.length, 1)
    assert.deepEqual(plain(cmdCatalogCalls[0]), { sid: 'classic-1', opts: { wake: true } })

    const sections = all(tree, n => n.props?.className === 'dsb-cmenu-sec').map(textOf)
    assert.ok(sections.includes('Commands'), 'Commands section present')
    assert.ok(sections.includes('Skills'), 'Skills section present')
    assert.ok(sections.includes('Files'), 'Files section present')

    // Because plan.active === true in makeTeam, the `/plan` entry offers `Exit plan mode` (`/plan off`),
    // and redundant subtitles (like `/feedback` or root `README.md`) are omitted.
    const builtActive = mod.buildComposerMenuItems({
      mode: 'command',
      query: '',
      roster: team.roster,
      sessions: { list: [], byId: {} },
      sessionId: 'classic-1',
      actions: team.actions,
      classicCatalog: {
        planActive: true,
        commands: [
          { name: 'plan', description: 'Plan before making changes' },
          { name: 'feedback', description: 'Send feedback' },
        ],
        skills: [{ name: 'code-review', description: 'code-review' }],
        files: [{ path: 'README.md', kind: 'file' }, { path: 'docs/my notes.md', kind: 'file' }],
      },
      onRunCommand: line => { ranCmds.push({ line, extra: undefined }) },
    })
    const planItemActive = builtActive.find(item => item.key.endsWith(':plan'))
    assert.equal(planItemActive.title, 'Exit plan mode')
    assert.equal(planItemActive.code, '/plan off')
    const builtInactive = mod.buildComposerMenuItems({
      mode: 'command',
      query: '',
      roster: team.roster,
      sessions: { list: [], byId: {} },
      sessionId: 'classic-1',
      actions: team.actions,
      classicCatalog: { planActive: false, commands: [{ name: 'plan', description: 'Plan' }], skills: [], files: [] },
      onRunCommand: () => {},
    })
    assert.equal(builtInactive.find(item => item.key.endsWith(':plan')).title, 'Enter plan mode')
    assert.equal(builtInactive.find(item => item.key.endsWith(':plan')).code, '/plan')
    assert.equal(builtActive.find(item => item.key.endsWith(':feedback')).subtitle, '', 'duplicate subtitle omitted')
    assert.equal(builtActive.find(item => item.key === 'file:file:README.md').subtitle, '', 'root file duplicate subtitle omitted')
    assert.equal(builtActive.find(item => item.key === 'skill:code-review').subtitle, '', 'skill duplicate subtitle omitted')

    // Submitting `/plan` invokes `runSessionCommand` and NOT `actions.send` or `actions.notice`.
    ta().props.onChange({ target: { value: '/plan', selectionStart: 5 } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    tree = inst.render()
    assert.equal(ranCmds[0].line, '/plan')
    assert.equal(sent.length, 0)
    assert.equal(notices.length, 0, 'plan toggle does not trigger red ErrorToast via actions.notice')

    // Submitting `/compact` with an attached file forwards staged file IDs to runSessionCommand,
    // and typing a new draft while the command runs is NOT erased when it finishes.
    let resolveDelayedCmd
    team.actions.runSessionCommand = async (_sid, line, extra) => {
      ranCmds.push({ line, extra })
      return await new Promise((resolve) => { resolveDelayedCmd = resolve })
    }
    const fileInput = all(tree, n => n.type === 'input' && n.props?.type === 'file')[0]
    fileInput.props.onChange({ target: { files: [new FakeFile(['hello'], 'notes.txt', { type: 'text/plain' })], value: 'x' } })
    tree = inst.render()
    ta().props.onChange({ target: { value: '/compact', selectionStart: 8 } })
    tree = inst.render()
    const beforeDoubleSubmit = ranCmds.length
    const sendBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0]
    sendBtn.props.onClick()
    sendBtn.props.onClick()
    await tick()
    assert.equal(ranCmds.length, beforeDoubleSubmit + 1, 'double-submitting an in-flight Classic slash command only runs it once')
    // User types new draft while `/compact` is still executing:
    ta().props.onChange({ target: { value: 'fresh draft typed mid-command', selectionStart: 29 } })
    tree = inst.render()
    resolveDelayedCmd({ matched: true, result: { kind: 'success', text: 'Compacted' } })
    await tick()
    await tick()
    tree = inst.render()
    assert.deepEqual(plain(ranCmds.at(-1)), { line: '/compact', extra: { images: [], files: ['staged-notes.txt'] } })
    assert.equal(ta().props.value, 'fresh draft typed mid-command', 'command completion never erases newer user draft')
    const statusBar = all(tree, n => n.props?.className === 'dsb-composer-notice')[0]
    assert.ok(statusBar && textOf(statusBar).includes('Compacted'))
    all(statusBar, n => n.type === 'button' && n.props?.className === 'dsb-composer-notice-x')[0].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-composer-notice').length, 0)

    // Submitting `/code-review check this` (a skill, not a host command) falls through to `actions.send`.
    ta().props.onChange({ target: { value: '/code-review check this', selectionStart: 23 } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    assert.deepEqual(sent, ['/code-review check this'])

    // Typing `@notes` triggers workspace file mention and inserts quoted path.
    tree = inst.render()
    ta().props.onChange({ target: { value: 'see @notes', selectionStart: 10 } })
    tree = inst.render()
    await tick()
    tree = inst.render()
    const menuOptions = all(tree, n => n.type === 'button' && n.props?.role === 'option')
    assert.equal(menuOptions.length, 1)
    assert.ok(textOf(menuOptions[0]).includes('my notes.md') && textOf(menuOptions[0]).includes('docs'))
    menuOptions[0].props.onClick()
    tree = inst.render()
    assert.equal(ta().props.value, 'see @"docs/my notes.md" ')
  } finally {
    inst.unmount()
  }

  // Submitting `/compact` immediately on a fresh session BEFORE `/` menu ever opened still loads commands and executes!
  const freshCmds = []
  const freshSent = []
  const freshTeam = makeTeam({
    actions: {
      send: async (_sid, text) => { freshSent.push(text) },
      runSessionCommand: async (_sid, line) => { freshCmds.push(line); return { matched: true, result: { kind: 'success', text: 'OK' } } },
    },
  })
  const inst2 = mount(mod.Chat, { sessionId: 'classic-2', team: freshTeam })
  try {
    let tree2 = inst2.render()
    const ta2 = () => all(tree2, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0]
    ta2().props.onChange({ target: { value: '/compact', selectionStart: 8 } })
    tree2 = inst2.render()
    all(tree2, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    await tick()
    assert.deepEqual(freshCmds, ['/compact'])
    assert.equal(freshSent.length, 0)
  } finally {
    inst2.unmount()
  }
})

test('Classic drafts persist across switching Classic sessions and switching Classic <-> Bot mode', async () => {
  storageMap.clear()
  mod.forgetKeptFiles()
  mod.clearFailedSends()
  const team = makeTeam()
  const inst = mount(mod.Chat, { sessionId: 'classic-1', team })
  try {
    let tree = inst.render()
    const ta = () => all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0]
    ta().props.onChange({ target: { value: 'classic one draft', selectionStart: 17 } })
    tree = inst.render()

    // Switch to classic-2 and write a separate draft.
    inst.render({ sessionId: 'classic-2', team })
    tree = inst.render({ sessionId: 'classic-2', team })
    assert.equal(ta().props.value, '')
    ta().props.onChange({ target: { value: 'classic two draft', selectionStart: 17 } })
    tree = inst.render({ sessionId: 'classic-2', team })

    // Switch to Bot chat b1 and write a Bot draft.
    inst.render({ sessionId: 'b1', team })
    tree = inst.render({ sessionId: 'b1', team })
    assert.equal(ta().props.value, '')
    ta().props.onChange({ target: { value: 'bot draft', selectionStart: 9 } })
    tree = inst.render({ sessionId: 'b1', team })

    // Switch back to classic-1 -> original draft restored!
    inst.render({ sessionId: 'classic-1', team })
    tree = inst.render({ sessionId: 'classic-1', team })
    assert.equal(ta().props.value, 'classic one draft')

    // Switch back to classic-2 -> second draft restored!
    inst.render({ sessionId: 'classic-2', team })
    tree = inst.render({ sessionId: 'classic-2', team })
    assert.equal(ta().props.value, 'classic two draft')
  } finally {
    inst.unmount()
  }
})

test('ClassicQuestionDock handles multi-question batches, Recommended badges, multiSelect, free text, skip, minimize, and dismiss', async () => {
  assert.deepEqual(plain(mod.parseRecommendedLabel('SQLite (Recommended)')), { label: 'SQLite', recommended: true })
  assert.deepEqual(plain(mod.parseRecommendedLabel('方案一（推荐）')), { label: '方案一', recommended: true })
  assert.deepEqual(plain(mod.parseRecommendedLabel('Plain')), { label: 'Plain', recommended: false })

  const submitted = []
  const dismissed = []
  const entry = {
    id: 'req-1',
    sessionId: 'classic-1',
    kind: 'question',
    mode: 'blocking',
    questions: [
      {
        id: 'q1',
        header: 'Storage',
        question: 'Pick engines',
        multiSelect: true,
        options: [
          { label: 'SQLite (Recommended)', description: 'Zero setup' },
          { label: 'Postgres' },
        ],
      },
      {
        id: 'q2',
        question: 'Any migration notes?',
      },
    ],
  }
  const team = makeTeam({
    userQuestions: [entry],
    actions: {
      answerUserQuestion: async (sid, reqId, answers) => { submitted.push({ sid, reqId, answers }); return { accepted: true } },
      dismissUserQuestion: async (sid, reqId) => { dismissed.push({ sid, reqId }); return { accepted: true } },
    },
  })

  const inst = mount(mod.ClassicQuestionDock, {
    sessionId: 'classic-1',
    useUserQuestions: team.hooks.useUserQuestions,
    useRoster: team.hooks.useRoster,
    actions: team.actions,
  })
  try {
    let tree = inst.render()
    // Badge strips "(Recommended)" from display while keeping raw label for submission.
    assert.equal(all(tree, n => n.props?.className === 'dsb-cq-rec').length, 1)
    const opts = all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')
    assert.equal(opts.length, 2)
    opts[0].props.onClick()
    opts[1].props.onClick()
    tree = inst.render()

    // Minimize & Expand preserves selections.
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Minimize')[0].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => n.props?.className === 'bt-q bt-q-raised dsb-cq-mini').length, 1)
    all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-cq-mini-btn'))[0].props.onClick()
    tree = inst.render()

    // Move to Question 2 and skip it -> submits both answers (raw label preserved + skipped `{ id: 'q2', selected: [] }`).
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Next question')[0].props.onClick()
    tree = inst.render()
    const skipBtn = all(tree, n => n.type === 'button' && textOf(n) === 'Skip')[0]
    skipBtn.props.onClick()
    await tick()
    assert.deepEqual(plain(submitted), [{
      sid: 'classic-1',
      reqId: 'req-1',
      answers: [
        { id: 'q1', selected: ['SQLite (Recommended)', 'Postgres'] },
        { id: 'q2', selected: [] },
      ],
    }])

    // Dismiss button invokes dismissUserQuestion on a fresh entry.
    team.userQuestions[0] = { ...entry, id: 'req-2' }
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Dismiss question')[0].props.onClick()
    await tick()
    assert.deepEqual(dismissed, [{ sid: 'classic-1', reqId: 'req-2' }])

    // Blocking -> continued transition with same callId preserves in-progress choices & custom text, and hides Dismiss!
    team.userQuestions[0] = {
      ...entry,
      id: 'req-timed',
      callId: 'call-42',
      mode: 'blocking',
      timed: true,
      deadlineAt: Date.now() + 25_000,
    }
    tree = inst.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-cq-timer').length, 1, 'timed question renders countdown badge')
    all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')[0].props.onClick()
    all(tree, n => n.type === 'textarea' && n.props?.className === 'bt-q-input')[0].props.onChange({ target: { value: 'in progress note' } })
    tree = inst.render()
    team.userQuestions[0] = { ...entry, id: 'continued:call-42', callId: 'call-42', mode: 'continued' }
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Dismiss question').length, 0, 'continued question hides Dismiss')
    assert.equal(all(tree, n => n.type === 'textarea' && n.props?.className === 'bt-q-input')[0].props.value, 'in progress note', 'draft text survives blocking -> continued transition')
    assert.equal(all(tree, n => n.type === 'button' && n.props?.className === 'bt-q-opt')[0].props['aria-pressed'], true, 'selected option survives blocking -> continued transition')
  } finally {
    inst.unmount()
  }
})

test('ClassicPlanReviewDock approves, requests changes with feedback, uses real DSH exit_plan_mode outcomes, strips duplicate H1, and hides Dismiss on continued', async () => {
  const answers = []
  const planEntry = {
    id: 'plan-1',
    callId: 'plan-call-1',
    sessionId: 'classic-1',
    kind: 'plan-review',
    mode: 'blocking',
    questions: [{
      id: 'plan-review',
      question: 'Review plan',
      detail: '# Ship Classic Composer\n\n1. Add controls\n2. Verify tests',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  }
  const team = makeTeam({
    userQuestions: [planEntry],
    actions: {
      answerUserQuestion: async (sid, id, payload) => { answers.push({ sid, id, payload }); return { accepted: true } },
    },
  })

  const inst = mount(mod.ClassicPlanReviewDock, {
    sessionId: 'classic-1',
    useUserQuestions: team.hooks.useUserQuestions,
    useRoster: team.hooks.useRoster,
    actions: team.actions,
  })
  try {
    let tree = inst.render()
    assert.ok(textOf(tree).includes('Ship Classic Composer'))
    // Body markdown strips the duplicated leading H1 title.
    const mdNode = all(tree, n => n.type === 'markdown')[0]
    assert.ok(mdNode && !mdNode.props.text.startsWith('# Ship Classic Composer'), 'PlanReviewDock strips duplicate H1')

    // Ask for changes -> Escape via window (shared useEscape stack) closes feedback editor cleanly.
    all(tree, n => n.type === 'button' && textOf(n) === 'Ask for changes')[0].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'textarea' && n.props?.className === 'dsb-plan-feedback-input').length, 1)
    for (const fn of winListeners.get('keydown') ?? []) fn({ key: 'Escape', defaultPrevented: false, isComposing: false })
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'textarea' && n.props?.className === 'dsb-plan-feedback-input').length, 0, 'useEscape closes feedback editor')

    // Reopen Ask for changes -> type feedback -> send feedback.
    all(tree, n => n.type === 'button' && textOf(n) === 'Ask for changes')[0].props.onClick()
    tree = inst.render()
    const fb = all(tree, n => n.type === 'textarea' && n.props?.className === 'dsb-plan-feedback-input')[0]
    fb.props.onChange({ target: { value: 'Also cover narrow widths' } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && textOf(n) === 'Send feedback')[0].props.onClick()
    await tick()
    assert.deepEqual(plain(answers[0]), {
      sid: 'classic-1',
      id: 'plan-1',
      payload: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Also cover narrow widths' }],
    })

    // Continued plan review hides Dismiss button.
    team.userQuestions[0] = { ...planEntry, id: 'continued:plan-call-2', callId: 'plan-call-2', mode: 'continued' }
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Dismiss').length, 0, 'continued plan review hides Dismiss')

    // Approve directly.
    all(tree, n => n.type === 'button' && textOf(n) === 'Approve')[0].props.onClick()
    await tick()
    assert.deepEqual(plain(answers[1]), {
      sid: 'classic-1',
      id: 'continued:plan-call-2',
      payload: [{ id: 'plan-review', selected: ['Approve'] }],
    })
  } finally {
    inst.unmount()
  }

  // Register and verify transcript Plan Card against all 6 recorded real `@deepseek-ai/dsh-plan-mode` outcomes.
  const registry = mod.createSlotRegistry()
  mod.registerClassicPlanView(registry)
  const resolved = registry.resolve(mod.TOOL_VIEW_SLOT, 'exit_plan_mode')
  assert.equal(resolved.length, 1)
  assert.deepEqual(plain(mod.planStatusOf({ phase: 'start' })), { tone: 'pending', label: 'Pending review' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: false,
    content: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
  })), { tone: 'ok', label: 'Approved' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: false,
    content: [{ type: 'text', text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.' }],
  })), { tone: 'muted', label: 'Dismissed' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: true,
    content: [{ type: 'text', text: 'The user chose to keep planning; their feedback: Add error handling' }],
  })), { tone: 'warn', label: 'Changes requested' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: true,
    content: [{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: Add error handling' }],
  })), { tone: 'warn', label: 'Changes requested' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: true,
    content: [{ type: 'text', text: 'The user chose to keep planning; revise the plan and present it again.' }],
  })), { tone: 'warn', label: 'Changes requested' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: true,
    error: { code: 'ASK_ABORTED' },
    content: [{ type: 'text', text: 'ask_user_question was aborted before the user answered' }],
  })), { tone: 'muted', label: 'Interrupted' })
  assert.deepEqual(plain(mod.planStatusOf({
    phase: 'done',
    isError: true,
    content: [{ type: 'text', text: 'exit_plan_mode is only available in plan mode' }],
  })), { tone: 'error', label: 'Error' })

  const cardInst = mount(mod.ClassicPlanCard, {
    block: {
      phase: 'done',
      isError: false,
      args: { text: () => '# Rollout Plan\n\n- Step 1' },
      content: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
    },
  })
  try {
    const cardTree = cardInst.render()
    assert.ok(textOf(cardTree).includes('Rollout Plan'))
    assert.ok(textOf(cardTree).includes('Approved'))
    const mdNode = all(cardTree, n => n.type === 'markdown')[0]
    assert.ok(mdNode && !mdNode.props.text.startsWith('# Rollout Plan'), 'ClassicPlanCard strips duplicate H1')
    const toolLabels = all(cardTree, n => n.type === 'button' && n.props?.className === 'dsb-plan-card-tool').map(b => b.props['aria-label'])
    assert.deepEqual(toolLabels, ['Copy plan', 'Collapse plan'], 'PlanCard tool buttons follow unified [Copy] [Collapse] order')
  } finally {
    cardInst.unmount()
  }
})

test('DesktopQueueDock uses shared presenter defaults, supports cross-chat Withdraw, inline Edit Escape via useEscape, Enter-to-steer placeholder/guard, and pending queued rows', async () => {
  storageMap.clear()
  mod.forgetKeptFiles()
  mod.clearFailedSends()

  const queueCalls = []
  const steerAllCalls = []
  let resolveSteer
  let resolveSlowRemove
  let slowRemoveMode = false
  const team = makeTeam({
    running: true,
    queues: {
      b1: [
        { id: 'q1', content: [{ type: 'text', text: 'queued first' }], source: { kind: 'user' } },
        { id: 'q2', content: [{ type: 'text', text: 'queued second' }], source: { kind: 'user' } },
      ],
    },
    actions: {
      send: async () => new Promise(() => {}),
      updateSessionQueue: async (sid, itemId, action) => {
        queueCalls.push({ sid, itemId, action })
        if (slowRemoveMode) return await new Promise((resolve) => { resolveSlowRemove = resolve })
        return { accepted: true }
      },
      steerSessionQueue: async (sid, ids) => {
        steerAllCalls.push({ sid, ids })
        return await new Promise((resolve) => { resolveSteer = () => resolve({ accepted: true, steered: ids.length }) })
      },
    },
  })

  const inst = mount(mod.Chat, { sessionId: 'b1', team })
  try {
    let tree = inst.render()
    // 2 items start collapsed by default (matching DSH plugin QueueDockPresenter).
    const head = all(tree, n => n.type === 'button' && n.props?.className === 'bt-queue-head')[0]
    assert.ok(head)
    assert.equal(head.props['aria-expanded'], false, '2+ queued rows default to collapsed')
    assert.ok(textOf(head).includes('2 queued messages'))

    // Empty composer while running with queued items displays the Enter-to-steer cue and guards double-Enter.
    const ta = () => all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0]
    assert.equal(ta().props.placeholder, 'Press Enter to steer queued messages')
    ta().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    ta().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    assert.equal(steerAllCalls.length, 1, 'rapid double-Enter does not double-fire steerSessionQueue')
    resolveSteer()
    await tick()
    assert.deepEqual(plain(steerAllCalls), [{ sid: 'b1', ids: ['q1', 'q2'] }])

    // Expand the collapsible queue header to access row actions.
    head.props.onClick()
    tree = inst.render()

    // Start typing in composer, then click Withdraw on q1 -> merges withdrawn text without clobbering typed draft.
    ta().props.onChange({ target: { value: 'already typing', selectionStart: 14 } })
    tree = inst.render()
    const withdrawBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Withdraw to input')[0]
    withdrawBtn.props.onClick()
    await tick()
    tree = inst.render()
    assert.deepEqual(plain(queueCalls[0]), { sid: 'b1', itemId: 'q1', action: { kind: 'remove' } })
    assert.ok(ta().props.value.includes('already typing') && ta().props.value.includes('queued first'))

    // Inline Edit on q2 cancels via window Escape (shared useEscape stack) and saves via Save button.
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Edit queued message')[1].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'textarea' && n.props?.className === 'bt-queue-edit').length, 1)
    for (const fn of winListeners.get('keydown') ?? []) fn({ key: 'Escape', defaultPrevented: false, isComposing: false })
    tree = inst.render()
    assert.equal(all(tree, n => n.type === 'textarea' && n.props?.className === 'bt-queue-edit').length, 0, 'useEscape cancels inline queue edit')

    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Edit queued message')[1].props.onClick()
    tree = inst.render()
    const editArea = all(tree, n => n.type === 'textarea' && n.props?.className === 'bt-queue-edit')[0]
    editArea.props.onChange({ target: { value: 'queued second edited' } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Save queued message')[0].props.onClick()
    await tick()
    assert.deepEqual(plain(queueCalls[1]), { sid: 'b1', itemId: 'q2', action: { kind: 'edit', text: 'queued second edited' } })

    // Unified steer button label (`Steer queued message`).
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Steer queued message')[1].props.onClick()
    await tick()
    assert.deepEqual(plain(queueCalls[2]), { sid: 'b1', itemId: 'q2', action: { kind: 'steer' } })

    // Sending while running places optimistic row inside DesktopQueueDock (`Sending…`) rather than PendingUserRows!
    ta().props.onChange({ target: { value: 'third queued in flight', selectionStart: 22 } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-pending').length, 0, 'running send does not flash in transcript PendingUserRows')
    assert.equal(all(tree, n => String(n.props?.className ?? '').includes('bt-queue-pending')).length, 1, 'running send renders as pending row inside QueueDock')

    // Sending a second identical message (`queued second`) while `q2` (`queued second`) is ALREADY in `queues`
    // must keep the second `Sending…` pending row across unrelated queue updates until a brand-new row ID arrives!
    ta().props.onChange({ target: { value: 'queued second', selectionStart: 13 } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    tree = inst.render()
    assert.equal(all(tree, n => String(n.props?.className ?? '').includes('bt-queue-pending')).length, 2)
    // Simulate an unrelated queue list update (new array reference with existing `q2` plus an unrelated row `q-other`).
    team.queues.b1 = [
      ...team.queues.b1,
      { id: 'q-other', content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' } },
    ]
    inst.render()
    tree = inst.render()
    assert.equal(
      all(tree, n => String(n.props?.className ?? '').includes('bt-queue-pending')).length,
      2,
      'already-seen queued row q2 must not prematurely clear the second identical pending send',
    )
    // Once the second identical message lands with its own new ID (`q-dup-2`), its pending row clears cleanly!
    team.queues.b1 = [
      ...team.queues.b1,
      { id: 'q-dup-2', content: [{ type: 'text', text: 'queued second' }], source: { kind: 'user' } },
    ]
    inst.render()
    tree = inst.render()
    assert.equal(
      all(tree, n => String(n.props?.className ?? '').includes('bt-queue-pending')).length,
      1,
      'new row ID clears the matching pending send once it actually lands in the queue',
    )

    // Withdraw across chat switches: click Withdraw on b1, switch to b2 before remove resolves -> lands in b1's saved draft, NOT b2!
    slowRemoveMode = true
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Withdraw to input')[1].props.onClick()
    inst.render({ sessionId: 'b2', team })
    tree = inst.render({ sessionId: 'b2', team })
    ta().props.onChange({ target: { value: 'b2 own draft', selectionStart: 12 } })
    tree = inst.render({ sessionId: 'b2', team })
    resolveSlowRemove({ accepted: true })
    await tick()
    tree = inst.render({ sessionId: 'b2', team })
    assert.equal(ta().props.value, 'b2 own draft', 'b2 composer is untouched by b1 withdrawal')
    inst.render({ sessionId: 'b1', team })
    tree = inst.render({ sessionId: 'b1', team })
    assert.ok(ta().props.value.includes('queued second'), 'withdrawn text merged into originating b1 draft')
  } finally {
    inst.unmount()
  }
})

test('Failed send protects in-flight image URLs across unmount, re-keys restored attachments, enforces batch budget, and prunes on deletion', async () => {
  storageMap.clear()
  mod.forgetKeptFiles()
  mod.clearFailedSends()
  createdUrls.length = 0
  revokedUrls.length = 0

  let rejectFirst
  const sent = []
  const team = makeTeam({
    actions: {
      stageImage: async () => ({ id: 'img-1' }),
      send: async (_sid, text) => {
        sent.push(text)
        if (sent.length === 1) return await new Promise((_res, rej) => { rejectFirst = rej })
      },
    },
  })

  const inst = mount(mod.Chat, { sessionId: 'b1', team })
  try {
    let tree = inst.render()
    const ta = () => all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0]

    // Send first message (stays in flight).
    ta().props.onChange({ target: { value: 'first important message', selectionStart: 23 } })
    tree = inst.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    tree = inst.render()
    assert.equal(ta().props.value, '')

    // User immediately starts typing the next message before the first send fails.
    ta().props.onChange({ target: { value: 'next message in progress', selectionStart: 24 } })
    tree = inst.render()

    // Now the first send fails!
    rejectFirst(new Error('network timeout'))
    await tick()
    await tick()
    tree = inst.render()

    // Active draft is untouched, AND FailedSendBar surfaces the failed message with Retry / Restore / Dismiss.
    assert.equal(ta().props.value, 'next message in progress', 'active draft is never overwritten')
    const failedRegion = all(tree, n => n.props?.['data-failed-sends'] === '')[0]
    assert.ok(failedRegion, 'FailedSendBar renders above composer')
    assert.ok(textOf(failedRegion).includes('first important message'))

    // Click Retry -> resends failed message without touching active draft and clears the bar on success.
    all(failedRegion, n => n.type === 'button' && n.props?.['aria-label'] === 'Retry send')[0].props.onClick()
    await tick()
    await tick()
    tree = inst.render()
    assert.deepEqual(sent, ['first important message', 'first important message'])
    assert.equal(ta().props.value, 'next message in progress')
    assert.equal(all(tree, n => n.props?.['data-failed-sends'] === '').length, 0)
  } finally {
    inst.unmount()
  }

  // Test in-flight image URL protection across unmount + fresh attachment IDs after remount + pruneFailedSends!
  createdUrls.length = 0
  revokedUrls.length = 0
  let rejectImgSend
  const team2 = makeTeam({
    actions: {
      stageImage: async () => ({ id: 'img-staged' }),
      send: async () => await new Promise((_res, rej) => { rejectImgSend = rej }),
    },
  })
  const instA = mount(mod.Chat, { sessionId: 'b1', team: team2 })
  let imgUrl
  try {
    let tree = instA.render()
    const fileInput = all(tree, n => n.type === 'input' && n.props?.type === 'file')[0]
    fileInput.props.onChange({ target: { files: [new FakeFile(['png'], 'pic.png', { type: 'image/png' })], value: 'x' } })
    tree = instA.render()
    imgUrl = createdUrls[0]
    assert.ok(imgUrl)
    all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0].props.onChange({ target: { value: 'photo msg', selectionStart: 9 } })
    tree = instA.render()
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    // Simulate another draft written before send fails, then unmount while send is in flight!
    all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0].props.onChange({ target: { value: 'newer draft', selectionStart: 11 } })
    tree = instA.render()
  } finally {
    instA.unmount()
  }
  assert.equal(revokedUrls.includes(imgUrl), false, 'unmounting while image send is in flight must NOT revoke previewUrl')
  rejectImgSend(new Error('offline'))
  await tick()
  await tick()
  assert.equal(revokedUrls.includes(imgUrl), false, 'failed image send keeps previewUrl alive in recovery shelf')

  // Remount b1, attach a new image (gets att-1), then Restore failed send -> restored image gets fresh att-2 (no ID collision!).
  const instB = mount(mod.Chat, { sessionId: 'b1', team: team2 })
  try {
    let tree = instB.render()
    const fileInput = all(tree, n => n.type === 'input' && n.props?.type === 'file')[0]
    fileInput.props.onChange({ target: { files: [new FakeFile(['png2'], 'second.png', { type: 'image/png' })], value: 'x' } })
    tree = instB.render()
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Restore failed message to input')[0].props.onClick()
    tree = instB.render()
    const thumbs = all(tree, n => n.props?.className === 'dsb-attach-thumb')
    assert.equal(thumbs.length, 2, 'both current and restored images appear')
    assert.notEqual(thumbs[0].props.key, thumbs[1].props.key, 'restored attachment gets a fresh non-colliding ID')
    // Removing the first thumbnail removes ONLY one thumbnail, leaving the other intact.
    all(thumbs[0], n => n.type === 'button' && n.props?.className === 'dsb-attach-x')[0].props.onClick()
    tree = instB.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-attach-thumb').length, 1)
  } finally {
    instB.unmount()
  }

  // Test pruneFailedSends revokes preview URLs for deleted chats.
  let rejectPrune
  team2.actions.send = async () => await new Promise((_res, rej) => { rejectPrune = rej })
  const instC = mount(mod.Chat, { sessionId: 'b2', team: team2 })
  let b2Url
  try {
    let tree = instC.render()
    const beforeLen = createdUrls.length
    all(tree, n => n.type === 'input' && n.props?.type === 'file')[0].props.onChange({
      target: { files: [new FakeFile(['png3'], 'bye.png', { type: 'image/png' })], value: 'x' },
    })
    tree = instC.render()
    b2Url = createdUrls[beforeLen]
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-send')[0].props.onClick()
    await tick()
    all(tree, n => n.type === 'textarea' && n.props?.['data-composer-input'] === '')[0].props.onChange({ target: { value: 'keep typing', selectionStart: 11 } })
    tree = instC.render()
    rejectPrune(new Error('gone'))
    await tick()
    await tick()
  } finally {
    instC.unmount()
  }
  assert.equal(revokedUrls.includes(b2Url), false)
  mod.pruneFailedSends(['b2'])
  assert.equal(revokedUrls.includes(b2Url), true, 'pruneFailedSends revokes held preview URLs when a chat is deleted')
})
