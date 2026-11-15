import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REST_MS, installMotionRest } from '../src/client/motion-rest.js'

// #1462: a working Bot's mark and its shimmering status loop forever, and each loop keeps
// the window drawing every frame, so a window nobody looks at kept a core busy.

class FakeAnimation {
  constructor(target, iterations = Infinity) {
    this.effect = { target, getTiming: () => ({ iterations }) }
    this.playState = 'running'
  }

  pause() { this.playState = 'paused' }

  play() { this.playState = 'running' }
}

function page() {
  const listeners = { win: new Map(), doc: new Map() }
  const on = map => (type, listener) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(listener) }
  const off = map => (type, listener) => { map.get(type)?.delete(listener) }
  const fire = (map, type) => { for (const listener of map.get(type) ?? []) listener({ type }) }
  const animations = []
  const observers = []
  class Observer {
    constructor(callback) { this.callback = callback; this.elements = new Set(); observers.push(this) }

    observe(element) { this.elements.add(element) }

    unobserve(element) { this.elements.delete(element) }

    disconnect() { this.elements.clear() }
  }
  let clock = 0
  let serial = 0
  const timers = new Map()
  const doc = { hidden: false, getAnimations: () => [...animations], addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc) }
  const win = {
    IntersectionObserver: Observer,
    setTimeout: (callback, ms) => { serial += 1; timers.set(serial, { callback, at: clock + ms }); return serial },
    clearTimeout: id => { timers.delete(id) },
    addEventListener: on(listeners.win),
    removeEventListener: off(listeners.win),
  }
  const advance = (ms) => {
    const end = clock + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      clock = due[1].at
      due[1].callback()
    }
    clock = end
  }
  const see = (element, visible) => { for (const observer of observers) if (observer.elements.has(element)) observer.callback([{ target: element, isIntersecting: visible }]) }
  const observed = element => observers.some(observer => observer.elements.has(element))
  const count = () => [...listeners.win.values(), ...listeners.doc.values()].reduce((sum, set) => sum + set.size, 0)
  return {
    doc, win, animations, advance, see, observed, count,
    now: () => clock,
    touch: (type = 'pointermove') => fire(listeners.win, type),
    changed: (type = 'animationstart') => fire(listeners.doc, type),
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const states = list => list.map(animation => animation.playState)

test('loops hold still once nobody has touched the window for a while and move on the next touch', () => {
  const p = page()
  const body = new FakeAnimation({})
  const shimmer = new FakeAnimation({})
  const rise = new FakeAnimation({}, 1)
  p.animations.push(body, shimmer, rise)
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  p.advance(REST_MS - 1)
  assert.deepEqual(states([body, shimmer, rise]), ['running', 'running', 'running'])
  p.advance(1)
  // A finite animation plays out; only the loops wait.
  assert.deepEqual(states([body, shimmer, rise]), ['paused', 'paused', 'running'])
  p.touch()
  assert.deepEqual(states([body, shimmer]), ['running', 'running'])
  // Each touch starts the wait again.
  p.advance(REST_MS / 2)
  p.touch('keydown')
  p.advance(REST_MS / 2)
  assert.equal(body.playState, 'running')
  p.advance(REST_MS / 2)
  assert.equal(body.playState, 'paused')
  p.touch('focus')
  assert.equal(body.playState, 'running')
})

test('a loop out of view holds still until it comes back into view', () => {
  const p = page()
  const row = {}
  const header = {}
  const body = new FakeAnimation(row)
  const eyes = new FakeAnimation(row)
  const pill = new FakeAnimation(header)
  p.animations.push(body, eyes, pill)
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  p.see(row, false)
  p.see(header, true)
  assert.deepEqual(states([body, eyes, pill]), ['paused', 'paused', 'running'])
  p.see(row, true)
  assert.deepEqual(states([body, eyes, pill]), ['running', 'running', 'running'])
  // Back in view while the window rests, it still waits for a touch.
  p.see(row, false)
  p.advance(REST_MS)
  p.see(row, true)
  assert.deepEqual(states([body, eyes, pill]), ['paused', 'paused', 'paused'])
  p.touch()
  assert.deepEqual(states([body, eyes, pill]), ['running', 'running', 'running'])
})

test('a loop on a part of an SVG drawing goes by whether the drawing is in view', () => {
  const p = page()
  const svg = { ownerSVGElement: null }
  const eyes = { ownerSVGElement: { ownerSVGElement: svg } }
  const squint = new FakeAnimation(eyes)
  p.animations.push(squint)
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  assert.equal(p.observed(eyes), false)
  assert.equal(p.observed(svg), true)
  p.see(svg, false)
  assert.equal(squint.playState, 'paused')
  p.see(svg, true)
  assert.equal(squint.playState, 'running')
})

test('a loop that starts while the window rests holds still at once, and an ended one is let go', async () => {
  const p = page()
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  p.advance(REST_MS)
  const mark = {}
  const thinking = new FakeAnimation(mark)
  p.animations.push(thinking)
  p.changed('animationstart')
  await settle()
  assert.equal(thinking.playState, 'paused')
  assert.equal(p.observed(mark), true)
  p.touch()
  assert.equal(thinking.playState, 'running')
  // The Bot stops working: its loop is gone, and so is the watch on its mark.
  p.animations.splice(0)
  p.changed('animationcancel')
  await settle()
  assert.equal(p.observed(mark), false)
})

test('a loop started from script is found when the window rests', () => {
  const p = page()
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  // element.animate() sends no animation event.
  const scripted = new FakeAnimation({})
  p.animations.push(scripted)
  p.advance(REST_MS)
  assert.equal(scripted.playState, 'paused')
  p.touch()
  assert.equal(scripted.playState, 'running')
})

test('a held loop that becomes finite plays out', async () => {
  const p = page()
  const alert = new FakeAnimation({})
  p.animations.push(alert)
  const undo = installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  p.advance(REST_MS)
  assert.equal(alert.playState, 'paused')
  // Turning effects down makes the same animation run once instead of forever.
  alert.effect.getTiming = () => ({ iterations: 1 })
  p.changed('animationstart')
  await settle()
  assert.equal(alert.playState, 'running')
  undo()
  assert.equal(alert.playState, 'running')
})

test('a hidden page rests at once and moves again when it shows', () => {
  const p = page()
  const loop = new FakeAnimation({})
  p.animations.push(loop)
  installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  p.doc.hidden = true
  p.changed('visibilitychange')
  assert.equal(loop.playState, 'paused')
  // Input that arrives while hidden does not wake it.
  p.touch()
  assert.equal(loop.playState, 'paused')
  p.doc.hidden = false
  p.changed('visibilitychange')
  assert.equal(loop.playState, 'running')
})

test('a loop its own code paused stays paused, and undoing plays only what was held', () => {
  const p = page()
  const own = new FakeAnimation({})
  own.pause()
  const held = new FakeAnimation({})
  p.animations.push(own, held)
  const before = p.count()
  const undo = installMotionRest({ doc: p.doc, win: p.win, now: p.now })
  assert.ok(p.count() > before)
  p.advance(REST_MS)
  p.touch()
  assert.deepEqual(states([own, held]), ['paused', 'running'])
  p.advance(REST_MS)
  assert.deepEqual(states([own, held]), ['paused', 'paused'])
  undo()
  assert.deepEqual(states([own, held]), ['paused', 'running'])
  assert.equal(p.count(), before)
  // Nothing is left that could pause a loop later.
  p.advance(REST_MS * 2)
  assert.equal(held.playState, 'running')
})

test('a page without the Web Animations API is left alone', () => {
  const undo = installMotionRest({ doc: {}, win: {} })
  assert.equal(typeof undo, 'function')
  undo()
})
