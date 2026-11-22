import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BotMark, colorOf, toolState } from './mark.js'
import { inkText } from './inks.js'
import { CheckIcon, ChevronDownIcon } from './icons.js'
import { Elapsed, Shimmer, workPhrase } from './cells.js'
import { SPRING_SHAPE, SPRING_TAP, spring, useLinger } from './motion.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// What a group's members are doing: above the group's composer, one capsule for the
// members at work or waiting for an approval; above a Bot's own composer, one for the
// groups it is at work in; and per member in the details panel, where the approvals
// their group turns wait on are answered.

const NO_WORK = { bots: {}, rooms: {}, approvals: [] }
const NO_COMPUTER = { asks: {} }
const FACES_MAX = 3
const DOCK_EXIT_MS = 160
const FRESH_DONE_MS = 1800

// Pending approvals belonging to this group alone: DSH tool approvals and computer
// app-access consents raised from members' hidden group Sessions, oldest first.
export function roomApprovals(room, work = NO_WORK, computer = NO_COMPUTER, roster = { byId: {} }) {
  if (!room) return []
  const byId = roster?.byId ?? {}
  const members = new Set(room.members ?? [])
  const tools = (work?.approvals ?? [])
    .filter(entry => entry.roomId === room.id && entry.answerable && byId[entry.botId] && members.has(entry.botId))
    .map(entry => ({ kind: 'tool', id: entry.id, botId: entry.botId, bot: byId[entry.botId], at: entry.at ?? 0, approval: entry }))
  const apps = Object.values(computer?.asks ?? {})
    .filter(ask => ask.roomId === room.id && byId[ask.botId] && members.has(ask.botId))
    .map(ask => ({ kind: 'computer-app', id: ask.id, botId: ask.botId, bot: byId[ask.botId], at: ask.at ?? 0, ask }))
  return [...tools, ...apps].sort((a, b) => a.at - b.at)
}

// Only work in this group counts here; work elsewhere shows on the Bot's own chat
// (its 'in {group}' capsule and sidebar group tag), not in every group it is in (#473).
export function memberWork(room, work = NO_WORK, computer = NO_COMPUTER) {
  const here = work.rooms?.[room.id] ?? []
  const asks = Object.values(computer?.asks ?? {})
  return room.members.map((id) => {
    const approvals = (work.approvals ?? []).filter(entry => entry.botId === id && (entry.roomId === undefined || entry.roomId === room.id))
    const computerAsks = asks.filter(ask => ask.botId === id && ask.roomId === room.id)
    const local = here.find(entry => entry.botId === id)
    const doing = local ? { ...local, roomId: room.id } : undefined
    const waiting = approvals.length > 0 || computerAsks.length > 0
    return { id, approvals, computerAsks, doing, here: local !== undefined, state: waiting ? 'ask' : doing ? 'work' : 'idle' }
  })
}

// The busy members, those waiting for an approval first.
export function busyMembers(room, work, roster, computer = NO_COMPUTER) {
  const busy = memberWork(room, work, computer).filter(entry => entry.state !== 'idle' && roster.byId[entry.id])
  return [...busy.filter(entry => entry.state === 'ask'), ...busy.filter(entry => entry.state === 'work')]
    .map(entry => ({ ...entry, bot: roster.byId[entry.id] }))
}

// The capsule leaves out the round's current speaker, which its round shows.
const dockMembers = busy => busy.filter(entry => !(entry.state === 'work' && entry.here && entry.doing.speaking === true))

export const workState = doing => (doing?.switching ? 'thinking' : toolState(doing?.tool ?? ''))

// The groups a Bot is at work in.
export function botGroupWork(botId, work, roster) {
  return Object.entries(work.rooms ?? {}).flatMap(([roomId, entries]) => {
    const entry = entries.find(item => item.botId === botId)
    const room = roster.roomsById[roomId]
    return entry && room ? [{ room, doing: entry, since: entry.since }] : []
  })
}

