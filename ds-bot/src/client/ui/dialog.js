// Canonical centered Modal Dialog carrier (`Dialog`, `DIALOG_CSS`).
//
// Every centered dialog automatically gets:
// - Backdrop scrim with frameless-window top drag band (`data-bt-dialog-mask`)
// - Escape priority stack (`useEscape`)
// - `SPRING_SHAPE` rise / sink entrance & exit (`[data-leaving]`)
// - Consistent focus & ARIA dialog semantics
import { createElement as h, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '../icons.js'
import { SPRING_SHAPE, spring } from '../motion.js'
import { ESCAPE_PRIORITY, useEscape, useModalFocusTrap } from '../overlay-hooks.js'
import { t } from '../i18n.js'

export function Dialog({
  open = true,
  leaving = false,
  as = 'div',
  label = undefined,
  ariaLabelledBy = undefined,
  title = null,
  size = 'md',
  onClose = null,
  onSubmit = undefined,
  closeOnBackdrop = true,
  escapePriority = ESCAPE_PRIORITY.DIALOG,
  className = '',
  maskClassName = '',
  scrimClassName = '',
  dialogRef: externalRef = null,
  layerRef = null,
  ariaModal = true,
  autoFocus = true,
  focusTrap = false,
  initialFocusRef = null,
  portal = false,
  header = null,
  footer = null,
  dataAttrs = null,
  children = null,
}) {
  const internalRef = useRef(null)
  const ref = externalRef ?? internalRef
  const maskRef = useRef(null)
  const setMaskRef = (node) => {
    maskRef.current = node
    if (typeof layerRef === 'function') layerRef(node)
    else if (layerRef && typeof layerRef === 'object') layerRef.current = node
  }

  useEscape(() => { onClose?.() }, open && !leaving && typeof onClose === 'function', { priority: escapePriority })
  useModalFocusTrap(ref, open && !leaving && focusTrap, { initialFocusRef, isolateRootRef: maskRef })

  useEffect(() => {
    if (!open || leaving || !autoFocus || focusTrap) return
    ref.current?.focus?.({ preventScroll: true })
  }, [open, leaving, autoFocus, focusTrap, ref])

  if (!open && !leaving) return null

  const sizeClass = size === 'sm' ? 'bt-ui-dialog-sm' : size === 'lg' ? 'bt-ui-dialog-lg' : ''
  const dialogClasses = ['bt-ui-dialog', sizeClass, className].filter(Boolean).join(' ')
  const maskClasses = ['bt-ui-dialog-mask', maskClassName].filter(Boolean).join(' ')
  const handleBackdrop = () => {
    if (closeOnBackdrop && !leaving) onClose?.()
  }

  const node = h('div', {
    ref: setMaskRef,
    className: maskClasses,
    'data-bt-dialog-mask': '',
    'data-has-scrim': scrimClassName ? '' : undefined,
    'data-leaving': leaving ? '' : undefined,
    onMouseDown: !scrimClassName ? (event) => {
      if (event.button === 0 && event.target === event.currentTarget) handleBackdrop()
    } : undefined,
    onClick: !scrimClassName ? (event) => {
      if (event.target === event.currentTarget && event.detail === 0) handleBackdrop()
    } : undefined,
  },
  scrimClassName ? h('div', {
    className: scrimClassName,
    'data-bt-dialog-scrim': '',
    onClick: handleBackdrop,
  }) : null,
  h(as, {
    ref,
    tabIndex: -1,
    className: dialogClasses,
    role: 'dialog',
    'aria-modal': ariaModal ? true : undefined,
    'aria-label': label,
    'aria-labelledby': ariaLabelledBy,
    'data-leaving': leaving ? '' : undefined,
    onSubmit,
    ...dataAttrs,
  },
  header !== null
    ? header
    : (title !== null
        ? h('div', { className: 'bt-ui-dialog-head' },
            h('h2', { className: 'bt-ui-dialog-title' }, title),
            onClose ? h('button', {
              type: 'button',
              className: 'bt-icon-btn bt-ui-dialog-close',
              'aria-label': t('Close'),
              title: t('Close'),
              onClick: onClose,
            }, h(CloseIcon)) : null)
        : null),
  children,
  footer ? h('div', { className: 'bt-ui-dialog-foot' }, footer) : null))

  if (portal) {
    const target = typeof document !== 'undefined' && document?.body ? document.body : null
    return target ? createPortal(node, target) : node
  }
  return node
}

export const DIALOG_CSS = `
:where(.bt-ui-dialog-mask){position:fixed;inset:0;z-index:65;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32);box-sizing:border-box;animation:bt-veil-in .18s ease-out backwards}
:where(.bt-ui-dialog-mask[data-has-scrim]){background:transparent}
:where(.bt-ui-dialog-mask[data-leaving]){opacity:0;pointer-events:none;transition:opacity .16s ease}
:where(:is(html[data-windows-titlebar],html[data-platform=darwin]):not([data-fullscreen]) .bt-ui-dialog-mask){padding-top:max(20px,var(--bt-titlebar-h,var(--dsb-band,40px)))}
:where(:is(html[data-windows-titlebar],html[data-platform=darwin]):not([data-fullscreen]) .bt-ui-dialog-mask:not([data-has-scrim]))::before,:where(:is(html[data-windows-titlebar],html[data-platform=darwin]):not([data-fullscreen]) .bt-ui-dialog-mask[data-has-scrim]>[data-bt-dialog-scrim])::before{content:"";position:absolute;inset:0 0 auto;height:var(--bt-titlebar-h,var(--dsb-band,40px));-webkit-app-region:drag;app-region:drag;z-index:1}
:where(:is(html[data-windows-titlebar],html[data-platform=darwin]):not([data-fullscreen]) .bt-ui-dialog-mask[data-leaving]:not([data-has-scrim]))::before,:where(:is(html[data-windows-titlebar],html[data-platform=darwin]):not([data-fullscreen]) .bt-ui-dialog-mask[data-leaving][data-has-scrim]>[data-bt-dialog-scrim])::before{-webkit-app-region:initial;app-region:initial}
:where(.bt-ui-dialog){position:relative;z-index:2;display:flex;flex-direction:column;width:min(520px,100%);max-height:min(760px,calc(100% - 16px));border-radius:16px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 24px 80px rgba(0,0,0,.24);color:var(--bt-ink);outline:none;overflow:hidden;-webkit-app-region:no-drag;app-region:no-drag;animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards}
:where(.bt-ui-dialog-sm){width:min(420px,100%)}
:where(.bt-ui-dialog-lg){width:min(680px,100%)}
:where(.bt-ui-dialog-mask[data-leaving]>.bt-ui-dialog){animation:bt-dialog-sink .16s ease forwards}
:where(.bt-ui-dialog-head){display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 0}
:where(.bt-ui-dialog-title){margin:0;font-size:15px;line-height:20px;font-weight:600;color:var(--bt-ink)}
:where(.bt-ui-dialog-close){flex:none}
:where(.bt-ui-dialog-foot){display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px 16px}
:where(.bt-ui-dialog-mask button){transition:background-color .12s ease,color .12s ease,${spring(SPRING_SHAPE, 'transform')}}
@media (prefers-reduced-motion:reduce){:where(.bt-ui-dialog-mask,.bt-ui-dialog,.bt-ui-dialog-mask[data-leaving]>.bt-ui-dialog){animation:none;transition:none}}
`
