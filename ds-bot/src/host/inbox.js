// The inbox: everything across the team that waits on the user, in one list.
// It is derived from the state that already holds each thing — approvals, cards,
// requests, holds, blocked Bots, paused work, proposals — and adds no record of its
// own. Every surface reads this one list: the sidebar's counts and marks, the inbox
// page, the phone's Needs you page and its pushes, and the desktop notifications.
//
// Groups, in the order they are worked:
//   decide  — a Bot stopped on the user's answer;
//   fix     — a Bot or group that cannot go on until something is fixed;
//   suggest — proposals that stop nothing.
// Inside a group the item that has waited longest comes first.

export const INBOX_GROUPS = ['decide', 'fix', 'suggest']
const GROUP_OF = {
  approval: 'decide', question: 'decide', view: 'decide', secret: 'decide', connector: 'decide', mail: 'decide',
  computer: 'decide', handoff: 'decide', goal: 'decide',
  blocked: 'fix', model: 'fix', paused: 'fix', 'room-paused': 'fix',
  learning: 'suggest',
}
const TEXT_MAX = 300
const clip = value => (typeof value === 'string' ? value.trim().slice(0, TEXT_MAX) : '')
const time = value => (Number.isFinite(value) ? value : 0)

// An extra source's items, kept to the shape every client reads.
function sourceItem(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  const ref = typeof raw.ref === 'string' ? raw.ref : ''
  const group = INBOX_GROUPS.includes(raw.group) ? raw.group : 'fix'
  if (kind === '' || ref === '') return undefined
  return {
    id: `${kind}:${ref}`, kind, group, ref, at: time(raw.at),
    ...(typeof raw.botId === 'string' ? { botId: raw.botId } : {}),
    ...(typeof raw.roomId === 'string' ? { roomId: raw.roomId } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.taskId === 'string' && raw.taskId !== '' ? { taskId: raw.taskId } : {}),
    ...(clip(raw.text) ? { text: clip(raw.text) } : {}),
  }
}

