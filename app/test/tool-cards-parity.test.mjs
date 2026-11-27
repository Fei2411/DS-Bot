import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const RECORDED_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/tool-cards-recorded.json', import.meta.url), 'utf8'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))

const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './app/ui/src/builtin-tool-views.js'
      export * from './app/ui/src/office-tool-view.js'
      export * from './app/ui/src/browser-computer-tool-views.js'
      export * from './app/ui/src/subagent-job-tool-views.js'
      export * from './app/ui/src/subagent-viewer.js'
      export { buildSessionRows } from './app/ui/src/session-transcript.js'
      export { ToolCallCard } from './app/ui/src/tool-card.js'
      export { createSlotRegistry, TOOL_VIEW_SLOT } from './app/ui/src/slots.js'
      export { installLocale } from './ds-bot/src/client/i18n.js'
      export { PartialArguments } from '@deepseek-ai/dsh-util-values'
    `,
    resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'tool-cards-parity-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /(dsh-primitives|primitives)\.js$/ }, () => ({ path: 'primitives.js', namespace: 'tcp-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'tcp-stub' }, () => ({
        contents: `
          export const writeClipboard = async (text) => { globalThis.__copied.push(text); return true }
          export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
          export const fileSizeText = bytes => (Number.isFinite(bytes) ? (bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B') : '')
        `,
        loader: 'js',
      }))
      bundler.onResolve({ filter: /ds-bot\/src\/client\/api\.js$/ }, () => ({ path: 'api.js', namespace: 'tcp-api-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'tcp-api-stub' }, () => ({
        contents: `
          export const call = (endpoint, payload) => globalThis.__testCall(endpoint, payload)
        `,
        loader: 'js',
      }))
    },
  }],
})

const tick = () => new Promise(resolve => setTimeout(resolve, 15))

function createHarness() {
  let active = null
  const winListeners = new Map()
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } })
  class MiniComponent {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
  }
  const reactStub = {
    Component: MiniComponent,
    Fragment: ({ children }) => ({ type: 'fragment', props: { children } }),
    createElement,
    useState(init) {
      const i = active.i++
      const slots = active.s
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      const set = (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }
      return [slots[i], set]
    },
    useRef(init) {
      const i = active.i++
      if (!(i in active.s)) active.s[i] = { current: init }
      return active.s[i]
    },
    useId: () => 'id-1',
    useMemo(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.s[i] = { deps, val: fn() }
      }
      return active.s[i].val
    },
    useCallback(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.s[i] = { deps, val: fn }
      }
      return active.s[i].val
    },
    useEffect(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.e.push({ i, fn, deps, prev })
      }
    },
    useLayoutEffect(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.e.push({ i, fn, deps, prev })
      }
    },
    useSyncExternalStore: (_sub, getSnap) => getSnap(),
  }

  const win = {
    addEventListener(type, fn, opts) {
      const key = opts === true || opts?.capture ? `${type}:capture` : type
      if (!winListeners.has(key)) winListeners.set(key, new Set())
      winListeners.get(key).add(fn)
    },
    removeEventListener(type, fn, opts) {
      const key = opts === true || opts?.capture ? `${type}:capture` : type
      winListeners.get(key)?.delete(fn)
    },
  }
  const doc = { body: { tagName: 'BODY' }, documentElement: { tagName: 'HTML' }, activeElement: null, hidden: false, querySelector: () => null }
  const sandbox = {
    console: { ...console, error() {} },
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    window: win,
    document: doc,
    navigator: { platform: 'MacIntel' },
    __copied: [],
    __testCall: async () => ({}),
    module: { exports: {} },
    exports: {},
    require: (id) => (id === 'react' ? reactStub : id === 'react-dom' ? { createPortal: node => node } : {}),
  }
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)

  function mount(Comp, initialProps) {
    let props = initialProps
    const states = new Map()
    const renderNode = (node, path) => {
      if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map((c, idx) => renderNode(c, `${path}.${idx}`))
      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name || 'fn'}`
        if (node.type.prototype && typeof node.type.prototype.render === 'function') {
          let inst = states.get(key)
          if (!inst) { inst = new node.type(node.props); states.set(key, inst) }
          else inst.props = node.props
          return renderNode(inst.render(), `${key}:cls`)
        }
        const st = states.get(key) ?? { s: [] }
        states.set(key, st)
        const prev = active
        active = { i: 0, s: st.s, e: [] }
        const out = node.type(node.props ?? {})
        const queued = active.e
        active = prev
        for (const item of queued) {
          if (typeof item.prev?.cleanup === 'function') item.prev.cleanup()
          const cleanup = item.fn()
          st.s[item.i] = { deps: item.deps, cleanup }
        }
        return renderNode(out, `${key}:r`)
      }
      return { ...node, props: { ...(node.props ?? {}), children: renderNode(node.props?.children ?? [], `${path}:c`) } }
    }
    return {
      render(nextProps = props) {
        props = nextProps
        return renderNode(createElement(Comp, props), 'root')
      },
      unmount() {
        for (const st of states.values()) {
          for (const slot of st.s ?? []) if (typeof slot?.cleanup === 'function') slot.cleanup()
        }
      },
    }
  }

  const all = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) all(child, pred, out); return out }
    if (pred(node)) out.push(node)
    all(node.props?.children, pred, out)
    return out
  }
  const textOf = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    return textOf(node.props?.children)
  }
  const makeBlock = (name, argsObj, extra = {}) => {
    const argsRaw = JSON.stringify(argsObj ?? {})
    return {
      kind: extra.phase === 'result' ? 'tool-result' : 'tool-call',
      phase: extra.phase ?? 'result',
      callId: extra.callId ?? `call-${name}`,
      name,
      argsRaw,
      args: sandbox.module.exports.PartialArguments.fromText(argsRaw),
      isError: extra.isError ?? false,
      content: extra.content ?? [],
      meta: extra.meta,
      error: extra.error,
      callTime: 1000,
      time: 2400,
      subCalls: extra.subCalls ?? [],
    }
  }

  return { exports: sandbox.module.exports, sandbox, mount, all, textOf, makeBlock, winListeners }
}

