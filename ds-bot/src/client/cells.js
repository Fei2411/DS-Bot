import { createElement as h, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText, writeClipboard } from './dsh-primitives.js'
import { inkText } from './inks.js'
import { linkMentions, normalizeFileLinks, mentionTarget, dayLabel, contentText, stripHeader, stripToolCallTags, isHiddenTurn, isRelayContext, relaysBefore, relayPart, commRunOf, toolName, toolArgs, reminderPrompts, elapsedLabel, clockLabel, messageClock } from './text.js'
import { messageAnchor } from './message-jump.js'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon, EyeIcon, HideIcon, GoalIcon, MemoryIcon } from './icons.js'
import { detectSecrets, projectSecretsToSlice } from '../shared/secret-mask.js'
import { ChangesCard } from './changes-card.js'
import { goalEventText } from './goal.js'
import { colorOf, toolState, BotMark, RoomAvatar } from './mark.js'
import { CellEmpty } from './cell-empty.js'
import { syncHostAncestors } from './chat-room.js'
import { AskUserCell, SettledQuestion } from './questions.js'
import { AnsweredReply, ClosedView, WidgetCell } from './widget-cell.js'
import { SecretToolCell } from './secret-card.js'
import { ConnectorToolCell, MailToolCell } from './connectors.js'
import { HandoffCall } from './handoff-card.js'
import { AppAccessCall, ComputerCallRow, ComputerHandoffCall } from './computer.js'
import { localeKey, mdLabels, t } from './i18n.js'
import { call } from './api.js'
import { failureLabel } from './diagnostics.js'
import { turnReasoning, thinkingStep, opensReply, stepActivity } from './turn-reasoning.js'
import { compressedRelayPreview, parseReplies, presentedFiles, relayRange, stackReplies } from '../shared/group-replies.js'
import { FOLD_AT, FOLD_HUGE, stripLongNote, useFold } from './fold.js'
import { ReplyGuide } from './reading.js'
import { noHover, useViewport, viewBottom } from './motion.js'
import { BtwCardView } from './btw.js'
import { partIndexOf, withBtwRows } from './btw-model.js'
import { PresentedFiles, ViaTag } from './user-message.js'
import { layoutOf, thinkingShown } from './themes.js'
import { ESCAPE_PRIORITY, useEscape } from './overlay-hooks.js'
import { lruGet, lruSet, memo, useRosterPick } from './memo.js'

export { clockLabel }

// -------------------------------------------------------------------------
// Chat cells


const useNullUi = () => null
const EMPTY_PICKED = []
const ASSISTANT_ROSTER_FIELDS = ['bots', 'byId', 'roomsById', 'exchangeTurns', 'prefs']
const TRIGGER_ROSTER_FIELDS = ['bots', 'byId', 'roomsById', 'exchangeTurns', 'prefs', 'closedCards']
export const TOOL_ROSTER_FIELDS = ['bots', 'byId', 'rooms', 'roomsById', 'exchangeTurns', 'prefs', 'closedCards', 'questions', 'views', 'secrets', 'secretRequests', 'connectors', 'connectorRequests', 'mailRequests', 'browser', 'computer']

const sameStringList = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]))

const sameBubbles = (a, b) => sameStringList(a.texts, b.texts)
  && a.selfId === b.selfId
  && a.actions === b.actions
  && a.streaming === b.streaming
  && a.lang === b.lang
  && a.sessionId === b.sessionId
  && a.anchor === b.anchor
  && a.turn === b.turn
  && a.msgKey === b.msgKey
  && a.useUi === b.useUi
  && a.lead === b.lead
  && a.mentions === b.mentions
  && a.fold === b.fold
  && a.whole === b.whole
  && a.time === b.time
  && a.textInteractionSource === b.textInteractionSource
  && a.roster?.bots === b.roster?.bots
  && a.roster?.byId?.[a.selfId]?.name === b.roster?.byId?.[b.selfId]?.name

// `lead` (a sender avatar in group chats) sits beside the last bubble, in the same
// row, so it lines up with the bubble whether or not reactions hang below it.
// `fold`: past what a bubble folds (fold.js); `whole`: the last text is only the start
// of its message (see useFold). `time` marks the bubbles' message below them; a caller
// whose own head already shows one (the flat speaker line, the group name row) leaves it unset.
export const Bubbles = memo(function Bubbles({ texts, roster, selfId, actions, streaming, sessionId, anchor = true, turn, msgKey, useUi, lead, mentions, lang, fold = FOLD_AT, whole, time, textInteractionSource }) {
  const onClick = (event) => {
    const target = mentionTarget(event)
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    actions.openSession(target)
  }
  const cleaned = texts.map(stripToolCallTags).filter(text => text.trim() !== '')
  const useReadUi = useUi ?? useNullUi
  const reactions = useReadUi(state => (msgKey ? state.reactions?.[msgKey] ?? null : null))
  return h('div', { className: 'bt-astack', 'data-lead': lead ? '' : undefined, ...(anchor ? messageAnchor(sessionId, turn, 'response') : undefined), onClickCapture: onClick },
    cleaned.map((text, index) => {
      const first = index === 0
      const last = index === cleaned.length - 1
      return h(Bubble, {
        key: index, text, index, first, last, roster, selfId, actions, sessionId, msgKey, mentions, fold, textInteractionSource, lang,
        picked: msgKey ? reactions?.[index] ?? EMPTY_PICKED : EMPTY_PICKED,
        live: streaming && last,
        lead: lead && last ? lead : null,
        whole: last ? whole : undefined,
      })
    }),
    Number.isFinite(time) ? h('div', { className: 'bt-utime', title: clockLabel(time) }, messageClock(time)) : null)
}, sameBubbles, 'Bubbles')

// A folded message's last code block shows only its start; DS Bot draws its own
// copy control for it, bound to the whole block. DSH's and the app's copy
// buttons live in the block's banner and their markup differs, so none of
// theirs is intercepted or cloned.
function FoldCodeCopy({ code, actions }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      if (typeof code === 'function' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        // Safari needs the clipboard write inside the click, before the attachment loads.
        const text = Promise.resolve().then(code).then(value => new Blob([value], { type: 'text/plain' }))
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })])
      } else {
        const text = typeof code === 'function' ? await code() : code
        if (!await writeClipboard(text)) throw new Error('Could not copy the code block')
      }
      setCopied(true); setTimeout(() => setCopied(false), 1000)
    } catch (error) { actions?.reportError?.(error, 'copy') }
  }
  return h('button', { type: 'button', className: 'bt-tool bt-fold-copy', 'aria-label': copied ? t('Copied') : t('Copy'), title: copied ? t('Copied') : t('Copy'), onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon))
}

// A folded message's last code block shows only its start. The start is not
// given to the host's Markdown — its block would carry a copy bound to the
// part shown — so DS Bot draws the part itself, with a copy bound to the
// whole block. `body` renders the markdown before the block.
const foldArea = (body, code, codeHead, actions) => (code === undefined ? body
  : h('div', { className: 'bt-fold-code' },
    body,
    h('pre', { className: 'bt-fold-pre' }, h('code', null, codeHead)),
    h(FoldCodeCopy, { code, actions })))

const sameBubble = (a, b) => a.text === b.text
  && a.index === b.index
  && a.first === b.first
  && a.last === b.last
  && a.selfId === b.selfId
  && a.lang === b.lang
  && a.actions === b.actions
  && a.sessionId === b.sessionId
  && a.msgKey === b.msgKey
  && a.mentions === b.mentions
  && a.fold === b.fold
  && sameStringList(a.picked, b.picked)
  && a.live === b.live
  && a.lead === b.lead
  && a.whole === b.whole
  && a.textInteractionSource === b.textInteractionSource
  && a.roster?.bots === b.roster?.bots
  && a.roster?.byId?.[a.selfId]?.name === b.roster?.byId?.[b.selfId]?.name

// `lang` is compared in `sameBubble` to invalidate memoization on language switches;
// `mdLabels()` is already content-addressed per language so Bubble reads it directly.
const Bubble = memo(function Bubble({ text, index, first = true, last = true, roster, selfId, actions, sessionId, msgKey, mentions, fold, picked, live, lead, whole, textInteractionSource }) {
  const { shown, folded, control, code, codeHead } = useFold(text, { limit: fold, whole, live })
  const key = msgKey ? `${msgKey}:${index}` : undefined
  // `mdLabels()` is already content-addressed per language; reading it directly avoids
  // freezing labels at mount time for callers that do not pass `lang`, while `sameBubble`
  // still invalidates memoization when `lang` changes.
  const labels = mdLabels()
  const linked = useMemo(() => (shown === '' ? '' : linkMentions(normalizeFileLinks(shown), roster.bots, selfId)), [shown, roster.bots, selfId])
  const openFile = useMemo(() => (typeof actions?.openFile === 'function'
    ? target => actions.openFile(typeof target === 'string'
      ? { path: target, sessionId }
      : { ...target, sessionId: target?.sessionId ?? sessionId })
    : undefined), [actions, sessionId])
  const revealFolder = useMemo(() => (typeof actions?.revealFolder === 'function'
    ? target => actions.revealFolder(typeof target === 'string'
      ? { path: target, sessionId }
      : { ...target, sessionId: target?.sessionId ?? sessionId })
    : undefined), [actions, sessionId])
  const body = useMemo(
    () => (linked === '' ? null : h(MarkdownText, {
      text: linked,
      streaming: live,
      labels,
      variant: 'compact',
      fileMentions: mentions,
      ...(openFile ? { onOpenFile: openFile } : {}),
      ...(revealFolder ? { onRevealFolder: revealFolder } : {}),
    })),
    [linked, live, labels, mentions, openFile, revealFolder],
  )
  const row = useRef(null)
  // Touch has no hover: a tap on the bubble opens its tools, a tap elsewhere
  // closes them. Interactive targets keep their own meaning.
  const [toolsOpen, setToolsOpen] = useState(false)
  useDismiss(toolsOpen, () => setToolsOpen(false), [row])
  const tapTools = (event) => {
    if (!noHover() || event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]')) return
    setToolsOpen(value => !value)
  }
  const bubble = useRef(null)
  const area = foldArea(body, code, codeHead, actions)
  return h('div', {
    ref: row,
    className: 'bt-msg',
    'data-first': first ? '' : undefined,
    'data-last': last ? '' : undefined,
    'data-join-top': first ? undefined : '',
    'data-join-bottom': last ? undefined : '',
    onClick: tapTools,
  },
    h('div', { className: 'bt-msg-line' },
      lead,
      h('div', { ref: bubble, className: 'bt-bubble', 'data-folded': folded || undefined, 'data-text-interaction-source': textInteractionSource ? '' : undefined },
        control ? h('div', { className: 'bt-fold-body' }, area) : area,
        control),
      h(ReplyGuide, { box: bubble, active: !live && !folded }),
      live ? null : h(MessageTools, { text: folded ? text : shown, name: roster.byId[selfId]?.name ?? t('Bot'), sessionId, react: key ? emoji => actions.toggleReaction(msgKey, index, emoji) : undefined, actions, open: toolsOpen })),
    picked.length ? h('div', { className: 'bt-reacts' }, picked.map(emoji => h('button', {
      key: emoji, type: 'button', className: 'bt-react', 'aria-label': t('Remove reaction {emoji}', { emoji }), onClick: () => actions.toggleReaction(msgKey, index, emoji),
    }, emoji))) : null)
}, sameBubble, 'Bubble')

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
// Half the reaction strip: six 32px buttons at 2px gaps plus its own padding and
// the 8px margin it keeps from the screen edge.
const STRIP_HALF = (REACTIONS.length * 34 + 10) / 2 + 8

