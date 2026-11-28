// Desktop-only React.lazy wrappers for Settings sub-pages so opening Settings only loads
// the active page (and its stylesheet) instead of every settings section up front.
import { createElement as h, Suspense, lazy } from 'react'
import { installStyles } from '../../../ds-bot/src/client/styles.js'

const installedStyles = new Set()

function ensureStyle(tag, css) {
  if (!css || installedStyles.has(tag)) return
  installedStyles.add(tag)
  installStyles(css, tag)
}

function lazyPage(load, exportName, styles = []) {
  const Lazy = lazy(() => load().then((mod) => {
    for (const [tag, cssKey] of styles) ensureStyle(tag, mod[cssKey])
    return { default: mod[exportName] }
  }))
  return function LazySettingsPage(props) {
    return h(Suspense, { fallback: null }, h(Lazy, props))
  }
}

export const AboutPage = lazyPage(() => import('../../../ds-bot/src/client/about.js'), 'AboutPage', [['about', 'ABOUT_CSS']])
export const ApiPage = lazyPage(() => import('../../../ds-bot/src/client/api-page.js'), 'ApiPage')
export const AppearancePage = lazyPage(() => import('../../../ds-bot/src/client/appearance-page.js'), 'AppearancePage')
export const BotModelsPage = lazyPage(() => import('../../../ds-bot/src/client/bot-models-page.js'), 'BotModelsPage', [['bot-models', 'BOT_MODELS_CSS']])
export const BotSettingsForm = lazyPage(() => import('../../../ds-bot/src/client/bot-settings.js'), 'BotSettingsForm')
export const BrowserPage = lazyPage(() => import('../../../ds-bot/src/client/browser-settings.js'), 'BrowserPage')
export const CapabilitiesPage = lazyPage(() => import('../../../ds-bot/src/client/capability-settings.js'), 'CapabilitiesPage')
export const ComputerPage = lazyPage(() => import('../../../ds-bot/src/client/computer.js'), 'ComputerPage')
export const ConnectorsPage = lazyPage(() => import('../../../ds-bot/src/client/connectors-page.js'), 'ConnectorsPage', [['connectors-page', 'CONNECTORS_PAGE_CSS']])
export const CreateBot = lazyPage(() => import('../../../ds-bot/src/client/create-bot.js'), 'CreateBot')
export const FeedbackPage = lazyPage(() => import('../../../ds-bot/src/client/feedback.js'), 'FeedbackPage')
export const GroupSettingsForm = lazyPage(() => import('../../../ds-bot/src/client/group-settings.js'), 'GroupSettingsForm')
export const NewGroupForm = lazyPage(() => import('../../../ds-bot/src/client/group-settings.js'), 'NewGroupForm')
export const ImPage = lazyPage(() => import('../../../ds-bot/src/client/im-page.js'), 'ImPage', [['im', 'IM_CSS']])
export const KeptPrivateSection = lazyPage(() => import('../../../ds-bot/src/client/kept-private.js'), 'KeptPrivateSection')
export const LocalAgentsPage = lazyPage(() => import('../../../ds-bot/src/client/local-agents-page.js'), 'LocalAgentsPage')
export const PhonePage = lazyPage(() => import('../../../ds-bot/src/client/phone-page.js'), 'PhonePage')
export const PluginsPage = lazyPage(() => import('../../../ds-bot/src/client/plugins-page.js'), 'PluginsPage')
export const PrivacyPage = lazyPage(() => import('../../../ds-bot/src/client/privacy-page.js'), 'PrivacyPage')
export const ProvidersPage = lazyPage(() => import('../../../ds-bot/src/client/providers-page.js'), 'ProvidersPage', [['providers', 'PROVIDERS_CSS']])
export const SchedulesPage = lazyPage(() => import('../../../ds-bot/src/client/schedules.js'), 'SchedulesPage')
export const SecretsPage = lazyPage(() => import('../../../ds-bot/src/client/secret-card.js'), 'SecretsPage')
export const DeepSeekServicesPage = lazyPage(() => import('../../../ds-bot/src/client/services-settings.js'), 'DeepSeekServicesPage', [['services', 'SERVICES_CSS']])
export const OverviewPage = lazyPage(async () => {
  const [overview, providers] = await Promise.all([
    import('../../../ds-bot/src/client/settings-overview.js'),
    import('../../../ds-bot/src/client/providers-page.js'),
  ])
  ensureStyle('providers', providers.PROVIDERS_CSS)
  return overview
}, 'OverviewPage')
export const SettingsPalette = lazyPage(() => import('../../../ds-bot/src/client/settings-palette.js'), 'SettingsPalette')
export const ShortcutsPage = lazyPage(() => import('../../../ds-bot/src/client/shortcuts-page.js'), 'ShortcutsPage')
export const UsagePage = lazyPage(() => import('../../../ds-bot/src/client/usage-page.js'), 'UsagePage', [['usage', 'USAGE_CSS']])
