// The phone's clock for live marks (clock.ts) on the real engine and the real models:
// when it asks for frames, how it builds a model, how it rests and dozes, what it skips,
// and that the last mark going leaves nothing behind. Frames and timers are run by the
// test on real time plus what the test skips, so a build slice is timed as it runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SHAPES } from '../../../../ds-bot/src/client/characters.js'
import { DOZE_MS } from '../../../../ds-bot/src/client/avatar/stage.js'
import { REST_MS } from '../../../../ds-bot/src/client/motion-rest.js'
import { Clock, IDLE_WAIT_MS, LiveMark, motionCapabilities, SLICE_MS, type Host, type Picture, type Signals } from './clock.ts'
import { shownState } from './shown.ts'

const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/appstate-ios.json', import.meta.url), 'utf8')) as {
  initial: string
  changes: { label: string; to?: string; reduceMotion?: boolean }[]
  idle: { calls: { remaining: number; didTimeout: boolean }[] }
}

// `idle`: how idle callbacks come. `recorded`: as React Native on iOS sent them (at once,
// offering about 50 ms); `busy`: never idle, so only when their timeout runs out; none:
// the host has no idle callbacks.
function phone({ idle }: { idle?: 'recorded' | 'busy' } = {}) {
  let skipped = 0
  const now = () => performance.now() + skipped
  let next = 1
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { fn: () => void; at: number }>()
  let signals: Signals | null = null
  let listening = 0
  let framesRun = 0
  // How long each timer callback ran, in real time: the build slices.
  const ran: number[] = []
  const runTimers = () => {
    for (let guard = 0; guard < 100_000; guard += 1) {
      let due: [number, { fn: () => void; at: number }] | null = null
      for (const entry of timers) if (entry[1].at <= now() && (!due || entry[1].at < due[1].at)) due = entry
      if (!due) return
      timers.delete(due[0])
      const start = performance.now()
      due[1].fn()
      ran.push(performance.now() - start)
    }
  }
  const host: Host = {
    now,
    frame(fn) { const id = next++; frames.set(id, fn); return id },
    cancelFrame(id) { frames.delete(id as number) },
    after(fn, ms) { const id = next++; timers.set(id, { fn, at: now() + ms }); return id },
    cancel(id) { timers.delete(id as number) },
    ...(idle ? {
      idle(fn: (deadline: { timeRemaining(): number; didTimeout: boolean }) => void, timeout: number) {
        const id = next++
        const call = RECORDED.idle.calls[id % RECORDED.idle.calls.length]
        const deadline = idle === 'busy' ? { timeRemaining: () => 0, didTimeout: true } : { timeRemaining: () => call.remaining, didTimeout: call.didTimeout }
        timers.set(id, { fn: () => fn(deadline), at: now() + (idle === 'busy' ? timeout : 0) })
        return id
      },
      cancelIdle(id: unknown) { timers.delete(id as number) },
    } : {}),
    listen(given) { signals = given; listening += 1; return () => { listening -= 1; signals = null } },
  }
  const clock = new Clock(host)
  const paints: (Picture | null)[] = []
  const mount = (shape: string, options: Partial<ConstructorParameters<typeof LiveMark>[1]> = {}) => new LiveMark(clock, {
    look: { shape, color: 'blue' }, def: (SHAPES as Record<string, unknown>)[shape], size: 36, seed: 3, paint: picture => paints.push(picture), ...options,
  })
  return {
    clock,
    mount,
    paints,
    get signals() { assert.ok(signals, 'the clock listens while a mark is up'); return signals },
    get listening() { return listening },
    // One frame later: timers that came due run, then the frames asked for.
    frame(ms = 1000 / 60) {
      skipped += ms
      runTimers()
      const queued = [...frames.values()]
      frames.clear()
      framesRun += queued.length
      for (const fn of queued) fn()
      return queued.length
    },
    skip(ms: number) { skipped += ms; runTimers() },
    get asking() { return frames.size > 0 },
    get timers() { return timers.size },
    get framesRun() { return framesRun },
    get ran() { return ran },
  }
}

