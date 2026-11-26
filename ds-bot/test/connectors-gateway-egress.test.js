// How the connector gateway reaches its upstream: through the proxy the launcher installed, event by
// event, never cut for being quiet, and with a call that stops when the client gives up. The
// upstream, the proxy and the client are the test; the gateway runs in a child process when the
// process-wide proxy policy matters.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
import { createSecureServer as createHttp2 } from 'node:http2'
import { createServer as createHttps } from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGateway } from '../src/host/connectors/gateway.js'
import { selfSigned } from './fixtures/self-signed.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const decode = chunk => new TextDecoder().decode(chunk)
const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref()),
])
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const listen = server => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)) })
const stop = server => () => { server.closeAllConnections?.(); server.close() }

async function inProcessGateway(t, upstream, { readOnly = false } = {}) {
  const logs = []
  const gateway = createGateway({
    credential: () => ({ url: upstream, headers: { Authorization: 'Bearer private-token' } }),
    readOnly: () => readOnly,
    onUnauthorized: async () => false,
    log: (...args) => logs.push(args.join(' ')),
  })
  await gateway.listen()
  t.after(() => gateway.close())
  return { logs, call: (init = {}) => fetch(gateway.urlFor('svc'), { ...init, headers: { ...gateway.headers(), ...init.headers } }) }
}

// An upstream that sends one event, then holds the next until the test lets go.
function heldStream() {
  const release = deferred()
  const state = { secondSent: false, closed: deferred(), release: release.resolve }
  state.handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: one\n\n')
    res.on('close', state.closed.resolve)
    release.promise.then(() => { state.secondSent = true; res.end('event: message\ndata: two\n\n') })
  }
  return state
}

test('an upstream stream reaches the client event by event, not when it ends', async (t) => {
  const stream = heldStream()
  const upstream = createHttp(stream.handler)
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  const response = await call({ headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(3000) })
  const reader = response.body.getReader()
  assert.match(decode((await reader.read()).value), /data: one/)
  assert.equal(stream.secondSent, false, 'the first event arrived while the upstream still held the second')
  stream.release()
  let rest = ''
  for (let next = await reader.read(); !next.done; next = await reader.read()) rest += decode(next.value)
  assert.match(rest, /data: two/)
})

for (const readOnly of [false, true]) {
  test(`a client that gives up before the upstream answers closes the upstream request${readOnly ? ' (read-only tools/list)' : ''}`, async (t) => {
    const arrived = deferred()
    const closed = deferred()
    const upstream = createHttp((req, res) => {
      res.on('close', closed.resolve)
      req.resume()
      req.on('end', arrived.resolve)
    })
    const port = await listen(upstream)
    t.after(stop(upstream))
    const { call, logs } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`, { readOnly })
    const controller = new AbortController()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: readOnly ? 'tools/list' : 'tools/call', params: {} })
    const pending = call({ method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal }).catch(() => {})
    await within(arrived.promise, 2000, 'the upstream receives the call')
    controller.abort()
    await within(closed.promise, 2000, 'the upstream request is closed after the client gave up')
    await pending
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(logs, [], 'a client leaving is not a failure to report')
  })
}

test('a client that gives up mid-stream closes the upstream stream', async (t) => {
  const stream = heldStream()
  const upstream = createHttp(stream.handler)
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call, logs } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  const controller = new AbortController()
  const response = await call({ headers: { accept: 'text/event-stream' }, signal: controller.signal })
  await response.body.getReader().read()
  controller.abort()
  await within(stream.closed.promise, 2000, 'the upstream stream is closed after the client gave up')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(logs, [], 'a client leaving is not a failure to report')
})

test('an upstream redirect is passed on, not followed', async (t) => {
  let followed = 0
  const target = createHttp((req, res) => { followed += 1; res.end('followed') })
  const targetPort = await listen(target)
  t.after(stop(target))
  const upstream = createHttp((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/elsewhere`, 'content-type': 'text/plain' })
    res.end('moved')
  })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  const response = await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(await response.text(), 'moved')
  assert.equal(followed, 0)
})