test('Office tools (office_render, office_convert, office.js CLI) render document kind, rendered thumbnails, missing fonts, and Preview action', async () => {
  const h = createHarness()
  const { registerBuiltinToolViews, createSlotRegistry, ToolCallCard, parseOfficeCliCommand, officePreviewTarget } = h.exports
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    // Temp-dir output falls back to workspace input for workspace-read safety; workspace output (including relative & UNC paths) previews directly.
    assert.equal(officePreviewTarget('/ws/report.docx', '/tmp/dsh-office/out.pdf', '/ws'), '/ws/report.docx')
    assert.equal(officePreviewTarget('/ws/report.docx', '/ws/out/report.pdf', '/ws'), '/ws/out/report.pdf')
    assert.equal(officePreviewTarget('draft.docx', 'final.docx', '/ws'), '/ws/final.docx')
    assert.equal(officePreviewTarget('draft.docx', 'final.docx', '/ws', 'reports'), '/ws/reports/final.docx')
    assert.equal(officePreviewTarget('draft.docx', '../outside.docx', '/ws'), '/ws/draft.docx')
    assert.equal(officePreviewTarget('\\\\server\\share\\docs\\draft.docx', 'final.docx', '\\\\server\\share\\docs'), '//server/share/docs/final.docx')
    assert.equal(officePreviewTarget('\\\\server\\share\\docs\\draft.docx', '\\\\server\\other\\out.docx', '\\\\server\\share\\docs'), '//server/share/docs/draft.docx')

    const opened = []
    const loaded = []
    const loadImage = async (id, opts) => {
      loaded.push({ id, preview: opts?.preview })
      return `data:image/png;base64,PAGE_${id}_${opts?.preview === false ? 'FULL' : 'THUMB'}`
    }

    // 1. office_render with real DSH 0.2.2-rc.5 output wording, array `pages`, sheet range caption, and missing fonts warning.
    const renderInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      loadImage,
      block: h.makeBlock('office_render', { input: '/ws/deck.pptx', pages: [1, 2], dpi: 150 }, {
        meta: { path: '/ws/deck.pptx' },
        content: [
          { type: 'text', text: 'Rendered 2 image(s) of /ws/deck.pptx (5 in the document) at 150 DPI.\nFonts not installed and substituted: Calibri, Arial.' },
          { type: 'text', text: 'Page 1: 1280x720 px' },
          { type: 'image', attachment: { attachmentId: 'pg-1', width: 1280, height: 720, bytes: 42000 } },
          { type: 'text', text: 'Sheet "Summary" A1:D20: 1280x720 px' },
          { type: 'image', attachment: { attachmentId: 'pg-2', width: 1280, height: 720, bytes: 38000 } },
        ],
      }),
    })
    renderInst.render()
    await tick()
    const tree = renderInst.render()
    const txt = h.textOf(tree)
    assert.match(txt, /Render document/)
    assert.match(txt, /PowerPoint/)
    assert.match(txt, /2 pages/)
    assert.match(txt, /Missing fonts/)
    assert.match(txt, /Calibri, Arial/)
    assert.match(txt, /Sheet "Summary" A1:D20/)
    assert.equal(h.all(tree, n => n.type === 'img' && n.props?.className === 'dsb-timg').length, 2)

    // Clicking Preview opens the document in the right panel.
    const previewBtn = h.all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0]
    previewBtn.props.onClick()
    assert.deepEqual(opened, ['/ws/deck.pptx'])
    renderInst.unmount()

    // 2. DS Bot office.js CLI call inside bash renders as Office card with Preview action (skipping --against/--ops/--order value flags + singular labels).
    const parsedCli = parseOfficeCliCommand('node /opt/office.js docx write --ops patch.json --against base.docx draft.docx -o final.docx --json')
    assert.equal(parsedCli.subcommand, 'docx')
    assert.equal(parsedCli.inputPath, 'draft.docx')
    assert.equal(parsedCli.outputPath, 'final.docx')
    const cliInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      block: h.makeBlock('bash', { command: 'node /opt/office.js docx write draft.docx -o final.docx --json', workdir: 'docs' }, {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { file: 'final.docx', paragraphs: 1, issues: ['Font fallback'] } }) }],
      }),
    })
    const cliTree = cliInst.render()
    assert.match(h.textOf(cliTree), /Word document/)
    assert.match(h.textOf(cliTree), /1 paragraph/)
    assert.match(h.textOf(cliTree), /1 issue/)
    h.all(cliTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.equal(opened.at(-1), '/ws/docs/final.docx')
    cliInst.unmount()

    // 2b. DS Bot office.js real CLI contracts: `sheet` contact sheet (not Excel/Spreadsheet), `--slides`/`--cols`/`--width` value flags,
    //     exit code 1 with `{ ok: true, data: { findings: [...] } }` as warning keeping Preview enabled, and `{ ok: false, error: { code, message } }`.
    const sheetCli = parseOfficeCliCommand('node /opt/office.js sheet --cols 4 --width 320 frames/ -o contact.png --json')
    assert.equal(sheetCli.subcommand, 'sheet')
    assert.equal(sheetCli.inputPath, 'frames/')
    assert.equal(sheetCli.outputPath, 'contact.png')
    assert.equal(sheetCli.docKind, '')
    const sheetInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      block: h.makeBlock('bash', { command: 'node /opt/office.js sheet --cols 4 --width 320 frames/ -o contact.png --json' }, {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { file: 'contact.png', pages: 4, width: 1280, height: 720 } }) }],
      }),
    })
    const sheetText = h.textOf(sheetInst.render())
    assert.match(sheetText, /Contact sheet/)
    assert.doesNotMatch(sheetText, /Spreadsheet|Excel/)
    assert.match(sheetText, /4 pages/)
    sheetInst.unmount()

    const layoutCli = parseOfficeCliCommand('node /opt/office.js pptx layout --slides 1,2 deck.pptx --json')
    assert.equal(layoutCli.subcommand, 'pptx')
    assert.equal(layoutCli.action, 'layout')
    assert.equal(layoutCli.inputPath, 'deck.pptx')
    const findingsInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      block: h.makeBlock('bash', { command: 'node /opt/office.js pptx layout --slides 1,2 deck.pptx --json' }, {
        isError: true,
        content: [{ type: 'text', text: `${JSON.stringify({ ok: true, data: { findings: [{ part: 'ppt/slides/slide1.xml', message: 'Text overflow' }] } })}\n[exit code: 1]` }],
      }),
    })
    const findingsTree = findingsInst.render()
    const findingsCard = h.all(findingsTree, n => n.props?.className === 'dsb-tool')[0]
    assert.equal(findingsCard.props['data-error'], undefined, 'exit code 1 with ok:true findings must not mark card as hard error')
    const findingsTxt = h.textOf(findingsTree)
    assert.match(findingsTxt, /1 issue/)
    assert.doesNotMatch(findingsTxt, /exit 1/)
    const findingsPreview = h.all(findingsTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0]
    assert.ok(findingsPreview, 'Preview button must stay enabled for ok:true findings exit 1')
    findingsPreview.props.onClick()
    assert.equal(opened.at(-1), '/ws/deck.pptx')
    findingsInst.unmount()

    // `pptx layout --autofit -o fixed.pptx --json` with empty `autofitApplied` (no `data.file`) previews the input deck, not the unwritten `-o` path.
    const noAutofitInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      block: h.makeBlock('bash', { command: 'node /opt/office.js pptx layout deck.pptx --autofit -o fixed.pptx --json' }, {
        isError: true,
        content: [{ type: 'text', text: `${JSON.stringify({ ok: true, data: { autofitApplied: [], findings: [{ part: 'ppt/slides/slide1.xml', message: 'Off-slide image' }] } })}\n[exit code: 1]` }],
      }),
    })
    const noAutofitTree = noAutofitInst.render()
    h.all(noAutofitTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.equal(opened.at(-1), '/ws/deck.pptx')
    noAutofitInst.unmount()

    const errCliInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      block: h.makeBlock('bash', { command: 'node /opt/office.js docx read missing.docx --json' }, {
        isError: true,
        content: [{ type: 'text', text: `${JSON.stringify({ ok: false, error: { code: 'usage', message: 'no such file: missing.docx' } })}\n[exit code: 2]` }],
      }),
    })
    const errCliTree = errCliInst.render()
    assert.equal(h.all(errCliTree, n => n.props?.className === 'dsb-tool')[0].props['data-error'], true)
    assert.equal(h.all(errCliTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action').length, 0)
    // Open card to verify structured error message is extracted and displayed.
    h.all(errCliTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    assert.match(h.textOf(errCliInst.render()), /no such file: missing\.docx/)
    errCliInst.unmount()

    // 3. Backgrounded office.js CLI command keeps live BackgroundJobPanel + Stop button instead of hiding behind OfficeCliCard.
    h.sandbox.__testCall = async (endpoint) => (endpoint === 'job-read'
      ? { job: { id: 'job-office-1', status: 'running', startedAt: Date.now() - 1000 }, text: 'converting...\n', next: 1 }
      : {})
    const bgOfficeInst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      sessionId: 'parent-1',
      readOnly: false,
      block: h.makeBlock('bash', { command: 'node /opt/office.js docx write draft.docx -o final.docx --json', run_in_background: true }, {
        content: [{ type: 'text', text: 'started background job job-office-1' }],
      }),
    })
    bgOfficeInst.render()
    await tick()
    const bgOfficeTree = bgOfficeInst.render()
    assert.match(h.textOf(bgOfficeTree), /converting\.\.\./)
    assert.equal(h.all(bgOfficeTree, n => n.type === 'button' && n.props?.className === 'dsb-job-stop').length, 1)
    bgOfficeInst.unmount()
  } finally {
    dispose()
  }
})

