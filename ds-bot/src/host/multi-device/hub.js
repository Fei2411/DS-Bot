// The hub: the machine the user sits at. It hands out pairing codes, keeps the node
// registry, holds the task queue, and pushes tasks down each node's open stream. A node
// always connects outward, so a Windows worker needs no listening port or firewall rule.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createCodeStore, newToken } from './pairing.js'
import { createRegistry } from './registry.js'
import { writeEvent, writePing } from './sse.js'

export const PROTOCOL = 1
export const VERSION = '0.1.0'

const MAX_BODY = 256 * 1024
const MAX_OUTPUT = 128 * 1024
const STREAM_PING_MS = 15_000
const DEFAULT_TASK_TIMEOUT_MS = 30_000
const MAX_TASK_TIMEOUT_MS = 5 * 60_000
const TASK_GRACE_MS = 5_000
const MAX_TASKS = 500
const PAIR_WINDOW_MS = 5 * 60_000
const PAIR_TRIES = 10

const TERMINAL = new Set(['done', 'failed', 'rejected', 'timeout', 'cancelled'])
const terminal = state => TERMINAL.has(state)

const badRequest = (message, status = 400) => Object.assign(new Error(message), { status })

function send(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(badRequest('request body is too large', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(badRequest('request body is not JSON'))
      }
    })
    request.on('error', reject)
  })
}

const bearer = request => {
  const value = String(request.headers.authorization ?? '')
  const [scheme, token] = value.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
}

