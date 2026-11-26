import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { CellEmpty } from './cell-empty.js'
import { ChevronDownIcon } from './icons.js'
import { t } from './i18n.js'
import { reducedMotion, useMorph } from './motion.js'
import { AnsweredCell, clearJustAnswered, closedLabel, keyLetter, noteJustAnswered, useAnswerMorph, useFoldCard } from './questions.js'
import { useDockHold } from './card-hold.js'
import { SettledHandoff } from './handoff-card.js'
import { SettledComputerHandoff } from './computer.js'
import { heldCardKey } from './sources.js'
import { WidgetCard, ViewUi, DEEP_VIEW_CSS, WidgetView as CoreWidgetView, ViewMenuList as CoreViewMenuList } from 'deep-view/react'
import { asText, checkShownView, choiceValue, inputDefault, resolve, viewInputs, viewScope } from 'deep-view/core'

// The core components draw with the host's labels: the submit keeps ds-bot's
// wording, the rest resolve through ds-bot's dictionary.
const viewT = (key, params) => (key === 'Send' ? t('Send to Bot') : t(key, params))
const VIEW_UI = { t: viewT, Markdown: MarkdownText }
const Card = props => h(ViewUi.Provider, { value: VIEW_UI }, h(WidgetCard, props))
// The show_view card, for the other request cards (connector, mail) to draw on.
export const ViewCard = Card
const withUi = Component => props => h(ViewUi.Provider, { value: VIEW_UI }, h(Component, props))

// Direct renders (tests, history) still see ds-bot's labels.
export const WidgetView = withUi(CoreWidgetView)
export const ViewMenuList = withUi(CoreViewMenuList)

function walkView(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  if ((node.type === 'stack' || node.type === 'row') && Array.isArray(node.children)) {
    for (const child of node.children) walkView(child, visit)
  }
}

