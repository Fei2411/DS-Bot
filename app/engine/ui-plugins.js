// Local desktop UI & theme plugin discovery and authenticated static serving.
// Supports:
//   1. Drop-in plugins under `<DSH_HOME>/ui-plugins/<folder>/` (manifest.json or package.json)
//   2. Enabled DSH/Bot profile bundles declaring `dsBot.ui` in their package.json
// All routes require the Host session cookie and strictly confine file reads to each plugin's real root.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

export const UI_PLUGINS_API_PREFIX = '/api/ui-plugins'
const UI_PLUGINS_MANIFEST_PATH = `${UI_PLUGINS_API_PREFIX}/manifest`
const UI_PLUGINS_FILES_PREFIX = `${UI_PLUGINS_API_PREFIX}/files/`

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const THEME_ID_RE = /^[a-z][\w-]{0,31}$/
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
const THEME_KEYS = ['bg', 'sidebar', 'bubble', 'card', 'text', 'user', 'userText', 'accent']
const MAX_THEME_CSS_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const STATIC_MISS_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' }

const ALLOWED_PLUGIN_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const CORE_PACKAGES = new Set(['ds-bot', '@deepseek-ai/ds-bot', 'dsbot-engine', '@deepseek-ai/dsh-base'])

function withSep(dir) {
  return dir.endsWith(sep) ? dir : dir + sep
}

function bytesBody(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function readJsonFile(path) {
  const info = statSync(path)
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new Error('Manifest file is too large or not a regular file')
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function cleanStringList(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))]
}

function normalizeRelativeEntry(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (trimmed === '' || trimmed.startsWith('/') || isAbsolute(trimmed) || trimmed.includes('\0') || trimmed.includes(':')) {
    return null
  }
  const normalized = normalize(trimmed).replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || /[. ]$/u.test(seg)) return null
  }
  return normalized
}

function validateThemeDef(raw, fallbackId, fallbackLabel) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Theme definition must be an object')
  }
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : fallbackId
  if (!THEME_ID_RE.test(id)) {
    throw new Error('Theme id must start with a lowercase letter and use only letters, digits, _ or - (max 32 chars)')
  }
  const cleanMode = (modeName) => {
    const mode = raw[modeName]
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) {
      throw new Error(`Theme is missing "${modeName}" colors`)
    }
    const out = {}
    for (const key of THEME_KEYS) {
      const value = mode[key]
      if (typeof value !== 'string' || !HEX_COLOR_RE.test(value.trim())) {
        throw new Error(`Theme ${modeName}.${key} must be a #rrggbb color`)
      }
      out[key] = value.trim().toLowerCase()
    }
    return out
  }
  const css = typeof raw.css === 'string' ? raw.css : ''
  if (Buffer.byteLength(css, 'utf8') > MAX_THEME_CSS_BYTES) {
    throw new Error('Theme CSS exceeds the 64 KB limit')
  }
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : fallbackLabel,
    light: cleanMode('light'),
    dark: cleanMode('dark'),
    ...(css ? { css } : {}),
  }
}

/**
 * Inspect a package directory's `package.json` for DSH Web client metadata and
 * DS Bot desktop UI declarations (`dsBot.ui`).
 */
export function inspectPackageUiMeta(pkgDir) {
  if (typeof pkgDir !== 'string' || pkgDir.trim() === '') {
    return { hasDshClient: false, dsBotUi: null, pkg: null }
  }
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return { hasDshClient: false, dsBotUi: null, pkg: null }
  let pkg
  try {
    pkg = readJsonFile(pkgPath)
  } catch {
    return { hasDshClient: false, dsBotUi: null, pkg: null }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { hasDshClient: false, dsBotUi: null, pkg: null }
  }
  const dshClient = Boolean(pkg.dsh && typeof pkg.dsh === 'object' && pkg.dsh.client && typeof pkg.dsh.client === 'object')
  const clientExport = Boolean(pkg.exports && typeof pkg.exports === 'object' && Object.prototype.hasOwnProperty.call(pkg.exports, './client'))
  const depNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]
  const dependsOnDshWeb = depNames.some(dep =>
    dep === '@deepseek-ai/dsh-web-app'
    || dep.startsWith('@deepseek-ai/dsh-client-ui-')
    || dep === '@deepseek-ai/dsh-client-modules'
    || dep === '@deepseek-ai/dsh-cordis-client-runner')
  const rawUi = pkg.dsBot?.ui ?? null
  let dsBotUi = null
  if (typeof rawUi === 'string' && rawUi.trim() !== '') {
    dsBotUi = { entry: rawUi.trim() }
  } else if (rawUi && typeof rawUi === 'object' && !Array.isArray(rawUi)) {
    dsBotUi = rawUi
  }
  return {
    hasDshClient: dshClient || clientExport || dependsOnDshWeb,
    dsBotUi,
    pkg,
  }
}

