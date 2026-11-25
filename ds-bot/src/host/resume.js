// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while DS Bot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, isWorkTool, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { eventMatchesReceipt, receiptKeyOf } from './coordination.js'
import { replaceFile } from './files.js'
import { stripOwnName } from './groups.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'
import { addressedSession, isActiveTask, ownChatSessions, returnAddress, sessionRoomId, threadCurrentOfPart, threadOfPart } from './threads.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], messages: {}, messageSeqs: {}, texts: [], toolCount: 0, reason: undefined, end: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      if (isWorkTool(String(event.data?.name ?? ''))) current.toolCount += 1
      const callId = event.data?.subCallId ?? event.data?.callId
      if (callId) (current.unconfirmedCalls ??= new Set()).add(callId)
      continue
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const callId = event.data?.subCallId ?? event.data?.callId ?? event.data?.message?.toolCallId
      if (callId) current.unconfirmedCalls?.delete(callId)
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) {
        current.took.push(source)
        // What the message held, for handing it back when its turn completed and no
        // deferred delivery made it: text, and the attachments it carried.
        current.messages[source.exchangeId] = { content: event.data?.content }
        if (event.seq !== undefined) current.messageSeqs[source.exchangeId] = event.seq
      }
      // A turn resumed across a part switch carries steered requests in source.joined
      // ({ info, text }[]) instead of separate user/message events.
      if (Array.isArray(source?.joined)) {
        for (const item of source.joined) {
          const info = item?.info
          if (info?.exchangeId === undefined) continue
          current.took.push(info)
          if (current.messages[info.exchangeId] === undefined) {
            current.messages[info.exchangeId] = { text: typeof item.text === 'string' ? item.text : '' }
          }
          if (event.seq !== undefined && current.messageSeqs[info.exchangeId] === undefined) {
            current.messageSeqs[info.exchangeId] = event.seq
          }
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') {
      current.reason = event.data?.reason
      current.end = event.seq
    }
  }
  return turns
}

const isSteerCutTurn = turn => turn?.reason?.kind === 'aborted'
  && turn.reason.reason?.kind === 'hook'
  && turn.reason.reason?.reason === STEER_CUT

function chainSteerCuts(turns, startAt) {
  let found = turns[startAt]
  let next = startAt + 1
  // A steer cut lands inside a step's model call, so the cut turn's last step left
  // an interrupted draft: texts before the last step/start stay, the rest is a
  // fragment the continuation replaces.
  const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
  while (isSteerCutTurn(found) && next < turns.length) {
    const follow = turns[next]
    const kept = finished(found)
    found = {
      ...follow,
      took: [...found.took, ...follow.took],
      messages: { ...found.messages, ...follow.messages },
      messageSeqs: { ...found.messageSeqs, ...follow.messageSeqs },
      texts: [...kept, ...follow.texts],
      toolCount: (found.toolCount ?? 0) + (follow.toolCount ?? 0),
      stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length),
    }
    next += 1
  }
  return isSteerCutTurn(found) ? { ...found, texts: finished(found), reason: undefined } : found
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    return chainSteerCuts(turns, at)
  }
  return undefined
}

