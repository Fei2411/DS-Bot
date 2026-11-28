import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const stubs = {
  'cells.js': 'export const workPhrase = () => ""\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    export const MarkdownText = ({ text }) => ({ type: 'markdown', props: { text, children: [text] } })
    export const writeClipboard = async (value) => { globalThis.__copied.push(value); return true }
    export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
    export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
  `,
  '@xterm/xterm': `
    export class Terminal {
      constructor(options = {}) {
        this.options = { ...options }
        this.cols = 80
        this.rows = 24
        this.written = []
        this.cleared = 0
        this.focused = 0
        this.disposed = false
        this.openedOn = null
        this.selection = ''
        this._dataListeners = []
        this._keyHandler = null
        globalThis.__xterms.push(this)
      }
      loadAddon(addon) { addon?.activate?.(this) }
      open(el) { this.openedOn = el }
      attachCustomKeyEventHandler(fn) { this._keyHandler = fn }
      onData(fn) {
        this._dataListeners.push(fn)
        return { dispose: () => { this._dataListeners = this._dataListeners.filter(item => item !== fn) } }
      }
      emitData(data) { for (const fn of [...this._dataListeners]) fn(data) }
      write(chunk) { this.written.push(String(chunk)) }
      clear() { this.cleared += 1 }
      focus() { this.focused += 1 }
      hasSelection() { return Boolean(this.selection) }
      getSelection() { return this.selection }
      clearSelection() { this.selection = '' }
      dispose() { this.disposed = true }
    }
  `,
  '@xterm/addon-fit': `
    export class FitAddon {
      activate(term) { this._term = term }
      fit() {
        const size = globalThis.__fitSize || { cols: 88, rows: 26 }
        if (this._term) {
          this._term.cols = size.cols
          this._term.rows = size.rows
        }
      }
      dispose() {}
    }
  `,
}

const entryCode = `
  export { parseDelimitedTable, computeCodeWindow, FilePreview, HtmlPreviewFrame, HtmlPreviewNotice } from './ui/src/file-preview.js'
  export { createLocalLineEditor, createTerminalKeyHandler, parseAnsiSpans, readXtermTheme, WorkspaceTerminal } from './ui/src/workspace-terminal.js'
  export { ChangesReview } from './ui/src/changes-review.js'
  export { RightPanel, WorkspacePaneBody, buildWorkspaceTabs, buildWorkspacePluginMenuItems } from './ui/src/right-panel.js'
  export { createPluginRuntime } from './ui/src/plugin-runtime.js'
  export { createSlotRegistry, RIGHT_PANE_TAB_SLOT } from './ui/src/slots.js'
  export { createTeam } from './ui/src/team.js'
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
    name: 'right-panel-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'rp-stub' }))
      bundler.onResolve({ filter: /(src\/client\/(cells|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'rp-stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'rp-stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'rp-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
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
class TestComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
}
const react = {
  Component: TestComponent,
  Fragment: 'fragment',
  Suspense: ({ children }) => children,
  lazy(loader) {
    let resolved = null
    let pending = null
    return function Lazy(props) {
      if (resolved) return react.createElement(resolved, props)
      if (!pending) pending = Promise.resolve().then(loader).then((mod) => { resolved = mod?.default ?? mod })
      return null
    }
  },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(make, deps) {
    const cell = slot(() => ({}))
    if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
      cell.value = make()
      cell.deps = deps
    }
    return cell.value
  },
  useCallback: (fn, deps) => react.useMemo(() => fn, deps),
  useEffect: effect,
  useLayoutEffect: effect,
  useSyncExternalStore(subscribe, getSnapshot) {
    const cell = slot(() => ({ sub: null }))
    if (cell.sub !== subscribe) {
      cell.stop?.()
      cell.sub = subscribe
      cell.stop = subscribe(() => {})
    }
    return getSnapshot()
  },
}

const storageMap = new Map()
const createdUrls = []
const revokedUrls = []
const windowEvents = []
const resizeObservers = []
const winListeners = new Map()
const docCaptureListeners = new Map()
const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  __testCall: async () => ({}),
  __copied: [],
  __xterms: [],
  __fitSize: { cols: 88, rows: 26 },
  ResizeObserver: class {
    constructor(cb) { this.cb = cb; this.targets = []; resizeObservers.push(this) }
    observe(target) { this.targets.push(target) }
    disconnect() { this.targets = [] }
  },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`unexpected require ${name}`)
  },
  Blob,
  Event,
  AbortController,
  atob: str => Buffer.from(str, 'base64').toString('binary'),
  URL: {
    createObjectURL: () => { const url = `blob:test/${createdUrls.length + 1}`; createdUrls.push(url); return url },
    revokeObjectURL: url => { revokedUrls.push(url) },
  },
  localStorage: {
    getItem: key => storageMap.get(key) ?? null,
    setItem: (key, value) => { storageMap.set(key, String(value)) },
    removeItem: key => { storageMap.delete(key) },
  },
  window: {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn) },
    dispatchEvent(event) { windowEvents.push(event?.type); return true },
  },
  document: {
    body: {},
    addEventListener(type, fn, capture) {
      if (capture) {
        if (!docCaptureListeners.has(type)) docCaptureListeners.set(type, new Set())
        docCaptureListeners.get(type).add(fn)
      }
    },
    removeEventListener(type, fn, capture) {
      if (capture) docCaptureListeners.get(type)?.delete(fn)
    },
    documentElement: { addEventListener() {}, removeEventListener() {} },
  },
  navigator: { language: 'en', platform: 'MacIntel' },
  console: { error() {}, warn() {}, log() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  parseDelimitedTable,
  computeCodeWindow,
  FilePreview,
  HtmlPreviewFrame,
  HtmlPreviewNotice,
  createLocalLineEditor,
  createTerminalKeyHandler,
  parseAnsiSpans,
  readXtermTheme,
  WorkspaceTerminal,
  ChangesReview,
  RightPanel,
  WorkspacePaneBody,
  buildWorkspaceTabs,
  buildWorkspacePluginMenuItems,
  createPluginRuntime,
  createSlotRegistry,
  RIGHT_PANE_TAB_SLOT,
  createTeam,
} = mod.exports

const makeHostEl = (tag) => {
  const listeners = new Map()
  return {
    tagName: tag,
    offsetWidth: 480,
    offsetHeight: 320,
    scrollWidth: 600,
    clientWidth: 240,
    scrollLeft: 0,
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
}

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
        if (typeof node.type.getDerivedStateFromProps === 'function') {
          const derived = node.type.getDerivedStateFromProps(node.props, cell.inst.state)
          if (derived) cell.inst.state = { ...cell.inst.state, ...derived }
        }
        cell.inst.props = node.props
        try {
          return expand(cell.inst.render(), id)
        } catch (error) {
          if (typeof node.type.getDerivedStateFromError === 'function') {
            cell.inst.state = { ...cell.inst.state, ...node.type.getDerivedStateFromError(error) }
            cell.inst.componentDidCatch?.(error)
            return expand(cell.inst.render(), id)
          }
          throw error
        }
      }
      return expand(node.type(node.props), id)
    } finally {
      current.fiber = prev
    }
  }
  if (typeof node.type === 'string' && node.props?.ref && typeof node.props.ref === 'object' && node.props.ref.current === null) {
    node.props.ref.current = makeHostEl(node.type)
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
      inst.onCommit?.(out)
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

test('parseDelimitedTable handles quoted commas, escaped quotes, empty records, CRLF, TSV, and exact row caps', () => {
  const csv = '\uFEFF"Name","Note"\r\n"Alice, Jr.","Says ""hi"""\r\nBob,Plain\r\n'
  const res = parseDelimitedTable(csv, ',')
  assert.deepEqual(plain(res.headers), ['Name', 'Note'])
  assert.deepEqual(plain(res.rows), [['Alice, Jr.', 'Says "hi"'], ['Bob', 'Plain']])
  assert.equal(res.truncatedRows, false)

  // Empty header and empty data record must not be silently dropped.
  const emptyHeader = ',\r\nAlice,95\r\n,\r\n'
  const preserved = parseDelimitedTable(emptyHeader, ',')
  assert.deepEqual(plain(preserved.headers), ['', ''])
  assert.deepEqual(plain(preserved.rows), [['Alice', '95'], ['', '']])

  // Exactly `maxRows` data rows must NOT flag `truncatedRows`.
  const exact = 'k\tv\n1\tone\n2\ttwo\n'
  const notCapped = parseDelimitedTable(exact, '\t', 2)
  assert.equal(notCapped.rows.length, 2)
  assert.equal(notCapped.truncatedRows, false)

  const tsv = 'k\tv\n1\tone\n2\ttwo\n3\tthree\n'
  const capped = parseDelimitedTable(tsv, '\t', 2)
  assert.equal(capped.rows.length, 2)
  assert.equal(capped.truncatedRows, true)
})

test('parseAnsiSpans converts ANSI SGR colors, skips 256/RGB params, handles cursor edits/backspaces/erase sequences, and strips OSC sequences cleanly', () => {
  const raw = '\u001b]0;title\u0007\u001b[1;32mPASS\u001b[0m \u001b[38;5;31mplain\u001b[0m \u001b[38;2;1;2;31mrgb\u001b[0m \u001b[31mFAIL\u001b[39m\r\n%\r50%\r100%'
  const spans = plain(parseAnsiSpans(raw))
  assert.deepEqual(spans, [
    { text: 'PASS', fg: 'green', bold: true },
    { text: ' plain rgb ' },
    { text: 'FAIL', fg: 'red' },
    { text: '\n100%' },
  ])

  const text = str => parseAnsiSpans(str).map(span => span.text).join('')
  // Zsh ZLE echoes first char, backspaces, then rewrites the full command (`lls -la` bug).
  assert.equal(text('feiz@host workspace % l\bls -la\r\ntotal 24'), 'feiz@host workspace % ls -la\ntotal 24')
  // Interactive backspace-space-backspace deletion trims cleanly.
  assert.equal(text('abc\b \b'), 'ab')
  // CSI CUB (D) + EL (K) rewrites from cursor to end of line.
  assert.equal(text('feiz@host % l\u001b[1D\u001b[Kls -la'), 'feiz@host % ls -la')
  // Zsh PROMPT_SP (`%` + padding + CR + 0J) clears trailing spaces cleanly before prompt.
  assert.equal(text('\u001b[1;7m%\u001b[0m     \r \r\u001b[0Jfeiz@host % '), 'feiz@host % ')
  // CSI 2J clears prior screen buffer.
  assert.equal(text('old output\r\n\u001b[2Jfresh'), 'fresh')
  // CSI CHA (G), DCH (P), and ICH (@) edit inside a line cleanly.
  assert.equal(text('abcdef\u001b[3G\u001b[2P'), 'abef')
  assert.equal(text('abef\u001b[3G\u001b[2@cd'), 'abcdef')
})

test('FilePreview renders Markdown, CSV table, strictly sandboxed HTML, PDF (Office), and revokes Blob URLs', () => {
  createdUrls.length = 0
  revokedUrls.length = 0

  const md = mount(FilePreview, { file: { kind: 'markdown', name: 'README.md', path: 'README.md', size: 20, text: '# Hi' } })
  try {
    let tree = md.render()
    assert.equal(all(tree, n => n.type === 'markdown').length, 1)
    const srcBtn = all(tree, n => n.type === 'button' && /Source/.test(textOf(n)))[0]
    srcBtn.props.onClick()
    tree = md.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-pv-code').length, 1)
  } finally {
    md.unmount()
  }

  const html = mount(FilePreview, { file: { kind: 'html', name: 'demo.html', path: 'demo.html', size: 40, text: '<p>Hello</p>' } })
  try {
    const tree = html.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-pv-html-wrap').length, 1, 'HTML preview wraps iframe in framed canvas container')
    const iframe = all(tree, n => n.type === 'iframe')[0]
    if (typeof DOMParser === 'function') {
      assert.equal(iframe.props.sandbox, '', 'HTML preview iframe must be strictly sandboxed with empty sandbox attribute')
      assert.match(iframe.props.srcDoc, /Content-Security-Policy/)
      assert.match(iframe.props.srcDoc, /<p>Hello<\/p>/)
    } else {
      assert.equal(iframe, undefined)
      assert.match(textOf(tree), /Preview unavailable/)
    }
  } finally {
    html.unmount()
  }

  const code = mount(FilePreview, { file: { kind: 'code', language: 'javascript', name: 'app.js', path: 'src/app.js', size: 64, text: 'export const x = 1' } })
  try {
    const tree = code.render()
    const badge = all(tree, n => n.props?.className === 'dsb-pv-badge')[0]
    assert.equal(textOf(badge).trim(), 'JAVASCRIPT', 'language badge uses consistent uppercase casing')
  } finally {
    code.unmount()
  }

  const pdf = mount(FilePreview, {
    file: { kind: 'pdf', convertedFrom: '.docx', name: 'report.docx', path: 'report.docx', size: 2048, mime: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') },
  })
  try {
    pdf.render()
    const tree = pdf.render()
    assert.match(textOf(tree), /Converted from \.DOCX/)
    assert.equal(all(tree, n => n.type === 'iframe' && String(n.props?.src).startsWith('blob:test/')).length, 1)
  } finally {
    pdf.unmount()
  }
  assert.equal(revokedUrls.length, 1, 'PDF blob URL must be revoked on unmount')
})

test('HtmlPreviewFrame keeps the iframe isolated and the blocked notice outside it without a DOM parser', () => {
  const framed = mount(HtmlPreviewFrame, { html: '<!doctype html><p>Hello</p>', title: 'demo.html' })
  try {
    const tree = framed.render()
    const iframe = all(tree, n => n.type === 'iframe')[0]
    assert.equal(iframe.props.sandbox, '', 'HTML preview iframe must be strictly sandboxed with empty sandbox attribute')
    assert.equal(iframe.props.referrerPolicy, 'no-referrer')
    assert.equal(iframe.props.srcDoc, '<!doctype html><p>Hello</p>')
    assert.equal(iframe.props.title, 'demo.html')
  } finally {
    framed.unmount()
  }
  const notice = mount(HtmlPreviewNotice)
  try {
    const tree = notice.render()
    const banner = all(tree, n => n.props?.className === 'dsb-pv-banner')[0]
    assert.ok(banner)
    assert.match(textOf(tree), /external or local resources are blocked/)
    assert.equal(all(tree, n => n.type === 'iframe').length, 0, 'notice is outside the iframe')
  } finally {
    notice.unmount()
  }
})

for (const native of [false, true]) {
  test(`FilePreview preserves binary preview behavior with ${native ? 'native' : 'fallback'} base64 decoding`, async (t) => {
    const decode = t.mock.fn((value) => Uint8Array.from(atob(value), ch => ch.charCodeAt(0)))
    sandbox.Uint8Array = class extends Uint8Array { static fromBase64 = native ? decode : undefined }
    t.after(() => { delete sandbox.Uint8Array })
    const legacy = t.mock.method(sandbox, 'atob', atob)
    const createUrl = t.mock.method(sandbox.URL, 'createObjectURL', () => 'blob:test/binary')
    const preview = (kind, base64, mime) => {
      const view = mount(FilePreview, { file: { kind, name: 'sample', base64, mime } })
      try {
        view.render()
        return view.render()
      } finally {
        view.unmount()
      }
    }

    const cases = [
      ['image', 'AP+AAQ==', 'IMAGE/PNG', 'image/png', [0, 255, 128, 1]],
      ['pdf', ' \t/ x\r\n', undefined, 'application/pdf', [255]],
      ['pdf', '/x==', undefined, 'application/pdf', [255]],
      ['pdf', ' \t', undefined, 'application/pdf', []],
    ]
    for (const [kind, base64, mime, type, bytes] of cases) {
      const tree = preview(kind, base64, mime)
      const tag = kind === 'image' ? 'img' : 'iframe'
      assert.equal(all(tree, n => n.type === tag)[0]?.props.src, 'blob:test/binary')
      const [blob] = createUrl.mock.calls.at(-1).arguments
      assert.equal(blob.type, type)
      assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), bytes)
    }

    for (const base64 of ['A', 'Zg=', '_w==', 'Zg==\v', '']) {
      const tree = preview('pdf', base64)
      assert.equal(all(tree, n => n.type === 'iframe').length, 0)
      assert.match(textOf(tree), /Preview unavailable/)
    }
    const image = preview('image', '!', 'image/png')
    assert.equal(all(image, n => n.type === 'img')[0]?.props.src, 'data:image/png;base64,!')
    assert.equal(createUrl.mock.callCount(), cases.length)
    assert.equal(decode.mock.callCount(), native ? 9 : 0)
    assert.equal(legacy.mock.callCount(), native ? 0 : 9)
  })
}

