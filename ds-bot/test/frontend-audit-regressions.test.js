import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const clientDir = join(repoRoot, 'ds-bot', 'src', 'client')

async function loadClientBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: join(repoRoot, 'ds-bot') },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

function makeFakeReact() {
  const hooks = []
  let idx = 0
  const effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true) }
    },
    useState(init) {
      const i = idx++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      const set = (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next }
      return [hooks[i], set]
    },
    useRef(init) {
      const i = idx++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
    useMemo(fn) {
      const i = idx++
      hooks[i] = fn()
      return hooks[i]
    },
    useCallback(fn) { return fn },
    useId() { return 'bt-test-id' },
    createContext(v) { return { Provider: ({ children }) => children, _v: v } },
    useContext(c) { return c?._v },
    useEffect(fn) { effects.push(fn) },
    useLayoutEffect(fn) { effects.push(fn) },
  }
  return {
    React,
    reset() { idx = 0; effects.length = 0 },
    clear() { hooks.length = 0; idx = 0; effects.length = 0 },
    flushEffects() {
      const cleanups = []
      for (const fn of effects.splice(0)) {
        const res = fn()
        if (typeof res === 'function') cleanups.push(res)
      }
      return () => { for (const c of cleanups) c() }
    },
  }
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

test('zh-tw dictionary translates Revoke as 撤銷, Undo as 復原, and 划 as 劃', async () => {
  const { convertDict, toTraditional } = await import('../src/client/locales/zh-tw.js')
  const dict = convertDict({ Revoke: '撤销', Undo: '撤销', Plan: '计划' })
  assert.equal(dict.Revoke, '撤銷')
  assert.equal(dict.Undo, '復原')
  assert.equal(dict.Plan, '計劃')
  assert.equal(toTraditional('规划路线'), '規劃路線')
})

test('every --bt-* CSS variable referenced in client styles is defined or an allowed runtime variable', () => {
  const files = readdirSync(clientDir).filter(name => name.endsWith('.js'))
  const defined = new Set([
    // Runtime-injected CSS variables set via JS inline styles or themes.js/inks.js/skin.js
    '--bt-accent-ink', '--bt-size', '--bt-delay', '--bt-fidget', '--bt-fidget-delay',
    '--bt-gx', '--bt-gy', '--bt-stack-size', '--bt-lc-w', '--bt-mem-w',
    '--bt-panel-w', '--bt-fold-top', '--bt-fill', '--bt-origin', '--bt-first-sep',
    '--bt-placeholder', '--bt-steer-unread', '--bt-level', '--bt-caption-start',
    '--bt-leftcol-fill', '--bt-fx-blur-2', '--bt-fx-blur-3', '--bt-fx-blur-4',
    '--bt-fx-blur-5', '--bt-fx-blur-6', '--bt-browser-bar', '--bt-col-w',
    '--bt-tint', '--bt-bg', '--bt-fg', '--bt-ink-mix', '--bt-ring',
    '--bt-hue', '--bt-im-', '--bt-effort-p', '--bt-dot-p',
    '--bt-skin-sidebar', '--bt-skin-main', '--bt-skin-card',
  ])
  const used = new Map()
  for (const file of files) {
    const src = readFileSync(join(clientDir, file), 'utf8')
    for (const m of src.matchAll(/(--bt-[a-z0-9-]+)\s*:/gi)) defined.add(m[1])
    for (const m of src.matchAll(/var\(\s*(--bt-[a-z0-9-]+)/gi)) {
      if (!used.has(m[1])) used.set(m[1], file)
    }
  }
  const missing = []
  for (const [token, file] of used) {
    if (!defined.has(token) && !token.startsWith('--bt-ink-')) missing.push(`${token} (${file})`)
  }
  assert.deepEqual(missing, [], `Undefined --bt-* variables referenced: ${missing.join(', ')}`)
})

test('styles.js keeps bt-dialog-sink transform-free and side-chat.js isolates .bt-sidechat', async () => {
  const code = await loadClientBundle(`
    export { SHELL_CSS } from './src/client/styles.js'
    export { SIDE_CSS } from './src/client/side-chat.js'
  `)
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => ({}))
  const { SHELL_CSS, SIDE_CSS } = mod.exports
  assert.match(SHELL_CSS, /@keyframes bt-dialog-sink\{to\{opacity:0;translate:0 6px;scale:\.975/)
  assert.doesNotMatch(SHELL_CSS, /@keyframes bt-dialog-sink\{[^}]*transform:/)
  assert.match(SIDE_CSS, /\.bt-sidechat\{/)
  assert.doesNotMatch(SIDE_CSS, /\.bt-side\{/)
})

test('installCompiledStyles uses a single shared MutationObserver and skips scanning for static sheets', async () => {
  const code = await loadClientBundle("export { installCompiledStyles } from './src/client/styles.js'")
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => ({}))
  const { installCompiledStyles } = mod.exports

  let observersCreated = 0
  let observersDisconnected = 0
  let styleSheetsReads = 0
  const appended = []
  const origDoc = globalThis.document
  const origMO = globalThis.MutationObserver
  globalThis.MutationObserver = class {
    constructor() { observersCreated += 1 }
    observe() {}
    disconnect() { observersDisconnected += 1 }
  }
  globalThis.document = {
    head: { appendChild(el) { el.isConnected = true; appended.push(el) } },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        isConnected: false,
        remove() { this.isConnected = false },
      }
    },
    get styleSheets() {
      styleSheetsReads += 1
      return []
    },
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    const off1 = installCompiledStyles('.bt-a{color:red}', 'a')
    const off2 = installCompiledStyles('.bt-b{color:blue}', 'b')
    assert.equal(observersCreated, 1, 'should share a single MutationObserver')
    assert.equal(styleSheetsReads, 0, 'static sheets without [class*="_ should not scan styleSheets')
    const off3 = installCompiledStyles('[class*="_foo"]{color:green}', 'c')
    assert.equal(observersCreated, 1, 'still only one MutationObserver')
    assert.equal(styleSheetsReads, 1, 'dynamic fragment sheet scans styleSheets once')
    off1(); off2(); off3()
    assert.equal(observersDisconnected, 1, 'disconnects shared observer when all sheets dispose')
  } finally {
    globalThis.document = origDoc
    globalThis.MutationObserver = origMO
  }
})

test('isImeComposing detects both isComposing and legacy WebKit keyCode 229', async () => {
  const { isImeComposing } = await import('../src/client/enter-key.js')
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true)
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true)
  assert.equal(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 }), true)
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false)
})

