// A worker: one machine that a hub can send a task to. It dials the hub itself and
// holds the connection open (server-sent events), so the machine needs no listening port
// and no firewall rule. Every task is checked against the protocol and the read-only
// allowlist, and no command goes through a shell; a child gets a minimal environment.
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { arch, hostname as localHostname, platform as localPlatform, release, version as osVersion } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { classifyCommand } from './policy.js'
import { MAX_FILE_BYTES, encodeContent, mimeOf, normalizeTaskSpec, resolveNodePath, taskNeedsApproval } from './protocol.js'
import { createSessionClient } from './session-client.js'
import { parseEvents } from './sse.js'

export const VERSION = '0.2.0'

const MAX_OUTPUT = 64 * 1024
const MAX_TIMEOUT_MS = 5 * 60_000
const RESULT_TRIES = 3
const HUB_TIMEOUT_MS = 30_000

function deviceFile(dataDir) {
  return join(dataDir, 'device.json')
}

function readDevice(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(deviceFile(dataDir), 'utf8'))
    if (typeof parsed?.token === 'string' && parsed.token !== '' && typeof parsed.nodeId === 'string') return parsed
  } catch {
    // No saved pairing yet, or one this version cannot read: pair again.
  }
  return undefined
}

function writeDevice(dataDir, device) {
  mkdirSync(dataDir, { recursive: true })
  const path = deviceFile(dataDir)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // A file system without modes keeps the 0600 write above.
    }
  }
}

// Only what a process needs to start: the hub's environment may hold model keys that a
// node has no business seeing.
function childEnv() {
  const keep = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']
  const env = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function append(existing, chunk, limit) {
  if (existing.length >= limit) return { text: existing, truncated: true }
  const text = chunk.toString('utf8')
  const room = limit - existing.length
  return text.length <= room ? { text: existing + text, truncated: false } : { text: existing + text.slice(0, room), truncated: true }
}

// Files a task names live beside the worker's own data unless the user gave an absolute
// path. Keeping relative paths in one workspace means a Bot cannot wander the disk by
// accident; an absolute path is the user's explicit choice and is allowed.
export function workspaceOf(dataDir) {
  return join(dataDir, 'workspace')
}

function readFileAt(path, maxBytes) {
  const info = statSync(path)
  if (!info.isFile()) throw new Error('that path is not a regular file')
  const size = info.size
  const wanted = Math.min(size, maxBytes, MAX_FILE_BYTES)
  const buffer = Buffer.alloc(wanted)
  const handle = openSync(path, 'r')
  let read = 0
  try {
    while (read < wanted) {
      const got = readSync(handle, buffer, read, wanted - read, read)
      if (got === 0) break
      read += got
    }
  } finally {
    closeSync(handle)
  }
  const body = buffer.subarray(0, read)
  return { buffer: body, size, truncated: size > read }
}

function writeFileAt(path, buffer) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, buffer, { mode: 0o600 })
  renameSync(temp, path)
}

function runCommand(argv, timeoutMs, cwd) {
  return new Promise(resolve => {
    const [program, ...args] = argv
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolve({ truncated, ...result, exitCode: timedOut ? 124 : result.exitCode })
    }
    let child
    try {
      child = spawn(program, args, { shell: false, windowsHide: true, env: childEnv(), cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ stdout, stderr: error.message, exitCode: 127 })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS))
    timer.unref?.()
    child.stdout?.on('data', chunk => {
      const next = append(stdout, chunk, MAX_OUTPUT)
      stdout = next.text
      if (next.truncated) truncated = true
    })
    child.stderr?.on('data', chunk => {
      const next = append(stderr, chunk, MAX_OUTPUT)
      stderr = next.text
      if (next.truncated) truncated = true
    })
    child.on('error', error => {
      clearTimeout(timer)
      finish({ stdout, stderr: `${stderr}${error.message}`, exitCode: 127 })
    })
    child.on('close', code => {
      clearTimeout(timer)
      finish({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 })
    })
  })
}

