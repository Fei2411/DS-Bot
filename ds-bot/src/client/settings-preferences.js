// #1815: replace DSH's misplaced Firefox Menu until its positioning is fixed.
import { createElement as h, Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { RiskConfirmation } from './dsh-primitives.js'
import { CheckIcon } from './icons.js'
import { useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'

export const PREFERENCE_ITEMS = new Set(['language', 'transcript-view', 'link-opening', 'composer-enter', 'performance-usage', 'permission'])

const CHAT_CHOICES = {
  transcriptView: ['compact', 'standard', 'detailed', 'verbose'],
  collapseTiming: ['completion', 'next-input'],
  foldedReplies: ['all', 'final'],
  performanceUsage: ['compact', 'detailed'],
  linkOpening: ['sidebar', 'new-tab'],
}
const CHAT_LABELS = {
  transcriptView: ['settings.transcript.compact', 'settings.transcript.standard', 'settings.transcript.detailed', 'settings.transcript.verbose'],
  collapseTiming: ['settings.collapse.completion', 'settings.collapse.nextInput'],
  foldedReplies: ['settings.foldedReplies.all', 'settings.foldedReplies.final'],
  performanceUsage: ['settings.performance.compact', 'settings.performance.detailed'],
  linkOpening: ['settings.links.sidebar', 'settings.links.newTab'],
}
const CHAT_KEYS = { transcriptView: 'transcript', collapseTiming: 'collapse', foldedReplies: 'foldedReplies', performanceUsage: 'performance', linkOpening: 'links' }

export function chatPreference(value = {}, desktop = false) {
  const mode = value.transcriptView
  return {
    transcriptView: mode === 'normal' || mode === 'expanded' ? 'detailed' : mode ?? (desktop ? 'standard' : 'detailed'),
    collapseTiming: value.collapseTiming ?? 'completion', foldedReplies: value.foldedReplies ?? 'all',
    performanceUsage: value.performanceUsage ?? 'detailed', linkOpening: value.linkOpening ?? 'sidebar',
  }
}

export async function savePreference(form, field, value) {
  const snapshot = form.getSnapshot()
  if (snapshot.status !== 'ready' || !snapshot.writable || !await form.set(field, value)) throw new Error('preference write refused')
}

export function PreferenceSelect({ label, value, options, disabled, pick }) {
  const menu = useAnchoredMenu()
  useEffect(() => { if (disabled || options.length === 0) menu.close() }, [disabled, options.length])
  const selected = options.find(option => option.id === value)
  const choose = (id) => {
    menu.button.current?.focus({ preventScroll: true })
    menu.close()
    pick(id)
  }
  return h(Fragment, null,
    h('button', {
      ref: menu.button, type: 'button', className: 'bt-select', 'aria-label': label,
      'aria-haspopup': 'menu', 'aria-expanded': menu.isOpen, disabled: disabled || options.length === 0,
      onClick: () => { if (menu.isOpen) menu.close(); else menu.open() },
      onKeyDown: (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.open() }
      },
    }, selected?.label ?? (options.length === 0 ? t('Loading…') : value ?? '')),
    menu.shownPlace ? createPortal(h('div', {
      ref: menu.menu, role: 'menu', 'aria-label': label, className: 'bt-menu',
      'data-leaving': menu.leaving ? '' : undefined, style: { ...menu.shownPlace, overflowY: 'auto', zIndex: 1100 },
      onKeyDown: (event) => { if (event.key === 'Tab') menu.close() },
    }, options.map(option => h('button', {
      key: option.id, type: 'button', role: 'menuitemradio', 'aria-checked': option.id === value,
      onClick: () => choose(option.id),
    }, h('span', { className: 'bt-menu-label' }, option.label), option.id === value ? h(CheckIcon) : null))), document.body) : null)
}

export function PreferenceRow({ title, description, value, options, disabled, save, saveUnchanged = false }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', null, title),
      description ? h('span', { className: 'bt-set-hint' }, description) : null,
      failed ? h('span', { className: 'bt-set-hint bt-danger', role: 'alert' }, t('Could not save. Try again.')) : null),
    h('div', { className: 'bt-set-control' }, h(PreferenceSelect, {
      label: title, value, options, disabled: disabled || busy,
      pick: (next) => {
        if (next === value && !saveUnchanged) return
        setBusy(true)
        setFailed(false)
        Promise.resolve().then(() => save(next)).catch(() => setFailed(true)).finally(() => setBusy(false))
      },
    })))
}

