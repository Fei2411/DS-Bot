import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom and the real client module system come from the harness, as the dsh packages do.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

// The style helpers and the CSS they ship, bundled once with a minimal React for
// motion.js; they run in each test's jsdom document through the vm context.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS, CONVERSATION_CSS, botOwnCss, installStyles, installCompiledStyles } from './src/client/styles.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// DS Bot's style tags in a document, all of them or those of one group.
const tagged = (document, tag) => [...document.head.querySelectorAll('style')]
  .filter(style => style.dataset.dshBot !== undefined && (tag === undefined || style.dataset.dshBot === tag))

// The client-modules bundle registers itself through the page's __ModuleLoader__
// facade when it loads; capture that registration once to reach its exports.
const clientModules = await (async () => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  let registration
  const previousWindow = globalThis.window
  globalThis.window = window
  window.__ModuleLoader__ = { load: (record) => { registration = record } }
  try {
    await import('@deepseek-ai/dsh-client-modules/client')
  } finally {
    globalThis.window = previousWindow
  }
  return registration.factory((spec) => { throw new Error(`no seed module ${spec}`) })
})()
const { createClientModuleSystem, parseBootManifest } = clientModules

test('message bodies skip offscreen content without containing overflowing tools', () => {
  const { window, module } = bench([])
  const style = window.document.createElement('style')
  style.textContent = module.exports.CONVERSATION_CSS
  window.document.head.appendChild(style)
  const rule = [...style.sheet.cssRules].find(rule => rule.selectorText === '.bt-bubble,.bt-ububble')
  assert.ok(rule)
  assert.equal(rule.style.getPropertyValue('content-visibility'), 'auto')
  assert.equal(rule.style.getPropertyValue('contain-intrinsic-size'), 'auto 160px')
  const row = window.document.createElement('div')
  row.dataset.chatFlowKind = 'assistant-step'
  row.innerHTML = '<div class="bt-msg"><div class="bt-msg-line"><div class="bt-lead"></div><div class="bt-bubble"></div><div class="bt-tools"><button></button></div></div><div class="bt-reacts"></div></div>'
  assert.ok(row.querySelector('.bt-bubble').matches(rule.selectorText))
  for (const node of [row, ...row.querySelectorAll(':not(.bt-bubble)')]) {
    assert.equal(node.matches(rule.selectorText), false)
  }
  const user = window.document.createElement('div')
  user.className = 'bt-ububble'
  assert.ok(user.matches(rule.selectorText))
  assert.equal([...style.sheet.cssRules].some(rule => rule.selectorText === '[data-chat-flow-kind]'), false)
})

// A fresh jsdom document, the bundled style helpers bound to it, and a real
// ClientModuleSystem that materializes the pretend modules named in `rows`.
const bench = (rows) => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: window.document,
    MutationObserver: window.MutationObserver,
    HTMLLinkElement: window.HTMLLinkElement,
    setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : {}),
  })
  // The client module system reads the page's globals when it claims and removes.
  const previousGlobals = { window: globalThis.window, document: globalThis.document }
  const inside = (fn) => {
    globalThis.window = window
    globalThis.document = window.document
    try { return fn() } finally { globalThis.window = previousGlobals.window; globalThis.document = previousGlobals.document }
  }
  const boot = (rev) => ({
    rev,
    entries: rows.map(id => ({ id, url: `/modules/${id}.js?rev=${rev}`, rev })),
    batches: rows.length ? [{ phase: 'application', url: `/boot.js?rev=${rev}`, rev, entries: [...rows] }] : [],
  })
  // A bench with no modules never builds the system; the helpers stay undefined.
  const system = rows.length === 0 ? undefined : inside(() => {
    window.__ModuleLoader__ = { mode: 'queue', pendingQueue: [], load() {} }
    return createClientModuleSystem(window.__ModuleLoader__, { id: 'shell', exports: {} }, {
      boot: boot('r1'),
      staticModules: {},
    })
  })
  const materialize = id => inside(() => system.materialize(id))
  const update = (rev, managed = new Map()) => inside(() => system.updateManifest(parseBootManifest(boot(rev)), managed))
  const register = (id, factory) => inside(() => window.__ModuleLoader__.load({ id, factory }))
  return { window, module, materialize, register, update }
}