test('useEscape ignores IME composition Escape and respects active flag', async () => {
  const code = await loadClientBundle("export { useEscape } from './src/client/overlay-hooks.js'")
  const fake = makeFakeReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => fake.React)
  const { useEscape } = mod.exports

  const listeners = new Set()
  const origWin = globalThis.window
  globalThis.window = {
    addEventListener(type, fn) { if (type === 'keydown') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'keydown') listeners.delete(fn) },
  }
  try {
    let calls = 0
    fake.reset()
    useEscape(() => { calls += 1 }, true)
    const cleanup = fake.flushEffects()
    assert.equal(listeners.size, 1)
    const [handler] = [...listeners]
    handler({ key: 'Escape', isComposing: true, keyCode: 27, preventDefault() {}, stopPropagation() {} })
    handler({ key: 'Escape', isComposing: false, keyCode: 229, preventDefault() {}, stopPropagation() {} })
    assert.equal(calls, 0, 'IME Escape must not dismiss overlay')
    handler({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault() {}, stopPropagation() {} })
    assert.equal(calls, 1, 'normal Escape dismisses overlay')
    cleanup()

    fake.clear()
    useEscape(() => { calls += 1 }, false)
    const cleanup2 = fake.flushEffects()
    assert.equal(listeners.size, 0, 'inactive useEscape should not register listener')
    cleanup2()
  } finally {
    globalThis.window = origWin
  }
})

test('PendingComputerHandoff keeps footer inside section and opens details computer tab', async () => {
  const code = await loadClientBundle("export { PendingComputerHandoff } from './src/client/computer.js'")
  const fake = makeFakeReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => fake.React)
  const { PendingComputerHandoff } = mod.exports

  const shown = []
  const taken = []
  const actions = {
    showDetails: (id, tab) => shown.push([id, tab]),
    computerTakeover: async id => { taken.push(id) },
    computerHoldAnswer: async () => {},
    reportError: () => {},
  }
  fake.reset()
  const tree = PendingComputerHandoff({
    sessionId: 'bot-1',
    bot: { id: 'bot-1', name: 'Helper', avatar: { shape: 'blob', color: 'blue' } },
    hold: { id: 'h-1', callId: 'c-1', reason: 'Sign in', by: 'bot' },
    actions,
  })
  const section = findAll(tree, n => n.type === 'section')[0]
  assert.ok(section, 'section.bt-q.bt-handoff should render')
  const foots = findAll(section, n => n.props?.className === 'bt-q-foot')
  assert.equal(foots.length, 1, 'footer must be nested inside section.bt-q.bt-handoff')
  const takeOverBtn = findAll(section, n => n.type === 'button' && textOf(n).includes('Take over'))[0]
  assert.ok(takeOverBtn, 'Take over button should render')
  takeOverBtn.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(taken, ['bot-1'])
  assert.deepEqual(shown, [['bot-1', 'computer']])
})

