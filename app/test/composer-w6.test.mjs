import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { Composer, attachmentLimitsOf, stageAttachmentItems } from './app/ui/src/composer-area.js'
      export { buildComposerMenuItems, buildSlashCommands, activeComposerTrigger } from './app/ui/src/composer-menus.js'
      export { Transcript } from './app/ui/src/chat-transcript.js'
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
    name: 'composer-w6-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: 'assistant-stream.js', namespace: 'cw6-stream' }))
      bundler.onLoad({ filter: /.*/, namespace: 'cw6-stream' }, () => ({
        contents: `export const assembleAssistantStream = () => null; export const createAssistantStreamAccumulator = () => ({ apply() {}, snapshot: () => null })`,
        loader: 'js',
      }))
      bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({ path: 'dsh-primitives.js', namespace: 'cw6-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'cw6-stub' }, () => ({
        contents: `
          export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
          export const fileSizeText = bytes => {
            if (!Number.isFinite(bytes)) return ''
            if (bytes >= 1024 * 1024) return (Math.round((bytes / (1024 * 1024)) * 10) / 10) + ' MB'
            if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
            return bytes + ' B'
          }
          export const writeClipboard = async () => true
          export const MarkdownText = ({ text }) => text
          export const CopyableText = ({ text }) => text
          export const Shimmer = ({ children }) => children
          export const Spinner = () => null
          export const FishLogo = () => null
          export const InlineNotice = ({ children }) => children
          export const Pill = ({ children }) => children
          export const Button = ({ children, ...p }) => children
          export const Tooltip = ({ children }) => children
          export const formatDuration = ms => ms + 'ms'
        `,
        loader: 'js',
      }))
    },
  }],
})

// Stateful mini-React harness supporting hooks & effects.
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
  useId: () => slot(() => `id-${++idSeq}`),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
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

