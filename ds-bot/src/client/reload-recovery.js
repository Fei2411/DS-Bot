// Top-level confirmation dialog host for `requestWindowReload()`.
// Kept separate from `./reload-action.js` so pure-JS desktop helpers (`retryable-lazy.js`)
// never pull `react` across the `ds-bot/` package boundary when `ds-bot/node_modules` is absent.
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.js'
import { useLinger } from './motion.js'
import { useEscape, useModalFocusTrap } from './overlay-hooks.js'
import { registerReloadConfirmHost, requestWindowReload } from './reload-action.js'

export { requestWindowReload }

const WarningIcon = () => h('svg', {
  width: 16,
  height: 16,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
},
h('path', { d: 'M10 3.2 17.4 16a1.1 1.1 0 0 1-.95 1.65H3.55A1.1 1.1 0 0 1 2.6 16L10 3.2Z' }),
h('path', { d: 'M10 8v4' }),
h('circle', { cx: 10, cy: 14.5, r: 0.7, fill: 'currentColor', stroke: 'none' }))

/**
 * Top-level confirmation dialog host for `requestWindowReload()`.
 * Reuses DS Bot's standard confirmation dialog styling (`.dsb-risk-layer` / `.dsb-risk-dialog`).
 */
export function ReloadConfirmHost() {
  const [pending, setPending] = useState(null)
  const [shown, leaving] = useLinger(pending, 160)
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)

  useEffect(() => registerReloadConfirmHost((req) => { setPending(req) }), [])

  useModalFocusTrap(dialogRef, Boolean(pending), { initialFocusRef: cancelRef })

  const close = () => { setPending(null) }
  useEscape(close, Boolean(pending), { priority: 40 })

  if (!shown) return null

  const confirm = () => {
    const action = shown.confirm
    setPending(null)
    action?.()
  }

  const dialog = h('div', {
    className: 'dsb-risk-layer',
    role: 'presentation',
    'data-leaving': leaving ? '' : undefined,
    onMouseDown: (event) => { if (event.target === event.currentTarget && !leaving) close() },
  },
  h('div', {
    ref: dialogRef,
    className: 'dsb-risk-dialog',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': descId,
    'data-danger': '',
  },
  h('div', { className: 'dsb-risk-head' },
    h('span', { className: 'dsb-risk-ico', 'aria-hidden': true }, h(WarningIcon)),
    h('h3', { id: titleId, className: 'dsb-risk-title' }, t('Reload window?'))),
  h('p', { id: descId, className: 'dsb-risk-body' }, t('Unsent attachments will be removed.')),
  h('div', { className: 'dsb-risk-foot' },
    h('button', {
      ref: cancelRef,
      type: 'button',
      className: 'bt-q-btn',
      disabled: leaving,
      onClick: close,
    }, t('Cancel')),
    h('button', {
      type: 'button',
      className: 'bt-q-submit dsb-risk-danger-btn',
      disabled: leaving,
      onClick: confirm,
    }, t('Reload window')))))

  return typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog
}