/** Resolve `<DSH_HOME>/ui-plugins` from DSH's profileContext (or an explicit home fallback). */
export function resolveUiPluginsDir(profileContext, homeFallback = '') {
  const home = typeof profileContext?.home === 'string' && profileContext.home.trim() !== ''
    ? profileContext.home.trim()
    : (typeof profileContext?.dir === 'string' && profileContext.dir.trim() !== ''
      ? dirname(dirname(profileContext.dir.trim()))
      : (typeof homeFallback === 'string' ? homeFallback.trim() : ''))
  return home !== '' ? join(resolve(home), 'ui-plugins') : null
}

async function resolveContainedFile(rootDir, relPath) {
  const normalized = normalizeRelativeEntry(relPath)
  if (normalized === null) throw new Error('Plugin entry path must stay inside the plugin folder')
  const root = resolve(rootDir)
  const target = resolve(root, normalized)
  if (!target.startsWith(withSep(root))) {
    throw new Error('Plugin entry path escapes the plugin folder')
  }
  const realRoot = await realpath(root)
  const realTarget = await realpath(target)
  if (!realTarget.startsWith(withSep(realRoot))) {
    throw new Error('Plugin entry symlink escapes the plugin folder')
  }
  const info = statSync(realTarget)
  if (!info.isFile()) throw new Error('Plugin entry must be a file')
  return { normalized, realRoot, realTarget }
}

function pluginFilesUrl(pluginId, relPath) {
  const encodedRel = relPath.split('/').map(encodeURIComponent).join('/')
  return `${UI_PLUGINS_FILES_PREFIX}${encodeURIComponent(pluginId)}/${encodedRel}`
}

async function parseUiPluginSpec({ id, fallbackName, rootDir, spec, source, packageName = null }) {
  const name = typeof spec?.name === 'string' && spec.name.trim() !== '' ? spec.name.trim() : fallbackName
  const pages = cleanStringList(spec?.pages)
  const inject = cleanStringList(spec?.inject)
  const hasEntry = typeof spec?.entry === 'string' && spec.entry.trim() !== ''
  const hasTheme = spec?.theme !== undefined && spec?.theme !== null

  if (!hasEntry && !hasTheme) {
    throw new Error('UI plugin manifest must declare "entry" (JS module) or "theme" (theme object or JSON file)')
  }

  let url = null
  let rootReal = null
  if (hasEntry) {
    const resolved = await resolveContainedFile(rootDir, spec.entry)
    const ext = extname(resolved.normalized).toLowerCase()
    if (ext !== '.js' && ext !== '.mjs') {
      throw new Error('UI plugin entry must be a .js or .mjs module')
    }
    url = pluginFilesUrl(id, resolved.normalized)
    rootReal = resolved.realRoot
  }

  let theme = null
  if (hasTheme) {
    let rawTheme = spec.theme
    if (typeof rawTheme === 'string') {
      const resolved = await resolveContainedFile(rootDir, rawTheme)
      rawTheme = readJsonFile(resolved.realTarget)
    }
    const defaultThemeId = id.replace(/^local:|^bundle:/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, 't-')
    theme = validateThemeDef(rawTheme, defaultThemeId.slice(0, 32) || 'custom-theme', name)
  }

  return {
    descriptor: {
      id,
      name,
      source,
      kind: url ? 'esm' : 'theme',
      ...(url ? { url } : {}),
      ...(theme ? { theme } : {}),
      ...(packageName ? { packageName } : {}),
      dir: resolve(rootDir),
      pages,
      inject,
    },
    rootDir: rootReal ?? resolve(rootDir),
  }
}