const blobUrls = new Map()
let blobSeq = 0
const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`unexpected require ${name}`)
  },
  URL: {
    createObjectURL: file => {
      const url = `blob:test/${++blobSeq}/${file.name ?? 'f'}`
      blobUrls.set(url, file)
      return url
    },
    revokeObjectURL: url => { blobUrls.delete(url) },
  },
  Buffer,
  Uint8Array,
  console: { ...console, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    body: { dataset: {}, style: { setProperty() {} } },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
  window: {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  },
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  Composer,
  attachmentLimitsOf,
  stageAttachmentItems,
  buildComposerMenuItems,
  Transcript,
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

function makeRoster(extra = {}) {
  const bot1 = { id: 'b1', name: 'Chief', role: 'Lead', sessionId: 'b1' }
  const bot2 = { id: 'b2', name: 'Writer', role: 'Docs', sessionId: 'b2' }
  const room1 = { id: 'r1', name: 'Launch', admin: 'b1', members: ['b1', 'b2'], sessionId: 'r1' }
  return {
    ready: true,
    bots: [bot1, bot2],
    byId: { b1: bot1, b2: bot2 },
    rooms: [room1],
    roomsById: { r1: room1 },
    prefs: {},
    ...extra,
  }
}

test('W6 PR C: attachments upload on select, show progress, support per-item retry, zoom lightbox, and honor host imageLimits', async () => {
  const limits = attachmentLimitsOf({ imageLimits: { maxImageBytes: 2 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxBatchBytes: 16 * 1024 * 1024 } })
  assert.equal(limits.maxImageBytes, 2 * 1024 * 1024)
  assert.equal(limits.maxFileBytes, 8 * 1024 * 1024)
  assert.equal(limits.maxBatchBytes, 16 * 1024 * 1024)

  let failFirst = true
  let stageCalls = 0
  const staged = []
  let resolveUpload
  const actions = {
    stageImage: (mediaType, data, name) => {
      stageCalls += 1
      if (failFirst) {
        failFirst = false
        return Promise.reject(new Error('Network dropped'))
      }
      return new Promise((resolve) => {
        resolveUpload = () => {
          staged.push({ mediaType, name })
          resolve({ id: `img-${stageCalls}` })
        }
      })
    },
    stageFile: async () => ({ id: 'file-1' }),
    noteSent: () => () => {},
    canReferenceChat: () => false,
    speech: () => null,
    canOpenFiles: () => false,
    canOpenTerminal: () => false,
  }
  const sent = []
  const roster = makeRoster({ imageLimits: { maxImageBytes: 1024, maxFileBytes: 4096, maxBatchBytes: 8192 } })
  const addFilesRef = { current: null }
  const inst = mount(Composer, {
    sessionId: 'b1',
    placeholder: 'Message Chief',
    disabled: false,
    running: false,
    onSend: async (text, items, opts) => { sent.push({ text, items, opts }) },
    addFilesRef,
    actions,
    useUi: s => s({}),
    useRoster: s => s(roster),
    useWork: s => s({ bots: {}, approvals: [] }),
    useSessions: s => s({ ids: [], byId: {} }),
    useSessionQueues: s => s({}),
  })
  inst.render()

  // Oversized image relative to host imageLimits (1 KB) is rejected with dynamic size label (not hardcoded 16 MB).
  const tooBig = { name: 'huge.png', type: 'image/png', size: 2048, arrayBuffer: async () => new Uint8Array(2048).buffer }
  addFilesRef.current([tooBig])
  let tree = inst.render()
  assert.match(textOf(tree), /1 KB/)
  assert.equal(textOf(tree).includes('16 MB'), false)

  // Valid image starts uploading immediately on select; first attempt fails -> shows per-item Retry.
  const imgFile = { name: 'pic.png', type: 'image/png', size: 16, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
  addFilesRef.current([imgFile])
  inst.render()
  await tick()
  await tick()
  tree = inst.render()
  const retryBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-attach-retry')[0]
  assert.ok(retryBtn, 'failed attachment upload must render a per-item retry button')

  // Clicking per-item Retry enters uploading state with progressbar, then resolves to ready.
  retryBtn.props.onClick()
  tree = inst.render()
  await tick()
  tree = inst.render()
  assert.equal(all(tree, n => n.props?.role === 'progressbar').length, 1, 'uploading attachment should display progress bar')
  resolveUpload()
  await tick()
  await tick()
  tree = inst.render()
  const thumb = all(tree, n => n.props?.className === 'dsb-attach-thumb')[0]
  assert.equal(thumb.props['data-status'], 'ready')
  assert.equal(staged.length, 1)

  // Clicking pending image thumbnail opens ImageLightbox zoom dialog.
  const zoomBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-attach-thumb-btn')[0]
  zoomBtn.props.onClick()
  tree = inst.render()
  assert.ok(all(tree, n => n.props?.role === 'dialog').length >= 1, 'clicking pending image should open zoom lightbox')

  // stageAttachmentItems reuses already-staged id without calling stageImage again.
  const reused = await stageAttachmentItems([{ id: 'att-1', isImage: true, size: 16, stagedId: 'img-2', file: imgFile }], actions)
  assert.deepEqual(plain(reused), { images: ['img-2'], files: [] })
  assert.equal(stageCalls, 2)
})

test('W6 PR C: running Enter defaults to queue, setting flips to steer, Cmd/Ctrl+Enter does the opposite, and bare /goal runs directly', async () => {
  const ran = []
  const sent = []
  const actions = {
    composeGoal: id => ran.push(['goal', id]),
    newSideChat: id => ran.push(['side', id]),
    showDetails: id => ran.push(['details', id]),
    openShortcuts: () => ran.push(['shortcuts']),
    sessionSkills: async () => ({ skills: [{ name: 'review', description: 'Code review' }] }),
    sessionFiles: async () => ({ files: [{ path: 'src/app.js', kind: 'file' }] }),
    canReferenceChat: () => false,
    speech: () => null,
    canOpenFiles: () => false,
    canOpenTerminal: () => false,
  }

  // 1. Bot menus include /side, /skills, and @file.
  const roster = makeRoster()
  const dmCmds = buildComposerMenuItems({
    mode: 'command',
    query: '',
    roster,
    sessionId: 'b1',
    actions,
    classicCatalog: { skills: [{ name: 'review', description: 'Code review' }] },
  })
  assert.ok(dmCmds.some(c => c.code === '/side'), 'Bot DM slash menu should expose /side')
  assert.ok(dmCmds.some(c => c.code === '/review' && c.kind === 'insert'), 'Bot slash menu should include skills')
  dmCmds.find(c => c.code === '/side').run()
  assert.deepEqual(ran[0], ['side', 'b1'])

  const dmFiles = buildComposerMenuItems({
    mode: 'mention',
    query: 'app',
    roster,
    sessionId: 'b1',
    actions,
    classicCatalog: { files: [{ path: 'src/app.js', kind: 'file' }] },
  })
  assert.ok(dmFiles.some(item => item.insertText === '@src/app.js '), 'Bot @ menu should include workspace @file items')

  // 2. Running Enter = queue, Cmd+Enter = steer; with runningEnter: 'steer', Enter = steer, Cmd+Enter = queue.
  const makeComposer = (sessionId, prefs) => mount(Composer, {
    sessionId,
    placeholder: 'Message',
    disabled: false,
    running: true,
    onSend: async (text, _items, opts) => { sent.push({ sessionId, text, mode: opts?.mode }) },
    actions,
    useUi: s => s({}),
    useRoster: s => s(makeRoster({ prefs })),
    useWork: s => s({ bots: {}, approvals: [] }),
    useSessions: s => s({ ids: [], byId: {} }),
    useSessionQueues: s => s({}),
  })

  const queueInst = makeComposer('b1', {})
  let tree = queueInst.render()
  let ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: 'queued msg', selectionStart: 10 } })
  tree = queueInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.deepEqual(plain(sent.at(-1)), { sessionId: 'b1', text: 'queued msg', mode: 'queue' })

  tree = queueInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: 'steered msg', selectionStart: 11 } })
  tree = queueInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.deepEqual(plain(sent.at(-1)), { sessionId: 'b1', text: 'steered msg', mode: 'steer' })

  const steerInst = makeComposer('b1', { runningEnter: 'steer' })
  tree = steerInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: 'now steer', selectionStart: 9 } })
  tree = steerInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.deepEqual(plain(sent.at(-1)), { sessionId: 'b1', text: 'now steer', mode: 'steer' })

  tree = steerInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: 'ctrl queue', selectionStart: 10 } })
  tree = steerInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.deepEqual(plain(sent.at(-1)), { sessionId: 'b1', text: 'ctrl queue', mode: 'queue' })

  // 3. Typing bare `/goal` in a group chat and submitting runs composeGoal instead of sending text.
  const roomInst = makeComposer('r1', {})
  tree = roomInst.render()
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: '/goal', selectionStart: 5 } })
  tree = roomInst.render()
  // Dismiss menu with Escape first to verify bare submit path directly.
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  tree = roomInst.render()
  const sendCountBefore = sent.length
  ta = all(tree, n => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.equal(sent.length, sendCountBefore, 'bare /goal must not be sent as literal chat text')
  assert.deepEqual(ran.at(-1), ['goal', 'r1'])
})

