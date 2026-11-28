import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon } from './icons.js'
import { Caret, useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'

const LABELS = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace',
  'danger-full-access': 'Full access',
  review: 'Review for me',
}
const DESCRIPTIONS = {
  'read-only': 'Read files only; changes require approval.',
  'workspace-write': 'Edit inside the workspace; wider access asks you.',
  review: 'Workspace access with model review; uncertain cases ask you.',
  'danger-full-access': 'Edit files and run commands without asking.',
}
const DANGER = new Set(['danger-full-access'])

export const presetDanger = value => DANGER.has(value)
export const presetName = (value, catalog) => (LABELS[value] ? t(LABELS[value]) : catalog?.options?.find(option => option.value === value)?.name ?? value)
export const presetDescription = option => (DESCRIPTIONS[option.value] ? t(DESCRIPTIONS[option.value]) : option.description)

// Original 15px stroke icons matching icons.js: lock for read-only, shield family for the rest.
function PresetIcon({ value }) {
  const props = { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (value === 'read-only') {
    return h('svg', props,
      h('rect', { x: 4.5, y: 9, width: 11, height: 8, rx: 1.5 }),
      h('path', { d: 'M6.75 9V6.75a3.25 3.25 0 0 1 6.5 0V9' }))
  }
  const shield = h('path', { d: 'M10 2.75l6 2.5v4.5c0 3.7-2.55 6.45-6 7.5-3.45-1.05-6-3.8-6-7.5v-4.5z' })
  if (value === 'review') return h('svg', props, shield, h('path', { d: 'M7.4 10.1l1.8 1.8 3.5-3.6' }))
  if (presetDanger(value)) return h('svg', props, shield, h('path', { d: 'M10 6.75v3.5' }), h('path', { d: 'M10 13.25h.01' }))
  return h('svg', props, shield)
}

// Keep non-danger presets in catalog order and group danger presets after a divider.
export function orderedPermissionOptions(options = []) {
  const safe = []
  const danger = []
  for (const option of options) {
    if (presetDanger(option.value)) danger.push(option)
    else safe.push(option)
  }
  return { safe, danger }
}

// The presets DeepSeek Harness offers, as an anchored menu picker matching Model and
// Working folder. A pick shows at once and holds until the saved value catches up, or
// falls back when `onPick` resolves false. `repick` lets the shown preset be picked again.
export function PermissionPicker({ catalog, saved, onPick, repick = false, wide = false, disabled = false }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu(wide ? 260 : 240)
  const [pending, setPending] = useState(null)
  // One save runs at a time. A pick made while one is in flight waits as `latest`
  // (newer ones overwrite it), so a request that settles cannot clear or reorder a
  // pick made after it; two saves never land out of order on the server.
  const flight = useRef({ value: undefined, latest: undefined })
  useEffect(() => {
    const flying = flight.current.value
    if (pending === saved && (flying === undefined || flying === pending)) setPending(null)
  }, [pending, saved])
  useEffect(() => { if (disabled && isOpen) close() }, [disabled, isOpen])
  const send = (value) => {
    flight.current.value = value
    void Promise.resolve(onPick(value)).then(done => done !== false, () => false).then((ok) => {
      const wanted = flight.current.latest
      flight.current.latest = undefined
      if (wanted !== undefined && !(wanted === value && ok)) { send(wanted); return }
      flight.current.value = undefined
      if (!ok) setPending(null)
    })
  }
  const current = pending ?? saved
  const currentLabel = presetName(current, catalog)
  const currentDanger = presetDanger(current)
  const pick = (value) => {
    close()
    button.current?.focus?.({ preventScroll: true })
    if (value === current && !repick) return
    setPending(value)
    if (flight.current.value !== undefined) { flight.current.latest = value; return }
    send(value)
  }
  const toggle = () => {
    if (disabled) return
    if (isOpen) close()
    else open()
  }
  const { safe, danger } = orderedPermissionOptions(catalog?.options)
  const renderOption = (option) => {
    const selected = option.value === current
    const isDanger = presetDanger(option.value)
    const description = presetDescription(option)
    return h('button', {
      key: option.value,
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': selected,
      className: 'bt-perm-item',
      'data-value': option.value,
      'data-danger': isDanger || undefined,
      title: description ?? option.description,
      onClick: () => pick(option.value),
    },
    h('span', { className: 'bt-perm-icon', 'aria-hidden': true }, h(PresetIcon, { value: option.value })),
    h('span', { className: 'bt-perm-copy' },
      h('span', { className: 'bt-perm-name' }, presetName(option.value, catalog)),
      description ? h('span', { className: 'bt-perm-desc' }, description) : null),
    h('span', { className: 'bt-model-tick', 'aria-hidden': true }, selected ? h(CheckIcon) : null))
  }
  const portalTarget = typeof document === 'undefined' ? null : document.body
  return h(Fragment, null,
    h('button', {
      ref: button,
      type: 'button',
      className: 'bt-model-trigger bt-perm-trigger',
      'data-wide': wide || undefined,
      'data-danger': currentDanger || undefined,
      'aria-haspopup': 'menu',
      'aria-expanded': isOpen,
      'aria-label': t('Permissions: {permission}', { permission: currentLabel }),
      disabled,
      onClick: toggle,
      onKeyDown: (event) => {
        if (!isOpen && !disabled && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          open()
        }
      },
    },
    h('span', { className: 'bt-perm-lead', 'aria-hidden': true }, h(PresetIcon, { value: current })),
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, currentLabel)),
    h(Caret)),
    shownPlace && portalTarget ? createPortal(h('div', {
      ref: menu,
      className: `bt-menu bt-model-menu bt-perm-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu',
      'aria-label': t('Permissions'),
      style: shownPlace,
      'data-leaving': leaving || undefined,
    }, h('div', { className: 'bt-model-scroll bt-perm-list' },
      safe.map(renderOption),
      safe.length > 0 && danger.length > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      danger.map(renderOption))), portalTarget) : null)
}

export const PERMISSION_CSS = `
.bt-drawer-permission .bt-model-trigger[data-wide]{width:100%;max-width:100%}
.bt-perm-trigger{gap:8px}
.bt-perm-lead{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2);transition:color .12s ease}
.bt-perm-trigger:hover .bt-perm-lead,.bt-perm-trigger[aria-expanded=true] .bt-perm-lead{color:var(--bt-ink)}
.bt-perm-trigger[data-danger]{color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 30%,var(--bt-line-2));background:color-mix(in srgb,var(--bt-danger) 7%,var(--bt-hover))}
.bt-perm-trigger[data-danger]:hover,.bt-perm-trigger[data-danger][aria-expanded=true]{background:color-mix(in srgb,var(--bt-danger) 12%,var(--bt-active))}
.bt-perm-trigger[data-danger] .bt-perm-lead,.bt-perm-trigger[data-danger]:hover .bt-perm-lead,.bt-perm-trigger[data-danger][aria-expanded=true] .bt-perm-lead{color:var(--bt-danger)}
.bt-perm-list{padding:6px;gap:2px}
.bt-menu .bt-perm-item{align-items:flex-start;min-height:40px;padding:7px 8px;gap:8px}
.bt-perm-icon{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2);transition:color .12s ease}
.bt-menu .bt-perm-item:hover .bt-perm-icon{color:var(--bt-ink)}
.bt-menu .bt-perm-item[aria-checked=true] .bt-perm-icon,.bt-menu .bt-perm-item[aria-checked=true] .bt-model-tick{color:var(--bt-accent)}
.bt-perm-copy{flex:1;display:flex;flex-direction:column;min-width:0;gap:1px}
.bt-perm-name{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-perm-desc{font-size:11px;line-height:15px;color:var(--bt-ink-3);white-space:normal;overflow-wrap:anywhere}
.bt-menu .bt-perm-item .bt-model-tick{margin-top:1px}
.bt-menu .bt-perm-item[data-danger] .bt-perm-icon,.bt-menu .bt-perm-item[data-danger] .bt-perm-name,.bt-menu .bt-perm-item[data-danger] .bt-model-tick{color:var(--bt-danger)}
.bt-menu .bt-perm-item[data-danger]:hover{background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
`
