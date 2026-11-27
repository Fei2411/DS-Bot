// Bridges UI plugin slot registrations (`settings.section`, `settings.section.icon`,
// `settings.general.item`, `settings.action`) into `SettingsDialog`'s `dsh` prop, and
// registers the built-in Engine settings pages and Language control through the plugin runtime.
import { Suspense, createElement as h, lazy, useEffect, useMemo, useState } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { SelectMenu } from '../../../ds-bot/src/client/select-menu.js'
import { LANGUAGE_OPTIONS, getAppLocale } from './locale.js'
import { bustImportUrl, pluginRuntime, usePlugins } from './plugin-runtime.js'
import {
  SETTINGS_GENERAL_ITEM_SLOT,
  SETTINGS_SECTION_SLOT,
  SlotErrorBoundary,
  slots as defaultSlots,
  useSlotEntries,
} from './slots.js'

export const SETTINGS_SECTION_ICON_SLOT = 'settings.section.icon'
export const SETTINGS_ACTION_SLOT = 'settings.action'

let lastFailedEngineChunkUrl = null

function findEngineChunkUrl(error) {
  const fromMessage = /https?:\/\/[^\s'")]+\/engine-settings[^?\s'")#]*\.js/i.exec(String(error?.message ?? error ?? ''))?.[0]
  if (fromMessage) return fromMessage
  try {
    const entries = globalThis.performance?.getEntriesByType?.('resource') ?? []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = String(entries[i]?.name ?? '')
      if (/\/engine-settings(?:-[^/?#]+)?\.js(?:$|[?#])/i.test(name)) return name
    }
  } catch {
    // Ignore restricted performance API environments.
  }
  return null
}

function defaultLoadEngineSettings(attempt = 0) {
  if (attempt > 0) {
    const chunkUrl = lastFailedEngineChunkUrl || findEngineChunkUrl(null)
    if (chunkUrl) {
      const busted = bustImportUrl(chunkUrl, attempt)
      return import(/* @vite-ignore */ busted).catch((err) => {
        lastFailedEngineChunkUrl = findEngineChunkUrl(err) || chunkUrl
        throw err
      })
    }
  }
  return import('./engine-settings.js').catch((err) => {
    lastFailedEngineChunkUrl = findEngineChunkUrl(err) || lastFailedEngineChunkUrl
    throw err
  })
}

/**
 * Wraps `React.lazy` so a failed module load is not stuck on React's cached rejected
 * payload: calling `Component.reset()` bumps the attempt counter and creates a fresh
 * lazy wrapper that invokes `loadModule(attempt)` again on the next render.
 */
export function createRetryableLazy(loadModule, pickExport) {
  let attempt = 0
  let Inner = null
  const ensure = () => {
    if (Inner === null) {
      const currentAttempt = attempt
      Inner = lazy(() => Promise.resolve(loadModule(currentAttempt)).then((mod) => {
        const picked = typeof pickExport === 'function' ? pickExport(mod) : mod?.default
        if (!picked) throw new Error('Settings module did not provide the expected view')
        return { default: picked }
      }))
    }
    return Inner
  }
  function RetryableLazy(props) {
    const Target = ensure()
    return h(Target, props)
  }
  RetryableLazy.reset = () => {
    attempt += 1
    Inner = null
  }
  RetryableLazy.attempt = () => attempt
  return RetryableLazy
}

const LazyFallback = () => h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))

function renderSlotComponent(entry, props, slotName, isLazy = true) {
  const Component = entry.component
  const child = h(Component, props)
  return h(SlotErrorBoundary, {
    slotName,
    resetKey: slotName,
    pluginId: entry.pluginId,
    runtime: entry.runtime,
    onRetry: () => {
      Component?.reset?.()
      entry.onRetry?.()
    },
  }, isLazy ? h(Suspense, { fallback: h(LazyFallback) }, child) : child)
}

/**
 * Synchronous Language switcher rendered inside `Settings → General → Basics`.
 */
export function LanguageGeneralItem() {
  const service = getAppLocale()
  const [preference, setPreference] = useState(() => service?.getLocale?.().preference ?? 'auto')
  useEffect(() => {
    if (!service?.subscribe) return undefined
    setPreference(service.getLocale().preference)
    return service.subscribe(next => setPreference(next.preference))
  }, [service])
  if (!service) return null
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', null, t('Language'))),
    h('div', { className: 'bt-set-control' },
      h(SelectMenu, {
        'aria-label': t('Language'),
        value: preference,
        options: LANGUAGE_OPTIONS.map(([id, nativeLabel]) => ({ value: id, label: nativeLabel ?? t('System default') })),
        onChange: next => { service.setLocale(next) },
      })))
}

/**
 * Registers the built-in Engine settings sections and General items as a UI plugin.
 * Heavy settings components are lazy-loaded only when the user opens a section, and
 * `pages` lets the runtime defer plugin activation until Settings opens.
 */
