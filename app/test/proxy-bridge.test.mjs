import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProxyBridge } from '../src/proxy-bridge.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise(resolve => server.close(() => resolve()))
}

/** Real HTTP forward + CONNECT proxy server for contract tests. */
async function createMockHttpProxy({ expectedAuth = null } = {}) {
  const seen = { http: [], connect: [] }
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="upstream"' }).end()
      return
    }
    seen.http.push(req.url)
    const target = new URL(req.url)
    const fwdHeaders = { ...req.headers, host: target.host }
    delete fwdHeaders['proxy-authorization']
    const up = http.request({
      host: target.hostname,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: fwdHeaders,
    }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, 'x-via-http-proxy': '1' })
      upRes.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) res.writeHead(502).end() })
    req.pipe(up)
  })
  server.on('connect', (req, client, head) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    seen.connect.push(req.url)
    const [host, portStr] = req.url.split(':')
    const up = net.connect(Number(portStr), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) up.write(head)
      client.pipe(up)
      up.pipe(client)
    })
    sockets.add(up)
    up.once('close', () => sockets.delete(up))
    up.on('error', () => client.destroy())
    client.on('error', () => up.destroy())
  })
  const port = await listen(server)
  return {
    port,
    seen,
    close: async () => { for (const s of sockets) s.destroy(); await closeServer(server) },
  }
}

/** Real RFC 1928 / RFC 1929 SOCKS5 proxy server for contract tests. */
async function createMockSocks5Proxy({ username = '', password = '' } = {}) {
  const seen = []
  const sockets = new Set()
  const requireAuth = Boolean(username || password)
  const server = net.createServer((client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    let buf = Buffer.alloc(0)
    let stage = 'greeting'
    const advance = () => {
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const nMethods = buf[1]
        if (buf.length < 2 + nMethods) return
        const methods = buf.subarray(2, 2 + nMethods)
        buf = buf.subarray(2 + nMethods)
        if (requireAuth) {
          if (!methods.includes(0x02)) { client.end(Buffer.from([0x05, 0xff])); return }
          client.write(Buffer.from([0x05, 0x02]))
          stage = 'auth'
        } else {
          client.write(Buffer.from([0x05, 0x00]))
          stage = 'request'
        }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return
        const uLen = buf[1]
        if (buf.length < 2 + uLen + 1) return
        const user = buf.subarray(2, 2 + uLen).toString('utf8')
        const pLen = buf[2 + uLen]
        if (buf.length < 3 + uLen + pLen) return
        const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8')
        buf = buf.subarray(3 + uLen + pLen)
        if (user !== username || pass !== password) {
          client.end(Buffer.from([0x01, 0x01]))
          return
        }
        client.write(Buffer.from([0x01, 0x00]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 4) return
        const atyp = buf[3]
        let host
        let offset = 4
        if (atyp === 0x01) {
          if (buf.length < 10) return
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          if (buf.length < 5) return
          const len = buf[4]
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        const port = buf.readUInt16BE(offset)
        const leftover = buf.subarray(offset + 2)
        buf = Buffer.alloc(0)
        stage = 'tunneled'
        client.off('data', onData)
        seen.push({ host, port, atyp })
        const up = net.connect(port, host === 'remote.test' ? '127.0.0.1' : host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (leftover.length) up.write(leftover)
          client.pipe(up)
          up.pipe(client)
        })
        sockets.add(up)
        up.once('close', () => sockets.delete(up))
        up.on('error', () => client.destroy())
        client.on('error', () => up.destroy())
      }
    }
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      advance()
    }
    client.on('data', onData)
  })
  const port = await listen(server)
  return {
    port,
    seen,
    close: async () => { for (const s of sockets) s.destroy(); await closeServer(server) },
  }
}