function stripPromptLine(raw) {
  const first = String(raw).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
  const clean = first.replace(/^#+\s*/, '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean
}

const LABELED_NODES = new Set(['metric', 'progress', 'slider', 'number', 'choice', 'toggle', 'submit'])

function viewPrompt(title, view, answer = null) {
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (view !== null && typeof view === 'object') {
    const sentInputs = answer?.values?.inputs
    const lookup = viewScope(view, sentInputs !== null && typeof sentInputs === 'object' ? sentInputs : {})
    let found = ''
    walkView(view, (node) => {
      if (found !== '') return
      if (node.type === 'text' || node.type === 'callout') {
        const line = stripPromptLine(asText(resolve(node.text, lookup, '')))
        if (line !== '') found = line
      } else if (node.type === 'form') {
        const fields = Array.isArray(node.fields) ? node.fields : []
        const label = fields.map(field => field?.label || field?.placeholder).find(item => typeof item === 'string' && item.trim() !== '')
        if (label) found = label.trim()
      } else if (LABELED_NODES.has(node.type) && typeof node.label === 'string' && node.label.trim() !== '') {
        found = node.label.trim()
      }
    })
    if (found !== '') return found
  }
  return t('View')
}

function collectInputRows(view, sentInputs) {
  return viewInputs(view).map((node) => {
    const raw = sentInputs !== null && typeof sentInputs === 'object' && Object.hasOwn(sentInputs, node.id)
      ? sentInputs[node.id]
      : inputDefault(node)
    let value
    if (node.type === 'toggle') {
      value = raw === true ? '✓' : '—'
    } else if (node.type === 'choice') {
      const options = (Array.isArray(node.options) ? node.options : []).map(option => (typeof option === 'string' ? { label: option } : option))
      value = options.find(option => choiceValue(option) === raw)?.label ?? asText(raw)
    } else {
      value = `${asText(raw)}${node.unit ? ` ${node.unit}` : ''}`
    }
    return { key: node.label || node.id, value }
  })
}

function summarizeView(view, answer, closed) {
  if (closed !== undefined || !answer) {
    return { answered: false, badge: { text: closedLabel(closed), accent: false }, options: [], kvRows: [] }
  }
  let target = null
  walkView(view, (node) => {
    if (target === null && node.id === answer.action) target = node
  })
  const inputRows = view !== null && typeof view === 'object' ? collectInputRows(view, answer.values?.inputs) : []
  switch (target?.type) {
    case 'options': {
      const opts = (Array.isArray(target.options) ? target.options : []).map(option => (typeof option === 'string' ? { label: option } : option))
      const selected = Array.isArray(answer.values?.selected) ? answer.values.selected : []
      const options = selected.map(label => ({ label, at: opts.findIndex(option => option?.label === label) }))
      return { answered: true, badge: null, options, kvRows: inputRows }
    }
    case 'confirm': {
      const confirmed = answer.values?.confirmed
      const text = confirmed === false ? (target.cancelLabel || t('Cancel')) : (target.confirmLabel || t('Confirm'))
      return { answered: true, badge: { text, accent: confirmed === true }, options: [], kvRows: inputRows }
    }
    case 'form': {
      if (answer.values?.canceled === true) {
        return { answered: true, badge: { text: target.cancelLabel || t('Cancel'), accent: false }, options: [], kvRows: [] }
      }
      const fields = (Array.isArray(target.fields) ? target.fields : []).filter(field => field !== null && typeof field === 'object' && field.id !== undefined)
      const sentFields = answer.values?.fields && typeof answer.values.fields === 'object' ? answer.values.fields : {}
      const fieldRows = fields.map(field => ({
        key: field.label || field.placeholder || field.id,
        value: String(sentFields[field.id] ?? field.value ?? '').replace(/\s+/g, ' ').trim(),
      })).filter(row => row.value !== '')
      const kvRows = [...fieldRows, ...inputRows]
      const badge = kvRows.length === 0 ? { text: target.submitLabel || t('Submit'), accent: true } : null
      return { answered: true, badge, options: [], kvRows }
    }
    default: {
      const badge = inputRows.length === 0 ? { text: target?.label || t('Send to Bot'), accent: true } : null
      return { answered: true, badge, options: [], kvRows: inputRows }
    }
  }
}

// A settled view card (answered on the card, replied by message, or dismissed): folds
// down to the title and outcome summary, and expands smoothly to the full read-only view.
export function SettledView({ id, title, view, answer = null, closed }) {
  const prompt = viewPrompt(title, view, closed === undefined ? answer : null)
  const summary = summarizeView(view, answer, closed)
  const hasDetail = view !== null && typeof view === 'object'
  const cardRef = useRef(null)
  const bodyRef = useRef(null)
  useAnswerMorph(cardRef, 'view', id)
  const fold = useFoldCard(cardRef, bodyRef, hasDetail)
  const badge = summary.badge
    ? h('span', { className: 'bt-q-badge', 'data-accent': summary.badge.accent ? '' : undefined }, summary.badge.text)
    : null
  const head = hasDetail
    ? h('button', {
      type: 'button',
      className: 'bt-q-head bt-q-fold',
      'aria-expanded': fold.open,
      title: fold.open ? t('Show less') : t('Show more'),
      onClick: fold.toggle,
    },
    h('span', { className: 'bt-q-text' }, h('span', { className: 'bt-q-title' }, prompt)),
    badge,
    h('span', { className: 'bt-q-chevron', 'aria-hidden': true }, h(ChevronDownIcon)))
    : h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, prompt)),
      badge)
  const hasSummary = !fold.open && (summary.options.length > 0 || summary.kvRows.length > 0)
  return h('div', {
    ref: cardRef,
    className: summary.answered ? 'bt-q bt-q-settled bt-q-answered bt-view-settled' : 'bt-q bt-q-settled bt-q-dismissed bt-view-settled',
    'data-open': fold.open ? '' : undefined,
    'data-expandable': hasDetail ? '' : undefined,
    role: 'group',
    'aria-label': prompt,
    onClick: hasDetail && !fold.open ? fold.onCardClick : undefined,
  },
  head,
  hasSummary ? h('div', { className: 'bt-q-list bt-q-summary', role: 'group', 'aria-label': t('Your answer') },
    summary.options.map(({ label, at }, index) => h('div', { key: `${label}-${index}`, className: 'bt-q-opt', title: t('Selected') },
      at >= 0 ? h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(at)) : null,
      h('span', { className: 'bt-q-body' }, h('span', { className: 'bt-q-label' }, label)))),
    summary.kvRows.map((row, index) => h('div', { key: `${row.key}-${index}`, className: 'bt-q-kv-row' },
      h('span', { className: 'bt-q-kv-key' }, row.key),
      h('span', { className: 'bt-q-kv-val' }, row.value)))) : null,
  fold.showBody ? h('div', {
    ref: bodyRef,
    className: 'bt-q-expand',
    'data-leaving': fold.leaving ? '' : undefined,
    style: fold.leaving ? { '--bt-fold-top': `${fold.foldTop}px` } : undefined,
  }, h(Card, { title: '', view, settled: true, answer })) : null)
}

