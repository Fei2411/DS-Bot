// Privacy-first anonymous telemetry and DSH upstream telemetry safeguards.
// Hard guarantees:
// - Never sends anything until the user explicitly confirms the privacy notice.
// - Never collects chat content, prompts, memories, Bot names, file paths, URLs,
//   secrets, custom provider/plugin names, error messages, or private Bot activity.
// - Monthly rotating random UUID v4 (no hardware fingerprint); user can reset anytime.
// - Keeps the last 20 sent payloads locally so the user can inspect exact JSON.
// - Protects against DSH upstream session-log / feedback-telemetry leaks without patching DSH.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanText, dshVersion } from './diagnostics.js'
import { replaceFile } from './files.js'
import { redactDeep } from './secrets.js'

export const DEFAULT_ENDPOINT = 'https://telemetry.dsbot.app/v1/collect'
export const PRIVACY_POLICY_URL = 'https://dsbot.app/privacy'
export const NOTICE_VERSION = 1
const RECENT_MAX = 20
const MAX_ERRORS_PER_DAY = 20
const STARTUP_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const SEND_TIMEOUT_MS = 5_000

const KNOWN_PROVIDERS = new Set([
  'deepseek-official', 'deepseek-account', 'openai', 'anthropic', 'google',
  'openrouter', 'xai', 'mistral', 'groq', 'ollama', 'lmstudio', 'chatgpt',
  'azure', 'bedrock', 'vertex',
])
const KNOWN_LOCAL_AGENTS = new Set([
  'claude-code', 'codex', 'gemini', 'antigravity', 'opencode', 'cursor', 'devin', 'qoder',
])
const KNOWN_THEMES = new Set(['deepseek', 'mono', 'paper', 'moonlight', 'fei'])
const KNOWN_IM = new Set(['telegram', 'feishu', 'discord', 'slack', 'dingtalk', 'wecom', 'qq', 'weixin'])
const KNOWN_FEATURES = new Set([
  'group_chat', 'background_task', 'bot_browser', 'computer_use', 'schedule',
  'phone_link', 'im_bridge', 'memory_recall', 'office_docs', 'voice_input',
  'local_api', 'connectors', 'capabilities', 'plugins', 'secrets',
])
const ERROR_SOURCES = new Set(['host', 'electron-main', 'renderer', 'turn', 'update'])
const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'DOMException',
  'SystemError', 'AssertionError', 'HttpError', 'NetworkError', 'AuthError',
  'QuotaError', 'ConfigError', 'SqliteError',
])
const SAFE_ERROR_CODES = new Set([
  'bot/invalid', 'bot/not-found', 'bot/refused', 'bot/read-only', 'bot/stale',
  'bot/busy', 'bot/conflict', 'bot/timeout', 'bot/internal', 'schedule/pending',
  'gateway/internal', 'gateway/timeout', 'gateway/unavailable',
  'session/not-found', 'session/agent-busy', 'session/archived', 'subagent/unauthorized',
  'AUTH', 'QUOTA', 'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'CONTENT_POLICY', 'ABORTED', 'UNKNOWN',
  'SERVER', 'MAX_TOKENS', 'CONTEXT_WINDOW_EXCEEDED', 'BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND',
  'OVERLOADED', 'PROVIDER', 'MODEL',
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENOSPC', 'EPIPE',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EADDRINUSE', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENOTFOUND', 'EBUSY', 'EXDEV', 'EINVAL',
  'ERR_INVALID_ARG_TYPE', 'ERR_MODULE_NOT_FOUND', 'ERR_IPC_CHANNEL_CLOSED',
  'ERR_STREAM_DESTROYED', 'ERR_ABORTED', 'ERR_UNHANDLED_REJECTION',
  'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_READONLY', 'SQLITE_CONSTRAINT',
])
const HTTP_ERROR_CODE_RE = /^HTTP_[45]\d\d$/
const SAFE_WHERE = new Set([
  'turns', 'groups', 'memory', 'browser', 'store', 'channel', 'schedule', 'connector',
  'im', 'phone', 'api', 'computer', 'plugins', 'secrets', 'update', 'overlay',
  'own-chat', 'group-chat', 'other',
])
const ARCHS = new Set(['arm64', 'x64', 'ia32', 'arm'])

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FRAME_CHECK_RE = /^(?:ds-bot|app|link|mobile)\/(?:(?:ui\/)?src\/|scripts\/|engine\/)?[A-Za-z0-9_/-]{1,96}\.(?:js|mjs|cjs|ts|tsx)(?::[0-9]{1,6}(?::[0-9]{1,5})?)?$/

