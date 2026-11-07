// The node side of the conversation sync: a read replica of one Bot's current part,
// pulled from the hub by revision, plus a send that the hub applies to the Session.
// The replica is not a second team: nothing here writes team state, and this process
// never opens the Session. Reconnect is just another pull with the cursor it saved.
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_MESSAGE_CHARS = 32 * 1024

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function replicaDir(dataDir) {
  return join(dataDir, 'sync')
}

export function replicaFile(dataDir, botId) {
  const safe = String(botId ?? 'bot').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'bot'
  return join(replicaDir(dataDir), `${safe}.json`)
}

function readReplica(dataDir, botId) {
  try {
    const parsed = JSON.parse(readFileSync(replicaFile(dataDir, botId), 'utf8'))
    if (typeof parsed?.epoch === 'string' && Number.isInteger(parsed.revision) && Array.isArray(parsed.items)) return parsed
  } catch {
    // No replica yet, or one this version cannot read: start from a full snapshot.
  }
  return undefined
}

function writeReplica(dataDir, replica) {
  const dir = replicaDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = replicaFile(dataDir, replica.botId)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(replica, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // A file system without modes keeps the 0600 write above.
    }
  }
}

// Abort either on stop or when the request runs long past the hub's own wait, so a
// silent network does not hold the loop forever. The caller's controller is not
// consumed by the timeout, so the next pull still listens to stop().
function requestSignal(outer, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('the hub did not answer in time')), timeoutMs)
  timer.unref?.()
  const forward = () => controller.abort()
  outer?.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    },
  }
}

const failure = (message, { fatal = false, code } = {}) => Object.assign(new Error(message), { fatal, code })

export function createSessionClient({
  hubUrl,
  dataDir,
  token,
  bot = 'main',
  pollMs = 2_000,
  waitMs = 20_000,
  log = () => {},
  now = Date.now,
} = {}) {
  if (typeof hubUrl !== 'string' || hubUrl === '') throw new Error('createSessionClient needs the hub URL')
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createSessionClient needs a dataDir')
  if (typeof token !== 'string' || token === '') throw new Error('createSessionClient needs the device token')
  const base = hubUrl.replace(/\/+$/, '')
  const controller = new AbortController()

  let status = 'idle'
  let lastError
  let lastSyncedAt
  let botId
  let botName
  let replica
  let running = false
  let stopped = false
  let loopPromise
  let backoff = Math.max(500, Math.min(pollMs, 5_000))

  const iso = () => new Date(now()).toISOString()

  function info() {
    return {
      status,
      supported: status !== 'unsupported',
      botId,
      botName,
      epoch: replica?.epoch,
      revision: replica?.revision,
      sessionId: replica?.sessionId,
      items: replica?.items?.length ?? 0,
      lastSyncedAt,
      lastError,
      pollMs,
      waitMs,
    }
  }

  async function request(path, init = {}) {
    const link = requestSignal(controller.signal, init.timeoutMs ?? (waitMs + REQUEST_TIMEOUT_MS))
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        signal: link.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
    } finally {
      link.done()
    }
  }

  async function bots() {
    const response = await request('/session/bots')
    if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
    if (response.status === 503) return { unsupported: true, bots: [] }
    if (!response.ok) throw failure(`the hub refused the Bot list: HTTP ${response.status}`)
    return response.json()
  }

  async function resolveBot() {
    if (botId !== undefined) return botId
    const answer = await bots()
    if (answer.unsupported === true) {
      const error = failure('this hub does not serve a conversation', { code: 'bot/unsupported' })
      error.unsupported = true
      throw error
    }
    const list = Array.isArray(answer.bots) ? answer.bots : []
    const wanted = typeof bot === 'string' && bot !== '' ? bot : 'main'
    const found = wanted === 'main' || wanted === 'auto'
      ? (list.find(entry => entry.main) ?? list[0])
      : (list.find(entry => entry.id === wanted) ?? list.find(entry => entry.name === wanted))
    if (found === undefined) {
      const error = failure(`the hub has no Bot named ${wanted}`, { code: 'bot/not-found' })
      error.unknownBot = true
      throw error
    }
    botId = found.id
    botName = found.name
    replica = readReplica(dataDir, botId)
    return botId
  }

  async function pullOnce() {
    const id = await resolveBot()
    const query = new URLSearchParams({ bot: id, wait: String(Math.max(0, waitMs)) })
    if (replica !== undefined) {
      query.set('since', String(replica.revision))
      if (typeof replica.epoch === 'string') query.set('epoch', replica.epoch)
    }
    const response = await request(`/session?${query.toString()}`)
    if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
    if (response.status === 503) return { unsupported: true }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 404) {
        botId = undefined
        throw failure(body.error ?? 'the Bot is no longer on the hub', { code: 'bot/not-found' })
      }
      throw failure(body.error ?? `the hub refused the snapshot: HTTP ${response.status}`)
    }
    lastSyncedAt = iso()
    if (body.unchanged === true) {
      status = 'syncing'
      return { unchanged: true, revision: body.revision, epoch: body.epoch }
    }
    const next = {
      version: 1,
      epoch: String(body.epoch ?? ''),
      revision: Number.isInteger(body.revision) ? body.revision : 0,
      botId: String(body.botId ?? id),
      botName: body.botName ?? botName ?? null,
      sessionId: body.sessionId ?? null,
      items: Array.isArray(body.items) ? body.items : [],
      hidden: Number.isInteger(body.hidden) ? body.hidden : 0,
      updatedAt: body.updatedAt ?? null,
      savedAt: iso(),
    }
    replica = next
    botId = next.botId
    writeReplica(dataDir, next)
    status = 'syncing'
    return { ...next, reset: body.reset === true }
  }

  async function loop() {
    while (!stopped) {
      try {
        const result = await pullOnce()
        if (result.unsupported === true) {
          status = 'unsupported'
          log('ds-bot lan: this hub does not serve a conversation; session sync is off')
          return
        }
        lastError = undefined
        backoff = Math.max(500, Math.min(pollMs, 5_000))
        if (result.unchanged !== true) continue
        // A hub that answered the long poll at once would otherwise spin.
        await sleep(Math.min(250, pollMs))
      } catch (error) {
        if (stopped || controller.signal.aborted || error?.name === 'AbortError') break
        if (error?.fatal === true) {
          status = 'unauthorized'
          lastError = error.message
          log('ds-bot lan: session sync stopped: %s', error.message)
          return
        }
        status = 'offline'
        lastError = error.message
        if (error?.unknownBot === true) botId = undefined
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  return {
    info,
    view: () => replica,
    pull: pullOnce,
    // A message typed on this machine goes to the hub, which writes it into the one
    // Session; the reply comes back through the same pull as any other message.
    async send(text, { messageId = randomUUID() } = {}) {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') throw new Error('the message is empty')
      if (value.length > MAX_MESSAGE_CHARS) throw new Error(`the message is longer than ${MAX_MESSAGE_CHARS} characters`)
      const id = await resolveBot()
      const response = await request('/session', {
        method: 'POST',
        body: JSON.stringify({ botId: id, text: value, messageId }),
      })
      const body = await response.json().catch(() => ({}))
      if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
      if (!response.ok) throw failure(body.error ?? `the hub refused the message: HTTP ${response.status}`)
      if (!running) void pullOnce().catch(error => { lastError = error.message })
      return { ...body, messageId }
    },
    async start() {
      if (running) return info()
      running = true
      stopped = false
      loopPromise = loop()
      return info()
    },
    async stop() {
      stopped = true
      running = false
      controller.abort()
      await loopPromise?.catch(() => {})
      status = 'stopped'
    },
  }
}