// A view waiting for its answer, inline at its call or raised in the dock. Keeps its
// content mounted while a request is in flight so a failure returns what was entered,
// and an inline settle morphs directly into the folded card.
export function PendingView({ sessionId, view, actions, inline, bare = false }) {
  const [answered, setAnswered] = useState(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const boxRef = useRef(null)
  const hold = useDockHold(sessionId, 'view', view.id, actions, inline)
  if (answered === view.id) return h(CellEmpty)
  const run = (make, { settle = false, onFail } = {}) => {
    // The ref, not the state: two clicks in the same frame both read busy=false.
    if (busyRef.current) return
    hold()
    busyRef.current = true
    setBusy(true)
    void Promise.resolve().then(make).then(() => { if (settle) setAnswered(view.id) }, () => {
      onFail?.()
      setAnswered(null)
    }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }
  const onSubmit = (action, values) => {
    if (busyRef.current) return
    const height = boxRef.current?.firstElementChild?.offsetHeight || boxRef.current?.offsetHeight
    if (inline) noteJustAnswered('view', view.id, height)
    run(() => actions.answerView(sessionId, view.id, action, values), {
      settle: true,
      onFail: () => clearJustAnswered('view', view.id),
    })
  }
  const onDismiss = () => run(() => actions.dismissView(sessionId))
  return h('div', { ref: boxRef, className: bare ? 'bt-q-hold' : (inline ? 'bt-q-inline' : 'bt-q-dock'), onFocusCapture: hold, onPointerDownCapture: hold },
    h(Card, { key: view.id, title: view.title ?? '', view: view.view, onSubmit, onDismiss, busy, raised: !inline }))
}

// The show_view call in the transcript.
export function WidgetCell({ sessionId, callId, args, done, isError, roster, actions, heldCards }) {
  const record = roster.views?.[sessionId]
  const isPending = record !== undefined && (record.callSessionId ?? sessionId) === sessionId && record.callId === callId
  const held = isPending && heldCards?.[heldCardKey('view', record.id)] > 0
  const skipShown = isPending || (done && isError)
  // Display-only and closed interactive cards draw from the recorded call arguments,
  // which keep the provider's encoding: checkShownView measures and unwraps them as the host did.
  const shown = skipShown ? null : checkShownView(args?.text?.('title'), args?.value?.('view'))
  const interactive = !skipShown && shown.error === undefined && (shown.interactive || args?.value?.('await_reply') === true)
  const closed = interactive && callId !== undefined ? roster.closedCards?.[sessionId]?.[callId] : undefined
  const phase = held ? 'held'
    : isPending ? `pending:${record.id}`
      : (done && isError) || shown?.error !== undefined ? 'error'
        : interactive ? (closed !== undefined ? `closed:${closed}` : 'gone')
          : 'display'
  const cellRef = useRef(null)
  useMorph(cellRef, phase)
  if (held) return h(CellEmpty)
  if (isPending) {
    return h('div', { ref: cellRef, className: 'bt-q-inline' },
      h(PendingView, { key: JSON.stringify([sessionId, record.id]), sessionId, view: record, actions, inline: true, bare: true }))
  }
  // A refused call (bad blueprint) drew no card; don't render an empty one.
  if (done && isError) return h(CellEmpty, { className: 'bt-q-gone' })
  if (shown.error !== undefined) return h(CellEmpty, { className: 'bt-q-gone' })
  if (interactive) {
    if (closed === undefined) return h(CellEmpty, { className: 'bt-q-gone' })
    return h('div', { ref: cellRef, className: 'bt-q-inline' },
      h(SettledView, { title: shown.title, view: shown.view, closed }))
  }
  return h('div', { ref: cellRef, className: 'bt-q-inline' }, h(Card, { title: shown.title, view: shown.view }))
}

// A view closed without an answer on it: compact like a closed question card, its
// title and a badge for how it closed, expandable to the full blueprint.
export function ClosedView({ title, view, closed }) {
  return h('div', { className: 'bt-q-inline' }, h(SettledView, { title, view, closed }))
}

// Views asked by a call the transcript does not draw wait above the composer,
// mirroring the question dock.
export function WidgetDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const view = useRoster(value => value.views?.[sessionId])
  const drawn = useCards?.(state => state[sessionId]?.[view?.callId] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('view', view?.id)] > 0) === true
  const inPart = (view?.callSessionId ?? sessionId) === sessionId
  const handedOff = inPart && Boolean(view?.callId) && drawn && !held
  const visible = view !== undefined && !handedOff
  const [exiting, setExiting] = useState(null)
  const prevRef = useRef({ sessionId, view: undefined, handedOff: false })
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { sessionId, view, handedOff }
    if (visible) {
      if (exiting) setExiting(null)
      return undefined
    }
    if (prev.sessionId === sessionId && prev.view !== undefined && !prev.handedOff && view === undefined && !reducedMotion() && typeof setTimeout === 'function') {
      setExiting(prev.view)
      const timer = setTimeout(() => setExiting(null), 150)
      return () => clearTimeout(timer)
    }
    if (exiting) setExiting(null)
    return undefined
  }, [sessionId, view?.id, visible])
  if (!visible) {
    if (view === undefined && exiting) {
      return h('div', { className: 'bt-q-dock', 'data-leaving': '' },
        h(Card, { key: exiting.id, title: exiting.title ?? '', view: exiting.view, busy: true, raised: true }))
    }
    return null
  }
  return h(PendingView, { key: JSON.stringify([sessionId, view.id]), sessionId, view, actions, inline: false })
}

