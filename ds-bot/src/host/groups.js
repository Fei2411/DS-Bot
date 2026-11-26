// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. "@Name" calls a member, and the members one message calls start
// at the same time: a call takes effect as soon as the message that makes it is
// posted, whether the user wrote it, a member said it while working, or a Bot posted
// it while the round runs. Each turn shows everything that arrived since that member
// last looked, and who else is answering. A plain message goes to the admin alone in
// admin mode; otherwise every member answers it in turn, admin first, each after the
// one before has posted or passed, so a discussion or a count-off stays in order. A
// member answers one call at a time. The user's own messages are always answered.
// Bots may call each other for as long as the work needs; the user stops a group from
// its details.
//
// Work does not hold a round up: a member that is still busy with tools a little after
// it started, or that is called while still at earlier work, lets the round go on. Its
// turn keeps running in its group Session, and what it ends with is posted to the group,
// where the member that asked for it answers.
import { randomUUID } from 'node:crypto'
import { claimsFor } from './claims.js'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GROUP_LINE_READ, HISTORY_PAGE, HISTORY_TIMEOUT_MS, INSTANT_WORK_TOOLS, ROOM_IDLE_RELAY_LIMIT, ROOM_REPLY_TIMEOUT_MS, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS, ROOM_ZERO_WORK_RELAY_LIMIT, SOURCE_KIND, TEXT_KEPT, isWorkTool } from './constants.js'
import { escapeRegExp, excerpt, headOf, reminderPrompts, splitRef, textOf } from './text.js'
import { viaIsIm, viaOf } from '../shared/im-platforms.js'
import { REPLY_ELISION, parseReplies, presentedFiles, relayRange } from '../shared/group-replies.js'
import { mentionSpans, speakerOf } from '../shared/mentions.js'
import { GROUP_REF, output } from './tools.js'
import { searchGroupBook } from './group-search.js'
import { createRoomReports } from './room-reports.js'
import { failureLine } from './turns.js'
import { parseBook } from './ledger.js'
import { addressedMembers, roomNote, roomRequest, roomResult } from './room-message.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8

// Short ack/thanks/closing phrases with no new content, used by the 0-tool idle loop guard.
const IDLE_ACK_WORDS = "收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|收工|完|结束|静默|不用再回|不用回|不用等|好嘞|行|ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack|done|all\\s+done|all\\s+good|sounds\\s+good|wrapping\\s+up|no\\s+reply\\s+needed"
// A status post: a member saying it has nothing to do right now. It carries no new
// content and calls nobody, and a group that keeps answering itself with these spins
// until the user writes (#853). The words are the ones members actually post.
// A noun needs its "nothing there" prefix: "任务", "变化" or "安排" alone is ordinary
// talk about work, and matching it would stop a group that is working.
const IDLE_STATUS_WORDS = [
  '(?:收口)?(?:我已收工|已收工|全部收工了?)',
  '(?:收口)?(?:当前|目前|今日|今天)*(?:暂无|没有|没|无)+(?:待办|任务|新进展|新内容|进展|动作|变化|安排)',
  '收工待命', '待命', '保持待命', '继续待命', '原地待命', '静候', '静候下一步', '静候指令', '等候指令',
  '等待指令', '等待指示', '等待下一步', '等待安排', '等待新任务', '无事可做', '空转',
  'standby', 'standing\\s+by', 'idle', 'nothing\\s+(?:pending|to\\s+do|new)',
  'no\\s+pending\\s+(?:tasks?|work)', 'no\\s+new\\s+(?:work|tasks?|progress|updates?)',
  'no\\s+changes?', 'no\\s+updates?', 'waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)',
].join('|')
// A line may mix them: "收到，待命" is a status post too.
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')
const IDLE_TEXT_MAX = 60
const normalizeRelayBody = (text, everyone) => {
  let out = String(text ?? '')
  for (const bot of everyone) {
    out = out.replace(new RegExp(`@${escapeRegExp(bot.name)}\\b`, 'gi'), '')
    out = out.replaceAll(`@${bot.name}`, '')
  }
  return out.replace(/@(?:all|everyone|所有人|全体)/gi, '').replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ').trim().toLowerCase()
}
export const isIdleRelayText = (text, everyone, priorBodies) => {
  const norm = normalizeRelayBody(text, everyone)
  if (norm === '' || (norm.length <= IDLE_TEXT_MAX && IDLE_BODY.test(norm))) return true
  return priorBodies.some(prev => prev !== '' && (prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))))
}

// Rows only the group chat draws: members read who is at work from the round itself.
const SHOWN_ONLY = new Set(['working', 'approval'])
const memberLine = record => record !== undefined && !SHOWN_ONLY.has(record.kind)

// A member's own lines are already in its Session, so only the others' are news.
// On a member's first look (`since === undefined`), keep the last ROOM_FIRST_LOOK
// lines from the log including any of the member's own prior lines on a fresh Session.
const unseenWindow = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) {
    return { all: room.log, lines: room.log.slice(-ROOM_FIRST_LOOK) }
  }
  const all = room.log.filter(line => line.seq > since && line.botId !== memberId)
  return { all, lines: all.slice(-ROOM_DELTA_MAX) }
}
const unseenLines = (room, memberId) => unseenWindow(room, memberId).lines

// A notice keeps its fields, not a finished sentence: the line members read is written
// when it is read, so old entries still say what happened when the wording or the
// constants move on.
const goalNotice = (line) => {
  switch (line.event) {
    case 'draft': return 'The user asked for a goal for this group; the admin is aligning it with them.'
    case 'start': return `Goal "${line.title}" started with ${line.count} stages; stage 1 "${line.next ?? ''}" is current.`
    case 'pass': return line.next !== undefined
      ? `Goal "${line.title}": stage ${line.stage} of ${line.count} passed; stage ${line.stage + 1} "${line.next}" is current.`
      : `Goal "${line.title}": stage ${line.stage} of ${line.count} passed; every stage passed.`
    case 'rework': return `Goal "${line.title}": stage ${line.stage} was sent back: ${line.text ?? ''}`
    case 'revise': return `Goal "${line.title}" was changed: ${line.text ?? ''}`
    case 'pause': return line.text ? `Goal "${line.title}" is paused (${line.text}). Start no new stage work.` : `Goal "${line.title}" is paused. Start no new stage work.`
    case 'resume': return `Goal "${line.title}" is resumed.`
    case 'complete': return `Goal "${line.title}" is complete.`
    case 'stop': return `Goal "${line.title}" was stopped: ${line.text ?? ''}`
    default: return line.text ?? ''
  }
}
const noticeText = (line) => {
  if (line.reason === 'missed') return `${(line.names ?? []).join(' and ')} did not answer within ${line.minutes} minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.`
  if (line.reason === 'paused' && line.idle && (line.names ?? []).length === 0) return `Paused: Bots here posted ${line.limit} status updates with no new work (no tool used, nobody called), the last from ${line.from ?? 'a member'}. The group answers no more of them until the user writes here; do not post again to start a round.`
  if (line.reason === 'paused' && line.idle && line.cause === 'cycle') return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} looped without running any work tool. The calls to @${(line.names ?? []).join(' and @')} wait until the user writes here; do not call them again.`
  if (line.reason === 'paused' && line.idle && line.cause === 'zero-work') return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} exchanged ${line.limit} consecutive messages without running any work tool. The calls to @${(line.names ?? []).join(' and @')} wait until the user writes here; do not call them again.`
  if (line.reason === 'paused' && line.idle) return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} went back and forth ${line.limit} times without progress (no tool used, only thanks or repeats). The calls to @${(line.names ?? []).join(' and @')} wait until the user writes here; do not call them again.`
  if (line.reason === 'paused') return `Paused: Bots have called each other ${line.limit} times since the user last wrote here. The calls to @${(line.names ?? []).join(' and @')} wait until the user continues or writes here; do not call them again.`
  if (line.reason === 'admin-passed') return `${(line.names ?? []).join(' and ') || 'The admin'} did not answer or call anyone; call a member with @Name.`
  if (line.reason === 'folder') return `The group's folder ${line.path} is gone, so its members work in the team workspace; set the group's folder again in the group's settings.`
  if (line.reason === 'goal') return goalNotice(line)
  if (line.reason === 'failed') return `${(line.names ?? []).join(' and ')} stopped: its model call failed (${line.detail}). What it was doing here is not finished; the user can switch its model in its settings or ask it to go on.`
  if (line.reason === 'helper-failed') return `${(line.names ?? []).join(' and ')}'s background helper did not finish: ${line.detail}. The work it was doing here is not finished; ask it to go on if it still matters.`
  return line.text ?? ''
}
const presentedLine = file => `[Presented file ${file.path}${file.description ? `: ${file.description}` : ''}]`

// `text` is what to show of a message line, by default what the log keeps of it.
export const lineText = (line, text = line.text) => {
  if (line.kind === 'lookup') return `[${speakerOf(line)} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${speakerOf(line)}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${speakerOf(line)}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${speakerOf(line)}'s work here]`
  if (line.kind === 'done') return `[${speakerOf(line)} finished the work it was asked for]`
  if (line.kind === 'notice') return `[${noticeText(line)}]`
  const body = [text, ...(line.presented ?? []).map(presentedLine)].filter(Boolean).join('\n')
  return `${speakerOf(line)}: ${body}`
}
const transcript = (lines, textOfLine = line => line.text) => lines.map(line => lineText(line, textOfLine(line))).join('\n')

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

