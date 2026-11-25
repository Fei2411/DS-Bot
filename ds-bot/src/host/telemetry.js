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
import { dirname, join } from 'node:path'
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
const KNOWN_THEMES = new Set(['deepseek', 'mono', 'paper', 'moonlight', 'celadon'])
const KNOWN_IM = new Set(['telegram', 'feishu', 'discord', 'slack', 'dingtalk', 'wecom', 'qq', 'weixin'])
const KNOWN_FEATURES = new Set([
  'group_chat', 'background_task', 'bot_browser', 'computer_use', 'schedule',
  'phone_link', 'im_bridge', 'memory_recall', 'office_docs', 'voice_input',
  'local_api', 'connectors', 'capabilities', 'plugins', 'secrets',
])
const ERROR_SOURCES = new Set(['host', 'electron-main', 'renderer', 'turn', 'update'])
const ARCHS = new Set(['arm64', 'x64', 'ia32', 'arm'])

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const CODE_RE = /^[A-Za-z0-9_/-]{1,48}$/
const WHERE_RE = /^[a-z][a-z0-9._-]{0,47}$/
const FRAME_CHECK_RE = /^(?:[A-Za-z0-9_$.<> -]{1,64} @ )?(?:ds-bot|app|link|mobile)\/[A-Za-z0-9_./-]{1,120}(?::[0-9]{1,6}(?::[0-9]{1,5})?)?$/

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)
const utcMonth = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

