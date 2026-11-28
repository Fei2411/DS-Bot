// Group chats: the room ledger, members' group Sessions, 3-way message protocol
// (`visible` / `invite` / `call`), SQLite-backed Bot-to-Bot delegations (`room_work`
// + `calls` + `waits`), group report-back, and group tools (`group_relay`,
// `read_own_chat`, `read_group_chat`).
//
// 3-way protocol:
//   - `visible` (`note`): written to `ledger/group-*.jsonl`, 0 model wakes. Body `@Name`
//     written by a Bot is strictly display-only and never creates calls or wakes.
//   - `invite`: user message (`admin` mode / `everyone` ordered / user `@Name` or `@all`),
//     kickoff, or goal cue — grants 1 speaking opportunity (may `[PASS]`), no owed deliverable.
//   - `call`: explicit Bot-to-Bot delegation (`delegate_work` / `post_to_group(intent='request')`)
//     persisted in `coordination.sqlite` (`works(kind='room_work') + calls + waits`), with
//     directed wait-cycle detection, single-settlement barrier back to the fixed caller,
//     and hard-signal no-progress pause (no fixed round/text heuristics).
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { claimsFor } from './claims.js'
import {
  GROUP_LINE_READ,
  HISTORY_PAGE,
  HISTORY_TIMEOUT_MS,
  INSTANT_WORK_TOOLS,
  ROOM_REPLY_TIMEOUT_MS,
  ROOM_STEP_GAP_MS,
  ROOM_WORK_GRACE_MS,
  SOURCE_KIND,
  TEXT_KEPT,
  isWorkTool,
} from './constants.js'
import { searchGroupBook } from './group-search.js'
import { parseBook } from './ledger.js'
import {
  addressedMembers,
  classifyBotGroupSpeech,
  explicitCallees,
  isCallRoute,
  isInviteRoute,
  isResultRoute,
  isVisibleRoute,
  resolveUserInvite,
  roomCall,
  roomResult,
  roomVisible,
  waitsOnMember,
} from './room-message.js'
import { createRoomReports } from './room-reports.js'
import { escapeRegExp, excerpt, headOf, reminderPrompts, splitRef, textOf } from './text.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'
import { REPLY_ELISION, parseReplies, presentedFiles, relayRange } from '../shared/group-replies.js'
import { viaIsIm, viaOf } from '../shared/im-platforms.js'
import { mentionSpans, speakerOf } from '../shared/mentions.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_READ_MAX = 30
const BACKFILL_WINDOW = 5

const CALLER_WORK_KIND = 'room_caller'
const CALL_WORK_KIND = 'room_call'
const CHAIN_WORK_KIND = 'room_chain'
const REPORT_WORK_KIND = 'room_report'
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped'])
const isPrivateBot = bot => bot?.private === true || bot?.privacy === true
const roomChainWorkId = roomId => `rw_chain:${roomId}`

const SHOWN_ONLY = new Set(['working', 'approval'])
const memberLine = record => record !== undefined && !SHOWN_ONLY.has(record.kind)

const unseenWindow = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) {
    return { all: room.log, lines: room.log.slice(-ROOM_FIRST_LOOK) }
  }
  const all = room.log.filter(line => line.seq > since && line.botId !== memberId)
  return { all, lines: all.slice(-ROOM_DELTA_MAX) }
}
const unseenLines = (room, memberId) => unseenWindow(room, memberId).lines

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
  if (line.reason === 'paused' && line.cause === 'no_progress') return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} made no measurable progress across ${line.count ?? line.limit ?? 3} attempts. Waiting for the user to continue or adjust.`
  if (line.reason === 'paused' && line.idle && (line.names ?? []).length === 0) return `Paused: Bots here posted ${line.limit} status updates with no new work, the last from ${line.from ?? 'a member'}. Waiting for the user to continue.`
  if (line.reason === 'paused' && line.idle && line.cause === 'cycle') return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} formed a wait cycle. Waiting for the user.`
  if (line.reason === 'paused') return `Paused: Bots waited on the same unresolved step without measurable progress. Waiting for the user to continue or stop.`
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

// Who "@" names in order, using the same span rules as the chat bubbles.
export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

function mentionsOf(opener, everyone) {
  if (opener.route) {
    if (isVisibleRoute(opener.route)) return { all: false, found: [] }
    if (isCallRoute(opener.route) && !opener.mentions) {
      return { all: false, found: explicitCallees(opener.route, everyone, opener.botId) }
    }
    if (isResultRoute(opener.route) || isInviteRoute(opener.route)) {
      return { all: false, found: addressedMembers(opener.route, everyone, opener.botId) }
    }
  }
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

export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_REPLY_COMPACT = 'Reply for the group (no name prefix; [PASS] to stay silent).'
const ROOM_CALLS = 'Use delegate_work to assign tasks to group members; their results return to you automatically once finished. Plain "@Name" in your message text is display-only and never wakes or delegates to other members.'

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
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or assign tasks to members with delegate_work.' : '',
  'When the user asks, change the group with update_group.',
  'When the user wants this group to reach a goal, set it with group_goal: align with the user first (goal-grill skill), then start it.',
].filter(Boolean).join(' ')