test('GroupReplies renders reply.kind === "goal" events instead of dropping them', async () => {
  const code = await loadClientBundle("export { ToolCell } from './src/client/cells.js'")
  const fake = makeFakeReact()
  const mod = { exports: {} }
  const primitives = { MarkdownText: () => null, FishLogo: () => null, writeClipboard: async () => true, UserMessageContent: () => null }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : fake.React))
  const { ToolCell } = mod.exports

  const roster = { byId: { b1: { id: 'b1', name: 'Lead' } }, roomsById: { r1: { id: 'r1', name: 'Team' } }, bots: [], rooms: [], exchangeTurns: {} }
  const payload = JSON.stringify({ replies: [{ kind: 'goal', action: 'started', title: 'Ship v2', botId: 'b1' }] })
  fake.clear()
  const wrapper = ToolCell({
    sessionId: 'r1',
    node: { data: { root: { turn: 1, kind: 'tool-result', name: 'group_relay', callId: 'c1', content: [{ type: 'text', text: payload }] } } },
    useRoster: sel => sel(roster),
    useUi: sel => sel({ reactions: {} }),
    useWork: sel => sel({ bots: {}, rooms: {} }),
    actions: {},
  })
  const relayNode = findAll(wrapper, n => typeof n.type === 'function' && n.props?.callId === 'c1')[0] ?? wrapper
  assert.equal(typeof relayNode.type, 'function', 'ToolCell should delegate group_relay to GroupReplies')
  fake.clear()
  const tree = relayNode.type(relayNode.props)
  const events = findAll(tree, n => n.props?.className === 'bt-event')
  assert.equal(events.length, 1, 'goal event must render as a .bt-event row')
  assert.match(textOf(events[0]), /Ship v2/)
})

test('ContextMenu requires two clicks to delete a Bot without crashing hooks', async () => {
  const code = await loadClientBundle("export { ContextMenu } from './src/client/context-menu.js'")
  const fake = makeFakeReact()
  const mod = { exports: {} }
  const fakeDom = { createPortal: el => el }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? fakeDom : fake.React))
  const { ContextMenu } = mod.exports

  const deleted = []
  const menu = { x: 100, y: 100, id: 'b2' }
  const roster = { mainBotId: 'b1', mainBotIds: ['b1'], byId: { b2: { id: 'b2', name: 'Scout' } }, roomsById: {}, bots: [{ id: 'b2', name: 'Scout' }], rooms: [], sections: [] }
  const useWork = sel => sel({ bots: {}, rooms: {}, approvals: [], waiting: {} })
  const actions = {
    closeMenu: () => {},
    deleteBot: id => { deleted.push(id); return Promise.resolve() },
    reportError: () => {},
  }

  fake.clear()
  let tree = ContextMenu({ menu, roster, actions, useWork })
  const delBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-danger')[0]
  assert.ok(delBtn, 'Delete button should render for non-main bot')
  assert.equal(textOf(delBtn), 'Delete')
  delBtn.props.onClick()
  assert.deepEqual(deleted, [], 'first click must arm confirmation without deleting')

  fake.reset()
  tree = ContextMenu({ menu, roster, actions, useWork })
  const confirmBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-danger')[0]
  assert.equal(textOf(confirmBtn), 'Click again to delete')
  confirmBtn.props.onClick()
  assert.deepEqual(deleted, ['b2'], 'second click confirms and calls deleteBot')
})

test('app/ui locale maps all 8 supported languages accurately', async () => {
  const { createLocale } = await import('../../app/ui/src/locale.js')
  assert.equal(createLocale('zh-CN').getLocale().active, 'zh')
  assert.equal(createLocale('zh-TW').getLocale().active, 'zh-TW')
  assert.equal(createLocale('zh-HK').getLocale().active, 'zh-TW')
  assert.equal(createLocale('zh-Hant-SG').getLocale().active, 'zh-TW')
  assert.equal(createLocale('ja-JP').getLocale().active, 'ja')
  assert.equal(createLocale('ko-KR').getLocale().active, 'ko')
  assert.equal(createLocale('es-MX').getLocale().active, 'es')
  assert.equal(createLocale('fr-FR').getLocale().active, 'fr')
  assert.equal(createLocale('de-AT').getLocale().active, 'de')
  assert.equal(createLocale('en-US').getLocale().active, 'en')
  assert.equal(createLocale('pt-BR').getLocale().active, 'en')
})

