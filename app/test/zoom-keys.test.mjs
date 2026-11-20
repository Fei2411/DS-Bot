import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zoomKey, zoomLevel } from '../src/zoom-keys.mjs'

const input = { type: 'keyDown', control: true, key: '=' }

test('Windows and Linux recognize the page zoom keys', () => {
  for (const platform of ['win32', 'linux']) {
    for (const [key, shift, action] of [['0', false, 'reset'], ['=', false, 'in'], ['+', false, 'in'], ['+', true, 'in'], ['=', true, 'in'], ['-', false, 'out']]) {
      assert.equal(zoomKey({ ...input, key, shift }, platform), action)
    }
    assert.equal(zoomKey({ ...input, key: 'Add', code: 'NumpadAdd' }, platform), 'in')
    assert.equal(zoomKey({ ...input, key: 'Subtract', code: 'NumpadSubtract' }, platform), 'out')
  }
})

test('other keys, modifiers, releases and composition are left alone', () => {
  for (const change of [{ key: 'a' }, { key: '' }, { control: false }, { alt: true }, { meta: true }, { type: 'keyUp' }, { isComposing: true }, { key: '0', shift: true }, { key: '_', shift: true }, { key: '-', shift: true }]) {
    assert.equal(zoomKey({ ...input, ...change }, 'win32'), null)
  }
  assert.equal(zoomKey(undefined, 'linux'), null)
  assert.equal(zoomKey({}, 'linux'), null)
  for (const key of ['0', '=', '+', '-']) assert.equal(zoomKey({ ...input, key }, 'darwin'), null)
})

test('AZERTY resets with physical zero and Shift-produced zero without accepting extra modifiers', () => {
  for (const platform of ['win32', 'linux']) {
    for (const zero of [{ key: 'à', code: 'Digit0', shift: false }, { key: '0', code: 'Digit0', shift: true }]) {
      assert.equal(zoomKey({ ...input, ...zero }, platform), 'reset')
      for (const guard of [{ control: false }, { alt: true }, { meta: true }, { isComposing: true }, { type: 'keyUp' }]) {
        assert.equal(zoomKey({ ...input, ...zero, ...guard }, platform), null)
      }
      assert.equal(zoomKey({ ...input, ...zero }, 'darwin'), null)
    }
    assert.equal(zoomKey({ ...input, key: ')', code: 'Digit0', shift: true }, platform), null)
  }
})

test('zoom uses half-level steps, resets to 100% and stops at Chromium limits', () => {
  assert.equal(zoomLevel(0, 'in'), 0.5)
  assert.equal(zoomLevel(0, 'out'), -0.5)
  assert.equal(zoomLevel(2, 'reset'), 0)
  assert.equal(zoomLevel(-2, 'reset'), 0)
  const min = Math.log(0.25) / Math.log(1.2)
  const max = Math.log(5) / Math.log(1.2)
  assert.equal(zoomLevel(max - 0.1, 'in'), max)
  assert.equal(zoomLevel(max, 'in'), max)
  assert.equal(zoomLevel(min + 0.1, 'out'), min)
  assert.equal(zoomLevel(min, 'out'), min)
})
