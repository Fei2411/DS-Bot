// Unified DSH execution adapter (D1–D4 dual-mode with 0.2.2-rc.5 fallback) and single
// coordination scheduler pump consuming `rt.coordDb` ready cards in strict priority order.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND } from './constants.js'
import { isContextOnlySource } from './context-messages.js'
import { textOf } from './text.js'
import { isMissingSessionError } from './threads.js'

const isWakingPreStepMessage = (msg) => {
  const src = msg?.source
  if (src === undefined) return true
  return !isContextOnlySource(src)
}

const matchesIdempotency = (source, key) => {
  if (!source || typeof key !== 'string' || key === '') return false
  return source.idempotencyKey === key || source.rpcId === key || source.exchangeId === key
}

const isNotFoundSessionError = (error) => (
  error?.code === 'session/not-found'
  || error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
  || error?.name === 'WorkspaceUnknownSessionError'
)

const INTERRUPTED_TOOL_ERROR_CODES = new Set(['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'])

// Pure D2 delivery status inspector over a session's event log (+ optional live inbox).
// Used when running on DSH 0.2.2-rc.5 without native `queryDeliveryStatus`, matching
// the real DSH event schema:
// - `agent/inbox/spliced`: `{ target: 'next-step' | 'next-turn' | 'note', start, removedCount, inserted, outcome }`
// - `session/end-seed`: `{ inherited: true }` clears inherited `note` queue across fork boundary
// - `tool/result`: `data.message.source.callId` and `data.error?.code` (`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`)
export function inspectDeliveryStatusFromEvents(events, query, options = {}) {
  const inheritedCount = Number.isInteger(options.inheritedEventCount) && options.inheritedEventCount > 0
    ? options.inheritedEventCount
    : 0
  const liveStatus = options.liveStatus
  const liveInbox = options.liveInbox
  const wantedKey = typeof query?.idempotencyKey === 'string' && query.idempotencyKey !== '' ? query.idempotencyKey : undefined
  const wantedTurn = Number.isInteger(query?.turn) ? query.turn : undefined
  const allEvents = Array.isArray(events) ? events : []

  const findInLiveInbox = () => {
    if (!wantedKey || !liveInbox) return undefined
    for (const bucket of [liveInbox.nextStep, liveInbox.nextTurn, liveInbox.notes, liveInbox.note]) {
      for (const msg of Array.isArray(bucket) ? bucket : []) {
        if (matchesIdempotency(msg?.source, wantedKey)) return msg
      }
    }
    return undefined
  }

  // Reconstruct the 3 inbox queues from seq 0 so `start` / `removedCount` splices are exact.
  const queues = {
    'next-step': [],
    'next-turn': [],
    note: [],
  }

  let matchedMessageId
  let state = 'not_found'
  let consumed = false
  let targetTurn = wantedTurn
  let currentTurn
  let currentTurnStartSeq
  let currentAssistantTexts = []
  let currentToolCalls = 0
  let openTools = new Map()
  let explicitInterruptedTools = []
  let boundTurnSummary

  const collectInterruptedTools = () => [...explicitInterruptedTools, ...openTools.values()]

  const finalizeBoundTurn = (reason, endSeq) => {
    const kind = reason?.kind
    const interruptedTools = collectInterruptedTools()
    const assistantText = currentAssistantTexts.join('\n\n').trim() || undefined
    if (kind === 'completed' || kind === 'yielded' || kind === 'max-tokens') {
      boundTurnSummary = {
        status: 'completed',
        consumed,
        ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
        ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
        turn: currentTurn,
        turnStartSeq: currentTurnStartSeq,
        turnEndSeq: endSeq,
        turnEndKind: kind,
        yielded: kind === 'yielded',
        ...(kind === 'yielded' && reason?.reason ? { yieldReason: reason.reason } : {}),
        ...(assistantText !== undefined ? { assistantText } : {}),
        toolCalls: currentToolCalls,
        interruptedTools,
      }
    } else if (kind === 'error' || kind === 'blocked') {
      boundTurnSummary = {
        status: 'failed',
        consumed,
        ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
        ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
        turn: currentTurn,
        turnStartSeq: currentTurnStartSeq,
        turnEndSeq: endSeq,
        turnEndKind: kind,
        ...(reason?.error !== undefined ? { error: reason.error } : {}),
        ...(assistantText !== undefined ? { assistantText } : {}),
        toolCalls: currentToolCalls,
        interruptedTools,
      }
    } else {
      boundTurnSummary = {
        status: 'aborted',
        consumed,
        ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
        ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
        turn: currentTurn,
        turnStartSeq: currentTurnStartSeq,
        turnEndSeq: endSeq,
        turnEndKind: kind,
        ...(reason?.reason?.kind ? { cancelCause: reason.reason.kind } : {}),
        ...(assistantText !== undefined ? { assistantText } : {}),
        toolCalls: currentToolCalls,
        interruptedTools,
      }
    }
  }

  for (let index = 0; index < allEvents.length; index += 1) {
    const event = allEvents[index]
    if (!event || typeof event !== 'object') continue
    const ownEvent = index >= inheritedCount

    if (event.type === 'session/end-seed' && event.data?.inherited === true) {
      queues.note.length = 0
      continue
    }

    if (event.type === 'agent/inbox/spliced' || event.type === 'agent/inbox/note-spliced') {
      const targetName = event.type === 'agent/inbox/note-spliced' ? 'note' : event.data?.target
      const queue = queues[targetName]
      const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
      let removed = []
      if (queue !== undefined) {
        const start = Number.isInteger(event.data?.start) && event.data.start >= 0 ? event.data.start : 0
        const removedCount = Number.isInteger(event.data?.removedCount) && event.data.removedCount >= 0 ? event.data.removedCount : 0
        removed = queue.splice(start, removedCount, ...inserted)
      }
      if (ownEvent && wantedKey !== undefined) {
        // Check `removed` before `inserted` so an in-place `inbox.replace` with the same key ends as `queued`.
        for (const msg of removed) {
          if (matchesIdempotency(msg?.source, wantedKey) || (matchedMessageId !== undefined && msg?.id === matchedMessageId)) {
            matchedMessageId ??= msg.id
            if (!consumed) {
              if (event.data?.outcome === 'canceled' || event.data?.outcome === 'cancelled') {
                state = 'aborted'
              } else if (currentTurn !== undefined) {
                // Claimed into the active turn before user/message is logged (B3/B4 crash window).
                targetTurn = currentTurn
                state = 'claimed'
              }
            }
          }
        }
        for (const msg of inserted) {
          if (matchesIdempotency(msg?.source, wantedKey)) {
            matchedMessageId = msg.id
            if (!consumed) state = 'queued'
          }
        }
      }
      continue
    }

    if (!ownEvent) continue

    if (event.type === 'turn/start') {
      currentTurn = event.data?.turn
      currentTurnStartSeq = event.seq
      currentAssistantTexts = []
      currentToolCalls = 0
      openTools = new Map()
      explicitInterruptedTools = []
      if (wantedTurn !== undefined && currentTurn === wantedTurn) {
        state = 'running'
        consumed = true
      }
      continue
    }

    if (event.type === 'user/message') {
      const src = event.data?.source
      if (wantedKey !== undefined && matchesIdempotency(src, wantedKey)) {
        consumed = true
        state = 'running'
        if (currentTurn !== undefined) targetTurn = currentTurn
      }
      continue
    }

    if (currentTurn !== undefined && (targetTurn === currentTurn || wantedTurn === currentTurn)) {
      if (event.type === 'tool/call') {
        currentToolCalls += 1
        const callId = event.data?.callId ?? `call_${currentToolCalls}`
        openTools.set(callId, String(event.data?.name ?? 'tool'))
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId ?? event.data?.callId
        const toolName = (callId !== undefined ? openTools.get(callId) : undefined)
          ?? event.data?.message?.source?.toolName
          ?? event.data?.name
          ?? 'tool'
        if (callId !== undefined) openTools.delete(callId)
        const errCode = event.data?.error?.code
        if (typeof errCode === 'string' && INTERRUPTED_TOOL_ERROR_CODES.has(errCode)) {
          explicitInterruptedTools.push(String(toolName))
        }
      } else if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content).trim()
        if (text !== '') currentAssistantTexts.push(text)
      }
    }

    if (event.type === 'turn/end') {
      if (targetTurn !== undefined && currentTurn === targetTurn) {
        finalizeBoundTurn(event.data?.reason, event.seq)
      }
      currentTurn = undefined
    }
  }

  if (boundTurnSummary !== undefined) return boundTurnSummary

  if (currentTurn !== undefined && (targetTurn === currentTurn || wantedTurn === currentTurn)) {
    const assistantText = currentAssistantTexts.join('\n\n').trim() || undefined
    if (liveStatus !== 'running') {
      return {
        status: 'aborted',
        consumed,
        ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
        ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
        turn: currentTurn,
        turnStartSeq: currentTurnStartSeq,
        cancelCause: 'interrupted',
        ...(assistantText !== undefined ? { assistantText } : {}),
        toolCalls: currentToolCalls,
        interruptedTools: collectInterruptedTools(),
      }
    }
    return {
      status: 'running',
      consumed,
      ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
      ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
      turn: currentTurn,
      turnStartSeq: currentTurnStartSeq,
      ...(assistantText !== undefined ? { assistantText } : {}),
      toolCalls: currentToolCalls,
      interruptedTools: [],
    }
  }

  const liveMsg = findInLiveInbox()
  if (liveMsg !== undefined) {
    return {
      status: 'queued',
      consumed: false,
      messageId: liveMsg.id,
      ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
      toolCalls: 0,
      interruptedTools: [],
    }
  }

  if (state === 'queued' || state === 'aborted') {
    return {
      status: state,
      consumed: false,
      ...(matchedMessageId !== undefined ? { messageId: matchedMessageId } : {}),
      ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
      toolCalls: 0,
      interruptedTools: [],
    }
  }

  return {
    status: 'not_found',
    consumed: false,
    ...(wantedKey !== undefined ? { idempotencyKey: wantedKey } : {}),
    toolCalls: 0,
    interruptedTools: [],
  }
}

