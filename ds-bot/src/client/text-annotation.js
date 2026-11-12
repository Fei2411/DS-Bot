import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { reducedMotion, SPRING_TAP } from './motion.js'

export const quoteMarkdown = text => text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')
const withAnnotation = (text, annotation) => annotation.trim() ? `${text}\n\n${annotation.trim()}` : text
export const annotatedMessage = (text, annotation) => quoteMarkdown(withAnnotation(text, annotation))
export const annotationKey = event => event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
  ? event.ctrlKey || event.metaKey ? 'send' : 'add'
  : null

export function insertAnnotation(inputActions, text, annotation) {
  return inputActions.insertQuote(withAnnotation(text, annotation))
}

// The host's quote interaction owns admission. This renderer adds the annotation
// editor for team conversations and retains its quote action on a plain Session.
export function TextSelectionAction({ sessionId, dismiss, readText, clearSelection, inputActions, useSession, useRoster, actions, t: hostT }) {
  const enabled = useSession(state => !state.removed && (state.subagent === null || state.subagent.address.mode === 'continuable' && state.subagent.parentAvailable === true))
  const team = useRoster(state => state.byId[sessionId] !== undefined || state.roomsById[sessionId] !== undefined)
  const [annotation, setAnnotation] = useState('')
  const [sending, setSending] = useState(false)
  const [closing, setClosing] = useState(false)
  const field = useRef(null)
  const pending = useRef(false)
  const closeTimer = useRef(null)
  useEffect(() => { if (!enabled) dismiss() }, [enabled, dismiss])
  useEffect(() => { if (team && enabled) field.current?.focus() }, [team, enabled])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  if (!enabled) return null

  // Selection and navigation changes belong to the host. Explicit closes linger
  // here so this card can play its exit before releasing the same host surface.
  const close = () => {
    clearSelection()
    setClosing(true)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(dismiss, reducedMotion() ? 0 : 160)
  }
  const closeNative = () => { clearSelection(); dismiss() }
  const add = () => {
    const text = readText()
    if (text === null) { close(); return }
    if (closing) return
    if (insertAnnotation(inputActions, text, annotation)) close()
  }
  const send = async () => {
    const text = readText()
    if (text === null) { close(); return }
    if (pending.current || closing) return
    pending.current = true
    setSending(true)
    try {
      await actions.send(sessionId, annotatedMessage(text, annotation))
      close()
    } catch (error) {
      actions.reportError(error, 'text-annotation')
      setSending(false)
      pending.current = false
      field.current?.focus()
    }
  }
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    const action = annotationKey(event)
    if (action === null) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'add') add()
    else void send()
  }

  if (!team) return h('button', {
    type: 'button', className: 'bt-quote-plain', 'aria-label': hostT('quote.add'),
    onPointerDown: event => event.preventDefault(),
    onClick: () => {
      const text = readText()
      if (text === null) { dismiss(); return }
      if (inputActions.insertQuote(text)) closeNative()
    },
  }, hostT('quote.add'))

  return h('section', { className: 'bt-annotation', 'aria-label': t('Annotate quote'), 'data-leaving': closing || undefined, onPointerDown: event => event.stopPropagation() },
    h('label', { className: 'bt-annotation-label', htmlFor: 'bt-annotation-field' }, t('Annotation')),
    h('blockquote', { className: 'bt-annotation-quote' }, readText()),
    h('textarea', {
      id: 'bt-annotation-field', ref: field, value: annotation, rows: 3,
      placeholder: t('Add an annotation…'), 'aria-label': t('Annotation'),
      disabled: sending || closing, onChange: event => setAnnotation(event.target.value), onKeyDown,
    }),
    h('div', { className: 'bt-annotation-actions' },
      h('button', { type: 'button', className: 'bt-annotation-add', disabled: sending || closing, onClick: add, title: t('Add quote and annotation to the composer · Enter') }, t('Add')),
      h('button', { type: 'button', className: 'bt-annotation-send', disabled: sending || closing, onClick: () => void send(), title: t('Send quote and annotation · Ctrl+Enter') }, sending ? t('Sending…') : t('Send'))))
}

export const ANNOTATION_CSS = `
.bt-quote-plain{corner-shape:round;background:var(--dsw-alias-button-floating-fill,var(--bt-card));--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel,var(--bt-glass-shadow));color:var(--dsw-alias-label-primary,var(--bt-ink));font:var(--dsw-font-xs-13,13px var(--bt-font));cursor:pointer;border:none;border-radius:999px;padding:5px 10px}
.bt-quote-plain:focus-visible,.bt-quote-plain:hover{background:var(--dsw-alias-button-floating-hover,var(--bt-hover))}
.bt-annotation{display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:12px;background:var(--bt-card);border:.5px solid var(--bt-line-2);border-radius:12px;box-shadow:var(--bt-glass-shadow);color:var(--bt-ink);font:13px/18px var(--bt-font);animation:bt-annotation-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-annotation[data-leaving]{animation:bt-annotation-out .16s cubic-bezier(.22,1,.36,1) forwards;pointer-events:none}
.bt-annotation-label{font:500 12px/16px var(--bt-font);color:var(--bt-ink-2)}
.bt-annotation-quote{margin:0;padding:6px 10px;border-left:2px solid var(--bt-accent);border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font:12px/16px var(--bt-font);white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto}
.bt-annotation textarea{display:block;resize:vertical;width:100%;min-height:84px;max-height:180px;box-sizing:border-box;padding:8px 10px;border:1px solid var(--bt-line);border-radius:8px;outline:none;background:var(--bt-main);color:var(--bt-ink);font:14px/22px var(--bt-font)}
.bt-annotation textarea:focus{border-color:var(--bt-accent);box-shadow:0 0 0 2px var(--bt-accent-soft)}
.bt-annotation textarea::placeholder{color:var(--bt-ink-3)}
.bt-annotation-actions{display:flex;justify-content:flex-end;gap:8px}
.bt-annotation-actions button{height:28px;border:1px solid var(--bt-line-2);border-radius:999px;padding:0 12px;background:var(--bt-main);color:var(--bt-ink);font:12px/16px var(--bt-font);cursor:pointer;touch-action:manipulation}
.bt-annotation-actions button:hover{background:var(--bt-hover)}
.bt-annotation-actions .bt-annotation-send{background:var(--bt-accent);border-color:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-annotation-actions .bt-annotation-send:hover{filter:brightness(1.06)}
.bt-annotation-actions button:disabled{opacity:.55;cursor:default}
@keyframes bt-annotation-in{from{opacity:0;transform:translateY(3px) scale(.98)}to{opacity:1;transform:none}}
@keyframes bt-annotation-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(2px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.bt-annotation,.bt-annotation[data-leaving]{animation:none}}
`
