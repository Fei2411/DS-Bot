import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { rectsOverlap } from '../src/client/browser-overlap.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-pane.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const { outputFiles: hooksFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/overlay-hooks.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})

function createHarness() {
  let current
  const listeners = new Map()
  const timers = new Map()
  let nextTimerId = 1
  const copied = []

  const slot = (make) => {
    const index = current.index++
    return current.slots[index] ??= make()
  }
  const effect = (make, deps) => {
    const cell = slot(() => ({}))
    if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
      current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
    }
  }
  const stubReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: (v) => ({ Provider: () => null, _currentValue: v }),
    useContext: (ctx) => ctx?._currentValue,
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useEffect: effect,
    useLayoutEffect: effect,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    memo: (c) => c,
    forwardRef: (c) => c,
  }
  const fakeWindow = {
    matchMedia: () => ({ matches: false }),
    addEventListener(type, fn) {
      let set = listeners.get(type)
      if (!set) { set = new Set(); listeners.set(type, set) }
      set.add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
  }
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++
    timers.set(id, { fn, ms })
    return id
  }
  const fakeClearTimeout = (id) => { timers.delete(id) }
  let intervalCalls = 0
  const fakeSetInterval = () => { intervalCalls += 1; return 9999 }
  const fakeClearInterval = () => {}

  const mod = { exports: {} }
  const ctx = {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'react') return stubReact
      if (name === 'react-dom') return { createPortal: (node) => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        return {
          FishLogo: 'fish',
          MarkdownText: () => null,
          writeClipboard: (text) => { copied.push(text); return Promise.resolve(true) },
        }
      }
      return {}
    },
    window: fakeWindow,
    document: { body: {}, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  }
  runInNewContext(outputFiles[0].text, ctx)

  const mount = (Component, props) => {
    const instance = {
      slots: [],
      effects: [],
      props,
      render(next = instance.props) {
        instance.props = next
        instance.index = 0
        current = instance
        const out = Component(next)
        current = undefined
        for (const run of instance.effects.splice(0)) run()
        return out
      },
      unmount() {
        for (const s of instance.slots) s?.stop?.()
      },
    }
    return instance
  }

  return {
    exports: mod.exports,
    window: fakeWindow,
    timers,
    copied,
    get intervalCalls() { return intervalCalls },
    mount,
  }
}

const allNodes = (node, check) => {
  if (Array.isArray(node)) return node.flatMap((child) => allNodes(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...allNodes(node.props?.children, check)]
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return String(node ?? '')
  return textOf(node.props?.children)
}

const { orderImportSources, siteMatchesHost } = createHarness().exports

test('overlay coverage requires positive rectangle intersection', () => {
  const panel = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 }
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 150, bottom: 160, width: 100, height: 100 }), true)
  assert.equal(rectsOverlap(panel, { left: 110, top: 20, right: 150, bottom: 60, width: 40, height: 40 }), false)
  assert.equal(rectsOverlap(panel, { left: 200, top: 200, right: 250, bottom: 250, width: 50, height: 50 }), false)
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 50, bottom: 90, width: 0, height: 30 }), false)
})

test('siteMatchesHost matches same host and direct domain hierarchy without crossing public suffix boundaries', () => {
  assert.equal(siteMatchesHost('github.com', 'github.com'), true)
  assert.equal(siteMatchesHost('github.com', 'gist.github.com'), true)
  assert.equal(siteMatchesHost('api.github.com', 'github.com'), true)
  assert.equal(siteMatchesHost('example.co.uk', 'app.example.co.uk'), true)
  assert.equal(siteMatchesHost('alice.github.io', 'bob.github.io'), false)
  assert.equal(siteMatchesHost('bank.co.nz', 'shop.co.nz'), false)
  assert.equal(siteMatchesHost('a.vercel.app', 'b.vercel.app'), false)
  assert.equal(siteMatchesHost('com', 'github.com'), false)
  assert.equal(siteMatchesHost('github.com', 'notgithub.com'), false)
  assert.equal(siteMatchesHost('localhost', 'localhost'), true)
  assert.equal(siteMatchesHost('127.0.0.1', '127.0.0.1'), true)
  assert.equal(siteMatchesHost('127.0.0.1', '127.0.0.2'), false)
})

