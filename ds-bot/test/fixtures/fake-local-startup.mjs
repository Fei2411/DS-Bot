// A delayed JSON-RPC handshake shared by the ACP and Codex startup tests.
// Requests sent before initialize succeeds are refused, as an unready CLI does.
import { createInterface } from 'node:readline'

let initialized = false
let nextId = 0
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') {
    setTimeout(() => {
      if (process.argv.includes('--reject-initialize')) { fail(id, 'initialization refused'); return }
      initialized = true
      reply(id, { agentCapabilities: { mcpCapabilities: { http: true } } })
    }, 50)
  } else if (id !== undefined) {
    if (!initialized) fail(id, 'not initialized')
    else reply(id, { sessionId: `session-${++nextId}`, thread: { id: `thread-${nextId}` } })
  }
}