test('Unified right sidebar coexists across Details, Side chat, Files, Preview, Changes, Terminal, and plugin tabs', async () => {
  const calls = []
  windowEvents.length = 0
  sandbox.__testCall = async (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint === 'state') {
      return {
        revision: 1,
        modelsKey: 'm1',
        mainBotId: 'b1',
        bots: [
          { id: 'b1', name: 'Alpha', sessions: ['b1'] },
          { id: 'b2', name: 'Beta', sessions: ['b2'] },
        ],
        rooms: [{ id: 'r1', name: 'Crew', members: ['b1', 'b2'], sessions: ['r1'] }],
        agents: [{ id: 'ag1', name: 'DSH Agent', sessions: ['as1', 'as2'] }],
        sideChats: { b1: [{ id: 'sc1', entries: [{ question: 'Quick Q' }] }] },
      }
    }
    if (endpoint === 'workspace-list') {
      return {
        root: '/repo', rootName: 'repo', path: body.path ?? '', truncated: false,
        entries: body.path === 'src'
          ? [{ name: 'app.js', path: 'src/app.js', kind: 'file', size: 128, ext: '.js' }]
          : [
              { name: 'src', path: 'src', kind: 'dir', size: 0, ext: '' },
              { name: 'README.md', path: 'README.md', kind: 'file', size: 42, ext: '.md' },
            ],
      }
    }
    if (endpoint === 'workspace-read') {
      return { kind: 'code', language: 'javascript', name: 'app.js', path: body.path, size: 128, text: 'console.log(1)' }
    }
    if (endpoint === 'workspace-changes') {
      if (body.index === undefined) {
        return { sessionId: 'b1', seq: 7, turn: 1, total: 1, added: 1, deleted: 0, files: [{ index: 0, path: 'src/app.js', display: 'src/app.js', added: 1, deleted: 0 }] }
      }
      return { kind: 'text', path: 'src/app.js', display: 'src/app.js', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+console.log(1)'] }] }
    }
    if (endpoint === 'changes-check') return true
    if (endpoint === 'terminal-list') return []
    if (endpoint === 'terminal-open') return { id: 'term-1', cwd: '/repo', title: 'repo', cols: 96, rows: 28, pty: true }
    if (endpoint === 'terminal-input') return true
    return {}
  }

  const team = createTeam()
  await team.actions.refreshLocale()
  team.actions.openSession('b1')

  const probe = mount(() => ({
    type: 'probe',
    props: team.hooks.useUi(s => ({ details: s.details, view: s.view, side: s.side, rightPanel: s.rightPanel })),
  }), {})
  try {
    // Details + Files + Side chat + Preview + Terminal + Changes all coexist in ONE panel state.
    team.actions.showDetails('b1')
    assert.equal(probe.render().props.details, 'b1')
    assert.equal(probe.render().props.view, 'details')
    assert.equal(probe.render().props.rightPanel, null)

    team.actions.openFiles()
    let snap = probe.render().props
    assert.equal(snap.details, 'b1', 'opening Files keeps unified BotPanel open on the active subject')
    assert.equal(snap.view, 'workspace')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files'])
    assert.equal(snap.rightPanel.tab, 'files')

    team.actions.openSideChat('b1', 'sc1')
    snap = probe.render().props
    assert.equal(snap.details, 'b1')
    assert.equal(snap.view, 'side')
    assert.equal(snap.side, 'sc1')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files'], 'switching to Side chat preserves open workspace tabs')

    team.actions.openFile('src/app.js')
    const appPreviewId = probe.render().props.rightPanel.tab
    assert.ok(appPreviewId.startsWith('preview:'), 'openFile assigns a unique per-file preview tab id')
    team.actions.newTerminal()
    await team.actions.openChanges({ sessionId: 'b1', seq: 7, turn: 1 })
    snap = probe.render().props
    assert.equal(snap.view, 'workspace')
    assert.equal(snap.side, 'sc1', 'opening workspace tabs keeps active side chat reference intact')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', appPreviewId, 'terminal', 'changes'])
    assert.equal(snap.rightPanel.tab, 'changes')

    // Switching back to Details preserves all workspace tabs.
    team.actions.showDetails('b1')
    snap = probe.render().props
    assert.equal(snap.view, 'details')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', appPreviewId, 'terminal', 'changes'])

    // Switching sessions drops stale preview & changes while preserving Files & Terminal.
    team.actions.setRightPanelTab(appPreviewId)
    team.actions.openSession('b2')
    snap = probe.render().props
    assert.equal(snap.view, 'workspace')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', 'terminal'])
    assert.equal(snap.rightPanel.tab, 'terminal', 'dropping active preview falls back to last remaining tab')
    assert.equal(snap.rightPanel.file, null)
    assert.equal(snap.rightPanel.changes, null)

    // Closing individual tabs removes them and switches active tab cleanly.
    team.actions.openSession('b1')
    team.actions.openFile('src/app.js')
    team.actions.closeWorkspaceTab('preview')
    snap = probe.render().props
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', 'terminal'])
    assert.equal(snap.rightPanel.file, null)
    assert.equal(snap.rightPanel.tab, 'terminal')

    // Closing the last workspace tab on a Bot with a live side chat folds to Side chat.
    team.actions.closeWorkspaceTab('terminal')
    team.actions.closeWorkspaceTab('files')
    snap = probe.render().props
    assert.equal(snap.rightPanel, null)
    assert.equal(snap.details, 'b1')
    assert.equal(snap.view, 'side')

    // Without a live side chat, closing the last workspace tab on a Bot folds back to Details.
    team.actions.closePanel()
    team.actions.openFiles()
    assert.equal(probe.render().props.details, 'b1')
    team.actions.closeWorkspaceTab('files')
    snap = probe.render().props
    assert.equal(snap.rightPanel, null)
    assert.equal(snap.details, 'b1')
    assert.equal(snap.view, 'details')

    // Toggle closes unified panel when viewing workspace, and opens Files otherwise.
    team.actions.toggleRightPanel()
    assert.equal(probe.render().props.view, 'workspace')
    team.actions.toggleRightPanel()
    assert.equal(probe.render().props.details, null)
    assert.equal(probe.render().props.rightPanel, null)

    // Escape (`closeOverlay`) clears both details and rightPanel when no modal dialog is open.
    team.actions.openFiles()
    assert.equal(probe.render().props.details, 'b1')
    team.actions.closeOverlay()
    assert.equal(probe.render().props.details, null)
    assert.equal(probe.render().props.rightPanel, null)

    // Classic Agent mode: panel opens with workspace tabs, keeps persistent tabs across agent switches,
    // and closes the panel completely when the last workspace tab is closed or only stale tabs remain.
    team.actions.openAgentSession('as1')
    team.actions.openFiles()
    team.actions.openFile('src/app.js')
    snap = probe.render().props
    assert.equal(snap.details, 'as1')
    assert.equal(snap.view, 'workspace')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', appPreviewId])

    team.actions.openAgentSession('as2')
    snap = probe.render().props
    assert.equal(snap.details, 'as2', 'switching Classic Agent sessions keeps persistent workspace tabs open')
    assert.equal(snap.view, 'workspace')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files'])

    team.actions.closeWorkspaceTab('files')
    snap = probe.render().props
    assert.equal(snap.details, null, 'closing last workspace tab in Classic Agent mode closes the unified panel')
    assert.equal(snap.rightPanel, null)

    // Classic Agent switch when only stale preview is open closes the panel cleanly.
    team.actions.openFile('src/app.js')
    assert.equal(probe.render().props.details, 'as2')
    team.actions.openAgentSession('as1')
    assert.equal(probe.render().props.details, null)
    assert.equal(probe.render().props.rightPanel, null)

    // Surface switch clears panel and rightPanel cleanly.
    team.actions.openFiles()
    assert.equal(probe.render().props.details, 'as1')
    await team.actions.setSurface('bot')
    assert.equal(probe.render().props.details, null)
    assert.equal(probe.render().props.rightPanel, null)
  } finally {
    probe.unmount()
  }

  // `buildWorkspaceTabs` builds ordered descriptors: unopened plugin tabs stay out of the strip
  // (surfaced in `+` menu), while opened plugin tabs are closable.
  const reg = createSlotRegistry()
  function BrokenTab() { throw new Error('plugin crash') }
  reg.register({ name: RIGHT_PANE_TAB_SLOT, id: 'broken', meta: { label: 'Broken' } }, BrokenTab)

  assert.deepEqual(plain(buildWorkspaceTabs(null, [])), [])
  const builtTabs = buildWorkspaceTabs(
    { tabs: ['files', 'preview', 'changes', 'terminal'], tab: 'preview', file: 'src/app.js', changes: { sessionId: 'b1', seq: 7 } },
    reg.list(RIGHT_PANE_TAB_SLOT),
  )
  assert.deepEqual(
    plain(builtTabs.map(tab => ({ id: tab.id, label: tab.label, closable: tab.closable }))),
    [
      { id: 'files', label: 'Files', closable: true },
      { id: 'preview', label: 'app.js', closable: true },
      { id: 'changes', label: 'Changes', closable: true },
      { id: 'terminal', label: 'Terminal', closable: true },
    ],
  )
  const withPlugin = buildWorkspaceTabs(
    { tabs: ['files', 'plugin:broken'], tab: 'plugin:broken' },
    reg.list(RIGHT_PANE_TAB_SLOT),
  )
  assert.deepEqual(
    plain(withPlugin.map(tab => ({ id: tab.id, label: tab.label, closable: tab.closable }))),
    [
      { id: 'files', label: 'Files', closable: true },
      { id: 'plugin:broken', label: 'Broken', closable: true },
    ],
  )
  const menuItems = buildWorkspacePluginMenuItems(reg.list(RIGHT_PANE_TAB_SLOT), () => {})
  assert.deepEqual(plain(menuItems.map(item => ({ key: item.key, label: item.label }))), [{ key: 'plugin:broken', label: 'Broken' }])

  // `WorkspacePaneBody` keeps FileTree & Terminal mounted with `hidden` toggle when `visible` flips,
  // dispatches resize when Terminal becomes visible, and isolates crashing plugin tabs.
  const panelInst = mount(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['files', 'terminal'], tab: 'files', terminalNonce: 1 },
    team,
    registry: reg,
    visible: true,
  })
  try {
    panelInst.render()
    await tick()
    let tree = panelInst.render()
    assert.match(textOf(tree), /README\.md/)
    // Expand `src` directory in FileTree.
    const srcBtn = all(tree, n => n.type === 'button' && /src/.test(textOf(n)))[0]
    srcBtn.props.onClick()
    await tick()
    tree = panelInst.render()
    assert.match(textOf(tree), /app\.js/)

    // Hide workspace body (user switched to Side chat / Details) -> panes stay mounted with `hidden: true`.
    tree = panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'terminal'], tab: 'files', terminalNonce: 1 },
      team,
      registry: reg,
      visible: false,
    })
    const hiddenPanes = all(tree, n => n.props?.className === 'dsb-ws-pane')
    assert.equal(hiddenPanes.length, 2, 'Files and Terminal remain mounted while panel shows Details/Side chat')
    assert.equal(hiddenPanes.every(p => p.props.hidden === true), true)

    // Switch back to visible Files -> expanded `app.js` child row is still preserved without reloading!
    tree = panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'terminal'], tab: 'files', terminalNonce: 1 },
      team,
      registry: reg,
      visible: true,
    })
    assert.match(textOf(tree), /app\.js/, 'expanded FileTree folder survives switching away and back')

    // Switch to visible Terminal -> dispatches resize event for terminal refit.
    windowEvents.length = 0
    panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'terminal'], tab: 'terminal', terminalNonce: 1 },
      team,
      registry: reg,
      visible: true,
    })
    assert.equal(windowEvents.includes('resize'), true, 'becoming visible on Terminal triggers resize refit')

    // Switch to Preview tab -> loads file via workspace-read.
    panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'preview'], tab: 'preview', file: 'src/app.js' },
      team,
      registry: reg,
      visible: true,
    })
    await tick()
    tree = panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'preview'], tab: 'preview', file: 'src/app.js' },
      team,
      registry: reg,
      visible: true,
    })
    const codeCells = all(tree, n => n.type === 'td' && n.props?.className === 'dsb-pv-line')
    const rawCodeText = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(rawCodeText).join('')
      return rawCodeText(node.props?.children)
    }
    assert.match(codeCells.map(rawCodeText).join('\n'), /console\.log\(1\)/)

    // Switch to crashing plugin tab -> isolated fallback with Retry.
    tree = panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'plugin:broken'], tab: 'plugin:broken' },
      team,
      registry: reg,
      visible: true,
    })
    assert.match(textOf(tree), /This view could not be shown/)
    assert.match(textOf(tree), /Retry/)

    // Switch to Changes tab -> loads summary and diff hunk.
    panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'changes'], tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } },
      team,
      registry: reg,
      visible: true,
    })
    await tick()
    panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'changes'], tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } },
      team,
      registry: reg,
      visible: true,
    })
    await tick()
    tree = panelInst.render({
      sessionId: 'b1',
      panel: { tabs: ['files', 'changes'], tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } },
      team,
      registry: reg,
      visible: true,
    })
    assert.match(textOf(tree), /console\.log\(1\)/)
  } finally {
    panelInst.unmount()
  }

  // Interactive direct-input xterm mounts with zero bottom <form>, streams live SSE chunks,
  // sends keystrokes straight to PTY, and syncs deduped resize dimensions.
  sandbox.__xterms.length = 0
  resizeObservers.length = 0
  sandbox.__fitSize = { cols: 88, rows: 26 }
  const termInst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, autoOpenNonce: 1 })
  try {
    termInst.render()
    await tick()
    let tree = termInst.render()
    assert.equal(all(tree, n => n.type === 'form').length, 0, 'must NOT render legacy bottom command <form>')
    assert.equal(all(tree, n => n.type === 'input' && n.props?.className === 'dsb-term-input').length, 0)
    assert.equal(sandbox.__xterms.length, 1, 'mounts persistent xterm Terminal instance')
    const xterm = sandbox.__xterms[0]
    assert.ok(xterm.openedOn, 'xterm opened onto host element')
    assert.equal(calls.some(([ep, b]) => ep === 'terminal-resize' && b.id === 'term-1' && b.cols === 88 && b.rows === 26), true)

    // Repeated resize with identical dimensions is deduped; changed dimensions sync cleanly.
    const beforeResizeCount = calls.filter(([ep]) => ep === 'terminal-resize').length
    resizeObservers.at(-1).cb()
    assert.equal(calls.filter(([ep]) => ep === 'terminal-resize').length, beforeResizeCount, 'identical cols×rows resize is deduped')
    sandbox.__fitSize = { cols: 104, rows: 32 }
    resizeObservers.at(-1).cb()
    await tick()
    assert.equal(calls.some(([ep, b]) => ep === 'terminal-resize' && b.id === 'term-1' && b.cols === 104 && b.rows === 32), true)

    // Live SSE chunk writes directly to xterm without needing a React buffer re-render.
    team.chat.emit('terminal', { id: 'term-1', chunk: '\u001b[32mhello-term\u001b[0m\n' })
    assert.match(xterm.written.join(''), /hello-term/)

    // Direct on-canvas typing flows straight to terminal-input.
    xterm.emitData('pwd\r')
    await tick()
    assert.equal(calls.some(([ep, b]) => ep === 'terminal-input' && b.id === 'term-1' && b.data === 'pwd\r'), true)

    // Clear button clears xterm and refocuses it.
    const clearBtn = all(tree, n => n.type === 'button' && /Clear/.test(textOf(n)))[0]
    clearBtn.props.onClick()
    assert.equal(xterm.cleared, 1)
    assert.ok(xterm.focused >= 2)
  } finally {
    termInst.unmount()
  }
})

