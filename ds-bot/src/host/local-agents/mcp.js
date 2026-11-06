// The loopback MCP server: one per CLI session, Streamable HTTP on 127.0.0.1
// with a random port and a per-session bearer token. It serves only the DS
// Bot team tools; every call is handed to the adapter, which emits it as a
// DSH tool call and answers here once the result arrives.
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const PROTOCOL_VERSION = '2025-03-26'
const KEEPALIVE_MS = 20_000

// Several CLIs refuse schemas with unions, refs or const, so every schema is
// flattened to plain JSON Schema before tools/list.
export function flattenSchema(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(flattenSchema)
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' || key === '$defs' || key === 'definitions' || key === 'const') continue
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      const branches = Array.isArray(value) ? value : []
      const first = branches.find(branch => branch?.type !== 'null')
      if (first !== undefined) Object.assign(out, flattenSchema(first))
      continue
    }
    out[key] = flattenSchema(value)
  }
  return out
}

export class LoopbackMcp {
  // onCall(name, args) -> Promise<{text, isError}> runs while the adapter waits
  // for the DSH result; it resolves when the tool call settles.
  constructor(tools, onCall) {
    this.token = randomBytes(32).toString('hex')
    this.tools = tools
    this.onCall = onCall
    this.calls = new Map()
    this.server = createServer((request, response) => void this.serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }))
    this.url = undefined
  }

  async listen() {
    await new Promise((resolve, reject) => this.server.listen(0, '127.0.0.1', () => resolve()).once('error', reject))
    const { port } = this.server.address()
    this.url = `http://127.0.0.1:${port}/mcp`
    return this.url
  }

  // A queued or in-flight tool call that the CLI cancelled, or that an abort
  // must fail instead of leaving the agent waiting.
  failAll(error) {
    for (const call of this.calls.values()) call.settle({ isError: true, text: error.message ?? String(error) })
    this.calls.clear()
  }

  close() {
    this.failAll(new Error('the session closed'))
    this.server.close()
  }

  async serve(request, response) {
    const auth = request.headers.authorization
    if (auth !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
      return
    }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    const body = await readBody(request)
    let message
    try { message = JSON.parse(body) } catch { response.writeHead(400); response.end(); return }
    const messages = Array.isArray(message) ? message : [message]
    // Notifications and responses get 202 with no body, per the spec.
    const calls = messages.filter(item => item?.method !== undefined)
    if (calls.length === 0) { response.writeHead(202); response.end(); return }
    const toolsCall = calls.find(item => item.method === 'tools/call')
    if (toolsCall !== undefined) {
      this.serveCall(toolsCall, response)
      return
    }
    const replies = calls.map(item => this.answer(item)).filter(Boolean)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]))
  }

  answer({ id, method, params }) {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'ds-bot', version: '1' } } }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.tools().map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: flattenSchema(tool.parameters ?? { type: 'object', properties: {} }) })) } }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    }
  }

  // tools/call answers on an SSE stream: progress notifications keep the agent
  // patient while DSH runs the call, then the result arrives on the same stream.
  serveCall({ id, params }, response) {
    const callId = `mcp-${randomUUID()}`
    const progressToken = params?._meta?.progressToken ?? callId
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (value) => { try { response.write(`data: ${JSON.stringify(value)}\n\n`) } catch {} }
    const entry = {
      progress: 0,
      settle: (result) => {
        clearInterval(timer)
        this.calls.delete(callId)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError === true } })
        response.end()
      },
      cancel: () => {
        clearInterval(timer)
        this.calls.delete(callId)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'the call was cancelled' }], isError: true } })
        response.end()
      },
    }
    const timer = setInterval(() => {
      entry.progress += 1
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: entry.progress * KEEPALIVE_MS, message: 'waiting for the tool result' } })
    }, KEEPALIVE_MS)
    timer.unref?.()
    this.calls.set(callId, entry)
    this.onCall({ name: params?.name, arguments: params?.arguments ?? {}, callId })
      .then(entry.settle, error => entry.settle({ isError: true, text: error?.message ?? String(error) }))
  }
}

const readBody = (request) => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => resolve(body))
  request.on('error', reject)
})
