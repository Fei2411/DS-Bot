// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { isContextOnlySource } from './context-messages.js'
import { headOf, textOf } from './text.js'
import { addressedSession, sameConversation, threadCurrentOfPart } from './threads.js'
import { workNotes } from './work-notes.js'

export function install(rt) {
  const { ctx, state } = rt
  const addressedNotes = workNotes(rt)
  rt.enqueueWorkNote = addressedNotes.enqueue
  rt.workNoteTaken = addressedNotes.taken
  rt.unreadWorkNotes = addressedNotes.unreadCount
  rt.clearWorkNotes = addressedNotes.clear

  const resolveAgent = async (sessionId) => {
    if (ctx.fiber?.uid === null || ctx.sessionController === undefined) {
      throw Object.assign(new Error('Plugin context is inactive'), { code: 'plugin/disposed' })
    }
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note, deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, abandonedReason, asker, workRef } = {}) => {
    const label = note ?? 'new message'
    const reportLabel = note ?? 'replies to your post'
    const tag = workRef ? ` #${workRef}` : ''
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // Silent one-way notices keep their exact header regardless of deferred/resent flags.
    if (role === 'cancelled') return `[Work${tag} cancelled by ${fromName} · no reply needed]`
    if (role === 'note') return `[Note from ${fromName} · FYI only, no reply needed]`
    if (role === 'stopped') return `[Stopped by ${fromName} · no reply needed]`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned && abandonedReason === 'restart') return `[Work${tag} · ${fromName} did not complete before restart${goesOn}]`
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    if (deferred && role === 'reply') return `[Work${tag} completed by ${fromName} · closed · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'ask_back') return `[Work${tag} · ${fromName} asked during your last task${goesOn} · call answer_work to unblock or cancel_work to stop]`
    if (deferred && role === 'answer') return `[Work${tag} · ${fromName} answered during your last task · continue and reply when done]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · ${reportLabel} · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role === 'task-report') return `[Background task report · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role !== 'room') return `[Work${tag} from ${fromName} · you read it during your last task; complete it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role === 'reply') return `[Work${tag} closed · continue processing its result after restart]`
    if (resumed && role !== 'room') return `[Work${tag} from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply') return `[Work${tag} completed by ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role === 'ask_back') return `[Work${tag} · ${fromName} asks before continuing · DeepSeek Harness restarted before it could reach you · call answer_work or cancel_work]`
    if (resent && role === 'answer') return `[Work${tag} · ${fromName} answered your question · DeepSeek Harness restarted before it could reach you · continue and reply when done]`
    if (resent && role !== 'room') return `[Work${tag} from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Work${tag} completed by ${fromName} · closed${goesOn}; reply [PASS] if nothing needs to be told to the user]`
    if (role === 'ask_back') return `[Work${tag} · ${fromName} asks before continuing${goesOn} · call answer_work to unblock or cancel_work to stop]`
    if (role === 'answer') return `[Work${tag} · ${fromName} answered your question · continue and reply when done]`
    if (role === 'room') return `[Group chat "${roomName}" · ${label}]`
    if (role === 'report') return `[Group chat "${roomName}" · ${reportLabel}${goesOn}]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    if (role === 'update') return '[Your profile was updated — follow the latest version]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'task') return `[Background task · ${label}]`
    if (role === 'task-followup') return `[Follow-up from your own chat · ${label}]`
    if (role === 'task-report') return `[Background task report · ${label}${goesOn}]`
    if (audience === 'user') return `[Work from ${fromName} · the user sees your reply here]`
    return `[Work${tag} from ${fromName} · reply closes work; call ask_back if blocked]`
  }

  // Silent (zero-wake) messages buffered while a target Session is busy.
  // In real DSH (`dsh-agent-loop`), `agent.inject()` puts messages into `inbox.nextStep`,
  // which while `agent.status === 'running'` forces an extra step or starts a spurious
  // turn when checked at `turnEnds`. Buffering until idle (and prepending before step 1
  // via `agent/pre-step` if another turn starts first) guarantees true zero-wake AND
  // deterministic causal ordering ahead of queued delegations. Persisted in `inflight.json`
  // with no silent drop cap so notices survive restarts and bursts intact.
  /** @type {Map<string, {message:any, ledger?:{book:string, id:string, sessionId:string, failureRequestId?:string, work?:string}}[]>} */
  const pendingSilent = new Map()
  const flushingSilent = new Set()
  const isBusyAgent = (agent, sessionId) => agent?.status === 'running' || rt.live?.get(sessionId)?.turn !== undefined
  const syncSilent = (sessionId) => { rt.noteSilent?.(sessionId, pendingSilent.get(sessionId)) }
  const switchingOwnerOf = (sessionId) => (
    sessionId !== undefined && state.switching != null && Object.hasOwn(state.switching, sessionId)
      ? state.switching[sessionId]
      : undefined
  )
  const appendUniqueSilent = (targetList, entries, toSessionId) => {
    const seenIds = new Set(targetList.map(item => item?.message?.source?.exchangeId).filter(Boolean))
    const seenMsgIds = new Set(targetList.map(item => item?.message?.id).filter(Boolean))
    for (const entry of entries ?? []) {
      if (entry?.message === undefined) continue
      const exId = entry.message?.source?.exchangeId
      const msgId = entry.message?.id
      if ((exId !== undefined && seenIds.has(exId)) || (msgId !== undefined && seenMsgIds.has(msgId))) continue
      if (exId !== undefined) seenIds.add(exId)
      if (msgId !== undefined) seenMsgIds.add(msgId)
      targetList.push({
        message: entry.message,
        ...(entry.ledger !== undefined ? { ledger: { ...entry.ledger, sessionId: toSessionId } } : {}),
      })
    }
  }
  const waitIdleBriefly = (agent, timeoutMs = 2000) => {
    if (typeof agent?.whenIdle !== 'function') return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
      const timer = setTimeout(done, timeoutMs)
      timer?.unref?.()
      Promise.resolve(agent.whenIdle()).then(done, done)
    })
  }
  const markSilentDelivered = (entries, overrideSessionId) => {
    const writes = []
    for (const entry of entries ?? []) {
      const ledger = entry?.ledger
      if (ledger?.book === undefined) continue
      rt.ledger.append(ledger.book, {
        event: 'delivered',
        id: ledger.id,
        sessionId: overrideSessionId ?? ledger.sessionId,
        time: Date.now(),
        ...(typeof ledger.failureRequestId === 'string' && ledger.failureRequestId !== '' ? { failureRequestId: ledger.failureRequestId } : {}),
        ...(typeof ledger.work === 'string' && ledger.work !== '' ? { work: ledger.work } : {}),
      })
      writes.push(rt.ledger.written(ledger.book).catch(() => {}))
    }
    return writes.length > 0 ? Promise.all(writes) : Promise.resolve()
  }
  const bufferSilent = (sessionId, message, agent, ledger) => {
    const list = pendingSilent.get(sessionId) ?? []
    const exchangeId = message?.source?.exchangeId
    if (exchangeId !== undefined && list.some(item => item?.message?.source?.exchangeId === exchangeId)) return
    list.push({ message, ...(ledger !== undefined ? { ledger } : {}) })
    pendingSilent.set(sessionId, list)
    syncSilent(sessionId)
    if (typeof agent?.whenIdle === 'function') {
      void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
    }
  }
  const putBackSilentNotes = (sessionId, entries) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(entries) || entries.length === 0) return
    const existing = pendingSilent.get(sessionId) ?? []
    const existingIds = new Set(existing.map(item => item?.message?.source?.exchangeId).filter(Boolean))
    const restored = entries.filter(item => {
      if (item?.message === undefined) return false
      const exId = item.message?.source?.exchangeId
      return exId === undefined || !existingIds.has(exId)
    })
    if (restored.length === 0) return
    pendingSilent.set(sessionId, [...restored, ...existing])
    syncSilent(sessionId)
  }
  const pendingMessageIds = (agent) => new Set([
    ...(agent?.inbox?.nextStep ?? []),
    ...(agent?.inbox?.nextTurn ?? []),
  ].map(item => item?.id).filter(Boolean))
  const injectIfNotPending = (agent, message, pendingIds) => {
    if (message?.id !== undefined && pendingIds.has(message.id)) return false
    agent.inject(message)
    if (message?.id !== undefined) pendingIds.add(message.id)
    return true
  }
  async function flushSilentNotes(sessionId, { rethrow = false } = {}) {
    if (!pendingSilent.has(sessionId) || flushingSilent.has(sessionId)) return
    if (rt.live?.get(sessionId)?.turn !== undefined) return
    flushingSilent.add(sessionId)
    let queued
    try {
      const agent = await resolveAgent(sessionId).catch(() => undefined)
      if (agent === undefined) {
        if (rt.selfOf?.(sessionId) === undefined && switchingOwnerOf(sessionId) === undefined) {
          pendingSilent.delete(sessionId)
          syncSilent(sessionId)
        }
        return
      }
      if (isBusyAgent(agent, sessionId)) {
        if (typeof agent.whenIdle === 'function') {
          void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
        }
        return
      }
      queued = pendingSilent.get(sessionId)
      if (queued === undefined || queued.length === 0) return
      pendingSilent.delete(sessionId)
      const pendingIds = pendingMessageIds(agent)
      for (const entry of queued) injectIfNotPending(agent, entry.message, pendingIds)
      await ctx.sessions.flush(agent.session)
      syncSilent(sessionId)
      void markSilentDelivered(queued, sessionId)
      queued = undefined
    } catch (error) {
      if (queued !== undefined && queued.length > 0) putBackSilentNotes(sessionId, queued)
      if (rethrow) throw error
      rt.warn('ds-bot: flushing silent notes for %s failed: %s', sessionId, error)
    } finally {
      flushingSilent.delete(sessionId)
    }
  }
  const takeSilentEntries = (sessionId) => {
    const queued = pendingSilent.get(sessionId)
    if (queued === undefined) return []
    pendingSilent.delete(sessionId)
    syncSilent(sessionId)
    return queued
  }
  const takeSilentNotes = (sessionId) => takeSilentEntries(sessionId).map(entry => entry.message)
  const moveSilentNotes = (fromSessionId, toSessionId, { awaitFlush = false, rethrow = false } = {}) => {
    if (fromSessionId === undefined || toSessionId === undefined || fromSessionId === toSessionId) return Promise.resolve()
    const fromStartup = rt.peekStartupSilent?.(fromSessionId) ?? []
    const fromMemory = pendingSilent.get(fromSessionId) ?? []
    const entries = fromStartup.length > 0 ? [...fromStartup, ...fromMemory] : fromMemory
    const toStartup = rt.peekStartupSilent?.(toSessionId) ?? []
    if (entries.length > 0 || toStartup.length > 0) {
      const existingTarget = pendingSilent.get(toSessionId) ?? []
      const targetList = []
      appendUniqueSilent(targetList, toStartup, toSessionId)
      appendUniqueSilent(targetList, existingTarget, toSessionId)
      appendUniqueSilent(targetList, entries, toSessionId)
      // Persist destination before removing source so a crash mid-move never drops notes.
      if (targetList.length > 0) {
        pendingSilent.set(toSessionId, targetList)
        syncSilent(toSessionId)
      }
      if (toStartup.length > 0) rt.clearStartupSilent?.(toSessionId)
      if (pendingSilent.has(fromSessionId) || fromStartup.length > 0) {
        pendingSilent.delete(fromSessionId)
        rt.clearStartupSilent?.(fromSessionId)
        syncSilent(fromSessionId)
      }
    } else if (pendingSilent.has(fromSessionId)) {
      pendingSilent.delete(fromSessionId)
      syncSilent(fromSessionId)
    }
    if (!pendingSilent.has(toSessionId)) return Promise.resolve()
    if (awaitFlush) return flushSilentNotes(toSessionId, { rethrow })
    queueMicrotask(() => void flushSilentNotes(toSessionId))
    return Promise.resolve()
  }
  async function restoreSilentNotes(savedMap) {
    if (savedMap === null || typeof savedMap !== 'object') return
    const touched = new Set()
    for (const [oldSid, list] of Object.entries(savedMap)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const switching = switchingOwnerOf(oldSid)
      const botId = rt.selfOf?.(oldSid) ?? switching?.botId
      const bot = botId === undefined ? undefined : rt.botOf(botId)
      if (bot === undefined) continue
      const groupOwner = rt.groupOwners?.get(oldSid)
      const switchingRoom = switching?.roomId !== undefined ? rt.roomOf(switching.roomId) : undefined
      const destSid = groupOwner !== undefined
        ? (rt.roomOf(groupOwner.roomId)?.sessions?.[botId] ?? oldSid)
        : switchingRoom !== undefined
          ? (switchingRoom.sessions?.[botId] ?? oldSid)
          : (threadCurrentOfPart(bot, oldSid)
            ?? (switching?.next !== undefined && rt.chatOwners?.has(switching.next) ? switching.next : undefined)
            ?? (rt.isBotSession?.(oldSid) ? oldSid : rt.chatOf(botId)))
      if (destSid === undefined) continue
      const destList = pendingSilent.get(destSid) ?? []
      appendUniqueSilent(destList, list, destSid)
      if (destList.length > 0) {
        pendingSilent.set(destSid, destList)
        syncSilent(destSid)
        touched.add(destSid)
      }
      if (destSid !== oldSid) {
        pendingSilent.delete(oldSid)
        rt.clearStartupSilent?.(oldSid)
        syncSilent(oldSid)
      }
    }
    for (const sid of touched) await flushSilentNotes(sid)
  }
  const injectSilent = (sessionId, message, agent, ledger) => {
    if (isBusyAgent(agent, sessionId)) {
      bufferSilent(sessionId, message, agent, ledger)
      return false
    }
    injectIfNotPending(agent, message, pendingMessageIds(agent))
    return true
  }

  const isWakingPreStepMessage = (msg) => {
    const src = msg?.source
    if (src === undefined) return true
    return !isContextOnlySource(src)
  }

  // Deterministically prepend any buffered silent notices before step 1 of a real
  // waking turn so queued work (e.g. `delegate_work` after `note_bot`) never runs
  // ahead of them, while never waking an empty or snapshot-only wake boundary.
  ctx.on('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
    const raw = await next()
    if (raw?.kind === 'reject' || signal?.aborted || !Array.isArray(raw?.messages)) return raw
    const decision = addressedNotes.atStep(agent, step, raw)
    if (step !== 1 || !decision.messages.some(isWakingPreStepMessage) || (Array.isArray(messages) && !messages.some(isWakingPreStepMessage))) return decision
    if (!pendingSilent.has(agent.id)) return decision
    const entries = takeSilentEntries(agent.id)
    if (entries.length === 0) return decision
    const alreadyIds = new Set(decision.messages.map(m => m?.id).filter(Boolean))
    const alreadyExchanges = new Set(decision.messages.map(m => m?.source?.exchangeId).filter(Boolean))
    const toPrepend = entries
      .map(entry => entry.message)
      .filter(msg => (msg?.id === undefined || !alreadyIds.has(msg.id))
        && (msg?.source?.exchangeId === undefined || !alreadyExchanges.has(msg.source.exchangeId)))
    void markSilentDelivered(entries, agent.id)
    if (toPrepend.length === 0) return decision
    return {
      ...decision,
      messages: [...toPrepend, ...decision.messages],
    }
  })

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped', 'ask_back', 'answer', 'cancelled', 'note'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // Incremental per-pair index cache: advances only over newly appended records and
  // rebuilds in O(1) detection whenever `ledger.js` replaces the array reference
  // (rollback, prepend, drop, or read-only reload).
  const pairCache = new Map()
  function pairRecords(a, b) {
    const book = pairBook(a, b)
    const records = rt.ledger.records(book)
    let cache = pairCache.get(book)
    if (cache === undefined || cache.ref !== records || cache.count > records.length) {
      cache = {
        ref: records,
        peers: [String(a), String(b)],
        count: 0,
        written: new Map(),
        shown: new Map(),
        marks: [],
        replies: new Map(),
        failures: new Map(),
      }
      pairCache.set(book, cache)
    }
    const indexShown = (record) => {
      cache.shown.set(record.id, record)
      if (record.role === 'reply' && typeof record.replyTo === 'string' && record.replyTo !== '') {
        cache.replies.set(`${record.from}\u0000${record.to}\u0000${record.replyTo}`, record)
      }
    }
    for (let i = cache.count; i < records.length; i += 1) {
      const record = records[i]
      if (record.event === 'delivered') {
        const message = cache.written.get(record.id)
        if (message !== undefined) indexShown(message)
        cache.marks.push(record)
        if (typeof record.failureRequestId === 'string' && record.failureRequestId !== '') {
          let list = cache.failures.get(record.failureRequestId)
          if (list === undefined) { list = []; cache.failures.set(record.failureRequestId, list) }
          list.push(record)
        }
      } else if (record.event === undefined) {
        cache.written.set(record.id, record)
        if (record.delivered === true) indexShown(record)
      }
    }
    cache.count = records.length
    return cache
  }
  const pairMessages = (a, b) => [...pairRecords(a, b).shown.values()]

  function dropBotLedgers(botId) {
    if (typeof botId !== 'string' || botId === '') return
    const booksToDrop = new Set()
    for (const otherId of Object.keys(state.bots ?? {})) {
      if (otherId !== botId) booksToDrop.add(pairBook(botId, otherId))
    }
    for (const [book, cache] of pairCache.entries()) {
      if (cache.peers?.includes(botId)) booksToDrop.add(book)
    }
    for (const book of booksToDrop) {
      pairCache.delete(book)
      rt.ledger.drop(book)
    }
    if (Array.isArray(state.exchanges) && state.exchanges.length > 0) {
      state.exchanges = state.exchanges.filter(entry => entry?.from !== botId && entry?.to !== botId)
    }
  }

  // One-time transparent migration for teams saved before the pair ledger (#1316):
  // durably moves legacy `state.exchanges` entries into `bot/ledger/pair-*.jsonl`
  // without losing entries for books that already exist on disk, and keeps any pair's
  // entries fail-closed in `state.exchanges` if its ledger write fails.
  async function migrateLegacyExchanges() {
    if (rt.readOnly?.() !== undefined || !Array.isArray(state.exchanges) || state.exchanges.length === 0) return false
    const snapshot = state.exchanges.slice()
    const byBook = new Map()
    const migratedRefs = new Set()
    for (const entry of snapshot) {
      if (!entry || typeof entry !== 'object') {
        migratedRefs.add(entry)
        continue
      }
      const from = typeof entry.from === 'string' && entry.from !== '' ? entry.from : undefined
      const to = typeof entry.to === 'string' && entry.to !== '' ? entry.to : undefined
      if (from === undefined || to === undefined || rt.botOf(from) === undefined || rt.botOf(to) === undefined) {
        // Legacy records for deleted Bots or non-Bot senders cannot be opened as a pair chat.
        migratedRefs.add(entry)
        continue
      }
      const book = pairBook(from, to)
      let bucket = byBook.get(book)
      if (bucket === undefined) {
        bucket = []
        byBook.set(book, bucket)
      }
      bucket.push(entry)
    }
    for (const [book, entries] of byBook.entries()) {
      const ok = await rt.ledger.mergeRecords(book, entries.map(entry => ({ ...entry, delivered: true })))
      if (ok) {
        for (const entry of entries) migratedRefs.add(entry)
      }
    }
    if (migratedRefs.size === 0) return false
    const before = state.exchanges.length
    state.exchanges = state.exchanges.filter(entry => !migratedRefs.has(entry))
    return state.exchanges.length !== before
  }

  function deliveredReplyOf(fromId, toId, replyTo) {
    if (typeof fromId !== 'string' || fromId === '' || typeof replyTo !== 'string' || replyTo === '') return undefined
    if (typeof toId === 'string' && toId !== '') {
      if (rt.botOf(fromId) !== undefined && rt.botOf(toId) !== undefined) {
        const found = pairRecords(fromId, toId).replies.get(`${fromId}\u0000${toId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
      return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.to === toId && entry.role === 'reply' && entry.replyTo === replyTo)
    }
    if (rt.botOf(fromId) !== undefined) {
      for (const otherId of Object.keys(state.bots ?? {})) {
        if (otherId === fromId) continue
        const found = pairRecords(fromId, otherId).replies.get(`${fromId}\u0000${otherId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
    }
    return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.role === 'reply' && entry.replyTo === replyTo)
  }

  const wasReplyDelivered = (fromId, toId, replyTo) => deliveredReplyOf(fromId, toId, replyTo) !== undefined

  function deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork) {
    if (typeof fromId !== 'string' || typeof toId !== 'string' || typeof requestId !== 'string' || requestId === '') return []
    if (rt.botOf(fromId) === undefined || rt.botOf(toId) === undefined) return []
    const wantedWork = typeof parentWork === 'string' && parentWork !== '' ? parentWork : undefined
    const { written, failures } = pairRecords(fromId, toId)
    const marks = failures.get(requestId)
    if (marks === undefined) return []
    const matches = []
    for (const mark of marks) {
      const markWork = typeof mark.work === 'string' && mark.work !== '' ? mark.work : undefined
      if (markWork !== wantedWork) continue
      const message = written.get(mark.id)
      if (message?.from === fromId && message?.to === toId && sameConversation(state, toId, mark.sessionId, targetSessionId)) {
        matches.push({ id: mark.id, replyTo: message.replyTo, work: markWork, sessionId: mark.sessionId })
      }
    }
    return matches
  }

  const wasFailureRequestDelivered = (fromId, toId, requestId, targetSessionId, parentWork) =>
    deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork).length > 0

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js); their exchange is recorded already too. `resent` is
  // a message a shutdown cancelled; its first send may not have been recorded.
  // `askedBy` is the member whose @mention called a group turn (groups.js).
  // `fromRoomId`: the group whose Session the sender wrote from; the reply goes back
  // to that Session (turns.js). `images` and `files` go along as image and file blocks,
  // which DSH projects for the recipient's model and tools. `length`: the whole message's
  // length when it went as a file (attachLong). `work`: the work (handoffs.js) a
  // result that came back goes on with. `merged`: a request that takes in an earlier
  // one its recipient had not read, under that one's exchange. `fromPart`: the Session
  // of the sending Bot, which a reply comes back to when that is a background part.
  async function deliver({ fromId, fromName: senderName, pairFrom, toId, sessionId, address, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), transferId, steer = false, wake = true, afterCancel = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, abandoned = false, abandonedReason, recordExchange = true, askedBy, resultRef, follows, batchKey, resumedUpstream = false, fromRoomId, fromPart, images = [], files = [], length, work, workRef, askWork, taskId, imOrigin, failureRequestId }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw Object.assign(new Error(`Unknown Bot ${toId}`), { delivered: false })
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    const resolvedWorkRef = workRef ?? rt.workRefOf?.(role === 'reply' ? replyTo : askWork ?? work ?? exchangeId)
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      ...(transferId ? { transferId } : {}),
      senderName: fromName,
      ...(wake === false ? { silent: true } : {}),
      ...(work ? { work } : {}),
      ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}),
      ...(askWork ? { askWork } : {}),
      ...(taskId ? { taskId } : {}),
      ...(imOrigin ? { imOrigin } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(fromPart ? { senderPart: fromPart } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(resultRef ? { resultRef } : {}),
      ...(follows ? { follows } : {}),
      ...(batchKey ? { batchKey } : {}),
      ...(resumedUpstream ? { resumedUpstream: true } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(abandoned ? { abandoned: true } : {}),
    }
    let targetSessionId = sessionId ?? rt.chatOf(toId)
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text.
    const bookPeer = fromId !== undefined && from !== undefined
      ? fromId
      : (pairFrom !== undefined && rt.botOf(pairFrom) !== undefined ? pairFrom : undefined)
    const book = bookPeer !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(bookPeer, toId) : undefined
    let enqueued = false
    let deliveredNow = true
    const ledgerMeta = book !== undefined
      ? {
          book,
          id: exchangeId,
          sessionId: targetSessionId,
          ...(typeof failureRequestId === 'string' && failureRequestId !== '' ? { failureRequestId } : {}),
          ...(typeof work === 'string' && work !== '' ? { work } : {}),
        }
      : undefined
    try {
      if (book !== undefined && (merged || !pairRecords(bookPeer, toId).written.has(exchangeId))) {
        rt.ledger.append(book, { id: exchangeId, from: fromId ?? 'user', to: toId, role, text, time: Date.now(), ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}), ...(follows ? { follows } : {}), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
        await rt.ledger.written(book)
      }
      await rt.ensureCapabilities(targetSessionId)
      let agent = await resolveAgent(targetSessionId)
      if (address && addressedSession(rt, toId, address) !== targetSessionId) {
        const currentTarget = addressedSession(rt, toId, address)
        const fallbackTarget = currentTarget ?? ((role === 'reply' || role === 'report') ? rt.chatOf(toId) : undefined)
        if (fallbackTarget === undefined) {
          throw Object.assign(new Error('The delivery recipient changed during admission'), { code: 'bot/unresolved-return', delivered: false })
        }
        targetSessionId = fallbackTarget
        if (ledgerMeta !== undefined) ledgerMeta.sessionId = targetSessionId
        await rt.ensureCapabilities(targetSessionId)
        agent = await resolveAgent(targetSessionId)
      }
      // A non-waking note/cancel injects model-facing context ONLY while the target is idle
      // (buffering until idle if the target is currently running, so DSH never runs an extra
      // model step or starts a spurious turn). A steered message cuts into a running turn at
      // its next step; a follow-up queues.
      const message = createUserMessage({
        content: [
          { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, abandonedReason, asker, workRef: resolvedWorkRef })}\n${text}` },
          ...images.map(attachment => ({ type: 'image', attachment })),
          ...files.map(attachment => ({ type: 'file', attachment })),
        ],
        source,
      })
      if (wake === false) {
        if (afterCancel && isBusyAgent(agent, targetSessionId)) await waitIdleBriefly(agent)
        const injected = injectSilent(targetSessionId, message, agent, ledgerMeta)
        enqueued = true
        if (injected) {
          await ctx.sessions.flush(agent.session)
        } else {
          // Buffered until idle / next pre-step: pair-ledger 'delivered' is written once flushed.
          deliveredNow = false
        }
      } else {
        const takenSilent = !isBusyAgent(agent, targetSessionId) && pendingSilent.has(targetSessionId)
          ? takeSilentEntries(targetSessionId)
          : []
        let woke = false
        try {
          const pendingIds = pendingMessageIds(agent)
          for (const entry of takenSilent) injectIfNotPending(agent, entry.message, pendingIds)
          // A new assignment never cuts into another assignment's actively running turn.
          if (steer && !(role === 'request' && isBusyAgent(agent, targetSessionId))) agent.steer(message)
          else agent.followup(message)
          woke = true
          enqueued = true
          await ctx.sessions.flush(agent.session)
        } catch (error) {
          // Restore silent notes only if the waking call itself never ran; once steer/followup
          // woke the turn, already-injected notes sit in the agent's inbox for that turn and
          // must not be re-buffered (which would duplicate them or collide on message.id).
          if (!woke && takenSilent.length > 0) {
            putBackSilentNotes(targetSessionId, takenSilent)
          }
          throw error
        }
        if (takenSilent.length > 0) void markSilentDelivered(takenSilent, targetSessionId)
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.delivered === undefined) {
        error.delivered = enqueued
      }
      throw error
    }
    if (deliveredNow && ledgerMeta !== undefined) {
      await markSilentDelivered([{ ledger: ledgerMeta }])
    }
    return exchangeId
  }

  // A message between Bots, whole, from the Session it was delivered to: the message
  // there is its header line, then the text. `whole` is false when only the start could
  // be read (the Session is gone, or the message is past what the dialog shows).
  async function exchangeText(entry) {
    // A message of the ledger is whole there, or in its file when it went as one.
    if (entry.ledger === true && entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: headOf(entry.text, TEXT_SHOW_MAX), whole: false }
    if (entry.ledger === true) return { text: headOf(entry.text, TEXT_SHOW_MAX), whole: entry.text.length <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text, whole: true }
    if (entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: entry.text, whole: false }
    try {
      for await (const event of rt.eventsBackwards(entry.sessionId ?? rt.chatOf(entry.to), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      rt.warn('ds-bot: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text, whole: false }
  }

  // A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
  // not in every Session it reaches, and the model reads it with its file tools when it
  // needs it. Undefined when this DSH cannot store files.
  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      // The file stays verbatim, so a line past what the read tool shows needs another way.
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

  // The text of a stored file, limited to what the dialogs show by default.
  async function fileText(file, maxLength = TEXT_SHOW_MAX) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > maxLength) return { text: headOf(text, maxLength), whole: false }
      }
    } catch (error) {
      rt.warn('ds-bot: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }

  const exchangesOf = (a, b) => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return { ...rest, text: kept, ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text.length } : {}) }
  })
  const formatExchangeRecord = (record) => {
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }
  const exchangeOf = (id, a, b) => formatExchangeRecord(pairRecords(a, b).shown.get(id))
  const exchangeById = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    for (const cache of pairCache.values()) {
      if (!Array.isArray(cache.peers) || cache.peers.length < 2) continue
      const hit = pairRecords(cache.peers[0], cache.peers[1]).shown.get(id)
      if (hit !== undefined) return formatExchangeRecord(hit)
    }
    const botIds = Object.keys(state.bots ?? {})
    for (let i = 0; i < botIds.length; i += 1) {
      for (let j = i + 1; j < botIds.length; j += 1) {
        const book = pairBook(botIds[i], botIds[j])
        if (pairCache.has(book)) continue
        if (typeof rt.ledger.hasBook === 'function' && !rt.ledger.hasBook(book)) continue
        const hit = pairRecords(botIds[i], botIds[j]).shown.get(id)
        if (hit !== undefined) return formatExchangeRecord(hit)
      }
    }
    return (state.exchanges ?? []).find(item => item?.id === id)
  }

  Object.assign(rt, {
    resolveAgent, deliver, flushSilentNotes, takeSilentNotes, takeSilentEntries, putBackSilentNotes,
    markSilentDelivered, moveSilentNotes, restoreSilentNotes, injectSilent, dropBotLedgers,
    migrateLegacyExchanges, exchangeText, attachLong, fileText, exchangesOf, exchangeOf, exchangeById,
    deliveredReplyOf, wasReplyDelivered, deliveredFailuresOf, wasFailureRequestDelivered,
  })
}
