// Local loopback HTTP/CONNECT proxy bridge in the Electron main process.
//
// Both the main process (`createFetch()`) and the DSH Host child process (`hostEnv()`) route
// outbound HTTP(S) traffic through this bridge so every request honors:
// 1) DS Bot's proxy setting (`system` / `custom` / `direct`) with live hot-switching,
// 2) macOS/Windows/Linux OS system proxy, PAC scripts, HTTP/HTTPS proxies, and SOCKS4/SOCKS5
//    (including remote DNS resolution via SOCKS5 ATYP 0x03),
// 3) explicit launch environment variables or `$DSH_HOME/.env` when in `system` mode.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net, { isIP } from 'node:net'
import tls from 'node:tls'
import {
  formatHost,
  isLoopbackHost,
  matchesBypass,
  parseAuthority,
  parseIpv6Bytes,
  parsePacProxyList,
  parseProxyUrl,
  readEnvProxyConfig,
  stripBrackets,
} from './proxy-prefs.mjs'

const CONNECT_TIMEOUT_MS = 15_000
const MAX_UPSTREAM_HEADER_BYTES = 16 * 1024
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1,[::1],0.0.0.0'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
])

const tlsServername = (host) => {
  const bare = stripBrackets(host)
  return bare && isIP(bare) === 0 ? bare : undefined
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && timingSafeEqual(left, right)
}

function basicAuthHeader(username, password) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function parseConnectAuthority(raw) {
  return parseAuthority(raw)
}

function readExact(socket, count, buffered, timeoutMs) {
  return new Promise((resolve, reject) => {
    let chunks = buffered.length > 0 ? [buffered] : []
    let total = buffered.length
    if (total >= count) {
      const merged = Buffer.concat(chunks)
      resolve({ data: merged.subarray(0, count), rest: merged.subarray(count) })
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Proxy handshake timed out'))
    }, timeoutMs)
    const onData = (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= count) {
        cleanup()
        const merged = Buffer.concat(chunks)
        resolve({ data: merged.subarray(0, count), rest: merged.subarray(count) })
      }
    }
    const onError = (error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error('Proxy connection closed during handshake')) }
    function cleanup() {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function readHeaderBlock(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Upstream proxy CONNECT timed out'))
    }, timeoutMs)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end !== -1) {
        cleanup()
        resolve({ headerText: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) })
        return
      }
      if (buf.length > MAX_UPSTREAM_HEADER_BYTES) {
        cleanup()
        reject(new Error('Upstream proxy response headers too large'))
      }
    }
    const onError = (error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error('Upstream proxy closed before CONNECT completed')) }
    function cleanup() {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function connectSocket(options, timeoutMs, useTls = false) {
  return new Promise((resolve, reject) => {
    const socket = useTls ? tls.connect(options) : net.connect(options)
    const event = useTls ? 'secureConnect' : 'connect'
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error('Connection timed out'))
    }, timeoutMs)
    const onConnect = () => { cleanup(); socket.setNoDelay(true); resolve(socket) }
    const onError = (error) => { cleanup(); socket.destroy(); reject(error) }
    function cleanup() {
      clearTimeout(timer)
      socket.off(event, onConnect)
      socket.off('error', onError)
    }
    socket.once(event, onConnect)
    socket.once('error', onError)
  })
}

function ipv6ToBuffer(address) {
  const bytes = parseIpv6Bytes(address)
  if (!bytes) throw new Error('Invalid IPv6 address')
  return Buffer.from(bytes)
}

