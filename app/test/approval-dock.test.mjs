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
      export { ApprovalCard as MemberApprovalCard, ApprovalIslandPod } from '../ds-bot/src/client/member-status.js'
      export { TaskIslandPanel } from '../ds-bot/src/client/bot-tasks.js'
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
  plugins: [{
    name: 'approval-dock-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({ path: 'dsh-primitives.js', namespace: 'ad-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'ad-stub' }, () => ({
        contents: `
          export const MarkdownText = ({ text }) => text ?? null
          export const writeClipboard = async () => true
          export const fileExtension = () => ''
          export const fileSizeText = () => ''
        `,
        loader: 'js',
      }))
      bundler.onResolve({ filter: /cells\.js$/ }, () => ({ path: 'cells.js', namespace: 'ad-cells-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'ad-cells-stub' }, () => ({
        contents: `
          export const Elapsed = () => null
          export const Shimmer = ({ children }) => children ?? null
          export const workPhrase = () => ''
        `,
        loader: 'js',
      }))
    },
  }],
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
    createContext: value => ({ Provider: ({ children }) => children, _currentValue: value }),
    useContext: ctx => ctx?._currentValue,
    memo: fn => fn,
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
    useLayoutEffect(fn, deps) {
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
    HTMLElement: class {},
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

test('matchApprovalShortcut requires card focus, never binds Shift+Enter, and guards inputs, IME, modals, and focused buttons', () => {
  const { exports: { matchApprovalShortcut } } = loadHarness()
  const cardEl = {
    tagName: 'DIV',
    contains(node) { return node === cardEl || node?.insideCard === true },
  }
  const focusedCardDoc = { activeElement: cardEl, querySelector: () => null }
  const unfocusedDoc = { activeElement: { tagName: 'BODY' }, querySelector: () => null }
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
    target: cardEl,
    currentTarget: cardEl,
    ...overrides,
  })

  // Unfocused card NEVER fires Enter or Escape.
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: unfocusedDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27 }), { cardEl, doc: unfocusedDoc, escapeLayerOpen: false }), null)

  // Focused card fires Enter -> allow, Escape -> reject, and NEVER Shift+Enter.
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), 'allow')
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27 }), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), 'reject')
  assert.equal(matchApprovalShortcut(baseEvent({ shiftKey: true }), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ metaKey: true }), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), null)

  // Guard: editable element inside card blocks both Enter and Escape.
  const inputNode = { tagName: 'TEXTAREA', insideCard: true }
  const textareaDoc = { activeElement: inputNode, querySelector: () => null }
  assert.equal(matchApprovalShortcut(baseEvent({ target: inputNode }), { cardEl, doc: textareaDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27, target: inputNode }), { cardEl, doc: textareaDoc, escapeLayerOpen: false }), null)

  // Guard: IME composition blocks shortcuts.
  assert.equal(matchApprovalShortcut(baseEvent({ isComposing: true }), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ keyCode: 229 }), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false, composing: true }), null)
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: focusedCardDoc, escapeLayerOpen: false, compositionEnded: true }), null)

  // Guard: open modal / overlay blocks shortcuts.
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: focusedCardDoc, escapeLayerOpen: true }), null)
  assert.equal(matchApprovalShortcut(baseEvent(), { cardEl, doc: { activeElement: cardEl, querySelector: () => ({}) }, escapeLayerOpen: false }), null)

  // Guard: focused button inside card blocks Enter (so button activates naturally) while Esc still rejects.
  const btnNode = { tagName: 'BUTTON', insideCard: true }
  const buttonDoc = { activeElement: btnNode, querySelector: () => null }
  assert.equal(matchApprovalShortcut(baseEvent({ target: btnNode }), { cardEl, doc: buttonDoc, escapeLayerOpen: false }), null)
  assert.equal(matchApprovalShortcut(baseEvent({ key: 'Escape', keyCode: 27, target: btnNode }), { cardEl, doc: buttonDoc, escapeLayerOpen: false }), 'reject')
})

