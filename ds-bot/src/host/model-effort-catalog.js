// Only public model capabilities are cached. Provider URLs, credentials and
// the IDs being looked up never go into a catalog request.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOUR = 3_600_000
const MAX_BYTES = 4 * 1024 * 1024
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ENGINE_LEVELS = ['off', ...LEVELS]
const ROOT = 'https://raw.githubusercontent.com/router-for-me/models/main/'
const COCKPIT = 'https://raw.githubusercontent.com/jlcodes99/cockpit-tools/main/'
const sources = file => [ROOT + file, COCKPIT + 'resources/codex/' + file]
const SOURCES = {
  codex: sources('codex_client_models.json'),
  cockpitOverrides: [COCKPIT + 'resources/codex/codex_client_models.json'],
  vendor: sources('models.json'),
  anthropic: [COCKPIT + 'src-tauri/src/modules/codex_native_api/anthropic_models.json'],
  devin: [ROOT + 'devin_models.json'],
  deepseek: [COCKPIT + 'src-tauri/resources/deepseek_codex_models.json'],
}
const NAMESPACES = new Map(Object.entries({
  anthropic: 'claude', google: 'gemini', models: 'gemini', 'x-ai': 'xai', moonshot: 'kimi', moonshotai: 'kimi',
  'github-copilot': 'copilot', 'google-vertex': 'vertex', 'google-ai-studio': 'aistudio',
}))
const CHANNELS = new Set(['copilot', 'antigravity', 'vertex', 'gemini-cli', 'aistudio'])
const namespace = name => NAMESPACES.get(name) ?? name

function catalogKeys(id, api, origin) {
  if (typeof id !== 'string' || !id.trim()) return []
  const raw = id.trim().toLowerCase()
  const slash = raw.indexOf('/')
  const scope = slash < 0 ? '' : namespace(raw.slice(0, slash))
  const name = raw.slice(slash + 1)
  if (!name || slash === 0) return []
  const native = api === 'anthropic-messages' ? 'claude' : api === 'google-generative-ai' ? 'gemini' : undefined
  if (native) {
    if (scope && scope !== native && !(CHANNELS.has(scope) && name.startsWith(native + '-'))) return []
    const vendor = ['vendor', (scope || native) + '/' + name]
    if (native === 'claude' && (!scope || scope === native) && name.startsWith('claude-')) {
      return [['anthropic', name], vendor]
    }
    return [vendor]
  }
  if (api !== 'openai-completions' && api !== 'openai-responses') return []
  const vendor = ['vendor', scope ? scope + '/' + name : name]
  if ((!scope || scope === 'xai') && name.startsWith('grok-')) {
    const xai = origin === 'https://api.x.ai' && api === 'openai-responses'
    return [xai ? ['vendor', 'xai/' + name] : vendor, ['cockpitOverrides', name]]
  }
  if (scope === 'devin' || (!scope && name.startsWith('swe-'))) return [['devin', 'devin/' + name]]
  if (origin === 'https://api.deepseek.com' && (!scope || scope === 'deepseek') && name.startsWith('deepseek-')) {
    return [['deepseek', name], ['deepseek', 'deepseek-v4-flash']]
  }
  if (scope === 'deepseek' || (!scope && name.startsWith('deepseek-'))) return [['deepseek', name], vendor]
  if (scope === 'openai' || (!scope && /^(gpt-|codex-|o[1-9])/.test(name))) return [['codex', name], vendor]
  return scope ? [vendor] : [vendor, ['codex', name]]
}

function thinkingCapability(thinking) {
  if (Array.isArray(thinking?.levels) && thinking.levels.length) return thinking.levels.filter(level => typeof level === 'string')
  if (Number.isSafeInteger(thinking?.max) && thinking.max > 0) return { min: thinking.min ?? 0, max: thinking.max }
  return []
}

function vendorEntries(json) {
  const result = new Map()
  const bare = new Map()
  for (const [group, rows] of Object.entries(json)) {
    if (!Array.isArray(rows)) continue
    const scope = namespace(group.toLowerCase())
    const direct = !CHANNELS.has(scope) && !scope.startsWith('codex-')
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !row.id.trim()) continue
      const id = row.id.trim().toLowerCase()
      const capability = thinkingCapability(row.thinking)
      const levels = Array.isArray(capability) ? capability : []
      result.set(scope + '/' + id, capability)
      const prev = bare.get(id)
      // Prefer the model provider for bare IDs. Across equally specific catalogs,
      // keep only shared levels so reordering the catalogs cannot change the slider.
      if (!prev || (direct && !prev.direct)) bare.set(id, { direct, levels })
      else if (prev.direct === direct) prev.levels = prev.levels.filter(level => levels.includes(level))
    }
  }
  for (const [id, entry] of bare) if (!result.has(id)) result.set(id, entry.levels)
  return result
}

function entries(kind, json) {
  if (kind === 'vendor' || kind === 'devin') return vendorEntries(json)
  const result = new Map()
  if (kind === 'anthropic') {
    for (const { id, thinking } of json.models) {
      if (typeof id !== 'string') continue
      result.set(id, thinkingCapability(thinking))
    }
    for (const [id, capability] of result) {
      const alias = id.replace(/-\d{8}$/, '')
      if (!result.has(alias)) result.set(alias, capability)
    }
    return result
  }
  const rows = kind === 'cockpitOverrides' ? json.model_overrides ?? [] : [...json.models, ...(json.model_overrides ?? [])]
  for (const row of rows) {
    const levels = row.supported_reasoning_levels?.map(item => item.effort)
    if (typeof row.slug === 'string' && Array.isArray(levels) && levels.every(level => typeof level === 'string')) {
      result.set(row.slug.toLowerCase(), levels)
    }
  }
  if (kind === 'deepseek' && !result.has('deepseek-flash') && result.has('deepseek-v4-flash')) {
    result.set('deepseek-flash', result.get('deepseek-v4-flash'))
  }
  return result
}

