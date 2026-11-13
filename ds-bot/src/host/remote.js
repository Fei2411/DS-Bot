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

export const RPC_NAMESPACE = 'dsBot'
const RPC_ENDPOINTS = Object.freeze({ call: `${RPC_NAMESPACE}/call`, feed: `${RPC_NAMESPACE}/feed` })
// A reader that falls this far behind is ended; it opens the stream again and catches up.
const MAX_QUEUED = 512

// `@Remote` applied by hand: the decorator records its marker when an instance is made.
function decorate(Class, name, decorator) {
  const initializers = []
  decorator(Class.prototype[name], {
    kind: 'method', name, static: false, private: false, metadata: {}, addInitializer: initializer => initializers.push(initializer),
  })
  return initializers
}

// A JSON copy: the Gateway accepts only JSON values, and an answer may hold `undefined`.
const plain = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

// The feed as an async iterable backed by a bounded ring buffer that ends when `signal` aborts.
export async function* feedEvents(subscribe, signal) {
  if (signal?.aborted === true) return
  const queue = Array.from({ length: MAX_QUEUED })
  let head = 0
  let count = 0
  let wake
  let overflow = false
  const unsubscribe = subscribe((event, data) => {
    if (overflow || signal?.aborted === true) return
    if (count >= MAX_QUEUED) overflow = true
    else {
      queue[(head + count) % MAX_QUEUED] = { event, data: plain(data) }
      count += 1
    }
    wake?.()
  })
  const aborted = () => wake?.()
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    while (signal?.aborted !== true) {
      if (count === 0) {
        if (overflow) return
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
    signal?.removeEventListener('abort', aborted)
    unsubscribe()
  }
}

export function createRemoteService(rt) {
  class DsBotRemote extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, RPC_NAMESPACE)
      for (const initializer of initializers) initializer.call(this)
    }

    // Simple identifier parameters with no defaults match DSH Gateway source-mode parsing.
    async call(endpoint, payload, signal) {
      return plain(await rt.channelCall(String(endpoint ?? ''), payload ?? {}, signal))
    }

    feed(signal) {
      return feedEvents(rt.subscribeFeed, signal)
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
