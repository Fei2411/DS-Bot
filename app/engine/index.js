// The engine's frontend server and host-only directory picker: claims the
// webserver fallback seat to exchange DSH's one-time launch token for the Host
// cookie on `/` and serve DS Bot's own built interface (app/ui/dist) on the
// same loopback origin as `/api/bot`, and mounts only the host-side directory
// picker backend (never DSH Web's `dsh-client-ui-directory-picker-*` rows).
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import NativeDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-native'

export const name = 'dsbot-engine'
export const inject = ['webServer', 'connection']

const HTML_MIME = 'text/html; charset=utf-8'
const MIME = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

const STATIC_MISS_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' }

/** Resolve DS Bot's built UI directory in dev, asar, or unpacked layouts. */
export function resolveDistDir(config, { env = process.env, moduleUrl = import.meta.url, exists = existsSync } = {}) {
  const configured = typeof config?.distDir === 'string' && config.distDir.trim() !== ''
    ? config.distDir.trim()
    : (typeof env.DS_BOT_UI_DIR === 'string' && env.DS_BOT_UI_DIR.trim() !== '' ? env.DS_BOT_UI_DIR.trim() : '')
  if (configured !== '') return resolve(configured)
  const here = dirname(fileURLToPath(moduleUrl))
  // Installed under app/node_modules/dsbot-engine -> ../../ui/dist; direct checkout -> ../ui/dist.
  for (const candidate of [join(here, '..', '..', 'ui', 'dist'), join(here, '..', 'ui', 'dist')]) {
    if (exists(join(candidate, 'index.html'))) return resolve(candidate)
  }
  return resolve(join(here, '..', '..', 'ui', 'dist'))
}

function canExecute(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** True when the local desktop host can open a native OS folder chooser without DSH Web UI. */
export function shouldUseNativeDirectoryPicker({
  platform = process.platform,
  env = process.env,
  executable = canExecute,
} = {}) {
  if (platform === 'darwin' || platform === 'win32') return true
  if (platform !== 'linux') return false
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (executable(join(dir, 'zenity')) || executable(join(dir, 'kdialog'))) return true
  }
  return false
}

function bytesBody(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function withSep(dir) {
  return dir.endsWith(sep) ? dir : dir + sep
}

function etagMatches(header, etag) {
  if (typeof header !== 'string' || header.trim() === '') return false
  const target = etag.replace(/^W\//u, '')
  for (const raw of header.split(',')) {
    const token = raw.trim()
    if (token === '*') return true
    if (token === etag || token.replace(/^W\//u, '') === target) return true
  }
  return false
}

/**
 * Validate a decoded URL pathname before touching the filesystem:
 * blocks null bytes, Windows backslashes, NTFS Alternate Data Streams (`:`),
 * `.` / `..` traversal segments, and NTFS trailing-dot / trailing-space aliases.
 */
function sanitizePathname(decodedPath) {
  if (decodedPath.includes('\0')) return { status: 400 }
  if (decodedPath.includes('\\') || decodedPath.includes(':')) return { status: 403 }
  if (!decodedPath.startsWith('/')) return { status: 400 }
  if (decodedPath.startsWith('//')) return { status: 403 }
  if (decodedPath !== '/' && decodedPath.endsWith('/')) return { status: 404 }
  const segments = decodedPath.slice(1).split('/')
  if (decodedPath !== '/') {
    for (const seg of segments) {
      if (seg === '.' || seg === '..') return { status: 403 }
      if (seg !== '' && /[. ]$/u.test(seg)) return { status: 403 }
    }
  }
  return { ok: true }
}

/**
 * Create the Fetch resource serving DS Bot's built UI from `distDir`.
 * Index and HTML requests pass `authorizeIndex` first (case-insensitively) so
 * the Host launch token is traded for the session cookie; static assets are
 * strictly confined inside `distDir` (including `realpath` checks outside asar).
 */
export function createUiResource({ distDir, authorizeIndex }) {
  const distRoot = resolve(distDir)
  const distRootPrefix = withSep(distRoot)
  const distIndex = join(distRoot, 'index.html')
  const checkRealpath = !/\.asar(?:[\\/]|$)/u.test(distRoot)
  let realDistRootPromise = null
  const getRealDistRoot = () => {
    if (!checkRealpath) return Promise.resolve(null)
    realDistRootPromise ??= realpath(distRoot).catch(() => {
      realDistRootPromise = null
      return null
    })
    return realDistRootPromise
  }

  return async (request, peer) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: 'GET, HEAD' } })
    }
    let decodedPath
    try {
      decodedPath = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response(null, { status: 400, headers: SECURITY_HEADERS })
    }
    const checked = sanitizePathname(decodedPath)
    if (!checked.ok) {
      return new Response(null, { status: checked.status, headers: SECURITY_HEADERS })
    }

    const lowerPath = decodedPath.toLowerCase()
    const isIndex = lowerPath === '/' || lowerPath === '/index.html'
    const isHtml = isIndex || extname(lowerPath) === '.html' || extname(lowerPath) === '.htm'

    if (isHtml && peer === undefined) {
      const refusal = authorizeIndex(request)
      if (refusal !== undefined) return refusal
    }

    let body
    let headers
    try {
      if (isIndex) {
        body = await readFile(distIndex, 'utf8')
        headers = { ...SECURITY_HEADERS, 'content-type': HTML_MIME, 'cache-control': 'no-store' }
      } else {
        const target = resolve(distRoot, decodedPath.slice(1))
        if (!target.startsWith(distRootPrefix) || target.toLowerCase() === distIndex.toLowerCase()) {
          return new Response(null, { status: 403, headers: SECURITY_HEADERS })
        }
        if (checkRealpath) {
          const realRoot = await getRealDistRoot()
          if (realRoot === null) return new Response(null, { status: 404, headers: SECURITY_HEADERS })
          const realTarget = await realpath(target)
          if (!realTarget.startsWith(withSep(realRoot))) {
            return new Response(null, { status: 403, headers: SECURITY_HEADERS })
          }
        }
        body = await readFile(target)
        if (isHtml) {
          headers = { ...SECURITY_HEADERS, 'content-type': HTML_MIME, 'cache-control': 'no-store' }
        } else {
          const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`
          const cache = { 'cache-control': 'no-cache', etag }
          if (etagMatches(request.headers.get('if-none-match'), etag)) {
            return new Response(null, { status: 304, headers: { ...SECURITY_HEADERS, ...cache } })
          }
          headers = {
            ...SECURITY_HEADERS,
            'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
            ...cache,
          }
        }
      }
    } catch (error) {
      if (!STATIC_MISS_CODES.has(error?.code)) throw error
      return new Response(null, { status: 404, headers: SECURITY_HEADERS })
    }

    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
  }
}

export function apply(ctx, config) {
  // Host-only directory picker: provides `ctx.directoryPicker` for DS Bot's folder chooser
  // without dynamically mounting DSH Web's `dsh-client-ui-directory-picker-*` front-end rows.
  ctx.plugin(shouldUseNativeDirectoryPicker() ? NativeDirectoryPicker : BrowseDirectoryPicker)

  const distDir = resolveDistDir(config)
  const authorizeIndex = (request) => {
    let status = 401
    let headers = new Headers()
    let body
    const allowed = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) {
        body = text
      },
    })
    return allowed ? undefined : new Response(body, { status, headers })
  }
  const resource = createUiResource({ distDir, authorizeIndex })
  ctx.effect(() => ctx.webServer.registerFallback({ resource }), 'dsbot-engine: ui dist fallback')
}
