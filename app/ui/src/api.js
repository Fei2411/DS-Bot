// The window talks only to ds-bot's own channel in the engine: POST api/bot for reads and
// actions (the Bot views' own `call`), and the live feed api/bot/feed for what changes.
const RETRY_MS = [500, 1000, 2000, 5000]
const HEALTHY_MS = 5_000
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024

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
      let reader
      let receivedEvent = false
      let connectedAt = 0
      try {
        const response = await fetch('api/bot/feed', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        connectedAt = Date.now()
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let start = 0
          for (let end = buffer.indexOf('\n\n', start); end >= 0; end = buffer.indexOf('\n\n', start)) {
            const parsed = parseEvent(buffer.slice(start, end))
            start = end + 2
            if (parsed !== undefined) {
              receivedEvent = true
              failures = 0
              onEvent(parsed.event, parsed.data)
            }
          }
          if (start > 0) buffer = buffer.slice(start)
          if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error('SSE buffer limit exceeded')
        }
      } catch {
        // The engine restarted or the window is going away; the loop decides.
      } finally {
        if (receivedEvent || (connectedAt > 0 && Date.now() - connectedAt >= HEALTHY_MS)) failures = 0
        void reader?.cancel?.().catch(() => {})
        controller.abort()
      }
      if (stopped) return
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