// The old node:https client sent exactly what the connector and the client set, plus the three
// every request carries. undici's `request` does the same; `fetch` added four more.
const FORWARDED = ['accept', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'mcp-protocol-version', 'mcp-session-id']
const headerNames = req => req.rawHeaders.filter((name, index) => index % 2 === 0).map(name => name.toLowerCase())
const mcpCall = { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'client-session' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }

test('the upstream sees the headers the connector and the client set and nothing else', async (t) => {
  const seen = []
  const upstream = createHttp((req, res) => { seen.push(req); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  assert.equal((await call(mcpCall)).status, 200)
  assert.deepEqual(headerNames(seen[0]).sort(), FORWARDED)
  assert.equal(seen[0].headers.authorization, 'Bearer private-token')
  assert.equal(seen[0].headers['mcp-session-id'], 'client-session')
})

test('a strict upstream that allows only a fixed header list accepts the call', async (t) => {
  const upstream = createHttp((req, res) => {
    req.resume()
    const unexpected = headerNames(req).find(name => !FORWARDED.includes(name))
    res.writeHead(unexpected === undefined ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(unexpected === undefined ? { ok: true } : { error: `unexpected header ${unexpected}` }))
  })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call, logs } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  const response = await call(mcpCall)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(logs, [])
})

// fetch refuses the ports a browser blocks (6000, 6667, 10080, 5060 ...); a connector on one of
// them worked with the old client and does again.
test('an upstream on a port that fetch refuses is reached', async (t) => {
  const upstream = createHttp((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"port":"blocked-for-fetch"}') })
  const port = await new Promise(resolve => upstream.listen(6667, '127.0.0.1', () => resolve(6667)).on('error', () => resolve(0)))
  if (port === 0) { t.skip('port 6667 is in use here'); return }
  t.after(stop(upstream))
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed/, 'fetch refuses this port')
  const { call } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  assert.deepEqual(await (await call(mcpCall)).json(), { port: 'blocked-for-fetch' })
})

// The gateway in a child process, with the proxy policy installed from the environment as the
// launcher does, and an https upstream reachable only through that proxy.
const NOT_INHERITED = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs)$/i

async function startChild(t, { upstream, proxy, ca, undiciTimeoutMs, headers, control }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !NOT_INHERITED.test(name)))
  if (proxy !== undefined) env.HTTPS_PROXY = proxy
  if (ca !== undefined) env.NODE_EXTRA_CA_CERTS = ca
  env.GATEWAY_EGRESS = JSON.stringify({ upstream, undiciTimeoutMs, headers, control })
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(here, 'harness-resolve.mjs')).href, join(here, 'fixtures/gateway-egress.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = once(child, 'exit')
  t.after(async () => {
    child.stdin.end()
    await within(exited, 3000, 'the gateway process exits').catch(() => child.kill())
  })
  // The child prints one JSON line per fact: first where the gateway listens, later what a plain
  // fetch made in the same process did (see `control`).
  const lines = []
  const waiting = []
  let text = ''
  child.stdout.on('data', (chunk) => {
    text += chunk
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
      const line = JSON.parse(text.slice(0, end))
      text = text.slice(end + 1)
      if (waiting.length > 0) waiting.shift()(line)
      else lines.push(line)
    }
  })
  const exitedEarly = new Promise((resolve, reject) => child.on('exit', code => reject(new Error(`the gateway process exited with ${code}: ${stderr}`))))
  const nextLine = (what, ms) => within(Promise.race([new Promise(resolve => (lines.length > 0 ? resolve(lines.shift()) : waiting.push(resolve))), exitedEarly]), ms, what)
  const { url, headers: auth } = await nextLine('the gateway process starts', 10_000)
  return { stderr: () => stderr, controlResult: () => nextLine('the control fetch ends', 10_000), call: (init = {}) => fetch(url, { ...init, headers: { ...auth, ...init.headers } }) }
}