test('read_image renders clickable thumbnail, loads full-res on lightbox enlarge, and opens preview', async () => {
  const h = createHarness()
  const { registerBuiltinToolViews, createSlotRegistry, ToolCallCard } = h.exports
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    const calls = []
    const opened = []
    const inst = h.mount(ToolCallCard, {
      registry,
      cwd: '/ws',
      openFile: p => opened.push(p),
      loadImage: async (id, opts) => {
        calls.push({ id, preview: opts?.preview })
        return `data:image/png;base64,${id}:${opts?.preview === false ? 'full' : 'thumb'}`
      },
      block: h.makeBlock('read_image', { file_path: '/ws/chart.png' }, {
        meta: { path: '/ws/chart.png' },
        content: [
          { type: 'text', text: 'Read image chart.png (800x600)' },
          { type: 'image', attachment: { attachmentId: 'img-42', width: 800, height: 600, bytes: 18432 } },
        ],
      }),
    })
    inst.render()
    await tick()
    let tree = inst.render()
    assert.match(h.textOf(tree), /Read image/)
    assert.match(h.textOf(tree), /800×600/)
    assert.equal(h.all(tree, n => n.props?.className === 'dsb-timg-meta').length, 0, 'Read image must not duplicate dimensions/size under thumbnail')
    const imgs = h.all(tree, n => n.type === 'img' && n.props?.className === 'dsb-timg')
    assert.equal(imgs.length, 1)
    assert.equal(imgs[0].props.src, 'data:image/png;base64,img-42:thumb')

    // Click thumbnail opens lightbox and requests full resolution (`preview: false`).
    h.all(tree, n => n.type === 'button' && n.props?.className === 'dsb-timg-btn')[0].props.onClick()
    inst.render()
    await tick()
    tree = inst.render()
    const lightImg = h.all(tree, n => n.type === 'img' && n.props?.className === 'dsb-lightbox-img')[0]
    assert.equal(lightImg.props.src, 'data:image/png;base64,img-42:full')
    assert.deepEqual(calls, [{ id: 'img-42', preview: true }, { id: 'img-42', preview: false }])

    // Preview header button opens file in right panel.
    h.all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.deepEqual(opened, ['/ws/chart.png'])
    inst.unmount()
  } finally {
    dispose()
  }
})