test('ChangesReview renders summary errors before loading state and guards cyclic FileTree, early terminal SSE, and DM workspace/changes rows', async () => {
  // 1. ChangesReview must render errors instead of getting stuck on "Loading…".
  sandbox.__testCall = async () => { throw new Error('These changes are no longer available') }
  const chg = mount(ChangesReview, { changes: { sessionId: 'b1', seq: 99, turn: 1 } })
  try {
    chg.render()
    await tick()
    const tree = chg.render()
    assert.match(textOf(tree), /These changes are no longer available/)
  } finally {
    chg.unmount()
  }

  // 2. WorkspaceTerminal preserves new terminal when terminal-list resolves late and flushes early SSE output into xterm.
  sandbox.__xterms.length = 0
  let resolveList
  let resolveOpen
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return new Promise(resolve => { resolveList = resolve })
    if (endpoint === 'terminal-open') return new Promise(resolve => { resolveOpen = resolve })
    return Promise.resolve({})
  }
  const team = createTeam()
  // Whitespace in file paths must be preserved verbatim by openFile, and target sessionId is retained.
  team.actions.openFile({ path: 'spaced.txt ', sessionId: 'member-s1' })
  const fileProbe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => s.rightPanel) }), {})
  assert.equal(fileProbe.render().props.file, 'spaced.txt ')
  assert.equal(fileProbe.render().props.fileSessionId, 'member-s1')
  fileProbe.unmount()

  const term = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, autoOpenNonce: 1 })
  try {
    term.render()
    // Emit SSE output BEFORE terminal-open resolves!
    team.chat.emit('terminal', { id: 'term-early', chunk: 'early-prompt$ ' })
    resolveOpen({ id: 'term-early', cwd: '/repo', title: 'repo', cols: 96, rows: 28, pty: true })
    await tick()
    // Now resolve terminal-list LATE with empty list — must NOT wipe `term-early`!
    resolveList([])
    await tick()
    term.render()
    assert.equal(sandbox.__xterms.length, 1)
    assert.match(sandbox.__xterms[0].written.join(''), /early-prompt\$/)
  } finally {
    term.unmount()
  }

  // 3. FileTree must not stack-overflow on a cyclic directory entry (`path: ''`).
  sandbox.__testCall = async (endpoint) => {
    if (endpoint === 'workspace-list') {
      return { root: '/repo', rootName: 'repo', path: '', truncated: false, entries: [{ name: 'loop', path: '', kind: 'dir', size: 0, ext: '' }] }
    }
    return {}
  }
  const cyclicPanel = mount(RightPanel, { sessionId: 'b1', panel: { tab: 'files' }, team })
  try {
    cyclicPanel.render()
    await tick()
    let tree = cyclicPanel.render()
    const loopBtn = all(tree, n => n.type === 'button' && /loop/.test(textOf(n)))[0]
    loopBtn.props.onClick()
    await tick()
    tree = cyclicPanel.render()
    assert.match(textOf(tree), /loop/)
  } finally {
    cyclicPanel.unmount()
  }
})

test('WorkspaceTerminal resumes numbered output after feed reconnects and marks trimmed scrollback', async () => {
  const listRequests = []
  const listAnswers = []
  const openCalls = []
  sandbox.__xterms.length = 0
  sandbox.__testCall = (endpoint, body) => {
    if (endpoint === 'terminal-list') {
      listRequests.push(body?.positions ?? null)
      return Promise.resolve(listAnswers.length === 0 ? [] : listAnswers.shift())
    }
    if (endpoint === 'terminal-open') openCalls.push(body)
    return Promise.resolve({})
  }
  const entry = (parts, extra = {}) => ({
    id: 'term-1', cwd: '/repo', title: 'repo', pty: true,
    start: parts[0]?.seq ?? 1, end: parts.at(-1)?.seq ?? 0,
    parts, truncated: false, exited: false, exitCode: null, ...extra,
  })
  listAnswers.push([entry([{ seq: 1, text: 'line-1\n' }])])
  const team = createTeam()
  const inst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat })
  try {
    inst.render()
    await tick()
    await tick()
    inst.render()
    assert.ok(listRequests.length >= 1)
    assert.equal(openCalls.length, 0)
    assert.equal(sandbox.__xterms.length, 1)
    const xterm = sandbox.__xterms[0]
    assert.equal(xterm.written.join(''), 'line-1\n')

    // Ordered live parts write once; overlapping replayed parts are dropped by position.
    team.chat.emit('terminal', { id: 'term-1', chunk: 'line-2\nline-3\n', start: 2, end: 3, parts: [{ seq: 2, text: 'line-2\n' }, { seq: 3, text: 'line-3\n' }] })
    team.chat.emit('terminal', { id: 'term-1', chunk: 'line-3\n', start: 3, end: 3, parts: [{ seq: 3, text: 'line-3\n' }] })
    assert.equal(xterm.written.join(''), 'line-1\nline-2\nline-3\n')

    // Clean resumed hello does NOT trigger a redundant terminal-list sync.
    const listsBeforeResumed = listRequests.length
    team.chat.emit('hello', { resumed: true })
    await tick()
    await tick()
    assert.equal(listRequests.length, listsBeforeResumed, 'hello { resumed: true } must not re-sync terminal-list')

    // A feed hello sends the held position and the answer fills exactly the missing tail.
    listAnswers.push([entry([{ seq: 4, text: 'line-4\n' }, { seq: 5, text: 'line-5\n' }], { start: 4, end: 5 })])
    team.chat.emit('hello', {})
    await tick()
    await tick()
    assert.equal(listRequests.at(-1)?.['term-1'], 3)
    assert.equal(xterm.written.join(''), 'line-1\nline-2\nline-3\nline-4\nline-5\n')

    // When the host no longer reaches the held position, the terminal says so quietly and
    // continues with the retained suffix; no output is duplicated.
    listAnswers.push([entry([{ seq: 8, text: 'line-8\n' }], { start: 8, end: 8, truncated: true })])
    team.chat.emit('hello', {})
    await tick()
    await tick()
    const written = xterm.written.join('')
    assert.match(written, /Earlier output was trimmed/)
    assert.ok(written.indexOf('line-5') < written.indexOf('Earlier output was trimmed'))
    assert.ok(written.indexOf('Earlier output was trimmed') < written.indexOf('line-8'))
    assert.equal((written.match(/line-8/g) ?? []).length, 1)

    // Exit state is part of the same catch-up read when its live event was missed.
    listAnswers.push([entry([], { start: 8, end: 8, exited: true, exitCode: 7 })])
    team.chat.emit('hello', {})
    await tick()
    await tick()
    const tree = inst.render()
    assert.match(textOf(tree), /Process exited \(7\)/)
  } finally {
    inst.unmount()
  }
})


test('WorkspaceTerminal does not auto-open after a list failure, appends reconnected terminals, and syncs early exits', async () => {
  sandbox.__xterms.length = 0
  let openCalls = 0
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return Promise.reject(new Error('host hiccup'))
    if (endpoint === 'terminal-open') { openCalls += 1; return Promise.resolve({ id: 'never', cwd: '/repo', title: 'repo' }) }
    return Promise.resolve({})
  }
  let team = createTeam()
  let inst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat })
  inst.render()
  await tick()
  await tick()
  assert.equal(openCalls, 0, 'a failed terminal-list is not proof that no terminals exist')
  inst.unmount()

  // Reconnected discoveries append after existing tabs, keeping tab numbers stable.
  const entry = (id, title) => ({ id, cwd: '/repo', title, pty: true, start: 1, end: 0, parts: [], truncated: false, exited: false, exitCode: null })
  const answers = [
    [entry('term-a', 'alpha')],
    [entry('term-a', 'alpha'), entry('term-b', 'beta')],
  ]
  sandbox.__xterms.length = 0
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return Promise.resolve(answers.length > 1 ? answers.shift() : answers[0])
    return Promise.resolve({})
  }
  team = createTeam()
  inst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat })
  try {
    inst.render()
    await tick()
    await tick()
    inst.render()
    team.chat.emit('hello', {})
    await tick()
    await tick()
    const text = textOf(inst.render())
    assert.ok(text.indexOf('alpha #1') >= 0 && text.indexOf('alpha #1') < text.indexOf('beta #2'), `tabs keep their order: ${text}`)
  } finally {
    inst.unmount()
  }

  // An exit that wins the race with terminal-open still triggers an immediate positional catch-up.
  sandbox.__xterms.length = 0
  let resolveOpen
  let listCalls = 0
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') {
      listCalls += 1
      return Promise.resolve(listCalls === 1 ? [] : [entry('term-fast', 'fast')].map(item => ({ ...item, end: 2, parts: [{ seq: 1, text: 'final-1\n' }, { seq: 2, text: 'final-2\n' }], exited: true, exitCode: 0 })))
    }
    if (endpoint === 'terminal-open') return new Promise(resolve => { resolveOpen = resolve })
    return Promise.resolve({})
  }
  team = createTeam()
  inst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat })
  try {
    inst.render()
    await tick()
    await tick()
    team.chat.emit('terminal-exit', { id: 'term-fast', code: 0, end: 2 })
    resolveOpen({ id: 'term-fast', cwd: '/repo', title: 'fast', cols: 96, rows: 28, pty: true })
    await tick()
    await tick()
    await tick()
    assert.ok(listCalls >= 2, 'the early exit end position triggers terminal-list immediately')
    inst.render()
    assert.equal(sandbox.__xterms[0]?.written.join(''), 'final-1\nfinal-2\n')
  } finally {
    inst.unmount()
    sandbox.__testCall = async () => ({})
  }
})