// An https upstream for upstream.example, and a proxy that tunnels every CONNECT to it.
async function tunnel(t, handler, { http2 = false } = {}) {
  const { cert, key } = selfSigned('upstream.example')
  const dir = mkdtempSync(join(tmpdir(), 'dsb-gateway-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ca = join(dir, 'ca.pem')
  writeFileSync(ca, cert)
  const upstream = http2 ? createHttp2({ cert, key, allowHTTP1: true }, handler) : createHttps({ cert, key }, handler)
  const upstreamPort = await listen(upstream)
  t.after(stop(upstream))
  const connects = []
  const sockets = new Set()
  const proxy = createHttp((req, res) => { res.writeHead(502); res.end() })
  proxy.on('connect', (req, client) => {
    connects.push(req.url)
    const target = net.connect(upstreamPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      target.pipe(client)
      client.pipe(target)
    })
    for (const socket of [client, target]) {
      sockets.add(socket)
      socket.on('error', () => { client.destroy(); target.destroy() })
    }
  })
  const proxyPort = await listen(proxy)
  t.after(() => { for (const socket of sockets) socket.destroy(); stop(proxy)() })
  return { ca, connects, proxy: `http://127.0.0.1:${proxyPort}` }
}

test('an https upstream is reached through the proxy the launcher installed', async (t) => {
  const seen = []
  const route = await tunnel(t, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, session: req.headers['mcp-session-id'], body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'upstream-session' })
      res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    })
  })
  const gateway = await startChild(t, { upstream: 'https://upstream.example/mcp?key=k', proxy: route.proxy, ca: route.ca })
  const response = await gateway.call(mcpCall)
  assert.deepEqual(route.connects, ['upstream.example:443'], gateway.stderr())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('mcp-session-id'), 'upstream-session')
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: { ok: true } })
  assert.deepEqual(seen, [{ method: 'POST', url: '/mcp?key=k', authorization: 'Bearer private-token', session: 'client-session', body: mcpCall.body }])
})

