// Model providers and their API keys, for a window that has no DSH Models page of its
// own. DSH keeps all of it: a provider route in the settings of the adapter that serves
// it, the route's key in DSH's credential store under the reference the route names.
// The providers to add are the ones DSH's directory of configurable providers offers.

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { serviceOf } from './services.js'
import { CHATGPT_PROVIDER } from './chatgpt.js'

const PI_AI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
// The baseline wire protocols DSH's pi-ai adapter serves on a custom route; newer DSH
// builds advertise any additional protocols (such as `google-generative-ai`) in their
// `llm-pi-ai` settings schema.
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
// The protocols whose model-listing the pi-ai adapter can read. A route on any other
// protocol has no refresh entry: the adapter would answer DISCOVERY_UNSUPPORTED.
const GEMINI_PROTOCOL = 'google-generative-ai'
const LISTABLE_PROTOCOLS = new Set([...PROTOCOLS, GEMINI_PROTOCOL])
const DEFAULT_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const GEMINI_LEVELS = new Set(['minimal', 'low', 'medium', 'high'])
const isKeylessNativeAuth = entry => entry?.nativeAuth !== undefined
  && (entry.nativeAuth.env ?? []).length === 0
  && entry.nativeAuth.oauth === true
const MODALITIES = new Set(['text', 'image'])
const CRED_BATCH_SIZE = 64
const MAX_MODELS = 500
// pi-ai guesses compatibility from the endpoint hostname and treats any unrecognized
// gateway as OpenAI's own server (sending the `developer` role, `store: false`, and
// `max_completion_tokens`). Every OpenAI-compatible server accepts `system` and
// `max_tokens`, and reasoning models such as Kimi and DeepSeek require
// `reasoning_content` on replayed assistant messages.
const CUSTOM_COMPAT = {
  'openai-completions': {
    supportsDeveloperRole: false,
    supportsStore: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
  'openai-responses': {
    supportsDeveloperRole: false,
  },
}
const RESPONSES_PROVIDERS = new Set(['openai', 'xai', 'meta'])
const COMPLETIONS_PROVIDERS = new Set([
  'ant-ling', 'baseten', 'cerebras', 'cloudflare-ai-gateway', 'cloudflare-workers-ai',
  'deepseek', 'fireworks', 'github-copilot', 'groq', 'huggingface', 'kimi-coding',
  'moonshotai', 'moonshotai-cn', 'nvidia', 'opencode', 'opencode-go', 'openrouter',
  'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'together',
  'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
  'zai', 'zai-coding-cn',
])
const catalogProtocol = id => (RESPONSES_PROVIDERS.has(id) ? 'openai-responses' : COMPLETIONS_PROVIDERS.has(id) ? 'openai-completions' : undefined)

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function schemaAt(schema, target) {
  const refs = schema?.refs
  if (typeof target === 'number' || typeof target === 'string') return refs?.[String(target)]
  return target
}

function schemaNodeAt(schema, path) {
  let node = schemaAt(schema, schema?.uid ?? schema)
  for (const segment of path) {
    if (!node || typeof node !== 'object') return undefined
    if (node.type === 'object' && node.dict) {
      node = schemaAt(schema, node.dict[segment])
    } else if (node.type === 'dict' || node.type === 'array') {
      node = schemaAt(schema, node.inner)
    } else {
      return undefined
    }
  }
  return node
}

function protocolsOf(section) {
  const schema = section?.schema
  const api = schemaNodeAt(schema, ['providers', '_probe', 'api'])
  const fromSchema = api?.list?.map(item => schemaAt(schema, item)?.value).filter(item => typeof item === 'string' && item !== '')
  return Array.isArray(fromSchema) && fromSchema.length > 0 ? fromSchema : PROTOCOLS
}

function reasoningLevelsOf(section) {
  const schema = section?.schema
  const node = schemaNodeAt(schema, ['providers', '_probe', 'models', '0', 'reasoningEfforts'])
  const branches = Array.isArray(node?.list) ? node.list.map(item => schemaAt(schema, item)) : []
  const dictBranch = branches.find(branch => branch?.type === 'dict')
  const keyUnion = schemaAt(schema, dictBranch?.sKey)
  const fromSchema = keyUnion?.list?.map(item => schemaAt(schema, item)?.value).filter(item => typeof item === 'string' && item !== '')
  return Array.isArray(fromSchema) && fromSchema.length > 0 ? fromSchema : DEFAULT_REASONING_LEVELS
}

function readPath(obj, path) {
  let cursor = obj
  for (const key of path) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function numberMeta(node, inheritedValue) {
  const meta = node?.meta ?? {}
  return {
    ...(inheritedValue !== undefined ? { default: inheritedValue } : meta.default !== undefined ? { default: meta.default } : {}),
    ...(typeof meta.min === 'number' ? { min: meta.min } : {}),
    ...(typeof meta.max === 'number' ? { max: meta.max } : {}),
    ...(typeof meta.step === 'number' ? { step: meta.step } : {}),
  }
}

function retryDefaultsOf(section, settingsPath, basePolicy) {
  const schema = section?.schema
  const node = schemaNodeAt(schema, [...settingsPath, 'retryPolicy'])
  if (!node || !Array.isArray(node.list)) return undefined
  const modes = []
  const branches = {}
  for (const rawBranch of node.list) {
    const branch = schemaAt(schema, rawBranch)
    if (!branch?.dict) continue
    const modeNode = schemaAt(schema, branch.dict.mode)
    const mode = typeof modeNode?.value === 'string' ? modeNode.value : undefined
    if (!mode) continue
    modes.push(mode)
    const fields = {}
    for (const [key, rawField] of Object.entries(branch.dict)) {
      if (key === 'mode') continue
      const field = schemaAt(schema, rawField)
      if (!field) continue
      if (field.type === 'number') {
        fields[key] = { type: 'number', ...numberMeta(field, readPath(basePolicy, [key])) }
      } else if (field.type === 'array') {
        const inner = schemaAt(schema, field.inner)
        const choices = (inner?.list ?? [])
          .map(item => schemaAt(schema, item))
          .filter(item => item?.type === 'const' && typeof item.value === 'string')
          .map(item => item.value)
        const inherited = readPath(basePolicy, [key])
        const defaultCodes = Array.isArray(inherited) ? inherited : (Array.isArray(field.meta?.default) ? field.meta.default : [])
        fields[key] = { type: 'codes', choices, default: [...defaultCodes] }
      } else if (field.type === 'object' && field.dict) {
        const nested = {}
        for (const [subKey, rawSub] of Object.entries(field.dict)) {
          const sub = schemaAt(schema, rawSub)
          if (sub?.type === 'number') {
            nested[subKey] = { type: 'number', ...numberMeta(sub, readPath(basePolicy, [key, subKey])) }
          }
        }
        fields[key] = { type: 'object', fields: nested }
      }
    }
    branches[mode] = fields
  }
  if (modes.length === 0) return undefined
  const storedMode = isRecord(basePolicy) && typeof basePolicy.mode === 'string' && modes.includes(basePolicy.mode)
    ? basePolicy.mode
    : modes[0]
  return { modes, defaultMode: storedMode, branches }
}

function schemaDefaultModelsOf(section, settingsPath) {
  const node = schemaNodeAt(section?.schema, [...settingsPath, 'models'])
  return Array.isArray(node?.meta?.default) ? structuredClone(node.meta.default) : []
}

// The reference DSH's own Models page derives for a route's key, so a provider added
// here and one added there read the same key.
export const keyRefFor = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })
const readOnlyErr = message => Object.assign(new Error(message), { code: 'bot/read-only' })

