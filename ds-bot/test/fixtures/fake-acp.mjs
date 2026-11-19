// A fake ACP agent for tests: newline JSON-RPC over stdio. The prompt text
// picks its behavior so a test can drive each branch:
//   contains "call-tool"    -> calls the dsbot MCP server's tools/call
//   contains "two-calls"    -> two queued MCP calls
//   contains "ask-permission" -> session/request_permission to the client
//   contains "team-permission" / "other-permission" -> an MCP call to the dsbot / another
//                              server that asks first, in the shape cursor-agent 2026.11.05 sends
//   contains "hang"         -> never ends until session/cancel
//   otherwise               -> a thought chunk, an activity line, "ok"
// `--exit-after-turn` makes it exit once a prompt is answered, so a test can
// watch the client reopen the agent.
//   contains "devin-team" / "devin-other" -> the same, in the shape Devin CLI 3000.12.28 sends
//   contains "show-mode"    -> answers with the mode the session is in
//   contains "grow:<n>"     -> the context grows by <n> tokens with this prompt
//   contains "count-sessions" -> answers with how many sessions are open
//   "/compact"              -> condenses as Devin CLI 3000.12.43 does: the prompt ends
//                              at once, then _cognition.ai/compaction started and
//                              completed, then a "Context compacted" chunk
// Every answered prompt reports usage_update and the prompt's usage the way Devin CLI
// 3000.12.43 does (test/fixtures/recorded/devin-acp-3000.12.43.json); `--no-compact`
// lists no compact command, `--no-usage` reports no usage.
// `--cursor-modes` lists the modes cursor-agent 2026.11.05 does (agent, plan, ask)
// and refuses any other, as it does.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const exitAfterTurn = process.argv.includes('--exit-after-turn')
const cursorModes = process.argv.includes('--cursor-modes')
const agyModes = process.argv.includes('--agy-modes')
const thoughtLevels = process.argv.includes('--thought-levels')
const legacyModels = process.argv.includes('--legacy-models')
const loadThoughtLevel = process.argv.includes('--load-thought-level')
const modelResetsThought = process.argv.includes('--model-resets-thought')
const preserveThoughtOnModel = process.argv.includes('--preserve-thought-on-model')
const stateFile = process.argv.find(arg => arg.startsWith('--state-file='))?.slice('--state-file='.length)
const omitMcpCaps = process.argv.includes('--omit-mcp-caps')
const rejectHttpMcp = process.argv.includes('--reject-http-mcp')
const rejectMcp = process.argv.includes('--reject-mcp')
const noHttpMcp = process.argv.includes('--no-http-mcp')
const failFirstInit = process.argv.includes('--fail-first-init')
let initCount = 0
const authRequired = process.argv.includes('--auth-required')
const noImage = process.argv.includes('--no-image')
const listsCompact = !process.argv.includes('--no-compact')
const reportsUsage = !process.argv.includes('--no-usage')
const WINDOW = 262_000
const MODES = agyModes ? ['default', 'accept-edits', 'auto', 'plan'] : cursorModes ? ['agent', 'plan', 'ask'] : ['ask', 'accept-edits', 'bypass']
let refusedModes = 0
const sessions = new Map()
let nextId = 0
if (stateFile) {
  try {
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(stateFile, 'utf8')))) sessions.set(key, value)
    nextId = sessions.size
  } catch {}
}
const saveSaved = () => {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sessions)))
}
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

