import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { BotViews } from '../src/bot-views.mjs'
import { matchForwardedShortcut } from '../src/shortcut-match.mjs'

const BOT = 'session-11111111-1111-4111-8111-111111111111'

class FakeWebContents extends EventEmitter {
  #url = 'about:blank'
  #title = ''
  debugger = {
    attached: false,
    on() {},
    attach() { this.attached = true },
    detach() { this.attached = false },
    async sendCommand() { return {} },
  }
  isDestroyed() { return false }
  isLoading() { return false }
  canGoBack() { return false }
  canGoForward() { return false }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  getURL() { return this.#url }
  getTitle() { return this.#title }
  setAudioMuted() {}
  setWindowOpenHandler() {}
  focus() {}
  loadURL(url) { this.#url = url; return Promise.resolve() }
  close() {}
  destroy() {}
}

class FakeWebContentsView {
  constructor() {
    this.webContents = new FakeWebContents()
    this.visible = false
    this.bounds = null
  }
  setBounds(bounds) { this.bounds = bounds }
  setVisible(visible) { this.visible = visible }
}

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { ShortcutsDialog, matchGlobalShortcut, resolveActiveModal } from './ui/src/shortcuts.js'
      export { ShortcutsPage } from '../ds-bot/src/client/shortcuts-page.js'
      export { createShortcutStore } from '../ds-bot/src/client/shortcuts-model.js'
      export { ESCAPE_PRIORITY, settingsOwnsKeyboard, useEscape } from '../ds-bot/src/client/overlay-hooks.js'
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

function loadUi() {
  const winListeners = new Map()
  const docCaptureListeners = new Map()
  const docBubbleListeners = new Map()
  const portalTargets = []
  let active = null
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } })
  const reactStub = {
    createElement,
    Fragment: ({ children }) => ({ type: 'fragment', props: { children } }),
    Component: class {},
    createContext: v => ({ Provider: ({ children }) => children, _v: v }),
    useContext: c => c?._v,
    useCallback: fn => fn,
    useLayoutEffect() {},
    useId: () => 'id',
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
    useEffect(fn, deps) {
      const i = active.i++
      const prev = active.s[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        active.e.push({ i, fn, deps, prev })
      }
    },
  }
  const reactDomStub = {
    createPortal: (node, target) => { portalTargets.push(target); return node },
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
    addEventListener(type, fn, capture) {
      const bucket = capture ? docCaptureListeners : docBubbleListeners
      if (!bucket.has(type)) bucket.set(type, new Set())
      bucket.get(type).add(fn)
    },
    removeEventListener(type, fn, capture) {
      const bucket = capture ? docCaptureListeners : docBubbleListeners
      bucket.get(type)?.delete(fn)
    },
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
    require: (id) => (id === 'react' ? reactStub : id === 'react-dom' ? reactDomStub : {}),
  }
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)

  function expand(node) {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      return expand(node.type(node.props ?? {}))
    }
    return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children ?? []) } }
  }

  function mount(Comp, initialProps) {
    let props = initialProps
    const state = { s: [] }
    const runEffects = (queued) => {
      for (const item of queued) {
        if (typeof item.prev?.cleanup === 'function') item.prev.cleanup()
        const cleanup = item.fn()
        state.s[item.i] = { deps: item.deps, cleanup }
      }
    }
    return {
      render(nextProps = props) {
        props = nextProps
        active = { i: 0, s: state.s, e: [] }
        const raw = Comp(props)
        const queued = active.e
        active = null
        runEffects(queued)
        return expand(raw)
      },
      unmount() {
        for (const slot of state.s) {
          if (typeof slot?.cleanup === 'function') slot.cleanup()
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
  return { exports: sandbox.module.exports, mount, all, textOf, winListeners, docCaptureListeners, docBubbleListeners }
}

test('matchForwardedShortcut and BotViews forward matching whitelist shortcuts and return focus safely', async () => {
  const whitelist = [
    { id: 'browser', code: 'KeyB', mod: true, ctrl: false, alt: false, shift: false },
    { id: 'switch-surface', code: 'KeyM', mod: true, ctrl: false, alt: false, shift: true },
    { id: 'terminal', code: 'Backquote', mod: false, ctrl: true, alt: false, shift: false },
  ]
  // Exact matching across darwin and win32, guarding keyUp, IME, and auto-repeat.
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, code: 'KeyB' }, whitelist, 'darwin'), 'browser')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, code: 'KeyB' }, whitelist, 'win32'), 'browser')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, shift: true, code: 'KeyM' }, whitelist, 'darwin'), 'switch-surface')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, code: 'Backquote' }, whitelist, 'darwin'), 'terminal')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, code: 'KeyB', isAutoRepeat: true }, whitelist, 'darwin'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, code: 'KeyB', isComposing: true }, whitelist, 'darwin'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyUp', meta: true, code: 'KeyB' }, whitelist, 'darwin'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, code: 'KeyC' }, whitelist, 'darwin'), null)
  // On Windows/Linux, Ctrl+Alt on non-function keys is reserved for AltGr character entry across all layouts,
  // while Ctrl+Alt+F-keys, macOS Option dead keys, and macOS Cmd/Ctrl+Alt shortcuts still match consistently.
  const altList = [
    { id: 'browser', code: 'KeyQ', mod: true, ctrl: false, alt: true, shift: false },
    { id: 'inbox', code: 'Period', mod: true, ctrl: false, alt: true, shift: false },
    { id: 'settings', code: 'F8', mod: true, ctrl: false, alt: true, shift: false },
    { id: 'terminal', code: 'KeyE', mod: false, ctrl: false, alt: true, shift: false },
  ]
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, alt: true, code: 'KeyQ', key: '@', modifiers: ['control', 'alt', 'altgraph'] }, altList, 'win32'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, alt: true, code: 'KeyQ', key: '@' }, altList, 'win32'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, alt: true, code: 'Period', key: '.' }, altList, 'linux'), null)
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, alt: true, code: 'F8', key: 'F8' }, altList, 'win32'), 'settings')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', meta: true, alt: true, code: 'KeyQ', key: 'œ' }, altList, 'darwin'), 'browser')
  // macOS Option+E produces key='Dead' on U.S. layout; must stay consistent with renderer matching.
  assert.equal(matchForwardedShortcut({ type: 'keyDown', alt: true, code: 'KeyE', key: 'Dead' }, altList, 'darwin'), 'terminal')
  // Stored Ctrl+Minus (recorded on German Ctrl+ß) matches 'ß' but yields to '-' zoom after switching to US layout.
  const zoomList = [{ id: 'settings', code: 'Minus', mod: true, ctrl: false, alt: false, shift: false }]
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, code: 'Minus', key: 'ß' }, zoomList, 'win32'), 'settings')
  assert.equal(matchForwardedShortcut({ type: 'keyDown', control: true, code: 'Minus', key: '-' }, zoomList, 'win32'), null)

  const received = []
  let focusedMain = 0
  const fakeWindow = {
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { focus() { focusedMain += 1 } },
  }
  const views = new BotViews({
    window: () => fakeWindow,
    WebContentsView: FakeWebContentsView,
    guests: {
      storageFor: () => ({}),
      partitionOf: () => ({}),
      setDownloadHandler() {},
    },
    origin: () => 'http://127.0.0.1:3000',
    onInputShortcut: (input) => {
      const id = matchForwardedShortcut(input, whitelist, 'darwin')
      if (!id) return false
      fakeWindow.webContents.focus()
      received.push(id)
      return true
    },
  })

  try {
    const entry = views.create(BOT, { url: 'https://example.com' })
    let prevented = 0
    entry.view.webContents.emit('before-input-event', { preventDefault() { prevented += 1 } }, { type: 'keyDown', meta: true, code: 'KeyB' })
    assert.deepEqual(received, ['browser'])
    assert.equal(prevented, 1)
    assert.equal(focusedMain, 1)

    // Ordinary page typing or unmatched shortcut must NOT be prevented or steal focus.
    entry.view.webContents.emit('before-input-event', { preventDefault() { prevented += 1 } }, { type: 'keyDown', meta: true, code: 'KeyC' })
    assert.equal(prevented, 1)
    assert.equal(focusedMain, 1)
  } finally {
    views.dispose()
  }
})

