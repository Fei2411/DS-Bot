// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. A group chat is one shared, ordered conversation, so members
// speak one at a time: a turn starts only after the previous speaker has posted or
// passed, and it shows everything that arrived since that member last looked, plus
// the speaking order and the member's place in it. Nobody answers a room that has
// moved on, and nobody has to count lines to know who went before. A plain message
// goes to every member in roster order, admin first, or to the admin alone in admin
// mode; "@Name" picks members. A reply that @mentions a member calls that member
// next, bounded per member and per round; the admin's calls reach further.
//
// Work does not hold a round up: a member that is still busy with tools a little after
// it started, or that is called while still at earlier work, lets the round go on. Its
// turn keeps running in its group Session, and what it ends with is posted to the group,
// where the member that asked for it answers.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROOM_LATE_ROUNDS, ROOM_REPLY_TIMEOUT_MS, ROOM_WORK_GRACE_MS, SOURCE_KIND, TEAM_TOOLS } from './constants.js'
import { escapeRegExp, splitRef, textOf } from './text.js'
import { mentionSpans } from '../shared/mentions.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_TURNS_EACH = 2
const ROOM_ADMIN_TURNS_EACH = 4

// Logs written before rooms were versioned get sequence numbers in place.
const ensureRoomLog = (room) => {
  if (typeof room.seq !== 'number') {
    room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
    room.seq = room.log.length
  }
  room.seen ??= {}
}

const appendRoom = (room, line) => {
  room.seq += 1
  room.log = [...room.log, { ...line, seq: room.seq }].slice(-ROOM_LOG_MAX)
}

// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

