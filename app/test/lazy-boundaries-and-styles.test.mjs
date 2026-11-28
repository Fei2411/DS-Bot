// Regression tests for PR #2447 review findings:
// 1. Chat-shared and cross-page CSS must be available without opening sibling Settings pages.
// 2. Retryable React.lazy boundaries for Terminal, SettingsDialog, Settings pages, and SettingsPalette.
// 3. Locale load failure diagnostics & retryability; deep-link scroll settle on late sibling resize.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const repoDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = fileURLToPath(new URL('..', import.meta.url))

function clickEl(el) {
  el.dispatchEvent({
    type: 'click',
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  })
}

function readEagerCssText() {
  return [
    readFileSync(new URL('../../ds-bot/src/client/styles.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../ds-bot/src/client/connectors.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../ds-bot/src/client/feedback.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../ds-bot/src/client/privacy-page.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../ds-bot/src/client/bot-settings.js', import.meta.url), 'utf8'),
  ].join('\n')
}

test('eager chat and shell styles cover ConnectorDock, MailForm, Privacy/Feedback links, and CommandPalette keycaps without opening Settings', () => {
  const mainSrc = readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(mainSrc, /APPEARANCE_PAGE_CSS/, 'main.js must not eagerly import APPEARANCE_PAGE_CSS')
  assert.doesNotMatch(mainSrc, /SHORTCUTS_PAGE_CSS/, 'main.js must not eagerly import SHORTCUTS_PAGE_CSS')

  const eagerCss = readEagerCssText()
  assert.match(eagerCss, /\.bt-connector-mark\{[^}]*--bt-mark-ink:/, 'ConnectorDock/MailDock mark ink must live in eager CSS')
  assert.match(eagerCss, /\.bt-provider-pair\{[^}]*grid-template-columns:/, 'MailForm Other-mail 2-column grid must live in eager CSS')
  assert.match(eagerCss, /\.bt-about-link\{/, 'PrivacyPage/AboutPage external link layout must live in eager CSS')
  assert.match(eagerCss, /\.bt-fb-primary:disabled\{/, 'FeedbackPage disabled primary button style must live in eager CSS')
  assert.match(eagerCss, /\.bt-kbd\{/, 'CommandPalette KeyCaps style must live in eager CSS')
  assert.match(eagerCss, /\.bt-palette-kbd\{/, 'CommandPalette shortcut alignment must live in eager CSS')
})

test('lazy Settings page wrappers install all cross-page CSS dependencies and avoid duplicate SERVICES_CSS', () => {
  const lazySrc = readFileSync(new URL('../ui/src/settings-pages-lazy.js', import.meta.url), 'utf8')
  assert.match(lazySrc, /ImPage[\s\S]*CONNECTORS_PAGE_CSS/, 'ImPage must explicitly install CONNECTORS_PAGE_CSS alongside IM_CSS')
  assert.doesNotMatch(lazySrc, /SERVICES_CSS/, 'DeepSeekServicesPage already injects SERVICES_CSS inline; lazy wrapper must not duplicate it')
  assert.match(lazySrc, /APPEARANCE_PAGE_CSS/, 'AppearancePage lazy wrapper must install APPEARANCE_PAGE_CSS on demand')
  assert.match(lazySrc, /SHORTCUTS_PAGE_CSS/, 'ShortcutsPage lazy wrapper must install SHORTCUTS_PAGE_CSS on demand')
  // B1: multi-chunk pages (ImPage, OverviewPage) must use independent per-chunk loaders
  // so retrying one failed chunk never bypasses sibling chunk loads or ensureStyle().
  assert.match(lazySrc, /loadImChunk/, 'ImPage should use an independent chunk loader for im-page')
  assert.match(lazySrc, /loadConnectorsChunk/, 'ImPage should use an independent chunk loader for connectors-page')
  assert.match(lazySrc, /loadOverviewChunk/, 'OverviewPage should use an independent chunk loader for settings-overview')
  assert.match(lazySrc, /loadProvidersChunk/, 'OverviewPage should use an independent chunk loader for providers-page')
  // Non-blocking: SHORTCUTS_PAGE_CSS must not duplicate .bt-kbd* rules already in eager SHELL_CSS.
  const shortcutsSrc = readFileSync(new URL('../../ds-bot/src/client/shortcuts-page.js', import.meta.url), 'utf8')
  const shortcutsCss = shortcutsSrc.slice(shortcutsSrc.indexOf('export const SHORTCUTS_PAGE_CSS'))
  assert.doesNotMatch(shortcutsCss, /\.bt-kbd\{|\.bt-kbd-group\{|\.bt-palette-kbd\{/, 'SHORTCUTS_PAGE_CSS must not duplicate .bt-kbd* rules from SHELL_CSS')
})

test('createChunkLoader passes bustedUrl to parameterized custom loaders instead of bypassing them (B1)', async () => {
  const { createChunkLoader } = await import('../ui/src/retryable-lazy.js')
  const calls = []
  const loader = createChunkLoader((ctx) => {
    calls.push({ attempt: ctx.attempt, bustedUrl: ctx.bustedUrl, hasImportBusted: typeof ctx.importBusted === 'function' })
    if (ctx.attempt === 0) {
      return Promise.reject(new Error('Failed to fetch dynamically imported module: http://127.0.0.1:4123/assets/im-page-abc.js'))
    }
    return Promise.resolve({ ImPage: () => null, styled: true })
  }, /\/im-page(?:-[^/?#]+)?\.js(?:$|[?#])/i)

  await assert.rejects(() => loader(0), /im-page-abc\.js/)
  const recovered = await loader(1)
  assert.equal(recovered.styled, true, 'custom loader body and side effects must still execute on retry')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].attempt, 0)
  assert.equal(calls[0].bustedUrl, null)
  assert.equal(calls[1].attempt, 1)
  assert.equal(calls[1].bustedUrl, 'http://127.0.0.1:4123/assets/im-page-abc.js?retry=1')
  assert.equal(calls[1].hasImportBusted, true)
})

test('SlotErrorBoundary retries once with busting, then switches to Reload window and self-heals on resetKey change (B2)', async () => {
  const { createRetryableLazy, reloadWindowSafely } = await import('../ui/src/retryable-lazy.js')
  const { SlotErrorBoundary } = await import('../ui/src/slots.js')
  const { keepDraft } = await import('../../ds-bot/src/client/draft-keep.js')
  const { STORAGE } = await import('../../ds-bot/src/client/storage.js')
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { installMiniDom } = await import('./mini-dom.mjs')
  installMiniDom()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const origErr = console.error
  console.error = () => {}
  try {
    // 1. Sub-chunk failure persists across bust retry -> switches to Reload window.
    let attempts = 0
    let reloadClicks = 0
    const PoisonedLazy = createRetryableLazy((attempt) => {
      attempts += 1
      return Promise.reject(new Error(`poisoned static sub-chunk vendor-xterm (attempt ${attempt})`))
    }, mod => mod.Target)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await React.act(async () => {
      root.render(React.createElement(SlotErrorBoundary, {
        slotName: 'workspace:terminal',
        resetKey: 'terminal:s1',
        onError: () => { PoisonedLazy.reset() },
        onRetry: () => { PoisonedLazy.reset() },
        onReload: () => { reloadClicks += 1 },
      }, React.createElement(React.Suspense, { fallback: React.createElement('div', null, 'Loading…') },
        React.createElement(PoisonedLazy))))
    })
    await React.act(async () => { await new Promise(r => setTimeout(r, 20)) })

    assert.equal(attempts, 1)
    let btn = container.querySelector('.dsb-slot-error')?.querySelector('button')
    assert.equal(btn?.textContent, 'Retry', 'first failure should offer Retry')

    // Click Retry -> attempt 1 still fails (simulating poisoned static sub-chunk).
    await React.act(async () => {
      clickEl(btn)
      await new Promise(r => setTimeout(r, 20))
    })
    assert.equal(attempts, 2)
    btn = container.querySelector('.dsb-slot-error')?.querySelector('button')
    assert.equal(btn?.textContent, 'Reload window', 'persistent failure after bust retry must switch to Reload window')

    await React.act(async () => { clickEl(btn) })
    assert.equal(reloadClicks, 1, 'clicking Reload window must invoke reload')

    // 2. Switching resetKey (e.g. switching sessions) without clicking Retry self-heals because onError reset Lazy.
    let selfHealAttempts = 0
    let failFirst = true
    const SelfHealLazy = createRetryableLazy((attempt) => {
      selfHealAttempts += 1
      if (failFirst) return Promise.reject(new Error(`transient #${attempt}`))
      return Promise.resolve({ Target: () => React.createElement('div', { className: 'healed-view' }, `Healed #${attempt}`) })
    }, mod => mod.Target)

    await React.act(async () => {
      root.render(React.createElement(SlotErrorBoundary, {
        key: 'self-heal',
        slotName: 'workspace:terminal',
        resetKey: 'terminal:sh-1',
        onError: () => { SelfHealLazy.reset() },
        onRetry: () => { SelfHealLazy.reset() },
      }, React.createElement(React.Suspense, { fallback: React.createElement('div', null, 'Loading…') },
        React.createElement(SelfHealLazy))))
    })
    await React.act(async () => { await new Promise(r => setTimeout(r, 20)) })
    assert.equal(selfHealAttempts, 1)
    assert.ok(container.querySelector('.dsb-slot-error'))

    // Chunk recovers and user switches to session s2 without clicking Retry.
    failFirst = false
    await React.act(async () => {
      root.render(React.createElement(SlotErrorBoundary, {
        key: 'self-heal',
        slotName: 'workspace:terminal',
        resetKey: 'terminal:sh-2',
        onError: () => { SelfHealLazy.reset() },
        onRetry: () => { SelfHealLazy.reset() },
      }, React.createElement(React.Suspense, { fallback: React.createElement('div', null, 'Loading…') },
        React.createElement(SelfHealLazy))))
    })
    await React.act(async () => { await new Promise(r => setTimeout(r, 20)) })
    assert.equal(selfHealAttempts, 2)
    assert.equal(container.querySelector('.healed-view')?.textContent, 'Healed #1')

    // 3. reloadWindowSafely flushes any debounced composer draft into localStorage before calling location.reload().
    const origLocation = globalThis.location
    const origStorage = globalThis.localStorage
    const store = new Map()
    globalThis.localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: k => { store.delete(k) },
    }
    let reloaded = 0
    globalThis.location = { reload() { reloaded += 1 } }
    try {
      keepDraft({ chatId: 'bot-1', part: 'p1', text: 'unsent draft text', files: [] }, globalThis.localStorage, { deferMs: 5000 })
      reloadWindowSafely()
      assert.equal(reloaded, 1)
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE.drafts) ?? '{}')
      assert.equal(stored['bot-1']?.text, 'unsent draft text', 'debounced draft must be flushed before reload')
    } finally {
      globalThis.location = origLocation
      globalThis.localStorage = origStorage
    }

    await React.act(async () => { root.unmount() })
    container.remove()
  } finally {
    console.error = origErr
  }
})

test('createLocale holds previous display language until switched dictionary registers (no English flash) and includes revision in notifications', async () => {
  const { createLocale } = await import('../ui/src/locale.js')
  const store = new Map()
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  const locale = createLocale('zh-CN', { storage })
  locale.register('ds-bot', 'zh', { Settings: '设置' })
  const translate = locale.bind('ds-bot')
  assert.equal(translate('Settings'), '设置')

  const events = []
  locale.subscribe(ev => events.push(ev))

  // Switch to Japanese before ja dictionary arrives: active updates, but rendered copy stays Chinese (no English flash).
  locale.setLocale('ja')
  assert.equal(locale.getLocale().active, 'ja')
  assert.equal(translate('Settings'), '设置', 'must hold previous language while new dictionary is still loading')
  assert.equal(typeof events.at(-1)?.revision, 'number', 'subscriber event should include revision')

  // Once Japanese dictionary registers, copy switches directly from Chinese to Japanese.
  locale.register('ds-bot', 'ja', { Settings: '設定' })
  assert.equal(translate('Settings'), '設定')
  assert.ok(events.at(-1).revision > events[0].revision)

  // Switching to English takes effect immediately (English needs no dictionary).
  locale.setLocale('en')
  assert.equal(translate('Settings'), 'Settings')
})

test('createRetryableLazy + SlotErrorBoundary recovers from dynamic import failure on Retry in real React DOM', async () => {
  const { createRetryableLazy } = await import('../ui/src/retryable-lazy.js')
  const { SlotErrorBoundary } = await import('../ui/src/slots.js')
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { installMiniDom } = await import('./mini-dom.mjs')
  installMiniDom()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const origErr = console.error
  console.error = () => {}
  try {
    let attempts = 0
    let shouldFail = true
    const LazyView = createRetryableLazy((attempt) => {
      attempts += 1
      if (shouldFail) return Promise.reject(new Error(`chunk load failed #${attempt}`))
      return Promise.resolve({ Target: () => React.createElement('div', { className: 'recovered-view' }, `Recovered on attempt ${attempt}`) })
    }, mod => mod.Target)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await React.act(async () => {
      root.render(React.createElement(SlotErrorBoundary, {
        slotName: 'test:lazy',
        resetKey: 'k1',
        onRetry: () => { LazyView.reset() },
      }, React.createElement(React.Suspense, { fallback: React.createElement('div', { className: 'dsb-rp-empty' }, 'Loading…') },
        React.createElement(LazyView))))
    })
    // Wait for rejected import microtask + React error boundary settle.
    await React.act(async () => { await new Promise(r => setTimeout(r, 20)) })

    assert.equal(attempts, 1)
    const errBox = container.querySelector('.dsb-slot-error')
    assert.ok(errBox, 'error boundary must render local failure UI')
    const retryBtn = errBox.querySelector('button')
    assert.ok(retryBtn, 'error boundary must expose Retry button')

    // Recover the dynamic import and click Retry.
    shouldFail = false
    await React.act(async () => {
      clickEl(retryBtn)
      await new Promise(r => setTimeout(r, 20))
    })

    assert.equal(attempts, 2)
    assert.equal(container.querySelector('.dsb-slot-error'), null, 'error UI must clear after successful retry')
    assert.equal(container.querySelector('.recovered-view')?.textContent, 'Recovered on attempt 1')

    await React.act(async () => { root.unmount() })
    container.remove()
  } finally {
    console.error = origErr
  }
})

test('WorkspacePaneBody terminal uses SlotErrorBoundary, Loading fallback, and retryable lazy loader', () => {
  const rpSrc = readFileSync(new URL('../ui/src/right-panel.js', import.meta.url), 'utf8')
  assert.match(rpSrc, /createRetryableLazy/, 'right-panel.js must use createRetryableLazy for WorkspaceTerminal')
  assert.match(rpSrc, /slotName:\s*['"]workspace:terminal['"]/, 'terminal pane must be isolated by a local SlotErrorBoundary')
  assert.match(rpSrc, /className:\s*['"]dsb-rp-empty['"][\s\S]*t\(['"]Loading…['"]\)/, 'terminal Suspense fallback must use .dsb-rp-empty Loading…')
  assert.match(rpSrc, /WorkspaceTerminal\.reset\?\.\(\)/, 'terminal SlotErrorBoundary retry must reset the lazy loader')
})

test('SettingsPalette failure in SettingsDialog is caught locally without unmounting SettingsDialog', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { SettingsDialog } from './ds-bot/src/client/settings.js'",
      resolveDir: repoDir,
      loader: 'js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    nodePaths: [`${appDir}/node_modules`],
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'palette-fail-stub',
      setup(bundler) {
        bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({ path: 'primitives', namespace: 'stub' }))
        bundler.onResolve({ filter: /settings-pages\.js$/ }, () => ({ path: 'pages', namespace: 'stub' }))
        bundler.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'primitives') {
            return { contents: 'export const IconAgentPresetOutlineMedium = () => null; export const IconArchiveOutlineMedium = () => null; export const IconSettingsOutlineMedium = () => null; export const IconUserOutlineMedium = () => null; export const RiskConfirmation = () => null;\n', loader: 'js' }
          }
          return {
            contents: `
              import { createElement as h } from 'react'
              const ok = name => () => h('div', { 'data-page': name }, name)
              export const OverviewPage = ok('overview')
              export const AboutPage = ok('about')
              export const ApiPage = ok('api')
              export const AppearancePage = ok('appearance')
              export const BotModelsPage = ok('bot-models')
              export const BotSettingsForm = ok('bot-settings')
              export const BrowserPage = ok('browser')
              export const CapabilitiesPage = ok('capabilities')
              export const ComputerPage = ok('computer')
              export const ConnectorsPage = ok('connectors')
              export const CreateBot = ok('create-bot')
              export const DeepSeekServicesPage = ok('services')
              export const FeedbackPage = ok('feedback')
              export const GroupSettingsForm = ok('group-settings')
              export const ImPage = ok('im')
              export const KeptPrivateSection = ok('kept-private')
              export const LocalAgentsPage = ok('local-agents')
              export const NewGroupForm = ok('new-group')
              export const PhonePage = ok('phone')
              export const PluginsPage = ok('plugins')
              export const PrivacyPage = ok('privacy')
              export const ProvidersPage = ok('providers')
              export const SchedulesPage = ok('schedules')
              export const SecretsPage = ok('secrets')
              export const ShortcutsPage = ok('shortcuts')
              export const UsagePage = ok('usage')
              export function SettingsPalette() {
                globalThis.__paletteAttempts = (globalThis.__paletteAttempts || 0) + 1
                if (globalThis.__paletteFail) throw new Error('settings-palette chunk failed')
                return h('div', { className: 'bt-palette-ok' }, 'Palette Ready')
              }
              SettingsPalette.reset = () => { globalThis.__paletteResets = (globalThis.__paletteResets || 0) + 1 }
            `,
            loader: 'js',
          }
        })
      },
    }],
  })

  const React = await import('react')
  const ReactDOM = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  const { installMiniDom } = await import('./mini-dom.mjs')
  installMiniDom()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const origErr = console.error
  console.error = () => {}
  try {
    const mod = { exports: {} }
    const sandbox = {
      module: mod,
      exports: mod.exports,
      __paletteFail: true,
      __paletteAttempts: 0,
      __paletteResets: 0,
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      localStorage: globalThis.localStorage,
      console: { ...console, error() {} },
      setTimeout,
      clearTimeout,
      requestAnimationFrame: cb => setTimeout(cb, 0),
      cancelAnimationFrame: clearTimeout,
      require: name => (name === 'react' ? React : name === 'react-dom' ? ReactDOM : {}),
    }
    sandbox.globalThis = sandbox
    runInNewContext(outputFiles[0].text, sandbox)
    const { SettingsDialog } = mod.exports

    let outerCaught = null
    class OuterBoundary extends React.Component {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(err) { outerCaught = err }
      render() { return this.state.failed ? React.createElement('div', null, 'OUTER_FAILED') : this.props.children }
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const roster = { bots: [], rooms: [], byId: {}, roomsById: {}, models: [], prefs: {} }
    const actions = { openSettings() {}, closeSettings() {}, folders: async () => ({}) }

    await React.act(async () => {
      root.render(React.createElement(OuterBoundary, null,
        React.createElement(SettingsDialog, { page: 'overview', roster, actions })))
    })

    const searchBtn = container.querySelector('.bt-set-search')
    assert.ok(searchBtn, 'Settings search button should exist')
    await React.act(async () => {
      clickEl(searchBtn)
    })

    assert.equal(outerCaught, null, 'SettingsPalette failure must NOT bubble out of SettingsDialog')
    assert.ok(container.querySelector('.bt-settings'), 'SettingsDialog must remain mounted after palette failure')
    assert.ok(sandbox.__paletteResets >= 1, 'SettingsPalette.reset() must be called so next attempt retries')
    assert.match(container.textContent, /could not be shown|error/i, 'Settings should surface a palette load error')

    // Now chunk recovers -> clicking Search again succeeds and renders the palette.
    sandbox.__paletteFail = false
    await React.act(async () => {
      clickEl(container.querySelector('.bt-set-search'))
    })
    assert.ok(container.querySelector('.bt-palette-ok'), 'retrying SettingsPalette after recovery must succeed')

    await React.act(async () => { root.unmount() })
    container.remove()
  } finally {
    console.error = origErr
  }
})

test('i18n logs diagnostics on locale load failure instead of swallowing silently', () => {
  const i18nSrc = readFileSync(new URL('../../ds-bot/src/client/i18n.js', import.meta.url), 'utf8')
  const mainSrc = readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(i18nSrc, /ensureLocale\([^)]*\)\.catch\(\(\) => \{\}\)/, 'i18n.js must log locale load failures instead of empty catch')
  assert.doesNotMatch(mainSrc, /ensureLocale\([^)]*\)\.catch\(\(\) => \{\}\)/, 'main.js must log initial locale load failures instead of empty catch')
})

test('Settings multi-part deep-link scroll observes sibling resize after 420ms until user scrolls', () => {
  const settingsSrc = readFileSync(new URL('../../ds-bot/src/client/settings.js', import.meta.url), 'utf8')
  assert.match(settingsSrc, /ResizeObserver/, 'settings.js should observe part container resizes so late lazy siblings do not push deep-linked targets out of view')
})
