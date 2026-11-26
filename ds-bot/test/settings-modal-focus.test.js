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
  dom.window.localStorage.setItem('ds-bot.settings-tour.v1', 'done')

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
