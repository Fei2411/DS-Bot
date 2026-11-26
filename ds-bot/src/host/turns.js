// Turns: live Session activity & mascot views, group round waiters/inboxes, failure
// diagnostics, and normalized turn lifecycle forwarding to `dsh-adapter.js` (`coordDb`).
import { randomUUID } from 'node:crypto'
import { symbols as cordisSymbols } from '@deepseek-ai/cordis'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { HANDOFF_ACK, isSilentTurnText, isWorkTool, LATE_ANSWER, MESSAGE_INLINE_MAX, REFERENCE_KIND, REPLY_KIND, SOURCE_KIND, STEER_CUT, USER_UI_TOOLS } from './constants.js'
import { cleanText } from './diagnostics.js'
import { absoluteLinks } from './links.js'
import { splitRef, textOf } from './text.js'
import { threadCurrentOfPart } from './threads.js'
import { viaOf } from '../shared/im-platforms.js'
import { reminderText } from './schedules.js'
import { usageChunk } from './usage.js'

// Failures only the user can fix: a key, a sign-in, a balance. They block the Bot
// until it is fixed (`bot.blocked`, for the repair card).
export const BLOCKING_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'LOCAL_AGENT_MISSING', 'LOCAL_AGENT_SIGNIN', 'LOCAL_AGENT_QUOTA', 'LOCAL_AGENT_EXIT', 'LOCAL_AGENT_ERROR'])
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

// Compatibility helper for direct/legacy non-coordDb request replies. Coordination-managed
// works settle atomically through `rt.coordDb.settleWork()` + `rt.kickScheduler()`.
export function answerSender(rt, id, source, text, long, options = {}) {
  const back = rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
  const asker = source.senderPart === undefined ? undefined : rt.botOf(source.senderSessionId)
  const part = back === undefined && asker !== undefined ? threadCurrentOfPart(asker, source.senderPart) : undefined
  const target = back ?? part
  const fromId = rt.selfOf(id)
  const toId = source.senderSessionId
  const name = rt.botOf(fromId)?.name ?? 'The other Bot'
  const deliveredReply = rt.deliveredReplyOf?.(fromId, toId, source.exchangeId)
  const alreadySent = deliveredReply !== undefined
    || (rt.deliveredReplyOf === undefined && rt.wasReplyDelivered?.(fromId, toId, source.exchangeId) === true)
  if (alreadySent) {
    if (typeof source.exchangeId === 'string' && source.exchangeId !== '') {
      rt.closeWork?.(source.exchangeId, name, deliveredReply?.text || text)
    }
    return false
  }
  if (typeof source.exchangeId === 'string' && source.exchangeId !== '' && rt.closedWorkOf?.(source.exchangeId)?.status === 'cancelled') {
    return false
  }
  const workBeforeClose = typeof source.exchangeId === 'string' && Object.hasOwn(rt.state?.works ?? {}, source.exchangeId) ? rt.state.works[source.exchangeId] : undefined
  const workRef = source.workRef ?? workBeforeClose?.ref ?? rt.workRefOf?.(source.exchangeId)
  const workWorked = workBeforeClose?.worked === true || options.worked === true
  const replyImOrigin = rt.workImOrigin?.(source.exchangeId)
  if (replyImOrigin !== undefined) rt.rememberImReplyOrigin?.(source.exchangeId, replyImOrigin)
  const work = rt.closeWork?.(source.exchangeId, name, text, {
    ...(workWorked ? { worked: true } : {}),
    ...(options.aborted === true ? { abandoned: true } : {}),
    ...(options.failure !== undefined ? { failed: true, error: options.failure } : {}),
    deliverDirect: true,
  })
  if (workBeforeClose !== undefined && options.failure === undefined && options.aborted !== true) {
    rt.noteWorkCompleted?.(workBeforeClose.from, workBeforeClose.to, { worked: workWorked, id: source.exchangeId, text })
  }
  const late = work === undefined ? rt.abandonedWork?.(source.exchangeId) : undefined
  const marker = late === undefined ? '' : LATE_ANSWER
  const body = marker === '' ? (long?.text ?? text) : `${marker}${long?.text ?? text}`
  const length = long === undefined ? undefined : late === undefined ? long.length : (long.length ?? text.length) + marker.length
  const failureRequestId = typeof options?.failure?.requestId === 'string' && options.failure.requestId !== ''
    ? options.failure.requestId
    : undefined
  const exchangeId = randomUUID()
  void rt.deliver({
    fromId,
    toId,
    ...(target ? { sessionId: target } : {}),
    text: body,
    ...(length === undefined ? {} : { files: long.files, length }),
    role: 'reply',
    replyTo: source.exchangeId,
    exchangeId,
    ...(work ? { work } : {}),
    ...(workRef ? { workRef } : {}),
    ...(failureRequestId === undefined ? {} : { failureRequestId }),
  }).catch((error) => {
    rt.warn('ds-bot: reply delivery failed: %s', error)
    rt.forgetDelivery?.(exchangeId)
    rt.answerMissed?.(source.exchangeId)
    const said = `${name} could not send its reply to you (${failureLine(turnFailure(error))}); what it had answered:\n`
    void rt.deliver({
      fromId,
      toId,
      ...(target ? { sessionId: target } : {}),
      text: `${said}${long?.text ?? text}`,
      ...(long?.length === undefined ? {} : { files: long.files, length: said.length + long.length }),
      role: 'reply',
      replyTo: source.exchangeId,
      ...(work ? { work } : {}),
      ...(failureRequestId === undefined ? {} : { failureRequestId }),
    }).catch((again) => {
      rt.warn('ds-bot: reply failure notice not delivered: %s', again)
    })
  })
  return true
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
// actually calling a tool or handing off with @Name (#469).
const PROMISED_WORK = /(?:^(?:收到|好的|明白|好|行|没问题|了解)[，,、。.!！：\s]*(?:我(?:现在|这就|先|马上|立刻|去|来)?(?:开始|着手|去|来|准备)?(?:排查|检查|调查|查看|看看|搜索|搜一下|分析|处理|执行|运行|跑一下|修改|修复|实现|编写|整理|验证|测试|读一下|翻一下)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|(?:现在|马上|立刻)?(?:开始|着手)(?:执行|处理|排查|检查|调查|干活|开工)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|开工(?:[。！!，,\s]|$))|^(?:开工(?:[。！!，,\s]|$)|我(?:现在|这就|先|马上|立刻)(?:开始|着手|去)(?:排查|检查|调查|查看|搜索|分析|处理|执行|运行|修改|修复|实现|编写|整理|验证|测试)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了))|\b(?:(?:i\s+will|i'll|let\s+me|going\s+to)\s+(?:start|begin|check|look\s+into|investigate|search|run|inspect|read|fix|implement|work\s+on)\b|(?:starting|beginning)\s+(?:the\s+)?(?:investigation|check|search|work|execution|analysis)\b|^on\s+it[,.\s!]+(?:i'll|i\s+will|let\s+me|starting|checking)\b))/i
export const promisesWork = text => typeof text === 'string' && text.trim().length <= 240 && PROMISED_WORK.test(text.trim())