// #228: our style tags carry the client module id, so another module's materialization
// cannot claim them and its teardown cannot delete them.
test('every DS Bot style is owned by the ds-bot client module', async () => {
  const { window, module, register, materialize, update } = bench(['other'])
  const { installStyles, installCompiledStyles } = module.exports
  const { document } = window
  register('other', () => ({}))

  const plain = installStyles('a{color:red}', 'mentions')
  installCompiledStyles('.b{position:fixed}', 'shell')
  const [compiled] = tagged(document, 'shell')
  const stray = document.createElement('style')
  stray.textContent = 'stray{}'
  document.head.appendChild(stray)
  for (const style of [plain, compiled]) {
    assert.equal(style.dataset.dshBot !== undefined, true)
    assert.equal(style.dataset.plugin, 'ds-bot')
    assert.equal(style.matches('style:not([data-plugin])'), false)
  }

  // Another module materializing claims untagged styles (DSH 0.2.0-rc.2 does; other
  // versions may not); ours keep their owner either way.
  materialize('other')
  const claimed = stray.dataset.plugin === 'other'
  assert.equal(plain.dataset.plugin, 'ds-bot')
  assert.equal(compiled.dataset.plugin, 'ds-bot')

  // A newer revision of that module replaces it: what it claimed goes, ours stay.
  update('r2')
  await tick()
  if (claimed) assert.equal(stray.isConnected, false)
  assert.equal(plain.isConnected, true)
  assert.equal(compiled.isConnected, true)
})

test('a compiled style removed from outside comes back, until its cleanup runs', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
  const [style] = tagged(document, 'shell')
  assert.ok(style.isConnected)

  style.remove()
  await tick()
  assert.equal(style.isConnected, true, 'the observer puts a removed node back')

  dispose()
  await tick()
  assert.equal(style.isConnected, false)
  // Later page changes cannot resurrect it.
  const late = document.createElement('style')
  document.head.appendChild(late)
  await tick()
  assert.equal(style.isConnected, false)
})

test('mounting and unmounting compiled styles twice leaves no extra nodes', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  for (let round = 0; round < 2; round += 1) {
    const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
    await tick()
    dispose()
  }
  await tick()
  assert.equal(tagged(document).length, 0)
})

test('the chat-room rule is installed through installStyles, so it is owned too', () => {
  const pane = readFileSync(new URL('../src/client/frame-watch.js', import.meta.url), 'utf8')
  assert.match(pane, /installStyles\(.*'chat-room'/)
  assert.equal(pane.includes("dataset.dshBot = 'chat-room'"), false)
})

test('message tools anchor to the bottom of a long reply in both layouts', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;/)
  // Flat: the toolbar hangs below the whole message instead of over its last line.
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg\{position:relative\}/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg-line\{position:static\}/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-tools\{top:100%;bottom:auto;/)
  assert.doesNotMatch(css, /body\[data-bt-layout=flat\] \.bt-tools\{bottom:-14px;/)
  assert.doesNotMatch(css, /\.bt-tools\{position:absolute;top:50%;/)
})

test('the tools toolbar keeps its own stacking context for the hover bridge', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // Without a stacking context on .bt-tools, the ::after bridge's z-index:-1
  // sinks behind the full-width .bt-astack and the toolbar flickers when the
  // pointer crosses the gap.
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;z-index:0;/)
  assert.match(css, /\.bt-tools::after\{[^}]*z-index:-1/)
})

test('the flat toolbar hangs below reactions instead of covering them', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg\{position:relative\}/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg-line\{position:static\}/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-tools\{top:100%;/)
  assert.doesNotMatch(css, /body\[data-bt-layout=flat\] \.bt-msg:has\(>\.bt-reacts\) \.bt-tools\{bottom:0\}/)
})

