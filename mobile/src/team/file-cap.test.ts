import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '../ui/i18n.ts'
import { fileCapMessage, fileOverCap, fileRouteOf } from './file-cap.ts'

// The save gate reads hello.maxFileBytes (#1443): a file the host reads whole must fit
// one api/bot answer, and the refusal names the limit the way the host's own does.
setLang('en')

test('a file over hello.maxFileBytes refuses, and one at or under it saves', () => {
  assert.equal(fileOverCap(12 * 1024 * 1024, 12 * 1024 * 1024 + 1), true)
  assert.equal(fileOverCap(12 * 1024 * 1024, 12 * 1024 * 1024), false)
  assert.equal(fileOverCap(12 * 1024 * 1024, 1024), false)
})

test('the gate stays open when the phone or the card names no size', () => {
  assert.equal(fileOverCap(undefined, 9999), false)
  assert.equal(fileOverCap(12 * 1024 * 1024, undefined), false)
  assert.equal(fileOverCap(undefined, undefined), false)
})

test('the refusal names the limit in whole megabytes', () => {
  assert.equal(fileCapMessage(12 * 1024 * 1024), 'This file is too large to save here (over 12 MB)')
  assert.equal(fileCapMessage(5 * 1024 * 1024 + 1024), 'This file is too large to save here (over 5 MB)')
  // A sub-megabyte limit still reads as at least one MB.
  assert.equal(fileCapMessage(1024), 'This file is too large to save here (over 1 MB)')
})

test('a web-linked file saves from the web, a host file over the chat endpoints', () => {
  assert.equal(fileRouteOf({ url: 'https://example.com/report.pdf' }), 'url')
  assert.equal(fileRouteOf({ url: '' }), 'host')
  assert.equal(fileRouteOf({}), 'host')
})
