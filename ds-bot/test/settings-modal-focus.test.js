import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React, { act } from 'react'
import ReactDOM from 'react-dom'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const req = createRequire(import.meta.url)
const harnessReq = createRequire(join(process.env.DSH_HARNESS ?? join(repoRoot, 'ds-bot', 'dev', 'harness'), 'package.json'))
const { JSDOM } = harnessReq('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { SettingsDialog, settingsOwnsKeyboard } from './src/client/settings.js'
      export { ESCAPE_PRIORITY, useEscape, useModalFocusTrap } from './src/client/overlay-hooks.js'
      export { TOUR_SEEN_KEY } from './src/client/settings-tour.js'
      export { ShortcutsDialog } from '../app/ui/src/shortcuts.js'
    `,
    resolveDir: join(repoRoot, 'ds-bot'),
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const primitivesStub = {
  IconSettingsOutlineMedium: () => null,
}

function loadSettingsModule() {
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', outputFiles[0].text)(mod, mod.exports, (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    return req(id)
  })
  return mod.exports
}

const baseRoster = {
  bots: [{ id: 'chief', name: 'Chief', role: 'Lead', model: 'deepseek/deepseek-chat' }],
  rooms: [],
  models: [{ ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', providerName: 'DeepSeek' }],
  byId: { chief: { id: 'chief', name: 'Chief', role: 'Lead', model: 'deepseek/deepseek-chat' } },
  roomsById: {},
  prefs: { enterToSend: true },
  browser: true,
}

test('SettingsDialog ⌘K ignores repeat holds and never steals focus from a foreground modal dialog', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    KeyboardEvent: globalThis.KeyboardEvent,
    Event: globalThis.Event,
    localStorage: globalThis.localStorage,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  globalThis.Node = dom.window.Node
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.Event = dom.window.Event
  globalThis.localStorage = dom.window.localStorage
  globalThis.getComputedStyle = dom.window.getComputedStyle
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = id => clearTimeout(id)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Prevent SettingsTour from auto-starting during the test.
  dom.window.localStorage.setItem('ds-bot:settings-tour-v1', '1')

  const { createRoot } = await import('react-dom/client')
  const { SettingsDialog, settingsOwnsKeyboard } = loadSettingsModule()
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)

  const actions = {
    openSettings() {},
    closeSettings() {},
    providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
    folders: () => Promise.resolve({ team: '/work' }),
    setPrefs: () => Promise.resolve(),
  }

  function ForegroundShortcutsModal({ open }) {
    const closeBtn = React.useRef(null)
    React.useEffect(() => {
      if (open) closeBtn.current?.focus()
    }, [open])
    if (!open) return null
    return ReactDOM.createPortal(
      React.createElement('div', { className: 'dsb-shortcuts-layer' },
        React.createElement('div', { className: 'dsb-shortcuts', role: 'dialog', 'aria-modal': true, 'aria-label': 'Keyboard shortcuts' },
          React.createElement('button', { ref: closeBtn, type: 'button', className: 'dsb-shortcuts-close' }, 'Close'))),
      dom.window.document.body,
    )
  }

  const renderTree = (shortcutsOpen) => {
    act(() => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(SettingsDialog, {
          page: 'general',
          id: null,
          roster: baseRoster,
          actions,
          useUpdate: sel => sel({}),
        }),
        React.createElement(ForegroundShortcutsModal, { open: shortcutsOpen }),
      ))
    })
  }

  const pressCmdK = (extra = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    })
    act(() => {
      dom.window.dispatchEvent(event)
    })
    return event
  }

  try {
    // 1. SettingsDialog alone: ⌘K opens SettingsPalette and focuses its search input.
    renderTree(false)
    const settingsEl = dom.window.document.querySelector('.bt-settings')
    assert.ok(settingsEl, 'SettingsDialog must be mounted')
    assert.equal(settingsOwnsKeyboard(settingsEl, dom.window.document), true)

    pressCmdK()
    const input = dom.window.document.querySelector('.bt-set-search-input')
    assert.ok(input, '⌘K opens SettingsPalette when Settings owns the top modal layer')
    assert.equal(dom.window.document.activeElement, input)

    // 2. Holding ⌘K (repeat: true) must NOT flicker or close SettingsPalette.
    pressCmdK({ repeat: true })
    assert.ok(dom.window.document.querySelector('.bt-set-search-input'), 'repeat ⌘K must not toggle search closed')

    // 3. Releasing and pressing ⌘K closes SettingsPalette.
    pressCmdK()
    assert.equal(dom.window.document.querySelector('.bt-set-search-input'), null)

    // 4. Mount a foreground modal (ShortcutsDialog) on top of Settings:
    //    ⌘K must NOT open SettingsPalette or steal focus from the foreground modal.
    renderTree(true)
    const closeBtn = dom.window.document.querySelector('.dsb-shortcuts-close')
    assert.ok(closeBtn)
    assert.equal(dom.window.document.activeElement, closeBtn)
    assert.equal(settingsOwnsKeyboard(settingsEl, dom.window.document), false)

    const blocked = pressCmdK()
    assert.equal(blocked.defaultPrevented, false, 'SettingsDialog must not swallow ⌘K when covered by a foreground modal')
    assert.equal(dom.window.document.querySelector('.bt-set-search-input'), null, 'SettingsPalette must stay closed under ShortcutsDialog')
    assert.equal(dom.window.document.activeElement, closeBtn, 'focus must stay on foreground ShortcutsDialog')

    // 5. Repeat ⌘K while covered also stays a no-op.
    pressCmdK({ repeat: true })
    assert.equal(dom.window.document.querySelector('.bt-set-search-input'), null)
    assert.equal(dom.window.document.activeElement, closeBtn)

    // 6. A fading-out modal (data-leaving) does NOT block SettingsDialog once dismissed.
    const leavingLayer = dom.window.document.createElement('div')
    leavingLayer.setAttribute('data-leaving', '')
    const leavingModal = dom.window.document.createElement('div')
    leavingModal.setAttribute('aria-modal', 'true')
    leavingLayer.appendChild(leavingModal)
    dom.window.document.body.appendChild(leavingLayer)

    renderTree(false)
    assert.equal(settingsOwnsKeyboard(settingsEl, dom.window.document), true, 'fading-out modal must not block Settings')
    pressCmdK()
    assert.ok(dom.window.document.querySelector('.bt-set-search-input'), '⌘K works again after foreground modal closes')
    leavingLayer.remove()

    // 7. An open alertdialog (e.g. sign-out confirmation) also blocks Settings ⌘K.
    const alertDialog = dom.window.document.createElement('div')
    alertDialog.setAttribute('role', 'alertdialog')
    dom.window.document.body.appendChild(alertDialog)
    assert.equal(settingsOwnsKeyboard(settingsEl, dom.window.document), false)
    alertDialog.remove()
  } finally {
    act(() => { root.unmount() })
    dom.window.close()
    globalThis.window = prev.window
    globalThis.document = prev.document
    if (prev.navigator) Object.defineProperty(globalThis, 'navigator', prev.navigator)
    else delete globalThis.navigator
    globalThis.HTMLElement = prev.HTMLElement
    globalThis.Element = prev.Element
    globalThis.Node = prev.Node
    globalThis.MutationObserver = prev.MutationObserver
    globalThis.ResizeObserver = prev.ResizeObserver
    globalThis.KeyboardEvent = prev.KeyboardEvent
    globalThis.Event = prev.Event
    globalThis.localStorage = prev.localStorage
    globalThis.getComputedStyle = prev.getComputedStyle
    globalThis.requestAnimationFrame = prev.requestAnimationFrame
    globalThis.cancelAnimationFrame = prev.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT
  }
})

test('Two-phase Escape preserves plugin-mode DSH Modal layering and SettingsTour yields inertness to foreground modals', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    KeyboardEvent: globalThis.KeyboardEvent,
    Event: globalThis.Event,
    localStorage: globalThis.localStorage,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  globalThis.Node = dom.window.Node
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.Event = dom.window.Event
  globalThis.localStorage = dom.window.localStorage
  globalThis.getComputedStyle = dom.window.getComputedStyle
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = id => clearTimeout(id)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const { createRoot } = await import('react-dom/client')
  const { SettingsDialog, ESCAPE_PRIORITY, useEscape } = loadSettingsModule()
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)

  try {
    // 1. Plugin-mode Escape layering against DSH's real `useModalLayer` (bubble listener on `document`).
    const closed = []
    let layers = { settings: true, dshModal: true, selectMenu: true }
    const dshModalListener = (event) => {
      if (!layers.dshModal) return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        layers = { ...layers, dshModal: false }
        closed.push('dsh-modal')
      }
    }
    dom.window.document.addEventListener('keydown', dshModalListener, false)
    function LayerHarness({ state }) {
      useEscape(() => { layers = { ...layers, settings: false }; closed.push('settings') }, state.settings, { priority: ESCAPE_PRIORITY.DIALOG })
      useEscape(() => { layers = { ...layers, selectMenu: false }; closed.push('select-menu') }, state.selectMenu, { priority: ESCAPE_PRIORITY.SELECT_MENU })
      return React.createElement('div', null, 'layers')
    }
    const renderLayers = () => act(() => { root.render(React.createElement(LayerHarness, { state: layers })) })
    const pressEsc = () => act(() => {
      dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    renderLayers()
    // 1st Esc: SelectMenu (document capture) closes BEFORE DSH Modal (document bubble).
    pressEsc()
    renderLayers()
    assert.deepEqual(closed, ['select-menu'])
    assert.equal(layers.dshModal, true, 'DSH Modal must stay open when DS Bot SelectMenu handles Escape')
    assert.equal(layers.settings, true)
    // 2nd Esc: DSH Modal (document bubble) closes BEFORE SettingsDialog (window bubble).
    pressEsc()
    renderLayers()
    assert.deepEqual(closed, ['select-menu', 'dsh-modal'])
    assert.equal(layers.settings, true, 'SettingsDialog must stay open when DSH Modal handles Escape')
    // 3rd Esc: SettingsDialog (window bubble) closes cleanly.
    pressEsc()
    renderLayers()
    assert.deepEqual(closed, ['select-menu', 'dsh-modal', 'settings'])
    dom.window.document.removeEventListener('keydown', dshModalListener, false)

    // 2. SettingsTour auto-starts on first open, inerts background siblings, and YIELDS inertness
    //    when an external foreground modal (e.g. ShortcutsDialog) mounts on document.body!
    const sibling = dom.window.document.createElement('div')
    sibling.id = 'app-shell-bg'
    dom.window.document.body.appendChild(sibling)

    let closeClicks = 0
    const actions = {
      openSettings() {},
      closeSettings() {},
      providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
      folders: () => Promise.resolve({ team: '/work' }),
      setPrefs: () => Promise.resolve(),
    }
    function ForegroundShortcuts({ open }) {
      if (!open) return null
      return ReactDOM.createPortal(
        React.createElement('div', { className: 'dsb-shortcuts-layer' },
          React.createElement('div', { className: 'dsb-shortcuts', role: 'dialog', 'aria-modal': true, 'aria-label': 'Keyboard shortcuts' },
            React.createElement('button', { type: 'button', className: 'dsb-shortcuts-close', onClick: () => { closeClicks += 1 } }, 'Close'))),
        dom.window.document.body,
      )
    }
    const renderTour = (shortcutsOpen) => act(() => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(SettingsDialog, {
          page: 'overview',
          id: null,
          roster: baseRoster,
          actions,
          useUpdate: sel => sel({}),
        }),
        React.createElement(ForegroundShortcuts, { open: shortcutsOpen }),
      ))
    })

    // First open without TOUR_SEEN_KEY starts SettingsTour automatically.
    renderTour(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.ok(dom.window.document.querySelector('.bt-tour-card'), 'SettingsTour auto-starts on first open')
    assert.equal(Boolean(sibling.inert), true, 'SettingsTour marks non-settings body siblings inert')

    // Mount ShortcutsDialog over Settings + SettingsTour -> tour yields inertness!
    renderTour(true)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const shortcutsLayer = dom.window.document.querySelector('.dsb-shortcuts-layer')
    assert.ok(shortcutsLayer, 'ShortcutsDialog mounted on document.body')
    assert.equal(Boolean(shortcutsLayer.inert), false, 'ShortcutsDialog must NEVER be marked inert by SettingsTour')
    assert.equal(Boolean(sibling.inert), false, 'SettingsTour yields inertness while foreground modal is open')
    const closeBtn = dom.window.document.querySelector('.dsb-shortcuts-close')
    act(() => { closeBtn.click() })
    assert.equal(closeClicks, 1, 'ShortcutsDialog close button remains clickable over SettingsTour')

    // Closing ShortcutsDialog lets SettingsTour resume cleanly.
    renderTour(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.equal(Boolean(sibling.inert), true, 'SettingsTour restores isolation after foreground modal closes')
    sibling.remove()
  } finally {
    act(() => { root.unmount() })
    dom.window.close()
    globalThis.window = prev.window
    globalThis.document = prev.document
    if (prev.navigator) Object.defineProperty(globalThis, 'navigator', prev.navigator)
    else delete globalThis.navigator
    globalThis.HTMLElement = prev.HTMLElement
    globalThis.Element = prev.Element
    globalThis.Node = prev.Node
    globalThis.MutationObserver = prev.MutationObserver
    globalThis.ResizeObserver = prev.ResizeObserver
    globalThis.KeyboardEvent = prev.KeyboardEvent
    globalThis.Event = prev.Event
    globalThis.localStorage = prev.localStorage
    globalThis.getComputedStyle = prev.getComputedStyle
    globalThis.requestAnimationFrame = prev.requestAnimationFrame
    globalThis.cancelAnimationFrame = prev.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT
  }
})

test('ShortcutsDialog traps Tab/Shift+Tab, blocks SettingsTour ArrowRight/ArrowLeft, and preserves ref-counted inert isolation over SettingsTour', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app-shell-bg"><button id="bg-btn" type="button">Main Pill</button></div><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    KeyboardEvent: globalThis.KeyboardEvent,
    Event: globalThis.Event,
    localStorage: globalThis.localStorage,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  globalThis.Node = dom.window.Node
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.Event = dom.window.Event
  globalThis.localStorage = dom.window.localStorage
  globalThis.getComputedStyle = dom.window.getComputedStyle
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = id => clearTimeout(id)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const { createRoot } = await import('react-dom/client')
  const { SettingsDialog, ShortcutsDialog } = loadSettingsModule()
  const container = dom.window.document.getElementById('root')
  const bgShell = dom.window.document.getElementById('app-shell-bg')
  const root = createRoot(container)

  let settingsPage = 'overview'
  let shortcutsOpen = false
  const openedPages = []

  const actions = {
    openSettings(nextPage) {
      openedPages.push(nextPage)
      settingsPage = nextPage ?? 'overview'
      shortcutsOpen = false
    },
    closeSettings() {},
    providers: () => Promise.resolve({ available: true, providers: [], revision: 1 }),
    folders: () => Promise.resolve({ team: '/work' }),
    setPrefs: () => Promise.resolve(),
  }

  const renderAll = () => act(() => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(SettingsDialog, {
        page: settingsPage,
        id: null,
        roster: baseRoster,
        actions,
        useUpdate: sel => sel({}),
      }),
      React.createElement(ShortcutsDialog, {
        open: shortcutsOpen,
        onCustomize: () => { actions.openSettings('shortcuts') },
        onClose: () => { shortcutsOpen = false },
      }),
    ))
  })

  try {
    // 1. Open Settings -> SettingsTour auto-starts at step 1 and marks background inert.
    renderAll()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const initialStep = dom.window.document.querySelector('.bt-tour-count')?.textContent?.trim()
    assert.ok(initialStep && initialStep.startsWith('1 /'), `tour starts at step 1 (got ${initialStep})`)
    assert.equal(Boolean(bgShell.inert), true, 'SettingsTour marks main shell inert')

    // 2. Open real ShortcutsDialog over SettingsDialog + SettingsTour.
    shortcutsOpen = true
    renderAll()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })

    const shortcutsEl = dom.window.document.querySelector('.dsb-shortcuts')
    const closeBtn = dom.window.document.querySelector('.dsb-shortcuts-close')
    const customizeBtn = dom.window.document.querySelector('.dsb-shortcuts-customize')
    assert.ok(shortcutsEl && closeBtn && customizeBtn, 'ShortcutsDialog controls rendered')
    assert.equal(shortcutsEl.closest('[inert]'), null, 'ShortcutsDialog itself is never inert')
    assert.equal(Boolean(bgShell.inert), true, 'background shell stays inert while ShortcutsDialog is open over SettingsTour')
    assert.equal(dom.window.document.activeElement, closeBtn, 'initial focus lands on ShortcutsDialog Close button')

    // 3. ArrowRight / ArrowLeft must NOT advance hidden SettingsTour or close ShortcutsDialog!
    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    renderAll()
    assert.equal(shortcutsOpen, true, 'ArrowRight/ArrowLeft must NOT close ShortcutsDialog')
    assert.equal(openedPages.length, 0, 'ArrowRight/ArrowLeft must NOT navigate Settings behind ShortcutsDialog')
    assert.equal(dom.window.document.querySelector('.bt-tour-count')?.textContent?.trim(), initialStep, 'hidden SettingsTour step must NOT advance')

    // 4. Tab / Shift+Tab cycles strictly between ShortcutsDialog controls and NEVER escapes to background!
    const pressTab = (shiftKey = false) => {
      const evt = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      act(() => {
        (dom.window.document.activeElement || dom.window.document.body).dispatchEvent(evt)
      })
      return evt
    }
    // From closeBtn -> Tab wraps to customizeBtn -> Tab cycles back to closeBtn.
    const t1 = pressTab(false)
    assert.equal(t1.defaultPrevented, true)
    assert.equal(dom.window.document.activeElement, customizeBtn, 'Tab from Close cycles to Customize')
    const t2 = pressTab(false)
    assert.equal(t2.defaultPrevented, true)
    assert.equal(dom.window.document.activeElement, closeBtn, 'Tab from Customize cycles back to Close without escaping dialog')
    const t3 = pressTab(true)
    assert.equal(t3.defaultPrevented, true)
    assert.equal(dom.window.document.activeElement, customizeBtn, 'Shift+Tab from Close cycles to Customize')
    assert.equal(shortcutsEl.contains(dom.window.document.activeElement), true)

    // 5. Close ShortcutsDialog -> SettingsTour regains keyboard control and ArrowRight advances step.
    shortcutsOpen = false
    renderAll()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.equal(dom.window.document.querySelector('.dsb-shortcuts'), null)
    assert.equal(Boolean(bgShell.inert), true, 'SettingsTour retains background isolation after ShortcutsDialog closes')

    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const nextStep = dom.window.document.querySelector('.bt-tour-count')?.textContent?.trim()
    assert.ok(nextStep && nextStep.startsWith('2 /'), `ArrowRight advances SettingsTour once ShortcutsDialog is closed (got ${nextStep})`)

    // 6. Dismiss SettingsTour -> background inert clears completely (zero leaked ref-counted inert locks).
    const tourCloseBtn = dom.window.document.querySelector('.bt-tour-close')
    assert.ok(tourCloseBtn)
    act(() => { tourCloseBtn.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.equal(Boolean(bgShell.inert), false, 'dismissing tour releases all ref-counted inert locks')
  } finally {
    act(() => { root.unmount() })
    dom.window.close()
    globalThis.window = prev.window
    globalThis.document = prev.document
    if (prev.navigator) Object.defineProperty(globalThis, 'navigator', prev.navigator)
    else delete globalThis.navigator
    globalThis.HTMLElement = prev.HTMLElement
    globalThis.Element = prev.Element
    globalThis.Node = prev.Node
    globalThis.MutationObserver = prev.MutationObserver
    globalThis.ResizeObserver = prev.ResizeObserver
    globalThis.KeyboardEvent = prev.KeyboardEvent
    globalThis.Event = prev.Event
    globalThis.localStorage = prev.localStorage
    globalThis.getComputedStyle = prev.getComputedStyle
    globalThis.requestAnimationFrame = prev.requestAnimationFrame
    globalThis.cancelAnimationFrame = prev.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT
  }
})
