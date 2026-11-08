// The settings shell: DS Bot holds `sidebar.settings`, the seat DSH's ui-settings-general
// fills elsewhere (the bundle patch turns that row off). Holding the seat means declaring
// its child slots, and only the declaring entry may render them, so DSH's own settings
// pages (`settings.section`), their nav icons, header actions, onboarding steps and General
// rows all draw inside DS Bot's settings dialog. This module also takes over what that
// shell did besides: the sidebar-foot row with the connection and Desktop update status,
// the onboarding coordinator, the Settings shortcut, the Host release prompt, the
// configuration-file action and the code work view switch.
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, ConnectionIndicator, Modal, Tooltip,
  IconDownloadOutlineRegular, IconLoadingOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsDialog } from './settings.js'
import { Switch } from './bot-settings.js'
import { GearIcon } from './icons.js'
import { useLinger } from './motion.js'
import { t } from './i18n.js'

// The child slots of the seat, as ui-settings declares their types.
export const SETTINGS_CHILDREN = {
  'settings.launcher': { kind: 'single', scope: 'root' },
  'settings.trigger': { kind: 'single', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.action': { kind: 'list', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
  'settings.onboarding': { kind: 'list', scope: 'root' },
  'settings.general.item': { kind: 'list', scope: 'root' },
}

// DSH's preview notice keeps its acknowledgement in ui-settings-general's own settings,
// which no longer run; DSH Desktop leaves that notice out as well.
const SKIPPED_STEPS = new Set(['welcome-notice'])

const DIALOG_EXIT_MS = 160
const RECOVERY_CONFIRMATION_MS = 2000
const CONNECTING_MIN_VISIBLE_MS = 800
const BUSY_PHASES = new Set(['checking', 'downloading', 'verifying', 'installing'])

export function snapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next) => {
      value = typeof next === 'function' ? next(value) : next
      for (const listener of [...listeners]) listener()
    },
  }
}

const labelOf = label => (typeof label === 'function' ? label() : label) ?? ''

// A ledger projected into sorted rows; the projection is rebuilt only when the slot's
// version or the language moved, so the hook sees a stable snapshot between changes.
export function ledgerSource(slots, localeOf, name, project) {
  let version = -1
  let revision = -1
  let rows = []
  return {
    getSnapshot: () => {
      const nextVersion = slots.getVersion(name)
      const nextRevision = localeOf()?.getSnapshot?.()?.revision ?? 0
      if (nextVersion !== version || nextRevision !== revision) {
        version = nextVersion
        revision = nextRevision
        rows = project(slots.entries(name))
      }
      return rows
    },
    subscribe: (listener) => {
      const offs = [slots.subscribe(name, listener)]
      const locale = localeOf()
      if (typeof locale?.subscribe === 'function') offs.push(locale.subscribe(listener))
      return () => { for (const off of offs) off() }
    },
  }
}

const byOrder = (a, b) => a.order - b.order
export const sectionRows = entries => entries.map(entry => ({ id: entry.options.id ?? '', order: entry.options.order ?? 0, label: labelOf(entry.options.label) })).sort(byOrder)
export const itemRows = entries => entries.map(entry => ({ id: entry.options.id ?? '', order: entry.options.order ?? 0 })).sort(byOrder)
export const stepRows = entries => itemRows(entries).filter(step => !SKIPPED_STEPS.has(step.id))

// DSH Desktop's update carrier: status in, one user action out. Other windows have none.
export function desktopUpdateSource(bridge) {
  const store = snapshotStore({ failed: false, opening: false })
  let live = true
  let received = false
  const off = bridge?.subscribe((presentation) => {
    if (!live) return
    received = true
    store.set(state => ({ ...state, presentation, failed: false }))
  })
  bridge?.status().then(
    (presentation) => { if (live && !received) store.set(state => ({ ...state, presentation })) },
    () => { if (live && !received) store.set(state => ({ ...state, failed: true })) },
  )
  return {
    store,
    open: () => {
      const state = store.getSnapshot()
      if (!live || bridge === undefined || state.opening || BUSY_PHASES.has(state.presentation?.phase)) return
      store.set({ ...state, opening: true })
      bridge.open()
        .catch(() => { if (live) store.set(current => ({ ...current, failed: true })) })
        .finally(() => { if (live) store.set(current => ({ ...current, opening: false })) })
    },
    dispose: () => { live = false; off?.() },
  }
}

