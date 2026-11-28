// Read-only subagent session viewer chrome: lineage breadcrumb bar with back
// navigation and a calm bottom banner replacing the composer while viewing a child session.
import { createElement as h, Fragment, useEffect } from 'react'
import { ChevronLeftIcon, PeopleIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { hasEscapeLayer } from '../../../ds-bot/src/client/overlay-hooks.js'

function isEditableElement(node) {
  if (!node || typeof node !== 'object') return false
  if (node.isContentEditable === true) return true
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function subagentModeLabel(mode) {
  if (mode === 'continuable') return t('Continuable')
  if (mode === 'one-shot' || mode === 'one_shot') return t('One-shot')
  if (mode === 'external') return t('External')
  return mode
}

/**
 * Sticky lineage header shown above the transcript while viewing a subagent child Session.
 */
export function SubagentLineageBar({ stack, rootLabel, running = false, onBack, onSelectDepth }) {
  const active = Array.isArray(stack) && stack.length > 0
  useEffect(() => {
    if (!active || typeof window === 'undefined' || typeof onBack !== 'function') return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.key !== 'Escape') return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.isComposing || event.keyCode === 229) return
      if (hasEscapeLayer()) return
      if (isEditableElement(event.target) || isEditableElement(typeof document !== 'undefined' ? document.activeElement : null)) return
      if (typeof document !== 'undefined' && document.querySelector?.('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [data-approval-dock]')) return
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onBack])

  if (!active) return null
  const current = stack.at(-1)
  return h('div', { className: 'dsb-sub-bar', role: 'navigation', 'aria-label': t('Subagent session') },
    h('button', {
      type: 'button',
      className: 'dsb-sub-back',
      onClick: onBack,
    },
    h(ChevronLeftIcon),
    h('span', null, t('Back'))),
    h('div', { className: 'dsb-sub-crumbs' },
      h('button', {
        type: 'button',
        className: 'dsb-sub-crumb',
        onClick: () => onSelectDepth?.(0),
      }, rootLabel || t('Parent session')),
      stack.map((entry, index) => {
        const isCurrent = index === stack.length - 1
        const text = entry.label || entry.name || entry.sessionId
        return h(Fragment, { key: entry.sessionId },
          h('span', { className: 'dsb-sub-sep', 'aria-hidden': true }, '/'),
          isCurrent
            ? h('span', { className: 'dsb-sub-crumb is-current', title: text },
                h(PeopleIcon),
                h('span', { className: 'dsb-sub-crumb-text' }, text))
            : h('button', {
                type: 'button',
                className: 'dsb-sub-crumb',
                title: text,
                onClick: () => onSelectDepth?.(index + 1),
              }, text))
      })),
    h('div', { className: 'dsb-sub-badges' },
      running ? h('span', { className: 'dsb-tool-pill', 'data-tone': 'ok' }, t('Running')) : null,
      current?.mode && current.mode !== 'unknown'
        ? h('span', { className: 'dsb-tool-pill' }, subagentModeLabel(current.mode))
        : null,
      h('span', { className: 'dsb-tool-pill' }, t('Read-only'))))
}

/**
 * Replaces the composer when viewing a read-only subagent child Session.
 */
export function SubagentReadOnlyBar({ onBack }) {
  return h('div', { className: 'dsb-sub-readonly', role: 'status' },
    h('span', { className: 'dsb-sub-readonly-text' }, t('Viewing subagent session (read-only)')),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      onClick: onBack,
    }, t('Back to parent')))
}