// Frames until the clock stops asking, or `limit`.
function settle(p: ReturnType<typeof phone>, limit = 3000) {
  let count = 0
  while (p.asking && count < limit) { p.frame(); count += 1 }
  return count
}
// Runs frames (and the build slices between them) until the mark has its model.
function built(p: ReturnType<typeof phone>, mark: LiveMark, limit = 4000) {
  for (let i = 0; i < limit && mark.rig === undefined; i += 1) p.frame(20)
  return mark.rig !== undefined
}

test('a mark at rest draws nothing, builds no model, and stops asking for frames', () => {
  const p = phone()
  const mark = p.mount('bear', { live: true })
  settle(p)
  p.skip(60_000)
  settle(p)
  assert.equal(mark.rig, undefined, 'no model is built for a mark that never moved')
  assert.equal(p.paints.length, 0, 'the flat art stays')
  assert.equal(p.asking, false)
  mark.destroy()
})

// The first model built in this process runs on cold code (Node compiles as it goes,
// where the phone runs Hermes bytecode); the timed tests build other shapes after it.
{
  const warm = phone()
  const first = warm.mount('sprout', { state: 'working' })
  assert.ok(built(warm, first))
  first.destroy()
}

// A slice stops once its time is up, so it runs past it by at most one build step
// (steps.js STEP_MS). The middle slice shows that; a busy test machine can stretch a few,
// as a garbage collection can, so the longest only has to stay under two frames (the
// device run measured Hermes itself).
function shortSlices(p: ReturnType<typeof phone>) {
  const slices = p.ran.filter(ms => ms > 0.5).sort((a, b) => a - b)
  assert.ok(slices.length >= 5, `the model is built over many slices (${slices.length})`)
  const middle = slices[Math.floor(slices.length / 2)]
  assert.ok(middle <= SLICE_MS + 2, `a build slice stays short (middle ${middle.toFixed(1)} ms of ${slices.length})`)
  assert.ok(slices.at(-1)! < 33, `no slice holds the thread for two frames (${slices.at(-1)!.toFixed(1)} ms)`)
}

test('idle callbacks as iOS sends them offer 50 ms; a slice still takes at most SLICE_MS', () => {
  const p = phone({ idle: 'recorded' })
  const mark = p.mount('bear', { state: 'thinking' })
  p.frame()
  assert.ok(built(p, mark))
  shortSlices(p)
  mark.destroy()
})

test('a thread that is never idle still builds the model, a slice per timeout', () => {
  const p = phone({ idle: 'busy' })
  const mark = p.mount('beacon', { state: 'working' })
  p.frame()
  p.skip(IDLE_WAIT_MS - 50)
  assert.equal(mark.rig, undefined, 'nothing before the timeout')
  assert.ok(built(p, mark, 20_000))
  shortSlices(p)
  mark.destroy()
})

test('a working mark waits for its model, built in short slices, then draws while it moves', () => {
  const p = phone()
  const mark = p.mount('octopus', { state: 'working' })
  p.frame()
  assert.equal(mark.rig, undefined, 'the move waits for the model')
  assert.equal(p.paints.length, 0, 'the flat art shows meanwhile')
  assert.ok(built(p, mark), 'the model is built')
  shortSlices(p)
  p.frame()
  p.frame()
  const picture = p.paints.at(-1)
  assert.ok(picture?.shapes, 'the model is drawn')
  assert.ok(picture.shapes.body.length > 0 && picture.shapes.eyes.length > 0, 'with its body and its eyes')
  // A row-sized mark draws 30 times a second; a hero, at the screen's rate.
  const before = p.paints.length
  for (let i = 0; i < 60; i += 1) p.frame()
  const drawn = p.paints.length - before
  assert.ok(drawn >= 28 && drawn <= 31, `a working row mark keeps moving, 30 times a second (${drawn})`)
  mark.update({ size: 64 })
  const hero = p.paints.length
  for (let i = 0; i < 60; i += 1) p.frame()
  assert.ok(p.paints.length - hero > 45, `a hero mark draws at the screen's rate (${p.paints.length - hero})`)
  mark.destroy()
})

test('a mark that appears in a state plays its opening move', () => {
  const p = phone()
  const mark = p.mount('star', { state: 'done', size: 52 })
  assert.ok(built(p, mark))
  const ys: number[] = []
  for (let i = 0; i < 90; i += 1) { p.frame(); ys.push(mark.engine.frame.y) }
  assert.ok(Math.min(...ys) < -0.5 || mark.engine.frame.accent !== null || ys.some(y => Math.abs(y) > 0.2), 'the done move plays')
  mark.destroy()
})