test('orderImportSources pins the last-used profile to the top without mutating input', () => {
  const list = [
    { id: 'chrome:Default', label: 'Chrome — Default' },
    { id: 'edge:Profile 1', label: 'Edge — Work' },
    { id: 'firefox:abc', label: 'Firefox' },
  ]
  const ordered = orderImportSources(list, 'edge:Profile 1')
  assert.deepEqual(Array.from(ordered, (s) => s.id), ['edge:Profile 1', 'chrome:Default', 'firefox:abc'])
  assert.deepEqual(list.map((s) => s.id), ['chrome:Default', 'edge:Profile 1', 'firefox:abc'])
  assert.deepEqual(Array.from(orderImportSources(list, 'missing'), (s) => s.id), list.map((s) => s.id))
  assert.deepEqual(Array.from(orderImportSources(null, 'chrome:Default')), [])
})

test('ImportMenu joins the useEscape stack and ignores IME composition Escape (keyCode 229)', () => {
  const h = createHarness()
  const { ImportMenu } = h.exports
  let closed = 0
  const inst = h.mount(ImportMenu, {
    sources: [], lastSourceId: null, loading: false, busy: false, canPaste: true,
    onFile() {}, onPaste() {}, onSource() {}, onClose: () => { closed += 1 },
  })
  inst.render()

  h.window.dispatch('keydown', { key: 'Escape', isComposing: true, keyCode: 229 })
  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 229 })
  assert.equal(closed, 0, 'IME Escape must not dismiss ImportMenu')

  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(closed, 1)
  inst.unmount()

  // Also verify useEscape stack itself ignores IME 229 and closes only the topmost layer.
  const listeners = []
  const hooksMod = { exports: {} }
  let cur
  const slot = (make) => { const i = cur.i++; return cur.s[i] ??= make() }
  const react = {
    useRef: (v) => slot(() => ({ current: v })),
    useEffect: (fn) => { const c = slot(() => ({})); if (!c.done) { c.done = true; c.stop = fn() } },
  }
  runInNewContext(hooksFiles[0].text, {
    module: hooksMod,
    exports: hooksMod.exports,
    require: () => react,
    window: {
      addEventListener: (_t, fn) => listeners.push(fn),
      removeEventListener: (_t, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) },
    },
  })
  const calls = []
  const layer = (name) => { cur = { i: 0, s: [] }; hooksMod.exports.useEscape(() => calls.push(name)); return cur }
  const l1 = layer('outer')
  const l2 = layer('inner')
  listeners[0]({ key: 'Escape', isComposing: false, keyCode: 229 })
  assert.deepEqual(calls, [])
  listeners[0]({ key: 'Escape', isComposing: false, keyCode: 27 })
  assert.deepEqual(calls, ['inner'])
  l2.s.forEach((s) => s?.stop?.())
  l1.s.forEach((s) => s?.stop?.())
  assert.equal(listeners.length, 0)
})

