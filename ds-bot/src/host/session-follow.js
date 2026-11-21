// A Session's log for a window that draws the conversation itself (the desktop app's own
// interface): DSH's `follow` and `page`, passed on through ds-bot's own channel so the
// window never calls DSH's services. The frames are DSH's as they are: an opening
// snapshot with its cursor, then every committed event in order, and the reply being
// written (`assistant-stream`). A window that reconnects opens again and drops what it
// already holds by `seq`; an earlier page is `session-page` with `beforeSeq`.
//   GET  api/bot/session?id=<Session>[&parent=<Session>&mode=<mode>][&max=<messages>]
//        Server-Sent Events: `frame` (one follow frame), `error` ({ code, message }), `end`
//   POST api/bot `session-page` { sessionId, parent?, mode?, beforeSeq?, throughSeq?, maxMessages? }
// Reading never wakes a Session: the follow is passive.
import { ROUTE } from './constants.js'

export const SESSION_ROUTE = `${ROUTE}/session`
const KEEPALIVE_MS = 20_000
// A window that stops reading is let go once this many frames wait for it; it opens again.
const MAX_QUEUED = 512
const SUBAGENT_MODES = new Set(['one-shot', 'continuable', 'unknown'])
const SESSION_ID = /^[\w-]{1,128}$/

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const missing = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const whole = (value, name) => {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) throw invalid(`${name} must be a whole number`)
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
  return { kind: 'subagent', parentSessionId: parent, childSessionId: id, mode: SUBAGENT_MODES.has(mode) ? mode : 'unknown' }
}

// DSH names a Session it does not know (`session "…" not found`, or `session/not-found` over
// its Remote); the window hears not-found.
const known = (error) => {
  if (error?.code === 'session/not-found' || /^session ".*" not found$/.test(error?.message ?? '')) throw missing(error.message)
  throw error
}

export function install(rt) {
  const { ctx } = rt
  const encoder = new TextEncoder()
  const controller = () => ctx.sessionController
  /** @type {Set<() => void>} */
  const open = new Set()

  rt.sessionEndpoint = async (name, body, signal) => {
    if (name !== 'page') throw missing(`Unknown endpoint session-${name}`)
    const request = {
      address: addressOf(body),
      ...(whole(body.beforeSeq, 'beforeSeq') === undefined ? {} : { beforeSeq: whole(body.beforeSeq, 'beforeSeq') }),
      ...(whole(body.throughSeq, 'throughSeq') === undefined ? {} : { throughSeq: whole(body.throughSeq, 'throughSeq') }),
      ...(whole(body.maxMessages, 'maxMessages') === undefined ? {} : { maxMessages: whole(body.maxMessages, 'maxMessages') }),
    }
    return controller().page(request, signal ?? AbortSignal.timeout(30_000)).catch(known)
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      let follow
      try {
        const max = whole(query.get('max'), 'max')
        follow = { address: addressOf({ sessionId: query.get('id'), parent: query.get('parent'), mode: query.get('mode') }), assistantStream: true, ...(max === undefined ? {} : { maxMessages: max }) }
      } catch (error) {
        return Response.json({ ok: false, error: { code: error.code ?? 'bot/invalid', message: error.message, details: {} } }, { status: 400 })
      }
      const stop = new AbortController()
      const ended = () => stop.abort()
      request.signal.addEventListener('abort', ended, { once: true })
      let keepalive
      const body = new ReadableStream({
        async start(stream) {
          const write = (event, data) => {
            if ((stream.desiredSize ?? 0) < -MAX_QUEUED) {
              stop.abort()
              return
            }
            try { stream.enqueue(encoder.encode(data === undefined ? event : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { stop.abort() }
          }
          keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS)
          keepalive.unref?.()
          open.add(ended)
          try {
            for await (const frame of controller().follow(follow, stop.signal)) {
              if (stop.signal.aborted) break
              write('frame', frame)
            }
            if (!stop.signal.aborted) write('end', {})
          } catch (error) {
            if (!stop.signal.aborted) {
              let code = 'bot/internal'
              try { known(error) } catch (mapped) { code = mapped.code ?? code }
              write('error', { code, message: error?.message ?? String(error) })
            }
          } finally {
            clearInterval(keepalive)
            open.delete(ended)
            request.signal.removeEventListener('abort', ended)
            try { stream.close() } catch { /* the window left */ }
          }
        },
        cancel() { stop.abort() },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: session follow route')

  ctx.effect(() => () => {
    for (const end of open) end()
  }, 'ds-bot: session follows')
}