test('WorkspaceTerminal closes sub-tabs reliably on rapid/concurrent clicks, prevents mousedown scroll-shift, supports wheel scroll, and handles non-PTY & shortcuts cleanly', async () => {
  const closedCalls = []
  const inputCalls = []
  let openSeq = 0
  let resolveLateList
  sandbox.__xterms.length = 0
  sandbox.__copied.length = 0
  sandbox.__testCall = (endpoint, body) => {
    if (endpoint === 'terminal-list') return new Promise(resolve => { resolveLateList = resolve })
    if (endpoint === 'terminal-open') {
      openSeq += 1
      return Promise.resolve({ id: `t-${openSeq}`, cwd: '/repo', title: 'workspace', cols: 96, rows: 28, pty: openSeq !== 3 })
    }
    if (endpoint === 'terminal-close') { closedCalls.push(body.id); return Promise.resolve(true) }
    if (endpoint === 'terminal-input') { inputCalls.push(body); return Promise.resolve(true) }
    return Promise.resolve(true)
  }

  const team = createTeam()
  const inst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, autoOpenNonce: 1 })
  try {
    inst.render()
    await tick()
    let tree = inst.render()
    const plusBtn = () => all(tree, n => n.type === 'button' && n.props?.className === 'dsb-term-act-ico')[0]

    // Open two more tabs: t-1 (pty), t-2 (pty), t-3 (non-PTY fallback).
    plusBtn().props.onClick()
    await tick()
    tree = inst.render()
    plusBtn().props.onClick()
    await tick()
    tree = inst.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-term-tab').length, 3)
    assert.equal(sandbox.__xterms.length, 3)

    // Non-PTY t-3 supports direct on-canvas typing (local echo + Backspace + Enter + ArrowUp history), zero <form>.
    assert.equal(all(tree, n => n.type === 'form').length, 0)
    const nonPtyTerm = sandbox.__xterms[2]
    assert.equal(nonPtyTerm.options.convertEol, true)
    nonPtyTerm.emitData('echx')
    nonPtyTerm.emitData('\x7f')
    nonPtyTerm.emitData('o hi\r')
    await tick()
    assert.equal(inputCalls.some(c => c.id === 't-3' && c.data === 'echo hi\n'), true)
    nonPtyTerm.emitData('\x1b[A\r')
    await tick()
    assert.equal(inputCalls.filter(c => c.id === 't-3' && c.data === 'echo hi\n').length, 2, 'ArrowUp recalls prior command on non-PTY canvas')

    // `.dsb-term-tabs` translates vertical mouse wheel into horizontal scrollLeft.
    const tabsNode = all(tree, n => n.props?.className === 'dsb-term-tabs')[0]
    const tabsEl = tabsNode.props.ref.current
    const wheelHandlers = [...(tabsEl.listeners.get('wheel') ?? [])]
    assert.equal(wheelHandlers.length, 1)
    let wheelPrevented = false
    wheelHandlers[0]({ deltaY: 42, deltaX: 0, deltaMode: 0, preventDefault() { wheelPrevented = true } })
    assert.equal(wheelPrevented, true)
    assert.equal(tabsEl.scrollLeft, 42)

    // `.dsb-term-tab-x` prevents mousedown focus/scroll-shift and reliably handles rapid back-to-back closes without stale closures.
    const closeBtns = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-term-tab-x')
    assert.equal(closeBtns.length, 3)
    let downPrevented = false
    let downStopped = false
    closeBtns[2].props.onMouseDown({ preventDefault() { downPrevented = true }, stopPropagation() { downStopped = true } })
    assert.equal(downPrevented, true, 'mousedown on × prevents Chromium scroll-shift')
    assert.equal(downStopped, true)

    // Click × on t-3 and t-2 synchronously back-to-back before re-rendering!
    closeBtns[2].props.onClick({ stopPropagation() {} })
    closeBtns[1].props.onClick({ stopPropagation() {} })
    await tick()
    tree = inst.render()
    assert.deepEqual(plain(closedCalls), ['t-3', 't-2'])
    assert.equal(sandbox.__xterms[2].disposed, true)
    assert.equal(sandbox.__xterms[1].disposed, true)
    assert.equal(all(tree, n => n.props?.className === 'dsb-term-tab').length, 1, 'both rapidly closed tabs stay removed')
    const remainingTab = all(tree, n => n.props?.className === 'dsb-term-tab')[0]
    assert.equal(remainingTab.props['data-active'], true, 'adjacent neighbor t-1 becomes active')

    // Late SSE chunks and late terminal-list entries for closed t-2/t-3 are ignored cleanly.
    const t2Before = sandbox.__xterms[1].written.length
    team.chat.emit('terminal', { id: 't-2', chunk: 'zombie output' })
    resolveLateList([
      { id: 't-1', cwd: '/repo', title: 'workspace', pty: true, snapshot: '' },
      { id: 't-2', cwd: '/repo', title: 'workspace', pty: true, snapshot: 'stale' },
      { id: 't-3', cwd: '/repo', title: 'workspace', pty: false, snapshot: 'stale' },
    ])
    await tick()
    tree = inst.render()
    assert.equal(sandbox.__xterms[1].written.length, t2Before)
    assert.equal(all(tree, n => n.props?.className === 'dsb-term-tab').length, 1, 'late terminal-list does not resurrect closed tabs')

    // Key handler lets macOS Cmd+C copy selection, Cmd+V paste natively, Cmd+K bubble, and Ctrl+C flow to PTY.
    const t1 = sandbox.__xterms[0]
    t1.selection = 'copied-line'
    const handler = createTerminalKeyHandler(t1, { mac: true, copy: text => sandbox.__copied.push(text) })
    assert.equal(handler({ type: 'keydown', metaKey: true, key: 'c', code: 'KeyC', preventDefault() {} }), false)
    assert.deepEqual(plain(sandbox.__copied), ['copied-line'])
    assert.equal(t1.hasSelection(), false)
    assert.equal(handler({ type: 'keydown', metaKey: true, key: 'v', code: 'KeyV' }), false)
    assert.equal(handler({ type: 'keydown', metaKey: true, key: 'k', code: 'KeyK' }), false)
    assert.equal(handler({ type: 'keydown', metaKey: true, key: ',', code: 'Comma' }), false)
    assert.equal(handler({ type: 'keydown', metaKey: true, shiftKey: true, key: 'M', code: 'KeyM' }), false)
    assert.equal(handler({ type: 'keydown', ctrlKey: true, key: '`', code: 'Backquote' }), false)
    assert.equal(handler({ type: 'keydown', ctrlKey: true, key: 'c', code: 'KeyC' }), true)
    assert.equal(handler({ type: 'keydown', ctrlKey: true, key: 'd', code: 'KeyD' }), true)
    // Non-Mac terminal handler bubbles custom F12 / Ctrl+` / Ctrl+Shift+M while preserving Ctrl+C/D/L for PTY,
    // and mirrors live capabilities so Bot-only bindings pass through to PTY in Classic Agent mode.
    const winHandler = createTerminalKeyHandler(t1, {
      mac: false,
      copy: text => sandbox.__copied.push(text),
      overrides: {
        terminal: { code: 'F12', mod: false, ctrl: false, alt: false, shift: false },
        browser: { code: 'F11', mod: false, ctrl: false, alt: false, shift: false },
      },
      getContext: () => ({ capabilities: { hasSurface: true, hasBrowser: false, hasInbox: false } }),
    })
    assert.equal(winHandler({ type: 'keydown', key: 'F12', code: 'F12' }), false)
    assert.equal(winHandler({ type: 'keydown', key: 'F11', code: 'F11' }), true, 'Bot-only F11 binding must pass through to PTY in Classic Agent mode')
    assert.equal(winHandler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'M', code: 'KeyM' }), false)
    assert.equal(winHandler({ type: 'keydown', ctrlKey: true, key: 'c', code: 'KeyC' }), true)
    assert.equal(winHandler({ type: 'keydown', ctrlKey: true, key: 'l', code: 'KeyL' }), true)

    // Direct unit check on local line editor Ctrl+C/Ctrl+D/Ctrl+L and theme reader fallback.
    const sent = []
    let eofs = 0
    const mockTerm = { written: [], cleared: 0, write(s) { this.written.push(s) }, clear() { this.cleared += 1 } }
    const editor = createLocalLineEditor(mockTerm, line => sent.push(line), () => { eofs += 1 })
    editor('ab')
    editor('\x03')
    assert.match(mockTerm.written.join(''), /\^C\r\n/)
    editor('\x04')
    assert.equal(eofs, 1)
    editor('\x0c')
    assert.equal(mockTerm.cleared, 1)
    const themed = readXtermTheme()
    assert.ok(themed.theme.background && themed.theme.foreground && themed.theme.cursor)
  } finally {
    inst.unmount()
  }
})

test('FileTree watches workspace changes, refreshes without losing expansion/selection/filter, and exposes context menu actions', async () => {
  const calls = []
  sandbox.__copied.length = 0
  winListeners.clear()
  docCaptureListeners.clear()
  let extraFileAdded = false
  let subDirTruncated = false
  let rootChanged = false
  sandbox.__testCall = async (endpoint, body) => {
    calls.push([endpoint, body])
    const curRoot = rootChanged ? '/repo-2' : '/repo'
    if (endpoint === 'workspace-watch') return { watchId: rootChanged ? 'w-2' : 'w-1', root: curRoot, recursive: true }
    if (endpoint === 'workspace-unwatch') return { ok: true }
    if (endpoint === 'workspace-open') return { ok: true }
    if (endpoint === 'workspace-list') {
      if (body.path === 'src') {
        const entries = [{ name: 'app.js', path: 'src/app.js', kind: 'file', size: 128, ext: '.js' }]
        if (extraFileAdded) entries.push({ name: 'added.js', path: 'src/added.js', kind: 'file', size: 64, ext: '.js' })
        return { root: curRoot, rootName: 'repo', path: 'src', truncated: subDirTruncated, entries }
      }
      const entries = [
        { name: 'src', path: 'src', kind: 'dir', size: 0, ext: '' },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 42, ext: '.md' },
      ]
      if (extraFileAdded) entries.push({ name: 'notes.md', path: 'notes.md', kind: 'file', size: 12, ext: '.md' })
      return { root: curRoot, rootName: 'repo', path: '', truncated: false, entries }
    }
    return {}
  }

  const team = createTeam()
  const openedFiles = []
  team.actions.openFile = target => openedFiles.push(target)

  const panel = mount(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['files'], tab: 'files' },
    team,
    visible: true,
  })
  try {
    panel.render()
    await tick()
    let tree = panel.render()
    assert.equal(calls.some(([ep]) => ep === 'workspace-watch'), true, 'subscribes to workspace-watch on mount')

    // Expand `src` directory.
    const srcBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-ft-row') && /src/.test(textOf(n)))[0]
    srcBtn.props.onClick()
    await tick()
    tree = panel.render()
    assert.match(textOf(tree), /app\.js/)

    // External file change triggers soft refresh without collapsing `src`.
    extraFileAdded = true
    team.chat.emit('workspace-changed', { root: '/repo', path: '' })
    await tick()
    await tick()
    tree = panel.render()
    assert.match(textOf(tree), /notes\.md/, 'root listing refreshed')
    assert.match(textOf(tree), /added\.js/, 'expanded subfolder refreshed while preserving expansion')

    // Open context menu on README.md -> verify actions, Show in folder, Copy path, Copy relative path.
    const readmeBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-ft-row') && /README\.md/.test(textOf(n)))[0]
    assert.ok(readmeBtn)
    readmeBtn.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 120, clientY: 160 })
    tree = panel.render()
    const menuItems = all(tree, n => n.type === 'button' && n.props?.role === 'menuitem')
    assert.deepEqual(menuItems.map(item => textOf(item).trim()), ['Open', 'Show in folder', 'Open in default app', 'Copy path', 'Copy relative path'])

    // Show in folder invokes workspace-open reveal WITH expectedRoot.
    menuItems[1].props.onClick()
    await tick()
    tree = panel.render()
    assert.equal(calls.some(([ep, b]) => ep === 'workspace-open' && b.path === 'README.md' && b.action === 'reveal' && b.expectedRoot === '/repo'), true)
    assert.equal(all(tree, n => n.props?.role === 'menu' && n.props?.['data-leaving'] === undefined).length, 0, 'menu closes after action')

    // Reopen context menu, Copy path & Copy relative path.
    readmeBtn.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 120, clientY: 160 })
    tree = panel.render()
    all(tree, n => n.type === 'button' && n.props?.role === 'menuitem')[3].props.onClick()
    await tick()
    assert.equal(sandbox.__copied.at(-1), '/repo/README.md')

    readmeBtn.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 120, clientY: 160 })
    tree = panel.render()
    all(tree, n => n.type === 'button' && n.props?.role === 'menuitem')[4].props.onClick()
    await tick()
    assert.equal(sandbox.__copied.at(-1), 'README.md')

    // Folder context menu offers Collapse/Expand and Escape dismisses menu via useEscape (document capture).
    const srcRow = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-ft-row') && /src/.test(textOf(n)))[0]
    srcRow.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 })
    tree = panel.render()
    const dirItems = all(tree, n => n.type === 'button' && n.props?.role === 'menuitem')
    assert.equal(textOf(dirItems[0]).trim(), 'Collapse')

    const escEvt = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
    for (const fn of [...(docCaptureListeners.get('keydown') ?? [])]) fn(escEvt)
    for (const fn of [...(winListeners.get('keydown') ?? [])]) fn(escEvt)
    tree = panel.render()
    assert.equal(all(tree, n => n.props?.role === 'menu' && n.props?.['data-leaving'] === undefined).length, 0, 'Escape dismisses file tree context menu')

    // Clean resumed hello does NOT trigger a redundant full tree refresh or watch re-registration.
    const listsBeforeResumed = calls.filter(([ep]) => ep === 'workspace-list').length
    const watchesBeforeResumed = calls.filter(([ep]) => ep === 'workspace-watch').length
    team.chat.emit('hello', { resumed: true })
    await tick()
    await tick()
    assert.equal(calls.filter(([ep]) => ep === 'workspace-list').length, listsBeforeResumed, 'hello { resumed: true } must not refresh file tree')
    assert.equal(calls.filter(([ep]) => ep === 'workspace-watch').length, watchesBeforeResumed, 'hello { resumed: true } must not re-register workspace watch')

    // SSE 'hello' (resumed: false) renews workspace-watch (in case orphan cleanup expired it) and refreshes tree.
    const listsBeforeHello = calls.filter(([ep]) => ep === 'workspace-list').length
    const watchesBeforeHello = calls.filter(([ep]) => ep === 'workspace-watch').length
    subDirTruncated = true
    team.chat.emit('hello', {})
    await tick()
    await tick()
    tree = panel.render()
    assert.ok(calls.filter(([ep]) => ep === 'workspace-list').length > listsBeforeHello, 'SSE hello triggers tree catch-up refresh')
    assert.ok(calls.filter(([ep]) => ep === 'workspace-watch').length > watchesBeforeHello, 'unresumed SSE hello renews workspace watch')
    assert.match(textOf(tree), /Showing first 500 entries/, 'truncated subfolder renders visible truncation notice')

    // Toggling "Show hidden" must NOT tear down or restart the OS watcher!
    const watchesBeforeHidden = calls.filter(([ep]) => ep === 'workspace-watch').length
    const unwatchesBeforeHidden = calls.filter(([ep]) => ep === 'workspace-unwatch').length
    const hiddenBtn = all(tree, n => n.type === 'button' && /Show hidden|Hide dotfiles/.test(textOf(n)))[0]
    assert.ok(hiddenBtn)
    hiddenBtn.props.onClick()
    await tick()
    tree = panel.render()
    assert.equal(calls.filter(([ep]) => ep === 'workspace-watch').length, watchesBeforeHidden, 'Show hidden toggle must not recreate OS watch')
    assert.equal(calls.filter(([ep]) => ep === 'workspace-unwatch').length, unwatchesBeforeHidden)

    // Hiding the panel stops watching (workspace-unwatch), and showing it again restarts watching.
    panel.render({ sessionId: 'b1', panel: { tabs: ['files'], tab: 'files' }, team, visible: false })
    await tick()
    assert.ok(calls.filter(([ep]) => ep === 'workspace-unwatch').length > unwatchesBeforeHidden, 'hidden panel unsubscribes OS watch')
  } finally {
    panel.unmount()
  }
  assert.equal(calls.some(([ep]) => ep === 'workspace-unwatch'), true, 'unmount cleans up workspace-unwatch')
})

test('FilePreview renders SpreadsheetPreview with sheet tabs, merges, formula bar, numeric cells, and truncation notices', () => {
  const wb = {
    kind: 'spreadsheet',
    name: 'budget.xlsx',
    path: 'budget.xlsx',
    size: 4096,
    truncatedSheets: true,
    totalSheets: 42,
    sheets: [
      {
        name: 'Summary',
        rowCount: 2,
        colCount: 3,
        totalRows: 600,
        totalCols: 3,
        truncatedRows: true,
        truncatedCols: false,
        merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }],
        rows: [
          [{ v: 'Q4 Report' }, null, { v: 'Status' }],
          [{ v: '42', num: true }, { v: '84', f: '=A2*2', num: true }, { v: '#DIV/0!', err: true }],
        ],
      },
      {
        name: 'Details',
        rowCount: 1,
        colCount: 2,
        totalRows: 1,
        totalCols: 2,
        truncatedRows: false,
        truncatedCols: false,
        merges: [],
        rows: [
          [{ v: 'Item' }, { v: 'Notes' }],
        ],
      },
    ],
  }
  const view = mount(FilePreview, { file: wb })
  try {
    let tree = view.render()
    const tabs = all(tree, n => n.type === 'button' && n.props?.role === 'tab')
    assert.deepEqual(tabs.map(tab => textOf(tab).trim()), ['Summary', 'Details'])
    assert.equal(tabs[0].props['aria-selected'], true)

    // Truncation notices are visible (never silent caps).
    const bodyText = textOf(tree)
    assert.match(bodyText, /Showing first 2 of 600 rows/)
    assert.match(bodyText, /Showing first 2 of 42 sheets/)

    // Merged cell gets colSpan=2, numeric cell gets is-num, formula cell gets has-formula, error cell gets is-err.
    const cells = all(tree, n => n.type === 'td' && String(n.props?.className ?? '').includes('dsb-pv-sheet-cell'))
    assert.equal(cells[0].props.colSpan, 2)
    assert.match(cells[2].props.className, /\bis-num\b/)
    assert.match(cells[3].props.className, /\bhas-formula\b/)
    assert.match(cells[4].props.className, /\bis-err\b/)

    // Clicking formula cell shows `B2` and `=A2*2` in the formula bar.
    cells[3].props.onClick()
    tree = view.render()
    assert.match(textOf(tree), /B2/)
    assert.match(textOf(tree), /=A2\*2/)

    // Switching to Details sheet renders Details cells.
    const detailsTab = all(tree, n => n.type === 'button' && n.props?.role === 'tab')[1]
    detailsTab.props.onClick()
    tree = view.render()
    assert.match(textOf(tree), /Item/)
    assert.match(textOf(tree), /Notes/)

    // Switching from populated workbook -> empty workbook (0 sheets) -> populated workbook with size truncation must NOT violate Rules of Hooks!
    tree = view.render({ file: { kind: 'spreadsheet', name: 'empty.xlsx', path: 'empty.xlsx', size: 128, sheets: [] } })
    assert.match(textOf(tree), /Empty file/)
    tree = view.render({
      file: {
        kind: 'spreadsheet',
        name: 'big.xlsx',
        path: 'big.xlsx',
        size: 999999,
        truncatedText: true,
        sheets: [{
          name: 'Stream',
          rowCount: 2,
          colCount: 1,
          totalRows: null,
          totalCols: 1,
          truncatedRows: true,
          truncatedCols: false,
          truncatedBySize: true,
          merges: [],
          rows: [[{ v: 'R1' }], [{ v: 'R2' }]],
        }],
      },
    })
    assert.match(textOf(tree), /Showing first 2 rows/)
    assert.match(textOf(tree), /Preview truncated for size/)
  } finally {
    view.unmount()
  }
})