// Closes a popover on a press outside the given elements or on Escape.
function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (refs.some(ref => ref.current?.contains(event.target))) return
      close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown) }
  }, [open])
  useEscape(close, open, { priority: ESCAPE_PRIORITY.MENU })
}

// The hover toolbar beside a reply bubble: Add reaction, Reply, More. `open` is
// the touch fallback: a tap on the bubble toggles it (see Bubble).
function MessageTools({ text, name, sessionId, react, actions, open: tapped }) {
  // The anchor element is kept, not its rect: the visible viewport can move
  // (on-screen keyboard) while the popover is open.
  const [panel, setPanel] = useState(null)
  const [copied, setCopied] = useState(false)
  const tools = useRef(null)
  const pop = useRef(null)
  const tick = useViewport(panel !== null)
  const close = () => setPanel(null)
  useDismiss(panel !== null, close, [tools, pop])
  const open = (kind, event) => { if (panel?.kind === kind) { close(); return } setPanel({ kind, node: event.currentTarget }) }
  const place = useMemo(() => {
    if (!panel) return null
    const rect = panel.node.getBoundingClientRect()
    const below = rect.bottom + 220 < viewBottom()
    return panel.kind === 'react'
      // The strip hangs off its center anchor: clamp the center so the strip
      // itself stays inside the viewport.
      ? { left: Math.min(Math.max(rect.left + rect.width / 2, STRIP_HALF), window.innerWidth - STRIP_HALF), top: rect.top - 6, '--bt-origin': 'bottom center' }
      : { left: Math.min(rect.left, window.innerWidth - 208), ...(below ? { top: rect.bottom + 4 } : { bottom: viewBottom() - rect.top + 4, '--bt-origin': 'bottom left' }) }
  }, [panel, tick])
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const item = (label, Icon, run) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { close(); run() } }, h(Icon), label)
  return h('div', { ref: tools, className: 'bt-tools', 'data-open': panel !== null || tapped || undefined },
    react ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': panel?.kind === 'react', onClick: event => open('react', event) }, h(SmileIcon)) : null,
    sessionId ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: () => actions.quote(sessionId, text) }, h(ReplyIcon)) : null,
    h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': panel?.kind === 'more', onClick: event => open('more', event) }, copied ? h(CheckIcon) : h(DotsIcon)),
    panel?.kind === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: place },
      REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    panel?.kind === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: place },
      item(t('Copy'), CopyIcon, copy), item(t('Download'), DownloadIcon, download)), document.body) : null)
}

// A Turn's settled thinking time, keyed per turn and refreshed as settled steps grow.
const MAX_THINKING_TIMES = 500
export const thinkingTimes = new Map()
function useThinkingMs({ sessionId, turn, settledSteps, skip }) {
  const key = `${sessionId}:${turn}`
  const initial = thinkingTimes.get(key)
  const [ms, setMs] = useState(() => (initial?.steps === settledSteps ? initial.ms : undefined))
  useEffect(() => {
    const cached = lruGet(thinkingTimes, key)
    if (skip) { setMs(cached?.steps === settledSteps ? cached.ms : undefined); return undefined }
    if (cached !== undefined && cached.steps === settledSteps) { setMs(cached.ms); return undefined }
    const control = new AbortController()
    call('thinking', { sessionId, turn }, control.signal)
      .then((value) => {
        lruSet(thinkingTimes, key, { steps: settledSteps, ms: value?.ms }, MAX_THINKING_TIMES)
        setMs(value?.ms)
      })
      .catch(() => {})
    return () => control.abort()
  }, [key, settledSteps, skip])
  return ms
}

// The row starts closed. Few readers go through a whole chain of thought, so when opened
// it shows the last lines and the box scrolls for the rest. It stays at the end as later
// steps add reasoning, unless the reader has scrolled up. While a step of the turn is
// thinking the row shows immediately and ticks (`at` backs the live clock so it counts
// the settled steps too); settled, it shows the turn's exact thinking time if known.
// A live turn's row moves to the step that reasons now, so whether the reader opened it
// and where they scrolled is kept per turn (`viewKey`), not per row.
const MAX_ROW_VIEWS = 200
export const rowViews = new Map()
export function ThinkingRow({ text, live, at, ms, viewKey, textInteractionSource }) {
  const box = useRef(null)
  const view = useRef(lruGet(rowViews, viewKey))
  const atEnd = useRef(view.current?.atEnd ?? true)
  const [open, setOpen] = useState(view.current?.open ?? false)
  const [fade, setFade] = useState(undefined)
  const remember = patch => { if (viewKey !== undefined) lruSet(rowViews, viewKey, { ...rowViews.get(viewKey), ...patch }, MAX_ROW_VIEWS) }
  const measure = () => {
    const el = box.current
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2
    remember({ atEnd: atEnd.current, top: el.scrollTop })
    const above = el.scrollTop > 0
    setFade(above && !atEnd.current ? 'both' : above ? 'top' : !atEnd.current ? 'bottom' : undefined)
  }
  const toggle = event => {
    const next = event.currentTarget.open
    if (next) atEnd.current = true
    remember({ open: next })
    setOpen(next)
  }
  useLayoutEffect(() => {
    if (!open) return
    const el = box.current
    const restore = view.current
    view.current = undefined
    if (atEnd.current) el.scrollTop = el.scrollHeight
    else if (restore?.top !== undefined) el.scrollTop = restore.top
    measure()
  }, [text, open])
  const title = live ? t('Thinking') : t('Thought it through')
  return h('details', { className: 'bt-think', open, onToggle: toggle },
    h('summary', null, title,
      live && at !== undefined ? h(Elapsed, { at, className: 'bt-think-time' }) : null,
      !live && ms !== undefined ? h('span', { className: 'bt-think-time' }, `· ${elapsedLabel(Math.max(1000, ms))}`) : null),
    h('div', { ref: box, className: 'bt-think-text', role: 'region', 'aria-label': title, tabIndex: 0, 'data-fade': fade, 'data-text-interaction-source': textInteractionSource && !live ? '' : undefined, onScroll: measure }, text))
}

// The files a finished turn changed or delivered, linked from inline code in its
// reply as in DSH's own chat. DSH resolves them for the step that closes the turn.
function useFileMentions({ node, openFile, fileMentions, useTurnData }) {
  const tail = useTurnData?.('turn-tail')
  const location = node.location
  const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
  const seq = node.data.finalNode?.seq
  return useMemo(() => {
    if (typeof fileMentions !== 'function' || turn?.status !== 'closed' || seq === undefined) return undefined
    return tail?.closing?.finalNode.seq === seq ? fileMentions({ turn, seq, openFile }) : undefined
  }, [fileMentions, openFile, seq, tail, turn])
}

export function AssistantCell({ node, groupPart, sessionId, openFile, fileMentions, useTurnData, useRoster, useUi, useTurnSteps, useTurnContext, actions }) {
  const roster = useRosterPick(useRoster, ASSISTANT_ROSTER_FIELDS)
  const data = node.data
  const steps = useTurnSteps(String(data.turn))
  const contexts = useTurnContext(String(data.turn))
  const mentions = useFileMentions({ node, openFile, fileMentions, useTurnData })
  const hidden = Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, data.turn)
  const texts = groupPart === 'reasoning' ? [] : data.blocks
    .filter(block => block.kind === 'text')
    .map(block => stripToolCallTags(block.text))
    .filter(text => text.trim() !== '')
  const running = data.status === 'running'
  const textInteractionSource = data.status === 'settled' && data.finalNode?.messageId !== undefined
  const members = steps.length ? steps : [data]
  const shown = thinkingShown(roster.prefs)
  const reasoning = groupPart === 'response' || !shown ? '' : turnReasoning(steps, data)
  // A live step of the same Turn keeps the row ticking even when it sits on an
  // earlier step's cell.
  const thinking = groupPart === 'response' || !shown ? undefined : thinkingStep(members)
  const ms = useThinkingMs({ sessionId, turn: data.turn, settledSteps: members.filter(step => step.status !== 'running').length, skip: hidden || reasoning === '' })
  // A streaming reply stands in for the activity row.
  useLiveNote(actions, sessionId, `text:${node.key ?? data.seq}`, !hidden && running && texts.length > 0 ? { text: true } : null)
  if (hidden) return h(CellEmpty)
  // A relay spliced mid-turn is a 'context' node, hidden from the chat flow on
  // DSH 0.2; the step that answers it shows the event line where it was read,
  // once, in the step's first cell.
  const relays = relayPart(data, groupPart) ? relaysBefore(contexts, steps, data) : []
  const activity = groupPart === 'response' ? [] : stepActivity(data)
  if (texts.length === 0 && !reasoning && relays.length === 0 && activity.length === 0) return h(CellEmpty)
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  // The flat layout heads a reply with who speaks, once per Turn: in the step that opens
  // it, in that step's reasoning part when the reasoning shows there.
  const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[sessionId] : undefined
  const head = speaker !== undefined && opensReply(steps, data, shown)
    && (reasoning !== '' || (texts.length > 0 && !(groupPart === 'response' && shown && turnReasoning(steps, data) !== '')))
  return h(Fragment, null,
    relays.map(relay => {
      const source = relay.source
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      return h(EventLine, {
        key: relay.seq,
        prefix: source.role === 'stopped' ? t('Stopped by')
          : source.role === 'cancelled' ? t('Cancelled by')
            : source.role === 'note' ? t('Note from')
              : source.role === 'ask_back' ? t('Question from')
                : source.role === 'answer' ? t('Answer from')
                  : source.role === 'reply' ? t('Reply from') : t('Message from'),
        bots: [sender],
        onOpen: () => { if (sender.id) actions.openExchange(selfId, sender.id) },
        whole: true,
      })
    }),
    head ? h(SpeakerHead, { bot: speaker, time: data.time }) : null,
    activity.length ? h('div', { className: 'bt-agent-activity' }, activity.map((line, index) => h('div', { key: index, className: 'bt-agent-act', title: line }, h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }), h('span', { className: 'bt-agent-act-text' }, activityParts(line))))) : null,
    reasoning ? h(ThinkingRow, {
      text: reasoning, live: thinking !== undefined, viewKey: `${sessionId}:${data.turn}`, textInteractionSource,
      // The live clock counts the settled steps too: backing `at` by the settled
      // time makes one Elapsed show settled + running.
      ...(thinking !== undefined ? { at: typeof thinking.time === 'number' ? thinking.time - (ms ?? 0) : undefined } : { ms }),
    }) : null,
    texts.length ? h(Bubbles, { texts, roster, selfId, actions, streaming: running, sessionId, turn: data.turn, msgKey: `${sessionId}:${data.turn}:${node.key ?? data.seq ?? ''}`, useUi, mentions, fold: FOLD_HUGE, time: speaker === undefined ? data.time : undefined, textInteractionSource }) : null)
}