test('W6 PR C: streaming upward scroll intent (wheel, touch, keyboard) immediately stops auto-following without snapping back', () => {
  const scrollerNode = { scrollTop: 950, scrollHeight: 1000, clientHeight: 500 }
  const scrollerRef = { current: scrollerNode }
  const roster = makeRoster()
  const inst = mount(Transcript, {
    sessionId: 'r1',
    activeSessionId: 'r1',
    viewedSessionId: 'r1',
    viewingSubagent: null,
    subagentStack: [],
    subagentAncestors: undefined,
    bot: undefined,
    room: roster.roomsById.r1,
    isRoom: true,
    isAgent: false,
    isClassic: false,
    name: 'Launch',
    readOnly: false,
    pending: [],
    transcriptPending: [],
    scrollerRef,
    transcriptRef: { current: null },
    onClearPendingUsers: () => {},
    onSessionUser: () => {},
    onWritingChange: () => {},
    actions: { roomChat: async () => ({ items: [] }) },
    hooks: {
      useRoster: s => s(roster),
      useSessions: s => s({ ids: [], byId: {} }),
      useSessionStatus: s => s(new Map([['r1', { running: true }]])),
      useUi: s => s({}),
      useWork: s => s({ bots: {}, approvals: [] }),
    },
    feed: { on: () => () => {} },
  })

  let tree = inst.render()
  let scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'true')

  // 1. Upward wheel immediately stops following even while within 80px of bottom.
  scrollerNode.scrollTop = 470 // dist = 30 (< FOLLOW_PX 80)
  scrollerEl.props.onWheel({ deltaY: -20 })
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'false')

  // Re-rendering with new streaming content does NOT snap back to bottom while user broke follow.
  scrollerNode.scrollHeight = 1040
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'false')
  assert.equal(scrollerNode.scrollTop, 470)

  // Scrolling all the way back to bottom re-engages follow.
  scrollerNode.scrollTop = 540
  scrollerEl.props.onScroll()
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'true')

  // 2. Touch drag downward (scrolling up into history) stops following immediately.
  scrollerEl.props.onTouchStart({ touches: [{ clientY: 200 }] })
  scrollerEl.props.onTouchMove({ touches: [{ clientY: 220 }] })
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'false')

  // Re-engage via back-to-bottom button, then verify PageUp breaks follow immediately.
  const toBottomBtn = all(tree, n => n.type === 'button' && n.props?.className === 'bt-to-bottom')[0]
  assert.ok(toBottomBtn)
  toBottomBtn.props.onClick()
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'true')

  scrollerEl.props.onKeyDown({ key: 'PageUp', target: { tagName: 'DIV' } })
  tree = inst.render()
  scrollerEl = all(tree, n => n.props?.className === 'dsb-scroll')[0]
  assert.equal(scrollerEl.props['data-bt-following-tail'], 'false')
})