test('WorkspacePaneBody plugin tab Retry calls runtime.retry(), FileTree syncs mid-flight Linux expansions, and pagehide unwatch uses relative credentials fetch', async () => {
  // 1. Crashing `sidebar.right.pane.tab` plugin registered via runtime.use() recovers when clicking Retry.
  const reg = createSlotRegistry()
  const runtime = createPluginRuntime({ slots: reg })
  let applyCount = 0
  let onRetryCalls = 0
  let resetCalls = 0
  let shouldCrash = true

  runtime.use({ id: 'ext.crash-tab' }, (ctx) => {
    applyCount += 1
    const TabComp = () => {
      if (shouldCrash) throw new Error('right pane plugin crash')
      return { type: 'div', props: { className: 'recovered-tab', children: [`tab-gen-${applyCount}`] } }
    }
    TabComp.reset = () => { resetCalls += 1 }
    ctx.slot({
      name: RIGHT_PANE_TAB_SLOT,
      id: 'crash-tab',
      meta: { label: 'Crash Tab' },
      onRetry: () => { onRetryCalls += 1 },
    }, TabComp)
  })
  assert.equal(applyCount, 1)

  const team = createTeam()
  const tabInst = mount(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['plugin:crash-tab'], tab: 'plugin:crash-tab' },
    team,
    registry: reg,
    visible: true,
  })
  try {
    let tree = tabInst.render()
    const retryBtn = all(tree, n => n.type === 'button' && /Retry/.test(textOf(n)))[0]
    assert.ok(retryBtn, 'WorkspacePaneBody renders SlotErrorBoundary Retry button')
    shouldCrash = false
    retryBtn.props.onClick()
    assert.equal(applyCount, 2, 'WorkspacePaneBody Retry must invoke runtime.retry() using top-level entry.pluginId/runtime')
    assert.equal(resetCalls, 1, 'WorkspacePaneBody Retry calls component.reset()')
    assert.equal(onRetryCalls, 1, 'WorkspacePaneBody Retry calls entry.onRetry()')
    tree = tabInst.render()
    assert.match(textOf(tree), /tab-gen-2/)
  } finally {
    tabInst.unmount()
  }

  // 2. Linux (recursive: false) mid-flight folder expansion syncs immediately when initial workspace-watch resolves,
  //    and pagehide unwatch uses document-relative `api/bot` with `credentials: 'same-origin'`.
  const watchCalls = []
  const fetchCalls = []
  const prevFetch = sandbox.fetch
  sandbox.fetch = (url, init) => { fetchCalls.push([url, init]); return Promise.resolve({}) }
  winListeners.clear()
  let resolveInitialWatch
  sandbox.__testCall = (endpoint, body) => {
    if (endpoint === 'workspace-watch') {
      watchCalls.push(body)
      if (!body.watchId) {
        return new Promise((resolve) => { resolveInitialWatch = resolve })
      }
      return Promise.resolve({ watchId: body.watchId, root: '/repo', recursive: false })
    }
    if (endpoint === 'workspace-unwatch') return Promise.resolve({ ok: true })
    if (endpoint === 'workspace-list') {
      return Promise.resolve({
        root: '/repo',
        rootName: 'repo',
        path: body.path ?? '',
        truncated: false,
        entries: body.path === 'src'
          ? [{ name: 'index.js', path: 'src/index.js', kind: 'file', size: 10, ext: '.js' }]
          : [{ name: 'src', path: 'src', kind: 'dir', size: 0, ext: '' }],
      })
    }
    return Promise.resolve({})
  }

  const ftInst = mount(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['files'], tab: 'files' },
    team,
    visible: true,
  })
  try {
    ftInst.render()
    await tick()
    let tree = ftInst.render()
    assert.equal(watchCalls.length >= 1, true, 'initial workspace-watch started')
    // Expand `src` BEFORE initial workspace-watch has resolved!
    const srcBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-ft-row') && /src/.test(textOf(n)))[0]
    assert.ok(srcBtn)
    srcBtn.props.onClick()
    await tick()
    tree = ftInst.render()
    assert.match(textOf(tree), /index\.js/)

    // Now resolve the initial watch as Linux non-recursive -> must immediately send follow-up watch with dirs: ['src']!
    resolveInitialWatch({ watchId: 'w-linux', root: '/repo', recursive: false })
    await tick()
    assert.equal(
      watchCalls.some(c => c.watchId === 'w-linux' && Array.isArray(c.dirs) && c.dirs.includes('src')),
      true,
      'folder expanded while initial Linux watch was in flight must be synced once watchId resolves',
    )

    // Verify pagehide unwatch uses document-relative `api/bot` and `credentials: 'same-origin'`.
    for (const fn of [...(winListeners.get('pagehide') ?? [])]) fn()
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0][0], 'api/bot')
    assert.equal(fetchCalls[0][1].credentials, 'same-origin')
  } finally {
    ftInst.unmount()
    if (prevFetch === undefined) delete sandbox.fetch
    else sandbox.fetch = prevFetch
  }
})

test('WorkspaceTerminal does not steal focus when hidden or while user is typing in the chat composer', async () => {
  sandbox.__xterms.length = 0
  let openCalls = 0
  let listPayload = [{ id: 'term-bg', cwd: '/repo', title: 'repo', pty: true, start: 1, end: 0, parts: [], truncated: false, exited: false, exitCode: null }]
  sandbox.__testCall = async (endpoint) => {
    if (endpoint === 'terminal-list') return listPayload
    if (endpoint === 'terminal-open') {
      openCalls += 1
      return { id: `term-opened-${openCalls}`, cwd: '/repo', title: 'repo', cols: 88, rows: 26, pty: true }
    }
    return {}
  }
  const team = createTeam()

  // 1. Hidden terminal pane (active: false) must never call xterm.focus(), even on SSE hello sync.
  const hiddenTerm = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, active: false })
  try {
    hiddenTerm.render()
    await tick()
    hiddenTerm.render()
    assert.equal(openCalls, 0, 'real array terminal-list contract must not trigger terminal-open')
    assert.equal(sandbox.__xterms.length, 1)
    assert.equal(sandbox.__xterms[0].focused, 0, 'hidden terminal must not steal focus on mount')
    team.chat.emit('hello', {})
    await tick()
    hiddenTerm.render()
    assert.equal(sandbox.__xterms[0].focused, 0, 'hidden terminal must not steal focus on SSE hello reconnect')
  } finally {
    hiddenTerm.unmount()
  }

  // 2. Visible terminal pane must not yank focus away from an active chat composer textarea on async sync,
  //    and once an explicit focusNonce is consumed, later synced terminals must not steal focus either.
  sandbox.__xterms.length = 0
  const prevActive = sandbox.document.activeElement
  sandbox.document.activeElement = { closest: sel => (sel.includes('data-bt-composer-input') ? {} : null) }
  const visibleTerm = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, active: true, focusNonce: 1 })
  try {
    visibleTerm.render()
    await tick()
    visibleTerm.render()
    assert.equal(sandbox.__xterms.length, 1)
    assert.equal(sandbox.__xterms[0].focused, 1, 'explicit focusNonce focuses the active terminal once')
    // Now SSE hello syncs a newly discovered terminal while user is back in composer: must NOT steal focus!
    listPayload = [
      ...listPayload,
      { id: 'term-bg-2', cwd: '/repo', title: 'repo', pty: true, start: 1, end: 0, parts: [], truncated: false, exited: false, exitCode: null },
    ]
    team.chat.emit('hello', {})
    await tick()
    visibleTerm.render()
    assert.equal(sandbox.__xterms.length, 2)
    assert.equal(sandbox.__xterms[1].focused, 0, 'consumed focusNonce must not let a later synced terminal steal composer focus')
  } finally {
    sandbox.document.activeElement = prevActive
    visibleTerm.unmount()
  }

  // 3. Clicking "New terminal" while an existing terminal is active must NOT refocus the old terminal
  //    while `terminal-open` is pending, and MUST focus the newly created terminal once it resolves
  //    (even when Chromium still reports the old hidden terminal's textarea as `document.activeElement`).
  sandbox.__xterms.length = 0
  let resolvePendingOpen
  const singleList = [{ id: 'term-old', cwd: '/repo-a', title: 'repo-a', pty: true, start: 1, end: 0, parts: [], truncated: false, exited: false, exitCode: null }]
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return Promise.resolve(singleList)
    if (endpoint === 'terminal-open') return new Promise(resolve => { resolvePendingOpen = resolve })
    return Promise.resolve({})
  }
  const newTermInst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, active: true })
  try {
    newTermInst.render()
    await tick()
    let tree = newTermInst.render()
    assert.equal(sandbox.__xterms.length, 1)
    const oldXterm = sandbox.__xterms[0]
    const initialOldFocus = oldXterm.focused
    // Model real Chromium: old terminal's xterm textarea remains document.activeElement until next frame.
    const prevActiveEl = sandbox.document.activeElement
    sandbox.document.activeElement = {
      tagName: 'TEXTAREA',
      closest: sel => (sel.includes('textarea') ? {} : null),
    }
    try {
      const plusBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'New terminal')[0]
      assert.ok(plusBtn)
      plusBtn.props.onClick()
      newTermInst.render()
      assert.equal(oldXterm.focused, initialOldFocus, 'old terminal must NOT be refocused while terminal-open is in flight')

      resolvePendingOpen({ id: 'term-new', cwd: '/repo-b', title: 'repo-b', cols: 88, rows: 26, pty: true })
      await tick()
      newTermInst.render()
      assert.equal(sandbox.__xterms.length, 2)
      assert.equal(oldXterm.focused, initialOldFocus, 'old terminal must still not receive focus when new terminal mounts')
      assert.equal(sandbox.__xterms[1].focused, 1, 'new terminal must receive explicit focus even while old xterm textarea is activeElement')
    } finally {
      sandbox.document.activeElement = prevActiveEl
    }
  } finally {
    newTermInst.unmount()
  }

  // 4. Consuming an external shortcut focusNonce notifies parent so unmounting/remounting
  //    a folded workspace panel never steals focus from an active composer.
  sandbox.__xterms.length = 0
  sandbox.__testCall = async (endpoint) => (endpoint === 'terminal-list' ? singleList : {})
  let parentFocusNonce = 1
  const onConsumeFocusNonce = (nonce) => {
    if (parentFocusNonce === nonce) parentFocusNonce = 0
  }
  const prevActive4 = sandbox.document.activeElement
  sandbox.document.activeElement = { closest: sel => (sel.includes('data-bt-composer-input') ? {} : null) }
  const firstMount = mount(WorkspaceTerminal, {
    sessionId: 'b1',
    feed: team.chat,
    active: true,
    focusNonce: parentFocusNonce,
    onConsumeFocusNonce,
  })
  try {
    firstMount.render()
    await tick()
    firstMount.render()
    assert.equal(sandbox.__xterms[0].focused, 1, 'initial Ctrl+` focuses active terminal')
    assert.equal(parentFocusNonce, 0, 'parent focusNonce is cleared once handled by visible terminal')
  } finally {
    firstMount.unmount()
  }
  // Panel folds away and later remounts while user is typing in chat composer.
  sandbox.__xterms.length = 0
  const remounted = mount(WorkspaceTerminal, {
    sessionId: 'b1',
    feed: team.chat,
    active: true,
    focusNonce: parentFocusNonce,
    onConsumeFocusNonce,
  })
  try {
    remounted.render()
    await tick()
    remounted.render()
    assert.equal(sandbox.__xterms.length, 1)
    assert.equal(sandbox.__xterms[0].focused, 0, 'remounted folded workspace panel must not steal composer focus')
  } finally {
    sandbox.document.activeElement = prevActive4
    remounted.unmount()
  }

  // 5. Consuming autoOpenNonce clears rightPanel.terminalNonce so unmounting and remounting
  //    WorkspaceTerminal does not spawn an extra PTY or steal composer focus; and an in-flight
  //    openNew({ focus: true }) that resolves while paneVisible=false does not leave a stale focus request.
  sandbox.__xterms.length = 0
  let autoOpenCalls = 0
  let resolveHiddenOpen
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return Promise.resolve(singleList)
    if (endpoint === 'terminal-open') {
      autoOpenCalls += 1
      if (autoOpenCalls === 1) {
        return Promise.resolve({ id: 'term-auto-1', cwd: '/repo', title: 'repo', cols: 88, rows: 26, pty: true })
      }
      return new Promise(resolve => { resolveHiddenOpen = resolve })
    }
    return Promise.resolve({})
  }
  const team5 = createTeam()
  team5.actions.newTerminal()
  const uiProbe5 = mount(() => ({ type: 'probe', props: team5.hooks.useUi(s => s.rightPanel) }), {})
  const firstNonce = uiProbe5.render().props.terminalNonce
  assert.ok(firstNonce > 0)
  const prevActive5 = sandbox.document.activeElement
  sandbox.document.activeElement = { closest: sel => (sel.includes('data-bt-composer-input') ? {} : null) }
  const autoInst = mount(WorkspaceTerminal, {
    sessionId: 'b1',
    feed: team5.chat,
    active: true,
    autoOpenNonce: firstNonce,
    onConsumeAutoOpenNonce: nonce => team5.actions.consumeTerminalNonce(nonce),
  })
  try {
    autoInst.render()
    await tick()
    autoInst.render()
    assert.equal(autoOpenCalls, 1)
    assert.equal(uiProbe5.render().props.terminalNonce, 0, 'autoOpenNonce must be cleared once consumed')
  } finally {
    autoInst.unmount()
  }
  // Remount with the cleared terminalNonce while typing in composer -> no extra PTY, no focus steal!
  sandbox.__xterms.length = 0
  const remountAuto = mount(WorkspaceTerminal, {
    sessionId: 'b1',
    feed: team5.chat,
    active: true,
    autoOpenNonce: uiProbe5.render().props.terminalNonce,
    onConsumeAutoOpenNonce: nonce => team5.actions.consumeTerminalNonce(nonce),
  })
  try {
    remountAuto.render()
    await tick()
    remountAuto.render()
    assert.equal(autoOpenCalls, 1, 'remounting after consumed autoOpenNonce must not spawn a duplicate PTY')
    assert.equal(sandbox.__xterms.every(x => x.focused === 0), true, 'remounting after consumed autoOpenNonce must not steal composer focus')

    // Trigger New terminal, then hide the pane before terminal-open resolves; when shown again later
    // while composer is focused, it must not steal focus.
    const plusBtn = all(remountAuto.render(), n => n.type === 'button' && n.props?.['aria-label'] === 'New terminal')[0]
    plusBtn.props.onClick()
    remountAuto.render({
      sessionId: 'b1',
      feed: team5.chat,
      active: false,
      autoOpenNonce: 0,
      onConsumeAutoOpenNonce: nonce => team5.actions.consumeTerminalNonce(nonce),
    })
    resolveHiddenOpen({ id: 'term-hidden-2', cwd: '/repo', title: 'repo', cols: 88, rows: 26, pty: true })
    await tick()
    remountAuto.render({
      sessionId: 'b1',
      feed: team5.chat,
      active: false,
      autoOpenNonce: 0,
      onConsumeAutoOpenNonce: nonce => team5.actions.consumeTerminalNonce(nonce),
    })
    remountAuto.render({
      sessionId: 'b1',
      feed: team5.chat,
      active: true,
      autoOpenNonce: 0,
      onConsumeAutoOpenNonce: nonce => team5.actions.consumeTerminalNonce(nonce),
    })
    assert.equal(sandbox.__xterms.every(x => x.focused === 0), true, 'openNew resolving while pane is hidden must not steal composer focus when later shown')
  } finally {
    sandbox.document.activeElement = prevActive5
    remountAuto.unmount()
    uiProbe5.unmount()
  }
})

