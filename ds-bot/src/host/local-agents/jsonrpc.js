// Newline-delimited JSON-RPC over a child process's stdio: requests we send,
// answers and server-initiated requests we receive. Shared by the ACP and the
// Codex app-server engines.
import { randomUUID } from 'node:crypto'

// One wire message is one JSON value on one line.
export class JsonRpcPeer {
  constructor(write) {
    this.write = write
    this.nextId = 0
    this.pending = new Map()
    this.requestHandler = undefined
    this.notificationHandler = undefined
    this.closed = undefined
  }

  // The process ended: every request still waiting fails.
  close(error = new Error('the connection closed')) {
    for (const [, call] of this.pending) call.reject(error)
    this.pending.clear()
    this.closed?.()
  }

  handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const call = this.pending.get(message.id)
      if (call === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) call.reject(Object.assign(new Error(errorMessage(message.error)), { code: message.error?.code, data: message.error?.data }))
      else call.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    if (message.id !== undefined) {
      const respond = (result) => this.write({ jsonrpc: '2.0', id: message.id, result })
      const refuse = (error) => this.write({ jsonrpc: '2.0', id: message.id, error: typeof error === 'object' && error !== null ? { code: error.code ?? -32603, message: String(error.message ?? error) } : { code: -32603, message: String(error) } })
      try {
        const answer = this.requestHandler?.(message.method, message.params, message)
        if (answer === undefined) { refuse({ code: -32601, message: `method not found: ${message.method}` }); return }
        Promise.resolve(answer).then(respond, refuse)
      } catch (error) { refuse(error) }
      return
    }
    try { this.notificationHandler?.(message.method, message.params, message) } catch { /* one bad notice is dropped */ }
  }

  request(method, params, { signal, timeout = 120_000 } = {}) {
    if (signal?.aborted) return Promise.reject(rejectReason(signal.reason))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      let timer
      const call = {
        resolve: (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error) },
      }
      const onAbort = () => call.reject(rejectReason(signal.reason))
      this.pending.set(id, call)
      if (timeout > 0) timer = setTimeout(() => { if (this.pending.delete(id)) call.reject(new Error(`${method} timed out`)) }, timeout)
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.pending.delete(id)
        call.reject(error)
      }
    })
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }
}

// Feeds stdout into a peer line by line; resolves when the process ends.
export function wireProcess(child, peer) {
  // A write that meets a process on its way out fails with EPIPE. Its exit already
  // ends what waits on it; an unheard stream error would take DS Bot down.
  child.stdin.on('error', () => {})
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    let at
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at).trim()
      rest = rest.slice(at + 1)
      if (line !== '') peer.handleLine(line)
    }
  })
  return rest
}

export const newCallId = () => randomUUID()

// A waitable event stream attached to one CLI session/thread: the engine pushes
// normalized events, the adapter drains them per stream() call.
export class EventQueue {
  constructor() {
    this.events = []
    this.waiters = []
  }
  push(event) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(event)
    else this.events.push(event)
  }
  next() {
    if (this.events.length > 0) return Promise.resolve(this.events.shift())
    return new Promise(resolve => this.waiters.push(resolve))
  }
  clear() { this.events.length = 0 }
}

// JSON-RPC error.message is sometimes an object. `new Error(object)` stringifies
// it as "[object Object]", which is what the turn would then show.
function errorMessage(error) {
  if (typeof error === 'string') return error === '' ? 'request failed' : error
  if (error == null || typeof error !== 'object') return 'request failed'
  const message = error.message
  if (typeof message === 'string' && message !== '' && message !== '[object Object]') return message
  if (message !== null && typeof message === 'object') {
    if (typeof message.text === 'string' && message.text !== '') return message.text
    try {
      const json = JSON.stringify(message)
      if (json && json !== '{}' && json !== 'null') return json
    } catch { /* fall through */ }
  }
  if (typeof error.data === 'string' && error.data !== '') return error.data
  for (const key of ['text', 'detail', 'reason']) {
    if (typeof error[key] === 'string' && error[key] !== '') return error[key]
  }
  try {
    const json = JSON.stringify(error)
    if (json && json !== '{}' && json !== 'null') return json
  } catch { /* fall through */ }
  return 'request failed'
}

function rejectReason(reason) {
  if (reason instanceof Error && reason.message !== '[object Object]') return reason
  if (typeof reason === 'string' && reason !== '') return new Error(reason)
  if (reason !== null && typeof reason === 'object') return Object.assign(new Error(errorMessage(reason)), reason.code === undefined ? {} : { code: reason.code })
  return new Error('aborted')
}