test('after REST_MS without a touch a petted mark finishes and holds still; a touch wakes it', () => {
  const p = phone()
  const mark = p.mount('puppy', { live: true })
  mark.act(engine => engine.pet(true, 1))
  assert.ok(built(p, mark))
  for (let i = 0; i < 60; i += 1) p.frame()
  p.skip(REST_MS + 100)
  assert.equal(p.clock.isResting, true)
  const frames = settle(p, 2000)
  assert.ok(frames < 2000, 'the clock stops asking for frames')
  const drawn = p.paints.length
  p.skip(20_000)
  settle(p)
  assert.equal(p.paints.length, drawn, 'nothing new starts while resting')
  p.signals.input()
  assert.equal(p.clock.isResting, false)
  for (let i = 0; i < 240; i += 1) p.frame()
  assert.ok(p.paints.length > drawn, 'a touch wakes it')
  mark.destroy()
})

test('woken from rest, marks rest again REST_MS after the last touch, not only at DOZE_MS', () => {
  const p = phone()
  const mark = p.mount('puppy', { state: 'working' })
  assert.ok(built(p, mark))
  p.skip(REST_MS + 100)
  assert.equal(p.clock.isResting, true)
  p.signals.input()
  assert.equal(p.clock.isResting, false)
  p.skip(REST_MS - 1000)
  assert.equal(p.clock.isResting, false, 'not before REST_MS')
  p.skip(1100)
  assert.equal(p.clock.isResting, true, 'REST_MS after the touch')
  // Coming back to the app wakes them the same way.
  p.signals.shown(false)
  p.signals.shown(true)
  assert.equal(p.clock.isResting, false)
  p.skip(REST_MS + 100)
  assert.equal(p.clock.isResting, true)
  mark.destroy()
})

test('a lively mark at rest dozes off after DOZE_MS and wakes on a touch', () => {
  const p = phone()
  p.clock.setPrefs({ motion: 'lively' })
  const mark = p.mount('bunny', { live: true, size: 52 })
  for (let elapsed = 0; elapsed < DOZE_MS + 6_000; elapsed += 500) p.frame(500)
  assert.equal(p.clock.isDozing, true)
  assert.equal(mark.engine.state, 'sleeping')
  p.signals.input()
  assert.equal(mark.engine.state, 'idle')
  mark.destroy()
})

test('in the background nothing runs: no frames, no slices; back in front it goes on and counts as a touch', () => {
  const p = phone()
  const mark = p.mount('kitty', { state: 'thinking' })
  p.frame()
  p.signals.shown(false)
  assert.equal(p.asking, false)
  for (let i = 0; i < 50; i += 1) p.frame(20)
  assert.equal(mark.rig, undefined, 'the model is not built in the background')
  assert.equal(p.paints.length, 0)
  p.skip(REST_MS + 1000)
  p.signals.shown(true)
  assert.equal(p.clock.isResting, false, 'coming back is someone looking')
  assert.ok(built(p, mark))
  p.frame()
  assert.ok(p.paints.length > 0)
  mark.destroy()
})

test('a mark off screen is skipped, and draws again when it is back', () => {
  const p = phone()
  const mark = p.mount('bloom', { state: 'working' })
  assert.ok(built(p, mark))
  p.frame()
  mark.setVisible(false)
  const drawn = p.paints.length
  for (let i = 0; i < 30; i += 1) p.frame()
  assert.equal(p.paints.length, drawn, 'nothing is drawn off screen')
  assert.equal(p.asking, false, 'nor asked for')
  mark.setVisible(true)
  p.frame()
  assert.ok(p.paints.length > drawn)
  mark.destroy()
})

test('a mark that leaves the screen while its model is built stops the build; the one on screen goes first', () => {
  const p = phone()
  const away = p.mount('pebbles', { state: 'working' })
  const here = p.mount('spark', { state: 'working' })
  p.frame()
  p.frame(20)
  assert.equal(away.rig, undefined)
  // The drawer closes over the first: the second, still on screen, is built next.
  away.setVisible(false)
  assert.ok(built(p, here))
  for (let i = 0; i < 400; i += 1) p.frame(20)
  assert.equal(away.rig, undefined, 'nothing is built for a mark off screen')
  // Back on screen it goes on from where its build stopped.
  away.setVisible(true)
  assert.ok(built(p, away))
  away.destroy()
  here.destroy()
})