const sameSecret = (left, right) => {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

const capped = (value, limit) => {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated by the hub]`
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function adminToken(dataDir) {
  const file = join(dataDir, 'admin.token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return { token: existing, file, created: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const token = randomBytes(24).toString('base64url')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
    } catch {
      // A file system without modes keeps the 0600 write above.
    }
  }
  return { token, file, created: true }
}

export function createHub({ dataDir, host = '0.0.0.0', port = 8787, name = 'DS Bot hub', log = () => {}, now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createHub needs a dataDir')
  mkdirSync(dataDir, { recursive: true })
  const registry = createRegistry({ dataDir, now, log })
  const secret = adminToken(dataDir)
  const codes = createCodeStore({ now })
  const events = new EventEmitter()
  const tasks = new Map()
  const taskTimers = new Map()
  const waiters = new Map()
  const streams = new Map()
  const pairFailures = new Map()

  let server
  let boundPort = port
  let url = ''
  let stopped = false

  function publicNode(node) {
    const { tokenHash, ...rest } = node
    return { ...rest, online: streams.has(node.id) }
  }

  function publicTask(task) {
    return { ...task, result: task.result === undefined ? undefined : { ...task.result } }
  }

  function settle(task, patch) {
    if (terminal(task.state)) return task
    Object.assign(task, patch, { finishedAt: new Date(now()).toISOString() })
    const timer = taskTimers.get(task.id)
    if (timer !== undefined) {
      clearTimeout(timer)
      taskTimers.delete(task.id)
    }
    const set = waiters.get(task.id)
    if (set !== undefined) {
      waiters.delete(task.id)
      for (const resolve of set) resolve(publicTask(task))
    }
    events.emit('task', publicTask(task))
    // One task runs per node, so the next queued one goes out now that this one is done.
    flush(task.nodeId)
    return task
  }

  function armTimeout(task) {
    const timer = setTimeout(() => {
      settle(task, {
        state: 'timeout',
        result: { stdout: '', stderr: `the node did not return a result within ${task.timeoutMs} ms`, exitCode: 124 },
      })
    }, task.timeoutMs + TASK_GRACE_MS)
    timer.unref?.()
    taskTimers.set(task.id, timer)
  }

  // Sends the oldest queued task of a node, unless one of its tasks is already running.
  function flush(nodeId) {
    const stream = streams.get(nodeId)
    if (stream === undefined) return
    for (const task of tasks.values()) {
      if (task.nodeId !== nodeId) continue
      if (task.state === 'sent') return
      if (task.state !== 'queued') continue
      task.state = 'sent'
      task.sentAt = new Date(now()).toISOString()
      writeEvent(stream.response, 'task', { id: task.id, argv: task.argv, timeoutMs: task.timeoutMs })
      armTimeout(task)
      return
    }
  }

  function dropStream(nodeId, response) {
    const stream = streams.get(nodeId)
    if (stream === undefined) return
    if (response !== undefined && stream.response !== response) return
    clearInterval(stream.interval)
    streams.delete(nodeId)
    if (!stream.response.writableEnded) stream.response.end()
    // A task that was on its way when the stream broke goes back to the queue: the node
    // runs it again after reconnecting, which can repeat a command but never loses one.
    for (const task of tasks.values()) {
      if (task.nodeId !== nodeId || task.state !== 'sent') continue
      const timer = taskTimers.get(task.id)
      if (timer !== undefined) clearTimeout(timer)
      taskTimers.delete(task.id)
      task.state = 'queued'
      delete task.sentAt
    }
    const node = registry.find(nodeId)
    if (node !== undefined) events.emit('offline', publicNode(node))
  }

  function handleStream(request, response) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    // A reconnect replaces the old stream: the worker only ever reads one.
    dropStream(node.id)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders?.()
    writeEvent(response, 'ready', { protocol: PROTOCOL, nodeId: node.id, nodeName: node.name, hub: name, version: VERSION })
    const interval = setInterval(() => {
      if (!response.writableEnded) writePing(response)
    }, STREAM_PING_MS)
    interval.unref?.()
    streams.set(node.id, { response, interval })
    registry.touch(node.id)
    events.emit('online', publicNode(node))
    const close = () => dropStream(node.id, response)
    request.on('close', close)
    response.on('close', close)
    flush(node.id)
  }

  async function handlePair(request, response) {
    const address = request.socket.remoteAddress ?? 'unknown'
    const failures = (pairFailures.get(address) ?? []).filter(at => now() - at < PAIR_WINDOW_MS)
    if (failures.length >= PAIR_TRIES) {
      pairFailures.set(address, failures)
      return send(response, 429, { error: 'too many pairing attempts; wait a few minutes' })
    }
    const body = await readJson(request)
    if (codes.redeem(body.code) !== true) {
      failures.push(now())
      pairFailures.set(address, failures)
      return send(response, 403, { error: 'pairing code is invalid or expired' })
    }
    const device = body.device && typeof body.device === 'object' ? body.device : {}
    const token = newToken()
    const node = registry.add({
      name: device.name,
      token,
      os: device.os,
      platform: device.platform,
      arch: device.arch,
      hostname: device.hostname,
      agentVersion: device.agentVersion,
    })
    log('ds-bot lan: paired %s as %s', node.name, node.id)
    events.emit('paired', publicNode(node))
    send(response, 200, { protocol: PROTOCOL, hub: name, nodeId: node.id, nodeName: node.name, token })
  }

  async function handleResult(request, response) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    const body = await readJson(request)
    const task = tasks.get(String(body.taskId ?? ''))
    if (task === undefined) return send(response, 404, { error: 'no such task' })
    if (task.nodeId !== node.id) return send(response, 403, { error: 'this task belongs to another node' })
    if (terminal(task.state)) return send(response, 200, { ok: true, duplicate: true })
    const exitCode = Number.isInteger(body.exitCode) ? body.exitCode : 1
    settle(task, {
      state: body.rejected === true ? 'rejected' : exitCode === 0 ? 'done' : 'failed',
      result: {
        exitCode,
        stdout: capped(body.stdout, MAX_OUTPUT),
        stderr: capped(body.stderr, MAX_OUTPUT),
        durationMs: Number.isFinite(body.durationMs) ? Math.max(0, Math.round(body.durationMs)) : undefined,
        rejected: body.rejected === true,
      },
    })
    registry.touch(node.id)
    send(response, 200, { ok: true })
  }

  async function handleAdmin(request, response, path) {
    const given = String(request.headers['x-admin-token'] ?? '')
    if (!sameSecret(given, secret.token)) return send(response, 401, { error: 'the admin token is required' })

    if (request.method === 'POST' && path === '/admin/pair-code') {
      const issued = codes.issue()
      log('ds-bot lan: pairing code %s issued', issued.code)
      return send(response, 200, issued)
    }
    if (request.method === 'GET' && path === '/admin/nodes') {
      return send(response, 200, { nodes: registry.list().map(publicNode), count: streams.size })
    }
    if (request.method === 'POST' && path === '/admin/tasks') {
      const body = await readJson(request)
      const task = dispatch({ node: body.node, argv: body.argv, timeoutMs: body.timeoutMs })
      return send(response, 200, { task: publicTask(task) })
    }
    const match = /^\/admin\/tasks\/([A-Za-z0-9_]+)$/.exec(path)
    if (request.method === 'GET' && match) {
      const task = tasks.get(match[1])
      if (task === undefined) return send(response, 404, { error: 'no such task' })
      return send(response, 200, { task: publicTask(task) })
    }
    return send(response, 404, { error: 'not found' })
  }

  async function handle(request, response) {
    const path = new URL(request.url ?? '/', 'http://hub').pathname
    if (request.method === 'GET' && path === '/health') {
      return send(response, 200, { ok: true, hub: name, version: VERSION, protocol: PROTOCOL, nodes: registry.list().length })
    }
    if (request.method === 'POST' && path === '/pair') return handlePair(request, response)
    if (request.method === 'GET' && path === '/stream') return handleStream(request, response)
    if (request.method === 'POST' && path === '/heartbeat') {
      const node = registry.findByToken(bearer(request))
      if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
      registry.touch(node.id)
      return send(response, 200, { ok: true, time: new Date(now()).toISOString() })
    }
    if (request.method === 'POST' && path === '/result') return handleResult(request, response)
    if (path.startsWith('/admin/')) return handleAdmin(request, response, path)
    return send(response, 404, { error: 'not found' })
  }

  function dispatch({ node, argv, timeoutMs }) {
    const target = registry.find(node)
    if (target === undefined) throw Object.assign(new Error(`no paired node named ${node ?? ''}`), { code: 'no-node', status: 400 })
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(part => typeof part === 'string' && part !== '')) {
      throw Object.assign(new Error('argv must be a non-empty list of strings'), { code: 'bad-argv', status: 400 })
    }
    const wanted = Number.isInteger(timeoutMs) ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS
    const task = {
      id: `tk_${randomBytes(6).toString('hex')}`,
      nodeId: target.id,
      nodeName: target.name,
      argv: [...argv],
      timeoutMs: Math.min(Math.max(wanted, 1000), MAX_TASK_TIMEOUT_MS),
      state: 'queued',
      createdAt: new Date(now()).toISOString(),
    }
    tasks.set(task.id, task)
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value
      const entry = tasks.get(oldest)
      if (!terminal(entry.state)) break
      tasks.delete(oldest)
    }
    if (streams.has(target.id)) flush(target.id)
    else log('ds-bot lan: %s is offline; task %s waits for it', target.name, task.id)
    return task
  }

  function waitForTask(id, { timeoutMs = 60_000 } = {}) {
    const task = tasks.get(id)
    if (task === undefined) return Promise.reject(new Error(`no such task: ${id}`))
    if (terminal(task.state)) return Promise.resolve(publicTask(task))
    return new Promise((resolve, reject) => {
      const set = waiters.get(id) ?? new Set()
      waiters.set(id, set)
      const timer = setTimeout(() => {
        set.delete(done)
        reject(new Error(`task ${id} did not finish within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      const done = value => {
        clearTimeout(timer)
        resolve(value)
      }
      set.add(done)
    })
  }

  return {
    get url() {
      return url
    },
    get port() {
      return boundPort
    },
    get dataDir() {
      return dataDir
    },
    get adminTokenFile() {
      return secret.file
    },
    get adminToken() {
      return secret.token
    },
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
    nodes: () => registry.list().map(publicNode),
    isOnline: nodeId => streams.has(nodeId),
    issueCode: () => codes.issue(),
    dispatch,
    task: id => (tasks.has(id) ? publicTask(tasks.get(id)) : undefined),
    waitForTask,
    dropStream: nodeId => dropStream(nodeId),
    async start() {
      if (server !== undefined) return { url, port: boundPort }
      server = createServer((request, response) => {
        handle(request, response).catch(error => {
          const status = error?.status ?? 500
          if (status >= 500) log('ds-bot lan: %s %s failed: %s', request.method, request.url, error.message)
          if (!response.headersSent) send(response, status, { error: status >= 500 ? 'internal error' : error.message })
          else response.end()
        })
      })
      await new Promise((resolve, reject) => {
        const failed = error => reject(error)
        server.once('error', failed)
        server.listen(port, host, () => {
          server.off('error', failed)
          resolve()
        })
      })
      const address = server.address()
      if (address !== null && typeof address === 'object') boundPort = address.port
      const display = host === '0.0.0.0' || host === '::' ? lanAddress() : host
      url = `http://${display}:${boundPort}`
      return { url, port: boundPort }
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const nodeId of streams.keys()) dropStream(nodeId)
      for (const timer of taskTimers.values()) clearTimeout(timer)
      taskTimers.clear()
      if (server !== undefined) {
        const closing = new Promise(resolve => server.close(() => resolve()))
        server.closeAllConnections?.()
        await closing
        server = undefined
      }
      registry.save(true)
    },
  }
}