const ownVersion = () => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function envDisabledReason(env = process.env) {
  if (typeof env.DS_BOT_TELEMETRY_DISABLED === 'string' && env.DS_BOT_TELEMETRY_DISABLED !== '') {
    return 'DS_BOT_TELEMETRY_DISABLED'
  }
  const dnt = typeof env.DO_NOT_TRACK === 'string' ? env.DO_NOT_TRACK.trim().toLowerCase() : ''
  if (dnt === '1' || dnt === 'true') return 'DO_NOT_TRACK'
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
    let fn = ''
    let loc = body
    const paren = body.match(/^(.+?)\s+\((.+)\)$/)
    if (paren) {
      fn = paren[1].replace(/^async\s+/, '').trim()
      loc = paren[2].trim()
    }
    const normalized = loc.replace(/\\/g, '/').replace(/[?#][^:]*/g, '')
    const match = /(?:^|.*\/)((?:ds-bot|app|link|mobile)\/[A-Za-z0-9_./-]{1,120})(?::(\d{1,6})(?::(\d{1,5}))?)?$/.exec(normalized)
    if (!match) continue
    const rel = match[1]
    if (rel.includes('..') || rel.includes('/node_modules/')) continue
    const coords = match[2] ? `:${match[2]}${match[3] ? `:${match[3]}` : ''}` : ''
    const safeFn = fn && /^[A-Za-z0-9_$.<> -]{1,64}$/.test(fn) ? `${fn} @ ` : ''
    const frame = `${safeFn}${rel}${coords}`
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
    usage: true,
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
    return {
      version: 1,
      noticeAccepted: parsed.noticeAccepted === true,
      noticeVersion: Number.isInteger(parsed.noticeVersion) ? parsed.noticeVersion : NOTICE_VERSION,
      usage: parsed.usage !== false,
      errors: parsed.errors === true,
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

  const envReason = () => (configDisabled ? 'config' : envDisabledReason(process.env))
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

  // Synchronous check used by DSH `sessionLogDeepSeek.registerExclusion` and
  // `session-telemetry/record` to guarantee private Bots never upload logs.
  const isPrivateSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const owner = rt.selfOf?.(sessionId)
    if (owner !== undefined && rt.isPrivate?.(owner)) return true
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot?.private !== true) continue
      if (bot.id === sessionId || rt.chatOf?.(bot.id) === sessionId) return true
      if (Array.isArray(bot.segments) && bot.segments.some(seg => seg?.sessionId === sessionId)) return true
      if (Array.isArray(bot.tasks) && bot.tasks.some(task => task?.sessionId === sessionId)) return true
      if (Array.isArray(bot.retiredTasks) && bot.retiredTasks.some(task => task?.sessionId === sessionId)) return true
    }
    for (const archive of rt.state?.privateArchives ?? []) {
      if (archive?.id === sessionId) return true
      if (Array.isArray(archive?.sessionIds) && archive.sessionIds.includes(sessionId)) return true
    }
    // Walk live parentSession chain for subagents spawned by a private Bot.
    const seen = new Set([sessionId])
    let cur = ctx.sessions?.get?.(sessionId)?.header?.parentSession
    while (cur !== undefined && !seen.has(String(cur))) {
      const id = String(cur)
      seen.add(id)
      const parentOwner = rt.selfOf?.(id)
      if (parentOwner !== undefined && rt.isPrivate?.(parentOwner)) return true
      cur = ctx.sessions?.get?.(id)?.header?.parentSession
    }
    return false
  }

  // --- DSH upstream telemetry safeguards (without patching DSH) ---
  // 1. Official DeepSeek API incremental session-log upload: excluded by default,
  //    and permanently excluded for all private Bots.
  ctx.inject?.(['sessionLogDeepSeek'], (child) => {
    if (typeof child.sessionLogDeepSeek?.registerExclusion !== 'function') return
    child.sessionLogDeepSeek.registerExclusion((request) => {
      if (!data.dshSessionLog) return true
      if (isPrivateSession(request?.sessionId)) return true
      return false
    })
  })

  // 2. OTLP feedback telemetry redaction & opt-in gate: DSH ships no default redaction
  //    rules, so we withhold unless enabled, always block private Bots, and scrub secrets/paths.
  ctx.on?.('session-telemetry/record', (record, next) => {
    const sid = record?.sourceEvent?.sessionId ?? record?.attributes?.['session.id']
    if (!data.dshFeedbackTelemetry || isPrivateSession(sid)) {
      return { ...record, sourceEvent: undefined }
    }
    const scrub = text => cleanText(text, { redact: rt.redactSecrets ?? (v => v) })
    const attrs = record.attributes && typeof record.attributes === 'object' ? { ...record.attributes } : undefined
    if (attrs && typeof attrs['session.cwd'] === 'string') attrs['session.cwd'] = '~'
    return next({
      ...record,
      ...(attrs ? { attributes: redactDeep(attrs, scrub) } : {}),
      body: redactDeep(record.body, scrub),
    })
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

  const buildDailyPayload = (now = nowFn()) => {
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
    if (Array.isArray(rt.schedulesView?.()) && rt.schedulesView().length > 0) features.add('schedule')
    if (rt.phoneView?.()?.paired === true || (rt.phoneView?.()?.devices?.length ?? 0) > 0) features.add('phone_link')
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
    const connectors = rt.connectorsView?.() ?? []
    const connectedCount = Array.isArray(connectors) ? connectors.filter(c => c?.connected === true || c?.status === 'connected').length : 0
    if (connectedCount > 0) features.add('connectors')
    if (Object.keys(state.capabilities?.items ?? {}).length > 0) features.add('capabilities')
    if ((rt.pluginsSummary?.()?.installed ?? 0) > 0) features.add('plugins')
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
    if (!data.noticeAccepted || !data.usage) return false
    const now = nowFn()
    rotateIfNeeded(now)
    const day = utcDay(now)
    if (data.lastPingDay === day) return false
    pingInFlight = true
    try {
      const payload = buildDailyPayload(now)
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

  const noteError = async ({ source = 'host', errorName, code, where, stack, botId, sessionId } = {}) => {
    if (stopped || isDisabled() || rt.readOnly?.() !== undefined) return false
    if (!data.noticeAccepted || !data.errors) return false
    if (botId && rt.isPrivate?.(botId)) return false
    if (sessionId && isPrivateSession(sessionId)) return false

    const safeSource = ERROR_SOURCES.has(source) ? source : 'host'
    const rawName = typeof errorName === 'string' && IDENT_RE.test(errorName) ? errorName : 'Error'
    const safeCode = typeof code === 'string' && CODE_RE.test(code) ? code : undefined
    const rawWhere = typeof where === 'string' ? where.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48) : ''
    const safeWhere = rawWhere && WHERE_RE.test(rawWhere) ? rawWhere : undefined
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
    const wasAccepted = data.noticeAccepted
    const wasUsage = data.usage
    if (typeof patch.noticeAccepted === 'boolean') {
      data.noticeAccepted = patch.noticeAccepted
      data.noticeVersion = NOTICE_VERSION
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
    if (data.noticeAccepted && data.usage && (!wasAccepted || !wasUsage)) {
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

  const shouldPromptNotice = () => !data.noticeAccepted && !isDisabled() && rt.readOnly?.() === undefined

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