export function install(rt) {
  const { ctx, state } = rt

  // The retry goes where the turn's trigger came from: a group round's waiter or a
  // Bot's request keeps its exchange; anything else is a nudge in the Bot's own chat.
  const retryTurn = (id, info, note, text) => {
    const keeps = info !== undefined && (info.role === 'room' || info.role === 'reply' || expectsReply(info))
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
      ...(keeps && info.batchKey ? { batchKey: info.batchKey } : {}),
      ...(keeps && info.resumedUpstream ? { resumedUpstream: true } : {}),
      ...(info?.resultRef ? { resultRef: info.resultRef } : {}),
      ...(info?.replyTo ? { replyTo: info.replyTo } : {}),
      ...(info?.workRef ? { workRef: info.workRef } : {}),
      ...(keeps && info.senderRoomId ? { fromRoomId: info.senderRoomId } : {}),
      ...(keeps && info.senderPart ? { fromPart: info.senderPart } : {}),
      note,
      retried: true,
      text,
    })
  }
  const retryWrittenCall = (id, info) => retryTurn(id, info, 'your tool call did not run', RETRY_TEXT)
  const retryPromisedWork = (id, info) => retryTurn(id, info, 'you stopped before calling any tool', RETRY_PROMISE_TEXT)

  /** @type {Map<string, {turn?:number, pending?:any, pendingText?:string, info?:any, texts:string[], opened?:boolean}>} */
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
  // Running DSH subagents spawned by each Bot Session: parentSessionId -> Map<childId, {childId, label?, since}>.
  /** @type {Map<string, Map<string, {childId:string, label?:string, since:number}>>} */
  const subagentsByParent = new Map()
  /** @type {Map<string, string>} childId -> parentSessionId */
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
    if (rt.groupOwners.has(parentId)) {
      rt.workRoomTurn?.(parentId, 'subagent')
      rt.markRoomReportsWorked?.(rt.groupOwners.get(parentId).roomId, rt.selfOf(parentId))
    }
    const taskOwner = rt.taskOwners?.get(parentId)
    if (taskOwner?.roomId !== undefined) rt.markRoomReportsWorked?.(taskOwner.roomId, taskOwner.botId)
    const taskWork = rt.taskBySession?.(parentId)?.task?.workId
    if (taskWork !== undefined) rt.markWorkWorked?.(taskWork)
  }

  // The settlement notice can arrive before subagent/end, so the label must outlive the
  // active entry; it is spent when the ending is read (#973).
  const endedSubagentLabels = new Map()
  const noteSubagentEnd = (childId) => {
    if (typeof childId !== 'string' || childId === '') return
    const parentId = subagentParent.get(childId)
    subagentParent.delete(childId)
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
      subagentParent.delete(childId)
      rememberStopped(stoppedSubagents, childId)
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

  // Rebuilds process-local live turn and subagent maps from currently running DSH Agents
  // after an in-place plugin reload. SQLite coordination adoption runs in `resume.js`
  // (`rt.adoptLiveWork()`), which invokes this helper first.
  async function adoptLiveTurnMaps() {
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
      entry.opened = true
      entry.since ??= Date.now()
      const adoptedTask = rt.taskBySession?.(sessionId)?.task
      if (adoptedTask?.origin === 'bot-handoff' && adoptedTask.exchangeId !== undefined && rt.ownsWork?.(rt.selfOf(sessionId), adoptedTask.exchangeId)) {
        const asker = rt.workAsker?.(adoptedTask.exchangeId)
        if (asker !== undefined) {
          entry.info = asker
          if (entry.texts.length === 0 && typeof agent.session?.snapshotEvents === 'function') {
            const events = agent.session.snapshotEvents()
            const startAt = events.findLastIndex(ev => ev?.type === 'turn/start')
            for (const ev of events.slice(startAt + 1)) {
              if (ev?.type !== 'assistant/message') continue
              const said = textOf(ev.data?.message?.content).trim()
              if (said !== '' && said !== HANDOFF_ACK) entry.texts.push(absoluteLinks(said, rt.sessionFolder?.(agent.session)))
            }
          }
        }
      }
      setActivity(sessionId, 'thinking')
    }
  }

  // A stopped round stops the member work it started: the turn that answers it, or the
  // delivery still waiting for the member's Session. An earlier turn there keeps going.
  async function stopRoomTurn(sessionId, exchangeId) {
    rememberStopped(stoppedRoomTurns, exchangeId)
    await stopSubagents(sessionId)
    const groupOwner = rt.groupOwners.get(sessionId)
    if (groupOwner !== undefined) {
      await rt.stopMemberRoomTasks?.(groupOwner.roomId, groupOwner.botId, 'group round stopped')
    }
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

  // Per DSH Agent, the turn one of its Sessions is running, for the phone.
  const agentWorkView = () => {
    const agents = {}
    for (const [id, entry] of live) {
      const agent = entry.turn === undefined ? undefined : rt.agentOf?.(id)
      if (agent !== undefined) agents[agent.id] = { since: entry.since, ...doingOf(entry) }
    }
    return agents
  }

  // Stop for a DSH Agent: cancels only `sessionId` when specified (and owned by this Agent),
  // or ends every running Session of the Agent when omitted (e.g. phone-wide Stop).
  async function stopAgent(agentId, sessionId) {
    await rt.load()
    const owned = rt.agentById?.(agentId)?.sessions ?? []
    const scope = typeof sessionId === 'string' && sessionId !== ''
      ? (owned.includes(sessionId) ? [sessionId] : [])
      : owned
    const running = scope.filter(id => live.get(id)?.turn !== undefined)
    for (const sid of running) {
      const agent = await rt.resolveAgent(sid).catch(() => undefined)
      agent?.cancel?.({ kind: 'user' })
    }
    return running.length > 0
  }

  // The phone's Stop for a Bot's own-chat turn: end the running turn and any subagents.
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

  const handingBack = new Map()
  const hasPendingHandback = sessionId => (handingBack.get(sessionId) ?? 0) > 0
  const trackHandback = (sessionId, promise) => {
    handingBack.set(sessionId, (handingBack.get(sessionId) ?? 0) + 1)
    return promise.finally(() => {
      const next = (handingBack.get(sessionId) ?? 1) - 1
      if (next <= 0) handingBack.delete(sessionId)
      else handingBack.set(sessionId, next)
    })
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
    if (/^(message_bot|delegate_work|ask_back|answer_work|cancel_work|note_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(tool)) return 'sending'
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
  const LOCAL_TEAM_TOOL = /^(?:mcp(?:__|_)dsbot(?=[_:]|$)|dsbot(?=[_:]|$))/i
  const localTeamCall = text => LOCAL_TEAM_TOOL.test(String(text ?? '').trim().split(/\s+/)[0] ?? '')
  const LOCAL_READ_TOOL = /^(?:read|view|cat|search|grep|glob|ls|find|list|fetch|browse|web_?search|web_?fetch|notebookread)\b/i
  const localActivityOf = (raw) => {
    const line = String(raw ?? '').replace(/^\s*▸\s*/, '').replaceAll('`', '').replace(/\s+/g, ' ').trim()
    if (line === '') return undefined
    return { tool: LOCAL_READ_TOOL.test(line) ? 'read' : 'cli', note: line.slice(0, 120) }
  }

  const showCall = (id, entry) => {
    const name = [...(entry.calls?.values() ?? [])].at(-1)?.name ?? entry.localDoing?.tool
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

  // A local agent CLI streams its thoughts and tool runs inside one LLM call, without
  // DSH tool/call events: mirror them onto the live turn so the group clock, work
  // grace, tool count and status views see what the CLI is doing.
  const noteLocalAgentEvent = (id, event) => {
    const entry = live.get(id)
    if (entry?.turn === undefined || event === undefined) return
    if (event.type === 'idle') {
      if (entry.localDoing !== undefined) {
        entry.localDoing = undefined
        showCall(id, entry)
      }
      return
    }
    if (rt.groupOwners.has(id)) rt.touchRoomTurn?.(id)
    if (event.type !== 'activity' && event.type !== 'status') return
    const text = String(event.text ?? '').replace(/^\s*▸\s*/, '').trim()
    if (event.team === true) return
    if (event.team !== false && localTeamCall(text)) return
    const doing = localActivityOf(text)
    if (doing === undefined) return
    entry.localDoing = doing
    showCall(id, entry)
    if (event.type === 'activity' && event.failed !== true) {
      entry.toolCount = (entry.toolCount ?? 0) + 1
      entry.workToolCount = (entry.workToolCount ?? 0) + 1
      const activeWork = rt.workOf?.(entry.info)
      if (activeWork !== undefined && rt.ownsWork?.(rt.selfOf(id), activeWork)) rt.markWorkWorked?.(activeWork)
      const taskWork = rt.taskBySession?.(id)?.task?.workId
      if (taskWork !== undefined) rt.markWorkWorked?.(taskWork)
      if (rt.groupOwners.has(id)) {
        rt.workRoomTurn?.(id, doing.tool)
        rt.markRoomReportsWorked?.(rt.groupOwners.get(id).roomId, rt.selfOf(id))
      }
      const taskOwner = rt.taskOwners?.get(id)
      if (taskOwner?.roomId !== undefined) rt.markRoomReportsWorked?.(taskOwner.roomId, taskOwner.botId)
    }
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

  const answersUser = info => info.role === 'request' && info.audience === 'user'
  const expectsReply = info => info.role === 'request'
  const isHiddenBotWorkTurn = (botId, info) => info !== undefined
    && ((info.role === 'request' && info.audience !== 'user')
      || (rt.workOf?.(info) !== undefined && rt.ownsWork?.(botId, rt.workOf(info)) === true))
  const speaksInGroup = (id, info) => rt.groupOwners.has(id) && !(info !== undefined && expectsReply(info))

  const showSteps = (id, entry, upTo) => {
    const info = entry.info
    if (entry.suppressedSubagent || !speaksInGroup(id, info) || (info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))) return
    for (; entry.shown < upTo; entry.shown += 1) {
      const text = stripWrittenCalls(entry.texts[entry.shown])
      if (text !== '') void rt.roomStepText?.(id, info, text, entry.shown === 0)?.catch(error => rt.warn('ds-bot: step text from %s not posted: %s', id, error))
    }
  }

  const tellSender = (id, source, text, long, options) => answerSender(rt, id, source, text, long, options)

  // Runs before a deleted Bot leaves the team: stops its sessions/subagents, settles
  // open works owned by this Bot in SQLite + legacy maps, and aborts outgoing works.
  async function releaseBot(botId, sessionIds) {
    const deletedBot = rt.botOf(botId)
    const deletedName = deletedBot?.name ?? 'The other Bot'
    const text = `${deletedName} was deleted before it could answer your message.`
    const cancelReason = `${deletedName} was deleted before this work finished.`
    const waiting = new Map()
    for (const id of sessionIds) {
      rt.abortRoomWaiters?.(id, { left: true })
      await stopSubagents(id)
      const entry = live.get(id)
      const held = [entry?.info, entry?.pending]
      for (const source of held) {
        if (source?.kind === SOURCE_KIND && source.coordWorkId === undefined && expectsReply(source) && !answersUser(source)) {
          waiting.set(source.exchangeId, [id, source])
        }
      }
      live.delete(id)
      stoppedSubagentParents.delete(id)
      setActivity(id, undefined)
    }
    // Stop all non-terminal SQLite works owned by this deleted Bot so parent callers wake immediately.
    if (rt.coordDb && !rt.coordDb.readonly && !rt.coordDb.isClosed()) {
      for (const work of rt.coordDb.listWorks({ botId })) {
        if (['done', 'failed', 'stopped'].includes(work.status)) continue
        const tag = work.workRef ? ` #${work.workRef}` : ''
        const res = rt.coordDb.stopWork(work.workId, {
          reason: cancelReason,
          by: 'system',
          cascadeChildren: true,
          summary: text,
          resultMeta: {
            role: 'reply',
            replyTo: work.workId,
            ...(work.workRef ? { workRef: work.workRef } : {}),
            senderName: deletedName,
            renderedText: `[Work${tag} stopped · ${deletedName}]\n${text}`,
            source: {
              replyTo: work.workId,
              ...(work.workRef ? { workRef: work.workRef } : {}),
              senderName: deletedName,
            },
          },
        })
        if (res.settled) rt.emitWorkSettled?.({ outcome: 'stopped', ...res })
      }
      queueMicrotask(() => void rt.kickScheduler?.())
    }
    const outgoing = []
    for (const source of rt.forgetBotWork?.(botId, { onOutgoing: items => outgoing.push(...items) }) ?? []) {
      if (!waiting.has(source.exchangeId)) waiting.set(source.exchangeId, [rt.chatOf(botId), source])
    }
    for (const [id, source] of waiting.values()) tellSender(id, source, text)
    for (const snapshot of outgoing) {
      await rt.abortWorkExecution?.(snapshot, { sender: deletedBot, reason: cancelReason }).catch(() => {})
    }
  }

  const claimTrigger = (sessionId, entry, info) => {
    entry.info = info
    if (rt.groupOwners.has(sessionId)) return
    const work = rt.workOf?.(info)
    const internalWork = !answersUser(info) && rt.ownsWork?.(rt.selfOf(sessionId), work)
      && rt.workAsker(work)?.senderSessionId !== undefined
    if (internalWork || (expectsReply(info) && !answersUser(info)) || info.role === 'room' || (info.role === 'handoff' && info.resume !== true)) {
      markExchangeTurn(sessionId, entry.turn)
    }
  }

  const activityView = () => {
    const merged = {}
    for (const [id, value] of Object.entries(activity)) {
      if (!rt.groupOwners.has(id) && !rt.taskOwners?.has(id)) merged[rt.chatOwners.get(id) ?? id] = value
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
    for (const job of rt.switchJobs()) {
      if (job.roomId === undefined) merged[job.botId] = 'thinking'
      else merged[job.botId ?? job.roomId] ??= 'thinking'
    }
    // Only answerable foreground DM approvals alert the Bot's own mascot; group approvals
    // live on the group row/island (#1623) and background task approvals live in the task deck.
    for (const approval of rt.approvalsView?.() ?? []) {
      if (approval.botId && approval.roomId === undefined && approval.taskId === undefined && approval.answerable !== false) {
        merged[approval.botId] = 'alert'
      }
    }
    for (const botId of Object.keys(rt.waitingView?.() ?? {})) merged[botId] ??= 'waiting'
    return merged
  }

  const doingOf = (entry) => {
    const call = [...(entry.calls?.values() ?? [])].at(-1)
    if (call === undefined) return entry.localDoing ?? {}
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

  const workView = () => {
    const bots = {}
    for (const [id, entry] of live) {
      if (entry.turn === undefined || rt.taskOwners?.has(id)) continue
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
      if (job.botId === undefined) continue
      const work = { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.roomId ? { roomId: job.roomId } : {}) }
      if (job.roomId === undefined) bots[job.botId] = work
      else bots[job.botId] ??= work
    }
    return bots
  }

  const turnsView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.since !== undefined)
    .map(([id, entry]) => [id, entry.since]))

  const steeredView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.steeredAt !== undefined)
    .map(([id, entry]) => [id, entry.steeredAt]))

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
    for (const item of rt.activeRoomTasks?.() ?? []) {
      add(item.roomId, item.botId, { since: item.task.startedAt, tool: 'task', ...(item.task.title ? { note: item.task.title.slice(0, 120) } : {}) })
    }
    for (const job of rt.switchJobs()) {
      if (job.roomId !== undefined) add(job.roomId, job.botId, { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.botId === undefined ? { self: true } : {}) })
    }
    return rooms
  }

  const callDetail = (sessionId, callId) => {
    let args
    try { args = JSON.parse(live.get(sessionId)?.calls?.get(callId)?.args ?? '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')
    const text = first(['description', 'justification'])
    const code = first(['command', 'cmd', 'file_path', 'path', 'url', 'query'])
    return { ...(text ? { text: text.trim().slice(0, 300) } : {}), ...(code ? { code: code.trim().slice(0, 400) } : {}) }
  }

  const placeOf = (id) => {
    const room = rt.roomOf(rt.groupOwners.get(id)?.roomId ?? rt.taskOwners?.get(id)?.roomId) ?? rt.roomOf(id)
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
  ctx.on?.('subagent/start', function (info) {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '' || stoppedSubagents.has(childId)) return
    const parentId = carrierKeyOf(this)?.session?.id
      ?? subagentParent.get(childId)
      ?? ctx.get?.('agents')?.get?.(childId)?.session?.header?.parentSession
      ?? [...live.entries()].find(([, entry]) => [...(entry.calls?.values() ?? [])].some(call => call.name === 'subagent'))?.[0]
    if (parentId === undefined) return
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
    void rt.settleRoomReports?.(owner.roomId).catch(error => rt.warn('ds-bot: group report settle failed: %s', error))
  })

  // Track non-coordDb legacy Bot messages claimed out of an Agent's inbox during preStep
  // before `user/message` is appended so preStep failures still settle cleanly.
  ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
    const id = agent?.id ?? agent?.session?.id
    if (id === undefined || !rt.isBotSession(id)) return
    const source = message?.source
    if (source?.kind !== SOURCE_KIND || source.coordWorkId !== undefined) return
    const entry = liveOf(id)
    const list = entry.claimed ??= []
    if (source.exchangeId !== undefined && list.some(item => item.exchangeId === source.exchangeId)) return
    list.push(source)
  })

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    const switchedEnd = event.type === 'turn/end' && live.get(id)?.switched === true && rt.pastOwners?.has(id)
    // A DSH Agent's plain Session is only watched for its running turn, for the phone's Stop.
    if (rt.agentOf?.(id) !== undefined && !rt.isBotSession(id)) {
      if (event.type === 'turn/start') Object.assign(liveOf(id), { turn: event.data?.turn, since: event.time ?? Date.now() })
      else if (event.type === 'turn/end' && live.delete(id)) setActivity(id, undefined)
      return
    }
    if (!rt.isBotSession(id) && !rt.roomOf(id) && !switchedEnd) {
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
        if (name !== PROGRAM_TOOL) {
          entry.toolCount = (entry.toolCount ?? 0) + 1
          if (USER_UI_TOOLS.has(name)) entry.uiToolCount = (entry.uiToolCount ?? 0) + 1
          if (isWorkTool(name)) {
            entry.workToolCount = (entry.workToolCount ?? 0) + 1
            const activeWork = rt.workOf?.(entry.info)
            if (activeWork !== undefined && rt.ownsWork?.(rt.selfOf(id), activeWork)) rt.markWorkWorked?.(activeWork)
            const taskWork = rt.taskBySession?.(id)?.task?.workId
            if (taskWork !== undefined) rt.markWorkWorked?.(taskWork)
            if (rt.groupOwners.has(id)) {
              rt.workRoomTurn?.(id, name)
              rt.markRoomReportsWorked?.(rt.groupOwners.get(id).roomId, rt.selfOf(id))
            }
            const taskOwner = rt.taskOwners?.get(id)
            if (taskOwner?.roomId !== undefined) rt.markRoomReportsWorked?.(taskOwner.roomId, taskOwner.botId)
          }
        }
        break
      }
      case 'tool/ptc-dispatch-start': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.subCallId, name, JSON.stringify(event.data?.arguments ?? {}))
        entry.toolCount = (entry.toolCount ?? 0) + 1
        if (USER_UI_TOOLS.has(name)) entry.uiToolCount = (entry.uiToolCount ?? 0) + 1
        if (isWorkTool(name)) {
          entry.workToolCount = (entry.workToolCount ?? 0) + 1
          const activeWork = rt.workOf?.(entry.info)
          if (activeWork !== undefined && rt.ownsWork?.(rt.selfOf(id), activeWork)) rt.markWorkWorked?.(activeWork)
          const taskWork = rt.taskBySession?.(id)?.task?.workId
          if (taskWork !== undefined) rt.markWorkWorked?.(taskWork)
          if (rt.groupOwners.has(id)) {
            rt.workRoomTurn?.(id, name)
            rt.markRoomReportsWorked?.(rt.groupOwners.get(id).roomId, rt.selfOf(id))
          }
          const taskOwner = rt.taskOwners?.get(id)
          if (taskOwner?.roomId !== undefined) rt.markRoomReportsWorked?.(taskOwner.roomId, taskOwner.botId)
        }
        break
      }
      case 'tool/ptc-dispatch':
        endCall(id, entry, event.data?.subCallId)
        break
      case 'tool/result':
        endCall(id, entry, event.data?.callId)
        break
      case 'turn/start': {
        // A model that could not be applied before is tried again now that a turn has
        // proved its Session can be reached; the first try may have come too early (#1937).
        if (rt.readOnly?.() === undefined) void rt.retryModel?.(rt.selfOf?.(id))
        setActivity(id, 'thinking')
        entry.turn = event.data.turn
        entry.since = event.time ?? Date.now()
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.info = undefined
        entry.toolCount = 0
        entry.workToolCount = 0
        entry.uiToolCount = 0
        entry.localDoing = undefined
        entry.usage = undefined
        entry.suppressedSubagent = false
        entry.switched = false
        entry.lastSwitched = false
        entry.askedBackWork = undefined
        entry.lastAskedBackWork = undefined
        entry.claimed = []
        entry.joined = []
        entry.later = []
        entry.retrying = false
        entry.answers = false
        entry.opened = false
        entry.userInput = false
        entry.steeredAt = undefined
        entry.carried = false
        const claimedPending = entry.pending
        const claimedPendingText = entry.pendingText
        const claimedPendingImages = entry.pendingImages
        const claimedPendingFiles = entry.pendingFiles
        if (claimedPending !== undefined) {
          claimTrigger(id, entry, claimedPending)
          entry.pending = undefined
          entry.pendingText = undefined
          entry.pendingImages = undefined
          entry.pendingFiles = undefined
        }
        if (entry.carry !== undefined) {
          const carry = entry.carry
          entry.carry = undefined
          entry.texts = carry.texts
          entry.shown = carry.shown
          entry.answers = carry.answers
          entry.joined = carry.joined ?? []
          entry.later = carry.later ?? []
          entry.toolCount = carry.toolCount ?? 0
          entry.workToolCount = carry.workToolCount ?? 0
          entry.uiToolCount = carry.uiToolCount ?? 0
          entry.opened = true
          entry.carried = true
          entry.userInput = Boolean(entry.userInput || carry.userInput)
          if (carry.info !== undefined) claimTrigger(id, entry, carry.info)
          if (carry.info !== undefined && claimedPending !== undefined
            && claimedPending.exchangeId !== carry.info.exchangeId
            && (expectsReply(claimedPending) || claimedPending.role === 'room') && !answersUser(claimedPending)) {
            entry.joined = [...entry.joined, {
              info: claimedPending,
              text: claimedPendingText ?? '',
              ...(claimedPendingImages?.length ? { images: claimedPendingImages } : {}),
              ...(claimedPendingFiles?.length ? { files: claimedPendingFiles } : {}),
            }]
          }
        }
        rt.notifyTurnLifecycle?.({
          type: 'turn/started',
          sessionId: id,
          turn: entry.turn,
          time: entry.since,
        })
        break
      }
      case 'user/message': {
        const source = event.data?.source
        // Forward every user/message (including silent notes with coordNoteSeq) to dsh-adapter
        // before filtering pure context notices so SQLite inbox acks happen at durable commit time.
        rt.notifyTurnLifecycle?.({
          type: 'turn/user-message',
          sessionId: id,
          turn: entry.turn,
          source,
          time: event.time ?? Date.now(),
        })
        if (source?.kind === SOURCE_KIND && typeof source.exchangeId === 'string' && source.exchangeId !== '') {
          rt.forgetDelivery?.(source.exchangeId)
        }
        if (source?.kind === SOURCE_KIND && Array.isArray(entry.claimed) && entry.claimed.length > 0) {
          entry.claimed = source.exchangeId !== undefined
            ? entry.claimed.filter(item => item.exchangeId !== source.exchangeId)
            : entry.claimed.slice(1)
        }
        if (source?.kind === SOURCE_KIND && source.role === 'answer' && source.work !== undefined && source.work === entry.askedBackWork) {
          entry.askedBackWork = undefined
        }
        // Pure context notices inform the model without opening/claiming a turn or expecting a reply.
        if (source?.kind === SOURCE_KIND && (source.role === 'task-handoff' || source.silent === true || source.role === 'note' || source.role === 'cancelled' || source.role === 'stopped')) break
        if (source?.kind === 'subagent-settled' || source?.kind === 'agent-message') {
          const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            noteSubagentEnd(childId)
            if (rt.groupOwners.has(id)) {
              const roomId = rt.groupOwners.get(id).roomId
              void rt.goalSettled?.(rt.roomOf(roomId)).catch(error => rt.warn('ds-bot: goal settle failed: %s', error))
              void rt.settleRoomReports?.(roomId).catch(error => rt.warn('ds-bot: group report settle failed: %s', error))
            }
          }
          if (stoppedSubagentParents.has(id) || (childId !== undefined && stoppedSubagents.has(childId))) {
            entry.suppressedSubagent = true
            void rt.resolveAgent(id).then(agent => agent?.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })).catch(() => {})
            break
          }
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            const stopReason = noticeStopReason(source, event.data?.content)
            const label = endedSubagentLabels.get(childId)
            endedSubagentLabels.delete(childId)
            if (stopReason !== undefined && rt.groupOwners.has(id)) noteSubagentFailure(id, childId, { stopReason, helper: label })
          }
        } else if (source?.kind === 'user' || source?.kind === SOURCE_KIND) {
          stoppedSubagentParents.delete(id)
        }
        const extractRelayPayload = (content) => {
          const blocks = Array.isArray(content) ? content : []
          const text = textOf(blocks).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
          const images = blocks.filter(block => block?.type === 'image' && block.attachment !== undefined && !block.offloaded).map(block => block.attachment)
          const files = blocks.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
          return { text, ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}) }
        }
        const bare = info => info?.handoff === true && info.resume !== true
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
          const roomId = rt.roomOf(id).id
          const files = (Array.isArray(event.data.content) ? event.data.content : []).filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
          queueRoomMessage(roomId, {
            text: textOf(event.data.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(files.length > 0 ? { files } : {}),
            botId: source.senderSessionId,
            name: source.senderName,
            reportBack: source.reportBack === true,
            ...(source.externalPost === true ? { externalPost: true } : {}),
            ...(source.exchangeId ? { exchangeId: source.exchangeId } : {}),
            ...(source.reportId ? { reportId: source.reportId } : {}),
            ...(source.fromTaskId ? { fromTaskId: source.fromTaskId } : {}),
            ...(source.claims === undefined ? {} : { claims: source.claims }),
            ...(source.changes === undefined ? {} : { changes: source.changes }),
            ...(source.member ? { member: true } : {}),
            ...(source.mentions ? { mentions: source.mentions } : {}),
            ...(source.route ? { route: source.route } : {}),
            ...(source.sub ? { sub: source.sub } : {}),
            ...(source.late ? { late: true } : {}),
            ...(source.worked ? { worked: true } : {}),
            ...(source.progress ? { progress: true } : {}),
            ...(source.quiet ? { quiet: true } : {}),
            ...(source.failed ? { failed: source.failed } : {}),
            ...(source.resumed ? { resumed: true } : {}),
            ...(source.resumedPause ? { resumedPause: true } : {}),
            ...(Array.isArray(source.resumedWorkIds) ? { resumedWorkIds: source.resumedWorkIds } : {}),
            ...(source.resumeWorkId ? { resumeWorkId: source.resumeWorkId } : {}),
            ...(source.resumeBy ? { resumeBy: source.resumeBy } : {}),
            ...(source.parentWorkId ? { parentWorkId: source.parentWorkId } : {}),
            ...(source.returnAddress ? { returnAddress: source.returnAddress } : {}),
            ...(source.wakeSnapshot !== undefined ? { wakeSnapshot: source.wakeSnapshot } : {}),
            ...(Number.isInteger(source.throughSeq) ? { throughSeq: source.throughSeq } : {}),
            ...(source.via !== undefined ? { via: source.via } : {}),
            ...(source.resultOnly ? { resultOnly: true } : {}),
            ...(source.again ? { again: true } : {}),
            ...(source.stopped ? { stopped: true } : {}),
            ...(source.done ? { done: true } : {}),
            ...(source.askedBy ? { askedBy: source.askedBy } : {}),
            ...(source.batch ? { batch: source.batch } : {}),
            ...(source.batchEnd ? { batchEnd: true } : {}),
            ...(source.explicitDelegate ? { explicitDelegate: true } : {}),
            ...(source.callerExchangeId ? { callerExchangeId: source.callerExchangeId } : {}),
            ...(source.callerId ? { callerId: source.callerId } : {}),
            ...(source.parentBatchKey ? { parentBatchKey: source.parentBatchKey } : {}),
            ...(source.fromRoomId ? { fromRoomId: source.fromRoomId } : {}),
            ...(source.fromPart ? { fromPart: source.fromPart } : {}),
            ...(source.logged !== undefined ? { logged: source.logged } : {}),
            ...(source.called ? { called: true } : {}),
          })
          rt.roomRelayTaken?.(roomId, source.exchangeId)
        } else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
          queueRoomMessage(rt.roomOf(id).id, { text: '', kickoff: true })
        } else if (source?.kind === SOURCE_KIND && source.role === 'goal' && rt.roomOf(id)) {
          const roomId = rt.roomOf(id).id
          queueRoomMessage(roomId, {
            text: textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(source.exchangeId ? { exchangeId: source.exchangeId } : {}),
            ...(source.goal !== undefined ? { goal: source.goal } : {}),
            ...(source.goalId !== undefined ? { goalId: source.goalId } : {}),
            ...(source.via !== undefined ? { via: source.via } : {}),
          })
          rt.roomRelayTaken?.(roomId, source.exchangeId)
        } else if (source?.kind === SOURCE_KIND) {
          if (Array.isArray(source.joined) && source.joined.length > 0) {
            const existingIds = new Set((entry.joined ?? []).map(item => item?.info?.exchangeId).filter(Boolean))
            const restored = source.joined.filter(item => item?.info?.exchangeId !== undefined && !existingIds.has(item.info.exchangeId))
            if (restored.length > 0) entry.joined = [...(entry.joined ?? []), ...restored]
          }
          const markTaken = () => {
            if (source.work !== undefined && source.replyTo !== undefined) rt.takenWork?.(source.work, source.replyTo)
          }
          if (entry.turn === undefined) {
            markTaken()
            const payload = extractRelayPayload(event.data.content)
            entry.pending = source
            entry.pendingText = payload.text
            entry.pendingImages = payload.images
            entry.pendingFiles = payload.files
          } else if (!opened) {
            markTaken()
            claimTrigger(id, entry, source)
          } else if ((source.role === 'reply' || source.role === 'answer' || source.role === 'ask_back')
            && source.work !== undefined && source.work !== rt.workOf?.(entry.info)
            && !(entry.later ?? []).some(item => item.info.exchangeId === source.exchangeId)) {
            // Arrived mid-turn for a different work than the one currently running:
            // defer handback until the running turn finishes instead of losing it.
            entry.later = [...(entry.later ?? []), { info: source, ...extractRelayPayload(event.data.content) }]
          } else if ((expectsReply(source) || source.role === 'room') && !answersUser(source)
            && source.exchangeId !== entry.info?.exchangeId
            && !(entry.joined ?? []).some(joined => joined.info.exchangeId === source.exchangeId)) {
            // A request that lands inside a running turn is answered in its own hidden turn
            // once the running turn finishes so the sender never receives the wrong turn's text.
            entry.joined = [...(entry.joined ?? []), { info: source, ...extractRelayPayload(event.data.content) }]
          } else {
            markTaken()
          }
        } else if (source?.kind === 'schedule' && rt.roomOf(id)) {
          queueRoomMessage(rt.roomOf(id).id, { text: reminderText(textOf(event.data.content)) })
        } else if (source?.kind === REFERENCE_KIND && rt.roomOf(id)) {
          attachReference(roomInbox.get(rt.roomOf(id).id), source, textOf(event.data.content))
        } else if (source?.kind === 'subagent-settled') {
          const run = rt.subWorkRun?.(source.senderSessionId, new Set())
          if (run !== undefined) {
            const info = { kind: SOURCE_KIND, role: 'reply', work: run.parent, replyTo: run.id, exchangeId: run.id, senderSessionId: source.senderSessionId }
            if (entry.turn === undefined) {
              rt.takenWork?.(run.parent, run.id)
              entry.pending = info
            } else if (entry.info === undefined && !opened) {
              rt.takenWork?.(run.parent, run.id)
              entry.opened = true
              entry.answers = true
              claimTrigger(id, entry, info)
            } else {
              rt.takenWork?.(run.parent, run.id)
            }
          }
        } else if (source?.kind === 'user' || source?.kind === REPLY_KIND) {
          if (rt.roomOf(id) && source.kind === 'user') {
            const content = Array.isArray(event.data.content) ? event.data.content : []
            const images = content.filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
            const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
            queueRoomMessage(rt.roomOf(id).id, { text: textOf(event.data.content), ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}), ...(viaOf(source) ? { via: viaOf(source) } : {}) })
          }
          const own = rt.chatOwners.get(id)
          if (own !== undefined && !rt.taskOwners?.has(id)) {
            entry.userInput = true
            rt.userWrote(own)
            rt.resetBotLoops?.(own)
          }
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
        if (rt.roomOf(id)) rt.nudgeRoom?.(rt.roomOf(id).id)
        if (stoppedSubagentParents.has(id)) {
          for (const inserted of event.data?.inserted ?? []) {
            if (inserted?.source?.kind === 'subagent-settled' || stoppedSubagents.has(inserted?.source?.senderSessionId)) {
              void rt.resolveAgent(id).then(agent => agent?.inbox?.remove(inserted.id)).catch(() => {})
            }
          }
        }
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
        const cut = entry.cut
        entry.cut = undefined
        const steerCut = cut !== undefined && event.data?.reason?.kind === 'aborted'
          && event.data.reason.reason?.kind === 'hook' && event.data.reason.reason.reason === STEER_CUT
        if (steerCut) {
          entry.carry = { info: entry.info, joined: entry.joined ?? [], later: entry.later ?? [], texts: entry.texts.slice(0, cut.texts), shown: entry.shown, answers: entry.answers, toolCount: entry.toolCount ?? 0, workToolCount: entry.workToolCount ?? 0, uiToolCount: entry.uiToolCount ?? 0, userInput: true }
        }
        const info = entry.info
        const joined = entry.joined ?? []
        const later = entry.later ?? []
        const claimed = entry.claimed ?? []
        const askedBackWork = entry.askedBackWork
        const texts = entry.texts.slice(entry.shown)
        const wroteText = entry.texts.length > 0
        const shown = entry.shown > 0 || (info?.retried === true && promisedOpenings.delete(info.exchangeId))
        const { lastText, lastCalled } = entry
        const usage = entry.usage
        const toolCount = entry.toolCount ?? 0
        const workToolCount = entry.workToolCount ?? 0
        const uiToolCount = entry.uiToolCount ?? 0
        const suppressedSubagent = entry.suppressedSubagent === true
        const switched = entry.switched === true
        const overflowFailure = entry.overflowFailure === true
        const watched = entry.turn !== undefined
        const turn = entry.turn
        const since = entry.since
        entry.turn = undefined
        entry.info = undefined
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.toolCount = 0
        entry.workToolCount = 0
        entry.uiToolCount = 0
        entry.suppressedSubagent = false
        entry.switched = false
        entry.overflowFailure = false
        entry.lastSwitched = switched
        entry.askedBackWork = undefined
        entry.lastAskedBackWork = askedBackWork
        entry.claimed = []
        entry.joined = []
        entry.later = []
        entry.since = undefined
        entry.steeredAt = undefined
        entry.tool = undefined
        entry.localDoing = undefined
        entry.calls = undefined
        entry.lastText = undefined
        entry.lastCalled = undefined
        entry.usage = undefined
        if (steerCut || suppressedSubagent) {
          rt.dropRoomStepEcho?.(id)
          if (suppressedSubagent && !steerCut && rt.groupOwners.has(id)) {
            void rt.settleRoomReports?.(rt.groupOwners.get(id).roomId).catch(error => rt.warn('ds-bot: group report settle in %s failed: %s', id, error))
          }
          break
        }
        const reason = event.data?.reason
        const rawFailure = reason?.kind === 'error' && !switched ? turnFailure(reason.error) : undefined
        const failure = rawFailure !== undefined && overflowFailure
          ? { ...rawFailure, code: 'CONTEXT_WINDOW_EXCEEDED' }
          : rawFailure
        if (failure !== undefined) noteTurnFailure(id, failure)
        if (failure?.code === 'HOSTED_ENGINE_ROUTE') {
          const config = session.requestHeader?.()?.config
          const ref = config?.provider && config?.model ? `${config.provider}/${config.model}` : undefined
          if (ref !== undefined) void rt.routeRefused(ref, rt.botOf(rt.selfOf(id))).catch(error => rt.warn('ds-bot: %s still failing: %s', ref, error))
        }
        // A turn refused before its request left because the Session's selection names
        // a provider with no adapter, or a model DSH no longer serves, applies the Bot's
        // model again and rewrites that selection, so the next turn can run (#1937).
        if ((failure?.code === 'NO_ADAPTER' || failure?.code === 'UNKNOWN_MODEL') && rt.readOnly?.() === undefined) {
          const bot = rt.botOf(rt.selfOf(id))
          if (bot !== undefined) {
            void Promise.resolve(rt.reapplyModel?.(bot, id))
              .catch(error => rt.warn('ds-bot: model for %s still not applied: %s', bot.name, error))
          } else {
            const room = rt.roomOf?.(id)
            if (room !== undefined) {
              void Promise.resolve(rt.selectRoomSession?.(id, room, { force: true }))
                .catch(error => rt.warn('ds-bot: model for the group Session %s not applied: %s', id, error))
            }
          }
        }
        const held = rt.groupOwners.has(id) ? rt.takeRoomSteps?.(id) ?? '' : ''
        if (switched) {
          rt.dropRoomStepEcho?.(id)
          break
        }
        const owner = rt.chatOwners.get(id)
        const groupOwner = rt.groupOwners.get(id)
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
          if (groupOwner !== undefined) rt.blockTasks?.(groupOwner.roomId, groupOwner.botId, { cause: 'failed', code: failure.code, ...(failure.status ? { status: failure.status } : {}) })
        } else if (reason?.kind === 'completed' || reason?.kind === 'yielded') {
          forgetFailure(id)
          unblockBot(rt.selfOf(id))
          const rawReply = texts.join('\n\n').trim()
          const explicitPassOnly = workToolCount === 0 && rawReply !== '' && (/^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(rawReply))
          if (groupOwner !== undefined && info?.resumed === true) rt.blockTasks?.(groupOwner.roomId, groupOwner.botId, { cause: 'restarted' }, since)
          else if (groupOwner !== undefined && !explicitPassOnly) rt.unblockTasks?.(groupOwner.roomId, groupOwner.botId)
          if (owner !== undefined && !rt.taskOwners?.has(id) && (info === undefined || info.role === 'continue')) rt.userAnswered(owner)
        }
        if (owner !== undefined && info?.role === 'kickoff') rt.clearSentKickoff?.(owner)
        const wroteCall = failure === undefined && reason?.kind === 'completed' && lastCalled !== true && writesToolCall(lastText)
        const promisedOnly = !wroteCall && failure === undefined && reason?.kind === 'completed'
          && toolCount === 0 && lastCalled !== true && info?.role === 'room' && !info.resultRef
          && promisesWork(lastText) && !rt.callsRoomMember?.(id, info, lastText)
        const retry = (wroteCall || promisedOnly) && info?.retried !== true && !(info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))
        entry.retrying = retry
        if (retry) {
          const onRetryFailed = (label, error) => {
            entry.retrying = false
            rt.warn(label, id, error)
            if (rt.groupOwners.has(id)) {
              void rt.settleRoomReports?.(rt.groupOwners.get(id).roomId).catch(err => rt.warn('ds-bot: group report settle in %s failed: %s', id, err))
            }
          }
          if (promisedOnly) {
            const opening = stripWrittenCalls(lastText ?? '')
            if (opening !== '') {
              rememberStopped(promisedOpenings, info.exchangeId)
              void rt.roomStepText?.(id, info, opening, !shown)?.catch(() => {})
            }
            roomWaiters.get(info.exchangeId)?.touch()
            void retryPromisedWork(id, info).catch(error => onRetryFailed('ds-bot: asking %s to run its promised work failed: %s', error))
          } else {
            void retryWrittenCall(id, info).catch(error => onRetryFailed('ds-bot: asking %s to run its written tool call failed: %s', error))
          }
        }
        const replyText = () => {
          const reply = (wroteCall ? texts.map(stripWrittenCalls) : texts).join('\n\n').trim()
          if (wroteCall && reply === '') return 'Tried to run a tool but wrote the call as text, so it did not run.'
          if (cutOff) return reply === '' && wroteText ? CUT_OFF_NOTE : cutOffText(reply)
          return reply
        }
        let echoed = false
        const groupReply = () => {
          echoed = true
          return rt.withRoomSteps?.(id, held, replyText()) ?? replyText()
        }
        const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
        const answer = (source, reply) => {
          if (!expectsReply(source) || answersUser(source)) return
          if (rt.closedWorkOf?.(source.exchangeId)?.status === 'cancelled') return
          if (failure !== undefined) {
            tellSender(id, source, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`, undefined, { failure })
          } else if (reply !== '' || reason?.kind === 'aborted') {
            tellSender(id, source, reply !== '' ? reply : `${name} was stopped before it could answer your message.`, undefined, {
              ...(reason?.kind === 'aborted' ? { aborted: true } : { worked: workToolCount > 0 }),
            })
          }
        }
        const finish = (source, reply) => {
          const work = rt.workOf?.(source)
          if (!rt.ownsWork?.(rt.selfOf(id), work)) return answer(source, reply)
          if (rt.closedWorkOf?.(work)?.status === 'cancelled') return
          const asker = rt.workAsker(work)
          if (failure !== undefined || reason?.kind === 'aborted') return answer(asker, reply)
          const currentState = rt.workStateOf?.(work)
          if (currentState === 'need_input' || currentState === 'paused' || askedBackWork === work) return
          if (rt.waitsWork(work)) return rt.holdWork(work, reply)
          const text = rt.answerText(work, reply, name)
          const opts = { worked: workToolCount > 0 }
          if (text.length <= MESSAGE_INLINE_MAX) return tellSender(id, asker, text, undefined, opts)
          void rt.attachLong(text, `Answer from ${name}.txt`)
            .then(long => tellSender(id, asker, text, long, opts))
            .catch(error => rt.warn('ds-bot: answer from %s not sent: %s', name, error))
        }
        if (!retry && !rt.groupOwners.has(id) && !rt.taskOwners?.has(id)
          && info?.kind === SOURCE_KIND && !answersUser(info)
          && failure === undefined && (reason?.kind === 'completed' || reason?.kind === 'yielded')
          && ['reply', 'report', 'task-report', 'ask_back'].includes(info.role)
          && uiToolCount === 0
          && state.questions?.[id] === undefined
          && state.views?.[id] === undefined
          && isSilentTurnText(replyText())) {
          markExchangeTurn(id, turn)
        }

        // Notify SQLite coordination adapter (`dsh-adapter.js`) once per non-retried turn end.
        if (!retry) {
          const reasonKind = reason?.kind
          const cancelCause = reason?.reason?.kind
          const lifecycleType = failure !== undefined
            ? 'turn/failed'
            : reasonKind === 'yielded'
              ? 'turn/yielded'
              : reasonKind === 'aborted'
                ? 'turn/aborted'
                : 'turn/ended'
          rt.notifyTurnLifecycle?.({
            type: lifecycleType,
            sessionId: id,
            turn,
            reasonKind,
            ...(cancelCause !== undefined ? { cancelCause } : {}),
            ...(failure !== undefined ? { failure } : {}),
            text: replyText(),
            toolCount,
            workToolCount,
            uiToolCount,
            info,
          })
        }

        // Route live room waiters / non-coordDb legacy exchanges (never double-deliver coordWorkId turns).
        if (!retry && info?.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          const stopped = stoppedRoomTurns.delete(info.exchangeId)
          if (waiter !== undefined) {
            if (failure !== undefined) waiter.fail(failure)
            else {
              waiter.setTurn?.(turn)
              waiter.resolve(reason?.kind === 'aborted' ? null : state.questions[id] !== undefined || state.views[id] !== undefined ? { answer: true, text: groupReply() } : groupReply())
            }
          } else if (!stopped && reason?.kind !== 'aborted') {
            if (failure !== undefined) void rt.lateRoomFailure?.(id, info, failure)
            else void rt.lateRoomReply?.(id, info, groupReply(), { shown, toolCount: workToolCount, turn })
          }
        } else if (!retry && speaksInGroup(id, info)) {
          const inRound = failure !== undefined && info === undefined && rt.failRoomTurn?.(id, failure) === true
          if (failure !== undefined) { if (!inRound) void rt.lateRoomFailure?.(id, info ?? {}, failure) }
          else if (reason?.kind !== 'aborted') void rt.lateRoomReply?.(id, info ?? {}, groupReply(), { shown, toolCount: workToolCount, turn })
        } else if (!retry && info !== undefined && info.coordWorkId === undefined) {
          finish(info, replyText())
        }

        // Settle non-coordDb legacy Bot works claimed during preStep that failed before `user/message`.
        if (!retry && !rt.groupOwners.has(id) && (failure !== undefined || reason?.kind === 'aborted')) {
          const settledExchanges = new Set([info?.exchangeId].filter(Boolean))
          const infoWork = rt.workOf?.(info)
          for (const source of claimed) {
            if (source.coordWorkId !== undefined) continue
            if (source.exchangeId !== undefined && settledExchanges.has(source.exchangeId)) continue
            const sourceWork = rt.workOf?.(source)
            if (infoWork !== undefined && sourceWork !== undefined && sourceWork === infoWork) continue
            if (source.exchangeId !== undefined) {
              settledExchanges.add(source.exchangeId)
              rt.forgetDelivery?.(source.exchangeId)
            }
            finish(source, '')
          }
        }

        // Hand back deferred replies/answers/ask_backs that landed inside another work's turn.
        for (const item of later) {
          void trackHandback(id, rt.deliver({
            fromId: item.info.senderSessionId,
            fromName: item.info.senderName,
            toId: rt.selfOf(id),
            sessionId: id,
            text: item.text,
            ...(item.images?.length ? { images: item.images } : {}),
            ...(item.files?.length ? { files: item.files } : {}),
            role: item.info.role,
            exchangeId: item.info.exchangeId,
            ...(item.info.replyTo ? { replyTo: item.info.replyTo } : {}),
            ...(item.info.work ? { work: item.info.work } : {}),
            ...(item.info.workRef ? { workRef: item.info.workRef } : {}),
            ...(item.info.askWork ? { askWork: item.info.askWork } : {}),
            ...(item.info.senderRoomId ? { fromRoomId: item.info.senderRoomId } : {}),
            ...(item.info.senderPart ? { fromPart: item.info.senderPart } : {}),
            deferred: true,
          })).catch(error => rt.warn('ds-bot: deferred later delivery failed: %s', error))
        }

        // Hand back requests/room calls that joined a running turn (and settle live roomWaiters on abort/fail).
        const activeJoined = []
        for (const request of joined) {
          if (request.info.role === 'room' && stoppedRoomTurns.delete(request.info.exchangeId)) {
            const waiter = roomWaiters.get(request.info.exchangeId)
            roomWaiters.delete(request.info.exchangeId)
            waiter?.resolve(null)
            continue
          }
          if (request.info.role !== 'room' && rt.closedWorkOf?.(request.info.exchangeId)?.status === 'cancelled') continue
          activeJoined.push(request)
        }
        const roomScopeOf = (info) => (info.askedBy !== undefined
          ? `${info.roomId}\0${info.askedBy}\0${info.workId ?? info.batchKey ?? ''}`
          : undefined)
        const liveWaiterRooms = new Set()
        const liveWaiterScopes = new Set()
        const latestWaiterlessRoom = new Map()
        const latestWaiterlessScope = new Map()
        for (const request of activeJoined) {
          if (request.info.role !== 'room' || request.info.roomId === undefined) continue
          const scope = roomScopeOf(request.info)
          if (roomWaiters.has(request.info.exchangeId)) {
            if (failure === undefined && reason?.kind !== 'aborted') {
              liveWaiterRooms.add(request.info.roomId)
              if (scope !== undefined) liveWaiterScopes.add(scope)
            }
          } else {
            latestWaiterlessRoom.set(request.info.roomId, request.info.exchangeId)
            if (scope !== undefined) latestWaiterlessScope.set(scope, request.info.exchangeId)
          }
        }
        for (const request of activeJoined) {
          if (failure !== undefined || reason?.kind === 'aborted') {
            if (request.info.role === 'room') {
              const waiter = roomWaiters.get(request.info.exchangeId)
              if (failure !== undefined) {
                roomWaiters.delete(request.info.exchangeId)
                if (waiter !== undefined) waiter.fail(failure)
                else void rt.lateRoomFailure?.(id, request.info, failure)
                continue
              }
              if (waiter !== undefined) {
                roomWaiters.delete(request.info.exchangeId)
                waiter.resolve(null)
                continue
              }
              if (reason?.reason?.kind === 'disposed') continue
            } else {
              answer(request.info, '')
              continue
            }
          }
          if (request.info.role === 'room' && request.info.roomId !== undefined && !roomWaiters.has(request.info.exchangeId)) {
            if (request.info.askedBy !== undefined) {
              const scope = roomScopeOf(request.info)
              if (liveWaiterScopes.has(scope) || latestWaiterlessScope.get(scope) !== request.info.exchangeId) continue
            } else if (liveWaiterRooms.has(request.info.roomId) || latestWaiterlessRoom.get(request.info.roomId) !== request.info.exchangeId) {
              continue
            }
          }
          void trackHandback(id, rt.deliver({
            fromId: request.info.senderSessionId,
            toId: rt.selfOf(id),
            sessionId: id,
            text: request.text,
            ...(request.images?.length ? { images: request.images } : {}),
            ...(request.files?.length ? { files: request.files } : {}),
            role: request.info.role,
            exchangeId: request.info.exchangeId,
            ...(request.info.workRef ? { workRef: request.info.workRef } : {}),
            ...(request.info.role === 'room' ? { roomId: request.info.roomId, askedBy: request.info.askedBy, resultRef: request.info.resultRef, ...(request.info.workId ? { work: request.info.workId } : {}), ...(request.info.batchKey ? { batchKey: request.info.batchKey } : {}), ...(request.info.resumedUpstream ? { resumedUpstream: true } : {}), note: 'you read this call during your last task; answer it now' } : {}),
            ...(request.info.senderRoomId ? { fromRoomId: request.info.senderRoomId } : {}),
            ...(request.info.senderPart ? { fromPart: request.info.senderPart } : {}),
            deferred: true,
          })).catch(error => rt.warn('ds-bot: deferred request delivery failed: %s', error))
        }

        if (!echoed && !retry) rt.dropRoomStepEcho?.(id)
        if (rt.groupOwners.has(id)) {
          const roomId = rt.groupOwners.get(id).roomId
          void rt.goalSettled?.(rt.roomOf(roomId)).catch(error => rt.warn('ds-bot: goal settle in %s failed: %s', id, error))
          void rt.settleRoomReports?.(roomId).catch(error => rt.warn('ds-bot: group report settle in %s failed: %s', id, error))
        }
        break
      }
    }
  })

  ctx.on('subagent/start', function (info) {
    const id = carrierKeyOf(this)?.session?.id
    const entry = id === undefined ? undefined : live.get(id)
    const work = rt.workOf?.(entry?.info)
    const self = id === undefined ? undefined : rt.selfOf(id)
    if (work === undefined || self === undefined || !rt.chatOwners.has(id) || typeof info?.id !== 'string' || typeof info?.runId !== 'string' || !rt.ownsWork?.(self, work)) return
    rt.openWork?.(info.runId, { from: self, parent: work, name: 'subagent', child: info.id })
  })
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
  // keeps the real cause in details.reason (#424). Preserve error diagnostics cleanly.
  const controller = ctx.sessionController
  const controllerTarget = controller?.[cordisSymbols.original] ?? controller
  if (controllerTarget != null && typeof controllerTarget.prompt === 'function') {
    const hadOwnPrompt = Object.hasOwn(controllerTarget, 'prompt')
    const prompt = controllerTarget.prompt
    const admitted = async function (request, ...rest) {
      try {
        return await prompt.call(this, request, ...rest)
      } catch (error) {
        const id = request?.sessionId
        if (id === undefined || (rt.roomOf(id) === undefined && !rt.isBotSession(id))) throw error
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
        if (reason !== undefined) {
          error.message = `${error?.message ?? 'prompt rejected'} — ${reason}`
          error.details = { ...error.details, reason }
        }
        throw error
      }
    }
    ctx.effect(() => {
      controllerTarget.prompt = admitted
      return () => {
        if (controllerTarget.prompt === admitted) {
          if (hadOwnPrompt) controllerTarget.prompt = prompt
          else delete controllerTarget.prompt
        }
      }
    }, 'ds-bot: prompt rejection reasons')
  }

  const forgetSessionTurn = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const entry = live.get(sessionId)
    if (entry !== undefined && entry.turn === undefined && entry.carry === undefined && entry.pending === undefined) live.delete(sessionId)
    stoppedSubagentParents.delete(sessionId)
  }
  ctx.on?.('agent/disposed', ({ agent }) => {
    const id = agent?.id
    if (id !== undefined && !rt.isBotSession?.(id) && rt.roomOf?.(id) === undefined) forgetSessionTurn(id)
  })

  Object.assign(rt, { live, liveOf, hasPendingHandback, roomWaiters, roomProgress, roomInbox, activityView, workView, agentWorkView, roomWorkView, turnsView, steeredView, callDetail, doingOf, noteLocalAgentEvent, stopRoomTurn, stopChat, stopAgent, releaseBot, forgetSessionTurn, unblockBots, resumeBot, markSteerCut, clearActivity: id => setActivity(id, undefined), hasSubagents, stopSubagents, adoptLiveTurnMaps, isHiddenBotWorkTurn })
}