test('RemoteDebugCard polls serially via lightweight probe (never setInterval/sources), reuses writeClipboard, and clears timers on unmount', async () => {
  const h = createHarness()
  const { RemoteDebugCard } = h.exports
  let sourcesCalls = 0
  let probeCalls = 0
  let resolveProbe = null
  const imports = {
    sources: async () => { sourcesCalls += 1; return [] },
    probe: (id) => {
      probeCalls += 1
      assert.equal(id, 'chrome:Default')
      return new Promise((resolve) => { resolveProbe = resolve })
    },
  }
  const inst = h.mount(RemoteDebugCard, {
    flow: { source: { id: 'chrome:Default', name: 'Chrome' }, info: { inspectUrl: 'chrome://inspect/#remote-debugging' } },
    busy: false,
    imports,
    onRetrySource() {}, onLaunchSource() {}, onFile() {}, onCancel() {},
  })
  const tree = inst.render()
  assert.equal(h.intervalCalls, 0, 'must not use setInterval')
  assert.equal(h.timers.size, 1, 'schedules a single serial setTimeout')

  // Fire first poll: while in flight, no second timer may be scheduled.
  const [firstId, firstTimer] = [...h.timers.entries()][0]
  assert.equal(firstTimer.ms, 2000)
  h.timers.delete(firstId)
  firstTimer.fn()
  assert.equal(probeCalls, 1)
  assert.equal(sourcesCalls, 0, 'must use lightweight probe instead of full sources()')
  assert.equal(h.timers.size, 0, 'must wait for in-flight probe before scheduling next poll')

  // Resolve probe -> schedules next serial timeout.
  resolveProbe({ liveDebugReady: true })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.timers.size, 1)

  // Copy button reuses writeClipboard and schedules a 1800ms timer that clears on unmount.
  const copyBtn = allNodes(tree, (n) => n.type === 'button' && n.props?.className === 'bt-import-mini')[0]
  copyBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(h.copied, ['chrome://inspect/#remote-debugging'])
  assert.equal([...h.timers.values()].some((t) => t.ms === 1800), true)

  // Unmount clears BOTH poll timer and 1800ms copied timer.
  inst.unmount()
  assert.equal(h.timers.size, 0, 'all timers must be cleared on unmount')
})

test('PreviewCard excludes pure-skipped (0 cookies, 0 localStorage) domains from selectable rows', () => {
  const h = createHarness()
  const { PreviewCard } = h.exports
  const inst = h.mount(PreviewCard, {
    flow: {
      id: 'p1',
      preview: {
        source: { label: 'Chrome — Default' },
        notes: [],
        warnings: [],
        skipped: [{ where: 'entry 1', name: 'old', domain: 'expired.example', code: 'expired', reason: 'expired' }],
        sites: [
          { site: 'good.example', cookies: 2, session: 0, localStorage: 0, skipped: 0 },
          { site: 'expired.example', cookies: 0, session: 0, localStorage: 0, skipped: 1 },
        ],
      },
    },
    page: { url: '' },
    busy: false,
    onApply() {},
    onCancel() {},
  })
  const tree = inst.render()
  const rows = allNodes(tree, (n) => n.type === 'label' && String(n.props?.className ?? '').includes('bt-import-check-row'))
  assert.equal(rows.length, 1)
  assert.match(textOf(rows[0]), /good\.example/)
})

test('BrowserView Cancel during connecting stage propagates live requestId to imports.cancel', async () => {
  const h = createHarness()
  const { BrowserView } = h.exports
  const liveCalls = []
  const cancelCalls = []
  const imports = {
    sources: async () => [{ id: 'chrome:Default', name: 'Chrome', label: 'Chrome — Default' }],
    live: (sourceId, close, requestId) => {
      liveCalls.push({ sourceId, close, requestId })
      return new Promise(() => {}) // stays pending in connecting stage
    },
    cancel: async (id) => { cancelCalls.push(id) },
  }
  const inst = h.mount(BrowserView, {
    bot: { id: 'b1', name: 'Bot' },
    tabId: 'tab-1',
    leaving: false,
    landed: true,
    hold: null,
    useBrowserPages: () => ({ url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }),
    actions: {
      browserImport: imports,
      browserShow: async () => {},
      browserCommand: async () => {},
      browserNavigate: async () => false,
      browserFocus: () => {},
      browserNewTab: () => {},
    },
  })
  let tree = inst.render()
  // Open import menu.
  const importBtn = allNodes(tree, (n) => n.type === 'button' && String(n.props?.className ?? '').includes('bt-import-btn'))[0]
  importBtn.props.onClick()
  tree = inst.render()
  // Pick a source via ImportMenu's onSource prop -> enters connecting stage.
  const menuNode = allNodes(tree, (n) => n.type === h.exports.ImportMenu)[0]
  assert.ok(menuNode)
  void menuNode.props.onSource({ id: 'chrome:Default', name: 'Chrome', label: 'Chrome — Default' })
  tree = inst.render()
  assert.equal(liveCalls.length, 1)
  assert.equal(typeof liveCalls[0].requestId, 'string')
  assert.ok(liveCalls[0].requestId.length > 0)

  // Click Cancel on the connecting ImportCard -> must call imports.cancel with the live requestId.
  const cardNode = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'connecting')[0]
  assert.ok(cardNode)
  cardNode.props.onCancel()
  assert.deepEqual(cancelCalls, [liveCalls[0].requestId])
  inst.unmount()
})