// post_to_group resolves "@" on the whole message and stores it on the post. A post
// past MESSAGE_INLINE_MAX keeps only its first LONG_HEAD characters in `text`, so
// reading "@" there would miss anyone named further on. Undefined for a user's
// message, a late reply, or a step line, which were not sent that way.
// A saved list ignores opener.references. post_to_group posts carry none today; if
// they gain references, handle them together with this list.
function mentionsOf(opener, everyone) {
  if (opener.route && (opener.route.kind !== 'request' || !opener.mentions)) return { all: false, found: opener.route.kind === 'request' ? addressedMembers(opener.route, everyone, opener.botId) : [] }
  const saved = opener?.mentions
  if (saved === undefined || !Array.isArray(saved.ids)) return undefined
  const byId = new Map(everyone.map(bot => [bot.id, bot]))
  const found = []
  for (const id of saved.ids) {
    const bot = byId.get(id)
    if (bot !== undefined && !found.includes(bot)) found.push(bot)
  }
  return { all: saved.all === true, found }
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_REPLY_COMPACT = 'Reply for the group (no name prefix; [PASS] to stay silent).'
const ROOM_CALLS = 'Writing "@Name" calls that member at once, to answer or to do what you ask, as soon as your message is posted: call members before you start on your own part. Members called in one message start together and do not see each other\'s replies until they post, so when one needs another\'s result, call the first and ask it to call the next. When a member finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const slotLabel = (slot, self) => {
  if (slot.status === 'speaking') return slot === self ? `${slot.name} (you, now)` : `${slot.name} (answering now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'waiting-answer') return `${slot.name} (waiting for the user's answer; posts when answered)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
  'When the user wants this group to reach a goal, set it with group_goal: align with the user first (goal-grill skill), then start it.',
].filter(Boolean).join(' ')

// The opening turn of a group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

// DSH cannot open the Session at all: it is gone, or its stored log is corrupt. DSH
// reports a corrupt log only in the message of a generic failure.
const lostSession = error => error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`
const POST_HEADER = /^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/
const BACKFILL_WINDOW = 5

function legacyNoticeRecord(reply, time) {
  const botId = reply.botId
  if (reply.kind === 'goal') {
    const { who: _who, kind: _kind, seq: _seq, time: _time, about: _about, botId: _botId, name: _name, color: _color, ...fields } = reply
    return { who: 'DS Bot', kind: 'notice', reason: 'goal', ...fields, ...time }
  }
  if (reply.kind === 'paused') {
    return {
      who: 'DS Bot', kind: 'notice', reason: 'paused',
      ...(reply.idle !== undefined ? { idle: reply.idle } : {}),
      ...(reply.name ? { from: reply.name } : {}),
      ...(botId ? { about: botId } : {}),
      ...(reply.count !== undefined ? { count: reply.count } : {}),
      ...(reply.limit !== undefined ? { limit: reply.limit } : {}),
      ...(Array.isArray(reply.names) ? { names: reply.names } : {}),
      ...time,
    }
  }
  if (reply.kind === 'failed') {
    return {
      who: 'DS Bot', kind: 'notice', reason: 'failed',
      ...(reply.name ? { names: [reply.name] } : {}),
      ...(botId ? { about: botId } : {}),
      ...(reply.code !== undefined ? { code: reply.code } : {}),
      ...(reply.status !== undefined ? { status: reply.status } : {}),
      ...(reply.text !== undefined ? { message: reply.text, detail: reply.text } : {}),
      ...time,
    }
  }
  if (reply.kind === 'helper-failed') {
    return {
      who: 'DS Bot', kind: 'notice', reason: 'helper-failed',
      ...(reply.name ? { names: [reply.name] } : {}),
      ...(botId ? { about: botId } : {}),
      ...(reply.stopReason ? { stopReason: reply.stopReason } : {}),
      ...(reply.helper ? { helper: reply.helper } : {}),
      ...(reply.text !== undefined ? { detail: reply.text } : {}),
      ...time,
    }
  }
  if (reply.kind === 'missed' || reply.kind === 'admin-passed') {
    return {
      who: 'DS Bot', kind: 'notice', reason: reply.kind,
      ...(reply.name ? { names: [reply.name] } : {}),
      ...(botId ? { about: botId } : {}),
      ...(reply.kind === 'missed' ? { minutes: reply.minutes ?? Math.round(ROOM_REPLY_TIMEOUT_MS / 60000) } : {}),
      ...time,
    }
  }
  if (reply.kind === 'folder') {
    return {
      who: 'DS Bot', kind: 'notice', reason: 'folder',
      ...(reply.path ? { path: reply.path } : {}),
      ...(reply.text !== undefined ? { text: reply.text } : {}),
      ...time,
    }
  }
  return {
    who: 'DS Bot', kind: 'notice', reason: reply.kind,
    ...(reply.name ? { names: [reply.name] } : {}),
    ...(botId ? { about: botId } : {}),
    ...(reply.text !== undefined ? { text: reply.text } : {}),
    ...time,
  }
}

// Extracts group log lines in chronological order from the group's own Session events.
// Rounds from before the ledger carry their replies inline on the group_relay tool result;
// rounds after the ledger carry only { from, anchor } and are already in the ledger.
// A pruned tool result marks a `{ gap: true }` boundary around itself so lines before an
// unknown drop are never given shifted sequence numbers.
export function extractGroupSessionLines(events, botNameOf = () => undefined) {
  const lines = []
  const relayCalls = new Set()
  for (const event of events) {
    if (event?.type === 'user/message') {
      const source = event.data?.source
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
      const time = Number.isFinite(event.time) ? { time: event.time } : {}
      if (source?.kind === 'user') {
        const text = [textOf(content), ...files.map(fileLine)].filter(Boolean).join('\n')
        // The channel the post came in over survives the backfill exactly as a
        // live post keeps it: a backfilled IM or API line is no owner's line either.
        const via = viaOf(source)
        lines.push({ who: 'User', text, ...(files.length > 0 ? { files } : {}), ...(via === undefined ? {} : { via }), ...time })
      } else if (source?.kind === 'schedule') {
        const prompts = reminderPrompts(textOf(content))
        const text = prompts.length > 0 ? prompts.join('\n') : textOf(content)
        lines.push({ who: 'User', text, ...time })
      } else if (source?.kind === SOURCE_KIND && source.role === 'post') {
        if (source.logged !== undefined || source.failed !== undefined || source.resumed === true || source.stopped === true || source.done === true || source.resumedPause === true) continue
        const raw = textOf(content).replace(POST_HEADER, '')
        const text = [raw, ...files.map(fileLine)].filter(Boolean).join('\n')
        const presented = presentedFiles(source.presented)
        const botId = source.senderSessionId
        const who = source.senderName ?? botNameOf(botId) ?? 'Bot'
        lines.push({ who, ...(botId ? { botId } : {}), text, ...(files.length > 0 ? { files } : {}), ...(presented.length > 0 ? { presented } : {}), ...time })
      }
      continue
    }
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      if (name === 'group_relay' || (name === 'run_code' && String(event.data?.arguments ?? '').includes('group_relay'))) {
        if (event.data?.callId !== undefined) relayCalls.add(event.data.callId)
      }
      continue
    }
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId
    if (!relayCalls.has(callId)) continue
    relayCalls.delete(callId)
    const raw = textOf(event.data?.message?.content)
    if (relayRange(raw) !== undefined) continue
    const parsed = parseReplies(raw)
    if (parsed.broken) lines.push({ gap: true })
    for (const reply of parsed.replies) {
      if (!reply || typeof reply !== 'object' || reply.kind === 'working' || reply.kind === 'approval') continue
      const time = Number.isFinite(reply.time) ? { time: reply.time } : {}
      if (reply.kind === 'user') {
        lines.push({ who: 'User', text: reply.text ?? '', ...(reply.via ? { via: reply.via } : {}), ...time })
      } else if (reply.kind === undefined) {
        const botId = reply.botId
        const who = reply.name ?? botNameOf(botId) ?? 'Bot'
        const presented = presentedFiles(reply.presented)
        lines.push({ who, ...(botId ? { botId } : {}), text: reply.text ?? '', ...(presented.length > 0 ? { presented } : {}), ...time })
      } else if (reply.kind === 'lookup' || reply.kind === 'done' || reply.kind === 'stopped' || reply.kind === 'cut' || reply.kind === 'resumed') {
        const botId = reply.botId
        const who = reply.name ?? botNameOf(botId) ?? 'Bot'
        lines.push({ who, ...(botId ? { botId } : {}), kind: reply.kind, text: reply.text ?? '', ...time })
      } else {
        lines.push(legacyNoticeRecord(reply, time))
      }
    }
    if (parsed.broken) lines.push({ gap: true })
  }
  return lines
}

function sameSessionLine(a, b) {
  if (a?.gap === true || b?.gap === true) return false
  if ((a.kind ?? undefined) !== (b.kind ?? undefined)) return false
  if (a.kind !== undefined) {
    if (a.kind === 'notice' && a.reason !== b.reason) return false
    return a.botId === undefined || b.botId === undefined || a.botId === b.botId
  }
  const userA = a.botId === undefined && a.who === 'User'
  const userB = b.botId === undefined && b.who === 'User'
  if (userA !== userB) return false
  if (!userA && a.botId !== undefined && b.botId !== undefined && a.botId !== b.botId) return false
  if (!userA && (a.botId === undefined || b.botId === undefined) && a.who !== b.who) return false
  const textA = String(a.text ?? '')
  const textB = String(b.text ?? '')
  if (textA === textB) return true
  if (textA !== '' && textB !== '') return textA.startsWith(textB) || textB.startsWith(textA)
  return userA && textA === '' && b.images !== undefined
}

// Aligns extracted Session lines against the oldest kept records in the group's ledger,
// returning the contiguous lines immediately before `kept[0].seq` without crossing any
// discontinuity (`{ gap: true }`).
export function alignGroupSessionLines(sessionLines, kept) {
  if (sessionLines.length === 0) return []
  const sorted = [...kept].filter(record => Number.isInteger(record?.seq)).sort((a, b) => a.seq - b.seq)
  if (sorted.length === 0) {
    const end = sessionLines.findIndex(line => line.gap === true)
    const prefix = end === -1 ? sessionLines : sessionLines.slice(0, end)
    return prefix.map((line, index) => ({ ...line, seq: index + 1 }))
  }
  const oldestSeq = sorted[0].seq
  const anchors = [0]
  const firstMessage = sorted.findIndex(line => line.kind === undefined)
  if (firstMessage > 0) anchors.push(firstMessage)
  for (const anchor of anchors) {
    const win = Math.min(BACKFILL_WINDOW, sorted.length - anchor)
    if (win <= 0) continue
    const candidates = []
    for (let idx = 0; idx <= sessionLines.length - win; idx += 1) {
      let ok = true
      for (let offset = 0; offset < win; offset += 1) {
        if (!sameSessionLine(sessionLines[idx + offset], sorted[anchor + offset])) { ok = false; break }
      }
      if (ok) candidates.push(idx)
    }
    if (candidates.length === 0) continue
    const target = sorted[anchor]
    const best = candidates.reduce((pick, idx) => {
      const dist = Math.abs(idx - (target.seq - 1))
      const pickDist = Math.abs(pick - (target.seq - 1))
      if (dist !== pickDist) return dist < pickDist ? idx : pick
      const gap = Math.abs((sessionLines[idx].time ?? 0) - (target.time ?? 0))
      const pickGap = Math.abs((sessionLines[pick].time ?? 0) - (target.time ?? 0))
      return gap < pickGap ? idx : pick
    })
    const recovered = []
    for (let i = best - 1; i >= 0; i -= 1) {
      if (sessionLines[i]?.gap === true) break
      const seq = target.seq - (best - i)
      if (seq >= 1 && seq < oldestSeq) recovered.push({ ...sessionLines[i], seq })
    }
    return recovered.reverse()
  }
  return undefined
}

export function install(rt) {
  const { ctx } = rt

  // Everything said in a group is in the group's book of the ledger (ledger.js), whole,
  // before anything reads it. The room's own log in state.json keeps the latest lines,
  // each cut to its start, for the members' turns; a member reads a long line whole from
  // the book. The group chat draws its rows from the book too (groupRows).
  const bookOf = roomId => `group-${roomId}`
  const writes = () => rt.readOnly?.() === undefined

  // A group's book starts from what groups kept before the ledger: the room's log, the
  // whole text of its long lines (group-lines), and its own log of whole lines (group-logs).
  const oldLogName = id => (/^[\w-]{1,128}$/.test(id) ? id : createHash('sha256').update(String(id)).digest('hex').slice(0, 32))
  rt.ledger.importer('group-', (book) => {
    const roomId = book.slice('group-'.length)
    const lines = new Map()
    const keep = (line, text = line.text) => lines.set(line.seq, typeof text === 'string'
      ? { ...line, text, length: line.length ?? text.length }
      : line)
    for (const line of rt.roomOf(roomId)?.log ?? []) {
      if (!Number.isInteger(line?.seq)) continue
      let text = line.text
      if (line.length !== undefined) {
        try { text = readFileSync(join(rt.home, 'group-lines', roomId, `${line.seq}.txt`), 'utf8') } catch { /* only its start was kept */ }
      }
      keep(line, text)
    }
    try {
      for (const line of parseBook(readFileSync(join(rt.home, 'group-logs', `${oldLogName(roomId)}.jsonl`), 'utf8'))) {
        if (Number.isInteger(line.seq)) keep(line)
      }
    } catch { /* no log of its own yet */ }
    return [...lines.values()].sort((a, b) => a.seq - b.seq)
  })

  // Logs written before rooms were versioned get sequence numbers in place. A book that
  // holds a later record than the saved state (the state was not saved after it) moves
  // the room's count on, so no number is used twice. What was said before a room had a
  // place for the chat to start from was shown already.
  const reconciled = new WeakSet()
  const ensureRoomLog = (room) => {
    if (typeof room.seq !== 'number') {
      room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
      room.seq = room.log.length
    }
    room.seen ??= {}
    if (!reconciled.has(room)) {
      reconciled.add(room)
      const ahead = rt.ledger.after(bookOf(room.id), room.seq)
      if (ahead.length > 0) {
        room.seq = Math.max(room.seq, ...ahead.map(record => record.seq))
        room.log = [...room.log, ...ahead.filter(memberLine).map(record => cutLine(record))].slice(-ROOM_LOG_MAX)
      }
    }
  }

  // What a member reads of a line: all of it, up to GROUP_LINE_READ.
  const memberText = room => (line) => {
    const whole = line.length === undefined ? line.text : rt.ledger.record(bookOf(room.id), line.seq)?.text
    if (whole === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const shown = headOf(whole, GROUP_LINE_READ)
    return whole.length > shown.length ? `${shown}… (cut; ${whole.length} characters in all)` : shown
  }

  // The start of a line for the room's log; the book has it whole.
  const cutLine = (line, text = line.text ?? '') => {
    const kept = headOf(text, TEXT_KEPT)
    return kept.length === text.length ? line : { ...line, text: kept, length: text.length }
  }
  // A team from before the ledger cuts its long lines once its book has them whole.
  function keepGroupLine(roomId, line, text) {
    rt.ledger.open(bookOf(roomId))
    return cutLine(line, text)
  }

  function dropGroupLines(roomId) {
    clearPresented(roomId)
    backfilled.delete(roomId)
    laterPosts.delete(roomId)
    stoppedFinishing.delete(roomId)
    for (const [key, batch] of Object.entries(batches())) {
      if (batch.roomId !== roomId) continue
      wakingBatches.delete(key)
      delete batches()[key]
    }
    rt.ledger.drop(bookOf(roomId))
    if (!writes()) return
    void rm(join(rt.home, 'group-lines', roomId), { recursive: true, force: true }).catch(() => {})
    void rm(join(rt.home, 'group-logs', `${oldLogName(roomId)}.jsonl`), { force: true }).catch(() => {})
  }

  const backfilled = new Set()
  const backfilling = new Map()
  async function sessionEvents(sessionId, signal) {
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    const throughSeq = agent?.session?.seq !== undefined ? Number(agent.session.seq) - 1 : undefined
    if (throughSeq !== undefined && throughSeq < 0) return []
    const pages = []
    let beforeSeq
    for (;;) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId },
        ...(throughSeq === undefined ? {} : { throughSeq }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: HISTORY_PAGE,
      }, signal)
      const events = (page.records ?? []).map(record => record.event).filter(Boolean)
      if (events.length > 0) pages.push(events)
      if (!page.hasMore || events.length === 0) break
      beforeSeq = events[0].seq
    }
    return pages.reverse().flat()
  }

  // Fills missing pre-ledger lines from the group's own Session when a cursor or lookup
  // asks for lines older than the group's kept log.
  async function backfillGroupLog(roomId, since) {
    if (since === undefined || backfilled.has(roomId)) return
    const pending = backfilling.get(roomId)
    if (pending !== undefined) return pending
    const run = (async () => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return
      ensureRoomLog(room)
      const book = bookOf(roomId)
      const records = rt.ledger.records(book)
      let oldestSeq
      for (const record of records) {
        if (Number.isInteger(record.seq) && (oldestSeq === undefined || record.seq < oldestSeq)) oldestSeq = record.seq
      }
      if (oldestSeq !== undefined && oldestSeq <= since + 1) return
      if (oldestSeq === undefined && room.seq <= since) return
      if (typeof ctx.sessionController?.page !== 'function') return
      const partIds = [...(room.parts ?? []).map(segment => segment.sessionId), rt.sessionOfRoom(room)].filter(Boolean)
      const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
      const botNameOf = botId => rt.botOf(botId)?.name
      const partLines = []
      let lostError
      for (let i = partIds.length - 1; i >= 0; i -= 1) {
        try {
          partLines.unshift(extractGroupSessionLines(await sessionEvents(partIds[i], signal), botNameOf))
        } catch (error) {
          if (lostSession(error)) {
            lostError ??= error
            partLines.unshift([{ gap: true }])
            continue
          }
          rt.warn('ds-bot: the Session of group "%s" could not be read: %s', room.name, error?.message ?? error)
          return
        }
      }
      const sessionLines = partLines.flat()
      const kept = records.filter(record => Number.isInteger(record.seq))
      const recovered = alignGroupSessionLines(sessionLines, kept)
      if (recovered !== undefined && recovered.length > 0) rt.ledger.prepend(book, recovered)
      let earliestSeq = oldestSeq
      for (const record of rt.ledger.records(book)) {
        if (Number.isInteger(record.seq) && (earliestSeq === undefined || record.seq < earliestSeq)) earliestSeq = record.seq
      }
      const missing = (earliestSeq ?? (room.seq + 1)) - since - 1
      if (missing > 0) {
        if (lostError !== undefined) {
          rt.warn('ds-bot: %d lines of group "%s" left its log before they were reviewed and could not be recovered from its Session: %s', missing, room.name, lostError.message ?? lostError)
        } else {
          rt.warn('ds-bot: %d lines of group "%s" left its log before they were reviewed and were not in its Session', missing, room.name)
        }
      }
      backfilled.add(roomId)
    })().finally(() => {
      if (backfilling.get(roomId) === run) backfilling.delete(roomId)
    })
    backfilling.set(roomId, run)
    return run
  }

  const roomLineListeners = new Set()
  // The one way anything is said in a group: into its book, then into the room's log for
  // the members' turns. `session` marks a message the group's own Session shows already.
  const say = (room, line) => {
    ensureRoomLog(room)
    room.seq += 1
    const record = { ...line, seq: room.seq, time: line.time ?? Date.now() }
    rt.ledger.append(bookOf(room.id), record)
    // The phone link hears every line the chat will draw (mobile.js).
    rt.roomLineAdded?.(room, record)
    if (!memberLine(record)) return record
    room.log = [...room.log, cutLine(record)].slice(-ROOM_LOG_MAX)
    for (const listener of roomLineListeners) {
      try { listener(room, record) } catch (error) { rt.warn('ds-bot: room line listener failed: %s', error) }
    }
    return record
  }

  // What the group chat draws of a record, in the shape of a reply of the round.
  function rowOf(record) {
    // A notice names the member it is about, not as its speaker: members skip their own lines.
    const botId = record.botId ?? record.about
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    const who = { botId, name: bot?.name ?? (record.kind === 'notice' ? record.names?.[0] : record.who), color: bot?.color }
    const time = record.time
    if (record.kind === undefined) {
      if (record.botId === undefined) return { kind: 'user', text: record.text, time, ...(record.via ? { via: record.via } : {}) }
      return {
        ...who, text: record.text, time,
        ...(record.duration === undefined ? {} : { duration: record.duration }),
        ...(record.claims === undefined ? {} : { claims: record.claims }),
        ...(record.changes === undefined ? {} : { changes: record.changes }),
        ...(record.presented?.length ? { presented: record.presented } : {}),
      }
    }
    if (record.kind === 'lookup') return { kind: 'lookup', ...who, text: record.text, time }
    if (record.kind !== 'notice') return { kind: record.kind, ...who, time, ...(record.changes === undefined ? {} : { changes: record.changes }) }
    switch (record.reason) {
      case 'failed': return { kind: 'failed', ...who, code: record.code, ...(record.status ? { status: record.status } : {}), text: record.message ?? record.detail, time }
      case 'helper-failed': return { kind: 'helper-failed', ...who, ...(record.stopReason ? { stopReason: record.stopReason } : {}), ...(record.helper ? { helper: record.helper } : {}), text: record.detail, time }
      case 'missed': return { kind: 'missed', ...who, time }
      case 'admin-passed': return { kind: 'admin-passed', ...who, time }
      case 'paused': return { kind: 'paused', idle: record.idle, ...(record.cause !== undefined ? { cause: record.cause } : {}), ...who, name: bot?.name ?? record.from, count: record.count ?? record.limit, limit: record.limit, names: record.names, time }
      case 'folder': return { kind: 'folder', text: noticeText(record), time }
      case 'goal': {
        const { who: _who, kind: _kind, reason: _reason, seq: _seq, time: _time, about: _about, ...fields } = record
        return { kind: 'goal', ...fields, time }
      }
      default: return undefined
    }
  }
  // Each group_relay call is an anchor in the group's book: the chat shows the rows from
  // it up to the next anchor, so what comes after the user's next message shows under it.
  // `to` undefined: up to the next anchor, or to the end while there is none (`open`).
  // `anchor` names the call, so the next call in the book ends its rows even when it starts
  // at the same seq.
  const rowsView = (roomId, from, to, anchor) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined) ensureRoomLog(room)
    let end = to
    if (end === undefined) {
      const nextFrom = rt.ledger.nextAnchor(bookOf(roomId), from, anchor)
      if (nextFrom !== undefined) end = nextFrom - 1
    }
    // Not the messages the group's own Session shows itself.
    const rows = rt.ledger.range(bookOf(roomId), from, end).filter(record => record.session !== true).map(rowOf).filter(Boolean)
    return { rows, open: end === undefined }
  }
  const groupRows = (roomId, from, to, anchor) => rowsView(roomId, from, to, anchor).rows
  const jsonText = text => JSON.stringify(text).slice(1, -1)
  const isLegacyReply = record => record.kind === undefined && record.session !== true
    && typeof record.botId === 'string' && typeof record.text === 'string'
  function hasCompleteText(record) {
    const length = record.text.length
    if (record.length !== undefined) return length === record.length
    // Old imports dropped the original length. Either cap can land one unit early at a surrogate pair.
    return length !== TEXT_KEPT && length !== TEXT_KEPT - 1
      && length !== GROUP_LINE_READ && length !== GROUP_LINE_READ - 1
  }
  const isKeptReply = record => isLegacyReply(record) && hasCompleteText(record)
  const matchesOpening = (record, opening, partial) => (partial ? record.text.startsWith(opening) : record.text === opening)
    || (!hasCompleteText(record) && opening.startsWith(record.text))

  function restoreTrimmedReplies(replies, records) {
    const restored = []
    for (const reply of replies) {
      if (!reply || typeof reply !== 'object' || reply.__omitted__) return null
      const marker = typeof reply.text === 'string' ? REPLY_ELISION.exec(reply.text) : null
      if (marker === null) { restored.push(reply); continue }
      const head = reply.text.slice(0, marker.index)
      const tail = reply.text.slice(marker.index + marker[0].length)
      const omitted = Number(marker[1])
      // save-token's JSON codec keeps 220 and 80 UTF-16 units of an individual string longer than 400.
      if (reply.kind !== undefined || head.length !== 220 || tail.length !== 80 || omitted <= 100 || REPLY_ELISION.test(tail)) return null
      const length = head.length + omitted + tail.length
      const matches = records.filter(record => {
        if (!isLegacyReply(record) || record.botId !== reply.botId || !matchesOpening(record, head, true)) return false
        if (!hasCompleteText(record)) return record.length === undefined || record.length === length
        return record.text.length === length && record.text.endsWith(tail)
      })
      if (matches.length !== 1 || !hasCompleteText(matches[0])) return null
      restored.push({ ...reply, text: matches[0].text })
    }
    return restored
  }

  function restoreRelayWindow(preview, records, marker) {
    const suffix = preview.slice(marker.index + marker[0].length)
    if (REPLY_ELISION.test(suffix)) return null
    const head = preview.slice(0, marker.index)
    const before = parseReplies(head).replies
    const tailFragment = /^((?:[^"\\]|\\.)*)"/.exec(suffix)
    if (tailFragment === null) return null
    let after
    try { after = JSON.parse(`{"replies":[{"text":"${suffix}`).replies } catch { return null }
    if (!Array.isArray(after) || after.some(reply => !reply || typeof reply !== 'object' || reply.__omitted__)) return null
    const tail = after[0]?.text
    if (typeof tail !== 'string' || tail.length < 16 || after[0].kind !== undefined) return null

    // A line window can start its cut inside a reply's text or after a complete reply.
    let partial
    const headFragment = /"text"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(head)
    if (headFragment !== null) {
      try { partial = JSON.parse(`${head}"}]}`).replies.at(-1) } catch { return null }
    }
    const first = partial ?? before.findLast(reply => reply?.kind === undefined && typeof reply?.botId === 'string' && typeof reply.text === 'string')
    if (typeof first?.text !== 'string' || first.text.length < 16 || first.kind !== undefined) return null
    // A surviving suffix does not prove which prompt owns a cut if an earlier matching start lost its ending.
    const starts = records.filter(record => isLegacyReply(record) && record.botId === first.botId
      && matchesOpening(record, first.text, partial !== undefined))
    // A cut can start in an escape, so decoding the suffix can give it a different meaning.
    const ends = records.filter(record => isKeptReply(record) && jsonText(record.text).endsWith(tailFragment[1])
      && (after[0].botId === undefined || record.botId === after[0].botId))
    if (starts.length !== 1 || ends.length !== 1 || ends[0].seq < starts[0].seq) return null
    // Don't guess across a missing ledger row, a new prompt, or any other boundary.
    const span = records.slice(records.indexOf(starts[0]), records.indexOf(ends[0]) + 1)
    if (!span.every((record, i) => isKeptReply(record) && record.seq === starts[0].seq + i)) return null
    // Count the saved JSON units: re-encoding half a surrogate pair would add an escape.
    const hiddenText = span.reduce((length, record) => length + jsonText(record.text).length, 0)
      - (headFragment?.[1].length ?? jsonText(first.text).length) - tailFragment[1].length
    const omitted = Number(marker[1])
    if (span.length === 1) {
      // A cut inside one string hides no JSON structure, so the encoded length must match exactly.
      if (partial === undefined || first.text.length + tail.length >= span[0].text.length || hiddenText !== omitted) return null
    } else if (hiddenText >= omitted) return null
    const missing = partial === undefined ? span.slice(1) : span
    return [...before, ...missing.map(rowOf), ...after.slice(1)]
  }

  // Use only DS Bot's own pre-ledger records, never a file locator embedded in a result.
  function groupRelayReplies(sessionId, preview) {
    if (typeof sessionId !== 'string' || typeof preview !== 'string' || preview.length > 65_536) return null
    const marker = REPLY_ELISION.exec(preview)
    if (marker === null) return null
    const room = rt.roomOf(sessionId) ?? rt.roomOf(rt.pastOwners.get(sessionId)?.roomId)
    if (room === undefined) return null
    // A room from before logs were versioned has no `seq` yet: open its book through the
    // migration first, or the importer would cache an empty book for this process.
    ensureRoomLog(room)
    const book = rt.ledger.records(bookOf(room.id))
    const anchor = book.findIndex(record => record.event === 'anchor')
    const records = anchor === -1 ? book : book.slice(0, anchor)
    // A unique match proves nothing when the original could have aged out of the legacy log.
    if (records.some((record, i) => record.seq !== i + 1)
      || (anchor === -1 ? records.length !== room.seq : book[anchor].from > records.length + 1)) return null
    // The line codec keeps 260 and 100 raw units, even if the splice still parses as JSON.
    if (marker.index === 260 && preview.length - marker.index - marker[0].length === 100) {
      return restoreRelayWindow(preview, records, marker)
    }
    let replies
    try { replies = JSON.parse(preview)?.replies } catch { /* a cut can break JSON syntax */ }
    if (Array.isArray(replies) && replies.some(reply => typeof reply?.text === 'string' && REPLY_ELISION.test(reply.text))) {
      const restored = restoreTrimmedReplies(replies, records)
      if (restored !== null) return restored
    }
    return restoreRelayWindow(preview, records, marker)
  }
  // A sequence of words over everything said in the group, newest first, with each
  // hit's neighbours. `page` (`before` or `offset`) reads the next older page.
  const groupSearch = (roomId, query, page) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined) ensureRoomLog(room)
    return searchGroupBook(rt.ledger.records(bookOf(roomId)), query, page)
  }

  Object.assign(rt, {
    keepGroupLine, dropGroupLines, groupRows, groupRowsView: rowsView, groupRelayReplies, groupSearch,
    logRoom: (room, line) => say(room, line),
    onRoomLine: (listener) => {
      roomLineListeners.add(listener)
      return () => roomLineListeners.delete(listener)
    },
    // The group's own log, for the memory review and read_group_chat: every line, whole.
    backfillGroupLog,
    groupLinesAfter: async (roomId, since) => rt.ledger.after(bookOf(roomId), since).filter(memberLine),
    groupLine: async (roomId, seq) => {
      const record = rt.ledger.record(bookOf(roomId), seq)
      return memberLine(record) ? record : undefined
    },
    searchGroupLog: async (roomId, query) => rt.ledger.search(bookOf(roomId), query, { filter: memberLine }),
  })

  // The folder a group was set to work in is gone: its members' Sessions move on in
  // the team workspace (parts.js), and the group is told once per folder, so a later
  // round does not say it again. Changing the folder clears the mark (updateRoom).
  // A failed turn stays in the log, so the admin and the other members read on their
  // next turn that the work stopped there and why (#974); the round's row is gone once
  // the round is.
  const noteFailure = (room, member, failure) => {
    const { code, status, message } = failure
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'failed', names: [member.name], about: member.id, detail: failureLine(failure), code, ...(status ? { status } : {}), message })
  }

  // A failed background helper appends a structured notice directly to the group's
  // ledger; the latest open group_relay anchor and room-chat read it on the revision
  // bump without synthesizing an empty turn or marking the member's own turn failed.
  const noteHelperFailure = async (sessionId, { stopReason, helper, closing } = {}) => {
    if (rt.readOnly() !== undefined) return
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const reason = typeof stopReason === 'string' && stopReason !== '' ? stopReason.slice(0, 40) : 'error'
    const cleanHelper = typeof helper === 'string' && helper.trim() !== '' ? helper.trim().slice(0, 120) : undefined
    const cleanClosing = typeof closing === 'string' && closing.trim() !== '' ? closing.replace(/\s+/g, ' ').trim().slice(0, 240) : undefined
    const summary = `subagent ended (${reason})${cleanClosing ? `: ${cleanClosing}` : ''}`
    const detail = cleanHelper ? `${cleanHelper} — ${summary}` : summary
    say(room, {
      who: 'DS Bot',
      kind: 'notice',
      reason: 'helper-failed',
      names: [member.name],
      about: member.id,
      stopReason: reason,
      ...(cleanHelper ? { helper: cleanHelper } : {}),
      detail,
    })
    await rt.save()
  }
  rt.subagentFailureNotice = noteHelperFailure

  async function roomFolderNotice(roomId, folder) {
    const room = rt.roomOf(roomId)
    if (room === undefined || folder === undefined || room.workDir !== folder || room.folderNotice === folder) return
    room.folderNotice = folder
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'folder', path: folder })
    await rt.save()
  }
  rt.roomFolderNotice = roomFolderNotice

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
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }), bot: member })
    // While the Session was made the member may have left or been deleted, the group been
    // deleted, or another turn made the member's Session first: the new one is not kept.
    // Undefined means the member is gone from the group.
    const gone = rt.roomOf(room.id) !== room || !room.members.includes(member.id) || rt.botOf(member.id) === undefined
    if (gone || room.sessions?.[member.id] !== undefined) {
      void ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused group Session of %s in %s not archived: %s', member.name, room.name, error))
      return gone ? undefined : groupSessionFor(room, member)
    }
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      const effort = await rt.desiredEffort(member, ref)
      await rt.selectSessionModel(id, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.applyPermission(member, id, room)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    // The Session was resolved before the group owned it, so its scoped tools land now.
    await rt.resolveAgent(id)
      .catch(error => rt.warn('ds-bot: scoped tools for %s in %s not applied: %s', member.name, room.name, error))
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  // `files` are the files of the lines shown, which go to the member with the prompt.
  // `finished` is what a batch woke the member for (finishedLines): its result lines, the
  // ones the prompt does not show anyway coming after the earlier lines, and the members
  // that finished without a closing message.
  function roomPrompt(room, member, round, slot, finished = { results: [], quiet: [] }, sessionId) {
    const { results, quiet } = finished
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const { all: allUnseen, lines } = unseenWindow(room, member.id)
    const droppedByDelta = Math.max(0, allUnseen.length - lines.length)
    const earlierAll = lines.filter(line => line.seq < round.startSeq)
    const earlier = earlierAll.slice(-ROOM_EARLIER_MAX)
    const droppedByEarlier = Math.max(0, earlierAll.length - earlier.length)
    const omittedCount = droppedByDelta + droppedByEarlier
    const current = lines.filter(line => line.seq >= round.startSeq)
    const owed = results.filter(result => ![...earlier, ...current].some(line => line.seq === result.seq))
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const overrideInstructions = slot.resultOnly
      ? `These are results of a finished request. Your reply is for the group; names in it do not call anyone. For a distinct next task use delegate_work with follow_up_to "${slot.resultRef}".`
      : batchOfSlot(room.id, slot)?.direct
        ? 'This is a delegated request. Your final answer goes back to its caller. Names in your progress or answer do not call other members; use delegate_work to assign a separate task.'
        : undefined
    const instructions = overrideInstructions ?? ROOM_CALLS
    const membersList = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}.`
    const members = `${membersList} ${instructions}`
    const noticeText = room.notice ?? ''
    const notice = noticeText ? `Group notice (shared instructions for every member):\n${noticeText}` : ''
    const adminText = leads ? adminNote(room) : ''
    if (round.kickoff) return { text: [members, notice, adminText, roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n'), images: [], files: [], meta: undefined }

    // Group rules, members list, notice, and admin role are delivered in full once
    // per context epoch (opening turn and after any compaction). Subsequent turns in
    // the same epoch send only a delta when group metadata changes plus a compact footer.
    const epoch = sessionId !== undefined ? (rt.contextRuntime?.epochOf?.(sessionId) ?? 0) : 0
    const prevMeta = sessionId !== undefined ? rt.contextRuntime?.groupMetaOf?.(sessionId) : undefined
    const metaPayload = { membersList, notice: noticeText, adminText }
    const metaHash = createHash('sha256').update(JSON.stringify(metaPayload)).digest('hex').slice(0, 16)
    const hasSnapshot = prevMeta !== undefined && prevMeta.epoch === epoch && prevMeta.full === true
    const hasCallRules = prevMeta?.hasCallRules === true
    const needsCallRules = overrideInstructions === undefined && !hasCallRules
    let headerBlocks
    let footer
    let nextMeta
    if (!hasSnapshot) {
      headerBlocks = [members, notice, adminText]
      footer = ROOM_REPLY
      nextMeta = sessionId !== undefined
        ? { hash: metaHash, epoch, full: true, hasCallRules: overrideInstructions === undefined, ...metaPayload }
        : undefined
    } else if (prevMeta.hash === metaHash) {
      headerBlocks = [overrideInstructions ?? (needsCallRules ? ROOM_CALLS : '')]
      footer = ROOM_REPLY_COMPACT
      nextMeta = needsCallRules
        ? { hash: metaHash, epoch, full: true, hasCallRules: true, ...metaPayload }
        : undefined
    } else {
      const deltas = []
      if (prevMeta.membersList !== membersList) deltas.push(`Updated group members: ${membersList}`)
      if (prevMeta.notice !== noticeText) {
        deltas.push(noticeText ? `Updated group notice (shared instructions for every member):\n${noticeText}` : 'Group notice was cleared.')
      }
      if (prevMeta.adminText !== adminText) {
        deltas.push(adminText ? `Updated group role: ${adminText}` : 'You are no longer this group\'s admin.')
      }
      if (overrideInstructions !== undefined) deltas.push(overrideInstructions)
      else if (needsCallRules) deltas.push(ROOM_CALLS)
      headerBlocks = deltas
      footer = ROOM_REPLY_COMPACT
      nextMeta = { hash: metaHash, epoch, full: true, hasCallRules: hasCallRules || overrideInstructions === undefined, ...metaPayload }
    }

    const goal = rt.goalBlock?.(room, member, { nudge: round.goalNudge === true, resume: round.goalResume === true }) ?? ''
    // Members answering in this round are named with the round below.
    const answering = new Set(round.slots.filter(other => other.status === 'speaking').map(other => other.id))
    const working = workingIn(room).filter(item => item.bot.id !== member.id && !answering.has(item.bot.id))
      .map(item => ({ ...item, unread: unreadCount(room, item.bot.id) }))
    const omittedNotice = omittedCount > 0
      ? `(${omittedCount} earlier unread group message${omittedCount === 1 ? '' : 's'} not shown here; use read_group_chat to read them.)`
      : ''
    const text = [
      ...headerBlocks,
      goal,
      earlier.length
        ? `Earlier in the group, before this round (context only):\n${omittedNotice ? `${omittedNotice}\n` : ''}${transcript(earlier, memberText(room))}`
        : omittedNotice,
      owed.length ? `Results of the work you asked for that the lines here leave out (oldest first):\n${owed.map(result => (result.line
        ? transcript([result.line], memberText(room))
        : `[${result.name}'s result, message #${result.seq}, is not available here; read_group_chat with seq ${result.seq} reads it]`)).join('\n')}` : '',
      quiet.length ? `Finished without a closing message: ${quiet.join(' and ')}. What they said while they worked is their result; read_group_chat reads it.` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current, memberText(room))}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min${item.unread > 0 ? `, with ${item.unread} group message(s) it has not read yet` : ''})`).join(', ')}.` : '',
      ...placeLines(round, slot),
      footer,
    ].filter(Boolean).join('\n\n')
    const shown = [...earlier, ...owed.flatMap(result => result.line ?? []), ...current]
    return { text, images: shown.flatMap(line => line.images ?? []), files: shown.flatMap(line => line.files ?? []), meta: nextMeta }
  }

  // The result lines a wake carries, oldest first, one per seq. A line that left the room's
  // log is read from the group's own log.
  async function finishedLines(room, slot) {
    if (slot.finished === undefined) return { results: [], quiet: [] }
    const results = [...new Map(slot.finished.results.map(result => [result.seq, result])).values()].sort((a, b) => a.seq - b.seq)
    const inLog = new Map(room.log.map(line => [line.seq, line]))
    return {
      results: await Promise.all(results.map(async ({ name, seq }) => ({ name, seq, line: inLog.get(seq) ?? await rt.groupLine(room.id, seq).catch(() => undefined) }))),
      quiet: [...new Set(slot.finished.names)].filter(name => !results.some(result => result.name === name)),
    }
  }

  // Where a turn stands in its round: its place in the order when members take turns,
  // or who was called with it and answers at the same time; then the others' latest
  // calls in this round.
  function placeLines(round, slot) {
    const lines = []
    if (slot.ordered) {
      const order = round.slots.filter(other => other.ordered)
      const index = order.indexOf(slot)
      const after = order.length - index - 1
      lines.push(`Members answer this message one at a time: ${order.map(other => slotLabel(other, slot)).join(' → ')}.`,
        `You are number ${index + 1} of ${order.length}. ${index === 0 ? 'Nobody spoke before you' : `${index} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`)
    } else {
      const together = round.slots.filter(other => other !== slot && other.batch === slot.batch && other.id !== slot.id)
      if (together.length > 0) lines.push(`Called together with you: ${together.map(other => other.name).join(', ')}. You answer at the same time and do not see each other's replies until they post.`)
    }
    const latest = new Map()
    for (const other of round.slots) if (other.id !== slot.id && !(slot.ordered && other.ordered)) latest.set(other.id, other)
    if (latest.size > 0) lines.push(`Also in this round: ${[...latest.values()].map(other => slotLabel(other, slot)).join(', ')}.`)
    return lines
  }

  // Members whose turn, DSH subagent, or background task in this group is running, and since when.
  const workingIn = room => room.members.flatMap((id) => {
    const sessionId = room.sessions?.[id]
    const entry = rt.live.get(sessionId)
    const bot = rt.botOf(id)
    if (bot === undefined) return []
    if (entry?.turn !== undefined) return [{ bot, since: entry.since ?? Date.now() }]
    if ((sessionId !== undefined && rt.hasSubagents?.(sessionId)) || rt.hasRoomTasks?.(room.id, id) === true) {
      const workSince = rt.roomWorkView?.()?.[room.id]?.find(item => item.botId === id)?.since
      return [{ bot, since: workSince ?? Date.now() }]
    }
    return []
  })
  // How many group lines a member has not been shown yet, counted the same way a
  // round counts the lines it carries over (unseenLines), so the number a speaker
  // reads is the number the member would get. A turn the reply timeout cut short
  // may leave them unread, and the member is never called again: the next speaker
  // is told, so it knows the hand-off it waits on sits behind unread lines.
  const unreadCount = (room, botId) => unseenLines(room, botId).length
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // Bot-to-Bot call batches in groups: when Bot `by` calls one or more members together
  // (`@B @C`), the batch tracks which callees are still working so:
  // 1) a callee that finishes tool work within the round (< 15s) without writing `@by`
  //    still hands the result back to `by` (#619), and
  // 2) when multiple callees work in parallel, `by` is woken once when the last callee
  //    in the batch finishes rather than woken piecemeal on every early reply.
  // A batch belongs to a call, not to the member: a member two Bots called is in both
  // batches, and each finished piece of work settles the batch of the Bot that asked.
  // Calling the same member again settles into the newest batch of that Bot, so a member
  // waits in at most one batch per Bot that called it. Batches are saved with the team
  // (`state.roomBatches`), so who still owes whom survives a restart.
  const batches = () => (rt.state.roomBatches ??= {})
  const saveSoon = () => void rt.save().catch(() => {})
  const batchOf = (roomId, botId, by, { matchParent = false, parentBatchKey } = {}) => Object.values(batches()).find(batch =>
    batch.roomId === roomId
    && batch.by === by
    && batch.pending.includes(botId)
    && (!matchParent || batch.parentBatchKey === parentBatchKey))
  rt.pendingGroupAssignment = (roomId, botId, by) => batchOf(roomId, botId, by)
  rt.pendingGroupAssignments = (roomId, botId, by) => Object.values(batches()).filter(batch =>
    batch.roomId === roomId
    && batch.by === by
    && batch.pending.includes(botId))
  rt.resolveGroupBatch = (roomId, botId, key) => resolveBatchKey(roomId, botId, key)
  rt.recordGroupNote = async (room, sender, target, long) => {
    say(room, {
      who: sender.name,
      botId: sender.id,
      text: long.text,
      route: { ...roomNote(), to: [target.id] },
      ...(long.files?.length ? { files: long.files } : {}),
    })
    await rt.ledger.written(bookOf(room.id))
    await rt.save({ required: true })
  }
  // Oldest first.
  const batchesOf = (roomId, botId) => Object.values(batches()).filter(batch => batch.roomId === roomId && batch.pending.includes(botId))
  const unpend = (batch, botId) => { batch.pending = batch.pending.filter(id => id !== botId) }
  // Resolves a turn/slot's `batchKey` to its live batch or its persisted same-parent
  // successor (`batch.replaces[botId]`), never falling back to another parent's batch.
  const resolveBatchKey = (roomId, botId, key) => {
    if (typeof key !== 'string' || key === '') return undefined
    const exact = batches()[key]
    if (exact !== undefined && exact.roomId === roomId && exact.pending.includes(botId)) return exact
    return Object.values(batches()).find(batch =>
      batch.roomId === roomId
      && batch.pending.includes(botId)
      && Array.isArray(batch.replaces?.[botId])
      && batch.replaces[botId].includes(key))
  }

  // Room deliveries whose 4-minute reply timer expired without the member starting a turn:
  // ignore their stale unreadOf entry in activeInRoom so batches and roomReports never
  // deadlock on a delivery that never took off (if it later starts, live.turn tracks it).
  const missedExchanges = new Set()
  const rememberMissedExchange = (exchangeId) => {
    if (typeof exchangeId !== 'string' || exchangeId === '') return
    missedExchanges.add(exchangeId)
    if (missedExchanges.size > 200) missedExchanges.delete(missedExchanges.values().next().value)
  }
  // Members explicitly delegated via `delegate_work` during a group turn, keyed by
  // turn exchangeId so the set survives >15s grace expiry, approvals, and part switches
  // until the member's model turn settles.
  const explicitCallsByExchange = new Map()
  const rememberExplicitCall = (exchangeId, targetId) => {
    if (typeof exchangeId !== 'string' || exchangeId === '' || typeof targetId !== 'string' || targetId === '') return
    let set = explicitCallsByExchange.get(exchangeId)
    if (set === undefined) {
      set = new Set()
      explicitCallsByExchange.set(exchangeId, set)
      if (explicitCallsByExchange.size > 200) explicitCallsByExchange.delete(explicitCallsByExchange.keys().next().value)
    }
    set.add(targetId)
  }
  rt.markExplicitRoomCall = rememberExplicitCall

  // Queued explicit `delegate_work` relays enqueued via `agent.followup` when no round
  // was running, tracked from enqueue until the target round registers the child batch
  // (or cancels/pauses the relay), so a slow caller closing Turn 1 in the gap never drops
  // its upstream parent batch early.
  const pendingDirectRelays = new Map()
  const hasPendingDirectRelay = (roomId, botId, parentBatchKey) => {
    for (const entry of pendingDirectRelays.values()) {
      if (entry.roomId !== roomId || entry.by !== botId) continue
      if (parentBatchKey === undefined || entry.parentBatchKey === parentBatchKey) return true
    }
    return false
  }

  const hasParkedDirectChild = (room, botId, parentBatchKey) => (room?.paused ?? []).some(entry =>
    entry.by === botId
    && entry.direct === true
    && (parentBatchKey === undefined || entry.parentBatchKey === parentBatchKey))

  const openChildBatches = (roomId, botId, parentBatchKey) => Object.values(batches())
    .filter(batch => batch.roomId === roomId
      && batch.by === botId
      && batch.direct === true
      && batch.pending.length > 0
      && (parentBatchKey === undefined || batch.parentBatchKey === parentBatchKey))

  const upstreamBatchFor = (roomId, callerId, parentBatchKey) => {
    if (parentBatchKey === undefined) return undefined
    const exact = batches()[parentBatchKey]
    return exact !== undefined && exact.roomId === roomId && exact.pending.includes(callerId) ? exact : undefined
  }

  const hasPendingUpstreamWake = (room, botId, batch, { round, slot, sessionId, joined } = {}) => {
    if (batch === undefined) return false
    const rounds = round !== undefined ? new Set([round, ...rt.roomProgress.values()]) : rt.roomProgress.values()
    for (const candidate of rounds) {
      if (candidate?.roomId !== room.id || !Array.isArray(candidate.slots)) continue
      if (candidate.slots.some(other => other !== slot
        && other.id === botId
        && other.resumedUpstream === true
        && other.batchKey === batch.key
        && (other.status === 'waiting' || other.status === 'speaking'))) return true
    }
    const joinedInfos = joined ?? (sessionId !== undefined ? (rt.live.get(sessionId)?.joined ?? []).map(item => item?.info) : [])
    if (joinedInfos.some(item => item?.role === 'room' && item.resumedUpstream === true && item.batchKey === batch.key)) return true
    if (sessionId !== undefined && (rt.unreadOf?.(sessionId) ?? []).some(args => args?.role === 'room' && args.resumedUpstream === true && args.batchKey === batch.key)) return true
    return false
  }

  const hasWakingChildBatch = (room, botId, parentBatchKey) => Object.values(batches()).some(child =>
    child.roomId === room.id
    && child.by === botId
    && child.direct === true
    && batchReadyToWake(room, child)
    && batchCarrier(room, child) !== undefined
    && (parentBatchKey === undefined || child.parentBatchKey === parentBatchKey))

  const hasPendingChildWork = (room, botId, batch, opts = {}) => {
    if (batch === undefined) return false
    return openChildBatches(room.id, botId, batch.key).length > 0
      || hasWakingChildBatch(room, botId, batch.key)
      || hasPendingDirectRelay(room.id, botId, batch.key)
      || hasParkedDirectChild(room, botId, batch.key)
      || hasPendingUpstreamWake(room, botId, batch, opts)
  }

  // At work in the group: a turn, subagent, or group background task running, a call waiting
  // in a round, a message on its way to the member's group Session that no turn took up yet,
  // or an open child delegation whose result this member is waiting on to finish its own task.
  const activeInRoom = (room, botId, ignoreTaskId, seen = new Set(), parentBatchKey = undefined, extraRound = undefined) => {
    if (!room.members.includes(botId) || seen.has(botId)) return false
    seen.add(botId)
    const sessionId = room.sessions?.[botId]
    if (sessionId !== undefined) {
      const liveEntry = rt.live.get(sessionId)
      if (liveEntry?.turn !== undefined) {
        if (parentBatchKey === undefined) return true
        if (batchOfTurn(room.id, botId, liveEntry.info)?.key === parentBatchKey) return true
        if ((liveEntry.joined ?? []).some(item => item?.info?.role === 'room' && batchOfTurn(room.id, botId, item.info)?.key === parentBatchKey)) return true
      }
      if (liveEntry?.pending !== undefined && (parentBatchKey === undefined || batchOfTurn(room.id, botId, liveEntry.pending)?.key === parentBatchKey)) return true
      if (rt.hasSubagents?.(sessionId) === true) return true
    }
    if (rt.hasRoomTasks?.(room.id, botId, ignoreTaskId) === true) return true
    if (sessionId !== undefined && (rt.unreadOf?.(sessionId) ?? []).some(args =>
      !missedExchanges.has(args.exchangeId)
      && (parentBatchKey === undefined || batchOfTurn(room.id, botId, args)?.key === parentBatchKey))) return true
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id
      && round.slots.some(slot => slot.id === botId
        && (slot.status === 'waiting' || slot.status === 'speaking')
        && (parentBatchKey === undefined || batchOfSlot(room.id, slot)?.key === parentBatchKey)))) return true
    if (extraRound !== undefined && extraRound.roomId === room.id
      && extraRound.slots.some(slot => slot.id === botId
        && (slot.status === 'waiting' || slot.status === 'speaking')
        && (parentBatchKey === undefined || batchOfSlot(room.id, slot)?.key === parentBatchKey))) return true
    if (hasPendingDirectRelay(room.id, botId, parentBatchKey)) return true
    if (hasParkedDirectChild(room, botId, parentBatchKey)) return true
    if (hasWakingChildBatch(room, botId, parentBatchKey)) return true
    return openChildBatches(room.id, botId, parentBatchKey).some(child => child.pending.some(peerId => activeInRoom(room, peerId, ignoreTaskId, seen, child.key, extraRound)))
  }

  const registerBatch = (roomId, by, callees, direct = false, parentBatchKey = undefined) => {
    if (by === undefined || callees.length === 0) return undefined
    // A group that was deleted takes its batches with it, also one whose wake never came.
    for (const [key, old] of Object.entries(batches())) {
      if (rt.roomOf(old.roomId) === undefined) {
        wakingBatches.delete(key)
        delete batches()[key]
      }
    }
    for (const [exchangeId, relay] of pendingDirectRelays) {
      if (rt.roomOf(relay.roomId) === undefined) pendingDirectRelays.delete(exchangeId)
    }
    const batch = {
      key: randomUUID(),
      roomId,
      by,
      pending: callees.map(peer => peer.id),
      done: [],
      // Who finished, by id: a name can change before a restart settles the batch.
      doneIds: [],
      results: [],
      worked: false,
      ...(direct ? { direct: true, returnRequested: true, ...(parentBatchKey !== undefined ? { parentBatchKey } : {}) } : {}),
      answered: false,
      at: Date.now(),
    }
    const room = rt.roomOf(roomId)
    for (const peer of callees) {
      const prev = batchOf(roomId, peer.id, by, { matchParent: true, parentBatchKey })
      if (prev === undefined) continue
      unpend(prev, peer.id)
      // Persist per-worker replacement keys on the new batch so a resumed turn carrying
      // `prev.key` still settles this same-parent successor after a host restart.
      const inherited = Array.isArray(prev.replaces?.[peer.id]) ? prev.replaces[peer.id] : []
      const replaces = (batch.replaces ??= {})
      const existing = Array.isArray(replaces[peer.id]) ? replaces[peer.id] : []
      replaces[peer.id] = [...new Set([...existing, ...inherited, prev.key])]
      // Re-parent this member's child batches, queued direct relays, and parked calls even
      // when `prev` still has other pending members.
      for (const child of Object.values(batches())) {
        if (child.roomId === roomId && child.by === peer.id && child.parentBatchKey === prev.key) child.parentBatchKey = batch.key
      }
      for (const relay of pendingDirectRelays.values()) {
        if (relay.roomId === roomId && relay.by === peer.id && relay.parentBatchKey === prev.key) relay.parentBatchKey = batch.key
      }
      for (const parked of room?.paused ?? []) {
        if (parked.by === peer.id && parked.parentBatchKey === prev.key) parked.parentBatchKey = batch.key
      }
      if (prev.pending.length === 0) {
        batch.done.push(...prev.done)
        batch.doneIds.push(...(prev.doneIds ?? []))
        batch.results.push(...prev.results)
        batch.worked ||= prev.worked
        if (prev.returnRequested) batch.returnRequested = true
        if (batch.parentBatchKey === undefined && prev.parentBatchKey !== undefined) batch.parentBatchKey = prev.parentBatchKey
        batch.answered ||= prev.answered
        delete batches()[prev.key]
      }
    }
    batches()[batch.key] = batch
    saveSoon()
    return batch.key
  }

  const pruneBatchPending = (room, batch) => {
    for (const otherId of batch.pending) {
      if (!room.members.includes(otherId) || !activeInRoom(room, otherId, undefined, new Set(), batch.key)) unpend(batch, otherId)
    }
  }

  // The batch a call of the round settles into: its own (or same-parent successor when
  // superseded in-flight), never an unrelated parent's batch from the same caller.
  const batchOfSlot = (roomId, slot) => slot.batchKey !== undefined
    ? resolveBatchKey(roomId, slot.id, slot.batchKey)
    : (slot.by !== undefined ? batchOf(roomId, slot.id, slot.by) : undefined)
  const markSlotWorked = (roomId, slot) => {
    const batch = batchOfSlot(roomId, slot)
    if (batch !== undefined && !batch.worked) {
      batch.worked = true
      saveSoon()
    }
  }

  // The batch the turn with trigger `info` answers. Exact `batchKey` (or its same-parent
  // successor) wins; a keyed turn never falls back to another parent's batch.
  const batchOfTurn = (roomId, botId, info) => {
    if (info?.batchKey !== undefined) return resolveBatchKey(roomId, botId, info.batchKey)
    return (info?.askedBy !== undefined ? batchOf(roomId, botId, info.askedBy) : undefined)
      ?? (info?.role !== 'room' ? batchesOf(roomId, botId)[0] : undefined)
  }
  rt.activeRoomBatchKey = (sessionId, info) => {
    const owner = rt.groupOwners.get(sessionId)
    if (owner === undefined) return undefined
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter?.slot !== undefined) return batchOfSlot(owner.roomId, waiter.slot)?.key
    return batchOfTurn(owner.roomId, owner.botId, info)?.key
  }

  // The member's work for one batch is over. A batch whose wake is posted to the group
  // (`keep`) stays until that post, the last one that names it, is taken in (closeBatch),
  // because the lines of its results are only known then.
  const leaveBatch = (room, batch, botId, { keep = false, settleGoal = true } = {}) => {
    unpend(batch, botId)
    pruneBatchPending(room, batch)
    if (batch.pending.length === 0) {
      if (!keep) {
        wakingBatches.delete(batch.key)
        delete batches()[batch.key]
      }
      if (settleGoal && !disposed && rt.roomOf(room.id) === room) {
        void rt.goalSettled?.(room).catch(error => rt.warn('ds-bot: goal settle in %s failed: %s', room.name, error))
      }
    }
    saveSoon()
  }
  // Batches whose terminal batchEnd wake is already posted in this process (not persisted,
  // so restart recovery still wakes any unconsumed batch while concurrent in-process
  // settleRoomBatches never double-posts a wake already in flight).
  const wakingBatches = new Set()
  const closeBatch = (key) => {
    if (key !== undefined) wakingBatches.delete(key)
    if (key !== undefined && batches()[key]?.pending.length === 0) {
      delete batches()[key]
      saveSoon()
    }
  }
  const nextRoomSeq = room => (typeof room?.seq === 'number' ? room.seq + 1 : 1)
  const roomReports = createRoomReports(rt, {
    batches,
    closeBatch,
    exitMemberBatches: (room, botId) => exitMemberBatches(room, botId),
    releaseIdleParentBatches: (room, items) => releaseIdleParentBatches(room, items),
    pendingDirectRelays,
    activeInRoom,
    runningRound: roomId => runningRound(roomId),
    isFinalizing: roomId => finalizing.has(roomId),
    isDisposed: () => disposed,
    laterPostsOf: roomId => laterPosts.get(roomId) ?? [],
    bookOf,
    ensureRoomLog,
    rowOf,
    saveSoon,
    nextRoomSeq,
  })
  const {
    rememberStoppedRelay,
    isStoppedRelay,
    isBotPendingPost,
    noteRoomRelayQueued,
    roomRelayTaken,
    withWithdrawingRelay,
    enterLate,
    leaveLate,
    dropRoomReport,
    noteRoomUserOrigin,
    applyIncomingOrigin,
    snapshotOriginState,
    restoreOriginState,
    registerQueuedReport,
    trackRoundReport,
    trackScopedReport,
    settleQueuedReportInRound,
    expandScopedReports,
    recordRoundOnReports,
    settleRoomReports,
    stopRoomReports,
  } = roomReports
  const recordResult = (key, name, seq) => {
    const batch = key === undefined ? undefined : batches()[key]
    if (batch === undefined) return
    batch.results.push({ name, seq })
    saveSoon()
  }
  // What a finished batch tells the Bot that asked: who finished and where their results are.
  const wakeOf = (key) => {
    const batch = key === undefined ? undefined : batches()[key]
    return batch !== undefined && batch.pending.length === 0 && batch.done.length > 0 ? { names: [...batch.done], results: [...batch.results] } : undefined
  }
  // After a restart, once interrupted turns are picked up: a member that does not work for
  // a batch now never will. The batch settles without it, and one whose work got done
  // wakes the Bot that asked, once, with the results it has.
  rt.settleRoomBatches = async () => {
    if (rt.readOnly?.() !== undefined) return
    let changed = false
    for (const batch of Object.values(batches())) {
      if (wakingBatches.has(batch.key)) continue
      const room = rt.roomOf(batch.roomId)
      if (room === undefined || rt.botOf(batch.by) === undefined) {
        delete batches()[batch.key]
        changed = true
        continue
      }
      const before = batch.pending.length
      pruneBatchPending(room, batch)
      if (batch.pending.length > 0) continue
      changed ||= before > 0
      const members = room.members.map(rt.botOf).filter(Boolean)
      // The post that wakes the caller comes from a member that finished, else from any
      // other member: the results are in the batch, whoever carries them.
      const doneIds = batch.doneIds ?? []
      const last = members.find(bot => bot.id === doneIds.at(-1)) ?? members.find(bot => doneIds.includes(bot.id))
        ?? members.find(bot => bot.name === batch.done.at(-1)) ?? members.find(bot => bot.id !== batch.by)
      if (!room.members.includes(batch.by) || batch.done.length === 0 || last === undefined || !(batch.worked || batch.returnRequested) || batch.answered) {
        delete batches()[batch.key]
        changed = true
        continue
      }
      wakingBatches.add(batch.key)
      await postToRoom(room, last, '', { late: true, done: true, askedBy: batch.by, batch: batch.key, batchEnd: true, ...(batch.parentBatchKey ? { parentBatchKey: batch.parentBatchKey } : {}) })
        .catch((error) => {
          // Leave the batch open for retry on transient wake failures instead of silently dropping results.
          wakingBatches.delete(batch.key)
          rt.warn('ds-bot: a batch in %s left by a restart did not wake its caller: %s', room.name, error)
        })
    }
    if (changed) saveSoon()
  }
  const finishedNote = names => `${names.join(' and ')} finished the work you asked for`
  const giveResults = (round, botId, wake, batchKey) => {
    const slot = (batchKey !== undefined
      ? round.slots.findLast(other => other.id === botId && other.status === 'waiting' && other.batchKey === batchKey)
      : undefined)
      ?? round.slots.findLast(other => other.id === botId && other.status === 'waiting')
    if (slot === undefined) return
    slot.finished = slot.finished === undefined ? wake
      : { names: [...new Set([...slot.finished.names, ...wake.names])], results: [...slot.finished.results, ...wake.results] }
  }

  const releaseIdleParentBatches = (room, items, extraRound = undefined) => {
    const queue = [...items]
    const seen = new Set()
    while (queue.length > 0) {
      const item = queue.shift()
      if (item?.by === undefined || item.parentBatchKey === undefined) continue
      const key = `${item.by}\0${item.parentBatchKey}`
      if (seen.has(key)) continue
      seen.add(key)
      const parent = upstreamBatchFor(room.id, item.by, item.parentBatchKey)
      if (parent === undefined || activeInRoom(room, item.by, undefined, new Set(), parent.key, extraRound)) continue
      leaveBatch(room, parent, item.by, { keep: false, settleGoal: false })
      if (parent.pending.length === 0 && parent.by !== undefined && parent.parentBatchKey !== undefined) {
        queue.push({ by: parent.by, parentBatchKey: parent.parentBatchKey })
      }
    }
  }
  // When a child batch closes without waking its caller (e.g. child failed, passed, or
  // paused), unwind the specific upstream parent batch that depended on it if that caller
  // has no other active work left for that parent assignment.
  async function unwindOrphanedCallers(room, closedBatches, excludeBotId, { round, signal } = {}) {
    const orphaned = new Map()
    for (const batch of closedBatches) {
      if (batch.pending.length === 0 && batch.by !== undefined && batch.by !== excludeBotId && batch.parentBatchKey !== undefined) {
        let keys = orphaned.get(batch.by)
        if (keys === undefined) { keys = new Set(); orphaned.set(batch.by, keys) }
        keys.add(batch.parentBatchKey)
      }
    }
    for (const [callerId, keys] of orphaned) {
      for (const parentKey of keys) {
        const parent = upstreamBatchFor(room.id, callerId, parentKey)
        if (parent !== undefined && !activeInRoom(room, callerId, undefined, new Set(), parent.key)) {
          await exitMemberBatches(room, callerId, { owed: [parent], round, signal })
        }
      }
    }
  }

  const batchCarrier = (room, batch, preferred) => {
    if (preferred !== undefined) return preferred
    const members = room.members.map(rt.botOf).filter(Boolean)
    const doneIds = batch.doneIds ?? []
    return members.find(bot => bot.id === doneIds.at(-1))
      ?? members.find(bot => doneIds.includes(bot.id))
      ?? members.find(bot => bot.name === batch.done.at(-1))
      ?? members.find(bot => bot.id !== batch.by)
  }
  const batchReadyToWake = (room, batch) => batch.pending.length === 0
    && batch.done.length > 0
    && (batch.worked === true || batch.returnRequested === true)
    && !batch.answered
    && room.members.includes(batch.by)

  // The member is gone, stopped or failed for good: it leaves every owed batch and wakes
  // EVERY completed caller whose remaining peers finished real work. Inside an active
  // non-aborted round, callers wake directly in that round; otherwise each completed
  // batch posts its own batchEnd wake via postToRoom.
  async function exitMemberBatches(room, botId, {
    owed = batchesOf(room.id, botId),
    round,
    signal,
    member = rt.botOf(botId),
    firstPost,
    wakeExtra = { late: true, done: true },
  } = {}) {
    if (owed.length === 0) return { wokenCount: 0, usedFirstPost: false }
    // When the round is aborted/stopped, the room was deleted, or the plugin is disposing,
    // close out the member's batch membership without waking callers or resurrecting work.
    const stopped = disposed || rt.roomOf(room.id) !== room || signal?.aborted === true || round?.abort?.signal.aborted === true
    if (stopped) {
      for (const batch of owed) leaveBatch(room, batch, botId, { keep: false, settleGoal: false })
      return { wokenCount: 0, usedFirstPost: false }
    }
    const inRound = round !== undefined && !round.closed
    for (const batch of owed) leaveBatch(room, batch, botId, { keep: !inRound })
    const ready = owed.filter(batch => batchReadyToWake(room, batch))
    const readySet = new Set(ready)
    if (!inRound) {
      for (const batch of owed) if (!readySet.has(batch)) closeBatch(batch.key)
    }
    // If a child batch closed without waking its caller (e.g. child failed, passed, or
    // paused) and that caller was waiting on it to fulfill an upstream request, unwind
    // that specific upstream parent batch so nested delegations never deadlock.
    await unwindOrphanedCallers(room, owed.filter(batch => !readySet.has(batch)), botId, { round, signal })
    if (ready.length === 0) return { wokenCount: 0, usedFirstPost: false }
    if (inRound) {
      for (const batch of ready) {
        const caller = rt.botOf(batch.by)
        if (caller === undefined || !room.members.includes(caller.id)) continue
        const wake = { names: [...batch.done], results: [...batch.results] }
        expandScopedReports(room.id, botId, [caller])
        const upstream = upstreamBatchFor(room.id, caller.id, batch.parentBatchKey)
        callIn(round, [caller], finishedNote(wake.names), undefined, upstream !== undefined ? { resumeBatch: upstream } : { resultOnly: true })
        giveResults(round, caller.id, wake, upstream?.key)
      }
      return { wokenCount: ready.length, usedFirstPost: false }
    }
    const toWake = ready.filter(batch => !wakingBatches.has(batch.key))
    for (const batch of toWake) wakingBatches.add(batch.key)
    let wokenCount = 0
    let usedFirstPost = false
    for (let i = 0; i < toWake.length; i += 1) {
      const batch = toWake[i]
      const custom = i === 0 && typeof firstPost === 'function' ? firstPost(batch) : undefined
      // Additional woken batches beyond a stopped/failed first post carry `done: true`,
      // so prefer a sibling that actually finished the batch over the stopped/failed member.
      const carrier = custom !== undefined
        ? batchCarrier(room, batch, member)
        : (batchCarrier(room, batch) ?? member)
      if (carrier === undefined) {
        closeBatch(batch.key)
        continue
      }
      const body = custom?.text ?? ''
      const parentExtra = batch.parentBatchKey ? { parentBatchKey: batch.parentBatchKey } : {}
      const extra = custom !== undefined
        ? { ...custom.extra, askedBy: batch.by, batch: batch.key, batchEnd: true, ...parentExtra }
        : { ...wakeExtra, askedBy: batch.by, batch: batch.key, batchEnd: true, ...parentExtra }
      if (custom !== undefined) usedFirstPost = true
      wokenCount += 1
      await postToRoom(room, carrier, body, extra)
        .catch((error) => {
          closeBatch(batch.key)
          rt.warn('ds-bot: waking group batch in %s failed: %s', room.name, error)
        })
    }
    return { wokenCount, usedFirstPost }
  }

  // A member's message in the round, for the members after it and the user.
  const postInRound = (room, member, text, duration, claims, changes, route = roomNote(), files = []) => {
    say(room, { who: member.name, botId: member.id, text, route, ...(duration === undefined ? {} : { duration }), ...(claims === undefined ? {} : { claims }), ...(changes === undefined ? {} : { changes }), ...(files.length > 0 ? { presented: files } : {}) })
    void rt.save().catch(() => {})
    return room.seq
  }

  // What a final reply claims, checked against the computer. Only final replies are
  // checked: a step line says what is under way, not what came of it.
  // A Session's own folder is where it really writes, and it is only known from the
  // Session object (its header), never from its id.
  const claimsOf = (session, text, worked, calledPeer = false) => {
    if (session === undefined) return undefined
    const owner = rt.groupOwners.get(session.id)
    const hasBg = rt.hasSubagents?.(session.id) === true
      || (owner !== undefined && rt.hasRoomTasks?.(owner.roomId, owner.botId) === true)
    return claimsFor({
      text,
      base: rt.sessionFolder?.(session),
      worked,
      subagents: hasBg,
      runningJobs: rt.runningJobs?.(session.id)?.length ?? null,
      calledPeer,
    })
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
  // it waits for the user's approval, `{ working }` when it goes on working without the
  // round, or null when the round was stopped. The wait restarts on each event of the
  // member's Session, so a member at work is never cut off. `by` is the member that
  // called it, which answers what the turn posts after the round moved on. What the
  // member writes before its last step is posted at once and collected in `said`, and
  // `heard` takes each such line once it is posted.
  async function roomTurn(room, member, sessionId, { text, images = [], files = [], meta }, note, signal, round, slot, said = [], heard = () => {}, onWork = () => {}, onTurn = () => {}) {
    const by = slot.by
    if (signal.aborted) return null
    const exchangeId = randomUUID()
    const explicitCalls = new Set()
    explicitCallsByExchange.set(exchangeId, explicitCalls)
    if (explicitCallsByExchange.size > 200) explicitCallsByExchange.delete(explicitCallsByExchange.keys().next().value)
    slot.exchangeId = exchangeId
    slot.explicitCalls = explicitCalls
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    // The read position is the one of this turn's start, and moves only when the
    // delivery lands: a delivery that failed leaves the member where it was.
    const seenAt = room.seq
    // Checked before the delivery, which may start the turn at once.
    const busy = rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true
    const done = new Promise((resolve) => {
      let timer
      let grace
      const onAbort = () => finish(null)
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        signal.removeEventListener('abort', onAbort)
        rt.roomWaiters.delete(exchangeId)
        if (value?.missed === true) rememberMissedExchange(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = (tool) => {
        onWork()
        if (!INSTANT_WORK_TOOLS.has(tool)) grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS)
      }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        heard(step)
      }
      touch()
      rt.roomWaiters.set(exchangeId, {
        sessionId, botId: member.id, roomId: room.id, slot,
        explicitCalls: slot.explicitCalls,
        resolve: finish,
        fail: failure => finish({ failure }),
        setTurn: (turnNumber) => { if (Number.isInteger(turnNumber)) onTurn(turnNumber) },
        touch, work, say,
        approval: () => finish({ approval: true }),
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text, images, files, steer: busy, ...(by ? { askedBy: by } : {}), ...(slot.resultRef ? { resultRef: slot.resultRef } : {}), ...(slot.batchKey ? { batchKey: slot.batchKey } : {}), ...(slot.resumedUpstream ? { resumedUpstream: true } : {}) })
      // The prompt reached the member: its read position and group header snapshot move on.
      // Persisted together at round end (`await rt.save()`), avoiding a mid-round fsync per member.
      room.seen[member.id] = seenAt
      if (meta !== undefined) rt.contextRuntime?.setGroupMeta?.(sessionId, meta, { persist: false })
      // Still held by an earlier request: this turn cannot start until the user answers.
      if (rt.state.questions[sessionId] !== undefined || rt.state.views[sessionId] !== undefined) rt.roomWaiters.get(exchangeId)?.resolve({ answer: true })
      else if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      // Still at earlier work: the call steers it at its next step; the round goes on.
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      // A delivery that failed is not a pass: the round shows it. Nothing here can
      // repair a lost Session, so the member's next turn in the group starts a new one.
      const lost = lostSession(error)
      if (lost && room.sessions?.[member.id] === sessionId) {
        rt.retireGroupSession(room, member.id)
        void rt.save().catch(() => {})
      }
      rt.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    const liveSid = room.sessions?.[member.id] ?? sessionId
    // A turn that ended leaves nothing for a stop to cancel unless subagents or group tasks keep running.
    if ((typeof reply === 'string' || reply?.failure !== undefined || reply?.left === true) && !rt.hasSubagents?.(liveSid) && !rt.hasRoomTasks?.(room.id, member.id)) started.splice(started.indexOf(turn), 1)
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
  rt.abortRoomWaiters = (sessionId, result = { left: true }) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.resolve(result)
    return waiters.length > 0
  }
  rt.failRoomTurn = (sessionId, failure) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.fail(failure)
    return waiters.length > 0
  }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // Any substantive work tool (`isWorkTool`) records real progress and clears idle streaks;
  // only truly instantaneous meta mutations (`INSTANT_WORK_TOOLS`) skip the 15s grace timer.
  rt.workRoomTurn = (sessionId, tool) => {
    if (!isWorkTool(tool)) return
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.work(tool)
    // A member that gave up its place in the round (it waits for an approval, or the round
    // moved on) still works for the call its turn answers.
    const owner = rt.groupOwners.get(sessionId)
    if (waiters.length > 0 || owner === undefined) return
    const room = rt.roomOf(owner.roomId)
    if (room !== undefined) clearIdleStreak(room)
    const batch = batchOfTurn(owner.roomId, owner.botId, rt.live.get(sessionId)?.info)
    if (batch !== undefined) batch.worked = true
  }
  // The group Session's inbox changed: a running round looks for the user's messages
  // once DSH has finished the change.
  rt.nudgeRoom = (roomId) => {
    for (const round of rt.roomProgress.values()) {
      if (round.roomId === roomId) setImmediate(() => round.nudge?.())
    }
  }

  // Calls members into a round; the members one call names share a batch. Ordered calls
  // (a plain message everyone answers in turn) go ahead of the ordered calls still
  // waiting, in their own order; the others start as soon as their member is free. A
  // member still waiting is called once, with the newest note: an ordered call moves
  // it up the order, any other call lets it start at once. A call of another Bot stays
  // a call of its own, so that Bot is woken for its own work. `by` is the calling
  // member, if a member called.
  // Two distinct live batches for the same caller/callee pair (e.g. nested delegations
  // serving different upstream parents) keep separate waiting slots instead of overwriting.
  const sameBatchSlot = (slot, batchKey) => {
    if (batchKey === undefined || slot.batchKey === undefined || slot.batchKey === batchKey) return true
    const existing = batches()[slot.batchKey]
    return existing === undefined || !existing.pending.includes(slot.id)
  }

  function callIn(round, callees, note, by, { ordered = false, resultOnly = false, returnRequested = false, parentBatchKey, resumeBatch } = {}) {
    if (callees.length === 0) return
    round.batches = (round.batches ?? 0) + 1
    const effectiveBy = resumeBatch !== undefined ? resumeBatch.by : by
    const batchKey = resumeBatch !== undefined ? resumeBatch.key : registerBatch(round.roomId, by, callees, returnRequested, parentBatchKey)
    let last
    for (const peer of callees) {
      const waiting = round.slots.findIndex(slot => slot.id === peer.id
        && slot.status === 'waiting'
        && (effectiveBy === undefined || slot.by === undefined || slot.by === effectiveBy)
        && sameBatchSlot(slot, batchKey))
      if (resultOnly && waiting !== -1) continue // giveResults adds context without replacing the waiting request.
      const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
      const slot = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots[waiting]
      if (resumeBatch !== undefined) {
        delete slot.resultOnly
        slot.resumedUpstream = true
      } else if (!resultOnly) {
        delete slot.resultOnly
      } else if (waiting === -1) {
        slot.resultOnly = true
      }
      if (moves && waiting !== -1) round.slots.splice(waiting, 1)
      slot.note = note
      slot.batch = round.batches
      if (batchKey !== undefined) slot.batchKey = batchKey
      if (effectiveBy === undefined) delete slot.by
      else slot.by = effectiveBy
      if (!moves) slot.ordered = false
      else if (!ordered) round.slots.push(slot)
      else {
        slot.ordered = true
        const queue = round.slots.findIndex(other => other.ordered && other.status === 'waiting')
        round.slots.splice(last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue, 0, slot)
        last = slot
      }
    }
    round.nudge?.()
  }

  // Whether a waiting call can start now: its member answers nothing else in this
  // round, and an ordered call waits for the ordered calls before it.
  const startable = (round, slot) => {
    if (slot.status !== 'waiting' || round.slots.some(other => other.id === slot.id && other.status === 'speaking')) return false
    if (!slot.ordered) return true
    const at = round.slots.indexOf(slot)
    return round.slots.every((other, index) => !other.ordered || other === slot || (other.status !== 'speaking' && !(other.status === 'waiting' && index < at)))
  }

  // Calls the idle ping-pong guard parked (`idle`) run once the user writes: in the
  // round the user's message opens, or in the running round that takes it in.
  // LEGACY: groups used to park Bot calls past a relay limit until the user went on;
  // calls still parked from then run in the group's next round. Either way they join
  // the round's speakers, and one already waiting in the round is not called twice.
  const releaseParked = (room, round) => {
    const parked = room.paused ?? []
    const due = parked.filter(entry => entry.idle !== true || round.userMessage === true)
    if (due.length === 0) return
    const left = parked.filter(entry => !due.includes(entry))
    if (left.length > 0) room.paused = left
    else delete room.paused
    const byGroups = new Map()
    const droppedParents = []
    for (const entry of due) {
      if (!room.members.includes(entry.id) || rt.botOf(entry.id) === undefined) {
        if (entry.direct === true && entry.by !== undefined && entry.parentBatchKey !== undefined) {
          droppedParents.push({ by: entry.by, parentBatchKey: entry.parentBatchKey })
        }
        continue
      }
      if (entry.direct !== true && round.slots.some(slot => slot.id === entry.id && slot.status === 'waiting')) continue
      const key = `${entry.by ?? ''}\0${entry.direct === true ? '1' : '0'}\0${entry.parentBatchKey ?? ''}`
      if (!byGroups.has(key)) byGroups.set(key, [])
      byGroups.get(key).push(entry)
    }
    for (const group of byGroups.values()) {
      const by = group[0].by
      const peers = group.map(entry => rt.botOf(entry.id)).filter(Boolean)
      const batchKey = by !== undefined && peers.length > 0
        ? registerBatch(room.id, by, peers, group[0].direct === true, group[0].parentBatchKey)
        : undefined
      round.batches = (round.batches ?? 0) + 1
      for (const entry of group) {
        const waiting = round.slots.find(slot => slot.id === entry.id
          && slot.status === 'waiting'
          && (by === undefined || slot.by === undefined || slot.by === by)
          && sameBatchSlot(slot, batchKey))
        if (waiting !== undefined) {
          delete waiting.resultOnly
          if (batchKey !== undefined) waiting.batchKey = batchKey
          if (by !== undefined) waiting.by = by
          if (waiting.note === undefined && entry.note !== undefined) waiting.note = entry.note
        } else {
          round.slots.push({
            id: entry.id, name: entry.name, status: 'waiting', batch: round.batches,
            ...(batchKey !== undefined ? { batchKey } : {}),
            ...(entry.note !== undefined ? { note: entry.note } : {}),
            ...(by !== undefined ? { by } : {}),
          })
        }
      }
    }
    if (droppedParents.length > 0) releaseIdleParentBatches(room, droppedParents, round)
  }

  // The user's messages waiting in the group Session's inbox while a round runs, from
  // the composer whether it queued or steered them. Images, chat references, and non-user
  // posts are only processed when the Session takes the message itself, so hitting one
  // stops draining strictly in FIFO order across both nextStep and nextTurn.
  const waitingLines = (agent) => {
    const lines = []
    for (const list of ['nextStep', 'nextTurn']) {
      for (const message of agent?.inbox?.[list] ?? []) {
        if (message.source?.kind !== 'user') return lines
        const content = Array.isArray(message.content) ? message.content : []
        const text = textOf(content)
        if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) return lines
        lines.push({ id: message.id, text, source: message.source, ...(viaOf(message.source) ? { via: viaOf(message.source) } : {}) })
      }
    }
    return lines
  }

  // Messages the user sent while this round is running post into the log at once, so
  // every turn that starts from now on sees them. The members the message's own round
  // would open with answer it inside this round, as soon as they are free. Each message
  // leaves the Session's inbox, so it does not open another round when this one ends.
  function drainRoomInbox(room, round, agent) {
    // The greeting's prompt tells the admin the user has not written yet.
    if (round.kickoff) return
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return
    const roomSid = rt.sessionOfRoom(room)
    unpauseRoomIdle(room)
    round.userMessage = true
    rt.goalUserMessage?.(room.id)
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      const classified = rt.classifyRoomUserSource?.(roomSid, line.source)
      if (classified?.ignored !== true) {
        // Only a real IM platform may keep the group's IM origin; any other external
        // channel (the API token's posts carry via 'api') reads as non-IM input here,
        // so replies are never forwarded out of the team for them.
        const origin = classified !== undefined ? classified.origin : (viaIsIm(line.via) ? rt.captureImOrigin?.(roomSid) : undefined)
        noteRoomUserOrigin(room, origin)
      }
      say(room, { who: 'User', text: line.text, ...(line.via ? { via: line.via } : {}) })
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      const { speakers, ordered } = openingCall(room, { text: line.text })
      callIn(round, speakers, note, undefined, { ordered })
    }
    releaseParked(room, round)
    void rt.save().catch(() => {})
  }

  // Consecutive idle steps in this room since the user last wrote here or a member worked
  // (#853). A step is one Bot turn that used no real work tool: the post that opens a round
  // is not a step of its own, so a round and the answer it gets count once. In addition to
  // ack/status text, any zero-work cycle (calling a Bot that already spoke with 0 work tools
  // since the last user message or real work) pauses immediately regardless of wording.
  const countIdleStep = (room) => {
    if (room.idlePaused !== undefined) return
    room.idleRelays = (room.idleRelays ?? 0) + 1
  }
  const noteIdleEdge = (room, fromId, toId) => {
    if (room.idlePaused !== undefined || !fromId || !toId || fromId === toId) return
    const edge = `${fromId}->${toId}`
    const list = room.idleEdges ??= []
    if (!list.includes(edge)) list.push(edge)
  }
  const canReachIdleEdge = (startId, targetId, edges) => {
    if (!startId || !targetId || startId === targetId || edges.size === 0) return false
    const seen = new Set([startId])
    const queue = [startId]
    while (queue.length > 0) {
      const node = queue.shift()
      const prefix = `${node}->`
      for (const edge of edges) {
        if (!edge.startsWith(prefix)) continue
        const next = edge.slice(prefix.length)
        if (next === targetId) return true
        if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
    }
    return false
  }
  const countZeroWorkRelay = (room) => {
    if (room.idlePaused !== undefined) return
    room.zeroWorkRelays = (room.zeroWorkRelays ?? 0) + 1
  }
  // Work or new content clears the streak, so a group that is working is never paused.
  // It does not lift a pause already in place: that is the user's to lift (#853).
  const clearIdleStreak = (room) => {
    if (room.idlePaused !== undefined) return
    if (room.idleRelays !== undefined) delete room.idleRelays
    if (room.zeroWorkRelays !== undefined) delete room.zeroWorkRelays
    if (room.idleEdges !== undefined) delete room.idleEdges
    if (room.idleSpeakers !== undefined) delete room.idleSpeakers
  }
  rt.clearRoomIdleStreak = (roomId) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined) clearIdleStreak(room)
  }
  // The user's own message or clicking Continue lifts a pause.
  const unpauseRoomIdle = (room) => {
    if (room.idleRelays !== undefined) delete room.idleRelays
    if (room.zeroWorkRelays !== undefined) delete room.zeroWorkRelays
    if (room.idleEdges !== undefined) delete room.idleEdges
    if (room.idleSpeakers !== undefined) delete room.idleSpeakers
    if (room.idlePaused !== undefined) delete room.idlePaused
  }
  // Whether an idle step must wait for the user: the room is paused, a zero-work cycle
  // formed, or this step reaches the idle/zero-work limit. Every call it would have made
  // waits in `room.paused` and runs once the user continues or writes, never dropped.
  function holdIdleCalls(room, round, member, callees, { named = [], all = false, force = false, count, cause, limit, direct = false, parentBatchKey } = {}) {
    if (!force && room.idlePaused === undefined && (room.idleRelays ?? 0) < ROOM_IDLE_RELAY_LIMIT) return false
    const resolvedCause = cause ?? room.idlePaused?.cause ?? 'idle'
    const resolvedLimit = limit ?? (resolvedCause === 'zero-work' ? ROOM_ZERO_WORK_RELAY_LIMIT : resolvedCause === 'cycle' ? Math.max(count ?? 2, 2) : ROOM_IDLE_RELAY_LIMIT)
    if (room.idlePaused === undefined) {
      room.idlePaused = { from: member.id, count: count ?? room.idleRelays ?? resolvedLimit, limit: resolvedLimit, cause: resolvedCause, noticed: false, at: Date.now() }
    }
    const added = []
    if (callees.length > 0) {
      const parked = room.paused ?? []
      for (const peer of callees) {
        const sameParked = entry => entry.id === peer.id
          && (!direct || (entry.direct === true && entry.by === member.id && entry.parentBatchKey === parentBatchKey))
        if (parked.some(sameParked)) continue
        const note = named.includes(peer) ? `${member.name} mentioned you` : all ? `${member.name} called everyone` : `${member.name} posted in the group`
        parked.push({
          id: peer.id,
          name: peer.name,
          note,
          by: member.id,
          idle: true,
          ...(direct ? { direct: true } : {}),
          ...(parentBatchKey !== undefined ? { parentBatchKey } : {}),
        })
        added.push(peer)
      }
      room.paused = parked
    }
    if (added.length > 0 && (named.length > 0 || all) && room.idlePaused.noticed === true) {
      room.idlePaused.noticed = false
      announceRoomIdlePaused(room, round, member, added)
    } else {
      announceRoomIdlePaused(room, round, member, callees)
    }
    return true
  }
  function announceRoomIdlePaused(room, round, member, callees) {
    if (room.idlePaused === undefined || room.idlePaused.noticed === true) return
    room.idlePaused.noticed = true
    const names = callees.map(peer => peer.name)
    const limit = room.idlePaused.limit ?? ROOM_IDLE_RELAY_LIMIT
    const cause = room.idlePaused.cause
    say(room, {
      who: 'DS Bot', kind: 'notice', reason: 'paused', idle: true,
      ...(cause !== undefined ? { cause } : {}),
      from: member.name, about: member.id, count: room.idlePaused.count ?? limit, limit, names,
    })
    void rt.save().catch(() => {})
  }

  // Only unstructured discussion interprets @ as addressing syntax. Names inside
  // a delegated answer or a receipt are content, even when they name the whole room.
  function speechRoute(room, member, text, { resultRef, askedBy, batch, explicitCalls } = {}) {
    if (resultRef) return roomNote()
    if (batch?.direct && askedBy) return roomResult(askedBy, batch.key)
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const { all, found } = mentionsIn(text, everyone)
    const peers = (all && rt.isAdminOf(room, member.id) ? everyone : found).filter(bot => bot.id !== member.id)
    const next = peers.filter(bot => bot.id !== askedBy && !explicitCalls?.has(bot.id))
    if (next.length) return roomRequest(next.map(bot => bot.id))
    if (askedBy && peers.some(bot => bot.id === askedBy)) return roomResult(askedBy, batch?.key)
    return roomNote()
  }

  // Evaluates the zero-work cycle, ack/status, and consecutive zero-work relay guard for
  // Bot-to-Bot group requests (both textual @mentions in `callFrom` and explicit
  // `delegate_work` calls in `callPost` / `openRound`). Returns true when the calls were
  // parked and paused.
  function guardZeroWorkRequest(room, round, member, text, callees, {
    worked = false,
    byBot = false,
    callerId,
    idleTurn,
    named = callees,
    all = false,
    called,
    countIdleText = true,
    direct = false,
    parentBatchKey,
  } = {}) {
    let idleStep = false
    let zeroWorkCycle = false
    const alreadyPaused = !worked && byBot && room.idlePaused !== undefined && callees.length > 0
    if (worked) {
      clearIdleStreak(room)
    } else if (byBot) {
      const priorEdges = new Set(room.idleEdges ?? [])
      const alreadyCounted = idleTurn?.counted === true
      if (!alreadyCounted) {
        countZeroWorkRelay(room)
        if (idleTurn !== undefined) idleTurn.counted = true
      }
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const history = round.botBodies?.get(member.id) ?? []
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...history, norm])
      if (countIdleText) {
        idleStep = isIdleRelayText(text, everyone, history)
        if (idleStep) {
          if (idleTurn?.idleCounted !== true) {
            countIdleStep(room)
            if (idleTurn !== undefined) idleTurn.idleCounted = true
          }
        } else if (!alreadyCounted && room.idlePaused === undefined && room.idleRelays !== undefined) {
          delete room.idleRelays
        }
      }
      // Directed zero-work cycle detection:
      // - Repeating a zero-work edge in a later turn (e.g. A -> B -> A -> B) pauses immediately.
      // - Closing an N-Bot ring (e.g. A -> B -> C -> A where peer !== direct caller)
      //   pauses immediately.
      // - Legitimate fan-out (User -> Admin -> @B @C -> Admin) and sequential chains
      //   (User -> Admin -> @B -> @Admin -> @C -> @Admin) never repeat an edge and
      //   never trigger a false pause.
      zeroWorkCycle = callees.some(peer => !(called?.has(peer.id)) && (
        priorEdges.has(`${member.id}->${peer.id}`)
        || (peer.id !== callerId && canReachIdleEdge(peer.id, member.id, priorEdges))
      ))
      for (const peer of callees) noteIdleEdge(room, member.id, peer.id)
    } else {
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...(round.botBodies?.get(member.id) ?? []), norm])
      for (const peer of callees) noteIdleEdge(room, member.id, peer.id)
    }
    const hitIdle = idleStep && (room.idleRelays ?? 0) >= ROOM_IDLE_RELAY_LIMIT
    if (byBot && (alreadyPaused || hitIdle || zeroWorkCycle)) {
      const cause = hitIdle ? 'idle' : zeroWorkCycle ? 'cycle' : (room.idlePaused?.cause ?? 'idle')
      const limit = cause === 'idle' ? ROOM_IDLE_RELAY_LIMIT : cause === 'zero-work' ? ROOM_ZERO_WORK_RELAY_LIMIT : Math.max(room.zeroWorkRelays ?? 2, 2)
      const pauseCount = cause === 'idle' ? room.idleRelays : cause === 'cycle' ? Math.max(room.zeroWorkRelays ?? 2, 2) : room.zeroWorkRelays
      if (holdIdleCalls(room, round, member, callees, { named, all, force: alreadyPaused || zeroWorkCycle, count: pauseCount, cause, limit, direct, parentBatchKey })) {
        return true
      }
    }
    return false
  }

  // A later request can call the same member again once its earlier call is no
  // longer pending. Zero-work Bot-to-Bot relays still pause on a graph cycle, after
  // ROOM_IDLE_RELAY_LIMIT ack/status posts, or after ROOM_ZERO_WORK_RELAY_LIMIT
  // consecutive 0-work Bot-to-Bot turns regardless of wording.
  function callFrom(room, round, member, text, route, called, { worked = false, byBot = false, callerId, idleTurn } = {}) {
    if (route.kind !== 'request') return
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const named = addressedMembers(route, everyone, member.id)
    const callees = named.filter(peer => !called.has(peer.id) || (
      batchOf(room.id, peer.id, member.id) === undefined
      && !room.paused?.some(entry => entry.id === peer.id && entry.by === member.id)
    ))
    const paused = guardZeroWorkRequest(room, round, member, text, callees, { worked, byBot, callerId, idleTurn, named, called })
    for (const peer of callees) called.add(peer.id)
    if (paused) return
    if (callees.length === 0) return
    callIn(round, callees, `${member.name} mentioned you`, member.id)
    expandScopedReports(room.id, member.id, callees)
    // An @Name from the admin hands the member its goal task.
    if (rt.isAdminOf(room, member.id)) for (const peer of callees) rt.goalTaskWorking?.(room.id, peer.id)
  }

  // Lets the user click Continue on a paused group notice without typing a message:
  // clears the idle pause state and releases any parked calls into a live round.
  async function resumeRoomPause(roomId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined || room.idlePaused === undefined) return false
    unpauseRoomIdle(room)
    const parked = (room.paused ?? []).map(entry => ({
      ...entry,
      idle: false,
      note: entry.note && !entry.note.includes('Continue after a pause')
        ? `${entry.note}; the user clicked Continue after a pause`
        : (entry.note || 'the user clicked Continue after a pause'),
    }))
    if (parked.length > 0) room.paused = parked
    else delete room.paused
    await rt.save().catch(() => {})
    const running = runningRound(room.id)
    if (running !== undefined && !running.starting && !running.closed) {
      releaseParked(room, running)
      running.nudge?.()
      return true
    }
    if (parked.length > 0) {
      const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat · user continued paused calls]' }],
        source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), roomId: room.id, quiet: true, resumedPause: true },
      }))
      await ctx.sessions.flush(agent.session)
    }
    return true
  }
  rt.resumeRoomPause = resumeRoomPause

  // A round runs every call that can start, and wakes when a turn ends, a call comes
  // in, the user writes or the round is stopped. It ends when no turn runs and no call
  // or message waits. The inbox check keeps a message sent during the last turn inside
  // this round.
  async function runRound(room, round, signal, agent) {
    const turns = new Set()
    let due = true
    let wake = () => {}
    round.nudge = () => { due = true; wake() }
    const onAbort = () => round.nudge?.()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        if (!due) await new Promise((resolve) => { wake = resolve })
        due = false
        if (signal.aborted) break
        drainRoomInbox(room, round, agent)
        for (const slot of round.slots) {
          if (!startable(round, slot)) continue
          const turn = memberTurn(room, round, slot, signal)
            .catch(error => rt.warn('ds-bot: group turn of %s in %s failed: %s', slot.name, room.name, error))
            .finally(() => { turns.delete(turn); round.nudge() })
          turns.add(turn)
        }
        // The greeting round leaves the user's messages for a round of their own.
        if (turns.size === 0 && !round.slots.some(slot => slot.status === 'waiting') && (round.kickoff || waitingLines(agent).length === 0)) break
      }
      // No new turns can start once the loop exits; mark closed before draining so late joiners queue for the next round.
      round.closed = true
      await Promise.allSettled([...turns])
    } finally {
      signal.removeEventListener('abort', onAbort)
      delete round.nudge
    }
    // The admin was alone with the user's message and passed: the round ends with
    // nothing said. The group says so once, so the user knows to call a member.
    const alone = round.soleAdmin !== undefined && round.slots.find(slot => slot.id === round.soleAdmin.id)?.status === 'passed'
    // An answer that came, or is still coming, means the round is not left silent.
    const answered = round.slots.some(slot => ['posted', 'working', 'waiting-approval', 'waiting-answer'].includes(slot.status))
    if (alone && !answered) {
      say(room, { who: 'DS Bot', kind: 'notice', reason: 'admin-passed', names: [round.soleAdmin.name], about: round.soleAdmin.id })
      await rt.save()
    }
  }

  // One call's turn in the round. Its status says how it ended; what it says calls
  // members as soon as each line is posted.
  async function memberTurn(room, round, slot, signal) {
    const member = rt.botOf(slot.id)
    // Settings may change mid-round, for example when the admin removes someone.
    if (member === undefined || !room.members.includes(slot.id)) {
      slot.status = 'left'
      await exitMemberBatches(room, slot.id, { round, signal })
      return
    }
    slot.status = 'speaking'
    let session
    try {
      session = await groupSessionFor(room, member)
    } catch (error) {
      rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
      slot.status = 'failed'
      const own = batchOfSlot(room.id, slot)
      if (own !== undefined) await exitMemberBatches(room, member.id, { owed: [own], round, signal })
      round.failed.push(member.name)
      noteFailure(room, member, { code: 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
      return
    }
    if (session === undefined) {
      slot.status = 'left'
      await exitMemberBatches(room, member.id, { round, signal })
      return
    }
    if (slot.resultOnly) slot.resultRef = `G${slot.finished?.results.at(-1)?.seq ?? room.seq}`
    const prompt = roomPrompt(room, member, round, slot, await finishedLines(room, slot), session.id)
    round.shown?.push(member.id)
    const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
    const said = []
    // The log lines this turn posted: its result for the Bot that called it.
    const posted = []
    const called = new Set()
    const startedAt = Date.now()
    let worked = false
    // A step answers a Bot when a Bot called it: by name, or the round a Bot's own post
    // opened (#853).
    const answeredBot = slot.by !== undefined || slot.fromBot === true
    const idleTurn = { counted: false, idleCounted: false }
    const onWork = () => {
      worked = true
      slot.worked = true
      clearIdleStreak(room)
      markSlotWorked(room.id, slot)
    }
    let finishedTurn
    const publish = (body, completedSession, changes, { interim = false, presented = [] } = {}) => {
      const batch = batchOfSlot(room.id, slot)
      const route = body !== ''
        ? speechRoute(room, member, body, { resultRef: slot.resultRef, askedBy: slot.by, batch, explicitCalls: slot.explicitCalls })
        : (slot.by !== undefined ? roomResult(slot.by, batch?.key) : roomNote())
      const holdsResult = interim || hasPendingChildWork(room, member.id, batch, { round, slot, sessionId: room.sessions?.[member.id] ?? session.id })
      if (route.kind === 'result' && !holdsResult && batch) batch.returnRequested = true
      const claims = body !== '' && completedSession ? claimsOf(completedSession, body, worked, route.kind === 'request' || slot.explicitCalls?.size > 0) : undefined
      const published = (!completedSession || holdsResult) && route.kind === 'result' ? roomNote() : route
      posted.push(postInRound(room, member, body, Date.now() - startedAt, claims, changes, published, presented))
      if (body !== '') callFrom(room, round, member, body, route, called, { worked, byBot: answeredBot, callerId: slot.by, idleTurn })
    }
    const reply = await roomTurn(
      room, member, session.id, { text, images: prompt.images, files: prompt.files, meta: prompt.meta }, slot.note ?? 'your turn', signal, round, slot, said,
      line => publish(line),
      onWork,
      (turnNumber) => { finishedTurn = turnNumber },
    )
    if (reply?.left === true) {
      clearPresented(room.id, member.id)
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      slot.status = 'left'
      await exitMemberBatches(room, member.id, { round, signal })
      return
    }
    // Resolve the member's live group Session after the turn in case a part switch
    // occurred mid-turn, and pass a real DSH Session object (with header) to claimsOf.
    const activeSid = room.sessions?.[member.id] ?? session.id
    const liveSession = ctx.get?.('agents')?.get(activeSid)?.session ?? { id: activeSid }
    const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
    // Tool-only turns can finish without assistant text; their changes still belong here.
    const changes = await rt.turnChanges?.(activeSid, finishedTurn)
    const files = typeof reply === 'string' || reply?.answer === true ? await takePresented(room.id, member.id) : []
    const bgRunning = rt.hasSubagents?.(activeSid) === true || rt.hasRoomTasks?.(room.id, member.id) === true
    if (reply?.failure !== undefined) {
      clearPresented(room.id, member.id)
      // Not a pass: the user sees why the member is silent, and the round goes on.
      slot.status = 'failed'
      round.failed.push(member.name)
      noteFailure(room, member, reply.failure)
    } else if (reply?.answer) {
      const answerText = typeof reply.text === 'string' && !isPass(reply.text) ? reply.text : ''
      if (answerText !== '' || files.length > 0) {
        posted.push(postInRound(room, member, answerText, Date.now() - startedAt, undefined, changes, roomNote(), files))
      }
      slot.status = 'waiting-answer'
    } else if (reply?.approval) {
      // The member's turn goes on in the background and posts when it ends.
      slot.status = 'waiting-approval'
      say(room, { who: member.name, botId: member.id, kind: 'approval' })
    } else if (reply?.working) {
      slot.status = 'working'
      markSlotWorked(room.id, slot)
      say(room, { who: member.name, botId: member.id, kind: 'working' })
    } else if (bgRunning) {
      worked = true
      slot.worked = true
      clearIdleStreak(room)
      if (final !== undefined || files.length > 0) {
        publish(final ?? '', liveSession, changes, { interim: true, presented: files })
      }
      slot.status = 'working'
      markSlotWorked(room.id, slot)
      say(room, { who: member.name, botId: member.id, kind: 'working' })
    } else if (changes !== undefined && final === undefined && files.length === 0 && typeof reply === 'string') {
      slot.status = 'posted'
      say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      posted.push(room.seq)
    } else if (final !== undefined || (typeof reply === 'string' && (said.length > 0 || files.length > 0))) {
      slot.status = 'posted'
      if ((final !== undefined && final.trim() !== '') || files.length > 0) {
        publish(final !== undefined && final.trim() !== '' ? final : '', liveSession, changes, { presented: files })
      } else if (changes !== undefined) {
        // The turn wrote nothing to hang the change line on (a pass, or an empty final
        // reply): its completion line carries it, the same place a late completion does.
        say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      }
    } else {
      if (reply === null) clearPresented(room.id, member.id)
      slot.status = reply === null ? 'cancelled' : typeof reply === 'string' ? 'passed' : 'missed'
      round.passed.push(member.name)
      // A pass that changed files has a review to open even without a word: its
      // completion line carries the change line, exactly like a late completion.
      if (changes !== undefined) say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      if (reply?.missed) {
        // The round moved on without this member: the log shows the call and then
        // silence, which reads as a lost message. The group is told the baton was
        // dropped, and what brings the member back.
        say(room, { who: 'DS Bot', kind: 'notice', reason: 'missed', names: [member.name], about: member.id, minutes: Math.round(ROOM_REPLY_TIMEOUT_MS / 60000) })
      }
    }
    // A result the admin asked for reports its goal task; a failed model call puts it back.
    if (slot.status === 'posted' && slot.by === room.admin && (final !== undefined || files.length > 0)) rt.goalTaskReported?.(room.id, member.id)
    if (reply?.failure !== undefined) rt.goalTaskReset?.(room.id, member.id, 'Could not finish: its model call failed')
    // Yielding to work, approval or an unanswered turn keeps the task pending.
    // A timed-out ('missed') slot whose member has left or is no longer active also exits
    // its batches so departed/idle members never deadlock callers, goals, or roomReports.
    if (['posted', 'passed', 'failed', 'left', 'cancelled'].includes(slot.status)) {
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      if (slot.status === 'left') {
        await exitMemberBatches(room, member.id, { round, signal })
      } else {
        const batch = batchOfSlot(room.id, slot)
        const pendingChildren = ['posted', 'passed'].includes(slot.status) && hasPendingChildWork(room, member.id, batch, { round, slot, sessionId: activeSid })
        if (batch !== undefined && !pendingChildren) {
          if (slot.status === 'posted') {
            batch.done.push(member.name)
            batch.doneIds.push(member.id)
            batch.results.push(...posted.map(seq => ({ name: member.name, seq })))
            if (called.size > 0) batch.answered = true
            if (worked) batch.worked = true
            if (slot.resumedUpstream === true) batch.returnRequested = true
          }
          await exitMemberBatches(room, member.id, { owed: [batch], round, signal })
        }
      }
    } else if (slot.status === 'missed' && (!room.members.includes(member.id) || !activeInRoom(room, member.id))) {
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      await exitMemberBatches(room, member.id, { round, signal })
    }
  }

  // A round runs in DS Bot, not inside the group_relay call that opened it: the call ends
  // at once, so DSH neither cuts a long round short (PTC) nor holds the group's Session.
  // One round runs in a group at a time; what comes in meanwhile joins it (joinRound) or
  // waits for the next one (laterPosts).
  const laterPosts = new Map()
  // Groups whose round has ended but still finishes (goal check, save, reports): the group
  // stays taken until it hands what waits on to the next round, so no second round starts.
  const finalizing = new Set()
  let disposed = false
  rt.roomActive = roomId => runningRound(roomId) !== undefined || finalizing.has(roomId)
  // The rounds of each group until they are all the way done, saves and reports included.
  const roundRuns = new Map()
  rt.roomRounds = roomId => [...(roundRuns.get(roomId) ?? [])]
  const runningRound = roomId => [...rt.roomProgress.values()].find(round => round.roomId === roomId)
  // Stops the round running in a group, with the member turns it started.
  // A round still finishing is stopped too: what waits on it then waits for the group's
  // next message instead of starting.
  const stoppedFinishing = new Set()
  rt.stopRoomRound = (roomId) => {
    const round = runningRound(roomId)
    round?.abort.abort()
    if (finalizing.has(roomId)) stoppedFinishing.add(roomId)
    return round !== undefined || finalizing.has(roomId)
  }
  // A call that comes in while a round runs joins it: the user's messages are answered in
  // it, a Bot's post calls its members in it. A goal post, a greeting, a message with
  // images or chat references, or anything while the greeting round runs, opens the next
  // round instead.
  async function joinRound(room, running, posts, agent) {
    const round = running.starting ? await running.ready : running
    if (round === undefined) {
      const current = runningRound(room.id)
      if (current !== undefined) return joinRound(room, current, posts, agent)
      if (finalizing.has(room.id)) laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...posts])
      else startRound(room, posts, agent ?? await rt.resolveAgent(rt.sessionOfRoom(room)))
      return
    }
    if (round.closed || round.abort?.signal.aborted) {
      laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...posts])
      return
    }
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const post of posts) {
      if (post.logged !== undefined || post.resumedPause === true || isStoppedRelay(post)) {
        if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
        continue
      }
      const own = round.kickoff || post.kickoff || post.goal !== undefined || post.images !== undefined || (post.references?.length ?? 0) > 0
      if (own) {
        laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), post])
        continue
      }
      const sender = post.botId === undefined ? undefined : rt.botOf(post.botId)
      if (sender !== undefined) {
        const text = [post.text, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        if (post.failed !== undefined) round.failed.push(sender.name)
        else if (post.resumed || post.stopped || post.done) say(room, { who: sender.name, botId: sender.id, kind: post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed', text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
        else {
          const presented = presentedFiles(post.presented)
          say(room, { who: sender.name, botId: sender.id, text, ...(post.route ? { route: post.route } : {}), ...(post.files === undefined ? {} : { files: post.files }), ...(presented.length > 0 ? { presented } : {}), ...(post.claims === undefined ? {} : { claims: post.claims }), ...(post.changes === undefined ? {} : { changes: post.changes }), session: true, ...(post.late !== true && post.progress !== true ? { openingPost: true } : {}) })
          if (post.batch !== undefined && (text !== '' || presented.length > 0)) recordResult(post.batch, sender.name, room.seq)
        }
        const trackedRelay = post.exchangeId !== undefined ? pendingDirectRelays.get(post.exchangeId) : undefined
        const resolvedPost = trackedRelay?.parentBatchKey !== undefined && trackedRelay.parentBatchKey !== post.parentBatchKey
          ? { ...post, parentBatchKey: trackedRelay.parentBatchKey }
          : post
        callPost(room, round, sender, resolvedPost.text ?? '', resolvedPost)
        if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
        settleQueuedReportInRound(room, post)
        if (post.batchEnd) closeBatch(post.batch)
        continue
      }
      if (post.botId !== undefined) {
        if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
        continue
      }
      // The user's message, as one the round takes in from the Session's inbox.
      noteRoomUserOrigin(room, viaIsIm(post.via) ? rt.captureImOrigin?.(rt.sessionOfRoom(room)) : undefined)
      const text = [post.text, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
      say(room, { who: 'User', text, ...(post.files === undefined ? {} : { files: post.files }), ...(post.via === undefined ? {} : { via: post.via }), session: true })
      unpauseRoomIdle(room)
      round.userMessage = true
      rt.goalUserMessage?.(room.id)
      const { all, found } = mentionsIn(post.text ?? '', members)
      const { speakers, ordered } = openingCall(room, { text: post.text ?? '' })
      callIn(round, speakers, all || found.length > 0 ? 'the user mentioned you' : 'new message from the user', undefined, { ordered })
    }
    releaseParked(room, round)
    round.nudge?.()
    await rt.save()
  }

  // Rounds stop with the plugin.
  ctx.effect(() => () => {
    disposed = true
    presented.clear()
    explicitCallsByExchange.clear()
    pendingDirectRelays.clear()
    for (const round of rt.roomProgress.values()) round.abort?.abort()
  }, 'ds-bot: group rounds')

  // DSH's present tool records the files a member delivers in the member's own group
  // Session, which the group chat does not show (#975). Keyed by (roomId, botId) so
  // files survive a member Session that moves to a fresh part mid-turn. A path named
  // again keeps its last description and locator, as in DSH's own cards.
  const presented = new Map()
  const presentedKey = (roomId, botId) => `${roomId}/${botId}`
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'deliverables/presented') return
    const owner = rt.groupOwners.get(session?.id)
    if (owner === undefined) return
    const key = presentedKey(owner.roomId, owner.botId)
    const files = new Map((presented.get(key) ?? []).map(file => [file.path, file]))
    const incoming = Array.isArray(event.data?.files) ? event.data.files : []
    for (let index = 0; index < incoming.length; index += 1) {
      const file = incoming[index]
      if (typeof file?.path !== 'string' || file.path.trim() === '') continue
      files.delete(file.path)
      files.set(file.path, {
        path: file.path,
        ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
        ...(typeof session?.id === 'string' && session.id !== '' ? { sessionId: session.id } : {}),
        ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
        index,
      })
    }
    if (files.size > 0) presented.set(key, [...files.values()])
  })
  const clearPresented = (roomId, botId) => {
    if (typeof roomId !== 'string' || roomId === '') return
    if (botId !== undefined) {
      presented.delete(presentedKey(roomId, botId))
      return
    }
    const prefix = `${roomId}/`
    for (const key of presented.keys()) {
      if (key.startsWith(prefix)) presented.delete(key)
    }
  }
  rt.clearGroupPresented = (sessionIdOrRoomId, botId) => {
    if (botId !== undefined) { clearPresented(sessionIdOrRoomId, botId); return }
    const owner = rt.groupOwners.get(sessionIdOrRoomId)
    if (owner !== undefined) clearPresented(owner.roomId, owner.botId)
  }
  async function takePresented(roomId, botId) {
    const key = presentedKey(roomId, botId)
    const raw = presented.get(key)
    if (raw === undefined || raw.length === 0) return []
    presented.delete(key)
    const safe = []
    for (const file of raw) {
      const resolved = await (rt.realBeyond?.(file.path) ?? rt.real?.(file.path) ?? Promise.resolve(file.path))
      if (resolved && await rt.inData?.(resolved)) continue
      if (await rt.isPrivatePathBlocked?.(resolved ?? file.path, botId)) continue
      safe.push(file)
    }
    return safe
  }

  function startRound(room, queued, agent, key = randomUUID(), anchor) {
    const controller = new AbortController()
    // Taken at once, so a call that comes in while this one sets up joins it.
    const holder = { roomId: room.id, slots: [], starting: true, abort: controller, ...(anchor !== undefined ? { anchor } : {}) }
    holder.ready = new Promise((resolve) => { holder.settle = resolve })
    rt.roomProgress.set(key, holder)
    rt.publishFeed?.('live', {})
    const run = runRoundFrom(room, queued, agent, key, controller.signal, holder)
      .catch(error => rt.warn('ds-bot: group round in %s failed: %s', room.name, error))
      .finally(() => {
        holder.settle(undefined)
        if (rt.roomProgress.get(key) === holder) {
          rt.roomProgress.delete(key)
          rt.publishFeed?.('live', {})
        }
      })
    const runs = roundRuns.get(room.id) ?? new Set()
    runs.add(run)
    roundRuns.set(room.id, runs)
    void run.finally(() => {
      runs.delete(run)
      if (runs.size === 0 && roundRuns.get(room.id) === runs) roundRuns.delete(room.id)
    })
    return run
  }
  async function runRoundFrom(room, queued, agent, key, signal, holder) {
    const filtered = queued.filter((post) => {
      if (!isStoppedRelay(post)) return true
      if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
      return false
    })
    if (queued.length > 0 && filtered.length === 0) return
    const posts = filtered.length > 0 ? filtered : [{ text: '' }]
    // A goal post queued for a goal that moved on is dropped: a check or resume
    // for a goal that is gone, idle or no longer active is stale, and a draft for
    // a goal that was written or stopped keeps only its user line.
    for (const post of [...posts]) {
      if (post.goal === 'nudge' || post.goal === 'resume') {
        if (room.goal?.id !== post.goalId || room.goal.status !== 'active' || (post.goal === 'nudge' && room.goal.idle === true)) posts.splice(posts.indexOf(post), 1)
      } else if (post.goal === 'draft' && (room.goal?.id !== post.goalId || room.goal.status !== 'drafting')) {
        delete post.goal
        delete post.goalId
      }
    }
    // A post a running round already logged stays inside the round this relay opens.
    const startSeq = Math.min(room.seq + 1, ...posts.map(post => post.logged).filter(seq => typeof seq === 'number'))
    // The opening greeting is a cue for the admin, not a line of the group; a member's
    // late failure, its work picked up after a restart, its work the user stopped, or
    // the end of work whose result it already posted is an event of the round.
    const event = item => item.failed || item.resumed || item.stopped || item.done || item.resumedPause || item.goal === 'nudge' || item.goal === 'resume'
    // A user post has no botId and is no round event or kickoff; a goal draft counts
    // as the user's own line too.
    const userPost = post => post.botId === undefined && post.kickoff !== true && !event(post)
    const stoppedOnly = posts.length > 0 && posts.every(item => event(item) && item.stopped === true && item.askedBy === undefined)
    for (const post of posts.filter(item => !item.kickoff && !event(item) && item.logged === undefined)) {
      // Image readings go into the log only; `@` names are picked from what the user typed.
      // Images and files stay with their line and reach each member the line is shown to.
      const readings = post.images === undefined ? [] : await rt.imagesForGroup(post.images, rt.sessionOfRoom(room))
      const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
      const who = post.botId ? rt.botOf(post.botId)?.name ?? post.name ?? 'Bot' : 'User'
      const presented = presentedFiles(post.presented)
      say(room, {
        who,
        ...(post.botId ? { botId: post.botId } : {}),
        ...(post.route ? { route: post.route } : {}),
        text,
        ...(post.images === undefined ? {} : { images: post.images }),
        ...(post.files === undefined ? {} : { files: post.files }),
        ...(presented.length > 0 ? { presented } : {}),
        ...(post.via === undefined ? {} : { via: post.via }),
        ...(post.claims === undefined ? {} : { claims: post.claims }),
        ...(post.changes === undefined ? {} : { changes: post.changes }),
        // The group's own Session shows the message; a goal draft's trigger it hides.
        ...(post.goal === 'draft' ? {} : { session: true }),
        ...(post.botId !== undefined && post.late !== true && post.progress !== true ? { openingPost: true } : {}),
      })
      post._afterSeq = room.seq + 1
      if (post.batch !== undefined && (text !== '' || presented.length > 0)) recordResult(post.batch, who, room.seq)
    }
    await rt.save()
    const userPosts = posts.filter(userPost)
    const hasUserPost = userPosts.length > 0
    if (hasUserPost) {
      const roomIm = rt.captureImOrigin?.(rt.sessionOfRoom(room))
      for (const post of userPosts) noteRoomUserOrigin(room, viaIsIm(post.via) ? roomIm : undefined)
      rt.goalUserMessage?.(room.id)
    }
    // An event post, and a member post that calls nobody, never pick the speakers
    // over a message queued with them. A post whose members an earlier round already
    // called (`called`) picks none.
    const callsNobody = post => post.member === true && openingSpeakers(room, post).length === 0
    const open = posts.filter(post => post.called !== true)
    const references = posts.flatMap(post => post.references ?? [])
    // A member a Bot's post calls by name works for that Bot. The saved list is the
    // whole message; the text may be only its opening.
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const admin = everyone.find(bot => rt.isAdminOf(room, bot.id))
    // A user's message lifts any idle pause before folded posts are scheduled.
    if (hasUserPost) unpauseRoomIdle(room)
    const kickoff = !hasUserPost && open.some(post => post.kickoff === true)
    const goalNudge = !hasUserPost && !open.some(post => !event(post) && !callsNobody(post)) && open.some(post => post.goal === 'nudge')
    const goalResume = open.some(post => post.goal === 'resume')
    const round = {
      roomId: room.id,
      members: room.members,
      startSeq,
      goalRevision: room.goal?.revision,
      ...(hasUserPost ? { userMessage: true } : {}),
      ...(kickoff ? { kickoff: true } : {}),
      ...(goalNudge ? { goalNudge: true } : {}),
      ...(goalResume ? { goalResume: true } : {}),
      ...(stoppedOnly ? { stoppedOnly: true } : {}),
      ...(references.length > 0 ? { references, shown: [] } : {}),
      slots: [],
      batches: 0,
      from: startSeq,
      ...(holder.anchor !== undefined ? { anchor: holder.anchor } : {}),
      abort: holder.abort,
      passed: [],
      failed: [],
      started: [],
    }
    // Process every actionable open post in chronological order so folded user @mentions,
    // concurrent post_to_group calls, and batchEnd wakes are never silently dropped.
    const postIsActionable = (post) => {
      if (post.route?.kind === 'note') return post.reportBack === true
      if (post.kickoff) return kickoff
      if (post.goal === 'nudge') return goalNudge
      if (post.goal !== undefined) return true
      if (post.reportBack === true && rt.botOf(post.botId) !== undefined) return true
      if (post.batch !== undefined && post.askedBy !== undefined && wakeOf(post.batch) !== undefined) return true
      if (event(post)) return openingSpeakers(room, post).length > 0
      if (callsNobody(post)) return false
      if (openingSpeakers(room, post).length > 0) return true
      const poster = post.botId === undefined ? undefined : rt.botOf(post.botId)
      return poster !== undefined && post.quiet !== true && post.late !== true && room.idlePaused !== undefined && isIdleRelayText(post.text ?? '', everyone, [])
    }
    const actionable = open.filter(postIsActionable)
    const multiPost = actionable.length > 1
    let reportsOpened = false
    for (const post of actionable) {
      const poster = post.botId === undefined ? undefined : rt.botOf(post.botId)
      const mentionResult = post.botId === undefined ? { all: false, found: [] } : (mentionsOf(post, everyone) ?? mentionsIn(post.text ?? '', everyone))
      const named = mentionResult.found
      // A Bot's status post is a round of its own: in a group where everyone answers, that
      // post is what starts the next round of status turns (#853). It counts once as an
      // idle round; a post with new work in it, or the user's own message, clears the
      // streak. Only the user's message lifts a pause already in place.
      const idlePost = poster !== undefined && !event(post) && post.quiet !== true && post.late !== true && isIdleRelayText(post.text ?? '', everyone, [])
      // The pause holds a status post back: it is not answered, and the members it named
      // wait for the user. A post with work in it goes ahead.
      const holdsPost = idlePost && room.idlePaused !== undefined
      const opened = openingCall(room, post)
      const afterSeq = post._afterSeq ?? (typeof post.logged === 'number' ? post.logged + 1 : startSeq)
      const trackedRelay = post.exchangeId !== undefined ? pendingDirectRelays.get(post.exchangeId) : undefined
      const effectiveParentKey = trackedRelay?.parentBatchKey ?? post.parentBatchKey
      if (holdsPost) {
        holdIdleCalls(room, round, poster, opened.speakers, { named, all: mentionResult.all === true, direct: post.route?.expectsResult === true, parentBatchKey: effectiveParentKey })
        if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
        if (post.reportBack && poster !== undefined) {
          if (multiPost) trackScopedReport(room, poster, post, [], afterSeq, { paused: true })
          else trackRoundReport(room, post, afterSeq)
          reportsOpened = true
        }
        continue
      }
      // Guard explicit delegate_work requests (including follow_up_to) against zero-work cycles and relay limits.
      if (poster !== undefined && post.explicitDelegate === true && post.route?.kind === 'request' && opened.speakers.length > 0) {
        const delegateKey = post.callerExchangeId ?? poster.id
        const delegateTurns = (round.delegateIdleTurns ??= new Map())
        let delegateIdleTurn = delegateTurns.get(delegateKey)
        if (delegateIdleTurn === undefined) { delegateIdleTurn = { counted: false, idleCounted: false }; delegateTurns.set(delegateKey, delegateIdleTurn) }
        const byBot = Boolean(post.route.follows) || post.callerId !== undefined || (room.idleEdges?.length ?? 0) > 0
        if (guardZeroWorkRequest(room, round, poster, post.text ?? '', opened.speakers, {
          worked: post.worked === true,
          byBot,
          callerId: post.callerId,
          idleTurn: delegateIdleTurn,
          named,
          countIdleText: false,
          direct: post.route?.expectsResult === true,
          parentBatchKey: effectiveParentKey,
        })) {
          if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
          if (post.reportBack) {
            if (multiPost) trackScopedReport(room, poster, post, [], afterSeq, { paused: true })
            else trackRoundReport(room, post, afterSeq)
            reportsOpened = true
          }
          continue
        }
      }
      // Only a post that actually ran work tools clears the zero-work cycle/limit streak;
      // a fresh non-idle post from outside clears only the text-based ack counter (`idleRelays`).
      if (poster !== undefined && !event(post) && post.quiet !== true) {
        if (post.worked === true) clearIdleStreak(room)
        else if (!idlePost && !post.late && room.idlePaused === undefined && room.idleRelays !== undefined) delete room.idleRelays
      }
      const speakers = opened.speakers
      const ordered = opened.ordered
      // A batch's last result wakes the Bot that asked, with the results of the whole batch.
      const wake = post.batch === undefined || post.askedBy === undefined ? undefined : wakeOf(post.batch)
      const wakeParentKey = effectiveParentKey ?? (post.batch === undefined ? undefined : batches()[post.batch]?.parentBatchKey)
      const calledByPost = post.botId !== undefined ? speakers.filter(member => named.includes(member)) : []
      const openingBatchKey = post.botId !== undefined && calledByPost.length > 0 ? registerBatch(room.id, post.botId, calledByPost, post.route?.expectsResult, effectiveParentKey) : undefined
      if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
      // The admin's own post that opens a round hands goal tasks the same way a call does.
      if (rt.isAdminOf(room, post.botId)) for (const member of calledByPost) rt.goalTaskWorking?.(room.id, member.id)
      if (post.botId !== undefined && speakers.length > 0) expandScopedReports(room.id, post.botId, speakers)
      if (speakers.length > 0) {
        round.batches += 1
        const postNote = post.kickoff ? 'the group was just created'
          : post.goal === 'draft' ? 'the user wants to set a goal for this group'
          : post.goal === 'nudge' ? 'goal check'
          : post.goal === 'resume' ? 'the user resumed the goal'
          : post.done ? `${post.name ?? 'a member'} finished the work you asked for`
          : undefined
        let last
        for (const member of speakers) {
          const by = calledByPost.includes(member) ? post.botId : undefined
          const isResultWake = by === undefined && (post.route?.kind === 'result' || (wake !== undefined && member.id === post.askedBy))
          const upstream = isResultWake ? upstreamBatchFor(room.id, member.id, wakeParentKey) : undefined
          const effectiveBy = upstream !== undefined ? upstream.by : by
          const effectiveBatchKey = upstream !== undefined ? upstream.key : (by !== undefined ? openingBatchKey : undefined)
          const memberNote = wake !== undefined && member.id === post.askedBy && by === undefined ? finishedNote(wake.names) : postNote
          const waiting = round.slots.findIndex(slot => slot.id === member.id
            && slot.status === 'waiting'
            && (effectiveBy === undefined || slot.by === undefined || slot.by === effectiveBy)
            && sameBatchSlot(slot, effectiveBatchKey))
          const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
          const slot = waiting === -1 ? { id: member.id, name: member.name, status: 'waiting' } : round.slots[waiting]
          if (upstream !== undefined) {
            delete slot.resultOnly
            slot.resumedUpstream = true
          } else if (isResultWake) {
            if (waiting === -1) slot.resultOnly = true
          } else delete slot.resultOnly
          if (moves && waiting !== -1) round.slots.splice(waiting, 1)
          slot.batch = round.batches
          if (memberNote !== undefined) slot.note = memberNote
          if (upstream !== undefined) {
            slot.by = upstream.by
            slot.batchKey = upstream.key
          } else if (by !== undefined) {
            slot.by = by
            if (openingBatchKey !== undefined) slot.batchKey = openingBatchKey
          }
          // A round a Bot's post opened: what its members answer is Bot-to-Bot, counted
          // by the idle guard even though no one is named (#853). A folded user message
          // lifts the fromBot tag on any shared slot.
          if (post.botId !== undefined) {
            if (waiting === -1) slot.fromBot = true
          } else {
            delete slot.fromBot
          }
          if (!moves) slot.ordered = false
          else if (!ordered) round.slots.push(slot)
          else {
            slot.ordered = true
            const queue = round.slots.findIndex(other => other.ordered && other.status === 'waiting')
            round.slots.splice(last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue, 0, slot)
            last = slot
          }
        }
        if (wake !== undefined && speakers.some(member => member.id === post.askedBy)) {
          giveResults(round, post.askedBy, wake, upstreamBatchFor(room.id, post.askedBy, wakeParentKey)?.key)
        }
      }
      if (post.reportBack && poster !== undefined) {
        if (multiPost) trackScopedReport(room, poster, post, speakers.map(member => member.id), afterSeq)
        else trackRoundReport(room, post, afterSeq)
        reportsOpened = true
      }
    }
    for (const post of posts) if (post.exchangeId !== undefined) pendingDirectRelays.delete(post.exchangeId)
    if (reportsOpened) saveSoon()
    if (round.batches === 0) round.batches = 1
    // The admin alone with the user's message: when it passes, the round ends with
    // nothing said, and the group says so once.
    const soleAdmin = room.mode === 'admin' && admin !== undefined
      && !kickoff && !open.some(post => post.goal !== undefined)
      && hasUserPost
      && round.slots.length === 1 && round.slots[0].id === admin.id
      && round.slots[0].by === undefined && round.slots[0].fromBot !== true && round.slots[0].finished === undefined
    if (soleAdmin) round.soleAdmin = { id: admin.id, name: admin.name, color: admin.color }
    // A member's late failure is in the log already (noteFailure); the round names it.
    for (const post of posts.filter(item => item.failed && item.logged === undefined)) {
      round.failed.push(rt.botOf(post.botId)?.name ?? post.name)
    }
    // The log line tells the admin and the other members on their next turn.
    for (const post of posts.filter(item => (item.resumed || item.stopped || item.done) && item.logged === undefined)) {
      const name = rt.botOf(post.botId)?.name ?? post.name
      const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
      say(room, { who: name, botId: post.botId, kind, text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
    }
    if (posts.some(post => post.resumed || post.stopped || post.done)) await rt.save()
    for (const post of posts) if (post.batchEnd) closeBatch(post.batch)
    releaseParked(room, round)
    rt.roomProgress.set(key, round)
    holder.settle(round)
    try {
      await runRound(room, round, signal, agent)
    } catch (error) {
      rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
    } finally {
      finalizing.add(room.id)
      rt.roomProgress.delete(key)
      round.to = room.seq
      // How the round ended, beside what was said in it.
      rt.ledger.append(bookOf(room.id), { event: 'round', from: round.from, to: round.to, passed: round.passed, failed: round.failed, ...(signal.aborted ? { stopped: true } : {}), time: Date.now() })
    }
    try {
      if (signal.aborted) {
        for (const turn of round.started) {
          void rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId)
            ?.catch(error => rt.warn('ds-bot: stopping a turn of the round in %s failed: %s', room.name, error))
        }
      } else if (rt.goalDrive !== undefined) {
        // A round that ends with an active goal and nothing running may wake the admin.
        try {
          await rt.goalDrive(room, round)
        } catch (error) {
          rt.warn('ds-bot: goal check in %s failed: %s', room.name, error)
        }
      }
      recordRoundOnReports(room, round, { aborted: signal.aborted })
      await rt.save()
    } finally {
      // What came in while it ran or while it finished opens the next round, in the same
      // step that frees the group. After a stop it waits for the group's next message.
      finalizing.delete(room.id)
      const later = laterPosts.get(room.id) ?? []
      const stopped = stoppedFinishing.delete(room.id)
      if (!signal.aborted && !stopped && !disposed && later.length > 0 && rt.roomOf(room.id) === room) {
        laterPosts.delete(room.id)
        startRound(room, later, agent)
      } else if (!disposed) {
        rt.publishFeed?.('live', {})
        void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
      }
    }
  }

  rt.teamTools.push(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots it calls in this group chat, and collect their replies.',
    parameters: {
      roundId: { type: 'string', description: 'Unique id of this relay round' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      // The chat shows this call's rows from here to the next call's.
      const from = Math.min(room.seq + 1, ...queued.map(post => post.logged).filter(seq => typeof seq === 'number'))
      // Its own id: two calls with nothing said between them start at the same seq.
      const anchor = randomUUID()
      rt.ledger.append(bookOf(room.id), { event: 'anchor', id: anchor, from, time: Date.now() })
      const running = runningRound(room.id)
      if (running !== undefined) await joinRound(room, running, queued, exec.agent)
      else if (finalizing.has(room.id)) laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...queued])
      else {
        // What a stopped round left waiting goes first.
        const left = laterPosts.get(room.id) ?? []
        laterPosts.delete(room.id)
        startRound(room, [...left, ...queued], exec.agent, exec.callId, anchor)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ from, anchor })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  rt.teamTools.push(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user (or your own earlier parts in a group when `group` is passed), across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as `around` to read that message in full, `part` for the closing handoff note of an earlier part, or `call_id` to recall the full saved output of an earlier tool call. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
      call_id: { type: 'string', description: 'Recall the full saved output of an earlier tool call by its call_id (e.g. from Recent tool activity or after tool-output pruning)' },
      offset: { type: 'integer', description: 'Optional character offset when recalling a long tool output via call_id' },
      group: { type: 'string', description: 'Optional group id or name you belong to: query your own conversation parts in that group instead of your private chat' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const taskOwner = rt.taskOwners?.get(id)
      const botId = owner?.botId ?? taskOwner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId ?? taskOwner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const callId = String(args.call_id ?? '').trim().slice(0, 120)
      const groupRef = args.group !== undefined && args.group !== null ? String(args.group).trim() : ''
      let targetRoom
      if (groupRef !== '') {
        const picked = rt.pickRoom(groupRef, botId)
        if (picked.error) return picked.error
        if (!picked.room.members.includes(botId)) {
          return `You are not a member of "${picked.room.name}", so you have no own parts there.`
        }
        targetRoom = picked.room
      }
      const targetRoomId = targetRoom?.id
      const scopeLabel = targetRoom !== undefined ? `Your parts in group "${targetRoom.name}"` : 'Your own chat'
      // Pass the actual caller session to indexed reads: when querying another
      // group from private chat or a different group, `askingSession` must be
      // undefined so the target group's latest finished turn is never hidden.
      const askingSession = targetRoomId !== undefined
        ? (owner?.roomId === targetRoomId ? id : undefined)
        : (taskOwner?.roomId !== undefined ? rt.chatOf(botId) : id)
      const parts = targetRoomId !== undefined
        ? rt.partsOf(botId, targetRoomId)
        : rt.partsOfThread(botId, askingSession)
      const number = Number.isInteger(args.part) ? args.part : undefined
      // Only log a private-chat lookup (or cross-group lookup) to the current group;
      // looking up this same group's own parts does not cross privacy boundaries.
      if (room !== undefined && member !== undefined && targetRoomId !== room.id) {
        const text = callId !== '' ? `call ${callId}` : query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        say(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        void rt.save().catch(() => {})
      }
      const partsNote = parts.length > 1 ? `\n\n${scopeLabel} has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (callId !== '') {
        const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
        const recalled = await rt.recallToolOutput?.(botId, callId, { askingId: askingSession, roomId: targetRoomId, around, offset })
        if (!recalled?.found) return `No saved tool output with call_id "${callId}" was found in ${scopeLabel.toLowerCase()}.${partsNote}`
        const status = recalled.ok ? 'ok' : 'error'
        return `Tool output [${parts.length > 1 ? `part ${recalled.partNumber} ` : ''}#${recalled.seq} · ${rt.clock(recalled.time)}] ${recalled.name} (${recalled.callId}, ${status}):\n${recalled.text}${partsNote}`
      }
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around, askingSession, { roomId: targetRoomId })
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `${scopeLabel} ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `${scopeLabel} has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) {
          return part.sessionId === id
            ? `Part ${number} is the current one; it is in your context.${partsNote}`
            : `Part ${number} is still open and has no closing handoff note yet. Search it with query, or omit query for its latest messages.${partsNote}`
        }
        const note = rt.noteText(part)
        if (note === undefined && Number.isInteger(part.throughSeq)) {
          return `Part ${number} of ${scopeLabel.toLowerCase()} (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}) has no closing handoff note. Search it with query, or omit query for its latest messages.${partsNote}`
        }
        return `Part ${number} of ${scopeLabel.toLowerCase()} (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${note ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: askingSession, roomId: targetRoomId })
        return lines.length === 0 ? `${scopeLabel} is empty.${partsNote}` : `${scopeLabel} (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: askingSession, roomId: targetRoomId })
      if (lines.length === 0) return `Nothing in ${scopeLabel.toLowerCase()} mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `${scopeLabel}, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: {
      group: GROUP_REF,
      seq: { type: 'integer', description: 'Read one message whole: the seq that a cut message or a memory source names, however old' },
      before_seq: { type: 'integer', description: 'Paginate backwards through the group ledger: read up to 30 earlier messages before this seq (oldest first), with #seq prefixes' },
      query: { type: 'string', description: 'Words to find in everything said in this group, newest first' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      if (args.seq !== undefined) {
        const seq = Number(args.seq)
        const line = room.log.find(entry => entry.seq === seq)
        if (line !== undefined) return lineText(line, memberText(room)(line))
        let kept = await rt.groupLine(room.id, seq).catch(() => undefined)
        if (kept === undefined && Number.isInteger(seq) && seq >= 1 && seq <= room.seq) {
          await backfillGroupLog(room.id, seq - 1).catch(() => {})
          kept = await rt.groupLine(room.id, seq).catch(() => undefined)
        }
        return kept === undefined ? `"${room.name}" has no message ${args.seq}.` : lineText(kept, headOf(kept.text ?? '', GROUP_LINE_READ))
      }
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        const terms = args.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const matchTerm = (text) => {
          const lower = text.toLowerCase()
          return terms.find(term => lower.includes(term)) ?? terms[0] ?? ''
        }
        const found = await rt.searchGroupLog(room.id, args.query).catch(() => [])
        return found.length === 0 ? `Nothing said in "${room.name}" has "${args.query}".` : `In "${room.name}" (newest first):\n${found.map(line => `#${line.seq} ${lineText(line, excerpt(line.text ?? '', matchTerm(line.text ?? ''), TEXT_KEPT))}`).join('\n')}`
      }
      // Thirty whole lines could fill the context, so a long one shows its start.
      const short = (line) => {
        if (line.text === undefined) return ''
        const length = line.length ?? line.text.length
        return length <= TEXT_KEPT ? line.text : `${headOf(line.text, TEXT_KEPT)}… (cut; ${length} characters in all; read_group_chat with seq ${line.seq} reads it whole)`
      }
      if (args.before_seq !== undefined) {
        const before = Number(args.before_seq)
        if (!Number.isInteger(before) || before < 1) return 'before_seq must be a positive integer.'
        const collectBefore = () => {
          const all = rt.ledger.records(bookOf(room.id))
          const collected = []
          for (let i = all.length - 1; i >= 0; i -= 1) {
            const record = all[i]
            if (!memberLine(record) || !Number.isInteger(record.seq) || record.seq >= before) continue
            collected.push(record)
            if (collected.length > ROOM_READ_MAX) break
          }
          return collected
        }
        let collected = collectBefore()
        if (collected.length <= ROOM_READ_MAX && before > 1) {
          await backfillGroupLog(room.id, 0).catch(() => {})
          collected = collectBefore()
        }
        const hasMore = collected.length > ROOM_READ_MAX
        const page = collected.slice(0, ROOM_READ_MAX).reverse()
        if (page.length === 0) return `No earlier messages in "${room.name}" before #${before}.`
        const body = page.map(line => `#${line.seq} ${lineText(line, short(line))}`).join('\n')
        const footer = hasMore ? `\n(Older messages exist; pass before_seq: ${page[0].seq} to read earlier.)` : ''
        return `Earlier in "${room.name}" before #${before} (oldest first):\n${body}${footer}`
      }
      const lines = room.log.slice(-ROOM_READ_MAX)
      if (lines.length === 0) return `"${room.name}" has no messages yet.`
      let hasEarlier = false
      if (lines[0].seq > 1) {
        const book = bookOf(room.id)
        const oldestLedgerSeq = rt.ledger.firstSeq(book)
        if (oldestLedgerSeq !== undefined && oldestLedgerSeq > 1) {
          hasEarlier = true
        } else if (oldestLedgerSeq !== undefined && oldestLedgerSeq < lines[0].seq) {
          const { bySeq } = rt.ledger.open(book)
          for (let seq = lines[0].seq - 1; seq >= oldestLedgerSeq; seq -= 1) {
            const record = bySeq.get(seq)
            if (record !== undefined && memberLine(record)) {
              hasEarlier = true
              break
            }
          }
        }
      }
      const footer = hasEarlier ? `\n(Showing messages #${lines[0].seq}–#${lines.at(-1).seq}; pass before_seq: ${lines[0].seq} to read earlier.)` : ''
      return `Latest in "${room.name}" (oldest first):\n${transcript(lines, short)}${footer}`
    },
  }))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone. What a member posts
  // after its round moved on is answered by the member that asked for it; work the
  // user asked for is left for the user to read.
  // `ordered`: a plain message everyone answers in turn, admin first; any other call
  // starts its members at once.
  function openingCall(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    const at = speakers => ({ speakers, ordered: false })
    if (opener.kickoff) return at(admin ? [admin] : [])
    if (opener.quiet) return at([])
    if (opener.route) {
      if (opener.route.kind === 'result' && opener.route.batch) {
        const batch = batches()[opener.route.batch]
        if (!batch || batch.roomId !== room.id || batch.by !== opener.route.to?.[0] || batch.pending.length) return at([])
      }
      return { speakers: addressedMembers(opener.route, everyone, opener.botId), ordered: opener.route.ordered === true }
    }
    if (opener.done || opener.stopped || opener.failed) return at(members.filter(bot => bot.id === opener.askedBy))
    // A goal post — the user's draft ask, an idle goal check, a resume — is the admin's alone.
    if (opener.goal !== undefined) return at(admin ? [admin] : [])
    const { all, found: named } = mentionsOf(opener, everyone) ?? mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.progress) return at(found)
    if (opener.late) return at(found.length > 0 ? found : members.filter(bot => bot.id === opener.askedBy))
    if (opener.member) return at(found)
    if (found.length > 0 && !all) return at(found)
    if (!all && room.mode === 'admin' && admin) return at([admin])
    const speakers = admin ? [admin, ...members.filter(bot => bot !== admin)] : members
    return { speakers, ordered: !all && speakers.length > 1 }
  }
  const openingSpeakers = (room, opener) => openingCall(room, opener).speakers

  // A Bot's post that lands while a round runs calls its members in that round at
  // once, as the relay it opens would. Returns whether it called anyone. A post that
  // wants the replies (`reportBack`) gets those of the members it called when the
  // round ends.
  function callPost(room, round, sender, text, extra) {
    if (extra.route?.kind === 'note') return false
    if (extra.failed !== undefined && !extra.askedBy) return false
    if (extra.resumed || (extra.stopped && !extra.askedBy)) return false
    const post = { ...extra, botId: sender.id, name: sender.name, text }
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const named = (mentionsOf(post, everyone) ?? mentionsIn(text, everyone)).found
    // Only a post backed by real work clears the zero-work cycle/limit streak;
    // a non-idle post from outside clears only the text-based ack counter (`idleRelays`).
    const idlePost = extra.route?.kind !== 'result' && !extra.done && extra.progress !== true && extra.late !== true && isIdleRelayText(text, everyone, [])
    if (extra.worked === true) clearIdleStreak(room)
    else if (!idlePost && !extra.late && room.idlePaused === undefined && room.idleRelays !== undefined) delete room.idleRelays
    const opened = openingCall(room, post)
    if (idlePost && room.idlePaused !== undefined && holdIdleCalls(room, round, sender, opened.speakers, { named, all: (mentionsOf(post, everyone) ?? mentionsIn(text, everyone)).all === true, direct: extra.route?.expectsResult === true, parentBatchKey: extra.parentBatchKey })) {
      settleQueuedReportInRound(room, post, { paused: true })
      return 'paused'
    }
    const { speakers, ordered } = opened
    if (speakers.length === 0) return false
    if (extra.explicitDelegate === true && extra.route?.kind === 'request') {
      const delegateKey = extra.callerExchangeId ?? sender.id
      const delegateTurns = (round.delegateIdleTurns ??= new Map())
      let delegateIdleTurn = delegateTurns.get(delegateKey)
      if (delegateIdleTurn === undefined) { delegateIdleTurn = { counted: false, idleCounted: false }; delegateTurns.set(delegateKey, delegateIdleTurn) }
      const activeSlot = round.slots.find(slot => slot.id === sender.id && slot.status === 'speaking')
      const byBot = Boolean(extra.route.follows) || extra.callerId !== undefined || activeSlot?.by !== undefined || activeSlot?.fromBot === true || activeSlot?.resultOnly === true
      if (guardZeroWorkRequest(room, round, sender, text, speakers, {
        worked: extra.worked === true,
        byBot,
        callerId: extra.callerId ?? activeSlot?.by,
        idleTurn: delegateIdleTurn,
        named,
        countIdleText: false,
        direct: extra.route?.expectsResult === true,
        parentBatchKey: extra.parentBatchKey,
      })) {
        settleQueuedReportInRound(room, post, { paused: true })
        return 'paused'
      }
    }
    const by = speakers.filter(peer => named.includes(peer))
    const rest = speakers.filter(peer => !named.includes(peer))
    const wake = extra.batch === undefined ? undefined : wakeOf(extra.batch)
    const wakeParentKey = extra.parentBatchKey ?? (extra.batch === undefined ? undefined : batches()[extra.batch]?.parentBatchKey)
    const note = extra.done ? `${sender.name} finished the work you asked for` : undefined
    callIn(round, by, note ?? `${sender.name} mentioned you`, sender.id, { ordered, returnRequested: extra.route?.expectsResult, parentBatchKey: extra.parentBatchKey })
    const resultWake = extra.route?.kind === 'result' || wake !== undefined
    if (resultWake) {
      for (const peer of rest) {
        const upstream = upstreamBatchFor(room.id, peer.id, wakeParentKey)
        callIn(round, [peer], wake === undefined ? note : finishedNote(wake.names), undefined, upstream !== undefined ? { ordered, resumeBatch: upstream } : { ordered, resultOnly: true })
      }
    } else {
      callIn(round, rest, wake === undefined ? note : finishedNote(wake.names), undefined, { ordered })
    }
    expandScopedReports(room.id, sender.id, speakers)
    if (wake !== undefined) giveResults(round, extra.askedBy, wake, upstreamBatchFor(room.id, extra.askedBy, wakeParentKey)?.key)
    if (rt.isAdminOf(room, sender.id)) for (const peer of speakers) rt.goalTaskWorking?.(room.id, peer.id)
    if (extra.reportBack) {
      trackScopedReport(room, sender, extra, speakers.map(peer => peer.id))
    }
    return true
  }

  // A Bot's message into the group's own Session, which relays it as a new round.
  // While a round runs, the post goes into the group's log and that round's replies at
  // once, and the members it calls start in that round, so it is not held back until
  // the round ends and never sits in the group Session's QueueDock (#663).
  async function postToRoom(room, sender, text, extra = {}, files = []) {
    // Keep imOrigin/callerOrigin out of DSH Session events — store imOrigin in state.roomReports only.
    const { imOrigin, callerOrigin, ...postExtra } = extra
    const presented = presentedFiles(postExtra.presented)
    if (presented.length > 0) postExtra.presented = presented
    else delete postExtra.presented
    if (!postExtra.route && (postExtra.done || postExtra.stopped || postExtra.failed || postExtra.resumed)) {
      postExtra.route = postExtra.askedBy && !postExtra.quiet ? roomResult(postExtra.askedBy, postExtra.batch) : roomNote()
    }
    if (!postExtra.route && postExtra.mentions) {
      const { speakers, ordered } = openingCall(room, { ...postExtra, botId: sender.id, text })
      postExtra.route = speakers.length ? { ...roomRequest(speakers.map(bot => bot.id)), ...(ordered ? { ordered: true } : {}) } : roomNote()
    }
    const postOrigin = imOrigin ?? callerOrigin
    const noticeOnly = postExtra.resumed === true || (postExtra.stopped === true && !postExtra.askedBy) || (postExtra.failed !== undefined && !postExtra.askedBy)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id
      && (noticeOnly
        ? !round.starting && (!round.abort?.signal.aborted || round.slots?.some(slot => slot.id === sender.id))
        : round.nudge !== undefined && !round.closed && !round.abort?.signal.aborted))
    const openingBotPost = postExtra.late !== true && postExtra.progress !== true && !noticeOnly
    if (running !== undefined) {
      if (openingBotPost) rt.taintRoomImOrigin?.(room.id, postOrigin)
      const { tainted } = openingBotPost
        ? applyIncomingOrigin(room, postOrigin, { excludeReportId: postExtra.reportId, wasWorking: true })
        : { tainted: false }
      if (postExtra.reportBack === true) {
        registerQueuedReport(room, sender, postExtra, { imOrigin, tainted: imOrigin !== undefined && tainted })
      }
      if (postExtra.failed !== undefined) {
        // A failed model call is in the log already (noteFailure); the round names it.
        running.failed.push(sender.name)
      } else if (postExtra.resumed === true || postExtra.stopped === true || postExtra.done === true) {
        const kind = postExtra.done === true ? 'done' : postExtra.stopped === true ? 'stopped' : postExtra.again === true ? 'cut' : 'resumed'
        say(room, { who: sender.name, botId: sender.id, kind, text: '', ...(postExtra.changes === undefined ? {} : { changes: postExtra.changes }) })
      } else {
        const line = [text, ...files.map(fileLine)].filter(Boolean).join('\n')
        say(room, { who: sender.name, botId: sender.id, text: line, ...(postExtra.route ? { route: postExtra.route } : {}), ...(files.length > 0 ? { files } : {}), ...(presented.length > 0 ? { presented } : {}), ...(postExtra.claims === undefined ? {} : { claims: postExtra.claims }), ...(postExtra.changes === undefined ? {} : { changes: postExtra.changes }), ...(postExtra.late !== true && postExtra.progress !== true ? { openingPost: true } : {}) })
        if (postExtra.batch !== undefined && (line !== '' || presented.length > 0)) recordResult(postExtra.batch, sender.name, room.seq)
      }
      const callOutcome = callPost(room, running, sender, text, postExtra)
      // If callPost held or called nobody during a running round, still track the report so it settles cleanly.
      settleQueuedReportInRound(room, postExtra)
      if (postExtra.batchEnd) closeBatch(postExtra.batch)
      await rt.save()
      return callOutcome === 'paused' ? { paused: true } : undefined
    }
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    const exchangeId = randomUUID()
    const tracksRelay = postExtra.reportBack === true
      || (!noticeOnly && (text !== '' || files.length > 0 || presented.length > 0 || openingSpeakers(room, { ...postExtra, botId: sender.id, name: sender.name, text }).length > 0))
    const snapshot = openingBotPost ? snapshotOriginState(room.id) : undefined
    const originUpdate = openingBotPost
      ? applyIncomingOrigin(room, postOrigin, { excludeReportId: postExtra.reportId })
      : { tainted: false, version: undefined }
    if (postExtra.reportBack === true) {
      registerQueuedReport(room, sender, postExtra, { imOrigin, tainted: imOrigin !== undefined && originUpdate.tainted })
    }
    if (tracksRelay) noteRoomRelayQueued(room.id, exchangeId, postExtra.reportId)
    const tracksDirectRelay = postExtra.explicitDelegate === true && postExtra.route?.kind === 'request'
    if (tracksDirectRelay) {
      pendingDirectRelays.set(exchangeId, { roomId: room.id, by: sender.id, parentBatchKey: postExtra.parentBatchKey })
    }
    let enqueued = false
    try {
      const msg = createUserMessage({
        content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }, ...files.map(attachment => ({ type: 'file', attachment }))],
        source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId, senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...(openingBotPost ? { openingPost: true } : {}), ...postExtra },
      })
      agent.followup(msg)
      enqueued = true
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      // Only treat the post as withdrawn if followup never ran or we explicitly removed
      // the still-unclaimed entry from agent.inbox. When an idle DSH agent synchronously
      // claimed the message before flush failed, fail closed so taint and tracking stay intact.
      let withdrawn = !enqueued
      if (!withdrawn && typeof agent.inbox?.remove === 'function') {
        withWithdrawingRelay(exchangeId, () => {
          for (const lane of [agent.inbox.nextStep, agent.inbox.nextTurn]) {
            for (const item of Array.from(lane ?? [])) {
              if (item?.source?.exchangeId === exchangeId && agent.inbox.remove(item.id) === true) {
                withdrawn = true
              }
            }
          }
        })
      }
      if (withdrawn) {
        if (tracksDirectRelay) pendingDirectRelays.delete(exchangeId)
        if (tracksRelay) roomRelayTaken(room.id, exchangeId)
        if (postExtra.reportId !== undefined) dropRoomReport(postExtra.reportId)
        if (snapshot !== undefined) restoreOriginState(room.id, snapshot, originUpdate.version)
        if (tracksRelay || postExtra.reportId !== undefined || snapshot !== undefined) {
          void settleRoomReports(room.id).catch(err => rt.warn('ds-bot: settling reports after withdrawn post failed: %s', err))
        }
      } else if (error && typeof error === 'object') {
        error.delivered = true
      }
      throw error
    }
  }
  rt.postToRoom = postToRoom

  // A member the round moved on from (it went on working, went quiet or waited for an
  // approval) posts what its turn ended with. The member that asked for it and anyone
  // it names answer. When multiple members were called in one batch, each result posts
  // as soon as it is ready, and the caller is woken once when the last member in the
  // batch finishes.
  async function lateRoomReply(sessionId, info, reply, { shown = false, toolCount = 0, turn, joined } = {}) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    enterLate(room.id)
    let keepExplicit = false
    try {
      const text = stripOwnName(member.name, reply)
      const files = await takePresented(room.id, member.id)
      const hasFiles = files.length > 0
      const delivered = hasFiles ? { presented: files } : {}
      const explicitCalls = explicitCallsByExchange.get(info?.exchangeId) ?? rt.roomWaiters?.get(info?.exchangeId)?.explicitCalls
      if (rt.state.questions[sessionId] !== undefined || rt.state.views[sessionId] !== undefined) {
        keepExplicit = true
        if (!isPass(text) || hasFiles) {
          await postToRoom(room, member, isPass(text) ? '' : text, { progress: true, quiet: true, ...delivered })
            .catch(error => rt.warn('ds-bot: question lead-in from %s failed: %s', member.name, error))
        }
        return
      }
      const batch = batchOfTurn(room.id, member.id, info)
      // While a DSH subagent, group background task, or child delegation of this batch is
      // still running/queued/resuming, the member's work for this batch is not finished yet:
      // post any non-empty text as a progress line and keep its upstream batch open.
      const hasBg = rt.hasSubagents?.(sessionId) === true || rt.hasRoomTasks?.(room.id, member.id) === true
      const hasChildren = hasPendingChildWork(room, member.id, batch, { sessionId, joined })
      if (hasBg || hasChildren) {
        if (!isPass(text) || hasFiles) {
          const route = isPass(text) ? roomNote() : speechRoute(room, member, text, { ...info, batch, explicitCalls })
          await postToRoom(room, member, isPass(text) ? '' : text, { progress: true, route: route.kind === 'request' ? route : roomNote(), ...(route.kind !== 'request' ? { quiet: true } : {}), ...delivered })
            .catch(error => rt.warn('ds-bot: background progress from %s failed: %s', member.name, error))
        }
        return
      }
      const askedBy = info.role === 'room' ? info.askedBy : (info.askedBy ?? batch?.by)
      // The admin asked for this result: its goal task is reported at once, even
      // while the other members of the batch still work.
      if (askedBy === room.admin && (!isPass(text) || shown || hasFiles)) rt.goalTaskReported?.(room.id, member.id)
      const route = isPass(text) ? roomNote() : speechRoute(room, member, text, { resultRef: info.resultRef, askedBy, batch, explicitCalls })
      const named = route.kind === 'request' ? addressedMembers(route, room.members.map(rt.botOf).filter(Boolean), member.id) : []
      expandScopedReports(room.id, member.id, named)
      let waitingPeers = false
      let batchDoneBefore = false
      if (batch !== undefined) {
        if (named.length > 0) batch.answered = true
        if (!isPass(text) || shown || hasFiles) {
          batch.done.push(member.name)
          ;(batch.doneIds ??= []).push(member.id)
        }
        leaveBatch(room, batch, member.id, { keep: true })
        waitingPeers = batch.pending.length > 0
        batchDoneBefore = !waitingPeers && batch.done.length > 0 && !batch.answered
      }
      // The post names its batch: its line is a result of it, and the wake that closes the
      // batch carries the results.
      const inBatch = batch === undefined ? {} : { batch: batch.key, ...(waitingPeers ? {} : { batchEnd: true }), ...(batch.parentBatchKey ? { parentBatchKey: batch.parentBatchKey } : {}) }
      const session = await rt.resolveAgent(sessionId).then(agent => agent?.session, () => undefined)
      const claims = isPass(text) ? undefined : claimsOf(session, text, toolCount > 0, named.length > 0 || (explicitCalls?.size ?? 0) > 0)
      // What this turn changed in the member's folder, so the group can open the review from
      // the same row. Read before posting: the review needs the turn that just ended.
      const changes = await rt.turnChanges?.(sessionId, turn)
      const moved = extra => (changes === undefined ? extra : { ...extra, changes })
      const post = (body, extra) => postToRoom(room, member, body, { late: true, route: extra.quiet ? roomNote() : (askedBy && route.kind !== 'request' ? roomResult(askedBy, batch?.key) : route), ...(toolCount > 0 ? { worked: true } : {}), ...moved(extra), ...inBatch, ...(claims === undefined ? {} : { claims }) })
        .catch((error) => {
          if (batch !== undefined) closeBatch(batch.key)
          rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error)
        })
      // A late turn that changed files still has a review to open. When it wrote text, that
      // text carries the change line; when it wrote none, its completion line does. This
      // line stays out of `inBatch`: the batching and closeBatch behaviour below is not
      // changed by it, and a late pass that changed nothing still posts nothing.
      const lateDone = (extra = {}) => postToRoom(room, member, '', { late: true, done: true, ...moved(extra), ...(askedBy ? { askedBy } : {}) })
        .catch(error => rt.warn('ds-bot: late completion from %s failed: %s', member.name, error))
      if (waitingPeers && named.length === 0) {
        if (!isPass(text) || hasFiles) await post(isPass(text) ? '' : text, { quiet: true, ...delivered })
        // `quiet` keeps the change line from waking the caller early: a done post without it
        // is routed straight to `askedBy`, and the batch end wakes it again.
        else if (changes !== undefined) await lateDone({ quiet: true })
        return
      }
      const done = isPass(text) && !hasFiles && (shown || batchDoneBefore) && askedBy !== undefined
      if (isPass(text) && !hasFiles && !done) {
        if (batch !== undefined) {
          closeBatch(batch.key)
          await unwindOrphanedCallers(room, [batch], member.id)
        }
        if (changes !== undefined) await lateDone()
        return
      }
      if (batch !== undefined && !waitingPeers) wakingBatches.add(batch.key)
      await post(done || isPass(text) ? '' : text, { ...(done ? { done: true } : {}), ...(askedBy ? { askedBy } : {}), ...delivered })
    } finally {
      if (!keepExplicit && info?.exchangeId !== undefined) explicitCallsByExchange.delete(info.exchangeId)
      leaveLate(room.id)
      void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
    }
  }
  rt.lateRoomReply = lateRoomReply

  const memberIn = (sessionId, info) => {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info?.roomId)
    const member = rt.botOf(owner?.botId)
    return room !== undefined && member !== undefined && room.members.includes(member.id) ? { room, member } : undefined
  }
  const stepRoute = (room, member, text, info) => speechRoute(room, member, text, {
    ...info, batch: batchOfTurn(room.id, member.id, info),
    explicitCalls: explicitCallsByExchange.get(info?.exchangeId) ?? rt.roomWaiters?.get(info?.exchangeId)?.explicitCalls,
  })
  rt.callsRoomMember = (sessionId, info, raw) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    return room !== undefined && stepRoute(room, member, stripOwnName(member.name, raw ?? ''), info).kind === 'request'
  }

  // What a member says while it works, into the group. While the member holds its place
  // in a round, it joins that round. Later, it joins whatever round runs in the group, or
  // posts on its own. Only the members it calls with @ answer it; the member that asked
  // for the work answers the result.
  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    ensureRoomLog(room)
    const route = stepRoute(room, member, text, info)
    const calls = route.kind === 'request'
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) {
      postInRound(room, member, text)
      return
    }
    const quiet = !calls
    await rt.save()
    await postToRoom(room, member, text, { progress: true, route: calls ? route : roomNote(), ...(quiet ? { quiet: true } : {}) })
  }

  // Lines a member writes close together reach the group as one message, so a burst of
  // steps does not come out as a string of messages. Its first line on work it was asked
  // for and a line that calls a member go at once; lines still held when the turn ends
  // open its result. The same status line twice in one turn is stored once. A line that
  // names a member is kept: that call is why it was written, and the turn calls each
  // member once. Per group Session.
  const held = new Map()
  const forgetHeldSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    held.delete(sessionId)
  }
  rt.forgetHeldSteps = forgetHeldSteps
  ctx.effect(() => () => {
    for (const entry of held.values()) clearTimeout(entry.timer)
    held.clear()
  }, 'ds-bot: group step lines')
  const stepKey = (sessionId, info) => `${info?.exchangeId ?? ''}:${rt.live?.get(sessionId)?.turn ?? ''}`
  const flushSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.lines.length === 0) return undefined
    entry.last = Date.now()
    const text = entry.lines.splice(0).join('\n\n')
    entry.posted = text
    return postStep(sessionId, entry.info, text)
  }
  rt.roomStepText = async (sessionId, info, raw, first) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    const entry = held.get(sessionId) ?? { last: 0, lines: [] }
    held.set(sessionId, entry)
    const key = stepKey(sessionId, info)
    if (entry.key !== key) {
      entry.key = key
      entry.lastLine = undefined
      entry.posted = undefined
    }
    entry.info = info
    const line = text.trim()
    const calls = stepRoute(room, member, text, info).kind === 'request'
    if (line === entry.lastLine && !calls) return
    entry.lastLine = line
    entry.lines.push(text)
    if ((first && info?.role === 'room') || calls || Date.now() - entry.last >= ROOM_STEP_GAP_MS) return flushSteps(sessionId)
    entry.timer ??= setTimeout(() => void flushSteps(sessionId)?.catch(error => rt.warn('ds-bot: step lines from %s not posted: %s', member.name, error)), entry.last + ROOM_STEP_GAP_MS - Date.now())
  }
  rt.takeRoomSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return ''
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.last = Date.now()
    return entry.lines.splice(0).join('\n\n')
  }
  // The closing reply repeats a line already in the group when it matches the line
  // still held, or the text just posted when nothing newer is held. A final that
  // matches an older flush while a newer line is still held is a different line.
  rt.withRoomSteps = (sessionId, lines, reply) => {
    const entry = held.get(sessionId)
    const text = typeof reply === 'string' ? reply : ''
    const repeated = text !== '' && (text === entry?.lastLine || (lines === '' && text === entry?.posted))
    if (entry !== undefined) {
      entry.lastLine = undefined
      entry.posted = undefined
      if (entry.timer === undefined && entry.lines.length === 0) held.delete(sessionId)
    }
    if (lines === '') return repeated ? '' : reply
    if (isPass(reply) || repeated) return lines
    return `${lines}\n\n${reply}`
  }
  // withRoomSteps is what forgets the line just shown. A turn that fails or stops
  // never calls it; the next turn then has only its final, and that final is dropped
  // when it repeats the line.
  rt.dropRoomStepEcho = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.lines.length = 0
    entry.lastLine = undefined
    entry.posted = undefined
    held.delete(sessionId)
  }

  // The user stops a member's work in this group from the group's details, including
  // any running DSH subagents (#701) or group background tasks (#783) it spawned.
  async function stopMemberWork(roomId, botId, { wake = true } = {}) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = rt.own(room?.sessions, botId)
    const turnRunning = sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined
    const subRunning = sessionId !== undefined && rt.hasSubagents?.(sessionId) === true
    const taskRunning = rt.hasRoomTasks?.(roomId, botId) === true
    if (room === undefined || member === undefined || (!turnRunning && !subRunning && !taskRunning)) return false
    clearPresented(room.id, botId)
    if (sessionId !== undefined) await rt.stopSubagents?.(sessionId)
    if (taskRunning) await rt.stopMemberRoomTasks?.(roomId, botId, 'stopped in group')
    if (turnRunning && sessionId !== undefined) {
      const agent = await rt.resolveAgent(sessionId)
      agent.cancel({ kind: 'user' })
    }
    rt.goalTaskReset?.(roomId, botId, 'Stopped by the user')
    rt.blockTasks?.(roomId, botId, { cause: 'stopped' })
    if (wake) {
      const { usedFirstPost } = await exitMemberBatches(room, botId, {
        member,
        firstPost: () => ({ text: '', extra: { late: true, stopped: true } }),
      })
      if (!usedFirstPost) await postToRoom(room, member, '', { quiet: true, stopped: true })
    } else {
      for (const batch of batchesOf(room.id, botId)) leaveBatch(room, batch, botId, { keep: false, settleGoal: false })
      await postToRoom(room, member, '', { quiet: true, stopped: true })
    }
    return true
  }
  rt.stopMemberWork = stopMemberWork

  // Cancel pending Bot/goal relays while preserving deferred user messages, images, and goal drafts.
  async function cancelRoomQueues(room) {
    const cancelledParents = []
    const recordCancelledDirect = (exchangeId, by, parentBatchKey) => {
      const tracked = exchangeId !== undefined ? pendingDirectRelays.get(exchangeId) : undefined
      if (exchangeId !== undefined) pendingDirectRelays.delete(exchangeId)
      const resolvedBy = tracked?.by ?? by
      const resolvedParent = tracked?.parentBatchKey ?? parentBatchKey
      if (resolvedBy !== undefined && resolvedParent !== undefined) {
        cancelledParents.push({ by: resolvedBy, parentBatchKey: resolvedParent })
      }
    }
    const cancelPending = (list) => {
      const kept = []
      for (const post of list) {
        if (isBotPendingPost(post)) {
          rememberStoppedRelay(post.exchangeId)
          rememberStoppedRelay(post.reportId)
          recordCancelledDirect(post.exchangeId, post.botId, post.parentBatchKey)
          if (post.batchEnd && post.batch) closeBatch(post.batch)
        } else {
          kept.push(post)
        }
      }
      return kept
    }
    const keptLater = cancelPending(laterPosts.get(room.id) ?? [])
    if (keptLater.length > 0) laterPosts.set(room.id, keptLater)
    else laterPosts.delete(room.id)
    const keptInbox = cancelPending(rt.roomInbox.get(room.id) ?? [])
    if (keptInbox.length > 0) rt.roomInbox.set(room.id, keptInbox)
    else rt.roomInbox.delete(room.id)
    // Close any already-empty unanswered batch on this room whose terminal wake relay
    // is being cancelled, so reports are never stranded after stopping work.
    for (const batch of Object.values(batches())) {
      if (batch.roomId === room.id && batch.pending.length === 0) closeBatch(batch.key)
    }
    // Withdraw matching queued Bot/goal follow-ups from the group's own Session inbox
    // so stopped posts never start later (user messages and goal drafts stay intact).
    try {
      const roomAgent = await rt.resolveAgent(rt.sessionOfRoom(room))
      if (typeof roomAgent?.inbox?.remove === 'function') {
        for (const lane of [roomAgent.inbox.nextStep, roomAgent.inbox.nextTurn]) {
          for (const message of Array.from(lane ?? [])) {
            const src = message?.source
            const cancelable = src?.kind === SOURCE_KIND
              && ((src.role === 'post' && src.stopped !== true) || (src.role === 'goal' && src.goal !== 'draft'))
            if (!cancelable) continue
            rememberStoppedRelay(src.exchangeId)
            rememberStoppedRelay(src.reportId)
            recordCancelledDirect(src.exchangeId, src.senderSessionId, src.parentBatchKey)
            if (src.batchEnd && src.batch) closeBatch(src.batch)
            roomAgent.inbox.remove(message.id)
          }
        }
      }
    } catch {}
    releaseIdleParentBatches(room, cancelledParents)
  }

  // Stops every other member's work, remaining waiting slots, and queued Bot/goal relays
  // while leaving `keepBotId`'s own running turn intact (used by in-group `group_goal stop`).
  async function stopOtherRoomWork(roomId, keepBotId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const running = runningRound(room.id)
    if (running !== undefined && Array.isArray(running.slots)) {
      for (const slot of running.slots) {
        if (slot.id === keepBotId || slot.status !== 'waiting') continue
        slot.status = 'cancelled'
        for (const batch of batchesOf(room.id, slot.id)) leaveBatch(room, batch, slot.id, { keep: false, settleGoal: false })
      }
      running.nudge?.()
    }
    const parkedParents = (room.paused ?? [])
      .filter(entry => entry.direct === true && entry.by !== undefined && entry.parentBatchKey !== undefined)
      .map(entry => ({ by: entry.by, parentBatchKey: entry.parentBatchKey }))
    if (room.paused !== undefined || room.idlePaused !== undefined) {
      unpauseRoomIdle(room)
      delete room.paused
      saveSoon()
    }
    const others = room.members.filter(id => id !== keepBotId)
    const results = await Promise.allSettled(others.map(id => stopMemberWork(room.id, id, { wake: false })))
    let stopped = false
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === true) stopped = true
      } else {
        rt.warn('ds-bot: stopping work in %s failed: %s', room.name, result.reason)
      }
    }
    await cancelRoomQueues(room)
    releaseIdleParentBatches(room, parkedParents)
    return stopped
  }
  rt.stopOtherRoomWork = stopOtherRoomWork

  // The user stops everything at work in this group at once: the round the group's own
  // Session runs, which takes the member turns it started with it, then each member's
  // turn here. The round goes first, so it calls no one else meanwhile. Work the same
  // Bots do in their own chats or other groups goes on. What cannot be stopped does not
  // keep the rest going; the first failure is reported once the others are stopped.
  async function stopRoomWork(roomId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const failures = []
    const attempt = async (work) => {
      try {
        return await work()
      } catch (error) {
        rt.warn('ds-bot: stopping work in %s failed: %s', room.name, error)
        failures.push(error)
        return false
      }
    }
    const round = rt.roomActive(room.id)
    if (round) await attempt(async () => rt.stopRoomRound(room.id))
    const memberResults = await Promise.allSettled(room.members.map(botId => stopMemberWork(room.id, botId, { wake: false })))
    let stopped = false
    for (const result of memberResults) {
      if (result.status === 'fulfilled') {
        if (result.value === true) stopped = true
      } else {
        rt.warn('ds-bot: stopping work in %s failed: %s', room.name, result.reason)
        failures.push(result.reason)
      }
    }
    const parkedParents = (room.paused ?? [])
      .filter(entry => entry.direct === true && entry.by !== undefined && entry.parentBatchKey !== undefined)
      .map(entry => ({ by: entry.by, parentBatchKey: entry.parentBatchKey }))
    if (room.paused !== undefined || room.idlePaused !== undefined) {
      unpauseRoomIdle(room)
      delete room.paused
      saveSoon()
    }
    stopRoomReports(room.id)
    await cancelRoomQueues(room)
    releaseIdleParentBatches(room, parkedParents)
    rt.goalUserStopped?.(room.id)
    void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
    if (failures.length > 0) throw failures[0]
    return round || stopped
  }
  rt.stopRoomWork = stopRoomWork
  Object.assign(rt, {
    workingInRoom: workingIn,
    roomBatchPending: roomId => Object.values(batches()).some(batch => batch.roomId === roomId && batch.pending.length > 0),
    reconcileStoppedRoomTask: async (roomId, botId) => {
      const room = rt.roomOf(roomId)
      const member = rt.botOf(botId)
      if (room === undefined || member === undefined || activeInRoom(room, botId)) return
      const owed = batchesOf(room.id, botId)
      if (owed.length === 0) {
        void rt.goalSettled?.(room).catch(error => rt.warn('ds-bot: goal settle in %s failed: %s', room.name, error))
        void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
        return
      }
      const { wokenCount } = await exitMemberBatches(room, botId, {
        owed,
        member,
        firstPost: () => ({ text: '', extra: { late: true, stopped: true } }),
      })
      if (wokenCount === 0) {
        void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
      }
    },
  })

  // The round said such a member posts when done; a failed model call is how it ended.
  // Nobody answers it unless other members of its batch already finished and waited on
  // the barrier for this member.
  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    clearPresented(room.id, member.id)
    enterLate(room.id)
    try {
      // The failed turn answers one call; without that call, every batch of the member ends.
      const owed = info?.batchKey !== undefined
        ? [resolveBatchKey(room.id, member.id, info.batchKey)].filter(Boolean)
        : info.askedBy !== undefined
          ? [batchOf(room.id, member.id, info.askedBy)].filter(Boolean)
          : batchesOf(room.id, member.id)
      const { code, status, message } = failure
      const failText = `Could not finish: its model call failed (${failureLine(failure)}).`
      const failExtra = { late: true, failed: { code, ...(status ? { status } : {}), message } }
      rt.goalTaskReset?.(room.id, member.id, 'Could not finish: its model call failed')
      noteFailure(room, member, failure)
      const { usedFirstPost } = await exitMemberBatches(room, member.id, {
        owed,
        member,
        firstPost: () => ({ text: failText, extra: failExtra }),
      })
      if (!usedFirstPost) {
        await postToRoom(room, member, failText, { ...failExtra, quiet: true })
          .catch(error => rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error))
      }
    } finally {
      if (info?.exchangeId !== undefined) explicitCallsByExchange.delete(info.exchangeId)
      leaveLate(room.id)
      void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
    }
  }
  rt.lateRoomFailure = lateRoomFailure

  // A group the user just made opens with its admin asking what the group is for.
  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles, and DS Bot's own
  // calls for the room such as image readings, still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      const room = rt.roomOf(options.sessionId)
      if (room === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff' || message.source.role === 'goal')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
      // Neither relay path is declared, so a synthesized call could only fail
      // unseen. The assemble scope keeps this unreachable; if it is reached the
      // step ends with a line the user can read instead.
      if (!declared.has('group_relay') && !declared.has('run_code')) {
        rt.warn('ds-bot: group %s cannot relay: group_relay is not available in its Session', room.name)
        const text = 'This group could not pass the message on: its relay tool is not available. Restart DS Bot; if it keeps happening, report it.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      // Every round is new work, even though the tool needs no input. Its id keeps
      // DSH's repeat-call guard from treating consecutive relay turns as a loop.
      const roundId = `${Date.now()}-${randomUUID()}`
      // Only for a group made under the PTC preset, which can call nothing but run_code;
      // new group Sessions get the standard preset.
      const [name, args] = declared.has('run_code') && !declared.has('group_relay')
        ? ['run_code', JSON.stringify({ description: `Relay the group chat to its Bots (${roundId})`, code: `return await tools.group_relay({ roundId: ${JSON.stringify(roundId)} })`, timeoutMs: 600_000 })]
        : ['group_relay', JSON.stringify({ roundId })]
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