// Whether the first-run steps run: the main view shows no conversation yet.
export function onboardingActive(state) {
  const main = Object.values(state?.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
  return state?.phase === 'ready' && (main === undefined || main.blank === true)
}

export function pickStep({ steps, requested, active, completed }) {
  if (requested !== undefined) return steps.find(step => step.id === requested)
  return active ? steps.find(step => !completed.has(step.id)) : undefined
}

// Connection status with the shell's timings: a reconnect shows at least 800ms, and the
// recovery note stays 2s once it can be seen.
function useConnectionView(state) {
  const [recovered, setRecovered] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const previous = useRef(state)
  const connectingAt = useRef(undefined)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = state
    if (state !== 'connected') { setRecovered(false); return }
    if (before === 'disconnected' || before === 'connecting') setRecovered(true)
  }, [state])
  useLayoutEffect(() => {
    if (!recovered || holdConnecting) return undefined
    const timer = setTimeout(() => setRecovered(false), RECOVERY_CONFIRMATION_MS)
    return () => clearTimeout(timer)
  }, [recovered, holdConnecting])
  useLayoutEffect(() => {
    if (state === 'connecting') { connectingAt.current = Date.now(); return undefined }
    const shownAt = connectingAt.current
    if (shownAt === undefined) return undefined
    connectingAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return undefined
    setHoldConnecting(true)
    const timer = setTimeout(() => setHoldConnecting(false), remaining)
    return () => { clearTimeout(timer); setHoldConnecting(false) }
  }, [state])
  if (state === 'connecting' || holdConnecting) return 'connecting'
  if (state === 'disconnected') return 'disconnected'
  return recovered ? 'recovered' : undefined
}

const FAILURES = {
  check: 'Could not check for updates. Try again later.',
  'check-network': 'Could not check for updates. Check your connection and try again.',
  download: 'Could not download the update. Try again.',
  'download-network': 'Could not download the update. Check your connection and try again.',
  install: 'Could not install the update. Try again later.',
  'install-network': 'Could not install the update. Check your connection and try again.',
  'stop-failed': 'Tasks could not stop safely, so the update was not installed. Try again later.',
  'tasks-changed': 'New tasks started. Confirm again to stop them and update.',
  'tasks-unavailable': 'Task status is not available. Try again when the workspace is ready.',
  'fullscreen-timeout': 'Could not leave full screen. Leave full screen and try again.',
}

export function updateCopy(view) {
  const { presentation: state, failed } = view
  if (failed || state === undefined) return { label: t('Retry update'), detail: t('Retry update') }
  const label = {
    idle: '',
    checking: t('Checking for updates…'),
    available: t('New version'),
    downloading: t('{percent}%', { percent: state.percent ?? 0 }),
    verifying: t('Verifying the update…'),
    installing: t('Getting ready to restart…'),
    ready: t('Install and restart'),
    error: t('Retry update'),
  }[state.phase] ?? ''
  if (state.phase === 'checking' || state.phase === 'verifying' || state.phase === 'installing') return { label, detail: state.version ?? label }
  if (state.phase === 'error') return { label, detail: t(FAILURES[state.failure ?? 'install'] ?? FAILURES.install) }
  if (state.phase === 'downloading' && state.version !== undefined) return { label, detail: t('Downloading the update: {percent}%, version {version}', { percent: state.percent ?? 0, version: state.version }) }
  return { label, detail: state.version === undefined ? label : t('{label}: {version}', { label, version: state.version }) }
}

const updateShown = view => view.failed || (view.presentation !== undefined && view.presentation.phase !== 'idle')

function DesktopUpdatePill({ view, hidden, onOpen }) {
  if (hidden || !updateShown(view)) return null
  const copy = updateCopy(view)
  const error = view.failed || view.presentation?.phase === 'error'
  const busy = view.opening || BUSY_PHASES.has(view.presentation?.phase)
  return h(Tooltip, { label: copy.detail, side: 'top' },
    h('button', { type: 'button', className: 'bt-dsh-update', 'aria-label': copy.label, 'aria-disabled': busy, onClick: () => { if (!busy) onOpen() } },
      h('span', { className: 'bt-dsh-update-icon', 'aria-hidden': true },
        error ? h('span', { className: 'bt-dsh-update-dot' }) : busy ? h(IconLoadingOutlineRegular, { size: 14, className: 'bt-spin' }) : h(IconDownloadOutlineRegular, { size: 14 })),
      h('span', null, copy.label)))
}