const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not delegate to members yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const lostSession = error => error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`
const POST_HEADER = /^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/
const digestOf = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)

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

  const bookOf = roomId => `group-${roomId}`
  const writes = () => rt.readOnly?.() === undefined
  const db = () => rt.coordDb ?? null
  const existingDb = () => (typeof rt.existingCoordDb === 'function' ? rt.existingCoordDb() : db())
  const writableDb = () => {
    const handle = db()
    if (handle === null || handle.isClosed?.() || handle.readonly || !writes()) return null
    return handle
  }
  const existingWritableDb = () => {
    const handle = existingDb()
    if (handle === null || handle.isClosed?.() || handle.readonly || !writes()) return null
    return handle
  }
  const saveSoon = () => void rt.save().catch(() => {})

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

  const memberText = room => (line) => {
    const whole = line.length === undefined ? line.text : rt.ledger.record(bookOf(room.id), line.seq)?.text
    if (whole === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const shown = headOf(whole, GROUP_LINE_READ)
    return whole.length > shown.length ? `${shown}… (cut; ${whole.length} characters in all)` : shown
  }

  const cutLine = (line, text = line.text ?? '') => {
    const kept = headOf(text, TEXT_KEPT)
    return kept.length === text.length ? line : { ...line, text: kept, length: text.length }
  }
  function keepGroupLine(roomId, line, text) {
    rt.ledger.open(bookOf(roomId))
    return cutLine(line, text)
  }

  function dropGroupLines(roomId) {
    clearPresented(roomId)
    backfilled.delete(roomId)
    laterPosts.delete(roomId)
    stoppedFinishing.delete(roomId)
    const handle = existingWritableDb()
    if (handle !== null) {
      const works = handle.listWorks({ kind: 'room_work', roomId, activeOnly: true, limit: 500 })
      for (const work of works) {
        if (work.meta?.kind === REPORT_WORK_KIND) continue
        handle.stopWork(work.workId, { reason: 'Group deleted' })
      }
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
  const say = (room, line) => {
    ensureRoomLog(room)
    room.seq += 1
    const record = { ...line, seq: room.seq, time: line.time ?? Date.now() }
    rt.ledger.append(bookOf(room.id), record)
    rt.roomLineAdded?.(room, record)
    if (!memberLine(record)) return record
    room.log = [...room.log, cutLine(record)].slice(-ROOM_LOG_MAX)
    for (const listener of roomLineListeners) {
      try { listener(room, record) } catch (error) { rt.warn('ds-bot: room line listener failed: %s', error) }
    }
    return record
  }

  function rowOf(record) {
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

  const rowsView = (roomId, from, to, anchor) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined) ensureRoomLog(room)
    let end = to
    if (end === undefined) {
      const nextFrom = rt.ledger.nextAnchor(bookOf(roomId), from, anchor)
      if (nextFrom !== undefined) end = nextFrom - 1
    }
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
      if (reply.kind !== undefined || head.length !== 220 || tail.length !== 80 || omitted <= 100 || REPLY_ELISION.test(tail)) return null
      const length = head.length + omitted + tail.length
      const matches = records.filter((record) => {
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

    let partial
    const headFragment = /"text"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(head)
    if (headFragment !== null) {
      try { partial = JSON.parse(`${head}"}]}`).replies.at(-1) } catch { return null }
    }
    const first = partial ?? before.findLast(reply => reply?.kind === undefined && typeof reply?.botId === 'string' && typeof reply.text === 'string')
    if (typeof first?.text !== 'string' || first.text.length < 16 || first.kind !== undefined) return null
    const starts = records.filter(record => isLegacyReply(record) && record.botId === first.botId
      && matchesOpening(record, first.text, partial !== undefined))
    const ends = records.filter(record => isKeptReply(record) && jsonText(record.text).endsWith(tailFragment[1])
      && (after[0].botId === undefined || record.botId === after[0].botId))
    if (starts.length !== 1 || ends.length !== 1 || ends[0].seq < starts[0].seq) return null
    const span = records.slice(records.indexOf(starts[0]), records.indexOf(ends[0]) + 1)
    if (!span.every((record, i) => isKeptReply(record) && record.seq === starts[0].seq + i)) return null
    const hiddenText = span.reduce((length, record) => length + jsonText(record.text).length, 0)
      - (headFragment?.[1].length ?? jsonText(first.text).length) - tailFragment[1].length
    const omitted = Number(marker[1])
    if (span.length === 1) {
      if (partial === undefined || first.text.length + tail.length >= span[0].text.length || hiddenText !== omitted) return null
    } else if (hiddenText >= omitted) return null
    const missing = partial === undefined ? span.slice(1) : span
    return [...before, ...missing.map(rowOf), ...after.slice(1)]
  }

  function groupRelayReplies(sessionId, preview) {
    if (typeof sessionId !== 'string' || typeof preview !== 'string' || preview.length > 65_536) return null
    const marker = REPLY_ELISION.exec(preview)
    if (marker === null) return null
    const room = rt.roomOf(sessionId) ?? rt.roomOf(rt.pastOwners.get(sessionId)?.roomId)
    if (room === undefined) return null
    ensureRoomLog(room)
    const book = rt.ledger.records(bookOf(room.id))
    const anchor = book.findIndex(record => record.event === 'anchor')
    const records = anchor === -1 ? book : book.slice(0, anchor)
    if (records.some((record, i) => record.seq !== i + 1)
      || (anchor === -1 ? records.length !== room.seq : book[anchor].from > records.length + 1)) return null
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
    backfillGroupLog,
    groupLinesAfter: async (roomId, since) => rt.ledger.after(bookOf(roomId), since).filter(memberLine),
    groupLine: async (roomId, seq) => {
      const record = rt.ledger.record(bookOf(roomId), seq)
      return memberLine(record) ? record : undefined
    },
    searchGroupLog: async (roomId, query) => rt.ledger.search(bookOf(roomId), query, { filter: memberLine }),
  })

  const noteFailure = (room, member, failure) => {
    const { code, status, message } = failure
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'failed', names: [member.name], about: member.id, detail: failureLine(failure), code, ...(status ? { status } : {}), message })
  }

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

  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }), bot: member })
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
    await rt.resolveAgent(id)
      .catch(error => rt.warn('ds-bot: scoped tools for %s in %s not applied: %s', member.name, room.name, error))
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // ---------------------------------------------------------------------------
  // SQLite-backed Bot-to-Bot group delegation helpers (`coordination.sqlite`).
  // Replaces legacy `state.roomBatches`, `wakingBatches`, and heuristic idle counters.

  const isReportWork = work => work?.meta?.kind === REPORT_WORK_KIND
    || work?.meta?.migratedFrom === 'state.roomReports'
    || (typeof work?.workId === 'string' && work.workId.startsWith('room-report:'))
  const isChainWork = work => work?.meta?.kind === CHAIN_WORK_KIND
  const isDelegationWork = work => work !== undefined && work !== null && work.kind === 'room_work' && !isReportWork(work) && !isChainWork(work)
  const isCallWork = work => work?.meta?.kind === CALL_WORK_KIND
    || (work?.meta?.migratedFrom === 'state.roomBatches' && work.parentWorkId !== null && work.parentWorkId !== undefined)
  const isCallerWork = work => work?.meta?.kind === CALLER_WORK_KIND
    || (work?.meta?.migratedFrom === 'state.roomBatches' && (work.parentWorkId === null || work.parentWorkId === undefined))

  // Stable chain anchor per room so consecutive Bot-to-Bot delegation rounds between user
  // messages share one `root_work_id` for stagnation tracking (never enters `ready`/`running`).
  const ensureRoomChainWork = (handle, room, fallbackBotId) => {
    const chainId = roomChainWorkId(room.id)
    const existing = handle.getWork(chainId)
    if (existing && !TERMINAL_STATUSES.has(existing.status)) return existing
    const anchorBotId = room.admin ?? fallbackBotId ?? room.members[0] ?? 'room'
    return handle.createWork({
      workId: chainId,
      botId: anchorBotId,
      kind: 'room_work',
      logicalAddress: `room:${room.id}:chain`,
      status: 'idle',
      priority: 'background',
      roomId: room.id,
      originKind: 'group',
      visibility: 'room',
      privacyScoped: false,
      meta: { kind: CHAIN_WORK_KIND, roomId: room.id },
    }).work
  }

  const parkChainWorkIdle = (handle, workId) => {
    const claimed = handle.claimReady({ workId, owner: 'groups:chain' })
    if (claimed) {
      handle.yieldWork({ workId, claimToken: claimed.claimToken, nextStatus: 'idle' })
    }
  }

  const resetRoomChainProgress = (room) => {
    const handle = writableDb()
    if (handle === null || room === undefined) return
    const chainId = roomChainWorkId(room.id)
    handle.transaction(() => {
      const chain = handle.getWork(chainId)
      if (!chain || TERMINAL_STATUSES.has(chain.status)) return
      if (chain.status === 'idle' && (chain.stagnationCount ?? 0) === 0 && !chain.progressSignature) return
      if (chain.status !== 'paused') {
        handle.pauseWork(chainId, { reason: 'reset_progress', pauseChain: false })
      }
      handle.resumeWork(chainId, { resumeChain: false, resetProgress: true, reason: 'user_reset' })
      parkChainWorkIdle(handle, chainId)
    })
  }

  const listActiveRoomWorks = (roomId, { botId } = {}) => {
    const handle = existingDb()
    if (handle === null || handle.isClosed?.()) return []
    return handle.listWorks({
      kind: 'room_work',
      ...(roomId !== undefined ? { roomId } : {}),
      ...(botId !== undefined ? { botId } : {}),
      activeOnly: true,
      limit: 500,
    }).filter(isDelegationWork)
  }

  const getRoomWork = (workId) => {
    if (typeof workId !== 'string' || workId === '') return undefined
    const handle = existingDb()
    if (handle === null || handle.isClosed?.()) return undefined
    const work = handle.getWork(workId)
    return isDelegationWork(work) && !TERMINAL_STATUSES.has(work.status) ? work : undefined
  }

  const openChildWaitsOf = (workId) => {
    const handle = existingDb()
    if (handle === null || handle.isClosed?.() || !workId) return []
    return handle.listWaits({ workId, kind: 'call', status: 'open', limit: 100 })
  }

  const isHeldRoomStatus = status => status === 'paused' || status === 'needs_verification' || status === 'stopping'

  const hasActiveRoomCalls = (roomId, { memberIds, ignoreTaskId, ignoreBotId, waitingForUser } = {}) => {
    const works = listActiveRoomWorks(roomId)
    const room = rt.roomOf(roomId)
    const handle = existingDb()
    const ignoredBotIdle = ignoreTaskId !== undefined && ignoreBotId !== undefined && !activeInRoom(room, ignoreBotId, ignoreTaskId)
    for (const work of works) {
      if (isHeldRoomStatus(work.status)) continue
      if (Array.isArray(memberIds) && !memberIds.includes(work.botId)) continue
      if (waitingForUser?.(room, work.botId) === true) continue
      if (ignoredBotIdle && work.botId === ignoreBotId) continue
      if (isCallWork(work)) return true
      const openWaits = openChildWaitsOf(work.workId)
      if (openWaits.length > 0) {
        if (ignoredBotIdle && handle !== null && openWaits.every((w) => {
          const target = w.targetWorkId ? handle.getWork(w.targetWorkId) : undefined
          return target?.botId === ignoreBotId
        })) continue
        return true
      }
    }
    return false
  }

  const openRoomCall = (room, callerBotId, callees, { parentWorkId, callerExchangeId, follows, returnAddress } = {}) => {
    const handle = writableDb()
    if (handle === null || !callerBotId || callees.length === 0) return undefined
    const callerBot = rt.botOf(callerBotId)
    return handle.transaction(() => {
      const chainWork = ensureRoomChainWork(handle, room, callerBotId)
      let parentWork = parentWorkId ? getRoomWork(parentWorkId) : undefined
      if (parentWork === undefined) {
        // Reuse an open fan-out caller work from the same turn so multiple `delegate_work`
        // calls in one step (`@B` then `@C`) share a single barrier and wake the caller once.
        const existingCallers = handle.listWorks({
          botId: callerBotId,
          kind: 'room_work',
          roomId: room.id,
          status: 'waiting',
          limit: 20,
        }).filter(w => isCallerWork(w)
          && (callerExchangeId === undefined || w.meta?.callerExchangeId === callerExchangeId))
        parentWork = existingCallers[0]
      }
      if (parentWork === undefined) {
        const callerId = `rw_caller_${randomUUID()}`
        parentWork = handle.createWork({
          workId: callerId,
          botId: callerBotId,
          kind: 'room_work',
          logicalAddress: `room:${room.id}:${callerBotId}`,
          status: 'waiting',
          priority: 'background',
          rootWorkId: chainWork.workId,
          roomId: room.id,
          originKind: 'group',
          visibility: isPrivateBot(callerBot) ? 'private' : 'room',
          privacyScoped: isPrivateBot(callerBot),
          sessionId: room.sessions?.[callerBotId],
          meta: {
            kind: CALLER_WORK_KIND,
            roomId: room.id,
            callerBotId,
            ...(callerExchangeId ? { callerExchangeId } : {}),
            ...(follows ? { follows } : {}),
          },
        }).work
      }
      const rootWorkId = parentWork.rootWorkId ?? chainWork.workId
      const children = []
      for (const peer of callees) {
        if (waitsOnMember(handle, room.id, callerBotId, peer.id, { callerWorkId: parentWork.workId })) {
          return { cycle: true, target: peer, parentWork }
        }
        const childId = `rw_call_${randomUUID()}`
        const childWork = handle.createWork({
          workId: childId,
          botId: peer.id,
          kind: 'room_work',
          logicalAddress: `room:${room.id}:${peer.id}`,
          status: 'running',
          priority: 'background',
          rootWorkId,
          parentWorkId: parentWork.workId,
          roomId: room.id,
          originKind: 'group',
          visibility: isPrivateBot(peer) ? 'private' : 'room',
          privacyScoped: isPrivateBot(peer),
          sessionId: room.sessions?.[peer.id],
          meta: {
            kind: CALL_WORK_KIND,
            roomId: room.id,
            callerBotId,
            calleeBotId: peer.id,
            parentWorkId: parentWork.workId,
            ...(follows ? { follows } : {}),
          },
        }).work
        const callRes = handle.createCall({
          callId: `rc_${randomUUID()}`,
          parentWorkId: parentWork.workId,
          childWorkId: childWork.workId,
          callerBotId,
          calleeBotId: peer.id,
          returnAddress: returnAddress ?? parentWork.logicalAddress,
          visibleScope: isPrivateBot(peer) ? 'private' : 'room',
          roomId: room.id,
          required: true,
          meta: {
            kind: CALL_WORK_KIND,
            roomId: room.id,
            ...(follows ? { follows } : {}),
          },
        })
        children.push({ peer, work: childWork, call: callRes.call })
      }
      return { cycle: false, parentWork, children }
    })
  }

  const recordParentResult = (parentWorkId, { botId, name, seq, worked = false }) => {
    const handle = writableDb()
    if (handle === null || !parentWorkId) return
    const work = handle.getWork(parentWorkId)
    if (!work || TERMINAL_STATUSES.has(work.status)) return
    handle.updateApiMeta(parentWorkId, (prev) => {
      const done = Array.isArray(prev.done) ? [...prev.done] : []
      const doneIds = Array.isArray(prev.doneIds) ? [...prev.doneIds] : []
      const results = Array.isArray(prev.results) ? [...prev.results] : []
      if (name && !done.includes(name)) done.push(name)
      if (botId && !doneIds.includes(botId)) doneIds.push(botId)
      if (Number.isInteger(seq) && !results.some(item => item.seq === seq)) {
        results.push({ name: name ?? rt.botOf(botId)?.name ?? 'Bot', botId, seq })
      }
      return {
        ...prev,
        done,
        doneIds,
        results,
        worked: prev.worked === true || worked === true,
      }
    })
  }

  const wakeSnapshotOfParent = (parentWorkId) => {
    const handle = existingDb()
    if (handle === null || handle.isClosed?.() || !parentWorkId) return undefined
    const work = handle.getWork(parentWorkId)
    if (!work) return undefined
    const state = work.apiMeta ?? {}
    const names = Array.isArray(state.done) ? state.done : []
    const results = Array.isArray(state.results) ? state.results : []
    if (names.length === 0 && results.length === 0) return undefined
    return { names: [...names], results: [...results], worked: state.worked === true }
  }

  const checkProgressStagnation = (room, workId, { callerId, calleeId, text = '', changes, failure } = {}) => {
    const handle = writableDb()
    if (handle === null || !workId) return { paused: false }
    const work = handle.getWork(workId)
    if (!work || TERMINAL_STATUSES.has(work.status)) return { paused: false }
    const root = handle.getWork(work.rootWorkId ?? work.workId) ?? work
    const workspaceDigest = changes !== undefined
      ? `changes:${digestOf(JSON.stringify(changes))}`
      : 'no-file-changes'
    const outputDigest = digestOf(String(text ?? '').trim().replace(/\s+/g, ' '))
    const errorSignature = failure?.code ?? ''
    const check = handle.recordProgressCheck({
      workId,
      unresolvedKey: `room:${room.id}:${callerId ?? 'user'}->${calleeId ?? work.botId}`,
      workspaceDigest,
      outputDigest,
      errorSignature,
      revision: root.revision,
      pauseOnStagnation: true,
    })
    if (check.paused) {
      const fromBot = callerId ? rt.botOf(callerId) : undefined
      const toBot = calleeId ? rt.botOf(calleeId) : rt.botOf(work.botId)
      say(room, {
        who: 'DS Bot',
        kind: 'notice',
        reason: 'paused',
        cause: 'no_progress',
        from: fromBot?.name ?? toBot?.name ?? 'Bot',
        about: fromBot?.id ?? toBot?.id,
        count: check.count,
        limit: check.threshold,
        names: toBot ? [toBot.name] : [],
      })
      saveSoon()
    }
    return check
  }

  // Members explicitly delegated via `delegate_work` during a group turn, keyed by exchangeId.
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

  const missedExchanges = new Set()
  const rememberMissedExchange = (exchangeId) => {
    if (typeof exchangeId !== 'string' || exchangeId === '') return
    missedExchanges.add(exchangeId)
    if (missedExchanges.size > 200) missedExchanges.delete(missedExchanges.values().next().value)
  }

  const activeWorkIdForSession = (sessionId, info) => {
    const explicit = info?.workId ?? info?.work ?? info?.batchKey
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const owner = rt.groupOwners.get(sessionId)
    if (owner === undefined) return undefined
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter?.slot?.workId !== undefined) return waiter.slot.workId
    // An ordinary user-invited room turn (`askedBy === undefined`) has no `room_call` work;
    // never steal an unrelated steered `room_call` queued for the next turn, but DO preserve
    // an open top-level `rw_caller_*` this member opened via `delegate_work` during this turn.
    if (info?.role === 'room' && info.askedBy === undefined) {
      const works = listActiveRoomWorks(owner.roomId, { botId: owner.botId })
      return works.find(w => isCallerWork(w) && openChildWaitsOf(w.workId).length > 0)?.workId
    }
    const works = listActiveRoomWorks(owner.roomId, { botId: owner.botId })
    return works.find(isCallWork)?.workId ?? works[0]?.workId
  }
  rt.activeRoomBatchKey = activeWorkIdForSession

  // Queued out-of-round child `delegate_work` relays whose `callIn()` has not opened a SQLite
  // child work yet; prevents `lateRoomReply` from settling the parent work prematurely.
  /** @type {Map<string, Set<string>>} parentWorkId -> Set<exchangeId> */
  const pendingQueuedChildRelays = new Map()
  const notePendingChildRelay = (parentWorkId, exchangeId) => {
    if (!parentWorkId || !exchangeId) return
    let set = pendingQueuedChildRelays.get(parentWorkId)
    if (set === undefined) pendingQueuedChildRelays.set(parentWorkId, set = new Set())
    set.add(exchangeId)
  }
  const clearPendingChildRelay = (parentWorkId, exchangeId) => {
    if (!parentWorkId) return
    const set = pendingQueuedChildRelays.get(parentWorkId)
    if (set === undefined) return
    if (exchangeId === undefined) pendingQueuedChildRelays.delete(parentWorkId)
    else {
      set.delete(exchangeId)
      if (set.size === 0) pendingQueuedChildRelays.delete(parentWorkId)
    }
  }
  // Bounded dedup set of delivered top-level `roomResult` parentWorkIds so replaying a queued
  // result relay after the batch closed cannot wake its caller a second time.
  const deliveredResultWakes = new Set()
  const markResultWakeDelivered = (resultWorkId) => {
    if (typeof resultWorkId !== 'string' || resultWorkId === '') return true
    if (deliveredResultWakes.has(resultWorkId)) return false
    deliveredResultWakes.add(resultWorkId)
    if (deliveredResultWakes.size > 500) deliveredResultWakes.delete(deliveredResultWakes.values().next().value)
    return true
  }

  const hasPendingChildWork = (workId) => {
    if (!workId) return false
    if ((pendingQueuedChildRelays.get(workId)?.size ?? 0) > 0) return true
    return openChildWaitsOf(workId).length > 0
  }

  const unreadChildResultsOf = (workId) => {
    const handle = existingDb()
    if (handle === null || handle.isClosed?.() || !workId) return []
    return handle.listInbox(workId, { unreadOnly: true, includeNotes: false })
      .filter(msg => msg.kind === 'result')
  }

  // Tracks the highest unread child `result` inbox seq for which this process has ALREADY
  // claimed/dispatched a synthesis wake for a nested `room_call` parent work.
  // Guarantees:
  // 1. Same-generation duplicate wakes are suppressed across concurrent await windows (`rt.save`,
  //    `postToRoom`, `turnChanges`, `memberTurn`, `watchAdoptedRoomTurn`, `settleRoomBatches`).
  // 2. When a newer generation (higher inbox seq) arrives while a synthesis slot is still `waiting`,
  //    its wake snapshot and `throughSeq` are MERGED directly into that waiting slot (1 wake, 0 loss).
  // 3. When a synthesis slot is already `speaking`, consumption is strictly bounded by its captured
  //    `slot.throughSeq`, preserving newer (`seq > throughSeq`) unread results + apiMeta for Generation 2.
  const synthesisWakeSeq = new Map()

  const maxUnreadResultSeq = (workId) => unreadChildResultsOf(workId).reduce((m, r) => Math.max(m, r.seq), 0)

  const findWaitingSynthesisSlot = (workId) => {
    if (!workId) return undefined
    for (const round of rt.roomProgress.values()) {
      if (round.closed) continue
      const slot = round.slots.findLast(s => s.workId === workId && s.resumedUpstream === true && s.status === 'waiting')
      if (slot !== undefined) return slot
    }
    return undefined
  }

  const mergeWakeIntoSlot = (slot, wake, throughSeq = 0) => {
    if (slot === undefined) return
    if (wake !== undefined) {
      if (slot.finished === undefined) {
        slot.finished = {
          names: [...(wake.names ?? [])],
          results: [...(wake.results ?? [])],
          worked: wake.worked === true,
        }
      } else {
        const mergedResults = [...new Map(
          [...(slot.finished.results ?? []), ...(wake.results ?? [])].map(r => [`${r.botId ?? ''}:${r.seq ?? ''}:${r.name ?? ''}`, r]),
        ).values()]
        slot.finished = {
          names: [...new Set([...(slot.finished.names ?? []), ...(wake.names ?? [])])],
          results: mergedResults,
          worked: slot.finished.worked === true || wake.worked === true,
        }
      }
      if (slot.finished.names.length > 0) slot.note = finishedNote(slot.finished.names)
    }
    if (Number.isInteger(throughSeq) && throughSeq > (slot.throughSeq ?? 0)) {
      slot.throughSeq = throughSeq
    }
  }

  const claimSynthesisWake = (workId, maxSeq, { wake } = {}) => {
    if (!workId || !(maxSeq > 0)) return { action: 'skip' }
    if ((synthesisWakeSeq.get(workId) ?? 0) >= maxSeq) return { action: 'skip' }
    const waitingSlot = findWaitingSynthesisSlot(workId)
    if (waitingSlot !== undefined) {
      mergeWakeIntoSlot(waitingSlot, wake, maxSeq)
      synthesisWakeSeq.set(workId, maxSeq)
      return { action: 'merged' }
    }
    synthesisWakeSeq.set(workId, maxSeq)
    return { action: 'wake' }
  }

  const releaseSynthesisWake = (workId, maxSeq) => {
    if (workId && synthesisWakeSeq.get(workId) === maxSeq) synthesisWakeSeq.delete(workId)
  }

  const consumeParentResults = (workId, maxSeq, consumedFinished) => {
    const handle = writableDb()
    if (handle === null || !workId || !(maxSeq > 0)) return
    if ((synthesisWakeSeq.get(workId) ?? 0) <= maxSeq) synthesisWakeSeq.delete(workId)
    try {
      handle.ackInbox(workId, maxSeq)
      const remainingUnread = unreadChildResultsOf(workId)
      if (remainingUnread.length === 0) {
        handle.updateApiMeta(workId, prev => ({
          ...prev,
          done: [],
          doneIds: [],
          results: [],
          worked: false,
        }))
      } else {
        const remainingDoneUnread = remainingUnread.filter(r => r.payload?.outcome === 'done')
        const consumedSeqs = new Set((consumedFinished?.results ?? []).map(r => r.seq).filter(Number.isInteger))
        const remainingDoneBotIds = new Set(remainingDoneUnread.map(r => r.senderBotId).filter(Boolean))
        handle.updateApiMeta(workId, (prev) => {
          const prevResults = Array.isArray(prev.results) ? prev.results : []
          const keptResults = prevResults.filter(r => !consumedSeqs.has(r.seq) && remainingDoneBotIds.has(r.botId))
          const keptIds = [...new Set([...remainingDoneBotIds, ...keptResults.map(r => r.botId).filter(Boolean)])]
          const keptNames = [...new Set(keptIds.map(id => rt.botOf(id)?.name).filter(Boolean))]
          return {
            ...prev,
            done: keptNames,
            doneIds: keptIds,
            results: keptResults,
            worked: keptResults.length > 0 ? prev.worked === true : false,
          }
        })
      }
    } catch { /* best-effort */ }
  }

  // Wakes a nested `room_call` parent whose fast child(ren) already finished and wrote unread
  // `result` inbox messages while the parent was still running (or across a restart).
  // Strictly idempotent per unread-result generation: always re-reads live SQLite state and
  // enforces `claimSynthesisWake` before mutating status or posting.
  async function resumeParentWithUnreadResults(room, member, work, { round, signal } = {}) {
    const handle = writableDb()
    if (handle === null || !work?.workId) return false
    const latest = handle.getWork(work.workId)
    if (!latest || TERMINAL_STATUSES.has(latest.status) || isHeldRoomStatus(latest.status)) {
      return false
    }
    if (openChildWaitsOf(latest.workId).length > 0 || handle.listWaits({ workId: latest.workId, status: 'open' }).length > 0) {
      return false
    }
    const unreadResults = unreadChildResultsOf(latest.workId)
    if (unreadResults.length === 0) return false
    const maxSeq = unreadResults.reduce((m, r) => Math.max(m, r.seq), 0)
    const wake = wakeSnapshotOfParent(latest.workId)
    if (wake === undefined || member === undefined || !room.members.includes(member.id)) {
      synthesisWakeSeq.delete(latest.workId)
      if (maxSeq > 0) {
        try { handle.ackInbox(latest.workId, maxSeq) } catch { /* best-effort */ }
      }
      const anyFailed = unreadResults.some(r => r.payload?.outcome === 'failed')
      await settleRoomCallWork(room, latest.workId, anyFailed ? 'failed' : 'stopped', { round, signal, member })
      return true
    }
    const claimed = claimSynthesisWake(latest.workId, maxSeq, { wake })
    if (claimed.action === 'skip') return false
    if (claimed.action === 'merged') {
      if (latest.status === 'queued') handle.claimReady({ workId: latest.workId, owner: 'groups:round' })
      return true
    }
    if (latest.status === 'running') handle.parkWaiting(latest.workId)
    if (latest.status === 'queued') handle.claimReady({ workId: latest.workId, owner: 'groups:round' })
    const activeRound = (round !== undefined && !round.closed) ? round : runningRound(room.id)
    if (activeRound !== undefined && !activeRound.closed) {
      callIn(activeRound, [member], finishedNote(wake.names), undefined, {
        resumeWorkId: latest.workId,
        resumeBy: latest.meta?.callerBotId,
      })
      giveResults(activeRound, member.id, wake, latest.workId, maxSeq)
      return true
    }
    const carrier = rt.botOf(wake.results.at(-1)?.botId ?? unreadResults.at(-1)?.senderBotId) ?? member
    await postToRoom(room, carrier, '', {
      late: true,
      done: true,
      askedBy: member.id,
      batch: latest.workId,
      route: roomResult(member.id, latest.workId),
      parentWorkId: latest.workId,
      wakeSnapshot: wake,
      throughSeq: maxSeq,
      resumeWorkId: latest.workId,
      resumeBy: latest.meta?.callerBotId,
    }).catch((err) => {
      if (!err?.delivered) releaseSynthesisWake(latest.workId, maxSeq)
      rt.warn('ds-bot: waking group parent %s with unread child results failed: %s', latest.workId, err)
    })
    return true
  }

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

  const activeInRoom = (room, botId, ignoreTaskId) => {
    if (room === undefined || !room.members.includes(botId)) return false
    const sessionId = room.sessions?.[botId]
    if (sessionId !== undefined) {
      const liveEntry = rt.live.get(sessionId)
      if (liveEntry?.turn !== undefined || liveEntry?.pending !== undefined) return true
      if (rt.hasSubagents?.(sessionId) === true) return true
    }
    if (rt.hasRoomTasks?.(room.id, botId, ignoreTaskId) === true) return true
    if (sessionId !== undefined && (rt.unreadOf?.(sessionId) ?? []).some(args => !missedExchanges.has(args.exchangeId))) return true
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id
      && round.slots.some(slot => slot.id === botId && (slot.status === 'waiting' || slot.status === 'speaking')))) return true
    return false
  }

  const unreadCount = (room, botId) => unseenLines(room, botId).length
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))
  const nextRoomSeq = room => (typeof room?.seq === 'number' ? room.seq + 1 : 1)

  // Settles a child `room_work` in SQLite and wakes its caller ONCE when all required waits drop to 0.
  // Enforces two root invariants synchronously before any `await`:
  // 1. Held works (`paused` / `needs_verification` / `stopping`) are NEVER overwritten unless `allowPaused: true` (explicit member exit).
  // 2. A `room_call` work with open child waits or unread child `result` inbox rows is NEVER settled `done`.
  async function settleRoomCallWork(room, workId, outcome, {
    round,
    signal,
    member,
    text = '',
    seq,
    worked = false,
    error,
    firstPost,
    allowPaused = false,
  } = {}) {
    const handle = writableDb()
    if (handle === null || !workId) return { wokenCount: 0, usedFirstPost: false }
    const work = handle.getWork(workId)
    if (!work || TERMINAL_STATUSES.has(work.status)) return { wokenCount: 0, usedFirstPost: false }
    if (!allowPaused && isHeldRoomStatus(work.status)) return { wokenCount: 0, usedFirstPost: false }
    if (outcome === 'done') {
      if (openChildWaitsOf(workId).length > 0 || handle.listWaits({ workId, status: 'open' }).length > 0) {
        handle.parkWaiting(workId)
        return { wokenCount: 0, usedFirstPost: false }
      }
      const unreadResults = unreadChildResultsOf(workId)
      if (unreadResults.length > 0) {
        await resumeParentWithUnreadResults(room, member ?? rt.botOf(work.botId), work, { round, signal, unreadResults })
        return { wokenCount: 0, usedFirstPost: false }
      }
    }
    const parentWorkId = work.parentWorkId ?? work.meta?.parentWorkId
    const callerBotId = work.meta?.callerBotId
    if (outcome === 'done' && parentWorkId) {
      recordParentResult(parentWorkId, {
        botId: member?.id ?? work.botId,
        name: member?.name ?? rt.botOf(work.botId)?.name,
        seq,
        worked,
      })
    }
    const res = handle.settleWork({
      workId,
      outcome,
      force: true,
      summary: text || undefined,
      resultRef: Number.isInteger(seq) ? `G${seq}` : undefined,
      ...(error !== undefined ? { error } : {}),
    })
    if (res.alreadyTerminal) return { wokenCount: 0, usedFirstPost: false }
    if (!disposed && rt.roomOf(room.id) === room) {
      void rt.goalSettled?.(room).catch(err => rt.warn('ds-bot: goal settle in %s failed: %s', room.name, err))
    }

    const stopped = disposed || rt.roomOf(room.id) !== room || signal?.aborted === true || round?.abort?.signal.aborted === true
    const parentWoken = res.wokenParents?.includes(parentWorkId) === true
    const parentSatisfiedWhileRunning = !parentWoken && res.satisfiedParents?.includes(parentWorkId) === true
    if (stopped && parentWorkId && !disposed) {
      const pWork = handle.getWork(parentWorkId)
      if (pWork && isCallerWork(pWork) && !TERMINAL_STATUSES.has(pWork.status) && openChildWaitsOf(parentWorkId).length === 0) {
        const lastSeq = handle.listInbox(parentWorkId, { unreadOnly: true }).at(-1)?.seq
        handle.settleWork({ workId: parentWorkId, outcome: 'stopped', force: true, ...(lastSeq !== undefined ? { ackThroughSeq: lastSeq } : {}), summary: 'Group round stopped' })
      }
      return { wokenCount: 0, usedFirstPost: false }
    }
    if (stopped || !parentWorkId || (!parentWoken && !parentSatisfiedWhileRunning)) {
      return { wokenCount: 0, usedFirstPost: false }
    }

    const parentWork = handle.getWork(parentWorkId)
    if (!parentWork || TERMINAL_STATUSES.has(parentWork.status)) return { wokenCount: 0, usedFirstPost: false }
    const caller = rt.botOf(parentWork.botId ?? callerBotId)
    const wake = wakeSnapshotOfParent(parentWorkId)
    const inRound = round !== undefined && !round.closed
    const isNestedUpstream = isCallWork(parentWork)

    // Fast child finished while its nested parent is STILL running Turn 1:
    // - Inside an active round, queue the resumed Turn 2 slot right away (held by `startable` until Turn 1 finishes).
    // - Outside a round (or if no peer succeeded), leave the unread `result` inbox row for the parent's
    //   end-of-turn handler (`watchAdoptedRoomTurn` / `memberTurn`) so we never unwind a running turn mid-flight.
    if (parentSatisfiedWhileRunning) {
      if (parentWork.status === 'running' && inRound && wake !== undefined && caller !== undefined && room.members.includes(caller.id)) {
        const wakeSeq = isNestedUpstream ? maxUnreadResultSeq(parentWorkId) : 0
        if (isNestedUpstream && wakeSeq > 0) {
          const claimed = claimSynthesisWake(parentWorkId, wakeSeq, { wake })
          if (claimed.action === 'skip') return { wokenCount: 0, usedFirstPost: false }
          if (claimed.action === 'merged') {
            expandScopedReports(room.id, member?.id ?? work.botId, [caller])
            return { wokenCount: 0, usedFirstPost: false }
          }
        }
        expandScopedReports(room.id, member?.id ?? work.botId, [caller])
        callIn(round, [caller], finishedNote(wake.names), undefined, isNestedUpstream
          ? { resumeWorkId: parentWorkId, resumeBy: parentWork.meta?.callerBotId }
          : { resultOnly: true })
        giveResults(round, caller.id, wake, isNestedUpstream ? parentWorkId : undefined, wakeSeq)
        return { wokenCount: 1, usedFirstPost: false }
      }
      return { wokenCount: 0, usedFirstPost: false }
    }

    // No peer succeeded (all failed/stopped/passed): unwind nested upstream calls without waking caller for empty results.
    if (wake === undefined || caller === undefined || !room.members.includes(caller.id)) {
      if (isCallWork(parentWork)) {
        return settleRoomCallWork(room, parentWorkId, outcome === 'failed' ? 'failed' : 'stopped', { round, signal, member: caller })
      }
      handle.stopWork(parentWorkId, { reason: 'All child room calls ended without results' })
      return { wokenCount: 0, usedFirstPost: false }
    }

    const wakeSeq = isNestedUpstream ? maxUnreadResultSeq(parentWorkId) : 0
    if (!isNestedUpstream) {
      // Top-level fan-out parent has collected all results; settle it and ack its inbox so
      // `unreadOf` / `activeInRoom` never see stale unread results on the terminal work.
      const lastSeq = handle.listInbox(parentWorkId, { unreadOnly: true }).at(-1)?.seq
      handle.settleWork({
        workId: parentWorkId,
        outcome: 'done',
        force: true,
        ...(lastSeq !== undefined ? { ackThroughSeq: lastSeq } : {}),
        summary: `Collected ${wake.names.join(', ')}`,
      })
    } else {
      // Consume the SQLite `ready` token for the nested `room_work` since the group round
      // drives its synthesis turn directly (prevents `dsh-adapter.js` double-dispatch).
      handle.claimReady({ workId: parentWorkId, owner: 'groups:round' })
      if (wakeSeq > 0) {
        const claimed = claimSynthesisWake(parentWorkId, wakeSeq, { wake })
        if (claimed.action === 'skip') return { wokenCount: 0, usedFirstPost: false }
        if (claimed.action === 'merged') {
          if (inRound) expandScopedReports(room.id, member?.id ?? work.botId, [caller])
          return { wokenCount: 0, usedFirstPost: false }
        }
      }
    }

    if (inRound) {
      expandScopedReports(room.id, member?.id ?? work.botId, [caller])
      callIn(round, [caller], finishedNote(wake.names), undefined, isNestedUpstream
        ? { resumeWorkId: parentWorkId, resumeBy: parentWork.meta?.callerBotId }
        : { resultOnly: true })
      giveResults(round, caller.id, wake, isNestedUpstream ? parentWorkId : undefined, wakeSeq)
      return { wokenCount: 1, usedFirstPost: false }
    }

    const custom = typeof firstPost === 'function' ? firstPost(parentWork) : undefined
    const carrier = custom !== undefined
      ? (member ?? rt.botOf(work.botId))
      : (rt.botOf(work.botId) ?? member)
    if (carrier === undefined) {
      if (isNestedUpstream && wakeSeq > 0) releaseSynthesisWake(parentWorkId, wakeSeq)
      return { wokenCount: 0, usedFirstPost: false }
    }
    const body = custom?.text ?? ''
    const extra = {
      ...(custom?.extra ?? { late: true, done: true }),
      askedBy: caller.id,
      batch: parentWorkId,
      route: roomResult(caller.id, parentWorkId),
      parentWorkId,
      wakeSnapshot: wake,
      ...(isNestedUpstream && wakeSeq > 0 ? { throughSeq: wakeSeq } : {}),
      ...(isNestedUpstream ? { resumeWorkId: parentWorkId, resumeBy: parentWork.meta?.callerBotId } : { resultOnly: true }),
    }
    await postToRoom(room, carrier, body, extra)
      .catch((err) => {
        if (isNestedUpstream && wakeSeq > 0 && !err?.delivered) releaseSynthesisWake(parentWorkId, wakeSeq)
        rt.warn('ds-bot: waking group caller in %s failed: %s', room.name, err)
      })
    return { wokenCount: 1, usedFirstPost: custom !== undefined }
  }

  async function exitMemberRoomCalls(room, botId, { round, signal, member = rt.botOf(botId), outcome = 'stopped', firstPost } = {}) {
    const works = listActiveRoomWorks(room.id, { botId }).filter(isCallWork)
    let wokenCount = 0
    let usedFirstPost = false
    for (let i = 0; i < works.length; i += 1) {
      const res = await settleRoomCallWork(room, works[i].workId, outcome, {
        round,
        signal,
        member,
        firstPost: i === 0 ? firstPost : undefined,
        allowPaused: true,
      })
      wokenCount += res.wokenCount
      usedFirstPost ||= res.usedFirstPost
    }
    return { wokenCount, usedFirstPost }
  }

  const roomReports = createRoomReports(rt, {
    hasActiveRoomCalls,
    exitMemberRoomCalls: (room, botId) => exitMemberRoomCalls(room, botId),
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

  // Dedicated group-owned adoption monitors for `queued` / `running` room_work deliveries
  // recovered across restarts. Never registers into `dsh-adapter`'s generic `activeClaims`
  // so group completion/yield ALWAYS flows through `settleRoomCallWork` / `needs_verification`.
  const adoptedRoomMonitors = new Map()
  const matchesKey = (source, key) => Boolean(
    source && typeof source === 'object' && key
    && (source.idempotencyKey === key || source.rpcId === key || source.exchangeId === key),
  )
  const assistantTextOf = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
  }

  async function applyRoomDeliveryStatus(room, member, work, sessionId, deliveryStatus, wokenThisPass) {
    const handle = writableDb()
    if (handle === null) return true
    const latest = handle.getWork(work.workId)
    if (!latest || TERMINAL_STATUSES.has(latest.status) || isHeldRoomStatus(latest.status)) return true
    const hasOpenWaits = handle.listWaits({ workId: work.workId, status: 'open' }).length > 0
    if (deliveryStatus?.status === 'yielded' || deliveryStatus?.yielded === true
      || (deliveryStatus?.status === 'completed' && hasOpenWaits)) {
      // Never settle a yielded turn (or one with open waits) as `done`: it paused for approval, ask_back, or sub-work.
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: 'yielded_before_restart',
        detail: {
          sessionId,
          turn: deliveryStatus.turn ?? null,
          hasOpenWaits,
          assistantText: String(deliveryStatus.assistantText ?? '').slice(0, 300),
        },
      })
      return true
    }
    const unreadResults = hasOpenWaits ? [] : unreadChildResultsOf(work.workId)
    if (deliveryStatus?.status === 'completed' && unreadResults.length > 0) {
      const recoveredText = stripOwnName(member.name, String(deliveryStatus.assistantText ?? '').trim())
      if (recoveredText && !isPass(recoveredText)) {
        say(room, { who: member.name, botId: member.id, text: recoveredText, route: roomVisible() })
      }
      wokenThisPass?.add(work.workId)
      await resumeParentWithUnreadResults(room, member, work, { unreadResults })
      return true
    }
    if (deliveryStatus?.status === 'completed') {
      const recoveredText = stripOwnName(member.name, String(deliveryStatus.assistantText ?? '').trim())
      const record = recoveredText && !isPass(recoveredText)
        ? say(room, { who: member.name, botId: member.id, text: recoveredText })
        : undefined
      const res = await settleRoomCallWork(room, work.workId, 'done', {
        member,
        text: recoveredText,
        seq: record?.seq,
        worked: (deliveryStatus.toolCalls ?? 0) > 0,
      })
      if (res.wokenCount > 0 && work.parentWorkId) wokenThisPass?.add(work.parentWorkId)
      return true
    }
    if (deliveryStatus?.status === 'claimed'
      || (deliveryStatus?.status === 'aborted' && deliveryStatus.consumed !== true && deliveryStatus.turn !== undefined)) {
      // Crash occurred after `inbox.claim()` inside `turn/start` before `user/message` committed:
      // fail closed to `needs_verification` instead of silently marking the delegation `stopped`.
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: 'claimed_before_restart',
        detail: {
          sessionId,
          deliveryStatus: deliveryStatus.status,
          turn: deliveryStatus.turn ?? null,
        },
      })
      return true
    }
    if (deliveryStatus?.status === 'aborted' && deliveryStatus.consumed === true) {
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: Array.isArray(deliveryStatus.interruptedTools) && deliveryStatus.interruptedTools.length > 0
          ? 'interrupted_tools'
          : 'interrupted_turn',
        detail: {
          sessionId,
          interruptedTools: deliveryStatus.interruptedTools ?? [],
          turn: deliveryStatus.turn ?? null,
        },
      })
      return true
    }
    if (deliveryStatus?.status === 'failed') {
      await settleRoomCallWork(room, work.workId, 'failed', {
        member,
        error: { code: 'room/delivery-failed', message: deliveryStatus.error ?? 'Group member turn failed before restart' },
      })
      return true
    }
    return false
  }

  function watchAdoptedRoomTurn(room, member, work, sessionId, deliveryKey, initialTurn) {
    if (adoptedRoomMonitors.has(work.workId)) return
    let matchedTurn = Number.isInteger(initialTurn) ? initialTurn : undefined
    let openTurn
    let lastText = ''
    let worked = false
    let settled = false

    const cleanup = () => {
      const off = adoptedRoomMonitors.get(work.workId)
      if (off) {
        adoptedRoomMonitors.delete(work.workId)
        try { off() } catch { /* ignore */ }
      }
    }

    const off = ctx.on('session/event', (session, event) => {
      if (settled || disposed || session?.id !== sessionId) return
      if (event.type === 'turn/start') {
        openTurn = event.data?.turn
        if (matchedTurn !== undefined && openTurn === matchedTurn) {
          lastText = ''
          worked = false
        }
        return
      }
      if (event.type === 'user/message') {
        if (matchedTurn === undefined && deliveryKey && matchesKey(event.data?.source, deliveryKey)) {
          matchedTurn = openTurn
          lastText = ''
          worked = false
          if (Number.isInteger(matchedTurn)) {
            try { writableDb()?.recordActiveTurn?.(work.workId, matchedTurn) } catch { /* best-effort */ }
          }
        }
        return
      }
      if (matchedTurn === undefined || openTurn !== matchedTurn) return
      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
        if (isWorkTool(String(event.data?.name ?? ''))) worked = true
        return
      }
      if (event.type === 'assistant/message') {
        const text = assistantTextOf(event.data?.message?.content).trim()
        if (text !== '') lastText = text
        return
      }
      if (event.type === 'turn/end' && event.data?.turn === matchedTurn) {
        settled = true
        cleanup()
        const reason = event.data?.reason
        const handle = writableDb()
        if (handle === null) return
        const latest = handle.getWork(work.workId)
        if (!latest || TERMINAL_STATUSES.has(latest.status) || isHeldRoomStatus(latest.status)) return
        if (reason?.kind === 'yielded' || rt.wasFallbackYielded?.(sessionId, matchedTurn)) {
          handle.pauseWork(work.workId, {
            status: 'needs_verification',
            reason: 'yielded_after_restart',
            detail: { sessionId, turn: matchedTurn },
          })
          return
        }
        if (reason?.kind === 'error' || reason?.kind === 'blocked') {
          void settleRoomCallWork(room, work.workId, 'failed', {
            member,
            error: {
              code: reason.error?.code ?? 'room/delivery-failed',
              message: reason.error?.message ?? 'Adopted group member turn failed',
            },
          }).catch(err => rt.warn?.('ds-bot: settling failed adopted room work %s failed: %s', work.workId, err))
          return
        }
        if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
          handle.pauseWork(work.workId, {
            status: 'needs_verification',
            reason: 'interrupted_turn',
            detail: { sessionId, turn: matchedTurn, cancelCause: reason.reason?.kind ?? null },
          })
          return
        }
        const recoveredText = stripOwnName(member.name, lastText)
        const hasPendingChild = hasPendingChildWork(work.workId)
          || handle.listWaits({ workId: work.workId, status: 'open' }).length > 0
        if (hasPendingChild) {
          // Adopted member delegated nested child work or opened a wait during this turn:
          // record any visible progress text, park the work in `waiting`, and NEVER settle `done` early.
          if (recoveredText && !isPass(recoveredText)) {
            say(room, { who: member.name, botId: member.id, text: recoveredText, route: roomVisible() })
          }
          handle.parkWaiting?.(work.workId)
          return
        }
        const unreadResults = unreadChildResultsOf(work.workId)
        if (unreadResults.length > 0) {
          // Fast child(ren) already settled while this adopted turn was still running:
          // record visible progress and wake this parent for its synthesis turn instead of settling `done`!
          if (recoveredText && !isPass(recoveredText)) {
            say(room, { who: member.name, botId: member.id, text: recoveredText, route: roomVisible() })
          }
          void resumeParentWithUnreadResults(room, member, work, { unreadResults })
            .catch(err => rt.warn?.('ds-bot: resuming adopted room work %s with fast child results failed: %s', work.workId, err))
          return
        }
        const record = recoveredText && !isPass(recoveredText)
          ? say(room, { who: member.name, botId: member.id, text: recoveredText })
          : undefined
        void settleRoomCallWork(room, work.workId, 'done', {
          member,
          text: recoveredText,
          seq: record?.seq,
          worked,
        }).catch(err => rt.warn?.('ds-bot: settling adopted room work %s failed: %s', work.workId, err))
      }
    })
    adoptedRoomMonitors.set(work.workId, off)
  }

  async function adoptGroupRoomDelivery(room, member, work, sessionId, query, deliveryStatus) {
    const handle = writableDb()
    if (handle === null) return
    let agent
    try {
      await rt.ensureCapabilities?.(sessionId)
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn?.('ds-bot: adopting group room work %s on %s failed: %s', work.workId, sessionId, error?.message ?? error)
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: 'delivery_adoption_failed',
        detail: { sessionId, error: String(error?.message ?? error).slice(0, 300) },
      })
      return
    }

    if (deliveryStatus?.status === 'queued') {
      const key = work.activeDeliveryKey
      const nextStepHit = (agent.inbox?.nextStep ?? []).find(m => matchesKey(m?.source, key))
      const nextTurnHit = nextStepHit ? undefined : (agent.inbox?.nextTurn ?? []).find(m => matchesKey(m?.source, key))
      const parked = nextStepHit ?? nextTurnHit
      const target = nextStepHit ? 'next-step' : 'next-turn'
      if (parked !== undefined) {
        // Attach the group-owned observer BEFORE waking the parked message so its `turn/end`
        // settles strictly through `settleRoomCallWork` (never generic `dsh-adapter` `activeClaims`).
        watchAdoptedRoomTurn(room, member, work, sessionId, key, undefined)
        const msg = createUserMessage({ content: parked.content, source: parked.source })
        const caps = rt.dshCapabilities?.(agent)
        if (caps?.idempotency && typeof agent.send === 'function') {
          agent.send(msg, target, true, { idempotencyKey: key })
        } else {
          agent.inbox?.remove?.(parked.id)
          if (target === 'next-step' && typeof agent.steer === 'function') agent.steer(msg)
          else agent.followup(msg)
        }
        await ctx.sessions?.flush?.(agent.session)
        return
      }
      // Message left inbox between cold D2 check and hydration: re-query D2 and apply group rules.
      let rechecked
      try {
        rechecked = await rt.queryDeliveryStatus(sessionId, query)
      } catch (error) {
        handle.pauseWork(work.workId, {
          status: 'needs_verification',
          reason: 'delivery_status_unreadable',
          detail: { sessionId, error: String(error?.message ?? error).slice(0, 300) },
        })
        return
      }
      if (await applyRoomDeliveryStatus(room, member, work, sessionId, rechecked)) return
      if (rechecked?.status === 'running' && agent.status === 'running') {
        watchAdoptedRoomTurn(room, member, work, sessionId, key, rechecked.turn)
        return
      }
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: 'delivery_state_ambiguous',
        detail: { sessionId, status: rechecked?.status ?? null },
      })
      return
    }

    if (deliveryStatus?.status === 'running') {
      if (agent.status === 'running') {
        watchAdoptedRoomTurn(room, member, work, sessionId, work.activeDeliveryKey, deliveryStatus.turn)
        return
      }
      // Agent is idle after restart: re-check cold D2 with liveStatus='idle' to classify cleanly.
      let rechecked
      try {
        rechecked = await rt.queryDeliveryStatus(sessionId, query, { liveStatus: 'idle' })
      } catch (error) {
        handle.pauseWork(work.workId, {
          status: 'needs_verification',
          reason: 'delivery_status_unreadable',
          detail: { sessionId, error: String(error?.message ?? error).slice(0, 300) },
        })
        return
      }
      if (await applyRoomDeliveryStatus(room, member, work, sessionId, rechecked)) return
      handle.pauseWork(work.workId, {
        status: 'needs_verification',
        reason: 'interrupted_turn',
        detail: { sessionId, turn: rechecked?.turn ?? deliveryStatus.turn ?? null },
      })
    }
  }

  // Startup reconciliation of persisted `room_work` call rows in `coordination.sqlite`.
  // Uses cold DSH D2 `queryDeliveryStatus` whenever a durable delivery key was recorded so
  // restarts recover completed results, adopt queued/running turns via group-owned observers,
  // or visibly pause yielded/interrupted work as `needs_verification` instead of blindly stopping.
  rt.settleRoomBatches = async () => {
    if (typeof rt.hasExistingCoordDb === 'function' && !rt.hasExistingCoordDb()) return
    const handle = writableDb()
    if (handle === null) return
    const active = handle.listWorks({ kind: 'room_work', activeOnly: true, limit: 500 }).filter(isDelegationWork)
    // Reconcile leaf `room_call` works before nested parents and top-level callers so a child
    // recovered in this pass can wake its waiting parent before the parent is inspected.
    active.sort((a, b) => {
      const rank = (w) => {
        if (isCallerWork(w)) return 2
        return openChildWaitsOf(w.workId).length > 0 ? 1 : 0
      }
      return rank(a) - rank(b)
    })
    const wokenThisPass = new Set()
    for (const snapshot of active) {
      const work = handle.getWork(snapshot.workId)
      if (!work || TERMINAL_STATUSES.has(work.status)) continue
      if (isHeldRoomStatus(work.status)) continue
      const room = rt.roomOf(work.roomId)
      const member = rt.botOf(work.botId)
      if (room === undefined || member === undefined) {
        handle.stopWork(work.workId, { reason: 'Group or member no longer exists' })
        continue
      }
      if (isCallWork(work)) {
        if (!room.members.includes(work.botId)) {
          await settleRoomCallWork(room, work.workId, 'stopped', { member, allowPaused: true })
          continue
        }
        const memberSession = work.sessionId ?? room.sessions?.[work.botId]
        const liveBusy = (memberSession !== undefined && (rt.live.get(memberSession)?.turn !== undefined || rt.hasSubagents?.(memberSession) === true || rt.waitsForApproval?.(memberSession) === true))
          || rt.hasRoomTasks?.(room.id, work.botId) === true
        if (liveBusy || adoptedRoomMonitors.has(work.workId) || wokenThisPass.has(work.workId)) continue
        const unreadBeforeProbe = unreadChildResultsOf(work.workId)
        if (openChildWaitsOf(work.workId).length === 0 && unreadBeforeProbe.length > 0) {
          wokenThisPass.add(work.workId)
          await resumeParentWithUnreadResults(room, member, work, { unreadResults: unreadBeforeProbe })
          continue
        }
        if (activeInRoom(room, work.botId)) continue
        const sessionId = memberSession
        const query = work.activeDeliveryKey
          ? { idempotencyKey: work.activeDeliveryKey }
          : (Number.isInteger(work.activeTurn) ? { turn: work.activeTurn } : undefined)
        if (sessionId && query && typeof rt.queryDeliveryStatus === 'function') {
          let deliveryStatus
          try {
            deliveryStatus = await rt.queryDeliveryStatus(sessionId, query)
          } catch (error) {
            rt.warn?.('ds-bot: room work %s cold delivery status unreadable: %s', work.workId, error?.message ?? error)
            handle.pauseWork(work.workId, {
              status: 'needs_verification',
              reason: 'delivery_status_unreadable',
              detail: {
                sessionId,
                error: String(error?.message ?? error).slice(0, 300),
              },
            })
            continue
          }
          if (await applyRoomDeliveryStatus(room, member, work, sessionId, deliveryStatus, wokenThisPass)) continue
          if (deliveryStatus?.status === 'queued' || deliveryStatus?.status === 'running') {
            await adoptGroupRoomDelivery(room, member, work, sessionId, query, deliveryStatus)
            continue
          }
        }
        // A nested `room_call` work that parked in `waiting` after delegating child work
        // (or already received unread child results before/during restart) has no active delivery
        // key/turn because it is waiting on its children or ready to run its synthesis turn.
        if (openChildWaitsOf(work.workId).length > 0) {
          if (work.status === 'running') handle.parkWaiting(work.workId)
          continue
        }
        const unreadResults = unreadChildResultsOf(work.workId)
        if (unreadResults.length > 0) {
          wokenThisPass.add(work.workId)
          await resumeParentWithUnreadResults(room, member, work, { unreadResults })
          continue
        }
        await settleRoomCallWork(room, work.workId, 'stopped', { member })
      } else if (isCallerWork(work) && openChildWaitsOf(work.workId).length === 0) {
        handle.stopWork(work.workId, { reason: 'Orphaned caller room work after restart' })
      }
    }
  }

  const finishedNote = names => `${names.join(' and ')} finished the work you asked for`
  const giveResults = (round, botId, wake, workId, throughSeq = 0) => {
    const slot = (workId !== undefined
      ? round.slots.findLast(other => other.id === botId && other.status === 'waiting' && other.workId === workId)
      : undefined)
      ?? round.slots.findLast(other => other.id === botId && other.status === 'waiting')
    if (slot === undefined) return
    mergeWakeIntoSlot(slot, wake, throughSeq)
  }

  // ---------------------------------------------------------------------------
  // Prompt building & round execution.

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
      : slot.workId !== undefined
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

  async function finishedLines(room, slot) {
    if (slot.finished === undefined) return { results: [], quiet: [] }
    const results = [...new Map((slot.finished.results ?? []).map(result => [result.seq, result])).values()].sort((a, b) => a.seq - b.seq)
    const inLog = new Map(room.log.map(line => [line.seq, line]))
    return {
      results: await Promise.all(results.map(async ({ name, seq }) => ({ name, seq, line: inLog.get(seq) ?? await rt.groupLine(room.id, seq).catch(() => undefined) }))),
      quiet: [...new Set(slot.finished.names ?? [])].filter(name => !results.some(result => result.name === name)),
    }
  }

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

  const postInRound = (room, member, text, duration, claims, changes, route = roomVisible(), files = []) => {
    say(room, { who: member.name, botId: member.id, text, route, ...(duration === undefined ? {} : { duration }), ...(claims === undefined ? {} : { claims }), ...(changes === undefined ? {} : { changes }), ...(files.length > 0 ? { presented: files } : {}) })
    saveSoon()
    return room.seq
  }

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

  async function roomTurn(room, member, sessionId, { text, images = [], files = [], meta }, note, signal, round, slot, said = [], heard = () => {}, onWork = () => {}, onTurn = () => {}, onDelivered = () => {}) {
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
    const seenAt = room.seq
    const busy = rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true
    let deliveryKey
    if (slot.workId !== undefined) {
      deliveryKey = `room-call:${slot.workId}:${exchangeId}`
      const handle = writableDb()
      if (handle !== null) {
        try {
          handle.recordDirectDeliveryAttempt({
            workId: slot.workId,
            idempotencyKey: deliveryKey,
            sessionId,
            ...(Number.isInteger(slot.throughSeq) ? { throughSeq: slot.throughSeq } : {}),
          })
        } catch (error) {
          if (error?.code === 'coordination/work_paused') {
            // Preserve the original `paused` / `needs_verification` status and reason untouched.
            const idx = started.indexOf(turn)
            if (idx !== -1) started.splice(idx, 1)
            return null
          }
          // Fail closed: never deliver into DSH without a durable delivery key in SQLite.
          rt.warn?.('ds-bot: persisting delivery attempt for room work %s failed: %s', slot.workId, error?.message ?? error)
          try {
            handle.pauseWork(slot.workId, {
              status: 'needs_verification',
              reason: 'delivery_attempt_unpersisted',
              detail: { sessionId, error: String(error?.message ?? error).slice(0, 300) },
            })
          } catch { /* best-effort */ }
          const idx = started.indexOf(turn)
          if (idx !== -1) started.splice(idx, 1)
          return { failure: { code: 'COORDINATION', message: String(error?.message ?? error).slice(0, 300) } }
        }
      }
    }
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
      const touchWorkGrace = (tool) => {
        if (!INSTANT_WORK_TOOLS.has(tool)) grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS)
      }
      const work = (tool) => {
        onWork()
        touchWorkGrace(tool)
      }
      const onStepSay = (raw) => {
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
        setTurn: (turnNumber) => {
          if (Number.isInteger(turnNumber)) {
            if (slot.workId !== undefined) {
              try { writableDb()?.recordActiveTurn?.(slot.workId, turnNumber) } catch { /* best-effort */ }
            }
            onTurn(turnNumber)
          }
        },
        touch, touchWorkGrace, work, say: onStepSay,
        approval: () => finish({ approval: true }),
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await rt.deliver({
        fromId: undefined,
        toId: member.id,
        sessionId,
        role: 'room',
        roomId: room.id,
        exchangeId,
        ...(deliveryKey ? { idempotencyKey: deliveryKey } : {}),
        note,
        text,
        images,
        files,
        steer: busy,
        ...(by ? { askedBy: by } : {}),
        ...(slot.resultRef ? { resultRef: slot.resultRef } : {}),
        ...(slot.workId ? { work: slot.workId, batchKey: slot.workId } : {}),
        ...(slot.resumedUpstream ? { resumedUpstream: true } : {}),
      })
      room.seen[member.id] = seenAt
      if (meta !== undefined) rt.contextRuntime?.setGroupMeta?.(sessionId, meta, { persist: false })
      onDelivered()
      if (rt.state.questions[sessionId] !== undefined || rt.state.views[sessionId] !== undefined) rt.roomWaiters.get(exchangeId)?.resolve({ answer: true })
      else if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      const lost = lostSession(error)
      if (lost && room.sessions?.[member.id] === sessionId) {
        rt.retireGroupSession(room, member.id)
        saveSoon()
      }
      rt.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    const liveSid = room.sessions?.[member.id] ?? sessionId
    if ((typeof reply === 'string' || reply?.failure !== undefined || reply?.left === true) && !rt.hasSubagents?.(liveSid) && !rt.hasRoomTasks?.(room.id, member.id)) {
      const idx = started.indexOf(turn)
      if (idx !== -1) started.splice(idx, 1)
    }
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

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
  // Starting a slow work tool arms the 15s grace timer without clearing idle streaks;
  // only a successful tool result (`workRoomTurn`) proves real progress.
  rt.touchRoomWorkGrace = (sessionId, tool) => {
    if (!isWorkTool(tool)) return
    for (const waiter of waitersOf(sessionId)) waiter.touchWorkGrace?.(tool)
  }
  // Any substantive work tool (`isWorkTool`) that completed without error records real
  // progress and clears idle streaks; instantaneous meta mutations skip the 15s grace timer.
  rt.workRoomTurn = (sessionId, tool) => {
    if (!isWorkTool(tool)) return
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.work(tool)
  }
  rt.nudgeRoom = (roomId) => {
    for (const round of rt.roomProgress.values()) {
      if (round.roomId === roomId) setImmediate(() => round.nudge?.())
    }
  }

  // Schedules speakers into a running round:
  // - `invite` (user / kickoff / goal): `by === undefined`, creates NO SQLite `call`.
  // - `call` (explicit Bot delegation): `by !== undefined`, creates SQLite `room_work + calls + waits`.
  // - `result` (waking caller after all waits resolved): `resultOnly: true` or `resumeWorkId`, creates NO new `call`.
  function callIn(round, callees, note, by, {
    ordered = false,
    resultOnly = false,
    parentWorkId,
    callerExchangeId,
    follows,
    returnAddress,
    resumeWorkId,
    resumeBy,
    existingChildren,
  } = {}) {
    if (callees.length === 0) return { ok: true }
    const room = rt.roomOf(round.roomId)
    let childWorkByBot = existingChildren
    if (by !== undefined && !resultOnly && resumeWorkId === undefined && childWorkByBot === undefined && room !== undefined) {
      const opened = openRoomCall(room, by, callees, { parentWorkId, callerExchangeId, follows, returnAddress })
      if (opened?.cycle === true) {
        return { cycle: true, target: opened.target }
      }
      if (opened?.children) {
        childWorkByBot = new Map(opened.children.map(item => [item.peer.id, item.work.workId]))
      }
    }
    round.batches = (round.batches ?? 0) + 1
    const effectiveBy = resumeWorkId !== undefined ? resumeBy : by
    let last
    for (const peer of callees) {
      const workId = resumeWorkId ?? childWorkByBot?.get(peer.id)
      const waiting = round.slots.findIndex(slot => slot.id === peer.id
        && slot.status === 'waiting'
        && (workId === undefined || slot.workId === undefined || slot.workId === workId))
      if (resultOnly && waiting !== -1) continue
      const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
      const slot = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots[waiting]
      if (resumeWorkId !== undefined) {
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
      if (workId !== undefined) slot.workId = workId
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
    return { ok: true }
  }

  const startable = (round, slot) => {
    if (slot.status !== 'waiting' || round.slots.some(other => other.id === slot.id && other.status === 'speaking')) return false
    if (!slot.ordered) return true
    const at = round.slots.indexOf(slot)
    return round.slots.every((other, index) => !other.ordered || other === slot || (other.status !== 'speaking' && !(other.status === 'waiting' && index < at)))
  }

  // Defense-in-depth store for resumed work IDs across group_relay turns.
  const pendingResumedRoomWorks = new Map()
  const takePendingResumedWorks = (exchangeId) => {
    if (typeof exchangeId !== 'string' || exchangeId === '') return undefined
    const ids = pendingResumedRoomWorks.get(exchangeId)
    if (ids !== undefined) pendingResumedRoomWorks.delete(exchangeId)
    return ids
  }

  // Resumes any paused `room_work` rows (including the room's chain anchor) in SQLite when
  // the user writes a message or clicks Continue. Always consumes `ready` tokens so
  // `dsh-adapter.js` never dispatches a group delegation outside `group_relay`.
  const resumePausedRoomWorks = (room, round, { reason = 'user_resume', workId } = {}) => {
    const handle = writableDb()
    if (handle === null || room === undefined) return 0
    const paused = handle.listWorks({ kind: 'room_work', roomId: room.id, statuses: ['paused', 'needs_verification'], limit: 200 })
      .filter(work => (isDelegationWork(work) || isChainWork(work)) && (workId === undefined || work.workId === workId))
    if (paused.length === 0) {
      if (reason === 'user_message' || reason === 'goal_resume') resetRoomChainProgress(room)
      return 0
    }
    let resumedCount = 0
    const resumedCalls = []
    const claimedIds = new Set()
    for (const work of paused) {
      const res = handle.resumeWork(work.workId, { resumeChain: true, resetProgress: true, reason })
      if (!res.resumed) continue
      resumedCount += 1
      for (const qId of res.queuedWorkIds ?? []) {
        if (claimedIds.has(qId)) continue
        claimedIds.add(qId)
        const queuedWork = handle.getWork(qId)
        if (!queuedWork || isReportWork(queuedWork)) continue
        if (isChainWork(queuedWork)) {
          parkChainWorkIdle(handle, qId)
        } else if (isCallWork(queuedWork)) {
          handle.claimReady({ workId: qId, owner: 'groups:round' })
          resumedCalls.push(queuedWork)
        } else if (isCallerWork(queuedWork)) {
          handle.settleWork({ workId: qId, outcome: 'done', force: true, summary: 'Resumed after pause' })
        }
      }
    }
    if (round !== undefined && resumedCalls.length > 0) {
      for (const work of resumedCalls) {
        const peer = rt.botOf(work.botId)
        if (peer === undefined || !room.members.includes(peer.id)) continue
        callIn(round, [peer], 'the user continued after a pause', work.meta?.callerBotId, {
          existingChildren: new Map([[peer.id, work.workId]]),
        })
      }
    }
    return resumedCount
  }

  // Kept for `goals.js` compatibility (resets stagnation on active room works when goal resumes).
  rt.clearRoomIdleStreak = (roomId) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return
    resumePausedRoomWorks(room, runningRound(room.id), { reason: 'goal_resume' })
  }

  async function resumeRoomPause(roomId, { workId } = {}) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const handle = writableDb()
    if (handle === null) return false
    const paused = handle.listWorks({ kind: 'room_work', roomId: room.id, statuses: ['paused', 'needs_verification'], limit: 200 })
      .filter(work => (isDelegationWork(work) || isChainWork(work)) && (workId === undefined || work.workId === workId))
    const hadIdlePause = room.idlePaused !== undefined
    if (paused.length === 0 && !hadIdlePause) return false
    if (hadIdlePause) {
      delete room.idlePaused
      delete room.idleRelays
      delete room.idleEdges
      await rt.save()
    }
    if (paused.length === 0) return true
    const running = runningRound(room.id)
    if (running !== undefined && !running.starting && !running.closed) {
      resumePausedRoomWorks(room, running, { reason: 'user_continue', workId })
      running.nudge?.()
      return true
    }
    const resumedCalls = paused.filter(isCallWork)
    resumePausedRoomWorks(room, undefined, { reason: 'user_continue', workId })
    if (resumedCalls.length > 0) {
      const exchangeId = randomUUID()
      const resumedWorkIds = resumedCalls.map(w => w.workId)
      pendingResumedRoomWorks.set(exchangeId, resumedWorkIds)
      if (pendingResumedRoomWorks.size > 200) pendingResumedRoomWorks.delete(pendingResumedRoomWorks.keys().next().value)
      const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[Group chat · user continued paused calls]' }],
        source: {
          kind: SOURCE_KIND,
          form: 'relay',
          role: 'post',
          exchangeId,
          roomId: room.id,
          resumedPause: true,
          resumedWorkIds,
        },
      }))
      await ctx.sessions.flush(agent.session)
    }
    return true
  }
  rt.resumeRoomPause = resumeRoomPause

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

  function drainRoomInbox(room, round, agent) {
    if (round.kickoff) return
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return
    const roomSid = rt.sessionOfRoom(room)
    round.userMessage = true
    rt.goalUserMessage?.(room.id)
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      const classified = rt.classifyRoomUserSource?.(roomSid, line.source)
      if (classified?.ignored !== true) {
        const origin = classified !== undefined ? classified.origin : (viaIsIm(line.via) ? rt.captureImOrigin?.(roomSid) : undefined)
        noteRoomUserOrigin(room, origin)
      }
      say(room, { who: 'User', text: line.text, ...(line.via ? { via: line.via } : {}) })
      const mentions = mentionsIn(line.text, members)
      const invite = resolveUserInvite({ members, adminId: room.admin, mode: room.mode, mentions })
      const speakers = addressedMembers(invite, members)
      const note = mentions.all || mentions.found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      callIn(round, speakers, note, undefined, { ordered: invite.ordered === true })
    }
    resumePausedRoomWorks(room, round, { reason: 'user_message' })
    saveSoon()
  }

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
        if (turns.size === 0 && !round.slots.some(slot => slot.status === 'waiting') && (round.kickoff || waitingLines(agent).length === 0)) break
      }
      round.closed = true
      await Promise.allSettled([...turns])
    } finally {
      signal.removeEventListener('abort', onAbort)
      delete round.nudge
    }
    const alone = round.soleAdmin !== undefined && round.slots.find(slot => slot.id === round.soleAdmin.id)?.status === 'passed'
    const answered = round.slots.some(slot => ['posted', 'working', 'waiting-approval', 'waiting-answer'].includes(slot.status))
    if (alone && !answered) {
      say(room, { who: 'DS Bot', kind: 'notice', reason: 'admin-passed', names: [round.soleAdmin.name], about: round.soleAdmin.id })
      await rt.save()
    }
  }

  async function memberTurn(room, round, slot, signal) {
    const member = rt.botOf(slot.id)
    if (member === undefined || !room.members.includes(slot.id)) {
      slot.status = 'left'
      await exitMemberRoomCalls(room, slot.id, { round, signal })
      return
    }
    slot.status = 'speaking'
    let session
    try {
      session = await groupSessionFor(room, member)
    } catch (error) {
      rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
      slot.status = 'failed'
      if (slot.workId !== undefined) {
        await settleRoomCallWork(room, slot.workId, 'failed', { round, signal, member, error: { code: 'SESSION', message: String(error?.message ?? error).slice(0, 300) } })
      }
      round.failed.push(member.name)
      noteFailure(room, member, { code: 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
      return
    }
    if (session === undefined) {
      slot.status = 'left'
      await exitMemberRoomCalls(room, member.id, { round, signal })
      return
    }
    if (slot.resultOnly) slot.resultRef = `G${slot.finished?.results?.at(-1)?.seq ?? room.seq}`
    // Bind consumption strictly to the generation presented in `slot.finished` (`slot.throughSeq`)
    // so newer child results arriving after this slot started `speaking` are NEVER prematurely acked.
    const isSynthesisSlot = slot.workId !== undefined && (slot.resumedUpstream === true || slot.finished !== undefined)
    let consumedResultSeq = 0
    if (isSynthesisSlot) {
      if (Number.isInteger(slot.throughSeq) && slot.throughSeq > 0) {
        consumedResultSeq = slot.throughSeq
      } else {
        const liveWake = wakeSnapshotOfParent(slot.workId)
        if (liveWake !== undefined) mergeWakeIntoSlot(slot, liveWake)
        consumedResultSeq = maxUnreadResultSeq(slot.workId)
      }
    }
    const consumedFinished = slot.finished
      ? { names: [...(slot.finished.names ?? [])], results: [...(slot.finished.results ?? [])] }
      : undefined
    const prompt = roomPrompt(room, member, round, slot, await finishedLines(room, slot), session.id)
    round.shown?.push(member.id)
    const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
    const said = []
    const posted = []
    const startedAt = Date.now()
    let worked = false
    const onWork = () => {
      worked = true
      slot.worked = true
    }
    let finishedTurn
    // Strictly zero-echo publishing: a Bot's speech body NEVER spawns new `call` edges
    // from `@Name` text. Delegations only enter via explicit `delegate_work` / `post_to_group`.
    const publish = (body, completedSession, changes, { interim = false, presented = [] } = {}) => {
      const holdsResult = interim || hasPendingChildWork(slot.workId) || unreadChildResultsOf(slot.workId).length > 0
      const route = holdsResult
        ? roomVisible()
        : classifyBotGroupSpeech({ resultRef: slot.resultRef, activeCallId: slot.workId, askedBy: slot.by })
      const claims = body !== '' && completedSession ? claimsOf(completedSession, body, worked, (slot.explicitCalls?.size ?? 0) > 0) : undefined
      posted.push(postInRound(room, member, body, Date.now() - startedAt, claims, changes, route, presented))
    }
    const reply = await roomTurn(
      room, member, session.id, { text, images: prompt.images, files: prompt.files, meta: prompt.meta }, slot.note ?? 'your turn', signal, round, slot, said,
      line => publish(line, undefined, undefined, { interim: true }),
      onWork,
      (turnNumber) => { finishedTurn = turnNumber },
      () => consumeParentResults(slot.workId, consumedResultSeq, consumedFinished),
    )
    if (reply?.left === true) {
      clearPresented(room.id, member.id)
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      slot.status = 'left'
      await exitMemberRoomCalls(room, member.id, { round, signal })
      return
    }
    const activeSid = room.sessions?.[member.id] ?? session.id
    const liveSession = ctx.get?.('agents')?.get(activeSid)?.session ?? { id: activeSid }
    const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
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
        posted.push(postInRound(room, member, answerText, Date.now() - startedAt, undefined, changes, roomVisible(), files))
      }
      slot.status = 'waiting-answer'
    } else if (reply?.approval) {
      slot.status = 'waiting-approval'
      say(room, { who: member.name, botId: member.id, kind: 'approval' })
    } else if (reply?.working) {
      slot.status = 'working'
      say(room, { who: member.name, botId: member.id, kind: 'working' })
    } else if (bgRunning) {
      worked = true
      slot.worked = true
      if (final !== undefined || files.length > 0) {
        publish(final ?? '', liveSession, changes, { interim: true, presented: files })
      }
      slot.status = 'working'
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
        say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      }
    } else {
      if (reply === null) clearPresented(room.id, member.id)
      slot.status = reply === null ? 'cancelled' : typeof reply === 'string' ? 'passed' : 'missed'
      round.passed.push(member.name)
      if (changes !== undefined) say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      if (reply?.missed) {
        say(room, { who: 'DS Bot', kind: 'notice', reason: 'missed', names: [member.name], about: member.id, minutes: Math.round(ROOM_REPLY_TIMEOUT_MS / 60000) })
      }
    }
    // A result the admin asked for reports its goal task; a failed model call puts it back.
    if (slot.status === 'posted' && slot.by === room.admin && (final !== undefined || files.length > 0)) rt.goalTaskReported?.(room.id, member.id)
    if (reply?.failure !== undefined) rt.goalTaskReset?.(room.id, member.id, 'Could not finish: its model call failed')

    // Hard-signal progress check on Bot-to-Bot calls (no round caps, no text heuristics).
    if (slot.workId !== undefined && slot.status === 'posted' && !hasPendingChildWork(slot.workId) && unreadChildResultsOf(slot.workId).length === 0) {
      const prog = checkProgressStagnation(room, slot.workId, {
        callerId: slot.by,
        calleeId: member.id,
        worked,
        text: final ?? '',
        changes,
      })
      if (prog.paused) {
        if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
        return
      }
    }

    if (['posted', 'passed', 'failed', 'left', 'cancelled'].includes(slot.status)) {
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      if (slot.status === 'left') {
        await exitMemberRoomCalls(room, member.id, { round, signal })
      } else if (slot.workId !== undefined) {
        const handle = writableDb()
        const persisted = handle?.getWork(slot.workId)
        if (persisted && !isHeldRoomStatus(persisted.status) && !TERMINAL_STATUSES.has(persisted.status)) {
          const pendingChildren = hasPendingChildWork(slot.workId) || handle.listWaits({ workId: slot.workId, status: 'open' }).length > 0
          const alreadyQueuedResume = round.slots.some(s => s !== slot && s.id === member.id && s.status === 'waiting' && s.workId === slot.workId && s.resumedUpstream === true)
          const unreadResults = (pendingChildren || alreadyQueuedResume) ? [] : unreadChildResultsOf(slot.workId)
          if (pendingChildren || alreadyQueuedResume) {
            handle.parkWaiting?.(slot.workId)
          } else if (unreadResults.length > 0) {
            await resumeParentWithUnreadResults(room, member, persisted, { round, signal, unreadResults })
          } else {
            const outcome = slot.status === 'posted' ? 'done' : slot.status === 'failed' ? 'failed' : 'stopped'
            await settleRoomCallWork(room, slot.workId, outcome, {
              round,
              signal,
              member,
              text: final ?? '',
              seq: posted.at(-1),
              worked,
              ...(reply?.failure ? { error: reply.failure } : {}),
            })
          }
        }
      }
    } else if (slot.status === 'missed' && (!room.members.includes(member.id) || !activeInRoom(room, member.id))) {
      if (slot.exchangeId !== undefined) explicitCallsByExchange.delete(slot.exchangeId)
      if (slot.workId !== undefined) await settleRoomCallWork(room, slot.workId, 'stopped', { round, signal, member })
    }
  }

  const laterPosts = new Map()
  const finalizing = new Set()
  let disposed = false
  rt.roomActive = roomId => runningRound(roomId) !== undefined || finalizing.has(roomId)
  const roundRuns = new Map()
  rt.roomRounds = roomId => [...(roundRuns.get(roomId) ?? [])]
  const runningRound = roomId => [...rt.roomProgress.values()].find(round => round.roomId === roomId)
  const stoppedFinishing = new Set()
  rt.stopRoomRound = (roomId) => {
    const round = runningRound(roomId)
    round?.abort.abort()
    if (finalizing.has(roomId)) stoppedFinishing.add(roomId)
    return round !== undefined || finalizing.has(roomId)
  }

  // Computes who an opening post addresses under the 3-way protocol:
  // - User message / kickoff / goal -> `invite`
  // - Explicit Bot `call`/`request` -> `call`
  // - Settled `result` -> wakes fixed caller ONLY
  // - `visible`/`note` / `quiet` / plain Bot message without explicit call -> `[]` (0 wakes)
  function openingCall(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    const at = (speakers, kind = 'invite', ordered = false) => ({ speakers, kind, ordered })
    if (opener.kickoff) return at(admin ? [admin] : [], 'invite')
    if (opener.quiet) return at([], 'visible')
    if (opener.route) {
      if (isVisibleRoute(opener.route)) return at([], 'visible')
      if (isResultRoute(opener.route)) return at(addressedMembers(opener.route, everyone, opener.botId), 'result')
      if (isCallRoute(opener.route)) return at(explicitCallees(opener.route, everyone, opener.botId), opener.externalPost ? 'invite' : 'call', opener.route.ordered === true)
      if (isInviteRoute(opener.route)) return at(addressedMembers(opener.route, everyone, opener.botId), 'invite', opener.route.ordered === true)
    }
    if (opener.done || opener.stopped || opener.failed) {
      return at(members.filter(bot => bot.id === opener.askedBy), 'result')
    }
    if (opener.goal !== undefined) return at(admin ? [admin] : [], 'invite')

    // Bot-authored post without an explicit `call` or `result` envelope:
    // Only `post_to_group` carrying explicit `mentions` (non-notice request) can open work;
    // ordinary Bot replies / progress / late posts never parse body `@Name` into new wakes.
    if (opener.botId !== undefined) {
      if (opener.late || opener.progress) {
        return at(opener.askedBy ? members.filter(bot => bot.id === opener.askedBy) : [], opener.askedBy ? 'result' : 'visible')
      }
      const saved = mentionsOf(opener, everyone)
      if (saved !== undefined) {
        const postKind = opener.externalPost ? 'invite' : 'call'
        const found = saved.found.filter(bot => bot.id !== opener.botId)
        if (found.length > 0 && !saved.all) return at(found, postKind)
        if (saved.all && !opener.member) return at(members, postKind)
        if (opener.member) return at(found, postKind)
        if (room.mode === 'admin' && admin) return at([admin], postKind)
        const ordered = admin ? [admin, ...members.filter(bot => bot !== admin)] : members
        return at(ordered, postKind, ordered.length > 1)
      }
      return at([], 'visible')
    }

    // User message -> `invite`.
    const mentions = mentionsIn(opener.text ?? '', everyone, opener.references)
    const invite = resolveUserInvite({ members: everyone, adminId: room.admin, mode: room.mode, mentions })
    return at(addressedMembers(invite, everyone), 'invite', invite.ordered === true)
  }
  const openingSpeakers = (room, opener) => openingCall(room, opener).speakers

  function callPost(room, round, sender, text, extra) {
    if (isVisibleRoute(extra.route) && extra.route !== undefined) return false
    if (extra.failed !== undefined && !extra.askedBy) return false
    if (extra.resumed || (extra.stopped && !extra.askedBy)) return false
    const post = { ...extra, botId: sender.id, name: sender.name, text }
    const opened = openingCall(room, post)
    const { speakers, kind, ordered } = opened
    if (speakers.length === 0) return false
    if (kind === 'result') {
      const resultWorkId = extra.parentWorkId ?? extra.batch ?? extra.route?.callId ?? extra.route?.batch
      const resultWork = resultWorkId ? db()?.getWork(resultWorkId) : undefined
      const isNested = extra.resumeWorkId !== undefined || isCallWork(resultWork)
      if (!isNested && resultWorkId !== undefined && !markResultWakeDelivered(resultWorkId)) {
        return false
      }
      const resumeWorkId = extra.resumeWorkId ?? (isNested ? resultWorkId : undefined)
      const resumeBy = extra.resumeBy ?? (isNested ? resultWork?.meta?.callerBotId : undefined)
      const wake = extra.wakeSnapshot ?? wakeSnapshotOfParent(resultWorkId)
      const note = wake ? finishedNote(wake.names) : (extra.done ? `${sender.name} finished the work you asked for` : undefined)
      for (const peer of speakers) {
        callIn(round, [peer], note, undefined, resumeWorkId !== undefined
          ? { ordered, resumeWorkId, resumeBy }
          : { ordered, resultOnly: true })
        if (wake !== undefined) giveResults(round, peer.id, wake, resumeWorkId, extra.throughSeq)
      }
      expandScopedReports(room.id, sender.id, speakers)
      return true
    }
    if (kind === 'call') {
      const result = callIn(round, speakers, `${sender.name} delegated a task to you`, sender.id, {
        ordered,
        parentWorkId: extra.parentWorkId ?? extra.parentBatchKey,
        callerExchangeId: extra.callerExchangeId,
        follows: extra.route?.follows,
        returnAddress: extra.returnAddress,
      })
      if (result.cycle) return 'cycle'
      expandScopedReports(room.id, sender.id, speakers)
      if (rt.isAdminOf(room, sender.id)) for (const peer of speakers) rt.goalTaskWorking?.(room.id, peer.id)
      if (extra.reportBack) trackScopedReport(room, sender, extra, speakers.map(peer => peer.id))
      return true
    }
    // `invite`
    callIn(round, speakers, `${sender.name} invited you to reply`, undefined, { ordered })
    if (rt.isAdminOf(room, sender.id)) for (const peer of speakers) rt.goalTaskWorking?.(room.id, peer.id)
    expandScopedReports(room.id, sender.id, speakers)
    if (extra.reportBack) trackScopedReport(room, sender, extra, speakers.map(peer => peer.id))
    return true
  }

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
      if (post.logged !== undefined || isStoppedRelay(post)) continue
      const resumedIds = post.resumedWorkIds ?? takePendingResumedWorks(post.exchangeId)
      if (post.resumedPause === true || resumedIds !== undefined) {
        for (const wId of resumedIds ?? []) {
          const work = getRoomWork(wId)
          const peer = work ? rt.botOf(work.botId) : undefined
          if (peer && room.members.includes(peer.id)) {
            callIn(round, [peer], 'the user continued after a pause', work.meta?.callerBotId, {
              existingChildren: new Map([[peer.id, work.workId]]),
            })
          }
        }
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
        else if (post.resumed || post.stopped || post.done) {
          say(room, { who: sender.name, botId: sender.id, kind: post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed', text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
        } else {
          const presented = presentedFiles(post.presented)
          say(room, { who: sender.name, botId: sender.id, text, ...(post.route ? { route: post.route } : {}), ...(post.files === undefined ? {} : { files: post.files }), ...(presented.length > 0 ? { presented } : {}), ...(post.claims === undefined ? {} : { claims: post.claims }), ...(post.changes === undefined ? {} : { changes: post.changes }), session: true, ...(post.late !== true && post.progress !== true ? { openingPost: true } : {}) })
        }
        callPost(room, round, sender, post.text ?? '', post)
        settleQueuedReportInRound(room, post)
        continue
      }
      if (post.botId !== undefined) continue
      noteRoomUserOrigin(room, viaIsIm(post.via) ? rt.captureImOrigin?.(rt.sessionOfRoom(room)) : undefined)
      const text = [post.text, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
      say(room, { who: 'User', text, ...(post.files === undefined ? {} : { files: post.files }), ...(post.via === undefined ? {} : { via: post.via }), session: true })
      round.userMessage = true
      rt.goalUserMessage?.(room.id)
      const mentions = mentionsIn(post.text ?? '', members)
      const invite = resolveUserInvite({ members, adminId: room.admin, mode: room.mode, mentions })
      callIn(round, addressedMembers(invite, members), mentions.all || mentions.found.length > 0 ? 'the user mentioned you' : 'new message from the user', undefined, { ordered: invite.ordered === true })
      resumePausedRoomWorks(room, round, { reason: 'user_message' })
    }
    round.nudge?.()
    await rt.save()
  }

  const DISPOSE_ROUND_WAIT_MS = 2_000
  // Rounds stop with the plugin.
  ctx.effect(() => () => {
    disposed = true
    presented.clear()
    explicitCallsByExchange.clear()
    pendingResumedRoomWorks.clear()
    for (const off of adoptedRoomMonitors.values()) {
      try { off() } catch { /* ignore */ }
    }
    adoptedRoomMonitors.clear()
    laterPosts.clear()
    const active = [...roundRuns.values()].flatMap(runs => [...runs])
    for (const round of rt.roomProgress.values()) round.abort?.abort()
    if (active.length === 0) return rt.ledger?.flush?.()
    let timer
    const bounded = Promise.race([
      Promise.allSettled(active),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DISPOSE_ROUND_WAIT_MS)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
    return bounded.then(() => rt.ledger?.flush?.())
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
    const filtered = queued.filter(post => !isStoppedRelay(post))
    if (queued.length > 0 && filtered.length === 0) return
    const posts = filtered.length > 0 ? filtered : [{ text: '' }]
    for (const post of [...posts]) {
      if (post.goal === 'nudge' || post.goal === 'resume') {
        if (room.goal?.id !== post.goalId || room.goal.status !== 'active' || (post.goal === 'nudge' && room.goal.idle === true)) posts.splice(posts.indexOf(post), 1)
      } else if (post.goal === 'draft' && (room.goal?.id !== post.goalId || room.goal.status !== 'drafting')) {
        delete post.goal
        delete post.goalId
      }
    }
    const startSeq = Math.min(room.seq + 1, ...posts.map(post => post.logged).filter(seq => typeof seq === 'number'))
    const event = item => item.failed || item.resumed || item.stopped || item.done || item.resumedPause || pendingResumedRoomWorks.has(item.exchangeId) || item.goal === 'nudge' || item.goal === 'resume'
    const userPost = post => post.botId === undefined && post.kickoff !== true && !event(post)
    const stoppedOnly = posts.length > 0 && posts.every(item => event(item) && item.stopped === true && item.askedBy === undefined)

    for (const post of posts.filter(item => !item.kickoff && !event(item) && item.logged === undefined)) {
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
        ...(post.goal === 'draft' ? {} : { session: true }),
        ...(post.botId !== undefined && post.late !== true && post.progress !== true ? { openingPost: true } : {}),
      })
      post._afterSeq = room.seq + 1
    }
    await rt.save()

    const userPosts = posts.filter(userPost)
    const hasUserPost = userPosts.length > 0
    if (hasUserPost) {
      const roomIm = rt.captureImOrigin?.(rt.sessionOfRoom(room))
      for (const post of userPosts) noteRoomUserOrigin(room, viaIsIm(post.via) ? roomIm : undefined)
      rt.goalUserMessage?.(room.id)
    }

    const open = posts.filter(post => post.called !== true)
    const references = posts.flatMap(post => post.references ?? [])
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const admin = everyone.find(bot => rt.isAdminOf(room, bot.id))
    const kickoff = !hasUserPost && open.some(post => post.kickoff === true)
    const callsNobody = post => post.member === true && openingSpeakers(room, post).length === 0
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

    const postIsActionable = (post) => {
      if (post.resumedPause === true || pendingResumedRoomWorks.has(post.exchangeId)) return true
      if (isVisibleRoute(post.route) && post.route !== undefined) return post.reportBack === true
      if (post.kickoff) return kickoff
      if (post.goal === 'nudge') return goalNudge
      if (post.goal !== undefined) return true
      if (post.reportBack === true && rt.botOf(post.botId) !== undefined) return true
      if (event(post)) return openingSpeakers(room, post).length > 0
      if (callsNobody(post)) return false
      return openingSpeakers(room, post).length > 0
    }

    const actionable = open.filter(postIsActionable)
    const multiPost = actionable.length > 1
    for (const post of actionable) {
      const resumedIds = post.resumedWorkIds ?? takePendingResumedWorks(post.exchangeId)
      if (post.resumedPause === true || resumedIds !== undefined) {
        for (const wId of resumedIds ?? []) {
          const work = getRoomWork(wId)
          const peer = work ? rt.botOf(work.botId) : undefined
          if (peer && room.members.includes(peer.id)) {
            callIn(round, [peer], 'the user continued after a pause', work.meta?.callerBotId, {
              existingChildren: new Map([[peer.id, work.workId]]),
            })
          }
        }
        continue
      }
      const poster = post.botId === undefined ? undefined : rt.botOf(post.botId)
      const opened = openingCall(room, post)
      const afterSeq = post._afterSeq ?? (typeof post.logged === 'number' ? post.logged + 1 : startSeq)
      const { speakers, kind, ordered } = opened
      if (speakers.length > 0) {
        const postNote = post.kickoff ? 'the group was just created'
          : post.goal === 'draft' ? 'the user wants to set a goal for this group'
          : post.goal === 'nudge' ? 'goal check'
          : post.goal === 'resume' ? 'the user resumed the goal'
          : post.done ? `${post.name ?? 'a member'} finished the work you asked for`
          : undefined
        if (kind === 'result') {
          const resultWorkId = post.parentWorkId ?? post.batch ?? post.route?.callId ?? post.route?.batch
          const resultWork = resultWorkId ? db()?.getWork(resultWorkId) : undefined
          const isNested = post.resumeWorkId !== undefined || isCallWork(resultWork)
          if (!isNested && resultWorkId !== undefined && !markResultWakeDelivered(resultWorkId)) {
            continue
          }
          const resumeWorkId = post.resumeWorkId ?? (isNested ? resultWorkId : undefined)
          const resumeBy = post.resumeBy ?? (isNested ? resultWork?.meta?.callerBotId : undefined)
          const wake = post.wakeSnapshot ?? wakeSnapshotOfParent(resultWorkId)
          const note = wake ? finishedNote(wake.names) : postNote
          for (const member of speakers) {
            callIn(round, [member], note, undefined, resumeWorkId !== undefined
              ? { ordered, resumeWorkId, resumeBy }
              : { ordered, resultOnly: true })
            if (wake !== undefined) giveResults(round, member.id, wake, resumeWorkId, post.throughSeq)
          }
        } else if (kind === 'call' && poster !== undefined) {
          const callParentId = post.parentWorkId ?? post.parentBatchKey
          callIn(round, speakers, postNote ?? `${poster.name} delegated a task to you`, poster.id, {
            ordered,
            parentWorkId: callParentId,
            callerExchangeId: post.callerExchangeId,
            follows: post.route?.follows,
            returnAddress: post.returnAddress,
          })
          clearPendingChildRelay(callParentId, post.exchangeId)
          if (rt.isAdminOf(room, poster.id)) for (const member of speakers) rt.goalTaskWorking?.(room.id, member.id)
          expandScopedReports(room.id, poster.id, speakers)
        } else {
          callIn(round, speakers, postNote ?? 'new message in the group', undefined, { ordered })
          if (poster !== undefined && rt.isAdminOf(room, poster.id)) {
            for (const member of speakers) rt.goalTaskWorking?.(room.id, member.id)
          }
          if (poster !== undefined) expandScopedReports(room.id, poster.id, speakers)
        }
      }
      if (post.reportBack && poster !== undefined) {
        if (multiPost) trackScopedReport(room, poster, post, speakers.map(member => member.id), afterSeq)
        else trackRoundReport(room, post, afterSeq)
      }
    }

    if (hasUserPost) resumePausedRoomWorks(room, round, { reason: 'user_message' })
    if (round.batches === 0) round.batches = 1

    const soleAdmin = room.mode === 'admin' && admin !== undefined
      && !kickoff && !open.some(post => post.goal !== undefined)
      && hasUserPost
      && round.slots.length === 1 && round.slots[0].id === admin.id
      && round.slots[0].by === undefined && round.slots[0].finished === undefined
    if (soleAdmin) round.soleAdmin = { id: admin.id, name: admin.name, color: admin.color }

    for (const post of posts.filter(item => item.failed && item.logged === undefined)) {
      round.failed.push(rt.botOf(post.botId)?.name ?? post.name)
    }
    for (const post of posts.filter(item => (item.resumed || item.stopped || item.done) && item.logged === undefined)) {
      const name = rt.botOf(post.botId)?.name ?? post.name
      const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
      say(room, { who: name, botId: post.botId, kind, text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
    }
    if (posts.some(post => post.resumed || post.stopped || post.done)) await rt.save()

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
      rt.ledger.append(bookOf(room.id), { event: 'round', from: round.from, to: round.to, passed: round.passed, failed: round.failed, ...(signal.aborted ? { stopped: true } : {}), time: Date.now() })
    }
    try {
      if (signal.aborted) {
        for (const turn of round.started) {
          void rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId)
            ?.catch(error => rt.warn('ds-bot: stopping a turn of the round in %s failed: %s', room.name, error))
        }
      } else if (!disposed && rt.goalDrive !== undefined) {
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

  // ---------------------------------------------------------------------------
  // Group tools (`group_relay`, `read_own_chat`, `read_group_chat`).

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
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const from = Math.min(room.seq + 1, ...queued.map(post => post.logged).filter(seq => typeof seq === 'number'))
      const anchor = randomUUID()
      rt.ledger.append(bookOf(room.id), { event: 'anchor', id: anchor, from, time: Date.now() })
      const running = runningRound(room.id)
      if (running !== undefined) await joinRound(room, running, queued, exec.agent)
      else if (finalizing.has(room.id)) laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...queued])
      else {
        const left = laterPosts.get(room.id) ?? []
        laterPosts.delete(room.id)
        startRound(room, [...left, ...queued], exec.agent, exec.callId, anchor)
      }
      if (typeof rt.yieldToolTurn === 'function') rt.yieldToolTurn(exec, 'group_relay')
      else exec.concludeTurn?.()
      return JSON.stringify({ from, anchor })
    },
  }))

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
      const askingSession = targetRoomId !== undefined
        ? (owner?.roomId === targetRoomId ? id : undefined)
        : (taskOwner?.roomId !== undefined ? rt.chatOf(botId) : id)
      const parts = targetRoomId !== undefined
        ? rt.partsOf(botId, targetRoomId)
        : rt.partsOfThread(botId, askingSession)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined && targetRoomId !== room.id) {
        const text = callId !== '' ? `call ${callId}` : query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        say(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        saveSoon()
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

  // ---------------------------------------------------------------------------
  // Posting into a room, late replies/failures, step flushing, stopping.

  async function postToRoom(room, sender, text, extra = {}, files = []) {
    const { imOrigin, callerOrigin, ...postExtra } = extra
    const presented = presentedFiles(postExtra.presented)
    if (presented.length > 0) postExtra.presented = presented
    else delete postExtra.presented
    if (!postExtra.route && (postExtra.done || postExtra.stopped || postExtra.failed || postExtra.resumed)) {
      postExtra.route = postExtra.askedBy && !postExtra.quiet ? roomResult(postExtra.askedBy, postExtra.parentWorkId) : roomVisible()
    }
    if (!postExtra.route && postExtra.mentions && postExtra.quiet !== true) {
      const { speakers, ordered } = openingCall(room, { ...postExtra, botId: sender.id, text })
      postExtra.route = speakers.length
        ? { ...roomCall(speakers.map(bot => bot.id)), ...(ordered ? { ordered: true } : {}) }
        : roomVisible()
    }
    if (!postExtra.route) postExtra.route = roomVisible()

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
        running.failed.push(sender.name)
      } else if (postExtra.resumed === true || postExtra.stopped === true || postExtra.done === true) {
        const kind = postExtra.done === true ? 'done' : postExtra.stopped === true ? 'stopped' : postExtra.again === true ? 'cut' : 'resumed'
        say(room, { who: sender.name, botId: sender.id, kind, text: '', ...(postExtra.changes === undefined ? {} : { changes: postExtra.changes }) })
      } else {
        const line = [text, ...files.map(fileLine)].filter(Boolean).join('\n')
        say(room, { who: sender.name, botId: sender.id, text: line, route: postExtra.route, ...(files.length > 0 ? { files } : {}), ...(presented.length > 0 ? { presented } : {}), ...(postExtra.claims === undefined ? {} : { claims: postExtra.claims }), ...(postExtra.changes === undefined ? {} : { changes: postExtra.changes }), ...(postExtra.late !== true && postExtra.progress !== true ? { openingPost: true } : {}) })
      }
      const callOutcome = callPost(room, running, sender, text, postExtra)
      settleQueuedReportInRound(room, postExtra)
      await rt.save()
      return callOutcome === 'cycle' ? { cycle: true } : undefined
    }

    // Pure `visible` (zero-wake) post when no round is running and the room already has an
    // anchor: write directly to the group ledger without waking the group Session.
    const hasAnchor = rt.ledger.records(bookOf(room.id)).some(record => record.event === 'anchor')
    if (hasAnchor && isVisibleRoute(postExtra.route) && postExtra.reportBack !== true && postExtra.late !== true && !noticeOnly && postExtra.done !== true && postExtra.stopped !== true && postExtra.failed === undefined) {
      const line = [text, ...files.map(fileLine)].filter(Boolean).join('\n')
      say(room, {
        who: sender.name,
        botId: sender.id,
        text: line,
        route: roomVisible(),
        ...(files.length > 0 ? { files } : {}),
        ...(presented.length > 0 ? { presented } : {}),
        ...(postExtra.claims === undefined ? {} : { claims: postExtra.claims }),
        ...(postExtra.changes === undefined ? {} : { changes: postExtra.changes }),
      })
      await rt.save()
      return undefined
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
    const tracksChildParent = typeof postExtra.parentWorkId === 'string' && postExtra.parentWorkId !== '' && isCallRoute(postExtra.route)
    if (tracksChildParent) notePendingChildRelay(postExtra.parentWorkId, exchangeId)
    if (tracksRelay) noteRoomRelayQueued(room.id, exchangeId, postExtra.reportId)
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
      let withdrawn = !enqueued
      if (!withdrawn && typeof agent.inbox?.remove === 'function') {
        rt.beginWithdrawingRelay?.(exchangeId)
        try {
          for (const lane of [agent.inbox.nextStep, agent.inbox.nextTurn]) {
            for (const item of Array.from(lane ?? [])) {
              if (item?.source?.exchangeId === exchangeId && agent.inbox.remove(item.id) === true) {
                withdrawn = true
              }
            }
          }
        } finally {
          rt.endWithdrawingRelay?.(exchangeId)
        }
      }
      if (withdrawn) {
        if (tracksChildParent) clearPendingChildRelay(postExtra.parentWorkId, exchangeId)
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
    return undefined
  }
  rt.postToRoom = postToRoom

  async function lateRoomReply(sessionId, info, reply, { shown = false, toolCount = 0, turn } = {}) {
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
          await postToRoom(room, member, isPass(text) ? '' : text, { progress: true, quiet: true, route: roomVisible(), ...delivered })
            .catch(error => rt.warn('ds-bot: question lead-in from %s failed: %s', member.name, error))
        }
        return
      }
      const workId = activeWorkIdForSession(sessionId, info)
      const handle = writableDb()
      const hasBg = rt.hasSubagents?.(sessionId) === true || rt.hasRoomTasks?.(room.id, member.id) === true
      const hasChildrenAtEntry = hasPendingChildWork(workId)
        || (workId !== undefined && (handle?.listWaits({ workId, status: 'open' }).length ?? 0) > 0)
      if (hasBg || hasChildrenAtEntry) {
        if (!isPass(text) || hasFiles) {
          await postToRoom(room, member, isPass(text) ? '' : text, { progress: true, quiet: true, route: roomVisible(), ...delivered })
            .catch(error => rt.warn('ds-bot: background progress from %s failed: %s', member.name, error))
        }
        if (hasBg || workId === undefined || handle === null) return
        // Re-read SQLite AFTER `await postToRoom` (no TOCTOU): a fast child may have closed its wait
        // and written unread `result` rows during the await window.
        const latestAfterProgress = handle.getWork(workId)
        if (!latestAfterProgress || TERMINAL_STATUSES.has(latestAfterProgress.status) || isHeldRoomStatus(latestAfterProgress.status)) {
          return
        }
        const stillHasChildren = hasPendingChildWork(workId) || handle.listWaits({ workId, status: 'open' }).length > 0
        if (stillHasChildren) {
          handle.parkWaiting(workId)
          return
        }
        const unreadAfterProgress = unreadChildResultsOf(workId)
        if (unreadAfterProgress.length > 0) {
          await resumeParentWithUnreadResults(room, member, latestAfterProgress, { unreadResults: unreadAfterProgress })
        }
        return
      }
      // Perform all async reads BEFORE entering the synchronous SQLite decision + settlement critical section.
      const session = await rt.resolveAgent(sessionId).then(agent => agent?.session, () => undefined)
      const claims = isPass(text) ? undefined : claimsOf(session, text, toolCount > 0, (explicitCalls?.size ?? 0) > 0)
      const changes = await rt.turnChanges?.(sessionId, turn)

      // Zero-await synchronous critical section: re-read SQLite work status, open waits, and unread child results
      // right before deciding whether to park, resume synthesis, or settle `done`.
      const work = workId !== undefined ? (handle?.getWork(workId) ?? getRoomWork(workId)) : undefined
      if (work !== undefined && (TERMINAL_STATUSES.has(work.status) || isHeldRoomStatus(work.status))) {
        return
      }
      const pendingNow = workId !== undefined
        && (hasPendingChildWork(workId) || (handle?.listWaits({ workId, status: 'open' }).length ?? 0) > 0)
      const unreadNow = (workId !== undefined && !pendingNow) ? unreadChildResultsOf(workId) : []
      if (work !== undefined && (pendingNow || unreadNow.length > 0)) {
        if (!isPass(text) || hasFiles) {
          say(room, {
            who: member.name,
            botId: member.id,
            text: isPass(text) ? '' : text,
            route: roomVisible(),
            ...(hasFiles ? { presented: files } : {}),
            ...(claims === undefined ? {} : { claims }),
            ...(changes === undefined ? {} : { changes }),
          })
        }
        if (pendingNow) {
          handle?.parkWaiting?.(workId)
          await rt.save()
          // Only recover if a child settled during `rt.save()` without an already-claimed
          // synthesis wake (idempotently gated inside `resumeParentWithUnreadResults`).
          const afterSave = handle?.getWork(workId)
          if (afterSave && !TERMINAL_STATUSES.has(afterSave.status) && !isHeldRoomStatus(afterSave.status)
            && !hasPendingChildWork(workId) && (handle?.listWaits({ workId, status: 'open' }).length ?? 0) === 0) {
            await resumeParentWithUnreadResults(room, member, afterSave)
          }
        } else {
          await rt.save()
          await resumeParentWithUnreadResults(room, member, work)
        }
        return
      }

      const askedBy = info.role === 'room' ? info.askedBy : (info.askedBy ?? work?.meta?.callerBotId)
      if (askedBy === room.admin && (!isPass(text) || shown || hasFiles)) rt.goalTaskReported?.(room.id, member.id)
      if (workId !== undefined && work !== undefined) {
        let postedSeq
        if (!isPass(text) || hasFiles) {
          const line = say(room, {
            who: member.name,
            botId: member.id,
            text: isPass(text) ? '' : text,
            route: classifyBotGroupSpeech({ resultRef: info.resultRef, activeCallId: workId, askedBy }),
            ...(hasFiles ? { presented: files } : {}),
            ...(claims === undefined ? {} : { claims }),
            ...(changes === undefined ? {} : { changes }),
          })
          postedSeq = line.seq
        } else if (changes !== undefined) {
          const line = say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
          postedSeq = line.seq
        }
        if (!isPass(text) || shown || hasFiles) {
          const prog = checkProgressStagnation(room, workId, {
            callerId: askedBy,
            calleeId: member.id,
            worked: toolCount > 0,
            text,
            changes,
          })
          if (prog.paused) {
            await rt.save()
            return
          }
        }
        const outcome = (!isPass(text) || shown || hasFiles || changes !== undefined) ? 'done' : 'stopped'
        // No `await` has occurred since re-reading `work` above; `settleRoomCallWork` commits SQLite
        // synchronously before its first `await`.
        await settleRoomCallWork(room, workId, outcome, {
          member,
          text: isPass(text) ? '' : text,
          seq: postedSeq,
          worked: toolCount > 0,
        })
        if (postedSeq !== undefined) await rt.save()
      } else if (!isPass(text) || hasFiles) {
        await postToRoom(room, member, isPass(text) ? '' : text, {
          late: true,
          route: askedBy ? roomResult(askedBy) : roomVisible(),
          ...(askedBy ? { askedBy } : {}),
          ...delivered,
          ...(claims === undefined ? {} : { claims }),
          ...(changes === undefined ? {} : { changes }),
        })
      } else if (changes !== undefined) {
        await postToRoom(room, member, '', {
          late: true,
          done: true,
          quiet: true,
          route: roomVisible(),
          changes,
        })
      }
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
  // Under the 3-way protocol, body `@Name` text in a Bot's speech never creates calls.
  rt.callsRoomMember = () => false

  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    ensureRoomLog(room)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (running !== undefined) {
      postInRound(room, member, text, undefined, undefined, undefined, roomVisible())
      return
    }
    await postToRoom(room, member, text, { progress: true, quiet: true, route: roomVisible() })
  }

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
    if (line === entry.lastLine) return
    entry.lastLine = line
    entry.lines.push(text)
    if ((first && info?.role === 'room') || Date.now() - entry.last >= ROOM_STEP_GAP_MS) return flushSteps(sessionId)
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

  async function stopMemberWork(roomId, botId, { wake = true } = {}) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = rt.own(room?.sessions, botId)
    const turnRunning = sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined
    const subRunning = sessionId !== undefined && rt.hasSubagents?.(sessionId) === true
    const taskRunning = rt.hasRoomTasks?.(roomId, botId) === true
    const hasOpenWork = listActiveRoomWorks(roomId, { botId }).length > 0
    if (room === undefined || member === undefined || (!turnRunning && !subRunning && !taskRunning && !hasOpenWork)) return false
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
      const { usedFirstPost } = await exitMemberRoomCalls(room, botId, {
        member,
        outcome: 'stopped',
        firstPost: () => ({ text: '', extra: { late: true, stopped: true } }),
      })
      if (!usedFirstPost) {
        say(room, { who: member.name, botId: member.id, kind: 'stopped', text: '' })
        await rt.save()
      }
    } else {
      const handle = writableDb()
      if (handle !== null) {
        for (const work of listActiveRoomWorks(room.id, { botId })) {
          handle.stopWork(work.workId, { reason: 'Stopped in group' })
        }
      }
      say(room, { who: member.name, botId: member.id, kind: 'stopped', text: '' })
      await rt.save()
    }
    return true
  }
  rt.stopMemberWork = stopMemberWork

  async function cancelRoomQueues(room) {
    const cancelPending = (list) => {
      const kept = []
      for (const post of list) {
        if (isBotPendingPost(post)) {
          rememberStoppedRelay(post.exchangeId)
          rememberStoppedRelay(post.reportId)
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
            roomAgent.inbox.remove(message.id)
          }
        }
      }
    } catch {}
  }

  async function stopOtherRoomWork(roomId, keepBotId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const running = runningRound(room.id)
    if (running !== undefined && Array.isArray(running.slots)) {
      for (const slot of running.slots) {
        if (slot.id === keepBotId || slot.status !== 'waiting') continue
        slot.status = 'cancelled'
        if (slot.workId !== undefined) writableDb()?.stopWork(slot.workId, { reason: 'Stopped other room work' })
      }
      running.nudge?.()
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
    return stopped
  }
  rt.stopOtherRoomWork = stopOtherRoomWork

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
    const handle = writableDb()
    if (handle !== null) {
      for (const work of listActiveRoomWorks(room.id)) {
        handle.stopWork(work.workId, { reason: 'Stopped by the user' })
      }
      resetRoomChainProgress(room)
    }
    stopRoomReports(room.id)
    await cancelRoomQueues(room)
    rt.goalUserStopped?.(room.id)
    void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
    if (failures.length > 0) throw failures[0]
    return round || stopped
  }
  rt.stopRoomWork = stopRoomWork

  Object.assign(rt, {
    workingInRoom: workingIn,
    roomBatchPending: roomId => hasActiveRoomCalls(roomId),
    openRoomCall,
    checkRoomProgressStagnation: checkProgressStagnation,
    checkRoomCallCycle: (roomId, callerBotId, targetBotId, opts) => waitsOnMember(existingDb(), roomId, callerBotId, targetBotId, opts),
    reconcileStoppedRoomTask: async (roomId, botId) => {
      const room = rt.roomOf(roomId)
      const member = rt.botOf(botId)
      if (room === undefined || member === undefined || activeInRoom(room, botId)) return
      const { wokenCount } = await exitMemberRoomCalls(room, botId, {
        member,
        outcome: 'stopped',
        firstPost: () => ({ text: '', extra: { late: true, stopped: true } }),
      })
      if (wokenCount === 0) {
        void rt.goalSettled?.(room).catch(error => rt.warn('ds-bot: goal settle in %s failed: %s', room.name, error))
        void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
      }
    },
  })

  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    clearPresented(room.id, member.id)
    enterLate(room.id)
    try {
      const workId = activeWorkIdForSession(sessionId, info)
      const beforeWork = workId !== undefined ? writableDb()?.getWork(workId) : undefined
      if (beforeWork !== undefined && (TERMINAL_STATUSES.has(beforeWork.status) || isHeldRoomStatus(beforeWork.status))) {
        return
      }
      const { code, status, message } = failure
      const failText = `Could not finish: its model call failed (${failureLine(failure)}).`
      const failExtra = { late: true, failed: { code, ...(status ? { status } : {}), message } }
      rt.goalTaskReset?.(room.id, member.id, 'Could not finish: its model call failed')
      noteFailure(room, member, failure)
      if (workId !== undefined) {
        await settleRoomCallWork(room, workId, 'failed', {
          member,
          text: failText,
          error: failure,
          firstPost: () => ({ text: failText, extra: failExtra }),
        })
      } else {
        await postToRoom(room, member, failText, { ...failExtra, quiet: true, route: roomVisible() })
      }
      await rt.save()
    } finally {
      if (info?.exchangeId !== undefined) explicitCallsByExchange.delete(info.exchangeId)
      leaveLate(room.id)
      void settleRoomReports(room.id).catch(error => rt.warn('ds-bot: settling reports in %s failed: %s', room.name, error))
    }
  }
  rt.lateRoomFailure = lateRoomFailure

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

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      const room = rt.roomOf(options.sessionId)
      if (room === undefined) {
        yield* next()
        return
      }
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff' || message.source.role === 'goal')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
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
      const roundId = `${Date.now()}-${randomUUID()}`
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
