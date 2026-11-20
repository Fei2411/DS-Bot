// Local Push event ingest (aligned with the v0.4.0 external API design):
//   POST http://127.0.0.1:<port>/v1/events
// Off by default, binds strictly to 127.0.0.1, authenticates via Authorization: Bearer
// against hashed tokens in <home>/api-tokens.json (never URL query), enforces body size
// caps and allowedTargets throughout routing, and closes keep-alive sockets cleanly.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const DEFAULT_PORT = 17830
const MAX_BODY_BYTES = 256 * 1024
const TOKEN_PREFIX = 'dsb_live_'
const LAST_USED_THROTTLE_MS = 60_000

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

function hashSecret(salt, secret) {
  return createHash('sha256').update(`${salt}:${secret}`).digest('hex')
}

export function createPushGateway(rt, { onEvent }) {
  const configPath = join(rt.home, 'events', 'push.json')
  const tokensPath = join(rt.home, 'api-tokens.json')
  const endpointPath = join(rt.home, 'api-endpoint.json')
  const instanceId = randomBytes(6).toString('hex')

  let config = readJson(configPath, { enabled: false, port: DEFAULT_PORT })
  let tokens = readJson(tokensPath, [])
  if (!Array.isArray(tokens)) tokens = []
  let server = null
  let boundPort = null
  let lifecycle = Promise.resolve()

  const writes = () => rt.readOnly?.() === undefined
  const saveConfig = () => { if (writes()) writeJsonAtomic(configPath, config) }
  const saveTokens = () => { if (writes()) writeJsonAtomic(tokensPath, tokens) }

  function reloadTokens() {
    const loaded = readJson(tokensPath, [])
    if (Array.isArray(loaded)) tokens = loaded
  }

  function verifyToken(authHeader, reqUrl) {
    try {
      if (typeof reqUrl === 'string' && /[?&](?:token|api_key|access_token)=/i.test(reqUrl)) {
        return { ok: false, status: 401, error: 'Tokens must be sent in the Authorization header, not in URL parameters' }
      }
      const raw = typeof authHeader === 'string' ? authHeader.trim() : ''
      if (!raw.startsWith('Bearer ')) return { ok: false, status: 401, error: 'Unauthorized' }
      const presented = raw.slice('Bearer '.length).trim()
      if (!presented.startsWith(TOKEN_PREFIX)) return { ok: false, status: 401, error: 'Unauthorized' }
      const rest = presented.slice(TOKEN_PREFIX.length)
      const sep = rest.indexOf('_')
      if (sep <= 0) return { ok: false, status: 401, error: 'Unauthorized' }
      const keyId = rest.slice(0, sep)
      const secret = rest.slice(sep + 1)

      reloadTokens()
      const entry = tokens.find(item => item && item.keyId === keyId && item.revoked !== true)
      if (!entry || typeof entry.salt !== 'string' || typeof entry.hash !== 'string') {
        return { ok: false, status: 401, error: 'Unauthorized' }
      }
      if (entry.expiresAt && Date.now() >= entry.expiresAt) return { ok: false, status: 401, error: 'Token expired' }
      const actual = Buffer.from(hashSecret(entry.salt, secret), 'hex')
      const expected = Buffer.from(entry.hash, 'hex')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return { ok: false, status: 401, error: 'Unauthorized' }
      }
      const scopes = Array.isArray(entry.scopes) ? entry.scopes : []
      if (!scopes.includes('events:write') && !scopes.includes('*')) {
        return { ok: false, status: 403, error: 'Forbidden' }
      }
      const now = Date.now()
      if (!entry.lastUsedAt || now - entry.lastUsedAt >= LAST_USED_THROTTLE_MS) {
        entry.lastUsedAt = now
        try { saveTokens() } catch { /* best-effort metadata update */ }
      }
      return { ok: true, token: entry }
    } catch {
      return { ok: false, status: 401, error: 'Unauthorized' }
    }
  }

  function createToken({ name = 'Local script', scopes = ['events:write'], allowedTargets = [], expiresAt = null } = {}) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const label = String(name ?? '').trim().slice(0, 80)
    if (label === '') throw invalid('Give the token a name')
    const keyId = randomBytes(4).toString('hex')
    const secret = randomBytes(24).toString('base64url')
    const salt = randomBytes(12).toString('hex')
    const entry = {
      keyId,
      name: label,
      salt,
      hash: hashSecret(salt, secret),
      scopes: Array.isArray(scopes) && scopes.length > 0 ? scopes.map(String) : ['events:write'],
      allowedTargets: Array.isArray(allowedTargets) ? allowedTargets.map(String).filter(Boolean) : [],
      createdAt: Date.now(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      lastUsedAt: null,
      revoked: false,
    }
    reloadTokens()
    tokens.push(entry)
    saveTokens()
    return {
      keyId,
      name: label,
      token: `${TOKEN_PREFIX}${keyId}_${secret}`,
      scopes: entry.scopes,
      allowedTargets: entry.allowedTargets,
      createdAt: entry.createdAt,
    }
  }

  function revokeToken(keyId) {
    if (!writes()) throw invalid('Team is read-only in this window')
    reloadTokens()
    const entry = tokens.find(item => item.keyId === keyId)
    if (!entry) throw invalid('Unknown token')
    entry.revoked = true
    entry.revokedAt = Date.now()
    saveTokens()
    return true
  }

  function listTokens() {
    reloadTokens()
    return tokens.map(({ salt: _s, hash: _h, ...meta }) => meta)
  }

  async function ingestExternalEvent(payload, auth = {}) {
    if (!writes()) throw Object.assign(new Error('Host is read-only'), { status: 503 })
    if (!payload || typeof payload !== 'object') throw invalid('Event body must be a JSON object')
    const summary = String(payload.summary ?? payload.title ?? '').trim()
    const body = String(payload.body ?? payload.text ?? '')
    if (summary === '' && body === '') throw invalid('Event needs a summary or body')

    const allowedTargets = Array.isArray(auth.allowedTargets) && auth.allowedTargets.length > 0 ? auth.allowedTargets : undefined
    const targetBotId = typeof payload.botId === 'string' && payload.botId !== '' ? payload.botId : undefined
    const targetRoomId = typeof payload.roomId === 'string' && payload.roomId !== '' ? payload.roomId : undefined
    const botAllowed = id => !allowedTargets || allowedTargets.includes(id) || allowedTargets.includes(`bot:${id}`)
    const roomAllowed = id => !allowedTargets || allowedTargets.includes(id) || allowedTargets.includes(`room:${id}`)
    if (targetBotId !== undefined) {
      const bot = rt.botOf(targetBotId)
      if (!bot || bot.private === true) {
        throw Object.assign(new Error('Not found'), { status: 404, code: 'bot/not-found' })
      }
      if (!botAllowed(targetBotId)) {
        throw Object.assign(new Error('Forbidden'), { status: 403, code: 'bot/forbidden' })
      }
    }
    if (targetRoomId !== undefined) {
      if (!rt.roomOf(targetRoomId)) {
        throw Object.assign(new Error('Not found'), { status: 404, code: 'bot/not-found' })
      }
      if (!roomAllowed(targetRoomId)) {
        throw Object.assign(new Error('Forbidden'), { status: 403, code: 'bot/forbidden' })
      }
    }

    const sourceId = String(payload.sourceId ?? payload.source ?? `push:${auth.keyId ?? 'local'}`).slice(0, 80)
    const eventInput = {
      source: {
        kind: 'push',
        id: sourceId,
        name: String(payload.sourceName ?? auth.tokenName ?? sourceId).slice(0, 80),
        actor: String(payload.actor ?? auth.tokenName ?? 'local-script').slice(0, 80),
        actorTrusted: false,
      },
      trust: 'external',
      threadKey: String(payload.threadKey ?? `push:${sourceId}`).slice(0, 200),
      entityKey: String(payload.entityKey ?? payload.threadKey ?? `push:${sourceId}`).slice(0, 200),
      eventType: String(payload.eventType ?? payload.type ?? 'push.event').slice(0, 80),
      dedupeKey: payload.dedupeKey ? `push:${sourceId}:${String(payload.dedupeKey).slice(0, 160)}` : '',
      summary: summary || body.slice(0, 120),
      body,
      meta: {
        ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        ...(targetBotId ? { targetBotId } : {}),
        ...(targetRoomId ? { targetRoomId } : {}),
      },
    }
    // Constrain all downstream subscription routing to `allowedTargets` (and never route
    // an explicit-target Push to unrelated targets when restricted).
    const routeTargets = allowedTargets
    return onEvent(eventInput, {
      directTarget: targetBotId ? { kind: 'bot', botId: targetBotId } : targetRoomId ? { kind: 'room', roomId: targetRoomId } : undefined,
      allowedTargets: routeTargets,
    })
  }

  function respondJson(res, status, data) {
    if (res.writableEnded || res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  async function startUnlocked() {
    config = readJson(configPath, config)
    if (!config.enabled || !writes() || server !== null) return
    const next = createServer((req, res) => {
      try {
        if (!writes()) {
          res.once('finish', () => { void stop() })
          respondJson(res, 503, { ok: false, error: 'Host no longer holds team lock' })
          return
        }
        const url = req.url ?? '/'
        const path = url.split('?')[0]
        if (req.method !== 'POST' || path !== '/v1/events') {
          respondJson(res, 404, { ok: false, error: 'Not found' })
          return
        }
        const auth = verifyToken(req.headers.authorization, url)
        if (!auth.ok) {
          respondJson(res, auth.status, { ok: false, error: auth.error })
          return
        }
        let size = 0
        const chunks = []
        let aborted = false
        req.on('error', () => { aborted = true })
        req.on('data', (chunk) => {
          if (aborted) return
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            aborted = true
            respondJson(res, 413, { ok: false, error: 'Payload too large' })
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (aborted) return
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            respondJson(res, 400, { ok: false, error: 'Invalid JSON' })
            return
          }
          void ingestExternalEvent(body, {
            keyId: auth.token.keyId,
            tokenName: auth.token.name,
            allowedTargets: auth.token.allowedTargets,
          }).then((result) => {
            // Never expose internal sessionId, subId, or private Bot delivery details to external HTTP callers.
            const deliveries = Array.isArray(result?.deliveries) ? result.deliveries : []
            const deliveredCount = deliveries.filter(d => d?.outcome === 'delivered' && !d?.privateTarget).length
            respondJson(res, 202, {
              ok: true,
              eventId: result?.eventId ?? null,
              deduplicated: Boolean(result?.deduplicated),
              delivered: deliveredCount,
            })
          }, (error) => {
            const status = Number.isInteger(error?.status) ? error.status : error?.code === 'bot/invalid' ? 400 : 500
            respondJson(res, status, { ok: false, error: error?.message ?? 'Event rejected' })
          })
        })
      } catch {
        respondJson(res, 500, { ok: false, error: 'Internal error' })
      }
    })
    await new Promise((resolveListen, rejectListen) => {
      next.once('error', rejectListen)
      next.listen(config.port ?? DEFAULT_PORT, '127.0.0.1', () => {
        next.removeListener('error', rejectListen)
        resolveListen()
      })
    })
    server = next
    boundPort = server.address()?.port ?? config.port ?? DEFAULT_PORT
    writeJsonAtomic(endpointPath, {
      version: 1,
      pid: process.pid,
      instanceId,
      baseUrl: `http://127.0.0.1:${boundPort}`,
      eventsUrl: `http://127.0.0.1:${boundPort}/v1/events`,
      startedAt: new Date().toISOString(),
    })
  }

  async function stopUnlocked() {
    const active = server
    server = null
    boundPort = null
    if (active) {
      active.closeIdleConnections?.()
      active.closeAllConnections?.()
      await new Promise(resolveClose => active.close(() => resolveClose()))
    }
    const current = readJson(endpointPath, null)
    if (current?.instanceId === instanceId) {
      try { unlinkSync(endpointPath) } catch {}
    }
  }

  const runLifecycle = (fn) => {
    const next = lifecycle.then(fn, fn)
    lifecycle = next.catch(() => {})
    return next
  }
  const start = () => runLifecycle(startUnlocked)
  const stop = () => runLifecycle(stopUnlocked)

  async function updateConfig(patch) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const port = patch.port !== undefined ? Number(patch.port) : (config.port ?? DEFAULT_PORT)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid('Pick a port between 0 and 65535')
    const nextEnabled = patch.enabled !== undefined ? Boolean(patch.enabled) : config.enabled
    const restart = nextEnabled !== config.enabled || port !== config.port
    config = { enabled: nextEnabled, port }
    saveConfig()
    if (restart) {
      await stop()
      if (config.enabled) await start()
    }
    return status()
  }

  function status() {
    if (!writes()) config = readJson(configPath, config)
    return {
      enabled: config.enabled === true,
      port: boundPort ?? config.port ?? DEFAULT_PORT,
      listening: server !== null,
      url: server !== null ? `http://127.0.0.1:${boundPort}/v1/events` : `http://127.0.0.1:${config.port ?? DEFAULT_PORT}/v1/events`,
      tokens: listTokens(),
    }
  }

  return {
    start,
    stop,
    updateConfig,
    createToken,
    revokeToken,
    listTokens,
    ingestExternalEvent,
    status,
  }
}
