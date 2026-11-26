import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isIP } from 'node:net'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function plainHost(host: string): boolean {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(host)
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) return false
  const name = match[1]
  if (name.startsWith('[')) return isIP(name.slice(1, -1)) === 6
  if (/^[0-9.]+$/.test(name)) return isIP(name) === 4
  return name.length <= 253 && name.replace(/\.$/, '').split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

export function serveWeb(req: IncomingMessage, res: ServerResponse, directory: string): boolean {
  const pathname = (req.url ?? '').split('?')[0]
  if ((req.method !== 'GET' && req.method !== 'HEAD') || (pathname !== '/web' && !pathname.startsWith('/web/'))) return false
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const host = req.headers.host ?? ''
  if (!plainHost(host)) {
    res.writeHead(400).end()
    return true
  }
  res.setHeader('Content-Security-Policy', `default-src 'self'; connect-src 'self' ws://${host} wss://${host}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`)
  if (pathname === '/web') {
    res.writeHead(308, { location: '/web/' }).end()
    return true
  }
  void sendFile().catch(() => { res.writeHead(500).end() })
  return true

  async function sendFile() {
    let path: string
    try { path = decodeURIComponent(pathname.slice('/web/'.length)) } catch {
      res.writeHead(400).end()
      return
    }
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..') || isAbsolute(path)) {
      res.writeHead(403).end()
      return
    }
    try {
      const root = await realpath(directory)
      async function locate(name: string) {
        const file = await realpath(resolve(root, name))
        if (!inside(root, file)) throw Object.assign(new Error('Outside web directory'), { code: 'EACCES' })
        if (!(await stat(file)).isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' })
        return file
      }
      let file: string
      try { file = await locate(path || 'index.html') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || extname(path)) throw error
        file = await locate('index.html')
      }
      const body = await readFile(file)
      const headers: Record<string, string | number> = {
        'content-type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
      }
      if (relative(root, file) === 'index.html') headers['cache-control'] = 'no-cache'
      res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      res.writeHead(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : code === 'EACCES' ? 403 : 500).end()
    }
  }
}
