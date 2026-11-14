import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceRegistry, HostLink, RelayTransport, SecureTransport, RpcClient, generateKeyPair, deviceIdFor, randomToken } from '../src/index.ts'
import { startRelayServer } from '../server/server.ts'

const identity = () => { const keys = generateKeyPair(); return { ...keys, deviceId: deviceIdFor(keys.publicKey) } }

test('two phones share the Host send budget while reading file-sized replies', async t => {
  const server = await startRelayServer()
  t.after(() => server.close())
  const self = identity()
  const registry = new DeviceRegistry()
  const payload = 'x'.repeat(700_000)
  const host = new HostLink({ url: server.url, identity: self, accessToken: randomToken(),
    admits: (id, key) => registry.admits(id, key),
    authorize: (id, key, hello) => registry.authorize(id, key, hello),
    handle: async () => payload,
  })
  host.start()
  t.after(() => host.stop())
  await host.waitOnline()
  const clients = []
  for (let i = 0; i < 2; i++) {
    const phone = identity()
    const code = registry.openPairing().code
    const relay = new RelayTransport(server.url, { deviceId: phone.deviceId, identityKey: phone.publicKey, accessToken: randomToken(), targetDeviceId: self.deviceId })
    const client = new RpcClient(new SecureTransport(relay, phone, { deviceId: self.deviceId, identityKey: self.publicKey }, { hello: { pairingCode: code } }))
    clients.push(client)
    t.after(() => client.close())
    await client.connect()
  }
  const started = Date.now()
  await Promise.all(clients.map(async client => {
    for (let i = 0; i < 12; i++) assert.equal(await client.rpc('file', { offset: i }), payload)
  }))
  assert.ok(Date.now() - started >= 1000)
  for (const client of clients) assert.equal(await client.rpc('still-connected', {}), payload)
})
