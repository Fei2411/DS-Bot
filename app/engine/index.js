// The engine's frontend server: claims the webserver fallback seat to exchange
// DSH's one-time launch token for the Host cookie on `/` and serve DS Bot's
// own built interface (app/ui/dist) on the same loopback origin as `/api/bot`.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function bytesBody(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Create the Fetch resource serving DS Bot's built UI from `distDir`.
 * Index requests pass `authorizeIndex` first so the Host launch token is traded
 * for the session cookie; static assets are strictly confined inside `distDir`.
 */
export function createUiResource({ distDir, authorizeIndex }) {
  const distRoot = resolve(distDir)
  const distIndex = join(distRoot, 'index.html')

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
    if (decodedPath.includes('\0')) {
      return new Response(null, { status: 400, headers: SECURITY_HEADERS })
    }
    const target = resolve(normalize(join(distRoot, decodedPath)))
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      return new Response(null, { status: 403, headers: SECURITY_HEADERS })
    }

    let body
    let headers
    try {
      if (target === distRoot || target === distIndex) {
        if (peer === undefined) {
          const refusal = authorizeIndex(request)
          if (refusal !== undefined) return refusal
        }
        body = await readFile(distIndex, 'utf8')
        headers = { ...SECURITY_HEADERS, 'content-type': HTML_MIME, 'cache-control': 'no-store' }
      } else {
        body = await readFile(target)
        const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`
        const cache = { 'cache-control': 'no-cache', etag }
        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, { status: 304, headers: { ...SECURITY_HEADERS, ...cache } })
        }
        headers = {
          ...SECURITY_HEADERS,
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          ...cache,
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
