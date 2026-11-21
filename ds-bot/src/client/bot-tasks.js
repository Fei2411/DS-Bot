import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { BotMark, colorOf } from './mark.js'
import { inkText } from './inks.js'
import { Elapsed } from './cells.js'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.js'
import { SPRING_TAP, spring, useMorph } from './motion.js'
import { sendsOnEnter } from './enter-key.js'
import { relativeShort } from './text.js'
import { hostText, mdLabels, t } from './i18n.js'

// -------------------------------------------------------------------------
// Background tasks UI (#783):
// - Sidebar count pill (active tasks + approval indicator)
// - Header Dynamic Island pod (`TaskIslandPod`) using the same GoalIsland
//   surface and spring morph as group Goals: compact bar while closed,
//   focused single-card pager with Left/Right (←/→) stepping, inline
//   approvals, Stop / View details, and an inline follow-up bar while open
// - Right-panel read-only task viewer (`TaskReaderView`) reusing BotPanel
// - Details drawer task section (`DetailsTaskList`)

export const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting_work', 'waiting_approval'])

export const isActiveTask = task => task !== undefined && task !== null && ACTIVE_TASK_STATUSES.has(task.status)

const taskSort = (a, b) => {
  const aRank = a.status === 'waiting_approval' ? 0 : isActiveTask(a) ? 1 : 2
  const bRank = b.status === 'waiting_approval' ? 0 : isActiveTask(b) ? 1 : 2
  if (aRank !== bRank) return aRank - bRank
  return (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0)
}

// Background tasks scoped to one conversation:
// - Bot DM: `bot.tasks` without a `roomId`
// - Group chat: all members' tasks whose `roomId === room.id`
export function tasksForChat({ bot, room, roster }) {
  if (room !== undefined) {
    const out = []
    for (const memberId of room.members ?? []) {
      const member = roster?.byId?.[memberId]
      if (!member) continue
      for (const task of member.tasks ?? []) {
        if (task?.roomId === room.id) out.push({ ...task, bot: member, botId: member.id })
      }
    }
    return out.sort(taskSort)
  }
  if (bot !== undefined) {
    return (bot.tasks ?? [])
      .filter(task => task && !task.roomId)
      .map(task => ({ ...task, bot, botId: bot.id }))
      .sort(taskSort)
  }
  return []
}

// Sidebar counts for a Bot DM or a Group chat.
export function taskCountsOf({ bot, room, roster }) {
  const list = tasksForChat({ bot, room, roster })
  let active = 0
  let waitingApproval = 0
  for (const task of list) {
    if (!isActiveTask(task)) continue
    active += 1
    if (task.status === 'waiting_approval') waitingApproval += 1
  }
  return { active, waitingApproval, total: list.length }
}

// Builds the Focus Deck items for one conversation:
// pending approvals first (each linked to its task if any), followed by active tasks
// not already represented by an approval, and finally recent settled tasks when the user
// explicitly focuses one.
export function taskDeckItems({ bot, room, roster, approvals = [], focusTaskId = null }) {
  const tasks = tasksForChat({ bot, room, roster })
  const taskById = new Map(tasks.map(item => [item.id, item]))
  const items = []
  const coveredTaskIds = new Set()

  for (const entry of approvals) {
    const taskId = entry.kind === 'tool' ? entry.approval?.taskId : undefined
    const task = taskId !== undefined ? taskById.get(taskId) : undefined
    if (task !== undefined) coveredTaskIds.add(task.id)
    const approvalTitle = entry.kind === 'computer-app'
      ? entry.ask?.appName
      : entry.approval?.detail?.text || entry.approval?.taskTitle || task?.title || entry.approval?.tool
    items.push({
      key: `${entry.kind}:${entry.id}`,
      kind: 'approval',
      approvalItem: entry,
      bot: entry.bot ?? task?.bot ?? bot,
      task,
      title: approvalTitle ?? t('Waiting for your approval'),
      at: entry.at ?? task?.startedAt,
    })
  }

  for (const task of tasks) {
    if (coveredTaskIds.has(task.id)) continue
    if (!isActiveTask(task) && task.id !== focusTaskId) continue
    items.push({
      key: `task:${task.id}`,
      kind: 'task',
      bot: task.bot ?? bot,
      task,
      title: task.title,
      at: task.startedAt ?? task.updatedAt,
    })
  }
  return items
}

export function taskStatusLabel(status) {
  switch (status) {
    case 'running': return t('Running')
    case 'waiting_work': return t('Waiting for teammate')
    case 'waiting_approval': return t('Waiting for approval')
    case 'completed': return t('Done')
    case 'failed': return t('Failed')
    case 'interrupted': return t('Interrupted')
    case 'stopped': return t('Stopped')
    default: return status ?? ''
  }
}

export function taskOriginLabel(origin) {
  switch (origin) {
    case 'fg-handoff': return t('Moved from chat')
    case 'bot-handoff': return t('Teammate request')
    default: return ''
  }
}