test('ApprovalDock keeps Allow once primary, scopes shortcuts to card focus without Shift+Enter, and lists accurate shortcuts', async () => {
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
    tool: 'write',
    reason: 'Allow this operation with danger-full-access permissions: Save report outside workspace',
    detail: { code: '/tmp/shared-notes/report.md', text: 'Save report outside workspace' },
    alwaysAllow: { kind: 'extra-dir', dirs: ['/tmp/shared-notes'], scope: 'bot' },
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
    assert.match(text, /Always allow file edits in \/tmp\/shared-notes/)
    assert.doesNotMatch(text, /danger-full-access/)
    assert.match(text, /Reject/)
    assert.match(text, /Allow once/)
    assert.match(text, /Always allow/)

    // Reject (secondary), Allow once (primary), Always allow (secondary, NO keycap!).
    const buttons = all(tree, n => n.type === 'button')
    assert.equal(buttons[0].props.className, 'bt-q-btn')
    assert.equal(buttons[1].props.className, 'bt-q-submit')
    assert.equal(buttons[2].props.className, 'bt-q-btn')
    assert.equal(all(buttons[2], n => n.type === 'kbd').length, 0, 'Always allow must not carry a keyboard shortcut keycap')

    // Zero global window keydown listeners registered by ApprovalDock.
    assert.equal((winListeners.get('keydown')?.size ?? 0), 0)

    // Card itself has tabIndex=0 and handles card-focused Enter/Esc, ignoring Shift+Enter.
    const cardNode = all(tree, n => n.props?.className === 'dsb-approval')[0]
    assert.equal(cardNode.props.tabIndex, 0)
    const fakeCardDom = { tagName: 'DIV', contains: node => node === fakeCardDom }

    // Unfocused: Enter does nothing.
    doc.activeElement = { tagName: 'BODY' }
    cardNode.props.onKeyDown({
      key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
      repeat: false, defaultPrevented: false, isComposing: false, keyCode: 13,
      target: fakeCardDom, currentTarget: fakeCardDom,
      preventDefault() {}, stopPropagation() {},
    })
    assert.equal(calls.length, 0)

    // Focused + Shift+Enter: does NOT trigger Always allow.
    doc.activeElement = fakeCardDom
    cardNode.props.onKeyDown({
      key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false,
      repeat: false, defaultPrevented: false, isComposing: false, keyCode: 13,
      target: fakeCardDom, currentTarget: fakeCardDom,
      preventDefault() {}, stopPropagation() {},
    })
    assert.equal(calls.length, 0)

    // Focused + plain Enter: triggers Allow once.
    let prevented = false
    cardNode.props.onKeyDown({
      key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
      repeat: false, defaultPrevented: false, isComposing: false, keyCode: 13,
      target: fakeCardDom, currentTarget: fakeCardDom,
      preventDefault() { prevented = true }, stopPropagation() {},
    })
    assert.equal(prevented, true)
    assert.deepEqual(calls, [{ id: 'ap-1', choice: 'allow' }])
  } finally {
    inst.unmount()
  }

  // Both ShortcutsDialog and ShortcutsPage list focused Enter/Esc only, never Shift+Enter / Always allow approval.
  const store = createShortcutStore()
  const dialog = mount(ShortcutsDialog, { open: true, store, onClose() {} })
  const dialogText = textOf(dialog.render())
  assert.match(dialogText, /Allow approval \(card focused\)/)
  assert.match(dialogText, /Reject approval \(card focused\)/)
  assert.doesNotMatch(dialogText, /Always allow approval/)
  dialog.unmount()

  const Section = ({ title, children }) => ({ type: 'section', props: { children: [title, children] } })
  const Row = ({ label, children }) => ({ type: 'row', props: { children: [label, children] } })
  const page = mount(ShortcutsPage, { roster: { prefs: {} }, actions: {}, Section, Row, store })
  const pageText = textOf(page.render())
  assert.match(pageText, /Allow approval \(card focused\)/)
  assert.match(pageText, /Reject approval \(card focused\)/)
  assert.doesNotMatch(pageText, /Always allow approval/)
  page.unmount()
})

