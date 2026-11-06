// A fake Codex app-server for tests: `codex app-server --listen stdio://`
// dialect, newline JSON-RPC. The turn's first text picks the behavior:
//   "ask"      -> an approval request the client must answer
//   otherwise  -> an activity item, an agentMessage, turn/completed
const threads = new Map()
let nextId = 0
const requests = new Map()

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
const notice = (method, params) => send({ jsonrpc: '2.0', method, params })

function runTurn(thread, turnId, text) {
  notice('item/started', { threadId: thread.id, item: { id: 'i1', type: 'commandExecution', command: 'ls' } })
  notice('item/completed', { threadId: thread.id, item: { id: 'i1', type: 'commandExecution', exitCode: 0 } })
  notice('item/completed', { threadId: thread.id, item: { id: 'i2', type: 'agentMessage', text: `ok: ${text.slice(0, 60)}` } })
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
      case 'model/list': reply(id, { data: [{ id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex' }] }); break
      case 'thread/start': {
        const thread = { id: `thr-${++nextId}` }
        threads.set(thread.id, thread)
        reply(id, { thread: { id: thread.id } })
        break
      }
      case 'thread/resume': reply(id, { thread: { id: params.threadId } }); break
      case 'thread/inject_items': reply(id, {}); break
      case 'turn/start': {
        const thread = threads.get(params.threadId)
        const turnId = `turn-${++nextId}`
        reply(id, { turn: { id: turnId } })
        const text = (params.input ?? []).map(item => item.text ?? '').join('\n')
        setImmediate(() => runTurn(thread ?? { id: params.threadId }, turnId, text))
        break
      }
      case 'turn/interrupt': reply(id, {}); break
      case 'turn/steer': reply(id, {}); break
      default: if (id !== undefined) fail(id, `method not found: ${method}`)
    }
  }
})