function usePreferenceSchema(preferences, namespace) {
  const describe = preferences.describe
  const snapshot = useSyncExternalStore(listener => describe.subscribe(listener), () => describe.getSnapshot())
  const entry = snapshot.view?.namespaces.find(entry => entry.ns === namespace)
  const wire = entry?.schema
  return useMemo(() => wire === undefined ? undefined : preferences.schema.rehydrate(wire), [preferences.schema, wire])
}

function FormPreferences({ id, preferences }) {
  const namespace = id === 'composer-enter' ? 'ui-conversation' : 'ui-chat'
  const form = preferences.forms[namespace]
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const schema = usePreferenceSchema(preferences, namespace)
  const supports = field => schema !== undefined && preferences.schema.nodeAtPath(schema, [field]) !== undefined
  const browserAvailable = useSyncExternalStore(preferences.browser.subscribe, preferences.browser.getSnapshot)
  const disabled = snapshot.status !== 'ready' || !snapshot.writable
  if (snapshot.status === 'unavailable') return null
  const tr = preferences.locale.bind(namespace === 'ui-chat' ? 'chat' : 'conversation')
  if (id === 'composer-enter') return !supports('busyEnter') ? null : h(PreferenceRow, {
    title: tr('settings.enter.title'), description: tr('settings.enter.description'),
    value: snapshot.value?.busyEnter ?? 'queue', disabled,
    options: ['queue', 'steer'].map(value => ({ id: value, label: tr(`settings.enter.${value}`) })),
    save: value => savePreference(form, 'busyEnter', value),
  })
  if (id === 'link-opening' && !browserAvailable) return null
  const value = chatPreference(snapshot.value, preferences.desktop)
  const fields = id === 'transcript-view'
    ? ['transcriptView', 'collapseTiming', ...(value.transcriptView === 'verbose' ? [] : ['foldedReplies'])]
    : [id === 'performance-usage' ? 'performanceUsage' : 'linkOpening']
  return fields.filter(supports).map(field => h(PreferenceRow, {
    key: field, title: tr(`settings.${CHAT_KEYS[field]}.title`), description: tr(`settings.${CHAT_KEYS[field]}.description`),
    value: value[field], disabled,
    options: CHAT_CHOICES[field].map((choice, index) => ({ id: choice, label: tr(CHAT_LABELS[field][index]) })),
    save: choice => savePreference(form, field, choice),
  }))
}

function LanguagePreference({ preferences }) {
  const locale = preferences.locale
  const snapshot = useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot())
  return h(PreferenceRow, {
    title: locale.bind('settings.locale')('language.title'), value: snapshot.active,
    saveUnchanged: true,
    options: snapshot.locales.map(({ id, label }) => ({ id, label })), save: id => locale.setLocale(id),
  })
}

export function permissionOptions(catalog, translate) {
  const builtins = { 'read-only': ['preset.readOnly', 'Read Only'], 'workspace-write': ['preset.workspaceWrite', 'Workspace Write'], 'danger-full-access': ['preset.fullAccess', 'Full access'] }
  return (catalog?.defaultOptions ?? []).map(({ value, name }) => {
    const builtin = builtins[value]
    const title = name ?? value
    const label = builtin && (title === value || title === builtin[1]) ? translate(builtin[0])
      : /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(title) ? title.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ') : title
    return { id: value, label }
  })
}