export function install(rt) {
  const { state } = rt
  const sources = new Set()
  const listeners = new Set()
  const changeListeners = new Set()

  // Where a card was asked: the Bot, and the group or background task it was asked in.
  const ownerOf = (sessionId) => {
    const task = rt.taskOwners?.get(sessionId)
    const group = rt.groupOwners?.get(sessionId)
    const botId = rt.selfOf?.(sessionId) ?? task?.botId ?? group?.botId
    const roomId = group?.roomId ?? task?.roomId ?? (rt.roomOf?.(sessionId) ? sessionId : undefined)
    return { botId, roomId: roomId ?? undefined, taskId: task?.taskId }
  }
  // A card left in an earlier segment of a chat is not shown there any more.
  const archived = sessionId => rt.pastOwners?.has?.(sessionId) === true
  // A card asked in a background task does not stop the Bot's own chat.
  const task = ({ taskId }) => (taskId === undefined ? {} : { taskId })
  const known = (botId, roomId) => (typeof botId === 'string' && rt.botOf(botId) !== undefined) || (typeof roomId === 'string' && rt.roomOf(roomId) !== undefined)
  const where = ({ botId, roomId, sessionId }) => ({
    ...(typeof botId === 'string' && rt.botOf(botId) !== undefined ? { botId } : {}),
    ...(typeof roomId === 'string' && rt.roomOf(roomId) !== undefined ? { roomId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
  })

  function collect() {
    const items = []
    const add = (kind, ref, at, place, extra = {}) => {
      if (!known(place.botId, place.roomId)) return
      items.push({ id: `${kind}:${ref}`, kind, group: GROUP_OF[kind], ref: String(ref), at: time(at), ...where(place), ...extra })
    }

    // Tool approvals in a Bot's chat, a group, or a background task. One the model is
    // still reviewing is not the user's yet; one this window cannot answer is another's.
    for (const approval of rt.approvalsView?.() ?? []) {
      if (approval.answerable === false || approval.review?.status === 'reviewing') continue
      const code = clip(approval.detail?.code)
      const note = clip(approval.detail?.text)
      add('approval', approval.id, approval.at, approval, {
        tool: String(approval.tool ?? ''),
        ...(code ? { text: code } : {}),
        ...(note ? { note } : {}),
        ...(approval.taskId !== undefined ? { taskId: approval.taskId } : {}),
        ...(approval.taskTitle ? { taskTitle: clip(approval.taskTitle) } : {}),
      })
    }

    // Question and view cards, by the Session they were asked in.
    for (const [sessionId, card] of Object.entries(state.questions ?? {})) {
      if (card?.id === undefined || archived(sessionId)) continue
      const owner = ownerOf(sessionId)
      add('question', card.id, card.askedAt, { ...owner, sessionId }, { text: clip(card.question), ...task(owner) })
    }
    for (const [sessionId, card] of Object.entries(state.views ?? {})) {
      if (card?.id === undefined || archived(sessionId)) continue
      const owner = ownerOf(sessionId)
      add('view', card.id, card.askedAt, { ...owner, sessionId }, { text: clip(card.title), ...task(owner) })
    }

    // Requests a Bot made through a card: a secret, a connector, an email to send.
    const pending = (map, each) => {
      for (const [botId, list] of Object.entries(map ?? {})) {
        for (const request of Array.isArray(list) ? list : []) {
          if (request?.status !== 'pending' || request.id === undefined || request.id === '') continue
          if (request.sessionId !== undefined && archived(request.sessionId)) continue
          each(botId, request)
        }
      }
    }
    const requestPlace = (botId, request) => {
      const owner = ownerOf(request.sessionId)
      return [{ ...owner, botId, sessionId: request.sessionId }, task(owner)]
    }
    pending(state.secretRequests, (botId, request) => {
      const [place, extra] = requestPlace(botId, request)
      add('secret', request.id, request.askedAt, place, { text: clip(request.name), need: request.kind === 'fill' ? 'fill' : 'allow', ...extra })
    })
    pending(state.connectorRequests, (botId, request) => {
      const [place, extra] = requestPlace(botId, request)
      add('connector', request.id, request.askedAt, place, { text: clip(request.name || request.connectorId), connectorId: String(request.connectorId ?? ''), ...extra })
    })
    pending(state.mailRequests, (botId, request) => {
      const [place, extra] = requestPlace(botId, request)
      add('mail', request.id, request.askedAt, place, { text: clip(request.subject), to: clip(request.to), ...extra })
    })

    // A Bot waiting for the user to let it use an app, or to finish a step in its
    // browser or on the computer that it handed over.
    const computer = rt.computerLive?.() ?? {}
    for (const ask of Object.values(computer.asks ?? {})) {
      add('computer', ask.id, ask.at, ask, { text: clip(ask.appName) })
    }
    for (const [botId, hold] of Object.entries(computer.holds ?? {})) {
      const legacyBotReason = typeof hold?.reason === 'string' && hold.reason !== '' && hold.reason !== 'takeover'
      if (hold?.by !== 'bot' && hold?.fromBot !== true && hold?.callId === undefined && !legacyBotReason) continue
      add('handoff', hold.id ?? botId, hold.at, { botId, sessionId: rt.chatOf?.(botId) }, { surface: 'computer', text: clip(hold.note), reason: String(hold.reason ?? '') })
    }
    for (const [botId, hold] of Object.entries(rt.browserChannel?.holdSnapshot?.() ?? {})) {
      if (hold?.callId === undefined) continue
      add('handoff', hold.callId, hold.at, { botId, sessionId: hold.sessionId ?? rt.chatOf?.(botId) }, { surface: 'browser', text: clip(hold.note || hold.reason), reason: String(hold.reason ?? '') })
    }

    for (const room of Object.values(state.rooms ?? {})) {
      // A group goal whose admin found nothing left to do without the user.
      const goal = room.goal
      if (goal?.status === 'active' && goal.idle === true) {
        const stage = (goal.stages ?? [])[goal.current]
        add('goal', goal.id ?? room.id, goal.updatedAt, { roomId: room.id, botId: room.admin ?? undefined }, { text: clip(stage?.title ?? goal.title) })
      }
      // A group stopped at its relay limit, waiting for Continue.
      if (room.idlePaused != null) {
        add('room-paused', room.id, room.idlePaused.at, { roomId: room.id }, { limit: room.idlePaused.limit, count: room.idlePaused.count })
      }
    }

    // A Bot a model failure stopped, or one still waiting for a model to be picked —
    // known only once the model list has been read.
    const catalogKnown = (rt.cachedCatalog?.() ?? []).length > 0
    for (const bot of Object.values(state.bots ?? {})) {
      if (bot.blocked != null) {
        add('blocked', bot.id, bot.blocked.at, { botId: bot.id, sessionId: rt.chatOf?.(bot.id) }, {
          text: String(bot.blocked.code ?? ''),
          ...(bot.blocked.status !== undefined ? { status: bot.blocked.status } : {}),
          ...(bot.blocked.provider ? { provider: String(bot.blocked.provider) } : {}),
        })
      } else if (bot.kickoff != null && catalogKnown && rt.isUsable?.(bot.model) === false) {
        add('model', bot.id, bot.createdAt, { botId: bot.id, sessionId: rt.chatOf?.(bot.id) })
      }
    }

    // Work handed to another Bot that stopped on a loop or a question for the user.
    for (const work of rt.pausedWorksView?.() ?? []) {
      add('paused', work.id, work.at, { botId: work.from ?? undefined }, {
        text: clip(work.question || work.goal),
        ...(work.to ? { to: work.to } : {}),
        ...(work.kind ? { reason: String(work.kind) } : {}),
      })
    }

    // Skills and AGENTS.md rules a Bot proposes to keep.
    for (const [botId, proposals] of Object.entries(rt.learningView?.() ?? {})) {
      for (const proposal of proposals) {
        const label = proposal.kind === 'agents' ? `${proposal.folder}/AGENTS.md` : `skills/${proposal.name}/SKILL.md`
        add('learning', proposal.id, proposal.at, { botId, sessionId: rt.chatOf?.(botId) }, { text: clip(label), proposal: proposal.kind === 'agents' ? 'agents' : 'skill' })
      }
    }

    // Sources other modules add (event alerts, a stalled turn).
    for (const source of sources) {
      let extra
      try { extra = source() } catch (error) { rt.warn?.('ds-bot: an inbox source failed: %s', error?.message ?? error); continue }
      for (const raw of Array.isArray(extra) ? extra : []) {
        const item = sourceItem(raw)
        if (item !== undefined && known(item.botId, item.roomId)) items.push(item)
      }
    }

    const order = item => INBOX_GROUPS.indexOf(item.group)
    const seen = new Set()
    return items
      .filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)))
      .sort((a, b) => order(a) - order(b) || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  const inboxView = () => {
    const items = collect()
    const counts = Object.fromEntries(INBOX_GROUPS.map(group => [group, items.filter(item => item.group === group).length]))
    return { count: items.length, counts, items }
  }

  // New items, for notifications: the ids already shown are remembered, and the first
  // look after start only learns them, so a restart does not announce the old ones.
  // Change listeners hear about any addition, removal, or update so live SSE clients
  // refresh immediately instead of waiting for the next poll.
  let shown = null
  let lastSnapshot = null
  const refresh = ({ live = true } = {}) => {
    if (listeners.size === 0 && changeListeners.size === 0) {
      shown = null
      lastSnapshot = null
      return
    }
    let items
    try { items = collect() } catch (error) { rt.warn?.('ds-bot: the inbox could not be read: %s', error?.message ?? error); return }
    if (listeners.size === 0) {
      shown = null
    } else {
      const before = shown
      shown = new Set(items.map(item => item.id))
      if (before !== null) {
        for (const item of items) {
          if (before.has(item.id)) continue
          for (const listener of listeners) {
            try { listener(item) } catch (error) { rt.warn?.('ds-bot: an inbox listener failed: %s', error?.message ?? error) }
          }
        }
      }
    }
    if (changeListeners.size === 0) {
      lastSnapshot = null
    } else {
      const snapshot = JSON.stringify(items)
      if (snapshot !== lastSnapshot) {
        const hadBaseline = lastSnapshot !== null
        lastSnapshot = snapshot
        if (hadBaseline && live) {
          for (const listener of changeListeners) {
            try { listener() } catch (error) { rt.warn?.('ds-bot: an inbox change listener failed: %s', error?.message ?? error) }
          }
        }
      }
    }
  }
  const onInboxAdded = (listener) => {
    listeners.add(listener)
    if (shown === null) refresh({ live: false })
    return () => listeners.delete(listener)
  }
  const onInboxChanged = (listener) => {
    changeListeners.add(listener)
    if (lastSnapshot === null) refresh({ live: false })
    return () => changeListeners.delete(listener)
  }
  const addInboxSource = (source) => {
    sources.add(source)
    refresh()
    return () => { sources.delete(source); refresh() }
  }

  // What can add or remove an item: a save (cards, requests, blocks, pauses, goals —
  // already broadcast as a state revision, so no extra live ping), an approval, a
  // browser hold. Computer asks/holds and learning proposals call inboxChanged themselves.
  const offSaved = rt.onSaved?.(() => refresh({ live: false }))
  const offApproval = rt.onApproval?.(() => refresh())
  const offHolds = rt.browserChannel?.subscribeHolds?.(() => refresh())
  rt.ctx.effect?.(() => () => {
    offSaved?.()
    offApproval?.()
    offHolds?.()
    listeners.clear()
    changeListeners.clear()
    sources.clear()
  }, 'ds-bot: inbox')

  Object.assign(rt, { inboxView, inboxChanged: () => refresh(), onInboxAdded, onInboxChanged, addInboxSource })
}