// `code` in an activity line is the command or path the agent works on.
const activityParts = line => line.split('`').map((part, index) => (index % 2 === 1 ? h('code', { key: index }, part) : part))

function EventLine({ prefix, bots, joiner = t('and'), onOpen, whole = false }) {
  if (whole && bots.length === 1) {
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', title: bots[0].name, onClick: () => onOpen?.(bots[0]) },
        h('span', null, prefix), h(BotMark, { bot: bots[0], size: 16 }), h('span', { className: 'bt-event-name' }, bots[0].name)))
  }
  const parts = []
  parts.push(h('span', { key: 'p' }, prefix))
  bots.forEach((bot, index) => {
    if (index > 0) parts.push(h('span', { key: `j${index}` }, joiner))
    parts.push(h('button', { key: bot.id ?? index, type: 'button', onClick: () => onOpen?.(bot) },
      h(BotMark, { bot, size: 16 }), bot.name))
  })
  return h('div', { className: 'bt-event' }, parts)
}

// The flat layout's head over a Bot's reply in its own chat: avatar, name, time.
function SpeakerHead({ bot, time }) {
  return h('div', { className: 'bt-group-name' },
    h('span', { className: 'bt-lead' }, h(BotMark, { bot, size: 22 })), bot.name,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null)
}

const CHAIN_BREAK_SEL = '.bt-group-msg, .bt-umsg, .bt-urow, [data-bt-flow-kind=user], [data-bt-flow-kind=command-input], .bt-q-inline, .bt-event, .bt-time-sep, .bt-new-sep, .bt-part-line, .bt-btw-card, .bt-learn-card'
export function syncGroupChains(flow) {
  const items = [...flow.querySelectorAll(CHAIN_BREAK_SEL)]
  for (let i = 0; i < items.length; i += 1) {
    const curr = items[i]
    if (!curr.classList.contains('bt-group-msg')) continue
    const prev = items[i - 1]
    const next = items[i + 1]
    const botId = curr.dataset.botId
    const chainPrev = Boolean(botId && prev?.classList.contains('bt-group-msg') && prev.dataset.botId === botId)
    const chainNext = Boolean(botId && next?.classList.contains('bt-group-msg') && next.dataset.botId === botId)
    if (chainPrev) curr.dataset.chainPrev = ''; else delete curr.dataset.chainPrev
    if (chainNext) curr.dataset.chainNext = ''; else delete curr.dataset.chainNext
    syncHostAncestors(curr)
    const turn = curr.closest('[data-bt-group-key]')
    if (turn) {
      if (chainPrev) turn.dataset.btChainPrev = ''; else delete turn.dataset.btChainPrev
      if (chainNext) turn.dataset.btChainNext = ''; else delete turn.dataset.btChainNext
    }
  }
}

const pendingFlows = new WeakSet()
function scheduleGroupChains(flow) {
  if (!flow || pendingFlows.has(flow)) return
  pendingFlows.add(flow)
  queueMicrotask(() => {
    pendingFlows.delete(flow)
    if (flow.isConnected !== false) syncGroupChains(flow)
  })
}

// One Bot message inside a group chat: avatar, name (with its group role), when it ran
// and how long it took, bubble. The flat layout moves the avatar from beside the last
// bubble to the head of the name row, so the text below runs the whole width.
// The host's checks on a final reply, as lines under it. A marker only tells the
// reader; it never asks the Bot to do anything again.
export function claimLines(claims) {
  if (claims === undefined || claims === null) return []
  const lines = []
  if (claims.inProgress === true) {
    lines.push({
      kind: 'inProgress',
      text: t('No background work detected'),
      detail: t('DS Bot has no recorded tool call or active background task for this reply.'),
    })
  }
  for (const path of claims.missingFiles ?? []) lines.push({ kind: 'file', text: t('File not found: {path}', { path }) })
  return lines
}

export function GroupMessage({ bot, text, texts = [text], files = [], openFile, room, sessionId, roster, actions, msgKey, useUi, whole, time, duration, claims, changes, anchorSessionId, turn, messageId }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.closest) return undefined
    syncHostAncestors(el)
    const flow = el.closest('[data-bt-flow]')
    if (!flow) return undefined
    scheduleGroupChains(flow)
    return () => scheduleGroupChains(flow)
  }, [bot.id])
  const lead = h('button', { type: 'button', className: 'bt-lead', 'aria-label': t("Open {name}'s chat", { name: bot.name }), onClick: () => actions.openSession(bot.id) },
    h(BotMark, { bot, size: 22 }))
  const flat = layoutOf(roster.prefs) === 'flat'
  const took = Number.isFinite(duration) && duration >= 1000 ? elapsedLabel(duration) : undefined
  // The Reply tool quotes into the composer of the chat on screen: a group that has split
  // its public chat keeps going in a new Session, while its room id stays the same.
  const quoteSession = sessionId ?? room?.sessionId ?? room?.id
  const visibleTexts = (Array.isArray(texts) ? texts : []).filter(entry => entry !== '' && entry !== undefined)
  const fileList = presentedFiles(files)
  const filesOnly = visibleTexts.length === 0 && fileList.length > 0
  const fileCards = fileList.length > 0 ? h(PresentedFiles, { files: fileList, openFile, actions }) : null
  return h('div', { ref, className: 'bt-group-msg', 'data-bot-id': bot.id, ...messageAnchor(anchorSessionId, turn, 'response', messageId) },
    h('span', { className: 'bt-group-name', style: flat ? undefined : { color: inkText(colorOf(bot)) } }, flat ? lead : null, bot.name,
      room?.admin === bot.id ? h('span', { className: 'bt-group-role' }, t('Admin')) : null,
      Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null,
      took ? h('span', { className: 'bt-group-took', title: t('Ran for {duration}', { duration: took }) }, took) : null),
    filesOnly
      ? (flat ? fileCards : h('div', { className: 'bt-pfiles-row' }, lead, fileCards))
      : h(Fragment, null,
        h(Bubbles, { texts: visibleTexts, roster, selfId: bot.id, actions, sessionId: quoteSession, anchor: anchorSessionId === undefined, msgKey, useUi, lead: flat ? null : lead, whole, textInteractionSource: true }),
        fileCards),
    changes === undefined ? null : h(ChangesCard, { changes, actions }),
    claimLines(claims).map(line => h('div', { key: line.kind + line.text, className: `bt-claim bt-claim-${line.kind}`, role: 'status', title: line.detail ?? undefined }, line.text)))
}

// A centered event line that names a group chat and opens it.
function GroupEvent({ prefix, room, name, roster, actions }) {
  return h('div', { className: 'bt-event' },
    h('span', null, prefix),
    room ? h('button', { type: 'button', onClick: () => actions.openSession(room.id) }, h(RoomAvatar, { room, roster, size: 16 }), room.name)
      : name ? h('span', null, name) : null)
}

// The results a memory write answers with when it changed the memory, and the
// one that says the entry was there already.
const MEMORY_SAVED = /^(Saved to|Updated in|Removed from) /
const MEMORY_ALREADY = /^Already in /

// The words the memory tools take for a scope.
const MEMORY_TEAM = /^(team|团队|共享)$/i
const MEMORY_OWN = /^(own|me|mine|self|yours?|自己|我)$/i
const MEMORY_GROUP = /^(group|this group|群|本群|群聊)$/i

// Why a memory write changed nothing, in the interface language. The host's own
// words stay in the tool record: they can name the entries that were asked
// about, and the notice does not repeat them.
function memoryFailure(code) {
  if (!code) return undefined
  switch (code) {
    case 'memory/empty': return t('Write something to save')
    case 'memory/no-match': return t('No saved entry matched')
    case 'memory/refused':
    case 'memory/denied': return t('The memory refused this change')
    // A write that broke, and any failure this interface does not know.
    default: return t('The memory could not be changed')
  }
}

// A change remember or forget made, which opens the memory it changed. A
// refusal and a write that failed changed nothing, and say so, with the way
// into the memory panel.
function MemoryEvent({ sessionId, scope, tool, result, failed, code, roster, actions, findBot }) {
  const self = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const named = String(scope ?? '').trim()
  const team = MEMORY_TEAM.test(named)
  const other = team || named === '' ? undefined : findBot(named)
  const target = other && other.id !== self?.id ? other : self
  // The panel that shows the memory: the Bot's own, the group's in a group chat,
  // or none when the scope names a Bot that is not there.
  const panel = team ? self?.id
    : MEMORY_OWN.test(named) ? self?.id
      : MEMORY_GROUP.test(named) ? room?.id
        : named === '' ? (room?.id ?? self?.id)
          : other?.id
  if (!failed && MEMORY_ALREADY.test(result)) {
    // The entry was there already: a quiet line, and the panel shows it.
    return h('div', { className: 'bt-event' },
      panel === undefined ? h('span', null, h(MemoryIcon), t('Already saved')) : h('button', { type: 'button', onClick: () => actions.openMemory(panel) }, h(MemoryIcon), t('Already saved')))
  }
  if (!failed && MEMORY_SAVED.test(result)) {
    if (!target) return h(CellEmpty)
    const label = team ? t('Team memory updated') : target === self ? t('Memory updated') : t("Updated {name}'s memory", { name: target.name })
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', title: result, onClick: () => actions.openMemory(target.id) }, h(MemoryIcon), label))
  }
  // Nothing was saved. The reason is a short line of our own; what the host
  // said stays in the tool record.
  const reason = memoryFailure(code)
  const label = failed
    ? ((tool === 'forget' || tool === 'bot_forget') ? t("Couldn't remove from memory") : t("Couldn't save to memory"))
    : t('Memory not changed')
  return h('div', { className: 'bt-event bt-event-error', role: 'status', title: code },
    h('span', null, h(MemoryIcon), label),
    reason ? h('span', null, ` · ${reason}`) : null,
    panel === undefined ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openMemory(panel) }, t('Manage')))
}

export function PartLine({ time }) {
  return h('div', { className: 'bt-part-line', role: 'separator' }, Number.isFinite(time) ? h('span', null, dayLabel(time)) : null)
}

const scrollParent = (node) => {
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return null
}

