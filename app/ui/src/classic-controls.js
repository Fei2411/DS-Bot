// Classic Agent session controls inside the composer footer:
//   - Model & thinking level selector (reusing DS Bot's `ModelMenu` visual language)
//   - Permission preset selector (with risk confirmation for Full access & Auto review)
//   - Active Plan mode chip with one-click exit
import { createElement as h, Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, CloseIcon, ShieldIcon } from '../../../ds-bot/src/client/icons.js'
import { Caret, ModelMenu, useAnchoredMenu } from '../../../ds-bot/src/client/model-menu.js'
import { useLinger } from '../../../ds-bot/src/client/motion.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'

const PRESET_LABELS = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace',
  'danger-full-access': 'Full access',
  auto: 'Auto review',
  custom: 'Custom',
}

const PRESET_DESCRIPTIONS = {
  'read-only': 'Read files without editing',
  'workspace-write': 'Edit inside the workspace; wider actions ask',
  'danger-full-access': 'Run commands and edit files without asking',
  auto: 'Model reviews actions for this session only',
}

const RISKY_PRESETS = new Set(['danger-full-access', 'auto'])

export function classicPresetLabel(value, options) {
  if (PRESET_LABELS[value]) return t(PRESET_LABELS[value])
  const found = (options ?? []).find(opt => opt.value === value)
  return found?.name ?? value ?? ''
}

function classicPresetDescription(opt) {
  if (opt?.value && PRESET_DESCRIPTIONS[opt.value]) return t(PRESET_DESCRIPTIONS[opt.value])
  return opt?.description ?? ''
}

// Original minimal permission icons drawn on the 20x20 stroke grid used by ds-bot/icons.js.
function ReadOnlyIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 4.5, y: 9, width: 11, height: 8, rx: 2 }),
    h('path', { d: 'M7 9V6.8a3 3 0 0 1 6 0V9' }))
}

function WorkspaceIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M10 2.75l6 2.5v4.5c0 3.7-2.55 6.45-6 7.5-3.45-1.05-6-3.8-6-7.5v-4.5z' }),
    h('path', { d: 'M7.5 10.25l1.75 1.75 3.25-3.5' }))
}

function AutoReviewIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z' }))
}

function FullAccessIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M10 3.2L17 15.8H3z' }),
    h('path', { d: 'M10 8v3.6M10 13.8h.01' }))
}

export function PlanModeIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 4, y: 3.5, width: 12, height: 13, rx: 2 }),
    h('path', { d: 'M7 7.5h6M7 10.5h6M7 13.5h3.5' }))
}

function presetIcon(value) {
  if (value === 'read-only') return h(ReadOnlyIcon)
  if (value === 'workspace-write') return h(WorkspaceIcon)
  if (value === 'auto') return h(AutoReviewIcon)
  if (value === 'danger-full-access') return h(FullAccessIcon)
  return h(ShieldIcon)
}

function RiskConfirmDialog({ preset, busy, error, onConfirm, onCancel }) {
  const [shown, leaving] = useLinger(preset, 160)
  const [ack, setAck] = useState(false)
  const titleId = useId()
  const descId = useId()
  const cancelRef = useRef(null)
  const previousFocus = useRef(null)

  useEffect(() => {
    if (!preset) return undefined
    setAck(false)
    previousFocus.current = typeof document !== 'undefined' ? document.activeElement : null
    cancelRef.current?.focus?.()
    return () => {
      const prev = previousFocus.current
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus()
    }
  }, [preset])

  useEscape(() => { if (!busy) onCancel() }, Boolean(preset), { priority: 30 })

  if (!shown) return null
  const isFull = shown === 'danger-full-access'
  const title = isFull ? t('Switch to Full access?') : t('Switch to Auto review?')
  const body = isFull
    ? t('Full access lets the agent run commands and edit files outside this workspace without asking.')
    : t('Auto review uses a model to review actions for this session only.')

  const dialog = h('div', {
    className: 'dsb-risk-layer',
    role: 'presentation',
    'data-leaving': leaving ? '' : undefined,
    onMouseDown: (event) => { if (event.target === event.currentTarget && !busy && !leaving) onCancel() },
  },
  h('div', {
    className: 'dsb-risk-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': descId,
    'data-danger': isFull ? '' : undefined,
  },
  h('div', { className: 'dsb-risk-head' },
    h('span', { className: 'dsb-risk-ico', 'aria-hidden': true }, presetIcon(shown)),
    h('h3', { id: titleId, className: 'dsb-risk-title' }, title)),
  h('p', { id: descId, className: 'dsb-risk-body' }, body),
  h('label', { className: 'dsb-risk-check' },
    h('input', {
      type: 'checkbox',
      checked: ack,
      disabled: busy || leaving,
      onChange: event => setAck(event.target.checked),
    }),
    h('span', null, t('I understand the risks'))),
  error ? h('p', { className: 'dsb-risk-error', role: 'alert' }, error) : null,
  h('div', { className: 'dsb-risk-foot' },
    h('button', {
      ref: cancelRef,
      type: 'button',
      className: 'bt-q-btn',
      disabled: busy || leaving,
      onClick: onCancel,
    }, t('Cancel')),
    h('button', {
      type: 'button',
      className: isFull ? 'bt-q-submit dsb-risk-danger-btn' : 'bt-q-submit',
      disabled: !ack || busy || leaving,
      onClick: () => onConfirm(shown),
    }, t('Switch preset')))))

  return typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog
}