test('Browser and Computer Use tools render action, target, screenshot thumbnail, and panel actions', async () => {
  const h = createHarness()
  const { registerBuiltinToolViews, createSlotRegistry, ToolCallCard, ComputerToolView } = h.exports
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    const openedPanels = []
    const roster = { browser: true, computer: { enabled: true }, byId: { b1: { id: 'b1', name: 'Helper' } } }
    const actions = {
      openBrowser: id => openedPanels.push(['browser', id]),
      showDetails: (sid, tab) => openedPanels.push(['details', sid, tab]),
      computerShot: async id => ({ dataUrl: `data:image/png;base64,COMP_${id}` }),
    }

    // 1. browser_screenshot with image attachment + openBrowser action.
    const brInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'b1',
      botId: 'b1',
      roster,
      actions,
      loadImage: async id => `data:image/png;base64,BR_${id}`,
      block: h.makeBlock('browser_screenshot', {}, {
        content: [
          { type: 'text', text: 'URL: https://example.com/dashboard\nTitle: Dashboard' },
          { type: 'image', attachment: { attachmentId: 'shot-1', width: 1280, height: 800, bytes: 24000 } },
        ],
      }),
    })
    brInst.render()
    await tick()
    const brTree = brInst.render()
    assert.match(h.textOf(brTree), /Screenshot/)
    assert.match(h.textOf(brTree), /example\.com\/dashboard/)
    assert.equal(h.all(brTree, n => n.type === 'img' && n.props?.className === 'dsb-timg')[0].props.src, 'data:image/png;base64,BR_shot-1')
    h.all(brTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.deepEqual(openedPanels[0], ['browser', 'b1'])
    brInst.unmount()

    // 2. cua click call + screenshot fallback via computerShot + Computer panel button.
    const cuaInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'b1',
      botId: 'b1',
      roster,
      actions,
      loadImage: async () => null,
      hooks: {
        useComputer: sel => sel({ bots: { b1: { steps: [{ callId: 'call-cua', app: 'Finder' }] } }, holds: {}, asks: {} }),
      },
      block: h.makeBlock('cua', { method: 'click', params: { x: 420, y: 180 } }, {
        callId: 'call-cua',
        content: [{ type: 'file', attachment: { attachmentId: 'cua-shot-9', width: 640, height: 480 } }],
      }),
    })
    cuaInst.render()
    await tick()
    const cuaTree = cuaInst.render()
    const cuaTxt = h.textOf(cuaTree)
    assert.match(cuaTxt, /Click/)
    assert.match(cuaTxt, /Finder · \(420, 180\)/)
    assert.match(cuaTxt, /Background/)
    assert.equal(h.all(cuaTree, n => n.type === 'img' && n.props?.className === 'dsb-timg')[0].props.src, 'data:image/png;base64,COMP_cua-shot-9')
    h.all(cuaTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.deepEqual(openedPanels[1], ['details', 'b1', 'computer'])
    cuaInst.unmount()

    // 3. Wildcard `cua_driver_native__type_text` rendered via ComputerToolView.
    const drvInst = h.mount(ComputerToolView, {
      toolName: 'cua_driver_native__type_text',
      callId: 'call-drv',
      phase: 'result',
      useDisclosure: () => ({ expanded: false, toggle() {} }),
      block: h.makeBlock('cua_driver_native__type_text', { app_name: 'Notes', text: 'Quarterly summary' }),
    })
    const drvTxt = h.textOf(drvInst.render())
    assert.match(drvTxt, /Type text/)
    assert.match(drvTxt, /Notes/)
    drvInst.unmount()
  } finally {
    dispose()
  }
})

