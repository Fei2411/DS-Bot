import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon } from './icons.js'
import { Caret, useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'
import { createReader, presetRows, presetState } from './agent-preset.js'

// The profile's Agent presets. The directory belongs to the view that asks for it:
// the picker shows the same one the Bot's hint reads, and opening the picker asks
// again because the profile's presets can change at any time.
export function useAgentPresets(actions) {
  const [state, setState] = useState({ presets: null, error: '' })
  const ask = actions?.presets
  const live = useRef(true)
  const reader = useMemo(() => (typeof ask === 'function' ? createReader(ask) : undefined), [ask])
  // A result that arrives after the view is gone changes nothing.
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const refresh = useCallback(async () => {
    if (reader === undefined) return undefined
    const answer = await reader()
    if (answer === undefined || !live.current) return undefined
    setState(answer)
    return answer
  }, [reader])
  useEffect(() => { void refresh() }, [refresh])
  return { ...state, refresh }
}

// One row of the picker: the preset's name, what it is, and whether it is the one
// the Bot runs on. A broken preset cannot be picked and says why.
function presetRow(row, current, pick) {
  return h('button', {
    key: row.id ?? 'default', type: 'button', role: 'menuitemradio', 'aria-checked': row.id === current,
    className: 'bt-preset-item', disabled: row.disabled,
    'data-broken': row.broken !== undefined || undefined, 'data-missing': row.missing || undefined,
    title: row.description ?? undefined, onClick: () => pick(row.id),
  },
  h('span', { className: 'bt-preset-copy' },
    h('span', { className: 'bt-preset-name' }, row.name),
    row.description ? h('span', { className: 'bt-preset-desc' }, row.description) : null),
  h('span', { className: 'bt-model-tick', 'aria-hidden': true }, row.id === current ? h(CheckIcon) : null))
}

// The Agent preset a Bot runs on: the default, or one preset from the profile's
// directory. A broken preset cannot be picked and says why; a preset the profile
// no longer serves stays visible as missing, and the default clears it.
export function AgentPresetMenu({ value, presets = null, error = '', onRefresh, onPick, wide = false, disabled = false }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const state = presetState(value, presets)
  const rows = presetRows(value, presets)
  const current = state.id
  const toggle = () => {
    if (isOpen) { close(); return }
    // The profile's presets can change at any time, so opening asks again.
    void onRefresh?.()
    open()
  }
  const pick = (id) => {
    close()
    const next = typeof id === 'string' && id !== '' ? id : null
    if (next !== current) onPick(next)
  }
  // The menu's own children: the failure first, then the presets, then the retry.
  const children = [
    error ? h('div', { className: 'bt-preset-error', role: 'alert' }, t('The preset list could not be loaded.')) : null,
    h('div', { className: 'bt-model-scroll' }, rows.map(row => presetRow(row, current, pick))),
    error ? h('div', { className: 'bt-model-foot' },
      h('button', { type: 'button', role: 'menuitem', onClick: () => { void onRefresh?.() } }, t('Try again'))) : null,
  ]
  const node = h('div', {
    ref: menu, className: `bt-menu bt-model-menu bt-preset-menu${shownPlace?.bottom !== undefined ? ' bt-menu-up' : ''}`,
    role: 'menu', 'aria-label': t('Agent preset'), style: shownPlace, 'data-leaving': leaving || undefined,
  }, children)
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger bt-preset-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': t('Agent preset: {preset}', { preset: state.name }),
      'data-missing': state.missing || undefined, 'data-error': error || undefined, onClick: toggle, disabled,
    },
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, state.name),
      state.id === null ? null : h('span', { className: 'bt-model-provider' }, state.description ?? state.id)),
    h(Caret)),
    // The menu lives in the document, so it is not cut off by the panel it opens from.
    shownPlace ? createPortal(node, document.body) : null)
}

export const AGENT_PRESET_CSS = `
.bt-menu .bt-preset-item{min-height:38px;padding:7px 8px;gap:8px}
.bt-preset-copy{flex:1;display:flex;flex-direction:column;min-width:0;gap:1px}
.bt-preset-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-preset-desc{font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-preset-error{padding:8px;font-size:12px;line-height:16px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-menu .bt-preset-item:disabled{cursor:default;opacity:.6}
.bt-menu .bt-preset-item:disabled:hover{background:none}
.bt-menu .bt-preset-item[data-broken] .bt-preset-name,.bt-menu .bt-preset-item[data-missing] .bt-preset-name{color:var(--bt-danger)}
.bt-menu .bt-preset-item[data-broken] .bt-preset-desc{color:var(--bt-danger)}
.bt-preset-trigger[data-missing] .bt-model-name,.bt-preset-trigger[data-error] .bt-model-name{color:var(--bt-danger)}
`
