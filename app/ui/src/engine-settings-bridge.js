// Bridges UI plugin slot registrations (`settings.section`, `settings.section.icon`,
// `settings.general.item`, `settings.action`) into `SettingsDialog`'s `dsh` prop, and
// registers the built-in Engine settings pages and Language control through the plugin runtime.
import { Suspense, createElement as h, lazy, useEffect, useMemo, useState } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { SelectMenu } from '../../../ds-bot/src/client/select-menu.js'
import { LANGUAGE_OPTIONS, getAppLocale } from './locale.js'
import {
  SETTINGS_GENERAL_ITEM_SLOT,
  SETTINGS_SECTION_SLOT,
  SlotErrorBoundary,
  slots as defaultSlots,
  useSlotEntries,
} from './slots.js'

export const SETTINGS_SECTION_ICON_SLOT = 'settings.section.icon'
export const SETTINGS_ACTION_SLOT = 'settings.action'

const loadEngineSettings = () => import('./engine-settings.js')

const LazyAccountSection = lazy(() => loadEngineSettings().then(mod => ({ default: mod.AccountSettingsPage })))
const LazyPluginsSection = lazy(() => loadEngineSettings().then(mod => ({ default: mod.PluginsSettingsPage })))
const LazyAgentPresetsSection = lazy(() => loadEngineSettings().then(mod => ({ default: mod.AgentPresetsSettingsPage })))
const LazyArchivedSessionsSection = lazy(() => loadEngineSettings().then(mod => ({ default: mod.ArchivedSessionsPage })))
const LazySessionLogItem = lazy(() => loadEngineSettings().then(mod => ({ default: mod.SessionLogGeneralItem })))

const LazyFallback = () => h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))

function renderSlotComponent(Component, props, slotName, isLazy = true) {
  const child = h(Component, props)
  return h(SlotErrorBoundary, { slotName, resetKey: slotName },
    isLazy ? h(Suspense, { fallback: h(LazyFallback) }, child) : child)
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
 * Heavy settings components are lazy-loaded only when the user opens a section.
 */
export function registerEngineSettingsPlugin(runtime) {
  return runtime.use({ id: 'ds-bot.engine-settings', name: 'Engine settings' }, (ctx) => {
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

  const readOnly = Boolean(extraProps.readOnly)
  const surfaceMode = extraProps.surfaceMode ?? 'bot'
  const localeVersion = extraProps.localeVersion ?? 0
  const onRestoredSession = extraProps.onRestoredSession
  const onStartPresetCreator = extraProps.onStartPresetCreator

  return useMemo(() => {
    void localeVersion
    const visibleSectionEntries = sectionEntries.filter(entry =>
      typeof entry.id === 'string' && entry.id !== '' && (!entry.meta?.surface || entry.meta.surface === surfaceMode))
    const sections = visibleSectionEntries.map(entry => ({
      id: entry.id,
      label: entry.meta?.labelKey ? t(entry.meta.labelKey) : String(entry.meta?.label ?? entry.id),
    }))
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
      sections,
      items,
      renderSlot(name, props = {}, options = {}) {
        const list = byName[name] ?? []
        const { only, fallback = null } = options
        if (only !== undefined) {
          const match = list.find(entry => entry.id === only)
          if (!match) return fallback
          const merged = { ...props, readOnly, surfaceMode, onRestoredSession, onStartPresetCreator }
          return renderSlotComponent(match.component, merged, `${name}:${only}`, match.meta?.sync !== true)
        }
        if (list.length === 0) return fallback
        return list.map((entry, idx) => h('span', { key: entry.id ?? idx, className: 'dsb-slot-item' },
          renderSlotComponent(entry.component, { ...props, readOnly, surfaceMode, onRestoredSession, onStartPresetCreator }, `${name}:${entry.id ?? idx}`, entry.meta?.sync !== true)))
      },
    }
  }, [sectionEntries, iconEntries, itemEntries, actionEntries, readOnly, surfaceMode, localeVersion, onRestoredSession, onStartPresetCreator])
}
