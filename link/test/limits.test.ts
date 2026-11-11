import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { WebSocket as WsClient } from 'ws'
import { PROTOCOL_VERSION, createControlFrame, deviceIdFor, generateKeyPair, randomToken } from '../src/index.ts'
import { startRelayServer, type RelayServerOptions } from '../server/server.ts'
import { DeviceStore } from '../server/store.ts'

async function relay(options: RelayServerOptions) {
  const server = await startRelayServer(options)
  after(() => server.close())
  return server
}

function device() {
  const keys = generateKeyPair()
  return { deviceId: deviceIdFor(keys.publicKey), publicKey: keys.publicKey, token: randomToken() }
}

async function open(url: string, headers: Record<string, string> = {}): Promise<WsClient | number> {
  const ws = new WsClient(url, { headers })
  return new Promise(resolve => {
    ws.once('open', () => { after(() => ws.close()); resolve(ws) })
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
  })
}

async function hello(url: string, self = device(), headers: Record<string, string> = {}): Promise<string> {
  const ws = await open(url, headers)
  if (typeof ws === 'number') return String(ws)
  ws.send(JSON.stringify(createControlFrame('hello', {
    role: 'client',
    deviceId: self.deviceId,
    identityKey: self.publicKey,
    accessToken: self.token,
    protocols: [PROTOCOL_VERSION],
    capabilities: ['transport.relay'],
  })))
  const reply = JSON.parse(String(await new Promise(resolve => ws.once('message', resolve)))) as { type: string; payload: { code?: string } }
  ws.close()
  return reply.type === 'error' ? reply.payload.code ?? 'error' : reply.type
}

test('one address may hold only so many sockets, and gets a slot back when one closes', async () => {
  const server = await relay({ maxSocketsPerAddress: 2 })
  const first = await open(server.url)
  const second = await open(server.url)
  assert.equal(await open(server.url), 429)
  assert.ok(first instanceof WsClient && second instanceof WsClient)
  await new Promise(resolve => { first.once('close', resolve); first.close() })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok((await open(server.url)) instanceof WsClient)
})

test('one address may register only so many new devices an hour, but known devices still come back', async () => {
  const server = await relay({ maxNewDevicesPerHour: 2 })
  const known = device()
  assert.equal(await hello(server.url, known), 'hello.ack')
  assert.equal(await hello(server.url), 'hello.ack')
  assert.equal(await hello(server.url), 'RATE_LIMITED')
  assert.equal(await hello(server.url, known), 'hello.ack')
})

test('behind a trusted proxy, limits apply to the forwarded address only', async () => {
  const server = await relay({ maxNewDevicesPerHour: 1, trustProxy: true })
  assert.equal(await hello(server.url, device(), { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' }), 'hello.ack')
  assert.equal(await hello(server.url, device(), { 'x-forwarded-for': '198.51.100.1' }), 'RATE_LIMITED')
  assert.equal(await hello(server.url, device(), { 'x-forwarded-for': '198.51.100.2' }), 'hello.ack')
})

test('the forwarded header is ignored unless the proxy is trusted', async () => {
  const server = await relay({ maxNewDevicesPerHour: 1 })
  assert.equal(await hello(server.url, device(), { 'x-forwarded-for': '198.51.100.3' }), 'hello.ack')
  assert.equal(await hello(server.url, device(), { 'x-forwarded-for': '198.51.100.4' }), 'RATE_LIMITED')
})

test('devices not seen for a long time are forgotten, and the file keeps the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-store-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'devices.json')
  const now = Date.now()
  const record = (lastSeen: number) => ({ role: 'client', identityKey: 'k', tokenHash: 'h', firstSeen: lastSeen, lastSeen })
  writeFileSync(file, JSON.stringify({ old: record(now - 200 * 86_400_000), recent: record(now - 86_400_000) }))
  const store = new DeviceStore(file)
  assert.equal(store.prune(180 * 86_400_000, now), 1)
  store.flush()
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['recent'])
})