test('group ApprovalCard and background TaskIslandPanel disclose group/bot scope, localize displayReason, and hide Always allow in read-only mode', () => {
  const { exports: { MemberApprovalCard, TaskIslandPanel }, mount, all, textOf } = loadHarness()
  const bot = { id: 'b1', name: 'Helper', color: 'blue', tasks: [] }
  const groupApproval = {
    id: 'ap-grp',
    botId: 'b1',
    roomId: 'r1',
    tool: 'write',
    reason: 'Fallback English',
    displayReason: { en: 'Save design notes outside group workspace' },
    detail: { code: '/tmp/design/spec.md' },
    alwaysAllow: { kind: 'extra-dir', dirs: ['/tmp/design'], scope: 'group', scopeName: 'Design' },
    answerable: true,
  }

  // Writable group ApprovalCard shows group scope disclosure and keeps Allow once primary.
  const card = mount(MemberApprovalCard, { approval: groupApproval, bot, actions: { answerApproval() {}, reportError() {} }, showBot: true, readOnly: false })
  const cardTree = card.render()
  const cardText = textOf(cardTree)
  assert.match(cardText, /Save design notes outside group workspace/)
  assert.match(cardText, /Always allow this group to edit files in \/tmp\/design/)
  const cardBtns = all(cardTree, n => n.type === 'button')
  assert.equal(cardBtns[0].props.className, 'bt-q-btn')
  assert.equal(cardBtns[1].props.className, 'bt-q-submit')
  assert.equal(cardBtns[2].props.className, 'bt-q-btn')
  card.unmount()

  // Read-only group ApprovalCard hides Always allow and disables buttons.
  const roCard = mount(MemberApprovalCard, { approval: groupApproval, bot, actions: { answerApproval() {}, reportError() {} }, showBot: true, readOnly: true })
  const roTree = roCard.render()
  assert.doesNotMatch(textOf(roTree), /Always allow/)
  assert.equal(all(roTree, n => n.type === 'button').every(b => b.props.disabled === true), true)
  roCard.unmount()

  // Background TaskIslandPanel also discloses scope, keeps Allow once primary, and hides Always allow in readOnly.
  const taskApprovals = [{ kind: 'tool', id: 'ap-grp', botId: 'b1', bot, at: 1000, approval: groupApproval }]
  const panel = mount(TaskIslandPanel, {
    bot,
    roster: { byId: { b1: bot }, roomsById: {}, prefs: {}, readOnly: null },
    approvals: taskApprovals,
    targetId: 'b1',
    actions: { answerApproval() {} },
  })
  const panelTree = panel.render()
  assert.match(textOf(panelTree), /Always allow this group to edit files in \/tmp\/design/)
  const allowBtn = all(panelTree, n => n.type === 'button' && textOf(n).trim() === 'Allow once')[0]
  const alwaysBtn = all(panelTree, n => n.type === 'button' && textOf(n).trim() === 'Always allow')[0]
  assert.equal(allowBtn.props.className, 'bt-btask-btn is-primary')
  assert.equal(alwaysBtn.props.className, 'bt-btask-btn')
  panel.unmount()

  const roPanel = mount(TaskIslandPanel, {
    bot,
    roster: { byId: { b1: bot }, roomsById: {}, prefs: {}, readOnly: 'Read-only' },
    approvals: taskApprovals,
    targetId: 'b1',
    actions: { answerApproval() {} },
  })
  assert.doesNotMatch(textOf(roPanel.render()), /Always allow/)
  roPanel.unmount()
})

test('foregroundApprovalsOf and ApprovalDock surface and answer Classic Agent subagent approvals via ownerSessionId', async () => {
  const { exports: { ApprovalDock, foregroundApprovalsOf }, mount, all, textOf } = loadHarness()
  const approvals = [
    {
      id: 'ap-sub-1',
      sessionId: 'classic-sub-1',
      ownerSessionId: 'classic-parent-1',
      tool: 'write',
      reason: 'Subagent requests write access',
      detail: { code: '/tmp/work/out.md' },
      answerable: true,
    },
    {
      id: 'ap-other-sub',
      sessionId: 'classic-sub-2',
      ownerSessionId: 'classic-parent-2',
      tool: 'bash',
      reason: 'Other classic session approval',
      answerable: true,
    },
  ]

  const matched = foregroundApprovalsOf(approvals, undefined, 'classic-parent-1')
  assert.deepEqual(matched.map(entry => entry.id), ['ap-sub-1'])

  const calls = []
  const inst = mount(ApprovalDock, {
    botId: undefined,
    sessionId: 'classic-parent-1',
    useWork: sel => sel({ approvals }),
    actions: { answerApproval: async (id, choice) => { calls.push({ id, choice }) } },
    readOnly: false,
  })
  try {
    const tree = inst.render()
    const txt = textOf(tree)
    assert.match(txt, /Subagent requests write access/)
    assert.doesNotMatch(txt, /Other classic session approval/)
    assert.doesNotMatch(txt, /Always allow/)
    const allowBtn = all(tree, n => n.type === 'button' && textOf(n).includes('Allow once'))[0]
    allowBtn.props.onClick()
    assert.deepEqual(calls, [{ id: 'ap-sub-1', choice: 'allow' }])
  } finally {
    inst.unmount()
  }
})