function findRecordedTurn(events, record) {
  if (!Array.isArray(events) || events.length === 0) return undefined
  if (record?.trigger?.exchangeId !== undefined) {
    const byExchange = turnOf(events, record.trigger.exchangeId)
    if (byExchange !== undefined) return byExchange
  }
  const turns = turnsOf(events)
  if (typeof record?.turn === 'number') {
    for (let at = turns.length - 1; at >= 0; at -= 1) {
      if (turns[at].turn === record.turn) return chainSteerCuts(turns, at)
    }
    return undefined
  }
  return turns.length > 0 ? chainSteerCuts(turns, turns.length - 1) : undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.senderPart ? { senderPart: info.senderPart } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.workRef ? { workRef: info.workRef } : {}),
  ...(info.askWork ? { askWork: info.askWork } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.batchKey ? { batchKey: info.batchKey } : {}),
  ...(info.resumedUpstream ? { resumedUpstream: true } : {}),
  ...(info.resultRef ? { resultRef: info.resultRef } : {}),
  ...(info.replyTo ? { replyTo: info.replyTo } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')
  const coord = rt.coordination

  // What the last run left; loaded from coordination.sqlite (importing legacy inflight.json if needed).
  let interrupted = coord?.loadInitialState?.() ?? { turns: {}, queued: {}, silent: {}, obligations: [] }
  let recoveringTurns = interrupted.turns

  /** @type {Record<string, {botId:string, roomId?:string, turn?:number, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean, unverified?:boolean}>} */
  let turns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  /** @type {Record<string, {message:any, ledger?:any}[]>} buffered silent notices awaiting idle flush */
  let silent = interrupted.silent
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    const gen = coord?.currentGen?.() ?? 0
    const mergedTurns = { ...recoveringTurns, ...turns }
    latest = JSON.stringify({
      ...(gen > 0 ? { _coordGen: gen } : {}),
      turns: mergedTurns,
      queued,
      ...(Object.keys(silent).length > 0 ? { silent } : {}),
    })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Atomic temp + replaceFile (with Windows retry) so the compatibility mirror
    // never leaves a torn inflight.json on disk.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      const temp = `${file}.${process.pid}.tmp`
      await mkdir(home, { recursive: true })
      try {
        await writeFile(temp, snapshot, 'utf8')
        await replaceFile(temp, file)
        coord?.noteMirrorWritten?.(snapshot)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const noteSilent = (sessionId, entries) => {
    if (stopped || rt.readOnly() !== undefined) return
    if (typeof sessionId !== 'string' || sessionId === '') return
    const next = { ...silent }
    if (!Array.isArray(entries) || entries.length === 0) {
      if (!(sessionId in next)) return
      delete next[sessionId]
    } else {
      next[sessionId] = entries.map(entry => ({ message: entry.message, ...(entry.ledger ? { ledger: entry.ledger } : {}) }))
    }
    silent = next
    coord?.replaceSessionSilent?.(sessionId, next[sessionId])
    persist()
  }
  rt.noteSilent = noteSilent
  const update = (id, change) => {
    if (stopped || rt.readOnly() !== undefined) return
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    coord?.upsertTurn?.(id, next)
    persist()
  }
  const forgetQueued = (exchangeId) => {
    if (!stopped && rt.readOnly() === undefined) coord?.removeDelivery?.(exchangeId)
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }
  const forgetTaskStartDeliveries = (taskId) => {
    if (typeof taskId !== 'string' || taskId === '') return
    if (!stopped && rt.readOnly() === undefined) coord?.removeTaskStartDeliveries?.(taskId)
    let changed = false
    const next = { ...queued }
    for (const [sessionId, list] of Object.entries(next)) {
      const kept = list.filter(item => !(item.args?.taskId === taskId && item.args?.role === 'task'))
      if (kept.length === list.length) continue
      changed = true
      if (kept.length === 0) delete next[sessionId]
      else next[sessionId] = kept
    }
    if (changed) {
      queued = next
      persist()
    }
  }
  const forgetWorkDeliveries = (workId) => {
    if (typeof workId !== 'string' || workId === '') return
    if (!stopped && rt.readOnly() === undefined) coord?.removeWorkDeliveries?.(workId)
    let changed = false
    const next = { ...queued }
    for (const [sessionId, list] of Object.entries(next)) {
      const kept = list.filter(item => item.args?.exchangeId !== workId && item.args?.work !== workId && item.args?.askWork !== workId)
      if (kept.length === list.length) continue
      changed = true
      if (kept.length === 0) delete next[sessionId]
      else next[sessionId] = kept
    }
    if (changed) {
      queued = next
      persist()
    }
  }

  const inferAddress = (args) => {
    if (args.address && typeof args.address === 'object') return args.address
    if ((args.role === 'task' || args.role === 'task-followup') && typeof args.taskId === 'string' && args.taskId !== '') {
      return { taskId: args.taskId }
    }
    if (args.role === 'room' && args.deferred !== true && typeof args.roomId === 'string' && args.roomId !== '' && rt.roomOf(args.roomId) !== undefined) {
      return { roomId: args.roomId }
    }
    return undefined
  }

  const deliver = rt.deliver
  // Deliveries on their way right now, by Session and exchangeId. A deferred delivery is
  // one request handed back for a turn of its own; the normal path and a restart
  // recovery can both reach it, and the later caller waits for the one already going.
  // A failed delivery leaves the note (the next start sends it again) but not this
  // entry, so a retry in this run really sends it.
  const sending = new Map()
  rt.deliver = async (args) => {
    const address = inferAddress(args)
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID(), ...(address !== undefined ? { address } : {}) }
    // Non-waking silent notices (note_bot, cancel_work, stop_bot) do not open turns, so
    // they must never enter inflight `queued` (would inflate unread counts and resend as work).
    if (noted.wake === false) return deliver(noted)
    const sessionId = address !== undefined
      ? addressedSession(rt, noted.toId, address)
      : (noted.sessionId ?? rt.chatOf(noted.toId))
    if (address !== undefined && sessionId === undefined) {
      rt.noteFailure?.({
        level: 'warn',
        source: 'delivery',
        code: 'RETURN_UNRESOLVED',
        text: 'The delivery was not sent: its target task or group is no longer active.',
        bot: rt.botOf(noted.toId)?.name,
      })
      throw Object.assign(new Error('The delivery has no active recipient'), { code: 'bot/unresolved-return', delivered: false })
    }
    if (address !== undefined) noted.sessionId = sessionId
    const repeat = noted.deferred === true && noted.resent !== true
    const key = `${sessionId}\u0000${noted.exchangeId}`
    if (repeat) {
      const running = sending.get(key)
      if (running !== undefined) return running
    }
    // Committed synchronously to coordination.sqlite before it goes out so a turn
    // taking it up or a crash mid-send never loses track of the obligation.
    const at = Date.now()
    const waiting = queued[sessionId] ?? []
    const idx = waiting.findIndex(item => item.args?.exchangeId === noted.exchangeId)
    const note = { at, args: noted }
    queued = { ...queued, [sessionId]: idx === -1 ? [...waiting, note] : waiting.with(idx, note) }
    coord?.upsertDelivery?.(sessionId, noted, at)
    persist()
    const run = (async () => {
      try {
        return await deliver(noted)
      } catch (error) {
        // Drop deliveries whose Bot is gone or whose target task/group closed permanently.
        if (rt.botOf(noted.toId) === undefined || error?.code === 'bot/unresolved-return') {
          forgetQueued(noted.exchangeId)
        }
        throw error
      }
    })()
    if (repeat) {
      sending.set(key, run)
      const done = () => { if (sending.get(key) === run) sending.delete(key) }
      run.then(done, done)
    }
    return run
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued
  rt.forgetTaskStartDeliveries = forgetTaskStartDeliveries
  rt.restoreDelivery = (sessionId, args) => {
    if (sessionId === undefined || args?.exchangeId === undefined) return
    const at = Date.now()
    const waiting = queued[sessionId] ?? []
    const idx = waiting.findIndex(item => item.args?.exchangeId === args.exchangeId)
    const note = { at, args }
    queued = { ...queued, [sessionId]: idx === -1 ? [...waiting, note] : waiting.with(idx, note) }
    coord?.upsertDelivery?.(sessionId, args, at)
    persist()
  }
  rt.forgetWorkDeliveries = forgetWorkDeliveries
  rt.hasPendingRecovery = sessionId => Object.hasOwn(recoveringTurns, sessionId) || Object.hasOwn(turns, sessionId)
    || (queued[sessionId]?.length ?? 0) > 0
  rt.hasPendingTaskReport = taskId => Object.values(queued).some(list => Array.isArray(list)
    && list.some(item => item?.args?.role === 'task-report' && item.args.taskId === taskId))
    || (!rt.isTaskSettling?.(taskId) && coord?.hasPendingObligation?.(`task-report:${taskId}`) === true)

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    if (rt.isMovingInboxMessage?.(message?.id) === true) return
    const source = message?.source
    if (source?.kind === SOURCE_KIND && source.exchangeId) forgetQueued(source.exchangeId)
    if (source?.kind === SOURCE_KIND && (source.role === 'post' || source.role === 'goal') && typeof source.roomId === 'string') {
      rt.roomRelayDiscarded?.(source, agent?.id ?? agent?.session?.id)
    }
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = (Object.keys(interrupted.queued).length > 0 || coord?.hadInitialReadFailure?.() === true) ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = (Object.keys(interrupted.turns).length > 0 || coord?.hadInitialReadFailure?.() === true) ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      rt.workNoteTaken?.(session, event.data.source)
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (event.type === 'turn/end') {
      // A stopped task has already left the active index. Only a turn cut by
      // DSH shutdown is kept to pick up at the next start.
      const reason = event.data?.reason
      if (reason?.kind !== 'aborted' || reason.reason?.kind !== 'disposed') update(id, () => undefined)
      return
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const info = rt.live.get(id)?.info
        update(id, () => ({
          botId,
          ...(owner ? { roomId: owner.roomId } : {}),
          ...(typeof event.data?.turn === 'number' ? { turn: event.data.turn } : {}),
          since: event.time ?? Date.now(),
          ...(info !== undefined ? { trigger: triggerOf(info) } : {}),
        }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND || event.data?.source?.silent === true) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  async function resumeTurn(sessionId, record) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return false
    const text = resumeText(record)
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id)) return false
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      // A turn already picked up once and cut off again stays stopped: a restart loop
      // must not run it forever. Reset any goal/group task state so it does not stay stuck.
      if (record.resumed) {
        rt.goalTaskReset?.(room.id, bot.id, 'Interrupted by restart twice')
        rt.blockTasks?.(room.id, bot.id, { cause: 'restarted' })
        return false
      }
      await rt.deliver({
        toId: bot.id,
        sessionId: room.sessions?.[bot.id] ?? sessionId,
        role: 'room',
        roomId: room.id,
        note: 'picking up after a restart',
        resumed: true,
        text,
        ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}),
        ...(record.trigger?.batchKey ? { batchKey: record.trigger.batchKey } : {}),
        ...(record.trigger?.resumedUpstream ? { resumedUpstream: true } : {}),
        ...(record.trigger?.resultRef ? { resultRef: record.trigger.resultRef } : {}),
      })
      return true
    }
    if (record.resumed) return false
    // Resolve by logical address: a closed/retired background task never falls back to
    // the Bot's private foreground chat.
    const address = returnAddress(bot, sessionId)
    const dest = addressedSession(rt, bot.id, address)
    if (dest === undefined) return false
    const ownPart = { sessionId: dest, address }
    const trigger = record.trigger
    const activeWorkId = trigger === undefined ? undefined : rt.workOf?.(trigger)
    if (activeWorkId !== undefined) {
      const activeState = rt.workStateOf?.(activeWorkId)
      if (rt.closedWorkOf?.(activeWorkId)?.status === 'cancelled' || activeState === 'need_input' || activeState === 'paused') return false
    }
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, ...ownPart, ...(trigger.senderPart ? { fromPart: trigger.senderPart } : {}), role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.workRef ? { workRef: trigger.workRef } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
      return true
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, ...ownPart, role: trigger?.role === 'reply' && !trigger.work ? 'reply' : 'resume', resumed: true, text, ...(trigger?.replyTo ? { replyTo: trigger.replyTo } : {}), ...(trigger?.work ? { work: trigger.work } : {}), ...(trigger?.workRef ? { workRef: trigger.workRef } : {}) })
    return true
  }

  // Resolve the current DSH Session and effective logical address for a queued delivery or
  // obligation. A closed background task or removed group NEVER receives a redirected
  // task-start, task-followup, or room call. Completed peer replies and group reports whose
  // originating task/group closed fall back to `{ foreground: true }` so completed answers
  // are never stranded by delivery admission.
  const canFallbackReturnToForeground = role => role === 'reply' || role === 'report'
  const resolveReplayTarget = (sessionId, args) => {
    const bot = rt.botOf(args.toId)
    if (bot === undefined) return undefined
    let addr
    if (args.address && typeof args.address === 'object') {
      addr = args.address
    } else if (args.taskId && (args.role === 'task' || args.role === 'task-followup')) {
      addr = { taskId: args.taskId }
    } else if (args.role === 'report') {
      // Legacy group reports carry the SOURCE group in `args.roomId`; infer the recipient
      // conversation solely from the saved session id (current or past group part, task, or DM).
      const destRoomId = sessionRoomId(rt.state, args.toId, sessionId)
      addr = returnAddress(bot, sessionId, destRoomId)
    } else {
      const destRoomId = sessionRoomId(rt.state, args.toId, sessionId) ?? (args.role === 'room' ? args.roomId : undefined)
      addr = returnAddress(bot, sessionId, destRoomId)
    }
    const resolved = addressedSession(rt, args.toId, addr)
    if (resolved !== undefined) return { sessionId: resolved, address: addr }
    if (canFallbackReturnToForeground(args.role)) {
      const fg = rt.chatOf(args.toId)
      if (fg !== undefined) return { sessionId: fg, address: { foreground: true }, fellBackFromRoom: Boolean(addr.roomId) }
    }
    return undefined
  }

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. Before replaying any queued delivery, verify both the live
  // inbox and durable DSH session history so already-consumed messages are never sent twice,
  // and fail closed when cold history cannot be read.
  async function resendQueued(sessionId, list, onCovered) {
    const active = new Set()
    const fresh = []
    for (const item of list) {
      const args = item?.args
      if (args === undefined || rt.botOf(args.toId) === undefined || taken?.has(args.exchangeId) === true) {
        if (args?.exchangeId !== undefined) forgetQueued(args.exchangeId)
        continue
      }
      const target = resolveReplayTarget(sessionId, args)
      if (target === undefined) {
        forgetQueued(args.exchangeId)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'RECIPIENT_CLOSED',
          text: 'The delivery was not redirected: its original task or group has closed.',
          sessionId,
        })
        continue
      }
      const isSilent = args.wake === false || ['note', 'cancelled', 'stopped'].includes(args.role)
      const refWork = args.role === 'request' ? args.exchangeId : args.askWork ?? args.work
      const cancelled = refWork !== undefined && rt.closedWorkOf?.(refWork)?.status === 'cancelled'
      const workState = refWork === undefined ? undefined : rt.workStateOf?.(refWork)
      const staleWorkState = refWork !== undefined && (
        (args.role === 'request' && workState === 'paused')
        || (args.role === 'ask_back' && workState !== 'need_input')
        || (args.role === 'answer' && workState !== 'open')
      )
      if (isSilent || cancelled || staleWorkState) {
        forgetQueued(args.exchangeId)
        continue
      }
      fresh.push(item)
    }
    if (fresh.length === 0) return active
    const agents = new Map()
    const evidenceCache = new Map()
    const readEvidence = async (sid) => {
      if (!evidenceCache.has(sid)) {
        const res = await rt.readSessionEvidence(sid, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        evidenceCache.set(sid, res)
      }
      return evidenceCache.get(sid)
    }
    for (const { args } of fresh) {
      const target = resolveReplayTarget(sessionId, args)
      if (target === undefined) {
        forgetQueued(args.exchangeId)
        continue
      }
      const dest = target.sessionId
      if (!agents.has(dest)) agents.set(dest, await rt.resolveAgent(dest))
      const agent = agents.get(dest)
      const inInbox = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(m =>
        m?.source?.exchangeId === args.exchangeId
        && (m.source.role === undefined || receiptKeyOf(m.source) === receiptKeyOf(args)),
      )
      if (inInbox) {
        active.add(dest)
        onCovered?.()
        continue
      }
      if (taken?.has(args.exchangeId) === true) {
        forgetQueued(args.exchangeId)
        onCovered?.()
        continue
      }
      const destEvidence = await readEvidence(dest)
      const origEvidence = dest === sessionId ? destEvidence : await readEvidence(sessionId)
      const alreadyConsumed = (destEvidence.status === 'ok' && destEvidence.events.some(ev => eventMatchesReceipt(ev, args)))
        || (origEvidence.status === 'ok' && origEvidence.events.some(ev => eventMatchesReceipt(ev, args)))
      if (alreadyConsumed) {
        forgetQueued(args.exchangeId)
        onCovered?.()
        continue
      }
      if (destEvidence.status === 'error' || origEvidence.status === 'error') {
        active.add(dest)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'CONSUMPTION_UNVERIFIED',
          text: 'Could not verify whether the recipient read this message. The delivery is held, not repeated.',
          sessionId: dest,
        })
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      const effectiveArgs = {
        ...args,
        sessionId: dest,
        address: target.address,
        ...(target.fellBackFromRoom ? { imOrigin: undefined } : {}),
        steer: false,
        resent: true,
      }
      const ok = await deliver(effectiveArgs)
        .then(() => true, (error) => { rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error); return false })
      if (ok) {
        active.add(dest)
        onCovered?.()
      }
    }
    return active
  }

  // Applies committed SQLite terminal markers (`task`, `room_report`) to `state.json`
  // before obligation replay and orphan-task / room-report sweeps run. Closes the crash
  // window between committing SQLite WAL and persisting `state.json` so completed tasks
  // are never re-marked `interrupted` and settled group report watchers never fire twice.
  async function reconcileTerminalMarkers() {
    if (stopped || rt.readOnly?.() !== undefined || !coord) return
    coord.syncLegacyInflight?.()
    const markers = coord.listTerminalMarkers?.() ?? []
    if (markers.length === 0) return
    const applied = []
    const alreadySynced = []
    let dirty = false
    for (const marker of markers) {
      if (stopped || rt.readOnly?.() !== undefined) return
      const snap = marker.snapshot ?? {}
      if (marker.kind === 'task') {
        const bot = rt.botOf(snap.botId)
        const task = bot?.tasks?.find(item => item?.id === marker.ownerId)
        if (task !== undefined && isActiveTask(task)) {
          task.status = snap.status ?? 'completed'
          if (typeof snap.updatedAt === 'number') task.updatedAt = snap.updatedAt
          if (typeof snap.endedAt === 'number') task.endedAt = snap.endedAt
          if (snap.error !== undefined) task.error = snap.error
          if (snap.summary !== undefined) task.summary = snap.summary
          if (snap.reportFile !== undefined) task.reportFile = snap.reportFile
          if (snap.workId !== undefined) {
            rt.closeWork?.(snap.workId, `task "${snap.workTitle ?? task.title}"`, snap.workResult ?? snap.summary ?? '(completed)')
          }
          dirty = true
          applied.push(marker)
        } else {
          alreadySynced.push(marker)
        }
      } else if (marker.kind === 'room_report') {
        let changed = false
        if (snap.sub !== undefined) {
          const closed = rt.closeWork?.(snap.sub, `Group "${snap.roomName ?? 'group'}"`, snap.workResult ?? '', snap.worked === true ? { worked: true } : undefined)
          if (closed !== undefined) changed = true
        }
        if (snap.imReplyOrigin !== undefined && snap.reportKey !== undefined) {
          if (rt.state.imReplyOrigins?.[snap.reportKey] === undefined) {
            rt.rememberImReplyOrigin?.(snap.reportKey, snap.imReplyOrigin)
            changed = true
          }
        }
        if (rt.state.roomReports?.[marker.ownerId] !== undefined) {
          delete rt.state.roomReports[marker.ownerId]
          changed = true
        }
        if (changed) {
          dirty = true
          applied.push(marker)
        } else {
          alreadySynced.push(marker)
        }
      } else {
        alreadySynced.push(marker)
      }
    }
    for (const marker of alreadySynced) {
      coord.clearTerminalMarker?.(marker.kind, marker.ownerId)
    }
    if (dirty) {
      try {
        await rt.save()
        for (const marker of applied) {
          coord.clearTerminalMarker?.(marker.kind, marker.ownerId)
        }
      } catch (error) {
        rt.warn('ds-bot: saving reconciled terminal markers failed: %s', error)
      }
    }
  }

  // Replays durable pending obligations (`task_report`, `room_report`, `peer_result`)
  // committed in `coordination.sqlite` before a crash or restart. Verifies durable
  // session evidence and pair-ledger state first so every owed delivery lands once.
  async function recoverObligations(keepTaskSessions = new Set()) {
    if (stopped || rt.readOnly?.() !== undefined || !coord) return
    coord.syncLegacyInflight?.()
    const pending = coord.listPendingObligations()
    if (pending.length === 0) return
    for (const obl of pending) {
      if (stopped || rt.readOnly?.() !== undefined) return
      const payload = obl.payload
      if (!payload || typeof payload !== 'object' || !payload.toId) {
        coord.markObligation(obl.id, 'cancelled')
        continue
      }
      if (rt.botOf(payload.toId) === undefined) {
        coord.markObligation(obl.id, 'cancelled')
        continue
      }
      const target = resolveReplayTarget(payload.sessionId, { ...payload, address: obl.address })
      if (target === undefined) {
        coord.markObligation(obl.id, 'cancelled')
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'RECIPIENT_CLOSED',
          text: 'The pending report or result was not redirected: its original task or group has closed.',
          bot: rt.botOf(payload.toId)?.name,
        })
        continue
      }
      const dest = target.sessionId
      const exchangeId = payload.exchangeId ?? obl.deliveryId ?? obl.id
      const deliverArgs = {
        ...payload,
        exchangeId,
        address: target.address,
        sessionId: dest,
        ...(target.fellBackFromRoom ? { imOrigin: undefined } : {}),
      }
      // If already queued in-memory/DB for resend or already in pair ledger, avoid duplicating.
      const alreadyQueued = Object.values(queued).some(items => Array.isArray(items) && items.some(item => item.args?.exchangeId === exchangeId))
      if (alreadyQueued) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      if (obl.kind === 'peer_result' && payload.replyTo && rt.wasReplyDelivered?.(payload.fromId, payload.toId, payload.replyTo) === true) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const agent = await rt.resolveAgent(dest).catch(() => undefined)
      const inInbox = [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].some(m =>
        m?.source?.exchangeId === exchangeId
        && (m.source.role === undefined || receiptKeyOf(m.source) === receiptKeyOf(deliverArgs)),
      )
      if (inInbox) {
        keepTaskSessions.add(dest)
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const evidence = await rt.readSessionEvidence(dest, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      const origEvidence = payload.sessionId && payload.sessionId !== dest
        ? await rt.readSessionEvidence(payload.sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        : { status: 'not_found', events: [] }
      if (evidence.status === 'error' || origEvidence.status === 'error') {
        keepTaskSessions.add(dest)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'CONSUMPTION_UNVERIFIED',
          text: 'Could not verify whether a pending report was already read. It is held, not repeated.',
          sessionId: dest,
        })
        continue
      }
      if ((evidence.status === 'ok' && evidence.events.some(ev => eventMatchesReceipt(ev, deliverArgs)))
        || (origEvidence.status === 'ok' && origEvidence.events.some(ev => eventMatchesReceipt(ev, deliverArgs)))) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const ok = await rt.deliver(deliverArgs).then(() => true, (error) => {
        rt.warn('ds-bot: replaying pending obligation %s failed: %s', obl.id, error)
        return false
      })
      if (ok) {
        keepTaskSessions.add(dest)
        coord.markObligation(obl.id, 'settled')
      }
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Uses the shared cold-session evidence reader (`sessionQuery` / `sessionController`).
  async function logOf(sessionId) {
    const history = await rt.readSessionEvidence(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    return history.status === 'ok' ? history.events : undefined
  }

  const isTerminalReason = reason => reason !== undefined && reason.kind !== 'interrupted'
    && !(reason.kind === 'aborted' && reason.reason?.kind === 'disposed')

  const whereFor = (asker) => {
    const sender = asker?.senderSessionId
    if (sender === undefined) return { sender: undefined, back: undefined, where: undefined }
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    // The answer would have gone to the part of the asking Bot's chat the request came
    // from, which is not its foreground chat when that part is a background one.
    const where = back ?? (asker.senderPart === undefined ? undefined : threadCurrentOfPart(rt.botOf(sender), asker.senderPart)) ?? rt.chatOf(sender)
    return { sender, back, where }
  }

  async function deliveredAnswer(botId, sender, workId) {
    const delivered = rt.deliveredReplyOf?.(botId, sender, workId)
    if (delivered === undefined) {
      return { answered: rt.deliveredReplyOf === undefined && sender !== undefined && rt.wasReplyDelivered?.(botId, sender, workId) === true }
    }
    const file = delivered.files?.[0]
    const stored = file === undefined ? undefined : await rt.fileText(file, delivered.length)
    if (stored?.whole !== true) return { answered: true, text: delivered.text }
    // Delivery warnings are prepended to the preview and included in its declared length.
    const prefixLength = (delivered.length ?? stored.text.length) - stored.text.length
    const prefix = prefixLength > 0 ? delivered.text.slice(0, prefixLength) : ''
    return { answered: true, text: prefix + stored.text }
  }

  async function alreadyAnswered(botId, sender, where, back, roomId, workId) {
    const delivered = await deliveredAnswer(botId, sender, workId)
    if (delivered.answered) return delivered
    if (where === undefined) return { answered: false }
    const sent = await logOf(where)
    if (sent !== undefined && answeredIn(sent, workId)) return { answered: true }
    const segments = back === undefined
      ? (threadOfPart(rt.botOf(sender), where)?.segments ?? [])
      : (rt.roomOf(roomId)?.segments?.[sender] ?? [])
    for (const segment of [...segments].reverse()) {
      if (segment?.sessionId === undefined || segment.sessionId === where) continue
      const earlier = await logOf(segment.sessionId)
      if (earlier !== undefined && answeredIn(earlier, workId)) return { answered: true }
    }
    return { answered: false }
  }

  // A turn that ended while DS Bot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ended, prefetchedEvents) {
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const trigger = record.trigger
    const workId = trigger === undefined ? undefined : rt.workOf(trigger)
    const ownsPrimary = workId !== undefined && rt.ownsWork(record.botId, workId)
    const primaryAsker = ownsPrimary ? rt.workAsker(workId) : undefined
    const primarySender = primaryAsker?.senderSessionId
    const canSettlePrimary = ownsPrimary && primarySender !== undefined && rt.botOf(primarySender) !== undefined
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? rt.botOf(record.botId)?.name ?? 'The other Bot'
    const events = prefetchedEvents ?? await logOf(sessionId)
    if (events === undefined) {
      if (!canSettlePrimary) return
      const delivered = await deliveredAnswer(record.botId, primarySender, workId)
      if (delivered.answered) {
        rt.closeWork?.(workId, name, delivered.text || rt.answerText(workId, '', name))
        return
      }
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, primaryAsker, text)
      return
    }
    const turn = findRecordedTurn(events, record)
    // The turn was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) {
      if (workId !== undefined) activeKeptWorks?.add(workId)
      return
    }
    const said = turn.texts.join('\n\n')
    let primarySettled = !canSettlePrimary
    if (canSettlePrimary) {
      // The answer went up in another run (even before a part switch): the work closes
      // with what it said, and nothing is sent twice.
      const { sender, back, where } = whereFor(primaryAsker)
      const answered = await alreadyAnswered(record.botId, sender, where, back, primaryAsker.senderRoomId, workId)
      if (answered.answered) {
        rt.closeWork?.(workId, name, answered.text || rt.answerText(workId, said, name))
        primarySettled = true
      }
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') {
      if (workId !== undefined) activeKeptWorks?.add(workId)
      return
    }
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted') {
      if (!primarySettled) await resumeTurn(sessionId, record)
      await recoverTurnDeferred(sessionId, record, turn, events, name)
      return
    }
    const failure = reason.kind === 'error' ? turnFailure(reason.error) : undefined
    const dedupKey = failure !== undefined
      ? `reconcile:${sessionId}:${turn.turn ?? ''}:error:${failure.requestId ?? failure.code}`
      : reason.kind === 'aborted'
        ? `reconcile:${sessionId}:${turn.turn ?? ''}:aborted`
        : undefined
    const settleFailureOrAbort = (asker) => {
      if (failure !== undefined) {
        answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`, undefined, { failure, dedupKey })
      } else {
        // The turn was stopped before it could answer: the sender is told, as it is told
        // when DS Bot watches the turn end.
        answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`, undefined, { dedupKey, aborted: true })
      }
    }
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      if (!primarySettled) settleFailureOrAbort(primaryAsker)
      // Steered requests that joined the same failed or aborted turn also owe their own
      // callers settlement, so distinct parent works cannot stall across a restart.
      const seen = new Set([workId, trigger?.exchangeId])
      for (const took of turn.took) {
        if (took?.kind !== SOURCE_KIND || (took.role !== 'request' && took.role !== 'stopped') || took.silent === true || took.audience === 'user') continue
        const joinedId = took.exchangeId
        if (typeof joinedId !== 'string' || joinedId === '' || seen.has(joinedId)) continue
        seen.add(joinedId)
        if (!rt.ownsWork(record.botId, joinedId)) continue
        const joinedAsker = rt.workAsker(joinedId)
        const { sender, back, where } = whereFor(joinedAsker)
        if (sender === undefined || rt.botOf(sender) === undefined) continue
        const answered = await alreadyAnswered(record.botId, sender, where, back, joinedAsker.senderRoomId, joinedId)
        if (answered.answered) {
          rt.closeWork?.(joinedId, name, answered.text || rt.answerText(joinedId, '', name))
          continue
        }
        settleFailureOrAbort(joinedAsker)
      }
      // Non-request deferred items (ask_back, reply, answer, report, task-report) for other
      // works must still be recovered even when an unrelated turn failed or aborted.
      await recoverTurnDeferred(sessionId, record, turn, events, name, { includeRequests: false })
      return
    }
    const currentWorkState = workId === undefined ? undefined : rt.workStateOf?.(workId)
    if (workId !== undefined && (rt.closedWorkOf?.(workId)?.status === 'cancelled' || currentWorkState === 'need_input' || currentWorkState === 'paused')) {
      primarySettled = true
    }
    if (!primarySettled) {
      // A turn cut off at the output limit is not a finish: the answer says so, and the
      // diagnostics record it, with the route the Session's log holds for it.
      const cutOff = reason?.kind === 'max-tokens'
      const withoutText = cutOff && turn.texts.length === 0
      if (cutOff) {
        rt.noteCutOffTurn?.(sessionId, { withoutText })
        const context = events.findLast(event => event?.type === 'request/context')?.data
        const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
        const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
        rt.noteFailure?.({
          level: 'warn',
          source: 'turn',
          code: 'MAX_TOKENS',
          text: `${withoutText
            ? 'the turn was cut off at the output limit before it wrote anything'
            : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
          bot: name,
          where: room === undefined ? 'own chat' : `group "${room.name}"`,
          sessionId,
        })
      }
      const answer = cutOff ? cutOffText(said) : said
      // The turn ended with what it said: the answer goes up the way a finished turn's
      // does, with the results that came back for it and the text it held. A work that
      // still waits for what it handed on keeps its part until that comes back.
      if (rt.waitsWork(workId)) rt.holdWork(workId, answer)
      else {
        const text = rt.answerText(workId, answer, name)
        const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
        answerSender(rt, sessionId, primaryAsker, text, long)
      }
    }
    // Deferred requests, replies, ask_backs, answers, and reports steered into this turn
    // are handed back in turns of their own; a crash before that delivery left them open.
    await recoverTurnDeferred(sessionId, record, turn, events, name)
  }

  // Reconciles a group member turn that finished or failed while DS Bot was offline,
  // posting its unseen reply/failure once via `lateRoomReply`/`lateRoomFailure` and
  // recovering any deferred messages steered into that turn.
  async function reconcileEndedGroupTurn(sessionId, record, ended, prefetchedEvents) {
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const room = rt.roomOf(record.roomId)
    const bot = rt.botOf(record.botId)
    if (room === undefined || bot === undefined || !room.members.includes(bot.id)) return
    const events = prefetchedEvents ?? await logOf(sessionId)
    if (events === undefined) return
    const turn = findRecordedTurn(events, record)
    if (turn === undefined) return
    const reason = turn.reason ?? ended.reason
    if (reason?.kind === 'blocked') return
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(sessionId, record)
      await recoverTurnDeferred(sessionId, record, turn, events, bot.name)
      return
    }
    const since = record.since ?? 0
    const roomLines = [
      ...(rt.ledger?.records?.(`group-${room.id}`) ?? []),
      ...(Array.isArray(room.log) ? room.log : []),
    ]
    const roomSessionId = rt.sessionOfRoom?.(room) ?? room.sessionId ?? room.id
    const roomAgent = await rt.resolveAgent(roomSessionId).catch(() => undefined)
    const queuedPosts = [...(roomAgent?.inbox?.nextStep ?? []), ...(roomAgent?.inbox?.nextTurn ?? [])]
      .filter(msg => msg?.source?.kind === SOURCE_KIND && msg.source.role === 'post' && msg.source.senderSessionId === bot.id)
    const info = record.trigger ?? { role: 'room', roomId: room.id }
    const isMemberFailureLine = (line, botId) => (line?.about === botId || line?.botId === botId)
      && ((line?.kind === 'notice' && line?.reason === 'failed') || line?.kind === 'failed' || line?.failed !== undefined)
    if (reason.kind === 'error') {
      const alreadyPostedFailure = roomLines.some(line => isMemberFailureLine(line, bot.id) && (line.time ?? 0) >= since)
        || queuedPosts.some(msg => msg.source?.failed !== undefined)
      if (!alreadyPostedFailure) {
        await rt.lateRoomFailure?.(sessionId, info, turnFailure(reason.error))
      }
      await recoverTurnDeferred(sessionId, record, turn, events, bot.name, { includeRequests: false })
      return
    }
    if (reason.kind !== 'aborted') {
      const said = turn.texts.join('\n\n').trim()
      const reply = reason.kind === 'max-tokens' ? cutOffText(said) : said
      const trimmed = stripOwnName(bot.name, reply).trim()
      const alreadyPosted = trimmed !== '' && (
        roomLines.some(line => line?.botId === bot.id && !line.progress && line.kind !== 'resumed'
          && (line.time ?? 0) >= since && typeof line.text === 'string' && stripOwnName(bot.name, line.text).trim() === trimmed)
        || queuedPosts.some(msg => stripOwnName(bot.name, textOf(msg.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')).trim() === trimmed)
      )
      if (!alreadyPosted) {
        await rt.lateRoomReply?.(sessionId, info, reply, { toolCount: turn.toolCount ?? 0, ...(turn.turn !== undefined ? { turn: turn.turn } : {}) })
      }
    }
    await recoverTurnDeferred(sessionId, record, turn, events, bot.name)
  }

  // Matches both delegated Bot works (`work.to === botId`) and task/subagent child work
  // nodes (`work.child !== undefined && work.from === botId`, cf. handoffs.js ownerBotOfWork).
  const ownsWorkOrTask = (botId, workId) => {
    if (workId === undefined) return false
    if (rt.ownsWork(botId, workId)) return true
    const works = rt.state?.works
    const work = works != null && Object.hasOwn(works, workId) ? works[workId] : undefined
    return work?.child !== undefined && work.from === botId
  }

  // Unified deferred-message recovery for turns reconciled or resumed after a restart.
  // Recovers steered requests, group calls, replies for other works, ask_backs, answers,
  // and group/task reports from the durable turn log — preserving attachments and enforcing
  // work-state guards — unless already handed back, taken up, or answered.
  const DEFERRED_ROLES = new Set(['request', 'stopped', 'room', 'reply', 'ask_back', 'answer', 'report', 'task-report'])
  async function recoverTurnDeferred(sessionId, record, turn, events, name, { includeRequests = true } = {}) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined || turn === undefined || !Array.isArray(turn.took) || turn.took.length === 0) return
    const primaryWork = rt.workOf?.(record.trigger)
    const seen = new Set([record.trigger?.exchangeId])
    for (const source of turn.took) {
      if (source?.kind !== SOURCE_KIND || source.silent === true) continue
      if (!DEFERRED_ROLES.has(source.role)) continue
      if (source.audience === 'user') continue
      const exchangeId = source.exchangeId
      if (typeof exchangeId !== 'string' || exchangeId === '' || seen.has(exchangeId)) continue
      if (source.role === 'request' && primaryWork !== undefined && exchangeId === primaryWork) continue
      seen.add(exchangeId)

      if (source.role === 'request' || source.role === 'stopped' || source.role === 'room') {
        if (!includeRequests) continue
      }
      if (source.role === 'room') {
        if (!rt.groupOwners.has(sessionId)) continue
        const targetRoom = rt.roomOf(source.roomId ?? record.roomId)
        if (targetRoom === undefined || !targetRoom.members.includes(record.botId)) continue
      } else if (source.role === 'request') {
        if (!rt.ownsWork(record.botId, exchangeId)) continue
        if (rt.closedWorkOf?.(exchangeId)?.status === 'cancelled') continue
      } else if (source.role === 'ask_back') {
        const refWork = source.askWork ?? source.work
        if (refWork !== undefined && rt.workStateOf?.(refWork) !== 'need_input') continue
      } else if (source.role === 'answer') {
        if (source.work !== undefined && (source.work === primaryWork || rt.workStateOf?.(source.work) !== 'open')) continue
      } else if (source.role === 'reply' || source.role === 'report' || source.role === 'task-report') {
        if (source.work === undefined || source.work === primaryWork) continue
        if (!ownsWorkOrTask(record.botId, source.work)) continue
        if (rt.closedWorkOf?.(source.work)?.status === 'cancelled') continue
      }

      const rawSender = source.senderSessionId
      const validBotSender = rawSender !== undefined && rt.botOf(rawSender) !== undefined ? rawSender : undefined
      if ((source.role === 'request' || source.role === 'stopped' || source.role === 'ask_back' || source.role === 'answer') && validBotSender === undefined) {
        continue
      }
      // Handed back after this turn ended (or after the steered message seq on a cut turn):
      // already in the Session's log, so an earlier or later turn took it up.
      const afterSeq = turn.end ?? turn.messageSeqs?.[exchangeId]
      if (afterSeq !== undefined && events.some(event => event.seq !== undefined && event.seq > afterSeq
        && event.type === 'user/message'
        && (event.data?.source?.exchangeId === exchangeId
          || event.data?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId)))) {
        activeKeptWorks?.add(exchangeId)
        if (source.work !== undefined) activeKeptWorks?.add(source.work)
        continue
      }
      if (rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId)) continue
      // For a request, check whether the reply already went out in another run.
      if (source.role === 'request') {
        const asker = rt.workAsker(exchangeId)
        if (asker !== undefined) {
          const { back, where } = whereFor(asker)
          const answered = await alreadyAnswered(record.botId, validBotSender, where, back, asker.senderRoomId, exchangeId)
          if (answered.answered) {
            rt.closeWork?.(exchangeId, name, answered.text || rt.answerText(exchangeId, '', name))
            continue
          }
        }
      }
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      const saved = turn.messages?.[exchangeId]
      const content = Array.isArray(saved?.content) ? saved.content : []
      const text = typeof saved?.text === 'string'
        ? saved.text
        : textOf(content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
      const images = content.filter(block => block?.type === 'image' && block.attachment !== undefined && !block.offloaded).map(block => block.attachment)
      const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
      // Re-check synchronously after awaits so we never duplicate a live/queued/inbox delivery.
      const liveEntry = rt.live?.get(sessionId)
      const liveHeld = [
        liveEntry?.info,
        liveEntry?.pending,
        liveEntry?.carry?.info,
        ...(liveEntry?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.later ?? []).map(later => later?.info),
        ...(liveEntry?.pending?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.carry?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.carry?.later ?? []).map(later => later?.info),
      ]
      const alreadyHandedBack = rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId) === true
        || [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
          .some(message => message?.source?.exchangeId === exchangeId
            || message?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId))
        || liveHeld.some(item => item?.exchangeId === exchangeId)
      const workStillValid = source.role === 'request'
        ? (rt.ownsWork(record.botId, exchangeId) && rt.workAsker(exchangeId) !== undefined && rt.closedWorkOf?.(exchangeId)?.status !== 'cancelled')
        : source.role === 'ask_back'
          ? ((source.askWork ?? source.work) === undefined || rt.workStateOf?.(source.askWork ?? source.work) === 'need_input')
          : source.role === 'answer'
            ? (source.work === undefined || rt.workStateOf?.(source.work) === 'open')
            : (source.role === 'reply' || source.role === 'report' || source.role === 'task-report')
              ? (ownsWorkOrTask(record.botId, source.work) && rt.closedWorkOf?.(source.work)?.status !== 'cancelled')
              : true
      if (alreadyHandedBack || !workStillValid) continue
      try {
        await rt.deliver({
          ...(validBotSender !== undefined ? { fromId: validBotSender } : {}),
          ...(source.senderName ? { fromName: source.senderName } : {}),
          toId: record.botId,
          sessionId,
          text,
          role: source.role,
          exchangeId,
          deferred: true,
          ...(source.replyTo ? { replyTo: source.replyTo } : {}),
          ...(source.work ? { work: source.work } : {}),
          ...(source.askWork ? { askWork: source.askWork } : {}),
          ...(source.workRef ? { workRef: source.workRef } : {}),
          ...(source.taskId ? { taskId: source.taskId } : {}),
          ...(source.imOrigin ? { imOrigin: source.imOrigin } : {}),
          ...(source.senderPart ? { fromPart: source.senderPart } : {}),
          ...(source.senderRoomId ? { fromRoomId: source.senderRoomId } : {}),
          ...(source.roomId ? { roomId: source.roomId } : {}),
          ...(source.askedBy ? { askedBy: source.askedBy } : {}),
          ...(source.batchKey ? { batchKey: source.batchKey } : {}),
          ...(source.resumedUpstream ? { resumedUpstream: true } : {}),
          ...(source.resultRef ? { resultRef: source.resultRef } : {}),
          ...(source.role === 'room' ? { note: 'you read this call during your last task; answer it now' } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
        })
      } catch (error) {
        rt.warn('ds-bot: handing a deferred %s back to %s failed: %s', source.role, name, error)
      }
    }
  }

  // Checks whether the work or reply-expecting trigger a stale inflight turn names has
  // already been answered in the pair ledger or the asker's session log. For a
  // continuation turn (`role: 'reply' | 'report' | 'resume'`), the owed answer is the
  // upstream work and its asker, never the child reply that triggered the turn.
  async function settleDeliveredTrigger(record, trigger) {
    const workId = rt.workOf(trigger)
    if (workId !== undefined) {
      const owns = rt.ownsWork(record.botId, workId)
      const asker = owns ? rt.workAsker(workId) : undefined
      const sender = asker?.senderSessionId
        ?? (trigger.role === 'request' && trigger.audience !== 'user' ? trigger.senderSessionId : undefined)
      const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
      if (owns && asker !== undefined && sender !== undefined && rt.botOf(sender) !== undefined) {
        const { back, where } = whereFor(asker)
        const answered = await alreadyAnswered(record.botId, sender, where, back, asker.senderRoomId, workId)
        if (answered.answered) {
          rt.closeWork?.(workId, name, answered.text || rt.answerText(workId, '', name))
          return true
        }
        return false
      }
      const delivered = await deliveredAnswer(record.botId, sender, workId)
      if (delivered.answered) {
        if (owns) rt.closeWork?.(workId, name, delivered.text || rt.answerText(workId, '', name))
        return true
      }
      return false
    }
    if (trigger.role === 'stopped' && trigger.exchangeId !== undefined && trigger.senderSessionId !== undefined) {
      return rt.wasReplyDelivered?.(record.botId, trigger.senderSessionId, trigger.exchangeId) === true
    }
    return false
  }

  async function settleEnded(sessionId, record, ended, events) {
    if (record.roomId !== undefined) {
      await reconcileEndedGroupTurn(sessionId, record, ended, events).catch(error => rt.warn('ds-bot: settling the group turn of %s failed: %s', sessionId, error))
      return
    }
    const task = rt.taskOwners?.has(sessionId)
    if (!task || isTerminalReason(ended.reason)) {
      await reconcileEnded(sessionId, record, ended, events).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
    }
    if (task) {
      await rt.reconcileEndedTask?.(sessionId, ended).catch(error => rt.warn('ds-bot: settling task %s failed: %s', sessionId, error))
    }
  }

  let activeKeptWorks

  const NON_WAKING_INBOX_KINDS = new Set([
    'working-directory', 'runtime-context', 'time-context', 'ds-bot-time-context',
    'bot-memory', 'skill-catalog', 'compact-checkpoint',
  ])
  const isWakingNextStepMsg = (msg) => {
    const source = msg?.source
    if (source === undefined || source === null) return true
    if (source.silent === true || source.form === 'snapshot') return false
    if (source.kind === SOURCE_KIND && ['note', 'cancelled', 'stopped', 'task-handoff'].includes(source.role)) return false
    return !NON_WAKING_INBOX_KINDS.has(source.kind)
  }
  const sourceMatchesWork = (source, workId) => source !== null && source !== undefined && (
    source.exchangeId === workId
    || source.work === workId
    || source.askWork === workId
    || source.replyTo === workId
    || (Array.isArray(source.joined) && source.joined.some(item => item?.info?.exchangeId === workId || item?.info?.work === workId || item?.info?.replyTo === workId))
  )
  const liveHeldMatchesWork = (entry, workId) => {
    if (entry === undefined) return false
    const held = [
      entry.info,
      entry.pending,
      entry.carry?.info,
      ...(entry.joined ?? []).map(item => item?.info),
      ...(entry.later ?? []).map(item => item?.info),
      ...(entry.pending?.joined ?? []).map(item => item?.info),
      ...(entry.carry?.joined ?? []).map(item => item?.info),
      ...(entry.carry?.later ?? []).map(item => item?.info),
    ]
    return held.some(info => sourceMatchesWork(info, workId))
  }

  // Startup reconciliation for genuinely abandoned open leaf works left behind when a
  // host crashed or restarted with empty or stale inflight.json. Strictly skips paused,
  // need_input, non-leaf, synthetic child/room, active-task, in-flight, switching, card,
  // or inbox-queued works. Recovers already-delivered replies from the pair ledger first,
  // otherwise settles visibly back to the caller/parent so upstream trees unblock.
  const MAX_ORPHAN_PASSES = 16
  async function reconcileOrphanWorks(keptWorks = new Set()) {
    if (stopped || rt.readOnly?.() !== undefined) return 0
    const wokenWorks = new Set()
    let totalSettled = 0

    const resolveTargetSession = (targetBot, work) => {
      if (work.toSession !== undefined) {
        return threadCurrentOfPart(targetBot, work.toSession)
          ?? (rt.isBotSession?.(work.toSession) ? work.toSession : rt.chatOf(targetBot.id))
      }
      return rt.chatOf(targetBot.id)
    }

    const collectProtectedSets = () => {
      const activeTaskWorks = new Set()
      const activeTaskIds = new Set()
      for (const bot of Object.values(rt.state?.bots ?? {})) {
        for (const task of bot?.tasks ?? []) {
          if (!isActiveTask(task)) continue
          activeTaskIds.add(task.id)
          if (task.exchangeId) activeTaskWorks.add(task.exchangeId)
          if (task.workId) activeTaskWorks.add(task.workId)
        }
      }
      const roomTrackedWorks = new Set()
      for (const report of Object.values(rt.state?.roomReports ?? {})) {
        if (report?.id) roomTrackedWorks.add(report.id)
        if (report?.sub) roomTrackedWorks.add(report.sub)
        if (report?.parentWork) roomTrackedWorks.add(report.parentWork)
      }
      for (const batch of Object.values(rt.state?.roomBatches ?? {})) {
        if (batch?.workId) roomTrackedWorks.add(batch.workId)
        if (batch?.exchangeId) roomTrackedWorks.add(batch.exchangeId)
      }
      const inflightWorks = new Set()
      for (const record of Object.values(turns)) {
        const trigger = record?.trigger
        const tracked = trigger === undefined ? undefined : rt.workOf?.(trigger)
        if (tracked) inflightWorks.add(tracked)
        if (trigger?.exchangeId) inflightWorks.add(trigger.exchangeId)
        if (trigger?.work) inflightWorks.add(trigger.work)
        if (trigger?.askWork) inflightWorks.add(trigger.askWork)
      }
      for (const list of Object.values(queued)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          const args = item?.args
          if (args?.exchangeId) inflightWorks.add(args.exchangeId)
          if (args?.work) inflightWorks.add(args.work)
          if (args?.askWork) inflightWorks.add(args.askWork)
        }
      }
      return { activeTaskWorks, activeTaskIds, roomTrackedWorks, inflightWorks }
    }

    const checkSyncActivity = (targetBot, work, workId) => {
      const primarySid = resolveTargetSession(targetBot, work)
      // `parts.js` keys `state.switching[oldSid] = { botId }` and `switchJobs()` by the
      // earlier segment moved into `segments` after `pushThreadPart`, so check Bot-level
      // non-room switches as well as all known session ids (including `work.toSession`).
      if (Object.values(rt.state?.switching ?? {}).some(entry => entry?.botId === targetBot.id && entry.roomId === undefined)) return { active: true }
      if ([...(rt.switchJobs?.() ?? [])].some(job => job?.botId === targetBot.id && job.roomId === undefined)) return { active: true }
      const allSids = [...new Set([primarySid, work.toSession, rt.chatOf(targetBot.id), ...ownChatSessions(targetBot)].filter(Boolean))]
      for (const sid of allSids) {
        if (rt.state?.switching?.[sid] !== undefined || rt.isSwitchingPart?.(sid) === true) return { active: true }
        if ((rt.unreadOf?.(sid) ?? []).some(args => args?.exchangeId === workId || args?.work === workId || args?.askWork === workId)) return { active: true }
        const liveEntry = rt.live?.get(sid)
        if (liveEntry?.turn !== undefined) {
          if (liveHeldMatchesWork(liveEntry, workId)) return { active: true }
          if (sid === primarySid && liveEntry.info === undefined) return { active: true }
        }
      }
      const inspectSids = [...new Set([primarySid, rt.chatOf(targetBot.id)].filter(Boolean))]
      for (const sid of inspectSids) {
        if (rt.waitsForApproval?.(sid) === true) return { active: true }
        if (rt.state?.questions?.[sid] !== undefined || rt.state?.views?.[sid] !== undefined) return { active: true }
        if ((rt.runningJobs?.(sid)?.length ?? 0) > 0) return { active: true }
        if (rt.hasSubagents?.(sid) === true) return { active: true }
      }
      return { active: false, primarySid, inspectSids }
    }

    for (let pass = 0; pass < MAX_ORPHAN_PASSES; pass += 1) {
      if (stopped || rt.readOnly?.() !== undefined) break
      const works = rt.state?.works
      if (works === null || typeof works !== 'object') break
      const entries = Object.entries(works)
      if (entries.length === 0) break
      let settledInPass = 0

      for (const [workId, work] of entries) {
        if (stopped || rt.readOnly?.() !== undefined) return totalSettled
        if (!work || !Object.hasOwn(works, workId)) continue
        if (keptWorks.has(workId) || wokenWorks.has(workId)) continue
        if ((work.state ?? 'open') !== 'open') continue
        if ((work.open?.length ?? 0) !== 0) continue
        if (work.child !== undefined || work.room !== undefined) continue
        if (typeof work.to !== 'string' || work.to === '') continue
        const targetBot = rt.botOf(work.to)
        if (targetBot === undefined) continue

        const initial = collectProtectedSets()
        if (initial.activeTaskWorks.has(workId) || (work.toTaskId !== undefined && initial.activeTaskIds.has(work.toTaskId))) continue
        if (initial.roomTrackedWorks.has(workId) || initial.inflightWorks.has(workId)) continue

        const syncCheck = checkSyncActivity(targetBot, work, workId)
        if (syncCheck.active) continue

        let blockedByAgent = false
        for (const sid of syncCheck.inspectSids) {
          let agent
          try {
            agent = await rt.resolveAgent(sid)
          } catch (error) {
            if (error?.code === 'plugin/disposed') return totalSettled
            blockedByAgent = true
            break
          }
          if (agent === undefined) {
            blockedByAgent = true
            break
          }
          if (agent.status === 'running') {
            const liveEntry = rt.live?.get(sid)
            if (liveEntry?.turn === undefined || liveEntry.info === undefined || liveHeldMatchesWork(liveEntry, workId)) {
              blockedByAgent = true
              break
            }
          }
          const hasMatchingInbox = (agent.inbox?.nextTurn ?? []).some(msg => sourceMatchesWork(msg?.source, workId))
            || (agent.inbox?.nextStep ?? []).some(msg => isWakingNextStepMsg(msg) && sourceMatchesWork(msg?.source, workId))
          if (hasMatchingInbox) {
            blockedByAgent = true
            break
          }
        }
        if (blockedByAgent) continue

        const delivered = await deliveredAnswer(work.to, work.from, workId)

        // Re-verify synchronously after awaits in case a live turn, delivery, or closure arrived.
        if (stopped || rt.readOnly?.() !== undefined) return totalSettled
        const current = Object.hasOwn(works, workId) ? works[workId] : undefined
        if (current === undefined || (current.state ?? 'open') !== 'open' || (current.open?.length ?? 0) !== 0) continue
        if (keptWorks.has(workId) || wokenWorks.has(workId)) continue
        const recheck = collectProtectedSets()
        if (recheck.activeTaskWorks.has(workId) || (current.toTaskId !== undefined && recheck.activeTaskIds.has(current.toTaskId))) continue
        if (recheck.roomTrackedWorks.has(workId) || recheck.inflightWorks.has(workId)) continue
        if (checkSyncActivity(targetBot, current, workId).active) continue

        if (delivered.answered) {
          const targetName = targetBot.name ?? current.name ?? 'The other Bot'
          const replyText = delivered.text || rt.answerText(workId, '', targetName)
          const parentId = current.parent
          const parent = parentId !== undefined && Object.hasOwn(works, parentId) ? works[parentId] : undefined
          rt.closeWork?.(workId, targetName, replyText)
          settledInPass += 1
          totalSettled += 1
          if (parent !== undefined && parent.open.includes(workId)) {
            const parentBotId = parent.to ?? (parent.child !== undefined ? parent.from : undefined)
            const parentBot = parentBotId === undefined ? undefined : rt.botOf(parentBotId)
            const parentAlreadyAnswered = parentBot !== undefined && parent.to !== undefined
              && (await deliveredAnswer(parent.to, parent.from, parentId)).answered === true
            if (parentAlreadyAnswered || parentBot === undefined) {
              rt.takenWork?.(parentId, workId)
            } else {
              const backRoom = rt.roomOf(current.fromRoom)?.sessions?.[parentBotId]
              const parentSid = backRoom
                ?? (current.fromPart === undefined ? undefined : threadCurrentOfPart(parentBot, current.fromPart))
                ?? (parent.toSession === undefined ? undefined : threadCurrentOfPart(parentBot, parent.toSession))
                ?? rt.chatOf(parentBotId)
              const parentAgent = parentSid === undefined ? undefined : await rt.resolveAgent(parentSid).catch(() => undefined)
              const replyAlreadyQueued = (rt.unreadOf?.(parentSid) ?? []).some(args => args?.replyTo === workId)
                || (parentAgent?.inbox?.nextTurn ?? []).some(msg => msg?.source?.replyTo === workId)
                || (parentAgent?.inbox?.nextStep ?? []).some(msg => isWakingNextStepMsg(msg) && msg?.source?.replyTo === workId)
                || liveHeldMatchesWork(rt.live?.get(parentSid), workId)
              wokenWorks.add(parentId)
              if (!replyAlreadyQueued) {
                const long = replyText.length > MESSAGE_INLINE_MAX
                  ? await rt.attachLong?.(replyText, `Answer from ${targetName}.txt`).catch(() => undefined)
                  : undefined
                await rt.deliver({
                  fromId: current.to,
                  fromName: targetName,
                  toId: parentBotId,
                  ...(parentSid ? { sessionId: parentSid } : {}),
                  text: long?.text ?? replyText,
                  ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
                  role: 'reply',
                  replyTo: workId,
                  work: parentId,
                  ...(current.ref ? { workRef: current.ref } : {}),
                  recordExchange: false,
                  exchangeId: randomUUID(),
                }).catch((error) => {
                  rt.takenWork?.(parentId, workId)
                  rt.answerMissed?.(workId)
                  rt.warn('ds-bot: waking parent work %s with recovered reply failed: %s', parentId, error)
                })
              }
            }
          } else if (parentId === undefined && current.fromPart !== undefined) {
            // Top-level work initiated by an active waiting_work background task:
            // deliver the recovered reply to the task session so it wakes instead of hanging.
            const callerBot = current.from === undefined ? undefined : rt.botOf(current.from)
            const taskThread = callerBot === undefined ? undefined : threadOfPart(callerBot, current.fromPart)
            const task = taskThread?.thread === 'task' ? callerBot.tasks?.[taskThread.index] : undefined
            if (task !== undefined && isActiveTask(task)) {
              const taskSid = threadCurrentOfPart(callerBot, current.fromPart) ?? task.sessionId
              const taskAgent = taskSid === undefined ? undefined : await rt.resolveAgent(taskSid).catch(() => undefined)
              const replyAlreadyQueued = (rt.unreadOf?.(taskSid) ?? []).some(args => args?.replyTo === workId)
                || (taskAgent?.inbox?.nextTurn ?? []).some(msg => msg?.source?.replyTo === workId)
                || (taskAgent?.inbox?.nextStep ?? []).some(msg => isWakingNextStepMsg(msg) && msg?.source?.replyTo === workId)
                || liveHeldMatchesWork(rt.live?.get(taskSid), workId)
              if (!replyAlreadyQueued) {
                const long = replyText.length > MESSAGE_INLINE_MAX
                  ? await rt.attachLong?.(replyText, `Answer from ${targetName}.txt`).catch(() => undefined)
                  : undefined
                await rt.deliver({
                  fromId: current.to,
                  fromName: targetName,
                  toId: callerBot.id,
                  ...(taskSid ? { sessionId: taskSid } : {}),
                  text: long?.text ?? replyText,
                  ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
                  role: 'reply',
                  replyTo: workId,
                  ...(current.ref ? { workRef: current.ref } : {}),
                  recordExchange: false,
                  exchangeId: randomUUID(),
                }).catch(error => rt.warn('ds-bot: waking background task %s with recovered reply failed: %s', task.id, error))
              }
            }
          }
          continue
        }

        const parentId = current.parent
        const abandoned = rt.abandonWork?.(workId, 'restart') === true
        if (abandoned) {
          settledInPass += 1
          totalSettled += 1
          if (parentId !== undefined) {
            const parent = Object.hasOwn(works, parentId) ? works[parentId] : undefined
            const parentBotId = parent?.to ?? (parent?.child !== undefined ? parent.from : undefined)
            if (parentBotId !== undefined && rt.botOf(parentBotId) !== undefined) wokenWorks.add(parentId)
          }
        } else if (Object.hasOwn(works, workId)) {
          rt.dropWork?.(workId)
          settledInPass += 1
          totalSettled += 1
        }
      }
      if (settledInPass === 0) break
    }
    return totalSettled
  }
  rt.reconcileOrphanWorks = reconcileOrphanWorks

  const mergeRecoveredSnapshot = (reloaded) => {
    if (reloaded === undefined) return false
    // Exclude turns started in this runtime so live work is never misclassified as interrupted.
    const preRestartTurns = {}
    for (const [sid, rec] of Object.entries(reloaded.turns ?? {})) {
      if (!(sid in turns)) preRestartTurns[sid] = rec
    }
    const mergedTurns = { ...preRestartTurns, ...interrupted.turns }
    const mergedQueued = Object.keys(interrupted.queued).length > 0 ? interrupted.queued : (reloaded.queued ?? {})
    const mergedSilent = Object.keys(interrupted.silent).length > 0 ? interrupted.silent : (reloaded.silent ?? {})
    interrupted = {
      turns: mergedTurns,
      queued: mergedQueued,
      silent: mergedSilent,
      obligations: reloaded.obligations ?? [],
      terminalMarkers: reloaded.terminalMarkers ?? [],
    }
    if (Object.keys(queued).length === 0 && Object.keys(mergedQueued).length > 0) queued = mergedQueued
    if (Object.keys(silent).length === 0 && Object.keys(mergedSilent).length > 0) silent = mergedSilent
    recoveringTurns = mergedTurns
    return Object.keys(mergedTurns).length > 0
      || Object.keys(mergedQueued).length > 0
      || Object.keys(mergedSilent).length > 0
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    if (coord?.recoverAfterLock?.() === true) {
      mergeRecoveredSnapshot(coord.loadInitialState?.())
    }
    coord?.syncLegacyInflight?.()
    if ((coord?.listTerminalMarkers?.().length ?? 0) > 0) {
      await reconcileTerminalMarkers().catch(error => rt.warn('ds-bot: reconciling terminal markers failed: %s', error))
    }
    const keptWorks = new Set()
    activeKeptWorks = keptWorks
    try {
      const { turns: noted, queued: dropped, silent: droppedSilent } = interrupted
      interrupted = { turns: {}, queued: {}, silent: {} }
      // What the last run still had on the way is noted again first, under the
      // Session it would go to now: nothing is cleared before it is handed over.
      // A Bot that is gone takes its notes with it; what a turn already read here
      // is done with.
      const pending = queued
      queued = {}
      for (const [oldId, list] of Object.entries(pending)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) {
            continue
          }
          const target = resolveReplayTarget(oldId, item.args)
          if (target === undefined) {
            rt.noteFailure?.({
              level: 'warn',
              source: 'delivery',
              code: 'RECIPIENT_CLOSED',
              text: 'The delivery was not redirected: its original task or group has closed.',
              sessionId: oldId,
            })
            continue
          }
          const updatedArgs = { ...item.args, address: target.address }
          queued = { ...queued, [target.sessionId]: [...(queued[target.sessionId] ?? []), { ...item, args: updatedArgs }] }
        }
      }
      coord?.replaceAllDeliveries?.(queued)
      persist()
      // Restore persisted silent notices before waking Sessions via resendQueued/resumeTurn,
      // preserving causal order without waking idle recipients (or wiping notes buffered
      // during the startup window before resumeAll ran).
      await rt.restoreSilentNotes?.(droppedSilent).catch(error => rt.warn('ds-bot: restoring silent notes failed: %s', error))
      persist()
      // Agents and inboxes are read before anything wakes their Sessions.
      const cut = []
      const keepTaskSessions = new Set()
      const unverified = {}
      for (const [sessionId, record] of Object.entries(noted)) {
        const first = firstTurn?.get(sessionId)
        if (first?.type === 'turn/end') {
          // The turn ended while DS Bot was not watching it: what it did is settled from
          // the Session's durable log.
          await settleEnded(sessionId, record, first)
          continue
        }
        // Still running: noted again, as if it had started here.
        if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') {
          update(sessionId, () => record)
          keepTaskSessions.add(sessionId)
          const activeWork = record.trigger === undefined ? undefined : rt.workOf?.(record.trigger)
          if (activeWork !== undefined) keptWorks.add(activeWork)
          continue
        }
        // Check durable session evidence before deciding whether to settle, hold, or resume.
        let inspectedEvents
        let inspectedTurn
        if (first === undefined) {
          const history = await rt.readSessionEvidence(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
          inspectedEvents = history.status === 'ok' ? history.events : undefined
          inspectedTurn = inspectedEvents === undefined ? undefined : findRecordedTurn(inspectedEvents, record)
          const unknownTool = !isTerminalReason(inspectedTurn?.reason)
            && record.approval === undefined
            && (inspectedTurn?.unconfirmedCalls?.size ?? 0) > 0
          if (history.status === 'error' || unknownTool) {
            unverified[sessionId] = { ...record, unverified: true }
            keepTaskSessions.add(sessionId)
            const activeWork = record.trigger === undefined ? undefined : rt.workOf?.(record.trigger)
            if (activeWork !== undefined) keptWorks.add(activeWork)
            rt.noteFailure?.({
              level: 'warn',
              source: 'delivery',
              code: 'TURN_UNVERIFIED',
              text: unknownTool
                ? 'A tool started before restart but has no saved result. Verify its effect before continuing; it was not run again.'
                : 'Could not verify whether this turn finished. Its commands were not restarted.',
              sessionId,
            })
            continue
          }
          if (isTerminalReason(inspectedTurn?.reason)) {
            await settleEnded(sessionId, record, { reason: inspectedTurn.reason }, inspectedEvents)
            continue
          }
          if (record.roomId === undefined && record.trigger !== undefined && await settleDeliveredTrigger(record, record.trigger)) {
            if (inspectedTurn !== undefined) {
              const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
              await recoverTurnDeferred(sessionId, record, inspectedTurn, inspectedEvents, name)
            }
            continue
          }
        }
        cut.push([sessionId, record, inspectedEvents, inspectedTurn])
      }
      firstTurn = undefined
      for (const [sessionId, list] of Object.entries(dropped)) {
        if (!Array.isArray(list)) continue
        const active = await resendQueued(sessionId, list).catch((error) => {
          rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error)
          return new Set()
        })
        for (const dest of active ?? []) keepTaskSessions.add(dest)
      }
      taken = undefined
      for (const [sessionId, record, events, turn] of cut) {
        const resumed = await resumeTurn(sessionId, record).catch((error) => {
          rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error)
          return false
        })
        if (resumed === true) {
          keepTaskSessions.add(sessionId)
          const activeWork = record.trigger === undefined ? undefined : rt.workOf?.(record.trigger)
          if (activeWork !== undefined) keptWorks.add(activeWork)
        }
        // Recover any other steered messages (requests, replies, ask_backs, answers, reports)
        // that arrived during the interrupted turn so they are not dropped when only `trigger` resumes.
        if (turn !== undefined && turn.took.length > 0) {
          const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
          await recoverTurnDeferred(sessionId, record, turn, events, name)
        }
      }
      // Reconcile orphaned background tasks before settling room batches so a zombie
      // group task does not keep `hasRoomTasks` true and mask a stuck batch.
      recoveringTurns = unverified
      coord?.replaceAllTurns?.({ ...recoveringTurns, ...turns })
      persist()
      await recoverObligations(keepTaskSessions).catch(error => rt.warn('ds-bot: replaying pending obligations failed: %s', error))
      await rt.reconcileTasksAfterRestart?.(keepTaskSessions).catch(error => rt.warn('ds-bot: reconciling background tasks failed: %s', error))
      // What a group's members were asked for and will not pick up is settled now.
      await rt.settleRoomBatches?.()
      await rt.settleRoomReports?.(undefined, { startup: true })
      await reconcileOrphanWorks(keptWorks).catch(error => rt.warn('ds-bot: reconciling orphan works failed: %s', error))
    } finally {
      activeKeptWorks = undefined
    }
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0
      || Object.keys(interrupted.queued).length > 0
      || Object.keys(interrupted.silent).length > 0
      || (interrupted.obligations?.length ?? 0) > 0
      || (interrupted.terminalMarkers?.length ?? 0) > 0
    // With nothing to pick up, orphaned tasks and group batches a restart left are settled at once.
    let fastStartup = Promise.resolve()
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => {
        fastStartup = rt.load()
          .then(() => {
            if (rt.readOnly() === undefined && coord?.recoverAfterLock?.() === true) {
              if (mergeRecoveredSnapshot(coord.loadInitialState?.())) {
                return resumeAll()
              }
            }
            firstTurn = undefined
            taken = undefined
            const hasWork = (coord?.listTerminalMarkers?.().length ?? 0) > 0
              || (coord?.listPendingObligations?.().length ?? 0) > 0
            return hasWork
              ? reconcileTerminalMarkers().then(() => recoverObligations()).then(() => rt.reconcileTasksAfterRestart?.(new Set()))
              : rt.reconcileTasksAfterRestart?.(new Set())
          })
          .then(() => rt.settleRoomBatches?.())
          .then(() => rt.settleRoomReports?.(undefined, { startup: true }))
          .catch(error => rt.warn('ds-bot: settling group batches failed: %s', error))
      }, 0)
    timer?.unref?.()
    // Even with empty inflight.json, open leaf works can be stranded after a crash or
    // restart; wait RESUME_DELAY_MS so workspaces, live turns, and part hand-offs settle first.
    const orphanTimer = pending
      ? undefined
      : setTimeout(() => void rt.load()
        .then(() => fastStartup)
        .then(() => reconcileOrphanWorks())
        .catch(error => rt.warn('ds-bot: reconciling orphan works failed: %s', error)), RESUME_DELAY_MS)
    orphanTimer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(orphanTimer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