test('FileTree runs full-workspace batched search, supports cancellation, and surfaces incomplete notices', async () => {
  const calls = []
  let batch = 0
  let resolveSecondBatch
  sandbox.__testCall = (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint === 'workspace-watch') return Promise.resolve({ watchId: 'w-search', root: '/repo', recursive: true })
    if (endpoint === 'workspace-unwatch') return Promise.resolve({ ok: true })
    if (endpoint === 'workspace-list') {
      return Promise.resolve({
        root: '/repo',
        rootName: 'repo',
        path: '',
        truncated: false,
        entries: [{ name: 'src', path: 'src', kind: 'dir', size: 0, ext: '' }],
      })
    }
    if (endpoint === 'workspace-search') {
      if (body.cancel === true) return Promise.resolve({ ok: true, cancelled: true })
      if (body.query === 'deep') {
        batch += 1
        return Promise.resolve({
          root: '/repo',
          searchId: 'srch-1',
          done: false,
          entries: [{ name: 'deep-a.js', path: 'src/unexpanded/deep-a.js', kind: 'file', size: 40, ext: '.js' }],
          incomplete: false,
          incompleteReasons: [],
        })
      }
      if (body.searchId === 'srch-1') {
        return new Promise((resolve) => { resolveSecondBatch = resolve })
      }
      if (body.query === 'perm') {
        return Promise.resolve({
          root: '/repo',
          searchId: null,
          done: true,
          entries: [{ name: 'ok.js', path: 'src/ok.js', kind: 'file', size: 12, ext: '.js' }],
          incomplete: true,
          incompleteReasons: ['permission'],
        })
      }
    }
    return Promise.resolve({})
  }

  const team = createTeam()
  const inst = mount(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['files'], tab: 'files' },
    team,
    visible: true,
  })
  try {
    inst.render()
    await tick()
    let tree = inst.render()
    const input = all(tree, n => n.type === 'input' && n.props?.className === 'dsb-ft-search-input')[0]
    assert.ok(input)

    // Typing 'deep' triggers workspace-search (finds unexpanded nested file without expanding src).
    input.props.onChange({ target: { value: 'deep' } })
    inst.render()
    await tick()
    tree = inst.render()
    assert.equal(batch, 1)
    assert.match(textOf(tree), /deep-a\.js/, 'renders first streamed batch immediately')
    assert.match(textOf(tree), /src\/unexpanded/, 'shows parent path for search hit')
    const cancelBtn = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-ft-search-cancel')[0]
    assert.ok(cancelBtn, 'shows Cancel button while multi-batch search is in progress')

    // Resolve second batch -> appends seamlessly and completes.
    resolveSecondBatch({
      root: '/repo',
      searchId: null,
      done: true,
      entries: [{ name: 'deep-b.js', path: 'src/unexpanded/deep-b.js', kind: 'file', size: 22, ext: '.js' }],
      incomplete: false,
      incompleteReasons: [],
    })
    await tick()
    tree = inst.render()
    assert.match(textOf(tree), /deep-a\.js/)
    assert.match(textOf(tree), /deep-b\.js/)
    assert.match(textOf(tree), /2 matches/)

    // Starting another multi-batch search and clicking Cancel keeps partial matches and shows incomplete notice.
    input.props.onChange({ target: { value: '' } })
    inst.render()
    input.props.onChange({ target: { value: 'deep' } })
    inst.render()
    await tick()
    tree = inst.render()
    const cancelBtn2 = all(tree, n => n.type === 'button' && n.props?.className === 'dsb-ft-search-cancel')[0]
    assert.ok(cancelBtn2)
    cancelBtn2.props.onClick()
    tree = inst.render()
    assert.match(textOf(tree), /Search cancelled/, 'cancellation clearly flags partial results')
    assert.match(textOf(tree), /deep-a\.js/, 'partial matches stay visible after cancel')
    assert.equal(calls.some(([ep, b]) => ep === 'workspace-search' && b.cancel === true && b.searchId === 'srch-1'), true)

    // Permission-incomplete search surfaces explicit notice.
    input.props.onChange({ target: { value: 'perm' } })
    inst.render()
    await tick()
    tree = inst.render()
    assert.match(textOf(tree), /Some folders could not be read/)
  } finally {
    inst.unmount()
  }
})

test('FilePreview virtualizes large code files, toggles word wrap, zooms images and PDFs, and shows live update reload + auto-refresh switch', () => {
  // 1. Virtualized CodeLines: 5,000-line file renders only a bounded viewport slice, not all 5,000 rows.
  const win = computeCodeWindow({ lineCount: 5000, scrollTop: 0, viewportHeight: 570, lineHeight: 19, overscan: 20 })
  assert.equal(win.start, 0)
  assert.equal(win.end, 50)
  assert.equal(win.topPad, 0)
  assert.equal(win.bottomPad, 4950 * 19)

  const bigText = Array.from({ length: 5000 }, (_, i) => `const line_${i + 1} = ${i + 1}`).join('\n')
  let reloadClicks = 0
  let autoToggleClicks = 0
  const codeView = mount(FilePreview, {
    file: { kind: 'code', language: 'javascript', name: 'big.js', path: 'src/big.js', size: bigText.length, text: bigText },
    updated: true,
    onReload: () => { reloadClicks += 1 },
    autoRefresh: false,
    onToggleAutoRefresh: () => { autoToggleClicks += 1 },
  })
  try {
    let tree = codeView.render()
    const lineRows = all(tree, n => n.type === 'tr' && n.props?.['data-line'] !== undefined)
    assert.ok(lineRows.length > 0 && lineRows.length < 150, `virtualized 5000-line file must mount < 150 rows (got ${lineRows.length})`)
    assert.equal(lineRows[0].props['data-line'], 1)

    // Scrolling down shifts the virtual window to the scrolled range.
    const wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    assert.equal(wrapDiv.props['data-virtualized'], '')
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 19 * 2500 } })
    tree = codeView.render()
    const scrolledRows = all(tree, n => n.type === 'tr' && n.props?.['data-line'] !== undefined)
    assert.ok(scrolledRows[0].props['data-line'] > 2400 && scrolledRows[0].props['data-line'] < 2520, 'scroll updates rendered line window')

    // Word wrap toggle toggles data-wrap and aria-pressed.
    const wrapBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0]
    assert.ok(wrapBtn)
    assert.equal(wrapBtn.props['aria-pressed'], false)
    wrapBtn.props.onClick()
    tree = codeView.render()
    assert.equal(all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props['data-wrap'], '')

    // Live update banner & Auto-refresh switch.
    const reloadBtn = all(tree, n => n.type === 'button' && /Updated · Reload/.test(textOf(n)))[0]
    assert.ok(reloadBtn, 'shows Updated · Reload button when file changed')
    reloadBtn.props.onClick()
    assert.equal(reloadClicks, 1)

    const autoSwitch = all(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Auto-refresh')[0]
    assert.ok(autoSwitch, 'renders Auto-refresh switch')
    assert.equal(autoSwitch.props['aria-checked'], false)
    autoSwitch.props.onClick()
    assert.equal(autoToggleClicks, 1)
  } finally {
    codeView.unmount()
  }

  // 2. Image zoom controls step cleanly from Fit -> 125% -> Fit.
  const imgView = mount(FilePreview, {
    file: { kind: 'image', name: 'logo.png', path: 'logo.png', size: 64, mime: 'image/png', base64: 'AP+AAQ==' },
  })
  try {
    imgView.render()
    let tree = imgView.render()
    assert.equal(all(tree, n => n.props?.['data-zoom'] === 'fit').length, 1)
    const zoomIn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Zoom in')[0]
    zoomIn.props.onClick()
    tree = imgView.render()
    assert.equal(all(tree, n => n.props?.['data-zoom'] === '125').length, 1)
    const resetBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Reset zoom')[0]
    resetBtn.props.onClick()
    tree = imgView.render()
    assert.equal(all(tree, n => n.props?.['data-zoom'] === 'fit').length, 1)
  } finally {
    imgView.unmount()
  }

  // 3. PDF zoom controls update iframe #zoom fragment.
  const pdfView = mount(FilePreview, {
    file: { kind: 'pdf', name: 'doc.pdf', path: 'doc.pdf', size: 128, mime: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') },
  })
  try {
    pdfView.render()
    let tree = pdfView.render()
    const zoomIn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Zoom in')[0]
    zoomIn.props.onClick()
    tree = pdfView.render()
    const iframe = all(tree, n => n.type === 'iframe')[0]
    assert.match(String(iframe.props.src), /#zoom=125$/)
  } finally {
    pdfView.unmount()
  }
})

test('Multi-preview tabs stay open side-by-side, follow workspace-changed live updates, and plugin tabs mount lazily and keep state across switches', async () => {
  let versionA = 1
  const readCalls = []
  sandbox.__testCall = async (endpoint, body) => {
    if (endpoint === 'workspace-watch') return { watchId: 'w-pv', root: '/repo', recursive: true }
    if (endpoint === 'workspace-unwatch') return { ok: true }
    if (endpoint === 'workspace-read') {
      readCalls.push(body.path)
      if (body.path === 'src/index.js') {
        return { kind: 'code', language: 'javascript', name: 'index.js', path: body.path, size: 32, text: `// a-v${versionA}` }
      }
      return { kind: 'code', language: 'javascript', name: 'index.js', path: body.path, size: 32, text: '// b-v1' }
    }
    return {}
  }

  const team = createTeam()
  team.actions.openSession('b1')
  team.actions.openFile({ path: 'src/index.js', root: '/repo' })
  team.actions.openFile({ path: 'test/index.js', root: '/repo' })

  const uiProbe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => s.rightPanel) }), {})
  const reg = createSlotRegistry()
  let pluginMounts = 0
  let pluginUnmounts = 0
  function StatefulPlugin() {
    const [count, setCount] = react.useState(0)
    react.useEffect(() => {
      pluginMounts += 1
      return () => { pluginUnmounts += 1 }
    }, [])
    return react.createElement('button', { type: 'button', className: 'plugin-counter', onClick: () => setCount(c => c + 1) }, `count:${count}`)
  }
  reg.register({ name: RIGHT_PANE_TAB_SLOT, id: 'stateful', meta: { label: 'Stateful' } }, StatefulPlugin)

  try {
    let rp = uiProbe.render().props
    const tabs = buildWorkspaceTabs(rp, reg.list(RIGHT_PANE_TAB_SLOT))
    assert.equal(tabs.length, 2, 'opening two files keeps both preview tabs open without overwriting')
    assert.deepEqual(plain(tabs.map(t => t.label)), ['src/index.js', 'test/index.js'], 'colliding basenames are disambiguated')
    assert.equal(tabs.some(t => t.id === 'plugin:stateful'), false, 'unopened plugin tab is not pinned in tab strip')

    const body = mount(WorkspacePaneBody, { sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
    try {
      body.render()
      await tick()
      let tree = body.render()
      assert.equal(pluginMounts, 0, 'unopened plugin tab is never mounted')
      assert.match(textOf(tree), /\/\/ a-v1/)
      assert.match(textOf(tree), /\/\/ b-v1/)

      // Switch to src/index.js tab, emit workspace-changed -> shows Updated · Reload when auto-refresh is off.
      const tabA = rp.tabs[0]
      team.actions.setRightPanelTab(tabA)
      rp = uiProbe.render().props
      body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      await tick()
      versionA = 2
      team.chat.emit('workspace-changed', { root: '/repo', paths: ['src/index.js'] })
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      const reloadBtn = all(tree, n => n.type === 'button' && /Updated · Reload/.test(textOf(n)))[0]
      assert.ok(reloadBtn, 'matching workspace-changed marks preview updated')

      // Clicking reload fetches v2 cleanly.
      reloadBtn.props.onClick()
      await tick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.match(textOf(tree), /\/\/ a-v2/)

      // Turning on Auto-refresh reloads automatically on the next workspace-changed without needing manual click.
      const autoSwitch = all(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Auto-refresh')[0]
      autoSwitch.props.onClick()
      body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      versionA = 3
      team.chat.emit('workspace-changed', { root: '/repo', paths: ['src/index.js'] })
      await tick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.match(textOf(tree), /\/\/ a-v3/, 'auto-refresh reloads file silently on workspace-changed')

      // Open plugin tab -> mounts once, retains state across switching away and back, unmounts on close.
      team.actions.setRightPanelTab('plugin:stateful')
      rp = uiProbe.render().props
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.equal(pluginMounts, 1)
      const counterBtn = all(tree, n => n.type === 'button' && n.props?.className === 'plugin-counter')[0]
      counterBtn.props.onClick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.match(textOf(tree), /count:1/)

      // Switch back to preview tab -> plugin tab stays mounted (hidden), does not unmount.
      team.actions.setRightPanelTab(tabA)
      rp = uiProbe.render().props
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      const hiddenPluginPane = all(tree, n => n.props?.['data-plugin-tab'] === 'plugin:stateful')
      assert.equal(hiddenPluginPane.length, 1, 'switching away keeps plugin pane mounted in DOM')
      assert.equal(hiddenPluginPane[0].props.hidden, true, 'inactive plugin pane is hidden')
      assert.equal(pluginUnmounts, 0, 'switching away from plugin tab must not unmount it')

      // Switch back to plugin tab -> state `count:1` is preserved.
      team.actions.setRightPanelTab('plugin:stateful')
      rp = uiProbe.render().props
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.match(textOf(tree), /count:1/, 'plugin tab state survives switching away and back')
      assert.equal(pluginMounts, 1)

      // Closing plugin tab removes it from rendered panes.
      team.actions.closeWorkspaceTab('plugin:stateful')
      rp = uiProbe.render().props
      tree = body.render({ sessionId: 'b1', panel: rp, team, registry: reg, visible: true })
      assert.equal(all(tree, n => n.props?.['data-plugin-tab'] === 'plugin:stateful').length, 0, 'closing plugin tab unmounts its pane')
    } finally {
      body.unmount()
    }
  } finally {
    uiProbe.unmount()
  }
})

test('CodeLines jumps once to targetLine, renders scrolled rows without blanking, and never jumps back on scroll, resize, or wrap toggle', () => {
  sandbox.localStorage.removeItem('dsb.preview.wrap')
  const lineCount = 2400
  const longText = Array.from({ length: lineCount }, (_, i) => `export const row_${i + 1} = ${i + 1}`).join('\n')
  const file = { kind: 'code', language: 'javascript', name: 'long.js', path: 'src/long.js', size: longText.length, text: longText }

  const prevObsCount = resizeObservers.length
  const view = mount(FilePreview, { file, line: 1000 })
  try {
    // Initial render already includes line 1000 via initial scrollTop computation (no render-time override).
    let tree = view.render()
    const renderedLines = (node) => all(node, n => n.type === 'tr' && n.props?.['data-line'] !== undefined).map(n => n.props['data-line'])
    let nums = renderedLines(tree)
    assert.ok(nums.includes(1000), `initial render must include targetLine 1000 (got ${nums[0]}..${nums.at(-1)})`)

    // Second render after mount effects still centers around line 1000.
    tree = view.render()
    nums = renderedLines(tree)
    assert.ok(nums.includes(1000), `post-effect render must include targetLine 1000 (got ${nums[0]}..${nums.at(-1)})`)

    const obs = resizeObservers.slice(prevObsCount).at(-1)
    assert.ok(obs && obs.targets[0], 'CodeLines observes its scroll wrapper')
    const scrollEl = obs.targets[0]

    // Scroll far down to line 1800 -> renders lines around 1800 (no blank screen, no snap-back to 1000).
    let wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    scrollEl.scrollTop = 19 * 1800
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 19 * 1800, scrollHeight: 19 * lineCount, clientHeight: 600 } })
    tree = view.render()
    nums = renderedLines(tree)
    assert.ok(nums.includes(1800), `scrolling to line 1800 must render around 1800 (got ${nums[0]}..${nums.at(-1)})`)
    assert.equal(nums.includes(1000), false, 'scrolling away from targetLine must not force targetLine back into DOM')

    // Trigger panel resize (ResizeObserver) while scrolled to line 1800 -> must NOT jump back to 1000.
    scrollEl.clientHeight = 420
    scrollEl.clientWidth = 360
    obs.cb()
    tree = view.render()
    nums = renderedLines(tree)
    assert.equal(scrollEl.scrollTop, 19 * 1800, 'panel resize must not overwrite DOM scrollTop')
    assert.ok(nums.includes(1800), `panel resize must keep scroll around line 1800 (got ${nums[0]}..${nums.at(-1)})`)
    assert.equal(nums.includes(1000), false, 'panel resize must not jump back to targetLine 1000')

    // Toggle word wrap while scrolled to line 1800 -> must NOT jump back to 1000.
    const wrapBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0]
    assert.ok(wrapBtn)
    wrapBtn.props.onClick()
    tree = view.render()
    tree = view.render()
    nums = renderedLines(tree)
    assert.equal(scrollEl.scrollTop, 19 * 1800, 'enabling word wrap must not overwrite DOM scrollTop')
    assert.ok(nums.includes(1800), `enabling word wrap must keep scroll around line 1800 (got ${nums[0]}..${nums.at(-1)})`)
    assert.equal(nums.includes(1000), false, 'enabling word wrap must not jump back to targetLine 1000')
    // Toggle word wrap back off and verify we still did not snap back to 1000.
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
    tree = view.render()
    tree = view.render()
    nums = renderedLines(tree)
    assert.equal(scrollEl.scrollTop, 19 * 1800, 'disabling word wrap must not overwrite DOM scrollTop')
    assert.ok(nums.includes(1800), `disabling word wrap must keep scroll around line 1800 (got ${nums[0]}..${nums.at(-1)})`)

    // Scroll far up to line 10 -> renders lines around 10, then small scroll to 0 reaches top cleanly.
    wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 19 * 10, scrollHeight: 19 * lineCount, clientHeight: 420 } })
    tree = view.render()
    nums = renderedLines(tree)
    assert.ok(nums.includes(10), `scrolling up to line 10 must render around line 10 (got ${nums[0]}..${nums.at(-1)})`)
    assert.equal(nums.includes(1000), false, 'scrolling up must not snap back to targetLine 1000')

    wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 8, scrollHeight: 19 * lineCount, clientHeight: 420 } })
    tree = view.render()
    wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 0, scrollHeight: 19 * lineCount, clientHeight: 420 } })
    tree = view.render()
    nums = renderedLines(tree)
    assert.equal(nums[0], 1, 'scrolling smoothly to scrollTop 0 must update and include line 1')

    // Explicit jump to a NEW targetLine (500) jumps once, and scrolling away works again.
    view.render({ file, line: 500 })
    tree = view.render({ file, line: 500 })
    nums = renderedLines(tree)
    assert.ok(nums.includes(500), `changing targetLine to 500 must jump to line 500 (got ${nums[0]}..${nums.at(-1)})`)
    wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    wrapDiv.props.onScroll({ currentTarget: { scrollTop: 19 * 2100, scrollHeight: 19 * lineCount, clientHeight: 420 } })
    tree = view.render({ file, line: 500 })
    nums = renderedLines(tree)
    assert.ok(nums.includes(2100), `scrolling after new jump must render line 2100 (got ${nums[0]}..${nums.at(-1)})`)
  } finally {
    view.unmount()
    sandbox.localStorage.removeItem('dsb.preview.wrap')
  }
})

