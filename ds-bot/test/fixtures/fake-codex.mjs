// A fake Codex app-server for tests: `codex app-server --listen stdio://`
// dialect, newline JSON-RPC. The turn's first text picks the behavior:
//   "ask"      -> an approval request the client must answer
//   "elicit <server> <kind>" -> an MCP tool-call approval (mcpServer/elicitation/request)
//                 from <server>, with _meta.codex_approval_kind <kind>; the answer
//                 comes back as the agentMessage, as JSON
//   otherwise  -> an activity item, an agentMessage, thread/tokenUsage/updated,
//                 turn/completed
// thread/compact/start condenses in a turn of its own. Usage and compaction take the
// shapes Codex 0.166 sends (test/fixtures/recorded/codex-app-server-0.166.json).
// `--exit-after-turn` exits once a turn completes, and `--text-only` sends no
// activity items first: a test can then tell whether the one text event reached
// the client. `--record <file>` appends the params of thread/start and thread/resume,
// so a test can check the shape the client sent without a model call.
import { appendFileSync } from 'node:fs'
const exitAfterTurn = process.argv.includes('--exit-after-turn')
const textOnly = process.argv.includes('--text-only')
const recordAt = process.argv.indexOf('--record')
const recordPath = recordAt === -1 ? undefined : process.argv[recordAt + 1]
const record = (method, params) => {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ method, params })}\n`)
}
// The fields Codex 0.166's app-server takes on thread/start and thread/resume
// (from `codex app-server generate-json-schema`). The real server drops any
// other field without a word, so the fake refuses it instead.
const THREAD_START = ['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd', 'developerInstructions', 'ephemeral', 'model', 'modelProvider', 'personality', 'sandbox', 'serviceName', 'serviceTier', 'sessionStartSource', 'threadSource']
const THREAD_RESUME = ['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd', 'developerInstructions', 'excludeTurns', 'model', 'modelProvider', 'personality', 'sandbox', 'serviceTier', 'threadId']
const unknownField = (params, known) => {
  const extra = Object.keys(params ?? {}).filter(key => !known.includes(key))
  return extra.length === 0 ? undefined : `unknown field ${extra.join(', ')}`
}
const threads = new Map()
let nextId = 0
const requests = new Map()

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32602, message } })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
const notice = (method, params) => send({ jsonrpc: '2.0', method, params })
const ask = (method, params) => new Promise((resolve) => {
  const id = `srv-${++nextId}`
  requests.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})

// The shape Codex sends before an MCP tool call when approval_policy is on-request.
async function elicitTurn(thread, turnId, text) {
  const [, serverName, kind] = text.match(/elicit (\S+) (\S+)/)
  const answer = await ask('mcpServer/elicitation/request', {
    threadId: thread.id, turnId, serverName, mode: 'form',
    message: 'Allow the dsbot MCP server to run tool "list_bots"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: kind, tool_name: 'list_bots' },
  })
  const shown = answer.error !== undefined ? { error: answer.error.code } : answer.result
  notice('item/completed', { threadId: thread.id, item: { id: 'i1', type: 'agentMessage', text: JSON.stringify(shown) } })
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
}

function runTurn(thread, turnId, text, effort) {
  if (/elicit \S+ \S+/.test(text)) return void elicitTurn(thread, turnId, text)
  // What the thread was opened with, for a test that checks the fields.
  if (text.includes('show-thread')) {
    notice('item/completed', { threadId: thread.id, item: { id: 'i2', type: 'agentMessage', text: JSON.stringify(thread.params ?? {}) } })
    notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    return
  }
  if (!textOnly) {
    notice('item/started', { threadId: thread.id, item: { id: 'i1', type: 'commandExecution', command: 'ls' } })
    notice('item/completed', { threadId: thread.id, item: { id: 'i1', type: 'commandExecution', exitCode: 0 } })
  }
  notice('item/completed', { threadId: thread.id, item: { id: 'i2', type: 'agentMessage', text: `ok: ${text.slice(0, 60)} effort=${effort ?? 'none'}` } })
  thread.used = (thread.used ?? 25_000) + 800 + Number(text.match(/grow:(\d+)/)?.[1] ?? 0)
  usage(thread, turnId, { totalTokens: thread.used, inputTokens: thread.used - 6, cachedInputTokens: 12_288, cacheWriteInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 })
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
  if (exitAfterTurn) setTimeout(() => process.exit(0), 50)
}

const ZERO = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
function usage(thread, turnId, last) {
  const total = thread.total ?? ZERO
  thread.total = Object.fromEntries(Object.keys(ZERO).map(key => [key, total[key] + last[key]]))
  notice('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: thread.total, last, modelContextWindow: 475_000 } })
}

function compactTurn(thread) {
  const turnId = `turn-${++nextId}`
  notice('turn/started', { threadId: thread.id, turn: { id: turnId, status: 'inProgress' } })
  notice('item/started', { threadId: thread.id, turnId, item: { type: 'contextCompaction', id: 'cc1' } })
  thread.used = 29_000
  usage(thread, turnId, { ...ZERO, totalTokens: thread.used })
  notice('item/completed', { threadId: thread.id, turnId, item: { type: 'contextCompaction', id: 'cc1' } })
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
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
      case 'initialize': reply(id, { userAgent: 'fake-codex' }); break
      case 'initialized': break
      case 'model/list':
        reply(id, {
          data: [{
            id: 'gpt-5.1-codex',
            displayName: 'GPT-5.1 Codex',
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast responses' },
              { reasoningEffort: 'medium', description: 'Balanced speed and depth' },
              { reasoningEffort: 'high', description: 'Deep reasoning' },
            ],
          }],
        })
        break
      case 'thread/start': {
        record('thread/start', params)
        const extra = unknownField(params, THREAD_START)
        if (extra !== undefined) { replyError(id, extra); break }
        const thread = { id: `thr-${++nextId}`, params }
        threads.set(thread.id, thread)
        reply(id, { thread: { id: thread.id } })
        break
      }
      case 'thread/resume': {
        record('thread/resume', params)
        const extra = unknownField(params, THREAD_RESUME)
        if (extra !== undefined) { replyError(id, extra); break }
        const thread = threads.get(params.threadId) ?? { id: params.threadId }
        thread.params = params
        threads.set(thread.id, thread)
        reply(id, { thread: { id: params.threadId } })
        break
      }
      case 'thread/inject_items': reply(id, {}); break
      case 'turn/start': {
        const thread = threads.get(params.threadId)
        const turnId = `turn-${++nextId}`
        reply(id, { turn: { id: turnId } })
        const text = (params.input ?? []).map(item => item.text ?? '').join('\n')
        setImmediate(() => runTurn(thread ?? { id: params.threadId }, turnId, text, params.effort))
        break
      }
      case 'thread/compact/start': {
        reply(id, {})
        const thread = threads.get(params.threadId) ?? { id: params.threadId }
        threads.set(thread.id, thread)
        setImmediate(() => compactTurn(thread))
        break
      }
      case 'turn/interrupt': reply(id, {}); break
      case 'turn/steer': reply(id, {}); break
      default: if (id !== undefined) fail(id, `method not found: ${method}`)
    }
  }
})