// Stateful React harness that tracks per-instance hook slots, effect deps/cleanups,
// and child-before-parent effect commit order (matching React's commit phase).
function makeStatefulReact() {
  let active = null
  const instances = new Map()
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const slot = (init) => {
    const i = active.idx++
    if (!(i in active.hooks)) active.hooks[i] = init()
    return active.hooks[i]
  }
  const scheduleEffect = (fn, deps) => {
    const cell = slot(() => ({ deps: undefined, cleanup: undefined }))
    if (deps === undefined || !sameDeps(cell.deps, deps)) {
      active.pending.push(() => {
        if (typeof cell.cleanup === 'function') cell.cleanup()
        cell.deps = deps
        cell.cleanup = fn()
      })
    }
  }
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  }
  const React = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true) }
    },
    useState(init) {
      const cell = slot(() => ({ value: typeof init === 'function' ? init() : init }))
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useRef(init) { return slot(() => ({ current: init })) },
    useMemo(fn, deps) {
      const cell = slot(() => ({ deps: undefined, value: undefined, ready: false }))
      if (!cell.ready || deps === undefined || !sameDeps(cell.deps, deps)) {
        cell.deps = deps
        cell.value = fn()
        cell.ready = true
      }
      return cell.value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useId() { return 'bt-test-id' },
    useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() },
    createContext(v) { return { Provider: ({ children }) => children, _v: v } },
    useContext(c) { return c?._v },
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
  }
  function renderNode(node, path, seen, effects) {
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, `${path}[${i}]`, seen, effects))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name || 'fn'}:${node.props?.key ?? ''}`
      seen.add(key)
      let inst = instances.get(key)
      if (!inst) { inst = { hooks: [], idx: 0, pending: [] }; instances.set(key, inst) }
      let out
      if (node.type.prototype && typeof node.type.prototype.render === 'function') {
        const clsProps = { ...node.props, children: node.children }
        if (!inst.cls) inst.cls = new node.type(clsProps)
        inst.cls.props = clsProps
        out = inst.cls.render()
      } else {
        const prev = active
        active = inst
        inst.idx = 0
        inst.pending = []
        try {
          out = node.type({ ...node.props, children: node.children })
        } finally {
          active = prev
        }
      }
      // Children commit effects BEFORE their parent, matching React.
      const expanded = renderNode(out, key, seen, effects)
      effects.push(...inst.pending)
      inst.pending = []
      return expanded
    }
    return {
      ...node,
      children: (node.children ?? []).map((child, i) => renderNode(child, `${path}/${i}`, seen, effects)),
    }
  }
  function render(element, attachRefs) {
    const seen = new Set()
    const effects = []
    const tree = renderNode(element, 'root', seen, effects)
    for (const [key, inst] of [...instances.entries()]) {
      if (!seen.has(key)) {
        for (const hook of inst.hooks) {
          if (hook && typeof hook.cleanup === 'function') hook.cleanup()
        }
        instances.delete(key)
      }
    }
    if (attachRefs) attachRefs(tree)
    for (const run of effects) run()
    return tree
  }
  function unmount() {
    for (const inst of instances.values()) {
      for (const hook of inst.hooks) {
        if (hook && typeof hook.cleanup === 'function') hook.cleanup()
      }
    }
    instances.clear()
  }
  return { React, render, unmount }
}

test('BrowserView detects inline [role="menu"] added/removed inside [data-chat-flow] while skipping plain chat streaming', async () => {
  const code = await loadClientBundle("export { BrowserView, shouldCheckBrowserCover } from './src/client/browser-pane.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  const fakeDom = { createPortal: el => el }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? fakeDom : harness.React))
  const { BrowserView, shouldCheckBrowserCover } = mod.exports

  let observerCb = null
  let rafId = 0
  const rafQueue = new Map()
  const openOverlays = []
  const origDoc = globalThis.document
  const origWin = globalThis.window
  const origMO = globalThis.MutationObserver
  const origRO = globalThis.ResizeObserver
  const origRaf = globalThis.requestAnimationFrame
  const origCancelRaf = globalThis.cancelAnimationFrame
  const frameRect = { left: 400, top: 0, right: 900, bottom: 700, width: 500, height: 700 }
  const chatFlowTarget = {
    nodeType: 1,
    closest: sel => (sel === '[data-chat-flow]' ? {} : null),
  }
  const makeEl = ({ matchesMenu = false, containsMenu = false, rect = null } = {}) => ({
    nodeType: 1,
    matches: sel => matchesMenu && sel.includes('[role="menu"]'),
    querySelector: sel => (containsMenu && sel.includes('[role="menu"]') ? {} : null),
    getBoundingClientRect: () => rect ?? { left: 420, top: 100, right: 620, bottom: 260, width: 200, height: 160 },
  })

  globalThis.MutationObserver = class {
    constructor(cb) { observerCb = cb }
    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => { const id = ++rafId; rafQueue.set(id, fn); return id }
  globalThis.cancelAnimationFrame = (id) => { rafQueue.delete(id) }
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) }
  globalThis.document = {
    body: {},
    querySelectorAll: (sel) => (sel.includes('[role="menu"]') ? openOverlays : []),
  }

  try {
    // Plain chat text inside [data-chat-flow] must stay skipped.
    assert.equal(shouldCheckBrowserCover([{
      type: 'childList', target: chatFlowTarget, addedNodes: [makeEl()], removedNodes: [],
    }]), false)
    // Inline menu element or wrapper containing [role="menu"] inside [data-chat-flow] must trigger a check.
    assert.equal(shouldCheckBrowserCover([{
      type: 'childList', target: chatFlowTarget, addedNodes: [makeEl({ matchesMenu: true })], removedNodes: [],
    }]), true)
    assert.equal(shouldCheckBrowserCover([{
      type: 'childList', target: chatFlowTarget, addedNodes: [makeEl({ containsMenu: true })], removedNodes: [],
    }]), true)

    const shownCalls = []
    const actions = {
      browserShow: (tabId, rect) => { shownCalls.push([tabId, rect]) },
      browserCommand() {},
      browserNewTab() {},
      browserNavigate: async () => true,
      browserFocus() {},
    }
    const props = {
      bot: { id: 'b1', name: 'Scout' },
      tabId: 't1',
      leaving: false,
      landed: true,
      actions,
      useBrowserPages: sel => sel({ t1: { url: 'https://example.com', title: 'Example' } }),
      hold: null,
    }
    const renderView = () => harness.render(harness.React.createElement(BrowserView, props), (tree) => {
      const frameNode = findAll(tree, n => n.props?.className === 'bt-browser-frame')[0]
      if (frameNode?.props?.ref && !frameNode.props.ref.current) {
        frameNode.props.ref.current = { getBoundingClientRect: () => frameRect }
      }
    })
    renderView()
    assert.deepEqual(shownCalls.at(-1), ['t1', { left: 400, top: 0, width: 500, height: 700 }], 'guest starts visible')

    // Plain streaming mutation inside [data-chat-flow] must not schedule an overlap check.
    rafQueue.clear()
    observerCb([{ type: 'childList', target: chatFlowTarget, addedNodes: [makeEl()], removedNodes: [] }])
    assert.equal(rafQueue.size, 0, 'plain chat streaming mutation must not schedule rAF')

    // MailApprovalMenu opens inline inside [data-chat-flow], overlapping the browser pane.
    const menuEl = makeEl({ matchesMenu: true })
    openOverlays.push(menuEl)
    observerCb([{ type: 'childList', target: chatFlowTarget, addedNodes: [menuEl], removedNodes: [] }])
    assert.equal(rafQueue.size, 1, 'inline [role="menu"] inside [data-chat-flow] must schedule rAF')
    for (const fn of [...rafQueue.values()]) fn()
    rafQueue.clear()
    renderView()
    assert.deepEqual(shownCalls.at(-1), ['t1', null], 'overlapping inline menu must hide native guest view')

    // MailApprovalMenu closes inside [data-chat-flow] -> guest view becomes visible again.
    openOverlays.length = 0
    observerCb([{ type: 'childList', target: chatFlowTarget, addedNodes: [], removedNodes: [menuEl] }])
    assert.equal(rafQueue.size, 1, 'removing inline [role="menu"] inside [data-chat-flow] must schedule rAF')
    for (const fn of [...rafQueue.values()]) fn()
    rafQueue.clear()
    renderView()
    assert.deepEqual(shownCalls.at(-1), ['t1', { left: 400, top: 0, width: 500, height: 700 }], 'closing inline menu restores guest view')
    harness.unmount()
  } finally {
    globalThis.document = origDoc
    globalThis.window = origWin
    globalThis.MutationObserver = origMO
    globalThis.ResizeObserver = origRO
    globalThis.requestAnimationFrame = origRaf
    globalThis.cancelAnimationFrame = origCancelRaf
  }
})

test('GeneralPage preset and default accent swatches cancel pending debounced custom accent', async () => {
  const code = await loadClientBundle("export { SettingsDialog } from './src/client/settings.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  const icon = () => null
  const primitives = {
    IconAgentPresetOutlineMedium: icon,
    IconArchiveOutlineMedium: icon,
    IconPersonalizationOutlineMedium: icon,
    IconSettingsOutlineMedium: icon,
    IconUserOutlineMedium: icon,
    MarkdownText: () => null,
    FishLogo: () => null,
    writeClipboard: async () => true,
    UserMessageContent: () => null,
  }
  const origWin = globalThis.window
  const origDoc = globalThis.document
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  const origRaf = globalThis.requestAnimationFrame
  const origCancelRaf = globalThis.cancelAnimationFrame
  let nextTimerId = 1
  const timers = new Map()
  globalThis.setTimeout = (fn) => { const id = nextTimerId++; timers.set(id, fn); return id }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) }
  globalThis.document = { body: {}, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} }

  try {
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SettingsDialog } = mod.exports

    const runScenario = (pickTarget) => {
      const saved = []
      const roster = { bots: [], rooms: [], byId: {}, roomsById: {}, prefs: { theme: 'deepseek' }, models: [], mainBotIds: [] }
      const actions = {
        closeSettings() {},
        setPrefs: patch => { saved.push(patch); return Promise.resolve() },
        folders: () => Promise.resolve({ team: '/tmp/work' }),
      }
      const tree = harness.render(harness.React.createElement(SettingsDialog, {
        page: 'general', id: null, roster, actions, useUpdate: sel => sel({}),
      }))
      const colorInput = findAll(tree, n => n.type === 'input' && n.props?.type === 'color')[0]
      assert.ok(colorInput, 'custom accent color input should render')
      const timersBefore = timers.size
      colorInput.props.onChange({ target: { value: '#ff00aa' } })
      assert.equal(saved.length, 0, 'custom accent should be debounced')
      assert.equal(timers.size, timersBefore + 1, 'debounce timer should be scheduled')

      const btn = pickTarget(tree)
      assert.ok(btn, 'target accent swatch should render')
      btn.props.onClick()
      assert.equal(timers.size, timersBefore, 'clicking swatch must clear pending debounce timer')

      for (const fn of [...timers.values()]) fn()
      timers.clear()
      harness.unmount()
      return saved
    }

    const defaultSaved = runScenario(tree => findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-swatch bt-swatch-default')[0])
    assert.deepEqual(defaultSaved, [{ accent: null }], 'default theme accent must not be overwritten by cancelled custom accent')

    const presetSaved = runScenario(tree => findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-swatch')[0])
    assert.equal(presetSaved.length, 1, 'preset accent must not be overwritten by cancelled custom accent')
    assert.notEqual(presetSaved[0].accent, '#ff00aa')
    assert.ok(typeof presetSaved[0].accent === 'string' && presetSaved[0].accent.startsWith('#'))
  } finally {
    harness.unmount()
    globalThis.window = origWin
    globalThis.document = origDoc
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
    globalThis.requestAnimationFrame = origRaf
    globalThis.cancelAnimationFrame = origCancelRaf
  }
})

test('PanelStrip repositions active capsule when sibling tab titles grow, tabs swap with equal length, or ResizeObserver fires', async () => {
  const code = await loadClientBundle("export { PanelStrip } from './src/client/browser-pane.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
    id === 'react-dom' ? { createPortal: el => el } : harness.React
  ))
  const { PanelStrip } = mod.exports

  let roCallback = null
  const observed = new Set()
  const origRO = globalThis.ResizeObserver
  const origWin = globalThis.window
  const origDoc = globalThis.document
  globalThis.ResizeObserver = class {
    constructor(cb) { roCallback = cb }
    observe(el) { observed.add(el) }
    unobserve(el) { observed.delete(el) }
    disconnect() { observed.clear() }
  }
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) }
  globalThis.document = { body: { dataset: {} }, querySelectorAll: () => [] }

  try {
    const botTab = { isConnected: true, offsetLeft: 0, offsetWidth: 40 }
    const tab1 = { isConnected: true, offsetLeft: 44, offsetWidth: 60 }
    const tab2 = { isConnected: true, offsetLeft: 108, offsetWidth: 80 }
    const tab3 = { isConnected: true, offsetLeft: 44, offsetWidth: 96 }
    let currentTabs = { t1: tab1, t2: tab2 }
    const box = {
      offsetWidth: 400,
      scrollLeft: 0,
      querySelector(sel) {
        if (sel === '.bt-ptab-bot') return botTab
        const m = /^\[data-tab="([^"]+)"\]$/.exec(sel)
        return m ? currentTabs[m[1]] ?? null : null
      },
      querySelectorAll(sel) {
        if (sel === '.bt-ptab-bot, .bt-ptab-wrap') return [botTab, ...Object.values(currentTabs)]
        return []
      },
    }
    const capsule = { style: {}, animate: () => ({ cancel() {} }) }
    const renderStrip = ({ ids, pages }) => {
      const el = harness.React.createElement(PanelStrip, {
        bot: { id: 'b1', name: 'Scout' },
        subject: 'b1',
        view: 'browser',
        ids,
        active: 't2',
        sides: [],
        side: null,
        canBrowse: true,
        reading: false,
        onView() {},
        actions: { closePanel() {}, browserActivate() {}, browserCloseTab() {} },
        useBrowserPages: sel => sel(pages),
      })
      harness.render(el, (tree) => {
        const wrapNode = findAll(tree, n => n.props?.className === 'bt-ptabs-in')[0]
        const indNode = findAll(tree, n => n.props?.className === 'bt-ptab-ind')[0]
        if (!wrapNode.props.ref.current) {
          wrapNode.props.ref.current = box
          indNode.props.ref.current = capsule
        }
      })
    }

    renderStrip({ ids: ['t1', 't2'], pages: { t1: { title: 'Short' }, t2: { title: 'Active' } } })
    assert.equal(capsule.style.left, '108px')
    assert.equal(capsule.style.right, '212px')
    assert.ok(observed.has(box) && observed.has(botTab) && observed.has(tab1) && observed.has(tab2), 'ResizeObserver must observe box and every tab')

    // Left sibling title grows without changing ids.length -> active tab shifts right.
    tab2.offsetLeft = 188
    renderStrip({ ids: ['t1', 't2'], pages: { t1: { title: 'A Much Longer Loaded Title' }, t2: { title: 'Active' } } })
    assert.equal(capsule.style.left, '188px', 'capsule must follow active tab when sibling title grows')
    assert.equal(capsule.style.right, '132px')

    // Equal-length replacement of left tab id -> active tab shifts again.
    currentTabs = { t3: tab3, t2: tab2 }
    tab2.offsetLeft = 144
    renderStrip({ ids: ['t3', 't2'], pages: { t3: { title: 'Short' }, t2: { title: 'Active' } } })
    assert.equal(capsule.style.left, '144px', 'capsule must follow active tab on equal-length tab swap')
    assert.ok(observed.has(tab3) && !observed.has(tab1), 'ResizeObserver must swap observed tab nodes')

    // Non-React layout resize (e.g. font/favicon load) shifts active tab -> ResizeObserver updates capsule.
    tab2.offsetLeft = 160
    roCallback()
    assert.equal(capsule.style.left, '160px', 'ResizeObserver must reposition capsule on sibling resize')
    harness.unmount()
  } finally {
    globalThis.ResizeObserver = origRO
    globalThis.window = origWin
    globalThis.document = origDoc
  }
})

test('useEscape priority stack lets DetailsDrawer rename and ImportMenu consume Escape without closing BotPanel', async () => {
  const code = await loadClientBundle(`
    export { BotPanel, ImportMenu } from './src/client/browser-pane.js'
    export { useEscape } from './src/client/overlay-hooks.js'
  `)
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  const listeners = new Set()
  const origWin = globalThis.window
  const origDoc = globalThis.document
  const origRO = globalThis.ResizeObserver
  const origLS = globalThis.localStorage
  const origRaf = globalThis.requestAnimationFrame
  const origCancelRaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = {
    addEventListener(type, fn) { if (type === 'keydown') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'keydown') listeners.delete(fn) },
    matchMedia: () => ({ matches: true }),
  }
  globalThis.document = {
    body: { dataset: {} },
    head: { appendChild() {} },
    createElement: () => ({
      dataset: {},
      style: {},
      textContent: '',
      sheet: { cssRules: [{ style: { setProperty() {}, removeProperty() {} } }], insertRule() { return 0 } },
      remove() {},
    }),
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.localStorage = { getItem: () => null, setItem() {} }

  const fireWindowEscape = (extra = {}) => {
    const event = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...extra }
    for (const fn of [...listeners]) fn(event)
    return event
  }

  try {
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { BotPanel, ImportMenu, useEscape } = mod.exports

    let closedOverlay = 0
    let updatedBot = 0
    const roster = {
      bots: [{ id: 'b1', name: 'Scout' }],
      rooms: [],
      byId: { b1: { id: 'b1', name: 'Scout', parts: [] } },
      roomsById: {},
      mainBotIds: ['b1'],
      exchangeTurns: {},
      models: [],
      sideChats: {},
      browser: false,
    }
    const actions = {
      closeOverlay: () => { closedOverlay += 1 },
      closePanel() {},
      updateBot: () => { updatedBot += 1; return Promise.resolve() },
      setPanelView() {},
      browserShow: () => Promise.resolve(),
    }
    const panelProps = {
      pane: { id: 'b1', view: 'details', renaming: true, tab: null, side: null },
      leaving: false,
      room: 1000,
      overlay: false,
      roster,
      actions,
      useSessions: sel => sel({ byId: {}, projectionsBySession: {} }),
      useSessionStatus: sel => sel(new Map()),
      useActivity: sel => sel({}),
      useWork: sel => sel({ bots: {}, rooms: {}, approvals: [], waiting: {} }),
      useBrowserTabs: sel => sel({}),
      useBrowserPages: sel => sel({}),
      useBrowserHolds: sel => sel({}),
      useComputer: sel => sel({}),
    }

    // 1. BotPanel + DetailsDrawer mounted in the same commit with startRenaming=true:
    // child effects run before parent effects, yet Escape must cancel rename FIRST.
    let tree = harness.render(harness.React.createElement(BotPanel, panelProps))
    let renameInput = findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-drawer-name-input')[0]
    assert.ok(renameInput, 'rename input should mount active')
    // Escape via React input onKeyDown + native bubble to window:
    let nativeStopped = false
    const inputEvt = {
      key: 'Escape',
      keyCode: 27,
      defaultPrevented: false,
      nativeEvent: { isComposing: false, stopPropagation() { nativeStopped = true } },
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
    }
    renameInput.props.onKeyDown(inputEvt)
    assert.equal(nativeStopped, true, 'input onKeyDown must stop native propagation')
    assert.equal(inputEvt.defaultPrevented, true, 'input onKeyDown must preventDefault')
    fireWindowEscape({ defaultPrevented: inputEvt.defaultPrevented })
    assert.equal(closedOverlay, 0, 'cancelling rename via input Escape must not close BotPanel')
    assert.equal(updatedBot, 0, 'cancelling rename must not save draft')

    // Re-open rename and test direct window Escape (priority stack when focus is elsewhere).
    tree = harness.render(harness.React.createElement(BotPanel, panelProps))
    const renameBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-drawer-name')[0]
    assert.ok(renameBtn, 'rename button should return after cancel')
    renameBtn.props.onClick()
    tree = harness.render(harness.React.createElement(BotPanel, panelProps))
    assert.ok(findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-drawer-name-input')[0], 'rename input re-opened')
    fireWindowEscape()
    assert.equal(closedOverlay, 0, 'window Escape during rename must cancel rename, not close BotPanel')
    tree = harness.render(harness.React.createElement(BotPanel, panelProps))
    assert.equal(findAll(tree, n => n.type === 'input' && n.props?.className === 'bt-drawer-name-input').length, 0)
    // Second Escape (no longer renaming) closes BotPanel.
    fireWindowEscape()
    assert.equal(closedOverlay, 1, 'second Escape closes BotPanel')

    // 2. ImportMenu over BotPanel + a newer modal dialog over both:
    closedOverlay = 0
    let importClosed = 0
    let dialogClosed = 0
    function TestDialog() { useEscape(() => { dialogClosed += 1 }); return null }
    function Host({ showImport, showDialog }) {
      return harness.React.createElement(harness.React.Fragment, null,
        harness.React.createElement(BotPanel, { ...panelProps, pane: { ...panelProps.pane, renaming: false } }),
        showImport ? harness.React.createElement(ImportMenu, { sources: [], busy: false, onFile() {}, onSource() {}, onClose: () => { importClosed += 1 } }) : null,
        showDialog ? harness.React.createElement(TestDialog) : null)
    }
    harness.unmount()
    harness.render(harness.React.createElement(Host, { showImport: true, showDialog: true }))
    // IME Escape must close nothing.
    fireWindowEscape({ isComposing: true })
    fireWindowEscape({ keyCode: 229 })
    assert.deepEqual([dialogClosed, importClosed, closedOverlay], [0, 0, 0])
    // Escape #1 closes newest priority-0 layer (TestDialog).
    fireWindowEscape()
    assert.deepEqual([dialogClosed, importClosed, closedOverlay], [1, 0, 0])
    harness.render(harness.React.createElement(Host, { showImport: true, showDialog: false }))
    // Escape #2 closes ImportMenu without closing BotPanel.
    fireWindowEscape()
    assert.deepEqual([dialogClosed, importClosed, closedOverlay], [1, 1, 0])
    harness.render(harness.React.createElement(Host, { showImport: false, showDialog: false }))
    // Escape #3 closes BotPanel.
    fireWindowEscape()
    assert.deepEqual([dialogClosed, importClosed, closedOverlay], [1, 1, 1])
    harness.unmount()
  } finally {
    harness.unmount()
    globalThis.window = origWin
    globalThis.document = origDoc
    globalThis.ResizeObserver = origRO
    globalThis.localStorage = origLS
    globalThis.requestAnimationFrame = origRaf
    globalThis.cancelAnimationFrame = origCancelRaf
  }
})

test('room-chat adapter renders distinct group members and round events in ChatRows without merging or "Message from" misrenders', async () => {
  const code = await loadClientBundle(`
    export { ChatRows } from './src/client/cells.js'
    export { adaptRoomItems } from '../app/ui/src/chat.js'
  `)
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  const primitives = {
    MarkdownText: ({ text }) => harness.React.createElement('span', { className: 'md' }, text),
    FishLogo: () => null,
    writeClipboard: async () => true,
    UserMessageContent: () => null,
  }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
    id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : id === 'react-dom' ? { createPortal: el => el } : harness.React
  ))
  const { ChatRows, adaptRoomItems } = mod.exports

  const roster = {
    byId: {
      b1: { id: 'b1', name: 'Alpha', color: 'blue' },
      b2: { id: 'b2', name: 'Beta', color: 'green' },
    },
    roomsById: { r1: { id: 'r1', name: 'Design', admin: 'b1', members: ['b1', 'b2'] } },
    bots: [],
    rooms: [],
    prefs: {},
    exchangeTurns: {},
  }
  const roomChatItems = [
    { id: '1', kind: 'user', text: 'Kick off', time: 1000 },
    { id: 'c1:0', kind: 'bot', botId: 'b1', name: 'Alpha', color: 'blue', text: 'Alpha reply', time: 1100 },
    { id: 'c1:1', kind: 'bot', botId: 'b2', name: 'Beta', color: 'green', text: 'Beta reply', time: 1200 },
    { id: 'c1:2', kind: 'event', event: 'done', botId: 'b1', name: 'Alpha', color: 'blue', time: 1300 },
    { id: 'c1:3', kind: 'event', event: 'failed', botId: 'b2', name: 'Beta', color: 'green', text: 'timeout', time: 1400 },
    { id: '2', kind: 'event', event: 'schedule', text: 'Daily digest', time: 1500 },
  ]
  const origWin = globalThis.window
  const origDoc = globalThis.document
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 }
  globalThis.document = { body: { dataset: {} }, querySelectorAll: () => [] }
  try {
    const adapted = adaptRoomItems(roomChatItems)
    const tree = harness.render(harness.React.createElement(ChatRows, {
      items: adapted,
      sessionId: 'r1',
      roster,
      actions: { openSession() {}, showDetails() {}, quote() {} },
      clock: false,
    }))
    const fullText = textOf(tree)
    const groupMsgs = findAll(tree, n => n.props?.className === 'bt-group-msg')
    assert.equal(groupMsgs.length, 2, 'consecutive messages from different group members must not merge into one block')
    assert.equal(groupMsgs[0].props['data-bot-id'], 'b1')
    assert.equal(groupMsgs[1].props['data-bot-id'], 'b2')
    assert.match(textOf(groupMsgs[0]), /Alpha/)
    assert.match(textOf(groupMsgs[0]), /Alpha reply/)
    assert.match(textOf(groupMsgs[1]), /Beta/)
    assert.match(textOf(groupMsgs[1]), /Beta reply/)

    const events = findAll(tree, n => typeof n.props?.className === 'string' && n.props.className.includes('bt-event'))
    assert.equal(events.length, 3, 'all 3 group events (done, failed, schedule) must render via RelayEvent')
    assert.match(textOf(events[0]), /Alpha finished its work/)
    assert.match(textOf(events[1]), /Beta stopped:/)
    assert.match(textOf(events[2]), /Scheduled task: Daily digest/)
    assert.doesNotMatch(fullText, /Message from/, 'group events must never misrender as 1:1 "Message from"')
    harness.unmount()
  } finally {
    globalThis.window = origWin
    globalThis.document = origDoc
  }
})
