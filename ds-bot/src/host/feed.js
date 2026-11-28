// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
//   notice    something a client that is not looking should hear about (mobile.js)
//   room      a group chat changed: ask for `room-chat` again
// `hello` carries the team's revision and, for the mobile API, its version and the
// latest notice, so a client that reconnects knows what it missed.
import { randomUUID } from 'node:crypto'
import { ROUTE } from './constants.js'

export const FEED_ROUTE = `${ROUTE}/feed`
// Leave room for Desktop's 10-second update-lock request drain (no public DSH drain signal; see C25).
const MAX_LIFETIME_MS = 6_000
// Brief grace window after server-initiated MAX_LIFETIME_MS SSE rotation while the local window reconnects.
const LOCAL_ROTATE_GRACE_MS = 5_000
// Keep the bounded SSE replay ring warm across rotations and short local drops.
const REPLAY_LIMIT = 512
const REPLAY_MAX_BYTES = 4 * 1024 * 1024
const REPLAY_IDLE_MS = 30_000
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150
// A window that stops reading is dropped once this many events wait for it; it
// reconnects and catches up from `hello`.
const MAX_QUEUED = 512
// Evict stalled stream entries whose `end` frame was lost (e.g. abrupt provider disconnect).
const WRITING_TTL_MS = 5 * 60_000