// What an HTTP header can carry, like DSH's own key check: a pasted `NAME=value` line
// or a quoted value would be stored as the key and refused by the provider.
export function checkKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') throw invalid('Enter the API key')
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^=]/.test(key)) throw invalid('Paste only the key, not a NAME=value line')
  if (/^(["']).*\1$/.test(key)) throw invalid('Paste the key without quotes')
  if (!/^[\x21-\x7E]+$/.test(key)) throw invalid('An API key has no spaces or special characters')
  return key
}

function checkEndpoint(value, { strictDeepSeek = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  if (strictDeepSeek && (url.username || url.password || url.search || url.hash)) {
    throw invalid('DeepSeek base URL must be an http or https root without credentials, query, or fragment')
  }
  return text
}

function lookupKnownModel(known, rawId) {
  if (!known || known.size === 0 || typeof rawId !== 'string') return undefined
  const id = rawId.trim().toLowerCase()
  if (id === '') return undefined
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return known.get(id) ?? known.get(bare) ?? (bare.startsWith('kimi-') ? known.get(bare.slice(5)) : known.get(`kimi-${bare}`))
}

const THINKING_LEVELS = new Set(DEFAULT_REASONING_LEVELS)

// DSH's llm-pi-ai schema accepts `false` (explicit non-reasoning) or a dict of
// pi-ai thinking levels with at least one level beyond `off`.
function normalizeReasoningEfforts(raw) {
  if (raw === false) return false
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const mapped = {}
  for (const [level, wire] of Object.entries(raw)) {
    if (!THINKING_LEVELS.has(level)) continue
    if (wire === null && level === 'off') mapped.off = null
    else if (typeof wire === 'string' && wire.trim() !== '') mapped[level] = wire.trim()
  }
  return Object.keys(mapped).some(level => level !== 'off') ? mapped : undefined
}

function validateConfigReasoningEfforts(raw, { protocol } = {}) {
  if (raw === undefined) return undefined
  if (raw === false) return false
  if (!isRecord(raw)) throw invalid('Reasoning levels must be a mapping of level to API value')
  const geminiOnly = protocol === GEMINI_PROTOCOL
  const entries = Object.entries(raw)
  const out = {}
  for (const [level, wire] of entries) {
    if (!THINKING_LEVELS.has(level)) throw invalid(`Unsupported reasoning level "${level}"`)
    if (geminiOnly && (!GEMINI_LEVELS.has(level) || wire !== level)) {
      throw invalid('Gemini supports only minimal, low, medium, and high with default API values')
    }
    if (wire === null) {
      if (level !== 'off') throw invalid(`Reasoning level "${level}" requires an API value`)
      out[level] = null
    } else if (typeof wire === 'string' && wire.trim() !== '') {
      out[level] = wire.trim()
    } else {
      throw invalid(`Reasoning level "${level}" requires an API value`)
    }
  }
  if (!Object.keys(out).some(level => level !== 'off')) {
    throw invalid('Add at least one reasoning level besides Off')
  }
  return out
}

function validateModalities(raw, { required = false } = {}) {
  if (raw === undefined) return required ? ['text'] : undefined
  if (!Array.isArray(raw)) throw invalid('Input types must be a list of modalities')
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || !MODALITIES.has(item)) throw invalid(`Unsupported input type "${String(item)}"`)
    if (!seen.has(item)) { seen.add(item); out.push(item) }
  }
  if (out.length === 0) {
    if (required) throw invalid('Select at least one input type')
    return undefined
  }
  return out
}

function openaiReasoningEfforts(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const mapped = {}
  for (const effort of efforts) {
    const id = typeof effort?.id === 'string' ? effort.id : ''
    // Omit 'off' unless the server explicitly confirmed default_reasoning_level === 'none',
    // so Default (unset effort) keeps omitting `reasoning` instead of sending effort='none'.
    if (id === 'off' || !THINKING_LEVELS.has(id)) continue
    mapped[id] = id
  }
  return normalizeReasoningEfforts(mapped)
}

// Conservative fallback for OpenAI Responses reasoning families when /v1/models omits
// supported_reasoning_levels and no official `openai` route is configured. Never guesses
// 'off' so Default preserves upstream server defaults, and never matches chat-only models.
function fallbackChatGPTReasoningEfforts(rawId) {
  const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
  if (id === '' || id.includes('chat-latest') || /^gpt-4\b|^gpt-4[.-]|^gpt-3\b|^gpt-3[.-]/.test(id)) return undefined
  if (/^gpt-5-pro(?:$|-)/.test(id)) return { high: 'high' }
  if (/^gpt-5\.[245]-pro(?:$|-)/.test(id)) return { medium: 'medium', high: 'high', xhigh: 'xhigh' }
  if (/^gpt-5(?:-mini|-nano)?(?:$|-\d)/.test(id)) return { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }
  if (/^gpt-5\.1(?:$|-)/.test(id)) return { low: 'low', medium: 'medium', high: 'high' }
  if (/^gpt-5\.[2345](?:$|-)/.test(id)) return { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }
  if (/^gpt-(?:5\.[6-9]|[6-9](?:\.\d+)?)(?:$|-)/.test(id)) return { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  if (/^(?:o1|o3|o4-mini)(?:$|-)/.test(id)) return { low: 'low', medium: 'medium', high: 'high' }
  return undefined
}

// A model as the route stores it: what discovery told about it, under pi-ai's names,
// with any missing capacity or modalities filled from a known catalog model of the same id.
function modelEntry(model, known) {
  const id = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : ''
  if (id === '') throw invalid('Every model needs an id')
  const match = lookupKnownModel(known, id)
  const whole = value => (Number.isInteger(value) && value > 0 ? value : undefined)
  const contextWindow = whole(model?.contextWindow) ?? whole(match?.contextWindow)
  const maxTokens = whole(model?.maxTokens)
  const rawInput = Array.isArray(model?.inputModalities) && model.inputModalities.length > 0
    ? model.inputModalities
    : Array.isArray(model?.input) && model.input.length > 0
      ? model.input
      : match?.inputModalities
  const input = Array.isArray(rawInput) ? rawInput.filter(kind => typeof kind === 'string') : []
  const reasoningEfforts = normalizeReasoningEfforts(model?.reasoningEfforts)
  return {
    id,
    ...(typeof model?.name === 'string' && model.name.trim() !== '' ? { name: model.name.trim() } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(input.length > 0 ? { input } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
  }
}

function cleanEditableModel(raw, { family, protocol }) {
  if (!isRecord(raw)) throw invalid('Every model must be an object')
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') throw invalid('Every model needs an id')
  const next = {}
  // Preserve unknown/advanced fields (e.g. compat, description, systemPromptUpdate, toolUpdate)
  // while normalizing and validating every curated field.
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) next[k] = structuredClone(v)
  }
  next.id = id
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw invalid(`Model "${id}" name must be text`)
    const trimmed = raw.name.trim()
    if (trimmed === '') delete next.name
    else next.name = trimmed
  }
  if (raw.contextWindow !== undefined) {
    if (typeof raw.contextWindow !== 'number' || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0) {
      throw invalid(`Model "${id}" context window must be a positive integer`)
    }
    next.contextWindow = raw.contextWindow
  }
  if (raw.maxTokens !== undefined) {
    if (typeof raw.maxTokens !== 'number' || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0) {
      throw invalid(`Model "${id}" max output tokens must be a positive integer`)
    }
    next.maxTokens = raw.maxTokens
  }
  if (family === 'deepseek') {
    delete next.input
    delete next.reasoningEfforts
    const modalities = validateModalities(raw.inputModalities ?? raw.input, { required: true })
    next.inputModalities = modalities
    if (!modalities.includes('image')) {
      delete next.imagePixelBudget
      delete next.imageMaxBytes
    }
  } else {
    delete next.inputModalities
    const input = validateModalities(raw.input ?? raw.inputModalities, { required: false })
    if (input === undefined) delete next.input
    else next.input = input
    if (Object.hasOwn(raw, 'reasoningEfforts') && raw.reasoningEfforts !== undefined) {
      next.reasoningEfforts = validateConfigReasoningEfforts(raw.reasoningEfforts, { protocol })
    } else {
      delete next.reasoningEfforts
    }
  }
  return next
}

function validateRetryPolicyConfig(raw, provider) {
  if (!isRecord(raw)) throw invalid('Retry policy must be an object')
  try {
    resolveRetryPolicy(raw, `provider "${provider}" retryPolicy`)
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error))
  }
  const clean = { mode: raw.mode }
  if (raw.mode === 'normal') {
    if (raw.maxRetries !== undefined) clean.maxRetries = raw.maxRetries
    if (raw.retryableCodes !== undefined) clean.retryableCodes = [...raw.retryableCodes]
  }
  if (isRecord(raw.backoff)) {
    const backoff = {}
    if (raw.backoff.initialDelayMs !== undefined) backoff.initialDelayMs = raw.backoff.initialDelayMs
    if (raw.backoff.maxDelayMs !== undefined) backoff.maxDelayMs = raw.backoff.maxDelayMs
    if (raw.backoff.jitterRatio !== undefined) backoff.jitterRatio = raw.backoff.jitterRatio
    if (Object.keys(backoff).length > 0) clean.backoff = backoff
  }
  return clean
}