test('ImportMenu keeps profile email and Last used visible alongside Ready', () => {
  const h = createHarness()
  const { ImportMenu } = h.exports
  const inst = h.mount(ImportMenu, {
    sources: [
      { id: 'edge:Profile 1', label: 'Edge — Work', email: 'work@example.com', liveDebugReady: true },
      { id: 'edge:Default', label: 'Edge — Default', email: null, liveDebugReady: false },
    ],
    lastSourceId: 'edge:Profile 1',
    loading: false,
    busy: false,
    canPaste: true,
    onFile() {}, onPaste() {}, onSource() {}, onClose() {},
  })
  const tree = inst.render()
  const items = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'menuitem')
  const firstText = textOf(items[0])
  assert.match(firstText, /Edge — Work/)
  assert.match(firstText, /work@example\.com/)
  assert.match(firstText, /Last used/)
  assert.match(firstText, /Ready/)

  const secondText = textOf(items[1])
  assert.match(secondText, /Edge — Default/)
  assert.match(secondText, /Browser profile/)
  inst.unmount()
})

test('ImportMenu displays profile cookie counts and Safari Permission needed badge', () => {
  const h = createHarness()
  const { ImportMenu } = h.exports
  const inst = h.mount(ImportMenu, {
    sources: [
      { id: 'chrome:Default', label: 'Chrome — Personal', email: 'me@example.com', cookieCount: 42, liveDebugReady: false, needsPermission: false },
      { id: 'safari:permission', label: 'Safari', email: null, cookieCount: null, liveDebugReady: false, needsPermission: true },
    ],
    lastSourceId: 'chrome:Default',
    loading: false,
    busy: false,
    canPaste: true,
    onFile() {}, onPaste() {}, onSource() {}, onClose() {},
  })
  const tree = inst.render()
  const items = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'menuitem')
  const firstText = textOf(items[0])
  assert.match(firstText, /Chrome — Personal/)
  assert.match(firstText, /me@example\.com/)
  assert.match(firstText, /Last used/)
  assert.match(firstText, /42 cookies/)

  const secondText = textOf(items[1])
  assert.match(secondText, /Safari/)
  assert.match(secondText, /Permission needed/)
  inst.unmount()
})

test('SafariPermissionCard polls serially via probe, opens System Settings, notifies once on grant, and cleans up timers', async () => {
  const h = createHarness()
  const { SafariPermissionCard } = h.exports
  let probeCalls = 0
  let resolveProbe = null
  let openCalls = 0
  let grantedNotifications = 0
  const imports = {
    probe: (id) => {
      probeCalls += 1
      assert.equal(id, 'safari:permission')
      return new Promise((resolve) => { resolveProbe = resolve })
    },
    openPermission: async () => { openCalls += 1; return { opened: true } },
  }
  const inst = h.mount(SafariPermissionCard, {
    flow: { source: { id: 'safari:permission', name: 'Safari', label: 'Safari' }, info: {} },
    busy: false,
    imports,
    onOpenPermission: () => { void imports.openPermission() },
    onPermissionGranted: () => { grantedNotifications += 1 },
    onRetrySource() {},
    onCancel() {},
  })
  let tree = inst.render()
  assert.equal(h.intervalCalls, 0, 'must not use setInterval')
  assert.equal(h.timers.size, 1)

  const openBtn = allNodes(tree, (n) => n.type === 'button' && textOf(n) === 'Open System Settings')[0]
  assert.ok(openBtn)
  openBtn.props.onClick()
  assert.equal(openCalls, 1)

  const [firstId, firstTimer] = [...h.timers.entries()][0]
  h.timers.delete(firstId)
  firstTimer.fn()
  assert.equal(probeCalls, 1)
  assert.equal(h.timers.size, 0, 'serial polling waits for in-flight probe')

  resolveProbe({ liveDebugReady: false, permissionGranted: true })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(grantedNotifications, 1)
  tree = inst.render()
  assert.match(textOf(tree), /Full Disk Access granted/)
  assert.equal(h.timers.size, 1)

  // Second granted poll must not fire onPermissionGranted a second time.
  const [secondId, secondTimer] = [...h.timers.entries()][0]
  h.timers.delete(secondId)
  secondTimer.fn()
  resolveProbe({ liveDebugReady: false, permissionGranted: true })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(grantedNotifications, 1)

  inst.unmount()
  assert.equal(h.timers.size, 0, 'unmount clears active poll timer')
})

