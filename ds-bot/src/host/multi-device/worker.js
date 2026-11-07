// A worker: one machine that a hub can send a command to. It dials the hub itself and
// holds the connection open (server-sent events), so the machine needs no listening port
// and no firewall rule. Every command is checked against the allowlist in policy.js and
// started without a shell, with a minimal environment.
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { arch, hostname as localHostname, platform as localPlatform, release, version as osVersion } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { checkCommand } from './policy.js'
import { parseEvents } from './sse.js'

export const VERSION = '0.1.0'

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

export function createWorker({ hubUrl, dataDir, name, code, log = () => {}, reconnectMs = 1000, maxReconnectMs = 30_000, heartbeatMs = 20_000, now = Date.now } = {}) {
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

  const info = () => ({
    status,
    nodeId: device?.nodeId,
    nodeName: device?.nodeName,
    hubUrl: base,
    lastError,
  })

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

  async function runTask(task) {
    const startedAt = now()
    const argv = Array.isArray(task.argv) ? task.argv : []
    const check = checkCommand(argv)
    if (!check.ok) {
      log('ds-bot lan: refused %s: %s', argv.join(' '), check.reason)
      await report(task.id, { stdout: '', stderr: `refused by the worker policy: ${check.reason}`, exitCode: 126, rejected: true, durationMs: 0 })
      return
    }
    const result = check.builtin
      ? { stdout: `${check.args.join(' ')}\n`, stderr: '', exitCode: 0, truncated: false }
      : await runCommand([check.program, ...check.args], task.timeoutMs ?? 30_000, dataDir)
    await report(task.id, { ...result, durationMs: now() - startedAt, startedAt: new Date(startedAt).toISOString() })
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
      await chain.catch(() => {})
      setStatus('stopped')
    },
  }
}