// Header Dynamic Island pod for background tasks: compact bar while closed,
// expanding smoothly inside GoalIsland into a focused single-card pager with
// Left/Right (←/→) stepping, inline approvals, Stop, View details, and follow-up.
export function TaskIslandPod({ bot, room, roster, tasks = [], approvals = [], open = false, focusTaskId = null, targetId, actions }) {
  const active = tasks.filter(isActiveTask)
  if (active.length === 0) return null
  const waiting = Math.max(active.filter(item => item.status === 'waiting_approval').length, approvals.length)
  const needsApproval = waiting > 0
  const label = active.length === 1
    ? active[0].title
    : needsApproval
      ? t('{count} background tasks · {waiting} needs approval', { count: active.length, waiting })
      : t('{count} background tasks running', { count: active.length })
  return h(Fragment, null,
    h('button', {
      type: 'button',
      className: 'bt-task-bar',
      'data-approval': needsApproval || undefined,
      'aria-expanded': open,
      onClick: () => (actions.toggleTaskDeck ? actions.toggleTaskDeck(targetId) : actions.openTaskDeck?.(targetId)),
    },
    h('span', { className: 'bt-task-dot', 'data-status': needsApproval ? 'waiting_approval' : 'running', 'aria-hidden': true }),
    h('span', { className: 'bt-task-bar-label' }, label),
    active.length === 1 && active[0].startedAt
      ? h(Elapsed, { at: active[0].startedAt, className: 'bt-task-bar-time' })
      : h('span', { className: 'bt-task-bar-count' }, active.length),
    h('span', { className: 'bt-goal-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
    open ? h(TaskIslandPanel, { bot, room, roster, approvals, focusTaskId, targetId, actions }) : null)
}

// Sidebar count pill (Scheme A): calm count badge next to Bot/Room name.
export function SidebarTaskPill({ active, waitingApproval, onClick }) {
  if (!active || active <= 0) return null
  const label = waitingApproval > 0
    ? t('{count} background tasks · {waiting} needs approval', { count: active, waiting: waitingApproval })
    : t('{count} background tasks running', { count: active })
  return h('span', {
    className: 'bt-task-pill',
    'data-approval': waitingApproval > 0 || undefined,
    title: label,
    'aria-label': label,
    onClick: onClick ? (event) => { event.stopPropagation(); onClick() } : undefined,
  },
  h('span', { className: 'bt-task-pill-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-task-pill-n' }, active))
}

// Expanded Dynamic Island panel (shares GoalIsland's glass surface, body,
// segmented indicator, and footer grammar). Switches cards with Left/Right (←/→).
export function TaskIslandPanel({ bot, room, roster, approvals = [], focusTaskId = null, targetId, actions }) {
  const items = useMemo(
    () => taskDeckItems({ bot, room, roster, approvals, focusTaskId }),
    [bot, room, roster, approvals, focusTaskId],
  )

  const [index, setIndex] = useState(() => {
    if (!focusTaskId) return 0
    const found = items.findIndex(item => item.task?.id === focusTaskId)
    return found >= 0 ? found : 0
  })
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [sentNote, setSentNote] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const bodyRef = useRef(null)
  const sentTimerRef = useRef(null)

  useEffect(() => () => { if (sentTimerRef.current) clearTimeout(sentTimerRef.current) }, [])

  useEffect(() => {
    if (focusTaskId) {
      const found = items.findIndex(item => item.task?.id === focusTaskId)
      if (found >= 0) { setIndex(found); return }
    }
    setIndex(prev => (items.length === 0 ? 0 : Math.min(prev, items.length - 1)))
  }, [focusTaskId, items.length])

  const selectIndex = useCallback((nextIdx) => {
    if (items.length === 0) return
    if (sentTimerRef.current) { clearTimeout(sentTimerRef.current); sentTimerRef.current = null }
    setError('')
    setSentNote('')
    setIndex(((nextIdx % items.length) + items.length) % items.length)
  }, [items.length])

  const step = useCallback((delta) => {
    if (items.length <= 1) return
    selectIndex(index + delta)
  }, [items.length, index, selectIndex])

  useEffect(() => {
    const onKey = (event) => {
      if (items.length <= 1) return
      const typing = event.target instanceof HTMLElement && (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT')
      if (event.key === 'ArrowLeft' && (!typing || event.altKey)) {
        event.preventDefault()
        selectIndex(index - 1)
      } else if (event.key === 'ArrowRight' && (!typing || event.altKey)) {
        event.preventDefault()
        selectIndex(index + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length, index, selectIndex])

  const item = items[index]
  useMorph(bodyRef, item?.key ?? '')
  if (!item) return null

  const ownerBot = item.bot ?? bot
  const task = item.task
  const itemKey = item.key
  const draft = drafts[itemKey] ?? ''
  const setDraftFor = (key, updater) => setDrafts(prev => ({ ...prev, [key]: typeof updater === 'function' ? updater(prev[key] ?? '') : updater }))
  const approvalItem = item.kind === 'approval' ? item.approvalItem : null
  const isApproval = approvalItem !== null
  const taskActive = task !== undefined && isActiveTask(task)
  const panelSubject = room?.sessionId ?? room?.id ?? bot?.sessionId ?? bot?.id ?? targetId

  const answerApproval = (choice) => {
    if (busy || !approvalItem) return
    setBusy(true)
    setError('')
    const promise = approvalItem.kind === 'computer-app'
      ? actions.computerAppAnswer(approvalItem.ask.id, choice)
      : actions.answerApproval(approvalItem.approval.id, choice)
    void Promise.resolve(promise)
      .catch(err => setError(hostText(err?.message ?? String(err))))
      .finally(() => setBusy(false))
  }

  const stopFocusedTask = () => {
    if (busy || !task || !ownerBot) return
    setBusy(true)
    setError('')
    void Promise.resolve(actions.stopTask(ownerBot.id, task.id))
      .catch(err => setError(hostText(err?.message ?? String(err))))
      .finally(() => setBusy(false))
  }

  const openTaskReader = () => {
    if (!task || !ownerBot) return
    actions.closeTaskDeck?.()
    actions.openTask?.(panelSubject, ownerBot.id, task.id)
  }

  const sendFollowup = () => {
    const text = draft.trim()
    if (text === '' || busy || !task || !ownerBot) return
    const targetKey = itemKey
    if (sentTimerRef.current) { clearTimeout(sentTimerRef.current); sentTimerRef.current = null }
    setBusy(true)
    setError('')
    setSentNote('')
    setDraftFor(targetKey, '')
    void Promise.resolve(actions.sendTask(ownerBot.id, task.id, text))
      .then(() => {
        setSentNote(t('Sent to background task'))
        sentTimerRef.current = setTimeout(() => { sentTimerRef.current = null; setSentNote('') }, 2200)
      })
      .catch((err) => {
        setDraftFor(targetKey, prev => (prev === '' ? text : prev))
        setError(hostText(err?.message ?? String(err)))
      })
      .finally(() => setBusy(false))
  }

  const statusKey = isApproval ? 'waiting_approval' : (task?.status ?? 'running')

  return h('div', { className: 'bt-task-panel', role: 'region', 'aria-label': t('Background tasks') },
    h('div', { className: 'bt-goal-body', ref: bodyRef },
      h('div', { className: 'bt-btask-card' },
        h('div', { className: 'bt-btask-head' },
          h('div', { className: 'bt-btask-meta' },
            h('span', { className: 'bt-task-dot bt-btask-dot', 'data-status': statusKey, 'aria-hidden': true }),
            room !== undefined && ownerBot ? h('span', { className: 'bt-btask-who', style: { color: inkText(colorOf(ownerBot)) } }, ownerBot.name) : null,
            h('span', { className: 'bt-btask-status', 'data-status': statusKey }, taskStatusLabel(statusKey)),
            task && taskActive && typeof task.startedAt === 'number'
              ? h(Elapsed, { at: task.startedAt, className: 'bt-btask-time' })
              : item.at ? h(Fragment, null, h('span', { className: 'bt-btask-sep', 'aria-hidden': true }, '·'), h('span', { className: 'bt-btask-time' }, relativeShort(item.at))) : null),
          items.length > 1
            ? h('div', { className: 'bt-task-stepper', role: 'group', 'aria-label': t('Background tasks') },
                h('button', { type: 'button', className: 'bt-task-arrow', title: t('Previous item'), 'aria-label': t('Previous item'), onClick: () => step(-1) }, h(ChevronLeftIcon)),
                h('span', { className: 'bt-task-pcount' }, `${index + 1}/${items.length}`),
                h('button', { type: 'button', className: 'bt-task-arrow', title: t('Next item'), 'aria-label': t('Next item'), onClick: () => step(1) }, h(ChevronRightIcon)))
            : null),

        isApproval && approvalItem.kind === 'computer-app'
          ? h('div', { className: 'bt-btask-title' }, t('Allow {name} to use {app}?', { name: ownerBot?.name ?? t('a Bot'), app: approvalItem.ask.appName }))
          : h('div', { className: 'bt-btask-title' }, item.title),

        isApproval && approvalItem.kind === 'tool'
          ? h(Fragment, null,
              approvalItem.approval.reason ? h('div', { className: 'bt-btask-reason' }, approvalItem.approval.reason) : null,
              approvalItem.approval.detail?.code
                ? h('div', { className: 'bt-btask-cmd' },
                    approvalItem.approval.tool ? h('span', { className: 'bt-btask-cmd-tool' }, approvalItem.approval.tool) : null,
                    h('code', { className: 'bt-btask-cmd-code', title: approvalItem.approval.detail.code }, approvalItem.approval.detail.code))
                : null)
          : null,

        !isApproval && task
          ? h(Fragment, null,
              task.error ? h('div', { className: 'bt-btask-err' }, task.error) : null,
              task.summary ? h('div', { className: 'bt-btask-desc' }, task.summary)
                : task.brief && task.brief !== task.title ? h('div', { className: 'bt-btask-desc' }, task.brief) : null)
          : null,

        task && taskActive && !isApproval && typeof actions.sendTask === 'function'
          ? h('div', { className: 'bt-btask-reply' },
              h('textarea', {
                ref: inputRef,
                className: 'bt-btask-input',
                rows: 1,
                value: draft,
                disabled: busy,
                placeholder: t('Send follow-up or guidance…'),
                'aria-label': t('Sending to {title}', { title: task.title }),
                onChange: (event) => { setDraftFor(itemKey, event.target.value); if (error) setError('') },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' || !sendsOnEnter(roster?.prefs) || event.shiftKey || event.nativeEvent?.isComposing || event.keyCode === 229) return
                  event.preventDefault()
                  sendFollowup()
                },
              }),
              h('button', {
                type: 'button',
                className: 'bt-btask-send',
                disabled: busy || draft.trim() === '',
                'aria-label': t('Send'),
                onClick: sendFollowup,
              }, h(ArrowUpIcon)))
          : null,

        error ? h('div', { className: 'bt-btask-err', role: 'alert' }, error) : null,
        sentNote ? h('div', { className: 'bt-btask-ok', role: 'status' }, h(CheckIcon), sentNote) : null)),

    h('div', { className: 'bt-goal-foot bt-btask-foot' },
      task
        ? h('button', { type: 'button', className: 'bt-goal-checks', onClick: openTaskReader },
            t('View details'),
            h('span', { className: 'bt-task-foot-go', 'aria-hidden': true }, h(ChevronRightIcon)))
        : h('span'),
      h('span', { className: 'bt-goal-facts' },
        isApproval && approvalItem.kind === 'computer-app'
          ? h(Fragment, null,
              h('button', { type: 'button', className: 'bt-btask-btn', disabled: busy, onClick: () => answerApproval('deny') }, t('Deny')),
              h('button', { type: 'button', className: 'bt-btask-btn', disabled: busy, onClick: () => answerApproval('once') }, t('This time')),
              h('button', { type: 'button', className: 'bt-btask-btn is-primary', disabled: busy, onClick: () => answerApproval('always') }, t('Always')))
          : isApproval
            ? h(Fragment, null,
                h('button', { type: 'button', className: 'bt-btask-btn', disabled: busy, onClick: () => answerApproval('reject') }, t('Reject')),
                h('button', { type: 'button', className: 'bt-btask-btn is-primary', disabled: busy, onClick: () => answerApproval('allow') }, t('Allow once')))
            : taskActive
              ? h('button', { type: 'button', className: 'bt-btask-btn is-danger', disabled: busy, onClick: stopFocusedTask }, t('Stop'))
              : null)))
}

// Right-panel read-only task transcript viewer (reuses BotPanel).
// Never switches `bot.sessionId`.
export function TaskReaderView({ bot, task, actions }) {
  const [page, setPage] = useState(null)
  const [older, setOlder] = useState([])
  const [olderCursor, setOlderCursor] = useState({ active: false, cursor: null })
  const [showSteps, setShowSteps] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const reqGenRef = useRef(0)
  const mountedRef = useRef(true)
  const botId = bot?.id
  const taskId = task?.id
  const active = isActiveTask(task)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadLatest = useCallback(async (quiet = false, gen = reqGenRef.current) => {
    const readTask = actionsRef.current?.readTask
    if (!botId || !taskId || typeof readTask !== 'function') return
    if (!quiet) setLoading(true)
    try {
      const next = await readTask(botId, taskId, undefined, showSteps)
      if (!mountedRef.current || gen !== reqGenRef.current) return
      setPage(next)
      setError('')
    } catch (err) {
      if (!mountedRef.current || gen !== reqGenRef.current) return
      setError(hostText(err?.message ?? String(err)))
    } finally {
      if (mountedRef.current && !quiet && gen === reqGenRef.current) setLoading(false)
    }
  }, [botId, taskId, showSteps])

  useEffect(() => {
    reqGenRef.current += 1
    const gen = reqGenRef.current
    setOlder([])
    setOlderCursor({ active: false, cursor: null })
    setPage(null)
    void loadLatest(false, gen)
  }, [loadLatest])

  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (active) {
      wasActiveRef.current = true
      const timer = setInterval(() => { void loadLatest(true, reqGenRef.current) }, 2500)
      return () => clearInterval(timer)
    }
    if (wasActiveRef.current) {
      wasActiveRef.current = false
      void loadLatest(true, reqGenRef.current)
    }
    return undefined
  }, [active, loadLatest])

  const nextCursor = olderCursor.active ? olderCursor.cursor : (page?.cursor ?? null)

  const loadEarlier = async () => {
    const readTask = actionsRef.current?.readTask
    if (!nextCursor || loadingMore || !botId || !taskId || typeof readTask !== 'function') return
    const gen = reqGenRef.current
    setLoadingMore(true)
    try {
      const prev = await readTask(botId, taskId, nextCursor, showSteps)
      if (!mountedRef.current || gen !== reqGenRef.current) return
      setOlder(list => [...(prev.items ?? []), ...list])
      setOlderCursor({ active: true, cursor: prev.cursor ?? null })
    } catch (err) {
      if (!mountedRef.current || gen !== reqGenRef.current) return
      setError(hostText(err?.message ?? String(err)))
    } finally {
      if (mountedRef.current && gen === reqGenRef.current) setLoadingMore(false)
    }
  }

  const stop = () => {
    if (stopping || !botId || !taskId) return
    setStopping(true)
    void Promise.resolve(actionsRef.current?.stopTask?.(botId, taskId))
      .then(() => loadLatest(true, reqGenRef.current))
      .catch((err) => { if (mountedRef.current) setError(hostText(err?.message ?? String(err))) })
      .finally(() => { if (mountedRef.current) setStopping(false) })
  }

  if (!bot || !task) return null
  const latestItems = page?.items ?? []
  const seqKey = it => (Number.isInteger(it?.seq) ? `${it.sessionId ?? page?.sessionId ?? ''}:${it.seq}` : null)
  const latestSeqs = new Set(latestItems.map(seqKey).filter(Boolean))
  const uniqueOlder = older.filter((it) => {
    const key = seqKey(it)
    return key === null || !latestSeqs.has(key)
  })
  const items = [...uniqueOlder, ...latestItems]
  const origin = taskOriginLabel(task.origin)
  const hasBotReply = items.some(entry => entry.kind === 'bot')

  return h('div', { className: 'bt-tread' },
    h('div', { className: 'bt-tread-head' },
      h('div', { className: 'bt-tread-top' },
        h('button', { type: 'button', className: 'bt-icon-btn bt-tread-back', 'aria-label': t('Back to details'), title: t('Back to details'), onClick: () => actions.closeTask?.() }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-task-dot', 'data-status': task.status, 'aria-hidden': true }),
        h('span', { className: 'bt-tread-title', title: task.title }, task.title),
        active ? h('button', { type: 'button', className: 'bt-tread-pill is-danger', disabled: stopping, onClick: stop }, t('Stop')) : null),
      h('div', { className: 'bt-tread-bar' },
        h('div', { className: 'bt-tread-sub' },
          h('span', { className: 'bt-btask-status', 'data-status': task.status }, taskStatusLabel(task.status)),
          active && typeof task.startedAt === 'number'
            ? h(Elapsed, { at: task.startedAt, className: 'bt-btask-time' })
            : task.endedAt ? h(Fragment, null, h('span', { className: 'bt-tread-sep', 'aria-hidden': true }, '·'), h('span', { className: 'bt-btask-time' }, relativeShort(task.endedAt))) : null,
          origin ? h(Fragment, null, h('span', { className: 'bt-tread-sep', 'aria-hidden': true }, '·'), h('span', null, origin)) : null),
        h('div', { className: 'bt-tread-controls' },
          h('button', {
            type: 'button',
            className: `bt-tread-pill${showSteps ? ' is-on' : ''}`,
            'aria-pressed': showSteps,
            onClick: () => setShowSteps(value => !value),
          }, showSteps ? t('Hide steps') : t('Show steps'))))),

    error ? h('div', { className: 'bt-tread-err', role: 'alert' }, error) : null,

    h('div', { className: 'bt-tread-scroll', ref: scrollRef },
      nextCursor
        ? h('button', { type: 'button', className: 'bt-tread-more', disabled: loadingMore, onClick: loadEarlier },
            loadingMore ? t('Loading…') : t('Load earlier'))
        : null,
      loading && items.length === 0
        ? h('div', { className: 'bt-tread-empty' }, t('Loading…'))
        : items.length === 0
          ? h('div', { className: 'bt-tread-empty' }, task.summary || task.brief || t('No messages yet'))
          : items.map((entry, idx) => {
              const key = `${entry.seq ?? 'x'}:${entry.kind}:${idx}`
              if (entry.kind === 'task-brief') {
                return h('div', { key, className: 'bt-tread-brief' },
                  entry.name ? h('div', { className: 'bt-tread-brief-from' }, entry.name) : null,
                  h('div', { className: 'bt-tread-brief-text' }, entry.text ?? ''))
              }
              if (entry.kind === 'user') {
                return h('div', { key, className: 'bt-tread-row is-user' },
                  h('div', { className: 'bt-tread-user' }, entry.text ?? ''))
              }
              if (entry.kind === 'steps') {
                const tools = Array.isArray(entry.tools) ? entry.tools : []
                if (!showSteps || tools.length === 0) return null
                return h('div', { key, className: 'bt-tread-steps' },
                  tools.map((tool, sIdx) => h('div', { key: sIdx, className: 'bt-tread-step', 'data-ok': tool.ok === false ? 'false' : undefined },
                    h('span', { className: 'bt-tread-step-dot', 'aria-hidden': true }),
                    h('span', { className: 'bt-tread-step-name' }, tool.label || tool.name || 'tool'))))
              }
              if (entry.kind === 'bot') {
                return entry.text
                  ? h('div', { key, className: 'bt-tread-row is-bot' },
                      h('div', { className: 'bt-tread-bot' }, h(MarkdownText, { text: entry.text, labels: mdLabels(), variant: 'compact' })))
                  : null
              }
              if (entry.text) {
                return h('div', { key, className: 'bt-tread-event' }, entry.text)
              }
              return null
            }),
      active && !loading && !hasBotReply
        ? h('div', { className: 'bt-tread-live' },
            h('span', { className: 'bt-task-dot', 'data-status': task.status, 'aria-hidden': true }),
            h('span', null, taskStatusLabel(task.status)))
        : null))
}

// Dedicated Tasks tab view inside DetailsDrawer (clean borderless-hover rows grouped into Active & Completed).
export function DetailsTaskList({ tasks, sessionId, showBot = false, actions, run }) {
  const [stoppingId, setStoppingId] = useState(null)
  if (!tasks || tasks.length === 0) return null
  const stop = (event, botId, taskId) => {
    event.stopPropagation()
    setStoppingId(taskId)
    void Promise.resolve(run ? run(actions.stopTask(botId, taskId)) : actions.stopTask(botId, taskId))
      .finally(() => setStoppingId(curr => (curr === taskId ? null : curr)))
  }
  const activeList = tasks.filter(isActiveTask)
  const doneList = tasks.filter(task => !isActiveTask(task))

  const renderGroup = (title, list) => {
    if (list.length === 0) return null
    return h('div', { className: 'bt-tlist-group' },
      h('div', { className: 'bt-tlist-head' },
        h('span', { className: 'bt-section-title' }, title),
        h('span', { className: 'bt-tlist-count' }, list.length)),
      h('div', { className: 'bt-tlist' },
        list.map((task) => {
          const active = isActiveTask(task)
          const ownerId = task.botId ?? task.bot?.id
          const origin = taskOriginLabel(task.origin)
          return h('div', {
            key: task.id,
            className: `bt-tlist-row${active ? ' is-active' : ''}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => actions.openTask?.(sessionId, ownerId, task.id),
            onKeyDown: (event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                actions.openTask?.(sessionId, ownerId, task.id)
              }
            },
          },
          h('span', { className: 'bt-task-dot bt-tlist-dot', 'data-status': task.status, 'aria-hidden': true }),
          h('div', { className: 'bt-tlist-main' },
            h('div', { className: 'bt-tlist-title-row' },
              showBot && task.bot ? h(BotMark, { bot: task.bot, size: 15, state: active ? 'working' : 'idle' }) : null,
              h('span', { className: 'bt-tlist-title' }, task.title)),
            h('div', { className: 'bt-tlist-sub' },
              h('span', { className: 'bt-btask-status', 'data-status': task.status }, taskStatusLabel(task.status)),
              origin ? h(Fragment, null, h('span', { 'aria-hidden': true }, '·'), h('span', null, origin)) : null,
              active && typeof task.startedAt === 'number'
                ? h(Elapsed, { at: task.startedAt, className: 'bt-task-row-time' })
                : task.endedAt ? h(Fragment, null, h('span', { 'aria-hidden': true }, '·'), h('span', { className: 'bt-task-row-time' }, relativeShort(task.endedAt))) : null)),
          active
            ? h('button', {
                type: 'button',
                className: 'bt-task-row-stop',
                disabled: stoppingId === task.id,
                onClick: event => stop(event, ownerId, task.id),
              }, t('Stop'))
            : h('span', { className: 'bt-tlist-go', 'aria-hidden': true }, h(ChevronRightIcon)))
        })))
  }

  return h('div', { className: 'bt-drawer-tasks' },
    renderGroup(t('Active'), activeList),
    renderGroup(t('Completed'), doneList))
}

export const TASKS_CSS = `
/* Sidebar count pill (Scheme A) */
.bt-task-pill{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent);font-size:11px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;transition:background-color .12s ease}
.bt-task-pill:hover{background:color-mix(in srgb,var(--bt-accent) 20%,transparent)}
.bt-task-pill[data-approval]{background:color-mix(in srgb,var(--bt-star) 14%,transparent);color:var(--bt-warn)}
.bt-task-pill[data-approval]:hover{background:color-mix(in srgb,var(--bt-star) 22%,transparent)}
.bt-task-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.bt-task-pill-n{line-height:1}
.bt-tile .bt-task-pill{margin-top:4px}

/* Gliding Tasks tab badge */
.bt-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;margin-left:5px;border-radius:999px;background:color-mix(in srgb,var(--bt-accent) 14%,transparent);color:var(--bt-accent);font-size:11px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}

/* Shared luminous status dot */
.bt-task-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3)}
.bt-task-dot[data-status=running]{background:var(--bt-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-task-dot[data-status=waiting_work]{background:var(--bt-green)}
.bt-task-dot[data-status=waiting_approval]{background:var(--bt-star);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-star) 22%,transparent)}
.bt-task-dot[data-status=completed]{background:var(--bt-green)}
.bt-task-dot[data-status=failed]{background:var(--bt-danger)}
.bt-task-dot[data-status=interrupted],.bt-task-dot[data-status=stopped]{background:var(--bt-ink-3)}

/* Header Dynamic Island task bar (pure clear Liquid Glass, zero muddy tint) */
.bt-task-bar{display:flex;align-items:center;gap:8px;height:32px;padding:0 14px;border:0;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left;transition:background-color .14s ease,color .14s ease;animation:bt-veil-in .18s ease-out backwards}
.bt-task-bar:hover{background:color-mix(in srgb,var(--bt-ink) 4%,transparent);color:var(--bt-ink)}
.bt-task-bar:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-task-bar[data-approval]{color:var(--bt-ink);font-weight:500}
.bt-task-bar-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task-bar-time{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-task-bar-count{flex:none;min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent);font-size:11px;line-height:18px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.bt-task-bar[data-approval] .bt-task-bar-count{background:color-mix(in srgb,var(--bt-star) 16%,transparent);color:var(--bt-warn)}
.bt-task-bar[aria-expanded=true] .bt-task-bar-count,.bt-task-bar[aria-expanded=true] .bt-task-bar-time{display:none}
.bt-task-bar[aria-expanded=true] .bt-goal-chev{margin-left:auto}
.bt-task-bar[aria-expanded=true] .bt-goal-chev svg{transform:rotate(180deg)}

/* Expanded Dynamic Island task panel (clean single-surface Liquid Glass interior) */
.bt-task-panel{display:flex;flex-direction:column;max-height:min(62vh,520px);overflow:hidden;border-radius:0 0 22px 22px;animation:bt-veil-in .2s ease-out backwards}
.bt-btask-card{display:flex;flex-direction:column;gap:9px;padding:12px 16px 14px;font-size:13px;line-height:18px}
.bt-btask-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px}
.bt-btask-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-btask-dot{width:6px;height:6px;box-shadow:none!important}
.bt-btask-who{font-weight:600}
.bt-btask-status{font-weight:500}
.bt-btask-status[data-status=running]{color:var(--bt-accent)}
.bt-btask-status[data-status=waiting_approval]{color:var(--bt-warn)}
.bt-btask-status[data-status=completed]{color:var(--bt-green)}
.bt-btask-status[data-status=failed]{color:var(--bt-danger)}
.bt-btask-sep{color:var(--bt-ink-3);opacity:.65}
.bt-btask-time{color:var(--bt-ink-3);font-variant-numeric:tabular-nums}

/* Unified Left/Right glass stepper pill */
.bt-task-stepper{flex:none;display:inline-flex;align-items:center;gap:1px;height:24px;padding:1px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-island-well)}
.bt-task-pcount{padding:0 5px;font-size:11px;line-height:20px;font-weight:500;color:var(--bt-ink-2);font-variant-numeric:tabular-nums;user-select:none}
.bt-task-arrow{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);cursor:pointer;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-task-arrow:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-task-arrow:active{scale:.9}
.bt-task-arrow svg{width:12px;height:12px}

.bt-btask-title{font-size:15px;line-height:21px;font-weight:600;letter-spacing:-.012em;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-btask-reason{font-size:12.5px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere}

/* Clean inset monospace command strip (zero card-in-card clutter) */
.bt-btask-cmd{display:flex;align-items:baseline;gap:8px;padding:8px 11px;border-radius:10px;background:var(--bt-island-well);border:.5px solid var(--bt-line);overflow-x:auto}
.bt-btask-cmd-tool{flex:none;font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--bt-ink-3);font-family:var(--bt-mono);user-select:none}
.bt-btask-cmd-code{flex:1 1 auto;min-width:0;font-size:12px;line-height:17px;color:var(--bt-ink);font-family:var(--bt-mono);white-space:pre-wrap;overflow-wrap:anywhere}

.bt-btask-desc{font-size:13px;line-height:19px;color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-btask-err{font-size:12px;line-height:17px;color:var(--bt-danger);padding:7px 10px;border-radius:10px;background:var(--bt-danger-soft)}
.bt-btask-ok{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--bt-green)}
.bt-btask-ok svg{width:14px;height:14px}

/* Recessed liquid glass follow-up capsule */
.bt-btask-reply{display:flex;align-items:flex-end;gap:8px;margin-top:2px;padding:6px 6px 6px 13px;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-island-well);transition:border-color .14s ease,background-color .14s ease}
.bt-btask-reply:focus-within{border-color:color-mix(in srgb,var(--bt-accent) 60%,transparent);background:var(--bt-island-well-focus)}
.bt-btask-input{flex:1 1 auto;min-width:0;max-height:76px;border:0;outline:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;resize:none;padding:3px 0}
.bt-btask-input::placeholder{color:var(--bt-ink-3)}
.bt-btask-send{flex:none;width:26px;height:26px;border:0;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-user);color:var(--bt-user-ink);cursor:pointer;transition:opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-btask-send:hover:not(:disabled){opacity:.85}
.bt-btask-send:disabled{opacity:.28;cursor:default}
.bt-btask-send:active:not(:disabled){scale:.92}
.bt-btask-send svg{width:14px;height:14px}

/* Refined glass footer & airtight action buttons */
.bt-btask-foot{height:44px;padding:0 12px 0 16px;border-top:.5px solid var(--bt-line)}
.bt-btask-btn{height:28px;padding:0 13px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-island-btn);color:var(--bt-ink);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .14s ease,border-color .14s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-btask-btn:not(.is-primary):not(.is-danger):hover:not(:disabled){background:var(--bt-island-btn-hover);border-color:var(--bt-line-2)}
.bt-btask-btn:active:not(:disabled){scale:.95}
.bt-btask-btn:disabled{opacity:.45;cursor:default}
.bt-btask-btn.is-primary{border-color:transparent;background:var(--bt-user);color:var(--bt-user-ink);box-shadow:var(--bt-island-btn-shadow)}
.bt-btask-btn.is-primary:hover:not(:disabled){background:var(--bt-user);color:var(--bt-user-ink);opacity:.84}
.bt-btask-btn.is-danger{color:var(--bt-danger);background:color-mix(in srgb,var(--bt-danger) 8%,transparent);border-color:color-mix(in srgb,var(--bt-danger) 24%,transparent)}
.bt-btask-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 14%,transparent);border-color:color-mix(in srgb,var(--bt-danger) 32%,transparent)}
body[data-ds-dark-theme] .bt-btask-btn.is-danger{color:var(--bt-danger);background:color-mix(in srgb,var(--bt-danger) 12%,transparent);border-color:color-mix(in srgb,var(--bt-danger) 28%,transparent)}
body[data-ds-dark-theme] .bt-btask-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 20%,transparent)}
.bt-task-foot-go{display:inline-flex;width:13px;height:13px;color:var(--bt-ink-3)}
.bt-task-foot-go svg{width:13px;height:13px}

/* Right-panel Read-only Task Reader (focused task-only activity log) */
.bt-tread{display:flex;flex-direction:column;height:100%;min-height:0}
.bt-tread-head{flex:none;padding:10px 14px 10px 10px;border-bottom:.5px solid var(--bt-line);display:flex;flex-direction:column;gap:6px}
.bt-tread-top{display:flex;align-items:center;gap:6px;min-width:0}
.bt-tread-back{flex:none;width:26px;height:26px}
.bt-tread-title{flex:1 1 auto;min-width:0;font-size:13.5px;line-height:18px;font-weight:600;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-tread-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:6px;min-width:0}
.bt-tread-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-tread-sep{opacity:.55}
.bt-tread-controls{display:flex;align-items:center;gap:4px;flex:none}
.bt-tread-pill{flex:none;height:24px;padding:0 9px;border-radius:999px;border:.5px solid var(--bt-line);background:transparent;color:var(--bt-ink-2);font:inherit;font-size:11px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.bt-tread-pill:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-tread-pill.is-on{background:var(--bt-active);color:var(--bt-ink);border-color:var(--bt-line-2)}
.bt-tread-pill.is-danger{color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 24%,transparent)}
.bt-tread-pill.is-danger:hover:not(:disabled){background:var(--bt-danger-soft)}
.bt-tread-pill:disabled{opacity:.45;cursor:default}
.bt-tread-err{margin:8px 14px 0;padding:8px 10px;border-radius:8px;background:var(--bt-danger-soft);color:var(--bt-danger);font-size:12px}
.bt-tread-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:12px}
.bt-tread-more{align-self:center;border:.5px solid var(--bt-line-2);border-radius:999px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}
.bt-tread-more:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-tread-empty{text-align:center;color:var(--bt-ink-3);font-size:13px;padding:36px 12px}
.bt-tread-brief{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 4%,transparent);border:.5px solid var(--bt-line);display:flex;flex-direction:column;gap:4px}
.bt-tread-brief-from{font-size:11px;line-height:15px;font-weight:600;color:var(--bt-ink-2)}
.bt-tread-brief-text{font-size:12.5px;line-height:18px;color:var(--bt-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-tread-row{display:flex;flex-direction:column;gap:4px}
.bt-tread-row.is-user{align-items:stretch}
.bt-tread-user{padding:9px 12px;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 5%,transparent);border:.5px solid var(--bt-line);color:var(--bt-ink);font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-tread-bot{color:var(--bt-ink);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.bt-tread-steps{display:flex;flex-direction:column;gap:4px;padding:6px 0}
.bt-tread-step{display:flex;align-items:center;gap:7px;padding:4px 9px;border-radius:8px;background:var(--bt-hover);font-size:11.5px;line-height:16px;color:var(--bt-ink-2)}
.bt-tread-step-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--bt-green)}
.bt-tread-step[data-ok=false] .bt-tread-step-dot{background:var(--bt-danger)}
.bt-tread-step-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--bt-ink-2)}
.bt-tread-event{align-self:center;font-size:11px;color:var(--bt-ink-3);padding:2px 8px}
.bt-tread-live{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;padding:6px 10px;border-radius:999px;background:var(--bt-hover);font-size:12px;line-height:16px;color:var(--bt-ink-2)}

