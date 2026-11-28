// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session,
// plus the pair exchange ledger (`pair-*.jsonl`) and long-message file attachment helpers.
//
// Zero-wake silent notices (`wake: false`) are routed exclusively through `rt.dispatchNote`
// (DSH D1 `appendNote` or SQLite `inbox(kind='note')` on 0.2.2-rc.5 fallback) — never via
// in-memory `pendingSilent` buffers or `agent.inject()` while busy.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { headOf, textOf } from './text.js'
import { sameConversation } from './threads.js'

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId) => {
    if (ctx.fiber?.uid === null || ctx.sessionController === undefined) {
      throw Object.assign(new Error('Plugin context is inactive'), { code: 'plugin/disposed' })
    }
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools?.(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note, deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, abandonedReason, asker, workRef } = {}) => {
    const label = note ?? 'new message'
    const reportLabel = note ?? 'replies to your post'
    const tag = workRef ? ` #${workRef}` : ''
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    if (role === 'cancelled') return `[Work${tag} cancelled by ${fromName} · no reply needed]`
    if (role === 'note') return `[Note from ${fromName} · FYI only, no reply needed]`
    if (role === 'stopped') return `[Stopped by ${fromName} · no reply needed]`
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
    if (role === 'update') return '[Your profile was updated — follow the latest version]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'task') return `[Background task · ${label}]`
    if (role === 'task-followup') return `[Follow-up from your own chat · ${label}]`
    if (role === 'task-report') return `[Background task report · ${label}${goesOn}]`
    if (audience === 'user') return `[Work from ${fromName} · the user sees your reply here]`
    return `[Work${tag} from ${fromName} · reply closes work; call ask_back if blocked]`
  }

  const markLedgerDelivered = (ledger, overrideSessionId) => {
    if (ledger?.book === undefined) return Promise.resolve()
    rt.ledger.append(ledger.book, {
      event: 'delivered',
      id: ledger.id,
      sessionId: overrideSessionId ?? ledger.sessionId,
      time: Date.now(),
      ...(typeof ledger.failureRequestId === 'string' && ledger.failureRequestId !== '' ? { failureRequestId: ledger.failureRequestId } : {}),
      ...(typeof ledger.work === 'string' && ledger.work !== '' ? { work: ledger.work } : {}),
    })
    return rt.ledger.written(ledger.book).catch(() => {})
  }

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped', 'ask_back', 'answer', 'cancelled', 'note'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))

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

  function deliveredReplyOf(fromId, toId, replyTo, { allowMissingPeer = false } = {}) {
    if (typeof fromId !== 'string' || fromId === '' || typeof replyTo !== 'string' || replyTo === '') return undefined
    if (typeof toId === 'string' && toId !== '') {
      if (allowMissingPeer || (rt.botOf(fromId) !== undefined && rt.botOf(toId) !== undefined)) {
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

  async function deliver({
    fromId,
    fromName: senderName,
    pairFrom,
    toId,
    sessionId,
    logicalAddress,
    text,
    role,
    replyTo,
    roomId,
    audience,
    note,
    exchangeId = randomUUID(),
    transferId,
    idempotencyKey,
    steer = false,
    wake = true,
    deferred = false,
    resumed = false,
    retried = false,
    resent = false,
    merged = false,
    abandoned = false,
    abandonedReason,
    recordExchange = true,
    askedBy,
    resultRef,
    follows,
    batchKey,
    resumedUpstream = false,
    fromRoomId,
    fromPart,
    images = [],
    files = [],
    length,
    work,
    workRef,
    askWork,
    taskId,
    imOrigin,
    failureRequestId,
    coordWorkId,
    coordThroughSeq,
    coordExactSeq,
  }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw Object.assign(new Error(`Unknown Bot ${toId}`), { delivered: false })
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(rt.resolveWork?.(work)?.work?.from ?? state.works?.[work]?.from)?.name
    const resolvedWorkRef = workRef ?? rt.workRefOf?.(role === 'reply' ? replyTo : askWork ?? work ?? exchangeId)
    const idemKey = idempotencyKey ?? exchangeId
    const resolvedTransferId = transferId ?? (wake === false ? undefined : randomUUID())
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      ...(resolvedTransferId ? { transferId: resolvedTransferId } : {}),
      idempotencyKey: idemKey,
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
      ...(coordWorkId ? { coordWorkId } : {}),
      ...(Number.isInteger(coordThroughSeq) ? { coordThroughSeq } : {}),
      ...(Number.isInteger(coordExactSeq) ? { coordExactSeq } : {}),
    }
    const targetSessionId = sessionId ?? (logicalAddress ? rt.resolveLogicalSession?.(logicalAddress) : undefined) ?? rt.chatOf(toId)
    const bookPeer = fromId !== undefined && from !== undefined
      ? fromId
      : (pairFrom !== undefined && rt.botOf(pairFrom) !== undefined ? pairFrom : undefined)
    const book = bookPeer !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(bookPeer, toId) : undefined
    const ledgerMeta = book !== undefined
      ? {
          book,
          id: exchangeId,
          sessionId: targetSessionId,
          ...(typeof failureRequestId === 'string' && failureRequestId !== '' ? { failureRequestId } : {}),
          ...(typeof work === 'string' && work !== '' ? { work } : {}),
        }
      : undefined
    const renderedText = `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, abandonedReason, asker, workRef: resolvedWorkRef })}\n${text}`
    const message = createUserMessage({
      content: [
        { type: 'text', text: renderedText },
        ...images.map(attachment => ({ type: 'image', attachment })),
        ...files.map(attachment => ({ type: 'file', attachment })),
      ],
      source,
    })

    let enqueued = false
    try {
      if (book !== undefined && (merged || !pairRecords(bookPeer, toId).written.has(exchangeId))) {
        rt.ledger.append(book, {
          id: exchangeId,
          from: fromId ?? 'user',
          to: toId,
          role,
          text,
          time: Date.now(),
          ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}),
          ...(follows ? { follows } : {}),
          ...(length !== undefined ? { length, files } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(audience === 'user' ? { audience } : {}),
          ...(roomId ? { roomId } : {}),
        })
        await rt.ledger.written(book)
      }

      if (wake === false) {
        if (typeof rt.dispatchNote === 'function') {
          await rt.dispatchNote(logicalAddress ?? targetSessionId, message, {
            idempotencyKey: idemKey,
            dedupKey: idemKey,
            sessionId: targetSessionId,
            senderBotId: fromId,
            bodyPreview: renderedText.slice(0, 400),
            payload: { renderedText, role, exchangeId },
          })
          enqueued = true
        } else {
          await rt.ensureCapabilities?.(targetSessionId)
          const agent = await resolveAgent(targetSessionId)
          if (typeof agent.appendNote === 'function') {
            agent.appendNote(message, { idempotencyKey: idemKey })
            await ctx.sessions.flush(agent.session)
            enqueued = true
          }
        }
      } else {
        await rt.ensureCapabilities?.(targetSessionId)
        const agent = await resolveAgent(targetSessionId)
        if (steer) agent.steer(message, { idempotencyKey: idemKey })
        else agent.followup(message, { idempotencyKey: idemKey })
        enqueued = true
        rt.notePendingDelivery?.(targetSessionId, { exchangeId, transferId: resolvedTransferId, role, work, replyTo, ...(taskId ? { taskId } : {}) })
        await ctx.sessions.flush(agent.session)
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.delivered === undefined) {
        error.delivered = enqueued
      }
      throw error
    }

    if (ledgerMeta !== undefined) {
      await markLedgerDelivered(ledgerMeta, targetSessionId)
    }
    return exchangeId
  }

  async function exchangeText(entry) {
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

  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

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
    resolveAgent,
    deliver,
    dropBotLedgers,
    migrateLegacyExchanges,
    exchangeText,
    attachLong,
    fileText,
    exchangesOf,
    exchangeOf,
    exchangeById,
    deliveredReplyOf,
    wasReplyDelivered,
    deliveredFailuresOf,
    wasFailureRequestDelivered,
  })
}
