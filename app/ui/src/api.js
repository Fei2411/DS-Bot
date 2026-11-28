// The window talks only to ds-bot's own channel in the engine: POST api/bot for reads and
// actions (the Bot views' own `call`), api/bot/feed for team changes, and api/bot/session
// for a Session's follow stream (host/session-follow.js).
const RETRY_MS = [500, 1000, 2000, 5000]
const HEALTHY_MS = 5_000
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024
// A Session that is gone, refused, malformed, stale, or oversized stops the follow loop instead of retrying forever.
const STREAM_OVERFLOW_CODE = 'bot/stream-overflow'
const TERMINAL_SESSION_ERRORS = new Set(['bot/not-found', 'bot/refused', 'bot/invalid', 'bot/stale', STREAM_OVERFLOW_CODE])

function parseEvent(block) {
  let event = 'message'
  let id
  const data = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line[6] === ' ' ? line.slice(7) : line.slice(6)
    else if (line.startsWith('id:')) id = line[3] === ' ' ? line.slice(4) : line.slice(3)
    else if (line.startsWith('data:')) data.push(line[5] === ' ' ? line.slice(6) : line.slice(5))
  }
  if (data.length === 0) return undefined
  try { return { event, id, data: JSON.parse(data.join('\n')) } } catch { return undefined }
}

async function readEventStream(body, onParsed, onComment) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  /** @type {string[]} */
  const parts = []
  let bufferedChars = 0
  let prevEndedWithNL = false
  let pendingCR = false
  const emitBlock = (block) => {
    if (block.startsWith(':')) {
      onComment?.(block.slice(1).trim())
      return true
    }
    const parsed = parseEvent(block)
    if (parsed !== undefined && onParsed(parsed.event, parsed.data, parsed.id) === false) return false
    return true
  }
  const flushParts = (extra = '') => {
    if (extra !== '') parts.push(extra)
    const block = parts.length === 1 ? parts[0] : parts.join('')
    parts.length = 0
    bufferedChars = 0
    prevEndedWithNL = false
    return block
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      let chunk = decoder.decode(value, { stream: true })
      if (chunk.length === 0) continue
      if (pendingCR) {
        pendingCR = false
        if (chunk.charCodeAt(0) !== 10) chunk = `\r${chunk}`
      }
      if (chunk.charCodeAt(chunk.length - 1) === 13) {
        pendingCR = true
        chunk = chunk.slice(0, -1)
      }
      if (chunk.includes('\r\n')) chunk = chunk.replaceAll('\r\n', '\n')
      if (chunk.length === 0) {
        if (bufferedChars + (pendingCR ? 1 : 0) > MAX_SSE_BUFFER_CHARS) {
          await reader.cancel().catch(() => {})
          throw Object.assign(new Error('SSE buffer limit exceeded'), { code: STREAM_OVERFLOW_CODE, fatal: true })
        }
        continue
      }
      let start = 0
      if (prevEndedWithNL && chunk.charCodeAt(0) === 10) {
        const last = parts.pop()
        if (last.length > 1) parts.push(last.slice(0, -1))
        const block = flushParts()
        start = 1
        if (emitBlock(block) === false) {
          await reader.cancel().catch(() => {})
          return
        }
      }
      for (let end = chunk.indexOf('\n\n', start); end >= 0; end = chunk.indexOf('\n\n', start)) {
        const segment = chunk.slice(start, end)
        start = end + 2
        const block = parts.length > 0 ? flushParts(segment) : segment
        if (emitBlock(block) === false) {
          await reader.cancel().catch(() => {})
          return
        }
      }
      const tail = start === 0 ? chunk : chunk.slice(start)
      if (tail.length > 0) {
        parts.push(tail)
        bufferedChars += tail.length
        prevEndedWithNL = tail.charCodeAt(tail.length - 1) === 10
      }
      if (bufferedChars + (pendingCR ? 1 : 0) > MAX_SSE_BUFFER_CHARS) {
        await reader.cancel().catch(() => {})
        throw Object.assign(new Error('SSE buffer limit exceeded'), { code: STREAM_OVERFLOW_CODE, fatal: true })
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

function parseFeedId(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let boot = null
  let seqText = trimmed
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0) {
    const tail = trimmed.slice(colon + 1)
    if (/^\d+$/.test(tail)) {
      boot = trimmed.slice(0, colon)
      seqText = tail
    }
  }
  if (!/^\d+$/.test(seqText)) return null
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return { boot, seq }
}

// Read over fetch: EventSource does not load from the window's own scheme. After a
// break the feed reconnects with the last seen sequence number so clean rotations resume
// without forcing a full re-read.
export function openFeed(onEvent) {
  let stopped = false
  let controller
  let retryTimer
  let wakeRetry
  let lastSeq = null
  let lastBoot = null
  const buildFeedRequest = () => {
    if (lastSeq === null || lastBoot === null) return { url: 'api/bot/feed', headers: undefined }
    const params = new URLSearchParams({ after: String(lastSeq), boot: lastBoot })
    return {
      url: `api/bot/feed?${params.toString()}`,
      headers: { 'Last-Event-ID': `${lastBoot}:${lastSeq}` },
    }
  }
  const run = async () => {
    for (let failures = 0; !stopped;) {
      controller = new AbortController()
      let receivedEvent = false
      let rotated = false
      let connectedAt = 0
      let fatalError = null
      try {
        const { url, headers } = buildFeedRequest()
        const response = await fetch(url, {
          signal: controller.signal,
          cache: 'no-store',
          ...(headers ? { headers } : {}),
        })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        connectedAt = Date.now()
        await readEventStream(response.body, (event, data, id) => {
          receivedEvent = true
          failures = 0
          const parsedId = parseFeedId(id)
          if (parsedId !== null) {
            if (parsedId.boot !== null) lastBoot = parsedId.boot
            lastSeq = parsedId.seq
          }
          if (event === 'hello') {
            if (typeof data?.boot === 'string' && data.boot !== '') lastBoot = data.boot
            if (Number.isSafeInteger(data?.feedSeq) && data.feedSeq >= 0) lastSeq = data.feedSeq
          }
          onEvent(event, data)
        }, (comment) => {
          if (comment === 'rotate') rotated = true
        })
      } catch (error) {
        rotated = false
        if (error?.code === STREAM_OVERFLOW_CODE) {
          fatalError = error
        }
        // The engine restarted or the window is going away; the loop decides.
      } finally {
        if (receivedEvent || (connectedAt > 0 && Date.now() - connectedAt >= HEALTHY_MS)) failures = 0
        controller.abort()
      }
      if (stopped) return
      if (fatalError !== null) {
        stopped = true
        onEvent('error', { code: STREAM_OVERFLOW_CODE, message: fatalError.message, fatal: true })
        return
      }
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
        } catch (error) {
          if (error?.code === STREAM_OVERFLOW_CODE) {
            terminal = true
            onEvent('error', { code: STREAM_OVERFLOW_CODE, message: error.message })
          }
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
