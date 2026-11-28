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
  assert.match(lazySrc, /ImPage[\s\S]*connectors-page\.js[\s\S]*CONNECTORS_PAGE_CSS/, 'ImPage must explicitly install CONNECTORS_PAGE_CSS alongside IM_CSS')
  assert.doesNotMatch(lazySrc, /SERVICES_CSS/, 'DeepSeekServicesPage already injects SERVICES_CSS inline; lazy wrapper must not duplicate it')
  assert.match(lazySrc, /APPEARANCE_PAGE_CSS/, 'AppearancePage lazy wrapper must install APPEARANCE_PAGE_CSS on demand')
  assert.match(lazySrc, /SHORTCUTS_PAGE_CSS/, 'ShortcutsPage lazy wrapper must install SHORTCUTS_PAGE_CSS on demand')
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
