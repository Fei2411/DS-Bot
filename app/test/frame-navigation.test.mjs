import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subframeNavigationAllowed } from '../src/frame-navigation.mjs'

test('subframes may stay inert or inside the app origin, never navigate away', () => {
  assert.equal(subframeNavigationAllowed('about:srcdoc', 'http://127.0.0.1:4321'), true)
  assert.equal(subframeNavigationAllowed('about:blank', 'http://127.0.0.1:4321'), true)
  assert.equal(subframeNavigationAllowed('http://127.0.0.1:4321/settings', 'http://127.0.0.1:4321'), true)
  assert.equal(subframeNavigationAllowed('https://example.test/', 'http://127.0.0.1:4321'), false)
  assert.equal(subframeNavigationAllowed('file:///etc/passwd', 'http://127.0.0.1:4321'), false)
  assert.equal(subframeNavigationAllowed('http://127.0.0.1:4321.evil.test/', 'http://127.0.0.1:4321'), false)
})