// The old client spoke HTTP/1.1 only; undici would use HTTP/2 with a server that offers it.
test('an upstream that offers HTTP/2 is spoken to over HTTP/1.1, through the proxy', async (t) => {
  const versions = []
  const route = await tunnel(t, (req, res) => { versions.push(req.httpVersion); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, { http2: true })
  const gateway = await startChild(t, { upstream: 'https://upstream.example/mcp', proxy: route.proxy, ca: route.ca })
  assert.equal((await gateway.call(mcpCall)).status, 200, gateway.stderr())
  assert.deepEqual(versions, ['1.1'])
})

test('a stream through the proxy reaches the client event by event and stops when the client gives up', async (t) => {
  const stream = heldStream()
  const route = await tunnel(t, stream.handler)
  const gateway = await startChild(t, { upstream: 'https://upstream.example/mcp', proxy: route.proxy, ca: route.ca })
  const controller = new AbortController()
  const response = await gateway.call({ headers: { accept: 'text/event-stream' }, signal: controller.signal })
  assert.deepEqual(route.connects, ['upstream.example:443'], gateway.stderr())
  const reader = response.body.getReader()
  assert.match(decode((await within(reader.read(), 3000, 'the first event arrives')).value), /data: one/)
  assert.equal(stream.secondSent, false, 'the first event arrived while the upstream still held the second')
  controller.abort()
  await within(stream.closed.promise, 2000, 'the upstream stream is closed after the client gave up')
})

test('a loopback upstream stays direct when a proxy is configured', async (t) => {
  const route = await tunnel(t, (req, res) => res.end('not reached'))
  const upstream = createHttp((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"direct":true}') })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const gateway = await startChild(t, { upstream: `http://127.0.0.1:${port}/mcp`, proxy: route.proxy, ca: route.ca })
  const response = await gateway.call(mcpCall)
  assert.deepEqual(await response.json(), { direct: true })
  assert.deepEqual(route.connects, [])
})

// fetch refuses an address that carries credentials; the old client turned them into Basic auth
// unless the connector already sent an Authorization header.
test('credentials in a connector address are sent as Basic auth, not in the address or the log', async (t) => {
  const seen = []
  const route = await tunnel(t, (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const address = 'https://bot:s3cr%40t@upstream.example/mcp?key=private-key'
  const plain = await startChild(t, { upstream: address, proxy: route.proxy, ca: route.ca, headers: {} })
  assert.equal((await plain.call(mcpCall)).status, 200, plain.stderr())
  const bearer = await startChild(t, { upstream: address, proxy: route.proxy, ca: route.ca, headers: { Authorization: 'Bearer private-token' } })
  assert.equal((await bearer.call(mcpCall)).status, 200, bearer.stderr())
  assert.deepEqual(seen, [
    { url: '/mcp?key=private-key', authorization: `Basic ${Buffer.from('bot:s3cr@t').toString('base64')}` },
    { url: '/mcp?key=private-key', authorization: 'Bearer private-token' },
  ])
  for (const gateway of [plain, bearer]) assert.doesNotMatch(gateway.stderr(), /s3cr|private-key/)
})

test('a failed call to an address with credentials does not log them', async (t) => {
  const closed = createHttp()
  const closedPort = await listen(closed)
  closed.close()
  const gateway = await startChild(t, { upstream: 'https://bot:s3cr%40t@upstream.example/mcp?key=private-key', proxy: `http://127.0.0.1:${closedPort}` })
  const response = await gateway.call(mcpCall)
  assert.equal(response.status, 502)
  assert.match(gateway.stderr(), /connector gateway/, 'the failure is logged')
  assert.doesNotMatch(gateway.stderr(), /s3cr|private-key/)
})

// undici ends a request that sends no response head, or no body bytes, for 300 s by default, and
// an MCP stream may stay quiet for far longer. The child stands in for that default with a 300 ms
// limit on the process-wide dispatcher, which is what the launcher's own dispatcher carries too;
// a plain fetch made in the same child shows the limit is in force.
const QUIET_MS = 2500

test('an upstream that is slow to answer is not cut by the dispatcher limit', async (t) => {
  const upstream = createHttp((req, res) => {
    req.resume()
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"late":true}') }, QUIET_MS)
  })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const url = `http://127.0.0.1:${port}/mcp`
  const gateway = await startChild(t, { upstream: url, undiciTimeoutMs: 300, control: url })
  const response = await gateway.call({ ...mcpCall, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, gateway.stderr())
  assert.deepEqual(await response.json(), { late: true })
  assert.equal((await gateway.controlResult()).control, 'UND_ERR_HEADERS_TIMEOUT', 'the limit does cut a plain fetch to the same upstream')
  assert.doesNotMatch(gateway.stderr(), /connector gateway/)
})

test('an upstream stream that goes quiet is not cut by the dispatcher limit', async (t) => {
  const upstream = createHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: one\n\n')
    setTimeout(() => res.end('event: message\ndata: two\n\n'), QUIET_MS)
  })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const url = `http://127.0.0.1:${port}/mcp`
  const gateway = await startChild(t, { upstream: url, undiciTimeoutMs: 300, control: url })
  const response = await gateway.call({ headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(10_000) })
  assert.match(await response.text(), /data: one\n\nevent: message\ndata: two\n\n$/, gateway.stderr())
  assert.equal((await gateway.controlResult()).control, 'UND_ERR_BODY_TIMEOUT', 'the limit does cut a plain fetch to the same upstream')
  assert.doesNotMatch(gateway.stderr(), /stream failed/)
})