const lineText = (line) => {
  if (line.kind === 'lookup') return `[${line.who} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${line.who}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${line.who}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${line.who}'s work here]`
  return `${line.who}: ${line.text}`
}
const transcript = lines => lines.map(lineText).join('\n')

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// Who "@" calls, in order, by the same rule the bubbles draw. `references` are the
// round's referenced conversations: each one's "@label" is a reference, not a call.
// Pass every member, the speaker too, so "@新 Bot 2" said by 新 Bot 2 is never read as
// a call to 新 Bot; the caller drops the speaker.
export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you and sees each message you write while you work: say what you will do, share what matters as you go, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_CALLS = 'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const slotLabel = (slot) => {
  if (slot.status === 'speaking') return `${slot.name} (you, now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

// The opening turn of a group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

export function install(rt) {
  const { ctx } = rt

  // A member's group Session, created on its first turn there. A new one starts with
  // a fresh look at the log and a brief of the member's own chat; the brief is the
  // first message, so it stays fixed and the prefix stays cacheable.
  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }) })
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      await rt.selectSessionModel(id, splitRef(ref))
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.applyPermission(member, id)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  function roomPrompt(room, member, round) {
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const index = round.slots.findIndex(slot => slot.status === 'speaking')
    const before = index
    const after = round.slots.length - index - 1
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. Members speak one at a time; each message is posted before the next speaker starts. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) return [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n')
    const working = workingIn(room).filter(item => item.bot.id !== member.id)
    return [
      members,
      notice,
      leads ? adminNote(room) : '',
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier)}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current)}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min)`).join(', ')}.` : '',
      `Speaking order for this round: ${round.slots.map(slotLabel).join(' → ')}.`,
      `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
  }

  // Members whose turn in this group is running, and since when.
  const workingIn = room => room.members.flatMap((id) => {
    const entry = rt.live.get(room.sessions?.[id])
    const bot = rt.botOf(id)
    return entry?.turn !== undefined && bot !== undefined ? [{ bot, since: entry.since ?? Date.now() }] : []
  })
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // A member's message in the round: in the log, for the members after it, and in the
  // round's replies, for the user.
  const postInRound = (room, round, member, text) => {
    appendRoom(room, { who: member.name, botId: member.id, text })
    round.replies.push({ botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
    void rt.save().catch(() => {})
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
  // it waits for the user's approval, `{ working }` when it goes on working without the
  // round, or null when the round was stopped. The wait restarts on each event of the
  // member's Session, so a member at work is never cut off. `by` is the member that
  // called it, which answers what the turn posts after the round moved on. What the
  // member writes before its last step is posted at once and collected in `said`.
  async function roomTurn(room, member, sessionId, text, note, signal, round, by, said = []) {
    if (signal.aborted) return null
    const exchangeId = randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    room.seen[member.id] = room.seq
    // Checked before the delivery, which may start the turn at once.
    const busy = rt.live.get(sessionId)?.turn !== undefined
    const done = new Promise((resolve) => {
      let timer
      let grace
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        rt.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS) }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        postInRound(room, round, member, step)
      }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, say, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text, hop: round.hop, ...(by ? { askedBy: by } : {}) })
      // Still held by an earlier request: this turn cannot start until the user answers.
      if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      // Still at earlier work: the call waits in its inbox and is answered after that.
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      rt.roomWaiters.get(exchangeId)?.resolve(null)
    }
    const reply = await done
    // A turn that ended leaves nothing for a stop to cancel.
    if (typeof reply === 'string' || reply?.failure !== undefined) started.splice(started.indexOf(turn), 1)
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  // A member that reaches its context limit mid-turn goes on in a fresh Session, so a
  // waiter is also found by the member and group that Session now speaks for.
  const waitersOf = (sessionId) => {
    const owner = rt.groupOwners.get(sessionId)
    return [...rt.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId
      || (owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  }
  rt.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // The team's own tools are quick; any other tool is the start of work.
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
  rt.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    for (const waiter of waitersOf(sessionId)) waiter.work()
  }

  // A called member moves up if it is still waiting, or gets one more turn if it
  // already spoke; either way it goes right after slot `index`. `cap` is the caller's
  // per-member turn bound for the round; `by` is the calling member, if a member called.
  function callMembers(round, turns, index, callees, note, cap, by) {
    let next = index + 1
    for (const peer of callees) {
      if ((turns.get(peer.id) ?? 0) >= cap) continue
      const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
      const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
      called.note = note
      if (by === undefined) delete called.by
      else called.by = by
      round.slots.splice(next, 0, called)
      next += 1
    }
  }

  // The user's messages waiting in the group Session's inbox while a round runs, from
  // the composer whether it queued or steered them. Images and chat references are
  // only read when the Session takes the message itself, so a message with either
  // stays for the next round, and so does everything after it in that list.
  const waitingLines = agent => ['nextStep', 'nextTurn'].flatMap((list) => {
    const lines = []
    for (const message of agent?.inbox?.[list] ?? []) {
      if (message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) break
      lines.push({ id: message.id, text })
    }
    return lines
  })

  // Messages the user sent while this round is running post into the log before the
  // next speaker, so everyone still to speak sees them. The members the message's own
  // round would open with answer it next, inside this round. Each message leaves the
  // Session's inbox, so it does not open another round when this one ends. Returns
  // the number of turns added, which the round's limit allows for.
  function drainRoomInbox(room, round, turns, index, agent) {
    // The greeting's prompt tells the admin the user has not written yet.
    if (round.kickoff) return 0
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return 0
    const before = round.slots.length
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      appendRoom(room, { who: 'User', text: line.text })
      round.replies.push({ kind: 'user', text: line.text, time: Date.now() })
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      callMembers(round, turns, index - 1, openingSpeakers(room, { text: line.text }), note, ROOM_ADMIN_TURNS_EACH)
    }
    // The user spoke in this room, so Bots may start their own rounds again. These
    // messages never reach the Session as events, so the team's count resets here too.
    room.botRounds = 0
    room.lateRounds = 0
    rt.userSpoke()
    void rt.save().catch(() => {})
    return round.slots.length - before
  }

  async function runRound(room, round, signal, agent) {
    let limit = round.slots.length + ROOM_EXTRA_TURNS + (room.admin ? ROOM_ADMIN_EXTRA_TURNS : 0)
    const turns = new Map()
    // The inbox check keeps a message sent during the last speaker's turn inside
    // this round: it drains at the loop's head even once the slots ran out.
    for (let index = 0; (index < round.slots.length || waitingLines(agent).length > 0) && round.turns < limit; index += 1) {
      if (signal.aborted) break
      limit += drainRoomInbox(room, round, turns, index, agent)
      if (index >= round.slots.length) break
      const slot = round.slots[index]
      const member = rt.botOf(slot.id)
      // Settings may change mid-round, for example when the admin removes someone.
      if (member === undefined || !room.members.includes(slot.id)) {
        slot.status = 'left'
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns += 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      let session
      try {
        session = await groupSessionFor(room, member)
      } catch (error) {
        rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
        round.speaking = null
        slot.status = 'failed'
        round.failed.push(member.name)
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
        continue
      }
      const prompt = roomPrompt(room, member, round)
      round.shown?.push(member.id)
      const text = session.brief === undefined ? prompt : `${session.brief}\n\n${prompt}`
      const said = []
      const reply = await roomTurn(room, member, session.id, text, slot.note ?? 'your turn', signal, round, slot.by, said)
      round.speaking = null
      const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
      if (reply?.failure !== undefined) {
        // Not a pass: the user sees why the member is silent, and the round goes on.
        slot.status = 'failed'
        round.failed.push(member.name)
        const { code, status, message } = reply.failure
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      } else if (reply?.approval) {
        // The member's turn goes on in the background and posts when it ends.
        slot.status = 'waiting-approval'
        round.replies.push({ kind: 'approval', botId: member.id, name: member.name, color: member.color, time: Date.now() })
      } else if (reply?.working) {
        slot.status = 'working'
        round.replies.push({ kind: 'working', botId: member.id, name: member.name, color: member.color, time: Date.now() })
      } else if (final !== undefined || (typeof reply === 'string' && said.length > 0)) {
        slot.status = 'posted'
        if (final !== undefined) postInRound(room, round, member, final)
      } else {
        slot.status = typeof reply === 'string' ? 'passed' : 'missed'
        round.passed.push(member.name)
        if (reply?.missed) round.replies.push({ kind: 'missed', botId: member.id, name: member.name, color: member.color, time: Date.now() })
      }
      const spoken = final === undefined ? said : [...said, final]
      if (spoken.length === 0) continue
      // Only the admin's "@all" calls everyone, so a member cannot set off a storm.
      const leads = rt.isAdminOf(room, member.id)
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const others = everyone.filter(other => other.id !== member.id)
      const { all, found: named } = mentionsIn(spoken.join('\n\n'), everyone)
      const found = named.filter(other => other.id !== member.id)
      const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
      callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? ROOM_ADMIN_TURNS_EACH : ROOM_TURNS_EACH, member.id)
    }
  }

  ctx.tools.register(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots in this group chat, one at a time, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      const startSeq = room.seq + 1
      // The opening greeting is a cue for the admin, not a line of the group; a member's
      // late failure, its work picked up after a restart, or its work the user stopped is
      // an event of the round.
      const event = item => item.failed || item.resumed || item.stopped
      for (const post of posts.filter(item => !item.kickoff && !event(item))) {
        // Image readings go into the log only; `@` names are picked from what the user typed.
        const text = post.images === undefined ? post.text : [post.text, ...await rt.imagesForGroup(post.images, room.id)].filter(Boolean).join('\n')
        appendRoom(room, post.botId
          ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId, text }
          : { who: 'User', text })
      }
      if (posts.some(post => !post.botId && !post.kickoff)) {
        room.botRounds = 0
        room.lateRounds = 0
      }
      await rt.save()
      // An event post never picks the speakers over a message queued with it.
      const opener = posts.findLast(post => !event(post)) ?? posts.at(-1)
      const references = posts.flatMap(post => post.references ?? [])
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members.map(rt.botOf).filter(Boolean)).found
      const round = {
        roomId: room.id,
        members: room.members,
        startSeq,
        // Member turns answer the opener, so they keep its hop; a round the user opens starts at 0.
        hop: opener.hop ?? 0,
        ...(opener.kickoff ? { kickoff: true } : {}),
        ...(references.length > 0 ? { references, shown: [] } : {}),
        slots: openingSpeakers(room, opener).map(member => ({
          id: member.id, name: member.name, status: 'waiting',
          ...(opener.kickoff ? { note: 'the group was just created' } : {}),
          ...(named.includes(member) ? { by: opener.botId } : {}),
        })),
        speaking: null,
        turns: 0,
        replies: [],
        passed: [],
        failed: [],
        started: [],
      }
      for (const post of posts.filter(item => item.failed)) {
        const bot = rt.botOf(post.botId)
        const { code, status, message } = post.failed
        round.failed.push(bot?.name ?? post.name)
        round.replies.push({ kind: 'failed', botId: post.botId, name: bot?.name ?? post.name, color: bot?.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      }
      // The log line tells the admin and the other members on their next turn.
      for (const post of posts.filter(item => item.resumed || item.stopped)) {
        const bot = rt.botOf(post.botId)
        const name = bot?.name ?? post.name
        const kind = post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
        appendRoom(room, { who: name, botId: post.botId, kind, text: '' })
        round.replies.push({ kind, botId: post.botId, name, color: bot?.color, time: Date.now() })
      }
      if (posts.some(post => post.resumed || post.stopped)) await rt.save()
      rt.roomProgress.set(exec.callId, round)
      try {
        await runRound(room, round, exec.signal, exec.agent)
      } catch (error) {
        rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
      } finally {
        rt.roomProgress.delete(exec.callId)
      }
      if (exec.signal?.aborted) {
        for (const turn of round.started) void rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId)
      }
      await rt.save()
      for (const post of posts) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, round)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  ctx.tools.register(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(botId)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        ensureRoomLog(room)
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        appendRoom(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        for (const round of rt.roomProgress.values()) {
          if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
        }
        void rt.save().catch(() => {})
      }
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      const lines = room.log.slice(-ROOM_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${transcript(lines)}`
    },
  }))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone. What a member posts
  // after its round moved on is answered by the member that asked for it; work the
  // user asked for is left for the user to read.
  function openingSpeakers(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    if (opener.kickoff) return admin ? [admin] : []
    if (opener.quiet) return []
    const { all, found: named } = mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.progress) return found
    if (opener.late) return found.length > 0 ? found : members.filter(bot => bot.id === opener.askedBy)
    if (found.length > 0 && !all) return found
    if (!all && room.mode === 'admin' && admin) return [admin]
    return admin ? [admin, ...members.filter(bot => bot !== admin)] : members
  }

  // A Bot's message into the group's own Session, which relays it as a new round.
  async function postToRoom(room, sender, text, extra = {}) {
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, hop: 0, ...extra },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.postToRoom = postToRoom

  // A member the round moved on from (it went on working, went quiet or waited for an
  // approval) posts what its turn ended with. The member that asked for it and anyone
  // it names answer; past the late round limit nobody does, so late posts cannot keep a
  // group talking.
  async function lateRoomReply(sessionId, info, reply) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, reply)
    if (isPass(text)) return
    const quiet = (room.lateRounds ?? 0) >= ROOM_LATE_ROUNDS
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await rt.save()
    await postToRoom(room, member, text, { late: true, hop: info.hop ?? 0, ...(info.askedBy ? { askedBy: info.askedBy } : {}), ...(quiet ? { quiet: true } : {}) })
      .catch(error => rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error))
  }
  rt.lateRoomReply = lateRoomReply

  // A step's text from a member's turn in its group Session. While the member holds its
  // place in a round, the text joins that round. Later, it joins whatever round runs in
  // the group, or posts on its own. Only the members it calls with @ answer it, and not
  // past the late round limit; the member that asked for the work answers the result.
  rt.roomStepText = async (sessionId, info, raw) => {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(raw)
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info?.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    ensureRoomLog(room)
    const calls = mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.some(bot => bot.id !== member.id)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) return postInRound(room, running, member, text)
    const quiet = !calls || (room.lateRounds ?? 0) >= ROOM_LATE_ROUNDS
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await rt.save()
    await postToRoom(room, member, text, { progress: true, hop: info?.hop ?? 0, ...(quiet ? { quiet: true } : {}) })
  }

  // The user stops a member's work in this group from the group's details. Messages
  // still waiting for that member here go with it.
  async function stopMemberWork(roomId, botId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = room?.sessions?.[botId]
    if (room === undefined || member === undefined || sessionId === undefined || rt.live.get(sessionId)?.turn === undefined) return false
    const agent = await rt.resolveAgent(sessionId)
    agent.cancel({ kind: 'user' })
    await postToRoom(room, member, '', { quiet: true, stopped: true })
    return true
  }
  rt.stopMemberWork = stopMemberWork

  // The round said such a member posts when done; a failed model call is how it ended.
  // Nobody answers it.
  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const { code, status, message } = failure
    await postToRoom(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
      late: true, quiet: true, failed: { code, ...(status ? { status } : {}), message },
    }).catch(error => rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error))
  }
  rt.lateRoomFailure = lateRoomFailure

  // A group the user just made opens with its admin asking what the group is for.
  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', hop: 0, roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  async function reportRound(room, post, round) {
    const lines = round.replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const waiting = round.replies.filter(reply => reply.kind === 'approval').map(reply => reply.name)
    const working = round.replies.filter(reply => reply.kind === 'working').map(reply => reply.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; read_group_chat shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.` : '',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    await rt.deliver({ toId: post.botId, role: 'report', roomId: room.id, text, hop: post.hop ?? 0 })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles, and DS Bot's own
  // calls for the room such as image readings, still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
      // Only for a group made under the PTC preset, which can call nothing but run_code;
      // new group Sessions get the standard preset.
      const [name, args] = declared.has('run_code') && !declared.has('group_relay')
        ? ['run_code', JSON.stringify({ description: 'Relay the group chat to its Bots', code: 'return await tools.group_relay({})', timeoutMs: 600_000 })]
        : ['group_relay', '{}']
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