function MaskedUserInline({ text, spans, revealed: controlledRevealed = null, onToggle = null }) {
  const [localRevealed, setLocalRevealed] = useState(() => new Set())
  useEffect(() => {
    setLocalRevealed(prev => (prev.size === 0 ? prev : new Set()))
  }, [text])
  const revealed = controlledRevealed instanceof Set ? controlledRevealed : localRevealed
  const toggle = (key) => {
    if (typeof onToggle === 'function') { onToggle(key); return }
    setLocalRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const nodes = []
  let cursor = 0
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]
    if (span.start > cursor) nodes.push(h(Fragment, { key: `t:${i}` }, text.slice(cursor, span.start)))
    const isOpen = revealed.has(span.key)
    const label = isOpen ? t('Hide secret') : t('Reveal secret')
    nodes.push(h('span', {
      key: `s:${span.key}:${i}`,
      className: `dsb-secret${isOpen ? ' is-revealed' : ''}`,
      'data-secret-masked': isOpen ? undefined : '',
    },
    h('span', { className: 'dsb-secret-val' }, isOpen ? span.raw : span.masked),
    h('button', {
      type: 'button',
      className: 'dsb-secret-toggle',
      'aria-pressed': isOpen,
      'aria-label': label,
      title: label,
      onClick: (event) => { event.stopPropagation(); toggle(span.key) },
    }, isOpen ? h(HideIcon) : h(EyeIcon))))
    cursor = span.end
  }
  if (cursor < text.length) nodes.push(h(Fragment, { key: 't:end' }, text.slice(cursor)))
  return h('div', { className: 'bt-umasked', style: { whiteSpace: 'pre-wrap' } }, nodes)
}

function EarlierUser({ row, sessionId, roster, actions, renderUserAttachments, renderUserText, showTime = false }) {
  const fullText = row.text ?? ''
  const customRender = typeof renderUserText === 'function'
    ? renderUserText
    : (typeof actions?.renderUserText === 'function' ? actions.renderUserText : null)
  const fullSecrets = useMemo(() => detectSecrets(fullText), [fullText])
  // Disable markdown code-fence folding whenever credentials are present or the own-window
  // user renderer handles the bubble, so folded fenced code can never bypass masking.
  const { shown, folded, control, code, codeHead } = useFold(fullText, {
    markdown: customRender === null && fullSecrets.length === 0,
  })
  const [revealedSecrets, setRevealedSecrets] = useState(() => new Set())
  useEffect(() => {
    setRevealedSecrets(prev => (prev.size === 0 ? prev : new Set()))
  }, [fullText])
  const toggleSecret = (key) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const secretSpans = useMemo(
    () => (fullSecrets.length > 0 ? projectSecretsToSlice(fullText, shown, fullSecrets) : []),
    [fullText, shown, fullSecrets],
  )
  const body = fullText && shown !== ''
    ? (customRender !== null
      ? h('div', { className: 'bt-umasked', style: { whiteSpace: 'pre-wrap' } },
        customRender({
          text: shown,
          fullText,
          sessionId,
          roster,
          actions,
          revealedSecrets,
          onToggleSecret: toggleSecret,
        }))
      : secretSpans.length > 0
        ? h(MaskedUserInline, { text: shown, spans: secretSpans, revealed: revealedSecrets, onToggle: toggleSecret })
        : h(MarkdownText, { text: shown, labels: mdLabels(), variant: 'compact' }))
    : null
  const area = foldArea(body, code, codeHead, actions)
  const hasRich = typeof renderUserAttachments === 'function' && ((row.imageRefs?.length ?? 0) > 0 || (row.fileRefs?.length ?? 0) > 0)
  const attachments = hasRich ? renderUserAttachments(row) : null
  const fileNames = !hasRich && Array.isArray(row.fileRefs) && row.fileRefs.length > 0
    ? row.fileRefs.map(file => file.name).filter(Boolean).join(', ')
    : ''
  const showBubble = Boolean(body || code !== undefined || (!hasRich && (row.images || fileNames)))
  const hasMeta = row.via !== undefined || (showTime && Number.isFinite(row.time))
  return h('div', { className: 'bt-urow', ...messageAnchor(row.sessionId, row.turn, 'prompt') },
    attachments,
    showBubble ? h('div', { className: 'bt-ububble', 'data-folded': folded || undefined, 'data-text-interaction-source': body || code !== undefined ? '' : undefined },
      control ? h('div', { className: 'bt-fold-body' }, area) : area,
      control,
      !hasRich && row.images ? h('span', { className: 'bt-uimages', 'data-text-interaction-exclude': '' }, row.images === 1 ? t('1 image') : t('{count} images', { count: row.images })) : null,
      fileNames ? h('span', { className: 'bt-uimages', 'data-text-interaction-exclude': '' }, fileNames) : null) : null,
    hasMeta ? h('div', { className: 'bt-utime', title: Number.isFinite(row.time) ? clockLabel(row.time) : undefined },
      row.via !== undefined ? h(ViaTag, { via: row.via }) : null,
      Number.isFinite(row.time) ? messageClock(row.time) : null) : null)
}

// Pure helpers for EarlierParts: merging skipped/multi-page earlier responses,
// keeping the closed-card reload key stable across later part switches, and trimming
// orphan part dividers.
export function earlierClosedKey(botParts, sessionId, closedCards) {
  const parts = Array.isArray(botParts) ? botParts : []
  const earlierParts = parts.includes(sessionId) ? parts.slice(0, parts.indexOf(sessionId)) : parts
  return JSON.stringify(earlierParts.map(part => [part, closedCards?.[part] ?? null]).filter(([, value]) => value !== null))
}

export function mergeEarlierPage(pages, page, fallbackPartIndex) {
  const incoming = Array.isArray(page.items) ? page.items : []
  const actualPartIndex = Number.isInteger(page.partIndex) ? page.partIndex : fallbackPartIndex
  const next = pages.slice()
  const at = next.findIndex(entry => entry.partIndex === actualPartIndex)
  // The host sends a part's aside cards on every page of that part.
  const btw = Array.isArray(page.btw) ? page.btw : (at >= 0 ? next[at].btw : [])
  if (at >= 0) next[at] = { partIndex: actualPartIndex, items: [...incoming, ...next[at].items], btw }
  else next.push({ partIndex: actualPartIndex, items: incoming, btw })
  next.sort((a, b) => a.partIndex - b.partIndex)
  return next
}

export function earlierItems(pages, { cursor, loading } = {}) {
  const items = []
  for (const page of pages) items.push(...withBtwRows(page.items, page.btw))
  // Drop trailing dividers from empty earlier parts right above the current part's own
  // divider, and drop leading dividers once all earlier history is loaded with nothing above.
  while (items.at(-1)?.kind === 'divider') items.pop()
  if (!cursor && !loading) {
    while (items[0]?.kind === 'divider') items.shift()
  }
  return { items, hasContent: items.some(item => item.kind !== 'divider') }
}

