import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readsRightToLeft } from './direction-core.ts'

test('an Arabic tablet reads right to left even when the platform says otherwise', () => {
  assert.equal(readsRightToLeft('ar-EG'), true)
  assert.equal(readsRightToLeft('ar_SA'), true)
  assert.equal(readsRightToLeft('he-IL'), true)
  assert.equal(readsRightToLeft('fa-IR'), true)
  assert.equal(readsRightToLeft('ur-PK'), true)
})

test('left-to-right locales and empty values keep the panel on the left', () => {
  assert.equal(readsRightToLeft('en-US'), false)
  assert.equal(readsRightToLeft('zh-Hans-CN'), false)
  assert.equal(readsRightToLeft('de'), false)
  assert.equal(readsRightToLeft(''), false)
  // A tag that merely starts with the letters of a language is not that language.
  assert.equal(readsRightToLeft('artist'), false)
})
