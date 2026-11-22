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
}

const entryCode = `
  export { parseDelimitedTable, FilePreview } from './ui/src/file-preview.js'
  export { parseAnsiSpans, WorkspaceTerminal } from './ui/src/workspace-terminal.js'
  export { ChangesReview } from './ui/src/changes-review.js'
  export { RightPanel } from './ui/src/right-panel.js'
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
const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  __testCall: async () => ({}),
  __copied: [],
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`unexpected require ${name}`)
  },
  Blob,
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
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { body: {}, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
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
  parseAnsiSpans,
  WorkspaceTerminal,
  ChangesReview,
  RightPanel,
  createSlotRegistry,
  RIGHT_PANE_TAB_SLOT,
  createTeam,
} = mod.exports

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

test('parseAnsiSpans converts ANSI SGR colors, skips 256/RGB params, applies carriage-return overwrites, and strips OSC sequences cleanly', () => {
  const raw = '\u001b]0;title\u0007\u001b[1;32mPASS\u001b[0m \u001b[38;5;31mplain\u001b[0m \u001b[38;2;1;2;31mrgb\u001b[0m \u001b[31mFAIL\u001b[39m\r\n%\r50%\r100%'
  const spans = plain(parseAnsiSpans(raw))
  assert.deepEqual(spans, [
    { text: 'PASS', fg: 'green', bold: true },
    { text: ' ' },
    { text: 'plain' },
    { text: ' ' },
    { text: 'rgb' },
    { text: ' ' },
    { text: 'FAIL', fg: 'red' },
    { text: '\n100%' },
  ])
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
    const iframe = all(tree, n => n.type === 'iframe')[0]
    assert.equal(iframe.props.sandbox, '', 'HTML preview iframe must be strictly sandboxed with empty sandbox attribute')
    assert.equal(iframe.props.srcDoc, '<p>Hello</p>')
  } finally {
    html.unmount()
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

test('RightPanel renders FileTree, opens preview, isolates crashing sidebar.right.pane.tab plugin, and mutually excludes BotPanel', async () => {
  const calls = []
  sandbox.__testCall = async (endpoint, body) => {
    calls.push([endpoint, body])
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
  // Mutual exclusion between BotPanel (details) and RightPanel:
  team.actions.showDetails('b1')
  const probe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => ({ details: s.details, rightPanel: s.rightPanel })) }), {})
  assert.equal(probe.render().props.details, 'b1')
  assert.equal(probe.render().props.rightPanel, null)

  team.actions.openFiles()
  assert.equal(probe.render().props.details, null, 'opening RightPanel closes BotPanel')
  assert.equal(probe.render().props.rightPanel.tab, 'files')

  team.actions.showDetails('b1')
  assert.equal(probe.render().props.details, 'b1')
  assert.equal(probe.render().props.rightPanel, null, 'opening BotPanel closes RightPanel')

  // Opening changes verifies changes-check and activates the changes tab.
  await team.actions.openChanges({ sessionId: 'b1', seq: 7, turn: 1 })
  assert.equal(probe.render().props.rightPanel.tab, 'changes')
  probe.unmount()

  // Register a crashing `sidebar.right.pane.tab` plugin and confirm SlotErrorBoundary isolates it.
  const reg = createSlotRegistry()
  function BrokenTab() { throw new Error('plugin crash') }
  reg.register({ name: RIGHT_PANE_TAB_SLOT, id: 'broken', meta: { label: 'Broken' } }, BrokenTab)

  const panelInst = mount(RightPanel, { sessionId: 'b1', panel: { tab: 'files' }, team, registry: reg })
  try {
    panelInst.render()
    await tick()
    let tree = panelInst.render()
    assert.match(textOf(tree), /README\.md/)
    // Expand `src` directory and click `src/app.js`.
    const srcBtn = all(tree, n => n.type === 'button' && /src/.test(textOf(n)))[0]
    srcBtn.props.onClick()
    await tick()
    tree = panelInst.render()
    assert.match(textOf(tree), /app\.js/)

    // Switch to crashing plugin tab -> isolated fallback with Retry.
    tree = panelInst.render({ sessionId: 'b1', panel: { tab: 'plugin:broken' }, team, registry: reg })
    assert.match(textOf(tree), /This view could not be shown/)
    assert.match(textOf(tree), /Retry/)

    // Switch to Changes tab -> loads summary and diff hunk.
    panelInst.render({ sessionId: 'b1', panel: { tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } }, team, registry: reg })
    await tick()
    panelInst.render({ sessionId: 'b1', panel: { tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } }, team, registry: reg })
    await tick()
    tree = panelInst.render({ sessionId: 'b1', panel: { tab: 'changes', changes: { sessionId: 'b1', seq: 7, turn: 1 } }, team, registry: reg })
    assert.match(textOf(tree), /console\.log\(1\)/)
  } finally {
    panelInst.unmount()
  }

  // Interactive terminal receives live SSE chunks and sends commands.
  const termInst = mount(WorkspaceTerminal, { sessionId: 'b1', feed: team.chat, autoOpenNonce: 1 })
  try {
    termInst.render()
    await tick()
    let tree = termInst.render()
    team.chat.emit('terminal', { id: 'term-1', chunk: '\u001b[32mhello-term\u001b[0m\n' })
    tree = termInst.render()
    assert.match(textOf(tree), /hello-term/)
    const input = all(tree, n => n.type === 'input' && n.props?.className === 'dsb-term-input')[0]
    input.props.onChange({ target: { value: 'pwd' } })
    tree = termInst.render()
    all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
    await tick()
    assert.equal(calls.some(([ep, b]) => ep === 'terminal-input' && b.id === 'term-1' && b.data === 'pwd\r'), true)
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

  // 2. WorkspaceTerminal preserves new terminal when terminal-list resolves late and replays early SSE output.
  let resolveList
  let resolveOpen
  sandbox.__testCall = (endpoint) => {
    if (endpoint === 'terminal-list') return new Promise(resolve => { resolveList = resolve })
    if (endpoint === 'terminal-open') return new Promise(resolve => { resolveOpen = resolve })
    return Promise.resolve({})
  }
  const team = createTeam()
  // Whitespace in file paths must be preserved verbatim by openFile.
  team.actions.openFile('spaced.txt ')
  const fileProbe = mount(() => ({ type: 'probe', props: team.hooks.useUi(s => s.rightPanel) }), {})
  assert.equal(fileProbe.render().props.file, 'spaced.txt ')
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
    const tree = term.render()
    assert.match(textOf(tree), /early-prompt\$/)
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
