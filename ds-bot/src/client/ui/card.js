// Canonical Card carrier (`ActionCard`, `SettledCard`, `CardShell`, `CardDock`).
//
// Every interactive request card (ask_user, show_view, secrets, connectors, handoffs,
// work-pause, learning proposals, tool approvals, classic plan/questions) and every
// collapsible tool/status card builds on these single shared shells instead of
// inventing new card containers or composer docks.
import { createElement as h, useId } from 'react'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from '../icons.js'
import { t } from '../i18n.js'

const ACTION_CLASS = {
  primary: 'bt-q-submit',
  secondary: 'bt-q-btn',
  danger: 'bt-q-btn bt-card-btn-danger',
}

function renderActionButton(item, index) {
  if (!item) return null
  if (typeof item !== 'object' || !('label' in item)) return item
  const cls = [ACTION_CLASS[item.variant ?? 'secondary'] ?? 'bt-q-btn', item.className].filter(Boolean).join(' ')
  const content = !item.icon && !item.kbd
    ? [item.label]
    : [
        item.icon ? item.icon : null,
        h('span', null, item.label),
        item.kbd ? h('kbd', { className: 'bt-card-kbd', 'aria-hidden': true }, item.kbd) : null,
      ]
  return h('button', {
    key: item.key ?? index,
    type: item.type ?? 'button',
    className: cls,
    disabled: item.disabled,
    title: item.title,
    'aria-label': item.ariaLabel,
    onClick: item.onClick,
  }, ...content)
}

// The single canonical interactive card used in both inline transcript and composer dock.
export function ActionCard({
  mode = 'inline',
  as = 'section',
  icon = null,
  dotTone = null,
  title = null,
  titleId: givenTitleId = null,
  detail = null,
  headMeta = null,
  badge = null,
  header = null,
  onDismiss = null,
  dismissLabel = '',
  dismissTitle = '',
  dismissDisabled = false,
  error = '',
  buttons = null,
  footer = null,
  hidden = false,
  busy = false,
  className = '',
  wrapperClassName = '',
  headClassName = '',
  footClassName = '',
  role = 'group',
  ariaLabel = undefined,
  ariaDescribedBy = undefined,
  tabIndex = undefined,
  cardRef = null,
  dataAttrs = null,
  onSubmit = undefined,
  onFocusCapture = undefined,
  onPointerDownCapture = undefined,
  onKeyDown = undefined,
  onKeyUpCapture = undefined,
  onCompositionStartCapture = undefined,
  onCompositionEndCapture = undefined,
  wrap = true,
  children = null,
}) {
  const autoTitleId = useId()
  const titleId = givenTitleId ?? (title ? autoTitleId : undefined)
  const dock = mode === 'dock'
  const cardClasses = ['bt-q', dock ? 'bt-q-raised' : '', className].filter(Boolean).join(' ')
  const hasHead = Boolean(icon || dotTone || title || detail || headMeta || badge || onDismiss)
  const footNode = footer !== null && footer !== undefined
    ? footer
    : Array.isArray(buttons) && buttons.some(Boolean)
      ? h('div', { className: footClassName ? `bt-q-foot ${footClassName}` : 'bt-q-foot' },
          buttons.map(renderActionButton))
      : null

  const card = h(as, {
    ref: cardRef,
    className: cardClasses,
    role: as === 'form' ? undefined : role,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabel ? undefined : titleId,
    'aria-describedby': ariaDescribedBy,
    'aria-busy': busy || undefined,
    tabIndex,
    onSubmit,
    onFocusCapture: wrap ? undefined : onFocusCapture,
    onPointerDownCapture: wrap ? undefined : onPointerDownCapture,
    onKeyDown,
    onKeyUpCapture,
    onCompositionStartCapture,
    onCompositionEndCapture,
    style: !wrap && hidden ? { display: 'none' } : undefined,
    ...dataAttrs,
  },
  header !== null
    ? header
    : (hasHead ? h('div', { className: headClassName ? `bt-q-head ${headClassName}` : 'bt-q-head' },
        dotTone ? h('span', { className: 'bt-card-dot', 'data-tone': dotTone, 'aria-hidden': true }) : null,
        icon ? h('span', { className: 'bt-card-icon', 'aria-hidden': true }, icon) : null,
        h('div', { className: 'bt-q-text' },
          title ? h('p', { className: 'bt-q-title', id: titleId }, title) : null,
          detail ? h('div', { className: 'bt-q-detail' }, detail) : null,
          headMeta),
        badge,
        onDismiss ? h('button', {
          type: 'button',
          className: 'bt-q-x',
          'aria-label': dismissLabel || t('Dismiss'),
          title: dismissTitle || dismissLabel || t('Dismiss'),
          disabled: dismissDisabled,
          onClick: onDismiss,
        }, h(CloseIcon)) : null) : null),
  children,
  error ? h('div', { className: 'bt-card-error', role: 'alert' }, error) : null,
  footNode)

  if (!wrap) return card
  const wrapClasses = [dock ? 'bt-q-dock' : 'bt-q-inline', wrapperClassName].filter(Boolean).join(' ')
  return h('div', {
    className: wrapClasses,
    style: hidden ? { display: 'none' } : undefined,
    onFocusCapture,
    onPointerDownCapture,
  }, card)
}

