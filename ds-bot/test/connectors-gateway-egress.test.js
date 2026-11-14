// How the connector gateway reaches its upstream: through the proxy the launcher installed, event by
// event, and with a call that stops when the client gives up. The upstream, the proxy and the client
// are the test; the gateway runs in a child process when the process-wide proxy policy matters.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
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

// Known difference from the node:https client the gateway used before: fetch always adds these
// request headers, and sec-fetch-mode cannot be overridden or removed.
const FORWARDED = ['accept', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'mcp-protocol-version', 'mcp-session-id']
const FETCH_EXTRAS = ['accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent']
const headerNames = req => req.rawHeaders.filter((name, index) => index % 2 === 0).map(name => name.toLowerCase())
const mcpCall = { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'client-session' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }

test('the upstream sees the forwarded headers plus the four that fetch adds', async (t) => {
  const seen = []
  const upstream = createHttp((req, res) => { seen.push(req); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  assert.equal((await call(mcpCall)).status, 200)
  const names = headerNames(seen[0])
  assert.deepEqual(names.filter(name => !FORWARDED.includes(name)).sort(), FETCH_EXTRAS)
  assert.equal(seen[0].headers['accept-encoding'], 'identity', 'no compression, as before')
  assert.equal(seen[0].headers.authorization, 'Bearer private-token')
  assert.equal(seen[0].headers['mcp-session-id'], 'client-session')
})

test('a strict upstream that allows only a fixed header list rejects the call and the rejection reaches the client', async (t) => {
  let allowed = FORWARDED
  const upstream = createHttp((req, res) => {
    req.resume()
    const unexpected = headerNames(req).find(name => !allowed.includes(name))
    res.writeHead(unexpected === undefined ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(unexpected === undefined ? { ok: true } : { error: `unexpected header ${unexpected}` }))
  })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const { call, logs } = await inProcessGateway(t, `http://127.0.0.1:${port}/mcp`)
  const rejected = await call(mcpCall)
  assert.equal(rejected.status, 400)
  assert.match((await rejected.json()).error, /^unexpected header (accept-encoding|accept-language|sec-fetch-mode|user-agent)$/)
  assert.match(logs.join('\n'), /svc.*POST.*400/)
  allowed = [...FORWARDED, ...FETCH_EXTRAS]
  assert.equal((await call(mcpCall)).status, 200)
})

// The gateway in a child process, with the proxy policy installed from the environment as the
// launcher does, and an https upstream reachable only through that proxy.
const NOT_INHERITED = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs)$/i

async function startChild(t, { upstream, proxy, ca, undiciTimeoutMs, headers }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !NOT_INHERITED.test(name)))
  if (proxy !== undefined) env.HTTPS_PROXY = proxy
  if (ca !== undefined) env.NODE_EXTRA_CA_CERTS = ca
  env.GATEWAY_EGRESS = JSON.stringify({ upstream, undiciTimeoutMs, headers })
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(here, 'harness-resolve.mjs')).href, join(here, 'fixtures/gateway-egress.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = once(child, 'exit')
  t.after(async () => {
    child.stdin.end()
    await within(exited, 3000, 'the gateway process exits').catch(() => child.kill())
  })
  const first = await within(new Promise((resolve, reject) => {
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]) })
    child.on('exit', code => reject(new Error(`the gateway process exited with ${code}: ${stderr}`)))
  }), 10_000, 'the gateway process starts')
  const { url, headers: auth } = JSON.parse(first)
  return { stderr: () => stderr, call: (init = {}) => fetch(url, { ...init, headers: { ...auth, ...init.headers } }) }
}

// An https upstream for upstream.example, and a proxy that tunnels every CONNECT to it.
async function tunnel(t, handler) {
  const { cert, key } = selfSigned('upstream.example')
  const dir = mkdtempSync(join(tmpdir(), 'dsb-gateway-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ca = join(dir, 'ca.pem')
  writeFileSync(ca, cert)
  const upstream = createHttps({ cert, key }, handler)
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

// undici ends a request that sends no response head, or no body bytes, for 300 s. The child stands
// in for that with a 300 ms limit on the process-wide dispatcher.
test('an upstream that stays silent past the dispatcher limit ends the call and is closed', async (t) => {
  const closed = deferred()
  const upstream = createHttp((req, res) => { res.on('close', closed.resolve); req.resume() })
  const port = await listen(upstream)
  t.after(stop(upstream))
  const gateway = await startChild(t, { upstream: `http://127.0.0.1:${port}/mcp`, undiciTimeoutMs: 300 })
  const response = await gateway.call({ ...mcpCall, signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'connector upstream failed' })
  await within(closed.promise, 2000, 'the upstream request is closed')
})

test('an upstream stream that goes silent past the dispatcher limit ends the stream and is closed', async (t) => {
  const stream = heldStream()
  const upstream = createHttp(stream.handler)
  const port = await listen(upstream)
  t.after(stop(upstream))
  const gateway = await startChild(t, { upstream: `http://127.0.0.1:${port}/mcp`, undiciTimeoutMs: 300 })
  const response = await gateway.call({ headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(5000) })
  const reader = response.body.getReader()
  assert.match(decode((await reader.read()).value), /data: one/)
  await assert.rejects(within(reader.read(), 3000, 'the stream ends'), error => !/timed out/.test(error.message))
  await within(stream.closed.promise, 2000, 'the upstream stream is closed')
})
