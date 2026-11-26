// Aside cards (btw) are the earlier single-shot aside: the ask path is gone,
// but existing cards stay readable until the user deletes them. This file keeps
// their files, their turn placement, and the shared snapshot/model-call
// helpers that side chats (side.js) use.
// Cards live in a file per Bot and part (<home>/btw/<botId>/<partId>.json), not
// in state.json, so a save never rewrites them; only the host that owns the
// team writes them.
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFile } from './files.js'
import { assembleLlmStream } from './models.js'
import { clip, textOf } from './text.js'

export const RESTART_ERROR = 'DS Bot restarted before this answer finished.'
export const TOOL_ERROR = 'The model called a tool again after being told not to, so this aside was not answered.'
export const EMPTY_ERROR = 'The model wrote nothing.'
// Events that still belong to a turn. A model selection or a title does not.
const MESSAGE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'])
// Host-only projection. `turnBoundary` clears its open seq on turn/end, so a
// log-only tail would lose the turn it still belongs to.
const ANCHOR_KEY = 'dsBotAnchor'

const seqOf = (value) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)
const turnOf = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : null)

// Checkpoint check for the projection registry. The live read does not use it.
const anchorStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ds-bot anchor projection state is not an object')
    const starts = []
    if (Array.isArray(value.starts)) {
      for (const start of value.starts) {
        const seq = seqOf(start?.seq)
        const turn = turnOf(start?.turn)
        if (seq === null || turn === null) continue
        starts.push({ seq, turn })
      }
    }
    return { turnStartSeq: seqOf(value.turnStartSeq), turn: turnOf(value.turn), messageSeq: seqOf(value.messageSeq), starts }
  },
}

// `turnStartSeq` is the latest turn/start and stays set after turn/end.
// `starts` lists every numbered turn/start so a later page can seed its rows.
const anchorProjection = {
  key: ANCHOR_KEY,
  stateVersion: 1,
  stateSchema: anchorStateSchema,
  init() {
    return { turnStartSeq: null, turn: null, messageSeq: null, starts: [] }
  },
  apply(state, event) {
    const seq = seqOf(event?.seq)
    if (seq === null) return state
    if (event.type === 'turn/start') {
      const turn = turnOf(event.data?.turn)
      if (turn === null) return state.turnStartSeq === seq && state.messageSeq === seq ? state : { ...state, turnStartSeq: seq, messageSeq: seq }
      return { turnStartSeq: seq, turn, messageSeq: seq, starts: [...state.starts, { seq, turn }] }
    }
    if (!MESSAGE_EVENTS.has(event.type) || state.messageSeq === seq) return state
    return { ...state, messageSeq: seq }
  },
}

// `session.eventAt` is closed to new callers. The registry folds the log;
// this reads the fold. Absent means the capability is not loaded.
function registerAnchor(ctx) {
  const register = (projections) => {
    if (typeof projections?.register === 'function') projections.register(anchorProjection)
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (projectionCtx) => { register(projectionCtx.sessionProjections) })
    return
  }
  register(ctx.get?.('sessionProjections'))
}

function anchorState(session, projections) {
  if (typeof projections?.stateOf !== 'function' || session == null) return undefined
  return projections.stateOf(session, ANCHOR_KEY)
}

const callIds = (message) => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
  const ids = []
  for (const block of message.content) if (block?.type === 'tool-call') ids.push(block.id)
  return ids
}

// DSH commits the assistant message before tool results exist. A tail that still
// owes a result is dropped whole: an adapter rejects a tool call with no result,
// and an aside does not wait for one or invent one.
export function trimToolBoundary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  let index = messages.length
  while (index > 0 && messages[index - 1]?.role === 'tool') index -= 1
  const calls = callIds(messages[index - 1])
  if (calls.length === 0) return messages
  const answered = new Set()
  for (const message of messages.slice(index)) {
    if (typeof message?.toolCallId === 'string') answered.add(message.toolCallId)
  }
  const balanced = calls.every(id => typeof id === 'string' && answered.has(id))
  return balanced ? messages : messages.slice(0, index - 1)
}

// `seq` is the next event's number. The last committed one is the snapshot's atSeq.
const committedSeq = (session) => {
  const seq = session?.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq - 1 : null
}

