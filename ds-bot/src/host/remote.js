// The client API as DSH Remote methods, for a client that reaches the host only through
// a carrier that forwards Remote methods and not Fetch routes, such as a relay
// (docs/plans/2026-10-24-mobile-api.md, "Remote methods").
//
//   dsBot/call {endpoint, payload}  one call of the api/bot channel; answers {ok, value | error}
//   dsBot/feed {}                   stream: the live feed's events as {event, data}, hello first
//
// A plain-JS plugin has no Typert generator, so the Gateway serves these methods from
// their `@Remote` markers (its source mode): simple parameter names, JSON values.
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { computerOnlyError, unclassifiedRemoteError } from '../shared/remote-endpoints.js'

export const RPC_NAMESPACE = 'dsBot'
const RPC_ENDPOINTS = Object.freeze({ call: `${RPC_NAMESPACE}/call`, feed: `${RPC_NAMESPACE}/feed` })
// A reader that falls this far behind is ended; it opens the stream again and catches up.
const MAX_QUEUED = 512
const STOP = Symbol('dsBot.remoteStop')

// `@Remote` applied by hand: the decorator records its marker when an instance is made.
function decorate(Class, name, decorator) {
  const initializers = []
  decorator(Class.prototype[name], {
    kind: 'method', name, static: false, private: false, metadata: {}, addInitializer: initializer => initializers.push(initializer),
  })
  return initializers
}

