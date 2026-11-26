// A Session's log for a window that draws the conversation itself (the desktop app's own
// interface): DSH's `follow` and `page`, passed on through ds-bot's own channel so the
// window never calls DSH's services. The frames are DSH's as they are: an opening
// snapshot with its cursor, then every committed event in order, and the reply being
// written (`assistant-stream`). A window that reconnects names the last committed seq it
// holds as `after`; when the opening no longer reaches back to it, the missing durable
// events are paged in first, then the opening and live frames follow in order. An earlier
// page is `session-page` with `beforeSeq`.
// DSH tells a follow about events committed in its own process. A window that only reads the
// team (another dsh holds it) gets the opening and no later events; it opens again when the
// live feed says the team changed.
//   GET  api/bot/session?id=<Session>[&parent=<Session>&mode=<mode>][&max=<messages>][&after=<seq>]
//        Server-Sent Events: `frame` (one follow frame), `error` ({ code, message }), `end`
//   POST api/bot `session-page` { sessionId, parent?, mode?, beforeSeq?, throughSeq?, maxMessages? }
// Reading never wakes a Session: the follow is passive.
import { errorCode } from './channel.js'
import { ROUTE } from './constants.js'

export const SESSION_ROUTE = `${ROUTE}/session`
const KEEPALIVE_MS = 20_000
// A window that stops reading is let go once this many frames wait for it; it opens again.
const MAX_QUEUED = 512
const SUBAGENT_MODES = new Set(['one-shot', 'continuable', 'unknown'])
const SESSION_ID = /^[\w-]{1,128}$/

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const missing = message => Object.assign(new Error(message), { code: 'bot/not-found' })
// A number field: absent, or a whole number from `min` (DSH takes -1 as an empty cut).
const whole = (value, name, min = 0) => {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < min) throw invalid(`${name} must be a whole number from ${min}`)
  return number
}

/**
 * The DSH address a request names: a Session, or a subagent Session under its parent.
 * @param {{ sessionId?: unknown, parent?: unknown, mode?: unknown }} request
 */
export function addressOf({ sessionId, parent, mode }) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (!SESSION_ID.test(id)) throw invalid('A Session id is needed')
  if (parent === undefined || parent === null || parent === '') return { kind: 'session', sessionId: id }
  if (typeof parent !== 'string' || !SESSION_ID.test(parent)) throw invalid('The parent Session id is not one')
  if (mode !== undefined && mode !== null && mode !== '' && !SUBAGENT_MODES.has(mode)) throw invalid(`A subagent mode is one of ${[...SUBAGENT_MODES].join(', ')}`)
  return { kind: 'subagent', parentSessionId: parent, childSessionId: id, mode: SUBAGENT_MODES.has(mode) ? mode : 'unknown' }
}

// DSH's refusals as the window hears them: a Session or subagent that is not there is
// not-found (the window stops asking); an address DSH turns away (a subagent's Session read
// without its parent, or under another one) is refused; anything else as every endpoint.
const GONE = new Set(['session/not-found', 'subagent/not-found'])
const TURNED_AWAY = new Set(['session/agent-busy', 'subagent/unauthorized'])
export function windowError(error) {
  const message = error?.message ?? String(error)
  if (GONE.has(error?.code) || /^session ".*" not found$/.test(message)) return Object.assign(new Error(message), { code: 'bot/not-found' })
  if (TURNED_AWAY.has(error?.code)) return Object.assign(new Error(message), { code: 'bot/refused' })
  return error
}

