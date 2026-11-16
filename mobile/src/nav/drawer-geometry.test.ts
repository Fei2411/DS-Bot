import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampProgress, drawerWidth, panelOffset, progressAfterDrag, settleProgress, shouldConsumeBack } from './drawer-geometry.ts'

test('drawerWidth follows the window up to the cap and never collapses', () => {
  assert.equal(drawerWidth(390), 331.5)
  assert.equal(drawerWidth(1194), 340)
  assert.equal(drawerWidth(0), 1)
  assert.equal(drawerWidth(Number.NaN), 1)
})

test('a closed drawer stays off screen on both edges and at every width', () => {
  for (const windowWidth of [360, 390, 400, 834, 1194, 1366]) {
    const width = drawerWidth(windowWidth)
    assert.equal(panelOffset(0, width, false), -width)
    assert.equal(panelOffset(0, width, true), width)
  }
  assert.equal(panelOffset(1, 340, false), 0)
  assert.equal(panelOffset(1, 340, true), 0)
})

test('the back button is consumed only while the drawer is on screen', () => {
  assert.equal(shouldConsumeBack(0), false)
  assert.equal(shouldConsumeBack(0.01), true)
  assert.equal(shouldConsumeBack(1), true)
  assert.equal(shouldConsumeBack(Number.NaN), false)
})

test('a drag moves the drawer from where it started and clamps at both ends', () => {
  // LTR: the panel is on the left; rightwards opens, leftwards closes.
  assert.equal(progressAfterDrag(0, 170, 340, false), 0.5)
  assert.equal(progressAfterDrag(1, -340, 340, false), 0)
  assert.equal(progressAfterDrag(0, -50, 340, false), 0)
  assert.equal(progressAfterDrag(1, 80, 340, false), 1)
  // RTL: the panel is on the right; leftwards opens, rightwards closes.
  assert.equal(progressAfterDrag(0, -170, 340, true), 0.5)
  assert.equal(progressAfterDrag(1, 340, 340, true), 0)
  assert.equal(progressAfterDrag(0, 50, 340, true), 0)
  assert.equal(progressAfterDrag(1, -80, 340, true), 1)
  assert.equal(progressAfterDrag(0.5, 0, 0, false), 0.5)
})

test('a flick wins over distance; otherwise the nearer end wins', () => {
  assert.equal(settleProgress(0.4, 0, false), 0)
  assert.equal(settleProgress(0.6, 0, false), 1)
  assert.equal(settleProgress(0.2, 400, false), 1)
  assert.equal(settleProgress(0.8, -400, false), 0)
  assert.equal(settleProgress(0.2, -400, true), 1)
  assert.equal(settleProgress(0.8, 400, true), 0)
  assert.equal(settleProgress(Number.NaN, 0, false), 0)
})

test('progress is clamped to the closed and open ends', () => {
  assert.equal(clampProgress(-1), 0)
  assert.equal(clampProgress(2), 1)
})