// The single canonical settled/completed card left in the transcript.
export function SettledCard({
  title = null,
  icon = null,
  badge = null,
  checked = false,
  checkedLabel = '',
  dismissed = false,
  answered = false,
  inline = true,
  expandable = false,
  open = false,
  onToggle = null,
  onCardClick = null,
  cardRef = null,
  bodyRef = null,
  showBody = false,
  leaving = false,
  foldTop = 44,
  className = '',
  ariaLabel = undefined,
  dataAttrs = null,
  summary = null,
  children = null,
}) {
  const cardClasses = [
    'bt-q',
    'bt-q-settled',
    answered ? 'bt-q-answered' : '',
    dismissed ? 'bt-q-dismissed' : '',
    className,
  ].filter(Boolean).join(' ')
  const statusTrailing = badge
    ?? (checked ? h('span', { className: 'bt-q-check', title: checkedLabel || t('Done') }, h(CheckIcon)) : null)

  const head = expandable
    ? h('button', {
        type: 'button',
        className: 'bt-q-head bt-q-fold',
        'aria-expanded': open,
        title: open ? t('Show less') : t('Show more'),
        onClick: onToggle,
      },
      icon ? h('span', { className: 'bt-card-icon', 'aria-hidden': true }, icon) : null,
      h('span', { className: 'bt-q-text' }, title ? h('span', { className: 'bt-q-title' }, title) : null),
      statusTrailing,
      h('span', { className: 'bt-q-chevron', 'aria-hidden': true }, h(ChevronDownIcon)))
    : h('div', { className: 'bt-q-head' },
        icon ? h('span', { className: 'bt-card-icon', 'aria-hidden': true }, icon) : null,
        h('div', { className: 'bt-q-text' }, title ? h('p', { className: 'bt-q-title' }, title) : null),
        statusTrailing)

  const body = h('div', {
    ref: cardRef,
    className: cardClasses,
    role: 'group',
    'aria-label': ariaLabel ?? (typeof title === 'string' ? title : undefined),
    'data-open': open ? '' : undefined,
    'data-expandable': expandable ? '' : undefined,
    onClick: expandable && !open ? onCardClick : undefined,
    ...dataAttrs,
  },
  head,
  !open ? summary : null,
  showBody ? h('div', {
    ref: bodyRef,
    className: 'bt-q-expand',
    'data-leaving': leaving ? '' : undefined,
    style: leaving ? { '--bt-fold-top': `${foldTop}px` } : undefined,
  }, children) : null)

  return inline ? h('div', { className: 'bt-q-inline' }, body) : body
}

// Unified collapsible read-only / tool / status card shell.
export function CardShell({
  icon = null,
  label,
  summary = null,
  summaryTitle = undefined,
  badges = null,
  headerAction = null,
  phase = undefined,
  isError = false,
  duration = null,
  expanded = false,
  onToggle = null,
  hasBody = false,
  className = '',
  children = null,
}) {
  const running = phase === 'preparing' || phase === 'start'
  const headButton = h('button', {
    type: 'button',
    className: 'dsb-tool-head',
    disabled: !hasBody,
    'aria-expanded': hasBody ? expanded : undefined,
    onClick: hasBody ? onToggle : undefined,
  },
  h('span', { className: 'dsb-tool-dot', 'aria-hidden': true }),
  icon ? h('span', { className: 'dsb-tool-icon', 'aria-hidden': true }, typeof icon === 'function' ? h(icon) : icon) : null,
  h('span', { className: 'dsb-tool-name' }, label),
  summary ? h('span', { className: 'dsb-tool-summary', title: summaryTitle ?? (typeof summary === 'string' ? summary : undefined) }, summary) : null,
  h('span', { className: 'dsb-tool-meta' },
    badges,
    running ? h('span', { className: 'dsb-tool-state' }, t('Running'))
      : isError && (!badges || (Array.isArray(badges) && badges.length === 0)) ? h('span', { className: 'dsb-tool-state' }, t('Error'))
        : duration ? h('span', { className: 'dsb-tool-time' }, duration) : null,
    hasBody ? h('span', { className: 'dsb-tool-chev', 'aria-hidden': true }, h(ChevronRightIcon)) : null))

  return h('div', {
    className: className ? `dsb-tool ${className}` : 'dsb-tool',
    'data-phase': phase,
    'data-error': isError || undefined,
    'data-open': expanded || undefined,
  },
  headerAction
    ? h('div', { className: 'dsb-tool-head-row' },
        headButton,
        h('div', { className: 'dsb-tool-head-action' }, headerAction))
    : headButton,
  expanded && hasBody ? h('div', { className: 'dsb-tool-body' }, children) : null)
}

// Unified stack container for composer-top interactive cards.
export function CardDock({ className = '', children }) {
  return h('div', { className: className ? `bt-card-dock ${className}` : 'bt-card-dock' }, children)
}

export const CARD_CSS = `
:where(.bt-card-dock){display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;min-width:0}
:where(.bt-card-dock:empty){display:none}
:where(.bt-card-icon){flex:none;display:inline-flex;align-items:center;justify-content:center}
:where(.bt-card-dot){flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;corner-shape:round;background:var(--bt-accent)}
:where(.bt-card-dot[data-tone=star]){background:var(--bt-star)}
:where(.bt-card-dot[data-tone=warn]){background:var(--bt-warn)}
:where(.bt-card-dot[data-tone=danger]){background:var(--bt-danger)}
:where(.bt-card-dot[data-tone=green]){background:var(--bt-green)}
:where(.bt-card-error){margin:8px 16px 0;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--bt-danger);font-size:12px;line-height:16px;overflow-wrap:anywhere}
:where(.bt-card-kbd){display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;margin-left:5px;border-radius:4px;background:color-mix(in srgb,currentColor 14%,transparent);font:500 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.8}
:where(.bt-card-btn-danger){color:var(--bt-danger)}
:where(.bt-card-btn-danger:hover:not(:disabled)){background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
:where(.bt-q-foot){flex-wrap:wrap}
:where(.bt-q-foot>button){display:inline-flex;align-items:center;justify-content:center;gap:4px}
@media (prefers-reduced-motion:reduce){:where(.bt-q-foot>button){transition:none}}
`