function compatForRoute(id, profile) {
  if (typeof profile !== 'object' || profile === null) return undefined
  const api = typeof profile.api === 'string'
    ? profile.api
    : (typeof profile.baseURL === 'string' || Array.isArray(profile.models)) ? catalogProtocol(id) : undefined
  const defaults = CUSTOM_COMPAT[api]
  if (defaults === undefined) return undefined
  const current = typeof profile.compat === 'object' && profile.compat !== null ? profile.compat : {}
  if (Object.keys(defaults).every(key => current[key] !== undefined)) return undefined
  return { ...defaults, ...current }
}

function familyOf(ns) {
  if (ns === DEEPSEEK) return 'deepseek'
  if (ns === PI_AI) return 'pi-ai'
  return 'unknown'
}

export function install(rt) {
  const { ctx } = rt

  const seams = () => {
    const settings = ctx.get?.('settings')
    const credentials = ctx.get?.('credentials')
    return settings && credentials && ctx.llm.listConfigurableProviders ? { settings, credentials } : undefined
  }
  const usable = () => {
    const found = seams()
    if (found === undefined) throw invalid('This DSH cannot set up model providers')
    return found
  }
  const assertWritable = (settings) => {
    const ro = rt.readOnly?.()
    if (ro !== undefined) throw readOnlyErr(ro)
    if (settings.writable === false) throw refused('Settings are read-only in this profile')
  }
  const sections = settings => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const profileOf = (entry, map, layer = 'value') => entry.settingsPath.reduce((value, key) => value?.[key], map.get(entry.settingsNs)?.[layer])
  const refOf = profile => (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined)
  const entryOf = provider => ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)

  async function describeCredentialsMap(credentials, refs) {
    const unique = [...new Set(refs.filter(ref => typeof ref === 'string' && ref !== ''))]
    const out = new Map()
    for (let i = 0; i < unique.length; i += CRED_BATCH_SIZE) {
      const slice = unique.slice(i, i + CRED_BATCH_SIZE)
      const pairs = await Promise.all(slice.map(async (ref) => {
        const info = await credentials.describe(ref).catch(() => undefined)
        return [ref, info]
      }))
      for (const [ref, info] of pairs) {
        if (info !== undefined) out.set(ref, info)
      }
    }
    return out
  }

  function projectCred(info) {
    if (!info) return undefined
    return {
      configured: info.configured === true,
      writable: info.writable !== false,
      ...(info.source !== undefined ? { source: info.source } : {}),
      ...(info.masked !== undefined ? { masked: info.masked } : {}),
    }
  }

  let knownCache
  async function knownCatalogModels() {
    if (knownCache !== undefined) return knownCache
    const entries = (ctx.llm.listConfigurableProviders?.() ?? [])
      .filter(entry => entry.settingsNs === PI_AI && entry.declared === false && (entry.nativeAuth !== undefined || entry.defaultBaseURL !== undefined))
    if (entries.length === 0) return new Map()
    const map = new Map()
    const remember = (key, model) => {
      if (key && !map.has(key)) map.set(key, model)
    }
    for (const entry of entries) {
      let list = []
      try { list = await ctx.llm.discoverModels(PI_AI, { provider: entry.provider }) } catch { continue }
      for (const model of list) {
        const id = typeof model?.id === 'string' ? model.id.trim().toLowerCase() : ''
        if (!id) continue
        remember(id, model)
        const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
        remember(bare, model)
        if (bare.startsWith('kimi-')) remember(bare.slice(5), model)
      }
    }
    knownCache = map
    return map
  }

  // Backfill compatibility defaults onto custom routes (and catalog routes pointed at a
  // custom gateway) that were saved before DS Bot wrote `compat`, or added through DSH's
  // own Models page. Explicit user settings win per field.
  let repairing = Promise.resolve()
  async function ensureCustomCompat() {
    const found = seams()
    if (found === undefined || found.settings.writable === false || rt.readOnly?.() !== undefined) return
    const section = sections(found.settings).get(PI_AI)
    const userProviders = section?.user?.providers
    if (!userProviders || typeof userProviders !== 'object') return
    const ops = []
    for (const [id, profile] of Object.entries(userProviders)) {
      const nextCompat = compatForRoute(id, profile)
      if (nextCompat !== undefined) ops.push({ op: 'set', path: ['providers', id, 'compat'], value: nextCompat })
    }
    if (ops.length === 0) return
    await found.settings.mutate(PI_AI, ops, section.revision)
    rt.dropCatalog()
  }
  function repairRoutes() {
    repairing = repairing.then(ensureCustomCompat, ensureCustomCompat).catch(() => {})
    return repairing
  }
  repairRoutes()

  // Per provider route, the credential its DSH settings name as its API key. A
  // provider with none authenticates some other way.
  function keyRefs() {
    const found = seams()
    if (found === undefined) return new Map()
    const map = sections(found.settings)
    const refs = new Map()
    const llm = serviceOf(ctx, 'llm')
    if (llm === undefined) return refs
    for (const entry of llm.listConfigurableProviders()) {
      const ref = refOf(profileOf(entry, map))
      if (ref !== undefined) refs.set(entry.provider, ref)
    }
    return refs
  }

  async function missingKeys(providers) {
    await repairRoutes()
    let refs
    try { refs = keyRefs() } catch { return new Set() }
    const missing = new Set()
    await Promise.all(providers.filter(id => refs.has(id)).map(async (id) => {
      const info = await seams().credentials.describe(refs.get(id)).catch(() => undefined)
      if (info?.configured === false) missing.add(id)
    }))
    return missing
  }

  // The providers set up in DSH, with their models and key state, and the ones DSH
  // can add. A provider with no key and no models (DeepSeek's account route before a
  // sign-in) is left out.
  async function providersView() {
    await repairRoutes()
    const found = seams()
    if (found === undefined) return { available: false }
    const map = sections(found.settings)
    const catalog = await rt.catalog({ fresh: true })
    const configurable = ctx.llm.listConfigurableProviders()
    const writable = found.settings.writable !== false && rt.readOnly?.() === undefined

    const refsToDescribe = []
    for (const entry of configurable) {
      if (entry.provider === 'deepseek-account' || entry.provider === CHATGPT_PROVIDER) continue
      const profile = profileOf(entry, map)
      const ref = refOf(profile)
      if (ref !== undefined) {
        refsToDescribe.push(ref)
      } else {
        refsToDescribe.push(keyRefFor(entry.provider))
        for (const envRef of entry.nativeAuth?.env ?? []) refsToDescribe.push(envRef)
      }
    }
    const credMap = await describeCredentialsMap(found.credentials, refsToDescribe)

    const providers = []
    const addable = []
    for (const entry of configurable) {
      const profile = profileOf(entry, map)
      if (entry.settingsNs === PI_AI && profile === undefined) {
        if (entry.declared !== true) {
          const derived = projectCred(credMap.get(keyRefFor(entry.provider)))
          const nativeRefs = entry.nativeAuth?.env ?? []
          const checks = {}
          for (const ref of nativeRefs) {
            const c = projectCred(credMap.get(ref))
            if (c) checks[ref] = c
          }
          const hasRichMeta = entry.defaultBaseURL !== undefined
            || (Array.isArray(entry.baseURLEnv) && entry.baseURLEnv.length > 0)
            || entry.nativeAuth !== undefined
            || derived?.configured === true
            || derived?.source !== undefined
          addable.push({
            id: entry.provider,
            name: entry.displayName,
            ...(hasRichMeta ? {
              ...(entry.defaultBaseURL !== undefined ? { defaultBaseURL: entry.defaultBaseURL } : {}),
              ...(Array.isArray(entry.baseURLEnv) && entry.baseURLEnv.length > 0 ? { baseURLEnv: [...entry.baseURLEnv] } : {}),
              ...(entry.nativeAuth !== undefined ? { nativeAuth: { env: [...(entry.nativeAuth.env ?? [])], oauth: Boolean(entry.nativeAuth.oauth) } } : {}),
              ...(Object.keys(checks).length > 0 ? { credentialChecks: checks } : {}),
              ...(derived?.configured === true || derived?.source !== undefined ? { derivedCredential: derived } : {}),
            } : {}),
          })
        }
        continue
      }
      const ref = refOf(profile)
      const models = catalog.filter(model => model.provider === entry.provider).map(model => ({ id: model.id, ref: model.ref, name: model.name }))
      if (ref === undefined && models.length === 0 && entry.error === undefined) continue
      const section = map.get(entry.settingsNs)
      const userProfile = profileOf(entry, map, 'user')
      const baseProfile = profileOf(entry, map, 'base')
      const family = familyOf(entry.settingsNs)
      const isAccount = entry.provider === 'deepseek-account'
      const isChatGPT = entry.provider === CHATGPT_PROVIDER
      const editable = !isAccount && !isChatGPT && (family === 'deepseek' || family === 'pi-ai')
      const allowKey = editable && !isKeylessNativeAuth(entry)
      const effectiveKeyRef = ref ?? (allowKey ? keyRefFor(entry.provider) : undefined)
      const info = effectiveKeyRef === undefined ? undefined : credMap.get(effectiveKeyRef)

      // A route can be refreshed when DSH's pi-ai discovery can list its endpoint and
      // the route has a user layer to write the new model list into. Native and
      // subscription routes (other settings namespaces, or base-only routes) have no
      // such entry; they are not named here.
      const listable = entry.settingsNs === PI_AI && profile !== undefined
        && typeof profile.baseURL === 'string' && profile.baseURL !== ''
        && LISTABLE_PROTOCOLS.has(typeof profile.api === 'string' ? profile.api : 'openai-completions')
      const refreshable = listable && userProfile !== undefined
      const declared = (Array.isArray(profile?.models) ? profile.models : []).map(model => {
        const id = typeof model === 'string' ? model : model?.id
        if (typeof id !== 'string' || id.trim() === '') return undefined
        return { id, ref: `${entry.provider}/${id}`, name: typeof model?.name === 'string' && model.name.trim() !== '' ? model.name : id }
      }).filter(Boolean)

      const modelsOverridden = isRecord(userProfile) && Object.hasOwn(userProfile, 'models')
      const rawDefaultModels = Array.isArray(baseProfile?.models)
        ? baseProfile.models
        : family === 'deepseek'
          ? schemaDefaultModelsOf(section, entry.settingsPath)
          : []
      const rawEditableModels = modelsOverridden
        ? (Array.isArray(userProfile.models) ? userProfile.models : [])
        : rawDefaultModels
      const cloneModelItem = item => (isRecord(item) ? structuredClone(item) : (typeof item === 'string' ? { id: item } : {}))
      const editableModels = rawEditableModels.map(cloneModelItem)
      const defaultModels = rawDefaultModels.map(cloneModelItem)

      const credentialChecks = {}
      const checkRefs = effectiveKeyRef !== undefined ? [effectiveKeyRef] : (entry.nativeAuth?.env ?? [])
      for (const checkRef of checkRefs) {
        const projected = projectCred(credMap.get(checkRef))
        if (projected) credentialChecks[checkRef] = projected
      }
      const keyObj = effectiveKeyRef === undefined
        ? null
        : {
            configured: info?.configured === true,
            writable: !isChatGPT && info?.writable !== false,
            ...(ref === undefined ? { optional: true } : {}),
            ...(info?.source !== undefined ? { source: info.source } : {}),
            ...(info?.masked !== undefined ? { masked: info.masked } : {}),
          }
      const retryDefaults = editable ? retryDefaultsOf(section, entry.settingsPath, baseProfile?.retryPolicy) : undefined
      providers.push({
        id: entry.provider,
        ...(isChatGPT ? { auth: 'chatgpt' } : {}),
        name: entry.displayName,
        models,
        declaredModels: declared,
        refreshable,
        key: keyObj,
        removable: !isChatGPT && entry.settingsNs === PI_AI && userProfile !== undefined && baseProfile === undefined,
        custom: entry.declared === true,
        ...(entry.error ? { error: entry.error } : {}),
        settingsNs: entry.settingsNs,
        family,
        editable,
        ...(section?.revision !== undefined ? { revision: section.revision } : {}),
        ...(typeof userProfile?.displayName === 'string' ? { displayName: userProfile.displayName } : {}),
        ...(typeof baseProfile?.displayName === 'string' ? { baseDisplayName: baseProfile.displayName } : {}),
        ...(typeof userProfile?.baseURL === 'string' ? { baseURL: userProfile.baseURL } : {}),
        ...(typeof profile?.baseURL === 'string' ? { effectiveBaseURL: profile.baseURL } : entry.defaultBaseURL !== undefined ? { effectiveBaseURL: entry.defaultBaseURL } : {}),
        ...(entry.defaultBaseURL !== undefined ? { defaultBaseURL: entry.defaultBaseURL } : {}),
        ...(Array.isArray(entry.baseURLEnv) && entry.baseURLEnv.length > 0 ? { baseURLEnv: [...entry.baseURLEnv] } : {}),
        ...(typeof profile?.api === 'string' ? { api: profile.api } : {}),
        ...(ref !== undefined ? { apiKeyEnv: ref } : {}),
        ...(refOf(baseProfile) !== undefined ? { baseApiKeyEnv: refOf(baseProfile) } : {}),
        ...(entry.nativeAuth !== undefined ? { nativeAuth: { env: [...(entry.nativeAuth.env ?? [])], oauth: Boolean(entry.nativeAuth.oauth) } } : {}),
        ...(Object.keys(credentialChecks).length > 0 ? { credentialChecks } : {}),
        modelsOverridden,
        editableModels,
        ...(defaultModels.length > 0 ? { defaultModels } : {}),
        ...(typeof profile?.defaultContextWindow === 'number' ? { defaultContextWindow: profile.defaultContextWindow } : {}),
        ...(family === 'deepseek' && typeof profile?.maxTokens === 'number' ? { defaultMaxTokens: profile.maxTokens }
          : typeof profile?.defaultMaxTokens === 'number' ? { defaultMaxTokens: profile.defaultMaxTokens } : {}),
        ...(Array.isArray(profile?.defaultInput) ? { defaultInput: [...profile.defaultInput] } : {}),
        ...(isRecord(userProfile?.retryPolicy) ? { retryPolicy: structuredClone(userProfile.retryPolicy) } : {}),
        ...(retryDefaults !== undefined ? { retryDefaults } : {}),
      })
    }
    // The ones that come with the setup first, then the added ones as DSH lists them.
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    const piSection = map.get(PI_AI)
    const revisions = Object.fromEntries([...map.entries()].map(([ns, sec]) => [ns, sec.revision]))
    return {
      available: true,
      writable,
      providers,
      addable,
      protocols: protocolsOf(piSection),
      reasoningLevels: reasoningLevelsOf(piSection),
      revisions,
      revision: piSection?.revision,
    }
  }

  async function writableRef(provider) {
    if (provider === CHATGPT_PROVIDER) throw invalid('Use ChatGPT sign-in and sign-out to manage this connection, not an API key.')
    const ref = keyRefs().get(provider)
    if (ref === undefined) throw invalid(`${provider} takes no API key here`)
    if ((await usable().credentials.describe(ref)).writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    return ref
  }

  // A key is only ever written; nothing here reads one back.
  async function setProviderKey(provider, value) {
    if (provider === CHATGPT_PROVIDER) throw invalid('Use ChatGPT sign-in and sign-out to manage this connection, not an API key.')
    const { settings, credentials } = usable()
    assertWritable(settings)
    const key = checkKey(value)
    const existingRef = keyRefs().get(provider)
    if (existingRef !== undefined) {
      if ((await credentials.describe(existingRef)).writable === false) {
        throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
      }
      await credentials.set(existingRef, key)
      rt.dropCatalog()
      return
    }
    const map = sections(settings)
    const entry = entryOf(provider)
    const profile = entry ? profileOf(entry, map) : undefined
    if (entry === undefined || entry.settingsNs !== PI_AI || profile === undefined || isKeylessNativeAuth(entry)) {
      throw invalid(`${provider} takes no API key here`)
    }
    const derivedRef = keyRefFor(provider)
    if ((await credentials.describe(derivedRef)).writable === false) {
      throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    }
    await settings.mutate(PI_AI, [{ op: 'set', path: [...entry.settingsPath, 'apiKeyEnv'], value: derivedRef }], map.get(PI_AI)?.revision)
    await credentials.set(derivedRef, key)
    rt.dropCatalog()
  }

  async function clearProviderKey(provider) {
    const { settings, credentials } = usable()
    assertWritable(settings)
    await credentials.unset(await writableRef(provider))
    rt.dropCatalog()
  }

  // Full provider profile edit (models, capacities, input types, reasoning efforts,
  // base URL, display name, protocol, retry policy, reset defaults, API key).
  // Writes only minimal path ops against the owning DSH namespace with revision fencing.
  async function saveProviderConfig(body) {
    await repairing
    const { settings, credentials } = usable()
    assertWritable(settings)
    const provider = String(body?.provider ?? '').trim()
    if (provider === '') throw invalid('Choose a provider')
    if (provider === CHATGPT_PROVIDER) throw invalid('Use ChatGPT sign-in and sign-out to manage this connection.')
    if (provider === 'deepseek-account') throw invalid('DeepSeek account settings cannot be edited here')
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry === undefined) throw invalid(`No editable provider ${provider}`)
    const family = familyOf(entry.settingsNs)
    if (family !== 'deepseek' && family !== 'pi-ai') throw invalid(`${provider} cannot be edited here`)
    const section = map.get(entry.settingsNs)
    if (section === undefined) throw invalid(`Settings namespace ${entry.settingsNs} is not available`)
    if (body.revision !== undefined && body.revision !== null && body.revision !== section.revision) {
      throw stale('The provider settings changed elsewhere; reload and try again')
    }

    const base = [...entry.settingsPath]
    const effective = profileOf(entry, map, 'value')
    const userProfile = profileOf(entry, map, 'user')
    const baseProfile = profileOf(entry, map, 'base')
    const protocols = family === 'pi-ai' ? protocolsOf(section) : []
    const ops = []

    const ownsIdentity = family === 'pi-ai' && entry.declared === true
    if (Object.hasOwn(body, 'displayName') && ownsIdentity) {
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : ''
      if (name === '') {
        if (isRecord(userProfile) && Object.hasOwn(userProfile, 'displayName')) {
          ops.push({ op: 'unset', path: [...base, 'displayName'] })
        }
      } else {
        ops.push({ op: 'set', path: [...base, 'displayName'], value: name.slice(0, 80) })
      }
    }

    if (Object.hasOwn(body, 'baseURL')) {
      const urlText = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
      if (urlText === '') {
        if (isRecord(userProfile) && Object.hasOwn(userProfile, 'baseURL')) {
          ops.push({ op: 'unset', path: [...base, 'baseURL'] })
        }
      } else {
        const checked = checkEndpoint(urlText, { strictDeepSeek: family === 'deepseek' })
        ops.push({ op: 'set', path: [...base, 'baseURL'], value: checked })
      }
    }

    let nextApi = typeof effective?.api === 'string' ? effective.api : undefined
    if (Object.hasOwn(body, 'api') && ownsIdentity) {
      const api = typeof body.api === 'string' ? body.api.trim() : ''
      if (api === '') {
        throw invalid('Choose a protocol')
      }
      if (!protocols.includes(api)) {
        throw invalid(`The protocol must be one of ${protocols.join(', ')}`)
      }
      if (api !== userProfile?.api) {
        ops.push({ op: 'set', path: [...base, 'api'], value: api })
        const nextCompat = CUSTOM_COMPAT[api]
        if (nextCompat !== undefined) {
          ops.push({ op: 'set', path: [...base, 'compat'], value: { ...nextCompat } })
        } else if (isRecord(userProfile) && Object.hasOwn(userProfile, 'compat')) {
          ops.push({ op: 'unset', path: [...base, 'compat'] })
        }
      }
      nextApi = api
    }

    if (body.resetModels === true) {
      if (isRecord(userProfile) && Object.hasOwn(userProfile, 'models')) {
        ops.push({ op: 'unset', path: [...base, 'models'] })
      }
    } else if (Object.hasOwn(body, 'models')) {
      if (!Array.isArray(body.models)) throw invalid('Models must be a list')
      if (body.models.length > MAX_MODELS) throw invalid(`At most ${MAX_MODELS} models can be kept`)
      if (ownsIdentity && body.models.length === 0) throw invalid('Add at least one model')
      const cleaned = body.models.map(item => cleanEditableModel(item, { family, protocol: nextApi }))
      if (new Set(cleaned.map(m => m.id)).size !== cleaned.length) {
        throw invalid('Two models have the same id')
      }
      ops.push({ op: 'set', path: [...base, 'models'], value: cleaned })
    }

    if (body.resetRetryPolicy === true || (Object.hasOwn(body, 'retryPolicy') && body.retryPolicy === null)) {
      if (isRecord(userProfile) && Object.hasOwn(userProfile, 'retryPolicy')) {
        ops.push({ op: 'unset', path: [...base, 'retryPolicy'] })
      }
    } else if (Object.hasOwn(body, 'retryPolicy') && body.retryPolicy !== undefined) {
      const validated = validateRetryPolicyConfig(body.retryPolicy, provider)
      ops.push({ op: 'set', path: [...base, 'retryPolicy'], value: validated })
    }

    const derivedRef = keyRefFor(provider)
    const namedRef = refOf(effective)
    const targetRef = namedRef ?? derivedRef
    const newKey = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
    const removeKey = body.removeKey === true && newKey === undefined

    if (removeKey) {
      if (namedRef === undefined) throw invalid(`${provider} has no saved API key to remove`)
      const info = await credentials.describe(namedRef)
      if (info.writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
      await credentials.unset(namedRef)
      if (family === 'pi-ai' && entry.nativeAuth !== undefined && refOf(userProfile) === derivedRef && refOf(baseProfile) === undefined) {
        ops.push({ op: 'unset', path: [...base, 'apiKeyEnv'] })
      }
    }

    if (newKey !== undefined) {
      const info = await credentials.describe(targetRef)
      if (info.writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
      if (family === 'pi-ai' && refOf(userProfile) === undefined && refOf(baseProfile) === undefined) {
        ops.push({ op: 'set', path: [...base, 'apiKeyEnv'], value: targetRef })
      }
    } else if (family === 'pi-ai' && nextApi === GEMINI_PROTOCOL && namedRef === undefined && !removeKey) {
      throw invalid('Google Gemini requires an API key')
    }

    if (ops.length > 0) {
      try {
        await settings.mutate(entry.settingsNs, ops, body.revision ?? section.revision)
      } catch (error) {
        if (error?.code === 'SETTINGS_CONFLICT') {
          throw stale('The provider settings changed elsewhere; reload and try again')
        }
        throw error
      }
    }

    if (newKey !== undefined) {
      await credentials.set(targetRef, newKey)
    }

    rt.dropCatalog()
    return providersView()
  }

  // `provider` from DSH's directory, or a route the user declares (`custom`) for an
  // endpoint DSH ships nothing about. The route goes in first, then its key, as DSH's
  // own Models page does it: a failed key write leaves a provider that asks for one.
  async function addProvider(body) {
    await repairing
    const { settings, credentials } = usable()
    assertWritable(settings)
    const provider = String(body.provider ?? '').trim()
    if (provider === CHATGPT_PROVIDER) throw invalid('Use ChatGPT sign-in to add this connection.')
    const custom = body.custom === true
    const known = custom ? await knownCatalogModels() : undefined
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry !== undefined && (entry.settingsNs !== PI_AI || profileOf(entry, map) !== undefined)) throw invalid(`${provider} is already set up`)
    if (!custom && (entry === undefined || entry.declared === true)) throw invalid(`DSH offers no provider ${provider}`)
    if (custom && !ROUTE_ID.test(provider)) throw invalid('A provider id is lowercase letters, digits and dashes, starting with a letter')
    if (custom && entry !== undefined) throw invalid(`DSH already offers ${provider}; add it from its list`)
    const key = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
    const ref = keyRefFor(provider)
    const info = await credentials.describe(ref)
    if (key !== undefined && info.writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    // A blank key keeps a key that is already there, else the provider's own sign-in.
    const keyed = key !== undefined || info.configured === true
    const profile = custom ? customProfile(body, known, protocolsOf(map.get(PI_AI))) : {}
    if (keyed) profile.apiKeyEnv = ref
    await settings.mutate(PI_AI, [{ op: 'set', path: entry?.settingsPath ?? ['providers', provider], value: profile }], map.get(PI_AI)?.revision)
    if (key !== undefined) await credentials.set(ref, key)
    rt.dropCatalog()
    return providersView()
  }

  function customProfile(body, known, protocols = PROTOCOLS) {
    if (!protocols.includes(body.api)) throw invalid(`The protocol must be one of ${protocols.join(', ')}`)
    const models = Array.isArray(body.models) ? body.models.slice(0, MAX_MODELS).map(model => modelEntry(model, known)) : []
    if (models.length === 0) throw invalid('Add at least one model')
    if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id')
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    const compat = CUSTOM_COMPAT[body.api]
    return {
      ...(name ? { displayName: name } : {}),
      api: body.api,
      baseURL: checkEndpoint(body.baseURL),
      ...(compat ? { compat: { ...compat } } : {}),
      models,
    }
  }

  // The models an endpoint (or a provider DSH ships) says it serves. The key typed for
  // the question goes with it and is not stored.
  async function discoverModels(body) {
    const { settings } = usable()
    const map = sections(settings)
    const protocols = protocolsOf(map.get(PI_AI))
    const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined
    const entry = provider === undefined ? undefined : entryOf(provider)
    const profile = entry !== undefined && entry.settingsNs === PI_AI ? profileOf(entry, map) : undefined
    const stored = entry !== undefined && entry.settingsNs === PI_AI
      && (profile !== undefined || entry.declared === false)
    // An existing route is discovered through the profile DSH already has: the endpoint,
    // protocol, headers and the credential reference it names. The key never comes back
    // to the client and is never part of the request here; DSH's stored profile resolves
    // it for the named provider.
    const request = stored
      ? {
          provider,
          ...(typeof profile?.baseURL === 'string' && profile.baseURL !== '' ? { baseURL: profile.baseURL } : {}),
          ...(typeof profile?.api === 'string' ? { api: profile.api } : {}),
        }
      : {
          baseURL: checkEndpoint(body.baseURL),
          ...(protocols.includes(body.api) ? { api: body.api } : {}),
          ...(typeof body.key === 'string' && body.key.trim() !== '' ? { apiKey: checkKey(body.key) } : {}),
        }
    const models = await ctx.llm.discoverModels(PI_AI, request)
    const known = request.provider === undefined ? await knownCatalogModels() : undefined
    return models.slice(0, MAX_MODELS).map((model) => {
      const match = lookupKnownModel(known, model.id)
      const contextWindow = model.contextWindow ?? match?.contextWindow
      const inputModalities = model.inputModalities ?? match?.inputModalities
      return {
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(inputModalities ? { inputModalities: [...inputModalities] } : {}),
      }
    })
  }

  // Replace only one provider's models. The route, its endpoint, protocol, key
  // reference, headers and compatibility settings stay as they are; a Bot's model
  // choice is not touched here.
  async function saveProviderModels(body) {
    const { settings } = usable()
    assertWritable(settings)
    const provider = String(body.provider ?? '').trim()
    if (provider === '') throw invalid('Choose a provider')
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry === undefined || entry.settingsNs !== PI_AI) throw invalid(`No editable provider ${provider}`)
    if (profileOf(entry, map, 'user') === undefined) throw invalid(`${provider} cannot be changed here`)
    const profile = profileOf(entry, map)
    const listable = typeof profile?.baseURL === 'string' && profile.baseURL !== ''
      && LISTABLE_PROTOCOLS.has(typeof profile.api === 'string' ? profile.api : 'openai-completions')
    if (!listable) throw invalid(`${provider} has no model list to refresh here`)
    const section = map.get(PI_AI)
    if (body.revision !== undefined && section !== undefined && body.revision !== section.revision) {
      throw Object.assign(new Error('The provider settings changed in another window; refresh the models and try again'), { code: 'bot/stale' })
    }
    const list = Array.isArray(body.models) ? body.models : []
    if (list.length === 0) throw invalid('Select at least one model')
    if (list.length > MAX_MODELS) throw invalid(`At most ${MAX_MODELS} models can be kept`)
    const known = await knownCatalogModels()
    const current = new Map((Array.isArray(profile?.models) ? profile.models : [])
      .map(model => [typeof model === 'string' ? model : model?.id, model])
      .filter(([id]) => typeof id === 'string' && id !== ''))
    const openaiEntry = provider === CHATGPT_PROVIDER ? entryOf('openai') : undefined
    const openaiProfile = openaiEntry ? profileOf(openaiEntry, map) : undefined
    const hasOfficialOpenAI = provider === CHATGPT_PROVIDER
      && typeof ctx.llm.resolveModelInfo === 'function'
      && (ctx.llm.listProviders?.() ?? []).some(item => item.id === 'openai')
      && (typeof openaiProfile?.baseURL !== 'string' || openaiProfile.baseURL === '')
    const models = await Promise.all(list.map(async (model) => {
      const id = typeof model === 'string' ? model.trim() : model?.id?.trim()
      const old = current.get(id)
      const saved = typeof old === 'string' ? { id: old } : old
      const incoming = typeof model === 'string' ? { id: model } : model
      const incomingHasEfforts = Object.prototype.hasOwnProperty.call(incoming, 'reasoningEfforts') && incoming.reasoningEfforts !== undefined
      let fallbackEfforts
      if (provider === CHATGPT_PROVIDER && !incomingHasEfforts && saved?.reasoningEfforts === undefined && id) {
        if (hasOfficialOpenAI) {
          const info = await ctx.llm.resolveModelInfo('openai', id).catch(() => undefined)
          fallbackEfforts = openaiReasoningEfforts(info)
        }
        fallbackEfforts ??= fallbackChatGPTReasoningEfforts(id)
      }
      const mergedInput = { ...saved, ...incoming, ...(fallbackEfforts !== undefined ? { reasoningEfforts: fallbackEfforts } : {}) }
      const next = modelEntry(mergedInput, known)
      const combined = { ...saved, ...next }
      // If the caller explicitly supplied reasoningEfforts that normalized to nothing
      // (e.g. invalid keys or off-only), do not resurrect a stale saved.reasoningEfforts.
      if (incomingHasEfforts && next.reasoningEfforts === undefined) delete combined.reasoningEfforts
      return combined
    }))
    if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id')
    await settings.mutate(PI_AI, [{ op: 'set', path: [...entry.settingsPath, 'models'], value: models }], section?.revision)
    rt.dropCatalog()
    return providersView()
  }

  // Only a route the user added goes; its key goes with it when it is the one this page
  // derives and no other provider names it.
  async function removeProvider(provider) {
    if (provider === CHATGPT_PROVIDER) throw invalid('Use ChatGPT sign-out to disconnect this connection; its model route is retained.')
    await repairing
    const { settings, credentials } = usable()
    assertWritable(settings)
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry === undefined || entry.settingsNs !== PI_AI || profileOf(entry, map) === undefined) throw invalid(`${provider} is not set up`)
    if (profileOf(entry, map, 'user') === undefined || profileOf(entry, map, 'base') !== undefined) throw invalid(`${provider} comes with this setup and cannot be removed`)
    const ref = refOf(profileOf(entry, map))
    const shared = [...keyRefs()].some(([other, otherRef]) => other !== provider && otherRef === ref)
    await settings.mutate(PI_AI, [{ op: 'unset', path: entry.settingsPath }], map.get(PI_AI)?.revision)
    if (ref === keyRefFor(provider) && !shared) {
      const info = await credentials.describe(ref)
      if (info.configured && info.writable) await credentials.unset(ref)
    }
    rt.dropCatalog()
    return providersView()
  }

  Object.assign(rt, {
    keyRefs, missingKeys, providersView, setProviderKey, clearProviderKey,
    addProvider, discoverModels, saveProviderModels, saveProviderConfig, removeProvider,
  })
}
