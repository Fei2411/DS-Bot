import { createElement as h, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { t } from './i18n.js'
import { AnsweredCell } from './questions.js'
import { useDockHold } from './card-hold.js'
import { SettledHandoff } from './handoff-card.js'
import { heldCardKey } from './sources.js'
import { WidgetCard, ViewUi, DEEP_VIEW_CSS, WidgetView as CoreWidgetView, ViewMenuList as CoreViewMenuList } from 'deep-view/react'
import { checkShownView } from 'deep-view/core'

// The core components draw with the host's labels: the submit keeps ds-bot's
// wording, the rest resolve through ds-bot's dictionary.
const viewT = (key, params) => (key === 'Send' ? t('Send to Bot') : t(key, params))
const VIEW_UI = { t: viewT, Markdown: MarkdownText }
const Card = props => h(ViewUi.Provider, { value: VIEW_UI }, h(WidgetCard, props))
const withUi = Component => props => h(ViewUi.Provider, { value: VIEW_UI }, h(Component, props))

// Direct renders (tests, history) still see ds-bot's labels.
export const WidgetView = withUi(CoreWidgetView)
export const ViewMenuList = withUi(CoreViewMenuList)

// A view waiting for its answer, inline at its call or raised in the dock. Like a
// pending question it hides on submit and comes back if the reply fails.
export function PendingView({ sessionId, view, actions, inline }) {
  const [answered, setAnswered] = useState(null)
  const busyRef = useRef(false)
  const hold = useDockHold(sessionId, 'view', view.id, actions, inline)
  const flying = answered === view.id
  const run = (make) => {
    // The ref, not the state: two clicks in the same frame both read flying=false.
    if (busyRef.current) return
    busyRef.current = true
    hold()
    setAnswered(view.id)
    void Promise.resolve().then(make).catch(() => setAnswered(null)).finally(() => { busyRef.current = false })
  }
  const onSubmit = (action, values) => run(() => actions.answerView(sessionId, view.id, action, values))
  const onDismiss = () => run(() => actions.dismissView(sessionId))
  // Hidden, not unmounted, while the answer is on its way: if it fails the card comes
  // back with what the user had typed or picked. The inputs stay busy meanwhile, so a
  // letter key cannot answer a hidden card.
  return h('div', { className: inline ? 'bt-q-inline' : 'bt-q-dock', style: flying ? { display: 'none' } : undefined, onFocusCapture: hold, onPointerDownCapture: hold },
    h(Card, { key: view.id, title: view.title ?? '', view: view.view, onSubmit, onDismiss, busy: flying, raised: !inline }))
}

// The show_view call in the transcript.
export function WidgetCell({ sessionId, callId, args, done, isError, roster, actions, heldCards }) {
  const record = roster.views?.[sessionId]
  if (record !== undefined && record.callId === callId) {
    if (heldCards?.[heldCardKey('view', record.id)] > 0) return null
    return h(PendingView, { sessionId, view: record, actions, inline: true })
  }
  // A refused call (bad blueprint) drew no card; don't render an empty one.
  if (done && isError) return h('span', { className: 'bt-q-gone', hidden: true })
  // Display-only cards draw from the recorded call arguments, which keep the
  // provider's encoding: checkShownView measures and unwraps them as the host did.
  // The args accessor reads strings through `text`; `value` drops them.
  const shown = checkShownView(args?.text?.('title'), args?.value?.('view'))
  // A call the host refused — a blueprint it would not show, or a reply it cannot
  // wait for — leaves no card; the model's retry then stays the only one. So does
  // a settled interactive call: answered, dismissed or replaced, it leaves no gap
  // where it was (same as ask_user).
  if (shown.error !== undefined || shown.interactive || args?.value?.('await_reply') === true) {
    return h('span', { className: 'bt-q-gone', hidden: true })
  }
  return h('div', { className: 'bt-q-inline' }, h(Card, { title: shown.title, view: shown.view }))
}

// Views asked by a call the transcript does not draw wait above the composer,
// mirroring the question dock.
export function WidgetDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const view = useRoster(value => value.views?.[sessionId])
  const drawn = useCards?.(state => state[sessionId]?.[view?.callId] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('view', view?.id)] > 0) === true
  if (view === undefined || (view.callId && drawn && !held)) return null
  return h(PendingView, { sessionId, view, actions, inline: false })
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
  if (view === null || typeof view !== 'object' || view.view === undefined) return null
  const answers = Array.isArray(payload.answers) ? payload.answers : []
  const answer = answers.find(entry => entry?.id === view.id) ?? answers[0] ?? null
  return h('div', { className: 'bt-q-inline' }, h(Card, { title: view.title ?? '', view: view.view, settled: true, answer }))
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
      return h(SettledHandoff, { handoff: { reason: parsed.reason, note: parsed.note ?? '', outcome: parsed.outcome } })
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
body[data-bt-layout=flat] .bt-q-inline .dv-view{max-width:calc(var(--bt-flat-w,1) * 100%)}
.bt-q-inline:has(>.dv-view-bare){margin:8px 0 12px}
`
