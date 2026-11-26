import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './ui/src/approval-dock.js'
      export { ShortcutsDialog } from './ui/src/shortcuts.js'
      export { ShortcutsPage } from '../ds-bot/src/client/shortcuts-page.js'
      export { createShortcutStore } from '../ds-bot/src/client/shortcuts-model.js'
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
})

function loadHarness() {
  const winListeners = new Map()
  let active = null
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.flat(Infinity) },
  })
  const reactStub = {
    createElement,
    Fragment: ({ children }) => ({ type: 'fragment', props: { children } }),
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
    useMemo(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.s[i] = { deps, val: fn() }
      }
      return active.s[i].val
    },
    useCallback: fn => fn,
    useEffect(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.e.push({ i, fn, deps, prev })
      }
    },
  }
  const win = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn)
    },
  }
  const doc = {
    body: { tagName: 'BODY' },
    documentElement: { tagName: 'HTML' },
    activeElement: null,
    querySelector: () => null,
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: win,
    document: doc,
    navigator: { platform: 'MacIntel', userAgent: 'Mac OS X' },
    Element: class {},
    module: { exports: {} },
    exports: {},
    require: (id) => (id === 'react' ? reactStub : id === 'react-dom' ? { createPortal: node => node } : {}),
  }
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)

  function mount(Comp, initialProps) {
    let props = initialProps
    const state = new Map()
    const renderNode = (node, path) => {
      if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map((c, idx) => renderNode(c, `${path}.${idx}`))
      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name || 'fn'}`
        const st = state.get(key) ?? { s: [] }
        state.set(key, st)
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
        for (const st of state.values()) {
          for (const slot of st.s) if (typeof slot?.cleanup === 'function') slot.cleanup()
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

  return { exports: sandbox.module.exports, mount, all, textOf, winListeners, doc }
}

test('matchApprovalShortcut respects composer inputs, IME, modals, focused buttons, and alwaysAllow eligibility', () => {
  const { exports: { matchApprovalShortcut } } = loadHarness()
  const baseEvent = (overrides = {}) => ({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 13,
    target: { tagName: 'BODY' },
    ...overrides,
  })
  const cleanDoc = { activeElement: { tagName: 'BODY' }, querySelector: () => null }

  assert.equal(matchApprovalShortcut(baseEvent(), { canAlways: false, doc: cleanDoc, escapeLayerOpen: false }), 'allow')
  assert.equal(matchApprovalShortcut(baseEvent({ shiftKey: true }), { canAlways: false, doc: cleanDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ shiftKey: true }), { canAlways: true, doc: cleanDoc, escapeLayerOpen: false }), 'always')
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27 }), { canAlways: true, doc: cleanDoc, escapeLayerOpen: false }), 'reject')

  // Guard: composer textarea / input / contenteditable blocks BOTH Enter and Escape.
  const textareaDoc = { activeElement: { tagName: 'TEXTAREA' }, querySelector: () => null }
  assert.equal(matchApprovalShortcut(baseEvent(), { canAlways: true, doc: textareaDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27 }), { canAlways: true, doc: textareaDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ target: { isContentEditable: true } }), { canAlways: true, doc: cleanDoc, escapeLayerOpen: false }), null)

  // Guard: IME composition blocks shortcuts.
  assert.equal(matchApprovalShortcut(baseEvent({ isComposing: true }), { canAlways: true, doc: cleanDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ keyCode: 229 }), { canAlways: true, doc: cleanDoc, escapeLayerOpen: false }), null)

  // Guard: open modal / overlay blocks shortcuts.
  assert.equal(matchApprovalShortcut(baseEvent(), { canAlways: true, doc: cleanDoc, escapeLayerOpen: true }), null)
  assert.equal(matchApprovalShortcut(baseEvent(), { canAlways: true, doc: { activeElement: null, querySelector: () => ({}) }, escapeLayerOpen: false }), null)

  // Guard: focused button blocks Enter (so the focused button activates naturally) while Esc still rejects.
  const buttonDoc = { activeElement: { tagName: 'BUTTON' }, querySelector: () => null }
  assert.equal(matchApprovalShortcut(baseEvent(), { canAlways: true, doc: buttonDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27 }), { canAlways: true, doc: buttonDoc, escapeLayerOpen: false }), 'reject')
})

test('ApprovalDock renders Always allow + scope + keycaps, fires keyboard shortcuts, and lists shortcuts in both sheets', async () => {
  const { exports: { ApprovalDock, ShortcutsDialog, ShortcutsPage, createShortcutStore, resolveApprovalReason }, mount, all, textOf, winListeners, doc } = loadHarness()

  // Localized displayReason resolution including zh-TW conversion.
  assert.equal(resolveApprovalReason({
    reason: 'English fallback',
    displayReason: { en: 'English text', zh: '允许下载文件吗？' },
  }, 'zh'), '允许下载文件吗？')
  assert.equal(resolveApprovalReason({
    reason: 'English fallback',
    displayReason: { en: 'English text', zh: '允许下载文件吗？' },
  }, 'zh-TW'), '允許下載文件嗎？')

  const calls = []
  const approvals = [{
    id: 'ap-1',
    botId: 'b1',
    sessionId: 'b1',
    tool: 'browser_click',
    reason: 'Let Bot download on github.com?',
    alwaysAllow: { kind: 'browser', site: 'github.com', action: 'download' },
    answerable: true,
  }]
  const inst = mount(ApprovalDock, {
    botId: 'b1',
    sessionId: 'b1',
    useWork: sel => sel({ approvals }),
    actions: { answerApproval: async (id, choice) => { calls.push({ id, choice }) } },
    readOnly: false,
  })
  try {
    const tree = inst.render()
    const text = textOf(tree)
    assert.match(text, /Always allow downloading files on github\.com/)
    assert.match(text, /Reject/)
    assert.match(text, /Allow once/)
    assert.match(text, /Always allow/)

    const listeners = [...(winListeners.get('keydown') ?? [])]
    assert.equal(listeners.length, 1)

    // Firing Shift+Enter while composer is NOT focused triggers 'always'.
    doc.activeElement = { tagName: 'BODY' }
    let prevented = false
    listeners[0]({
      key: 'Enter',
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 13,
      target: { tagName: 'BODY' },
      preventDefault() { prevented = true },
      stopPropagation() {},
    })
    assert.equal(prevented, true)
    assert.deepEqual(calls, [{ id: 'ap-1', choice: 'always' }])
  } finally {
    inst.unmount()
  }

  // Both ShortcutsDialog and ShortcutsPage list the three approval shortcuts.
  const store = createShortcutStore()
  const dialog = mount(ShortcutsDialog, { open: true, store, onClose() {} })
  const dialogText = textOf(dialog.render())
  assert.match(dialogText, /Allow approval/)
  assert.match(dialogText, /Always allow approval/)
  assert.match(dialogText, /Reject approval/)
  dialog.unmount()

  const Section = ({ title, children }) => ({ type: 'section', props: { children: [title, children] } })
  const Row = ({ label, children }) => ({ type: 'row', props: { children: [label, children] } })
  const page = mount(ShortcutsPage, { roster: { prefs: {} }, actions: {}, Section, Row, store })
  const pageText = textOf(page.render())
  assert.match(pageText, /Allow approval/)
  assert.match(pageText, /Always allow approval/)
  assert.match(pageText, /Reject approval/)
  page.unmount()
})