export function registerEngineSettingsPlugin(runtime, { pages, loadEngineSettings = defaultLoadEngineSettings } = {}) {
  return runtime.use({
    id: 'ds-bot.engine-settings',
    name: 'Engine settings',
    ...(Array.isArray(pages) ? { pages } : {}),
  }, (ctx) => {
    const loadWithRetry = attempt => loadEngineSettings(attempt + (ctx.retryCount ?? 0))
    const LazyAccountSection = createRetryableLazy(loadWithRetry, mod => mod.AccountSettingsPage)
    const LazyPluginsSection = createRetryableLazy(loadWithRetry, mod => mod.PluginsSettingsPage)
    const LazyAgentPresetsSection = createRetryableLazy(loadWithRetry, mod => mod.AgentPresetsSettingsPage)
    const LazyArchivedSessionsSection = createRetryableLazy(loadWithRetry, mod => mod.ArchivedSessionsPage)
    const LazySessionLogItem = createRetryableLazy(loadWithRetry, mod => mod.SessionLogGeneralItem)

    ctx.slot({ name: SETTINGS_SECTION_SLOT, id: 'account', priority: 10, meta: { labelKey: 'Account' } }, LazyAccountSection)
    ctx.slot({ name: SETTINGS_SECTION_SLOT, id: 'plugins', priority: 20, meta: { labelKey: 'Plugins' } }, LazyPluginsSection)
    ctx.slot({ name: SETTINGS_SECTION_SLOT, id: 'agent-presets', priority: 30, meta: { labelKey: 'Agent presets' } }, LazyAgentPresetsSection)
    ctx.slot({ name: SETTINGS_SECTION_SLOT, id: 'archived-sessions', priority: 40, meta: { labelKey: 'Archived sessions', surface: 'agent' } }, LazyArchivedSessionsSection)
    ctx.slot({ name: SETTINGS_GENERAL_ITEM_SLOT, id: 'language', priority: 1, meta: { sync: true } }, LanguageGeneralItem)
    ctx.slot({ name: SETTINGS_GENERAL_ITEM_SLOT, id: 'session-log-deepseek', priority: 10 }, LazySessionLogItem)
  })
}

/**
 * Builds the reactive `dsh` prop consumed by `SettingsDialog`.
 * Sets `ownWindow: true` so `AppearancePage` retains desktop-owned theme/font/material controls.
 */
export function useDshSettingsBridge(registry = defaultSlots, extraProps = {}) {
  const sectionEntries = useSlotEntries(registry, SETTINGS_SECTION_SLOT)
  const iconEntries = useSlotEntries(registry, SETTINGS_SECTION_ICON_SLOT)
  const itemEntries = useSlotEntries(registry, SETTINGS_GENERAL_ITEM_SLOT)
  const actionEntries = useSlotEntries(registry, SETTINGS_ACTION_SLOT)
  const runtime = extraProps.runtime ?? pluginRuntime
  const plugins = usePlugins(runtime)

  const readOnly = Boolean(extraProps.readOnly)
  const surfaceMode = extraProps.surfaceMode ?? 'bot'
  const localeVersion = extraProps.localeVersion ?? 0
  const onRestoredSession = extraProps.onRestoredSession
  const onStartPresetCreator = extraProps.onStartPresetCreator

  return useMemo(() => {
    void localeVersion
    const visibleSectionEntries = sectionEntries.filter(entry =>
      typeof entry.id === 'string' && entry.id !== '' && (!entry.meta?.surface || entry.meta.surface === surfaceMode))
    const failedEnginePlugin = plugins.find(p => p.id === 'ds-bot.engine-settings' && p.status === 'error')
    const sections = visibleSectionEntries.map(entry => ({
      id: entry.id,
      label: entry.meta?.labelKey ? t(entry.meta.labelKey) : String(entry.meta?.label ?? entry.id),
    }))
    if (failedEnginePlugin && !sections.some(s => s.id === 'plugins')) {
      sections.push({ id: 'plugins', label: t('Plugins') })
    }
    const items = itemEntries
      .filter(entry => typeof entry.id === 'string' && entry.id !== '')
      .map(entry => ({ id: entry.id }))

    const byName = {
      [SETTINGS_SECTION_SLOT]: visibleSectionEntries,
      [SETTINGS_SECTION_ICON_SLOT]: iconEntries,
      [SETTINGS_GENERAL_ITEM_SLOT]: itemEntries,
      [SETTINGS_ACTION_SLOT]: actionEntries,
    }

    return {
      ownWindow: true,
      surfaceMode,
      sections,
      items,
      renderSlot(name, props = {}, options = {}) {
        const list = byName[name] ?? []
        const { only, fallback = null } = options
        if (only !== undefined) {
          const match = list.find(entry => entry.id === only)
          if (!match) {
            if (name === SETTINGS_SECTION_SLOT && only === 'plugins' && failedEnginePlugin) {
              return h('div', { className: 'dsb-slot-error', role: 'alert' },
                h('span', null, failedEnginePlugin.error || t('This view could not be shown.')),
                h('button', {
                  type: 'button',
                  className: 'bt-soft bt-soft-sm',
                  onClick: () => { runtime.retry(failedEnginePlugin.id) },
                }, t('Retry')))
            }
            return fallback
          }
          const merged = { ...props, readOnly, surfaceMode, runtime, onRestoredSession, onStartPresetCreator }
          return renderSlotComponent(match, merged, `${name}:${only}`, match.meta?.sync !== true)
        }
        if (list.length === 0) return fallback
        return list.map((entry, idx) => h('span', { key: entry.id ?? idx, className: 'dsb-slot-item' },
          renderSlotComponent(entry, { ...props, readOnly, surfaceMode, runtime, onRestoredSession, onStartPresetCreator }, `${name}:${entry.id ?? idx}`, entry.meta?.sync !== true)))
      },
    }
  }, [sectionEntries, iconEntries, itemEntries, actionEntries, plugins, runtime, readOnly, surfaceMode, localeVersion, onRestoredSession, onStartPresetCreator])
}
