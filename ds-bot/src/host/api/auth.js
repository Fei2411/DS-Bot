// External API configuration, token store, scope/target authorization, rate limits,
// DNS-rebinding guards, and metadata-only audit log.
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 17830
export const TOKEN_PREFIX = 'dsb_live_'
export const ALL_SCOPES = ['read', 'message', 'event:ingest', 'memory:write', 'approval', 'team:manage']
export const DEFAULT_SCOPES = ['read', 'message']
export const HIGH_RISK_SCOPES = new Set(['approval', 'team:manage'])

const CONFIG_FILE = 'api-config.json'
const TOKENS_FILE = 'api-tokens.json'
const AUDIT_FILE = 'api-audit.jsonl'
const LEGACY_MCP_FILE = 'mcp.json'
const LAST_USED_THROTTLE_MS = 60_000
const AUDIT_MAX_ENTRIES = 5_000
const AUDIT_ROTATE_CHECK_EVERY = 200
const TOKEN_NAME_MAX = 80
const QUERY_SECRET_RE = /[?&](?:token|api_key|apikey|access_token|auth|bearer|key)=/i
const scryptAsync = promisify(scrypt)
const DEFAULT_RATE_LIMIT = 120
const DEFAULT_CONCURRENT_RUNS = 4
const AUTH_WINDOW_MS = 60_000
const AUTH_FAILURE_LIMIT = 10
const VERIFICATION_TTL_MS = 30_000
const AUTH_CACHE_LIMIT = 1024
const positiveLimit = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch { /* windows */ }
  renameSync(temp, path)
}

function hashSha256(salt, secret) {
  return createHash('sha256').update(`${salt}:${secret}`).digest('hex')
}

function hashScrypt(salt, secret) {
  return scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')
}

