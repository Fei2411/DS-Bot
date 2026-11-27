// Only public IDs and supported level names are kept. Provider URLs, credentials
// and the IDs being looked up never go into a catalog request.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOUR = 3_600_000
const MAX_BYTES = 4 * 1024 * 1024
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const FILES = { codex: 'codex_client_models.json', vendor: 'models.json' }
const ROOT = 'https://raw.githubusercontent.com/router-for-me/models/main/'
const FALLBACK = 'https://raw.githubusercontent.com/jlcodes99/cockpit-tools/main/resources/codex/'

function modelKey(id, api) {
  if (typeof id !== 'string') return
  const openai = api === 'openai-completions' || api === 'openai-responses'
  const raw = id.trim().toLowerCase()
  const name = raw.slice(raw.lastIndexOf('/') + 1)
  const prefix = raw.slice(0, raw.length - name.length)
  if ((openai || api === 'anthropic-messages') && (!prefix || prefix === 'anthropic/') && name.startsWith('claude-')) return ['vendor', name]
  if ((openai || api === 'google-generative-ai') && (!prefix || prefix === 'google/' || prefix === 'models/') && name.startsWith('gemini-')) return ['vendor', name]
  if (openai && (!prefix || prefix === 'openai/' || prefix === 'xai/')) return ['codex', name]
}

function entries(kind, json) {
  const rows = kind === 'codex' ? [...json.models, ...(json.model_overrides ?? [])] : [...json.claude, ...json.gemini]
  const result = new Map()
  for (const row of rows) {
    const id = kind === 'codex' ? row.slug : row.id
    const raw = kind === 'codex' ? row.supported_reasoning_levels?.map(item => item.effort) : row.thinking?.levels
    if (typeof id === 'string' && Array.isArray(raw) && raw.every(level => typeof level === 'string')) {
      result.set(id.toLowerCase(), raw)
    }
  }
  if (!result.size) throw new Error('Empty model capability catalog')
  return result
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
        previous = { rows: new Map(disk.rows), expires: disk.updated + HOUR }
        cached.set(kind, previous)
      } catch { /* first use */ }
    }
    if (previous?.expires > Date.now()) return previous.rows
    for (const base of [ROOT, FALLBACK]) {
      let rows
      try { rows = entries(kind, await download(base + FILES[kind], fetchCatalog)) } catch { continue }
      const updated = Date.now()
      cached.set(kind, { rows, expires: updated + HOUR })
      const tmp = file + '.' + randomUUID() + '.tmp'
      try {
        await mkdir(home, { recursive: true })
        await writeFile(tmp, JSON.stringify({ updated, rows: [...rows] }))
        await rename(tmp, file)
      } catch { await rm(tmp, { force: true }).catch(() => {}) }
      return rows
    }
    const rows = previous?.rows ?? new Map()
    cached.set(kind, { rows, expires: Date.now() + 60_000 })
    return rows
  }

  return async (id, api) => {
    const key = modelKey(id, api)
    if (!home || !key) return
    const [kind, name] = key
    if (!pending.has(kind)) pending.set(kind, refresh(kind).finally(() => pending.delete(kind)))
    const rows = await pending.get(kind)
    if (!rows.size) return
    const raw = rows.get(name)
    if (!Array.isArray(raw)) return null
    const allowed = api === 'google-generative-ai' ? LEVELS.slice(0, 4) : LEVELS
    const supported = allowed.filter(level => raw.includes(level))
    return supported.length ? Object.fromEntries(supported.map(level => [level, level])) : null
  }
}
