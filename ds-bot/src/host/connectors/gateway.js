// The connector gateway: one local HTTP server inside the plugin process. Every
// remote connector's mcp-client mounts `http://127.0.0.1:<port>/c/<id>` with a
// random per-process nonce, so no real credential ever reaches the mcp-client
// config. The gateway adds the credential here and streams the answer back.
// When a connector's read-only switch is on, tools/list answers are filtered to
// readOnlyHint tools and write tools/call is refused locally.
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

const FORWARD_HEADERS = ['mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'accept', 'content-type']
const RETURN_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version']
const RETRYABLE = new Set(['GET', 'POST', 'DELETE'])

const nonceMatches = (header, nonce) => {
  const given = /^Bearer\s+(.+)$/i.exec(String(header ?? ''))?.[1] ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(nonce)
  return a.length === b.length && timingSafeEqual(a, b)
}

const sseMessage = (body) => {
  // Pull the JSON-RPC payload out of an SSE body (one or more event frames).
  const frames = []
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data !== '') frames.push(data)
  }
  return frames.length === 1 ? frames[0] : null
}

// Upstreams are https; loopback HTTP is allowed for local custom servers.
const loopbackHttp = url => /^http:\/\/(127\.|localhost|::1)/i.test(String(url))
const upstreamRequest = (target, init, onResponse) =>
  (target.protocol === 'http:' && loopbackHttp(target) ? httpRequest : httpsRequest)(target, init, onResponse)

const readAll = stream => new Promise((resolve, reject) => {
  if (stream.errored) { reject(stream.errored); return }
  const chunks = []
  stream.on('data', chunk => chunks.push(chunk))
  stream.on('end', () => resolve(Buffer.concat(chunks)))
  stream.on('error', reject)
})

