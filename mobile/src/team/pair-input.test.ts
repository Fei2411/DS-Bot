import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceIdFor, generateKeyPair, pairingUri } from '../../../link/src/index.ts'
import { parsePairingInput } from './pair-input.ts'

const keys = generateKeyPair()
const offer = { server: 'wss://relay.test/prefix/v1/link', hostKey: keys.publicKey, hostDeviceId: deviceIdFor(keys.publicKey), code: 'one-time', name: '电脑 + 100% & team' }
const uri = pairingUri(offer)

test('pair input accepts raw pairing URIs and copied browser links without changing the offer', () => {
  for (const input of [uri, `https://relay.test/prefix/web/#pair=${encodeURIComponent(uri)}`, `http://localhost:8787/web/#pair=${encodeURIComponent(uri)}`]) {
    assert.deepEqual(parsePairingInput(`  ${input}\n`), offer)
  }
})

test('pair input refuses empty, malformed and non-pairing browser links', () => {
  for (const input of ['', 'not a URL', 'https://relay.test/web/', 'https://relay.test/web/#pair=', 'https://relay.test/web/#pair=%ZZ', `https://relay.test/web/?pair=${encodeURIComponent(uri)}`, `javascript:ignored#pair=${encodeURIComponent(uri)}`, `https://relay.test/web/#pair=${encodeURIComponent('https://other.test')}`]) {
    assert.throws(() => parsePairingInput(input), Error, input)
  }
})

test('browser pairing links still undergo the existing pairing validation', () => {
  const changed = new URL(uri)
  changed.searchParams.set('host', 'different-computer')
  assert.throws(() => parsePairingInput(`https://relay.test/web/#pair=${encodeURIComponent(changed.href)}`), /does not match/)
})