export function normalizeErrorName(raw) {
  return typeof raw === 'string' && SAFE_ERROR_NAMES.has(raw) ? raw : 'Error'
}

export function normalizeErrorCode(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  if (SAFE_ERROR_CODES.has(raw) || HTTP_ERROR_CODE_RE.test(raw)) return raw
  return undefined
}

export function normalizeWhere(raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return undefined
  if (trimmed === 'own chat' || trimmed === 'own-chat') return 'own-chat'
  if (trimmed.startsWith('group ') || trimmed === 'group-chat') return 'group-chat'
  if (trimmed.startsWith('overlay.') || trimmed.startsWith('overlay:') || trimmed === 'overlay') return 'overlay'
  return SAFE_WHERE.has(trimmed) ? trimmed : undefined
}

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)
const utcMonth = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

const ownVersion = () => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const isTruthyEnv = (value) => {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return clean === '1' || clean === 'true'
}

export function envDisabledReason(env = process.env) {
  if (typeof env.DS_BOT_TELEMETRY_DISABLED === 'string' && env.DS_BOT_TELEMETRY_DISABLED !== '') {
    return 'DS_BOT_TELEMETRY_DISABLED'
  }
  if (isTruthyEnv(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK'
  return null
}

export function automatedEnvReason(env = process.env) {
  if (isTruthyEnv(env.CI)) return 'CI'
  if (isTruthyEnv(env.GITHUB_ACTIONS)) return 'GITHUB_ACTIONS'
  if (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT !== '') return 'NODE_TEST_CONTEXT'
  if (typeof env.VITEST === 'string' && env.VITEST !== '') return 'VITEST'
  if (typeof env.JEST_WORKER_ID === 'string' && env.JEST_WORKER_ID !== '') return 'JEST_WORKER_ID'
  if (typeof env.PLAYWRIGHT_TEST === 'string' && env.PLAYWRIGHT_TEST !== '') return 'PLAYWRIGHT_TEST'
  return null
}

function allowedEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_ENDPOINT
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol === 'https:') return parsed.toString()
    if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return parsed.toString()
    }
  } catch {}
  return null
}

export function botCountBucket(count) {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2-3'
  if (count <= 7) return '4-7'
  return '8+'
}

export function smallCountBucket(count) {
  if (count <= 0) return '0'
  if (count <= 2) return '1-2'
  return '3+'
}

export function turnsBucket(count) {
  if (count <= 0) return '0'
  if (count <= 5) return '1-5'
  if (count <= 20) return '6-20'
  if (count <= 50) return '21-50'
  return '51+'
}

export function normalizeProvider(ref) {
  if (typeof ref !== 'string' || ref === '') return null
  const prefix = ref.split('/')[0].trim().toLowerCase()
  if (prefix === '' || prefix === 'local' || prefix === 'agent') return null
  if (KNOWN_PROVIDERS.has(prefix)) return prefix
  if (prefix.startsWith('deepseek')) return 'deepseek-official'
  return 'custom'
}

export function normalizeLocalAgent(badge) {
  if (typeof badge !== 'string' || badge.trim() === '') return null
  const key = badge.trim().toLowerCase()
  return KNOWN_LOCAL_AGENTS.has(key) ? key : 'custom'
}

export function normalizeLocale(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown'
  const clean = raw.trim().replace(/_/g, '-')
  const lower = clean.toLowerCase()
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo') || lower.startsWith('zh-hant')) return 'zh-TW'
  const base = lower.split('-')[0]
  return /^[a-z]{2}$/.test(base) ? base : 'unknown'
}

export function coarseOs(osPlatform = platform(), osRelease = release()) {
  const name = ['darwin', 'win32', 'linux', 'ios', 'android'].includes(osPlatform) ? osPlatform : 'unknown'
  if (name === 'unknown') return 'unknown'
  const major = /^(\d{1,3})\b/.exec(String(osRelease ?? ''))?.[1]
  return major ? `${name} ${major}` : name
}

