// Model providers and their API keys, for a window that has no DSH Models page of its
// own. DSH keeps all of it: a provider route in the settings of the adapter that serves
// it, the route's key in DSH's credential store under the reference the route names.
// The providers to add are the ones DSH's directory of configurable providers offers.

const PI_AI = 'llm-pi-ai'
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
// The baseline wire protocols DSH's pi-ai adapter serves on a custom route; newer DSH
// builds advertise any additional protocols (such as `google-generative-ai`) in their
// `llm-pi-ai` settings schema.
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

function protocolsOf(section) {
  const schema = section?.schema
  const refs = schema?.refs
  const at = node => (typeof node === 'number' || typeof node === 'string' ? refs?.[String(node)] : node)
  const root = at(schema?.uid ?? schema)
  const api = at(at(at(root?.dict?.providers)?.inner)?.dict?.api)
  const fromSchema = api?.list?.map(item => at(item)?.value).filter(item => typeof item === 'string' && item !== '')
  return Array.isArray(fromSchema) && fromSchema.length > 0 ? fromSchema : PROTOCOLS
}
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

// The reference DSH's own Models page derives for a route's key, so a provider added
// here and one added there read the same key.
export const keyRefFor = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

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

function checkEndpoint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  return text
}

function lookupKnownModel(known, rawId) {
  if (!known || known.size === 0 || typeof rawId !== 'string') return undefined
  const id = rawId.trim().toLowerCase()
  if (id === '') return undefined
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return known.get(id) ?? known.get(bare) ?? (bare.startsWith('kimi-') ? known.get(bare.slice(5)) : known.get(`kimi-${bare}`))
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
  return {
    id,
    ...(typeof model?.name === 'string' && model.name.trim() !== '' ? { name: model.name.trim() } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(input.length > 0 ? { input } : {}),
  }
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
  const sections = settings => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const profileOf = (entry, map, layer = 'value') => entry.settingsPath.reduce((value, key) => value?.[key], map.get(entry.settingsNs)?.[layer])
  const refOf = profile => (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined)
  const entryOf = provider => ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)

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
    if (found === undefined) return
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
    for (const entry of ctx.llm.listConfigurableProviders()) {
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
    const providers = []
    const addable = []
    for (const entry of ctx.llm.listConfigurableProviders()) {
      const profile = profileOf(entry, map)
      if (entry.settingsNs === PI_AI && profile === undefined) {
        if (entry.declared !== true) addable.push({ id: entry.provider, name: entry.displayName })
        continue
      }
      const ref = refOf(profile)
      const models = catalog.filter(model => model.provider === entry.provider).map(model => ({ ref: model.ref, name: model.name }))
      if (ref === undefined && models.length === 0 && entry.error === undefined) continue
      const info = ref === undefined ? undefined : await found.credentials.describe(ref).catch(() => undefined)
      providers.push({
        id: entry.provider,
        name: entry.displayName,
        models,
        key: ref === undefined ? null : { configured: info?.configured === true, writable: info?.writable !== false },
        removable: entry.settingsNs === PI_AI && profileOf(entry, map, 'user') !== undefined && profileOf(entry, map, 'base') === undefined,
        custom: entry.declared === true,
        ...(entry.error ? { error: entry.error } : {}),
      })
    }
    // The ones that come with the setup first, then the added ones as DSH lists them.
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    return { available: true, providers, addable, protocols: protocolsOf(map.get(PI_AI)) }
  }

  async function writableRef(provider) {
    const ref = keyRefs().get(provider)
    if (ref === undefined) throw invalid(`${provider} takes no API key here`)
    if ((await usable().credentials.describe(ref)).writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    return ref
  }

  // A key is only ever written; nothing here reads one back.
  async function setProviderKey(provider, value) {
    const key = checkKey(value)
    await usable().credentials.set(await writableRef(provider), key)
    rt.dropCatalog()
  }

  async function clearProviderKey(provider) {
    await usable().credentials.unset(await writableRef(provider))
    rt.dropCatalog()
  }

  // `provider` from DSH's directory, or a route the user declares (`custom`) for an
  // endpoint DSH ships nothing about. The route goes in first, then its key, as DSH's
  // own Models page does it: a failed key write leaves a provider that asks for one.
  async function addProvider(body) {
    await repairing
    const { settings, credentials } = usable()
    const provider = String(body.provider ?? '').trim()
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
    const protocols = protocolsOf(sections(settings).get(PI_AI))
    const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined
    const request = provider !== undefined && entryOf(provider)?.declared === false
      ? { provider }
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

  // Only a route the user added goes; its key goes with it when it is the one this page
  // derives and no other provider names it.
  async function removeProvider(provider) {
    await repairing
    const { settings, credentials } = usable()
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

  Object.assign(rt, { keyRefs, missingKeys, providersView, setProviderKey, clearProviderKey, addProvider, discoverModels, removeProvider })
}