test('Subagent card opens child session in viewer, and background job card streams live output with two-press Stop', async () => {
  const h = createHarness()
  const {
    registerBuiltinToolViews,
    createSlotRegistry,
    ToolCallCard,
    resolveSubagentCatalog,
    SubagentLineageBar,
    SubagentReadOnlyBar,
  } = h.exports
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    // 1. Subagent catalog (real DSH `id` wire shape) + Open session callback + External withholding.
    const catalog = resolveSubagentCatalog({
      projections: {
        values: {
          subagentCatalog: [
            { id: 'sub-77', createdAt: 1000, name: 'researcher', mode: 'one-shot', label: 'Audit dependencies' },
            { id: 'ext-1', createdAt: 1001, name: 'codex-ext', mode: 'external', label: 'External agent' },
          ],
        },
      },
      events: [],
    })
    const openedSub = []
    const subInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      subagentCatalog: catalog,
      onOpenSubagent: info => openedSub.push(info),
      block: h.makeBlock('subagent', { description: 'Audit dependencies', prompt: 'Check package versions' }, {
        meta: { kind: 'activation', name: 'researcher' },
        content: [{ type: 'text', text: 'Done auditing dependencies.' }],
      }),
    })
    const subTree = subInst.render()
    assert.match(h.textOf(subTree), /Subagent/)
    assert.match(h.textOf(subTree), /Audit dependencies/)
    assert.match(h.textOf(subTree), /One-shot/)
    h.all(subTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(openedSub)), [{
      sessionId: 'sub-77',
      parentSessionId: 'parent-1',
      mode: 'one-shot',
      label: 'Audit dependencies',
      name: 'researcher',
    }])
    subInst.unmount()

    // External subagent shows localized External badge and withholds "Open session".
    const extInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      subagentCatalog: catalog,
      onOpenSubagent: info => openedSub.push(info),
      block: h.makeBlock('subagent', { description: 'External agent', prompt: 'Run externally' }, {
        meta: { kind: 'activation', name: 'codex-ext' },
        content: [{ type: 'text', text: 'Done.' }],
      }),
    })
    const extTree = extInst.render()
    assert.match(h.textOf(extTree), /External/)
    assert.equal(h.all(extTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action').length, 0)
    extInst.unmount()

    // Lineage bar & read-only bar navigation.
    let backed = 0
    const barInst = h.mount(SubagentLineageBar, {
      stack: openedSub,
      rootLabel: 'Main Bot',
      running: true,
      onBack: () => { backed += 1 },
      onSelectDepth: () => { backed += 10 },
    })
    const barTree = barInst.render()
    assert.match(h.textOf(barTree), /Main Bot/)
    assert.match(h.textOf(barTree), /Audit dependencies/)
    assert.match(h.textOf(barTree), /Read-only/)
    h.all(barTree, n => n.type === 'button' && n.props?.className === 'dsb-sub-back')[0].props.onClick()
    assert.equal(backed, 1)
    barInst.unmount()

    const roBar = h.mount(SubagentReadOnlyBar, { onBack: () => { backed += 1 } })
    assert.match(h.textOf(roBar.render()), /Viewing subagent session \(read-only\)/)
    roBar.unmount()

    // 2. Backgrounded shell command shows live BackgroundJobPanel + two-press Stop button.
    const apiCalls = []
    let killed = false
    h.sandbox.__testCall = async (endpoint, payload) => {
      apiCalls.push({ endpoint, payload })
      if (endpoint === 'job-read') {
        return {
          job: { id: 'job-bg-1', status: killed ? 'killed' : 'running', startedAt: Date.now() - 4000 },
          text: payload.from === 0 ? 'building bundle...\n' : '',
          next: 1,
        }
      }
      if (endpoint === 'job-kill') {
        killed = true
        return { ok: true, job: { id: 'job-bg-1', status: 'killed' } }
      }
      return {}
    }

    const bgInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      readOnly: false,
      block: h.makeBlock('bash', { command: 'npm run watch', run_in_background: true }, {
        content: [{ type: 'text', text: 'started background job job-bg-1' }],
      }),
    })
    bgInst.render()
    await tick()
    let bgTree = bgInst.render()
    assert.match(h.textOf(bgTree), /In background/)
    assert.match(h.textOf(bgTree), /building bundle\.\.\./)
    const stopBtn1 = h.all(bgTree, n => n.type === 'button' && n.props?.className === 'dsb-job-stop')[0]
    assert.match(h.textOf(stopBtn1), /Stop/)

    // First click arms the button without calling job-kill yet.
    stopBtn1.props.onClick()
    bgTree = bgInst.render()
    assert.equal(apiCalls.some(c => c.endpoint === 'job-kill'), false)
    const stopBtn2 = h.all(bgTree, n => n.type === 'button' && n.props?.className === 'dsb-job-stop')[0]
    assert.match(h.textOf(stopBtn2), /Confirm stop/)

    // Second click sends job-kill.
    stopBtn2.props.onClick()
    await tick()
    assert.equal(apiCalls.some(c => c.endpoint === 'job-kill' && c.payload.jobId === 'job-bg-1'), true)
    bgInst.unmount()

    // 3. Collapsed job_output watches status via lightweight `job-list` (never `job-read`),
    // and expanded BackgroundJobPanel renders `lossy` + `gapBefore` and unsubscribes at terminal status.
    let jobDone = false
    const collapsedCalls = []
    const feedListeners = new Set()
    const fakeFeed = { on: (fn) => { feedListeners.add(fn); return () => feedListeners.delete(fn) } }
    h.sandbox.__testCall = async (endpoint, payload) => {
      collapsedCalls.push({ endpoint, payload })
      if (endpoint === 'job-list') {
        return { jobs: [{ id: 'job-live-2', status: jobDone ? 'completed' : 'running', label: 'build' }] }
      }
      if (endpoint === 'job-read') {
        if (!jobDone) {
          return {
            job: { id: 'job-live-2', status: 'running', startedAt: Date.now() - 2000 },
            chunks: [{ at: 1, text: 'Compiling...\n', channel: 'stdout' }],
            text: payload.from === 0 ? 'Compiling...\n' : '',
            next: 1,
            lossy: false,
          }
        }
        return {
          job: { id: 'job-live-2', status: 'completed', startedAt: Date.now() - 3000, finishedAt: Date.now() },
          chunks: [{ at: 2, text: 'Build succeeded!\n', channel: 'stdout', gapBefore: true }],
          text: 'Build succeeded!\n',
          next: 2,
          lossy: true,
        }
      }
      return {}
    }
    const outInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      feed: fakeFeed,
      readOnly: false,
      block: h.makeBlock('job_output', { job_id: 'job-live-2' }, {
        content: [{ type: 'text', text: 'Compiling...\n[status: running]' }],
      }),
    })
    // While collapsed, only `job-list` is called (never `job-read`).
    const collapsedTree = outInst.render()
    await tick()
    assert.equal(collapsedCalls.some(c => c.endpoint === 'job-list'), true)
    assert.equal(collapsedCalls.some(c => c.endpoint === 'job-read'), false)

    // Open disclosure so BackgroundJobPanel mounts.
    const headBtn = h.all(collapsedTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0]
    headBtn.props.onClick()
    outInst.render()
    await tick()
    assert.match(h.textOf(outInst.render()), /Compiling\.\.\./)
    jobDone = true
    for (const fn of feedListeners) fn('jobs', { sessionId: 'parent-1', jobId: 'job-live-2' })
    await tick()
    const finishedTree = outInst.render()
    const finishedText = h.textOf(finishedTree)
    assert.match(finishedText, /Earlier output was dropped/)
    assert.match(finishedText, /Truncated/)
    assert.match(finishedText, /Build succeeded!/)
    assert.match(finishedText, /Completed/)
    // Copy button writes ONLY raw retained process text without the localized gap notice.
    const copyBtn = h.all(finishedTree, n => n.type === 'button' && n.props?.className?.includes('dsb-tool-copy'))[0]
    assert.ok(copyBtn)
    copyBtn.props.onClick()
    await tick()
    assert.equal(h.sandbox.__copied.at(-1), 'Compiling...\nBuild succeeded!\n')
    assert.doesNotMatch(h.sandbox.__copied.at(-1), /Earlier output was dropped/)
    // Terminal status unsubscribes from feed.
    assert.equal(feedListeners.size, 0)
    outInst.unmount()

    // 4. job_list with 1 active job uses singular '1 job', updates live, and unsubscribes once finished.
    let listLiveDone = false
    const listFeedListeners = new Set()
    const listFeed = { on: (fn) => { listFeedListeners.add(fn); return () => listFeedListeners.delete(fn) } }
    h.sandbox.__testCall = async () => ({
      jobs: [{ id: 'j-one', kind: 'bash', status: listLiveDone ? 'completed' : 'running', label: 'dev' }],
    })
    const listInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      feed: listFeed,
      readOnly: false,
      block: h.makeBlock('job_list', {}, {
        content: [{ type: 'text', text: 'j-one [bash] running — dev' }],
      }),
    })
    listInst.render()
    await tick()
    assert.match(h.textOf(listInst.render()), /1 job/)
    assert.equal(listFeedListeners.size, 1)
    listLiveDone = true
    for (const fn of listFeedListeners) fn('jobs', { sessionId: 'parent-1' })
    await tick()
    assert.match(h.textOf(listInst.render()), /Completed/)
    assert.equal(listFeedListeners.size, 0, 'job_list must unsubscribe once no jobs remain active')
    listInst.unmount()

    // 5. Historical completed job_list card neither fetches job-list nor subscribes to feed.
    let histCalls = 0
    const histFeedListeners = new Set()
    const histFeed = { on: (fn) => { histFeedListeners.add(fn); return () => histFeedListeners.delete(fn) } }
    h.sandbox.__testCall = async () => { histCalls += 1; return { jobs: [] } }
    const histInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      feed: histFeed,
      readOnly: false,
      block: h.makeBlock('job_list', {}, {
        content: [{ type: 'text', text: 'j-old [bash] completed — build' }],
      }),
    })
    histInst.render()
    await tick()
    const histTxt = h.textOf(histInst.render())
    assert.equal(histCalls, 0)
    assert.equal(histFeedListeners.size, 0)
    assert.match(histTxt, /j-old/)
    assert.doesNotMatch(histTxt, /No jobs/)
    histInst.unmount()

    // 6. Active job_list card preserves non-empty historical snapshot when live job-list is empty (pruned/restarted),
    //    hides stale Stop buttons, and unsubscribes from feed.
    const prunedFeedListeners = new Set()
    const prunedFeed = { on: (fn) => { prunedFeedListeners.add(fn); return () => prunedFeedListeners.delete(fn) } }
    h.sandbox.__testCall = async () => ({ jobs: [] })
    const prunedInst = h.mount(ToolCallCard, {
      registry,
      sessionId: 'parent-1',
      feed: prunedFeed,
      readOnly: false,
      block: h.makeBlock('job_list', {}, {
        content: [{ type: 'text', text: 'j-pruned [bash] running — server' }],
      }),
    })
    prunedInst.render()
    await tick()
    const prunedTree = prunedInst.render()
    assert.match(h.textOf(prunedTree), /j-pruned/)
    assert.doesNotMatch(h.textOf(prunedTree), /No jobs/)
    assert.equal(h.all(prunedTree, n => n.type === 'button' && n.props?.className === 'dsb-job-stop').length, 0)
    assert.equal(prunedFeedListeners.size, 0)
    prunedInst.unmount()

    // 7. JobStopButton localizes host errors via hostText in non-English locales.
    const { JobStopButton, installLocale } = h.exports
    const dicts = new Map()
    const disposeLocale = installLocale({
      dicts,
      getLocale: () => ({ active: 'zh' }),
      register: (ns, lang, dict) => {
        if (!dicts.has(ns)) dicts.set(ns, new Map())
        dicts.get(ns).set(lang, dict)
        return () => {}
      },
      bind: ns => key => dicts.get(ns)?.get('zh')?.[key] ?? key,
    })
    try {
      h.sandbox.__testCall = async () => { throw new Error('Job not found') }
      const stopErrInst = h.mount(JobStopButton, { sessionId: 'parent-1', jobId: 'j-missing' })
      let stopTree = stopErrInst.render()
      h.all(stopTree, n => n.type === 'button')[0].props.onClick() // arm
      stopTree = stopErrInst.render()
      h.all(stopTree, n => n.type === 'button')[0].props.onClick() // confirm -> fails
      await tick()
      assert.match(h.textOf(stopErrInst.render()), /未找到该后台任务/)
      stopErrInst.unmount()
    } finally {
      disposeLocale()
    }
  } finally {
    dispose()
  }
})