async function dialHttpConnect(candidate, targetHost, targetPort, timeoutMs) {
  const useTls = candidate.type === 'https'
  const servername = tlsServername(candidate.host)
  const socket = await connectSocket(
    useTls ? { host: candidate.host, port: candidate.port, ...(servername ? { servername } : {}) } : { host: candidate.host, port: candidate.port },
    timeoutMs,
    useTls,
  )
  try {
    const authority = `${formatHost(targetHost)}:${String(targetPort)}`
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
    const auth = basicAuthHeader(candidate.username, candidate.password)
    if (auth) lines.push(`Proxy-Authorization: ${auth}`)
    lines.push('Proxy-Connection: Keep-Alive', '', '')
    socket.write(lines.join('\r\n'))
    const { headerText, rest } = await readHeaderBlock(socket, timeoutMs)
    const statusLine = headerText.split('\r\n')[0] ?? ''
    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/u)
    const status = match ? Number(match[1]) : 0
    if (status < 200 || status >= 300) {
      throw new Error(`Upstream proxy rejected CONNECT with HTTP ${String(status)}`)
    }
    return { socket, rest }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function dialSocks5(candidate, targetHost, targetPort, timeoutMs) {
  const socket = await connectSocket({ host: candidate.host, port: candidate.port }, timeoutMs)
  try {
    const hasAuth = Boolean(candidate.username || candidate.password)
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
    let { data: greeting, rest } = await readExact(socket, 2, Buffer.alloc(0), timeoutMs)
    if (greeting[0] !== 0x05) throw new Error('Invalid SOCKS5 greeting version')
    const method = greeting[1]
    if (method === 0x02) {
      if (!hasAuth) throw new Error('SOCKS5 proxy requires authentication')
      const userBuf = Buffer.from(candidate.username, 'utf8')
      const passBuf = Buffer.from(candidate.password, 'utf8')
      if (userBuf.length > 255 || passBuf.length > 255) throw new Error('SOCKS5 credentials exceed 255 bytes')
      socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]))
      const authReply = await readExact(socket, 2, rest, timeoutMs)
      rest = authReply.rest
      if (authReply.data[0] !== 0x01 || authReply.data[1] !== 0x00) throw new Error('SOCKS5 authentication failed')
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 proxy selected unsupported auth method ${String(method)}`)
    }
    const bareHost = stripBrackets(targetHost)
    const ipKind = isIP(bareHost)
    let addrPart
    if (ipKind === 4) {
      addrPart = Buffer.from([0x01, ...bareHost.split('.').map(Number)])
    } else if (ipKind === 6) {
      addrPart = Buffer.concat([Buffer.from([0x04]), ipv6ToBuffer(bareHost)])
    } else {
      const hostBuf = Buffer.from(bareHost, 'utf8')
      if (hostBuf.length > 255) throw new Error('Target hostname exceeds SOCKS5 limit')
      addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf])
    }
    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(targetPort, 0)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]))

    const headReply = await readExact(socket, 4, rest, timeoutMs)
    rest = headReply.rest
    if (headReply.data[0] !== 0x05 || headReply.data[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed with code ${String(headReply.data[1])}`)
    }
    const atyp = headReply.data[3]
    let remaining = 0
    if (atyp === 0x01) remaining = 4 + 2
    else if (atyp === 0x04) remaining = 16 + 2
    else if (atyp === 0x03) {
      const lenReply = await readExact(socket, 1, rest, timeoutMs)
      rest = lenReply.rest
      remaining = lenReply.data[0] + 2
    } else {
      throw new Error(`Unsupported SOCKS5 address type ${String(atyp)}`)
    }
    const tailReply = await readExact(socket, remaining, rest, timeoutMs)
    return { socket, rest: tailReply.rest }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function dialSocks4(candidate, targetHost, targetPort, timeoutMs) {
  const socket = await connectSocket({ host: candidate.host, port: candidate.port }, timeoutMs)
  try {
    const bareHost = stripBrackets(targetHost)
    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(targetPort, 0)
    const userBuf = Buffer.from(candidate.username || '', 'utf8')
    let payload
    if (isIP(bareHost) === 4) {
      payload = Buffer.concat([Buffer.from([0x04, 0x01]), portBuf, Buffer.from(bareHost.split('.').map(Number)), userBuf, Buffer.from([0x00])])
    } else {
      // SOCKS4a remote DNS resolution.
      payload = Buffer.concat([Buffer.from([0x04, 0x01]), portBuf, Buffer.from([0x00, 0x00, 0x00, 0x01]), userBuf, Buffer.from([0x00]), Buffer.from(bareHost, 'utf8'), Buffer.from([0x00])])
    }
    socket.write(payload)
    const reply = await readExact(socket, 8, Buffer.alloc(0), timeoutMs)
    if (reply.data[0] !== 0x00 || reply.data[1] !== 0x5a) throw new Error(`SOCKS4 CONNECT failed with code ${String(reply.data[1])}`)
    return { socket, rest: reply.rest }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function dialCandidate(candidate, targetHost, targetPort, timeoutMs) {
  if (candidate.type === 'direct') {
    const socket = await connectSocket({ host: targetHost, port: targetPort }, timeoutMs)
    return { socket, rest: Buffer.alloc(0) }
  }
  if (candidate.type === 'http' || candidate.type === 'https') {
    return dialHttpConnect(candidate, targetHost, targetPort, timeoutMs)
  }
  if (candidate.type === 'socks5') {
    return dialSocks5(candidate, targetHost, targetPort, timeoutMs)
  }
  if (candidate.type === 'socks4') {
    return dialSocks4(candidate, targetHost, targetPort, timeoutMs)
  }
  throw new Error(`Unsupported proxy candidate type: ${String(candidate.type)}`)
}

async function dialWithFallback(candidates, targetHost, targetPort, timeoutMs) {
  let lastError
  for (const candidate of candidates) {
    try {
      return await dialCandidate(candidate, targetHost, targetPort, timeoutMs)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No proxy candidate succeeded')
}

function cleanForwardHeaders(headers, hostHeader) {
  const dynamicHopByHop = new Set()
  const rawConn = headers?.connection
  const connValues = Array.isArray(rawConn) ? rawConn : (typeof rawConn === 'string' ? [rawConn] : [])
  for (const entry of connValues) {
    for (const token of entry.split(',')) {
      const name = token.trim().toLowerCase()
      if (name) dynamicHopByHop.add(name)
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || dynamicHopByHop.has(lower)) continue
    out[key] = value
  }
  if (hostHeader) out.host = hostHeader
  // Each forwarded plain HTTP request uses a single-use unpooled socket; force close so the
  // upstream peer closes cleanly instead of holding the socket open until idle timeout.
  out.connection = 'close'
  return out
}

/**
 * Start the loopback HTTP/CONNECT proxy bridge.
 * @param {{
 *   getPrefs: () => { mode: 'system'|'custom'|'direct', url: string, bypass: string },
 *   resolveSystemProxy?: (url: string) => Promise<string>,
 *   getEnvProxy?: () => { http: any, https: any, noProxy: string },
 *   timeoutMs?: number,
 *   allowLoopbackTargets?: boolean,
 *   log?: { warn?: Function, error?: Function },
 * }} options
 */
export async function createProxyBridge({
  getPrefs,
  resolveSystemProxy = async () => 'DIRECT',
  getEnvProxy = () => readEnvProxyConfig(process.env),
  timeoutMs = CONNECT_TIMEOUT_MS,
  allowLoopbackTargets = false,
  log = console,
} = {}) {
  const secret = randomBytes(24).toString('hex')
  const expectedAuth = `Basic ${Buffer.from(`dsbot:${secret}`).toString('base64')}`
  const activeSockets = new Set()
  const activeDispatchers = new Set()
  let bridgePort = 0
  let closed = false

  const trackSocket = (socket) => {
    activeSockets.add(socket)
    socket.once('close', () => { activeSockets.delete(socket) })
    return socket
  }

  const isAuthorized = (req) => safeEqual(req.headers['proxy-authorization'] ?? '', expectedAuth)

  const isSelfProxy = (candidate) => candidate.type !== 'direct'
    && isLoopbackHost(candidate.host)
    && Number(candidate.port) === bridgePort

  const resolveCandidates = async (targetUrl, targetHost, targetPort, protocol) => {
    const prefs = getPrefs?.() ?? { mode: 'system', url: '', bypass: '' }
    if (prefs.mode === 'direct') return [{ type: 'direct' }]
    if (prefs.mode === 'custom') {
      if (matchesBypass(targetHost, targetPort, prefs.bypass, { bypassLoopback: !allowLoopbackTargets })) {
        return [{ type: 'direct' }]
      }
      try {
        const parsed = parseProxyUrl(prefs.url)
        return isSelfProxy(parsed) ? [{ type: 'direct' }] : [parsed]
      } catch {
        return [{ type: 'direct' }]
      }
    }
    // System mode: explicit launch environment / $DSH_HOME/.env wins over OS probe if set.
    const envProxy = getEnvProxy?.()
    if (envProxy) {
      const chosen = protocol === 'http:' ? envProxy.http : envProxy.https
      if (chosen && !isSelfProxy(chosen)) {
        if (matchesBypass(targetHost, targetPort, envProxy.noProxy, { bypassLoopback: !allowLoopbackTargets })) {
          return [{ type: 'direct' }]
        }
        return [chosen]
      }
    }
    let pacResult = 'DIRECT'
    try {
      pacResult = await resolveSystemProxy(targetUrl)
    } catch (error) {
      log?.warn?.(`DS Bot: system proxy lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const candidates = parsePacProxyList(pacResult).filter(candidate => !isSelfProxy(candidate))
    return candidates.length > 0 ? candidates : [{ type: 'direct' }]
  }

  const server = http.createServer((req, res) => {
    if (closed) { res.writeHead(503).end(); return }
    if (!isAuthorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="DS Bot"', connection: 'close' })
      res.end('Proxy authentication required')
      return
    }
    let target
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400, { connection: 'close' }).end('Invalid proxy target URL')
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(400, { connection: 'close' }).end('Unsupported target protocol')
      return
    }
    const targetHost = stripBrackets(target.hostname)
    const targetPort = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80)
    if (isLoopbackHost(targetHost) && (targetPort === bridgePort || !allowLoopbackTargets)) {
      res.writeHead(403, { connection: 'close' }).end('Loopback target refused')
      return
    }
    let aborted = false
    let upstreamReq
    let upstreamSocket
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted = true
        upstreamReq?.destroy()
        upstreamSocket?.destroy()
      }
    })
    void (async () => {
      const candidates = await resolveCandidates(target.href, targetHost, targetPort, target.protocol)
      if (closed || aborted || res.destroyed) return
      const headers = cleanForwardHeaders(req.headers, target.host)
      const transport = target.protocol === 'https:' ? https : http
      const targetSni = tlsServername(targetHost)

      let lastError
      for (const candidate of candidates) {
        if (closed || aborted || res.destroyed) return
        try {
          if (candidate.type === 'direct') {
            const socket = await connectSocket({ host: targetHost, port: targetPort }, timeoutMs)
            if (closed || aborted || res.destroyed) { socket.destroy(); return }
            upstreamSocket = trackSocket(socket)
            upstreamReq = transport.request({
              host: targetHost,
              port: targetPort,
              method: req.method,
              path: `${target.pathname}${target.search}`,
              headers,
              agent: false,
              createConnection: () => (target.protocol === 'https:' ? tls.connect({ socket, ...(targetSni ? { servername: targetSni } : {}) }) : socket),
              timeout: timeoutMs,
            })
            break
          }
          if ((candidate.type === 'http' || candidate.type === 'https') && target.protocol === 'http:') {
            const useTls = candidate.type === 'https'
            const proxySni = tlsServername(candidate.host)
            const socket = await connectSocket(
              useTls ? { host: candidate.host, port: candidate.port, ...(proxySni ? { servername: proxySni } : {}) } : { host: candidate.host, port: candidate.port },
              timeoutMs,
              useTls,
            )
            if (closed || aborted || res.destroyed) { socket.destroy(); return }
            upstreamSocket = trackSocket(socket)
            const proxyTransport = useTls ? https : http
            const proxyAuth = basicAuthHeader(candidate.username, candidate.password)
            upstreamReq = proxyTransport.request({
              host: candidate.host,
              port: candidate.port,
              method: req.method,
              path: target.href,
              headers: proxyAuth ? { ...headers, 'proxy-authorization': proxyAuth } : headers,
              agent: false,
              createConnection: () => socket,
              timeout: timeoutMs,
            })
            break
          }
          const { socket, rest } = await dialCandidate(candidate, targetHost, targetPort, timeoutMs)
          if (closed || aborted || res.destroyed) { socket.destroy(); return }
          if (rest.length > 0) socket.unshift(rest)
          upstreamSocket = trackSocket(socket)
          upstreamReq = transport.request({
            host: targetHost,
            port: targetPort,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers,
            agent: false,
            createConnection: () => (target.protocol === 'https:' ? tls.connect({ socket, ...(targetSni ? { servername: targetSni } : {}) }) : socket),
            timeout: timeoutMs,
          })
          break
        } catch (error) {
          lastError = error
        }
      }
      if (closed || aborted || res.destroyed) { upstreamReq?.destroy(); upstreamSocket?.destroy(); return }
      if (!upstreamReq) throw lastError ?? new Error('No proxy candidate succeeded')

      upstreamReq.on('response', (upstreamRes) => {
        if (res.headersSent || res.destroyed) { upstreamRes.resume(); upstreamReq.destroy(); upstreamSocket?.destroy(); return }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        res.once('finish', () => { upstreamSocket?.destroy() })
        upstreamRes.pipe(res)
      })
      upstreamReq.on('error', () => {
        upstreamSocket?.destroy()
        if (!res.headersSent && !res.destroyed) res.writeHead(502, { connection: 'close' }).end('Bad Gateway')
        else if (!res.destroyed) res.destroy()
      })
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream request timed out'))
        upstreamSocket?.destroy()
      })
      req.pipe(upstreamReq)
    })().catch(() => {
      upstreamSocket?.destroy()
      if (!res.headersSent && !res.destroyed) res.writeHead(502, { connection: 'close' }).end('Bad Gateway')
      else if (!res.destroyed) res.destroy()
    })
  })

  server.on('connect', (req, clientSocket, head) => {
    trackSocket(clientSocket)
    clientSocket.on('error', () => { clientSocket.destroy() })
    if (closed) {
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    if (!isAuthorized(req)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="DS Bot"\r\nConnection: close\r\n\r\n')
      return
    }
    const authority = parseConnectAuthority(req.url)
    if (!authority) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    if (isLoopbackHost(authority.host) && (authority.port === bridgePort || !allowLoopbackTargets)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    void (async () => {
      const targetUrl = `https://${formatHost(authority.host)}:${String(authority.port)}`
      const candidates = await resolveCandidates(targetUrl, authority.host, authority.port, 'https:')
      const { socket: upstream, rest } = await dialWithFallback(candidates, authority.host, authority.port, timeoutMs)
      trackSocket(upstream)
      if (closed || clientSocket.destroyed) {
        upstream.destroy()
        return
      }
      clientSocket.setNoDelay(true)
      upstream.setNoDelay(true)
      upstream.on('error', () => { clientSocket.destroy(); upstream.destroy() })
      clientSocket.on('error', () => { upstream.destroy(); clientSocket.destroy() })
      clientSocket.on('close', () => { upstream.destroy() })
      upstream.on('close', () => { clientSocket.destroy() })

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length > 0) clientSocket.write(rest)
      if (head && head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })().catch(() => {
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  bridgePort = server.address().port
  const proxyUrl = `http://dsbot:${secret}@127.0.0.1:${String(bridgePort)}`

  const applyHostEnv = (baseEnv = {}) => {
    const next = { ...baseEnv }
    // Explicitly shadow ALL_PROXY with empty string rather than deleting so @deepseek-ai/dsh-app-boot's
    // loadLayeredEnv does not backfill a SOCKS ALL_PROXY from $DSH_HOME/.env.
    next.ALL_PROXY = ''
    next.all_proxy = ''
    next.HTTP_PROXY = proxyUrl
    next.HTTPS_PROXY = proxyUrl
    next.http_proxy = proxyUrl
    next.https_proxy = proxyUrl
    next.NO_PROXY = LOOPBACK_NO_PROXY
    next.no_proxy = LOOPBACK_NO_PROXY
    return next
  }

  let undiciPromise
  let proxyDispatcher
  let directDispatcher
  const ensureUndici = async () => {
    if (!undiciPromise) {
      undiciPromise = import('undici').then((mod) => {
        // allowH2: false prevents undici's idle h2 session informational UND_ERR_INFO errors.
        proxyDispatcher = new mod.ProxyAgent({ uri: proxyUrl, allowH2: false })
        directDispatcher = new mod.Agent({ allowH2: false })
        activeDispatchers.add(proxyDispatcher)
        activeDispatchers.add(directDispatcher)
        return mod
      })
    }
    return undiciPromise
  }

  const createFetch = () => async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    let useDirect = false
    if (typeof rawUrl === 'string') {
      try {
        const parsed = new URL(rawUrl)
        if (!allowLoopbackTargets && isLoopbackHost(parsed.hostname)) useDirect = true
      } catch { /* let fetch report invalid URL */ }
    }
    const mod = await ensureUndici()
    const dispatcher = useDirect ? directDispatcher : proxyDispatcher
    return mod.fetch(input, init ? { ...init, dispatcher } : { dispatcher })
  }

  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of activeSockets) socket.destroy()
    activeSockets.clear()
    for (const dispatcher of activeDispatchers) {
      try { await dispatcher.close() } catch { /* ignore close errors */ }
    }
    activeDispatchers.clear()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(() => resolve()))
  }

  return { port: bridgePort, proxyUrl, applyHostEnv, createFetch, close }
}
