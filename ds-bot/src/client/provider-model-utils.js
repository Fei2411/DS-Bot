// Pure validation, capacity formatting, and protocol helpers shared by the Models
// provider and model list editors. Kept in step with DSH's llm-deepseek and llm-pi-ai schemas.

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 }
const GEMINI_PROTOCOL = 'google-generative-ai'
const GEMINI_LEVELS = ['minimal', 'low', 'medium', 'high']
const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const INITIAL_REASONING_LEVELS = ['off', 'low', 'medium', 'high']
export const DEFAULT_CAPACITY_HINTS = { contextWindow: '1M', maxTokens: '128K' }

export function parseCapacity(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

export function formatCapacity(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return typeof value === 'number' ? String(value) : ''
  }
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
  return String(value)
}

export function protocolNeedsKey(protocol) {
  return protocol === GEMINI_PROTOCOL
}

export function protocolReasoningLevels(protocol, levels) {
  const list = Array.isArray(levels) ? levels : []
  if (protocol !== GEMINI_PROTOCOL) return { levels: list, levelsOnly: false }
  return { levels: list.filter(level => GEMINI_LEVELS.includes(level)), levelsOnly: true }
}

export function defaultEffortValue(level) {
  return level === 'off' ? null : level
}

export function acceptedEffortValue(level, wire) {
  return typeof wire === 'string' ? wire.trim().length > 0 : wire === null && level === 'off'
}

export function readEfforts(model) {
  const value = model?.reasoningEfforts
  if (value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.entries(value)
}

export function withEfforts(model, entries) {
  const next = { ...model }
  if (entries === undefined) {
    delete next.reasoningEfforts
    return next
  }
  next.reasoningEfforts = Object.fromEntries(entries)
  return next
}

export function normalizeModelDrafts(value) {
  if (!Array.isArray(value)) return []
  return value.map(entry => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : {}))
}

export function validateReasoningEfforts(models, onlyLevels) {
  const list = normalizeModelDrafts(models)
  for (let index = 0; index < list.length; index += 1) {
    const entries = readEfforts(list[index])
    if (entries === undefined) continue
    if (Array.isArray(onlyLevels) && entries.some(([level, wire]) => !onlyLevels.includes(level) || wire !== level)) {
      return { index, key: 'Gemini supports only minimal, low, medium, and high' }
    }
    if (entries.some(([level, wire]) => !acceptedEffortValue(level, wire))) {
      return { index, key: 'Enter an API value for each reasoning level' }
    }
    if (!entries.some(([level]) => level !== 'off')) {
      return { index, key: 'Add at least one reasoning level besides Off' }
    }
  }
  return undefined
}

export function validateModelRows(models, { reasoningLevelsOnly, reasoningLevels, requireNonEmpty = false } = {}) {
  const list = normalizeModelDrafts(models)
  if (requireNonEmpty && list.length === 0) {
    return { index: -1, key: 'Add at least one model' }
  }
  const seen = new Set()
  for (let index = 0; index < list.length; index += 1) {
    const model = list[index]
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (id.length === 0) return { index, key: 'Every model needs an ID' }
    if (seen.has(id)) return { index, key: 'Duplicate model ID' }
    seen.add(id)
    if (model.name !== undefined && (typeof model.name !== 'string' || model.name.trim().length === 0)) {
      return { index, key: 'Model display name cannot be blank' }
    }
    if (model.contextWindow !== undefined && (typeof model.contextWindow !== 'number' || !Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      return { index, key: 'Context window must be a positive whole number' }
    }
    if (model.maxTokens !== undefined && (typeof model.maxTokens !== 'number' || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      return { index, key: 'Max output tokens must be a positive whole number' }
    }
  }
  return validateReasoningEfforts(list, reasoningLevelsOnly ? reasoningLevels : undefined)
}

export function isValidRouteId(route) {
  return typeof route === 'string' && ROUTE_PATTERN.test(route)
}

export function validateBaseUrl(text, { strictDeepSeek = false } = {}) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return undefined
  let url
  try { url = new URL(trimmed) } catch { return 'Enter the endpoint as an http or https address' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Enter the endpoint as an http or https address'
  if (strictDeepSeek && (url.username || url.password || url.search || url.hash)) {
    return 'Base URL must not include credentials, query, or fragment'
  }
  return undefined
}

function isQuoted(value) {
  const first = value[0]
  if (first !== '"' && first !== "'" && first !== '`') return false
  return value.length > 1 && value.endsWith(first)
}

export function validateApiKeyDraft(draft, { required = false } = {}) {
  const raw = String(draft ?? '')
  if (raw.length === 0) return required ? 'API key is required' : undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Enter the API key'
  if (ENV_LINE.test(trimmed)) return 'Paste only the key, not a NAME=value line'
  if (isQuoted(trimmed)) return 'Paste the key without quotes'
  if (!LEGAL_API_KEY.test(trimmed)) return 'An API key has no spaces or special characters'
  return undefined
}
