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
import { readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, isWorkTool, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { replaceFile } from './files.js'
import { stripOwnName } from './groups.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'
import { threadCurrentOfPart, threadOfPart } from './threads.js'

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
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued), silent: object(parsed?.silent) }
  } catch {
    return { turns: {}, queued: {}, silent: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)

  /** @type {Record<string, {botId:string, roomId?:string, turn?:number, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
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
    latest = JSON.stringify({ turns, queued, ...(Object.keys(silent).length > 0 ? { silent } : {}) })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Atomic temp + replaceFile (with Windows retry) so a crash mid-write never
    // leaves a torn inflight.json that drops all in-flight turns and queued work.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      const temp = `${file}.${process.pid}.tmp`
      await mkdir(home, { recursive: true })
      try {
        await writeFile(temp, snapshot, 'utf8')
        await replaceFile(temp, file)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const noteSilent = (sessionId, entries) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const next = { ...silent }
    if (!Array.isArray(entries) || entries.length === 0) {
      if (!(sessionId in next)) return
      delete next[sessionId]
    } else {
      next[sessionId] = entries.map(entry => ({ message: entry.message, ...(entry.ledger ? { ledger: entry.ledger } : {}) }))
    }
    silent = next
    persist()
  }
  rt.noteSilent = noteSilent
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
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
  const forgetWorkDeliveries = (workId) => {
    if (typeof workId !== 'string' || workId === '') return
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

  const deliver = rt.deliver
  // Deliveries on their way right now, by Session and exchangeId. A deferred delivery is
  // one request handed back for a turn of its own; the normal path and a restart
  // recovery can both reach it, and the later caller waits for the one already going.
  // A failed delivery leaves the note (the next start sends it again) but not this
  // entry, so a retry in this run really sends it.
  const sending = new Map()
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    // Non-waking silent notices (note_bot, cancel_work, stop_bot) do not open turns, so
    // they must never enter inflight `queued` (would inflate unread counts and resend as work).
    if (noted.wake === false) return deliver(noted)
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    const repeat = noted.deferred === true && noted.resent !== true
    const key = `${sessionId}\u0000${noted.exchangeId}`
    if (repeat) {
      const running = sending.get(key)
      if (running !== undefined) return running
    }
    // Noted before it is sent: a turn may take it up before the send returns. Notes
    // are kept whole; nothing waits out a delivery silently. A retry replaces its own
    // note instead of stacking a second one.
    const waiting = queued[sessionId] ?? []
    const at = waiting.findIndex(item => item.args?.exchangeId === noted.exchangeId)
    const note = { at: Date.now(), args: noted }
    queued = { ...queued, [sessionId]: at === -1 ? [...waiting, note] : waiting.with(at, note) }
    persist()
    const run = (async () => {
      try {
        return await deliver(noted)
      } catch (error) {
        // A delivery that never reached the inbox stays noted: the next start sends
        // it again. One whose Bot is gone is dropped, since it can never be sent.
        if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
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
  rt.restoreDelivery = (sessionId, args) => {
    if (sessionId === undefined || args?.exchangeId === undefined) return
    const waiting = queued[sessionId] ?? []
    const at = waiting.findIndex(item => item.args?.exchangeId === args.exchangeId)
    const note = { at: Date.now(), args }
    queued = { ...queued, [sessionId]: at === -1 ? [...waiting, note] : waiting.with(at, note) }
    persist()
  }
  rt.forgetWorkDeliveries = forgetWorkDeliveries

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    const source = message?.source
    if (source?.kind === SOURCE_KIND && source.exchangeId) forgetQueued(source.exchangeId)
    if (source?.kind === SOURCE_KIND && (source.role === 'post' || source.role === 'goal') && typeof source.roomId === 'string') {
      if (rt.isMovingInboxMessage?.(message?.id) === true) return
      rt.roomRelayDiscarded?.(source, agent?.id ?? agent?.session?.id)
    }
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
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
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') break
        update(id, () => undefined)
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
      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return true
    }
    if (record.resumed) return false
    // The turn ran in a part that is still one of the Bot's: it goes on there, not in the
    // foreground chat when that part is a background one. A part gone since (archived and
    // dropped) falls back to the Bot's current chat.
    const ownPart = rt.selfOf(sessionId) === bot.id && rt.isBotSession(sessionId) ? { sessionId } : {}
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
    await rt.deliver({ toId: bot.id, ...ownPart, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}), ...(trigger?.workRef ? { workRef: trigger.workRef } : {}) })
    return true
  }

  // Where a queued note goes now: its Session if it still is one, else the
  // current Session of its Bot, or of its group when the message went to one.
  const sessionFor = (sessionId, args) => (rt.isBotSession(sessionId) ? sessionId
    : args?.roomId === undefined ? rt.chatOf(args?.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId])

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. The notes stay queued until a turn takes the messages
  // up, so a send that fails here, or a Session that cannot be opened, leaves them
  // for the next start instead of losing them.
  async function resendQueued(sessionId, list) {
    const active = new Set()
    const fresh = []
    for (const item of list) {
      const args = item?.args
      if (args === undefined || rt.botOf(args.toId) === undefined || sessionFor(sessionId, args) === undefined || taken?.has(args.exchangeId) === true) continue
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
    const target = sessionFor(sessionId, fresh[0].args)
    const agent = await rt.resolveAgent(target)
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source?.exchangeId))
    for (const { args } of fresh) {
      const dest = sessionFor(sessionId, args)
      if (waiting.has(args.exchangeId)) {
        if (dest !== undefined) active.add(dest)
        continue
      }
      if (taken?.has(args.exchangeId) === true) {
        forgetQueued(args.exchangeId)
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      const ok = await deliver({ ...args, sessionId: dest, steer: false, resent: true })
        .then(() => true, (error) => { rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error); return false })
      if (ok && dest !== undefined) active.add(dest)
    }
    return active
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
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
    if (turn === undefined) return
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
    if (reason?.kind === 'blocked') return
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
        await rt.lateRoomReply?.(sessionId, info, reply, { toolCount: turn.toolCount ?? 0 })
      }
    }
    await recoverTurnDeferred(sessionId, record, turn, events, bot.name)
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
        if (!rt.ownsWork(record.botId, source.work)) continue
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
          || event.data?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId)))) continue
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
              ? (rt.ownsWork(record.botId, source.work) && rt.closedWorkOf?.(source.work)?.status !== 'cancelled')
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

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
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
        if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) continue
        const key = sessionFor(oldId, item.args) ?? oldId
        queued = { ...queued, [key]: [...(queued[key] ?? []), item] }
      }
    }
    persist()
    // Restore persisted silent notices before waking Sessions via resendQueued/resumeTurn,
    // preserving causal order without waking idle recipients (or wiping notes buffered
    // during the startup window before resumeAll ran).
    await rt.restoreSilentNotes?.(droppedSilent).catch(error => rt.warn('ds-bot: restoring silent notes failed: %s', error))
    persist()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    const keepTaskSessions = new Set()
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
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
        continue
      }
      // If inflight.json still held a turn (Bot work, ordinary user turn, or group turn)
      // whose durable log already shows a terminal turn/end, or whose owed reply is already
      // recorded in the pair ledger, settle it instead of re-running via resumeTurn.
      let inspectedEvents
      let inspectedTurn
      if (first === undefined) {
        inspectedEvents = await logOf(sessionId)
        inspectedTurn = inspectedEvents === undefined ? undefined : findRecordedTurn(inspectedEvents, record)
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
      if (resumed === true) keepTaskSessions.add(sessionId)
      // Recover any other steered messages (requests, replies, ask_backs, answers, reports)
      // that arrived during the interrupted turn so they are not dropped when only `trigger` resumes.
      if (turn !== undefined && turn.took.length > 0) {
        const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
        await recoverTurnDeferred(sessionId, record, turn, events, name)
      }
    }
    // Reconcile orphaned background tasks before settling room batches so a zombie
    // group task does not keep `hasRoomTasks` true and mask a stuck batch.
    await rt.reconcileTasksAfterRestart?.(keepTaskSessions).catch(error => rt.warn('ds-bot: reconciling background tasks failed: %s', error))
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
    await rt.settleRoomReports?.(undefined, { startup: true })
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0
      || Object.keys(interrupted.queued).length > 0
      || Object.keys(interrupted.silent).length > 0
    // With nothing to pick up, orphaned tasks and group batches a restart left are settled at once.
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => void rt.load()
        .then(() => rt.reconcileTasksAfterRestart?.(new Set()))
        .then(() => rt.settleRoomBatches?.())
        .then(() => rt.settleRoomReports?.(undefined, { startup: true }))
        .catch(error => rt.warn('ds-bot: settling group batches failed: %s', error)), 0)
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
