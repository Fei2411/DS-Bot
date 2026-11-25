import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const stubs = {
  'cells.js': 'export const workPhrase = () => ""\n',
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'ui-api.js': 'export const openFeed = () => () => {}\n',
}

const entryCode = `
  export { createTeam } from './ui/src/team.js'
  export { matchGlobalShortcut } from './ui/src/shortcuts.js'
  export { paintMode } from './ui/src/mode.js'
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
    name: 'team-browser-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /(src\/client\/(cells|api)|ui\/src\/api)\.js$|^\.\/(cells|api)\.js$/ }, (args) => {
        const dir = args.resolveDir.replace(/\\/g, '/')
        if (args.path === './api.js' && dir.endsWith('/app/ui/src')) {
          return { path: 'ui-api.js', namespace: 'tb-stub' }
        }
        if ((args.path === './cells.js' || args.path === './api.js') && dir.endsWith('/ds-bot/src/client')) {
          return { path: args.path.slice(2), namespace: 'tb-stub' }
        }
        if (args.path.endsWith('/ds-bot/src/client/cells.js')) return { path: 'cells.js', namespace: 'tb-stub' }
        if (args.path.endsWith('/ds-bot/src/client/api.js')) return { path: 'api.js', namespace: 'tb-stub' }
        if (args.path.endsWith('/app/ui/src/api.js')) return { path: 'ui-api.js', namespace: 'tb-stub' }
        return null
      })
      bundler.onLoad({ filter: /.*/, namespace: 'tb-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = v => JSON.parse(JSON.stringify(v))

function createHarness() {
  const storageMap = new Map()
  let current
  const slot = (make) => {
    const bucket = current.fiber
    const index = bucket.index++
    return bucket.slots[index] ??= make()
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: initial => slot(() => ({ current: initial })),
    useEffect() {},
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

  const bodyAttrs = new Set()
  const mediaListeners = new Set()
  const mediaQuery = {
    matches: false,
    addEventListener(name, fn) { if (name === 'change') mediaListeners.add(fn) },
    removeEventListener(name, fn) { if (name === 'change') mediaListeners.delete(fn) },
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    __testCall: async () => ({}),
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      throw new Error(`unexpected require ${name}`)
    },
    AbortController,
    URL,
    crypto: globalThis.crypto,
    matchMedia: () => mediaQuery,
    localStorage: {
      getItem: key => storageMap.get(key) ?? null,
      setItem: (key, value) => { storageMap.set(key, String(value)) },
      removeItem: key => { storageMap.delete(key) },
    },
    window: { addEventListener() {}, removeEventListener() {} },
    document: {
      activeElement: null,
      documentElement: { dataset: {} },
      body: {
        append() {},
        toggleAttribute(name, force) {
          const on = force === undefined ? !bodyAttrs.has(name) : Boolean(force)
          if (on) bodyAttrs.add(name)
          else bodyAttrs.delete(name)
          return on
        },
        hasAttribute: name => bodyAttrs.has(name),
      },
      createElement: () => ({ style: {}, dataset: {}, remove() {} }),
    },
    navigator: { language: 'en', platform: 'Linux' },
    console: { error() {}, warn() {}, log() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  }
  sandbox.globalThis = sandbox
  runInNewContext(outputFiles[0].text, sandbox)

  const readHook = (hook, selector = v => v) => {
    const inst = { fiber: { slots: [], index: 0 } }
    current = inst
    try {
      return hook(selector)
    } finally {
      current = undefined
      for (const cell of inst.fiber.slots) cell?.stop?.()
    }
  }

  const fireColorScheme = (isDark) => {
    mediaQuery.matches = isDark
    for (const fn of Array.from(mediaListeners)) fn({ matches: isDark })
  }

  return { sandbox, exports: mod.exports, readHook, storageMap, fireColorScheme }
}

function createMockBridge() {
  const log = []
  const listeners = new Set()
  const viewsState = new Map()
  let unsubscribed = 0
  const emit = (change) => {
    for (const listener of Array.from(listeners)) listener(change)
  }
  const bridge = {
    log,
    emit,
    get listenerCount() { return listeners.size },
    get unsubscribed() { return unsubscribed },
    forget: async (key) => { log.push(['forget', key]) },
    views: {
      create: async (botId, tabId, url) => {
        log.push(['create', botId, tabId, url])
        viewsState.set(tabId, { botId, tabId, url: url || '', title: '', loading: false, canGoBack: false, canGoForward: false })
      },
      sync: async (botId) => {
        log.push(['sync', botId])
        return [...viewsState.values()].filter(v => v.botId === botId)
      },
      place: async (tabId, rect, visible) => { log.push(['place', tabId, rect, visible]) },
      navigate: async (botId, tabId, url) => {
        log.push(['navigate', botId, tabId, url])
        const next = { botId, tabId, url, title: `Title:${url}`, loading: false, canGoBack: true, canGoForward: false }
        viewsState.set(tabId, next)
        emit({ type: 'updated', ...next })
      },
      command: async (botId, tabId, cmd) => { log.push(['command', botId, tabId, cmd]) },
      focus: async (botId, tabId) => { log.push(['focus', botId, tabId]) },
      read: async (botId, tabId, script) => {
        log.push(['read', botId, tabId, typeof script === 'string' && script.length > 0])
        return { url: viewsState.get(tabId)?.url ?? '', title: viewsState.get(tabId)?.title ?? '', text: 'Page body' }
      },
      close: async (botId, tabId) => {
        log.push(['close', botId, tabId])
        viewsState.delete(tabId)
      },
      hold: async (botId, held) => { log.push(['hold', botId, held]) },
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribed += 1
        }
      },
    },
    importSources: async () => [{ id: 'chrome', name: 'Chrome' }],
    importProbe: async source => ({ source, ok: true }),
    importPick: async () => ({ id: 'pick-1' }),
    importPaste: async (text, url) => ({ text, url }),
    importLaunch: async source => ({ launched: source }),
    importLive: async (source, close, reqId) => ({ source, close, reqId }),
    importApply: async (key, pending, options) => ({ key, pending, options }),
    importCancel: async pending => ({ cancelled: pending }),
  }
  return bridge
}

test('createTeam leaves browser actions undefined when no desktop bridge is present', () => {
  const { exports, readHook } = createHarness()
  const team = exports.createTeam()
  assert.equal(team.actions.openBrowser, undefined)
  assert.equal(team.actions.browserNewTab, undefined)
  assert.equal(team.actions.browserPick, undefined)
  assert.equal(team.actions.browserShow, undefined)
  assert.equal(team.actions.browserImport, undefined)
  assert.deepEqual(plain(readHook(team.hooks.useBrowserTabs)), {})
  assert.deepEqual(plain(readHook(team.hooks.useBrowserPages)), {})
  assert.deepEqual(plain(readHook(team.hooks.useBrowserHolds)), {})
})

test('createTeam wires Bot Browser actions, unified right sidebar coexistence, serveBrowserReads, retain, and clean dispose', async () => {
  const { sandbox, exports, readHook } = createHarness()
  const bridge = createMockBridge()
  sandbox.dsBotApp = { browser: bridge }

  let rosterRevision = 1
  let browserEnabled = true
  let botsList = [
    { id: 'b1', name: 'Alpha', sessions: ['b1'] },
    { id: 'b2', name: 'Beta', sessions: ['b2'] },
  ]
  const hostCalls = []
  let waitCount = 0
  let abortedWait = false
  let releaseWait = null

  sandbox.__testCall = async (endpoint, body, signal) => {
    hostCalls.push([endpoint, body])
    if (endpoint === 'state') {
      return {
        revision: rosterRevision,
        modelsKey: 'm1',
        browser: browserEnabled,
        mainBotId: 'b1',
        bots: botsList,
        rooms: [],
        agents: [],
        sideChats: { b1: [{ id: 'sc1', entries: [{ question: 'Side Q' }] }] },
      }
    }
    if (endpoint === 'update-check') return { available: false, phase: 'idle' }
    if (endpoint === 'browser-wait') {
      waitCount += 1
      if (waitCount === 1) {
        return { holds: { b1: { reason: 'login' } }, requests: [{ id: 'req-1', botId: 'b1' }] }
      }
      return new Promise((resolve, reject) => {
        releaseWait = resolve
        signal?.addEventListener('abort', () => {
          abortedWait = true
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
    if (endpoint === 'browser-result') return { ok: true }
    if (endpoint === 'browser-takeover' || endpoint === 'browser-stop' || endpoint === 'browser-give-back') return { ok: true }
    return {}
  }

  const team = exports.createTeam()
  // All browser actions must be attached when dsBotApp.browser exists.
  for (const name of [
    'openBrowser', 'browserNewTab', 'browserPick', 'browserEnsure', 'browserCloseTab',
    'browserActivate', 'browserShow', 'browserNavigate', 'browserCommand', 'browserFocus',
    'browserTakeover', 'browserStop', 'browserGiveBack', 'browserImport',
  ]) {
    assert.ok(team.actions[name], `expected action ${name} to be defined`)
  }

  const stop = team.start()
  try {
    await tick()
    await tick()

    // Open Bot b1 with Files + Terminal + Side chat already open in the unified right sidebar.
    team.actions.openSession('b1')
    team.actions.openFiles()
    team.actions.newTerminal()
    team.actions.openSideChat('b1', 'sc1')

    // Opening browser keeps rightPanel (Files + Terminal) and side chat intact.
    team.actions.openBrowser('b1')
    let ui = readHook(team.hooks.useUi)
    assert.equal(ui.details, 'b1')
    assert.equal(ui.view, 'browser')
    assert.equal(ui.side, 'sc1')
    assert.deepEqual(plain(ui.rightPanel.tabs), ['files', 'terminal'], 'openBrowser must preserve workspace tabs')

    let tabs = readHook(team.hooks.useBrowserTabs)
    assert.equal(tabs.b1.ids.length, 1)
    const tab1 = tabs.b1.active

    // Opening a second browser tab and picking back to the first preserves workspace tabs.
    const tab2 = team.actions.browserNewTab('b1')
    assert.ok(tab2 && tab2 !== tab1)
    tabs = readHook(team.hooks.useBrowserTabs)
    assert.deepEqual(plain(tabs.b1.ids), [tab1, tab2])
    assert.equal(tabs.b1.active, tab2)
    assert.deepEqual(plain(readHook(team.hooks.useUi).rightPanel.tabs), ['files', 'terminal'], 'browserNewTab preserves workspace tabs')

    team.actions.browserPick('b1', tab1)
    assert.equal(readHook(team.hooks.useBrowserTabs).b1.active, tab1)
    assert.deepEqual(plain(readHook(team.hooks.useUi).rightPanel.tabs), ['files', 'terminal'], 'browserPick preserves workspace tabs')

    // Navigate, show, command, and focus forward cleanly to bridge.views.
    const box = { left: 600, top: 88, width: 520, height: 640 }
    await team.actions.browserShow(tab1, box)
    assert.equal(await team.actions.browserNavigate(tab1, 'https://example.com'), true)
    await tick()
    const pages = readHook(team.hooks.useBrowserPages)
    assert.equal(pages[tab1].url, 'https://example.com/')
    team.actions.browserCommand(tab1, 'reload')
    team.actions.browserFocus(tab1)
    assert.equal(bridge.log.some(([op, botId, tId, cmd]) => op === 'command' && botId === 'b1' && tId === tab1 && cmd === 'reload'), true)
    assert.equal(bridge.log.some(([op, botId, tId]) => op === 'focus' && botId === 'b1' && tId === tab1), true)

    // serveBrowserReads answered the host request and propagated browserHolds into useBrowserHolds.
    assert.equal(hostCalls.some(([ep]) => ep === 'browser-wait'), true)
    assert.equal(hostCalls.some(([ep, b]) => ep === 'browser-result' && b.id === 'req-1'), true)
    assert.deepEqual(plain(readHook(team.hooks.useBrowserHolds)), { b1: { reason: 'login' } })

    // Takeover / stop / give-back call host endpoints and bridge.views.hold.
    await team.actions.browserTakeover('b1')
    await team.actions.browserStop('b1')
    await team.actions.browserGiveBack('b1', { callId: 'c1', outcome: 'done' })
    assert.equal(bridge.log.some(([op, botId, held]) => op === 'hold' && botId === 'b1' && held === true), true)
    assert.equal(bridge.log.some(([op, botId, held]) => op === 'hold' && botId === 'b1' && held === false), true)
    assert.equal(hostCalls.some(([ep, b]) => ep === 'browser-give-back' && b.botId === 'b1' && b.callId === 'c1'), true)

    // Cookie import bridge wraps bot storage key (`bot:<id>`).
    assert.deepEqual(plain(await team.actions.browserImport.sources()), [{ id: 'chrome', name: 'Chrome' }])
    assert.deepEqual(
      plain(await team.actions.browserImport.apply('b1', 'pend-1', { domains: ['example.com'] })),
      { key: 'bot:b1', pending: 'pend-1', options: { domains: ['example.com'] } },
    )

    // Closing one of two browser tabs stays in 'browser' view on the remaining tab.
    await team.actions.browserCloseTab('b1', tab1)
    assert.equal(readHook(team.hooks.useUi).view, 'browser')
    assert.equal(readHook(team.hooks.useBrowserTabs).b1.active, tab2)

    // Closing the last browser tab while workspace tabs are open falls back to 'workspace'!
    await team.actions.browserCloseTab('b1', tab2)
    ui = readHook(team.hooks.useUi)
    assert.equal(ui.view, 'workspace', 'closing last browser tab falls back to open workspace tabs')
    assert.deepEqual(plain(ui.rightPanel.tabs), ['files', 'terminal'])

    // Reopen browser tab, clear side chat, then close all workspace tabs -> falls back to 'browser'!
    const tab3 = team.actions.browserNewTab('b1')
    team.actions.setRightPanelTab('files')
    // Close side chat reference by reopening panel without side chat:
    team.actions.closePanel()
    team.actions.openFiles()
    team.actions.browserPick('b1', tab3)
    team.actions.setRightPanelTab('files')
    team.actions.closeWorkspaceTab('files')
    ui = readHook(team.hooks.useUi)
    assert.equal(ui.rightPanel, null)
    assert.equal(ui.view, 'browser', 'closing last workspace tab falls back to open browser tab when no side chat is active')

    // Closing last browser tab with an active side chat and no workspace falls back to 'side'.
    team.actions.openSideChat('b1', 'sc1')
    team.actions.browserPick('b1', tab3)
    await team.actions.browserCloseTab('b1', tab3)
    ui = readHook(team.hooks.useUi)
    assert.equal(ui.view, 'side', 'closing last browser tab with no workspace falls back to active side chat')

    // Closing last browser tab with neither workspace nor side chat falls back to 'details'.
    team.actions.closePanel()
    const tab4 = team.actions.browserNewTab('b1')
    await team.actions.browserCloseTab('b1', tab4)
    ui = readHook(team.hooks.useUi)
    assert.equal(ui.view, 'details', 'closing last browser tab with no workspace or side chat falls back to details')

    // Roster update removing bot b2 triggers browsers.retain -> bridge.forget('bot:b2').
    team.actions.openBrowser('b2')
    team.actions.openBrowser('b1')
    team.actions.openFiles()
    team.actions.openBrowser('b1')
    botsList = [{ id: 'b1', name: 'Alpha', sessions: ['b1'] }]
    rosterRevision = 2
    await team.actions.refreshLocale()
    await tick()
    assert.equal(bridge.log.some(([op, key]) => op === 'forget' && key === 'bot:b2'), true, 'deleted bot storage is forgotten via retain')

    // When roster disables browser (`browser: false`) while on browser view, falls back to workspace if open.
    browserEnabled = false
    rosterRevision = 3
    await team.actions.refreshLocale()
    await tick()
    ui = readHook(team.hooks.useUi)
    assert.equal(ui.view, 'workspace', 'disabling browser falls back from browser view to workspace when tabs are open')

    // Re-enable browser, drop workspace, then disable browser -> falls back to details.
    browserEnabled = true
    rosterRevision = 4
    await team.actions.refreshLocale()
    team.actions.closeWorkspaceTab('files')
    assert.equal(readHook(team.hooks.useUi).view, 'browser')
    browserEnabled = false
    rosterRevision = 5
    await team.actions.refreshLocale()
    assert.equal(readHook(team.hooks.useUi).view, 'details', 'disabling browser falls back to details when no workspace is open')
  } finally {
    stop()
    releaseWait?.({})
  }

  // Cleanup disposed browsers and unsubscribed bridge view listener.
  assert.equal(bridge.listenerCount, 0, 'dispose unsubscribes bridge.views listener')
  assert.equal(bridge.unsubscribed >= 1, true)
  assert.equal(abortedWait, true, 'dispose aborts in-flight serveBrowserReads poll')
})

test('createTeam prefers dshDesktop protocol v1 browser bridge over dsBotApp.browser', () => {
  const { sandbox, exports } = createHarness()
  const dshBridge = createMockBridge()
  const appBridge = createMockBridge()
  sandbox.dshDesktop = { protocolVersion: 1, browser: dshBridge }
  sandbox.dsBotApp = { browser: appBridge }

  const team = exports.createTeam()
  assert.equal(dshBridge.listenerCount, 1, 'dshDesktop protocol v1 bridge is bound')
  assert.equal(appBridge.listenerCount, 0, 'dsBotApp bridge is untouched when dshDesktop v1 is present')
  assert.ok(team.actions.openBrowser)
})

test('matchGlobalShortcut passes Ctrl combos through to focused .xterm on non-Mac while keeping macOS Cmd shortcuts intact', () => {
  const { sandbox, exports } = createHarness()
  const { matchGlobalShortcut } = exports
  const xtermTarget = { closest: selector => (selector === '.xterm' ? { className: 'xterm' } : null) }
  const chatTarget = { closest: () => null }

  // Non-Mac inside `.xterm`: Ctrl+<key> passes through to PTY (returns null).
  for (const [key, code] of [
    ['k', 'KeyK'],
    [',', 'Comma'],
    ['n', 'KeyN'],
    ['\\', 'Backslash'],
    ['/', 'Slash'],
    ['c', 'KeyC'],
    ['d', 'KeyD'],
    ['l', 'KeyL'],
    ['r', 'KeyR'],
  ]) {
    assert.equal(
      matchGlobalShortcut({ ctrlKey: true, key, code, target: xtermTarget }, { mac: false }),
      null,
      `non-Mac Ctrl+${key} inside .xterm must pass through`,
    )
  }

  // Synthetic window event (target without `.closest`) while document.activeElement is inside `.xterm`.
  sandbox.document.activeElement = xtermTarget
  try {
    assert.equal(matchGlobalShortcut({ ctrlKey: true, key: 'k', code: 'KeyK', target: {} }, { mac: false }), null)
  } finally {
    sandbox.document.activeElement = null
  }

  // Non-Mac outside `.xterm`: Ctrl global shortcuts still fire normally.
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: 'k', code: 'KeyK', target: chatTarget }, { mac: false }), 'palette')
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: ',', code: 'Comma', target: chatTarget }, { mac: false }), 'settings')
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: 'n', code: 'KeyN', target: chatTarget }, { mac: false }), 'new-chat')
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: '\\', code: 'Backslash', target: chatTarget }, { mac: false }), 'sidebar')
  assert.equal(matchGlobalShortcut({ ctrlKey: true, key: '/', code: 'Slash', target: chatTarget }, { mac: false }), 'shortcuts')

  // macOS inside `.xterm`: Cmd shortcuts stay intact while Ctrl combos pass through.
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'k', code: 'KeyK', target: xtermTarget }, { mac: true }), 'palette')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: ',', code: 'Comma', target: xtermTarget }, { mac: true }), 'settings')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: 'n', code: 'KeyN', target: xtermTarget }, { mac: true }), 'new-chat')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: '\\', code: 'Backslash', target: xtermTarget }, { mac: true }), 'sidebar')
  assert.equal(matchGlobalShortcut({ metaKey: true, key: '/', code: 'Slash', target: xtermTarget }, { mac: true }), 'shortcuts')
  for (const [key, code] of [['c', 'KeyC'], ['d', 'KeyD'], ['l', 'KeyL'], ['r', 'KeyR'], ['k', 'KeyK']]) {
    assert.equal(
      matchGlobalShortcut({ ctrlKey: true, key, code, target: xtermTarget }, { mac: true }),
      null,
      `macOS Ctrl+${key} inside .xterm passes straight to PTY`,
    )
  }
})

test('paintMode syncs data-ds-dark-theme and html[data-ds-theme-source] for Electron nativeTheme', () => {
  const { sandbox, exports, fireColorScheme } = createHarness()
  const { paintMode } = exports

  // Explicit light mode: dark attribute off, themeSource = 'light'.
  paintMode('light')
  assert.equal(sandbox.document.body.hasAttribute('data-ds-dark-theme'), false)
  assert.equal(sandbox.document.documentElement.dataset.dsThemeSource, 'light')

  // Explicit dark mode: dark attribute on, themeSource = 'dark'.
  paintMode('dark')
  assert.equal(sandbox.document.body.hasAttribute('data-ds-dark-theme'), true)
  assert.equal(sandbox.document.documentElement.dataset.dsThemeSource, 'dark')

  // Undefined follows system preference and marks themeSource = 'system'.
  paintMode(undefined)
  assert.equal(sandbox.document.body.hasAttribute('data-ds-dark-theme'), false)
  assert.equal(sandbox.document.documentElement.dataset.dsThemeSource, 'system')

  fireColorScheme(true)
  assert.equal(sandbox.document.body.hasAttribute('data-ds-dark-theme'), true)
  assert.equal(sandbox.document.documentElement.dataset.dsThemeSource, 'system')

  fireColorScheme(false)
  assert.equal(sandbox.document.body.hasAttribute('data-ds-dark-theme'), false)
  assert.equal(sandbox.document.documentElement.dataset.dsThemeSource, 'system')

  // Electron material CSS, preload Mica lookup, and CSP allow unified .bt-panel and loopback favicons.
  const materialCss = readFileSync(fileURLToPath(new URL('../src/material.css', import.meta.url)), 'utf8')
  const preloadSrc = readFileSync(fileURLToPath(new URL('../src/preload.cjs', import.meta.url)), 'utf8')
  const indexHtml = readFileSync(fileURLToPath(new URL('../ui/index.html', import.meta.url)), 'utf8')
  assert.match(materialCss, /\.bt-panel\s*\{/)
  assert.doesNotMatch(materialCss, /\.dsb-rightbar\b/)
  assert.match(preloadSrc, /querySelector\('\.bt-panel, div\[class\*="_rightbarCol"\]'\)/)
  assert.match(indexHtml, /img-src 'self' data: blob: https: http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/)
})