// `atSeq` is the last committed event, which may be log-only. `anchorSeq` is the
// turn/start of the turn that event belongs to (or the newest message when no
// turn has started) so the card is not left turnless. `turn` is that turn's
// number from the same read, or null when no numbered turn owns the snapshot.
function placementOf(session, projections) {
  const state = anchorState(session, projections)
  if (state == null) return { anchorSeq: null, turn: null }
  return { anchorSeq: seqOf(state.turnStartSeq) ?? seqOf(state.messageSeq), turn: turnOf(state.turn) }
}

// The turn number in effect at `seq`: the latest numbered turn/start at or
// before it. No projection, no session, or no such start leaves it unset.
export function openTurnAt(projections, session, seq) {
  if (seqOf(seq) === null) return undefined
  const starts = anchorState(session, projections)?.starts
  if (!Array.isArray(starts)) return undefined
  let best = -1
  let turn
  for (const start of starts) {
    const at = seqOf(start?.seq)
    if (at === null || at > seq || at < best) continue
    const next = turnOf(start.turn)
    if (next === null) continue
    best = at
    turn = next
  }
  return turn
}

// Header, derived history, tool history, and the session id, taken together.
export function snapshotOf(session, projections) {
  const header = session.requestHeader()
  const messages = trimToolBoundary(session.deriveMessages())
  const toolHistory = session.toolHistory()
  const sessionId = session.id
  const { anchorSeq, turn } = placementOf(session, projections)
  return { header, messages, toolHistory, sessionId, atSeq: committedSeq(session), anchorSeq, turn }
}

const ASIDE_TRANSCRIPT_BYTES = 48_000
const ASIDE_EXTRA_BYTES = 24_000
const ASIDE_LINE_MAX = 4_000
const ASIDE_LOCAL_SYSTEM = 'You are answering a side-chat question from a snapshot of the conversation. Answer in plain text only, without running any tools or changing any files.'

// Bounded plain-text snapshot transcript for isolated local-agent side-chat calls,
// newest messages kept within budget and ordered oldest first. Always preserves the
// latest handoff message even when newer turns exceed the byte budget.
function formatAsideTranscript(snapshotMessages, extra, prompt) {
  const body = (snapshotMessages ?? []).filter(message => message?.role !== 'system' && message?.source?.kind !== 'runtime-context')
  const latestHandoff = [...body].reverse().find(message => message?.source?.handoff === true)
  const kept = []
  let keptHandoff = false
  let used = 0
  let truncated = false
  for (const message of [...body].reverse()) {
    const raw = textOf(message?.content).trim()
    if (raw === '') continue
    const label = message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'
    const keepWhole = message === latestHandoff
    const line = `${label}: ${keepWhole ? raw : clip(raw, ASIDE_LINE_MAX, 'truncated')}`
    if (!keepWhole && kept.length > 0 && used + line.length > ASIDE_TRANSCRIPT_BYTES) {
      truncated = true
      break
    }
    kept.unshift(line)
    if (keepWhole) keptHandoff = true
    else used += line.length + 1
  }
  const sections = []
  if (kept.length > 0 || latestHandoff !== undefined) {
    const handoffRaw = !keptHandoff && latestHandoff !== undefined ? textOf(latestHandoff.content).trim() : ''
    const head = handoffRaw !== '' ? `User: ${handoffRaw}\n\n` : ''
    sections.push(`Conversation snapshot (oldest first):\n${head}${truncated ? '…\n' : ''}${kept.join('\n\n')}`)
  }
  const sideKept = []
  let sideUsed = 0
  let sideTruncated = false
  for (const message of [...(extra ?? [])].reverse()) {
    const text = textOf(message?.content).trim()
    if (text === '') continue
    const line = `${message.role === 'assistant' ? 'Side assistant' : 'Side user'}: ${clip(text, ASIDE_LINE_MAX, 'truncated')}`
    if (sideKept.length > 0 && sideUsed + line.length > ASIDE_EXTRA_BYTES) {
      sideTruncated = true
      break
    }
    sideKept.unshift(line)
    sideUsed += line.length + 1
  }
  if (sideKept.length > 0) {
    sections.push(`Earlier side chat (oldest first):\n${sideTruncated ? '…\n' : ''}${sideKept.join('\n\n')}`)
  }
  sections.push(prompt)
  return sections.join('\n\n')
}