function parseResumeCursor(request) {
  const url = new URL(request.url, 'http://localhost')
  const queryAfter = url.searchParams.get('after')
  const queryBoot = url.searchParams.get('boot')
  const headerId = request.headers.get('last-event-id')
  const raw = queryAfter !== null && queryAfter !== '' ? queryAfter : headerId
  if (raw === null || raw.trim() === '') return null
  const trimmed = raw.trim()
  let cursorBoot = queryBoot !== null && queryBoot !== '' ? queryBoot : null
  let seqText = trimmed
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon)
    const tail = trimmed.slice(colon + 1)
    if (/^\d+$/.test(tail)) {
      if (cursorBoot === null) cursorBoot = prefix
      else if (cursorBoot !== prefix) return { invalid: true }
      seqText = tail
    }
  }
  if (!/^\d+$/.test(seqText)) return { invalid: true }
  const after = Number(seqText)
  if (!Number.isSafeInteger(after) || after < 0) return { invalid: true }
  return { after, boot: cursorBoot }
}

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  const fallbackBoot = randomUUID()
  const bootId = () => rt.noticeCursor?.()?.boot ?? fallbackBoot
  let feedSeq = 0
  let droppedBeforeSeq = 0
  let historyBytes = 0
  /** @type {{ seq: number, chunk: Uint8Array, bytes: number }[]} */
  const history = []
  let lastLocalLeftAt = 0
  /** @type {Set<{ controller: ReadableStreamDefaultController<Uint8Array>, pending: { chunk: Uint8Array, live: boolean }[], liveQueued: number, closed: boolean }>} */
  const clients = new Set()
  const formatSse = (event, data, id) => encoder.encode(
    `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  )
  const formatFeedId = (boot, seq) => `${boot}:${seq}`
  const localReplayActive = () => clients.size > 0 || (lastLocalLeftAt > 0 && Date.now() - lastLocalLeftAt < REPLAY_IDLE_MS)
  const invalidateReplay = () => {
    feedSeq += 1
    history.length = 0
    historyBytes = 0
    droppedBeforeSeq = feedSeq
  }
  rt.invalidateFeedReplay = invalidateReplay
  const flush = (client) => {
    while (!client.closed && client.pending.length > 0 && (client.controller.desiredSize ?? 0) > 0) {
      const next = client.pending.shift()
      if (next.live) client.liveQueued -= 1
      try {
        client.controller.enqueue(next.chunk)
      } catch {
        leave(client)
        return false
      }
    }
    return !client.closed
  }
  const send = (client, chunk) => {
    if (client.closed) return false
    if (client.pending.length > 0) {
      if (client.liveQueued >= MAX_QUEUED) {
        leave(client)
        return false
      }
      client.pending.push({ chunk, live: true })
      client.liveQueued += 1
      return flush(client)
    }
    if ((client.controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(client)
      return false
    }
    try {
      client.controller.enqueue(chunk)
      return true
    } catch {
      leave(client)
      return false
    }
  }
  const publishLocal = (event, data) => {
    if (!localReplayActive()) {
      if (lastLocalLeftAt > 0) invalidateReplay()
      return
    }
    const seq = ++feedSeq
    const chunk = formatSse(event, data, formatFeedId(bootId(), seq))
    const bytes = chunk.byteLength
    if (bytes > REPLAY_MAX_BYTES) {
      history.length = 0
      historyBytes = 0
      droppedBeforeSeq = seq
    } else {
      history.push({ seq, chunk, bytes })
      historyBytes += bytes
      while (history.length > REPLAY_LIMIT || historyBytes > REPLAY_MAX_BYTES) {
        const evicted = history.shift()
        historyBytes -= evicted.bytes
        if (evicted.seq > droppedBeforeSeq) droppedBeforeSeq = evicted.seq
      }
    }
    for (const client of clients) send(client, chunk)
  }
  const publish = (event, data) => {
    for (const tap of taps) {
      try { tap(event, data) } catch { /* taps are isolated from the feed */ }
    }
    publishLocal(event, data)
  }

  // Attempts being streamed, by id. A turn that answers another Bot is hidden from the
  // chat (turns.js marks it before the model is called), so its text is not streamed.
  const writing = new Map()
  const pruneWriting = (now = Date.now()) => {
    for (const [id, entry] of writing) {
      if (rt.live?.get(entry.sessionId)?.turn !== undefined) continue
      if (now - entry.updatedAt > WRITING_TTL_MS) writing.delete(id)
    }
  }
  const clearWritingFor = (sessionId) => {
    if (sessionId === undefined) return
    for (const [id, entry] of writing) {
      if (entry.sessionId === sessionId) writing.delete(id)
    }
  }

  const feedHello = (extra = {}) => ({
    revision: state.revision,
    ...(rt.noticeCursor ? { api: rt.apiVersion, ...rt.noticeCursor() } : { boot: fallbackBoot }),
    ...extra,
  })
  const replay = (listener) => {
    pruneWriting()
    listener('hello', feedHello())
    for (const [attemptId, { text, updatedAt: _updatedAt, ...target }] of writing) {
      listener('stream', { ...target, attemptId, phase: 'start' })
      if (text !== '') listener('stream', { ...target, attemptId, text })
    }
  }

  // Non-SSE listeners (the phone link) get every event through a tap; a tap is
  // isolated so a slow or throwing listener never hurts SSE clients.
  const taps = new Set()
  rt.feedTap = (listener) => { taps.add(listener); return () => taps.delete(listener) }
  // Remote subscribers (such as `dsBot/feed`) open at `hello` and then track every live event.
  rt.subscribeFeed = (listener) => {
    const untap = rt.feedTap(listener)
    try { replay(listener) } catch { /* isolate subscriber errors */ }
    return untap
  }
  const listening = () => clients.size > 0 || taps.size > 0 || localReplayActive()
  const offSaved = rt.onSaved(() => {
    if (listening()) publish('revision', { revision: state.revision })
    else if (lastLocalLeftAt > 0) invalidateReplay()
  })
  const offAdopted = rt.onAdopted?.(() => {
    if (listening()) publish('revision', { revision: state.revision })
    else if (lastLocalLeftAt > 0) invalidateReplay()
  })
  rt.publishFeed = (event, data) => {
    if (listening()) publish(event, data)
    else if (lastLocalLeftAt > 0) invalidateReplay()
  }
  // Computer-local SSE only (never fans out to paired phones, browsers, or remote RPC taps).
  const localListeners = new Set()
  const notifyLocalClients = () => {
    for (const fn of localListeners) {
      try { fn(clients.size) } catch { /* isolated */ }
    }
  }
  rt.publishLocalFeed = (event, data) => {
    publishLocal(event, data)
  }
  rt.localFeedClientCount = () => clients.size
  rt.onLocalFeedClients = (listener) => {
    localListeners.add(listener)
    return () => localListeners.delete(listener)
  }

  let liveTimer
  const live = () => {
    if (!listening()) {
      if (lastLocalLeftAt > 0) invalidateReplay()
      return
    }
    if (liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  rt.notifyLive = live
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') clearWritingFor(agent?.id)
    if (rt.selfOf(agent.id) !== undefined || rt.agentOf?.(agent.id) !== undefined) live()
  })
  ctx.on?.('agent/disposed', ({ agent }) => {
    clearWritingFor(agent?.id)
  })

  ctx.on('session/event', (session, event) => {
    if (!listening()) {
      if (lastLocalLeftAt > 0) invalidateReplay()
      return
    }
    if (rt.taskOwners?.has(session.id)) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    const items = rt.displayItems(session.id, [event])
    for (let block = 0; block < items.length; block += 1) {
      const raw = items[block]
      const item = Number.isInteger(raw?.seq) && !Number.isInteger(raw.block) ? { ...raw, block } : raw
      publish('message', { botId, sessionId: session.id, item })
    }
    if (event.type === 'tool/call') live()
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      if (rt.taskOwners?.has(agent.id)) return
      const now = Date.now()
      pruneWriting(now)
      const botId = rt.chatOwners.get(agent.id)
      if (botId === undefined || (state.exchangeTurns[agent.id] ?? []).includes(frame.turn)) return
      writing.set(frame.attemptId, { botId, sessionId: agent.id, text: '', updatedAt: now })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const target = writing.get(frame.attemptId)
    if (target === undefined) return
    if (frame.type === 'chunk') {
      target.updatedAt = Date.now()
      if (frame.chunk?.type === 'text-delta') {
        target.text += frame.chunk.text
        publish('stream', { botId: target.botId, sessionId: target.sessionId, attemptId: frame.attemptId, text: frame.chunk.text })
      }
    }
    else if (frame.type === 'end') {
      writing.delete(frame.attemptId)
      publish('stream', { botId: target.botId, sessionId: target.sessionId, attemptId: frame.attemptId, phase: 'end' })
    }
  })

  // A Request built on a caller's signal only follows it while the Request is reachable;
  // once collected, its abort never fires and the feed stays open. Each open feed keeps
  // its Request until it leaves.
  const requests = new Map()
  const lifetimes = new Map()
  let rotateGraceUntil = 0
  let rotateGraceTimer
  let localConnected = false
  const localDisconnectListeners = new Set()
  const localConnectListeners = new Set()
  const notifyLocalConnected = () => {
    for (const listener of localConnectListeners) {
      try { listener() } catch { /* isolate listeners */ }
    }
    try { rt.onLocalFeedConnected?.() } catch { /* isolate listeners */ }
  }
  const notifyLocalDisconnected = () => {
    if (!localConnected) return
    localConnected = false
    for (const listener of localDisconnectListeners) {
      try { listener() } catch { /* isolate listeners */ }
    }
    try { rt.onLocalFeedLost?.() } catch { /* isolate listeners */ }
  }
  const hasLocalFeedClient = () => clients.size > 0 || (rotateGraceUntil > 0 && Date.now() < rotateGraceUntil)
  rt.hasLocalFeedClient = hasLocalFeedClient
  rt.onLocalFeedDisconnected = (listener) => {
    localDisconnectListeners.add(listener)
    return () => { localDisconnectListeners.delete(listener) }
  }
  rt.onLocalFeedReconnected = (listener) => {
    localConnectListeners.add(listener)
    return () => { localConnectListeners.delete(listener) }
  }
  const leave = (client, { rotated = false } = {}) => {
    if (!client) return
    client.closed = true
    client.pending.length = 0
    client.liveQueued = 0
    const had = clients.delete(client)
    clearTimeout(lifetimes.get(client))
    lifetimes.delete(client)
    const connection = requests.get(client)
    connection?.request.signal.removeEventListener('abort', connection.abort)
    requests.delete(client)
    try { client.controller.close() } catch { /* already closed or errored */ }
    if (had && clients.size === 0) {
      lastLocalLeftAt = Date.now()
      clearTimeout(rotateGraceTimer)
      if (rotated) {
        rotateGraceUntil = Date.now() + LOCAL_ROTATE_GRACE_MS
        rotateGraceTimer = setTimeout(() => {
          rotateGraceTimer = undefined
          if (clients.size === 0) {
            rotateGraceUntil = 0
            notifyLocalDisconnected()
          }
        }, LOCAL_ROTATE_GRACE_MS)
        rotateGraceTimer.unref?.()
      } else {
        rotateGraceUntil = 0
        notifyLocalDisconnected()
      }
    }
    if (had) notifyLocalClients()
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const alreadyAborted = request.signal.aborted
      const cursor = parseResumeCursor(request)
      const currentBoot = bootId()
      const replayWarm = clients.size > 0 || lastLocalLeftAt === 0 || Date.now() - lastLocalLeftAt < REPLAY_IDLE_MS
      const canResume = cursor !== null
        && cursor.invalid !== true
        && cursor.boot !== null
        && cursor.boot === currentBoot
        && replayWarm
        && cursor.after >= droppedBeforeSeq
        && cursor.after <= feedSeq
      let client = null
      const body = new ReadableStream({
        start(own) {
          client = { controller: own, pending: [], liveQueued: 0, closed: false }
          rotateGraceUntil = 0
          clearTimeout(rotateGraceTimer)
          rotateGraceTimer = undefined
          if (canResume) {
            client.pending.push({
              chunk: formatSse('hello', feedHello({ resumed: true, feedSeq: cursor.after }), formatFeedId(currentBoot, cursor.after)),
              live: false,
            })
            for (const entry of history) {
              if (entry.seq > cursor.after) client.pending.push({ chunk: entry.chunk, live: false })
            }
          } else {
            const baseSeq = feedSeq
            pruneWriting()
            client.pending.push({
              chunk: formatSse('hello', feedHello({ resumed: false, feedSeq: baseSeq }), formatFeedId(currentBoot, baseSeq)),
              live: false,
            })
            for (const [attemptId, { text, updatedAt: _updatedAt, ...target }] of writing) {
              client.pending.push({ chunk: formatSse('stream', { ...target, attemptId, phase: 'start' }), live: false })
              if (text !== '') client.pending.push({ chunk: formatSse('stream', { ...target, attemptId, text }), live: false })
            }
          }
          if (!flush(client)) return
          if (alreadyAborted) {
            leave(client, { rotated: false })
            return
          }
          clients.add(client)
          if (!localConnected) {
            localConnected = true
            notifyLocalConnected()
          }
          notifyLocalClients()
        },
        pull() {
          if (client) flush(client)
        },
        cancel() { leave(client, { rotated: false }) },
      })
      if (!alreadyAborted && client && !client.closed) {
        const abort = () => leave(client, { rotated: false })
        requests.set(client, { request, abort })
        lifetimes.set(client, setTimeout(() => {
          if (!client.closed && client.pending.length === 0) {
            try { client.controller.enqueue(encoder.encode(': rotate\n\n')) } catch { /* already closed or errored */ }
          }
          leave(client, { rotated: true })
        }, MAX_LIFETIME_MS))
        request.signal.addEventListener('abort', abort, { once: true })
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    return () => {
      clearTimeout(liveTimer)
      clearTimeout(rotateGraceTimer)
      rotateGraceTimer = undefined
      rotateGraceUntil = 0
      lastLocalLeftAt = 0
      history.length = 0
      historyBytes = 0
      localConnected = false
      offSaved()
      offAdopted?.()
      for (const client of clients) leave(client)
      localConnectListeners.clear()
      localDisconnectListeners.clear()
      localListeners.clear()
      taps.clear()
      writing.clear()
    }
  }, 'ds-bot: live feed')
}