export function summaryText(busy) {
  const asks = busy.filter(entry => entry.state === 'ask')
  const workers = busy.filter(entry => entry.state === 'work')
  const names = asks.slice(0, 2).map(entry => entry.bot.name)
  const waiting = asks.length === 0 ? ''
    : asks.length === 1 ? t('{name} is waiting for your approval', { name: names[0] })
      : asks.length === 2 ? t('{first} and {second} are waiting for your approval', { first: names[0], second: names[1] })
        : t('{first}, {second} and {count} more are waiting for your approval', { first: names[0], second: names[1], count: asks.length - 2, total: asks.length })
  const first = workers[0]
  const doing = first ? `${first.bot.name} · ${workPhrase(first.doing)}…${workers.length > 1 ? ` +${workers.length - 1}` : ''}` : ''
  return { waiting, doing }
}

// What the capsule shows, as plain data: it outlives the work for its exit.
function dockModel(sessionId, roster, work, computer) {
  const room = roster.roomsById[sessionId]
  if (room) {
    const busy = dockMembers(busyMembers(room, work, roster, computer))
    if (busy.length === 0) return null
    const { waiting, doing } = summaryText(busy)
    const hasRoomApproval = roomApprovals(room, work, computer, roster).length > 0
    return {
      open: hasRoomApproval ? { approval: room.id, details: room.id } : { details: room.id },
      faces: busy.slice(0, FACES_MAX).map(entry => ({ id: entry.id, ask: entry.state === 'ask', state: workState(entry.doing) })),
      waiting, doing,
    }
  }
  const bot = roster.byId[sessionId]
  // A running own chat has its activity row.
  if (!bot || (work.bots?.[bot.id] !== undefined && work.bots[bot.id].roomId === undefined)) return null
  const groups = botGroupWork(bot.id, work, roster)
  if (groups.length === 0) return null
  const [first] = groups
  return {
    open: { session: first.room.id },
    faces: [{ id: bot.id, ask: false, state: workState(first.doing) }],
    waiting: '',
    doing: `${t('in {name}', { name: first.room.name })} · ${workPhrase(first.doing)}…${groups.length > 1 ? ` +${groups.length - 1}` : ''}`,
  }
}

function Face({ bot, ask, state }) {
  return h('span', { className: 'bt-mw-face', 'data-ask': ask || undefined },
    h(BotMark, { bot, size: 20, state: ask ? 'alert' : state }))
}

// The capsule springs to the width of what it says; it is measured, so the spring runs
// between two real widths. A capsule that comes back starts from its own width.
function useFitWidth(inner, key) {
  const [width, setWidth] = useState(null)
  useLayoutEffect(() => { setWidth(key && inner.current ? inner.current.offsetWidth : null) }, [key])
  return width
}

// Above the composer, one capsule for everything at work: it opens the group's details
// (or the header approval island when an approval waits here), or from a Bot's own chat
// the group it is at work in.
export function MemberDock({ sessionId, useRoster, useWork, useComputer, actions }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const computer = useComputer?.(value => value) ?? NO_COMPUTER
  const live = dockModel(sessionId, roster, work, computer)
  const [kept, leaving] = useLinger(live ? JSON.stringify(live) : null, DOCK_EXIT_MS)
  const model = kept ? JSON.parse(kept) : null
  const inner = useRef(null)
  const width = useFitWidth(inner, kept)
  if (!model) return null
  const faces = model.faces.map(face => ({ ...face, bot: roster.byId[face.id] })).filter(face => face.bot)
  const label = [model.waiting, model.doing].filter(Boolean).join(' · ')
  const open = () => (
    model.open.approval && typeof actions.openApproval === 'function' ? actions.openApproval(model.open.approval)
      : model.open.details ? actions.showDetails(model.open.details)
        : actions.openSession(model.open.session)
  )
  return h('div', { className: 'bt-mw-dock', 'data-leaving': leaving || undefined },
    h('button', { type: 'button', className: 'bt-mw-pill', 'aria-label': label, onClick: open, disabled: leaving, style: width ? { width } : undefined },
      h('span', { ref: inner, className: 'bt-mw-pill-in' },
        h('span', { className: 'bt-mw-faces', 'aria-hidden': true }, faces.map(face => h(Face, { key: face.id, ...face }))),
        h('span', { key: label, className: 'bt-mw-label', 'aria-hidden': true },
          model.waiting ? h('span', { className: 'bt-mw-ask' }, model.waiting) : null,
          model.waiting && model.doing ? h('span', { className: 'bt-mw-dot' }, '·') : null,
          model.doing ? h('span', { className: 'bt-mw-doing' }, h(Shimmer, null, model.doing)) : null))))
}