test('BrowserView enters safari-permission, clears stale rows while refreshing multi-profile Safari, and renders browser-locked errors', async () => {
  const h = createHarness()
  const { BrowserView } = h.exports
  const imports = {
    sources: async () => [{ id: 'safari:permission', name: 'Safari', label: 'Safari', needsPermission: true }],
    live: async () => ({ needsFullDiskAccess: true, sourceId: 'safari:permission', browserName: 'Safari', label: 'Safari', kind: 'safari' }),
    probe: async () => ({ liveDebugReady: false, permissionGranted: false }),
    openPermission: async () => ({ opened: true }),
    cancel: async () => {},
  }
  const inst = h.mount(BrowserView, {
    bot: { id: 'b1', name: 'Bot' },
    tabId: 'tab-1',
    leaving: false,
    landed: true,
    hold: null,
    useBrowserPages: () => ({ url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }),
    actions: {
      browserImport: imports,
      browserShow: async () => {},
      browserCommand: async () => {},
      browserNavigate: async () => false,
      browserFocus: () => {},
      browserNewTab: () => {},
    },
  })
  let tree = inst.render()
  const importBtn = allNodes(tree, (n) => n.type === 'button' && String(n.props?.className ?? '').includes('bt-import-btn'))[0]
  importBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = inst.render()
  const menuNode = allNodes(tree, (n) => n.type === h.exports.ImportMenu)[0]
  await menuNode.props.onSource({ id: 'safari:permission', name: 'Safari', label: 'Safari', needsPermission: true })
  tree = inst.render()
  const cardNode = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'safari-permission')[0]
  assert.ok(cardNode, 'expected BrowserView to transition to safari-permission stage')

  // When multi-profile Safari unlocks and live returns needsProfileChoice, stale safari:permission
  // must be cleared immediately (loading: true, sources: []) until unlocked profiles resolve.
  let resolveRefresh = null
  let sourcesRefreshes = 0
  imports.sources = () => {
    sourcesRefreshes += 1
    return new Promise((resolve) => { resolveRefresh = resolve })
  }
  imports.live = async () => ({ needsProfileChoice: true })
  cardNode.props.onRetrySource()
  await new Promise((r) => setTimeout(r, 0))
  tree = inst.render()
  const loadingMenu = allNodes(tree, (n) => n.type === h.exports.ImportMenu)[0]
  assert.ok(loadingMenu, 'expected return to ImportMenu')
  assert.equal(loadingMenu.props.loading, true, 'must show loading state while refreshed Safari profiles load')
  assert.deepEqual(Array.from(loadingMenu.props.sources), [], 'stale pre-permission Safari row must not stay clickable during refresh')
  assert.equal(sourcesRefreshes, 1)

  resolveRefresh([
    { id: 'safari:Default', name: 'Safari', label: 'Safari — Personal', cookieCount: 10 },
    { id: 'safari:work-uuid', name: 'Safari', label: 'Safari — Work', cookieCount: 25 },
  ])
  await new Promise((r) => setTimeout(r, 0))
  tree = inst.render()
  const loadedMenu = allNodes(tree, (n) => n.type === h.exports.ImportMenu)[0]
  assert.equal(loadedMenu.props.loading, false)
  assert.deepEqual(Array.from(loadedMenu.props.sources, (s) => s.id), ['safari:Default', 'safari:work-uuid'])

  // Non-Windows locked SQLite error renders the localized busy-database message instead of running prompt.
  imports.live = async () => ({ error: 'browser-locked' })
  await loadedMenu.props.onSource({ id: 'chrome:Default', name: 'Chrome', label: 'Chrome — Default' })
  tree = inst.render()
  const errCard = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'error')[0]
  assert.ok(errCard)
  assert.match(errCard.props.flow.message, /cookie database is busy/i)
  inst.unmount()
})