// Some rules belong to the service at a particular endpoint. A relay may use
// the same model name for an entirely different upstream.
const BAILIAN_TOKEN_PLAN = new Set(['https://token-plan.cn-beijing.maas.aliyuncs.com', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com'])

// DSH sends named efforts or token budgets depending on the wire adapter.
// Expose only distinct budgets the adapter will actually send for this model.
function budgetLevels(id, route, bounds) {
  const google = route.api === 'google-generative-ai'
  const claude = route.api === 'anthropic-messages'
  if (!google && !claude) return []
  let budgets
  if (claude) {
    if (route.explicitAdaptive === true) return []
    budgets = { low: 2048, medium: 8192, high: 16384 }
  } else {
    const match = /(?:^|\/)gemini-2\.5-(pro|flash-lite|flash)(?:-|$)/.exec(id)
    if (!match) return []
    budgets = { minimal: match[1] === 'flash-lite' ? 512 : 128, low: 2048, medium: 8192, high: match[1] === 'pro' ? 32768 : 24576 }
  }
  const seen = new Set()
  return Object.keys(budgets).filter(level => {
    if (!(route.allowed ?? ENGINE_LEVELS).includes(level)) return false
    const requested = route.thinkingBudgets?.[level] ?? budgets[level]
    const budget = claude && route.maxTokens ? Math.min(requested, Math.max(0, route.maxTokens - 1024)) : requested
    if (budget <= 0 || budget < bounds.min || budget > bounds.max || seen.has(budget)) return false
    seen.add(budget)
    return true
  })
}

function offered(id, route, capability) {
  const named = Array.isArray(capability)
  const raw = named ? capability : budgetLevels(id, route, capability)
  const { api, allowed = ENGINE_LEVELS } = route
  const adaptive = named && api === 'anthropic-messages' && route.adaptive && route.explicitAdaptive !== false
  const supported = allowed.filter(level => level !== 'off' && raw.includes(level)
    && (api !== 'google-generative-ai' || LEVELS.slice(0, 4).includes(level))
    && (api !== 'anthropic-messages' || adaptive || !['max', 'xhigh'].includes(level)))
  if (!supported.length) return null
  const levels = Object.fromEntries(supported.map(level => [level, level]))
  if (api.startsWith('openai-') && allowed.includes('off') && raw.includes('none')) levels.off = 'none'
  return { levels, adaptive: Boolean(adaptive) }
}

async function download(url, fetchCatalog) {
  const response = await fetchCatalog(url, { signal: AbortSignal.timeout(4000), redirect: 'error' })
  if (!response.ok) throw new Error('Model catalog unavailable')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error('Model catalog exceeds size limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createEffortCatalog(home, fetchCatalog = fetch) {
  const cached = new Map()
  const pending = new Map()

  async function refresh(kind) {
    const file = join(home, 'model-catalog-' + kind + '.json')
    let previous = cached.get(kind)
    if (!previous) {
      try {
        const disk = JSON.parse(await readFile(file, 'utf8'))
        const rows = new Map(disk.rows)
        const legacy = kind === 'vendor' && disk.version !== 3
        if (legacy && disk.version !== 2) {
          for (const [id, levels] of disk.rows) {
            if (id.startsWith('claude-')) rows.set('claude/' + id, levels)
            if (id.startsWith('gemini-')) rows.set('gemini/' + id, levels)
          }
        }
        previous = { rows, expires: legacy ? 0 : disk.updated + HOUR }
        cached.set(kind, previous)
      } catch { /* first use */ }
    }
    if (previous?.expires > Date.now()) return previous.rows
    for (const url of SOURCES[kind]) {
      let rows
      try { rows = entries(kind, await download(url, fetchCatalog)) } catch { continue }
      if (!rows.size) continue
      const updated = Date.now()
      cached.set(kind, { rows, expires: updated + HOUR })
      const tmp = file + '.' + randomUUID() + '.tmp'
      try {
        await mkdir(home, { recursive: true })
        await writeFile(tmp, JSON.stringify({ version: 3, updated, rows: [...rows] }))
        await rename(tmp, file)
      } catch { await rm(tmp, { force: true }).catch(() => {}) }
      return rows
    }
    const rows = previous?.rows ?? new Map()
    cached.set(kind, { rows, expires: Date.now() + 60_000 })
    return rows
  }

  return async (id, route) => {
    if (typeof id !== 'string') return
    id = id.trim().toLowerCase()
    const origin = URL.canParse(route.baseURL) ? new URL(route.baseURL).origin : undefined
    if (BAILIAN_TOKEN_PLAN.has(origin) && route.api === 'openai-responses' && id === 'qwen3.8-max') {
      return offered(id, route, ['low', 'medium', 'xhigh'])
    }
    if (!home) return
    const keys = catalogKeys(id, route.api, origin)
    if (!keys.length) return null
    let complete = true
    for (const [kind, key] of keys) {
      if (!pending.has(kind)) pending.set(kind, refresh(kind).finally(() => pending.delete(kind)))
      const rows = await pending.get(kind)
      if (!rows.size) complete = false
      const capability = rows.get(key) ?? (kind === 'anthropic' ? rows.get(key.replace(/-\d{8}$/, '')) : undefined)
      if (Array.isArray(capability) || Number.isSafeInteger(capability?.max)) {
        const result = offered(id, route, capability)
        return result ?? (complete ? null : undefined)
      }
    }
    // An unavailable catalog cannot revoke previously managed settings.
    return complete ? null : undefined
  }
}