function PermissionPreference({ preferences }) {
  const form = preferences.forms.permission
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const schema = usePreferenceSchema(preferences, 'permission')
  const [catalog, setCatalog] = useState(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [confirmation, setConfirmation] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const tr = preferences.locale.bind('settings.permission')
  useEffect(() => {
    let epoch = 0
    const refresh = () => {
      const current = ++epoch
      setCatalog(null)
      setFailed(false)
      Promise.resolve().then(() => preferences.permissionCatalog()).then((result) => {
        if (current !== epoch) return
        if (result.ok) setCatalog(result.value)
        else setFailed(true)
      }).catch(() => { if (current === epoch) setFailed(true) })
    }
    const stop = preferences.subscribePermission(refresh)
    refresh()
    return () => { ++epoch; stop() }
  }, [preferences, attempt])
  useEffect(() => {
    if (snapshot.writable && snapshot.status !== 'unavailable') return
    confirmation?.resolve()
    setConfirmation(null)
    setAcknowledged(false)
  }, [snapshot.writable, snapshot.status])
  if (snapshot.status === 'unavailable' || schema === undefined || preferences.schema.nodeAtPath(schema, ['defaultPreset']) === undefined) return null
  const value = snapshot.value?.defaultPreset ?? catalog?.defaultPreset
  const options = permissionOptions(catalog, tr)
  return h(Fragment, null,
    h(PreferenceRow, {
      title: tr('title'), description: tr('description'), value, options,
      disabled: snapshot.status !== 'ready' || !snapshot.writable || catalog === null,
      save: next => next !== 'danger-full-access' ? savePreference(form, 'defaultPreset', next)
        : new Promise((resolve, reject) => { setAcknowledged(false); setConfirmation({ value: next, resolve, reject }) }),
    }),
    failed ? h('div', { className: 'bt-set-note', role: 'alert' }, tr('unavailable'), ' ',
      h('button', { type: 'button', className: 'bt-soft-sm', onClick: () => setAttempt(value => value + 1) }, t('Try again'))) : null,
    h(RiskConfirmation, {
      open: confirmation !== null, title: tr('confirm.title'), description: tr('confirm.description'),
      acknowledgeLabel: tr('confirm.acknowledge'), cancelLabel: tr('confirm.cancel'), closeLabel: tr('close'), confirmLabel: tr('confirm.enable'),
      acknowledged, onAcknowledgedChange: setAcknowledged, disabled: !snapshot.writable,
      onCancel: () => { confirmation?.resolve(); setConfirmation(null) },
      onConfirm: () => {
        if (!acknowledged || !confirmation) return
        const pending = confirmation
        setConfirmation(null)
        savePreference(form, 'defaultPreset', pending.value).then(pending.resolve, pending.reject)
      },
    }))
}

export function SettingsPreferences({ id, preferences }) {
  if (id === 'language') return h(LanguagePreference, { preferences })
  if (id === 'permission') return h(PermissionPreference, { preferences })
  return h(FormPreferences, { id, preferences })
}

export function settingsPreferences(ctx) {
  const configForms = ctx.get('configForms')
  const locale = ctx.get('locale')
  const schema = ctx.get('settingsSchema')
  if (!configForms || !locale || !schema) return undefined
  return {
    forms: { 'ui-chat': configForms.get('ui-chat'), 'ui-conversation': configForms.get('ui-conversation'), permission: configForms.get('permission') },
    locale, schema, describe: configForms.describe(), desktop: 'dshDesktop' in globalThis,
    browser: {
      getSnapshot: () => ctx.get('sidebarRightTabs')?.get('browser') !== undefined,
      subscribe: listener => ctx.get('sidebarRightTabs')?.subscribe(listener) ?? (() => {}),
    },
    permissionCatalog: () => Promise.resolve().then(() => ctx.get('remote.permissionPresets')?.catalog() ?? { ok: false }),
    subscribePermission: (listener) => {
      const stop = ctx.get('remote')?.$on?.('permission-presets/catalog-changed', listener)
      const reset = ctx.on?.('connection/reset', listener)
      return () => { stop?.(); reset?.() }
    },
  }
}