test('PreviewCard toggles session persistence via DS Bot switch and passes persistSession to onApply', () => {
  const h = createHarness()
  const { PreviewCard } = h.exports
  const applied = []
  const inst = h.mount(PreviewCard, {
    flow: {
      id: 'p2',
      preview: {
        source: { label: 'Chrome — Personal' },
        notes: ['session-cookies'],
        warnings: [],
        skipped: [],
        sites: [{ site: 'github.com', cookies: 5, session: 2, localStorage: 0 }],
      },
    },
    page: { url: 'https://github.com/Fei-Craft/DS-Bot' },
    busy: false,
    onApply: (opts) => applied.push(opts),
    onCancel() {},
  })
  let tree = inst.render()
  const sw = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'switch')[0]
  assert.ok(sw, 'expected a role=switch toggle for session persistence')
  assert.equal(sw.props['aria-checked'], true)
  sw.props.onClick()
  tree = inst.render()
  const swAfter = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'switch')[0]
  assert.equal(swAfter.props['aria-checked'], false)

  const submitBtn = allNodes(tree, (n) => n.type === 'button' && n.props?.className === 'bt-import-primary')[0]
  submitBtn.props.onClick()
  assert.equal(applied.length, 1)
  assert.equal(applied[0].sites, undefined)
  assert.equal(applied[0].persistSession, false)
  inst.unmount()
})

test('SafariPermissionCard keeps the primary CTA rightmost before and after permission grant', async () => {
  const h = createHarness()
  const { SafariPermissionCard } = h.exports
  let resolveProbe = null
  const imports = {
    probe: () => new Promise((resolve) => { resolveProbe = resolve }),
    openPermission: async () => ({ opened: true }),
  }
  const inst = h.mount(SafariPermissionCard, {
    flow: { source: { id: 'safari:permission', name: 'Safari', label: 'Safari' }, info: {} },
    busy: false,
    imports,
    onOpenPermission() {},
    onRetrySource() {},
    onCancel() {},
  })
  let tree = inst.render()
  const actionsBefore = allNodes(tree, (n) => n.type === 'div' && n.props?.className === 'bt-import-actions')[0]
  const btnsBefore = allNodes(actionsBefore, (n) => n.type === 'button')
  assert.equal(btnsBefore.at(-1)?.props?.className, 'bt-import-primary')
  assert.equal(textOf(btnsBefore.at(-1)), 'Open System Settings')

  const [id, timer] = [...h.timers.entries()][0]
  h.timers.delete(id)
  timer.fn()
  resolveProbe({ permissionGranted: true })
  await new Promise((r) => setTimeout(r, 0))
  tree = inst.render()
  const actionsAfter = allNodes(tree, (n) => n.type === 'div' && n.props?.className === 'bt-import-actions')[0]
  const btnsAfter = allNodes(actionsAfter, (n) => n.type === 'button')
  assert.equal(btnsAfter.at(-1)?.props?.className, 'bt-import-primary')
  assert.equal(textOf(btnsAfter.at(-1)), 'Import')
  inst.unmount()
})

