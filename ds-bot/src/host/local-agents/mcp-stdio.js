// Bridges an ACP agent's stdio MCP transport to DS Bot's loopback Streamable HTTP MCP server.
// Keep zero relative imports so packaged builds can copy this single file out of app.asar.
import { createInterface } from 'node:readline'

const url = process.env.DSBOT_MCP_URL || process.argv[2]
const token = process.env.DSBOT_MCP_TOKEN || process.argv[3]

if (!url || !token) process.exit(1)

const STDIN_CLOSE_GRACE_MS = 2_000

let sessionId
const inFlight = new Set()
const sseKeepaliveControllers = new Set()
const shutdown = new AbortController()
let stdinClosed = false
let exiting = false
let graceTimer
let notificationStreamStarted = false

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function startNotificationStream() {
  if (notificationStreamStarted || shutdown.signal.aborted) return
  notificationStreamStarted = true
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'text/event-stream',
  }
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
  void fetch(url, { method: 'GET', headers, signal: shutdown.signal })
    .then(async (response) => {
      if (!response.ok || response.body === null) return
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        await response.body.cancel().catch(() => {})
        return
      }
      await readSse(response.body, (msg) => {
        if (!shutdown.signal.aborted && msg !== null && typeof msg === 'object') send(msg)
      })
    })
    .catch(() => {})
}

const sendError = (id, code, message) => {
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } })
}

function parseSseEvent(block, onJson) {
  const dataLines = []
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
  }
  const payload = dataLines.join('\n').trim()
  if (payload === '' || payload === '[DONE]') return
  try { onJson(JSON.parse(payload)) } catch {}
}

async function readSse(body, onJson) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let match
      while ((match = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        parseSseEvent(buffer.slice(0, match.index), onJson)
        buffer = buffer.slice(match.index + match[0].length)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') parseSseEvent(buffer, onJson)
  } finally {
    reader.releaseLock?.()
  }
}

async function forward(raw) {
  if (shutdown.signal.aborted) return
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const hasId = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.id !== undefined
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId

  const reqAbort = new AbortController()
  const signal = AbortSignal.any([shutdown.signal, reqAbort.signal])
  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: raw, signal })
  } catch (error) {
    if (signal.aborted) return
    sendError(hasId ? parsed.id : undefined, -32603, error instanceof Error ? error.message : String(error))
    return
  }
  const nextSession = response.headers.get('mcp-session-id')
  if (nextSession) sessionId = nextSession

  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => {})
    return
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim()
    if (signal.aborted) return
    sendError(hasId ? parsed.id : undefined, -32603, detail || `MCP HTTP ${response.status}`)
    return
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream') && response.body !== null) {
    let responded = false
    try {
      await readSse(response.body, (msg) => {
        if (hasId && msg?.id === parsed.id) responded = true
        if (msg?.method === 'notifications/progress') {
          sseKeepaliveControllers.add(reqAbort)
          if (stdinClosed) reqAbort.abort()
        }
        send(msg)
      })
    } catch (error) {
      if (signal.aborted) return
      sendError(hasId ? parsed.id : undefined, -32603, error instanceof Error ? error.message : String(error))
      return
    } finally {
      sseKeepaliveControllers.delete(reqAbort)
    }
    if (hasId && !responded && !signal.aborted) sendError(parsed.id, -32603, 'MCP stream ended without a response')
    return
  }

  let text
  try {
    text = (await response.text()).trim()
  } catch (error) {
    if (signal.aborted) return
    sendError(hasId ? parsed.id : undefined, -32603, error instanceof Error ? error.message : String(error))
    return
  }
  if (text === '') {
    if (hasId) sendError(parsed.id, -32603, 'Empty MCP HTTP response')
    return
  }
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data)) {
      for (const item of data) send(item)
    } else {
      send(data)
      if (parsed?.method === 'initialize' && data?.result?.capabilities?.tools?.listChanged === true) {
        startNotificationStream()
      }
    }
  } catch {
    if (hasId) sendError(parsed.id, -32603, 'Invalid MCP JSON response')
  }
}

const finishExit = () => {
  clearTimeout(graceTimer)
  graceTimer = undefined
  process.exit(0)
}

const abortAndExit = () => {
  if (exiting) return
  exiting = true
  clearTimeout(graceTimer)
  graceTimer = undefined
  shutdown.abort()
  void Promise.allSettled(inFlight).finally(finishExit)
}

process.on('SIGTERM', abortAndExit)
process.on('SIGINT', abortAndExit)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  const task = forward(trimmed).finally(() => inFlight.delete(task))
  inFlight.add(task)
})
lines.on('close', () => {
  stdinClosed = true
  if (exiting) return
  if (inFlight.size === 0) {
    abortAndExit()
    return
  }
  for (const ctrl of sseKeepaliveControllers) ctrl.abort()
  graceTimer = setTimeout(abortAndExit, STDIN_CLOSE_GRACE_MS)
  graceTimer.unref?.()
  void Promise.allSettled(inFlight).then(() => {
    if (!exiting) abortAndExit()
  })
})
