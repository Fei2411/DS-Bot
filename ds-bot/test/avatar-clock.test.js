// The live layer's shared clock (src/client/avatar/live.js) in a page: when it asks
// for frames, when it builds a character's model, how it rests and dozes, what it
// skips, and that the last mark going leaves no listener behind. The module runs in
// its own context per test with a JSDOM page, hand-run frames and timers on a clock
// the test moves, and a 2D canvas that only counts what is drawn.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')

const bundle = (await build({
  stdin: {
    contents: "export * from './src/client/avatar/live.js'; export { SHAPES } from './src/client/characters.js'; export { models, rigReady, rigSteps } from './src/client/avatar/rig.js'",
    resolveDir: PLUGIN,
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
})).outputFiles[0].text

function page({ motion = 'normal', effects = 'full', busy = false, stepClockMs = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const { document } = dom.window
  let hidden = false
  Object.defineProperty(document, 'hidden', { get: () => hidden })
  document.body.dataset.btMotion = motion
  document.body.dataset.btEffects = effects

  // Time: either real time plus what the test skips, or (when stepClockMs > 0) a
  // deterministic synthetic clock that advances per clock read inside timer slices so
  // live.js's timeRemaining() > 2 budget and rigSteps's STEP_MS yields are tested
  // without OS scheduler or timer-quantum noise.
  let skipped = 0
  let synthetic = 0
  let inTimer = false
  const clock = () => {
    if (stepClockMs > 0) {
      if (inTimer) synthetic += stepClockMs
      return synthetic
    }
    return performance.now() + skipped
  }
  const timers = new Map()
  let nextTimer = 1
  const setTimer = every => (fn, ms = 0) => { const id = nextTimer++; timers.set(id, { fn, at: clock() + ms, every: every ? ms : 0 }); return id }
  let longestSliceMs = 0
  let maxStepsPerSlice = 0
  let totalSliceSteps = 0
  let sliceSteps = 0
  let timerRuns = 0
  const runTimers = () => {
    for (let guard = 0; guard < 10_000; guard += 1) {
      let due = null
      for (const [id, timer] of timers) if (timer.at <= clock() && (!due || timer.at < due[1].at)) due = [id, timer]
      if (!due) return
      const [id, timer] = due
      if (timer.every) timer.at += timer.every
      else timers.delete(id)
      const sliceStart = synthetic
      sliceSteps = 0
      inTimer = true
      try {
        timer.fn()
      } finally {
        inTimer = false
      }
      if (!timer.every) {
        timerRuns += 1
        longestSliceMs = Math.max(longestSliceMs, synthetic - sliceStart)
        maxStepsPerSlice = Math.max(maxStepsPerSlice, sliceSteps)
        totalSliceSteps += sliceSteps
      }
    }
  }
  const idleAsks = []
  const rafs = new Map()
  let nextRaf = 1
  let frames = 0

  // Listeners, counted per target, and reduced-motion queries, a new object per call
  // as in a browser.
  const live = new Map()
  const track = (name, target) => {
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    target.addEventListener = (type, fn, options) => { live.set(`${name}:${type}`, (live.get(`${name}:${type}`) ?? 0) + 1); add(type, fn, options) }
    target.removeEventListener = (type, fn, options) => { live.set(`${name}:${type}`, (live.get(`${name}:${type}`) ?? 0) - 1); remove(type, fn, options) }
  }
  const win = {
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    dispatch(type, init = {}) { for (const fn of winListeners.get(type) ?? []) fn({ type, ...init }) },
    // A busy page: idle callbacks come only when their timeout runs out, with no
    // time left.
    ...(busy ? {
      requestIdleCallback: (fn, options) => {
        idleAsks.push(options)
        return setTimer(false)(() => fn({ didTimeout: true, timeRemaining: () => 0 }), options?.timeout ?? 1e9)
      },
      cancelIdleCallback: id => timers.delete(id),
    } : {}),
    matchMedia: () => {
      const query = { matches: false, addEventListener: (type) => { live.set(`media:${type}`, (live.get(`media:${type}`) ?? 0) + 1); query.added = true }, removeEventListener: (type) => { if (query.added) live.set(`media:${type}`, (live.get(`media:${type}`) ?? 0) - 1); query.added = false } }
      return query
    },
  }
  const winListeners = new Map()
  win.addEventListener = (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, new Set())
    winListeners.get(type).add(fn)
    live.set(`window:${type}`, (live.get(`window:${type}`) ?? 0) + 1)
  }
  win.removeEventListener = (type, fn) => {
    if (winListeners.get(type)?.delete(fn)) live.set(`window:${type}`, live.get(`window:${type}`) - 1)
  }
  track('document', document)
  track('root', document.documentElement)

  // A 2D canvas that counts frames drawn.
  let drawn = 0
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key]
      : key === 'clearRect' ? () => { drawn += 1 }
        : key === 'createLinearGradient' ? () => ({ addColorStop() {} })
          : () => {}),
    set: (target, key, value) => { target[key] = value; return true },
  })
  const createElement = document.createElement.bind(document)
  document.createElement = (tag, ...rest) => {
    const element = createElement(tag, ...rest)
    if (tag === 'canvas') element.getContext = () => ctx
    return element
  }

  const sights = []
  let observers = 0
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; sights.push(this) }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationObserver extends dom.window.MutationObserver {
    constructor(callback) { super(callback); observers += 1 }
    disconnect() { observers -= 1; super.disconnect() }
  }

  const context = createContext({
    window: win,
    document,
    performance: { now: clock },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (fn) => { const id = nextRaf++; rafs.set(id, fn); return id },
    cancelAnimationFrame: (id) => { rafs.delete(id) },
    setTimeout: setTimer(false),
    clearTimeout: id => timers.delete(id),
    setInterval: setTimer(true),
    clearInterval: id => timers.delete(id),
    IntersectionObserver,
    MutationObserver,
    module: { exports: {} },
    console,
  })
  runInContext(bundle, context)
  const api = context.module.exports
  if (stepClockMs > 0) {
    // Count top-level generator steps (rigJob -> steps.next()) per timer slice without
    // double-counting delegated yield* inner generators.
    const genProto = runInContext('Object.getPrototypeOf(function* () {}).prototype', context)
    const rawNext = genProto.next
    let genDepth = 0
    genProto.next = function next(...args) {
      if (inTimer && genDepth === 0) sliceSteps += 1
      genDepth += 1
      try { return rawNext.apply(this, args) } finally { genDepth -= 1 }
    }
  }

  const mount = (shape, options = {}) => {
    const host = document.createElement('span')
    host.innerHTML = '<svg viewBox="0 0 100 100"></svg>'
    document.body.appendChild(host)
    return new api.LiveMark(host, { look: { shape, color: 'blue' }, def: api.SHAPES[shape], size: 36, seed: 3, ...options })
  }
  const advance = (ms) => {
    if (stepClockMs > 0) synthetic += ms
    else skipped += ms
  }
  return {
    api,
    document,
    mount,
    // One frame later: timers that came due run, then the frames asked for.
    frame(ms = 1000 / 60) {
      advance(ms)
      runTimers()
      const queued = [...rafs.values()]
      rafs.clear()
      frames += queued.length
      for (const fn of queued) fn(clock())
      return queued.length
    },
    skip(ms) { advance(ms); runTimers() },
    get asking() { return rafs.size > 0 },
    get timers() { return timers.size },
    get longestSliceMs() { return longestSliceMs },
    get maxStepsPerSlice() { return maxStepsPerSlice },
    get totalSliceSteps() { return totalSliceSteps },
    get timerRuns() { return timerRuns },
    idleAsks,
    get frames() { return frames },
    get drawn() { return drawn },
    get observers() { return observers },
    sights,
    live,
    win,
    hide(on) { hidden = on; document.dispatchEvent(new dom.window.Event('visibilitychange')) },
  }
}