test('Absolute chat file links use canonical workspace-relative paths for workspace-watch dirs and live update matching', async () => {
  sandbox.localStorage.removeItem('dsb.preview.autoRefresh')
  let version = 1
  const watchCalls = []
  sandbox.__testCall = async (endpoint, body) => {
    if (endpoint === 'workspace-watch') {
      watchCalls.push(body)
      return { watchId: `w-abs-${watchCalls.length}`, root: '/repo', recursive: false }
    }
    if (endpoint === 'workspace-unwatch') return { ok: true }
    if (endpoint === 'workspace-read') {
      // Mirrors real Host `workspace-read`: resolves `/repo/src/nested/chat-link.js` to canonical relative `src/nested/chat-link.js`.
      assert.equal(body.path, '/repo/src/nested/chat-link.js')
      return {
        kind: 'code',
        language: 'javascript',
        name: 'chat-link.js',
        path: 'src/nested/chat-link.js',
        size: 32,
        text: `// chat-link-v${version}`,
      }
    }
    return {}
  }

  const team = createTeam()
  team.actions.openSession('b1')
  // Chat link passes an absolute path with no `root`.
  team.actions.openFile({ path: '/repo/src/nested/chat-link.js', sessionId: 'b1' })

  const uiProbe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => s.rightPanel) }), {})
  try {
    const rp = uiProbe.render().props
    const body = mount(WorkspacePaneBody, { sessionId: 'b1', panel: rp, team, visible: true })
    try {
      body.render()
      await tick()
      let tree = body.render()
      assert.match(textOf(tree), /\/\/ chat-link-v1/)
      await tick()

      // Watch registration must never pass the bogus stripped absolute path (`repo/src/nested`),
      // and must register the canonical parent directory `src/nested` once workspace-read resolves.
      assert.equal(
        watchCalls.some(call => Array.isArray(call.dirs) && call.dirs.some(dir => dir.startsWith('repo/'))),
        false,
        'workspace-watch must not strip leading slash from absolute paths into invalid relative dirs',
      )
      assert.equal(
        watchCalls.some(call => Array.isArray(call.dirs) && call.dirs.includes('src/nested')),
        true,
        'workspace-watch must register canonical parent directory returned by workspace-read',
      )

      // Host emits workspace-changed with canonical workspace-relative path -> shows Updated · Reload banner.
      version = 2
      team.chat.emit('workspace-changed', { root: '/repo', paths: ['src/nested/chat-link.js'] })
      tree = body.render()
      const reloadBtn = all(tree, n => n.type === 'button' && /Updated · Reload/.test(textOf(n)))[0]
      assert.ok(reloadBtn, 'absolute chat link preview must show Updated · Reload on matching workspace-changed')

      // Enable Auto-refresh -> next workspace-changed automatically reloads v3.
      const autoSwitch = all(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Auto-refresh')[0]
      autoSwitch.props.onClick()
      body.render()
      version = 3
      team.chat.emit('workspace-changed', { root: '/repo', paths: ['src/nested/chat-link.js'] })
      await tick()
      tree = body.render()
      assert.match(textOf(tree), /\/\/ chat-link-v3/, 'absolute chat link preview auto-refreshes cleanly on workspace-changed')
    } finally {
      body.unmount()
    }
  } finally {
    uiProbe.unmount()
    sandbox.localStorage.removeItem('dsb.preview.autoRefresh')
  }
})

test('Active preview renews workspace-watch and detects edits on unresumed hello reconnect, search-mode context menu opens folder in tree, Refresh re-runs search, and team.openFile deduplicates tabs with lineNonce re-jumps', async () => {
  sandbox.localStorage.removeItem('dsb.preview.autoRefresh')
  // 1. Unresumed `hello` reconnect re-registers preview watch and detects edits made during disconnect.
  let version = 1
  const watchCalls = []
  let searchCalls = 0
  const revealedFolders = []
  sandbox.__testCall = async (endpoint, body) => {
    if (endpoint === 'workspace-watch') {
      watchCalls.push(body)
      return { watchId: `w-hello-${watchCalls.length}`, root: '/repo', recursive: true }
    }
    if (endpoint === 'workspace-unwatch') return { ok: true }
    if (endpoint === 'workspace-read') {
      return {
        kind: 'code',
        language: 'javascript',
        name: 'app.js',
        path: 'src/app.js',
        root: '/repo',
        size: 10 + version,
        text: `// version-${version}\n`,
      }
    }
    if (endpoint === 'workspace-list') {
      return { root: '/repo', rootName: 'repo', path: body?.path ?? '', entries: [{ name: 'src', path: 'src', kind: 'dir' }], truncated: false }
    }
    if (endpoint === 'workspace-search') {
      searchCalls += 1
      return {
        root: '/repo',
        searchId: null,
        done: true,
        entries: [
          { name: 'nested', path: 'src/nested', kind: 'dir', size: 0, mtimeMs: 1, ext: '' },
          { name: `hit-${searchCalls}.js`, path: `src/nested/hit-${searchCalls}.js`, kind: 'file', size: 12, mtimeMs: 1, ext: '.js' },
        ],
        incomplete: false,
        incompleteReasons: [],
      }
    }
    return {}
  }

  const team = createTeam()
  team.actions.openSession('b1')
  const origReveal = team.actions.revealFolder
  team.actions.revealFolder = (arg) => {
    revealedFolders.push(arg)
    return origReveal(arg)
  }

  // Open from FileTree (relative + root), then open same file from chat link (absolute + sessionId) -> single deduplicated tab!
  team.actions.openFile({ path: 'src/app.js', root: '/repo' })
  team.actions.openFile({ path: '/repo/src/app.js', sessionId: 'b1', line: 2 })
  const uiProbe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => s.rightPanel) }), {})
  try {
    let rp = uiProbe.render().props
    const previewTabs = rp.tabs.filter(id => id.startsWith('preview:'))
    assert.equal(previewTabs.length, 1, 'opening same file via FileTree relative+root and chat absolute path must deduplicate into one tab')
    const tabId = previewTabs[0]
    const firstNonce = rp.previews[tabId].lineNonce
    assert.equal(firstNonce, 1)

    // Re-clicking the same file:line increments lineNonce so CodeLines jumps back.
    team.actions.openFile({ path: '/repo/src/app.js', sessionId: 'b1', line: 2 })
    rp = uiProbe.render().props
    assert.equal(rp.previews[tabId].lineNonce, 2, 're-clicking the same file:line must increment lineNonce')

    const body = mount(WorkspacePaneBody, { sessionId: 'b1', panel: rp, team, visible: true })
    try {
      body.render()
      await tick()
      let tree = body.render()
      assert.match(textOf(tree), /\/\/ version-1/)
      const watchesBeforeHello = watchCalls.length
      assert.ok(watchesBeforeHello >= 1)

      // Host restarts (unresumed hello) while file changed on disk to version 2 -> watch re-registered & Updated · Reload appears!
      version = 2
      team.chat.emit('hello', { resumed: false })
      await tick()
      await tick()
      tree = body.render()
      assert.ok(watchCalls.length > watchesBeforeHello, 'unresumed hello must re-register preview workspace-watch')
      assert.ok(all(tree, n => n.type === 'button' && /Updated · Reload/.test(textOf(n))).length === 1, 'unresumed hello must detect file change during disconnect')

      // Enable Auto-refresh and simulate another unresumed hello with version 3 -> reloads automatically!
      const autoSwitch = all(tree, n => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === 'Auto-refresh')[0]
      autoSwitch.props.onClick()
      body.render()
      version = 3
      team.chat.emit('hello', { resumed: false })
      await tick()
      await tick()
      tree = body.render()
      assert.match(textOf(tree), /\/\/ version-3/, 'unresumed hello with Auto-refresh enabled must reload active preview')

      // Switch to Files tab -> search -> verify Refresh re-runs search and folder context menu triggers openSearchDir.
      team.actions.openFiles()
      rp = uiProbe.render().props
      tree = body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      await tick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      const searchInput = all(tree, n => n.type === 'input' && n.props?.className === 'dsb-ft-search-input')[0]
      assert.ok(searchInput)
      searchInput.props.onChange({ target: { value: 'hit' } })
      body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      await tick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      assert.equal(searchCalls, 1)
      assert.match(textOf(tree), /hit-1\.js/)

      // Clicking header Refresh while in search mode must re-run the active search query!
      const refreshBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Refresh')[0]
      assert.ok(refreshBtn)
      refreshBtn.props.onClick()
      body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      await tick()
      tree = body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      assert.equal(searchCalls, 2, 'header Refresh in search mode must re-run active search')
      assert.match(textOf(tree), /hit-2\.js/)

      // Right-clicking a folder hit in search mode exposes Open wired to openSearchDir (revealFolder), not Expand/Collapse.
      const dirHit = all(tree, n => n.type === 'button' && n.props?.['data-path'] === 'src/nested')[0]
      assert.ok(dirHit)
      dirHit.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 40, clientY: 60, currentTarget: {} })
      tree = body.render({ sessionId: 'b1', panel: rp, team, visible: true })
      const openDirItem = all(tree, n => n.type === 'button' && n.props?.['data-ft-action'] === 'open-in-tree')[0]
      assert.ok(openDirItem, 'search-mode folder context menu must render open-in-tree action')
      assert.equal(all(tree, n => n.type === 'button' && n.props?.['data-ft-action'] === 'toggle').length, 0, 'search-mode folder menu must not show no-op Expand/Collapse')
      openDirItem.props.onClick()
      assert.ok(revealedFolders.some(item => item?.path === 'src/nested'), 'open-in-tree must call openSearchDir -> revealFolder')
    } finally {
      body.unmount()
    }
  } finally {
    uiProbe.unmount()
    sandbox.localStorage.removeItem('dsb.preview.autoRefresh')
  }

  // 2. Re-jumping to the SAME line via incremented lineNonce scrolls back to targetLine after scrolling away.
  const lineCount = 2400
  const bigFile = {
    kind: 'code',
    language: 'javascript',
    name: 'rejump.js',
    path: 'src/rejump.js',
    size: lineCount * 20,
    text: Array.from({ length: lineCount }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n'),
  }
  const scrollEl = { scrollTop: 0, clientHeight: 380, clientWidth: 640 }
  const view = mount(FilePreview, { file: bigFile, line: 1000, lineNonce: 1 })
  try {
    let tree = view.render({ file: bigFile, line: 1000, lineNonce: 1 })
    const wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    if (wrapDiv.props?.ref && typeof wrapDiv.props.ref === 'object') wrapDiv.props.ref.current = scrollEl
    tree = view.render({ file: bigFile, line: 1000, lineNonce: 1 })
    // Scroll away to line 100.
    scrollEl.scrollTop = 19 * 100
    all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({
      currentTarget: { scrollTop: 19 * 100, scrollHeight: 19 * lineCount, clientHeight: 380 },
    })
    tree = view.render({ file: bigFile, line: 1000, lineNonce: 1 })
    assert.equal(all(tree, n => n.type === 'tr' && n.props?.['data-line'] === 1000).length, 0)
    // Increment lineNonce with the same line 1000 -> jumps right back to line 1000!
    view.render({ file: bigFile, line: 1000, lineNonce: 2 })
    tree = view.render({ file: bigFile, line: 1000, lineNonce: 2 })
    assert.equal(all(tree, n => n.type === 'tr' && n.props?.['data-line'] === 1000).length, 1, 'incremented lineNonce must re-jump to the same targetLine')
  } finally {
    view.unmount()
  }
})

