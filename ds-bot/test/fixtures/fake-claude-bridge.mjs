// A fake Claude Code that calls the dsbot MCP server, like the real CLI does for
// a team tool. The log file (first argument) gets every user message it reads
// on stdin, so a test can tell what reached the CLI.
//   contains "call-tool" -> calls message_bot over the --mcp-config server and
//                           stays inside that call until DS Bot answers it
//   otherwise            -> answers "ok: <text>"
import { appendFileSync } from 'node:fs'

const log = process.argv[2]
const sessionId = `claude-${Math.random().toString(36).slice(2)}`
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const configAt = process.argv.indexOf('--mcp-config')
const server = configAt === -1 ? undefined : JSON.parse(process.argv[configAt + 1]).mcpServers.dsbot

async function mcpCall(name, args) {
  const headers = { 'content-type': 'application/json', authorization: server.headers.Authorization }
  const post = body => fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
  const response = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  const line = (await response.text()).split('\n').map(row => row.trim()).find(row => row.startsWith('data: ') && row.includes('"result"'))
  return JSON.parse(line.slice(6)).result
}

let inited = false
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type !== 'user') continue
    if (!inited) { inited = true; send({ type: 'system', subtype: 'init', session_id: sessionId }) }
    const text = (message.message?.content ?? []).map(block => block.text ?? '').join('\n')
    appendFileSync(log, `${text}\n---\n`)
    void answer(text)
  }
})

async function answer(text) {
  if (text.includes('call-tool')) {
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__dsbot__message_bot' }] } })
    const result = await mcpCall('message_bot', { bot: 'Chief', text: 'ping' })
    send({ type: 'assistant', message: { content: [{ type: 'text', text: `tool said: ${result.content?.[0]?.text}` }] } })
  } else {
    send({ type: 'assistant', message: { content: [{ type: 'text', text: `ok: ${text.slice(0, 60)}` }] } })
  }
  send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } })
}