test('ShortcutsDialog and ShortcutsPage filter by capability, honor IME/conflict keyboard nav, and guard reset conflicts', () => {
  const { exports, mount, all, textOf, winListeners } = loadUi()

  const storageMap = new Map()
  const store = exports.createShortcutStore({
    mac: true,
    storage: {
      getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => { storageMap.set(k, v) },
    },
  })

  // Customize browser shortcut and verify ShortcutsDialog hides unavailable Inbox when hasInbox=false.
  store.setBinding('browser', { code: 'KeyJ', mod: true, ctrl: false, alt: false, shift: false })
  let customized = 0
  let closed = 0
  const dialogInst = mount(exports.ShortcutsDialog, {
    open: true,
    enterToSend: true,
    hasSurface: true,
    hasBrowser: true,
    hasInbox: false,
    store,
    onCustomize: () => { customized += 1 },
    onClose: () => { closed += 1 },
  })
  try {
    let tree = dialogInst.render()
    let bodyText = textOf(tree)
    assert.match(bodyText, /Switch Bot \/ Classic Agent mode/)
    assert.doesNotMatch(bodyText, /Open Inbox/)
    assert.match(bodyText, /Toggle Bot browser/)
    assert.match(bodyText, /Switch to conversation 1–9/)
    const browserRow = all(tree, n => n.props?.className === 'dsb-shortcuts-row' && /Toggle Bot browser/.test(textOf(n)))[0]
    assert.ok(browserRow)
    assert.match(textOf(browserRow), /⌘.*J/)

    // When hasInbox=true (#782 mounted), Open Inbox appears immediately.
    tree = dialogInst.render({
      open: true, enterToSend: true, hasSurface: true, hasBrowser: true, hasInbox: true,
      store, onCustomize: () => { customized += 1 }, onClose: () => { closed += 1 },
    })
    assert.match(textOf(tree), /Open Inbox/)

    const customizeBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-shortcuts-customize'))[0]
    assert.ok(customizeBtn)
    customizeBtn.props.onClick()
    assert.equal(closed, 1)
    assert.equal(customized, 1)
  } finally {
    dialogInst.unmount()
  }

  // ShortcutsPage filters unavailable Inbox when actions.openInbox is absent, shows it when present.
  const Section = ({ title, children }) => ({ type: 'section', props: { title, children } })
  const Row = ({ label, children }) => ({ type: 'row', props: { label, children } })
  const pageInst = mount(exports.ShortcutsPage, {
    roster: { prefs: { enterToSend: true }, browser: true },
    actions: { setSurface() {}, openBrowser() {}, openInbox() {} },
    Section,
    Row,
    store,
  })
  try {
    let tree = pageInst.render()
    assert.match(textOf(tree), /Reset all/)
    const inboxRow = all(tree, n => n.props?.['data-shortcut-row'] === 'inbox')[0]
    const keyBtn = all(inboxRow, n => n.type === 'button' && n.props?.className === 'bt-sc-keybtn')[0]
    keyBtn.props.onClick()
    tree = pageInst.render()
    assert.match(textOf(tree), /Press keys…/)

    // IME composition Backspace during recording must NOT unbind the shortcut.
    for (const fn of [...(winListeners.get('keydown') ?? [])]) {
      fn({ key: 'Backspace', isComposing: true, preventDefault() {}, stopPropagation() {} })
    }
    assert.equal(store.bindingOf('inbox')?.code, 'KeyI')

    // Press Cmd+J (currently held by browser) -> shows inline conflict alert with Replace.
    for (const fn of [...(winListeners.get('keydown') ?? [])]) {
      fn({ metaKey: true, code: 'KeyJ', key: 'j', preventDefault() {}, stopPropagation() {} })
    }
    tree = pageInst.render()
    assert.match(textOf(tree), /Already used by/)

    // While conflict alert is open, Tab/Enter must pass through to operate Cancel / Replace buttons.
    let tabPrevented = false
    for (const fn of [...(winListeners.get('keydown') ?? [])]) {
      fn({ key: 'Tab', preventDefault() { tabPrevented = true }, stopPropagation() {} })
    }
    assert.equal(tabPrevented, false)
    tree = pageInst.render()
    assert.match(textOf(tree), /Already used by/)

    const replaceBtn = all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-sc-replace'))[0]
    assert.ok(replaceBtn)
    replaceBtn.props.onClick()
    tree = pageInst.render()
    assert.equal(store.bindingOf('inbox')?.code, 'KeyJ')
    assert.equal(store.bindingOf('browser'), null)
  } finally {
    pageInst.unmount()
  }
})