// The same route as the conversation, including temperature, stop, and the output
// budget: thinking shares it, so an aside must not set a small one of its own. The
// messages array is tagged for usage. `extra` messages sit between the snapshot
// and the prompt; a side chat's earlier finished pairs go there.
// Local-agent routes never share the live CLI session; they run in an isolated
// read-only one-off session via `rt.localAgentAsk`.
export async function callAside(ctx, rt, snapshot, { extra = [], question, promptFor, kind, retry = false, signal }) {
  const route = snapshot.header?.config
  const isLocal = route?.provider !== undefined && (
    rt?.isLocalAgentRoute?.(route.provider) === true
    || (route.model !== undefined && rt?.isLocalAgentRef?.(`${route.provider}/${route.model}`) === true)
  )
  if (isLocal) {
    if (typeof rt?.localAgentAsk !== 'function') {
      return { failed: 'Side chat is not available for this local agent.' }
    }
    const baseSystem = (snapshot.messages ?? [])
      .filter(message => message?.role === 'system')
      .map(message => textOf(message.content).trim())
      .filter(Boolean)
      .join('\n\n')
    const system = baseSystem === '' ? ASIDE_LOCAL_SYSTEM : `${baseSystem}\n\n${ASIDE_LOCAL_SYSTEM}`
    const prompt = formatAsideTranscript(snapshot.messages, extra, promptFor(question, retry))
    try {
      const raw = await rt.localAgentAsk(snapshot.sessionId, {
        system,
        prompt,
        signal,
        route: route.provider,
        model: route.model,
        kind,
      })
      return { text: String(raw ?? '').trim(), toolCalls: false }
    } catch (error) {
      return { failed: error?.message ?? String(error) }
    }
  }
  const messages = rt.tagUsage([
    ...snapshot.messages,
    ...extra,
    { role: 'user', content: [{ type: 'text', text: promptFor(question, retry) }] },
  ], { sessionId: snapshot.sessionId, kind })
  const tools = snapshot.header?.tools
  const callOptions = {
    ...route,
    messages,
    toolHistory: snapshot.toolHistory,
    ...(tools ? { tools: [...tools] } : {}),
    sessionId: snapshot.sessionId,
    purpose: 'aside',
    signal,
  }
  const assembler = await (rt?.assembleLlm ? rt.assembleLlm(callOptions) : assembleLlmStream(ctx, callOptions, { backoff: rt?.config?.llmRetryBackoff }))
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return { failed: finish.failure?.message ?? finish.kind }
  }
  const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  // Checked before a tool-call retry: a truncated tool call is not a request.
  if (finish.kind === 'max-tokens') return { text, cutOff: true }
  const toolCalls = finish.kind === 'tool-calls' || assembler.blocks().some(block => block?.type === 'tool-call')
  return { text, toolCalls }
}

// A Bot id or an earlier part of its own chat means the current part, as `send` does.
// `groupError` is the refusal a group chat raises.
export function locatePrivate(rt, raw, groupError) {
  const past = rt.pastOwners.get(raw)
  const sessionId = rt.botOf(raw) ? rt.chatOf(raw) : past && past.roomId === undefined ? rt.chatOf(past.botId) : raw
  const grouped = rt.roomOf(raw) !== undefined || rt.roomOf(sessionId) !== undefined
    || rt.groupOwners.has(raw) || rt.groupOwners.has(sessionId)
    || past?.roomId !== undefined
  if (grouped) throw new Error(groupError)
  const botId = rt.chatOwners.get(sessionId) ?? rt.botOf(raw)?.id
  if (botId === undefined || rt.botOf(botId) === undefined) throw new Error('Unknown Bot')
  return { sessionId, botId }
}

const MAX_HISTORICAL_PARTS = 50