test('real recorded DSH 0.2.2-rc.5 session fixture projects and renders read_image, office.js CLI, read_browser, background bash, job_list, job_output, and subagent cards', async () => {
  const h = createHarness()
  const { registerBuiltinToolViews, createSlotRegistry, ToolCallCard, buildSessionRows, resolveSubagentCatalog } = h.exports
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    const log = {
      header: { id: 'session-recorded-1', cwd: '/workspace' },
      cursor: 99,
      events: RECORDED_FIXTURE.events,
      hasMore: false,
      projections: null,
      writing: null,
      streamRevision: null,
      revision: 1,
    }
    const rows = buildSessionRows(log, { roster: { bots: [], rooms: [], byId: {}, roomsById: {}, exchangeTurns: {} }, sessionId: 'session-recorded-1' })
    const toolRows = rows.filter(r => r.kind === 'tool')
    assert.equal(toolRows.length, 6)

    // Assert fixture is trimmed (no verbose unused `assistant/message` stream chunk arrays).
    assert.equal(
      RECORDED_FIXTURE.events.some(e => e.type === 'assistant/message' && Array.isArray(e.data?.stream)),
      false,
      'recorded fixture must strip unused assistant/message stream chunk arrays',
    )

    const recordedJobId = RECORDED_FIXTURE.events
      .filter(e => e.type === 'tool/call' && e.data?.name === 'job_output')
      .map(e => JSON.parse(e.data.arguments || '{}').job_id)[0]
    assert.ok(recordedJobId)

    const loadedImages = []
    const openedFiles = []
    h.sandbox.__testCall = async (endpoint) => {
      if (endpoint === 'job-read') return { job: { id: recordedJobId, status: 'running', startedAt: Date.now() - 2000 }, text: 'Watching build output...\n', next: 1 }
      if (endpoint === 'job-list') return { jobs: [{ id: recordedJobId, kind: 'bash', status: 'running', label: 'Dev build watcher' }] }
      return {}
    }

    const renderedTexts = []
    for (const row of toolRows) {
      const inst = h.mount(ToolCallCard, {
        registry,
        entry: row,
        cwd: '/workspace',
        sessionId: 'session-recorded-1',
        botId: 'session-recorded-1',
        roster: { browser: true, computer: { enabled: false }, byId: {} },
        actions: { openFile: p => openedFiles.push(p), openBrowser() {} },
        openFile: p => openedFiles.push(p),
        loadImage: async (id) => { loadedImages.push(id); return `data:image/png;base64,REC_${id}` },
      })
      inst.render()
      await tick()
      renderedTexts.push(h.textOf(inst.render()))
      inst.unmount()
    }
    const joined = renderedTexts.join('\n')
    assert.match(joined, /Read image/)
    assert.match(joined, /480×280/)
    assert.equal(loadedImages.length, 1, 'read_image card must auto-load thumbnail from recorded DSH tool/result attachment')
    assert.match(joined, /Word document/)
    assert.match(joined, /quarterly-report\.docx/)
    assert.match(joined, /In background/)
    assert.match(joined, /Watching build output/)
    assert.match(joined, /Read page/)
    assert.match(joined, /Background jobs/)
    assert.match(joined, /1 job/)
    assert.match(joined, /Job output/)

    // Recorded DSH 0.2.2-rc.5 Classic Agent subagent session (including live `subagent/catalog` event).
    assert.ok(RECORDED_FIXTURE.subagentSession?.events?.length > 0)
    const subLog = {
      header: { id: 'session-classic-recorded-1', cwd: '/workspace' },
      cursor: 50,
      events: RECORDED_FIXTURE.subagentSession.events,
      hasMore: false,
      projections: null,
      writing: null,
      streamRevision: null,
      revision: 1,
    }
    const subCatalog = resolveSubagentCatalog(subLog)
    assert.equal(subCatalog.length, 1)
    assert.equal(subCatalog[0].name, 'agent-1')
    assert.equal(subCatalog[0].mode, 'continuable')
    const subRows = buildSessionRows(subLog, { roster: { bots: [], rooms: [], byId: {}, roomsById: {}, exchangeTurns: {} }, sessionId: 'session-classic-recorded-1' })
    const subToolRow = subRows.find(r => r.kind === 'tool' && r.block?.name === 'subagent')
    assert.ok(subToolRow)
    const openedSub = []
    const subInst = h.mount(ToolCallCard, {
      registry,
      entry: subToolRow,
      cwd: '/workspace',
      sessionId: 'session-classic-recorded-1',
      subagentCatalog: subCatalog,
      onOpenSubagent: info => openedSub.push(info),
    })
    const subTree = subInst.render()
    const subTxt = h.textOf(subTree)
    assert.match(subTxt, /Subagent/)
    assert.match(subTxt, /Inspect architecture diagram/)
    assert.match(subTxt, /Continuable/)
    assert.match(subTxt, /Open session/)
    h.all(subTree, n => n.type === 'button' && n.props?.className === 'dsb-tool-action')[0].props.onClick()
    assert.equal(openedSub[0]?.sessionId, subCatalog[0].childSessionId)
    subInst.unmount()
  } finally {
    dispose()
  }
})