// The earlier parts of a Bot's own chat, above its current part as one conversation.
// Pages load from the host as the user scrolls up; a thin line marks where each
// part begins, the last one where the current part begins.
export function EarlierParts({ sessionId, roster, actions, openFile, renderUserText }) {
  const [view, setView] = useState({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null })
  const top = useRef(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const restore = useRef(null)
  const load = (cursor) => {
    if (busy.current) return
    const mine = generation.current
    // The host numbers a page by the same part index: cursor.part, or the part
    // before this one. A group's own Session chains `room.ownParts` + `sessionId`.
    const room = roster.roomsById[sessionId]
    const owner = roster.byId[sessionId] ?? (room === undefined ? undefined : { parts: room.ownParts, sessionId: room.sessionId })
    const partIndex = partIndexOf(owner, sessionId, cursor)
    busy.current = true
    setView(current => ({ ...current, loading: true, failed: false }))
    actions.earlier(sessionId, cursor).then((page) => {
      if (mine !== generation.current) return
      busy.current = false
      // The chat's scroller does not anchor content prepended above the viewport,
      // so the page keeps its distance from the end by hand.
      const scroller = top.current && scrollParent(top.current)
      if (scroller) restore.current = { scroller, fromEnd: scroller.scrollHeight - scroller.scrollTop }
      setView(current => ({
        pages: mergeEarlierPage(current.pages, page, partIndex),
        cursor: page.cursor,
        loading: false,
        failed: false,
        startedAt: page.startedAt ?? current.startedAt,
      }))
    }, () => {
      if (mine !== generation.current) return
      busy.current = false
      setView(current => ({ ...current, loading: false, failed: true }))
    })
  }
  const closedEarlier = earlierClosedKey(roster.byId[sessionId]?.parts, sessionId, roster.closedCards)
  useEffect(() => {
    generation.current += 1
    busy.current = false
    setView({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null })
    load(undefined)
    return () => { generation.current += 1 }
  }, [sessionId, closedEarlier])
  useLayoutEffect(() => {
    const pending = restore.current
    restore.current = null
    if (pending) pending.scroller.scrollTop = pending.scroller.scrollHeight - pending.fromEnd
  }, [view.pages])
  useEffect(() => {
    const node = top.current
    if (!node || view.loading || view.failed || !view.cursor || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) load(view.cursor)
    }, { root: scrollParent(node), rootMargin: '600px 0px 0px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [view.cursor, view.loading, view.failed])
  const removeBtw = useCallback(cardId => setView(current => ({
    ...current,
    pages: current.pages.map(page => ({ ...page, btw: page.btw.filter(card => card?.id !== cardId) })),
  })), [])
  const { items, hasContent } = earlierItems(view.pages, view)
  return h('div', { className: 'bt-earlier', role: 'feed', 'aria-label': t('Earlier messages'), 'aria-busy': view.loading },
    h('div', { ref: top, className: 'bt-earlier-top' },
      view.loading ? h(Shimmer, null, t('Loading earlier messages…'))
        : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Couldn’t load earlier messages · Retry'))
          : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Load earlier')) : null),
    h(ChatRows, { items, sessionId, roster, actions, openFile, onBtwDelete: removeBtw, renderUserText }),
    hasContent ? h(PartLine, { time: view.startedAt }) : null)
}

// A Bot chat's entries as the host lists them (the `earlier` and `chat` endpoints): the
// Bot's messages in a row are one block, and a thin line marks where a part begins.
// `clock` adds the time separators: one above the first entry, and one after each pause.
const NOOP_UI = () => undefined

function stableChatRowBaseKey(row) {
  const seg = row.sessionId !== undefined && row.sessionId !== null ? `${row.sessionId}:` : ''
  if (row.id !== undefined && row.id !== null) return `${seg}${row.kind}:id:${row.id}`
  switch (row.kind) {
    case 'post': return `${seg}post:${row.seq ?? row.time ?? ''}:${row.botId ?? ''}`
    case 'view': return `${seg}view:${row.callId ?? row.time ?? ''}`
    case 'btw': return `${seg}btw:${row.card?.id ?? row.time ?? ''}`
    case 'divider': return `${seg}divider:${row.time ?? ''}`
    case 'bot': return `${seg}bot:${row.time ?? ''}`
    case 'relay': return `${seg}relay:${row.reply?.botId ?? ''}:${row.reply?.kind ?? ''}:${row.time ?? row.reply?.time ?? ''}`
    case 'event': return `${seg}event:${row.role ?? ''}:${row.botId ?? row.roomId ?? ''}:${row.time ?? ''}`
    case 'user': return `${seg}user:${row.seq ?? row.time ?? ''}`
    default: return `${seg}${row.kind ?? 'row'}:${row.seq ?? row.time ?? ''}`
  }
}

const MemoEarlierUser = memo(EarlierUser, undefined, 'EarlierUser')
const MemoGroupMessage = memo(GroupMessage, undefined, 'GroupMessage')
const MemoPartLine = memo(PartLine, undefined, 'PartLine')
const MemoEventLine = memo(EventLine, undefined, 'EventLine')
const MemoGroupEvent = memo(GroupEvent, undefined, 'GroupEvent')
const MemoBubbles = memo(Bubbles, undefined, 'Bubbles')
const MemoRelayEvent = memo(RelayEvent, undefined, 'RelayEvent')

// Stable per-row caches so fallback objects (`poster`, `whole`, `args`) keep exact
// references across appends/prepends and allow `React.memo` to bail out on unchanged rows.
const fallbackBotCache = new WeakMap()
const wholeLoaderCache = new WeakMap()
const viewArgsCache = new WeakMap()

function stableFallbackBot(row, id, name, color) {
  let cached = fallbackBotCache.get(row)
  if (!cached || cached.id !== id || cached.name !== name || cached.color !== color) {
    cached = { id, name, color }
    fallbackBotCache.set(row, cached)
  }
  return cached
}

function stableWhole(row, actions) {
  if (!row.file) return undefined
  let cached = wholeLoaderCache.get(row)
  if (!cached || cached.file !== row.file || cached.length !== row.length || cached.actions !== actions) {
    cached = {
      file: row.file,
      length: row.length,
      actions,
      value: { length: row.length, load: () => actions.fileText(row.file) },
    }
    wholeLoaderCache.set(row, cached)
  }
  return cached.value
}

function stableViewArgs(row) {
  let cached = viewArgsCache.get(row)
  if (!cached || cached.title !== row.title || cached.view !== row.view) {
    cached = {
      title: row.title,
      view: row.view,
      value: { text: name => (name === 'title' ? row.title : undefined), value: name => (name === 'view' ? row.view : undefined) },
    }
    viewArgsCache.set(row, cached)
  }
  return cached.value
}

const eventBotsCache = new WeakMap()
const stableEventBots = (row, other) => {
  let cached = eventBotsCache.get(row)
  if (!cached || cached.other !== other) {
    cached = { other, value: [other] }
    eventBotsCache.set(row, cached)
  }
  return cached.value
}

const eventOpenCache = new WeakMap()
const stableEventOpen = (row, selfId, otherId, actions) => {
  let cached = eventOpenCache.get(row)
  if (!cached || cached.selfId !== selfId || cached.otherId !== otherId || cached.actions !== actions) {
    cached = { selfId, otherId, actions, value: () => { if (selfId && otherId) actions.openExchange(selfId, otherId) } }
    eventOpenCache.set(row, cached)
  }
  return cached.value
}

// `useUi` gives a block its reactions and its Reply tool.
// Each row component is individually memoized with stable keys and stable props so
// appending a new group message (or prepending an earlier page) skips unchanged rows.
function chatRow(row, key, { sessionId, selfId, roster, actions, useUi, openFile, onBtwDelete, renderUserAttachments, renderUserText, locale }) {
  switch (row.kind) {
    case 'divider': return h(MemoPartLine, { key, time: row.time, locale })
    case 'user': return h(MemoEarlierUser, { key, row, sessionId, roster, actions, renderUserAttachments, renderUserText, locale })
    case 'answer': return h(AnsweredReply, { key, node: { data: row } })
    // A question or view card closed without an answer on it.
    case 'closed': return row.view === undefined
      ? h('div', { key, className: 'bt-q-inline' }, h(SettledQuestion, { question: row.question, closed: row.closed }))
      : h(ClosedView, { key, title: row.title, view: row.view, closed: row.closed })
    // A display-only view replays from the blueprint the host kept on the call.
    case 'view': return h(WidgetCell, { key, sessionId, callId: row.callId, args: stableViewArgs(row), done: true, isError: false, roster, actions })
    case 'bot': {
      const bubbles = h(MemoBubbles, { key, texts: row.texts, roster, selfId, actions, sessionId: useUi ? sessionId : undefined, msgKey: useUi ? `${sessionId}:${row.time}` : undefined, useUi, fold: FOLD_HUGE, textInteractionSource: true, locale })
      const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[selfId] : undefined
      return speaker ? h(Fragment, { key }, h(SpeakerHead, { bot: speaker, time: row.time }), bubbles) : bubbles
    }
    case 'btw': return h(BtwCardView, { key, card: row.card, sessionId, actions, onDeleted: onBtwDelete })
    case 'post': {
      // A member's message in a group's earlier part, as the live row shows it.
      const poster = roster.byId[row.botId] ?? stableFallbackBot(row, row.botId, row.name ?? t('a Bot'), row.color ?? 'gray')
      return h(MemoGroupMessage, {
        key, bot: poster, text: row.file ? stripLongNote(row.text) : row.text, texts: row.texts, files: row.presented ?? row.files, openFile, room: roster.roomsById[sessionId], sessionId, roster, actions,
        msgKey: `${sessionId}:post:${row.seq ?? row.time}`, time: row.time, duration: row.duration, claims: row.claims, changes: row.changes, useUi,
        whole: stableWhole(row, actions), locale, anchorSessionId: row.sessionId, turn: row.turn, messageId: row.messageId,
      })
    }
    case 'relay': {
      // A round notice from a group_relay result on an earlier part, the row the
      // live chat draws for it.
      const reply = row.reply
      const speaker = roster.byId[reply.botId] ?? stableFallbackBot(row, reply.botId, reply.name ?? t('a Bot'), reply.color ?? 'gray')
      return h(MemoRelayEvent, { key, reply, bot: speaker, sessionId, actions, locale })
    }
    case 'event': {
      if (row.role === 'report') return h(MemoGroupEvent, { key, prefix: t('Replies from'), room: roster.roomsById[row.roomId], name: t('a group chat'), roster, actions, locale })
      const other = roster.byId[row.botId] ?? stableFallbackBot(row, row.botId, row.name ?? t('a Bot'), 'gray')
      const prefix = {
        stopped: t('Stopped by'),
        cancelled: t('Cancelled by'),
        note: t('Note from'),
        ask_back: t('Question from'),
        answer: t('Answer from'),
        reply: t('Reply from'),
      }[row.role] ?? t('Message from')
      return h(MemoEventLine, { key, prefix, bots: stableEventBots(row, other), onOpen: stableEventOpen(row, selfId, other.id, actions), whole: true, locale })
    }
    default: return null
  }
}

export function ChatRows({ items, sessionId, roster, actions, useUi = NOOP_UI, clock = false, openFile, onBtwDelete, renderUserAttachments, renderUserText }) {
  const selfId = roster.byId[sessionId]?.id
  const visit = useUi(state => state?.visits?.[sessionId])
  const locale = localeKey()
  // Preserve merged `bot` row object identity across appends/prepends so memoized rows stay hit.
  const botRunCacheRef = useRef(new Map())
  const rows = useMemo(() => {
    const prevCache = botRunCacheRef.current
    const nextCache = new Map()
    const out = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const last = out.at(-1)
      if (item.kind === 'divider' && last?.kind === 'divider') {
        // Collapse consecutive dividers from empty parts into one, keeping the latest start time.
        out[out.length - 1] = item
      } else if (item.kind === 'bot') {
        const texts = [item.text]
        let end = item.time
        while (i + 1 < items.length && items[i + 1].kind === 'bot' && (items[i + 1].sessionId ?? null) === (item.sessionId ?? null)) {
          i += 1
          texts.push(items[i].text)
          end = items[i].time
        }
        const runKey = `${item.sessionId ?? ''}:${item.id ?? ''}:${item.time ?? ''}:${end ?? ''}:${texts.length}`
        const cached = prevCache.get(runKey)
        const same = cached && cached.texts.length === texts.length && cached.texts.every((value, idx) => value === texts[idx])
        const merged = same ? cached : { ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}), ...(item.id !== undefined ? { id: item.id } : {}), kind: 'bot', texts, time: item.time, end }
        nextCache.set(runKey, merged)
        out.push(merged)
      } else {
        out.push(item)
      }
    }
    botRunCacheRef.current = nextCache
    return out
  }, [items])
  useEffect(() => {
    if (!clock || typeof actions?.noteTurnTime !== 'function') return
    rows.forEach((row, index) => {
      if (row.kind !== 'divider' && Number.isFinite(row.time)) {
        actions.noteTurnTime(sessionId, row.seq ?? `row:${index}`, 'first', row.time)
      }
    })
  }, [clock, sessionId, rows, actions])
  let before
  let newShown = false
  const seenKeys = new Map()
  return rows.flatMap((row) => {
    // Keys stay stable across both prepends (earlier pages) and appends (new live messages).
    const baseKey = stableChatRowBaseKey(row)
    const count = seenKeys.get(baseKey) ?? 0
    seenKeys.set(baseKey, count + 1)
    const key = count === 0 ? baseKey : `${baseKey}#${count}`
    const shown = chatRow(row, key, { sessionId, selfId, roster, actions, useUi, openFile, onBtwDelete, renderUserAttachments, renderUserText, locale })
    // A part's first entry shows its time under the part's line, as a chat's first one does.
    if (row.kind === 'divider') {
      before = undefined
      return [shown]
    }
    const pause = clock && Number.isFinite(row.time) && (before === undefined || row.time - before >= SEPARATOR_GAP_MS)
    if (Number.isFinite(row.end ?? row.time)) before = row.end ?? row.time
    const showNew = clock && !newShown && unseenSince(visit, row.time)
    if (showNew) newShown = true
    const out = []
    if (showNew) out.push(h(NewDivider, { key: `${key}:new` }))
    if (pause) out.push(h('div', { key: `${key}:clock`, className: 'bt-time-sep', role: 'separator' }, clockLabel(row.time)))
    out.push(shown)
    return out
  })
}

export function TriggerCell({ node, sessionId, openFile, useRoster, useSessions, useTurnClock, useUi, actions }) {
  const roster = useRosterPick(useRoster, TRIGGER_ROSTER_FIELDS)
  const data = node.data
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  // Team state (exchanges) is keyed by the Bot id; Session state by the part shown.
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  // A resumed handoff keeps the relayed message's source, but it opens a part, not a run.
  // A deferred request was already shown where the Bot read it mid-turn; the turn
  // that answers it adds no second line.
  const deferred = source.kind === 'bot' && source.deferred === true
  const relayed = isRelayContext(data)
  const turn = node.location?.turn?.turn ?? data.turn
  // Noted before paint so a folded line never flashes in before its run's first line.
  useLayoutEffect(() => {
    if (relayed) actions.noteTurnPeer(sessionId, turn, source.senderSessionId)
  }, [relayed, sessionId, turn, source.senderSessionId])
  const order = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.map(entry => entry.turn).join(',') : ''
  })
  const peers = useTurnClock((state) => {
    if (!relayed) return ''
    const turns = state[sessionId] ?? {}
    return Object.keys(turns).filter(key => turns[key].peer !== undefined).map(key => `${key}:${turns[key].peer}`).join(',')
  })
  // A conversation opened for the first time since it began starts under the
  // unread divider, with its opening time below it.
  const visit = useUi(state => state.visits?.[sessionId])
  const hiddenTurns = roster.exchangeTurns[sessionId]
  const unreadOpening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], order, hiddenTurns)
    return first?.turn === turn && unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  const body = triggerBody()
  return unreadOpening
    ? h(Fragment, null, h('div', { className: 'bt-open-new' }, h(NewDivider), h('div', { className: 'bt-time-sep', role: 'separator' }, unreadOpening)), body)
    : (body ?? h(CellEmpty))

  function triggerBody() {
    if (source.kind === 'bot') {
      // A part opens with its handoff package, so the earlier parts go right above it.
      if (source.handoff === true) return h(EarlierParts, { sessionId, roster, actions, openFile })
      // Group turns belong to the group chat; the member's own chat stays one-to-one.
      // Background task handoff notices and computer handback notices are model-only context.
      if (source.role === 'kickoff' || source.role === 'room' || source.role === 'goal' || source.role === 'task-handoff' || source.role === 'handback') return null
      // The secret card itself shows what the user did; the note to the Bot stays out.
      if (source.role === 'secret' || deferred) return null
      if (source.role === 'note' || source.role === 'cancelled' || source.silent === true) return null
      // A profile notice is the user's edit landing in the Bot's chat, not a peer
      // message: show it as an event, with no exchange to open.
      if (source.role === 'update') return h('div', { className: 'bt-event' }, t('Profile updated'))
      if (source.role === 'post') {
        // A post logged into a running round already shows there, not again as a trigger.
        if (source.logged !== undefined) return null
        // A member's late failure, its work picked up after a restart, its work the user
        // stopped, the end of its work, or a user-continued pause shows as an event of the round.
        if (source.failed !== undefined || source.resumed === true || source.stopped === true || source.done === true || source.resumedPause === true) return null
        const room = roster.roomsById[sessionId]
        const poster = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
        // A post past what a message holds came as a file, with its start only.
        const file = source.length === undefined ? undefined : (data.content ?? []).find(block => block?.type === 'file')?.attachment
        const text = stripHeader(contentText(data.content))
        // A trigger's data carries no turn; its event seq is the one durable name of this post.
        return h(GroupMessage, {
          bot: poster, text: file ? stripLongNote(text) : text, files: presentedFiles(source.presented), openFile, room, sessionId, roster, actions, msgKey: `${sessionId}:post:${data.seq ?? node.key}`, useUi, time: data.time,
          claims: source.claims, anchorSessionId: sessionId, turn,
          changes: source.changes,
          whole: file ? { length: source.length, load: () => actions.fileText(file) } : undefined,
        })
      }
      if (source.role === 'report') {
        return h(GroupEvent, { prefix: t('Replies from'), room: roster.roomsById[source.roomId], name: t('a group chat'), roster, actions })
      }
      // A request carried on keeps its role, but its message line was shown already.
      if (source.role === 'resume' || source.resumed === true) return h('div', { className: 'bt-event' }, t('Picked up its work after a restart'))
      if (source.role === 'retry' || source.retried === true) return h('div', { className: 'bt-event' }, t('Asked to make the tool call it wrote as text'))
      // The repair card's Retry: the user's message is not sent again, nor is the note to the Bot.
      if (source.role === 'continue') return h('div', { className: 'bt-event' }, t('Went on after the failed turn'))
      const run = relayed ? commRunOf(
        order.split(',').filter(Boolean).map(Number),
        Object.fromEntries(peers.split(',').filter(Boolean).map(pair => [Number(pair.slice(0, pair.indexOf(':'))), pair.slice(pair.indexOf(':') + 1)])),
        turn,
        hiddenTurns,
      ) : null
      if (run === 'folded') return null
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      const count = run?.count ?? (isHiddenTurn(roster, sessionId, turn) ? 2 : 1)
      // Peers may be named by any part of their chat, so they are matched by Bot.
      const bots = [sender]
      for (const peer of (run?.peerIds ?? []).map(id => roster.byId[id]).filter(Boolean)) {
        if (!bots.some(bot => bot.id === peer.id)) bots.push(peer)
      }
      return h(EventLine, {
        prefix: source.role === 'stopped' ? t('Stopped by')
          : source.role === 'ask_back' ? t('Question from')
            : source.role === 'answer' ? t('Answer from')
              : count > 1 ? t('{count} messages with', { count }) : t('Message from'),
        bots,
        onOpen: bot => actions.openExchange(selfId, bot.id),
        whole: true,
      })
    }
    if (source.kind === 'schedule') {
      const prompts = reminderPrompts(contentText(data.content))
      return h('div', { className: 'bt-event' }, prompts.length > 0 ? t('Scheduled task: {text}', { text: prompts.join(' · ').slice(0, 80) }) : t('Routine started'))
    }
    if (source.kind === 'user-question-reply' || source.kind === 'goal') return null
    return h('div', { className: 'bt-event' }, contentText(data.content).slice(0, 80) || t('Update'))
  }
}