export function install(rt) {
  const { ctx, state } = rt
  registerAnchor(ctx)
  const dropped = new Set()

  // Cards by Bot and part. A part's list is read from
  // <home>/btw/<botId>/<partId>.json on first need and kept here; writes are
  // whole-file replaces, queued so a finish and a cancel never interleave. A
  // runtime without a home (a bare channel install) keeps cards in memory only.
  const cardsDir = typeof rt.home === 'string' ? join(rt.home, 'btw') : undefined
  const partFile = (botId, partId) => join(cardsDir, botId, `${partId}.json`)
  const partKey = (botId, partId) => `${botId}/${partId}`
  const writes = () => rt.readOnly?.() === undefined
  const writeKey = (botId, partId) => `${botId}:${partId}`
  /** @type {Map<string, Map<string, object[]>>} */
  const cards = new Map()
  // Bounded LRU of cached non-current parts (`botId\0partId`) so paging old history does not grow RAM unboundedly.
  const historicalParts = new Set()
  const reading = new Map()
  const writingParts = new Map()
  let writing = Promise.resolve()
  let deleting = Promise.resolve()

  const histKey = (botId, partId) => `${botId}\0${partId}`
  const isCurrentPart = (botId, partId) => rt.chatOf?.(botId) === partId
  const trackPart = (botId, partId) => {
    if (cardsDir === undefined || dropped.has(botId)) return
    const key = histKey(botId, partId)
    if (isCurrentPart(botId, partId)) {
      historicalParts.delete(key)
      const byBot = cards.get(botId)
      if (byBot !== undefined) {
        for (const cachedPart of byBot.keys()) {
          if (cachedPart !== partId) historicalParts.add(histKey(botId, cachedPart))
        }
      }
    } else {
      historicalParts.delete(key)
      historicalParts.add(key)
    }
    if (historicalParts.size <= MAX_HISTORICAL_PARTS) return
    for (const oldest of historicalParts) {
      if (historicalParts.size <= MAX_HISTORICAL_PARTS) break
      if (oldest === key) continue
      const sep = oldest.indexOf('\0')
      const bId = oldest.slice(0, sep)
      const pId = oldest.slice(sep + 1)
      if (isCurrentPart(bId, pId)) {
        historicalParts.delete(oldest)
        continue
      }
      if (reading.has(partKey(bId, pId)) || writingParts.has(writeKey(bId, pId))) continue
      historicalParts.delete(oldest)
      const byBot = cards.get(bId)
      if (byBot !== undefined) {
        byBot.delete(pId)
        if (byBot.size === 0) cards.delete(bId)
      }
    }
  }

  const listOf = (botId, partId) => cards.get(botId)?.get(partId) ?? []

  const writePart = (botId, partId, list) => {
    const key = writeKey(botId, partId)
    const snapshot = [...(list ?? cards.get(botId)?.get(partId) ?? [])]
    writingParts.set(key, (writingParts.get(key) ?? 0) + 1)
    const run = writing.then(async () => {
      if (cardsDir === undefined || !writes() || dropped.has(botId) || rt.botOf(botId) === undefined) return
      const path = partFile(botId, partId)
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      try {
        await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8')
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    }).finally(() => {
      const remaining = (writingParts.get(key) ?? 0) - 1
      if (remaining <= 0) writingParts.delete(key)
      else writingParts.set(key, remaining)
    })
    writing = run.catch(() => {})
    return run
  }

  // A part's list, reading its file once. The owning host records the restart a
  // previous process left behind: an 'answering' card could only have failed
  // with it, and the file is written again. A reading host keeps the cards as
  // they were saved.
  async function readPart(botId, partId) {
    const held = cards.get(botId)?.get(partId)
    if (held !== undefined) {
      trackPart(botId, partId)
      return held
    }
    const key = partKey(botId, partId)
    const pending = reading.get(key)
    if (pending !== undefined) return pending
    const job = (async () => {
      let list = []
      if (cardsDir === undefined) {
        if (dropped.has(botId)) return list
        let byBot = cards.get(botId)
        if (byBot === undefined) { byBot = new Map(); cards.set(botId, byBot) }
        byBot.set(partId, list)
        trackPart(botId, partId)
        return list
      }
      try {
        const parsed = JSON.parse(await readFile(partFile(botId, partId), 'utf8'))
        if (Array.isArray(parsed)) {
          list = parsed.filter(card => card !== null && typeof card === 'object' && !Array.isArray(card))
            .map(card => ({ ...card, botId, partId }))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable btw cards %s: %s', partFile(botId, partId), error?.code ?? error)
      }
      if (dropped.has(botId)) return list
      let byBot = cards.get(botId)
      if (byBot === undefined) { byBot = new Map(); cards.set(botId, byBot) }
      if (writes()) {
        const now = Date.now()
        let touched = false
        list = list.map((card) => {
          if (card.status !== 'answering') return card
          touched = true
          return { ...card, status: 'failed', error: card.error ?? RESTART_ERROR, finishedAt: card.finishedAt ?? now }
        })
        byBot.set(partId, list)
        if (touched) await writePart(botId, partId, list).catch(error => rt.warn('ds-bot: btw cards of %s not saved: %s', botId, error))
        if (dropped.has(botId)) return list
      } else {
        byBot.set(partId, list)
      }
      trackPart(botId, partId)
      return cards.get(botId)?.get(partId) ?? list
    })()
    reading.set(key, job)
    try {
      return await job
    } finally {
      reading.delete(key)
    }
  }

  // Only each Bot's current part is read up front. An earlier part's file is
  // read when that part's history is asked for (parts.js's earlier page).
  const originalLoad = rt.load?.bind(rt)
  if (typeof originalLoad === 'function') {
    let ready
    rt.load = () => (ready ??= (async () => {
      await originalLoad()
      for (const botId of Object.keys(state.bots)) await readPart(botId, rt.chatOf(botId))
    })())
  }

  const originalRefresh = rt.refresh?.bind(rt)
  if (typeof originalRefresh === 'function') {
    rt.refresh = async () => {
      const wasWriting = writes()
      await originalRefresh()
      // Taking over a team the other host closed makes this one the writer:
      // re-read the loaded parts so a leftover 'answering' is recorded now.
      if (wasWriting || !writes()) return
      for (const [botId, byBot] of cards) {
        const parts = Array.from(byBot.keys())
        byBot.clear()
        for (const partId of parts) await readPart(botId, partId)
      }
    }
  }

  // The team view carries each Bot's current part only; earlier parts come with
  // their history pages.
  const btwView = () => {
    const view = {}
    for (const botId of Object.keys(state.bots)) {
      const list = listOf(botId, rt.chatOf(botId))
      if (list.length > 0) view[botId] = list
    }
    return view
  }

  // Deleting a card removes only that saved aside. The whole read-modify-write
  // is queued so two cards deleted together cannot restore each other. A state
  // save afterwards bumps the revision, so every window polls the new lists.
  function btwDelete({ sessionId, cardId }) {
    const run = deleting.then(async () => {
      const { botId } = locatePrivate(rt, sessionId, "Side chat is only available in a Bot's private chat.")
      const list = await readPart(botId, sessionId)
      if (dropped.has(botId)) return { deleted: false }
      const next = list.filter(card => card?.id !== cardId)
      if (next.length === list.length) return { deleted: false }
      let byBot = cards.get(botId)
      if (byBot === undefined) { byBot = new Map(); cards.set(botId, byBot) }
      byBot.set(sessionId, next)
      try {
        await writePart(botId, sessionId, next)
      } catch (error) {
        if (!dropped.has(botId)) {
          let rollback = cards.get(botId)
          if (rollback === undefined) { rollback = new Map(); cards.set(botId, rollback) }
          rollback.set(sessionId, list)
          trackPart(botId, sessionId)
        }
        throw error
      }
      if (dropped.has(botId)) return { deleted: false }
      trackPart(botId, sessionId)
      await rt.save()
      return { deleted: true }
    })
    deleting = run.catch(() => {})
    return run
  }

  // Plugin unload; queued deletes and their file writes have to finish.
  async function btwDispose() {
    await deleting
    await writing
    cards.clear()
    historicalParts.clear()
    reading.clear()
    writingParts.clear()
  }

  // Clears the Bot's cards before the roster save.
  async function dropBot(botId) {
    dropped.add(botId)
    cards.delete(botId)
    const histPrefix = `${botId}\0`
    for (const key of historicalParts) if (key.startsWith(histPrefix)) historicalParts.delete(key)
    for (const key of reading.keys()) if (key.startsWith(`${botId}/`)) reading.delete(key)
    if (cardsDir !== undefined && writes()) await rm(join(cardsDir, botId), { recursive: true, force: true }).catch(error => rt.warn('ds-bot: btw cards of %s not removed: %s', botId, error))
  }

  // Channel can be installed without the roster (the thinking route test).
  rt.onBotDelete?.(dropBot)

  Object.assign(rt, { btwDelete, btwDispose, btwView, btwPartCards: readPart, btwCachedParts: () => [...cards.values()].reduce((sum, map) => sum + map.size, 0) })
}
