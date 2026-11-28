// Desktop-only retryable React.lazy wrappers for Settings sub-pages so opening Settings
// only loads the active page (and every stylesheet it depends on) without permanently
// caching rejected dynamic imports.
import { Suspense, createElement as h } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { installStyles } from '../../../ds-bot/src/client/styles.js'
import { createChunkLoader, createRetryableLazy } from './retryable-lazy.js'
import { SlotErrorBoundary } from './slots.js'

const installedStyles = new Set()

function ensureStyle(tag, css) {
  if (!css || installedStyles.has(tag)) return
  installedStyles.add(tag)
  installStyles(css, tag)
}

function lazyPage(load, exportName, { chunkPattern, styles = [], boundary = true } = {}) {
  const loader = chunkPattern ? createChunkLoader(load, chunkPattern) : load
  const Lazy = createRetryableLazy(async (attempt) => {
    const mod = await loader(attempt)
    for (const [tag, cssKey] of styles) ensureStyle(tag, mod[cssKey])
    return mod
  }, mod => mod[exportName])

  function LazySettingsPage(props) {
    const fallback = boundary ? h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…')) : null
    const content = h(Suspense, { fallback }, h(Lazy, props))
    if (!boundary) return content
    return h(SlotErrorBoundary, {
      slotName: `settings:${exportName}`,
      resetKey: exportName,
      onError: () => { Lazy.reset() },
    }, content)
  }
  LazySettingsPage.reset = () => { Lazy.reset() }
  return LazySettingsPage
}

