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
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}

function textOf(node) {
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