// Frames until the clock stops asking, or `limit`.
function settle(p, limit = 2000) {
  let count = 0
  while (p.asking && count < limit) { p.frame(); count += 1 }
  return count
}
// Lets idle-time building run until the mark has its model.
function built(p, mark, limit = 4000) {
  for (let i = 0; i < limit && mark.rig === undefined; i += 1) p.frame(20)
  return mark.rig !== undefined
}

test('a mark at rest draws nothing, builds no model, and stops asking for frames', () => {
  const p = page()
  const mark = p.mount('gumdrop')
  assert.ok(settle(p) < 5, 'it stops at once')
  p.skip(10_000)
  assert.equal(p.asking, false)
  assert.equal(mark.rig, undefined, 'no model for a mark that never moved')
  assert.equal(p.api.rigReady('gumdrop', p.api.SHAPES.gumdrop), false)
  assert.equal(p.drawn, 0)
  assert.equal(mark.host.dataset.live3d, undefined, 'the flat art shows')
})

test('a move waits for the model, plays from its start, and the clock stops once back at rest', () => {
  const p = page()
  const mark = p.mount('gumdrop')
  settle(p)
  const before = mark.engine.time
  mark.update({ state: 'working' })
  p.frame()
  p.frame()
  assert.equal(mark.engine.time, before, 'the move holds while the model is built')
  assert.ok(built(p, mark), 'the model is built in idle slices')
  assert.equal(mark.host.dataset.live3d, '', 'the canvas takes over')
  assert.ok(mark.engine.time - before < 0.1, 'the move starts on the canvas, not halfway through')
  for (let i = 0; i < 120; i += 1) p.frame()
  assert.ok(p.drawn > 60, 'it draws while it works')
  mark.update({ state: 'idle' })
  const frames = settle(p)
  assert.ok(frames > 5 && frames < 400, `it plays back to rest (${frames} frames), then stops`)
  assert.equal(mark.engine.atRest, true)
  const drawn = p.drawn
  p.skip(20_000)
  assert.equal(p.asking, false)
  assert.equal(p.drawn, drawn, 'nothing more is drawn')
  assert.equal(mark.host.dataset.live3d, '', 'the layer stays until the mark goes')
})

