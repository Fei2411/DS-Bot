// Turns: what each Bot Session is doing now (for its mascot), which turns another Bot
// triggered, the waiters and inboxes of group rounds, and routing a finished turn's reply.
//
// Turn tracking: which turns were triggered by another Bot, and what they said.
import { randomUUID } from 'node:crypto'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { HANDOFF_ACK, LATE_ANSWER, MESSAGE_INLINE_MAX, REFERENCE_KIND, REPLY_KIND, SOURCE_KIND, STEER_CUT } from './constants.js'
import { cleanText } from './diagnostics.js'
import { absoluteLinks } from './links.js'
import { splitRef, textOf } from './text.js'
import { viaOf } from '../shared/im-platforms.js'
import { reminderText } from './schedules.js'
import { usageChunk } from './usage.js'

// Failures only the user can fix: a key, a sign-in, a balance. They block the Bot
// until it is fixed (`bot.blocked`, for the repair card).
export const BLOCKING_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'LOCAL_AGENT_MISSING', 'LOCAL_AGENT_SIGNIN', 'LOCAL_AGENT_QUOTA', 'LOCAL_AGENT_EXIT'])
// The ones a key set outside a turn can fix, and the ones a sign-in can (unblockBots).
// A balance only a turn that completes shows fixed, as Retry runs one.
const KEY_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'])
const SIGN_IN_CODES = new Set(['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID'])

// A failed turn's `LlmFailure`, kept to what can be shown and logged. Like DSH's own
// error row, an AUTH failure loses its message: providers may echo part of the key.
// DSH maps every HTTP 403 to AUTH, but an upstream also uses 403 for a content audit,
// and the body says which one it is. A rekey cannot fix an audit, so it keeps its own
// code; the audit body and request id stay for the card and the diagnostics.
const CONTENT_POLICY = /content[\s_-]?polic|content[\s_-]?violation|content[\s_-]?filter|内容审计|内容安全|风险规则/i
const REQUEST_ID = /(?:request[-_ ]?id|x-request-id)["'\s:=]+([A-Za-z0-9._:-]{6,})/i

const requestIdOf = (message) => {
  const found = REQUEST_ID.exec(message)
  return found === null ? undefined : found[1].replace(/[.,;:)+]+$/, '')
}

export function turnFailure(error) {
  const rawCode = typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN'
  const raw = typeof error?.message === 'string' ? error.message.trim() : ''
  const contentPolicy = rawCode === 'AUTH' && error?.status === 403 && CONTENT_POLICY.test(raw)
  const code = contentPolicy ? 'CONTENT_POLICY' : rawCode
  const message = code === 'AUTH' || raw === '' ? '' : cleanText(raw).slice(0, 500)
  const requestId = typeof error?.requestId === 'string' && error.requestId !== '' ? error.requestId : requestIdOf(raw)
  return {
    code,
    message,
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

export const failureLine = failure => `${failure.code}${failure.status ? ` ${failure.status}` : ''}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}`

// The reply a sender waits for, sent the way a finished turn sends it: the work it was
// for closes, and the answer goes up to the Bot that asked. `id` is the Session the
// answer comes from; `source` is the trigger the turn answered.
export function answerSender(rt, id, source, text, long) {
  const back = rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
  const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
  const work = rt.closeWork?.(source.exchangeId, name, text)
  // A reply that arrives after the user gave up the wait is a late answer: it closes
  // nothing, opens nothing, and says on it that the wait was already over.
  const late = work === undefined ? rt.abandonedWork?.(source.exchangeId) : undefined
  const marker = late === undefined ? '' : LATE_ANSWER
  const body = marker === '' ? (long?.text ?? text) : `${marker}${long?.text ?? text}`
  const length = long === undefined ? undefined : late === undefined ? long.length : (long.length ?? text.length) + marker.length
  const exchangeId = randomUUID()
  void rt.deliver({
    fromId: rt.selfOf(id),
    toId: source.senderSessionId,
    ...(back ? { sessionId: back } : {}),
    text: body,
    ...(length === undefined ? {} : { files: long.files, length }),
    role: 'reply',
    replyTo: source.exchangeId,
    exchangeId,
    ...(work ? { work } : {}),
  }).catch((error) => {
    rt.warn('ds-bot: reply delivery failed: %s', error)
    // The reply never reached the asker: its note goes — the notice below carries
    // what it answered — the result kept with the work is marked, and the failure
    // reaches the asker the way the reply would have, so the work goes on and its
    // answer names it.
    rt.forgetDelivery?.(exchangeId)
    rt.answerMissed?.(source.exchangeId)
    const said = `${name} could not send its reply to you (${failureLine(turnFailure(error))}); what it had answered:\n`
    void rt.deliver({
      fromId: rt.selfOf(id),
      toId: source.senderSessionId,
      ...(back ? { sessionId: back } : {}),
      text: `${said}${long?.text ?? text}`,
      ...(long?.length === undefined ? {} : { files: long.files, length: said.length + long.length }),
      role: 'reply',
      replyTo: source.exchangeId,
      ...(work ? { work } : {}),
    }).catch(again => rt.warn('ds-bot: reply failure notice not delivered: %s', again))
  })
}

// A group's own Session never reaches a model, so the snapshot DSH prepared there
// rides with the user's queued message to the members who answer it.
export function attachReference(queued, source, text) {
  const post = queued?.findLast(item => item.botId === undefined && item.kickoff !== true)
  if (post === undefined || text === '') return
  const labels = (Array.isArray(source?.references) ? source.references : [])
    .map(reference => reference?.label).filter(label => typeof label === 'string' && label !== '')
  post.references = [...(post.references ?? []), { labels, text }]
}

// A tool call some models write into their text instead of making it (the XML-like
// form of their own chat template). A reply cut off in the middle of such a call can
// keep only its closing tags, so those count as one too, or only the first tags of a
// parameter. Some models write the CJK brackets, so both forms match.
const TAG_OPEN = '[<＜]'
const TAG_CLOSE = '[>＞]'
const TOOL_CALL_TAG = `${TAG_OPEN}tool_call${TAG_CLOSE}`
const FUNCTION_TAG = `${TAG_OPEN}function=[\\w.-]+${TAG_CLOSE}`
const PARAMETER_TAG = `${TAG_OPEN}parameter=[\\w.-]+${TAG_CLOSE}`
const CLOSING_TAG = `${TAG_OPEN}/(?:parameter|function|tool_call)${TAG_CLOSE}`
const WRITTEN_CALL = new RegExp(`${TOOL_CALL_TAG}\\s*${TAG_OPEN}function=|${FUNCTION_TAG}\\s*${TAG_OPEN}parameter=|${CLOSING_TAG}`)
export const writesToolCall = text => typeof text === 'string' && WRITTEN_CALL.test(text)
export const stripWrittenCalls = text => text
  .replace(new RegExp(`${TOOL_CALL_TAG}[\\s\\S]*?(?:${TAG_OPEN}/tool_call${TAG_CLOSE}|$)`, 'g'), '')
  .replace(new RegExp(`${FUNCTION_TAG}[\\s\\S]*?(?:${TAG_OPEN}/function${TAG_CLOSE}|$)`, 'g'), '')
  .replace(new RegExp(`(?:${CLOSING_TAG}|${PARAMETER_TAG})\\s*`, 'g'), '')
  .trim()

// Under DSH's PTC presentation the model calls only this tool; the program's sub-calls
// are the tools it really runs.
const PROGRAM_TOOL = 'run_code'
// DSH's delegation tools, named by the tool instance: a spawn child and a fork.
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])
// A settled child's closing text, or why it ended without one. A child that did
// not finish says so: output it left behind can be partial, so the reason it
// ended is part of its result.
const subEndText = (data) => {
  const text = textOf(data?.lastAssistantMessage)
  const reason = typeof data?.stopReason === 'string' ? data.stopReason : ''
  if (text === '') return `subagent ended${reason === '' ? '' : ` (${reason})`} without a closing message.`
  return reason === '' || reason === 'completed' ? text : `subagent ended (${reason}) before it finished. What it had written:\n${text}`
}

// A settlement notice is all a plugin loaded again has of an ending (#973): its
// runtime-owned summary names how the child stopped without carrying raw output into
// the group ledger.
const noticeStopReason = (source, content) => {
  const said = typeof source?.summary === 'string' && source.summary !== ''
    ? source.summary
    : (textOf(content).split('\n')[0] ?? '')
  const rest = said.replace(/^Background subagent \S+\s+/, '')
  if (rest === '' || rest.startsWith('finished')) return undefined
  if (rest.startsWith('was stopped')) return 'aborted'
  if (rest.startsWith('ran out of room')) return 'max-tokens'
  if (rest.startsWith('declined')) return 'refusal'
  if (rest.startsWith('failed')) return 'error'
  return /^ended abnormally \(([^)]*)\)/.exec(rest)?.[1] ?? 'error'
}