// The clock stays whole at the end; only what comes before it is cut.
const stateLine = (className, at, ...what) => h('span', { className },
  h('span', { className: 'bt-member-what' }, ...what),
  typeof at === 'number' ? h(Elapsed, { at, className: 'bt-member-time' }) : null)

const cardHead = (bot, at, label) => h('div', { className: 'bt-mw-head' },
  h(BotMark, { bot, size: 18, state: 'alert' }),
  h('span', { className: 'bt-mw-who', style: { color: inkText(colorOf(bot)) } }, bot.name),
  label ? h('span', { className: 'bt-mw-tool' }, label) : null,
  typeof at === 'number' ? h(Elapsed, { at, className: 'bt-mw-time' }) : null)

export function ApprovalCard({ approval, bot, actions, showBot = false }) {
  const [busy, setBusy] = useState(false)
  const answer = (choice) => {
    setBusy(true)
    void Promise.resolve(actions.answerApproval(approval.id, choice))
      .catch(error => actions.reportError(error, 'approval'))
      .finally(() => setBusy(false))
  }
  const label = approval.taskTitle ? `${approval.taskTitle} · ${approval.tool}` : approval.tool
  return h('div', { className: 'bt-mw-card', role: 'group', 'aria-label': t('{name} is waiting for your approval', { name: bot.name }) },
    showBot ? cardHead(bot, approval.at, label) : h('div', { className: 'bt-mw-tool' }, label),
    approval.detail?.text ? h('div', { className: 'bt-mw-text' }, approval.detail.text) : null,
    approval.reason ? h('div', { className: 'bt-mw-reason' }, approval.reason) : null,
    approval.detail?.code ? h('code', { className: 'bt-mw-code', title: approval.detail.code }, approval.detail.code) : null,
    // Group and background-task approvals are answered directly through DS Bot;
    // foreground own-chat approvals still use DSH's own inline card.
    approval.answerable && (approval.roomId !== undefined || approval.taskId !== undefined)
      ? h('div', { className: 'bt-mw-actions' },
        h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('reject') }, t('Reject')),
        h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer('allow') }, t('Allow once')))
      : h('div', { className: 'bt-mw-actions' },
        h('button', { type: 'button', className: 'bt-q-btn', onClick: () => actions.openSession(bot.id) }, t("Open {name}'s chat", { name: bot.name }))))
}

export function ComputerAppApprovalCard({ ask, bot, actions, showBot = false }) {
  const [busy, setBusy] = useState(false)
  const answer = (choice) => {
    setBusy(true)
    void Promise.resolve(actions.computerAppAnswer(ask.id, choice))
      .catch(error => actions.reportError?.(error, 'computer'))
      .finally(() => setBusy(false))
  }
  const title = t('Allow {name} to use {app}?', { name: bot.name, app: ask.appName })
  return h('div', { className: 'bt-mw-card', role: 'group', 'aria-label': title },
    showBot ? cardHead(bot, ask.at) : null,
    h('div', { className: 'bt-mw-text' }, title),
    h('div', { className: 'bt-mw-actions' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('deny') }, t('Deny')),
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('once') }, t('This time')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer('always') }, t('Always'))))
}

// A member's second line in the group's details: what it is doing here, or its role.
export function MemberState({ entry, bot }) {
  if (entry?.state === 'ask') {
    const at = entry.approvals?.[0]?.at ?? entry.computerAsks?.[0]?.at
    return stateLine('bt-member-state bt-mw-ask', at, t('Waiting for your approval'))
  }
  if (entry?.state !== 'work') return bot.role ? stateLine('bt-member-state', undefined, bot.role) : null
  return stateLine('bt-member-state', entry.doing.since, h(Shimmer, null, `${workPhrase(entry.doing)}…`))
}

// Work in this group can be stopped from its details, since the user cannot reach the
// member's group Session otherwise; a turn waiting for an approval still holds its work.
export function StopMemberWork({ entry, bot, room, actions }) {
  const [stopping, setStopping] = useState(false)
  if (!entry?.here || (entry.state !== 'work' && entry.state !== 'ask')) return null
  const stop = () => {
    setStopping(true)
    void Promise.resolve(actions.stopMemberWork(room.id, bot.id))
      .catch(error => actions.reportError(error, 'stop'))
      .finally(() => setStopping(false))
  }
  return h('button', { type: 'button', className: 'bt-member-stop', disabled: stopping, 'aria-label': `${t('Stop')} · ${bot.name}`, onClick: stop }, t('Stop'))
}