// The header's new-message pills look for the divider every frame; a query for it
// walks the whole transcript whenever there is none, so the dividers register here.
const newDividers = new Set()

export function newDividerIn(scroller) {
  let first = null
  for (const node of newDividers) {
    if (!scroller.contains(node)) continue
    if (first === null || first.compareDocumentPosition(node) & first.DOCUMENT_POSITION_PRECEDING) first = node
  }
  return first
}

export function NewDivider() {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const node = ref.current
    newDividers.add(node)
    return () => { newDividers.delete(node) }
  }, [])
  return h('div', { ref, className: 'bt-new-sep', role: 'separator', 'aria-label': t('New messages') }, h('span', null, t('New')))
}

export function TurnProcessCell({ node, sessionId, turnProcess, useRoster, useUi, useTurnClock, actions }) {
  const open = turnProcess === undefined || !turnProcess.foldable || turnProcess.open
  useEffect(() => {
    if (!open) turnProcess.setOpen(true)
  }, [open, turnProcess])
  const turn = node?.location?.turn?.turn ?? node?.data?.turn
  const start = node?.location?.turn?.start?.time
  const hidden = useRoster(roster => isHiddenTurn(roster, sessionId, turn))
  // Exchange turns hide their replies but still show their trigger chip, so their start
  // counts for separators too.
  useEffect(() => {
    actions.noteTurnTime(sessionId, turn, 'first', start)
  }, [sessionId, turn, start])
  // The reply to a turn the user saw begin arrived while the user was away.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    const own = state[sessionId]?.[turn]
    return !hidden && typeof visit?.seen === 'number' && own?.first !== undefined && own.first <= visit.seen
      && own.end !== undefined && own.end > visit.seen && own.end <= visit.entered
  })
  return fresh ? h(NewDivider) : h(CellEmpty)
}

export function Nothing() { return null }

export { CellEmpty }

// A pause longer than this splits the transcript with a time separator.
const SEPARATOR_GAP_MS = 30 * 60 * 1000
function nextTurnStart(turns, turn) {
  let next
  for (const key in turns) {
    const candidate = Number(key)
    if (candidate > turn && turns[key].first !== undefined && (next === undefined || candidate < next)) next = candidate
  }
  return next === undefined ? undefined : turns[next].first
}
// The first turn the transcript shows: the earliest rendered start, with only hidden
// exchange turns before it. `firstTurns` lists the outline's first turns.
export function openingTurn(turns, firstTurns, hiddenTurns) {
  if (!turns || !firstTurns) return null
  const start = nextTurnStart(turns, -Infinity)
  if (start === undefined) return null
  const turn = Number(Object.keys(turns).filter(key => turns[key].first === start)[0])
  const listed = firstTurns.split(',').map(Number)
  const earlier = listed.filter(entry => entry < turn)
  return listed.includes(turn) && earlier.every(entry => hiddenTurns?.includes(entry)) ? { turn, start } : null
}
// Began after the user last left the conversation and before this visit opened it.
export const unseenSince = (visit, time) => typeof visit?.seen === 'number' && time > visit.seen && time <= visit.entered

// An entry in DSH's own turn tail, after what other plugins put there (the cards of
// the files a turn delivered). The tail sits right before the next turn's first row,
// so the separator for a pause between turns renders here.
export function TurnTailCell({ turn: location, sessionId, useTurnClock, useUi, actions }) {
  const turn = location.turn
  // DSH builds the tail from the turn's end, so it is there.
  const time = location.end.time
  useEffect(() => { actions.noteTurnTime(sessionId, turn, 'end', time) }, [sessionId, turn, time])
  const label = useTurnClock((state) => {
    const start = nextTurnStart(state[sessionId] ?? {}, turn)
    return start !== undefined && start - time >= SEPARATOR_GAP_MS ? clockLabel(start) : ''
  })
  // The unread divider sits before the first turn that began after the last visit;
  // turns that begin while the conversation is open were watched live.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number' || time > visit.seen) return false
    const start = nextTurnStart(state[sessionId] ?? {}, turn)
    return start !== undefined && start > visit.seen && start <= visit.entered
  })
  if (!label && !fresh) return null
  return h(Fragment, null,
    label ? h('div', { className: 'bt-time-sep', role: 'separator' }, label) : null,
    fresh ? h(NewDivider) : null)
}

export function Shimmer({ children }) {
  return h('span', { className: 'bt-shimmer' }, children)
}

// The time since `at`, from 1s. It ticks on its own whole seconds, so its parent does
// not render again each second. `dot` leads it with a separator, for a line it ends.
export function Elapsed({ at, className, dot = true }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const time = Date.now()
      setNow(time)
      timer = setTimeout(tick, 1000 - (((time - at) % 1000) + 1000) % 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [at])
  const label = elapsedLabel(Math.max(1000, now - at))
  return h('span', { className }, dot ? `· ${label}` : label)
}

// Status phrases. A running tool names what it does; otherwise one
// phrase is drawn from the pool each time the activity changes.
export const PHRASES = {
  thinking: ['Thinking about it', 'Weighing the options', 'Working out a plan', 'Sorting out the details'],
  working: ['On it', 'Busy with it', 'Moving ahead', 'Taking care of it', 'Making headway'],
}
const TOOL_PHRASES = [
  [/^cua(_driver_native__|$)|^computer_/, 'Using the computer'],
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/grep|glob|list_dir|^ls$|find|search/i, 'Looking through files'],
  [/write|edit|patch|apply|replace/i, 'Writing changes'],
  [/image|photo|draw/i, 'Working on an image'],
]
const GROUP_PHRASES = { create_group: 'Creating a group', update_group: 'Updating the group', delete_group: 'Deleting the group', post_to_group: 'Posting in the group' }
function toolActivity(name, arg, findBot, self) {
  switch (name) {
    case 'ask_user': return null
    case 'request_secret': return null
    case 'list_secrets': return { label: t('Checking the keys'), state: 'searching' }
    case 'ask_user_question': return { label: t('Waiting for your answer'), state: 'alert' }
    case 'group_relay': return { relay: true, state: 'orbit' }
    case 'message_bot':
    case 'delegate_work': {
      const target = findBot(arg('to'))
      return { label: target ? t('Delegating to {name}', { name: target.name }) : t('Delegating to another Bot'), state: 'sending' }
    }
    case 'ask_back':
      return { label: t('Asking a teammate'), state: 'sending' }
    case 'answer_work':
      return { label: t('Answering a teammate'), state: 'sending' }
    case 'cancel_work': {
      const target = findBot(arg('target'))
      return { label: target ? t('Cancelling work for {name}', { name: target.name }) : t('Cancelling delegated work'), state: 'sending' }
    }
    case 'note_bot': {
      const target = findBot(arg('to'))
      return { label: target ? t('Leaving a note for {name}', { name: target.name }) : t('Leaving a note'), state: 'sending' }
    }
    case 'stop_bot': {
      const target = findBot(arg('bot'))
      return { label: target ? t('Stopping {name}', { name: target.name }) : t('Stopping another Bot'), state: 'sending' }
    }
    case 'create_bot': return { label: t('Creating {name}', { name: arg('name') ?? t('a Bot') }), state: 'sending' }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return { label: t('Updating {name}', { name: target?.name ?? t('a Bot') }), state: 'sending' }
    }
    case 'list_bots': return { label: t('Checking the team'), state: 'searching' }
    case 'read_group_chat': return { label: t('Reading {name}', { name: arg('group') ?? t('a group chat') }), state: 'searching' }
    case 'read_own_chat': return { label: t('Looking back through the chat'), state: 'searching' }
    case 'bot_remember':
    case 'remember': return { label: t('Saving to memory'), state: 'working' }
    case 'bot_forget':
    case 'forget': return { label: t('Updating memory'), state: 'working' }
    case 'bot_recall':
    case 'recall': return { label: t('Checking memory'), state: 'searching' }
    default:
      if (GROUP_PHRASES[name]) return { label: t(GROUP_PHRASES[name]), state: 'sending' }
      const phrase = TOOL_PHRASES.find(([pattern]) => pattern.test(name))?.[1]
      return { label: phrase ? t(phrase) : null, state: toolState(name) }
  }
}

