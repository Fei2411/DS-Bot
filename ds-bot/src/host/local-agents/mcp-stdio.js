// Bridges an ACP agent's stdio MCP transport to DS Bot's loopback Streamable HTTP MCP server.
// Keep zero relative imports so packaged builds can copy this single file out of app.asar.
import { createInterface } from 'node:readline'

const url = process.env.DSBOT_MCP_URL || process.argv[2]
const token = process.env.DSBOT_MCP_TOKEN || process.argv[3]

if (!url || !token) process.exit(1)

let sessionId
const inFlight = new Set()

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
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
}

async function forward(raw) {
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

  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: raw })
  } catch (error) {
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
    sendError(hasId ? parsed.id : undefined, -32603, detail || `MCP HTTP ${response.status}`)
    return
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream') && response.body !== null) {
    let responded = false
    await readSse(response.body, (msg) => {
      if (hasId && msg?.id === parsed.id) responded = true
      send(msg)
    })
    if (hasId && !responded) sendError(parsed.id, -32603, 'MCP stream ended without a response')
    return
  }

  const text = (await response.text()).trim()
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
    }
  } catch {
    if (hasId) sendError(parsed.id, -32603, 'Invalid MCP JSON response')
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  const task = forward(trimmed).finally(() => inFlight.delete(task))
  inFlight.add(task)
})
lines.on('close', () => {
  void Promise.allSettled(inFlight).then(() => process.exit(0))
})