function hashSha256Raw(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function verifySecret(entry, secret, fullToken) {
  if (typeof entry?.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.hash)) return false
  let digest
  if (entry.hashAlgo === 'sha256-raw') {
    if (typeof fullToken !== 'string' || fullToken === '') return false
    digest = hashSha256Raw(fullToken)
  } else {
    if (typeof entry?.salt !== 'string') return false
    digest = entry.hashAlgo === 'scrypt'
      ? (await scryptAsync(secret, entry.salt, 32, { N: 16384, r: 8, p: 1 })).toString('hex')
      : hashSha256(entry.salt, secret)
  }
  const actual = Buffer.from(digest, 'hex')
  const expected = Buffer.from(entry.hash, 'hex')
  return actual.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function isLoopbackHost(host) {
  const clean = String(host ?? '').toLowerCase()
  if (clean === '::1') return true
  const match = /^(?:\[([^\]]+)\]|([^:\s/\\?#@]+))(?::([0-9]+))?$/.exec(clean)
  if (!match || (match[3] !== undefined && Number(match[3]) > 65535)) return false
  const hostname = match[1] ?? match[2]
  if (match[1] !== undefined) return hostname === '::1'
  return hostname === 'localhost' || (isIP(hostname) === 4 && hostname.startsWith('127.'))
}

export function normalizeConfig(raw) {
  const candidate = typeof raw?.host === 'string' ? raw.host.trim() : DEFAULT_HOST
  const validHost = candidate === 'localhost' || isIP(candidate) !== 0
  const host = validHost && (isLoopbackHost(candidate) || raw?.confirmLan === true) ? candidate : DEFAULT_HOST
  const port = Number.isInteger(raw?.port) && raw.port >= 0 && raw.port <= 65535 ? raw.port : DEFAULT_PORT
  return {
    enabled: raw?.enabled === true,
    host,
    confirmLan: !isLoopbackHost(host) && raw?.confirmLan === true,
    port,
    openaiCompat: raw?.openaiCompat === true,
    rateLimitPerMin: positiveLimit(raw?.rateLimitPerMin, DEFAULT_RATE_LIMIT),
    maxConcurrentRuns: positiveLimit(raw?.maxConcurrentRuns, DEFAULT_CONCURRENT_RUNS),
  }
}

function normalizeScopeName(scope) {
  const value = String(scope ?? '').trim()
  // Interop with event-driven branch's push gateway scope alias.
  if (value === 'events:write') return 'event:ingest'
  return value
}

function normalizeTokenScopes(raw) {
  if (!Array.isArray(raw)) return []
  const list = []
  for (const item of raw) {
    const scope = normalizeScopeName(item)
    if (scope === '*') {
      for (const known of ALL_SCOPES) if (!list.includes(known)) list.push(known)
      continue
    }
    if (ALL_SCOPES.includes(scope) && !list.includes(scope)) list.push(scope)
  }
  return list
}

function uniqueIds(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
}

export function createApiAuth(rt) {
  const configPath = join(rt.home, CONFIG_FILE)
  const tokensPath = join(rt.home, TOKENS_FILE)
  const auditPath = join(rt.home, AUDIT_FILE)
  const legacyMcpPath = join(rt.home, LEGACY_MCP_FILE)

  let config = normalizeConfig(readJson(configPath, {}))
  let tokens = []
  let migratedLegacyMcp = false
  let auditWrites = 0
  // Sliding 60-second request timestamps per token keyId for optional per-minute limits.
  const rateWindows = new Map()
  // Active concurrent run counter per token keyId.
  const activeRuns = new Map()
  const authAttempts = new Map()
  const verified = new Map()
  let tokenVersion = ''
  const tokenFingerprint = entry => JSON.stringify({ ...entry, lastUsedAt: undefined })

  const writes = () => rt.readOnly?.() === undefined

  // One-time seamless migration from v0.3.9's standalone mcp.json into unified
  // api-config.json + api-tokens.json so existing MCP clients keep working without
  // rotating tokens or changing ports.
  function migrateLegacyMcpIfNeeded() {
    if (migratedLegacyMcp || !writes()) return
    if (existsSync(configPath)) {
      migratedLegacyMcp = true
      return
    }
    if (!existsSync(legacyMcpPath)) return
    migratedLegacyMcp = true
    const legacy = readJson(legacyMcpPath, null)
    if (!legacy || typeof legacy !== 'object') return
    const wasOn = legacy.on === true
    const legacyPort = Number.isInteger(legacy.port) && legacy.port >= 1024 && legacy.port <= 65535 ? legacy.port : DEFAULT_PORT
    config = normalizeConfig({
      enabled: wasOn,
      host: DEFAULT_HOST,
      port: wasOn ? legacyPort : DEFAULT_PORT,
      openaiCompat: false,
    })
    writeJsonAtomic(configPath, config)
    const legacyClients = Array.isArray(legacy.clients) ? legacy.clients : []
    if (legacyClients.length > 0) {
      const existing = readJson(tokensPath, [])
      const list = Array.isArray(existing) ? existing : []
      const usedKeys = new Set(list.map(item => item?.keyId).filter(Boolean))
      for (const client of legacyClients) {
        if (!client || typeof client.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(client.hash)) continue
        const rawId = String(client.id ?? randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || randomBytes(4).toString('hex')
        let keyId = `mcp_${rawId}`
        while (usedKeys.has(keyId)) keyId = `mcp_${randomBytes(4).toString('hex')}`
        usedKeys.add(keyId)
        const botIds = uniqueIds(client.bots).filter(id => rt.botOf?.(id)?.private !== true)
        const roomIds = uniqueIds(client.rooms)
        list.push({
          keyId,
          name: String(client.name ?? 'MCP client').trim().slice(0, TOKEN_NAME_MAX) || 'MCP client',
          prefix: 'dsb_mcp',
          hashAlgo: 'sha256-raw',
          salt: '',
          hash: client.hash.toLowerCase(),
          scopes: ['read', 'message'],
          targetScope: 'selected',
          botIds,
          roomIds,
          privateBotIds: [],
          createdAt: Number.isFinite(client.createdAt) ? client.createdAt : Date.now(),
          expiresAt: null,
          lastUsedAt: Number.isFinite(client.lastUsedAt) ? client.lastUsedAt : null,
          paused: false,
          revoked: false,
          maxConcurrentRuns: null,
          rateLimitPerMin: null,
          migratedFrom: 'mcp.json',
        })
      }
      tokens = list
      writeJsonAtomic(tokensPath, tokens)
    }
  }

  const reloadConfig = () => {
    migrateLegacyMcpIfNeeded()
    config = normalizeConfig(readJson(configPath, {}))
    return config
  }

  const saveConfig = () => {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    writeJsonAtomic(configPath, config)
  }

  const reloadTokens = () => {
    const raw = readJson(tokensPath, [])
    tokens = Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object' && typeof item.keyId === 'string') : []
    const version = JSON.stringify(tokens.map(tokenFingerprint))
    if (version !== tokenVersion) {
      verified.clear()
      tokenVersion = version
    }
    return tokens
  }

  const saveTokens = () => {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    writeJsonAtomic(tokensPath, tokens)
  }

  reloadTokens()

  function getConfig() {
    if (!writes()) reloadConfig()
    return { ...config }
  }

  function updateConfig(patch = {}) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    const next = { ...config }
    for (const field of ['rateLimitPerMin', 'maxConcurrentRuns']) {
      if (patch[field] !== undefined) {
        next[field] = sanitizeLimit(patch[field], { name: field, max: field === 'rateLimitPerMin' ? 10_000 : 500 })
          ?? (field === 'rateLimitPerMin' ? DEFAULT_RATE_LIMIT : DEFAULT_CONCURRENT_RUNS)
      }
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true
    if (patch.openaiCompat !== undefined) next.openaiCompat = patch.openaiCompat === true
    if (patch.port !== undefined) {
      const port = Number(patch.port)
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid('Port must be a whole number from 0 to 65535')
      next.port = port
    }
    if (patch.host !== undefined) {
      const host = String(patch.host ?? '').trim()
      if (host === '') {
        next.host = DEFAULT_HOST
        next.confirmLan = false
      } else {
        if (host !== 'localhost' && isIP(host) === 0) {
          throw invalid('Host must be 127.0.0.1, localhost, or a valid IP address')
        }
        if (!isLoopbackHost(host) && patch.confirmLan !== true) {
          throw invalid('Binding outside 127.0.0.1 exposes the API to other devices on the network and requires explicit confirmation')
        }
        next.host = host
        next.confirmLan = !isLoopbackHost(host)
      }
    }
    config = next
    saveConfig()
    return { ...config }
  }

  function validateTargets(rt_, { targetScope, botIds, roomIds, privateBotIds, confirmPrivate }) {
    const scope = targetScope === 'all_public' ? 'all_public' : 'selected'
    const cleanBots = uniqueIds(botIds)
    const cleanRooms = uniqueIds(roomIds)
    const cleanPrivate = uniqueIds(privateBotIds)
    // Any private Bot passed in botIds must be explicitly listed in privateBotIds with confirmation.
    const hiddenInBots = cleanBots.filter(id => rt_.botOf(id)?.private === true)
    if (hiddenInBots.length > 0 && confirmPrivate !== true) {
      throw invalid('Authorizing a private Bot requires explicit confirmation')
    }
    if (cleanPrivate.length > 0 && confirmPrivate !== true) {
      throw invalid('Authorizing a private Bot requires explicit confirmation')
    }
    const finalPrivate = [...new Set([...cleanPrivate, ...hiddenInBots])].filter(id => rt_.botOf(id)?.private === true)
    const finalPublicBots = cleanBots.filter(id => rt_.botOf(id)?.private !== true)
    return { targetScope: scope, botIds: finalPublicBots, roomIds: cleanRooms, privateBotIds: finalPrivate }
  }

  function sanitizeLimit(value, { name, min = 1, max = 10_000 }) {
    if (value === undefined || value === null || value === '') return null
    const num = Number(value)
    if (!Number.isInteger(num) || num < min || num > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`)
    return num
  }

  function createToken(input = {}) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    const name = String(input.name ?? '').trim().slice(0, TOKEN_NAME_MAX)
    if (name === '') throw invalid('Give the token a name')
    const scopes = normalizeTokenScopes(input.scopes ?? DEFAULT_SCOPES)
    if (scopes.length === 0) throw invalid('Select at least one scope')
    if (scopes.some(scope => HIGH_RISK_SCOPES.has(scope)) && input.confirmHighRisk !== true) {
      throw invalid('High-risk scopes (approval, team:manage) require explicit confirmation')
    }
    const targets = validateTargets(rt, {
      targetScope: input.targetScope,
      botIds: input.botIds,
      roomIds: input.roomIds,
      privateBotIds: input.privateBotIds,
      confirmPrivate: input.confirmPrivate === true,
    })
    let expiresAt = null
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
      const ts = typeof input.expiresAt === 'number' ? input.expiresAt : Date.parse(String(input.expiresAt))
      if (!Number.isFinite(ts) || ts <= Date.now()) throw invalid('Expiration time must be in the future')
      expiresAt = Math.floor(ts)
    }
    const maxConcurrentRuns = sanitizeLimit(input.maxConcurrentRuns, { name: 'Max concurrent runs', min: 1, max: 500 }) ?? config.maxConcurrentRuns
    const rateLimitPerMin = sanitizeLimit(input.rateLimitPerMin, { name: 'Rate limit per minute', min: 1, max: 10_000 }) ?? config.rateLimitPerMin

    const keyId = randomBytes(4).toString('hex')
    // 256-bit random secret encoded as URL-safe base64.
    const secret = randomBytes(32).toString('base64url')
    const salt = randomBytes(16).toString('hex')
    const now = Date.now()
    const entry = {
      keyId,
      name,
      prefix: `${TOKEN_PREFIX}${keyId}`,
      hashAlgo: 'scrypt',
      salt,
      hash: hashScrypt(salt, secret),
      scopes,
      targetScope: targets.targetScope,
      botIds: targets.botIds,
      roomIds: targets.roomIds,
      privateBotIds: targets.privateBotIds,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      paused: false,
      revoked: false,
      maxConcurrentRuns,
      rateLimitPerMin,
    }
    reloadTokens()
    tokens.push(entry)
    saveTokens()
    return {
      token: `${TOKEN_PREFIX}${keyId}_${secret}`,
      meta: publicTokenMeta(entry),
    }
  }

  function updateToken(keyId, patch = {}) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    reloadTokens()
    const entry = tokens.find(item => item.keyId === String(keyId ?? '') && item.revoked !== true)
    if (entry === undefined) throw Object.assign(new Error('Unknown token'), { code: 'bot/not-found' })
    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').trim().slice(0, TOKEN_NAME_MAX)
      if (name === '') throw invalid('Give the token a name')
      entry.name = name
    }
    if (patch.paused !== undefined) entry.paused = patch.paused === true
    if (patch.scopes !== undefined) {
      const scopes = normalizeTokenScopes(patch.scopes)
      if (scopes.length === 0) throw invalid('Select at least one scope')
      const addedHighRisk = scopes.some(scope => HIGH_RISK_SCOPES.has(scope) && !(entry.scopes ?? []).includes(scope))
      if (addedHighRisk && patch.confirmHighRisk !== true) {
        throw invalid('High-risk scopes (approval, team:manage) require explicit confirmation')
      }
      entry.scopes = scopes
    }
    if (patch.targetScope !== undefined || patch.botIds !== undefined || patch.roomIds !== undefined || patch.privateBotIds !== undefined) {
      const existingPrivate = new Set(entry.privateBotIds ?? [])
      const requestedPrivate = uniqueIds(patch.privateBotIds ?? entry.privateBotIds)
      const addedPrivate = requestedPrivate.some(id => !existingPrivate.has(id))
      const targets = validateTargets(rt, {
        targetScope: patch.targetScope ?? entry.targetScope,
        botIds: patch.botIds ?? entry.botIds,
        roomIds: patch.roomIds ?? entry.roomIds,
        privateBotIds: requestedPrivate,
        confirmPrivate: patch.confirmPrivate === true || !addedPrivate,
      })
      entry.targetScope = targets.targetScope
      entry.botIds = targets.botIds
      entry.roomIds = targets.roomIds
      entry.privateBotIds = targets.privateBotIds
    }
    if (patch.maxConcurrentRuns !== undefined) {
      entry.maxConcurrentRuns = sanitizeLimit(patch.maxConcurrentRuns, { name: 'Max concurrent runs', min: 1, max: 500 })
    }
    if (patch.rateLimitPerMin !== undefined) {
      entry.rateLimitPerMin = sanitizeLimit(patch.rateLimitPerMin, { name: 'Rate limit per minute', min: 1, max: 10_000 })
    }
    saveTokens()
    return publicTokenMeta(entry)
  }

  function revokeToken(keyId) {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    reloadTokens()
    const entry = tokens.find(item => item.keyId === String(keyId ?? ''))
    if (entry === undefined) throw Object.assign(new Error('Unknown token'), { code: 'bot/not-found' })
    entry.revoked = true
    entry.revokedAt = Date.now()
    saveTokens()
    rateWindows.delete(entry.keyId)
    return true
  }

  function publicTokenMeta(entry) {
    return {
      keyId: entry.keyId,
      name: entry.name,
      prefix: entry.prefix ?? `${TOKEN_PREFIX}${entry.keyId}`,
      scopes: normalizeTokenScopes(entry.scopes),
      targetScope: entry.targetScope === 'all_public' ? 'all_public' : 'selected',
      botIds: Array.isArray(entry.botIds) ? entry.botIds : [],
      roomIds: Array.isArray(entry.roomIds) ? entry.roomIds : [],
      privateBotIds: Array.isArray(entry.privateBotIds) ? entry.privateBotIds : [],
      createdAt: entry.createdAt ?? 0,
      expiresAt: entry.expiresAt ?? null,
      lastUsedAt: entry.lastUsedAt ?? null,
      paused: entry.paused === true,
      revoked: entry.revoked === true,
      maxConcurrentRuns: positiveLimit(entry.maxConcurrentRuns, config.maxConcurrentRuns),
      rateLimitPerMin: positiveLimit(entry.rateLimitPerMin, config.rateLimitPerMin),
    }
  }

  function listTokens({ includeRevoked = false } = {}) {
    reloadTokens()
    return tokens
      .filter(entry => includeRevoked || entry.revoked !== true)
      .map(publicTokenMeta)
  }

  function tokenById(keyId) {
    reloadTokens()
    const entry = tokens.find(item => item.keyId === keyId && item.revoked !== true)
    return entry ? publicTokenMeta(entry) : undefined
  }

  // DNS rebinding & cross-site browser protection: refuse requests carrying a web Origin
  // header, and when bound to loopback require Host to name a loopback address.
  function checkRequestOrigin(req) {
    if (req.headers.origin !== undefined && String(req.headers.origin).trim() !== '') {
      return { ok: false, status: 403, code: 'api/origin-forbidden', message: 'Cross-origin browser requests are not allowed' }
    }
    if (isLoopbackHost(config.host)) {
      const hostHeader = String(req.headers.host ?? '')
      if (hostHeader !== '') {
        if (!isLoopbackHost(hostHeader)) {
          return { ok: false, status: 403, code: 'api/host-forbidden', message: 'Invalid Host header for local API' }
        }
      }
    }
    return { ok: true }
  }

  async function checkSecret(entry, secret, presented) {
    const fingerprint = tokenFingerprint(entry)
    const key = `${entry.keyId}:${hashSha256Raw(secret || presented)}`
    const cached = verified.get(key)
    if (cached?.fingerprint === fingerprint && cached.until > Date.now()) return true
    if (!await verifySecret(entry, secret, presented)) return false
    reloadTokens()
    if (!tokens.some(item => item.keyId === entry.keyId && tokenFingerprint(item) === fingerprint)) return false
    if (verified.size >= AUTH_CACHE_LIMIT) verified.delete(verified.keys().next().value)
    verified.set(key, { fingerprint, until: Date.now() + VERIFICATION_TTL_MS })
    return true
  }

  async function authenticate(req) {
    const originCheck = checkRequestOrigin(req)
    if (!originCheck.ok) return originCheck
    if (QUERY_SECRET_RE.test(String(req.url ?? ''))) {
      return { ok: false, status: 401, code: 'api/token-in-query', message: 'Send the API token in the Authorization header, never in URL query parameters' }
    }
    const raw = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
    if (!raw.startsWith('Bearer ')) return { ok: false, status: 401, code: 'api/unauthorized', message: 'Missing Bearer token' }
    const presented = raw.slice(7).trim()
    const modern = presented.startsWith(TOKEN_PREFIX)
    const rest = presented.slice(TOKEN_PREFIX.length)
    const separator = rest.indexOf('_')
    if (/\s/.test(presented) || (modern
      ? separator <= 0 || separator === rest.length - 1
      : !presented.startsWith('dsb_') || presented.length <= 4)) {
      return { ok: false, status: 401, code: 'api/unauthorized', message: 'Invalid API token' }
    }
    const now = Date.now()
    for (const [address, attempts] of authAttempts) {
      const live = attempts.filter(at => now - at < AUTH_WINDOW_MS)
      if (live.length === 0) authAttempts.delete(address)
      else authAttempts.set(address, live)
    }
    const address = req.socket?.remoteAddress ?? 'unknown'
    const attempts = authAttempts.get(address) ?? []
    if (attempts.length >= AUTH_FAILURE_LIMIT) {
      return { ok: false, status: 429, code: 'api/auth-rate-limited', message: 'Too many failed authentication attempts', details: { retryAfterMs: Math.max(1, AUTH_WINDOW_MS - (now - (attempts[0] ?? now))) } }
    }
    if (!authAttempts.has(address) && authAttempts.size >= AUTH_CACHE_LIMIT) {
      authAttempts.delete(authAttempts.keys().next().value)
    }
    attempts.push(now)
    authAttempts.set(address, attempts)
    const { failedSecret, ...result } = await authenticateToken(req)
    if (!failedSecret) {
      const current = authAttempts.get(address)
      const index = current?.indexOf(now) ?? -1
      if (index >= 0) current.splice(index, 1)
      if (current?.length === 0) authAttempts.delete(address)
    }
    return result
  }

  async function authenticateToken(req) {
    const originCheck = checkRequestOrigin(req)
    if (!originCheck.ok) return originCheck

    const reqUrl = String(req.url ?? '')
    if (QUERY_SECRET_RE.test(reqUrl)) {
      return { ok: false, status: 401, code: 'api/token-in-query', message: 'Send the API token in the Authorization header, never in URL query parameters' }
    }

    const raw = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
    if (!raw.startsWith('Bearer ')) {
      return { ok: false, status: 401, code: 'api/unauthorized', message: 'Missing Bearer token' }
    }
    const presented = raw.slice('Bearer '.length).trim()
    reloadTokens()
    let entry
    let secretChecked = false
    if (presented.startsWith(TOKEN_PREFIX)) {
      const rest = presented.slice(TOKEN_PREFIX.length)
      const sep = rest.indexOf('_')
      if (sep <= 0) {
        return { ok: false, status: 401, code: 'api/unauthorized', message: 'Invalid API token' }
      }
      const keyId = rest.slice(0, sep)
      const secret = rest.slice(sep + 1)
      if (secret === '') {
        return { ok: false, status: 401, code: 'api/unauthorized', message: 'Invalid API token' }
      }
      const candidate = tokens.find(item => item.keyId === keyId && item.revoked !== true)
      if (candidate !== undefined) {
        secretChecked = true
        if (await checkSecret(candidate, secret, presented)) entry = candidate
      }
    } else if (presented.startsWith('dsb_')) {
      // Support tokens migrated from v0.3.9 mcp.json (raw sha256 hashes of `dsb_<secret>`).
      for (const item of tokens) {
        if (item.revoked !== true && item.hashAlgo === 'sha256-raw') {
          secretChecked = true
          if (await checkSecret(item, '', presented)) {
            entry = item
            break
          }
        }
      }
    }
    if (entry === undefined) {
      return { ok: false, status: 401, code: 'api/unauthorized', message: 'Invalid API token', failedSecret: secretChecked }
    }
    const current = tokens.find(item => item.keyId === entry.keyId)
    if (!current || tokenFingerprint(current) !== tokenFingerprint(entry)) {
      return { ok: false, status: 401, code: 'api/unauthorized', message: 'API token changed during verification' }
    }
    entry = current
    if (entry.paused === true) {
      return { ok: false, status: 403, code: 'api/token-paused', message: 'This API token is paused' }
    }
    if (typeof entry.expiresAt === 'number' && Date.now() >= entry.expiresAt) {
      return { ok: false, status: 401, code: 'api/token-expired', message: 'This API token has expired' }
    }

    const now = Date.now()
    if (!entry.lastUsedAt || now - entry.lastUsedAt >= LAST_USED_THROTTLE_MS) {
      entry.lastUsedAt = now
      try { if (writes()) saveTokens() } catch { /* best-effort */ }
    }
    return { ok: true, token: buildPrincipal(entry) }
  }

  // Builds a live authorization principal that always re-checks current Bot privacy on rt.state.
  function buildPrincipal(entry) {
    const fingerprint = tokenFingerprint(entry)
    const isCurrent = () => {
      reloadTokens()
      const current = tokens.find(item => item.keyId === entry.keyId)
      return current !== undefined && current.revoked !== true && current.paused !== true
        && !(typeof current.expiresAt === 'number' && Date.now() >= current.expiresAt)
        && tokenFingerprint(current) === fingerprint
    }
    const scopes = new Set(normalizeTokenScopes(entry.scopes))
    // Compatibility with event-driven branch's `allowedTargets` array.
    const legacyTargets = Array.isArray(entry.allowedTargets) ? entry.allowedTargets.filter(id => typeof id === 'string') : []
    const targetScope = entry.targetScope === 'all_public' ? 'all_public' : 'selected'
    const botIds = new Set(uniqueIds(entry.botIds))
    const roomIds = new Set(uniqueIds(entry.roomIds))
    const privateBotIds = new Set(uniqueIds(entry.privateBotIds))
    if (legacyTargets !== null) {
      for (const item of legacyTargets) {
        if (item.startsWith('bot:')) botIds.add(item.slice(4))
        else if (item.startsWith('room:')) roomIds.add(item.slice(5))
        else { botIds.add(item); roomIds.add(item) }
      }
    }

    const hasScope = scope => {
      if (scope === 'memory:read') return entry.migratedFrom !== 'mcp.json' && scopes.has('read')
      if (scope === 'card:respond') return entry.migratedFrom !== 'mcp.json' && (scopes.has('message') || scopes.has('approval'))
      return scopes.has(normalizeScopeName(scope))
    }

    const canAccessBot = (botId) => {
      const bot = rt.botOf(botId)
      if (bot === undefined) return false
      // Hard privacy rule: turning a public Bot private immediately revokes every token
      // that did not explicitly confirm that Bot in `privateBotIds`.
      if (bot.private === true) return privateBotIds.has(bot.id)
      if (targetScope === 'all_public') return true
      return botIds.has(bot.id)
    }

    const canAccessRoom = (roomId) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return false
      if (targetScope === 'all_public') return true
      return roomIds.has(room.id)
    }

    // Checks target authorization and returns HTTP status + error code on denial.
    // Private Bots always return 404 when unauthorized so their existence is never leaked.
    const assertBotAccess = (botId) => {
      const bot = rt.botOf(botId)
      if (bot === undefined) return { ok: false, status: 404, code: 'bot/not-found', message: 'Bot not found' }
      if (canAccessBot(bot.id)) return { ok: true, bot }
      if (bot.private === true) return { ok: false, status: 404, code: 'bot/not-found', message: 'Bot not found' }
      return { ok: false, status: 403, code: 'api/target-forbidden', message: 'Token is not authorized for this Bot' }
    }

    const assertRoomAccess = (roomId) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { ok: false, status: 404, code: 'room/not-found', message: 'Group not found' }
      if (canAccessRoom(room.id)) return { ok: true, room }
      return { ok: false, status: 403, code: 'api/target-forbidden', message: 'Token is not authorized for this group' }
    }

    return {
      keyId: entry.keyId,
      name: entry.name,
      scopes: [...scopes],
      targetScope,
      maxConcurrentRuns: positiveLimit(entry.maxConcurrentRuns, config.maxConcurrentRuns),
      rateLimitPerMin: positiveLimit(entry.rateLimitPerMin, config.rateLimitPerMin),
      hasScope,
      isCurrent,
      canAccessBot,
      canAccessRoom,
      assertBotAccess,
      assertRoomAccess,
    }
  }

  function checkRateLimit(principal) {
    const limit = principal.rateLimitPerMin
    if (!Number.isInteger(limit) || limit <= 0) return { ok: true }
    const now = Date.now()
    const cutoff = now - 60_000
    let stamps = rateWindows.get(principal.keyId)
    if (stamps === undefined) {
      stamps = []
      rateWindows.set(principal.keyId, stamps)
    }
    while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift()
    if (stamps.length >= limit) {
      const retryAfterMs = Math.max(250, stamps[0] + 60_000 - now)
      return {
        ok: false,
        status: 429,
        code: 'api/rate-limited',
        message: `Rate limit exceeded (${limit} requests/min)`,
        details: { retryAfterMs, limit },
      }
    }
    stamps.push(now)
    return { ok: true }
  }

  function acquireRunSlot(principal) {
    const limit = principal.maxConcurrentRuns
    const current = activeRuns.get(principal.keyId) ?? 0
    if (Number.isInteger(limit) && limit > 0 && current >= limit) {
      return {
        ok: false,
        status: 429,
        code: 'api/concurrency-limited',
        message: `Concurrent run limit reached (${limit})`,
        details: { retryAfterMs: 1_000, limit, active: current },
      }
    }
    activeRuns.set(principal.keyId, current + 1)
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        const left = (activeRuns.get(principal.keyId) ?? 1) - 1
        if (left <= 0) activeRuns.delete(principal.keyId)
        else activeRuns.set(principal.keyId, left)
      },
    }
  }

  // Metadata-only audit log: never writes token secrets, request bodies, or replies.
  function recordAudit(entry) {
    if (!writes()) return
    const record = {
      time: Date.now(),
      tokenId: entry.tokenId ?? null,
      tokenName: entry.tokenName ?? null,
      method: String(entry.method ?? ''),
      path: String(entry.path ?? '').split('?')[0],
      ...(entry.action ? { action: String(entry.action).slice(0, 120) } : {}),
      ...(entry.targetKind ? { targetKind: entry.targetKind } : {}),
      ...(entry.targetId ? { targetId: entry.targetId } : {}),
      ...(entry.targetName ? { targetName: String(entry.targetName).slice(0, 80) } : {}),
      status: Number(entry.status ?? 0),
      ...(entry.runId ? { runId: entry.runId } : {}),
      durationMs: Math.max(0, Math.round(Number(entry.durationMs ?? 0))),
    }
    try {
      mkdirSync(rt.home, { recursive: true })
      appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
      auditWrites += 1
      if (auditWrites % AUDIT_ROTATE_CHECK_EVERY === 0) rotateAudit()
    } catch { /* best-effort */ }
  }

  function rotateAudit() {
    try {
      if (!existsSync(auditPath)) return
      const lines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      if (lines.length <= AUDIT_MAX_ENTRIES) return
      const kept = lines.slice(-AUDIT_MAX_ENTRIES)
      const temp = `${auditPath}.${process.pid}.tmp`
      writeFileSync(temp, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(temp, 0o600) } catch {}
      renameSync(temp, auditPath)
    } catch { /* best-effort */ }
  }

  function readAudit({ limit = 100, offset = 0 } = {}) {
    try {
      if (!existsSync(auditPath)) return { entries: [], total: 0 }
      const lines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      const total = lines.length
      const cap = Math.max(1, Math.min(500, Number(limit) || 100))
      const skip = Math.max(0, Number(offset) || 0)
      const end = Math.max(0, total - skip)
      const start = Math.max(0, end - cap)
      const entries = []
      for (let i = end - 1; i >= start; i -= 1) {
        try { entries.push(JSON.parse(lines[i])) } catch {}
      }
      return { entries, total }
    } catch {
      return { entries: [], total: 0 }
    }
  }

  function clearAudit() {
    if (!writes()) throw Object.assign(new Error(rt.readOnly() ?? 'Host is read-only'), { code: 'bot/read-only' })
    try { unlinkSync(auditPath) } catch {}
    return true
  }

  return {
    getConfig,
    reloadConfig,
    updateConfig,
    createToken,
    updateToken,
    revokeToken,
    listTokens,
    tokenById,
    authenticate,
    checkRateLimit,
    acquireRunSlot,
    recordAudit,
    readAudit,
    clearAudit,
    paths: { configPath, tokensPath, auditPath },
  }
}