// What a Bot busy elsewhere is doing: what it said in the step it is on, its running
// call's own description, else the kind of tool and what it works on. `doing` is a work
// entry, or just a tool name.
export function workPhrase(doing) {
  const { tool, said, note, target, switching, folder } = typeof doing === 'string' ? { tool: doing } : doing ?? {}
  if (switching) return folder === true ? t('Switching working folder') : t('Moving to a fresh conversation')
  const own = (said || note)?.replace(/[\s.。…]+$/u, '')
  if (own) return own
  if (!tool) return t('Thinking about it')
  const label = toolActivity(tool, () => undefined, () => undefined)?.label ?? t('On it')
  return target ? `${label} · ${target}` : label
}

// Transcript rows report what is in flight to the one activity row at the tail.
function useLiveNote(actions, sessionId, id, entry) {
  const key = entry ? JSON.stringify(entry) : ''
  useEffect(() => {
    if (!key) return undefined
    actions.noteLive(sessionId, id, JSON.parse(key))
    return () => actions.noteLive(sessionId, id, null)
  }, [sessionId, id, key])
}

function helperFailureReason(reply) {
  let why
  switch (reply.stopReason) {
    case 'max-tokens': why = t('Reached the output limit'); break
    case 'aborted': why = t('Stopped before finishing'); break
    case 'refusal': why = t('Declined the task'); break
    case 'error': why = t('Run failed'); break
    default: why = reply.stopReason ? `${t('Run failed')} (${reply.stopReason})` : (reply.text || t('Run failed')); break
  }
  return reply.helper ? `${reply.helper} (${why})` : why
}

function RoomPauseEvent({ reply, bot, room, canResume, actions }) {
  const [busy, setBusy] = useState(false)
  const onContinue = () => {
    if (busy || !room?.id) return
    setBusy(true)
    Promise.resolve(actions.resumeRoomPause(room.id))
      .catch(error => actions.reportError?.(error, 'room-pause'))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-event' },
    h('span', null, reply.idle
      ? t('{names} went back and forth {count} times without progress and paused. Write here to go on', { count: reply.count, names: [bot.name, ...(reply.names ?? [])].join(t(' and ')) })
      : t('Paused after {count} Bot relays. Waiting: {names}', { count: reply.count, names: (reply.names ?? []).join(t(' and ')) })),
    canResume
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onContinue }, t('Continue'))
      : null)
}

// One non-message row of a group round: the same event line the live view draws
// for a reply that is not a member's message or the user's own line. `bot` is the
// resolved member the reply names.
function RelayEvent({ reply, bot, room, sessionId, actions, latestPaused = false }) {
  if (reply.kind === 'failed') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: [reply.code, reply.status, reply.text].filter(Boolean).join(' · ') },
      t('{name} stopped: {reason}. Switch its model or ask it to go on.', { name: bot.name, reason: failureLabel(reply.code, reply.text) }))
  }
  if (reply.kind === 'helper-failed') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: reply.text || undefined },
      t("{name}'s background helper did not finish: {reason}. Ask it to go on if it still matters.", { name: bot.name, reason: helperFailureReason(reply) }))
  }
  if (reply.kind === 'lookup') {
    return h('div', { className: 'bt-event' },
      reply.text ? t('{name} looked up its own chat for “{text}”', { name: bot.name, text: reply.text }) : t('{name} looked up its own chat', { name: bot.name }))
  }
  if (reply.kind === 'missed') {
    return h('div', { className: 'bt-event' }, t("{name} didn't answer in time", { name: bot.name }))
  }
  if (reply.kind === 'admin-passed') {
    return h('div', { className: 'bt-event' },
      t('{name} did not answer or call anyone; call a member with @Name', { name: bot.name }))
  }
  // Bots that went back and forth without progress. LEGACY: rounds from when groups
  // paused at a relay limit.
  if (reply.kind === 'paused') {
    const canResume = latestPaused && room?.idlePaused !== undefined && typeof actions?.resumeRoomPause === 'function'
    return h(RoomPauseEvent, { reply, bot, room, canResume, actions })
  }
  if (reply.kind === 'resumed') {
    return h('div', { className: 'bt-event' }, t('{name} was cut off by a restart and picked its work back up', { name: bot.name }))
  }
  if (reply.kind === 'cut') {
    return h('div', { className: 'bt-event' }, t('{name} was cut off by a restart again and stopped', { name: bot.name }))
  }
  if (reply.kind === 'approval' || reply.kind === 'working') {
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', onClick: () => actions.showDetails(sessionId) },
        h(BotMark, { bot, size: 16 }), h('span', { className: 'bt-event-name' }, t(reply.kind === 'working' ? '{name} started on it' : '{name} paused for your approval', { name: bot.name }))))
  }
  if (reply.kind === 'folder') {
    return h('div', { className: 'bt-event' }, reply.text)
  }
  if (reply.kind === 'schedule') {
    return h('div', { className: 'bt-event' }, reply.text ? t('Scheduled task: {text}', { text: reply.text.slice(0, 80) }) : t('Routine started'))
  }
  if (reply.kind === 'stopped') {
    return h('div', { className: 'bt-event' }, t("You stopped {name}'s work", { name: bot.name }))
  }
  if (reply.kind === 'done') {
    const line = h('div', { className: 'bt-event' }, t('{name} finished its work', { name: bot.name }))
    return reply.changes === undefined ? line : h(Fragment, null, line, h(ChangesCard, { changes: reply.changes, actions }))
  }
  return null
}

// Rows a later call closed do not change: each is read from the group's book once per page.
const MAX_SETTLED_ROWS = 120
export const settledRows = new Map()