/** Perform an HTTP CONNECT through the bridge and send/read a raw TCP payload. */
function connectThroughBridge(bridgePort, authHeader, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(bridgePort, '127.0.0.1', () => {
      const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
      if (authHeader) headers.push(`Proxy-Authorization: ${authHeader}`)
      socket.write(`${headers.join('\r\n')}\r\n\r\n`)
    })
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const statusLine = buf.subarray(0, end).toString('latin1').split('\r\n')[0]
      resolve({ statusLine, socket, rest: buf.subarray(end + 4) })
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

test('proxy bridge enforces auth and blocks loopback targets in production mode', async () => {
  const bridge = await createProxyBridge({
    getPrefs: () => ({ mode: 'direct', url: '', bypass: '' }),
    getEnvProxy: () => ({ http: null, https: null, noProxy: '' }),
  })
  try {
    const unauth = await connectThroughBridge(bridge.port, null, 'api.openai.com:443')
    assert.match(unauth.statusLine, /407/)
    unauth.socket.destroy()

    const wrongAuth = await connectThroughBridge(bridge.port, 'Basic d3Jvbmc6d3Jvbmc=', 'api.openai.com:443')
    assert.match(wrongAuth.statusLine, /407/)
    wrongAuth.socket.destroy()

    const authHeader = `Basic ${Buffer.from(new URL(bridge.proxyUrl).username + ':' + new URL(bridge.proxyUrl).password).toString('base64')}`
    for (const target of [
      '127.0.0.1:8080',
      '127.1:8080',
      '2130706433:8080',
      '0x7f000001:8080',
      '[0:0:0:0:0:0:0:1]:8080',
      '[::0:1]:8080',
      '[::ffff:0:7f00:1]:8080',
    ]) {
      const loopbackBlocked = await connectThroughBridge(bridge.port, authHeader, target)
      assert.match(loopbackBlocked.statusLine, /403/, `expected 403 for ${target}`)
      loopbackBlocked.socket.destroy()
    }

    const env = bridge.applyHostEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080', PATH: '/usr/bin' })
    assert.equal(env.HTTP_PROXY, bridge.proxyUrl)
    assert.equal(env.HTTPS_PROXY, bridge.proxyUrl)
    assert.equal(env.ALL_PROXY, '')
    assert.equal(env.all_proxy, '')
    assert.match(env.NO_PROXY, /127\.0\.0\.1/)
  } finally {
    await bridge.close()
  }
})

test('proxy bridge routes HTTP, SSE, redirect:manual, SOCKS5 auth, fallback chains, and live mode switching', async () => {
  const targetHits = []
  const targetServer = http.createServer((req, res) => {
    targetHits.push(req.url)
    if (req.url === '/redir') {
      res.writeHead(302, { location: 'https://example.com/elsewhere' })
      res.end()
      return
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: chunk-1\n\n')
      setTimeout(() => { res.write('data: chunk-2\n\n'); res.end() }, 15)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  const targetPort = await listen(targetServer)

  const echoServer = net.createServer((sock) => {
    sock.once('data', (chunk) => {
      sock.end(Buffer.concat([Buffer.from('ECHO:'), chunk]))
    })
  })
  const echoPort = await listen(echoServer)

  const upstreamAuth = `Basic ${Buffer.from('upuser:uppass').toString('base64')}`
  const httpProxy = await createMockHttpProxy({ expectedAuth: upstreamAuth })
  const plainHttpProxy = await createMockHttpProxy()
  const socksProxy = await createMockSocks5Proxy({ username: 'suser', password: 'spass' })

  let prefs = { mode: 'system', url: '', bypass: '' }
  let pacAnswer = `PROXY 127.0.0.1:${String(plainHttpProxy.port)}`

  const bridge = await createProxyBridge({
    getPrefs: () => prefs,
    resolveSystemProxy: async () => pacAnswer,
    getEnvProxy: () => ({ http: null, https: null, noProxy: '' }),
    allowLoopbackTargets: true,
  })

  try {
    const appFetch = bridge.createFetch()
    const bridgeAuth = `Basic ${Buffer.from(new URL(bridge.proxyUrl).username + ':' + new URL(bridge.proxyUrl).password).toString('base64')}`

    // 1. System mode resolves OS/PAC HTTP proxy and preserves redirect: 'manual' + SSE streaming.
    const r1 = await appFetch(`http://127.0.0.1:${String(targetPort)}/hello`)
    assert.equal(r1.status, 200)
    assert.equal(r1.headers.get('x-via-http-proxy'), '1')
    assert.deepEqual(await r1.json(), { ok: true, path: '/hello' })
    assert.equal(plainHttpProxy.seen.http.length, 1)

    const rRedir = await appFetch(`http://127.0.0.1:${String(targetPort)}/redir`, { redirect: 'manual' })
    assert.equal(rRedir.status, 302)
    assert.equal(rRedir.headers.get('location'), 'https://example.com/elsewhere')

    const rSse = await appFetch(`http://127.0.0.1:${String(targetPort)}/sse`)
    assert.equal(rSse.status, 200)
    const sseChunks = []
    for await (const chunk of Readable.fromWeb(rSse.body)) sseChunks.push(chunk.toString('utf8'))
    assert.equal(sseChunks.join(''), 'data: chunk-1\n\ndata: chunk-2\n\n')

    // 2. Live PAC fallback: dead first proxy falls back cleanly to live second proxy.
    pacAnswer = `PROXY 127.0.0.1:1; PROXY 127.0.0.1:${String(plainHttpProxy.port)}`
    const rFallback = await appFetch(`http://127.0.0.1:${String(targetPort)}/fallback`)
    assert.equal(rFallback.status, 200)
    assert.equal(rFallback.headers.get('x-via-http-proxy'), '1')

    // 3. Hot-switch to Direct mode (no restart): bypasses proxy completely.
    prefs = { mode: 'direct', url: '', bypass: '' }
    const beforeProxyHits = plainHttpProxy.seen.http.length
    const rDirect = await appFetch(`http://127.0.0.1:${String(targetPort)}/direct`)
    assert.equal(rDirect.status, 200)
    assert.equal(rDirect.headers.get('x-via-http-proxy'), null)
    assert.equal(plainHttpProxy.seen.http.length, beforeProxyHits)

    // 4. Hot-switch to Custom authenticated HTTP proxy: forwards Proxy-Authorization upstream.
    prefs = { mode: 'custom', url: `http://upuser:uppass@127.0.0.1:${String(httpProxy.port)}`, bypass: '' }
    const rCustomAuth = await appFetch(`http://127.0.0.1:${String(targetPort)}/auth-http`)
    assert.equal(rCustomAuth.status, 200)
    assert.equal(rCustomAuth.headers.get('x-via-http-proxy'), '1')
    assert.equal(httpProxy.seen.http.length, 1)

    // 5. Custom bypass rule sends matching target direct while non-matching goes through proxy.
    prefs = { mode: 'custom', url: `http://upuser:uppass@127.0.0.1:${String(httpProxy.port)}`, bypass: '127.0.0.1' }
    const rBypassed = await appFetch(`http://127.0.0.1:${String(targetPort)}/bypassed`)
    assert.equal(rBypassed.status, 200)
    assert.equal(rBypassed.headers.get('x-via-http-proxy'), null)
    assert.equal(httpProxy.seen.http.length, 1)

    // 6. Hot-switch to Custom authenticated SOCKS5 proxy + CONNECT tunnel with remote DNS (ATYP 0x03).
    prefs = { mode: 'custom', url: `socks5://suser:spass@127.0.0.1:${String(socksProxy.port)}`, bypass: '' }
    const rSocksHttp = await appFetch(`http://127.0.0.1:${String(targetPort)}/via-socks5`)
    assert.equal(rSocksHttp.status, 200)
    assert.deepEqual(await rSocksHttp.json(), { ok: true, path: '/via-socks5' })
    assert.equal(socksProxy.seen.length, 1)

    const tun = await connectThroughBridge(bridge.port, bridgeAuth, `remote.test:${String(echoPort)}`)
    assert.match(tun.statusLine, /200 Connection Established/)
    tun.socket.write('ping-socks5')
    const echoed = await new Promise((resolve, reject) => {
      const parts = tun.rest.length ? [tun.rest] : []
      tun.socket.on('data', d => parts.push(d))
      tun.socket.once('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      tun.socket.once('error', reject)
    })
    assert.equal(echoed, 'ECHO:ping-socks5')
    // Verify domain name was sent remotely (ATYP 0x03) instead of local DNS resolution.
    assert.deepEqual(socksProxy.seen.at(-1), { host: 'remote.test', port: echoPort, atyp: 0x03 })

    // 7. Self-recursion to bridge's own port is ALWAYS rejected with 403.
    const selfLoop = await connectThroughBridge(bridge.port, bridgeAuth, `127.0.0.1:${String(bridge.port)}`)
    assert.match(selfLoop.statusLine, /403/)
    selfLoop.socket.destroy()
  } finally {
    await bridge.close()
    await Promise.all([
      httpProxy.close(),
      plainHttpProxy.close(),
      socksProxy.close(),
      closeServer(targetServer),
      closeServer(echoServer),
    ])
  }
})

test('plain HTTP strips Connection + hop-by-hop headers without leaking sockets, system env NO_PROXY skips OS proxy, and SOCKS4a CONNECT works', async () => {
  let openUpstreamSockets = 0
  let lastSeenHeaders = null
  const targetServer = http.createServer((req, res) => {
    lastSeenHeaders = req.headers
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  targetServer.on('connection', (sock) => {
    openUpstreamSockets += 1
    sock.once('close', () => { openUpstreamSockets -= 1 })
  })
  const targetPort = await listen(targetServer)

  const echoServer = net.createServer((sock) => {
    sock.once('data', chunk => sock.end(Buffer.concat([Buffer.from('S4A:'), chunk])))
  })
  const echoPort = await listen(echoServer)

  // Real SOCKS4a mock proxy.
  const socks4Seen = []
  const socks4Sockets = new Set()
  const socks4Server = net.createServer((client) => {
    socks4Sockets.add(client)
    client.once('close', () => socks4Sockets.delete(client))
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 9) return
      const userEnd = buf.indexOf(0x00, 8)
      if (userEnd === -1) return
      const isSocks4a = buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0
      let host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
      let restStart = userEnd + 1
      if (isSocks4a) {
        const hostEnd = buf.indexOf(0x00, userEnd + 1)
        if (hostEnd === -1) return
        host = buf.subarray(userEnd + 1, hostEnd).toString('utf8')
        restStart = hostEnd + 1
      }
      const port = buf.readUInt16BE(2)
      const leftover = buf.subarray(restStart)
      client.off('data', onData)
      socks4Seen.push({ host, port })
      const up = net.connect(port, host === 's4a.test' ? '127.0.0.1' : host, () => {
        client.write(Buffer.from([0x00, 0x5a, 0, 0, 127, 0, 0, 1]))
        if (leftover.length) up.write(leftover)
        client.pipe(up)
        up.pipe(client)
      })
      socks4Sockets.add(up)
      up.once('close', () => socks4Sockets.delete(up))
      up.on('error', () => client.destroy())
      client.on('error', () => up.destroy())
    }
    client.on('data', onData)
  })
  const socks4Port = await listen(socks4Server)

  let osProxyCalls = 0
  let prefs = { mode: 'system', url: '', bypass: '' }
  const bridge = await createProxyBridge({
    getPrefs: () => prefs,
    resolveSystemProxy: async () => { osProxyCalls += 1; return 'PROXY 127.0.0.1:1' },
    getEnvProxy: () => ({
      http: { type: 'http', host: '127.0.0.1', port: 1, username: '', password: '' },
      https: { type: 'http', host: '127.0.0.1', port: 1, username: '', password: '' },
      noProxy: '127.0.0.1',
    }),
    allowLoopbackTargets: true,
  })

  try {
    const appFetch = bridge.createFetch()
    const bridgeAuth = `Basic ${Buffer.from(new URL(bridge.proxyUrl).username + ':' + new URL(bridge.proxyUrl).password).toString('base64')}`

    // 1a. Raw HTTP request through bridge: strips Connection + headers named in Connection and closes upstream cleanly.
    const rawStatus = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: bridge.port,
        method: 'GET',
        path: `http://127.0.0.1:${String(targetPort)}/hop-raw`,
        headers: {
          host: `127.0.0.1:${String(targetPort)}`,
          'proxy-authorization': bridgeAuth,
          connection: 'keep-alive, x-custom-hop',
          'x-custom-hop': 'secret-hop',
          'x-keep': 'yes',
        },
      }, (resp) => {
        resp.resume()
        resp.once('end', () => resolve(resp.statusCode))
      })
      req.once('error', reject)
      req.end()
    })
    assert.equal(rawStatus, 200)
    assert.equal(osProxyCalls, 0, 'env NO_PROXY match must return DIRECT without calling resolveSystemProxy')
    assert.equal(lastSeenHeaders['x-custom-hop'], undefined, 'hop-by-hop header named in Connection must be stripped')
    assert.equal(lastSeenHeaders['x-keep'], 'yes')
    assert.equal(lastSeenHeaders.connection, 'close')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(openUpstreamSockets, 0, 'upstream TCP socket must close cleanly after raw plain HTTP response')

    // 1b. appFetch through bridge also leaves zero leaked upstream sockets.
    const res = await appFetch(`http://127.0.0.1:${String(targetPort)}/hop-fetch`, { headers: { 'x-keep': 'fetch' } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(osProxyCalls, 0)
    assert.equal(lastSeenHeaders['x-keep'], 'fetch')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(openUpstreamSockets, 0, 'upstream TCP socket must close cleanly after appFetch response')

    // 2. Custom SOCKS4a CONNECT tunnel works with remote hostname.
    prefs = { mode: 'custom', url: `socks4a://127.0.0.1:${String(socks4Port)}`, bypass: '' }
    const tun = await connectThroughBridge(bridge.port, bridgeAuth, `s4a.test:${String(echoPort)}`)
    assert.match(tun.statusLine, /200 Connection Established/)
    tun.socket.write('hello')
    const echoed = await new Promise((resolve, reject) => {
      const parts = tun.rest.length ? [tun.rest] : []
      tun.socket.on('data', d => parts.push(d))
      tun.socket.once('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      tun.socket.once('error', reject)
    })
    assert.equal(echoed, 'S4A:hello')
    assert.deepEqual(socks4Seen, [{ host: 's4a.test', port: echoPort }])
  } finally {
    await bridge.close()
    for (const s of socks4Sockets) s.destroy()
    await Promise.all([closeServer(socks4Server), closeServer(targetServer), closeServer(echoServer)])
  }
})
