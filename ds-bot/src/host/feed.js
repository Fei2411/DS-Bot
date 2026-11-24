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
import { ROUTE } from './constants.js'

export const FEED_ROUTE = `${ROUTE}/feed`
// Leave room for Desktop's 10-second update-lock request drain.
const MAX_LIFETIME_MS = 6_000
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150
// A window that stops reading is dropped once this many events wait for it; it
// reconnects and catches up from `hello`.
const MAX_QUEUED = 512

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  /** @type {Set<ReadableStreamDefaultController<Uint8Array>>} */
  const clients = new Set()
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try { controller.enqueue(chunk) } catch { leave(controller) }
  }
  const publish = (event, data) => {
    for (const tap of taps) {
      try { tap(event, data) } catch { /* taps are isolated from the feed */ }
    }
    if (clients.size === 0) return
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients) send(controller, chunk)
  }

  const feedHello = () => ({ revision: state.revision, ...(rt.noticeCursor ? { api: rt.apiVersion, ...rt.noticeCursor() } : {}) })
  const replay = (listener) => {
    listener('hello', feedHello())
    for (const [attemptId, { text, ...target }] of writing) {
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
  const listening = () => clients.size > 0 || taps.size > 0
  const offSaved = rt.onSaved(() => {
    if (listening()) publish('revision', { revision: state.revision })
  })
  rt.publishFeed = (event, data) => {
    if (listening()) publish(event, data)
  }

  let liveTimer
  const live = () => {
    if (!listening() || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined || rt.agentOf?.(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if (!listening()) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    for (const item of rt.displayItems(session.id, [event])) publish('message', { botId, sessionId: session.id, item })
    if (event.type === 'tool/call') live()
  })

  // Attempts being streamed, by id. A turn that answers another Bot is hidden from the
  // chat (turns.js marks it before the model is called), so its text is not streamed.
  const writing = new Map()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (botId === undefined || (state.exchangeTurns[agent.id] ?? []).includes(frame.turn)) return
      writing.set(frame.attemptId, { botId, sessionId: agent.id, text: '' })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const target = writing.get(frame.attemptId)
    if (target === undefined) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
      target.text += frame.chunk.text
      publish('stream', { botId: target.botId, sessionId: target.sessionId, attemptId: frame.attemptId, text: frame.chunk.text })
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
  const leave = (controller) => {
    clients.delete(controller)
    clearTimeout(lifetimes.get(controller))
    lifetimes.delete(controller)
    const connection = requests.get(controller)
    connection?.request.signal.removeEventListener('abort', connection.abort)
    requests.delete(controller)
    try { controller.close() } catch { /* already closed or errored */ }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let controller
      const body = new ReadableStream({
        start(own) {
          controller = own
          clients.add(own)
          replay((event, data) => send(own, encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)))
        },
        cancel() { leave(controller) },
      })
      const abort = () => leave(controller)
      requests.set(controller, { request, abort })
      lifetimes.set(controller, setTimeout(abort, MAX_LIFETIME_MS))
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) leave(controller)
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    return () => {
      clearTimeout(liveTimer)
      offSaved()
      for (const controller of clients) leave(controller)
      writing.clear()
    }
  }, 'ds-bot: live feed')
}
