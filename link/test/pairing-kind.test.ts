import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceRegistry, type PairedDevice } from '../src/pairing.ts'

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