/* Dedicated Tasks tab inside DetailsDrawer (clean borderless-hover rows) */
.bt-drawer-tasks{display:flex;flex-direction:column;gap:18px}
.bt-tlist-group{display:flex;flex-direction:column;gap:4px}
.bt-tlist-head{display:flex;align-items:center;justify-content:space-between;padding:0 2px 2px}
.bt-tlist-head .bt-section-title{margin:0}
.bt-tlist-count{font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-tlist{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-tlist-row{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:12px;cursor:pointer;transition:background-color .12s ease}
.bt-tlist-row:hover{background:var(--bt-hover)}
.bt-tlist-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-tlist-dot{margin-top:1px}
.bt-tlist-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-tlist-title-row{display:flex;align-items:center;gap:6px;min-width:0}
.bt-tlist-title{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-tlist-sub{display:flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden}
.bt-task-row-time{font-variant-numeric:tabular-nums}
.bt-task-row-stop{flex:none;height:24px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:999px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:11px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.bt-task-row-stop:hover:not(:disabled){background:var(--bt-danger-soft);color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 28%,transparent)}
.bt-task-row-stop:disabled{opacity:.45;cursor:default}
.bt-tlist-go{flex:none;display:inline-flex;color:var(--bt-ink-3);opacity:.6;transition:opacity .12s ease,transform .12s ease}
.bt-tlist-row:hover .bt-tlist-go{opacity:1;transform:translateX(1px)}

@media (prefers-reduced-motion:reduce){.bt-task-bar,.bt-task-panel{animation:none!important}}
`