test('computeCodeWindow clamps scrollTop past maxScroll, and CodeLines preserves first visible line without blanking across word-wrap toggles and file shrinks', () => {
  // 1. Direct computeCodeWindow clamping in fixed-height (unwrapped) and offsets (wrapped) modes.
  const unwrappedPastEof = computeCodeWindow({ lineCount: 1000, scrollTop: 170285, viewportHeight: 500, lineHeight: 19, overscan: 24 })
  assert.ok(unwrappedPastEof.start <= unwrappedPastEof.end, 'unwrapped start must be <= end')
  assert.ok(unwrappedPastEof.end > unwrappedPastEof.start, 'unwrapped window past EOF must stay non-empty')
  assert.equal(unwrappedPastEof.end, 1000, 'unwrapped window past EOF must clamp to final lines')
  assert.ok(unwrappedPastEof.topPad < unwrappedPastEof.totalHeight, 'topPad must not exceed totalHeight')

  const offsets = new Float64Array(1001)
  for (let i = 0; i <= 1000; i += 1) offsets[i] = i * 190
  const wrappedPastEof = computeCodeWindow({ lineCount: 1000, scrollTop: 500000, viewportHeight: 500, lineHeight: 19, overscan: 24, offsets })
  assert.ok(wrappedPastEof.start <= wrappedPastEof.end, 'wrapped start must be <= end')
  assert.ok(wrappedPastEof.end > wrappedPastEof.start, 'wrapped window past EOF must stay non-empty')
  assert.equal(wrappedPastEof.end, 1000, 'wrapped window past EOF must clamp to final lines')

  // 2. 1,000 lines x 400 chars: enable Word Wrap, scroll deep (~100,000px), toggle Word Wrap OFF ->
  //    ZERO blank frames on first render, first visible line preserved, toggle back ON preserves same line!
  const longText = Array.from({ length: 1000 }, (_, i) => `L${String(i + 1).padStart(4, '0')} ${'x'.repeat(394)}`).join('\n')
  const wideFile = { kind: 'code', language: 'text', name: 'wide.txt', path: 'wide.txt', size: longText.length, text: longText }
  sandbox.localStorage.removeItem('dsb.preview.wrap')
  const view = mount(FilePreview, { file: wideFile })
  try {
    let tree = view.render({ file: wideFile })
    const wrapDiv = all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    const scrollEl = wrapDiv.props.ref.current
    assert.ok(scrollEl, 'CodeLines attaches wrapRef to scroll container')
    tree = view.render({ file: wideFile })

    // Turn Word Wrap ON.
    const wrapBtn = all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0]
    assert.ok(wrapBtn)
    wrapBtn.props.onClick()
    tree = view.render({ file: wideFile })

    // Scroll deep into wrapped file (~100,000 px, far beyond unwrapped totalHeight of 19,000 px).
    const deepScroll = 100_000
    scrollEl.scrollTop = deepScroll
    all(tree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({
      currentTarget: { scrollTop: deepScroll, scrollHeight: 361_000, clientHeight: scrollEl.clientHeight },
    })
    tree = view.render({ file: wideFile })
    const wrappedLines = all(tree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line'])).map(n => n.props['data-line'])
    assert.ok(wrappedLines.length > 0, 'wrapped deep scroll renders rows')

    const charsPerLine = Math.max(20, Math.floor((scrollEl.clientWidth - 72) / 7.4))
    const rowsPerLine = Math.ceil(400 / charsPerLine)
    const expectedLineIdx = Math.floor(deepScroll / (rowsPerLine * 19))
    const expectedLineNum = expectedLineIdx + 1
    assert.ok(wrappedLines.includes(expectedLineNum), `anchored line ${expectedLineNum} is mounted before wrap-off`)

    // Toggle Word Wrap OFF -> MUST be non-empty on the VERY FIRST render and anchored to expectedLineNum!
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
    tree = view.render({ file: wideFile })
    const afterOffRows = all(tree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line'])).map(n => n.props['data-line'])
    assert.ok(afterOffRows.length > 0, 'turning Word Wrap OFF must never produce a blank frame')
    assert.ok(afterOffRows.includes(expectedLineNum), `turning Word Wrap OFF must keep anchored line ${expectedLineNum} visible`)
    assert.equal(scrollEl.scrollTop, expectedLineIdx * 19, 'scrollTop must remap to anchored line top in unwrapped coordinates')

    // Toggle Word Wrap back ON -> MUST keep the EXACT same anchored line!
    all(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
    tree = view.render({ file: wideFile })
    const afterOnRows = all(tree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line'])).map(n => n.props['data-line'])
    assert.ok(afterOnRows.length > 0, 'turning Word Wrap back ON must stay non-empty')
    assert.ok(afterOnRows.includes(expectedLineNum), `round-trip wrap ON/OFF/ON must keep anchored line ${expectedLineNum} visible`)
    assert.equal(scrollEl.scrollTop, expectedLineIdx * rowsPerLine * 19, 'scrollTop must remap back to anchored line top in wrapped coordinates')

    // 3. Live reload shrinks file from 1,000 lines to 300 lines while scrolled deep -> non-empty & clamped!
    const shrunkText = Array.from({ length: 300 }, (_, i) => `S${i + 1} short`).join('\n')
    const shrunkFile = { ...wideFile, size: shrunkText.length, text: shrunkText }
    tree = view.render({ file: shrunkFile })
    const shrunkRows = all(tree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line'])).map(n => n.props['data-line'])
    assert.ok(shrunkRows.length > 0, 'shrunk live-reloaded file must never render blank')
    assert.ok(shrunkRows.includes(300), 'shrunk file clamps to bottom lines')
  } finally {
    view.unmount()
    sandbox.localStorage.removeItem('dsb.preview.wrap')
  }
})

test('CodeLines has zero anchor drift across 20 wrap toggles + width resize under realistic DOM height mismatch, never resets to line 1 after a big jump, and does not fight active scrolling during resize', async () => {
  const longText = Array.from({ length: 1000 }, (_, i) => `L${String(i + 1).padStart(4, '0')} ${'x'.repeat(394)}`).join('\n')
  const wideFile = { kind: 'code', language: 'text', name: 'drift.txt', path: 'drift.txt', size: longText.length, text: longText }
  sandbox.localStorage.removeItem('dsb.preview.wrap')

  // Helper that simulates realistic Chromium DOM geometry where wrapped lines render at 152px
  // (8 visual rows) even when CodeLines' model estimates 171px (9 visual rows) — reproducing the
  // exact ~12% mismatch that caused cumulative drift across repeated toggles.
  let latestTree = null
  let currentWrapped = false
  const realRowH = (w) => (currentWrapped ? (w <= 360 ? 190 : 152) : 19)
  const makeDomMock = (scrollEl) => {
    scrollEl.clientWidth = 440
    scrollEl.clientHeight = 500
    scrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 100 + scrollEl.clientHeight, height: scrollEl.clientHeight, width: scrollEl.clientWidth })
    const buildRows = () => {
      if (!latestTree) return []
      const topSpacer = all(latestTree, n => n.type === 'tr' && n.props?.className === 'dsb-pv-spacer' && n.props?.key === 'pad-top')[0]
      const topPadPx = topSpacer ? Number.parseFloat(topSpacer.props.children?.[0]?.props?.style?.height || '0') : 0
      const lineNodes = all(latestTree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line']))
      const rh = realRowH(scrollEl.clientWidth)
      let y = topPadPx
      return lineNodes.map((n) => {
        const lineNum = n.props['data-line']
        const rowTopDoc = y
        const rowBottomDoc = y + rh
        y += rh
        return {
          getAttribute: (attr) => (attr === 'data-line' ? String(lineNum) : null),
          getBoundingClientRect: () => ({
            top: 100 + rowTopDoc - scrollEl.scrollTop,
            bottom: 100 + rowBottomDoc - scrollEl.scrollTop,
            height: rh,
          }),
        }
      })
    }
    scrollEl.querySelectorAll = (sel) => (sel === 'tr[data-line]' ? buildRows() : [])
    scrollEl.querySelector = (sel) => {
      const m = /^tr\[data-line="(\d+)"\]$/.exec(sel)
      if (!m) return null
      return buildRows().find(r => r.getAttribute('data-line') === m[1]) ?? null
    }
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => {
        if (!latestTree) return 19_000
        const spacers = all(latestTree, n => n.type === 'tr' && n.props?.className === 'dsb-pv-spacer')
        const linesCount = all(latestTree, n => n.type === 'tr' && Number.isInteger(n.props?.['data-line'])).length
        const padSum = spacers.reduce((s, sp) => s + Number.parseFloat(sp.props.children?.[0]?.props?.style?.height || '0'), 0)
        return padSum + linesCount * realRowH(scrollEl.clientWidth)
      },
    })
  }
  const firstVisibleDomLineInMock = (scrollEl) => {
    for (const r of scrollEl.querySelectorAll('tr[data-line]')) {
      const rect = r.getBoundingClientRect()
      if (rect.bottom > 101 && rect.top < 100 + scrollEl.clientHeight) {
        return { line: Number(r.getAttribute('data-line')), subOffset: Math.max(0, Math.round(100 - rect.top)) }
      }
    }
    return null
  }

  const prevObsCount = resizeObservers.length
  const view = mount(FilePreview, { file: wideFile })
  view.onCommit = (tree) => { latestTree = tree }
  try {
    latestTree = view.render({ file: wideFile })
    const wrapDiv = all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0]
    const scrollEl = wrapDiv.props.ref.current
    makeDomMock(scrollEl)
    const obs = resizeObservers[prevObsCount]
    obs?.cb?.()
    latestTree = view.render({ file: wideFile })

    // Turn wrap ON and scroll to line 699 with 7px sub-line offset.
    all(latestTree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
    currentWrapped = true
    latestTree = view.render({ file: wideFile })
    // Settle scroll cleanly onto line 699 with 7px sub-line offset (2 passes settle topPad in mock DOM).
    scrollEl.scrollTop = 119_358
    all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({ currentTarget: scrollEl })
    latestTree = view.render({ file: wideFile })
    for (let pass = 0; pass < 2; pass += 1) {
      const row699 = scrollEl.querySelector('tr[data-line="699"]')
      assert.ok(row699, 'line 699 mounted for setup')
      scrollEl.scrollTop += (row699.getBoundingClientRect().top - 100) + 7
      all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({ currentTarget: scrollEl })
      latestTree = view.render({ file: wideFile })
    }
    const initialVis = firstVisibleDomLineInMock(scrollEl)
    assert.deepEqual(initialVis, { line: 699, subOffset: 7 }, 'starting at line 699 +7px sub-line offset')

    // 1. Toggle Word Wrap 20 times in a row -> MUST stay locked at line 699 (+7px), 0 drift!
    for (let i = 0; i < 20; i += 1) {
      all(latestTree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
      currentWrapped = !currentWrapped
      latestTree = view.render({ file: wideFile })
      latestTree = view.render({ file: wideFile })
      const vis = firstVisibleDomLineInMock(scrollEl)
      assert.equal(vis?.line, 699, `toggle #${i + 1} (${currentWrapped ? 'wrap ON' : 'wrap OFF'}) must stay on line 699 (got ${vis?.line})`)
      assert.equal(vis?.subOffset, 7, `toggle #${i + 1} must preserve 7px sub-line offset (got ${vis?.subOffset})`)
    }

    // 2a. Panel width resize 440px -> 360px while wrapped (after quiet window) -> MUST stay on line 699 (+7px), 0 drift!
    assert.equal(currentWrapped, true)
    await new Promise(r => setTimeout(r, 270))
    scrollEl.clientWidth = 360
    obs?.cb?.()
    latestTree = view.render({ file: wideFile })
    latestTree = view.render({ file: wideFile })
    const afterResize = firstVisibleDomLineInMock(scrollEl)
    assert.equal(afterResize?.line, 699, `width resize 440->360 after quiet window must stay on line 699 (got ${afterResize?.line})`)
    assert.equal(afterResize?.subOffset, 7, `width resize 440->360 must preserve 7px sub-line offset (got ${afterResize?.subOffset})`)

    // 2b. Width resize DURING active user scroll -> MUST NOT overwrite scrollTop!
    all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onWheel?.()
    const scrollDuringUserDrag = scrollEl.scrollTop
    scrollEl.clientWidth = 400
    obs?.cb?.()
    latestTree = view.render({ file: wideFile })
    assert.equal(scrollEl.scrollTop, scrollDuringUserDrag, 'width resize during active user scroll must not overwrite scrollTop')

    // 3. Big jump from top (scrollTop = 0) straight to 0.7 depth (outside overscan) + IMMEDIATE wrap toggle ->
    //    MUST NOT reset to line 1 / scrollTop = 0!
    scrollEl.scrollTop = 0
    all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({ currentTarget: scrollEl })
    latestTree = view.render({ file: wideFile })
    assert.equal(firstVisibleDomLineInMock(scrollEl)?.line, 1)

    // Jump straight to 120,000px in one shot (rows in DOM are still [1..30], NONE intersect viewport!)
    // and toggle wrap OFF immediately BEFORE React re-renders for 120,000px!
    scrollEl.scrollTop = 120_000
    all(latestTree, n => n.type === 'div' && n.props?.className === 'dsb-pv-code-wrap')[0].props.onScroll({ currentTarget: scrollEl })
    all(latestTree, n => n.type === 'button' && n.props?.['aria-label'] === 'Wrap lines')[0].props.onClick()
    currentWrapped = false
    latestTree = view.render({ file: wideFile })
    latestTree = view.render({ file: wideFile })
    const afterJumpToggle = firstVisibleDomLineInMock(scrollEl)
    assert.ok(afterJumpToggle && afterJumpToggle.line > 500, `big jump + immediate wrap toggle must land deep (>500), not reset to line 1 (got ${afterJumpToggle?.line})`)
    assert.ok(scrollEl.scrollTop > 9000, `scrollTop must stay deep after big jump + wrap toggle (got ${scrollEl.scrollTop})`)
  } finally {
    view.unmount()
    sandbox.localStorage.removeItem('dsb.preview.wrap')
  }
})