export function install(rt) {
  const { ctx } = rt
  const encoder = new TextEncoder()
  const controller = () => ctx.sessionController
  /** @type {Set<() => void>} */
  const open = new Set()

  const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })

  // A reconnect names the last committed seq the window holds. DSH's follow always opens
  // at the current end, so a gap wider than its opening is filled from cold-safe pages
  // before the opening and any live frames reach the window.
  const gapBefore = async (address, after, opening, maxMessages, signal) => {
    const boundary = opening.records[0]?.event?.seq ?? opening.cursor + 1
    if (!Number.isSafeInteger(boundary) || after >= boundary - 1) return []
    const pages = []
    let beforeSeq = boundary
    for (;;) {
      const request = {
        address,
        beforeSeq,
        throughSeq: opening.cursor,
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }
      const page = await controller().events(request, signal).catch((error) => { throw windowError(error) })
      const events = (page.records ?? []).map(record => record.event).filter(event => Number.isSafeInteger(event?.seq))
      if (events.length === 0) {
        if (page.hasMore) throw stale('Session history could not be paged to the reconnect position')
        break
      }
      pages.unshift(events)
      const oldest = events[0].seq
      // Paging must move strictly backwards; a page that repeats its own cut would loop forever.
      if (oldest >= beforeSeq) throw stale('Session history could not be paged to the reconnect position')
      if (oldest <= after + 1) {
        return pages.flat()
          .filter(event => event.seq > after && event.seq < boundary)
          .map(event => ({ type: 'event', event }))
      }
      if (!page.hasMore) break
      beforeSeq = oldest
    }
    throw stale('Session history no longer reaches the reconnect position')
  }

  async function* resumedFollow(request, after, signal) {
    const stream = controller().follow(request, signal)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done) return
      const opening = first.value
      if (opening?.type === 'snapshot' && after !== undefined) {
        for (const frame of await gapBefore(request.address, after, opening, request.maxMessages, signal)) yield frame
      }
      yield opening
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      await iterator.return?.()
    }
  }

  rt.sessionEndpoint = async (name, body, signal) => {
    if (name !== 'page') throw missing(`Unknown endpoint session-${name}`)
    const request = {
      address: addressOf(body),
      ...(whole(body.beforeSeq, 'beforeSeq') === undefined ? {} : { beforeSeq: whole(body.beforeSeq, 'beforeSeq') }),
      ...(whole(body.throughSeq, 'throughSeq', -1) === undefined ? {} : { throughSeq: whole(body.throughSeq, 'throughSeq', -1) }),
      ...(whole(body.maxMessages, 'maxMessages', 1) === undefined ? {} : { maxMessages: whole(body.maxMessages, 'maxMessages', 1) }),
    }
    // `events` is DSH's name for the page read (`page` stays for its own web client).
    return controller().events(request, signal ?? AbortSignal.timeout(30_000)).catch((error) => { throw windowError(error) })
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      let follow
      try {
        const max = whole(query.get('max'), 'max', 1)
        const after = whole(query.get('after'), 'after', 0)
        follow = {
          request: { address: addressOf({ sessionId: query.get('id'), parent: query.get('parent'), mode: query.get('mode') }), assistantStream: true, ...(max === undefined ? {} : { maxMessages: max }) },
          after,
        }
      } catch (error) {
        return Response.json({ ok: false, error: { code: error.code ?? 'bot/invalid', message: error.message, details: {} } }, { status: 400 })
      }
      const stop = new AbortController()
      const ended = () => stop.abort()
      request.signal.addEventListener('abort', ended, { once: true })
      let keepalive
      const demandWaiters = new Set()
      const notifyDemand = () => {
        for (const resolve of demandWaiters) resolve()
        demandWaiters.clear()
      }
      stop.signal.addEventListener('abort', notifyDemand, { once: true })
      const body = new ReadableStream({
        start(stream) {
          const write = (event, data, { live = false, whenEmpty = false } = {}) => {
            const size = stream.desiredSize ?? 0
            // Catch-up is finite and paced by `pull`; live output is not, so only live
            // frames trip the runaway-queue guard.
            if (live && size < -MAX_QUEUED) {
              stop.abort()
              return false
            }
            if (whenEmpty && size <= 0) return false
            try {
              stream.enqueue(encoder.encode(data === undefined ? event : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
              return true
            } catch {
              stop.abort()
              return false
            }
          }
          const waitForDemand = async () => {
            while (!stop.signal.aborted && (stream.desiredSize ?? 0) <= 0) {
              await new Promise(resolve => demandWaiters.add(resolve))
            }
          }
          const pump = async () => {
            keepalive = setInterval(() => write(': keepalive\n\n', undefined, { whenEmpty: true }), KEEPALIVE_MS)
            keepalive.unref?.()
            open.add(ended)
            let live = false
            try {
              for await (const frame of resumedFollow(follow.request, follow.after, stop.signal)) {
                if (stop.signal.aborted) break
                if (!live) await waitForDemand()
                if (stop.signal.aborted || !write('frame', frame, { live })) break
                if (frame?.type === 'snapshot') live = true
              }
              if (!stop.signal.aborted) write('end', {})
            } catch (error) {
              if (!stop.signal.aborted) {
                const mapped = windowError(error)
                const code = errorCode(mapped)
                if (code === 'bot/internal') rt.noteFailure?.({ source: 'api', text: `session follow: ${mapped.message}`, code: error?.code ?? error?.name, stack: error?.stack })
                write('error', { code, message: mapped.message })
              }
            } finally {
              clearInterval(keepalive)
              open.delete(ended)
              request.signal.removeEventListener('abort', ended)
              try { stream.close() } catch { /* the window left */ }
            }
          }
          void pump()
        },
        pull() { notifyDemand() },
        cancel() { stop.abort() },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: session follow route')

  ctx.effect(() => () => {
    for (const end of open) end()
  }, 'ds-bot: session follows')
}