export function ClassicPermissionMenu({ sessionId, permission, disabled, actions, onUpdated }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu(264, 'left')
  const [confirmPreset, setConfirmPreset] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = permission?.options ?? []
  const current = permission?.current ?? permission?.defaultPreset ?? ''

  if (!permission || options.length === 0) return null

  const currentLabel = classicPresetLabel(current, options)
  const isDanger = current === 'danger-full-access'
  const isAuto = current === 'auto'

  const applyPreset = async (preset) => {
    if (busy || disabled) return
    setBusy(true)
    setError('')
    try {
      const next = await actions.setSessionPermission?.(sessionId, preset)
      setConfirmPreset(null)
      if (next) onUpdated?.(next)
    } catch (failure) {
      const msg = failure?.message ?? t('Couldn’t update permission')
      if (confirmPreset) setError(msg)
      else actions?.reportError?.(failure, 'session-permission')
    } finally {
      setBusy(false)
    }
  }

  const pick = (value) => {
    close()
    if (value === current || disabled || busy) return
    if (RISKY_PRESETS.has(value)) {
      setError('')
      setConfirmPreset(value)
      return
    }
    void applyPreset(value)
  }

  return h(Fragment, null,
    h('button', {
      ref: button,
      type: 'button',
      className: 'dsb-ctl-btn dsb-perm-btn',
      disabled: disabled || busy,
      'aria-haspopup': 'menu',
      'aria-expanded': isOpen,
      'aria-label': t('Permission: {preset}', { preset: currentLabel }),
      title: t('Permission: {preset}', { preset: currentLabel }),
      'data-danger': isDanger ? '' : undefined,
      'data-auto': isAuto ? '' : undefined,
      onClick: () => { if (!disabled && !busy) { if (isOpen) close(); else open() } },
    },
    h('span', { className: 'dsb-ctl-ico', 'aria-hidden': true }, presetIcon(current)),
    h('span', { className: 'dsb-ctl-label' }, currentLabel),
    h(Caret)),
    shownPlace ? createPortal(h('div', {
      ref: menu,
      className: `bt-menu dsb-perm-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu',
      'aria-label': t('Permission preset'),
      style: shownPlace,
      'data-leaving': leaving || undefined,
    }, options.map((opt) => {
      const selected = opt.value === current
      const label = classicPresetLabel(opt.value, options)
      const description = classicPresetDescription(opt)
      return h('button', {
        key: opt.value,
        type: 'button',
        role: 'menuitemradio',
        className: 'dsb-perm-row',
        'aria-checked': selected,
        'data-danger': opt.value === 'danger-full-access' ? '' : undefined,
        onClick: () => pick(opt.value),
      },
      h('span', { className: 'dsb-perm-row-ico', 'aria-hidden': true }, presetIcon(opt.value)),
      h('span', { className: 'dsb-perm-row-text' },
        h('span', { className: 'dsb-perm-row-head' },
          h('span', { className: 'bt-menu-label' }, label),
          opt.value === 'auto' ? h('span', { className: 'dsb-perm-badge' }, t('Session only')) : null),
        description ? h('span', { className: 'dsb-perm-row-desc' }, description) : null),
      h('span', { className: 'bt-model-tick', 'aria-hidden': true }, selected ? h(CheckIcon) : null))
    })), document.body) : null,
    h(RiskConfirmDialog, {
      preset: confirmPreset,
      busy,
      error,
      onConfirm: value => { void applyPreset(value) },
      onCancel: () => { setConfirmPreset(null); setError('') },
    }))
}

export function ClassicPlanChip({ sessionId, plan, disabled, actions, onUpdated }) {
  const [busy, setBusy] = useState(false)
  const effectiveActive = plan ? (plan.pending ? !plan.active : plan.active) : false
  if (!plan || (!plan.active && !plan.pending)) return null
  const label = plan.pending
    ? (plan.active ? t('Leaving plan mode…') : t('Entering plan mode…'))
    : t('Plan mode')

  const exitPlan = async () => {
    if (disabled || busy) return
    setBusy(true)
    try {
      const res = await actions?.runSessionCommand?.(sessionId, '/plan off')
      if (res?.controls) onUpdated?.(res.controls)
    } catch (error) {
      actions?.reportError?.(error, 'plan-mode')
    } finally {
      setBusy(false)
    }
  }

  return h('div', {
    className: 'dsb-plan-chip',
    'data-pending': plan.pending ? '' : undefined,
  },
  h('span', { className: 'dsb-plan-chip-ico', 'aria-hidden': true }, h(PlanModeIcon)),
  h('span', { className: 'dsb-plan-chip-text' }, label),
  effectiveActive ? h('button', {
    type: 'button',
    className: 'dsb-plan-chip-x',
    disabled: disabled || busy,
    'aria-label': t('Exit plan mode'),
    title: t('Exit plan mode'),
    onClick: () => { void exitPlan() },
  }, h(CloseIcon)) : null)
}

export function ClassicControls({ sessionId, controls, roster, actions, disabled, onUpdated }) {
  const [savingModel, setSavingModel] = useState(false)
  const modelRef = controls?.model?.ref ?? undefined
  const modelEffort = controls?.model?.effort ?? undefined
  const syntheticBot = useMemo(() => ({
    id: sessionId,
    name: 'DSH Agent',
    model: modelRef,
    effort: modelEffort,
  }), [sessionId, modelRef, modelEffort])

  // Merge session-fetched reasoning info into the model catalog entry if the catalog omitted it.
  const effectiveRoster = useMemo(() => {
    const reasoning = controls?.model?.reasoning
    if (!reasoning || !modelRef || !Array.isArray(roster?.models)) return roster
    let changed = false
    const models = roster.models.map((entry) => {
      if (entry?.ref !== modelRef || entry.reasoning) return entry
      changed = true
      return { ...entry, reasoning }
    })
    return changed ? { ...roster, models } : roster
  }, [roster, controls?.model?.reasoning, modelRef])

  const pickModel = async (ref) => {
    if (disabled || savingModel || typeof actions?.selectSessionModel !== 'function') return
    setSavingModel(true)
    try {
      const next = await actions.selectSessionModel(sessionId, ref)
      if (next) onUpdated?.(next)
    } catch (error) {
      actions?.reportError?.(error, 'session-model')
    } finally {
      setSavingModel(false)
    }
  }

  // `EffortBar` serializes writes itself and expects a `Promise<boolean>` (rolling back on `false`),
  // passing `undefined` when the user resets to Default (encoded on the wire as `effort: null`).
  const pickEffort = async (effort) => {
    if (disabled || typeof actions?.selectSessionModel !== 'function') return false
    try {
      const next = await actions.selectSessionModel(sessionId, modelRef, effort ?? null)
      if (next) onUpdated?.(next)
      return true
    } catch (error) {
      actions?.reportError?.(error, 'session-model')
      return false
    }
  }

  return h('div', { className: 'dsb-classic-controls', 'data-classic-controls': '' },
    h(ModelMenu, {
      bot: syntheticBot,
      roster: effectiveRoster,
      actions,
      compact: true,
      align: 'left',
      disabled: disabled || savingModel,
      onPick: ref => { void pickModel(ref) },
      onPickEffort: pickEffort,
    }),
    h(ClassicPermissionMenu, {
      sessionId,
      permission: controls?.permission,
      disabled,
      actions,
      onUpdated,
    }),
    h(ClassicPlanChip, {
      sessionId,
      plan: controls?.plan,
      disabled,
      actions,
      onUpdated,
    }))
}
