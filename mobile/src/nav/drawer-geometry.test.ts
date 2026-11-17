import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampedDrag, panelOffset, snapOnFlick } from './drawer-geometry.ts'

const WIDTH = 300
const CLOSED_LTR = -WIDTH
const CLOSED_RTL = WIDTH

test('panelOffset rests the closed panel offscreen on its own side and opens at zero', () => {
  assert.equal(panelOffset(0, WIDTH, false), CLOSED_LTR)
  assert.equal(panelOffset(1, WIDTH, false), 0)
  assert.equal(panelOffset(0, WIDTH, true), CLOSED_RTL)
  assert.equal(panelOffset(1, WIDTH, true), 0)
})

test('clampedDrag follows the edge pan toward opening and clamps on both ends', () => {
  // LTR: the finger drags right out of the closed panel.
  assert.equal(clampedDrag(120, WIDTH, 0, false), -180)
  assert.equal(clampedDrag(-80, WIDTH, 0, false), CLOSED_LTR)
  assert.equal(clampedDrag(WIDTH + 80, WIDTH, 0, false), 0)
  // RTL mirrors the finger: dragging left opens the right-anchored panel.
  assert.equal(clampedDrag(-120, WIDTH, 0, true), 180)
  assert.equal(clampedDrag(80, WIDTH, 0, true), CLOSED_RTL)
  assert.equal(clampedDrag(-(WIDTH + 80), WIDTH, 0, true), 0)
})

test('clampedDrag follows the panel pan either way and clamps on both ends', () => {
  // LTR: the finger drags the open panel left to close it.
  assert.equal(clampedDrag(-120, WIDTH, 1, false), -120)
  assert.equal(clampedDrag(80, WIDTH, 1, false), 0)
  assert.equal(clampedDrag(-(WIDTH + 80), WIDTH, 1, false), CLOSED_LTR)
  // RTL: the finger drags the open panel right to close it.
  assert.equal(clampedDrag(120, WIDTH, 1, true), 120)
  assert.equal(clampedDrag(-80, WIDTH, 1, true), 0)
  assert.equal(clampedDrag(WIDTH + 80, WIDTH, 1, true), CLOSED_RTL)
})

test('snapOnFlick settles on the crossed half when the flick is weak', () => {
  assert.equal(snapOnFlick(0, -100, WIDTH, false, 0), 0)
  assert.equal(snapOnFlick(0, -200, WIDTH, false, 0), CLOSED_LTR)
  assert.equal(snapOnFlick(0, -100, WIDTH, false, 1), 0)
  assert.equal(snapOnFlick(0, -200, WIDTH, false, 1), CLOSED_LTR)
  assert.equal(snapOnFlick(0, 100, WIDTH, true, 0), 0)
  assert.equal(snapOnFlick(0, 200, WIDTH, true, 0), CLOSED_RTL)
  assert.equal(snapOnFlick(0, 100, WIDTH, true, 1), 0)
  assert.equal(snapOnFlick(0, 200, WIDTH, true, 1), CLOSED_RTL)
})

test('snapOnFlick honors a decisive flick in the gesture direction on both sides', () => {
  // Edge pan: a flick toward opening wins even from the closed half.
  assert.equal(snapOnFlick(400, -200, WIDTH, false, 0), 0)
  assert.equal(snapOnFlick(-400, 200, WIDTH, true, 0), 0)
  // A counter-flick cannot close a panel already past the halfway point.
  assert.equal(snapOnFlick(-400, -100, WIDTH, false, 0), 0)
  assert.equal(snapOnFlick(400, 100, WIDTH, true, 0), 0)
  // Panel pan: a flick toward closing wins even from the open half.
  assert.equal(snapOnFlick(-400, -100, WIDTH, false, 1), CLOSED_LTR)
  assert.equal(snapOnFlick(400, 100, WIDTH, true, 1), CLOSED_RTL)
  // A counter-flick cannot reopen a panel already past the halfway point.
  assert.equal(snapOnFlick(400, -200, WIDTH, false, 1), CLOSED_LTR)
  assert.equal(snapOnFlick(-400, 200, WIDTH, true, 1), CLOSED_RTL)
})

test('snapOnFlick keeps the exact thresholds on the boundary', () => {
  assert.equal(snapOnFlick(350, -200, WIDTH, false, 0), CLOSED_LTR)
  assert.equal(snapOnFlick(-350, -100, WIDTH, false, 1), 0)
  assert.equal(snapOnFlick(0, -WIDTH / 2, WIDTH, false, 0), CLOSED_LTR)
  assert.equal(snapOnFlick(0, -WIDTH / 2, WIDTH, false, 1), 0)
})