export function createWorker({ hubUrl, dataDir, name, code, sync, log = () => {}, reconnectMs = 1000, maxReconnectMs = 30_000, heartbeatMs = 20_000, now = Date.now } = {}) {
  if (typeof hubUrl !== 'string' || hubUrl === '') throw new Error('createWorker needs the hub URL')
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createWorker needs a dataDir')
  const base = hubUrl.replace(/\/+$/, '')
  let device = readDevice(dataDir)
  let status = device === undefined ? 'unpaired' : 'offline'
  let lastError
  let running = false
  let stopped = false
  let abort
  let heartbeat
  let chain = Promise.resolve()
  let connectResolvers = []
  let reconnectDelay = reconnectMs
  let session
  // `sync` is off by default in the library so a task-only worker stays one job; the
  // CLI turns it on, and `true` or a Bot id selects what to follow.
  const follow = sync === undefined || sync === null || sync === false
    ? undefined
    : sync === true
      ? { bot: 'main' }
      : typeof sync === 'string'
        ? { bot: sync }
        : sync

  const info = () => ({
    status,
    nodeId: device?.nodeId,
    nodeName: device?.nodeName,
    hubUrl: base,
    lastError,
    ...(session === undefined ? {} : { sync: session.info() }),
  })

  // The sync client is made once the device is paired, because it needs the token that
  // pairing wrote. A hub without the Bot team answers 503 and the client turns itself
  // off rather than retrying a route that will never exist.
  function startSession() {
    if (follow === undefined || session !== undefined || device === undefined) return
    session = createSessionClient({
      hubUrl: base,
      dataDir,
      token: device.token,
      bot: follow.bot,
      ...(Number.isInteger(follow.pollMs) ? { pollMs: follow.pollMs } : {}),
      ...(Number.isInteger(follow.waitMs) ? { waitMs: follow.waitMs } : {}),
      log,
      now,
    })
    void session.start()
  }

  function setStatus(next, error) {
    status = next
    lastError = error
    if (next === 'online') {
      for (const resolve of connectResolvers) resolve(info())
      connectResolvers = []
    }
  }

  async function pair(pairingCode) {
    const value = pairingCode ?? code
    if (typeof value !== 'string' || value === '') throw new Error('this device is not paired yet: pass the pairing code the hub printed')
    status = 'pairing'
    const response = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: value,
        device: {
          name: name ?? localHostname(),
          os: localPlatform(),
          platform: `${osVersion()} ${release()}`.trim(),
          arch: arch(),
          hostname: localHostname(),
          agentVersion: VERSION,
        },
      }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`pairing failed: ${body.error ?? `HTTP ${response.status}`}`)
    device = { nodeId: body.nodeId, nodeName: body.nodeName, token: body.token, hubUrl: base, pairedAt: new Date(now()).toISOString() }
    writeDevice(dataDir, device)
    setStatus('offline')
    log('ds-bot lan: paired as %s (%s)', device.nodeName, device.nodeId)
    return info()
  }

  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    })
    return response
  }

  async function report(taskId, result) {
    const payload = { taskId, ...result, finishedAt: new Date(now()).toISOString() }
    for (let attempt = 1; attempt <= RESULT_TRIES; attempt += 1) {
      try {
        const response = await post('/result', payload)
        if (response.ok) return true
        if (response.status === 403 || response.status === 404) {
          log('ds-bot lan: the hub refused result for task %s (HTTP %s)', taskId, response.status)
          return false
        }
      } catch (error) {
        lastError = error.message
      }
      if (attempt < RESULT_TRIES) await delay(300 * attempt)
    }
    log('ds-bot lan: could not deliver the result of task %s', taskId)
    return false
  }

  // A task is refused here as well as on the hub: the mark is checked on this side, so
  // a hub bug cannot turn into an unapproved write on the machine.
  function refuseTask(task, reason) {
    log('ds-bot lan: refused task %s (%s): %s', task.id, task.kind ?? 'shell', reason)
    return report(task.id, { stdout: '', stderr: `refused by the worker policy: ${reason}`, exitCode: 126, rejected: true, durationMs: 0 })
  }

  async function runTask(task) {
    const startedAt = now()
    const normalized = normalizeTaskSpec(task)
    if (!normalized.ok) return refuseTask(task, normalized.reason)
    const spec = normalized.spec
    if (taskNeedsApproval(spec) && task.approved !== true) {
      return refuseTask(task, 'this task needs the user\'s approval on the hub and was not approved')
    }
    try {
      if (spec.kind === 'shell') {
        const check = classifyCommand(spec.argv)
        if (!check.ok) return refuseTask(task, check.reason)
        const result = check.safe === true && spec.argv[0] === 'echo'
          ? { stdout: `${spec.argv.slice(1).join(' ')}\n`, stderr: '', exitCode: 0, truncated: false }
          : await runCommand(spec.argv, task.timeoutMs ?? 30_000, dataDir)
        await report(task.id, { ...result, durationMs: now() - startedAt, startedAt: new Date(startedAt).toISOString() })
        return
      }
      const path = resolveNodePath(spec.path, workspaceOf(dataDir))
      if (!path.ok) return refuseTask(task, path.reason)
      if (spec.kind === 'read_file' || (spec.kind === 'transfer' && spec.direction === 'get')) {
        const file = readFileAt(path.path, spec.maxBytes)
        const encoded = encodeContent(file.buffer, spec.encoding)
        await report(task.id, {
          stdout: '',
          stderr: '',
          exitCode: 0,
          file: { path: path.path, size: file.size, mime: mimeOf(path.path), encoding: encoded.encoding, data: encoded.data, truncated: file.truncated },
          durationMs: now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
        })
        return
      }
      const buffer = spec.encoding === 'base64' ? Buffer.from(spec.data, 'base64') : Buffer.from(spec.data, 'utf8')
      if (buffer.length > MAX_FILE_BYTES) return refuseTask(task, `the file is larger than ${MAX_FILE_BYTES} bytes`)
      writeFileAt(path.path, buffer)
      log('ds-bot lan: wrote %d bytes to %s', buffer.length, path.path)
      await report(task.id, {
        stdout: `Wrote ${buffer.length} bytes to ${path.path}\n`,
        stderr: '',
        exitCode: 0,
        durationMs: now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
      })
    } catch (error) {
      log('ds-bot lan: task %s failed: %s', task.id, error.message)
      await report(task.id, { stdout: '', stderr: error.message, exitCode: 1, durationMs: now() - startedAt })
    }
  }

  function enqueue(task) {
    chain = chain.then(() => runTask(task)).catch(error => log('ds-bot lan: task %s failed: %s', task?.id, error.message))
  }

  function startHeartbeat() {
    clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (device === undefined) return
      post('/heartbeat', {}).catch(error => {
        lastError = error.message
      })
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  async function connectOnce() {
    abort = new AbortController()
    const response = await fetch(`${base}/stream`, {
      headers: { authorization: `Bearer ${device.token}`, accept: 'text/event-stream' },
      signal: abort.signal,
    })
    if (response.status === 401) {
      const error = new Error('the hub does not know this device; pair it again')
      error.fatal = true
      throw error
    }
    if (!response.ok || response.body === null) throw new Error(`the hub stream failed: HTTP ${response.status}`)
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const { events, rest } = parseEvents(buffer)
      buffer = rest
      for (const { event, data } of events) {
        if (event === 'ready') {
          reconnectDelay = reconnectMs
          setStatus('online')
          log('ds-bot lan: connected to %s as %s', base, device.nodeName)
          startHeartbeat()
          startSession()
        } else if (event === 'task') {
          enqueue(data)
        }
      }
    }
  }

  async function connectLoop() {
    while (!stopped) {
      try {
        await connectOnce()
        setStatus('offline')
      } catch (error) {
        if (stopped) break
        if (error.fatal) {
          running = false
          setStatus('unauthorized', error.message)
          log('ds-bot lan: %s', error.message)
          return
        }
        if (error.name !== 'AbortError') setStatus('offline', error.message)
      }
      if (stopped) break
      const wait = reconnectDelay
      reconnectDelay = Math.min(maxReconnectMs, Math.round(reconnectDelay * 2))
      await delay(wait)
    }
  }

  return {
    info,
    get nodeId() {
      return device?.nodeId
    },
    get token() {
      return device?.token
    },
    get status() {
      return status
    },
    // The conversation replica this node follows, when `sync` named one.
    session: () => session,
    paired: () => device !== undefined,
    pair,
    async start() {
      if (!device) await pair()
      if (running) return info()
      running = true
      stopped = false
      void connectLoop()
      return info()
    },
    connected({ timeoutMs = 10_000 } = {}) {
      if (status === 'online') return Promise.resolve(info())
      if (status === 'unauthorized') return Promise.reject(new Error(lastError ?? 'the hub refused this device'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the worker did not connect within ${timeoutMs} ms`)), timeoutMs)
        timer.unref?.()
        connectResolvers.push(value => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    async stop() {
      stopped = true
      running = false
      clearInterval(heartbeat)
      abort?.abort()
      await session?.stop()
      await chain.catch(() => {})
      setStatus('stopped')
    },
  }
}