test('Shared Escape stack closes ShortcutsDialog before SettingsTour and SettingsDialog in strict priority order', () => {
  const { exports, mount, winListeners, docCaptureListeners, docBubbleListeners } = loadUi()
  const storageMap = new Map()
  const store = exports.createShortcutStore({
    mac: true,
    storage: {
      getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => { storageMap.set(k, v) },
    },
  })

  const closedOrder = []
  let openState = {
    settings: true,
    tour: true,
    shortcuts: true,
    modal: true,
    select: true,
    lightbox: true,
  }

  function StackHost() {
    exports.useEscape(() => { closedOrder.push('settings'); openState = { ...openState, settings: false } }, openState.settings, { priority: exports.ESCAPE_PRIORITY.DIALOG })
    exports.useEscape(() => { closedOrder.push('tour'); openState = { ...openState, tour: false } }, openState.tour, { priority: exports.ESCAPE_PRIORITY.TOUR })
    exports.useEscape(() => { closedOrder.push('modal'); openState = { ...openState, modal: false } }, openState.modal, { priority: exports.ESCAPE_PRIORITY.MODAL_CHILD })
    exports.useEscape(() => { closedOrder.push('select'); openState = { ...openState, select: false } }, openState.select, { priority: exports.ESCAPE_PRIORITY.SELECT_MENU })
    exports.useEscape(() => { closedOrder.push('lightbox'); openState = { ...openState, lightbox: false } }, openState.lightbox, { priority: exports.ESCAPE_PRIORITY.LIGHTBOX })
    return { type: 'div', props: { children: [] } }
  }

  const hostInst = mount(StackHost, {})
  const scInst = mount(exports.ShortcutsDialog, {
    open: true,
    enterToSend: true,
    hasSurface: true,
    hasBrowser: true,
    hasInbox: false,
    store,
    onClose: () => { closedOrder.push('shortcuts'); openState = { ...openState, shortcuts: false } },
  })
  const fireEsc = () => {
    const evt = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
    for (const fn of [...(docCaptureListeners.get('keydown') ?? [])]) fn(evt)
    for (const fn of [...(docBubbleListeners.get('keydown') ?? [])]) fn(evt)
    for (const fn of [...(winListeners.get('keydown') ?? [])]) fn(evt)
    hostInst.render()
    scInst.render({
      open: openState.shortcuts,
      enterToSend: true,
      hasSurface: true,
      hasBrowser: true,
      hasInbox: false,
      store,
      onClose: () => { closedOrder.push('shortcuts'); openState = { ...openState, shortcuts: false } },
    })
    return evt
  }
  try {
    hostInst.render()
    scInst.render()
    for (let i = 0; i < 6; i += 1) {
      const evt = fireEsc()
      assert.equal(evt.defaultPrevented, true)
    }
    assert.deepEqual(closedOrder, ['lightbox', 'select', 'modal', 'shortcuts', 'tour', 'settings'])
  } finally {
    scInst.unmount()
    hostInst.unmount()
  }
})