export function install(rt) {
  const { ctx } = rt

  /** @type {Set<(event: any) => void>} */
  const workSettledListeners = new Set()
  /** @type {Array<(payload: any) => Promise<any> | any>} */
  const promptGates = []
  /** @type {Map<string, {workId:string, claimToken:string, claimedRevision:number, claimedInboxSeq:number, deliveryKey:string, throughSeq:number, logicalAddress:string}>} */
  const activeClaims = new Map()
  /** @type {Map<string, string>} workId -> sessionId */
  const activeWorkClaims = new Map()
  /** @type {Map<string, {reason:string, at:number}>} fallback D4 yielded sessions */
  const fallbackYieldedSessions = new Map()
  /** @type {Map<string, number>} fallback D4 yield turn marker for non-activeClaims observers (e.g. groups.js) */
  const recentFallbackYieldTurns = new Map()
  const wasFallbackYielded = (sessionId, turn) => {
    if (fallbackYieldedSessions.has(sessionId)) return true
    return Number.isInteger(turn) && recentFallbackYieldTurns.get(sessionId) === turn
  }
  /** @type {Map<string, {workId:string, seqs:number[]}>} fallback D1 notes attached in pre-step awaiting user/message confirmation */
  const pendingFallbackNoteAcks = new Map()

  const emitWorkSettled = (payload) => {
    for (const listener of workSettledListeners) {
      try { listener(payload) } catch (error) { rt.warn?.('ds-bot: work settled listener failed: %s', error) }
    }
  }
  const onWorkSettled = (listener) => {
    workSettledListeners.add(listener)
    return () => workSettledListeners.delete(listener)
  }

  const dshCapabilities = (agent) => {
    const ctrlCaps = ctx.sessionController?.capabilities
    const agentCaps = agent?.capabilities
    const query = ctx.get?.('sessionQuery')
    return Object.freeze({
      zeroWakeNote: Boolean(ctrlCaps?.zeroWakeNote || agentCaps?.zeroWakeNote || typeof agent?.appendNote === 'function'),
      idempotency: Boolean(
        ctrlCaps?.idempotency
        || agentCaps?.idempotency
        || typeof ctx.sessionController?.deliveryStatus === 'function'
        || typeof query?.queryDeliveryStatus === 'function',
      ),
      beforePrompt: Boolean(ctrlCaps?.beforePrompt),
      beforeSend: Boolean(ctrlCaps?.beforeSend || agentCaps?.beforeSend),
      yieldTurn: Boolean(ctrlCaps?.yieldTurn || agentCaps?.yieldTurn),
    })
  }

  // D3: Unified prompt gate registration (native `session/before-prompt` or 0.2.2-rc.5 wrapper).
  const runPromptGates = async (payload) => {
    for (const gate of promptGates) {
      const decision = await gate(payload)
      if (decision && decision.kind && decision.kind !== 'pass') return decision
    }
    return { kind: 'pass' }
  }

  const registerPromptGate = (gate) => {
    if (typeof gate !== 'function') return () => {}
    promptGates.push(gate)
    return () => {
      const at = promptGates.indexOf(gate)
      if (at !== -1) promptGates.splice(at, 1)
    }
  }

  // D3: Native `session/before-prompt` gate when supported by DSH. On official
  // `0.2.2-rc.5` (no `beforePrompt` capability), DS Bot never wraps or patches
  // `sessionController.prompt` — foreground isolation uses the public
  // `agent/inbox/inserted` handoff path in `bot-tasks.js`.
  if (ctx.sessionController?.capabilities?.beforePrompt) {
    ctx.on('session/before-prompt', async (payload, next) => {
      const decision = await runPromptGates({
        ...payload,
        sessionId: payload?.request?.sessionId,
      })
      if (decision.kind !== 'pass') return decision
      return next()
    })
  }

  // D4: Deterministic tool yield (native `exec.yieldTurn` or 0.2.2-rc.5 `concludeTurn` + clean pre-step break).
  const yieldToolTurn = (exec, reason = 'yielded') => {
    if (typeof exec?.yieldTurn === 'function') {
      exec.yieldTurn(reason)
      return
    }
    exec?.concludeTurn?.()
    const sessionId = exec?.sessionId ?? exec?.agent?.id ?? exec?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') {
      fallbackYieldedSessions.set(sessionId, { reason, at: Date.now() })
    }
  }

  // D1 fallback + D4 fallback pre-step hook (never marks SQLite notes read in pre-step; waits for user/message).
  ctx.on('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
    const id = agent?.id ?? agent?.session?.id
    if (id !== undefined && step > 1 && fallbackYieldedSessions.has(id)) {
      return { kind: 'enter', messages: [] }
    }
    const decision = await next()
    if (decision?.kind === 'reject' || signal?.aborted || !Array.isArray(decision?.messages)) return decision
    if (step !== 1 || id === undefined) return decision
    if (!decision.messages.some(isWakingPreStepMessage) || (Array.isArray(messages) && !messages.some(isWakingPreStepMessage))) {
      return decision
    }
    if (dshCapabilities(agent).zeroWakeNote) return decision
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.isClosed()) return decision
    const work = coordDb.getWorkBySessionId(id)
    if (!work) return decision
    const unreadNotes = coordDb.listInbox(work.workId, { unreadOnly: true }).filter(m => m.kind === 'note')
    if (unreadNotes.length === 0) return decision

    const alreadyKeys = new Set(decision.messages.map(m => m?.source?.idempotencyKey ?? m?.source?.exchangeId).filter(Boolean))
    const toPrepend = []
    const attachedSeqs = []
    for (const note of unreadNotes) {
      const key = note.dshIdempotencyKey ?? note.dedupKey ?? `coord-note:${work.workId}:${note.seq}`
      if (alreadyKeys.has(key)) continue
      alreadyKeys.add(key)
      const text = note.payload?.renderedText ?? note.bodyPreview ?? ''
      if (text === '') continue
      toPrepend.push(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: SOURCE_KIND,
          form: 'relay',
          role: 'note',
          silent: true,
          idempotencyKey: key,
          coordWorkId: work.workId,
          coordNoteSeq: note.seq,
          ...(note.senderBotId ? { senderSessionId: note.senderBotId } : {}),
        },
      }))
      attachedSeqs.push(note.seq)
    }
    if (toPrepend.length === 0) return decision
    pendingFallbackNoteAcks.set(id, { workId: work.workId, seqs: attachedSeqs })
    return {
      ...decision,
      messages: [...toPrepend, ...decision.messages],
    }
  })

  // D1: Zero-wake silent note delivery.
  async function dispatchNote(target, msgSpec, opts = {}) {
    const coordDb = rt.coordDb
    const idempotencyKey = opts.idempotencyKey ?? opts.dedupKey ?? msgSpec?.source?.idempotencyKey ?? msgSpec?.source?.exchangeId ?? `note_${randomUUID()}`
    let workId = opts.workId
    let sessionId = opts.sessionId
    if (!workId && coordDb && !coordDb.isClosed()) {
      if (typeof target === 'string' && target !== '') {
        const byId = coordDb.getWork(target)
        const byAddr = byId ?? coordDb.getWorkByLogicalAddress(target)
        const bySess = byAddr ?? coordDb.getWorkBySessionId(target)
        workId = bySess?.workId
        sessionId ??= bySess?.sessionId
      }
    }
    if (!sessionId && typeof target === 'string') {
      sessionId = rt.resolveLogicalSession?.(target) ?? target
    }

    let queuedInDb = false
    let noteSeq
    if (workId && coordDb && !coordDb.readonly && !coordDb.isClosed()) {
      const renderedText = typeof msgSpec === 'string'
        ? msgSpec
        : (typeof msgSpec?.text === 'string' ? msgSpec.text : textOf(msgSpec?.content))
      const recv = coordDb.receiveMessage({
        workId,
        kind: 'note',
        dedupKey: opts.dedupKey ?? idempotencyKey,
        senderAddress: opts.senderAddress,
        senderBotId: opts.senderBotId,
        bodyPreview: opts.bodyPreview ?? renderedText.slice(0, 400),
        payload: { ...(opts.payload ?? {}), renderedText },
        dshIdempotencyKey: idempotencyKey,
        wake: false,
      })
      noteSeq = recv?.message?.seq
      queuedInDb = true
    }

    if (sessionId) {
      const liveAgent = ctx.get?.('agents')?.get?.(sessionId)
      const agent = liveAgent ?? (dshCapabilities().zeroWakeNote ? await rt.resolveAgent?.(sessionId).catch(() => undefined) : undefined)
      if (agent && typeof agent.appendNote === 'function') {
        const baseMsg = typeof msgSpec === 'string'
          ? createUserMessage({
              content: [{ type: 'text', text: msgSpec }],
              source: {
                kind: SOURCE_KIND,
                form: 'relay',
                role: 'note',
                silent: true,
              },
            })
          : msgSpec
        const userMessage = {
          ...baseMsg,
          source: {
            ...(baseMsg?.source ?? { kind: SOURCE_KIND, form: 'relay', role: 'note', silent: true }),
            idempotencyKey,
            ...(workId ? { coordWorkId: workId } : {}),
            ...(Number.isInteger(noteSeq) ? { coordNoteSeq: noteSeq } : {}),
          },
        }
        agent.appendNote(userMessage, { idempotencyKey })
        await ctx.sessions?.flush?.(agent.session).catch(() => {})
        return { delivered: true, queuedInDb, idempotencyKey }
      }
    }
    return { delivered: false, queuedInDb, idempotencyKey }
  }

  // Detects when DSH skipped indexing a corrupt persisted `.jsonl` file on disk and
  // reported `SESSION_QUERY_SESSION_NOT_FOUND` / `session/not-found`: in that case
  // cold-read MUST fail closed (`session/log_unreadable`) so recovery pauses as
  // `needs_verification` rather than fabricating `not_found` and blindly re-running.
  const hasPersistedSessionFileOnDisk = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const roots = new Set()
    const persistenceRoot = ctx.get?.('sessionPersistence')?.root
    if (typeof persistenceRoot === 'string' && persistenceRoot !== '') roots.add(persistenceRoot)
    if (typeof rt.dshHome === 'string' && rt.dshHome !== '') roots.add(join(rt.dshHome, 'sessions'))
    if (typeof rt.home === 'string' && rt.home !== '') {
      roots.add(join(rt.home, 'sessions'))
      roots.add(join(dirname(rt.home), 'sessions'))
    }
    const matchesSessionFile = (name) => (
      name === `${sessionId}.jsonl`
      || name.startsWith(`${sessionId}.jsonl.`)
      || name.endsWith(`-${sessionId}.jsonl`)
      || name.endsWith(`_${sessionId}.jsonl`)
      || name.includes(`-${sessionId}.jsonl.`)
      || name.includes(`_${sessionId}.jsonl.`)
    )
    const hasJsonlInDir = (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).some(
          item => item.isFile() && (item.name.endsWith('.jsonl') || item.name.includes('.jsonl.')),
        )
      } catch {
        return false
      }
    }
    const scanDir = (dir, depth) => {
      if (depth > 3 || !existsSync(dir)) return false
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return false
      }
      for (const entry of entries) {
        if (entry.isFile() && matchesSessionFile(entry.name)) return true
        if (entry.isDirectory()) {
          const full = join(dir, entry.name)
          // Real DSH JSONL layout: `<sessionsRoot>/<cwdKey>/<sessionId>/session.v4.jsonl[.zst]`
          if (entry.name === sessionId && hasJsonlInDir(full)) return true
          if (scanDir(full, depth + 1)) return true
        }
      }
      return false
    }
    for (const root of roots) {
      if (scanDir(root, 0)) return true
    }
    return false
  }

  const handleNotFoundSessionError = (sessionId, error) => {
    if (hasPersistedSessionFileOnDisk(sessionId)) {
      throw Object.assign(
        new Error(`Persisted session log for ${sessionId} exists on disk but could not be read/indexed`),
        { code: 'session/log_unreadable', cause: error },
      )
    }
    return { status: 'not_found', consumed: false, toolCalls: 0, interruptedTools: [] }
  }

  // Native D2 `deliveryStatus` / `queryDeliveryStatus` internally maps `SESSION_QUERY_SESSION_NOT_FOUND`
  // to `{ status: 'not_found' }`. When a persisted `.jsonl` file exists on disk for a cold session,
  // probe `observeSession` once (disposing the lease immediately) to distinguish a valid session whose
  // delivery never arrived (B1 -> `not_found`) from a corrupt-header file skipped by the scanner (B6a -> fail closed).
  const verifyNotFoundAgainstDisk = async (sessionId, result, signal) => {
    if (result?.status !== 'not_found') return result
    if (ctx.get?.('agents')?.get?.(sessionId) !== undefined) return result
    if (!hasPersistedSessionFileOnDisk(sessionId)) return result
    const sessionQuery = ctx.get?.('sessionQuery')
    if (typeof sessionQuery?.observeSession !== 'function') return result
    let obs
    try {
      obs = await sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal })
      return result
    } catch (probeError) {
      if (isNotFoundSessionError(probeError)) return handleNotFoundSessionError(sessionId, probeError)
      throw probeError
    } finally {
      obs?.[Symbol.dispose]?.()
    }
  }

  // D2: Cold-read-safe delivery status query (never hydrates cold agents; propagates real I/O & corrupt-log errors).
  async function queryDeliveryStatus(sessionId, query, { liveStatus, signal } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { status: 'not_found', consumed: false, toolCalls: 0, interruptedTools: [] }
    }
    if (typeof ctx.sessionController?.deliveryStatus === 'function') {
      try {
        const res = await ctx.sessionController.deliveryStatus({
          sessionId,
          ...query,
        }, signal)
        return await verifyNotFoundAgainstDisk(sessionId, res, signal)
      } catch (error) {
        if (isNotFoundSessionError(error)) return handleNotFoundSessionError(sessionId, error)
        throw error
      }
    }
    const sessionQuery = ctx.get?.('sessionQuery')
    if (typeof sessionQuery?.queryDeliveryStatus === 'function') {
      try {
        const res = await sessionQuery.queryDeliveryStatus(sessionId, query, { signal })
        return await verifyNotFoundAgainstDisk(sessionId, res, signal)
      } catch (error) {
        if (isNotFoundSessionError(error)) return handleNotFoundSessionError(sessionId, error)
        throw error
      }
    }
    const liveAgent = ctx.get?.('agents')?.get?.(sessionId)
    if (liveAgent && typeof liveAgent.getDeliveryStatus === 'function') {
      return liveAgent.getDeliveryStatus(query)
    }
    const effectiveLiveStatus = liveStatus ?? (liveAgent ? liveAgent.status : 'idle')
    if (liveAgent && typeof liveAgent.session?.snapshotEvents === 'function') {
      return inspectDeliveryStatusFromEvents(liveAgent.session.snapshotEvents(), query, {
        inheritedEventCount: liveAgent.session.inheritedEventCount ?? 0,
        liveStatus: effectiveLiveStatus,
        liveInbox: liveAgent.inbox,
      })
    }
    if (typeof sessionQuery?.observeSession === 'function') {
      let obs
      try {
        obs = await sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal })
        const events = Array.isArray(obs?.events) ? obs.events : (Array.isArray(obs?.records) ? obs.records.map(r => r.event) : [])
        return inspectDeliveryStatusFromEvents(events, query, {
          inheritedEventCount: obs?.inheritedEventCount ?? 0,
          liveStatus: effectiveLiveStatus,
        })
      } catch (error) {
        if (isNotFoundSessionError(error)) return handleNotFoundSessionError(sessionId, error)
        throw error
      } finally {
        obs?.[Symbol.dispose]?.()
      }
    }
    if (typeof ctx.sessionController?.page === 'function') {
      const pages = []
      let beforeSeq
      try {
        for (let i = 0; i < 20; i += 1) {
          const page = await ctx.sessionController.page({
            address: { kind: 'session', sessionId },
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
            maxMessages: 200,
          }, signal)
          const events = (page.records ?? []).map(r => r.event).filter(Boolean)
          if (events.length > 0) pages.push(events)
          if (!page.hasMore || events.length === 0) break
          beforeSeq = events[0].seq
        }
      } catch (error) {
        if (isNotFoundSessionError(error)) return handleNotFoundSessionError(sessionId, error)
        throw error
      }
      return inspectDeliveryStatusFromEvents(pages.reverse().flat(), query, { liveStatus: effectiveLiveStatus })
    }
    return { status: 'not_found', consumed: false, toolCalls: 0, interruptedTools: [] }
  }

  function formatInboxBatch(work, unreadMessages) {
    const parts = []
    for (const msg of unreadMessages) {
      const payloadText = typeof msg.payload?.text === 'string' && msg.payload.text !== '' ? msg.payload.text : undefined
      const fallbackText = payloadText ?? msg.bodyPreview ?? msg.bodyRef ?? ''
      if (typeof msg.payload?.renderedText === 'string' && msg.payload.renderedText !== '') {
        parts.push(msg.payload.renderedText)
      } else if (msg.kind === 'revise') {
        parts.push(`[Revision #${msg.targetRevision ?? work.revision}]\n${fallbackText}`)
      } else if (msg.kind === 'ask') {
        parts.push(`[Question from ${msg.senderAddress ?? 'teammate'} · wait ${msg.waitId ?? ''}]\n${fallbackText}`)
      } else if (msg.kind === 'answer') {
        parts.push(`[Answer · wait ${msg.waitId ?? ''}]\n${fallbackText}`)
      } else if (msg.kind === 'result') {
        parts.push(`[Result for call ${msg.callId ?? ''}]\n${fallbackText}`)
      } else {
        parts.push(fallbackText)
      }
    }
    return parts.filter(Boolean).join('\n\n')
  }

  // Single coordination scheduler pump with merged filter state & anti-livelock deferral.
  let disposed = false
  let pumping = null
  let pendingPumpAll = false
  const pendingBotIds = new Set()
  const pendingWorkIds = new Set()
  const isStopped = db => disposed || !db || db.readonly || db.isClosed()

  async function dispatchClaimedWork(claim) {
    const coordDb = rt.coordDb
    if (isStopped(coordDb)) return 'stopped'
    const { work, claimToken, claimedRevision, claimedInboxSeq, unreadMessages, notes } = claim
    // Group-relay-managed room_call / room_caller works are orchestrated by `groups.js`, never raw-dispatched.
    if (work.kind === 'room_work' && work.originKind === 'group') {
      coordDb.yieldWork({
        workId: work.workId,
        claimToken,
        nextStatus: 'waiting',
        expectedRevision: claimedRevision,
        expectedInboxSeq: claimedInboxSeq,
        releaseOnConflict: false,
      })
      return 'deferred'
    }
    // Never emit a ghost `(continue work)` turn into a user's foreground chat when no waking inbox message exists.
    if (work.kind === 'foreground' && unreadMessages.length === 0) {
      coordDb.yieldWork({
        workId: work.workId,
        claimToken,
        nextStatus: 'idle',
        expectedRevision: claimedRevision,
        expectedInboxSeq: claimedInboxSeq,
      })
      return 'yielded'
    }
    const sessionId = rt.resolveLogicalSession?.(work.logicalAddress) ?? work.sessionId
    if (!sessionId) {
      if (work.kind !== 'foreground') {
        const res = coordDb.settleWork({
          workId: work.workId,
          outcome: 'failed',
          force: true,
          error: { code: 'coordination/unresolvable_address', message: `No active session for ${work.logicalAddress}` },
        })
        if (res.settled) emitWorkSettled({ outcome: 'failed', ...res })
      } else {
        coordDb.yieldWork({ workId: work.workId, claimToken, nextStatus: 'idle', expectedRevision: claimedRevision, expectedInboxSeq: claimedInboxSeq })
      }
      return 'settled'
    }

    // Enforce strict 1:1 active claim mutual exclusion on every session (DSH & local CLI alike)
    // plus exclusive workspace boundary for local CLI engines.
    const cliCap = rt.localAgentCapability?.(work.botId)
    if (activeClaims.has(sessionId)) {
      coordDb.requeueInterruptedWork(work.workId, { reason: cliCap?.serialPerSession ? 'cli_session_busy' : 'session_busy' })
      return 'deferred'
    }
    if (cliCap?.exclusiveWorkspace && work.kind !== 'foreground' && work.workspaceDir) {
      for (const active of activeClaims.values()) {
        const runningWork = coordDb.getWork(active.workId)
        if (runningWork && runningWork.botId === work.botId && runningWork.workspaceDir === work.workspaceDir) {
          coordDb.requeueInterruptedWork(work.workId, { reason: 'cli_workspace_busy' })
          return 'deferred'
        }
      }
    }

    if (sessionId !== work.sessionId) {
      coordDb.rebindSession(work.workId, sessionId)
    }

    const throughSeq = claimedInboxSeq
    const { deliveryKey } = coordDb.beginDeliveryAttempt({
      workId: work.workId,
      claimToken,
      throughSeq,
      sessionId,
    })

    const claimRecord = {
      workId: work.workId,
      claimToken,
      claimedRevision,
      claimedInboxSeq,
      deliveryKey,
      throughSeq,
      logicalAddress: work.logicalAddress,
    }
    activeClaims.set(sessionId, claimRecord)
    activeWorkClaims.set(work.workId, sessionId)

    try {
      await rt.ensureCapabilities?.(sessionId)
      if (isStopped(coordDb)) {
        if (activeClaims.get(sessionId) === claimRecord) activeClaims.delete(sessionId)
        if (activeWorkClaims.get(work.workId) === sessionId) activeWorkClaims.delete(work.workId)
        return 'stopped'
      }
      const agent = await rt.resolveAgent(sessionId)
      if (isStopped(coordDb)) {
        if (activeClaims.get(sessionId) === claimRecord) activeClaims.delete(sessionId)
        if (activeWorkClaims.get(work.workId) === sessionId) activeWorkClaims.delete(work.workId)
        return 'stopped'
      }
      const caps = dshCapabilities(agent)

      if (notes.length > 0 && caps.zeroWakeNote && typeof agent.appendNote === 'function') {
        for (const note of notes) {
          const text = note.payload?.renderedText ?? note.bodyPreview ?? ''
          if (text === '') continue
          const noteKey = note.dshIdempotencyKey ?? note.dedupKey ?? `coord-note:${work.workId}:${note.seq}`
          agent.appendNote(createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: SOURCE_KIND,
              form: 'relay',
              role: 'note',
              silent: true,
              idempotencyKey: noteKey,
              coordWorkId: work.workId,
              coordNoteSeq: note.seq,
            },
          }), { idempotencyKey: noteKey })
        }
      }

      const body = formatInboxBatch(work, unreadMessages)
      const lastMsg = unreadMessages.at(-1)
      const msgPayload = lastMsg?.payload ?? {}
      const extraSource = msgPayload.source && typeof msgPayload.source === 'object' ? msgPayload.source : {}
      const images = unreadMessages.flatMap(m => (Array.isArray(m.payload?.images) ? m.payload.images : []))
      const files = unreadMessages.flatMap(m => [
        ...(Array.isArray(m.payload?.files) ? m.payload.files : []),
        ...(Array.isArray(m.payload?.workMeta?.files) && !Array.isArray(m.payload?.files) ? m.payload.workMeta.files : []),
      ])
      const resolvedRole = msgPayload.role
        ?? msgPayload.callMeta?.role
        ?? msgPayload.workMeta?.role
        ?? (lastMsg?.kind === 'ask' ? 'ask_back' : lastMsg?.kind === 'answer' ? 'answer' : lastMsg?.kind === 'result' ? 'reply' : 'request')
      const resolvedRoomId = msgPayload.roomId ?? msgPayload.workMeta?.roomId ?? work.roomId
      const resolvedImOrigin = msgPayload.imOrigin ?? msgPayload.workMeta?.imOrigin ?? work.imOrigin
      const resolvedWorkRef = msgPayload.workRef ?? msgPayload.source?.workRef ?? work.workRef
      const resolvedReplyTo = msgPayload.replyTo ?? msgPayload.source?.replyTo
      const resolvedSenderName = msgPayload.senderName ?? msgPayload.source?.senderName ?? rt.botOf?.(lastMsg?.senderBotId)?.name
      const resolvedLength = typeof msgPayload.length === 'number'
        ? msgPayload.length
        : (typeof msgPayload.workMeta?.length === 'number' ? msgPayload.workMeta.length : undefined)
      const exchangeId = msgPayload.exchangeId ?? deliveryKey
      const message = createUserMessage({
        content: [
          { type: 'text', text: body || '(continue work)' },
          ...images.map(attachment => ({ type: 'image', attachment })),
          ...files.map(attachment => ({ type: 'file', attachment })),
        ],
        source: {
          ...extraSource,
          kind: SOURCE_KIND,
          form: 'relay',
          role: resolvedRole,
          exchangeId,
          transferId: msgPayload.transferId ?? extraSource.transferId ?? deliveryKey,
          idempotencyKey: deliveryKey,
          coordWorkId: work.workId,
          coordThroughSeq: throughSeq,
          coordRevision: claimedRevision,
          ...(resolvedRoomId ? { roomId: resolvedRoomId } : {}),
          ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}),
          ...(resolvedReplyTo ? { replyTo: resolvedReplyTo } : {}),
          ...(resolvedSenderName ? { senderName: resolvedSenderName } : {}),
          ...(resolvedImOrigin ? { imOrigin: resolvedImOrigin } : {}),
          ...(resolvedLength !== undefined ? { length: resolvedLength } : {}),
          ...(lastMsg?.senderBotId ? { senderSessionId: lastMsg.senderBotId } : {}),
        },
      })

      const useSteer = msgPayload.steer === true && cliCap?.supportsSteer !== false
      if (useSteer && typeof agent.steer === 'function') {
        agent.steer(message, { idempotencyKey: deliveryKey })
      } else {
        agent.followup(message, { idempotencyKey: deliveryKey })
      }
      await ctx.sessions?.flush?.(agent.session)
      return 'dispatched'
    } catch (error) {
      if (activeClaims.get(sessionId) === claimRecord) activeClaims.delete(sessionId)
      if (activeWorkClaims.get(work.workId) === sessionId) activeWorkClaims.delete(work.workId)
      if (isStopped(coordDb) || error?.code === 'coordination/closed' || error?.code === 'plugin/disposed') {
        return 'stopped'
      }
      rt.warn?.('ds-bot: dispatching work %s to %s failed: %s', work.workId, sessionId, error?.message ?? error)

      if (work.kind !== 'foreground' && (isNotFoundSessionError(error) || error?.code === 'bot/unknown')) {
        if (isStopped(coordDb)) return 'stopped'
        const res = coordDb.settleWork({
          workId: work.workId,
          outcome: 'failed',
          force: true,
          error: { code: error.code, message: error.message },
        })
        if (res.settled) emitWorkSettled({ outcome: 'failed', ...res })
        return 'failed'
      }

      let status
      try {
        status = await queryDeliveryStatus(sessionId, { idempotencyKey: deliveryKey })
      } catch (statusError) {
        if (isStopped(coordDb) || statusError?.code === 'coordination/closed') return 'stopped'
        rt.warn?.('ds-bot: delivery status check after dispatch error for %s failed: %s', work.workId, statusError?.message ?? statusError)
        coordDb.pauseWork(work.workId, {
          status: 'needs_verification',
          reason: 'delivery_status_unreadable',
          detail: {
            sessionId,
            deliveryKey,
            dispatchError: String(error?.message ?? error),
            statusError: String(statusError?.message ?? statusError),
          },
        })
        return 'paused'
      }

      if (isStopped(coordDb)) return 'stopped'
      if (status.status === 'running' || status.status === 'queued') {
        activeClaims.set(sessionId, claimRecord)
        activeWorkClaims.set(work.workId, sessionId)
      } else {
        coordDb.reconcileDeliveryStatus({ workId: work.workId, deliveryStatus: status })
      }
      return 'reconciled'
    }
  }

  function kickScheduler({ botId, workId } = {}) {
    if (disposed || rt.readOnly?.() !== undefined) return Promise.resolve()
    const coordDb = rt.coordDb
    if (isStopped(coordDb)) return Promise.resolve()

    if (typeof workId === 'string' && workId !== '') pendingWorkIds.add(workId)
    else if (typeof botId === 'string' && botId !== '') pendingBotIds.add(botId)
    else pendingPumpAll = true

    if (pumping !== null) return pumping

    pumping = (async () => {
      try {
        while (!disposed && (pendingPumpAll || pendingWorkIds.size > 0 || pendingBotIds.size > 0)) {
          const runAll = pendingPumpAll
          const runWorkIds = [...pendingWorkIds]
          const runBotIds = [...pendingBotIds]
          pendingPumpAll = false
          pendingWorkIds.clear()
          pendingBotIds.clear()

          const deferredWorkIds = new Set()
          const maxBatch = 64
          let dispatched = 0

          const claimAndDispatch = async (filter) => {
            if (rt.readOnly?.() !== undefined || isStopped(rt.coordDb)) return false
            try {
              const claim = rt.coordDb.claimReady({
                ...filter,
                respectWorkspaceLock: true,
                excludeWorkIds: deferredWorkIds,
              })
              if (!claim) return false
              const outcome = await dispatchClaimedWork(claim)
              if (outcome === 'stopped') return false
              if (outcome === 'deferred') deferredWorkIds.add(claim.work.workId)
              dispatched += 1
              return true
            } catch (error) {
              if (disposed || error?.code === 'coordination/closed') return false
              throw error
            }
          }

          for (const targetWorkId of runWorkIds) {
            if (dispatched >= maxBatch) break
            await claimAndDispatch({ workId: targetWorkId })
          }
          if (!runAll) {
            for (const targetBotId of runBotIds) {
              while (dispatched < maxBatch) {
                const more = await claimAndDispatch({ botId: targetBotId })
                if (!more) break
              }
            }
          } else {
            while (dispatched < maxBatch) {
              const more = await claimAndDispatch({})
              if (!more) break
            }
          }
        }
      } finally {
        pumping = null
      }
    })()
    return pumping
  }

  // Normalized turn lifecycle handler invoked by `turns.js`.
  function notifyTurnLifecycle(event) {
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.readonly || coordDb.isClosed()) return
    const sessionId = event?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return

    if (event.type === 'turn/user-message') {
      const src = event.source
      if (src?.coordWorkId && Number.isInteger(src.coordNoteSeq)) {
        // Single-row note ack: NEVER marks earlier unread waking messages read.
        try { coordDb.ackInboxSeq(src.coordWorkId, src.coordNoteSeq, { turn: event.turn }) } catch {}
      }
      if (src?.coordWorkId && Number.isInteger(src.coordThroughSeq)) {
        try { coordDb.ackInbox(src.coordWorkId, src.coordThroughSeq, { turn: event.turn }) } catch {}
      }
      const pendingAck = pendingFallbackNoteAcks.get(sessionId)
      if (pendingAck && src?.coordNoteSeq !== undefined && pendingAck.seqs.includes(src.coordNoteSeq)) {
        const remaining = pendingAck.seqs.filter(s => s !== src.coordNoteSeq)
        if (remaining.length === 0) pendingFallbackNoteAcks.delete(sessionId)
        else pendingAck.seqs = remaining
      }
      return
    }

    if (event.type === 'turn/started') {
      // Record active_turn only — NEVER mark inbox rows read before `user/message` commits!
      const active = activeClaims.get(sessionId)
      if (active && Number.isInteger(event.turn)) {
        try { coordDb.recordActiveTurn(active.workId, event.turn, { claimToken: active.claimToken }) } catch {}
      }
      return
    }

    if (event.type === 'turn/ended' || event.type === 'turn/yielded' || event.type === 'turn/failed' || event.type === 'turn/aborted') {
      const fallbackYield = fallbackYieldedSessions.get(sessionId)
      if (fallbackYield !== undefined) {
        fallbackYieldedSessions.delete(sessionId)
        if (Number.isInteger(event.turn)) recentFallbackYieldTurns.set(sessionId, event.turn)
      }
      pendingFallbackNoteAcks.delete(sessionId)

      const active = activeClaims.get(sessionId)
      if (!active) return
      activeClaims.delete(sessionId)
      if (activeWorkClaims.get(active.workId) === sessionId) activeWorkClaims.delete(active.workId)

      const work = coordDb.getWork(active.workId)
      if (!work) return
      const isYielded = event.type === 'turn/yielded' || fallbackYield !== undefined || event.reasonKind === 'yielded'

      if (event.type === 'turn/aborted' && event.cancelCause === 'disposed') {
        return
      }

      const buildResultMeta = (outcome, bodyText, failure) => {
        const senderName = rt.botOf?.(work.botId)?.name ?? 'The other Bot'
        const tag = work.workRef ? ` #${work.workRef}` : ''
        let renderedText
        if (outcome === 'done') {
          const header = `[Work${tag} completed by ${senderName} · closed; reply [PASS] if nothing needs to be told to the user]`
          renderedText = typeof bodyText === 'string' && bodyText !== '' ? `${header}\n${bodyText}` : header
        } else if (outcome === 'failed') {
          const errDetail = failure?.code
            ? ` (${failure.code}${failure.message ? `: ${failure.message}` : ''})`
            : ''
          renderedText = `[Work${tag} failed · ${senderName}]\n${senderName} could not complete this work${errDetail}.`
        } else {
          renderedText = `[Work${tag} stopped · ${senderName}]\n${senderName} was stopped before this work finished.`
        }
        return {
          role: 'reply',
          replyTo: work.workId,
          ...(work.workRef ? { workRef: work.workRef } : {}),
          senderName,
          renderedText,
          source: {
            replyTo: work.workId,
            ...(work.workRef ? { workRef: work.workRef } : {}),
            senderName,
          },
        }
      }

      if (isYielded || work.kind === 'foreground') {
        coordDb.yieldWork({
          workId: active.workId,
          claimToken: active.claimToken,
          expectedRevision: active.claimedRevision,
          expectedInboxSeq: active.claimedInboxSeq,
          ackThroughSeq: active.throughSeq,
        })
      } else if (event.type === 'turn/failed') {
        const failure = event.failure ?? { code: 'turn/failed', message: 'Turn failed' }
        const res = coordDb.settleWork({
          workId: active.workId,
          outcome: 'failed',
          force: true,
          error: failure,
          resultMeta: buildResultMeta('failed', event.text, failure),
        })
        if (res.settled) emitWorkSettled({ outcome: 'failed', ...res })
      } else if (event.type === 'turn/aborted') {
        const res = coordDb.settleWork({
          workId: active.workId,
          outcome: 'stopped',
          force: true,
          error: { code: 'turn/aborted', message: event.reason ?? 'Turn aborted' },
          resultMeta: buildResultMeta('stopped', event.text),
        })
        if (res.settled) emitWorkSettled({ outcome: 'stopped', ...res })
      } else {
        const openReqWaits = coordDb.listWaits({ workId: active.workId, status: 'open' }).filter(w => w.required)
        const hasRunningJobs = (rt.runningJobs?.(sessionId)?.length ?? 0) > 0
        const hasPendingApproval = rt.waitsForApproval?.(sessionId) === true
        const hasActiveSubagents = rt.hasSubagents?.(sessionId) === true
        if (openReqWaits.length > 0 || hasRunningJobs || hasPendingApproval || hasActiveSubagents) {
          coordDb.yieldWork({
            workId: active.workId,
            claimToken: active.claimToken,
            nextStatus: 'waiting',
            expectedRevision: active.claimedRevision,
            expectedInboxSeq: active.claimedInboxSeq,
            ackThroughSeq: active.throughSeq,
          })
        } else {
          const res = coordDb.settleWork({
            workId: active.workId,
            outcome: 'done',
            claimToken: active.claimToken,
            expectedRevision: active.claimedRevision,
            expectedInboxSeq: active.claimedInboxSeq,
            ackThroughSeq: active.throughSeq,
            summary: event.text,
            resultMeta: buildResultMeta('done', event.text),
          })
          if (res.settled) emitWorkSettled({ outcome: 'done', ...res })
        }
      }

      queueMicrotask(() => void kickScheduler())
    }
  }

  // Re-attaches an active claim after restart/reload (`adopt_live`) and wakes parked B2a
  // queued deliveries (`status: 'queued'`) in DSH without duplicating inbox entries.
  async function adoptActiveDelivery(work, sessionId, deliveryStatus) {
    if (!work || typeof sessionId !== 'string' || sessionId === '') return { adopted: false, woken: false }
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.readonly || coordDb.isClosed()) return { adopted: false, woken: false }

    const claimRecord = {
      workId: work.workId,
      claimToken: work.claimToken,
      claimedRevision: work.claimedRevision ?? work.revision,
      claimedInboxSeq: work.claimedInboxSeq ?? work.lastDeliveredSeq ?? 0,
      deliveryKey: work.activeDeliveryKey,
      throughSeq: work.lastDeliveredSeq ?? work.claimedInboxSeq ?? 0,
      logicalAddress: work.logicalAddress,
    }
    activeClaims.set(sessionId, claimRecord)
    activeWorkClaims.set(work.workId, sessionId)

    if (deliveryStatus?.status !== 'queued') {
      return { adopted: true, woken: false }
    }

    try {
      await rt.ensureCapabilities?.(sessionId)
      const agent = await rt.resolveAgent(sessionId)
      if (agent.status === 'running') {
        return { adopted: true, woken: false }
      }

      const key = work.activeDeliveryKey
      const nextStepHit = (agent.inbox?.nextStep ?? []).find(m => matchesIdempotency(m?.source, key))
      const nextTurnHit = nextStepHit ? undefined : (agent.inbox?.nextTurn ?? []).find(m => matchesIdempotency(m?.source, key))
      const parked = nextStepHit ?? nextTurnHit
      const target = nextStepHit ? 'next-step' : 'next-turn'

      if (parked !== undefined) {
        const msg = createUserMessage({ content: parked.content, source: parked.source })
        const caps = dshCapabilities(agent)
        if (caps.idempotency && typeof agent.send === 'function') {
          agent.send(msg, target, true, { idempotencyKey: key })
        } else {
          agent.inbox?.remove?.(parked.id)
          if (target === 'next-step' && typeof agent.steer === 'function') agent.steer(msg)
          else agent.followup(msg)
        }
        await ctx.sessions?.flush?.(agent.session)
        return { adopted: true, woken: true }
      }

      // Message already left the inbox between cold read and hydration: re-query D2 and reconcile.
      if (activeClaims.get(sessionId) === claimRecord) activeClaims.delete(sessionId)
      if (activeWorkClaims.get(work.workId) === sessionId) activeWorkClaims.delete(work.workId)
      if (isStopped(coordDb)) return { adopted: false, woken: false }
      const rechecked = await queryDeliveryStatus(sessionId, { idempotencyKey: key })
      if (isStopped(coordDb)) return { adopted: false, woken: false }
      const reconciled = coordDb.reconcileDeliveryStatus({
        workId: work.workId,
        deliveryStatus: rechecked,
        autoSettle: true,
      })
      if (reconciled.action === 'adopt_live') {
        activeClaims.set(sessionId, claimRecord)
        activeWorkClaims.set(work.workId, sessionId)
      } else if (reconciled.settled && (reconciled.action === 'settled' || reconciled.action === 'failed' || reconciled.action === 'stopped')) {
        emitWorkSettled({
          outcome: reconciled.action === 'settled' ? 'done' : reconciled.action,
          ...reconciled,
        })
      }
      return { adopted: reconciled.action === 'adopt_live', woken: false, reconciled }
    } catch (error) {
      if (activeClaims.get(sessionId) === claimRecord) activeClaims.delete(sessionId)
      if (activeWorkClaims.get(work.workId) === sessionId) activeWorkClaims.delete(work.workId)
      if (isStopped(coordDb) || error?.code === 'coordination/closed' || error?.code === 'plugin/disposed') {
        return { adopted: false, woken: false }
      }
      rt.warn?.('ds-bot: adopting queued delivery for %s on %s failed: %s', work.workId, sessionId, error?.message ?? error)
      if (work.kind !== 'foreground' && isNotFoundSessionError(error)) {
        const settled = coordDb.settleWork({
          workId: work.workId,
          outcome: 'failed',
          force: true,
          error: { code: error.code ?? 'session/not-found', message: String(error?.message ?? error) },
        })
        if (settled.settled) emitWorkSettled({ outcome: 'failed', ...settled })
      } else {
        coordDb.pauseWork(work.workId, {
          status: 'needs_verification',
          reason: 'queued_delivery_adopt_failed',
          detail: { sessionId, deliveryKey: work.activeDeliveryKey, message: String(error?.message ?? error) },
        })
      }
      return { adopted: false, woken: false }
    }
  }

  // Unified work cancellation: atomically stops SQLite work + cancels active DSH agent turn/subagents.
  async function abortWorkExecution(workOrId, { reason = 'Stopped', by, cascadeChildren = false } = {}) {
    const workId = typeof workOrId === 'string' ? workOrId : (workOrId?.workId ?? workOrId?.id)
    let sessionId = typeof workOrId === 'object' ? (workOrId?.sessionId ?? workOrId?.toSession) : undefined
    let settledResult

    const coordDb = rt.coordDb
    if (workId && coordDb && !coordDb.readonly && !coordDb.isClosed()) {
      const existing = coordDb.getWork(workId)
      if (existing) {
        sessionId ??= rt.resolveLogicalSession?.(existing.logicalAddress) ?? existing.sessionId
        settledResult = coordDb.stopWork(workId, { reason, by, cascadeChildren })
        if (settledResult.settled) emitWorkSettled({ outcome: 'stopped', ...settledResult })
      }
    }

    const mappedSession = workId ? activeWorkClaims.get(workId) : undefined
    sessionId ??= mappedSession
    if (mappedSession) {
      activeWorkClaims.delete(workId)
      if (activeClaims.get(mappedSession)?.workId === workId) activeClaims.delete(mappedSession)
    }

    if (typeof sessionId === 'string' && sessionId !== '') {
      await rt.stopSubagents?.(sessionId).catch(() => {})
      const agent = ctx.get?.('agents')?.get?.(sessionId) ?? await rt.resolveAgent?.(sessionId).catch(() => undefined)
      if (agent) {
        if (agent.status === 'running') {
          try { agent.cancel?.({ kind: 'hook', reason: 'ds-bot/stopped' }) } catch {}
        }
        for (const msg of [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]) {
          if (workId && (msg?.source?.coordWorkId === workId || msg?.source?.exchangeId === workId)) {
            agent.inbox?.remove?.(msg.id)
          }
        }
      }
    }

    queueMicrotask(() => void kickScheduler())
    return { stopped: Boolean(settledResult?.settled || sessionId), work: settledResult?.work }
  }

  ctx.effect?.(() => () => {
    disposed = true
    activeClaims.clear()
    activeWorkClaims.clear()
    fallbackYieldedSessions.clear()
    recentFallbackYieldTurns.clear()
    pendingFallbackNoteAcks.clear()
    pendingBotIds.clear()
    pendingWorkIds.clear()
    pendingPumpAll = false
    workSettledListeners.clear()
  }, 'ds-bot: dsh adapter')

  // Shared durable session evidence reader used by `bot-tasks.js` and `resume.js`.
  // Works on official DSH `0.2.2-rc.5` (`sessionQuery.inspectSession` / `readSession`,
  // `sessionController.page`), live loaded sessions, and test `inspect` hooks,
  // distinguishing missing sessions from I/O failures so recovery fails closed on errors.
  async function readSessionEvidence(sessionId, signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)) {
    if (typeof sessionId !== 'string' || sessionId === '') return { status: 'not_found', events: [] }
    const agentsSvc = ctx.get?.('agents') ?? ctx.agents
    const sessionsSvc = ctx.get?.('sessions') ?? ctx.sessions
    const liveSession = (typeof agentsSvc?.get === 'function' ? agentsSvc.get(sessionId)?.session : undefined)
      ?? (typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined)
    const liveEvents = typeof liveSession?.snapshotEvents === 'function' ? liveSession.snapshotEvents() : undefined

    const preferLiveIfNewer = (result) => {
      if (Array.isArray(liveEvents) && liveEvents.length > 0) {
        if (result.status === 'not_found') return { status: 'ok', events: liveEvents }
        if (result.status === 'ok' && liveEvents.length > result.events.length) {
          return { status: 'ok', events: liveEvents }
        }
      }
      return result
    }

    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
    if (typeof query?.inspectSession === 'function') {
      try {
        const events = await query.inspectSession(sessionId, session => session?.snapshotEvents?.() ?? [], signal)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(events) ? events : [] })
      } catch (error) {
        if (isMissingSessionError(error) || isNotFoundSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (typeof query?.readSession === 'function') {
      try {
        const seen = await query.readSession(sessionId)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] })
      } catch (error) {
        if (isMissingSessionError(error) || isNotFoundSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    const controller = ctx.sessionController
    if (typeof controller?.inspect === 'function') {
      try {
        const seen = await controller.inspect(sessionId, signal)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] })
      } catch (error) {
        if (isMissingSessionError(error) || isNotFoundSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (typeof ctx.sessionController?.page === 'function' && typeof rt.eventsBackwards === 'function') {
      try {
        const collected = []
        const read = {}
        for await (const event of rt.eventsBackwards(sessionId, signal, 50, read)) {
          collected.push(event)
        }
        collected.reverse()
        if (collected.length === 0 && read.complete) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return preferLiveIfNewer({ status: 'ok', events: collected })
      } catch (error) {
        if (isMissingSessionError(error) || isNotFoundSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (Array.isArray(liveEvents)) {
      return { status: 'ok', events: liveEvents }
    }
    return { status: 'unavailable' }
  }

  // Rebinds any SQLite works attached to `fromSessionId` onto `toSessionId` so unread
  // zero-wake notes survive part switches and missing-session recovery (#2004).
  const moveSilentNotes = async (fromSessionId, toSessionId) => {
    if (typeof fromSessionId !== 'string' || fromSessionId === '' || typeof toSessionId !== 'string' || toSessionId === '' || fromSessionId === toSessionId) return
    const coordDb = rt.coordDb
    if (!coordDb || coordDb.readonly || coordDb.isClosed()) return
    try {
      const works = coordDb.listWorks({ limit: 500 }).filter(w => w.sessionId === fromSessionId)
      if (works.length > 0) {
        coordDb.transaction(() => {
          for (const w of works) coordDb.rebindSession(w.workId, toSessionId)
        })
      }
    } catch { /* best-effort */ }
  }

  Object.assign(rt, {
    dshCapabilities,
    kickScheduler,
    dispatchNote,
    moveSilentNotes,
    queryDeliveryStatus,
    readSessionEvidence,
    registerPromptGate,
    yieldToolTurn,
    wasFallbackYielded,
    abortWorkExecution,
    adoptActiveDelivery,
    adoptQueuedDelivery: (work, sessionId) => adoptActiveDelivery(work, sessionId, { status: 'queued' }),
    onWorkSettled,
    emitWorkSettled,
    notifyTurnLifecycle,
  })
}
