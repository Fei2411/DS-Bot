import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { effectsOf } from '../src/client/themes.js'
import { toTraditional } from '../src/client/locales/zh-tw.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { effectsTier, reducedEffects, reducedMotion } from './src/client/motion.js'",
      "export { SHELL_CSS, botOwnCss } from './src/client/styles.js'",
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { BotMark } from './src/client/mark.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const makeReact = (overrides = {}) => {
  class FakeComponent { constructor(p) { this.props = p } }
  return {
    Component: FakeComponent,
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useCallback: fn => fn,
    useEffect() {},
    useLayoutEffect() {},
    useMemo: make => make(),
    useRef: current => ({ current }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    startTransition: fn => fn(),
    createElement: (type, p, ...children) => ({ type, props: p ? { ...p, children } : { children } }),
    Fragment: 'fragment',
    ...overrides,
  }
}

const loadClient = (globals = {}, hooks = {}) => {
  const react = makeReact(hooks)
  const icons = new Proxy({}, { get: () => () => ({ type: 'svg', props: { children: [] } }) })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return icons
      return {}
    },
    ...globals,
  })
  return { exports: module.exports, react }
}

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    if (node.type.prototype?.render) {
      const instance = new node.type(node.props)
      return expand(instance.render())
    }
    return expand(node.type(node.props))
  }
  return { ...node, props: node.props ? { ...node.props, children: expand(node.props.children) } : { children: expand(node.props?.children) } }
}

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.props?.children, visit)
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ui-motion-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1, bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const ctx = fakeContext()
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, saved, stop }
}

test('set-prefs persists reduced and off effects tiers independently of bot motion and clears on full or null', async (t) => {
  const host = startHost()
  t.after(host.stop)

  await host.call('set-prefs', { effects: 'reduced', motion: 'lively' })
  assert.deepEqual(host.saved().prefs, { motion: 'lively', effects: 'reduced' })

  await host.call('set-prefs', { effects: 'off' })
  assert.deepEqual(host.saved().prefs, { motion: 'lively', effects: 'off' })

  await host.call('set-prefs', { effects: 'full' })
  assert.deepEqual(host.saved().prefs, { motion: 'lively' })
  assert.equal('effects' in host.saved().prefs, false)

  await host.call('set-prefs', { effects: 'reduced' })
  await host.call('set-prefs', { effects: null })
  assert.deepEqual(host.saved().prefs, { motion: 'lively' })

  const invalidRes = await host.call('set-prefs', { effects: 'minimal' })
  assert.deepEqual(invalidRes, { ok: false, error: { code: 'bot/invalid', message: 'Effects must be full, reduced or off', details: {} } })
})

test('effectsOf normalizes missing and unknown values to full', () => {
  assert.equal(effectsOf(undefined), 'full')
  assert.equal(effectsOf(null), 'full')
  assert.equal(effectsOf({}), 'full')
  assert.equal(effectsOf({ effects: 'full' }), 'full')
  assert.equal(effectsOf({ effects: 'extreme' }), 'full')
  assert.equal(effectsOf({ effects: 'reduced' }), 'reduced')
  assert.equal(effectsOf({ effects: 'off' }), 'off')
})

test('effectsTier, reducedEffects and reducedMotion handle Node without globals and distinguish tiers in DOM', () => {
  const bare = loadClient().exports
  assert.equal(bare.effectsTier(), 'full')
  assert.equal(bare.reducedEffects(), false)
  assert.equal(bare.reducedMotion(), false)

  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  let osReduced = false
  dom.window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' ? osReduced : false })
  const client = loadClient({ window: dom.window, document: dom.window.document }).exports

  dom.window.document.body.dataset.btEffects = 'full'
  assert.equal(client.effectsTier(), 'full')
  assert.equal(client.reducedEffects(), false)
  assert.equal(client.reducedMotion(), false)

  dom.window.document.body.dataset.btEffects = 'reduced'
  assert.equal(client.effectsTier(), 'reduced')
  assert.equal(client.reducedEffects(), true)
  assert.equal(client.reducedMotion(), false)

  dom.window.document.body.dataset.btEffects = 'off'
  assert.equal(client.effectsTier(), 'off')
  assert.equal(client.reducedEffects(), true)
  assert.equal(client.reducedMotion(), true)

  dom.window.document.body.dataset.btEffects = 'full'
  osReduced = true
  assert.equal(client.effectsTier(), 'full')
  assert.equal(client.reducedEffects(), true)
  assert.equal(client.reducedMotion(), true)
})