// Extract only relative source frames inside DS Bot packages (ds-bot/, app/, link/, mobile/).
// Strips all absolute filesystem prefixes, drive letters, file:// URLs, query params, and
// drops every third-party or user-workspace frame so paths can never leak.
export function sanitizeStack(rawStack) {
  if (typeof rawStack !== 'string' || rawStack === '') return []
  const frames = []
  for (const rawLine of rawStack.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('at ')) continue
    const body = line.slice(3).trim()
    let loc = body
    const paren = body.match(/^.+?\s+\((.+)\)$/)
    if (paren) loc = paren[1].trim()
    const normalized = loc.replace(/\\/g, '/').replace(/[?#][^:]*/g, '')
    const match = /(?:^|.*\/)((?:ds-bot|app|link|mobile)\/(?:(?:ui\/)?src\/|scripts\/|engine\/)?[A-Za-z0-9_/-]{1,96}\.(?:js|mjs|cjs|ts|tsx))(?::(\d{1,6})(?::(\d{1,5}))?)?$/.exec(normalized)
    if (!match) continue
    const rel = match[1]
    if (rel.includes('..') || rel.includes('/node_modules/')) continue
    const coords = match[2] ? `:${match[2]}${match[3] ? `:${match[3]}` : ''}` : ''
    const frame = `${rel}${coords}`
    if (!FRAME_CHECK_RE.test(frame)) continue
    frames.push(frame)
    if (frames.length >= 8) break
  }
  return frames
}

export function errorFingerprint({ source, errorName, errorCode, where, frames }) {
  const key = [source, errorName, errorCode ?? '', where ?? '', ...(frames ?? []).slice(0, 3)].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function defaultState(now = Date.now()) {
  const day = utcDay(now)
  return {
    version: 1,
    noticeAccepted: false,
    noticeVersion: NOTICE_VERSION,
    usage: false,
    errors: false,
    dshSessionLog: false,
    dshFeedbackTelemetry: false,
    anonId: randomUUID(),
    anonMonth: utcMonth(now),
    firstSeenDay: day,
    lastPingDay: null,
    daily: { day, turns: 0, features: [] },
    sentErrors: { day, counts: {} },
    recentSent: [],
  }
}

function readInitialState(filePath, now) {
  const base = defaultState(now)
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    const month = utcMonth(now)
    const day = utcDay(now)
    const validId = typeof parsed.anonId === 'string' && UUID_V4.test(parsed.anonId) && parsed.anonMonth === month
    const daily = parsed.daily && parsed.daily.day === day
      ? {
          day,
          turns: Number.isInteger(parsed.daily.turns) && parsed.daily.turns >= 0 ? parsed.daily.turns : 0,
          features: Array.isArray(parsed.daily.features) ? parsed.daily.features.filter(f => KNOWN_FEATURES.has(f)) : [],
        }
      : { day, turns: 0, features: [] }
    const sentErrors = parsed.sentErrors && parsed.sentErrors.day === day && parsed.sentErrors.counts && typeof parsed.sentErrors.counts === 'object'
      ? { day, counts: { ...parsed.sentErrors.counts } }
      : { day, counts: {} }
    const noticeAccepted = parsed.noticeAccepted === true
    return {
      version: 1,
      noticeAccepted,
      noticeVersion: Number.isInteger(parsed.noticeVersion) ? parsed.noticeVersion : NOTICE_VERSION,
      usage: noticeAccepted && parsed.usage === true,
      errors: noticeAccepted && parsed.errors === true,
      dshSessionLog: parsed.dshSessionLog === true,
      dshFeedbackTelemetry: parsed.dshFeedbackTelemetry === true,
      anonId: validId ? parsed.anonId.toLowerCase() : randomUUID(),
      anonMonth: month,
      firstSeenDay: typeof parsed.firstSeenDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.firstSeenDay) ? parsed.firstSeenDay : day,
      lastPingDay: typeof parsed.lastPingDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.lastPingDay) ? parsed.lastPingDay : null,
      daily,
      sentErrors,
      recentSent: Array.isArray(parsed.recentSent) ? parsed.recentSent.slice(-RECENT_MAX) : [],
    }
  } catch {
    return base
  }
}