test('Classic mode ShortcutsDialog and ShortcutsPage omit Bot-only shortcuts and label Toggle browser', () => {
  const { exports, mount, textOf } = loadUi()
  const store = exports.createShortcutStore({ mac: true, storage: { getItem: () => null, setItem() {} } })

  const dialogInst = mount(exports.ShortcutsDialog, {
    open: true,
    classic: true,
    enterToSend: true,
    hasSurface: true,
    hasBrowser: true,
    hasInbox: false,
    hasDetails: false,
    hasMemory: false,
    hasGroupSearch: false,
    store,
    onClose: () => {},
  })
  try {
    const body = textOf(dialogInst.render())
    assert.match(body, /Toggle browser/)
    assert.doesNotMatch(body, /Toggle Bot browser/)
    assert.doesNotMatch(body, /Open Inbox/)
    assert.doesNotMatch(body, /Toggle Bot details/)
    assert.doesNotMatch(body, /Open Bot memory/)
    assert.doesNotMatch(body, /Search messages in group/)
    assert.doesNotMatch(body, /Mention a Bot/)
  } finally {
    dialogInst.unmount()
  }

  const Section = ({ title, children }) => ({ type: 'section', props: { title, children } })
  const Row = ({ label, children }) => ({ type: 'row', props: { label, children: [label, ...(Array.isArray(children) ? children : [children])] } })
  const pageInst = mount(exports.ShortcutsPage, {
    roster: { prefs: { enterToSend: true }, browser: true },
    actions: { setSurface() {}, openBrowser() {}, openInbox() {} },
    surfaceMode: 'agent',
    Section,
    Row,
    store,
  })
  try {
    const body = textOf(pageInst.render())
    assert.match(body, /Toggle browser/)
    assert.doesNotMatch(body, /Toggle Bot browser/)
    assert.doesNotMatch(body, /Open Inbox/)
    assert.doesNotMatch(body, /Toggle Bot details/)
    assert.doesNotMatch(body, /Open Bot memory/)
    assert.doesNotMatch(body, /Search messages in group/)
    assert.doesNotMatch(body, /Mention a Bot/)
  } finally {
    pageInst.unmount()
  }
})