test('the system reduced-motion setting holds marks still: pokes do nothing, a new state is drawn in place', () => {
  const p = phone()
  const mark = p.mount('acorn', { state: 'working' })
  assert.ok(built(p, mark))
  p.signals.reduceMotion(true)
  assert.deepEqual(p.clock.settings, { tier: 'normal', effects: 'off' })
  settle(p)
  const drawn = p.paints.length
  mark.act(engine => engine.poke())
  assert.ok(settle(p) <= 2, 'a poke plays nothing')
  mark.update({ state: 'alert' })
  settle(p)
  assert.ok(p.paints.length > drawn && p.paints.length - drawn <= 4, 'the new face is drawn in place')
  assert.equal(p.asking, false)
  p.signals.reduceMotion(false)
  assert.deepEqual(p.clock.settings, { tier: 'normal', effects: 'full' })
  mark.destroy()
})

test("the computer's motion levels: quiet takes no pokes, reduced stops loops, the system's setting wins", () => {
  const p = phone()
  const mark = p.mount('cloud', { size: 52 })
  p.clock.setPrefs({ motion: 'quiet' })
  assert.equal(mark.engine.tier, 'quiet')
  settle(p)
  mark.act(engine => engine.poke())
  settle(p)
  assert.equal(mark.rig, undefined, 'a quiet mark is not poked: it never left the flat art')
  assert.equal(p.paints.length, 0)
  p.clock.setPrefs({ motion: 'normal', effects: 'reduced' })
  assert.deepEqual(p.clock.settings, { tier: 'normal', effects: 'reduced' })
  p.signals.reduceMotion(true)
  assert.equal(p.clock.settings.effects, 'off')
  p.clock.setPrefs(undefined)
  assert.equal(p.clock.settings.effects, 'off', 'the system asks for no motion')
  mark.destroy()
})

test('a poke and a held touch move the mark, and petting ends when the touch lifts', () => {
  const p = phone()
  const mark = p.mount('bear', { size: 64 })
  mark.act(engine => engine.poke())
  assert.ok(built(p, mark), 'a poke builds the model')
  const before = p.paints.length
  for (let i = 0; i < 30; i += 1) p.frame()
  assert.ok(p.paints.length > before, 'the poke plays')
  settle(p)
  mark.act(engine => engine.pet(true, -1))
  for (let i = 0; i < 40; i += 1) p.frame()
  assert.ok(mark.engine.frame.roll > 1, 'it leans into the touch')
  mark.act(engine => engine.pet(false))
  settle(p)
  assert.ok(Math.abs(mark.engine.frame.roll) < 0.05, 'and back')
  mark.destroy()
})

test('a photo moves as a whole from the start, with no model', () => {
  const p = phone()
  const mark = p.mount('image', { turns: false, def: undefined, state: 'done', size: 52 })
  assert.equal(mark.rig, null)
  for (let i = 0; i < 10; i += 1) p.frame()
  const picture = p.paints.at(-1)
  assert.ok(picture?.pose, 'a pose for the flat art')
  mark.destroy()
})

test('a mark that goes while its model is being built leaves nothing running; the next one builds it', () => {
  const p = phone()
  const first = p.mount('saucer', { state: 'working' })
  p.frame()
  p.frame(20)
  first.destroy()
  assert.equal(p.listening, 0)
  assert.equal(p.timers, 0, 'no slice, frame or rest timer is left')
  assert.equal(p.asking, false)
  const second = p.mount('saucer', { state: 'working' })
  assert.ok(built(p, second))
  second.destroy()
})

test('the last mark going stops listening and leaves no timer, every time', () => {
  const p = phone()
  for (let round = 0; round < 3; round += 1) {
    const a = p.mount('peanut', { state: 'working' })
    const b = p.mount('gumdrop', { live: true })
    assert.equal(p.listening, 1, 'one set of listeners serves every mark')
    for (let i = 0; i < 20; i += 1) p.frame(20)
    a.destroy()
    assert.equal(p.listening, 1)
    b.destroy()
    assert.equal(p.listening, 0)
    assert.equal(p.timers, 0)
    assert.equal(p.asking, false)
  }
})