// The collapsed sidebar's expand button carries the same update status as a dot.
export function DesktopUpdateBadge({ useDesktopUpdate, useConnectionState }) {
  const view = useDesktopUpdate(value => value)
  const connection = useConnectionState(value => value)
  if (((connection === 'disconnected' || connection === 'connecting') && view.presentation?.phase !== 'installing') || !updateShown(view)) return null
  const copy = updateCopy(view)
  return h(Tooltip, { label: copy.detail, side: 'right' }, h('span', { role: 'img', 'aria-label': copy.label, className: 'bt-dsh-update-badge' }))
}

// The trigger's own content where no Bot surface puts the whale there (Agent mode).
export function TriggerContent({ wide }) {
  return h(Fragment, null, h(GearIcon), wide ? h('span', { className: 'bt-settings-trigger-label' }, t('Settings')) : null)
}

export function SettingsShell(props) {
  const {
    wide, renderSlot, actions, useUi, useRoster, useUpdate, useSessions,
    useSections, useGeneralItems, useOnboardingSteps, useOnboardingRequest,
    useConnectionState, useDesktopUpdate, useSettingsShortcut,
    reconnect, openDesktopUpdate, openOnboarding, finishOnboarding,
  } = props
  const settings = useUi(state => state.settings)
  const roster = useRoster(value => value)
  const sections = useSections(rows => rows)
  const items = useGeneralItems(rows => rows)
  const steps = useOnboardingSteps(rows => rows)
  const requested = useOnboardingRequest(value => value)
  const connection = useConnectionState(value => value)
  const update = useDesktopUpdate(value => value)
  const shortcut = useSettingsShortcut(value => value)
  const active = useSessions(onboardingActive)
  const [completed, setCompleted] = useState(() => new Set())
  useEffect(() => { if (!active) setCompleted(new Set()) }, [active])
  const step = pickStep({ steps, requested, active, completed })
  // A step that appears takes over from an open Settings dialog.
  const seen = useRef(step)
  useEffect(() => {
    const appeared = seen.current === undefined && step !== undefined
    seen.current = step
    if (appeared && settings) actions.closeSettings()
  }, [step, settings])
  const complete = (id) => {
    finishOnboarding()
    setCompleted(previous => (previous.has(id) ? previous : new Set([...previous, id])))
  }
  const indicator = useConnectionView(connection)
  const installing = update.presentation?.phase === 'installing'
  const [kept, leaving] = useLinger(settings, DIALOG_EXIT_MS)
  const open = settings !== null && settings !== undefined
  const openSettings = () => actions.openSettings('general')
  return h(Fragment, null,
    h('div', { className: 'bt-settings-row', 'data-rail': wide ? undefined : '' },
      renderSlot('settings.launcher', {
        wide, settingsOpen: open, openSettings, openOnboarding,
        ...(shortcut?.keys?.length ? { settingsShortcut: { keys: shortcut.keys, aria: shortcut.aria } } : {}),
      }, {
        fallback: h(Tooltip, { disabled: open, label: t('Settings'), shortcutKeys: shortcut?.keys },
          h('button', {
            type: 'button', className: 'bt-settings-trigger', 'aria-label': t('Settings'), 'aria-keyshortcuts': shortcut?.aria,
            'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: openSettings,
          }, renderSlot('settings.trigger', { wide }))),
      }),
      h(ConnectionIndicator, {
        state: wide && !installing ? indicator : undefined,
        disconnectedLabel: t('Connection lost. Refresh to retry'),
        connectingLabel: t('Reconnecting'),
        recoveredLabel: t('Connected'),
        reconnectActionLabel: t('Connection lost. Reconnect now'),
        restartActionLabel: t('Connection dropped and retrying. Reconnect now'),
        onReconnect: reconnect,
      }),
      wide ? h(DesktopUpdatePill, { view: update, hidden: indicator !== undefined && !installing, onOpen: openDesktopUpdate }) : null),
    kept ? createPortal(h(SettingsDialog, {
      page: kept.page, id: kept.id, roster, actions, useUpdate, leaving,
      dsh: { sections, items, renderSlot },
    }), document.body) : null,
    step !== undefined ? renderSlot('settings.onboarding', {
      stepId: step.id, explicit: requested !== undefined, complete: () => complete(step.id),
      openSection: (id) => { finishOnboarding(); actions.openSettings(...settingsPlace(id)) },
    }, { only: step.id }) : null)
}