test('on touch, the message toolbar sits below the message and is shorter', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const touch = css.slice(css.indexOf('@media (hover:none)'), css.indexOf('.bt-mic-note'))
  // A touch tap opens the toolbar, so it must not sit over the bubble it belongs to.
  assert.match(touch, /\.bt-msg\{position:relative\}/)
  assert.match(touch, /\.bt-msg-line\{position:static\}/)
  assert.match(touch, /\.bt-tools\{top:100%;bottom:auto;/)
  assert.match(touch, /\.bt-tool\{width:36px;height:36px\}/)
  assert.doesNotMatch(touch, /\.bt-tool\{width:44px;height:44px\}/)
  // The open pill is 36px plus a 4px gap; reserve it so the next message's text stays clear.
  assert.match(touch, /\.bt-msg:has\(>\.bt-msg-line>\.bt-tools\[data-open\]\)\{margin-bottom:40px\}/)
})

test('an active message toolbar stacks above the next message', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // Later .bt-msg siblings are position:relative in the flat layout and on touch,
  // so without a z-index they paint over a toolbar that hangs below this message.
  assert.match(css, /\.bt-msg:hover,\.bt-msg:focus-within,\.bt-msg:has\(>\.bt-msg-line>\.bt-tools\[data-open\]\)\{z-index:2\}/)
})

// #1571: on macOS the side panel and the body-level browser layer are body children that
// DSH marks no-drag. The browser layer must stay neutral (and 0x0 in bot-browsers.js) so
// it never punches a full-window no-drag hole over the title bar; inside the panel, the
// top drag strip (.bt-ptabs or, without a strip, .bt-drawer-top / .bt-subhead) drags the
// window while interactive controls inside it stay clickable (no-drag).
test('a macOS side panel neutralizes .bt-browser-layer and keeps a top drag row with clickable controls', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /html\[data-platform=darwin\] \.bt-browser-layer\{-webkit-app-region:initial\}/)
  const dragRule = /(html\[data-platform=darwin\] \.bt-panel>\[data-window-drag\],html\[data-platform=darwin\] \.bt-panel>\.bt-panel-view>\[data-window-drag\])\{([^}]*)\}/.exec(css)
  assert.ok(dragRule, 'the macOS panel drag-row rule exists')
  assert.match(dragRule[2], /-webkit-app-region:drag/)
  const noDragRule = /(html\[data-platform=darwin\] \.bt-panel \[data-window-drag\] :is\([^)]+\))\{([^}]*)\}/.exec(css)
  assert.ok(noDragRule, 'controls inside the drag row stay no-drag')
  assert.match(noDragRule[2], /-webkit-app-region:no-drag/)

  const { window } = new JSDOM('<!doctype html><html data-platform="darwin"><body><div class="bt-browser-layer"></div><aside class="bt-panel"><div class="bt-ptabs" data-window-drag="true"><div class="bt-ptabs-in"><button class="bt-ptab" role="tab">Tab</button></div></div><div class="bt-panel-view"><div class="bt-drawer-top" data-window-drag="true"><button class="bt-round">Settings</button></div><div class="bt-subhead" data-window-drag="true"><button class="bt-icon-btn">Back</button></div></div></aside></body></html>')
  const { document } = window
  assert.equal(document.querySelector('.bt-ptabs').matches(dragRule[1]), true)
  assert.equal(document.querySelector('.bt-drawer-top').matches(dragRule[1]), true)
  assert.equal(document.querySelector('.bt-subhead').matches(dragRule[1]), true)
  assert.equal(document.querySelector('.bt-panel').matches(dragRule[1]), false)
  assert.equal(document.querySelector('.bt-ptab').matches(noDragRule[1]), true)
  assert.equal(document.querySelector('.bt-round').matches(noDragRule[1]), true)
  assert.equal(document.querySelector('.bt-icon-btn').matches(noDragRule[1]), true)
  assert.doesNotMatch(css, /html\[data-platform=darwin\] \.bt-panel\{[^}]*-webkit-app-region:drag/)
})

// #1571: both the tab strip and the strip-less drawer top rows carry the shell's drag mark.
test('the panel strip and strip-less drawer top rows carry the shell window drag mark', () => {
  const pane = readFileSync(new URL('../src/client/browser-pane.js', import.meta.url), 'utf8')
  const drawer = readFileSync(new URL('../src/client/details-drawer.js', import.meta.url), 'utf8')
  assert.match(pane, /className: 'bt-ptabs'[^}]*'data-window-drag': true/)
  assert.match(drawer, /className: 'bt-drawer-top'[^}]*'data-window-drag': !hasStrip \|\| undefined/)
  assert.match(drawer, /className: 'bt-subhead'[^}]*'data-window-drag': !hasStrip \|\| undefined/)
})

