// Strict allowlist validator for DS Bot anonymous telemetry payloads.
// Rejects any unknown field, free-text message, absolute path, or oversized body.

export const MAX_BODY_BYTES = 8 * 1024

export const SURFACES = new Set(['desktop', 'dsh-desktop', 'dsh-web', 'docker', 'mobile', 'unknown'])
export const ARCHS = new Set(['arm64', 'x64', 'ia32', 'arm', 'unknown'])
export const BOT_BUCKETS = new Set(['0', '1', '2-3', '4-7', '8+'])
export const GROUP_BUCKETS = new Set(['0', '1-2', '3+'])
export const TURN_BUCKETS = new Set(['0', '1-5', '6-20', '21-50', '51+'])
export const CONNECTOR_BUCKETS = new Set(['0', '1-2', '3+'])
export const THEMES = new Set(['deepseek', 'mono', 'paper', 'moonlight', 'fei', 'celadon', 'custom'])
export const LAYOUTS = new Set(['bubble', 'flat'])
export const PROVIDERS = new Set([
  'deepseek-official', 'deepseek-account', 'openai', 'anthropic', 'google',
  'openrouter', 'xai', 'mistral', 'groq', 'ollama', 'lmstudio', 'chatgpt',
  'azure', 'bedrock', 'vertex', 'custom',
])
export const LOCAL_AGENTS = new Set([
  'claude-code', 'codex', 'gemini', 'antigravity', 'opencode', 'cursor', 'devin', 'qoder', 'custom',
])
export const FEATURES = new Set([
  'group_chat', 'background_task', 'bot_browser', 'computer_use', 'schedule',
  'phone_link', 'im_bridge', 'memory_recall', 'office_docs', 'voice_input',
  'local_api', 'connectors', 'capabilities', 'plugins', 'secrets',
])
export const IM_PLATFORMS = new Set([
  'telegram', 'feishu', 'discord', 'slack', 'dingtalk', 'wecom', 'qq', 'weixin',
])
export const ERROR_SOURCES = new Set(['host', 'electron-main', 'renderer', 'turn', 'update'])
export const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'DOMException',
  'SystemError', 'AssertionError', 'HttpError', 'NetworkError', 'AuthError',
  'QuotaError', 'ConfigError', 'SqliteError',
])
export const SAFE_ERROR_CODES = new Set([
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
export const SAFE_WHERE = new Set([
  'turns', 'groups', 'memory', 'browser', 'store', 'channel', 'schedule', 'connector',
  'im', 'phone', 'api', 'computer', 'plugins', 'secrets', 'update', 'overlay',
  'own-chat', 'group-chat', 'other',
])

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const VERSION_RE = /^(?:unknown|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?)$/
const OS_RE = /^(?:darwin|win32|linux|ios|android|unknown)(?: [0-9]{1,3})?$/
const LOCALE_RE = /^(?:unknown|[a-z]{2}(?:-[A-Z]{2})?)$/
const FINGERPRINT_RE = /^[0-9a-f]{16}$/
// Only relative DS Bot package source frames (no arbitrary function names or non-source paths).
const FRAME_RE = /^(?:ds-bot|app|link|mobile)\/(?:(?:ui\/)?src\/|scripts\/|engine\/)?[A-Za-z0-9_/-]{1,96}\.(?:js|mjs|cjs|ts|tsx)(?::[0-9]{1,6}(?::[0-9]{1,5})?)?$/

function isValidErrorCode(code) {
  return typeof code === 'string' && (SAFE_ERROR_CODES.has(code) || HTTP_ERROR_CODE_RE.test(code))
}

const DAILY_KEYS = new Set([
  'schema_v', 'type', 'anon_id', 'day', 'app_version', 'dsh_version',
  'surface', 'os', 'arch', 'locale', 'is_first_day',
  'bot_count_bucket', 'group_count_bucket', 'turns_bucket', 'connectors_count_bucket',
  'theme', 'layout', 'providers_used', 'local_agents_used', 'features_active', 'im_platforms',
])

const ERROR_KEYS = new Set([
  'schema_v', 'type', 'anon_id', 'day', 'app_version', 'dsh_version',
  'surface', 'os', 'arch', 'source', 'error_name', 'error_code', 'where',
  'stack_frames', 'fingerprint', 'count',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter(key => !allowed.has(key))
}

function enumList(value, allowed, max) {
  if (!Array.isArray(value) || value.length > max) return null
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) return null
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  out.sort()
  return out
}

function validDay(day, nowMs) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false
  const parsed = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(parsed)) return false
  const serverDay = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`)
  // Allow +/- 1 day for clock skew near UTC midnight.
  return Math.abs(parsed - serverDay) <= 86_400_000
}

export function validatePayload(raw, nowMs = Date.now()) {
  if (!isPlainObject(raw)) return { ok: false, error: 'body must be a JSON object' }
  if (raw.schema_v !== 1) return { ok: false, error: 'unsupported schema_v' }
  if (raw.type !== 'daily' && raw.type !== 'error') return { ok: false, error: 'invalid type' }

  const extra = unknownKeys(raw, raw.type === 'daily' ? DAILY_KEYS : ERROR_KEYS)
  if (extra.length > 0) return { ok: false, error: `unexpected fields: ${extra.join(', ')}` }

  if (typeof raw.anon_id !== 'string' || !UUID_V4.test(raw.anon_id)) return { ok: false, error: 'invalid anon_id' }
  if (!validDay(raw.day, nowMs)) return { ok: false, error: 'invalid day' }
  if (typeof raw.app_version !== 'string' || !VERSION_RE.test(raw.app_version)) return { ok: false, error: 'invalid app_version' }
  if (typeof raw.dsh_version !== 'string' || !VERSION_RE.test(raw.dsh_version)) return { ok: false, error: 'invalid dsh_version' }
  if (typeof raw.surface !== 'string' || !SURFACES.has(raw.surface)) return { ok: false, error: 'invalid surface' }
  if (typeof raw.os !== 'string' || !OS_RE.test(raw.os)) return { ok: false, error: 'invalid os' }
  if (typeof raw.arch !== 'string' || !ARCHS.has(raw.arch)) return { ok: false, error: 'invalid arch' }

  if (raw.type === 'daily') {
    if (typeof raw.locale !== 'string' || !LOCALE_RE.test(raw.locale)) return { ok: false, error: 'invalid locale' }
    if (typeof raw.is_first_day !== 'boolean') return { ok: false, error: 'invalid is_first_day' }
    if (typeof raw.bot_count_bucket !== 'string' || !BOT_BUCKETS.has(raw.bot_count_bucket)) return { ok: false, error: 'invalid bot_count_bucket' }
    if (typeof raw.group_count_bucket !== 'string' || !GROUP_BUCKETS.has(raw.group_count_bucket)) return { ok: false, error: 'invalid group_count_bucket' }
    if (typeof raw.turns_bucket !== 'string' || !TURN_BUCKETS.has(raw.turns_bucket)) return { ok: false, error: 'invalid turns_bucket' }
    if (typeof raw.connectors_count_bucket !== 'string' || !CONNECTOR_BUCKETS.has(raw.connectors_count_bucket)) return { ok: false, error: 'invalid connectors_count_bucket' }
    if (typeof raw.theme !== 'string' || !THEMES.has(raw.theme)) return { ok: false, error: 'invalid theme' }
    if (typeof raw.layout !== 'string' || !LAYOUTS.has(raw.layout)) return { ok: false, error: 'invalid layout' }

    const providers = enumList(raw.providers_used, PROVIDERS, 16)
    const localAgents = enumList(raw.local_agents_used, LOCAL_AGENTS, 10)
    const features = enumList(raw.features_active, FEATURES, 20)
    const imPlatforms = enumList(raw.im_platforms, IM_PLATFORMS, 10)
    if (!providers || !localAgents || !features || !imPlatforms) return { ok: false, error: 'invalid enum array' }

    return {
      ok: true,
      value: {
        schema_v: 1,
        type: 'daily',
        anon_id: raw.anon_id.toLowerCase(),
        day: raw.day,
        app_version: raw.app_version,
        dsh_version: raw.dsh_version,
        surface: raw.surface,
        os: raw.os,
        arch: raw.arch,
        locale: raw.locale,
        is_first_day: raw.is_first_day,
        bot_count_bucket: raw.bot_count_bucket,
        group_count_bucket: raw.group_count_bucket,
        turns_bucket: raw.turns_bucket,
        connectors_count_bucket: raw.connectors_count_bucket,
        theme: raw.theme,
        layout: raw.layout,
        providers_used: providers,
        local_agents_used: localAgents,
        features_active: features,
        im_platforms: imPlatforms,
      },
    }
  }

  // type === 'error'
  if (typeof raw.source !== 'string' || !ERROR_SOURCES.has(raw.source)) return { ok: false, error: 'invalid source' }
  if (typeof raw.error_name !== 'string' || !SAFE_ERROR_NAMES.has(raw.error_name)) return { ok: false, error: 'invalid error_name' }
  if (raw.error_code !== undefined && !isValidErrorCode(raw.error_code)) return { ok: false, error: 'invalid error_code' }
  if (raw.where !== undefined && (typeof raw.where !== 'string' || !SAFE_WHERE.has(raw.where))) return { ok: false, error: 'invalid where' }
  if (!Array.isArray(raw.stack_frames) || raw.stack_frames.length > 8) return { ok: false, error: 'invalid stack_frames' }
  for (const frame of raw.stack_frames) {
    if (typeof frame !== 'string' || !FRAME_RE.test(frame) || frame.includes('..')) {
      return { ok: false, error: 'invalid stack frame' }
    }
  }
  if (typeof raw.fingerprint !== 'string' || !FINGERPRINT_RE.test(raw.fingerprint)) return { ok: false, error: 'invalid fingerprint' }
  if (!Number.isInteger(raw.count) || raw.count < 1 || raw.count > 1000) return { ok: false, error: 'invalid count' }

  return {
    ok: true,
    value: {
      schema_v: 1,
      type: 'error',
      anon_id: raw.anon_id.toLowerCase(),
      day: raw.day,
      app_version: raw.app_version,
      dsh_version: raw.dsh_version,
      surface: raw.surface,
      os: raw.os,
      arch: raw.arch,
      source: raw.source,
      error_name: raw.error_name,
      error_code: raw.error_code ?? '',
      where: raw.where ?? '',
      stack_frames: [...raw.stack_frames],
      fingerprint: raw.fingerprint.toLowerCase(),
      count: raw.count,
    },
  }
}