// Where one of DSH's section ids opens in DS Bot's Settings.
export function settingsPlace(id) {
  if (id === 'general') return ['general']
  if (id === 'models') return ['models']
  return ['dsh', id]
}

// The Host now runs another release than this page: reload, or keep the page.
function transitionText(from, to, unknown) {
  const field = from?.version !== to?.version ? 'version' : 'commit'
  return [from?.[field] ?? unknown, to?.[field] ?? unknown]
}

function Transition({ label, from, to, done }) {
  return h(Fragment, null,
    h('span', { className: 'bt-release-label' }, label),
    h('span', { className: `bt-release-name${done ? ' bt-release-faded' : ''}` }, from),
    h('span', { 'aria-hidden': true, className: `bt-release-line${done ? ' bt-release-done' : ''}` }),
    h('span', { className: `bt-release-name${done ? '' : ' bt-release-faded'}` }, to))
}

export function HostReleasePrompt({ useReleaseChange, dismissRelease, reloadPage }) {
  const change = useReleaseChange(value => value)
  if (change === undefined || change === null) return null
  const unknown = t('Unknown')
  const [serviceFrom, serviceTo] = transitionText(change.previous, change.host, unknown)
  const [pageFrom, pageTo] = transitionText(change.page, change.host, unknown)
  return h(Modal, {
    open: true, title: t('The service version changed'),
    description: t('This page paused live updates. Reload to load the new version.'),
    closeLabel: t('Not now'), onClose: dismissRelease, className: 'bt-release',
    footer: h(Fragment, null,
      h(Button, { variant: 'outline', 'data-modal-autofocus': true, onClick: dismissRelease }, t('Not now')),
      h(Button, { variant: 'primary', onClick: reloadPage }, t('Reload to load the new version'))),
  }, h('div', { className: 'bt-release-grid' },
    h(Transition, { label: t('Service'), from: serviceFrom, to: serviceTo, done: true }),
    h(Transition, { label: t('Page'), from: pageFrom, to: pageTo, done: false })))
}

// The local settings file opens in the system's text editor; only a loopback page offers it.
export function OpenDocumentAction({ useDocument, openDocument, loadDocument }) {
  const state = useDocument(value => value)
  useEffect(() => { loadDocument() }, [])
  if (state.status !== 'ready') return null
  return h('div', { className: 'bt-doc-action' },
    state.error ? h('span', { className: 'bt-danger bt-set-hint', role: 'alert' }, t('Could not open the settings file')) : null,
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: state.opening, onClick: openDocument }, t('Open settings file')))
}

export function documentSource(describe, openRemote) {
  const store = snapshotStore({ status: 'idle', opening: false, error: null })
  let following = null
  const derive = () => {
    const mirrored = describe.getSnapshot()
    if (mirrored.view === undefined) {
      if (mirrored.error !== null && mirrored.error !== undefined) store.set(state => ({ ...state, status: 'unavailable', error: mirrored.error }))
      return
    }
    store.set(state => ({ ...state, status: mirrored.view.hasDocument ? 'ready' : 'unavailable', error: null }))
  }
  return {
    store,
    load: async () => {
      following ??= describe.subscribe(derive)
      store.set(state => ({ ...state, status: state.status === 'ready' ? 'ready' : 'loading', error: null }))
      await describe.ensure()
      derive()
    },
    open: async () => {
      const current = store.getSnapshot()
      if (current.status !== 'ready' || current.opening) return
      store.set(state => ({ ...state, opening: true, error: null }))
      try {
        const result = await openRemote()
        if (!result.ok) store.set(state => ({ ...state, error: result.error?.message ?? 'failed' }))
      } catch (error) {
        store.set(state => ({ ...state, error: String(error?.message ?? error) }))
      } finally {
        store.set(state => ({ ...state, opening: false }))
      }
    },
    dispose: () => { following?.(); following = null },
  }
}