// Independent per-chunk loaders for multi-chunk pages so retrying after a failure in
// either chunk busts only the failed specifier and always runs cross-page CSS install.
const loadConnectorsChunk = createChunkLoader(
  () => import('../../../ds-bot/src/client/connectors-page.js'),
  /\/connectors-page(?:-[^/?#]+)?\.js(?:$|[?#])/i,
)
const loadImChunk = createChunkLoader(
  () => import('../../../ds-bot/src/client/im-page.js'),
  /\/im-page(?:-[^/?#]+)?\.js(?:$|[?#])/i,
)
const loadProvidersChunk = createChunkLoader(
  () => import('../../../ds-bot/src/client/providers-page.js'),
  /\/providers-page(?:-[^/?#]+)?\.js(?:$|[?#])/i,
)
const loadOverviewChunk = createChunkLoader(
  () => import('../../../ds-bot/src/client/settings-overview.js'),
  /\/settings-overview(?:-[^/?#]+)?\.js(?:$|[?#])/i,
)

export const AboutPage = lazyPage(
  () => import('../../../ds-bot/src/client/about.js'),
  'AboutPage',
  { chunkPattern: /\/about(?:-[^/?#]+)?\.js(?:$|[?#])/i, styles: [['about', 'ABOUT_CSS']] },
)
export const ApiPage = lazyPage(
  () => import('../../../ds-bot/src/client/api-page.js'),
  'ApiPage',
  { chunkPattern: /\/api-page(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const AppearancePage = lazyPage(
  () => import('../../../ds-bot/src/client/appearance-page.js'),
  'AppearancePage',
  { chunkPattern: /\/appearance-page(?:-[^/?#]+)?\.js(?:$|[?#])/i, styles: [['appearance', 'APPEARANCE_PAGE_CSS']] },
)
export const BotModelsPage = lazyPage(
  () => import('../../../ds-bot/src/client/bot-models-page.js'),
  'BotModelsPage',
  { chunkPattern: /\/bot-models-page(?:-[^/?#]+)?\.js(?:$|[?#])/i, styles: [['bot-models', 'BOT_MODELS_CSS']] },
)
export const BotSettingsForm = lazyPage(
  () => import('../../../ds-bot/src/client/bot-settings.js'),
  'BotSettingsForm',
  { chunkPattern: /\/bot-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const BrowserPage = lazyPage(
  () => import('../../../ds-bot/src/client/browser-settings.js'),
  'BrowserPage',
  { chunkPattern: /\/browser-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const CapabilitiesPage = lazyPage(
  () => import('../../../ds-bot/src/client/capability-settings.js'),
  'CapabilitiesPage',
  { chunkPattern: /\/capability-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const ComputerPage = lazyPage(
  () => import('../../../ds-bot/src/client/computer.js'),
  'ComputerPage',
  { chunkPattern: /\/computer(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const ConnectorsPage = lazyPage(
  attempt => loadConnectorsChunk(attempt),
  'ConnectorsPage',
  { styles: [['connectors-page', 'CONNECTORS_PAGE_CSS']] },
)
export const CreateBot = lazyPage(
  () => import('../../../ds-bot/src/client/create-bot.js'),
  'CreateBot',
  { chunkPattern: /\/create-bot(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const FeedbackPage = lazyPage(
  () => import('../../../ds-bot/src/client/feedback.js'),
  'FeedbackPage',
  { chunkPattern: /\/feedback(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const GroupSettingsForm = lazyPage(
  () => import('../../../ds-bot/src/client/group-settings.js'),
  'GroupSettingsForm',
  { chunkPattern: /\/group-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const NewGroupForm = lazyPage(
  () => import('../../../ds-bot/src/client/group-settings.js'),
  'NewGroupForm',
  { chunkPattern: /\/group-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
// ImPage shares `.bt-apps`/`.bt-app-grid` rules from CONNECTORS_PAGE_CSS; load both
// chunks through independent cache-busting loaders and install both stylesheets outside
// any single-URL bypass so retries always preserve styling and return the ImPage module.
export const ImPage = lazyPage(async (attempt) => {
  const [im, connectors] = await Promise.all([
    loadImChunk(attempt),
    loadConnectorsChunk(attempt),
  ])
  ensureStyle('connectors-page', connectors.CONNECTORS_PAGE_CSS)
  ensureStyle('im', im.IM_CSS)
  return im
}, 'ImPage')
export const KeptPrivateSection = lazyPage(
  () => import('../../../ds-bot/src/client/kept-private.js'),
  'KeptPrivateSection',
  { chunkPattern: /\/kept-private(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const LocalAgentsPage = lazyPage(
  () => import('../../../ds-bot/src/client/local-agents-page.js'),
  'LocalAgentsPage',
  { chunkPattern: /\/local-agents-page(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const PhonePage = lazyPage(
  () => import('../../../ds-bot/src/client/phone-page.js'),
  'PhonePage',
  { chunkPattern: /\/phone-page(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const PluginsPage = lazyPage(
  () => import('../../../ds-bot/src/client/plugins-page.js'),
  'PluginsPage',
  { chunkPattern: /\/plugins-page(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const PrivacyPage = lazyPage(
  () => import('../../../ds-bot/src/client/privacy-page.js'),
  'PrivacyPage',
  { chunkPattern: /\/privacy-page(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const ProvidersPage = lazyPage(
  attempt => loadProvidersChunk(attempt),
  'ProvidersPage',
  { styles: [['providers', 'PROVIDERS_CSS']] },
)
export const SchedulesPage = lazyPage(
  () => import('../../../ds-bot/src/client/schedules.js'),
  'SchedulesPage',
  { chunkPattern: /\/schedules(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const SecretsPage = lazyPage(
  () => import('../../../ds-bot/src/client/secret-card.js'),
  'SecretsPage',
  { chunkPattern: /\/secret-card(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
// DeepSeekServicesPage renders its own inline <style data-ds-bot="deepseek-services">.
export const DeepSeekServicesPage = lazyPage(
  () => import('../../../ds-bot/src/client/services-settings.js'),
  'DeepSeekServicesPage',
  { chunkPattern: /\/services-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i },
)
export const OverviewPage = lazyPage(async (attempt) => {
  const [overview, providers] = await Promise.all([
    loadOverviewChunk(attempt),
    loadProvidersChunk(attempt),
  ])
  ensureStyle('providers', providers.PROVIDERS_CSS)
  return overview
}, 'OverviewPage')
// SettingsPalette is isolated by PaletteBoundary in settings.js so a load failure only
// dismisses the search overlay and surfaces an error while keeping Settings open.
export const SettingsPalette = lazyPage(
  () => import('../../../ds-bot/src/client/settings-palette.js'),
  'SettingsPalette',
  { chunkPattern: /\/settings-palette(?:-[^/?#]+)?\.js(?:$|[?#])/i, boundary: false },
)
export const ShortcutsPage = lazyPage(
  () => import('../../../ds-bot/src/client/shortcuts-page.js'),
  'ShortcutsPage',
  { chunkPattern: /\/shortcuts-page(?:-[^/?#]+)?\.js(?:$|[?#])/i, styles: [['shortcuts', 'SHORTCUTS_PAGE_CSS']] },
)
export const UsagePage = lazyPage(
  () => import('../../../ds-bot/src/client/usage-page.js'),
  'UsagePage',
  { chunkPattern: /\/usage-page(?:-[^/?#]+)?\.js(?:$|[?#])/i, styles: [['usage', 'USAGE_CSS']] },
)