// A member stuck in this group, on an error its own chat cannot reach, starts a fresh
// part of its group conversation from here, as New session does in its own chat.
// Only members that already have a group Session here show it.
export function FreshMemberPart({ entry, bot, room, actions }) {
  const scope = `${room?.id ?? ''}:${bot?.id ?? ''}`
  const [status, setStatus] = useState(null)
  const timer = useRef(null)
  const mounted = useRef(true)
  const scopeRef = useRef(scope)
  const inFlight = useRef(null)
  scopeRef.current = scope
  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      inFlight.current = null
      clear()
    }
  }, [])
  useEffect(() => () => {
    clear()
    inFlight.current = null
  }, [scope])
  const phase = status?.scope === scope ? status.phase : 'idle'
  const hasSession = Array.isArray(room?.sessionMembers) && room.sessionMembers.includes(bot.id)
  if (actions.newPart === undefined || !hasSession || (entry !== undefined && entry.state !== 'idle')) return null
  const start = () => {
    if (phase !== 'idle' || inFlight.current === scope) return
    clear()
    const current = scope
    inFlight.current = current
    setStatus({ scope: current, phase: 'starting' })
    void Promise.resolve(actions.newPart(bot.id, { roomId: room.id })).then(
      () => {
        if (!mounted.current || scopeRef.current !== current) return
        setStatus({ scope: current, phase: 'done' })
        timer.current = setTimeout(() => {
          timer.current = null
          if (inFlight.current === current) inFlight.current = null
          if (!mounted.current) return
          setStatus(prev => (prev?.scope === current && prev.phase === 'done' ? null : prev))
        }, FRESH_DONE_MS)
      },
      (error) => {
        if (inFlight.current === current) inFlight.current = null
        if (mounted.current && scopeRef.current === current) setStatus(null)
        actions.reportError?.(error, 'new-part')
      },
    )
  }
  const done = phase === 'done'
  return h('button', {
    type: 'button',
    className: 'bt-member-stop bt-member-fresh',
    'data-state': phase === 'idle' ? undefined : phase,
    disabled: phase !== 'idle',
    title: done ? t('Started a new session for {name} in this group', { name: bot.name }) : t('Start a new session for {name} in this group', { name: bot.name }),
    'aria-label': `${done ? t('Started') : t('New session')} · ${bot.name}`,
    onClick: start,
  }, done ? [h('span', { key: 'ok', className: 'bt-member-fresh-ok bt-pop-in' }, h(CheckIcon)), t('Started')] : t('New session'))
}

// The group's work stops all at once from its details: DSH's own stop reaches only the
// round, and a member the round moved on from keeps working.
export function StopRoomWork({ room, entries, actions }) {
  const [stopping, setStopping] = useState(false)
  if (!entries.some(entry => entry.here)) return null
  const stop = () => {
    setStopping(true)
    void Promise.resolve(actions.stopRoomWork(room.id))
      .catch(error => actions.reportError(error, 'stop'))
      .finally(() => setStopping(false))
  }
  const label = t('Stop all work in this group')
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: stopping, 'aria-label': label, title: label, onClick: stop }, t('Stop all'))
}

export function MemberApprovals({ entry, bot, actions }) {
  if (entry?.state !== 'ask') return null
  return h('div', { className: 'bt-member-cards' },
    (entry.approvals ?? []).map(approval => h(ApprovalCard, { key: `t:${approval.id}`, approval, bot, actions })),
    (entry.computerAsks ?? []).map(ask => h(ComputerAppApprovalCard, { key: `c:${ask.id}`, ask, bot, actions })))
}

function approvalSummary(approvals) {
  const seen = new Set()
  const bots = []
  for (const item of approvals) {
    if (!item.bot || seen.has(item.bot.id)) continue
    seen.add(item.bot.id)
    bots.push(item.bot)
  }
  const label = bots.length === 0 ? t('Waiting for your approval')
    : bots.length === 1 ? t('{name} is waiting for your approval', { name: bots[0].name })
      : bots.length === 2 ? t('{first} and {second} are waiting for your approval', { first: bots[0].name, second: bots[1].name })
        : t('{first}, {second} and {count} more are waiting for your approval', { first: bots[0].name, second: bots[1].name, count: bots.length - 2, total: bots.length })
  return { bots, label }
}