// An answered view rides on the reply message itself: the settled card, read-only.
export function AnsweredView({ node }) {
  const data = node.data ?? {}
  let payload = null
  if (Array.isArray(data.views)) payload = data
  else {
    try { payload = typeof data.text === 'string' ? JSON.parse(data.text) : null } catch { payload = null }
    if (payload?.kind !== 'answer_to_pending_view') payload = null
  }
  const view = payload?.views?.[0]
  if (view === null || typeof view !== 'object' || view.view === undefined) return h(CellEmpty)
  const answers = Array.isArray(payload.answers) ? payload.answers : []
  const answer = answers.find(entry => entry?.id === view.id) ?? answers[0] ?? null
  return h('div', { className: 'bt-q-inline' }, h(SettledView, { id: view.id, title: view.title ?? '', view: view.view, answer }))
}

// A question reply node carries either questions (data.questions), a view answer or
// a browser handoff answer (JSON text discriminated by kind); each shape gets its
// own renderer. A history page has already read the handoff answer into data.handoff.
export function AnsweredReply({ node }) {
  const data = node?.data ?? {}
  if (Array.isArray(data.views) && data.views.length > 0) return h(AnsweredView, { node })
  if (typeof data.handoff?.reason === 'string') return h(SettledHandoff, { handoff: data.handoff })
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    let parsed = null
    try { parsed = typeof data.text === 'string' ? JSON.parse(data.text) : null } catch { parsed = null }
    if (parsed?.kind === 'answer_to_pending_view') return h(AnsweredView, { node })
    if (parsed?.kind === 'answer_to_pending_handoff' && typeof parsed.reason === 'string') {
      const reply = { reason: parsed.reason, note: parsed.note ?? '', outcome: parsed.outcome }
      return parsed.tool === 'computer_handoff' ? h(SettledComputerHandoff, { handoff: reply }) : h(SettledHandoff, { handoff: reply })
    }
  }
  return h(AnsweredCell, { node })
}

