import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserPairingUrl } from '../src/client/phone-browser.js'

test('browser pairing uses the relay origin and preserves its path prefix', () => {
  const uri = 'dsbot://pair?code=one-time&name=My%20computer'
  for (const [server, base] of [
    ['wss://relay.dsbot.app/v1/link', 'https://relay.dsbot.app/web/'],
    ['ws://127.0.0.1:8787/v1/link', 'http://127.0.0.1:8787/web/'],
    ['wss://relay.test/prefix/nested/v1/link', 'https://relay.test/prefix/nested/web/'],
    ['wss://relay.test/prefix/v1/link/', 'https://relay.test/prefix/web/'],
    ['wss://relay.test', 'https://relay.test/web/'],
  ]) {
    const actual = browserPairingUrl(server, uri)
    assert.equal(actual, `${base}#pair=${encodeURIComponent(uri)}`)
    const url = new URL(actual)
    assert.equal(url.search, '')
    assert.equal(decodeURIComponent(url.hash.slice('#pair='.length)), uri)
    assert.equal(actual.split('#')[0].includes('code='), false)
  }
})

test('browser pairing permits an empty fragment value but rejects invalid server URLs', () => {
  assert.equal(browserPairingUrl('wss://relay.test/v1/link', ''), 'https://relay.test/web/#pair=')
  assert.throws(() => browserPairingUrl('', 'dsbot://pair'))
  assert.throws(() => browserPairingUrl('https://relay.test/v1/link', 'dsbot://pair'), /ws:\/\//)
})