test('settingsOwnsKeyboard blocks Settings ⌘K while ShortcutsDialog is mounted above Settings', () => {
  const { exports } = loadUi()
  const { settingsOwnsKeyboard } = exports
  const settingsNode = { isConnected: true, closest: () => null }
  const shortcutsNode = { isConnected: true, closest: () => null }
  const leavingNode = { isConnected: true, closest: sel => (sel === '[data-leaving]' ? {} : null) }

  assert.equal(settingsOwnsKeyboard(settingsNode, { querySelectorAll: () => [settingsNode] }), true)
  assert.equal(settingsOwnsKeyboard(settingsNode, { querySelectorAll: () => [settingsNode, shortcutsNode] }), false)
  assert.equal(settingsOwnsKeyboard(settingsNode, { querySelectorAll: () => [settingsNode, leavingNode] }), true)
  assert.equal(settingsOwnsKeyboard({ isConnected: false }, { querySelectorAll: () => [settingsNode] }), false)
})

test('resolveActiveModal ranks releaseNotes above settings so shortcuts do not leak through to Settings', () => {
  const { exports } = loadUi()
  const { resolveActiveModal, matchGlobalShortcut } = exports
  const uiSnap = { settings: { page: 'about' }, releaseNotes: { mode: 'manual', current: '0.3.10' } }
  assert.equal(resolveActiveModal(uiSnap, null), 'dialog')
  assert.equal(resolveActiveModal({ settings: { page: 'about' }, releaseNotes: null }, null), 'settings')

  // Cmd+, (settings toggle) must be blocked when releaseNotes is open over Settings.
  const hit = matchGlobalShortcut(
    { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, code: 'Comma', key: ',', defaultPrevented: false, isComposing: false },
    { settingsOpen: true, modal: resolveActiveModal(uiSnap, null), capabilities: { surface: true, browser: true, inbox: true } },
  )
  assert.equal(hit, null)
})