// The code work view switch: the shared `ui-settings.enabled` preference.
export function DeveloperToolsRow({ useDeveloperTools, setEnabled }) {
  const enabled = useDeveloperTools(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, t('Show code work view')),
      failed ? h('span', { className: 'bt-set-hint bt-danger', role: 'alert' }, t('Could not save. Try again.')) : null),
    h('div', { className: 'bt-set-control' }, h(Switch, {
      label: t('Show code work view'), on: enabled === true, disabled: busy || enabled === undefined,
      onChange: (next) => {
        setBusy(true)
        setFailed(false)
        Promise.resolve(setEnabled(next)).catch(() => setFailed(true)).finally(() => setBusy(false))
      },
    })))
}

// Registers the seat and its companions. `face` is DS Bot's own injected face; the
// returned `openOnboarding` reaches a registered onboarding step by id.
export function installSettingsShell(ctx, { face, actions, ui, held }) {
  const slots = ctx.slots
  const locale = () => ctx.get('locale')
  const request = snapshotStore(undefined)
  const openOnboarding = (id) => { actions.closeSettings(); request.set(id) }
  const finishOnboarding = () => request.set(undefined)
  const carrier = globalThis.dshDesktop
  const update = desktopUpdateSource(carrier?.protocolVersion === 1 ? carrier.updates : undefined)
  // Connection and shortcuts are read lazily: the shell outlets mount after both exist.
  const connectionState = {
    getSnapshot: () => ctx.get('connection')?.state.getSnapshot(),
    subscribe: listener => ctx.get('connection')?.state.subscribe(listener) ?? (() => {}),
  }
  const settingsShortcut = {
    getSnapshot: () => ctx.get('shortcuts')?.catalog.getSnapshot().find(row => row.id === 'settings.open'),
    subscribe: listener => ctx.get('shortcuts')?.catalog.subscribe(listener) ?? (() => {}),
  }
  const sections = ledgerSource(slots, locale, 'settings.section', sectionRows)
  const items = ledgerSource(slots, locale, 'settings.general.item', itemRows)
  const steps = ledgerSource(slots, locale, 'settings.onboarding', stepRows)
  const shellFace = () => {
    const base = face()
    return {
      ...base,
      reconnect: () => ctx.get('connection')?.reconnect(),
      openDesktopUpdate: () => update.open(),
      openOnboarding,
      finishOnboarding,
      hooks: {
        ...base.hooks,
        sections, generalItems: items, onboardingSteps: steps, onboardingRequest: request,
        connectionState, desktopUpdate: update.store, settingsShortcut,
      },
    }
  }
  const disposers = [
    () => update.dispose(),
    // A profile that turned DSH's shell back on keeps it: the seat's child slots are then
    // declared already, and DS Bot's dialog stays on its own pages.
    slots.inject('sidebar.settings', () => {
      try {
        const off = slots.register({ name: 'sidebar.settings', inject: shellFace, children: SETTINGS_CHILDREN }, SettingsShell)
        held?.set(true)
        return () => { held?.set(false); off() }
      } catch (error) {
        console.warn('[ds-bot] DSH settings shell is on; DS Bot settings show its own pages only', error)
        return () => {}
      }
    }),
    slots.inject('settings.trigger', () => slots.register({ name: 'settings.trigger' }, TriggerContent)),
  ]
  if (carrier?.protocolVersion === 1) {
    disposers.push(slots.inject('sidebar.toggle.badge', () => slots.register({
      name: 'sidebar.toggle.badge', inject: () => ({ hooks: { desktopUpdate: update.store, connectionState } }),
    }, DesktopUpdateBadge)))
  }
  const fibers = [
    ctx.inject(['shortcuts'], (scope) => {
      scope.effect(() => scope.shortcuts.register({
        id: 'settings.open',
        label: () => t('Open settings'),
        aliases: ['settings', 'preferences'],
        defaults: {
          'desktop:macos': { code: 'Comma', modifiers: ['primary'] },
          'desktop:windows': { code: 'Comma', modifiers: ['primary'] },
          'desktop:linux': { code: 'Comma', modifiers: ['primary'] },
          'web:macos': { code: 'Comma', modifiers: ['primary', 'alt'] },
          'web:windows': { code: 'Comma', modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable', 'terminal'],
        modals: ['settings'],
        resolve: ({ modal }) => {
          if (ui.getSnapshot().settings) return { status: 'handled', run: () => actions.closeSettings() }
          if (modal !== null && modal !== 'settings') return { status: 'blocked', reason: 'modal' }
          return { status: 'handled', run: () => actions.openSettings('general') }
        },
      }), 'ds-bot: settings command')
    }),
    ctx.inject(['modules'], (scope) => {
      scope.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay', id: 'host-release-change',
        inject: () => ({
          dismissRelease: () => scope.modules.entries.dismissRelease(),
          reloadPage: () => globalThis.location.reload(),
          hooks: { releaseChange: scope.modules.entries.releaseChange },
        }),
      }, HostReleasePrompt)), 'ds-bot: host release prompt')
    }),
    ctx.inject(['configForms'], (scope) => {
      scope.effect(() => slots.inject('settings.general.item', () => slots.register({
        name: 'settings.general.item', id: 'developer-tools', order: 15,
        inject: () => ({
          hooks: { developerTools: scope.configForms.developerTools.enabled },
          setEnabled: async (enabled) => {
            const form = scope.configForms.get('ui-settings')
            const previous = form.getSnapshot().value?.enabled
            const timestamp = Date.now()
            await scope.configForms.developerTools.setEnabled(enabled)
            if (previous !== undefined && previous !== enabled && form.getSnapshot().value?.enabled === enabled) {
              ctx.get('productAnalytics')?.track('code_work_view_toggle', { is_enabled: enabled }, timestamp)
            }
          },
        }),
      }, DeveloperToolsRow)), 'ds-bot: code work view row')
    }),
    ctx.inject(['remote', 'remote.settings', 'configForms'], (scope) => {
      if (!scope.remote.$host?.isLoopback) return
      scope.effect(() => {
        const doc = documentSource(scope.configForms.describe(), () => scope.remote.settings.openSettingsDocument())
        const off = slots.inject('settings.action', () => slots.register({
          name: 'settings.action', id: 'open-document', order: 0,
          inject: () => ({ hooks: { document: doc.store }, openDocument: () => { void doc.open() }, loadDocument: () => { void doc.load() } }),
        }, OpenDocumentAction))
        return () => { off(); doc.dispose() }
      }, 'ds-bot: settings file action')
    }),
  ]
  return {
    openOnboarding,
    dispose: () => {
      for (const fiber of fibers) fiber.dispose()
      for (const off of disposers) off()
    },
  }
}