// The approval row and expandable cards rendered inside the top header island
// (for a group chat or a Bot with background-task approvals).
export function ApprovalIslandPod({ approvals, open, room, targetId = room?.id, actions }) {
  if (!approvals || approvals.length === 0) return null
  const { bots, label } = approvalSummary(approvals)
  return h(Fragment, null,
    h('button', {
      type: 'button', className: 'bt-apv-bar', 'aria-expanded': open,
      onClick: () => actions.toggleApproval?.(targetId),
    },
    h('span', { className: 'bt-apv-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-apv-label' }, label),
    approvals.length > 1 ? h('span', { className: 'bt-apv-count' }, approvals.length) : null,
    bots.length > 0 ? h('span', { className: 'bt-goal-faces', 'aria-hidden': true },
      bots.slice(0, FACES_MAX).map(bot => h('span', { key: bot.id, className: 'bt-goal-face' },
        h(BotMark, { bot, size: 18, state: 'alert' }))),
      bots.length > FACES_MAX ? h('span', { className: 'bt-goal-more' }, `+${bots.length - FACES_MAX}`) : null) : null,
    h('span', { className: 'bt-goal-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
    open ? h('div', { className: 'bt-apv-panel', role: 'region', 'aria-label': t('Waiting for your approval') },
      approvals.map(item => (item.kind === 'computer-app'
        ? h(ComputerAppApprovalCard, { key: `c:${item.id}`, ask: item.ask, bot: item.bot, actions, showBot: true })
        : h(ApprovalCard, { key: `t:${item.id}`, approval: item.approval, bot: item.bot, actions, showBot: true })))) : null)
}

export function useMemberWork(room, useWork, useComputer) {
  const work = useWork?.(value => value) ?? NO_WORK
  const computer = useComputer?.(value => value) ?? NO_COMPUTER
  return { entries: room ? memberWork(room, work, computer) : [] }
}

export const MEMBER_CSS = `
.bt-mw-dock{display:flex;justify-content:center;margin:0 auto 8px;pointer-events:none}
.bt-mw-pill{pointer-events:auto;position:relative;display:inline-flex;align-items:center;flex:none;box-sizing:border-box;height:32px;max-width:100%;padding:0;border:0;border-radius:999px;overflow:hidden;background:var(--bt-main);box-shadow:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px rgba(0,0,0,.12);color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;cursor:pointer;animation:bt-mw-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .18s ease-out backwards;transition:background-color .12s ease,${spring(SPRING_SHAPE, 'width')},${spring(SPRING_TAP, 'scale')}}
.bt-mw-pill:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main))}
.bt-mw-pill:active{scale:.97}
.bt-mw-dock[data-leaving] .bt-mw-pill{animation:bt-mw-out .16s cubic-bezier(.4,0,1,1) forwards;pointer-events:none}
.bt-mw-pill-in{display:inline-flex;align-items:center;gap:8px;flex:none;padding:0 13px 0 6px;white-space:nowrap}
.bt-mw-faces{display:inline-flex;align-items:center;flex:none;line-height:0}
.bt-mw-face{position:relative;display:inline-flex;flex:none;border-radius:50%;corner-shape:round;background:var(--bt-main);box-shadow:0 0 0 2px var(--bt-main);animation:bt-mw-seat .26s cubic-bezier(.34,1.56,.64,1) backwards}
.bt-mw-face+.bt-mw-face{margin-left:-5px}
.bt-mw-face[data-ask]::after{content:"";position:absolute;right:-1px;bottom:-1px;width:7px;height:7px;border-radius:50%;corner-shape:round;background:var(--bt-star);box-shadow:0 0 0 1.5px var(--bt-main)}
.bt-mw-label{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:min(420px,58vw);animation:bt-mw-swap .22s ease-out backwards}
.bt-mw-label>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-mw-ask{color:var(--bt-warn);flex:none}
.bt-mw-dot{flex:none;color:var(--bt-ink-3)}
.bt-mw-doing{flex:0 1 auto}
@keyframes bt-mw-in{from{transform:translateY(8px) scale(.94)}}
@keyframes bt-mw-out{to{opacity:0;transform:translateY(6px) scale(.96);filter:var(--bt-fx-blur-3,blur(3px))}}
@keyframes bt-mw-seat{from{opacity:0;scale:.6}}
@keyframes bt-mw-swap{from{opacity:0;filter:var(--bt-fx-blur-4,blur(4px))}}
.bt-members{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-members-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.bt-members-head>.bt-section-title{margin:0}
/* The button hangs over the title's line, so the list below does not move when it appears. */
.bt-members-head>.bt-soft-sm{margin:-6px 0}
.bt-members-head>.bt-soft-sm:disabled{opacity:.5;cursor:default}
.bt-member{display:flex;flex-direction:column;border-radius:12px;animation:bt-rise .18s ease-out backwards}
.bt-member-row{position:relative;display:flex;align-items:center;gap:8px;min-height:48px;padding:0 8px;border-radius:12px;transition:background-color .12s ease}
.bt-member-row:hover{background:var(--bt-hover)}
.bt-member-open{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:8px 0;border:0;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-member-open>.bt-mark{flex:none}
.bt-member-text{display:flex;flex-direction:column;min-width:0;gap:1px}
.bt-member-line{display:flex;align-items:center;gap:6px;min-width:0}
.bt-member-name{min-width:0;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-member-line>.bt-tag{font-size:11px;line-height:15px;padding:0 5px}
.bt-member-state{display:flex;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-member-what{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-member-time{flex:none;margin-left:.3em;font-variant-numeric:tabular-nums}
.bt-member-state.bt-mw-ask{color:var(--bt-warn)}
.bt-member-stop{flex:none;height:28px;padding:0 11px;border:0;border-radius:999px;background:var(--bt-main);box-shadow:inset 0 0 0 .5px var(--bt-line-2);color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-member-stop:hover:not(:disabled){background:color-mix(in srgb,var(--bt-ink) 12%,var(--bt-main));color:var(--bt-ink)}
.bt-member-stop:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-member-stop:active:not(:disabled){scale:.94}
.bt-member-stop:disabled{opacity:.5;cursor:default}
.bt-member-fresh{position:absolute;right:8px;top:0;bottom:0;z-index:1;margin:auto 0;display:inline-flex;align-items:center;gap:4px;box-shadow:inset 0 0 0 .5px var(--bt-line-2),0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);opacity:0;pointer-events:none;transition:opacity .12s ease,background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-member-row:hover>.bt-member-fresh,.bt-member-fresh:focus-visible,.bt-member-fresh[data-state]{opacity:1;pointer-events:auto}
.bt-member-fresh[data-state=done]{color:var(--bt-ink)}
.bt-member-fresh[data-state=done]:disabled{opacity:1}
.bt-member-fresh-ok{display:inline-flex;color:var(--bt-green)}
.bt-member-fresh-ok svg{width:13px;height:13px}
@media (hover:none){.bt-member-fresh{position:static;margin:0;box-shadow:inset 0 0 0 .5px var(--bt-line-2);opacity:1;pointer-events:auto}}
.bt-member-cards{display:flex;flex-direction:column;gap:6px;padding:2px 8px 8px 50px}
.bt-mw-card{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:12px;background:var(--bt-hover);font-size:12px;line-height:17px;color:var(--bt-ink-2);animation:bt-rise .2s ease-out backwards}
.bt-mw-head{display:flex;align-items:center;gap:6px;min-width:0}
.bt-mw-who{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-mw-time{flex:none;margin-left:auto;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-mw-tool{font-weight:600;color:var(--bt-ink)}
.bt-mw-text{color:var(--bt-ink);overflow-wrap:anywhere}
.bt-mw-reason{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-mw-code{display:block;padding:4px 8px;border-radius:6px;background:var(--bt-main);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-mw-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}
.bt-mw-actions>button{height:28px;padding:0 12px;font-size:12px}
.bt-mw-actions>button:disabled{opacity:.5;cursor:default}
@media (prefers-reduced-motion:reduce){.bt-mw-pill,.bt-mw-dock[data-leaving] .bt-mw-pill,.bt-mw-face,.bt-mw-label,.bt-member,.bt-mw-card{animation:none}.bt-mw-pill{transition:background-color .12s ease}.bt-member-stop,.bt-member-fresh{transition:opacity .12s ease,background-color .12s ease,color .12s ease}}
`