// The app's state and the motion setting as the iOS simulator sent them (recorded, see
// fixtures/appstate-ios.json): Home and back, the app switcher, and Settings, where Reduce
// Motion was switched on; that change arrives just before the app is active again.
test('the app states iOS sends move the clock to the background and back, and Reduce Motion holds marks still', () => {
  const p = phone()
  const mark = p.mount('moon', { state: 'working' })
  p.signals.shown(shownState(RECORDED.initial))
  assert.ok(built(p, mark))
  for (const change of RECORDED.changes) {
    if (change.reduceMotion !== undefined) { p.signals.reduceMotion(change.reduceMotion); continue }
    p.signals.shown(shownState(change.to))
    const drawn = p.paints.length
    for (let i = 0; i < 5; i += 1) p.frame()
    if (change.to !== 'active') assert.equal(p.paints.length, drawn, `${change.label} (${change.to}): nothing drawn`)
    else if (p.clock.settings.effects === 'off') {
      settle(p)
      const still = p.paints.length
      for (let i = 0; i < 60; i += 1) p.frame()
      assert.equal(p.paints.length, still, `${change.label}: Reduce Motion holds the mark still`)
    } else assert.ok(p.paints.length > drawn, `${change.label} (${change.to}): drawing`)
  }
  assert.equal(mark.engine.effects, 'off')
  mark.destroy()
})

test('motionCapabilities matches engine poke/pet acceptance and subscribeSettings tracks changes', () => {
  const p = phone()
  const seen: string[] = []
  const off = p.clock.subscribeSettings(() => {
    const { tier, effects } = p.clock.settings
    seen.push(`${tier}|${effects}`)
  })
  const mark = p.mount('gumdrop', { live: true, size: 64 })

  assert.deepEqual(motionCapabilities(p.clock.settings), { canPoke: true, canPet: true })

  // Reduced effects: engine allows poke but rejects pet.
  p.clock.setPrefs({ effects: 'reduced' })
  assert.deepEqual(motionCapabilities(p.clock.settings), { canPoke: true, canPet: false })
  mark.act(engine => engine.poke())
  assert.ok(built(p, mark), 'reduced effects still allows poke and builds model')
  settle(p)
  const rollAtRest = mark.engine.frame.roll
  mark.act(engine => engine.pet(true, 1))
  for (let i = 0; i < 30; i += 1) p.frame()
  assert.equal(mark.engine.frame.roll, rollAtRest, 'reduced effects ignores pet')

  // Quiet motion: neither poke nor pet.
  p.clock.setPrefs({ motion: 'quiet', effects: 'full' })
  assert.deepEqual(motionCapabilities(p.clock.settings), { canPoke: false, canPet: false })

  // System Reduce Motion overrides full effects to off: neither poke nor pet.
  p.clock.setPrefs({ motion: 'normal', effects: 'full' })
  p.signals.reduceMotion(true)
  assert.deepEqual(motionCapabilities(p.clock.settings), { canPoke: false, canPet: false })

  // No-op update does not re-notify; unsubscribe stops notifications.
  const count = seen.length
  p.signals.reduceMotion(true)
  assert.equal(seen.length, count)
  off()
  p.signals.reduceMotion(false)
  assert.equal(seen.length, count)

  assert.deepEqual(seen, ['normal|reduced', 'quiet|full', 'normal|full', 'normal|off'])
  mark.destroy()
})

test('waking a resting clock before petting lets screen-reader pet nuzzle', () => {
  const p = phone()
  const mark = p.mount('puppy', { live: true, size: 64 })
  p.skip(REST_MS + 100)
  assert.equal(p.clock.isResting, true)
  settle(p)

  // Calling input() before pet(true, 1) — as LiveMark's accessibility action does — wakes the clock.
  p.signals.input()
  assert.equal(p.clock.isResting, false)
  mark.act(engine => engine.pet(true, 1))
  assert.ok(built(p, mark))
  for (let i = 0; i < 30; i += 1) p.frame()
  assert.ok(Math.abs(mark.engine.frame.roll) > 0.5, 'petting leans in after waking from rest')
  mark.act(engine => engine.pet(false))
  mark.destroy()
})