const RETRY_TEXT = 'Your last reply wrote a tool call as plain text (<tool_call>…), so it did not run and nothing happened. Call the tool through the tool interface now, then reply as you meant to.'
const RETRY_PROMISE_TEXT = 'Your last reply said you would start working, but you ended the turn without calling any tool, so nothing ran. Call the tools you need and do the work now. If your last reply already was your whole answer, reply [PASS]; it stays posted.'
// The turn number a running turn gets when it started before this plugin was loaded and
// dsh does not say which number it has. dsh numbers turns from 1, so this one is unused.
const RECOVERED_TURN = -1
// A turn cut off at the model's output limit is not a finish. Whoever reads its answer
// is told, so half an answer is not taken as the whole one and silence is not taken as
// a deliberate one.
const CUT_OFF_NOTE = '[cut off at the model\'s output limit; the answer is not complete]'
const CUT_OFF_EMPTY_NOTE = '[cut off at the model\'s output limit before it wrote anything]'
// The answer a cut-off turn leaves: what it said, marked as unfinished, or the line
// that stands in for a turn that wrote nothing at all.
export const cutOffText = said => (said === '' ? CUT_OFF_EMPTY_NOTE : `${said}\n\n${CUT_OFF_NOTE}`)
// A finish far below the prepared request's own output budget can be a route's
// smaller context window. Unknown budgets provide no evidence for that inference.
export function prematureCutOff(usage, route) {
  const limit = Number(route?.maxTokens)
  const output = Number(usage?.outputTokens)
  const input = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0)
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(output) && output >= 0
    && output < limit / 8 && input >= limit
}

// A reply that only promises to start investigating/checking/running tools now without
// actually calling a tool or handing off with @Name (#469). A verb followed by 过了,
// 完了, 完毕 or 好了 reports work that is done; 查看过去… still promises. A miss leaves
// the work undone, while a wrong match only costs a turn the member can pass, so the
// rest of the reply is not judged.
const PROMISED_WORK = /(?:^(?:收到|好的|明白|好|行|没问题|了解)[，,、。.!！：\s]*(?:我(?:现在|这就|先|马上|立刻|去|来)?(?:开始|着手|去|来|准备)?(?:排查|检查|调查|查看|看看|搜索|搜一下|分析|处理|执行|运行|跑一下|修改|修复|实现|编写|整理|验证|测试|读一下|翻一下)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|(?:现在|马上|立刻)?(?:开始|着手)(?:执行|处理|排查|检查|调查|干活|开工)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|开工(?:[。！!，,\s]|$))|^(?:开工(?:[。！!，,\s]|$)|我(?:现在|这就|先|马上|立刻)(?:开始|着手|去)(?:排查|检查|调查|查看|搜索|分析|处理|执行|运行|修改|修复|实现|编写|整理|验证|测试)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了))|\b(?:(?:i\s+will|i'll|let\s+me|going\s+to)\s+(?:start|begin|check|look\s+into|investigate|search|run|inspect|read|fix|implement|work\s+on)\b|(?:starting|beginning)\s+(?:the\s+)?(?:investigation|check|search|work|execution|analysis)\b|^on\s+it[,.\s!]+(?:i'll|i\s+will|let\s+me|starting|checking)\b))/i
export const promisesWork = text => typeof text === 'string' && text.trim().length <= 240 && PROMISED_WORK.test(text.trim())