export const SETTINGS_SHELL_CSS = `
.bt-settings-row{display:flex;align-items:center;gap:6px;min-width:0}
.bt-settings-row[data-rail]{flex-direction:column}
.bt-settings-trigger{display:inline-flex;align-items:center;gap:8px;height:32px;min-width:32px;padding:0 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;cursor:pointer}
.bt-settings-trigger:hover{background:var(--bt-hover)}
.bt-settings-trigger svg{width:16px;height:16px;flex:none}
.bt-settings-trigger-label{white-space:nowrap;overflow:hidden}
.bt-dsh-update{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--bt-accent);border-radius:8px;background:none;color:var(--bt-accent);font:inherit;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer}
.bt-dsh-update[aria-disabled=true]{cursor:default}
.bt-dsh-update-icon{display:inline-flex;width:14px;justify-content:center}
.bt-dsh-update-dot,.bt-dsh-update-badge{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--bt-accent)}
.bt-spin{animation:bt-spin 1s linear infinite}
@keyframes bt-spin{to{transform:rotate(360deg)}}
.bt-doc-action{display:flex;align-items:center;gap:8px;min-width:0}
.bt-doc-action .bt-set-hint{max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-release{width:min(480px,100%)}
.bt-release-grid{display:grid;grid-template-columns:max-content minmax(0,max-content) 56px minmax(0,max-content);align-items:center;gap:8px 12px;font-size:13px;line-height:20px}
.bt-release-label{color:var(--bt-ink-2)}
.bt-release-name{font-family:var(--ds-font-family-code,monospace);overflow-wrap:anywhere}
.bt-release-faded{opacity:.5}
.bt-release-line{position:relative;height:0;border-top:1px dashed currentColor;opacity:.5}
.bt-release-line.bt-release-done{border-top-style:solid;color:var(--bt-green);opacity:1}
`
