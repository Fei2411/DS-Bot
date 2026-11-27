// The window talks only to ds-bot's own channel in the engine: POST api/bot for reads and
// actions (the Bot views' own `call`), api/bot/feed for team changes, and api/bot/session
// for a Session's follow stream (host/session-follow.js).
const RETRY_MS = [500, 1000, 2000, 5000]
const HEALTHY_MS = 5_000
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024
// A Session that is gone, refused, malformed, or stale stops the follow loop instead of retrying forever.
const TERMINAL_SESSION_ERRORS = new Set(['bot/not-found', 'bot/refused', 'bot/invalid', 'bot/stale'])

function parseEvent(block) {
  let event = 'message'
  const data = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) data.push(line.slice(6))
  }
  if (data.length === 0) return undefined
  try { return { event, data: JSON.parse(data.join('\n')) } } catch { return undefined }
}

async function readEventStream(body, onParsed, onComment) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
      let start = 0
      for (let end = buffer.indexOf('\n\n', start); end >= 0; end = buffer.indexOf('\n\n', start)) {
        const block = buffer.slice(start, end)
        start = end + 2
        if (block.startsWith(':')) {
          onComment?.(block.slice(1).trim())
          continue
        }
        const parsed = parseEvent(block)
        if (parsed !== undefined && onParsed(parsed.event, parsed.data) === false) {
          await reader.cancel().catch(() => {})
          return
        }
      }
      if (start > 0) buffer = buffer.slice(start)
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        await reader.cancel().catch(() => {})
        throw new Error('SSE buffer limit exceeded')
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

// Read over fetch: EventSource does not load from the window's own scheme. After a
// break the feed reconnects, and its first event (`hello`) tells the window to catch up.
export function openFeed(onEvent) {
  let stopped = false
  let controller
  let retryTimer
  let wakeRetry
  const run = async () => {
    for (let failures = 0; !stopped;) {
      controller = new AbortController()
      let receivedEvent = false
      let rotated = false
      let connectedAt = 0
      try {
        const response = await fetch('api/bot/feed', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        connectedAt = Date.now()
        await readEventStream(response.body, (event, data) => {
          receivedEvent = true
          failures = 0
          onEvent(event, data)
        }, (comment) => {
          if (comment === 'rotate') rotated = true
        })
      } catch {
        rotated = false
        // The engine restarted or the window is going away; the loop decides.
      } finally {
        if (receivedEvent || (connectedAt > 0 && Date.now() - connectedAt >= HEALTHY_MS)) failures = 0
        controller.abort()
      }
      if (stopped) return
      // Reconnect immediately on server-initiated SSE rotation (no setTimeout, so backgrounded
      // Electron windows never get throttled past the host's rotation grace window).
      if (rotated && receivedEvent) {
        failures = 0
        continue
      }
      onEvent('lost', {})
      const delay = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
      await new Promise((resolve) => {
        wakeRetry = () => {
          if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
          wakeRetry = undefined
          resolve()
        }
        retryTimer = setTimeout(wakeRetry, delay)
      })
      if (stopped) return
      failures += 1
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
    wakeRetry?.()
  }
}

/**
 * Follow one DSH Session through `GET api/bot/session` (SSE).
 * Reconnects with backoff on transient drops, stops on terminal errors (`bot/not-found`,
 * `bot/refused`, `bot/invalid`, `bot/stale`), and supports an immediate `reopen()` when the window sees
 * a frame gap or a read-only refresh signal.
 * @param {{ sessionId: string, parent?: string, mode?: string, max?: number, after?: () => number }} request
 * @param {(event: 'frame' | 'error' | 'end' | 'lost', data: any) => void} onEvent
 * @returns {{ close: () => void, reopen: () => void }}
 */
export function openSessionFollow({ sessionId, parent, mode, max, after }, onEvent) {
  const followUrl = () => {
    const params = new URLSearchParams({ id: sessionId })
    if (parent) params.set('parent', parent)
    if (mode) params.set('mode', mode)
    if (max !== undefined) params.set('max', String(max))
    const cursor = typeof after === 'function' ? after() : after
    if (Number.isSafeInteger(cursor) && cursor >= 0) params.set('after', String(cursor))
    return `api/bot/session?${params.toString()}`
  }

  let stopped = false
  let terminal = false
  let reopenNow = false
  let running = false
  let controller = null
  let wakeTimer = 0
  let wakeResolve = null

  const wake = () => {
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = 0 }
    if (wakeResolve) { const done = wakeResolve; wakeResolve = null; done() }
  }

  const sleep = ms => new Promise((resolve) => {
    wakeResolve = resolve
    wakeTimer = setTimeout(() => { wakeTimer = 0; wakeResolve = null; resolve() }, ms)
  })

  const run = async () => {
    if (running) return
    running = true
    try {
      for (let failures = 0; !stopped && !terminal;) {
        reopenNow = false
        controller = new AbortController()
        const myController = controller
        let sawFrame = false
        try {
          const response = await fetch(followUrl(), { signal: myController.signal, cache: 'no-store' })
          if (!response.ok) {
            let body = null
            try { body = await response.json() } catch { /* plain status */ }
            const code = body?.error?.code ?? (response.status === 400 ? 'bot/invalid' : 'bot/error')
            const message = body?.error?.message ?? `HTTP ${response.status}`
            if (TERMINAL_SESSION_ERRORS.has(code) || response.status === 400) {
              terminal = true
              onEvent('error', { code, message })
              if (terminal) break
              continue
            }
            throw new Error(message)
          }
          if (response.body === null) throw new Error('Empty response body')
          await readEventStream(response.body, (event, data) => {
            if (stopped || myController.signal.aborted) return false
            if (event === 'frame') {
              sawFrame = true
              failures = 0
              onEvent('frame', data)
              return !reopenNow
            }
            if (event === 'error') {
              if (TERMINAL_SESSION_ERRORS.has(data?.code)) terminal = true
              onEvent('error', data ?? { code: 'bot/error', message: 'Session follow failed' })
              if (terminal) { myController.abort(); return false }
              return true
            }
            if (event === 'end') {
              onEvent('end', data ?? {})
              return false
            }
            return true
          })
        } catch {
          // Transient abort, network drop, or host restart; loop decides whether to reopen.
        }
        if (stopped || terminal) break
        if (reopenNow) {
          failures = 0
          continue
        }
        if (!sawFrame) onEvent('lost', {})
        await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)])
        if (!reopenNow) failures += 1
      }
    } finally {
      running = false
      if (reopenNow && !stopped && !terminal) void run()
    }
  }

  void run()
  return {
    close() {
      stopped = true
      controller?.abort()
      wake()
    },
    reopen() {
      if (stopped) return
      terminal = false
      reopenNow = true
      controller?.abort()
      wake()
      if (!running) void run()
    },
  }
}