export function createGateway({ credential, readOnly, onUnauthorized, log = () => {} }) {
  const nonce = randomBytes(24).toString('base64url')
  let server = null
  let port = 0
  // Tool annotations seen in tools/list answers, per connector, for read-only checks.
  const annotations = new Map()

  const toolReadOnly = (id, name) => {
    const flags = annotations.get(id)
    return flags?.get(name) === true
  }

  // Marks annotations from a tools/list result, and filters it when read-only.
  const processList = (id, result, filtered) => {
    const tools = Array.isArray(result?.result?.tools) ? result.result.tools : null
    if (tools === null) return result
    let flags = annotations.get(id)
    if (flags === undefined) annotations.set(id, flags = new Map())
    for (const tool of tools) flags.set(tool.name, tool.annotations?.readOnlyHint === true)
    if (!filtered) return result
    return { ...result, result: { ...result.result, tools: tools.filter(tool => tool.annotations?.readOnlyHint === true) } }
  }

  const refuseCall = (id, rpc) => ({
    jsonrpc: '2.0',
    id: rpc?.id ?? null,
    error: { code: -32600, message: `The ${id} connector is read-only: this tool can change things, so it is off. Turn off the read-only switch in Settings → Connectors to use it.` },
  })

  // A 401 that survives the refresh: answer the JSON-RPC request with a reason
  // the Bot can act on, instead of an empty HTTP error.
  const signInAgain = (id, body, upstream, res) => {
    let rpc
    try { rpc = JSON.parse(body?.toString('utf8') ?? '') } catch { return false }
    if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.id === undefined) return false
    upstream.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: rpc.id,
      error: { code: -32001, message: `The ${id} connector needs sign-in again. Call request_connector with id ${id} so the user can sign in, or ask them to sign in under Settings → Connectors.` },
    }))
    return true
  }

  async function sendUpstream(id, entry, method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const target = new URL(entry.url)
      const suffix = new URL(path, 'http://x')
      if (suffix.pathname !== '/') {
        target.pathname = `${target.pathname.replace(/\/$/, '')}/${suffix.pathname.replace(/^\//, '')}`
      }
      for (const [key, value] of suffix.searchParams) target.searchParams.append(key, value)
      const outgoing = { ...entry.headers }
      for (const name of FORWARD_HEADERS) if (headers[name] !== undefined) outgoing[name] = headers[name]
      if (body !== undefined) outgoing['content-length'] = body.length
      const req = upstreamRequest(target, { method, headers: outgoing }, upstream => {
        // This listener must exist before refresh awaits: the response can fail
        // before the handler starts consuming it.
        upstream.on('error', reject)
        // GET 405 is the normal answer from servers without a standalone stream.
        if (upstream.statusCode >= 400 && !(method === 'GET' && upstream.statusCode === 405)) log('ds-bot: connector %s upstream %s HTTP %s (session: %s)', id, method, upstream.statusCode, headers['mcp-session-id'] !== undefined)
        resolve(upstream)
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  async function handle(id, req, res) {
    const entry = credential(id)
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector not connected' }))
      return
    }
    if (!/^https:\/\//i.test(entry.url) && !loopbackHttp(entry.url)) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector address must be https' }))
      return
    }
    const suffix = req.url.slice(`/c/${id}`.length)
    const path = suffix === '' ? '/' : suffix
    const limited = readOnly(id) === true
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readAll(req)
    // Read-only: a write tools/call never reaches the server.
    if (limited && req.method === 'POST' && body !== undefined) {
      let rpc
      try { rpc = JSON.parse(body.toString('utf8')) } catch { rpc = null }
      if (Array.isArray(rpc)) {
        // A batch could hide a write call, so read-only refuses them outright.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `The ${id} connector is read-only: batched calls are refused.` } }))
        return
      }
      if (rpc?.method === 'tools/call' && !toolReadOnly(id, rpc.params?.name)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(refuseCall(id, rpc)))
        return
      }
      if (rpc?.method === 'tools/list') {
        let upstream = await sendUpstream(id, entry, req.method, path, req.headers, body)
        if (upstream.statusCode === 401) {
          const retried = await onUnauthorized(id)
          if (retried === true) {
            upstream.resume()
            upstream = await sendUpstream(id, credential(id) ?? entry, req.method, path, req.headers, body)
          }
        }
        if (upstream.statusCode === 401 && signInAgain(id, body, upstream, res)) return
        const raw = await readAll(upstream)
        const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
        const payload = isSse ? sseMessage(raw.toString('utf8')) : raw.toString('utf8')
        let out = raw
        try {
          const parsed = payload === null ? null : JSON.parse(payload)
          if (parsed !== null) {
            const filtered = JSON.stringify(processList(id, parsed, true))
            out = isSse ? Buffer.from(`event: message\ndata: ${filtered}\n\n`) : Buffer.from(filtered)
          }
        } catch { /* pass the answer through unchanged */ }
        const heads = {}
        for (const name of RETURN_HEADERS) if (upstream.headers[name] !== undefined) heads[name] = upstream.headers[name]
        if (!isSse) heads['content-length'] = out.length
        else delete heads['content-length']
        res.writeHead(upstream.statusCode ?? 502, heads)
        res.end(out)
        return
      }
    }
    if (!RETRYABLE.has(req.method)) {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    let upstream
    try {
      upstream = await sendUpstream(id, entry, req.method, path, req.headers, body)
      // One refresh + retry when the answer is still unsent.
      if (upstream.statusCode === 401) {
        const retried = await onUnauthorized(id)
        if (retried === true) {
          upstream.resume()
          upstream = await sendUpstream(id, credential(id) ?? entry, req.method, path, req.headers, body)
        }
      }
      if (upstream.errored) throw upstream.errored
    } catch (error) {
      log('ds-bot: connector gateway %s: %s', id, error?.message ?? error)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector upstream failed' }))
      return
    }
    if (upstream.statusCode === 401 && req.method === 'POST' && signInAgain(id, body, upstream, res)) return
    // tools/list without the read-only filter still feeds the annotation cache.
    const isList = req.method === 'POST' && body !== undefined && (() => { try { return JSON.parse(body.toString('utf8'))?.method === 'tools/list' } catch { return false } })()
    const heads = {}
    for (const name of RETURN_HEADERS) if (upstream.headers[name] !== undefined) heads[name] = upstream.headers[name]
    if (!isList || limited) {
      const close = () => { upstream.destroy() }
      res.on('close', close)
      upstream.on('end', () => res.off('close', close))
      upstream.on('error', () => {
        log('ds-bot: connector %s upstream %s stream failed', id, req.method)
        res.destroy()
      })
      res.writeHead(upstream.statusCode ?? 502, heads)
      upstream.pipe(res)
      return
    }
    // Unfiltered tools/list: buffer to learn annotations, then send as-is.
    const raw = await readAll(upstream)
    try {
      const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
      const payload = isSse ? sseMessage(raw.toString('utf8')) : raw.toString('utf8')
      if (payload !== null) processList(id, JSON.parse(payload), false)
    } catch { /* annotations stay as they were */ }
    res.writeHead(upstream.statusCode ?? 502, heads)
    res.end(raw)
  }

  return {
    get port() { return port },
    get nonce() { return nonce },
    urlFor(id) { return `http://127.0.0.1:${port}/c/${id}` },
    headers() { return { Authorization: `Bearer ${nonce}` } },
    forget(id) { annotations.delete(id) },
    async listen() {
      if (server !== null) return
      server = createServer((req, res) => {
        req.on('error', () => res.destroy())
        res.on('error', () => req.destroy())
        const found = /^\/c\/([A-Za-z0-9_-]{1,32})/.exec(req.url ?? '')
        if (found === null || !nonceMatches(req.headers.authorization, nonce)) {
          res.writeHead(404)
          res.end()
          return
        }
        handle(found[1], req, res).catch((error) => {
          log('ds-bot: connector gateway: %s', error?.message ?? error)
          if (res.headersSent) res.destroy()
          else { res.writeHead(502); res.end() }
        })
      })
      server.on('error', error => log('ds-bot: connector gateway server failed: %s', error?.code ?? 'error'))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      port = server.address().port
    },
    async close() {
      const closing = server
      server = null
      if (closing !== null) await new Promise(resolve => closing.close(resolve))
      annotations.clear()
    },
  }
}