test('a mark that appears in a state plays its opening move', () => {
  const p = page()
  const mark = p.mount('gumdrop', { state: 'done' })
  assert.ok(mark.engine.clips.some(play => ['celebrate', 'nodHappy', 'hopHappy'].includes(play.name)), 'done opens with a celebration')
  assert.ok(built(p, mark))
  settle(p)
  p.skip(3_000)
  settle(p)
  assert.equal(mark.engine.state, 'idle', 'done hands back to idle')
})

test('without requestIdleCallback a build slice stays short', () => {
  const p = page({ stepClockMs: 0.005 })
  const mark = p.mount('whale')
  mark.update({ state: 'working' })
  p.frame()
  for (let i = 0; i < 4000 && mark.rig === undefined; i += 1) p.frame(20)
  assert.notEqual(mark.rig, undefined)
  // Without requestIdleCallback, live.js gives each slice an 8 ms budget with a 2 ms
  // reserve (6 ms usable), and rigSteps yields after STEP_MS (1 ms). Driving the synthetic
  // clock deterministically per read checks both sides of that contract without OS jitter:
  // an un-yielded single-chunk build fails slice count, steps/slice, and slice budget.
  assert.ok(p.totalSliceSteps > 100, `whale rig yields many build steps (${p.totalSliceSteps} steps)`)
  assert.ok(p.timerRuns > 20, `model builds across many slices (${p.timerRuns} slices)`)
  assert.ok(p.maxStepsPerSlice > 0 && p.maxStepsPerSlice <= 12, `each slice executes only a few steps (max ${p.maxStepsPerSlice} steps/slice)`)
  assert.ok(p.longestSliceMs < 15, `synthetic slice duration stays bounded (${p.longestSliceMs.toFixed(2)} ms)`)
})

test('a page that is never idle still builds the model, a few steps per timeout', () => {
  const p = page({ busy: true })
  // How many steps the whale takes, built straight through in the same page.
  let steps = 0
  for (const run = p.api.rigSteps(p.api.models().whale); !run.next().done;) steps += 1
  const mark = p.mount('whale')
  mark.update({ state: 'working' })
  p.frame()
  assert.ok(p.idleAsks.length > 0)
  assert.ok(p.idleAsks.every(options => options?.timeout > 0), 'every idle request has a timeout')
  for (let i = 0; i < 4000 && mark.rig === undefined; i += 1) p.frame(400)
  assert.notEqual(mark.rig, undefined, 'the model is built')
  assert.ok(p.idleAsks.length < steps / 2, `${p.idleAsks.length} timeouts for ${steps} steps`)
  assert.ok(p.frame() > 0, 'and the move plays')
})

test('after REST_MS without input a petted mark finishes and holds still; input wakes it', () => {
  const p = page()
  const mark = p.mount('gumdrop', { live: true })
  mark.act(engine => engine.pet(true, 1))
  assert.ok(built(p, mark))
  // Between two nuzzles the mark waits on a short timer instead of a frame, so one look
  // at a moment can miss it: petting moves if the mark draws during the second.
  let drawn = 0
  for (let i = 0; i < 60; i += 1) drawn += p.frame()
  assert.ok(drawn > 0, 'petting moves')
  p.skip(31_000)
  assert.ok(settle(p) < 400, 'it finishes what it does and stops')
  p.skip(10_000)
  assert.equal(p.asking, false, 'a pointer left on the mark does not keep it going')
  p.win.dispatch('keydown')
  assert.ok(p.asking || p.timers > 1, 'input wakes it')
})

test('a lively mark dozes off after DOZE_MS and wakes on input', () => {
  const p = page({ motion: 'lively' })
  const mark = p.mount('gumdrop', { live: true })
  p.skip(p.api.DOZE_MS + 6_000)
  assert.equal(mark.engine.state, 'sleeping')
  p.win.dispatch('pointerdown')
  assert.equal(mark.engine.state, 'idle')
})

test('marks that come up after the window rested with none on screen start awake', () => {
  const p = page()
  const mark = p.mount('gumdrop', { state: 'working' })
  assert.ok(built(p, mark))
  p.skip(31_000)
  assert.equal(mark.engine.resting, true)
  mark.destroy()
  // Someone opened the page again; no mark was there to hear it.
  const next = p.mount('gumdrop', { state: 'working' })
  assert.equal(next.engine.resting, false)
  assert.ok(p.asking, 'it moves')
})