export function install(rt) {
  const { ctx, home, config } = rt
  const filePath = join(home, 'telemetry.json')
  const nowFn = typeof config.telemetryNow === 'function' ? config.telemetryNow : () => Date.now()
  const fetchFn = typeof config.telemetryFetch === 'function' ? config.telemetryFetch : globalThis.fetch
  const endpoint = allowedEndpoint(config.telemetryUrl ?? process.env.DS_BOT_TELEMETRY_URL)
  const configDisabled = config.telemetry === false
  let data = readInitialState(filePath, nowFn())
  let stopped = false
  let saving = Promise.resolve()
  let pingInFlight = false
  let startTimer = null
  let periodicTimer = null

  const hasTestOverride = typeof config.telemetryFetch === 'function' || typeof config.telemetryUrl === 'string'
  const envReason = () => {
    if (configDisabled) return 'config'
    const explicit = envDisabledReason(process.env)
    if (explicit !== null) return explicit
    if (!hasTestOverride) return automatedEnvReason(process.env)
    return null
  }
  const isDisabled = () => envReason() !== null || endpoint === null

  const rotateIfNeeded = (now = nowFn()) => {
    const month = utcMonth(now)
    const day = utcDay(now)
    let changed = false
    if (data.anonMonth !== month || !UUID_V4.test(data.anonId)) {
      data.anonId = randomUUID()
      data.anonMonth = month
      changed = true
    }
    if (data.daily.day !== day) {
      data.daily = { day, turns: 0, features: [] }
      changed = true
    }
    if (data.sentErrors.day !== day) {
      data.sentErrors = { day, counts: {} }
      changed = true
    }
    return changed
  }

  const persist = () => {
    if (stopped || configDisabled || rt.readOnly?.() !== undefined) return Promise.resolve()
    const snapshot = JSON.stringify(data, null, 2)
    saving = saving.then(async () => {
      if (stopped || rt.readOnly?.() !== undefined) return
      await mkdir(dirname(filePath), { recursive: true })
      const temp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        await writeFile(temp, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
        await replaceFile(temp, filePath)
        await chmod(filePath, 0o600).catch(() => {})
      } catch {
        await unlink(temp).catch(() => {})
      }
    }).catch(() => {})
    return saving
  }

  const isPathWithin = (candidate, dir) => {
    if (typeof candidate !== 'string' || candidate === '' || typeof dir !== 'string' || dir === '') return false
    const norm = p => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    const c = process.platform === 'linux' ? norm(candidate) : norm(candidate).toLowerCase()
    const d = process.platform === 'linux' ? norm(dir) : norm(dir).toLowerCase()
    return c === d || c.startsWith(`${d}/`)
  }

  const hasAnyPrivate = () => Object.values(rt.state?.bots ?? {}).some(bot => bot?.private === true)
    || (rt.state?.privateArchives?.length ?? 0) > 0

  const botOwnsSession = (bot, sessionId) => {
    if (!bot) return false
    if (bot.id === sessionId || rt.chatOf?.(bot.id) === sessionId) return true
    if (Array.isArray(bot.segments) && bot.segments.some(seg => seg?.sessionId === sessionId)) return true
    if (Array.isArray(bot.openParts) && bot.openParts.some(part => part?.sessionId === sessionId
      || (Array.isArray(part?.segments) && part.segments.some(seg => seg?.sessionId === sessionId)))) return true
    if (Array.isArray(bot.tasks) && bot.tasks.some(task => task?.sessionId === sessionId)) return true
    if (Array.isArray(bot.retiredTasks) && bot.retiredTasks.some(task => task?.sessionId === sessionId)) return true
    return false
  }

  const isPrivateCwd = (cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return false
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot?.private !== true) continue
      if (isPathWithin(cwd, bot.workDir)) return true
      if (isPathWithin(cwd, join(home, 'memory', 'bots', bot.id))) return true
      if (isPathWithin(cwd, join(home, 'browser-profiles', bot.id))) return true
    }
    for (const archive of rt.state?.privateArchives ?? []) {
      if (isPathWithin(cwd, archive?.archivePath)) return true
    }
    return false
  }

  const isDirectlyPrivate = (sessionId) => {
    const owner = rt.selfOf?.(sessionId)
    if (owner !== undefined && rt.isPrivate?.(owner)) return true
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot?.private === true && botOwnsSession(bot, sessionId)) return true
    }
    for (const archive of rt.state?.privateArchives ?? []) {
      if (archive?.id === sessionId) return true
      if (Array.isArray(archive?.sessionIds) && archive.sessionIds.includes(sessionId)) return true
    }
    return false
  }

  const isDirectlyPublic = (sessionId) => {
    const owner = rt.selfOf?.(sessionId)
    if (owner !== undefined && !rt.isPrivate?.(owner)) return true
    if (rt.roomOf?.(sessionId)) return true
    if (rt.agentOf?.(sessionId) !== undefined) return true
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot?.private !== true && botOwnsSession(bot, sessionId)) return true
    }
    for (const agent of Object.values(rt.state?.agents ?? {})) {
      if (Array.isArray(agent?.sessions) && agent.sessions.includes(sessionId)) return true
    }
    return false
  }

  // Synchronous check used by DSH `sessionLogDeepSeek.registerExclusion`,
  // `session-telemetry/record`, and DS Bot telemetry to guarantee private Bots
  // (including offline/disk-resumed subagents) never upload logs.
  const isPrivateSession = (sessionId, { failClosed = false, record } = {}) => {
    const recordCwd = record?.attributes?.['session.cwd']
    if (isPrivateCwd(recordCwd)) return true
    if (typeof sessionId !== 'string' || sessionId === '') return failClosed && hasAnyPrivate()

    const seen = new Set()
    let cur = sessionId
    let first = true
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      if (isDirectlyPrivate(cur)) return true
      const live = ctx.sessions?.get?.(cur)
      if (live && isPrivateCwd(live.header?.cwd)) return true
      if (isDirectlyPublic(cur)) return false
      if (live) {
        const nextParent = live.header?.parentSession
        if (nextParent === undefined) return false
        cur = String(nextParent)
        first = false
        continue
      }
      // Check parent hints on the record itself before giving up on an offline session.
      if (first && record) {
        const hint = record?.sourceEvent?.envelope?.parentSession ?? record?.attributes?.['session.parent_id']
        if (typeof hint === 'string' && hint !== '' && !seen.has(hint)) {
          cur = hint
          first = false
          continue
        }
      }
      // Offline / disk-resumed session whose ownership cannot be proven public:
      // fail closed whenever this team has any private Bot or private archive.
      return failClosed && hasAnyPrivate()
    }
    return failClosed && hasAnyPrivate()
  }

  // --- DSH upstream telemetry safeguards (without patching DSH) ---
  // 1. Official DeepSeek API incremental session-log upload: excluded by default,
  //    and permanently excluded for all private Bots (fail-closed on offline subagents).
  ctx.inject?.(['sessionLogDeepSeek'], (child) => {
    if (typeof child.sessionLogDeepSeek?.registerExclusion !== 'function') return
    child.sessionLogDeepSeek.registerExclusion((request) => {
      if (!data.dshSessionLog) return true
      if (isPrivateSession(request?.sessionId, { failClosed: true })) return true
      return false
    })
  })

  // 2. OTLP feedback telemetry redaction & opt-in gate: DSH ships no default redaction
  //    rules, so we withhold unless enabled, always block private Bots (fail-closed on
  //    offline/disk-resumed subagents), and scrub secrets/paths.
  //    Cordis waterfall `next()` takes no arguments; run downstream first, then scrub its result.
  ctx.on?.('session-telemetry/record', (record, next) => {
    const sid = record?.sourceEvent?.sessionId ?? record?.attributes?.['session.id']
    if (!data.dshFeedbackTelemetry || isPrivateSession(sid, { failClosed: true, record })) {
      return { ...record, sourceEvent: undefined }
    }
    const current = next()
    if (!current || typeof current !== 'object') return current
    const scrub = text => cleanText(text, { redact: rt.redactSecrets ?? (v => v), maxLength: Infinity })
    const attrs = current.attributes && typeof current.attributes === 'object' ? { ...current.attributes } : undefined
    if (attrs && typeof attrs['session.cwd'] === 'string') attrs['session.cwd'] = '~'
    return {
      ...current,
      ...(attrs ? { attributes: redactDeep(attrs, scrub) } : {}),
      body: redactDeep(current.body, scrub),
    }
  })

  const detectSurface = () => {
    if (process.env.DS_BOT_APP === '1') return 'desktop'
    if (process.env.DS_BOT_DOCKER === '1' || existsSync('/.dockerenv')) return 'docker'
    const profile = ctx.get?.('profileContext')?.name
    if (profile === 'desktop') return 'dsh-desktop'
    if (profile === 'ds-bot') return 'desktop'
    return 'dsh-web'
  }

  const noteFeature = (feature) => {
    if (!KNOWN_FEATURES.has(feature)) return
    rotateIfNeeded()
    if (!data.daily.features.includes(feature)) {
      data.daily.features.push(feature)
      void persist()
    }
  }

  const noteTurn = (sessionId) => {
    if (isPrivateSession(sessionId)) return
    rotateIfNeeded()
    data.daily.turns += 1
    if (rt.roomOf?.(sessionId)) {
      if (!data.daily.features.includes('group_chat')) data.daily.features.push('group_chat')
    }
    void persist()
  }

  // Observe non-private turn completions without slowing the agent loop.
  ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'turn/end' && session?.id) noteTurn(String(session.id))
  })

  const isNoticeCurrent = () => data.noticeAccepted === true && (data.noticeVersion ?? 0) >= NOTICE_VERSION

  const isPrivateBotRef = (botRef) => {
    if (typeof botRef !== 'string' || botRef === '') return false
    if (rt.isPrivate?.(botRef)) return true
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot?.private === true && (bot.id === botRef || bot.name === botRef)) return true
    }
    for (const archive of rt.state?.privateArchives ?? []) {
      if (archive?.id === botRef || archive?.name === botRef) return true
    }
    return false
  }

  const buildDailyPayload = async (now = nowFn()) => {
    rotateIfNeeded(now)
    const state = rt.state ?? { bots: {}, rooms: {}, prefs: {} }
    const publicBots = Object.values(state.bots ?? {}).filter(bot => bot?.private !== true)
    const rooms = Object.values(state.rooms ?? {})
    const providers = new Set()
    const localAgents = new Set()
    const features = new Set(data.daily.features)

    for (const bot of publicBots) {
      const ref = bot.model ?? bot.appliedModel
      const badge = rt.localAgentBadge?.(ref)
      if (badge !== undefined) {
        const la = normalizeLocalAgent(badge)
        if (la) localAgents.add(la)
      } else {
        const prov = normalizeProvider(ref)
        if (prov) providers.add(prov)
      }
      if (Array.isArray(bot.tasks) && bot.tasks.length > 0) features.add('background_task')
    }
    if (rooms.length > 0) features.add('group_chat')
    if (rt.browserEnabled === true) features.add('bot_browser')
    if (rt.computerView?.()?.enabled === true) features.add('computer_use')
    try {
      const sched = await rt.scheduleEndpoint?.('schedules')
      const tasks = Array.isArray(sched?.tasks) ? sched.tasks : []
      if (tasks.some(t => t?.state !== 'finished' && !isPrivateSession(t?.sessionId))) features.add('schedule')
    } catch { /* schedule service optional */ }
    const phone = rt.phoneView?.()
    if (phone?.on === true || (Array.isArray(phone?.phones) && phone.phones.length > 0)) features.add('phone_link')
    const imConns = rt.imView?.()?.connections ?? []
    const imPlatforms = new Set()
    if (imConns.length > 0) {
      features.add('im_bridge')
      for (const conn of imConns) {
        const plat = typeof conn?.platform === 'string' ? conn.platform.toLowerCase() : ''
        if (KNOWN_IM.has(plat)) imPlatforms.add(plat)
      }
    }
    if (rt.apiView?.()?.enabled === true) features.add('local_api')
    const connView = rt.connectorsView?.()
    const connectorRows = Array.isArray(connView?.connectors) ? connView.connectors : []
    const mailAccounts = Array.isArray(connView?.mail?.accounts) ? connView.mail.accounts : []
    const connectedCount = connectorRows.filter(c => c?.state === 'ready' || c?.state === 'connecting').length + mailAccounts.length
    if (connectedCount > 0) features.add('connectors')
    if (Object.keys(state.capabilities?.items ?? {}).length > 0) features.add('capabilities')
    if ((rt.pluginsSummary?.()?.installedCount ?? 0) > 0) features.add('plugins')
    if ((rt.secretsView?.()?.length ?? 0) > 0) features.add('secrets')
    if (state.prefs?.memoryAutoRecall !== false && rt.memoryEnabled !== false) features.add('memory_recall')
    if (ctx.get?.('speechController')) features.add('voice_input')

    const rawTheme = state.prefs?.theme
    const theme = typeof rawTheme === 'string' && KNOWN_THEMES.has(rawTheme) ? rawTheme : (rawTheme ? 'custom' : 'deepseek')
    const layout = state.prefs?.layout === 'flat' ? 'flat' : 'bubble'
    const rawArch = arch()
    const day = utcDay(now)

    return {
      schema_v: 1,
      type: 'daily',
      anon_id: data.anonId,
      day,
      app_version: ownVersion(),
      dsh_version: dshVersion() ?? 'unknown',
      surface: detectSurface(),
      os: coarseOs(),
      arch: ARCHS.has(rawArch) ? rawArch : 'unknown',
      locale: normalizeLocale(rt.uiLocale?.() ?? rt.uiLanguage?.()),
      is_first_day: data.firstSeenDay === day,
      bot_count_bucket: botCountBucket(publicBots.length),
      group_count_bucket: smallCountBucket(rooms.length),
      turns_bucket: turnsBucket(data.daily.turns),
      connectors_count_bucket: smallCountBucket(connectedCount),
      theme,
      layout,
      providers_used: [...providers].sort(),
      local_agents_used: [...localAgents].sort(),
      features_active: [...features].filter(f => KNOWN_FEATURES.has(f)).sort(),
      im_platforms: [...imPlatforms].sort(),
    }
  }

  const sendPayload = async (payload) => {
    if (isDisabled() || typeof fetchFn !== 'function' || stopped) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response?.ok) return false
      data.recentSent.push({ sentAt: new Date(nowFn()).toISOString(), payload })
      if (data.recentSent.length > RECENT_MAX) data.recentSent = data.recentSent.slice(-RECENT_MAX)
      await persist()
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const maybeSendDaily = async () => {
    if (pingInFlight || stopped || isDisabled() || rt.readOnly?.() !== undefined) return false
    if (!isNoticeCurrent() || !data.usage) return false
    const now = nowFn()
    rotateIfNeeded(now)
    const day = utcDay(now)
    if (data.lastPingDay === day) return false
    pingInFlight = true
    try {
      const payload = await buildDailyPayload(now)
      if (stopped || isDisabled() || rt.readOnly?.() !== undefined || !isNoticeCurrent() || !data.usage) return false
      const ok = await sendPayload(payload)
      if (ok) {
        data.lastPingDay = day
        await persist()
      }
      return ok
    } finally {
      pingInFlight = false
    }
  }

  const noteError = async ({ source = 'host', errorName, code, where, stack, bot, botId, sessionId } = {}) => {
    if (stopped || isDisabled() || rt.readOnly?.() !== undefined) return false
    if (!isNoticeCurrent() || !data.errors) return false
    if (isPrivateBotRef(botId) || isPrivateBotRef(bot)) return false
    if (sessionId && isPrivateSession(sessionId)) return false

    const safeSource = ERROR_SOURCES.has(source) ? source : 'host'
    const rawName = normalizeErrorName(errorName)
    const safeCode = normalizeErrorCode(code)
    const safeWhere = normalizeWhere(where)
    const frames = sanitizeStack(stack)
    const fp = errorFingerprint({ source: safeSource, errorName: rawName, errorCode: safeCode, where: safeWhere, frames })

    const now = nowFn()
    rotateIfNeeded(now)
    const day = utcDay(now)
    const counts = data.sentErrors.counts
    const already = counts[fp] ?? 0
    if (already === 0 && Object.keys(counts).length >= MAX_ERRORS_PER_DAY) return false
    counts[fp] = Math.min(already + 1, 1000)
    // Send once per unique fingerprint per UTC day.
    if (already > 0) {
      void persist()
      return false
    }
    const rawArch = arch()
    const payload = {
      schema_v: 1,
      type: 'error',
      anon_id: data.anonId,
      day,
      app_version: ownVersion(),
      dsh_version: dshVersion() ?? 'unknown',
      surface: detectSurface(),
      os: coarseOs(),
      arch: ARCHS.has(rawArch) ? rawArch : 'unknown',
      source: safeSource,
      error_name: rawName,
      ...(safeCode ? { error_code: safeCode } : {}),
      ...(safeWhere ? { where: safeWhere } : {}),
      stack_frames: frames,
      fingerprint: fp,
      count: 1,
    }
    const ok = await sendPayload(payload)
    if (!ok) delete counts[fp]
    else await persist()
    return ok
  }

  const syncDshSessionLog = async (enabled) => {
    const settings = ctx.get?.('settings') ?? ctx.settings
    if (!settings?.writable || typeof settings.mutate !== 'function') return
    try {
      await settings.mutate('session-log-deepseek', [{ op: 'set', path: ['enabled'], value: Boolean(enabled) }])
    } catch { /* best-effort; registerExclusion remains authoritative */ }
  }

  const status = () => {
    rotateIfNeeded()
    const reason = envReason()
    return {
      noticeAccepted: data.noticeAccepted,
      noticeVersion: data.noticeVersion,
      usage: data.usage,
      errors: data.errors,
      dshSessionLog: data.dshSessionLog,
      dshFeedbackTelemetry: data.dshFeedbackTelemetry,
      anonId: data.anonId,
      anonMonth: data.anonMonth,
      lastPingDay: data.lastPingDay,
      envDisabled: reason !== null,
      envReason: reason,
      endpoint: endpoint ?? DEFAULT_ENDPOINT,
      privacyUrl: PRIVACY_POLICY_URL,
      recentSent: [...data.recentSent].reverse(),
    }
  }

  const update = async (patch = {}) => {
    const wasCurrent = isNoticeCurrent()
    const wasUsage = data.usage
    if (typeof patch.noticeAccepted === 'boolean') {
      data.noticeAccepted = patch.noticeAccepted
      data.noticeVersion = NOTICE_VERSION
      // On first-time consent, each switch requires explicit opt-in; never silently
      // enable usage statistics when the user only toggles error reports.
      if (!wasCurrent && patch.noticeAccepted === true) {
        if (typeof patch.usage !== 'boolean') data.usage = false
        if (typeof patch.errors !== 'boolean') data.errors = false
      }
    }
    if (typeof patch.usage === 'boolean') data.usage = patch.usage
    if (typeof patch.errors === 'boolean') data.errors = patch.errors
    if (typeof patch.dshSessionLog === 'boolean') {
      data.dshSessionLog = patch.dshSessionLog
      void syncDshSessionLog(data.dshSessionLog)
    }
    if (typeof patch.dshFeedbackTelemetry === 'boolean') {
      data.dshFeedbackTelemetry = patch.dshFeedbackTelemetry
    }
    await persist()
    if (isNoticeCurrent() && data.usage && (!wasCurrent || !wasUsage)) {
      void maybeSendDaily()
    }
    return status()
  }

  const resetId = async () => {
    data.anonId = randomUUID()
    data.anonMonth = utcMonth(nowFn())
    await persist()
    return status()
  }

  const clearLog = async () => {
    data.recentSent = []
    await persist()
    return status()
  }

  const shouldPromptNotice = () => !isNoticeCurrent() && !isDisabled() && rt.readOnly?.() === undefined

  if (!configDisabled) {
    startTimer = setTimeout(() => { void maybeSendDaily() }, STARTUP_DELAY_MS)
    startTimer.unref?.()
    periodicTimer = setInterval(() => { void maybeSendDaily() }, CHECK_INTERVAL_MS)
    periodicTimer.unref?.()
  }

  ctx.effect?.(() => () => {
    stopped = true
    if (startTimer !== null) clearTimeout(startTimer)
    if (periodicTimer !== null) clearInterval(periodicTimer)
    return saving
  }, 'ds-bot: telemetry')

  rt.telemetry = {
    status,
    update,
    resetId,
    clearLog,
    noteError,
    noteFeature,
    maybeSendDaily,
    buildDailyPayload,
    shouldPromptNotice,
    isPrivateSession,
  }
}