// Normalize a value into lossless JSON without serializing and re-parsing strings:
// strings and booleans pass through by value, while `undefined` object fields, `-0`,
// non-finite numbers, and `toJSON()` objects match `JSON.stringify` and Typert's check.
function toJson(input, key, seen) {
  let value = input
  if (value !== null && typeof value === 'object') {
    const toJSON = value.toJSON
    if (typeof toJSON === 'function') value = toJSON.call(value, key)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
  if (typeof value === 'bigint') throw new TypeError('BigInt is not JSON-safe')
  if (typeof value !== 'object') return undefined
  if (value instanceof String || value instanceof Boolean) return value.valueOf()
  if (value instanceof Number) {
    const n = value.valueOf()
    return Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : null
  }
  if (seen.has(value)) throw new TypeError('Circular JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = Array.from({ length: value.length })
      for (let i = 0; i < value.length; i += 1) {
        const item = toJson(value[i], String(i), seen)
        out[i] = item === undefined ? null : item
      }
      return out
    }
    const out = {}
    for (const k of Object.keys(value)) {
      const item = toJson(value[k], k, seen)
      if (item === undefined) continue
      if (k === '__proto__') Object.defineProperty(out, k, { value: item, enumerable: true, configurable: true, writable: true })
      else out[k] = item
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export function plain(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  const out = toJson(value, '', new Set())
  return out === undefined ? null : out
}

// The feed as an async iterable backed by a bounded ring buffer. It ends cleanly when
// `signal` or `stopSignal` aborts, or immediately drops queued backlog on overflow so the
// client reconnects and catches up from `hello` + `notices`.
export async function* feedEvents(subscribe, signal, stopSignal) {
  if (signal?.aborted === true || stopSignal?.aborted === true) return
  const queue = Array.from({ length: MAX_QUEUED })
  let head = 0
  let count = 0
  let wake
  let overflow = false
  let closed = false
  let unsubscribed = false
  let unsubscribe
  const close = () => {
    closed = true
    queue.fill(undefined)
    head = 0
    count = 0
    if (!unsubscribed && unsubscribe) {
      unsubscribed = true
      const fn = unsubscribe
      unsubscribe = undefined
      fn()
    }
  }
  const stopped = () => signal?.aborted === true || stopSignal?.aborted === true || overflow
  unsubscribe = subscribe((event, data) => {
    if (closed || stopped()) return
    if (count >= MAX_QUEUED) {
      overflow = true
      close()
    } else {
      queue[(head + count) % MAX_QUEUED] = { event, data: plain(data) }
      count += 1
    }
    wake?.()
  })
  if (closed || stopped()) close()
  const onStop = () => {
    close()
    wake?.()
  }
  signal?.addEventListener('abort', onStop, { once: true })
  stopSignal?.addEventListener('abort', onStop, { once: true })
  try {
    while (!stopped()) {
      if (count === 0) {
        await new Promise((resolve) => { wake = resolve })
        wake = undefined
        continue
      }
      const next = queue[head]
      queue[head] = undefined
      head = (head + 1) % MAX_QUEUED
      count -= 1
      yield next
    }
  } finally {
    signal?.removeEventListener('abort', onStop)
    stopSignal?.removeEventListener('abort', onStop)
    close()
  }
}

function stripRemoteLive(value) {
  if (!value || typeof value !== 'object') return value
  let next = value
  if (Object.hasOwn(next, 'userQuestions') || Object.hasOwn(next, 'sessionQueues')) {
    next = { ...next }
    delete next.userQuestions
    delete next.sessionQueues
  }
  if (next.phone && typeof next.phone === 'object' && Object.hasOwn(next.phone, 'pairing')) {
    const phone = { ...next.phone }
    delete phone.pairing
    next = { ...next, phone }
  }
  if (Array.isArray(next.work?.approvals) && next.work.approvals.some(entry => entry && Object.hasOwn(entry, 'alwaysAllow'))) {
    next = {
      ...next,
      work: {
        ...next.work,
        approvals: next.work.approvals.map(entry => (entry && Object.hasOwn(entry, 'alwaysAllow')
          ? (({ alwaysAllow: _, ...rest }) => rest)(entry)
          : entry)),
      },
    }
  }
  return next
}

export function createRemoteService(rt) {
  class DsBotRemote extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, RPC_NAMESPACE)
      for (const initializer of initializers) initializer.call(this)
      const stop = new AbortController()
      this[STOP] = stop.signal
      ctx.effect(() => () => stop.abort(), 'ds-bot: remote feed')
    }

    // Simple identifier parameters with no defaults match DSH Gateway source-mode parsing.
    // Computer-only actions (phone pairing, the native desktop folder dialog, Session logs) stay local.
    async call(endpoint, payload, signal) {
      const name = typeof endpoint === 'string' ? endpoint : ''
      const denied = computerOnlyError(name) ?? unclassifiedRemoteError(name)
      if (denied !== undefined) return { ok: false, error: denied }
      if (name === 'image' && payload?.parent !== undefined && payload?.parent !== null && String(payload.parent).trim() !== '') {
        return { ok: false, error: { code: 'bot/refused', message: 'Session logs are read on the computer', details: {} } }
      }
      if (name === 'approval-answer' && payload?.choice === 'always') {
        return { ok: false, error: { code: 'bot/refused', message: 'Always allow is available on the computer', details: {} } }
      }
      const answer = plain(await rt.channelCall(name, payload ?? {}, signal, true))
      if (name === 'state' && answer?.ok === true && answer.value && typeof answer.value === 'object') {
        return { ...answer, value: stripRemoteLive(answer.value) }
      }
      if (name === 'folders' && answer?.ok === true && answer.value && typeof answer.value === 'object' && Object.hasOwn(answer.value, 'data')) {
        const value = { ...answer.value }
        delete value.data
        return { ...answer, value }
      }
      return answer
    }

    feed(signal) {
      return feedEvents((listener) => rt.subscribeFeed((event, data) => {
        if (event === 'terminal' || event === 'terminal-exit' || event === 'jobs' || event === 'workspace-changed') return
        listener(event, event === 'live' ? stripRemoteLive(data) : data)
      }), signal, this[STOP])
    }
  }
  const initializers = [
    ...decorate(DsBotRemote, 'call', Remote),
    ...decorate(DsBotRemote, 'feed', Remote({ mode: 'stream' })),
  ]
  return DsBotRemote
}

// Mounted only where a Typert Gateway serves Remote methods (DSH Web and Desktop); a
// test context has none.
export function install(rt) {
  const { ctx } = rt
  let gateway
  rt.remoteRpc = () => (
    gateway?.claimsEndpoint?.(RPC_ENDPOINTS.call) && gateway?.claimsEndpoint?.(RPC_ENDPOINTS.feed)
      ? RPC_ENDPOINTS
      : undefined
  )
  if (typeof ctx.inject !== 'function') return
  // The fork is not returned: Cordis would await a returned fiber before the Service it starts.
  ctx.inject(['typertGateway'], (gatewayCtx) => {
    const current = gatewayCtx.typertGateway
    gatewayCtx.plugin(createRemoteService(rt))
    gatewayCtx.effect(() => {
      gateway = current
      return () => { if (gateway === current) gateway = undefined }
    }, 'ds-bot: remote readiness')
  })
}