/**
 * Scan `<DSH_HOME>/ui-plugins/` and enabled profile bundles for desktop UI / theme plugins.
 */
export async function discoverUiPlugins({
  uiPluginsDir = null,
  bundles = [],
  resolveBundleDir = null,
} = {}) {
  const plugins = []
  const roots = new Map()
  const seenIds = new Set()

  // 1. Local drop-in UI / theme plugins under `<DSH_HOME>/ui-plugins/<folder>/`.
  if (typeof uiPluginsDir === 'string' && uiPluginsDir.trim() !== '' && existsSync(uiPluginsDir)) {
    let entries = []
    try {
      entries = readdirSync(uiPluginsDir, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const dir = join(uiPluginsDir, entry.name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const manifestPath = join(dir, 'manifest.json')
      const pkgPath = join(dir, 'package.json')
      const hasManifest = existsSync(manifestPath)
      const hasPkg = existsSync(pkgPath)
      if (!hasManifest && !hasPkg) continue

      const fallbackSlug = entry.name
      const fallbackId = `local:${fallbackSlug}`
      try {
        const raw = readJsonFile(hasManifest ? manifestPath : pkgPath)
        const spec = hasManifest
          ? raw
          : (typeof raw?.dsBot?.ui === 'string'
            ? { entry: raw.dsBot.ui, name: raw.name }
            : (raw?.dsBot?.ui && typeof raw.dsBot.ui === 'object' ? { name: raw.name, ...raw.dsBot.ui } : raw))
        const rawId = typeof spec?.id === 'string' && spec.id.trim() !== '' ? spec.id.trim() : fallbackSlug
        if (!PLUGIN_ID_RE.test(rawId)) {
          throw new Error(`Invalid UI plugin id "${rawId}"`)
        }
        const id = `local:${rawId}`
        if (seenIds.has(id)) continue
        const parsed = await parseUiPluginSpec({
          id,
          fallbackName: fallbackSlug,
          rootDir: dir,
          spec,
          source: 'local',
        })
        seenIds.add(id)
        plugins.push(parsed.descriptor)
        if (parsed.descriptor.url) roots.set(id, parsed.rootDir)
      } catch (error) {
        if (seenIds.has(fallbackId)) continue
        seenIds.add(fallbackId)
        plugins.push({
          id: fallbackId,
          name: fallbackSlug,
          source: 'local',
          kind: 'esm',
          dir: resolve(dir),
          pages: [],
          inject: [],
          error: error?.message ?? String(error),
        })
      }
    }
  }

  // 2. Enabled profile bundles declaring `dsBot.ui` in their package.json.
  if (Array.isArray(bundles) && typeof resolveBundleDir === 'function') {
    for (const bundle of bundles) {
      const pkgName = typeof bundle?.name === 'string' ? bundle.name.trim() : ''
      if (!pkgName || CORE_PACKAGES.has(pkgName) || !bundle.enabled) continue
      let pkgDir = null
      try {
        pkgDir = await resolveBundleDir(pkgName)
      } catch {
        pkgDir = null
      }
      if (!pkgDir) continue
      const meta = inspectPackageUiMeta(pkgDir)
      if (!meta.dsBotUi) continue
      const id = `bundle:${pkgName}`
      if (seenIds.has(id)) continue
      try {
        const parsed = await parseUiPluginSpec({
          id,
          fallbackName: meta.pkg?.name || pkgName,
          rootDir: pkgDir,
          spec: meta.dsBotUi,
          source: 'bundle',
          packageName: pkgName,
        })
        seenIds.add(id)
        plugins.push(parsed.descriptor)
        if (parsed.descriptor.url) roots.set(id, parsed.rootDir)
      } catch (error) {
        seenIds.add(id)
        plugins.push({
          id,
          name: meta.pkg?.name || pkgName,
          source: 'bundle',
          kind: 'esm',
          packageName: pkgName,
          dir: resolve(pkgDir),
          pages: [],
          inject: [],
          error: error?.message ?? String(error),
        })
      }
    }
  }

  return {
    uiPluginsDir: uiPluginsDir ? resolve(uiPluginsDir) : null,
    plugins,
    roots,
  }
}

/**
 * Validate a decoded pathname for `/api/ui-plugins/*` (same hardening as static UI assets).
 */
function sanitizePluginRelPath(relPath) {
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.includes(':')) return null
  if (relPath === '' || relPath.startsWith('/') || relPath.endsWith('/')) return null
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || /[. ]$/u.test(seg)) return null
  }
  return segments.join('/')
}