function GroupReplies({ sessionId, callId, done, content, roster, actions, useRoster, useUi, useWork, openFile }) {
  const [live, setLive] = useState({ replies: [], speaking: [] })
  useEffect(() => {
    if (done) return undefined
    let stop = false
    let timer
    let seen = ''
    let delay = 1000
    const tick = async () => {
      try {
        const result = await actions.roomProgress(sessionId)
        if (stop) return
        if (Array.isArray(result)) {
          delay = 1000
          const entry = result.find(item => item.callId === callId) ?? result[0]
          const key = entry ? JSON.stringify([entry.replies, entry.speaking]) : ''
          if (entry && key !== seen) { seen = key; setLive({ replies: entry.replies ?? [], speaking: [entry.speaking ?? []].flat() }) }
        } else {
          delay = Math.min(delay * 2, 30_000)
        }
      } catch {
        if (stop) return
        delay = Math.min(delay * 2, 30_000)
      }
      timer = setTimeout(tick, document.hidden ? Math.max(5000, delay) : delay)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [done, sessionId, callId])
  // A settled round names where its rows are in the group's book; one from before
  // the ledger carries them in its result.
  const resultText = done ? contentText(content) : ''
  const range = done ? relayRange(resultText) : undefined
  const preview = compressedRelayPreview(resultText)
  const [recovered, setRecovered] = useState(null)
  useEffect(() => {
    if (preview === undefined) return undefined
    let stop = false
    void actions.groupRelayReplies(sessionId, preview).then(replies => {
      if (!stop) setRecovered({ sessionId, preview, replies })
    })
    return () => { stop = true }
  }, [sessionId, preview])
  const rowsKey = range === undefined ? undefined : `${sessionId}:${range.from}:${range.to ?? ''}:${range.anchor ?? ''}`
  const [view, setView] = useState(() => (rowsKey === undefined ? null : lruGet(settledRows, rowsKey) ?? null))
  // An open cell that is quiet is read again when the team changes, not on a clock.
  const quiet = view?.open === true && view.active !== true
  const quietRevision = useRoster?.(value => (quiet ? value.revision : undefined))
  const quietKey = quiet ? (quietRevision ?? roster.revision) : undefined
  useEffect(() => {
    if (rowsKey === undefined) return undefined
    const known = lruGet(settledRows, rowsKey)
    if (known !== undefined) { setView(known); return undefined }
    // The newest call's rows grow while the group works: they are read every second then,
    // and once when the group is quiet, until the next call closes them.
    let stop = false
    let timer
    let seen = ''
    let delay = 1000
    const tick = async () => {
      try {
        const next = await actions.groupRows(sessionId, range.from, range.to, range.anchor)
        if (stop) return
        if (next !== null && Array.isArray(next?.rows)) {
          delay = 1000
          if (!next.open) lruSet(settledRows, rowsKey, next, MAX_SETTLED_ROWS)
          const key = JSON.stringify(next)
          if (key !== seen) { seen = key; setView(next) }
          if (!next.open || next.active !== true) return
        } else {
          delay = Math.min(delay * 2, 30_000)
        }
      } catch {
        if (stop) return
        delay = Math.min(delay * 2, 30_000)
      }
      timer = setTimeout(tick, document.hidden ? Math.max(5000, delay) : delay)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [rowsKey, quietKey])
  let replies = live.replies
  let broken = false
  if (range !== undefined) {
    replies = view?.rows ?? live.replies
  } else if (done) {
    const restored = recovered?.sessionId === sessionId && recovered.preview === preview ? recovered.replies : null
    if (Array.isArray(restored)) replies = restored
    else {
      const parsed = parseReplies(resultText)
      replies = parsed.replies.length ? parsed.replies : live.replies
      broken = parsed.broken
    }
  }
  // Every member answering in the round is typing; what each is doing comes as text,
  // so the cell redraws only when that changes.
  const pending = range !== undefined ? (view?.open ? view.speaking ?? [] : []) : done ? [] : live.speaking
  const doing = JSON.parse(useWork?.(work => JSON.stringify(pending.map((id) => {
    const tool = work.bots?.[id]?.tool
    return tool ? [tool, workPhrase(work.bots[id])] : []
  }))) ?? '[]')
  if (replies.length === 0 && pending.length === 0) {
    // A pruned tool result left nothing to draw; keep a marker row instead of an
    // empty turn, which reads as a blank gap on a narrow first paint.
    return broken ? h('div', { className: 'bt-group-replies' }, h('div', { className: 'bt-event' }, t('The group replies could not be shown'))) : h(CellEmpty)
  }
  const room = roster.roomsById[sessionId]
  const stacked = stackReplies(replies)
  const latestRound = range === undefined || view?.open === true
  let lastPausedIndex = -1
  if (latestRound) {
    for (let at = stacked.length - 1; at >= 0; at -= 1) {
      if (stacked[at].reply.kind === 'paused') { lastPausedIndex = at; break }
    }
  }
  return h('div', { className: 'bt-group-replies' },
    stacked.map(({ reply, index, texts, files, time, duration, claims, changes }, at) => {
      const bot = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name, color: reply.color ?? 'gray' }
      if (reply.kind === 'user') {
        return h(EarlierUser, {
          key: `user-${index}`,
          row: { ...reply, time },
          sessionId,
          roster,
          actions,
          showTime: true,
        })
      }
      if (reply.kind === 'goal') {
        return h('div', { key: `goal-${index}`, className: 'bt-event', title: reply.text || undefined },
          h('span', { className: 'bt-event-ico', 'aria-hidden': true }, h(GoalIcon)), goalEventText(reply))
      }
      if (reply.kind !== undefined) {
        return h(RelayEvent, { key: `${reply.botId ?? reply.kind}-${index}`, reply, bot, room, sessionId, actions, latestPaused: at === lastPausedIndex })
      }
      return h(GroupMessage, { key: `${reply.botId}-${index}`, bot, texts, files, openFile, room, sessionId, roster, actions, msgKey: callId ? `${sessionId}:${callId}:${index}` : undefined, useUi, time, duration, claims, changes })
    }),
    pending.map((id, at) => {
      const bot = roster.byId[id]
      if (!bot) return null
      const [tool, phrase] = doing[at] ?? []
      return h('div', { key: `pending-${id}`, className: 'bt-activity' },
        h(BotMark, { bot: bot, size: 22, state: tool ? toolState(tool) : 'thinking' }),
        h(Shimmer, null, phrase ? `${bot.name} · ${phrase}…` : t('{name} is typing…', { name: bot.name })))
    }))
}

// The calls ToolCell draws. A PTC program (`run_code`) dispatches the real tools as
// its sub-calls, so a call draws by its own name wherever it sits in the tree.
const isComputerCall = name => name === 'cua' || name?.startsWith('cua_driver_native__') === true
const DRAWN = new Set(['message_bot', 'delegate_work', 'ask_back', 'answer_work', 'cancel_work', 'note_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret', 'request_connector', 'mail_send', 'ask_user_question', 'show_view', 'browser_handoff', 'computer_handoff', 'read_group_chat', 'bot_remember', 'bot_forget', 'remember', 'forget'])
// Calls whose card a dock above the composer carries when the call is not drawn.
const CARDS = new Set(['ask_user', 'request_secret', 'request_connector', 'mail_send', 'show_view', 'browser_handoff', 'computer_handoff'])
export const isBotTool = name => DRAWN.has(name) || isComputerCall(name)

// The root and its sub-calls in dispatch order, each call once.
export function callTree(root) {
  const calls = []
  const seen = new Set()
  const visit = (call) => {
    const id = call.callId ?? call
    if (seen.has(id)) return
    seen.add(id)
    calls.push(call)
    for (const child of call.subCalls ?? []) visit(child)
  }
  visit(root)
  return calls
}

// Tells the docks which card calls the transcript draws, so a card shows in one place.
// A layout effect: an untouched dock drops its copy before the first paint.
function useShownCards(actions, sessionId, callIds) {
  const key = JSON.stringify(callIds)
  useLayoutEffect(() => {
    const ids = JSON.parse(key)
    if (ids.length === 0 || !actions.noteCards) return undefined
    actions.noteCards(sessionId, ids, 1)
    return () => actions.noteCards(sessionId, ids, -1)
  }, [sessionId, key])
}

function renderCall(call, { sessionId, roster, actions, useRoster, useUi, useWork, findBot, heldCards, hooks, openFile }) {
  const tool = toolName(call)
  const done = call.kind === 'tool-result'
  const { text: arg, value: argValue } = toolArgs(call)
  const self = roster.byId[sessionId]
  switch (tool) {
    case 'message_bot': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't message {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Messaged'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'delegate_work': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't delegate to {name}", { name: target.name }))
      const result = done ? contentText(call.content) : ''
      const paused = /^Paused work\b/.test(result)
      return h(EventLine, { prefix: paused ? t('Paused delegation to') : t('Delegated to'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'note_bot': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't leave a note for {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Left a note for'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'cancel_work': {
      const rawTarget = arg('target')
      const target = findBot(rawTarget)
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't cancel work"))
      if (target) return h(EventLine, { prefix: t('Cancelled work for'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
      return h('div', { className: 'bt-event' }, rawTarget ? t('Cancelled work {ref}', { ref: rawTarget }) : t('Cancelled work'))
    }
    case 'ask_back': {
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't ask back"))
      return h('div', { className: 'bt-event' }, t('Asked caller for input'))
    }
    case 'answer_work': {
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't answer work"))
      return h('div', { className: 'bt-event' }, t('Answered teammate'))
    }
    case 'stop_bot': {
      const target = findBot(arg('bot')) ?? { name: arg('bot') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't stop {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Stopped'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'create_bot': {
      const created = findBot(arg('name'))
      if (!done || created === undefined) return h(CellEmpty)
      return h(EventLine, { prefix: t('Created'), bots: [created], onOpen: bot => actions.openSession(bot.id) })
    }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return done && target ? h(EventLine, { prefix: t('Updated'), bots: [target], onOpen: bot => actions.openSession(bot.id) }) : h(CellEmpty)
    }
    case 'group_relay':
      return h(GroupReplies, { sessionId, callId: call.callId, done, content: call.content, roster, actions, useRoster, useUi, useWork, openFile })
    case 'create_group':
    case 'update_group':
    case 'delete_group':
    case 'post_to_group': {
      const verbs = {
        create_group: ['Created group', "Couldn't create the group"],
        update_group: ['Updated group', "Couldn't update the group"],
        delete_group: ['Deleted group', "Couldn't delete the group"],
        post_to_group: ['Posted in', "Couldn't post in the group"],
      }[tool]
      if (!done) return h(CellEmpty)
      // Tool results quote the group's name; anything else is a refusal.
      const result = contentText(call.content)
      const named = /^(Created group|Updated|Nothing changed in|Deleted|Posted in) "([^"]+)"/.exec(result)
      if (call.isError || !named) return h('div', { className: 'bt-event', title: result }, t(verbs[1]))
      const name = named[2]
      const room = roster.rooms.find(entry => entry.name === name)
      return h(GroupEvent, { prefix: t(verbs[0]), room: tool === 'delete_group' ? undefined : room, name, roster, actions })
    }
    case 'ask_user':
      return h(AskUserCell, { sessionId, callId: call.callId, arg, argValue, roster, actions, heldCards })
    case 'show_view':
      return h(WidgetCell, { sessionId, callId: call.callId, args: { text: arg, value: argValue }, done, isError: call.isError, roster, actions, heldCards })
    case 'request_secret':
      return h(SecretToolCell, { sessionId, callId: call.callId, name: arg('name'), done, content: call.content, roster, actions, heldCards })
    case 'request_connector':
      return h(ConnectorToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'mail_send':
      return h(MailToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'browser_handoff':
      return h(HandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'computer_handoff':
      return h(ComputerHandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'ask_user_question': {
      if (!done) return h(CellEmpty)
      let parsed = null
      try { parsed = JSON.parse(contentText(call.content)) } catch { parsed = null }
      const answer = parsed?.answers?.[0]
      const question = argValue('questions')?.[0]
      if (!answer) return h(CellEmpty)
      return h('div', { className: 'bt-q-inline' }, h(SettledQuestion, { question, answer }))
    }
    case 'read_group_chat': {
      if (!done) return h(CellEmpty)
      const room = roster.rooms.find(entry => entry.name === arg('group'))
      return room ? h(GroupEvent, { prefix: t('Read'), room, roster, actions }) : h(CellEmpty)
    }
    case 'bot_remember':
    case 'remember':
    case 'bot_forget':
    case 'forget':
      return done ? h(MemoryEvent, { sessionId, scope: arg('scope'), tool, result: contentText(call.content), failed: call.isError === true, code: call.error?.code, roster, actions, findBot }) : h(CellEmpty)
    default:
      if (isComputerCall(tool)) {
        return h(Fragment, null,
          h(ComputerCallRow, { sessionId, call, roster, actions, hooks }),
          h(AppAccessCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks }))
      }
      return h(CellEmpty)
  }
}

export function ToolCell({ node, sessionId, openFile, useRoster, useUi, useWork, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, actions }) {
  const roster = useRosterPick(useRoster, TOOL_ROSTER_FIELDS)
  const heldCards = useHeldCards?.(state => state[sessionId])
  const root = node.data.root
  const turn = node.location?.turn?.turn ?? root.turn
  const hidden = isHiddenTurn(roster, sessionId, turn)
  const findBot = nameOrId => roster.byId[nameOrId] ?? roster.bots.find(bot => bot.name.toLowerCase() === String(nameOrId ?? '').toLowerCase())
  const closed = roster.closedCards?.[sessionId]
  // Hidden Bot-to-Bot turns keep their own calls out of the chat, except a question
  // or view card the user dismissed or answered by message, which settles here.
  const calls = hidden
    ? callTree(root).filter(call => (toolName(call) === 'ask_user' || toolName(call) === 'show_view') && call.callId && closed?.[call.callId] !== undefined)
    : callTree(root)
  const drawn = calls.filter(call => DRAWN.has(toolName(call)) || isComputerCall(toolName(call)))
  // The newest call still running names the work, so a program reads as the tool it is in.
  const running = root.kind === 'tool-result' ? undefined : calls.findLast(call => call.kind !== 'tool-result')
  const note = running ? toolActivity(toolName(running), toolArgs(running).text, findBot, roster.byId[sessionId]) : null
  // A running tool shows only as the activity row's phrase.
  useLiveNote(actions, sessionId, `tool:${root.callId ?? node.key}`, note)
  useShownCards(actions, sessionId, drawn.filter(call => (CARDS.has(toolName(call)) || isComputerCall(toolName(call))) && call.callId).map(call => call.callId))
  if (drawn.length === 0) return h(CellEmpty)
  const env = { sessionId, roster, actions, useRoster, useUi, useWork, findBot, heldCards, openFile, hooks: { useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer } }
  return h(Fragment, null, drawn.map((call, index) => h(Fragment, { key: call.callId ?? index }, renderCall(call, env))))
}