export function install(rt) {
  const { ctx, state } = rt

  // The retry goes where the turn's trigger came from: a group round's waiter or a
  // Bot's request keeps its exchange; anything else is a nudge in the Bot's own chat.
  const retryTurn = (id, info, note, text) => {
    const keeps = info !== undefined && (info.role === 'room' || expectsReply(info))
    return rt.deliver({
      ...(keeps && info.senderSessionId ? { fromId: info.senderSessionId } : {}),
      toId: rt.selfOf(id),
      sessionId: id,
      role: keeps ? info.role : 'retry',
      ...(keeps && info.roomId ? { roomId: info.roomId } : {}),
      ...(keeps && info.exchangeId ? { exchangeId: info.exchangeId } : {}),
      ...(info?.work ? { work: info.work } : {}),
      ...(keeps && info.audience ? { audience: info.audience } : {}),
      ...(keeps && info.askedBy ? { askedBy: info.askedBy } : {}),
      ...(keeps && info.senderRoomId ? { fromRoomId: info.senderRoomId } : {}),
      note,
      retried: true,
      text,
    })
  }
  const retryWrittenCall = (id, info) => retryTurn(id, info, 'your tool call did not run', RETRY_TEXT)
  const retryPromisedWork = (id, info) => retryTurn(id, info, 'you stopped before calling any tool', RETRY_PROMISE_TEXT)

  /** @type {Map<string, {turn?:number, pending?:any, pendingText?:string, info?:any, texts:string[], opened?:boolean, joined?:{info:any, from:number}[]}>} */
  const live = new Map()
  /** @type {Map<string, {sessionId:string, resolve:(text:string|null)=>void, fail:(failure:any)=>void, touch:()=>void, approval:()=>void}>} member turn waiters keyed by exchange id */
  const roomWaiters = new Map()
  /** @type {Map<string, {roomId:string, replies:any[], members:string[], speaking:string|null}>} */
  const roomProgress = new Map()
  /** @type {Map<string, {text:string, botId?:string, name?:string, reportBack?:boolean, kickoff?:boolean, references?:{labels:string[], text:string}[]}[]>} messages a room's next relay posts */
  const roomInbox = new Map()
  const queueRoomMessage = (roomId, item) => roomInbox.set(roomId, [...(roomInbox.get(roomId) ?? []), item])
  // Member turns of a group round the user stopped: what they end with stays out of the group.
  const stoppedRoomTurns = new Set()
  // Running DSH subagents spawned by each Bot Session: parentSessionId → Map<childId, {childId, label?, since}>.
  /** @type {Map<string, Map<string, {childId:string, label?:string, since:number}>>} */
  const subagentsByParent = new Map()
  /** @type {Map<string, string>} childId → parentSessionId */
  const subagentParent = new Map()
  // Subagent child IDs and parent Sessions whose subagents were stopped by the user;
  // late settlement notices from these stopped children must not wake the parent (#701).
  const stoppedSubagents = new Set()
  const stoppedSubagentParents = new Set()
  // Exchanges whose promise-only opening the group already got before the retry: the
  // retried turn counts it as shown, so a [PASS] there still hands the result back.
  const promisedOpenings = new Set()

  const STOPPED_KEPT = 200
  const rememberStopped = (set, value) => {
    set.add(value)
    if (set.size > STOPPED_KEPT) set.delete(set.values().next().value)
  }

  const subagentLabelFromCall = (entry) => {
    const call = [...(entry?.calls?.values() ?? [])].findLast(item => item.name === 'subagent')
    if (call === undefined) return undefined
    try {
      const args = JSON.parse(call.args || '{}')
      const raw = [args.description, args.label, args.prompt, args.task].find(value => typeof value === 'string' && value.trim() !== '')
      return raw?.replace(/\s+/g, ' ').trim().slice(0, 120)
    } catch {
      return undefined
    }
  }

  const noteSubagentStart = (parentId, childId, label, since = Date.now()) => {
    if (typeof parentId !== 'string' || parentId === '' || typeof childId !== 'string' || childId === '') return
    if (stoppedSubagents.has(childId) || (!rt.isBotSession(parentId) && !rt.roomOf(parentId))) return
    subagentParent.set(childId, parentId)
    let map = subagentsByParent.get(parentId)
    if (map === undefined) subagentsByParent.set(parentId, map = new Map())
    const existing = map.get(childId)
    map.set(childId, {
      childId,
      label: label || existing?.label || subagentLabelFromCall(live.get(parentId)),
      since: existing?.since ?? since,
    })
    if (rt.groupOwners.has(parentId)) rt.workRoomTurn?.(parentId, 'subagent')
  }

  // The settlement notice can arrive before subagent/end, so the label must outlive the
  // active entry; it is spent when the ending is read (#973).
  const endedSubagentLabels = new Map()
  const noteSubagentEnd = (childId) => {
    if (typeof childId !== 'string' || childId === '') return
    const parentId = subagentParent.get(childId)
    if (parentId === undefined) return
    const map = subagentsByParent.get(parentId)
    const label = map?.get(childId)?.label
    if (typeof label === 'string' && label !== '') {
      endedSubagentLabels.set(childId, label)
      while (endedSubagentLabels.size > 100) endedSubagentLabels.delete(endedSubagentLabels.keys().next().value)
    }
    map?.delete(childId)
    if (map !== undefined && map.size === 0) subagentsByParent.delete(parentId)
  }

  // The group sees one row for a failed helper: whichever ending names it first posts
  // it, and the other one adds nothing (#973).
  const notedSubagentFailures = new Set()
  const noteSubagentFailure = (parentId, childId, { stopReason, helper, closing }) => {
    if (typeof childId !== 'string' || childId === '' || notedSubagentFailures.has(childId)) return
    rememberStopped(notedSubagentFailures, childId)
    void rt.subagentFailureNotice(parentId, { stopReason, helper, closing })
      .catch(error => rt.warn('ds-bot: background helper failure not posted: %s', error))
  }

  const hasSubagents = id => (subagentsByParent.get(id)?.size ?? 0) > 0

  const subagentDoingOf = (id) => {
    const active = [...(subagentsByParent.get(id)?.values() ?? [])].at(-1)
    if (active === undefined) return undefined
    return { since: active.since, tool: 'subagent', ...(active.label ? { note: active.label.slice(0, 120) } : {}) }
  }

  async function stopSubagents(sessionId) {
    const map = subagentsByParent.get(sessionId)
    const childIds = [...(map?.keys() ?? [])]
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
      const header = agent?.session?.header
      // A fork names its parent too, but it is the user's own Session, not work to stop.
      if (header?.parentSession === sessionId && header.origin === 'subagent' && typeof agent.id === 'string' && !childIds.includes(agent.id)) {
        childIds.push(agent.id)
      }
    }
    if (childIds.length === 0) return false
    subagentsByParent.delete(sessionId)
    stoppedSubagentParents.add(sessionId)
    for (const childId of childIds) {
      rememberStopped(stoppedSubagents, childId)
      // Not in the plugin's inject list, where ctx.subagents throws; interrupt can throw too.
      try { await ctx.get?.('subagents')?.interrupt?.(childId, { kind: 'user', parentSessionId: sessionId }) } catch {}
      const childAgent = ctx.get?.('agents')?.get?.(childId)
      if (childAgent !== undefined) {
        try { childAgent.cancel?.({ kind: 'user' }) } catch {}
      }
    }
    const parent = await rt.resolveAgent(sessionId).catch(() => undefined)
    for (const message of [...(parent?.inbox?.nextStep ?? []), ...(parent?.inbox?.nextTurn ?? [])]) {
      if (message?.source?.kind === 'subagent-settled' || stoppedSubagents.has(message?.source?.senderSessionId)) {
        parent.inbox.remove(message.id)
      }
    }
    return true
  }

  // A plugin update replaces the files under a running dsh and loads the plugin again
  // in place: the process keeps its turns and child agents, while the maps above start
  // empty. Adopt what dsh still runs from its live Agents, so Stop, the group view and
  // a late child settle still see it: a subagent child belongs to the Session in its
  // header, and a Bot Session whose Agent runs is mid-turn. A running call is not in
  // dsh's registry, so an adopted turn shows as working without its call line.
  async function adoptLiveWork() {
    const agents = ctx.get?.('agents')
    if (agents?.list === undefined) return
    await rt.load()
    const known = id => rt.isBotSession(id) || rt.roomOf(id) !== undefined
    for (const agent of agents.list()) {
      if (agent?.status !== 'running') continue
      const sessionId = agent?.session?.id ?? agent?.id
      const header = agent?.session?.header
      const parentId = header?.parentSession
      if (typeof parentId === 'string' && header?.origin === 'subagent' && known(parentId)) {
        noteSubagentStart(parentId, sessionId, undefined, Date.now())
        continue
      }
      if (typeof sessionId !== 'string' || !known(sessionId)) continue
      const entry = liveOf(sessionId)
      if (entry.turn !== undefined) continue
      entry.turn = RECOVERED_TURN
      // Its input was consumed before the reload; a later request joins this turn.
      entry.opened = true
      entry.since ??= Date.now()
      setActivity(sessionId, 'thinking')
    }
  }

  // A stopped round stops the member work it started: the turn that answers it, or the
  // delivery still waiting for the member's Session. An earlier turn there keeps going.
  // An exchange whose turn already ended stays in the set, so it is bounded.
  async function stopRoomTurn(sessionId, exchangeId) {
    rememberStopped(stoppedRoomTurns, exchangeId)
    await stopSubagents(sessionId)
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    if (agent === undefined) return
    const entry = live.get(sessionId)
    if (entry?.turn !== undefined && entry.info?.exchangeId === exchangeId) {
      agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      return
    }
    for (const message of [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]) {
      if (message.source?.exchangeId === exchangeId && agent.inbox.remove(message.id)) stoppedRoomTurns.delete(exchangeId)
    }
  }

  // The phone's Stop for a Bot's own-chat turn: the same cancel the group's
  // member stop uses — end the running turn and any subagents it spawned.
  async function stopChat(botId) {
    await rt.load()
    const sessionId = rt.chatOf(botId)
    if (sessionId === undefined) return false
    const turnRunning = live.get(sessionId)?.turn !== undefined
    const subRunning = hasSubagents?.(sessionId) === true
    if (!turnRunning && !subRunning) return false
    await stopSubagents(sessionId)
    if (turnRunning) {
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      agent?.cancel?.({ kind: 'user' })
    }
    return true
  }

  const liveOf = id => {
    let entry = live.get(id)
    if (entry === undefined) live.set(id, entry = { texts: [], shown: 0 })
    return entry
  }

  // What each running Bot is doing right now, for its mascot. Process-local: it is
  // rebuilt from live events and never saved.
  /** @type {Record<string, string>} */
  let activity = {}
  const activityOf = (tool) => {
    if (/^(message_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(tool)) return 'sending'
    if (tool === 'group_relay') return 'orbit'
    if (/search|fetch|browse|browser|read|grep|glob|list/i.test(tool)) return 'searching'
    return 'working'
  }
  const setActivity = (id, value) => {
    if (activity[id] === value) return
    const next = { ...activity }
    if (value === undefined) delete next[id]
    else next[id] = value
    activity = next
  }
  // The newest call still running, a program's sub-calls included, is what the Session
  // is doing.
  const showCall = (id, entry) => {
    const name = [...(entry.calls?.values() ?? [])].at(-1)?.name
    entry.tool = name
    if (name !== undefined) setActivity(id, name === 'ask_user' || name === 'show_view' ? undefined : activityOf(name))
    else if (entry.turn !== undefined) setActivity(id, 'thinking')
  }
  const startCall = (id, entry, callId, name, args) => {
    if (typeof callId === 'string') (entry.calls ??= new Map()).set(callId, { name, args })
    showCall(id, entry)
  }
  const endCall = (id, entry, callId) => {
    entry.calls?.delete(callId)
    showCall(id, entry)
  }

  const markExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ??= []
    if (!turns.includes(turn)) {
      turns.push(turn)
      if (turns.length > 400) turns.splice(0, turns.length - 400)
      void rt.save().catch(() => {})
    }
  }
  const unmarkExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ?? []
    if (!turns.includes(turn)) return
    state.exchangeTurns[sessionId] = turns.filter(other => other !== turn)
    void rt.save().catch(() => {})
  }

  // A request whose audience is the user is answered in the recipient's own chat: that
  // turn stays visible there and its reply is not routed back to the sender.
  const answersUser = info => info.role === 'request' && info.audience === 'user'
  // Roles whose turn owes the sender a reply: a 'stopped' notice asks the Bot to
  // acknowledge, exactly like a request.
  const expectsReply = info => info.role === 'request' || info.role === 'stopped'
  // A group Session speaks only in its group, so what its turns write goes there, also
  // for turns that a finished background job or a fresh part starts; a Bot's private
  // message to it is answered privately.
  const speaksInGroup = (id, info) => rt.groupOwners.has(id) && !(info !== undefined && expectsReply(info))

  // The group hears what the member says while it works. A text with a tool call goes
  // on at once; one without may be the turn's last, so it waits for the next text or the
  // turn's end, which shows the rest as the turn's reply.
  const showSteps = (id, entry, upTo) => {
    const info = entry.info
    if (entry.suppressedSubagent || !speaksInGroup(id, info) || (info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))) return
    for (; entry.shown < upTo; entry.shown += 1) {
      const text = stripWrittenCalls(entry.texts[entry.shown])
      if (text !== '') void rt.roomStepText?.(id, info, text, entry.shown === 0)?.catch(error => rt.warn('ds-bot: step text from %s not posted: %s', id, error))
    }
  }

  // The reply a sender waits for, also when it wrote from a group, where it gets the
  // reply in its Session there while it is still a member. A sender that asked for it
  // while working on another Bot's request goes on with that work when it reads it.
  // `long`: the text as attachLong sends it, when it went as a file.
  const tellSender = (id, source, text, long) => answerSender(rt, id, source, text, long)

  // Runs before a deleted Bot leaves the team. Its Sessions stop with it, and the
  // turn/end that follows is no longer the team's, so their activity and turn records go
  // now. Every Bot still waiting for its reply hears that it was deleted: the turn's
  // trigger, requests that joined the turn, and requests it has not read yet.
  async function releaseBot(botId, sessionIds) {
    const text = `${rt.botOf(botId)?.name ?? 'The other Bot'} was deleted before it could answer your message.`
    const waiting = new Map()
    for (const id of sessionIds) {
      await stopSubagents(id)
      const entry = live.get(id)
      const held = [entry?.info, entry?.pending, ...(entry?.joined ?? []).map(joined => joined.info)]
      if (entry?.turn !== undefined) {
        const agent = await rt.resolveAgent(id).catch(() => undefined)
        held.push(...[...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].map(message => message.source))
      }
      for (const source of held) {
        if (source?.kind === SOURCE_KIND && expectsReply(source) && !answersUser(source)) waiting.set(source.exchangeId, [id, source])
      }
      live.delete(id)
      setActivity(id, undefined)
    }
    // Work it was asked for and still waits on, outside any running turn.
    for (const source of rt.forgetBotWork?.(botId) ?? []) {
      if (!waiting.has(source.exchangeId)) waiting.set(source.exchangeId, [rt.chatOf(botId), source])
    }
    for (const [id, source] of waiting.values()) tellSender(id, source, text)
  }

  // A group Session is hidden as a whole, so its turns need no marking. A handoff
  // package that only opens a part is acknowledged with a fixed line, also hidden.
  const claimTrigger = (sessionId, entry, info) => {
    entry.info = info
    // A turn that was stopped for a part switch brings its joined requests along.
    if (Array.isArray(info.joined) && info.joined.length > 0) {
      entry.joined = info.joined.filter(item => item?.info !== undefined && item.info !== null)
    }
    if (rt.groupOwners.has(sessionId)) return
    if ((expectsReply(info) && !answersUser(info)) || info.role === 'room' || (info.role === 'handoff' && info.resume !== true)) {
      markExchangeTurn(sessionId, entry.turn)
    }
  }

  // Activity is tracked per Session; a Bot's mascot shows its own chat's, else a group's.
  const activityView = () => {
    const merged = {}
    for (const [id, value] of Object.entries(activity)) {
      if (!rt.groupOwners.has(id)) merged[rt.chatOwners.get(id) ?? id] = value
    }
    for (const [id, value] of Object.entries(activity)) {
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined) merged[owner.botId] ??= value
    }
    for (const [id, map] of subagentsByParent) {
      if (map.size === 0) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId !== undefined) merged[botId] ??= 'working'
    }
    // A Bot writing its handoff note is thinking; a group's own Session that moves
    // shows on the group's key.
    for (const job of rt.switchJobs()) {
      if (job.roomId === undefined) merged[job.botId] = 'thinking'
      else merged[job.botId ?? job.roomId] ??= 'thinking'
    }
    for (const approval of rt.approvalsView?.() ?? []) merged[approval.botId] = 'alert'
    // Waiting for work it handed on shows only while no turn of the Bot runs.
    for (const botId of Object.keys(rt.waitingView?.() ?? {})) merged[botId] ??= 'waiting'
    return merged
  }

  // What the newest running call does, in its own words: what the Bot said in the step
  // that made it, the call's description, or the file, search or site it works on.
  const doingOf = (entry) => {
    const call = [...(entry.calls?.values() ?? [])].at(-1)
    if (call === undefined) return {}
    const said = entry.step?.replace(/\s+/g, ' ').trim().slice(0, 160)
    let args
    try { args = JSON.parse(call.args || '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')?.replace(/\s+/g, ' ').trim()
    const note = first(['description', 'justification'])
    const path = first(['file_path', 'path'])
    const url = first(['url'])
    let site
    try { site = url && new URL(url).host } catch { site = undefined }
    const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site
    return { tool: call.name, ...(said ? { said } : {}), ...(note ? { note: note.slice(0, 120) } : {}), ...(target ? { target: target.slice(0, 80) } : {}) }
  }

  // Per Bot, the turn it is running and what it is doing; its own chat wins over a
  // group. A Bot writing its handoff note shows that.
  const workView = () => {
    const bots = {}
    for (const [id, entry] of live) {
      if (entry.turn === undefined) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined || (owner !== undefined && bots[botId] !== undefined)) continue
      bots[botId] = { since: entry.since, ...doingOf(entry), ...(owner ? { roomId: owner.roomId } : {}) }
    }
    for (const [id] of subagentsByParent) {
      const sub = subagentDoingOf(id)
      if (sub === undefined) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined || bots[botId] !== undefined) continue
      bots[botId] = { ...sub, ...(owner ? { roomId: owner.roomId } : {}) }
    }
    for (const job of rt.switchJobs()) {
      // `folder` marks the switch the chat must name: the working folder changed. A
      // group's own Session belongs to no Bot; the group's row shows it instead.
      if (job.botId === undefined) continue
      const work = { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.roomId ? { roomId: job.roomId } : {}) }
      if (job.roomId === undefined) bots[job.botId] = work
      else bots[job.botId] ??= work
    }
    return bots
  }

  // Per Session, when its running turn began.
  const turnsView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.since !== undefined)
    .map(([id, entry]) => [id, entry.since]))

  // Per Session, when the user last steered its running turn: the input the
  // activity row's phrase and clock restart from.
  const steeredView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.steeredAt !== undefined)
    .map(([id, entry]) => [id, entry.steeredAt]))

  // Per group, the members whose turn there is running or who move on to a fresh part;
  // the members answering in a round are marked, since the round shows them.
  const roomWorkView = () => {
    const speaking = new Set([...roomProgress.values()].flatMap(round => round.slots
      .filter(slot => slot.status === 'speaking').map(slot => `${round.roomId}:${slot.id}`)))
    const rooms = {}
    const add = (roomId, botId, work) => {
      if (rooms[roomId]?.some(item => item.botId === botId)) return
      rooms[roomId] = [...(rooms[roomId] ?? []), { botId, ...work, ...(speaking.has(`${roomId}:${botId}`) ? { speaking: true } : {}) }]
    }
    for (const [id, entry] of live) {
      const owner = rt.groupOwners.get(id)
      if (entry.turn !== undefined && owner !== undefined) add(owner.roomId, owner.botId, { since: entry.since, ...doingOf(entry) })
    }
    for (const [id] of subagentsByParent) {
      const owner = rt.groupOwners.get(id)
      const sub = owner !== undefined ? subagentDoingOf(id) : undefined
      if (sub !== undefined) add(owner.roomId, owner.botId, sub)
    }
    for (const job of rt.switchJobs()) {
      // `self`: the group's own Session moves; the group's activity row names it.
      if (job.roomId !== undefined) add(job.roomId, job.botId, { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.botId === undefined ? { self: true } : {}) })
    }
    return rooms
  }

  // What a running tool call is about, for an approval card: its own description and
  // the command, path or address it acts on.
  const callDetail = (sessionId, callId) => {
    let args
    try { args = JSON.parse(live.get(sessionId)?.calls?.get(callId)?.args ?? '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')
    const text = first(['description', 'justification'])
    const code = first(['command', 'cmd', 'file_path', 'path', 'url', 'query'])
    return { ...(text ? { text: text.trim().slice(0, 300) } : {}), ...(code ? { code: code.trim().slice(0, 400) } : {}) }
  }

  // Where a Session speaks, for the diagnostics log.
  const placeOf = (id) => {
    const room = rt.roomOf(rt.groupOwners.get(id)?.roomId) ?? rt.roomOf(id)
    return room ? `group "${room.name}"` : 'own chat'
  }
  const noteTurnFailure = (id, failure) => {
    rt.noteFailure({
      source: 'turn',
      text: failure.message || 'the model call failed',
      code: failure.code,
      status: failure.status,
      requestId: failure.requestId,
      bot: rt.botOf(rt.selfOf(id))?.name ?? (rt.roomOf(id) ? undefined : 'unknown Bot'),
      where: placeOf(id),
      sessionId: id,
    })
  }

  // The repair card reads DSH's own failure row, which can carry a code DS Bot has
  // corrected (a 403 content audit arrives as AUTH). Keep the corrected failure with
  // the part and turn it belongs to; the view sends it to the card, and the next
  // completed turn in that part drops it.
  const rememberFailure = (id, turn, failure, session) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot === undefined || turn === undefined) return
    const provider = session?.requestHeader?.()?.config?.provider
    const message = failure.message ? cleanText(failure.message, { redact: rt.redactSecrets }).slice(0, 500) : ''
    const failures = bot.failures ??= {}
    failures[id] = { turn, ...failure, message, ...(provider ? { provider } : {}), at: Date.now() }
    const keys = Object.keys(failures)
    if (keys.length > 6) {
      for (const key of keys.sort((a, b) => (failures[a].at ?? 0) - (failures[b].at ?? 0)).slice(0, keys.length - 6)) delete failures[key]
    }
    void rt.save().catch(() => {})
  }
  const forgetFailure = (id) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot?.failures?.[id] === undefined) return
    delete bot.failures[id]
    if (Object.keys(bot.failures).length === 0) delete bot.failures
    void rt.save().catch(() => {})
  }

  // A turn cut off at the output limit is not a finish, but no failure either. The
  // record names the route and the size of the input, so a route whose declared
  // window is larger than the service really serves can be found from it. A cut-off
  // far below the model's output limit also records what came out: that is the shape
  // of a route stopping the request at its real window (#1104, #1461).
  const noteCutOffTurn = (id, { session, wroteNothing, outputTokens }) => {
    const route = session.requestHeader?.()?.config
    const ref = route?.provider && route?.model ? `${route.provider}/${route.model}` : undefined
    const tokens = rt.sessionTokens?.(session)
    const facts = [
      ref,
      Number.isFinite(tokens) && tokens > 0 ? `${tokens} tokens in` : undefined,
      Number.isFinite(outputTokens) && outputTokens >= 0 ? `${outputTokens} tokens out` : undefined,
    ].filter(Boolean)
    rt.noteFailure({
      level: 'warn',
      source: 'turn',
      code: 'MAX_TOKENS',
      text: `${wroteNothing
        ? 'the turn was cut off at the output limit before it wrote anything'
        : 'the turn was cut off at the output limit, so its answer is not complete'}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`,
      bot: rt.botOf(rt.selfOf(id))?.name ?? (rt.roomOf(id) ? undefined : 'unknown Bot'),
      where: placeOf(id),
      sessionId: id,
    })
  }

  // The facts of a blocking failure stay on its Bot, from any of its Sessions, until a
  // turn of it completes, a change that can fix it (unblockBots), or its model changes
  // (roster.js). Never the message: a provider may echo part of the key. The provider
  // is the failing route's, which is the Session's last request, else the model the
  // Bot runs on.
  const blockBot = (id, session, failure) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot === undefined || !BLOCKING_CODES.has(failure.code)) return false
    const provider = session?.requestHeader?.()?.config?.provider ?? splitRef(bot.appliedModel)?.provider
    bot.blocked = {
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(provider ? { provider } : {}),
      at: Date.now(),
    }
    void rt.save().catch(() => {})
    return true
  }
  const unblockBot = (botId) => {
    const bot = rt.botOf(botId)
    if (bot?.blocked === undefined) return
    delete bot.blocked
    void rt.save().catch(() => {})
  }

  // A key set (`ref`) or a sign-in may be the user's fix (models.js): the blocks it can
  // fix lift, and a greeting held for one goes out again. A key lifts the key failures
  // of the providers that read it; one whose provider names no key, or that failed on
  // a provider not known, lifts on any key. A host that only reads the team leaves it
  // to the one that holds it.
  function unblockBots({ ref, signedIn = false, keyed } = {}) {
    if (rt.readOnly?.() !== undefined) return
    let refs
    try { refs = ref === undefined ? undefined : rt.keyRefs?.() } catch {}
    const fixes = ({ code, provider }) => (signedIn && SIGN_IN_CODES.has(code))
      || (ref !== undefined && KEY_CODES.has(code) && (refs?.get(provider) ?? ref) === ref)
      || (code === 'MISSING_CREDENTIAL' && provider !== undefined && keyed?.has(provider) === true)
    const lifted = Object.values(state.bots ?? {}).filter(bot => bot.blocked !== undefined && fixes(bot.blocked))
    if (lifted.length === 0) return
    for (const bot of lifted) delete bot.blocked
    void rt.save().catch(() => {})
    for (const bot of lifted) void rt.releaseKickoff(bot).catch(error => rt.warn('ds-bot: greeting of %s not sent again: %s', bot.name, error))
  }

  // The repair card's Retry. A greeting that failed goes out again; otherwise the Bot
  // answers the user's last message, which is not sent again. A greeting on its way, or
  // a turn under way in the Bot's chat, answers already: a turn on top answers twice.
  async function resumeBot(bot) {
    if (await rt.releaseKickoff(bot)) return
    if (rt.greetingOut?.(bot.id) || live.get(rt.chatOf(bot.id))?.turn !== undefined) return
    const code = bot.blocked?.code
    await rt.deliver({
      toId: bot.id,
      role: 'continue',
      text: `Your last turn failed${code ? ` (${code})` : ''} and the user has fixed it. Answer the user's last unanswered message.`,
    })
  }
  ctx.on?.('subagent/start', (info) => {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '' || stoppedSubagents.has(childId)) return
    const parentId = subagentParent.get(childId)
      ?? ctx.get?.('agents')?.get?.(childId)?.session?.header?.parentSession
      ?? [...live.entries()].find(([, entry]) => [...(entry.calls?.values() ?? [])].some(call => call.name === 'subagent'))?.[0]
    if (parentId === undefined) return
    // A child can run again after it settled; its next ending gets its own row.
    notedSubagentFailures.delete(childId)
    noteSubagentStart(parentId, childId, undefined)
  })
  ctx.on?.('subagent/end', function (info) {
    const parentId = carrierKeyOf(this)?.session?.id ?? subagentParent.get(info?.id)
    const helper = subagentsByParent.get(parentId)?.get(info?.id)?.label ?? endedSubagentLabels.get(info?.id)
    noteSubagentEnd(info?.id)
    endedSubagentLabels.delete(info?.id)
    const owner = rt.groupOwners.get(parentId)
    if (owner === undefined) return
    if (typeof info?.stopReason === 'string' && info.stopReason !== 'completed'
      && !stoppedSubagentParents.has(parentId) && !stoppedSubagents.has(info.id)) {
      noteSubagentFailure(parentId, info.id, { stopReason: info.stopReason, helper, closing: textOf(info?.lastAssistantMessage) })
    }
    void rt.goalSettled?.(rt.roomOf(owner.roomId)).catch(error => rt.warn('ds-bot: goal settle failed: %s', error))
  })

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (!rt.isBotSession(id) && !rt.roomOf(id)) {
      // A deleted Bot's Session can still be ending its turn; nothing of it stays.
      if (live.delete(id)) setActivity(id, undefined)
      return
    }
    const entry = liveOf(id)
    if (rt.groupOwners.has(id)) rt.touchRoomTurn?.(id)
    switch (event.type) {
      case 'subagent/catalog': {
        const childId = event.data?.childId
        const label = typeof event.data?.label === 'string' ? event.data.label.trim() : undefined
        noteSubagentStart(id, childId, label, event.time ?? Date.now())
        break
      }
      case 'tool/call': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.callId, name, String(event.data?.arguments ?? ''))
        // A program is as quick as the tools it runs, so its sub-calls decide.
        if (name !== PROGRAM_TOOL) {
          entry.toolCount = (entry.toolCount ?? 0) + 1
          if (rt.groupOwners.has(id)) rt.workRoomTurn?.(id, name)
        }
        break
      }
      case 'tool/ptc-dispatch-start': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.subCallId, name, JSON.stringify(event.data?.arguments ?? {}))
        entry.toolCount = (entry.toolCount ?? 0) + 1
        if (rt.groupOwners.has(id)) rt.workRoomTurn?.(id, name)
        break
      }
      case 'tool/ptc-dispatch':
        endCall(id, entry, event.data?.subCallId)
        break
      case 'tool/result':
        endCall(id, entry, event.data?.callId)
        break
      case 'turn/start':
        setActivity(id, 'thinking')
        entry.turn = event.data.turn
        entry.since = event.time ?? Date.now()
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.info = undefined
        entry.toolCount = 0
        entry.usage = undefined
        entry.suppressedSubagent = false
        // A turn turned away before its first step may end without a turn/end.
        entry.switched = false
        entry.answers = false
        entry.opened = false
        entry.joined = []
        entry.later = []
        entry.steeredAt = undefined
        entry.carried = false
        let claimedPending
        let claimedPendingText
        if (entry.pending !== undefined) {
          claimedPending = entry.pending
          claimedPendingText = entry.pendingText
          claimTrigger(id, entry, claimedPending)
          entry.pending = undefined
          entry.pendingText = undefined
        }
        if (entry.carry !== undefined) {
          const carry = entry.carry
          entry.carry = undefined
          entry.texts = carry.texts
          entry.shown = carry.shown
          entry.answers = carry.answers
          entry.joined = carry.joined
          entry.later = carry.later
          entry.toolCount = carry.toolCount ?? 0
          entry.opened = true
          entry.carried = true
          if (carry.info !== undefined) claimTrigger(id, entry, carry.info)
          entry.joined = carry.joined
          // A request the carry displaced as this turn's trigger keeps its deferred
          // place, the same as a request that joins a running turn.
          if (carry.info !== undefined && claimedPending !== undefined
            && claimedPending.exchangeId !== carry.info.exchangeId
            && (expectsReply(claimedPending) || claimedPending.role === 'room') && !answersUser(claimedPending)) {
            entry.joined = [...carry.joined, { info: claimedPending, text: claimedPendingText }]
          }
        }
        break
      case 'user/message': {
        const source = event.data?.source
        if (source?.kind === 'subagent-settled' || source?.kind === 'agent-message') {
          const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
          // Only settlement ends a child's turn; an intermediate `agent-message` keeps the
          // child active and preserves its label until it actually settles.
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            noteSubagentEnd(childId)
            if (rt.groupOwners.has(id)) void rt.goalSettled?.(rt.roomOf(rt.groupOwners.get(id).roomId)).catch(error => rt.warn('ds-bot: goal settle failed: %s', error))
          }
          if (stoppedSubagentParents.has(id) || (childId !== undefined && stoppedSubagents.has(childId))) {
            entry.suppressedSubagent = true
            void rt.resolveAgent(id).then(agent => agent?.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })).catch(() => {})
            break
          }
          // An ending the lifecycle event never brought here (a reload lost it) still
          // says why the child stopped: the notice names it, so the group's row appears.
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            const stopReason = noticeStopReason(source, event.data?.content)
            const label = endedSubagentLabels.get(childId)
            endedSubagentLabels.delete(childId)
            if (stopReason !== undefined && rt.groupOwners.has(id)) noteSubagentFailure(id, childId, { stopReason, helper: label })
          }
        } else if (source?.kind === 'user' || source?.kind === SOURCE_KIND) {
          stoppedSubagentParents.delete(id)
        }
        // A result that came back counts as taken once a turn reads it.
        if (source?.kind === SOURCE_KIND && source.work !== undefined && source.replyTo !== undefined) rt.takenWork?.(source.work, source.replyTo)
        // A message that shares a step with a bare handoff package is what the turn
        // answers, so the turn is not a hidden acknowledgement.
        const bare = info => info?.handoff === true && info.resume !== true
        // Whether the turn was already opened by an earlier message decides what a
        // Bot relay that lands inside it may claim: the first message of a turn
        // still claims it as today, a later one only joins it.
        const opened = entry.opened === true
        if (entry.turn !== undefined && !bare(source)
          && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === 'schedule' || source?.kind === SOURCE_KIND)) {
          entry.opened = true
        }
        if (entry.turn !== undefined && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === SOURCE_KIND)) {
          if (bare(source)) {
            if (entry.answers) break
          } else {
            entry.answers = true
            if (bare(entry.info)) {
              unmarkExchangeTurn(id, entry.turn)
              entry.info = undefined
            }
          }
        }
        if (source?.kind === SOURCE_KIND && source.role === 'post' && rt.roomOf(id)) {
          // A long post comes as a file (attachLong), which stays with its line.
          const files = (Array.isArray(event.data.content) ? event.data.content : []).filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
          queueRoomMessage(rt.roomOf(id).id, {
            text: textOf(event.data.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(files.length > 0 ? { files } : {}),
            botId: source.senderSessionId,
            name: source.senderName,
            reportBack: source.reportBack === true,
            ...(source.claims === undefined ? {} : { claims: source.claims }),
            ...(source.member ? { member: true } : {}),
            // Who the whole post called. `text` may be only its opening (attachLong).
            ...(source.mentions ? { mentions: source.mentions } : {}),
            ...(source.sub ? { sub: source.sub } : {}),
            ...(source.late ? { late: true } : {}),
            ...(source.progress ? { progress: true } : {}),
            ...(source.quiet ? { quiet: true } : {}),
            ...(source.failed ? { failed: source.failed } : {}),
            ...(source.resumed ? { resumed: true } : {}),
            ...(source.again ? { again: true } : {}),
            ...(source.stopped ? { stopped: true } : {}),
            ...(source.done ? { done: true } : {}),
            ...(source.askedBy ? { askedBy: source.askedBy } : {}),
            ...(source.batch ? { batch: source.batch } : {}),
            ...(source.batchEnd ? { batchEnd: true } : {}),
            ...(source.fromRoomId ? { fromRoomId: source.fromRoomId } : {}),
            // A post written into a running round already carries its log seq, or true
            // when its event needed none; the relay must not write it again.
            ...(source.logged !== undefined ? { logged: source.logged } : {}),
            ...(source.called ? { called: true } : {}),
          })
        } else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
          queueRoomMessage(rt.roomOf(id).id, { text: '', kickoff: true })
        } else if (source?.kind === SOURCE_KIND && source.role === 'goal' && rt.roomOf(id)) {
          // A goal message — the user's draft ask, an idle goal check, a resume —
          // opens a round of its own; the draft ask is the user's line.
          queueRoomMessage(rt.roomOf(id).id, {
            text: textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(source.goal !== undefined ? { goal: source.goal } : {}),
            ...(source.goalId !== undefined ? { goalId: source.goalId } : {}),
          })
        } else if (source?.kind === SOURCE_KIND) {
          if (entry.turn === undefined) {
            entry.pending = source
            entry.pendingText = textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
          }
          else if (!opened) claimTrigger(id, entry, source)
          else if (source.work !== undefined && source.work !== rt.workOf?.(entry.info) && !expectsReply(source)) {
            // A result for other work than this turn's informs it, and comes back in a
            // turn of its own once this one ends, which goes on with that work.
            entry.later = [...(entry.later ?? []), { info: source, text: textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '') }]
          } else if ((expectsReply(source) || source.role === 'room') && !answersUser(source)
            && source.exchangeId !== entry.info?.exchangeId
            && !(entry.joined ?? []).some(joined => joined.info.exchangeId === source.exchangeId)) {
            // A request that lands inside a running turn steers that work but is
            // answered in a hidden turn of its own once the work is done, so the
            // sender never gets the turn's text. A failed-switch resume message
            // re-sends the trigger's own source; the same exchangeId must not join twice.
            const text = textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
            entry.joined = [...(entry.joined ?? []), { info: source, text }]
          }
          // A mid-turn relay that owes no reply only informs the turn: it neither
          // claims the running turn nor queues as the next one's trigger.
        } else if (source?.kind === 'schedule' && rt.roomOf(id)) {
          // A group's scheduled task reaches the group as the user's message.
          queueRoomMessage(rt.roomOf(id).id, { text: reminderText(textOf(event.data.content)) })
        } else if (source?.kind === REFERENCE_KIND && rt.roomOf(id)) {
          attachReference(roomInbox.get(rt.roomOf(id).id), source, textOf(event.data.content))
        } else if (source?.kind === 'subagent-settled') {
          // A settled sub-run's notice: the work it hung under goes on once a turn
          // reads it, like a reply that came back. The notice names only the child;
          // its run is the earliest of the child's not read yet. One read while a
          // turn does other work comes back in a turn of its own, like any
          // handed-back result.
          const run = rt.subWorkRun?.(source.senderSessionId)
          if (run !== undefined) {
            rt.takenWork?.(run.parent, run.id)
            const info = { kind: SOURCE_KIND, role: 'reply', work: run.parent, replyTo: run.id, exchangeId: run.id, senderSessionId: source.senderSessionId }
            if (entry.turn === undefined) entry.pending = info
            else if (entry.info === undefined && !opened) {
              // DSH opens the turn before it records the message that filled its
              // inbox: a notice that opened the turn claims it, like the first
              // relay of a turn.
              entry.opened = true
              entry.answers = true
              claimTrigger(id, entry, info)
            } else if (rt.workOf?.(entry.info) !== run.parent) entry.later = [...(entry.later ?? []), { info, text: textOf(event.data.content) }]
          }
        } else if (source?.kind === 'user' || source?.kind === REPLY_KIND) {
          if (rt.roomOf(id) && source.kind === 'user') {
            const content = Array.isArray(event.data.content) ? event.data.content : []
            const images = content.filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
            const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
            queueRoomMessage(rt.roomOf(id).id, { text: textOf(event.data.content), ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}), ...(viaOf(source) ? { via: viaOf(source) } : {}) })
          }
          const own = rt.chatOwners.get(id)
          if (own !== undefined) rt.userWrote(own)
          // Any user message answers or supersedes the open question card and view card.
          let dropped = false
          if (state.questions[id] !== undefined) {
            rt.closeCard(id, state.questions[id], 'replied')
            delete state.questions[id]
            dropped = true
          }
          if (state.views?.[id] !== undefined) {
            rt.closeCard(id, state.views[id], 'replied')
            delete state.views[id]
            dropped = true
          }
          if (dropped) void rt.save().catch(() => {})
        }
        break
      }
      case 'agent/inbox/spliced':
        // A message the user sends to a group while its round runs joins that round.
        if (rt.roomOf(id)) rt.nudgeRoom?.(rt.roomOf(id).id)
        if (stoppedSubagentParents.has(id)) {
          for (const inserted of event.data?.inserted ?? []) {
            if (inserted?.source?.kind === 'subagent-settled' || stoppedSubagents.has(inserted?.source?.senderSessionId)) {
              void rt.resolveAgent(id).then(agent => agent?.inbox?.remove(inserted.id)).catch(() => {})
            }
          }
        }
        // A message the user steered into the running turn is fresh input, like
        // a send that never queued.
        if (event.data?.target === 'next-step' && entry.turn !== undefined
          && (event.data.inserted ?? []).some(message => message?.source?.kind === 'user')) {
          entry.steeredAt = event.time ?? Date.now()
        }
        break
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content)
        const called = Array.isArray(content) && content.some(block => block?.type === 'tool-call')
        const messageUsage = event.data?.usage ?? usageChunk(event.data?.stream)
        if (messageUsage !== undefined) entry.usage = messageUsage
        if (text !== '' && text !== HANDOFF_ACK) {
          // What a turn says goes on to the group or the sender, read from other folders.
          entry.texts.push(absoluteLinks(text, rt.sessionFolder?.(session)))
          if (entry.turn !== undefined) showSteps(id, entry, called ? entry.texts.length : entry.texts.length - 1)
        }
        entry.lastText = text
        entry.lastCalled = called
        entry.step = called && text !== HANDOFF_ACK ? stripWrittenCalls(text) || undefined : undefined
        break
      }
      case 'turn/end': {
        setActivity(id, undefined)
        // A steer cut leaves the turn's routing state for the fresh turn that
        // claims the steer: nothing is answered or delivered for the cut one.
        const cut = entry.cut
        entry.cut = undefined
        const steerCut = cut !== undefined && event.data?.reason?.kind === 'aborted'
          && event.data.reason.reason?.kind === 'hook' && event.data.reason.reason.reason === STEER_CUT
        if (steerCut) {
          entry.carry = { info: entry.info, joined: entry.joined ?? [], later: entry.later ?? [], texts: entry.texts.slice(0, cut.texts), shown: entry.shown, answers: entry.answers, toolCount: entry.toolCount ?? 0 }
        }
        const info = entry.info
        const joined = entry.joined ?? []
        // What the group already saw of the turn is not posted again.
        const texts = entry.texts.slice(entry.shown)
        // Whether the turn wrote any text, also text the group already saw.
        const wroteText = entry.texts.length > 0
        const shown = entry.shown > 0 || (info?.retried === true && promisedOpenings.delete(info.exchangeId))
        const { lastText, lastCalled } = entry
        const usage = entry.usage
        const toolCount = entry.toolCount ?? 0
        const suppressedSubagent = entry.suppressedSubagent === true
        // A turn stopped for a switch goes on in the next part, which answers instead.
        const switched = entry.switched === true
        // A turn the plugin watched start. A turn/end replayed after a restart, whose
        // turn is settled from the Session's log, is not one (resume.js does that).
        const watched = entry.turn !== undefined
        const turn = entry.turn
        entry.turn = undefined
        entry.info = undefined
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.toolCount = 0
        entry.suppressedSubagent = false
        entry.switched = false
        entry.joined = []
        entry.since = undefined
        entry.steeredAt = undefined
        entry.tool = undefined
        entry.calls = undefined
        entry.lastText = undefined
        entry.lastCalled = undefined
        entry.usage = undefined
        const later = entry.later ?? []
        entry.later = []
        if (steerCut || suppressedSubagent) break
        for (const result of later) {
          void rt.deliver({
            fromId: result.info.senderSessionId,
            toId: rt.selfOf(id),
            text: result.text,
            role: result.info.role,
            exchangeId: result.info.exchangeId,
            replyTo: result.info.replyTo,
            work: result.info.work,
            ...(result.info.roomId ? { roomId: result.info.roomId } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: handing back a result failed: %s', error))
        }
        const reason = event.data?.reason
        const failure = reason?.kind === 'error' && !switched ? turnFailure(reason.error) : undefined
        if (failure !== undefined) noteTurnFailure(id, failure)
        // A route that is not a model endpoint refuses every generation; the failed
        // Session's own request names it, so it is refused everywhere from now on.
        if (failure?.code === 'HOSTED_ENGINE_ROUTE') {
          const config = session.requestHeader?.()?.config
          const ref = config?.provider && config?.model ? `${config.provider}/${config.model}` : undefined
          if (ref !== undefined) void rt.routeRefused(ref, rt.botOf(rt.selfOf(id))).catch(error => rt.warn('ds-bot: %s still failing: %s', ref, error))
        }
        const held = rt.groupOwners.has(id) ? rt.takeRoomSteps?.(id) ?? '' : ''
        if (switched) break
        const owner = rt.chatOwners.get(id)
        // A turn cut off at the output limit is not a finish: whoever reads its answer
        // is told, and the diagnostics record it. Nothing written at all, twice in a
        // row, is what a route over the window it really has leaves behind, and the
        // context check then moves the part on instead of sending the same size again.
        const cutOff = watched && failure === undefined && reason?.kind === 'max-tokens'
        const route = session.requestHeader?.()?.config
        const outputTokens = Number(usage?.outputTokens)
        const usedBudget = Number.isFinite(outputTokens) && Number(route?.maxTokens) > 0 && outputTokens >= Number(route.maxTokens)
        const wroteNothing = cutOff && !wroteText && !usedBudget
        const premature = cutOff && prematureCutOff(usage, route)
        rt.noteCutOffTurn?.(id, { withoutText: wroteNothing, premature })
        if (cutOff) noteCutOffTurn(id, { session, wroteNothing, ...(premature ? { outputTokens } : {}) })
        if (failure !== undefined) {
          if (watched) rememberFailure(id, turn, failure, session)
          if (blockBot(id, session, failure) && owner !== undefined && info?.role === 'kickoff') rt.holdKickoffAgain(owner)
        } else if (reason?.kind === 'completed') {
          forgetFailure(id)
          unblockBot(rt.selfOf(id))
          // A turn the user opened, or the Retry that answers the user.
          if (owner !== undefined && (info === undefined || info.role === 'continue')) rt.userAnswered(owner)
        }
        // A model that writes its tool call as text ends the turn as if it were done,
        // though nothing ran. It gets one more turn on the same trigger, so a waiting
        // round or sender gets the real answer; a second time, the text goes on without
        // the call.
        const wroteCall = failure === undefined && reason?.kind === 'completed' && lastCalled !== true && writesToolCall(lastText)
        const promisedOnly = !wroteCall && failure === undefined && reason?.kind === 'completed'
          && toolCount === 0 && lastCalled !== true && info?.role === 'room'
          && promisesWork(lastText) && !rt.callsRoomMember?.(id, info, lastText)
        const retry = (wroteCall || promisedOnly) && info?.retried !== true && !(info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))
        if (retry) {
          if (promisedOnly) {
            const opening = stripWrittenCalls(lastText ?? '')
            if (opening !== '') {
              rememberStopped(promisedOpenings, info.exchangeId)
              void rt.roomStepText?.(id, info, opening, !shown)?.catch(() => {})
            }
            roomWaiters.get(info.exchangeId)?.touch()
            void retryPromisedWork(id, info).catch(error => rt.warn('ds-bot: asking %s to run its promised work failed: %s', id, error))
          } else {
            void retryWrittenCall(id, info).catch(error => rt.warn('ds-bot: asking %s to run its written tool call failed: %s', id, error))
          }
        }
        const replyText = () => {
          const reply = (wroteCall ? texts.map(stripWrittenCalls) : texts).join('\n\n').trim()
          if (wroteCall && reply === '') return 'Tried to run a tool but wrote the call as text, so it did not run.'
          if (cutOff) return reply === '' && wroteText ? CUT_OFF_NOTE : cutOffText(reply)
          return reply
        }
        const groupReply = () => rt.withRoomSteps?.(held, replyText()) ?? replyText()
        // Whoever the turn answers gets the same three-way rule: a failure notice,
        // the turn's text (or a stopped-before-answer line), or nothing.
        const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
        const answer = (source, reply) => {
          if (!expectsReply(source) || answersUser(source)) return
          if (failure !== undefined) {
            // The sender was told a reply comes later; without this it would wait forever.
            tellSender(id, source, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
          } else if (reply !== '' || reason?.kind === 'aborted') {
            // A turn stopped before it could answer still owes the sender a line,
            // or it would wait forever for a reply that never comes.
            tellSender(id, source, reply !== '' ? reply : `${name} was stopped before it could answer your message.`)
          }
        }
        // Work a Bot asked for, also when what came back for it opens the turn: while
        // anything handed on for it is still out, the answer waits; then it goes up with
        // what came back. A failed or stopped turn answers at once.
        const finish = (source, reply) => {
          const work = rt.workOf?.(source)
          if (!rt.ownsWork?.(rt.selfOf(id), work)) return answer(source, reply)
          const asker = rt.workAsker(work)
          if (failure !== undefined || reason?.kind === 'aborted') return answer(asker, reply)
          if (rt.waitsWork(work)) return rt.holdWork(work, reply)
          // With what came back, the answer may pass what one message carries.
          const text = rt.answerText(work, reply, name)
          if (text.length <= MESSAGE_INLINE_MAX) return tellSender(id, asker, text)
          void rt.attachLong(text, `Answer from ${name}.txt`)
            .then(long => tellSender(id, asker, text, long))
            .catch(error => rt.warn('ds-bot: answer from %s not sent: %s', name, error))
        }
        // A retried turn answers the same waiter or sender, so this one passes nothing on.
        if (!retry && info?.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          const stopped = stoppedRoomTurns.delete(info.exchangeId)
          if (waiter !== undefined) {
            if (failure !== undefined) waiter.fail(failure)
            else waiter.resolve(reason?.kind === 'aborted' ? null : groupReply())
          } else if (!stopped && reason?.kind !== 'aborted') {
            // The round moved on without this member; how its turn ends still reaches the group.
            if (failure !== undefined) void rt.lateRoomFailure?.(id, info, failure)
            else void rt.lateRoomReply?.(id, info, groupReply(), { shown, toolCount })
          }
        } else if (!retry && speaksInGroup(id, info)) {
          // A turn that failed before it took any input (DSH can turn it down before its
          // first step) never names its call, so the call waiting on this Session fails.
          const inRound = failure !== undefined && info === undefined && rt.failRoomTurn?.(id, failure) === true
          if (failure !== undefined) { if (!inRound) void rt.lateRoomFailure?.(id, info ?? {}, failure) }
          else if (reason?.kind !== 'aborted') void rt.lateRoomReply?.(id, info ?? {}, groupReply(), { shown, toolCount })
        } else if (!retry && info !== undefined) {
          finish(info, replyText())
        }
        for (const request of joined) {
          if (request.info.role === 'room' && stoppedRoomTurns.delete(request.info.exchangeId)) continue
          // A failed or stopped turn closes the request like any other; a finished
          // one hands it back to the Bot to answer next.
          if (failure !== undefined || reason?.kind === 'aborted') {
            if (request.info.role === 'room') {
              if (failure !== undefined) void rt.lateRoomFailure?.(id, request.info, failure)
            } else answer(request.info, '')
            continue
          }
          void rt.deliver({
            fromId: request.info.senderSessionId,
            toId: rt.selfOf(id),
            sessionId: id,
            text: request.text,
            role: request.info.role,
            exchangeId: request.info.exchangeId,
            ...(request.info.role === 'room' ? { roomId: request.info.roomId, askedBy: request.info.askedBy, note: 'you read this call during your last task; answer it now' } : {}),
            ...(request.info.senderRoomId ? { fromRoomId: request.info.senderRoomId } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: deferred request delivery failed: %s', error))
        }
        if (rt.groupOwners.has(id)) void rt.goalSettled?.(rt.roomOf(rt.groupOwners.get(id).roomId)).catch(error => rt.warn('ds-bot: goal settle in %s failed: %s', id, error))
        break
      }
    }
  })

  // A subagent a Bot's turn delegates to is work handed on, like message_bot: each
  // run of the child hangs under the work the turn answers until its settlement
  // notice comes back, and its closing message joins that work's results. A child
  // can be sent more to do once it settled, and that is a fresh run on the same
  // child id, so the run — not the child — is the sub-work. These are Cordis
  // events, not Session events: the dispatch keys `this` by the delegating parent
  // Agent, which `carrierKeyOf` hands back.
  ctx.on('subagent/start', function (info) {
    const id = carrierKeyOf(this)?.session?.id
    const entry = id === undefined ? undefined : live.get(id)
    const work = rt.workOf?.(entry?.info)
    const self = id === undefined ? undefined : rt.selfOf(id)
    if (work === undefined || self === undefined || !rt.chatOwners.has(id) || typeof info?.id !== 'string' || typeof info?.runId !== 'string' || !rt.ownsWork?.(self, work)) return
    rt.openWork?.(info.runId, { from: self, parent: work, name: 'subagent', child: info.id })
  })
  // A settled run closes its sub-work: its closing text joins the results of
  // the work it hung under.
  ctx.on('subagent/end', (info) => {
    if (typeof info?.id !== 'string') return
    rt.settleSubWork?.(typeof info.runId === 'string' ? info.runId : info.id, subEndText(info), info.id)
  })
  ctx.on('tools/result', (exec, result) => {
    if (!SUBAGENT_TOOLS.has(exec?.name) || result?.isError || typeof result?.value?.subagentId !== 'string') return
    const description = exec.arguments?.description
    rt.nameSubWork?.(result.value.subagentId, `subagent${typeof description === 'string' && description.trim() !== '' ? ` ${description.trim()}` : ''}`)
  })

  const markSteerCut = (id) => {
    const entry = live.get(id)
    if (entry?.turn !== undefined) entry.cut = { texts: entry.texts.length }
  }

  // DSH's prompt admission wraps any unexpected failure as 'session/agent-busy' and
  // keeps the real cause in details.reason, which the window never shows and the log
  // never saw (#424). For a Session this team owns, the reason is written to the
  // diagnostics and put into the error the user reads.
  const prompt = ctx.sessionController?.prompt
  if (typeof prompt === 'function') {
    const controller = ctx.sessionController
    const admitted = async function (request, ...rest) {
      try {
        return await prompt.call(this, request, ...rest)
      } catch (error) {
        const id = request?.sessionId
        if (id === undefined || (rt.roomOf(id) === undefined && !rt.isBotSession(id))) throw error
        // The reason can name local paths or carry tokens, so the same cleaning the
        // diagnostics get applies before it reaches the client.
        const reason = typeof error?.details?.reason === 'string' && error.details.reason !== ''
          ? cleanText(error.details.reason, { redact: rt.redactSecrets })
          : undefined
        rt.noteFailure({
          source: 'prompt',
          text: `prompt rejected for ${placeOf(id)}${reason === undefined ? '' : `: ${reason}`}`,
          code: error?.code,
          where: placeOf(id),
          sessionId: id,
        })
        // The gateway passes a RemoteError's code and details on as they are, but
        // wraps a fresh plain Error as 'gateway/internal': the reason is written on
        // the rejection itself, keeping its identity.
        if (reason !== undefined) {
          error.message = `${error?.message ?? 'prompt rejected'} — ${reason}`
          error.details = { ...error.details, reason }
        }
        throw error
      }
    }
    ctx.effect(() => {
      controller.prompt = admitted
      return () => { if (controller.prompt === admitted) controller.prompt = prompt }
    }, 'ds-bot: prompt rejection reasons')
  }

  Object.assign(rt, { live, liveOf, roomWaiters, roomProgress, roomInbox, activityView, workView, roomWorkView, turnsView, steeredView, callDetail, doingOf, stopRoomTurn, stopChat, releaseBot, unblockBots, resumeBot, markSteerCut, hasSubagents, stopSubagents, adoptLiveWork })
}