test('botOwnCss preserves effects tokens, backdrop relief and off-tier rules while stripping shell selectors', () => {
  const { SHELL_CSS, botOwnCss } = loadClient().exports
  assert.match(SHELL_CSS, /@keyframes bt-veil-in\{from\{opacity:0;filter:var\(--bt-fx-blur-6,blur\(6px\)\)\}\}/)
  const own = botOwnCss(SHELL_CSS)
  assert.match(own, /body\[data-bt-effects=reduced\],body\[data-bt-effects=off\]\{--dsw-menu-backdrop-filter:none;--dsw-mask-blur:none;/)
  assert.match(own, /body\[data-bt-effects=reduced\] \.bt-mark\[data-gaze\] \.bt-gaze/)
  assert.match(own, /--bt-fx-blur-6:none/)
  assert.match(own, /\.bt-pill[^}]*backdrop-filter:none!important/)
  assert.match(own, /\.bt-settings-layer[^}]*animation:none!important;transition:none!important/)
  assert.match(own, /\.bt-spin[^}]*animation-timing-function:steps\(8\)!important/)
  assert.doesNotMatch(own, /\[data-bt-effects=off\] \[class\*="_centerCol"\]/)
  assert.doesNotMatch(own, /\[class\^="bt-"\]/)
})

test('Traditional Chinese phrase mapping translates 界面动效 and its tier labels', () => {
  assert.equal(toTraditional('界面动效'), '介面動效')
  assert.equal(toTraditional('标准'), '標準')
  assert.equal(toTraditional('精简'), '精簡')
  assert.equal(toTraditional('无'), '無')
})

test('SettingsDialog renders Interface motion choices in General appearance and updates effects', () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const { exports: client, react } = loadClient({ document: dom.window.document, window: dom.window })

  const calls = []
  const tree = expand(react.createElement(client.SettingsDialog, {
    page: 'general',
    roster: { byId: {}, roomsById: {}, prefs: { effects: 'reduced' } },
    actions: {
      setPrefs: (patch) => { calls.push(patch); return Promise.resolve() },
      openSettings() {},
      closeSettings() {},
    },
    dsh: { items: [{ id: 'theme' }], sections: [], renderSlot: (_slot, _p, opts) => opts?.fallback ?? null },
  }))

  let group = null
  walk(tree, (node) => {
    if (node.type === 'div' && node.props?.['aria-label'] === 'Interface motion') group = node
  })
  assert.ok(group, 'Interface motion Segmented group should render in GeneralPage')
  const buttons = []
  walk(group, (node) => { if (node.type === 'button') buttons.push(node) })
  assert.deepEqual(buttons.map(btn => [textOf(btn), btn.props['aria-pressed']]), [
    ['Full', false],
    ['Reduced', true],
    ['None', false],
  ])
  buttons[2].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ effects: 'off' }])
})

test('BotMark gaze listeners and offsets respond dynamically to data-bt-effects changes', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const { window } = dom
  const { document } = window
  document.body.dataset.btEffects = 'full'

  let rafId = 0
  let queued = new Map()
  let rafCalls = 0
  window.matchMedia = () => ({ matches: false })
  const globals = {
    window,
    document,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (fn) => {
      rafCalls += 1
      const id = ++rafId
      queued.set(id, fn)
      return id
    },
    cancelAnimationFrame: (id) => { queued.delete(id) },
  }
  const flushRaf = () => {
    const callbacks = [...queued.values()]
    queued.clear()
    for (const fn of callbacks) fn()
  }

  const node = document.createElement('span')
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 40 })
  document.body.appendChild(node)

  const effects = []
  let refCount = 0
  const { exports: client } = loadClient(globals, {
    useRef: (init) => (refCount++ === 0 ? { current: node } : { current: init }),
    useEffect: (fn) => { effects.push(fn) },
  })

  client.BotMark({ bot: { id: 'b1' }, look: { shape: 'orb', color: '#4f7' }, gaze: true })
  assert.equal(effects.length, 1)
  const dispose = effects[0]()

  const move = (x, y) => {
    const ev = new window.Event('pointermove')
    ev.clientX = x
    ev.clientY = y
    window.dispatchEvent(ev)
  }
  rafCalls = 0
  move(100, 60)
  assert.equal(rafCalls, 1)
  flushRaf()
  assert.notEqual(node.style.getPropertyValue('--bt-gx'), '')

  // Switching to reduced clears existing gaze offsets and stops scheduling RAF
  document.body.dataset.btEffects = 'reduced'
  await new Promise(r => setTimeout(r, 20))
  assert.equal(node.style.getPropertyValue('--bt-gx'), '')
  assert.equal(node.style.getPropertyValue('--bt-gy'), '')
  rafCalls = 0
  move(180, 140)
  assert.equal(rafCalls, 0)

  // Switching back to full re-attaches without remounting the mark
  document.body.dataset.btEffects = 'full'
  await new Promise(r => setTimeout(r, 20))
  move(180, 140)
  assert.equal(rafCalls, 1)
  flushRaf()
  assert.notEqual(node.style.getPropertyValue('--bt-gx'), '')

  dispose()
  rafCalls = 0
  move(10, 10)
  assert.equal(rafCalls, 0)
})