test('with motion off, a face that switches in place is drawn, and so is the way back to rest', () => {
  const p = page({ effects: 'off' })
  const mark = p.mount('gumdrop')
  settle(p)
  assert.equal(mark.rig, undefined)
  // Sending changes only the face: that is enough to need the model.
  mark.update({ state: 'sending' })
  assert.ok(built(p, mark), 'the model is built for the face')
  settle(p)
  assert.equal(mark.engine.face.name, 'determined')
  const sent = p.drawn
  assert.ok(sent > 0, 'and drawn')
  mark.update({ state: 'done' })
  settle(p)
  assert.equal(mark.engine.face.name, 'happy')
  assert.ok(p.drawn > sent)
  // Done hands back to idle in place, and the neutral face is drawn.
  const happy = p.drawn
  for (let i = 0; i < 500 && mark.engine.state !== 'idle'; i += 1) p.frame(20)
  settle(p)
  assert.equal(mark.engine.state, 'idle')
  assert.equal(mark.engine.face.name, 'neutral')
  assert.ok(p.drawn > happy, 'the way back is drawn')
  assert.equal(p.asking, false)
  assert.equal(p.timers, 1, 'only the rest timer is left')
})

test('a mark that goes while its model is still being built leaves nothing running, and a new one builds it', () => {
  const p = page()
  const mark = p.mount('whale', { state: 'working' })
  for (let i = 0; i < 3; i += 1) p.frame(20)
  assert.equal(mark.rig, undefined, 'still building')
  mark.destroy()
  assert.equal(p.timers, 0, 'no build slice is left waiting')
  assert.equal(p.asking, false)
  const again = p.mount('whale', { state: 'working' })
  assert.ok(built(p, again))
  again.destroy()
  assert.equal(p.timers, 0)
})

test('a hidden page and a mark out of view are skipped', () => {
  const p = page()
  const mark = p.mount('gumdrop', { state: 'working' })
  assert.ok(built(p, mark))
  p.hide(true)
  const time = mark.engine.time
  for (let i = 0; i < 10; i += 1) p.frame()
  assert.equal(mark.engine.time, time, 'no ticks while hidden')
  assert.equal(p.asking, false)
  p.hide(false)
  assert.ok(p.asking)
  p.sights[0].callback([{ target: mark.host, isIntersecting: false }])
  for (let i = 0; i < 5; i += 1) p.frame()
  assert.equal(p.asking, false, 'nothing in view, no frames')
})

test('reduced interface motion stops a running flourish and blinks, and the clock goes quiet', async () => {
  const p = page()
  const mark = p.mount('gumdrop', { size: 64, state: 'thinking' })
  assert.ok(built(p, mark))
  for (let i = 0; i < 60; i += 1) p.frame()
  assert.equal(mark.engine.frame.accent?.kind, 'dots')
  p.document.body.dataset.btEffects = 'reduced'
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(mark.engine.frame.accent, null)
  assert.ok(settle(p) < 400, 'the clock stops')
  p.skip(60_000)
  assert.equal(p.asking, false, 'no blink or loop wakes it')
})

test('a change on the body that no mark shows redraws nothing', async () => {
  const p = page()
  const mark = p.mount('gumdrop', { state: 'working' })
  assert.ok(built(p, mark))
  mark.update({ state: 'idle' })
  settle(p)
  const drawn = p.drawn
  p.document.body.style.setProperty('--bt-placeholder', '"Message"')
  p.document.body.className = 'other'
  await new Promise(resolve => setTimeout(resolve, 0))
  settle(p)
  assert.equal(p.drawn, drawn)
  p.document.body.toggleAttribute('data-ds-dark-theme', true)
  await new Promise(resolve => setTimeout(resolve, 0))
  settle(p)
  assert.ok(p.drawn > drawn, 'dark mode redraws in the new ink')
})

test('the last mark going removes every listener, observer and timer, every time', () => {
  const p = page()
  for (let round = 0; round < 3; round += 1) {
    const a = p.mount('gumdrop', { follow: true })
    const b = p.mount('bear', { state: 'working' })
    built(p, b)
    for (let i = 0; i < 5; i += 1) p.frame()
    a.destroy()
    b.destroy()
    const left = [...p.live].filter(([, count]) => count !== 0)
    assert.deepEqual(left, [], `round ${round}: listeners left ${JSON.stringify(left)}`)
    assert.equal(p.observers, 0)
    assert.equal(p.asking, false)
    assert.equal(p.timers, 0, 'no rest timer or wake-up timer is left')
    assert.equal(a.host.dataset.live3d, undefined)
    assert.equal(b.host.querySelector('canvas'), null)
  }
})