/**
 * Create the authenticated Fetch handler for `/api/ui-plugins/manifest` and `/api/ui-plugins/files/*`.
 */
export function createUiPluginsResource({ getSnapshot, authorizeRequest }) {
  return async (request, peer) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: 'GET, HEAD' } })
    }
    const url = new URL(request.url)
    if (peer === undefined) {
      // Never accept launch-token redirects on API endpoints; require an established session cookie.
      if (url.searchParams.has('token')) {
        return new Response('unauthorized', { status: 401, headers: SECURITY_HEADERS })
      }
      const refusal = authorizeRequest(request)
      if (refusal !== undefined) return refusal
    }

    let decodedPath
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      return new Response(null, { status: 400, headers: SECURITY_HEADERS })
    }

    if (decodedPath === UI_PLUGINS_MANIFEST_PATH) {
      const snapshot = await getSnapshot({ refresh: true })
      const body = JSON.stringify({
        uiPluginsDir: snapshot.uiPluginsDir,
        plugins: snapshot.plugins,
      })
      const headers = {
        ...SECURITY_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(body, { status: 200, headers })
    }

    if (!decodedPath.startsWith(UI_PLUGINS_FILES_PREFIX)) {
      return new Response(null, { status: 404, headers: SECURITY_HEADERS })
    }

    const rest = decodedPath.slice(UI_PLUGINS_FILES_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) {
      return new Response(null, { status: 404, headers: SECURITY_HEADERS })
    }
    let pluginId
    try {
      pluginId = decodeURIComponent(rest.slice(0, slash))
    } catch {
      return new Response(null, { status: 400, headers: SECURITY_HEADERS })
    }
    const relPath = sanitizePluginRelPath(rest.slice(slash + 1))
    if (relPath === null) {
      return new Response(null, { status: 403, headers: SECURITY_HEADERS })
    }
    const mime = ALLOWED_PLUGIN_MIME[extname(relPath).toLowerCase()]
    if (!mime) {
      return new Response(null, { status: 403, headers: SECURITY_HEADERS })
    }

    const snapshot = await getSnapshot({ refresh: false })
    const rootDir = snapshot.roots.get(pluginId)
    if (!rootDir) {
      return new Response(null, { status: 404, headers: SECURITY_HEADERS })
    }

    try {
      const root = resolve(rootDir)
      const target = resolve(root, relPath)
      if (!target.startsWith(withSep(root))) {
        return new Response(null, { status: 403, headers: SECURITY_HEADERS })
      }
      const realRoot = await realpath(root)
      const realTarget = await realpath(target)
      if (!realTarget.startsWith(withSep(realRoot))) {
        return new Response(null, { status: 403, headers: SECURITY_HEADERS })
      }
      const body = await readFile(realTarget)
      const headers = {
        ...SECURITY_HEADERS,
        'content-type': mime,
        'cache-control': 'no-store',
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(bytesBody(body), { status: 200, headers })
    } catch (error) {
      if (STATIC_MISS_CODES.has(error?.code)) {
        return new Response(null, { status: 404, headers: SECURITY_HEADERS })
      }
      throw error
    }
  }
}

export function normalizePluginDisplayName(moduleName, fallbackId) {
  const raw = String(moduleName ?? '').trim()
  if (!raw) return String(fallbackId ?? '')
  if (raw.startsWith('file://') || isAbsolute(raw) || raw.startsWith('.')) {
    const clean = raw.replace(/^file:\/\//i, '').replace(/\/+$/, '')
    const base = basename(clean)
    if (base === 'index.js' || base === 'index.mjs' || base === 'index.cjs') {
      const parent = basename(dirname(clean))
      if (parent && parent !== '.' && parent !== '/') return parent
    }
    return base || String(fallbackId ?? raw)
  }
  return raw
}
