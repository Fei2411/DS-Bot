import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceRegistry, type PairedDevice } from '../src/pairing.ts'
import { pairingUri, parsePairingUri } from '../src/pairing.ts'
import { generateKeyPair, deviceIdFor } from '../src/keys.ts'

test('browser pairing markers round trip while legacy phone offers remain unmarked', () => {
  const keys = generateKeyPair()
  const offer = { server: 'wss://relay.test/v1/link', hostDeviceId: deviceIdFor(keys.publicKey), hostKey: keys.publicKey, code: 'code', name: 'Computer' }
  assert.deepEqual(parsePairingUri(pairingUri(offer)), offer)
  assert.deepEqual(parsePairingUri(pairingUri({ ...offer, device: 'browser' })), { ...offer, device: 'browser' })
  assert.throws(() => parsePairingUri(pairingUri(offer) + '&device=unknown'))
  const registry = new DeviceRegistry()
  const { code } = registry.openPairing()
  const markedPhone = parsePairingUri(pairingUri({ ...offer, code, device: 'browser' }))
  assert.equal(registry.authorize('device', 'key', { pairingCode: markedPhone.code }), true)
  assert.equal(registry.list()[0].kind, 'phone')
})

test('pairing codes assign device kind, not the self-reported device name', () => {
  for (const kind of ['phone', 'browser'] as const) {
    let saved: PairedDevice[] = []
    const registry = new DeviceRegistry([], devices => { saved = devices })
    const { code, browserCode } = registry.openPairing()
    assert.notEqual(code, browserCode)
    assert.equal(registry.authorize('device', 'key', { pairingCode: kind === 'phone' ? code : browserCode, name: kind === 'phone' ? 'Web browser' : 'iPhone' }), true)
    assert.equal(registry.list()[0].kind, kind)
    assert.equal(new DeviceRegistry(saved).list()[0].kind, kind)
    assert.equal(registry.authorize('other', 'other-key', { pairingCode: code }), false)
    assert.equal(registry.authorize('other', 'other-key', { pairingCode: browserCode }), false)
    assert.equal(registry.authorize('device', 'key', { name: 'changed' }), true)
    assert.equal(registry.list()[0].kind, kind)
  }
})

test('legacy devices are phones; invalid and expired codes cannot set a kind', () => {
  let now = 0
  const registry = new DeviceRegistry([{ deviceId: 'legacy', identityKey: 'key', name: '', pairedAt: 0 }], undefined, () => now)
  assert.equal(registry.list()[0].kind, 'phone')
  const { browserCode } = registry.openPairing(10)
  assert.equal(registry.authorize('new', 'key', { pairingCode: 'bad' }), false)
  now = 10
  assert.equal(registry.authorize('new', 'key', { pairingCode: browserCode }), false)
  assert.equal(registry.list().length, 1)
})

test('a paired device closes a new offer when it scans the new code', () => {
  const registry = new DeviceRegistry([{ deviceId: 'iphone', identityKey: 'key', name: 'iPhone', pairedAt: 1, kind: 'browser' }])
  const [device] = registry.list()
  const { code, browserCode } = registry.openPairing()
  assert.equal(registry.authorize('iphone', 'key', {}), true)
  assert.equal(registry.authorize('iphone', 'key', { pairingCode: 'old-code' }), true)
  assert.equal(registry.pairingOpen(), true)
  assert.equal(registry.authorize('iphone', 'key', { pairingCode: browserCode }), true)
  assert.equal(registry.pairingOpen(), false)
  assert.equal(registry.authorize('new', 'other-key', { pairingCode: code }), false)
  assert.deepEqual(registry.list(), [device])
})
