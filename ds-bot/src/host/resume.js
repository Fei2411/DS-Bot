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
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
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
      current = { turn: event.data?.turn, took: [], messages: {}, texts: [], reason: undefined, end: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) {
        current.took.push(source)
        // What the message held, for handing it back when its turn completed and no
        // deferred delivery made it: text, and the attachments it carried.
        current.messages[source.exchangeId] = { content: event.data?.content }
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

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && turn.reason.reason?.reason === STEER_CUT
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    // A steer cut lands inside a step's model call, so the cut turn's last step left
    // an interrupted draft: texts before the last step/start stay, the rest is a
    // fragment the continuation replaces.
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], messages: { ...found.messages, ...follow.messages }, texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
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
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued) }
  } catch {
    return { turns: {}, queued: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
  let turns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Written in place: a rename over the file fails on Windows while anything reads
    // it, and a torn write only loses what one restart would pick up.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      await writeFile(file, snapshot, 'utf8')
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
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

  const deliver = rt.deliver
  // Deliveries on their way right now, by Session and exchangeId. A deferred delivery is
  // one request handed back for a turn of its own; the normal path and a restart
  // recovery can both reach it, and the later caller waits for the one already going.
  // A failed delivery leaves the note (the next start sends it again) but not this
  // entry, so a retry in this run really sends it.
  const sending = new Map()
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
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

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ message } = {}) => {
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
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
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}) }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
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
      // must not run it forever.
      if (record.resumed) return false
      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return true
    }
    if (record.resumed) return false
    // The turn ran in a part that is still one of the Bot's: it goes on there, not in the
    // foreground chat when that part is a background one. A part gone since (archived and
    // dropped) falls back to the Bot's current chat.
    const ownPart = rt.selfOf(sessionId) === bot.id && rt.isBotSession(sessionId) ? { sessionId } : {}
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, ...ownPart, ...(trigger.senderPart ? { fromPart: trigger.senderPart } : {}), role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
      return true
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, ...ownPart, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}) })
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
    const fresh = list.filter(item => rt.botOf(item.args?.toId) !== undefined
      && sessionFor(sessionId, item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
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
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    const ownsPrimary = rt.ownsWork(record.botId, workId)
    const hasOwnedWork = ownsPrimary || Object.values(rt.state?.works ?? {}).some(work => work.to === record.botId)
    if (!hasOwnedWork) return
    const exchangeId = trigger.exchangeId
    if (exchangeId === undefined) return
    const primaryAsker = ownsPrimary ? rt.workAsker(workId) : undefined
    const primarySender = primaryAsker?.senderSessionId
    const canSettlePrimary = ownsPrimary && primarySender !== undefined && rt.botOf(primarySender) !== undefined
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? rt.botOf(record.botId)?.name ?? 'The other Bot'
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
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
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
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
        answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`, undefined, { dedupKey })
      }
    }
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      if (!primarySettled) settleFailureOrAbort(primaryAsker)
      // Steered requests that joined the same failed or aborted turn also owe their own
      // callers settlement, so distinct parent works cannot stall across a restart.
      const seen = new Set([workId, exchangeId])
      for (const took of turn.took) {
        if (took?.kind !== SOURCE_KIND || (took.role !== 'request' && took.role !== 'stopped') || took.audience === 'user') continue
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
      return
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
    // A request that steered into this turn is answered in a turn of its own; a crash
    // after the completed turn/end but before that delivery left it open.
    await recoverJoinedRequests(sessionId, record, turn, events, name)
  }

  // Requests the turn read as steering are handed back to the Bot in a turn of their
  // own when the turn ends. A crash between a successful turn/end reaching disk and
  // that delivery leaves them open, and the caller or parent waits forever. The durable
  // log still holds them, so each is delivered again in the same conversation — with
  // the attachments and the work it came with — unless it was already handed back, taken
  // up, or answered before the crash.
  async function recoverJoinedRequests(sessionId, record, turn, events, name) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const seen = new Set([rt.workOf?.(record.trigger), record.trigger?.exchangeId])
    for (const source of turn.took) {
      if (source?.kind !== SOURCE_KIND) continue
      if (source.role !== 'request' && source.role !== 'stopped') continue
      if (source.audience === 'user') continue
      const exchangeId = source.exchangeId
      if (typeof exchangeId !== 'string' || exchangeId === '' || seen.has(exchangeId)) continue
      seen.add(exchangeId)
      // A request whose work is gone was closed, or answered, in another run.
      if (source.role === 'request' && !rt.ownsWork(record.botId, exchangeId)) continue
      const sender = source.senderSessionId
      if (sender === undefined || rt.botOf(sender) === undefined) continue
      // Handed back after this turn ended: it is already in the Session's log, and the
      // restart resend or its own inbox moves it; an earlier or later turn took it up.
      if (turn.end !== undefined && events.some(event => event.seq !== undefined && event.seq > turn.end
        && event.type === 'user/message'
        && (event.data?.source?.exchangeId === exchangeId
          || event.data?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId)))) continue
      if (rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId)) continue
      // The reply went out in another run: the work closes with what it said, and the
      // Bot is not asked again.
      if (source.role === 'request') {
        const asker = rt.workAsker(exchangeId)
        if (asker !== undefined) {
          const { back, where } = whereFor(asker)
          const answered = await alreadyAnswered(record.botId, sender, where, back, asker.senderRoomId, exchangeId)
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
      const images = content.filter(block => block?.type === 'image' && block.attachment !== undefined).map(block => block.attachment)
      const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
      // The checks above awaited, so the normal path may have committed this exchange,
      // started a live turn for it, or closed its work in the meantime. Check once more
      // with nothing awaited between here and the delivery: a queued note, an inbox
      // entry, or a live turn holding the same exchange means it was already handed back,
      // and a closed work has nothing left to answer.
      const liveEntry = rt.live?.get(sessionId)
      const liveHeld = [
        liveEntry?.info,
        liveEntry?.pending,
        liveEntry?.carry?.info,
        ...(liveEntry?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.pending?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.carry?.joined ?? []).map(joined => joined?.info),
      ]
      const alreadyHandedBack = rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId) === true
        || [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
          .some(message => message?.source?.exchangeId === exchangeId
            || message?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId))
        || liveHeld.some(item => item?.exchangeId === exchangeId)
      const workOpen = source.role !== 'request'
        || (rt.ownsWork(record.botId, exchangeId) && rt.workAsker(exchangeId) !== undefined)
      if (alreadyHandedBack || !workOpen) continue
      try {
        await rt.deliver({
          fromId: sender,
          toId: record.botId,
          sessionId,
          text,
          role: source.role,
          exchangeId,
          deferred: true,
          ...(source.senderPart ? { fromPart: source.senderPart } : {}),
          ...(source.senderRoomId ? { fromRoomId: source.senderRoomId } : {}),
          ...(source.roomId ? { roomId: source.roomId } : {}),
          ...(source.askedBy ? { askedBy: source.askedBy } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
        })
      } catch (error) {
        rt.warn('ds-bot: handing a steered request back to %s failed: %s', name, error)
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
    const { turns: noted, queued: dropped } = interrupted
    interrupted = { turns: {}, queued: {} }
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
      // If inflight.json still held a turn whose durable log already shows a finished
      // turn/end, or whose owed reply is already recorded in the pair ledger, settle it
      // instead of re-running via resumeTurn.
      if (first === undefined && record.roomId === undefined && record.trigger !== undefined) {
        const trigger = record.trigger
        const events = trigger.exchangeId !== undefined ? await logOf(sessionId) : undefined
        const turn = events === undefined ? undefined : turnOf(events, trigger.exchangeId)
        if (isTerminalReason(turn?.reason)) {
          await settleEnded(sessionId, record, { reason: turn.reason }, events)
          continue
        }
        if (await settleDeliveredTrigger(record, trigger)) continue
      }
      cut.push([sessionId, record])
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
    for (const [sessionId, record] of cut) {
      const resumed = await resumeTurn(sessionId, record).catch((error) => {
        rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error)
        return false
      })
      if (resumed === true) keepTaskSessions.add(sessionId)
    }
    // Reconcile orphaned background tasks before settling room batches so a zombie
    // group task does not keep `hasRoomTasks` true and mask a stuck batch.
    await rt.reconcileTasksAfterRestart?.(keepTaskSessions).catch(error => rt.warn('ds-bot: reconciling background tasks failed: %s', error))
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    // With nothing to pick up, orphaned tasks and group batches a restart left are settled at once.
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => void rt.load()
        .then(() => rt.reconcileTasksAfterRestart?.(new Set()))
        .then(() => rt.settleRoomBatches?.())
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