test('ImportCard disables Close and ignores Escape while apply is busy, but still lets connecting cancel on Escape', () => {
  const h = createHarness()
  const { ImportCard, PreviewCard } = h.exports
  let canceled = 0
  const previewFlow = {
    stage: 'preview',
    id: 'p-busy',
    preview: {
      source: { label: 'Chrome — Personal' },
      notes: [],
      warnings: [],
      skipped: [],
      sites: [{ site: 'github.com', cookies: 5, session: 0, localStorage: 0 }],
    },
  }
  const inst = h.mount(ImportCard, {
    flow: previewFlow,
    page: { url: '' },
    busy: true,
    imports: {},
    onApply() {},
    onCancel: () => { canceled += 1 },
    onDone() {},
  })
  inst.render()
  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(canceled, 0, 'Escape must not dismiss preview while apply is busy')
  inst.unmount()

  // PreviewCard header Close button is also disabled while busy.
  const prevInst = h.mount(PreviewCard, {
    flow: previewFlow,
    page: { url: '' },
    busy: true,
    onApply() {},
    onCancel: () => { canceled += 1 },
  })
  const prevTree = prevInst.render()
  const headerNode = allNodes(prevTree, (n) => typeof n.type === 'function' && n.props?.onClose)[0]
  assert.ok(headerNode, 'expected ImportHeader with onClose in non-inline PreviewCard')
  assert.equal(headerNode.props.busy, true)
  const closeBtn = allNodes(headerNode.type(headerNode.props), (n) => n.type === 'button' && n.props?.['aria-label'] === 'Close')[0]
  assert.ok(closeBtn, 'expected Close button in non-inline PreviewCard header')
  assert.equal(closeBtn.props.disabled, true)
  prevInst.unmount()

  // Connecting stage remains cancellable via Escape so live harvest can be aborted.
  const connInst = h.mount(ImportCard, {
    flow: { stage: 'connecting', source: { id: 'chrome:Default', name: 'Chrome', label: 'Chrome — Default' } },
    page: { url: '' },
    busy: true,
    imports: {},
    onApply() {},
    onCancel: () => { canceled += 1 },
    onDone() {},
  })
  connInst.render()
  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(canceled, 1, 'Escape must still cancel connecting stage')
  connInst.unmount()

  // Running stage (closeAndImport live read) remains cancellable via Escape and Cancel button.
  const runInst = h.mount(ImportCard, {
    flow: { stage: 'running', source: { id: 'chrome:Default', name: 'Chrome', label: 'Chrome — Default' } },
    page: { url: '' },
    busy: true,
    imports: {},
    onApply() {},
    onCancel: () => { canceled += 1 },
    onCloseAndImport() {},
    onDone() {},
  })
  const runTree = runInst.render()
  const runCancelBtn = allNodes(runTree, (n) => n.type === 'button' && textOf(n) === 'Cancel')[0]
  assert.ok(runCancelBtn)
  assert.notEqual(runCancelBtn.props.disabled, true)
  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(canceled, 2, 'Escape must still cancel busy running close-and-import read')
  runInst.unmount()

  // Overlay ImportMenu also disables Close and ignores Escape while busy (e.g. pickFile in flight).
  let menuClosed = 0
  const { ImportMenu } = h.exports
  const menuInst = h.mount(ImportMenu, {
    sources: [],
    lastSourceId: null,
    loading: false,
    busy: true,
    canPaste: true,
    onFile() {},
    onPaste() {},
    onSource() {},
    onClose: () => { menuClosed += 1 },
  })
  const menuTree = menuInst.render()
  const menuHeader = allNodes(menuTree, (n) => typeof n.type === 'function' && n.props?.onClose)[0]
  assert.ok(menuHeader)
  assert.equal(menuHeader.props.busy, true)
  const menuCloseBtn = allNodes(menuHeader.type(menuHeader.props), (n) => n.type === 'button' && n.props?.['aria-label'] === 'Close')[0]
  assert.equal(menuCloseBtn.props.disabled, true)
  h.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(menuClosed, 0, 'Escape must not dismiss overlay ImportMenu while busy')
  menuInst.unmount()
})