async function stdioMcpCall(server, name, args) {
  if (server.type !== undefined) throw new Error('McpServerStdio must not include type')
  if (!Array.isArray(server.env)) throw new Error('McpServerStdio must include env array')
  const env = { ...process.env }
  for (const item of server.env) env[item.name] = item.value
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const msg = JSON.parse(trimmed)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio MCP ${method} timed out: ${stderr}`)), 5_000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else resolve(msg.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-acp-stdio', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const [callRes] = await Promise.all([
      rpc(2, 'tools/call', { name, arguments: args }),
      rpc(3, 'tools/list', {}),
    ])
    return callRes
  } finally {
    child.stdin.end()
    child.kill()
  }
}

async function mcpCall(server, name, args) {
  if (server?.command !== undefined) return stdioMcpCall(server, name, args)
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
  const post = (body) => fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
  const response = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  const text = await response.text()
  const line = text.split('\n').map(row => row.trim()).find(row => row.startsWith('data: ') && row.includes('"result"'))
  return JSON.parse(line.slice(6)).result
}

async function runPrompt(session, prompt, requestId) {
  const blocks = prompt ?? []
  const images = blocks.filter(block => block.type === 'image')
  if (images.length > 0) {
    if (noImage) {
      send({ jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'Invalid params: image prompt content is unsupported' } })
      return
    }
    const bad = images.find(block => typeof block.mimeType !== 'string' || typeof block.data !== 'string' || block.data.startsWith('data:'))
    if (bad !== undefined) {
      send({ jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'Invalid params: malformed ACP image block' } })
      return
    }
  }
  const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  const sessionId = session.id
  const finish = (textOut) => {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textOut } })
    if (!reportsUsage) { reply(requestId, { stopReason: 'end_turn' }); return }
    const grow = Number(text.match(/grow:(\d+)/)?.[1] ?? 0)
    session.used = (session.used ?? 14_000) + 50 + grow
    const meta = { 'cognition.ai/inputTokens': session.used - 30, 'cognition.ai/outputTokens': 30, 'cognition.ai/cachedReadTokens': 9_000 }
    update(sessionId, { sessionUpdate: 'usage_update', used: session.used, size: WINDOW, _meta: meta })
    update(sessionId, { sessionUpdate: 'usage_update', used: session.used, size: WINDOW, _meta: { ...meta, 'cognition.ai/subagent_context': { parentAgentId: 'root' } } })
    reply(requestId, { stopReason: 'end_turn', usage: { totalTokens: session.used, inputTokens: session.used - 30, outputTokens: 30, cachedReadTokens: 9_000 } })
  }
  if (text.trim() === '/compact') {
    reply(requestId, { stopReason: 'end_turn' })
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: '_cognition.ai/compaction', params: { status: 'started', sessionId } })
      session.used = 15_000
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: '_cognition.ai/compaction', params: { status: 'completed', summary: '<summary>(trimmed)</summary>', sessionId } })
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Context compacted' } })
      }, 30)
    }, 20)
    return
  }
  if (text.includes('rpc-error-number')) { send({ jsonrpc: '2.0', id: requestId, error: { code: -32603, message: 'Internal error: approval was cancelled' } }); return }
  if (text.includes('rpc-error-empty')) { send({ jsonrpc: '2.0', id: requestId, error: { code: '', message: 'Internal error: empty code' } }); return }
  if (text.includes('rpc-error-object')) { send({ jsonrpc: '2.0', id: requestId, error: { code: -32603, message: { reason: 'stopped' } } }); return }
  if (text.includes('count-sessions')) { finish(`sessions: ${sessions.size}`); return }
  if (/\bhang\b/.test(text)) return // session/cancel releases it below
  if (text.includes('show-state')) { finish(`cwd: ${process.cwd()}; effort: ${session.thoughtLevel ?? 'default'}${legacyModels ? `; model: ${session.model ?? 'default'}` : ''}`); return }
  if (text.includes('show-mode')) { finish(`mode: ${session.mode}; refused: ${refusedModes}`); return }
  if (text.includes('late-permission')) {
    void ask('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'late', kind: 'execute', title: 'Late action' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    })
    session.reask = true
    finish('old output before the decision')
    return
  }
  if (session.reask && text.includes('The calls that were waiting')) {
    session.reask = false
    return runPrompt(session, [{ type: 'text', text: 'ask-permission' }], requestId)
  }
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
    finish(outcome?.outcome === 'selected' && !outcome.optionId.startsWith('reject') ? `allowed via ${outcome.optionId}` : 'denied')
    return
  }
  if (text.includes('devin-team') || text.includes('devin-other')) {
    // Recorded from devin acp: the server is named only in `_meta`, by the
    // permission rule on the request.
    const provider = text.includes('devin-team') ? 'dsbot' : 'github'
    const name = `mcp__${provider}__message_bot`
    const toolCallId = 'mcp_call_tool:0#1'
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: `Calling message_bot from ${provider}`, rawInput: { to: 'River', message: 'ping' }, _meta: { 'cognition.ai/toolName': name, 'cognition.ai/eventType': 'mcp_tool_call' } })
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, _meta: { 'cognition.ai/permissionRule': name } },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: `Yes, allow calling message_bot on the ${provider} MCP server (this session)`, kind: 'allow_always' },
        { optionId: 'allow_always', name: `Yes, always allow calling message_bot on the ${provider} MCP server`, kind: 'allow_always' },
        { optionId: 'switch_bypass', name: 'Yes, switch to bypass mode', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = answer?.result?.outcome
    if (outcome?.outcome !== 'selected' || outcome.optionId.startsWith('reject')) { finish('denied'); return }
    if (provider !== 'dsbot') { finish(`allowed via ${outcome.optionId}`); return }
    const result = await mcpCall(session.mcp, 'message_bot', { to: 'River', message: 'ping' })
    finish(`allowed via ${outcome.optionId}; tool said: ${(result.content ?? []).map(block => block.text).join('')}`)
    return
  }
  if (text.includes('team-permission') || text.includes('other-permission')) {
    // Recorded from cursor-agent acp: the call opens empty, an update names the
    // server and tool, then the permission request carries only a title.
    const provider = text.includes('team-permission') ? 'dsbot' : 'github'
    const toolCallId = 'call-1\nfc_1_0'
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, title: `${provider}: message_bot`, rawInput: { providerIdentifier: provider, toolName: 'message_bot', args: { to: 'River', message: 'ping' } } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, title: `${provider}-message_bot: message_bot`, kind: 'other', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: '```json\n{"to":"River","message":"ping"}\n```' } }] },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ].filter(option => !text.includes('always-only') || option.kind !== 'allow_once'),
    })
    const outcome = answer?.result?.outcome
    if (outcome?.outcome !== 'selected' || outcome.optionId.startsWith('reject')) { finish('denied'); return }
    if (provider !== 'dsbot') { finish(`allowed via ${outcome.optionId}`); return }
    const result = await mcpCall(session.mcp, 'message_bot', { to: 'River', message: 'ping' })
    finish(`allowed via ${outcome.optionId}; tool said: ${(result.content ?? []).map(block => block.text).join('')}`)
    return
  }
  if (text.includes('generic-mcp-')) {
    const isTeam = text.includes('generic-mcp-team')
    const name = text.includes('generic-mcp-team-colon') ? 'dsbot:message_bot'
      : isTeam ? 'mcp__dsbot__message_bot'
        : text.includes('generic-mcp-other-prefix') ? 'dsbot-unrelated'
          : 'mcp__github__issue'
    const toolCallId = 'gm-1'
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name, title: name, kind: 'other', rawInput: { to: 'River', message: 'ping' } })
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, name, title: name, kind: 'other', rawInput: { to: 'River', message: 'ping' } },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = answer?.result?.outcome
    if (outcome?.outcome !== 'selected' || outcome.optionId.startsWith('reject')) { finish('denied'); return }
    if (!isTeam) { finish(`allowed via ${outcome.optionId}`); return }
    const result = await mcpCall(session.mcp, 'message_bot', { to: 'River', message: 'ping' })
    finish(`allowed via ${outcome.optionId}; tool said: ${(result.content ?? []).map(block => block.text).join('')}`)
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
  const suffix = images.length > 0 ? ` images=${JSON.stringify(images.map(block => ({ mimeType: block.mimeType, data: block.data })))}` : ''
  finish(`ok: ${text.slice(0, 60)}${suffix}`)
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
      case 'initialize': {
        initCount += 1
        if (failFirstInit && initCount === 1) { fail(id, 'init boom'); break }
        const mcpCapabilities = noHttpMcp ? { http: false, sse: false } : omitMcpCaps ? undefined : { http: true, sse: false }
        const agentCapabilities = {
          ...(mcpCapabilities === undefined ? {} : { mcpCapabilities }),
          loadSession: true,
          promptCapabilities: { image: !noImage, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {} },
        }
        reply(id, { protocolVersion: 1, agentCapabilities, authMethods: [] })
        break
      }
      case 'session/new': {
        if (authRequired) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } }); break }
        const servers = params.mcpServers ?? []
        if (rejectMcp && servers.length > 0) { fail(id, 'Invalid params: mcpServers unsupported'); break }
        if (rejectHttpMcp && servers.some(entry => entry.type === 'http')) { fail(id, 'Invalid params: http mcp unsupported'); break }
        const server = servers.find(entry => entry.name === 'dsbot')
        if (server?.command !== undefined && (server.type !== undefined || !Array.isArray(server.env))) {
          fail(id, 'Invalid params: McpServerStdio malformed'); break
        }
        const defaultThought = String(params.cwd ?? '').includes('low-ws') ? 'low' : 'medium'
        const session = { id: `acp-${++nextId}`, mcp: undefined, mode: MODES[0], thoughtLevel: defaultThought, ...(legacyModels ? { model: 'legacy-std' } : {}) }
        if (server !== undefined) {
          session.mcp = server.command !== undefined
            ? { command: server.command, args: server.args ?? [], env: server.env }
            : { url: server.url, token: (server.headers ?? []).find(header => header.name === 'Authorization')?.value?.replace('Bearer ', '') }
        }
        sessions.set(session.id, session)
        saveSaved()
        // Devin lists its commands before it answers session/new.
        update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'status', description: 'Show status' }, ...(listsCompact ? [{ name: 'compact', description: 'Force conversation compaction' }] : [])] })
        const configOptions = [
          ...(legacyModels ? [] : [{ id: 'model', category: 'model', name: 'Model', options: [{ id: 'fake-large', name: 'Fake Large' }, { id: 'fake-small', name: 'Fake Small' }] }]),
          ...(thoughtLevels ? [{ id: 'thought_level', category: 'thought_level', name: 'Thinking Level', currentValue: defaultThought, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] : []),
          { id: 'mode', category: 'mode', name: 'Mode', currentValue: MODES[0], options: MODES.map(value => ({ value, name: value })) },
        ]
        const models = legacyModels ? {
          availableModels: [
            { modelId: 'legacy-std', name: 'Legacy Standard' },
            { modelId: 'legacy-fast', name: 'Legacy Fast' },
          ],
        } : thoughtLevels ? {
          availableModels: [
            { modelId: 'fake-large-low', name: 'Fake Large (Low)' },
            { modelId: 'fake-large-medium', name: 'Fake Large (Medium)' },
            { modelId: 'fake-large-high', name: 'Fake Large (High)' },
            { modelId: 'fake-large-xhigh', name: 'Fake Large (XHigh)' },
            { modelId: 'fake-small', name: 'Fake Small' },
          ],
        } : undefined
        reply(id, { sessionId: session.id, ...(models ? { models } : {}), configOptions })
        break
      }
      case 'session/load': {
        const servers = params.mcpServers ?? []
        if (rejectMcp && servers.length > 0) { fail(id, 'Invalid params: mcpServers unsupported'); break }
        if (rejectHttpMcp && servers.some(entry => entry.type === 'http')) { fail(id, 'Invalid params: http mcp unsupported'); break }
        const server = servers.find(entry => entry.name === 'dsbot')
        if (server?.command !== undefined && (server.type !== undefined || !Array.isArray(server.env))) {
          fail(id, 'Invalid params: McpServerStdio malformed'); break
        }
        let session = sessions.get(params.sessionId)
        // Bare on purpose: some agents list no modes on load (cursor-agent does).
        if (session === undefined) { session = { id: params.sessionId, mcp: undefined, mode: MODES[0], thoughtLevel: 'medium', ...(legacyModels ? { model: 'legacy-std' } : {}) }; sessions.set(session.id, session) }
        if (server !== undefined) {
          session.mcp = server.command !== undefined
            ? { command: server.command, args: server.args ?? [], env: server.env }
            : { url: server.url, token: (server.headers ?? []).find(header => header.name === 'Authorization')?.value?.replace('Bearer ', '') }
        }
        saveSaved()
        reply(id, {
          sessionId: params.sessionId,
          ...(loadThoughtLevel ? {
            configOptions: [{ id: 'thought_level', category: 'thought_level', name: 'Thinking Level', currentValue: session.thoughtLevel, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }],
          } : {}),
        })
        break
      }
      case 'session/set_config_option':
        if (params.configId === 'model' && (legacyModels || !['fake-large', 'fake-small'].includes(params.value))) fail(id, `unknown model ${params.value}`)
        else if (params.configId === 'mode' && !MODES.includes(params.value)) { refusedModes++; fail(id, 'Invalid params') }
        else if (params.configId === 'thought_level' && !['low', 'medium', 'high', 'xhigh'].includes(params.value)) fail(id, `unknown thought_level ${params.value}`)
        else {
          if (params.configId === 'model') {
            const session = sessions.get(params.sessionId)
            session.model = params.value
            if (modelResetsThought || preserveThoughtOnModel) {
              if (modelResetsThought) session.thoughtLevel = params.value === 'fake-small' ? 'low' : 'medium'
              saveSaved()
              reply(id, { configOptions: [{ id: 'thought_level', category: 'thought_level', name: 'Thinking Level', currentValue: session.thoughtLevel, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] })
              break
            }
          }
          if (params.configId === 'mode') sessions.get(params.sessionId).mode = params.value
          if (params.configId === 'thought_level') sessions.get(params.sessionId).thoughtLevel = params.value
          saveSaved()
          reply(id, {})
        }
        break
      case 'session/set_mode':
        if (!MODES.includes(params.modeId)) { refusedModes++; fail(id, 'Internal error') }
        else { sessions.get(params.sessionId).mode = params.modeId; saveSaved(); reply(id, {}) }
        break
      case 'session/set_model':
        if (!['legacy-std', 'legacy-fast', 'fake-large', 'fake-small'].includes(params.modelId)) fail(id, `unknown model ${params.modelId}`)
        else { sessions.get(params.sessionId).model = params.modelId; saveSaved(); reply(id, {}) }
        break
      case 'session/prompt':
        void runPrompt(sessions.get(params.sessionId) ?? { id: params.sessionId }, params.prompt, id)
          .then(() => { if (exitAfterTurn) setTimeout(() => process.exit(0), 50) })
        break
      case 'session/close':
        sessions.delete(params.sessionId)
        reply(id, {})
        break
      case 'session/cancel':
        update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } })
        break
      default:
        if (id !== undefined) fail(id, `method not found: ${method}`)
    }
  }
})
