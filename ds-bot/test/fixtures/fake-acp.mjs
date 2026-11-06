// A fake ACP agent for tests: newline JSON-RPC over stdio. The prompt text
// picks its behavior so a test can drive each branch:
//   contains "call-tool"    -> calls the dsbot MCP server's tools/call
//   contains "two-calls"    -> two queued MCP calls
//   contains "ask-permission" -> session/request_permission to the client
//   contains "hang"         -> never ends until session/cancel
//   otherwise               -> a thought chunk, an activity line, "ok"
const sessions = new Map()
let nextId = 0
const requests = new Map()

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
const update = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
const ask = (method, params) => {
  const id = `fake-${++nextId}`
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise(resolve => requests.set(id, resolve))
}

async function mcpCall(server, name, args) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
  const post = (body) => fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
  const response = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  const text = await response.text()
  const line = text.split('\n').map(row => row.trim()).find(row => row.startsWith('data: ') && row.includes('"result"'))
  return JSON.parse(line.slice(6)).result
}

async function runPrompt(session, prompt, requestId) {
  const text = (prompt ?? []).map(block => block.text ?? '').join('\n')
  const sessionId = session.id
  const finish = (textOut) => {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textOut } })
    reply(requestId, { stopReason: 'end_turn' })
  }
  if (/\bhang\b/.test(text)) return // session/cancel releases it below
  if (text.includes('ask-permission')) {
    // Like Devin: the call's kind and input arrive with its tool_call update;
    // the permission request names it only by id.
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'perm-call', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf /tmp/x' } })
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'perm-call' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = answer?.result?.outcome
    finish(outcome?.outcome === 'selected' ? `allowed via ${outcome.optionId}` : 'denied')
    return
  }
  if (text.includes('call-tool') || text.includes('two-calls')) {
    const server = session.mcp
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp dsbot message_bot', kind: 'other', status: 'in_progress' })
    try {
      const calls = text.includes('two-calls') ? 2 : 1
      const results = await Promise.all([...Array(calls)].map((_, i) => mcpCall(server, 'message_bot', { to: 'Chief', message: `hi ${i}` })))
      finish(`tool said: ${results.map(result => (result.content ?? []).map(block => block.text).join('')).join(' | ')}`)
    } catch (error) {
      finish(`tool failed: ${error.message}`)
    }
    return
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `thought about: ${text.slice(0, 40)}` } })
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't0', kind: 'read', status: 'in_progress', locations: [{ path: 'src/a.js' }] })
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } })
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
  finish(`ok: ${text.slice(0, 60)}`)
}

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
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      requests.get(message.id)?.(message)
      requests.delete(message.id)
      continue
    }
    const { id, method, params = {} } = message
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: false }, loadSession: true }, authMethods: [] })
        break
      case 'session/new': {
        const session = { id: `acp-${++nextId}`, mcp: undefined }
        const server = (params.mcpServers ?? []).find(entry => entry.name === 'dsbot')
        if (server !== undefined) session.mcp = { url: server.url, token: (server.headers ?? []).find(header => header.name === 'Authorization')?.value?.replace('Bearer ', '') }
        sessions.set(session.id, session)
        reply(id, {
          sessionId: session.id,
          configOptions: [
            { id: 'model', category: 'model', name: 'Model', options: [{ id: 'fake-large', name: 'Fake Large' }, { id: 'fake-small', name: 'Fake Small' }] },
            { id: 'mode', category: 'mode', name: 'Mode', options: [{ id: 'ask', name: 'Ask' }, { id: 'accept-edits', name: 'Accept edits' }, { id: 'bypass', name: 'Bypass' }] },
          ],
        })
        break
      }
      case 'session/load': {
        let session = sessions.get(params.sessionId)
        if (session === undefined) { session = { id: params.sessionId, mcp: undefined }; sessions.set(session.id, session) }
        const server = (params.mcpServers ?? []).find(entry => entry.name === 'dsbot')
        if (server !== undefined) session.mcp = { url: server.url, token: (server.headers ?? []).find(header => header.name === 'Authorization')?.value?.replace('Bearer ', '') }
        reply(id, { sessionId: params.sessionId })
        break
      }
      case 'session/set_config_option':
      case 'session/set_mode':
        reply(id, {})
        break
      case 'session/prompt':
        void runPrompt(sessions.get(params.sessionId) ?? { id: params.sessionId }, params.prompt, id)
        break
      case 'session/cancel':
        update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } })
        break
      default:
        if (id !== undefined) fail(id, `method not found: ${method}`)
    }
  }
})