test('dsh-mobile conversation header is opaque and catches hits without altering desktop', () => {
  const { window, module } = bench([])
  const { CONVERSATION_CSS, botOwnCss, installCompiledStyles } = module.exports
  const { document } = window
  const hostSheet = document.createElement('style')
  hostSheet.textContent = '.wSkVaW_header{display:grid;border-bottom:.5px solid rgba(0,0,0,.1)}'
  document.head.appendChild(hostSheet)

  const dispose = installCompiledStyles(CONVERSATION_CSS, 'conversation')
  try {
    const [compiled] = tagged(document, 'conversation')
    const text = compiled.textContent
    // Desktop floating header keeps its transparent canvas, click-through hit policy, and ::before fade.
    assert.match(text, /header:is\(\.wSkVaW_header\):has\(\.bt-head\)\{[^}]*background:transparent!important;pointer-events:none/)
    assert.match(text, /header:is\(\.wSkVaW_header\):has\(\.bt-head\)::before\{[^}]*background:linear-gradient/)

    // When dsh-mobile is active, both html.dsh-native-mobile-active and [data-dsh-mobile-header]
    // override the transparent floating strip with an opaque --bt-main surface and pointer-events:auto.
    assert.match(
      text,
      /html\.dsh-native-mobile-active header:is\(\.wSkVaW_header\):has\(\.bt-head\),header:is\(\.wSkVaW_header\)\[data-dsh-mobile-header\]:has\(\.bt-head\)\{[^}]*background:var\(--bt-main\)!important;pointer-events:auto/,
    )
    assert.match(
      text,
      /html\.dsh-native-mobile-active header:is\(\.wSkVaW_header\):has\(\.bt-head\)::before,header:is\(\.wSkVaW_header\)\[data-dsh-mobile-header\]:has\(\.bt-head\)::before\{content:none\}/,
    )
    // Leading header button stays stacked above .bt-head and clickable: .bt-head must NOT
    // receive pointer-events:auto on mobile, or it covers the earlier _headerLeading in DOM order.
    assert.match(
      text,
      /header:is\(\.wSkVaW_header\):has\(\.bt-head\)>\[class\*="_headerLeading"\]\{[^}]*z-index:1;pointer-events:auto/,
    )
    assert.doesNotMatch(
      text,
      /dsh-(?:native-mobile-active|mobile-header)[^}]*\.bt-head\{[^}]*pointer-events:auto/,
    )

    // Host header rules stay excluded from botOwnCss so Agent mode never inherits them.
    assert.equal(botOwnCss(CONVERSATION_CSS).includes('dsh-native-mobile-active'), false)
    assert.equal(botOwnCss(CONVERSATION_CSS).includes('data-dsh-mobile-header'), false)
  } finally {
    dispose()
  }
})

test('trigger menu descriptions stay beside their row labels', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\[data-trigger-menu\] \[role=option\]>span\{text-align:left\}/)
})

test('send and voice buttons tint background-color on hover, matching their transition', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const send = '[data-composer-card] button[class*="_primary"]'
  for (const selector of [`${send}:hover:not(:disabled)`, '.bt-voice:hover']) {
    const start = css.indexOf(`${selector}{`)
    assert.ok(start >= 0, `${selector} rule exists`)
    const body = css.slice(start + selector.length + 1, css.indexOf('}', start))
    assert.match(body, /(^|;)background-color:color-mix\(in srgb,var\(--bt-accent\) 90%,transparent\)/)
    assert.doesNotMatch(body, /(^|;)background:/)
    assert.doesNotMatch(body, /opacity/)
  }
  // The transition lists the property the hover changes, so the tint animates.
  assert.match(css, /_primary"\]\{[^}]*transition:background-color \.15s ease/)
  assert.match(css, /\.bt-voice\{[^}]*;transition:background-color \.15s ease|\.bt-mic,\.bt-voice\{[^}]*transition:background-color \.15s ease/)
})