// The core styles, with the --dv-* tokens rebound to ds-bot's --bt-* palette so
// a view card keeps the Bot theme.
export const WIDGET_CSS = `${DEEP_VIEW_CSS}
body{
--dv-ink:var(--bt-ink);--dv-ink-2:var(--bt-ink-2);--dv-ink-3:var(--bt-ink-3);
--dv-line:var(--bt-line);--dv-line-2:var(--bt-line-2);
--dv-card:var(--bt-card);--dv-main:var(--bt-main);
--dv-hover:var(--bt-hover);--dv-active:var(--bt-active);
--dv-accent:var(--bt-accent);--dv-accent-ink:var(--bt-accent-ink);
--dv-green:var(--bt-green);--dv-star:var(--bt-star);--dv-danger:var(--bt-danger);
--dv-knob:var(--bt-knob);--dv-tag-bg:var(--bt-tag-bg);
--dv-ink-tangerine:var(--bt-ink-tangerine);--dv-ink-green:var(--bt-ink-green);
--dv-ink-violet:var(--bt-ink-violet);--dv-ink-sky:var(--bt-ink-sky);
--dv-ink-rose:var(--bt-ink-rose);--dv-ink-yellow:var(--bt-ink-yellow);
--dv-ink-cyan:var(--bt-ink-cyan);--dv-ink-magenta:var(--bt-ink-magenta)}
.bt-q-inline .dv-view{margin:0;width:100%;max-width:min(100%,max(calc(var(--bt-msg-w,.8) * 100%),560px));order:0}
.bt-q-inline .dv-q{margin:0;max-width:min(550px,86%);order:0}
body[data-bt-layout=flat] .bt-q-inline .dv-view,body[data-bt-layout=flat] .bt-q-inline .bt-view-settled{max-width:calc(var(--bt-flat-w,1) * 100%)}
.bt-q-inline:has(>.dv-view-bare){margin:8px 0 12px}
.bt-q-expand>.dv-view{padding:0;margin:0;max-width:none;background:none;box-shadow:none;border-radius:0;animation:none}
/* A standalone settled ViewCard keeps only the chosen rows, each under its card letter
   (a counter, since the core draws no letters on a settled card). Inside an expanded
   SettledView card (.bt-q-expand), every option stays visible with its letter and
   description, matching expanded SettledQuestion cards. */
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check){counter-reset:bt-opt}
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check)>.dv-q-opt{counter-increment:bt-opt;gap:16px;align-items:center}
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check)>.dv-q-opt:not(:has(.dv-q-check)){visibility:hidden;height:0;min-height:0;padding-block:0;overflow:hidden}
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check)>.dv-q-opt::before{content:counter(bt-opt,upper-alpha);position:static;inset:auto;opacity:1;flex:none;width:24px;height:24px;border-radius:8px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:12px;line-height:24px;font-weight:500;text-align:center}
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check)>.dv-q-opt .dv-q-label{color:var(--bt-ink)}
.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check)>.dv-q-opt .dv-q-desc,.dv-q-settled:not(.bt-q-expand *) .dv-q-list:has(.dv-q-check) .dv-q-check{display:none}
.bt-q-expand .dv-q-settled .dv-q-list{counter-reset:bt-opt}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt{counter-increment:bt-opt;gap:16px;padding:6px 8px;cursor:default}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt::before{content:counter(bt-opt,upper-alpha);position:static;inset:auto;opacity:1;flex:none;width:var(--dv-key,24px);height:var(--dv-key,24px);border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:12px;line-height:var(--dv-key,24px);font-weight:500;text-align:center;font-variant-numeric:tabular-nums}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt:has(.dv-q-desc)::before{margin-top:2px;border-radius:10px;font-size:13px}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt:has(.dv-q-check)::before{background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt .dv-q-label{color:var(--bt-ink-2)}
.bt-q-expand .dv-q-settled .dv-q-list>.dv-q-opt:has(.dv-q-check) .dv-q-label{color:var(--bt-ink)}
/* A row of segmented options is only as wide as its labels; at phone widths a
   few longer ones would spill past the card. Let them wrap and let a label wrap
   inside its own button instead. */
.dv-seg.dv-view-seg{flex-wrap:wrap}
.dv-seg.dv-view-seg button{flex:0 1 auto;height:auto;min-height:30px;min-width:0;padding-block:5px;white-space:normal;overflow-wrap:anywhere}
`
