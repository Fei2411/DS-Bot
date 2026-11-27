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
  export { parseDelimitedTable, FilePreview, HtmlPreviewFrame, HtmlPreviewNotice } from './ui/src/file-preview.js'
  export { createLocalLineEditor, createTerminalKeyHandler, parseAnsiSpans, readXtermTheme, WorkspaceTerminal } from './ui/src/workspace-terminal.js'
  export { ChangesReview } from './ui/src/changes-review.js'
  export { RightPanel, WorkspacePaneBody, buildWorkspaceTabs } from './ui/src/right-panel.js'
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
    team.actions.newTerminal()
    await team.actions.openChanges({ sessionId: 'b1', seq: 7, turn: 1 })
    snap = probe.render().props
    assert.equal(snap.view, 'workspace')
    assert.equal(snap.side, 'sc1', 'opening workspace tabs keeps active side chat reference intact')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', 'preview', 'terminal', 'changes'])
    assert.equal(snap.rightPanel.tab, 'changes')

    // Switching back to Details preserves all workspace tabs.
    team.actions.showDetails('b1')
    snap = probe.render().props
    assert.equal(snap.view, 'details')
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', 'preview', 'terminal', 'changes'])

    // Switching sessions drops stale preview & changes while preserving Files & Terminal.
    team.actions.setRightPanelTab('preview')
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
    assert.deepEqual(plain(snap.rightPanel.tabs), ['files', 'preview'])

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

  // `buildWorkspaceTabs` builds ordered descriptors + registered `sidebar.right.pane.tab` plugins.
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
      { id: 'plugin:broken', label: 'Broken', closable: false },
    ],
  )

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

    // SSE 'hello' reconnect triggers silent refresh so changes across the 6s SSE recycle gap are never missed.
    const listsBeforeHello = calls.filter(([ep]) => ep === 'workspace-list').length
    subDirTruncated = true
    team.chat.emit('hello', {})
    await tick()
    await tick()
    tree = panel.render()
    assert.ok(calls.filter(([ep]) => ep === 'workspace-list').length > listsBeforeHello, 'SSE hello triggers tree catch-up refresh')
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
