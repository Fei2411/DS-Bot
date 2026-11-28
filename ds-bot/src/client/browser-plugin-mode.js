// Shared browser-slot classification and display-label resolution across the sidebar
// browser view, details drawer, Browser settings, Plugins page, and plugin marks.
import { language, t } from './i18n.js'

const KNOWN_BROWSER_LABELS = {
  'builtin:readonly': () => t('Read-only Browser'),
  'builtin:refs': () => t('Playwright (Refs)'),
  'builtin:script': () => t('Playwright (Script)'),
  'builtin:task': () => t('Playwright (Task)'),
  'mcp:playwright-mcp': () => 'Playwright MCP',
  'mcp:chrome-devtools-mcp': () => 'Chrome DevTools MCP',
}

function localizedNameFrom(locales) {
  if (!locales || typeof locales !== 'object') return null
  const lang = String(language?.() ?? 'en').toLowerCase()
  const exact = locales[lang]?.name
  if (typeof exact === 'string' && exact.trim()) return exact.trim()
  const base = lang.split('-')[0]
  const primary = locales[base]?.name
  if (typeof primary === 'string' && primary.trim()) return primary.trim()
  return null
}

/** Whether a browser-slot plugin opens in an external window outside DS Bot's sidebar. */
export function isExternalBrowserPlugin(plugin) {
  if (plugin?.slot !== 'browser') return false
  if (plugin.windowMode === 'external') return true
  if (plugin.windowMode === 'pane' || plugin.windowMode === 'readonly') return false
  return !plugin.builtin && plugin.controlsPane !== true
}

/** Resolve active browser-slot surface mode, takeover visibility, and localized label. */
export function browserPaneMode(browserSlot, hold = null) {
  const active = browserSlot?.active ?? 'builtin:readonly'
  const controlsPane = typeof browserSlot?.controlsPane === 'boolean'
    ? browserSlot.controlsPane
    : browserSlot?.windowMode === 'pane'
      || (browserSlot?.windowMode == null && /^builtin:(refs|script|task|injected)$/.test(active))
  const windowMode = browserSlot?.windowMode === 'pane'
    || browserSlot?.windowMode === 'readonly'
    || browserSlot?.windowMode === 'external'
    ? browserSlot.windowMode
    : (controlsPane ? 'pane' : (active === 'builtin:readonly' ? 'readonly' : 'external'))
  const customName = browserSlot?.customName === true && typeof browserSlot?.activeName === 'string' && browserSlot.activeName.trim() !== ''
  const localized = customName ? null : localizedNameFrom(browserSlot?.activeLocales)
  const activeLabel = customName
    ? browserSlot.activeName.trim()
    : (localized
      ?? KNOWN_BROWSER_LABELS[active]?.()
      ?? (typeof browserSlot?.activeName === 'string' && browserSlot.activeName.trim() ? browserSlot.activeName.trim() : null)
      ?? active.replace(/^(builtin|dsh|mcp|provider):/, ''))
  return {
    active,
    activeLabel,
    controlsPane,
    windowMode,
    showTakeover: Boolean(controlsPane || hold?.by),
    isExternal: windowMode === 'external',
  }
}
