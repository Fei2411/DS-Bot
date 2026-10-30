// The whale director: turns start snapshots into whale motion. The whale stays in the middle of
// a ring of three arcs, one per stage, and the ring is the progress: an arc turns active, then
// fills as its stage is done, and the ring closes at the hand-off. The director keeps the arcs
// (.arc data-state) and the hidden stage list (.station data-state, aria-current) for the live
// region and screen readers. A click on the whale makes it spout.
// Layers (start.html): .whale-x the box (gaze, spout) > .whale-gaze pointer > .whale scale >
// .whale-move one-shots > .whale-loop CSS state loops > svg (#tail, #eye-pair, #gaze, .bt-eye).
// One-shots run on WAAPI and end with commitStyles() + cancel(); loops are CSS keyed on
// html[data-whale] and html[data-tail]. Every await is raced against a timer, because a
// hidden document stops ticking animations.
const root = document.documentElement
const rm = matchMedia('(prefers-reduced-motion: reduce)')
const tierNow = () => root.dataset.motion || 'normal'
// html[data-tier] is the tier the CSS reads; it follows data-motion (the snapshot's tier).
const syncTier = () => { if (root.dataset.tier !== tierNow()) root.dataset.tier = tierNow() }
syncTier()
new MutationObserver(syncTier).observe(root, { attributes: true, attributeFilter: ['data-motion'] })
export const reduced = () => rm.matches
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cs = el => getComputedStyle(el)
const clamp = v => Math.max(-1, Math.min(1, v))
const IDENTITY = /^(none|1|0px|0px 0px|matrix\(1, 0, 0, 1, 0, 0\))$/u
const CLEAR = ['transform', 'scale', 'translate']
const OUT = 'cubic-bezier(.4,0,.2,1)'
const HOP = 'cubic-bezier(.3,.7,.4,1)'
const PHASES = ['data', 'engine', 'team']
// An active station and a state loop each hold at least 400 ms; the margin covers the frame
// on which the change is painted.
const HOLD = 420
// The first arc fills this long after the whale has surfaced, so that it is seen to fill: the
// data stage is usually done before the page has painted.
const FIRST_ARC_MS = 260
// The whale is 112 px on every kind of start (start.css --u). Starting over in a new folder, it
// sinks this far: under the waterline.
const u = 1.12
const SINK = 84
// Hops land at .55 of their 1.3 s cycle; the lively tier spaces further hops out, never closer.
const HOP_MS = 1300
const LANDED = 0.55 * HOP_MS
const MORE_HOPS = [2600, 5200]
const HOP_EVERY = 9000
// Acts that only open, fold or copy something on the card; every other card button answers it.
const LOCAL = new Set(['toggleDetails', 'toggleMore', 'toggleModels', 'copyDetails'])
// Waits get calmer on the card's own clock: rates and blink gaps after 30 s and after 90 s.
const calmer = ms => (ms >= 90000 ? [0.6, 2] : ms >= 30000 ? [0.8, 1.4] : [1, 1])

const springs = {}
export function spring(name) {
  if (!springs[name]) {
    const style = cs(root)
    springs[name] = { duration: parseFloat(style.getPropertyValue(`--spring-${name}-ms`)) || 420, easing: style.getPropertyValue(`--spring-${name}`).trim() || 'ease-out' }
  }
  return springs[name]
}

let instant = false
// Plays keyframes; with `instant` (a resumed page) it writes the last frame and returns at once.
export function play(el, frames, opts) {
  if (instant) {
    for (const [key, value] of Object.entries(frames.at(-1))) if (key !== 'offset' && key !== 'easing') el.style[key] = CLEAR.includes(key) && IDENTITY.test(String(value)) ? '' : value
    return { done: Promise.resolve(), cancel() {}, finish() {}, commitStyles() {} }
  }
  const anim = el.animate(frames, { fill: 'forwards', ...opts })
  const count = opts.iterations ?? 1
  anim.done = count === Infinity ? new Promise(() => {}) : Promise.race([anim.finished.catch(() => {}), sleep((opts.delay ?? 0) + (opts.duration ?? 0) * count + 150)])
  return anim
}
// Ends a one-shot at its end state: finish, commit through CSSOM (CSP allows it), cancel.
export function settle(anim, el, commit = true) {
  if (!anim?.effect || anim.playState === 'idle') return
  try { if (anim.playState !== 'finished' && anim.effect.getComputedTiming().iterations !== Infinity) anim.finish() } catch { /* infinite */ }
  if (commit) try { anim.commitStyles() } catch { /* not rendered */ }
  anim.cancel()
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
const scripted = el => el.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))
// Replaces earlier one-shots on el, keeping the pose they have reached this frame (never
// their end state: finishing one mid-flight would teleport the whale).
function drop(el) {
  for (const a of scripted(el)) {
    try { a.commitStyles() } catch { /* not rendered */ }
    a.cancel()
  }
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
function to(el, props, opts) {
  const from = {}
  for (const key of Object.keys(props)) from[key] = cs(el)[key]
  drop(el)
  const anim = play(el, [from, props], opts)
  anim.done.then(() => settle(anim, el))
  return anim
}
const kf = (frames, easing) => frames.map(frame => ({ easing, ...frame }))
export const clamped = easing => easing.replace(/\d+\.\d+/gu, value => String(Math.min(1, Number(value))))

export function createDirector({ start, resume, act, label, announce, onCheck, onActive }) {
  const $ = selector => document.querySelector(selector)
  const x = $('.whale-x'), gazeLayer = $('.whale-gaze'), body = $('.whale'), move = $('.whale-move'), loop = $('.whale-loop')
  const tail = $('#tail'), pair = $('#eye-pair'), lane = $('.lane'), ripple = $('.ripple'), hit = $('.whale-hit')
  const eyes = [...document.querySelectorAll('.bt-eye')], happy = [...document.querySelectorAll('.bt-eye-happy')]
  const stations = [...document.querySelectorAll('.station')]
  const arcs = [...document.querySelectorAll('.arc')]
  const first = start === 'first'
  const t0 = performance.now()
  const entranceMs = resume ? 0 : first ? 560 : 290
  const D = { at: 0, checks: 0, pose: 'enter', loop: '', card: '', slow: 0, bx: 0, by: 0, since: [t0], activeAt: [], loopAt: 0, hop: null, pet: null, handed: false, workReady: first, missed: false, sinking: false,
    // Rest on a card: its clock, the lean, the breath, the lively hops; the last glance and press.
    clockKind: '', cardAt: 0, lean: false, leanDue: false, leanOff: false, leanMine: -1, restMine: -1, breath: null, hopsStopped: false, legging: false, glanceAt: -Infinity, press: null, nodAt: 0 }
  const rnd = Math.random
  let want = { station: 0, view: 'boot', phase: 'data', done: [], card: '', missed: false, celebrate: first, update: '' }
  let token = 0
  let wake = () => {}
  let bumped = new Promise(resolve => { wake = resolve })
  // Timers of the rest on a card belong to one token; a new state drops them all.
  const timers = new Set()
  function later(mine, ms, fn) {
    const id = setTimeout(() => { timers.delete(id); if (mine === token) fn() }, Math.max(0, ms))
    timers.add(id)
  }
  const bump = () => {
    token += 1
    for (const id of timers) clearTimeout(id)
    timers.clear()
    stopBreath()
    unpress()
    wake()
    bumped = new Promise(resolve => { wake = resolve })
  }
  const until = promise => Promise.race([promise, bumped])
  const wait = ms => (instant ? Promise.resolve() : sleep(ms))
  const tier = tierNow
  const playful = () => tier() !== 'quiet' && !reduced()
  const failure = () => want.view === 'failed' || want.view === 'viewFailed' || want.card === 'importFailed'
  const entered = sleep(entranceMs).then(() => { root.dataset.entered = '' })
  // Finished entrance veils are dropped, so later fades of the same blocks stay composited.
  sleep(resume ? 0 : 700).then(() => { root.dataset.settled = '' })
  if (resume) instant = true
  if (!first) setTimeout(() => { D.workReady = true; if (D.started) kick() }, resume ? 0 : 1000)

  // ---- stages: the ring's arcs and the hidden list ----
  // Each arc carries its stage's state: pending (faint), active (tinted, a light running along
  // it), done (drawn in the whale's blue) or failed (red); start.css draws them.
  function setStation(i, state) {
    const st = stations[i]
    if (!st || st.dataset.state === state) return
    st.dataset.state = state
    arcs[i].dataset.state = state
    st.querySelector('.sr').textContent = label(`status.state.${state}`)
    if (state === 'active') st.setAttribute('aria-current', 'step')
    else st.removeAttribute('aria-current')
  }
  function popCheck(i) {
    if (D.checks > i) return
    D.checks = i + 1
    setStation(i, 'done')
    announce(label('status.sr.done', { phase: label(`status.phase.${PHASES[i]}`) }))
    onCheck?.(i)
  }
  let activeTimer = 0
  function armActive() {
    clearTimeout(activeTimer)
    const i = D.at
    if (D.handed || failure() || i > 2 || D.checks > i || stations[i].dataset.state !== 'pending') return
    if (i < 2 && want.done.includes(PHASES[i])) return
    const now = performance.now()
    const delay = Math.max(0, (D.since[i] ?? now) + 250 - now, t0 + entranceMs - now)
    activeTimer = setTimeout(() => {
      if (D.at !== i || stations[i].dataset.state !== 'pending' || failure() || (i < 2 && want.done.includes(PHASES[i]))) return
      setStation(i, 'active')
      D.activeAt[i] = performance.now()
      announce(label('status.sr.active', { phase: label(`status.phase.${PHASES[i]}`) }))
      onActive?.(i)
    }, instant ? 0 : delay)
  }

  // ---- loops ----
  const capture = () => ({ loop: cs(loop).transform, tail: cs(tail).transform, pair: cs(pair).transform, eyes: eyes.map(eye => cs(eye).transform) })
  // Every pose change starts here and then slides .whale-loop from where it is, lean included.
  const stopLoop = () => { delete root.dataset.whale; delete root.dataset.tail; D.loop = ''; D.lean = false; clearTimeout(D.wander) }
  function slide(el, from, target, opts) {
    drop(el)
    if (from === 'none' && target === 'none') return null
    const anim = play(el, [{ transform: from }, { transform: target }], opts)
    anim.done.then(() => settle(anim, el))
    return anim
  }
  function release(pose, opts) {
    slide(loop, pose.loop, 'none', opts)
    slide(tail, pose.tail, 'none', opts)
    slide(pair, pose.pair, 'none', opts)
    eyes.forEach((eye, k) => slide(eye, pose.eyes[k], 'none', opts))
  }
  const START = { searching: { loop: 'rotate(-4deg)', pair: 'translateX(-12%)' }, pondering: { loop: 'rotate(4deg)', eye: 'translate(0,-4%) scaleY(.7)' } }
  async function startLoop(name) {
    const tailName = first && tier() !== 'quiet' ? ({ working: 'beat', sending: 'dash' }[name] ?? '') : ''
    if (D.loop === name) return
    const mine = token
    const pose = capture()
    stopLoop()
    if (!reduced()) {
      const shape = spring('shape')
      const begin = START[name] ?? {}
      slide(loop, pose.loop, begin.loop ?? 'none', shape)
      slide(pair, pose.pair, begin.pair ?? 'none', { duration: 240, easing: 'ease-out' })
      slide(tail, pose.tail, 'none', { duration: 240, easing: 'ease-out' })
      eyes.forEach((eye, k) => slide(eye, pose.eyes[k], begin.eye ?? 'none', { duration: 240, easing: 'ease-out' }))
      await until(wait(shape.duration))
      if (mine !== token) return
    }
    // The slides end on the loop's first frame, so dropping them in the same task as the
    // switch shows no jump.
    for (const el of [loop, pair, tail, ...eyes]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform') }
    root.dataset.whale = name
    if (tailName) root.dataset.tail = tailName
    D.loop = name
    D.loopAt = performance.now()
    if (D.slow === 1) calm()
    if (name === 'working') wanderLater()
  }
  // While it works on the second stage, the whale glances left or right now and then (§3, the
  // small reactions): every 5 to 9 s, a 600 ms look to one side at random, over the bob. Not in
  // the quiet tier, with reduced motion or while thinking, and not while the eyes follow the
  // pointer or a control, or look at the user.
  // Only the second stage of a first start: later and moving starts, and the copying cards, use
  // the working loop too.
  const wandering = () => first && D.at === 1 && !D.card && playful() && D.loop === 'working' && D.slow < 2
  function wanderLater() {
    clearTimeout(D.wander)
    if (!wandering()) return
    D.wander = setTimeout(() => { wander(); wanderLater() }, 5000 + 4000 * rnd())
  }
  function wander() {
    if (!wandering() || D.gazeHold || D.pet || D.hop || D.handed || document.hidden) return
    if (pointer || (focused && focused === document.activeElement)) return
    const side = `translateX(${rnd() < 0.5 ? -14 : 14}%)`
    D.wanderAnim = play(pair, kf([{ transform: 'none' }, { transform: side, offset: 0.25 }, { transform: side, offset: 0.7 }, { transform: 'none' }], 'ease-in-out'), { duration: 600, fill: 'none' })
  }
  // A look at the user takes the eyes back from a glance to the side first.
  function unwander() {
    const a = D.wanderAnim
    if (!a) return
    D.wanderAnim = null
    if (a.playState !== 'running') return
    const from = cs(pair).transform
    a.cancel()
    if (from !== 'none') slide(pair, from, 'none', { duration: 120, easing: 'ease-out' })
  }
  // Calmer, never faster (S6): every running whale animation at .85, no phase jump.
  function calm() {
    for (const el of [loop, tail, pair, move, ...eyes]) for (const a of el.getAnimations()) if (a.playbackRate === 1) a.updatePlaybackRate(0.85)
  }
  // The 10 s glance and the return glance share one budget: at most one every 20 s.
  async function glance(poses = ['loop']) {
    const now = performance.now()
    if (!playful() || !poses.includes(D.pose) || D.gazeHold || now - D.glanceAt < 20000) return
    D.glanceAt = now
    D.gazeHold = true
    unwander()
    setGaze(0, -0.3)
    for (const eye of eyes) play(eye, kf([{ transform: 'none' }, { transform: 'scaleY(.03)', offset: 1 / 3 }, { transform: 'scaleY(.03)', offset: 5 / 9 }, { transform: 'none' }], 'ease-in-out'), { duration: 360, fill: 'none' })
    await sleep(600)
    D.gazeHold = false
    applyGaze()
  }

  // ---- one-shots ----
  function nod() {
    if (!playful() || instant || ['down', 'lift', 'dive'].includes(D.pose) || D.pet || D.hop) return
    // One answer nods once, whichever listener asks first.
    if (performance.now() - D.nodAt < 150) return
    D.nodAt = performance.now()
    const a = play(move, [{ transform: 'none' }, { transform: 'translateY(2px) rotate(3deg)' }], { ...spring('tap'), fill: 'forwards' })
    setTimeout(() => {
      if (D.pet || D.hop || D.handed) return
      const from = cs(move).transform
      a.cancel()
      const b = play(move, [{ transform: from }, { transform: 'none' }], spring('shape'))
      b.done.then(() => settle(b, move))
    }, 160)
    const keep = [D.bx, D.by]
    setBase(keep[0], 0.6)
    setTimeout(() => { if (D.by === 0.6) setBase(keep[0], keep[1]) }, 300)
  }
  function hop(count) {
    const lift = `translateY(${(-8.1 * u).toFixed(2)}px) scale(.96,1.05)`
    const frames = kf([{ offset: 0, transform: 'none' }, { offset: 0.2, transform: lift }, { offset: 0.4, transform: 'translateY(0) scale(1.06,.94)' }, { offset: 0.55, transform: 'none' }, { offset: 1, transform: 'none' }], HOP)
    drop(move)
    return play(move, frames, { duration: HOP_MS, iterations: count, fill: 'none' })
  }
  function stopHop() {
    const a = D.hop
    if (!a) return
    D.hop = null
    const from = cs(move).transform
    a.cancel()
    if (from !== 'none') slide(move, from, 'none', spring('shape'))
  }
  function happyEyes(on, ms = 140) {
    eyes.forEach(eye => to(eye, { transform: on ? 'scaleY(0)' : 'none' }, { duration: ms, easing: on ? 'ease-in' : 'ease-out' }))
    happy.forEach(arc => to(arc, { opacity: on ? '1' : '0' }, { duration: 120, delay: on ? 100 : 0, easing: 'ease-out' }))
  }
  function petStart() {
    if (!playful() || !['alert', 'rest'].includes(D.pose) || D.pet || D.handed) return
    stopHop()
    D.hopsStopped = true
    leanOut()
    const lean = `translate(${(4.6 * u).toFixed(2)}px, ${(-0.58 * u).toFixed(2)}px) rotate(8deg)`
    const nuzzle = `translate(${(7.4 * u).toFixed(2)}px, ${(-1.74 * u).toFixed(2)}px) rotate(14deg) scale(1.03, .97)`
    const a = to(move, { transform: lean }, spring('pop'))
    const b = play(move, [{ transform: lean }, { transform: nuzzle, offset: 0.5 }, { transform: lean }], { duration: 780, delay: 320, iterations: Infinity, easing: 'ease-in-out', fill: 'none' })
    happyEyes(true)
    D.pet = [a, b]
  }
  function petEnd() {
    if (!D.pet) return
    const from = cs(move).transform
    for (const a of D.pet) a.cancel()
    D.pet = null
    slide(move, from, 'none', spring('pop'))
    happyEyes(false)
    leanIn()
  }
  // ---- the spout: a click on the whale ----
  // A column rises from the blowhole, opens into two curls and lifts off, and drops fall from the
  // curls back into the water, with a ripple where they land. Four clicks within 2.5 s make a
  // bigger one; a whale that is down only puffs. Reduced motion: the ^ ^ eyes only.
  const plume = $('.plume')
  const spoutEl = $('.spout')
  let clicks = []
  let happyTimer = 0
  function fallDrop(dx0, dy0, { dx, fall, delay, size = 5.5 }) {
    const el = document.createElement('span')
    el.className = 'drop'
    el.style.width = el.style.height = `${size.toFixed(1)}px`
    spoutEl.append(el)
    const a = el.animate([
      { translate: `${dx0}px ${dy0}px`, scale: '.8', opacity: 0.95 },
      { translate: `${(dx0 + dx).toFixed(1)}px ${(dy0 + fall).toFixed(1)}px`, scale: '1', opacity: 0.55 },
    ], { duration: 520 + rnd() * 120, delay, easing: 'cubic-bezier(.5,0,.9,.5)', fill: 'backwards' })
    a.finished.then(() => el.remove(), () => el.remove())
  }
  function spout({ big = false, small = false } = {}) {
    if (!plume || reduced() || instant) return
    const k = small ? 0.55 : big ? 1.35 : tier() === 'quiet' ? 0.85 : 1
    const shape = plume.cloneNode(true)
    // An SVG element has no hidden property: the attribute itself goes.
    shape.removeAttribute('hidden')
    shape.style.scale = String(k)
    spoutEl.append(shape)
    const [stem, ...curls] = shape.querySelectorAll('path')
    const rise = 'cubic-bezier(.2,.7,.4,1)'
    stem.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 170, easing: rise, fill: 'forwards' })
    stem.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }], { duration: 260, delay: 380, easing: 'ease-in', fill: 'forwards' })
    if (small) {
      for (const curl of curls) curl.remove()
      fallDrop(0, -27 * k, { dx: 3, fall: 46, delay: 300, size: 5 })
    } else {
      for (const curl of curls) {
        curl.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 200, delay: 120, easing: rise, fill: 'forwards' })
        curl.animate([{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: -0.7, opacity: 0 }], { duration: 240, delay: 420, easing: 'ease-in', fill: 'forwards' })
      }
      const per = big ? 3 : 2
      for (const side of [-1, 1]) for (let i = 0; i < per; i += 1) fallDrop(side * 18 * k, -31 * k, { dx: side * (4 + i * 5 + rnd() * 3), fall: 70 + i * 10 + rnd() * 10, delay: 330 + i * 70, size: 5 + rnd() * 1.5 })
      fallDrop(0, -38 * k, { dx: (rnd() - 0.5) * 6, fall: 80, delay: 400, size: 6 })
      // At the hand-off the dive sends the ripple; this one would land as the window grows.
      if (!D.handed) setTimeout(sendRipple, 760)
    }
    setTimeout(() => shape.remove(), 900)
  }
  function squash(big) {
    drop(body)
    const a = play(body, kf([{ scale: '1' }, { scale: big ? '1.12 .88' : '1.07 .93', offset: 0.3 }, { scale: '.96 1.05', offset: 0.62 }, { scale: '1' }], OUT), { duration: 460, fill: 'none' })
    a.done.then(() => a.cancel())
    const t = play(tail, [{ transform: 'none' }, { transform: 'rotate(12deg)' }, { transform: 'none' }], { duration: 380, easing: 'ease-in-out', fill: 'none' })
    t.done.then(() => t.cancel())
  }
  // No spout once the team is ready: the hand-off spouts by itself.
  function spoutClick() {
    if (D.handed || want.view === 'handoff' || ['dive', 'sunk', 'enter'].includes(D.pose) || D.sinking) return
    const now = performance.now()
    clicks = clicks.filter(at => now - at < 2500)
    clicks.push(now)
    if (['down', 'lift'].includes(D.pose)) { spout({ small: true }); return }
    const big = clicks.length >= 4
    if (big) clicks = []
    if (!reduced()) squash(big)
    if (!D.pet && (!root.dataset.eyes || root.dataset.eyes === 'happy')) {
      clearTimeout(happyTimer)
      const ms = big ? 900 : 480
      // Reduced motion swaps the eyes (ui-standard 9.6) and so leaves no inline transform on
      // them that would hide the heavy eyes of a failure.
      if (reduced()) {
        root.dataset.eyes = 'happy'
        happyTimer = setTimeout(() => { if (root.dataset.eyes === 'happy') delete root.dataset.eyes }, ms)
      } else {
        happyEyes(true)
        happyTimer = setTimeout(() => { if (!D.pet && !D.handed && !['down', 'lift', 'dive'].includes(D.pose)) happyEyes(false) }, ms)
      }
    }
    spout({ big })
  }
  function lookAround() {
    if (!playful()) return
    const side = v => `translateX(${v}%)`
    play(pair, kf([{ transform: 'none' }, { transform: side(-14), offset: 0.15 }, { transform: side(-14), offset: 0.4 }, { transform: side(14), offset: 0.55 }, { transform: side(14), offset: 0.85 }, { transform: 'none' }], 'ease-in-out'), { duration: 900, fill: 'none' })
  }
  function sendRipple() {
    if (!playful()) return
    play(ripple, [{ scale: '.5' }, { scale: '1.6' }], { ...spring('shape'), fill: 'none' })
    play(ripple, [{ opacity: 0.9 }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'none' })
  }

  // ---- rest on a card: lean, breath, blinks, lively hops (none in quiet, reduced or failure) ----
  const stirs = () => playful() && !failure()
  const px = v => (v * u / 0.88).toFixed(2)
  // Nose 2.5° down toward the sheet, 1.5 px forward, 1 px up (at 88 px), on .whale-loop, which
  // no loop uses while a card waits, so hops, nods and petting compose on top of it.
  const LEAN = () => `translate(${px(1.5)}px, ${px(-1)}px) rotate(2.5deg)`
  function leanAt(mine, ms) {
    D.leanDue = false
    D.leanOff = false
    D.leanMine = mine
    if (!stirs()) return
    if (instant) { D.leanDue = true; leanIn(); return }
    later(mine, ms, () => { D.leanDue = true; leanIn() })
  }
  function leanIn() {
    if (D.lean || !D.leanDue || D.leanOff || D.leanMine !== token || D.pet || D.handed || !stirs() || !['alert', 'rest'].includes(D.pose)) return
    D.lean = true
    to(loop, { transform: LEAN() }, spring('shape'))
  }
  function leanOut() {
    if (!D.lean) return
    D.lean = false
    to(loop, { transform: 'none' }, spring('shape'))
  }
  function breathe(mine) {
    if (D.breath || instant || !stirs() || D.pose !== 'rest') return
    // Compositor-only: the scale property on an HTML wrapper that nothing else scales.
    const a = gazeLayer.animate(kf([{ scale: '1' }, { scale: '1.008 1.018', offset: 0.45 }, { scale: '1' }], 'ease-in-out'), { duration: 4200, iterations: Infinity })
    D.breath = a
    const age = performance.now() - D.cardAt
    a.updatePlaybackRate(calmer(age)[0])
    const slower = () => { const rate = calmer(performance.now() - D.cardAt)[0]; if (D.breath === a && rate < a.playbackRate) a.updatePlaybackRate(rate) }
    for (const at of [30000, 90000]) if (age < at) later(mine, at - age, slower)
  }
  function stopBreath() {
    const a = D.breath
    if (!a) return
    D.breath = null
    const from = cs(gazeLayer).scale
    a.cancel()
    if (!reduced() && from !== 'none' && from !== '1') play(gazeLayer, [{ scale: from }, { scale: '1' }], { duration: 240, easing: 'ease-out', fill: 'none' })
  }
  const canBlink = () => stirs() && D.pose === 'rest' && !D.pet && !D.hop && !D.gazeHold && !D.handed && !root.dataset.eyes && !document.hidden && eyes.every(eye => !eye.style.transform && scripted(eye).length === 0)
  function blink() {
    if (!canBlink()) return
    for (const eye of eyes) {
      const a = play(eye, kf([{ transform: 'none' }, { transform: 'scaleY(.03)', offset: 0.48 }, { transform: 'scaleY(1.06)', offset: 0.78 }, { transform: 'none' }], 'ease-in-out'), { duration: 270, fill: 'none' })
      a.done.then(() => a.cancel())
    }
  }
  function blinkLater(mine, firstOne) {
    const gap = firstOne ? 1400 + 800 * rnd() : (3200 + 3600 * rnd()) * calmer(performance.now() - D.cardAt)[1]
    const double = rnd() < 0.2
    later(mine, gap, () => {
      blink()
      if (double) later(mine, 340, blink)
      blinkLater(mine, false)
    })
  }
  function resting(mine) {
    D.restMine = mine
    if (!stirs()) return
    later(mine, 600, () => breathe(mine))
    blinkLater(mine, true)
  }
  // Lively: after the two hops (starts 0 and 1.3 s), more at +2.6 s, +5.2 s, then every 9 s.
  function moreHops(mine, began) {
    let at = began + HOP_MS
    let k = 0
    const next = () => {
      at += MORE_HOPS[k] ?? HOP_EVERY
      k += 1
      later(mine, at - performance.now(), () => {
        if (D.hopsStopped || D.pose !== 'rest' || !stirs()) return
        if (D.pet || D.hop) { next(); return }
        const a = hop(1)
        D.hop = a
        a.done.then(() => { if (D.hop === a) { D.hop = null; a.cancel() } })
        next()
      })
    }
    next()
  }

  // ---- poses ----
  // A stage done: its arc fills while the whale, which stays where it is, gives a tail stroke
  // and a small surge forward. Stages done together follow each other faster.
  async function leg(i, queued) {
    D.legging = true
    clearTimeout(activeTimer)
    petEnd()
    stopHop()
    if (playful() && !instant) {
      const strokes = play(tail, [{ transform: 'none' }, { transform: 'rotate(10deg)' }, { transform: 'rotate(-10deg)' }, { transform: 'none' }], { duration: 200, iterations: 2, easing: 'ease-in-out', fill: 'none' })
      strokes.done.then(() => strokes.cancel())
      const surge = play(move, kf([{ transform: 'none' }, { transform: `translateX(${px(4)}px) rotate(-3deg)`, offset: 0.4 }, { transform: 'none' }], OUT), { duration: 420, fill: 'none' })
      surge.done.then(() => surge.cancel())
    }
    popCheck(i)
    D.at = i + 1
    await hold(performance.now() + (queued ? 200 : 360))
    D.legging = false
  }
  // Waits until `at`. Other states keep the wait, but the hand-off does not: it fills the arcs
  // left at once, and a beat in front of it would push handoffShow past the main process's
  // fallback (start-window.mjs fallbackMs).
  async function hold(at) {
    if (instant) return
    while (performance.now() < at && want.view !== 'handoff') await until(wait(at - performance.now()))
  }
  async function runLegs() {
    let ran = 0
    while (D.at < want.station && want.view !== 'handoff') {
      const i = D.at
      if (!ran) {
        // The first arc waits for the whale to surface (FIRST_ARC_MS). No loop starts for that
        // short wait: a loop's own hold would delay the arc by another 400 ms.
        const seen = i === 0 && !resume && ['boot', 'moving'].includes(want.view) ? t0 + entranceMs + FIRST_ARC_MS : 0
        await hold(Math.max(D.activeAt[i] ? D.activeAt[i] + HOLD : 0, D.loopAt ? D.loopAt + HOLD : 0, seen))
        if (want.view === 'handoff') break
      }
      await leg(i, ran > 0)
      ran += 1
    }
    // The hand-off follows at once and takes the whale down; a nod now would bring it back up.
    if (!ran || want.view === 'handoff') return
    D.loopAt = 0
    armActive()
    if (D.at <= 2 && !(D.at < 2 && want.done.includes(PHASES[D.at]))) nod()
  }
  // A failed start turns its stage's arc red; the whale's pose says the rest.
  function failStation() {
    const i = want.view === 'viewFailed' ? 2 : Math.min(D.at, Math.max(0, PHASES.indexOf(want.phase)))
    clearTimeout(activeTimer)
    if (D.checks > i) return
    D.failed = i
    setStation(i, 'failed')
  }
  async function goDown() {
    if (['down', 'lift'].includes(D.pose)) return
    stopHop()
    petEnd()
    // A spout's ^ ^ eyes give way to the heavy ones, and their timer cannot undo them.
    clearTimeout(happyTimer)
    D.pose = 'down'
    D.card = ''
    D.clockKind = ''
    // A failed import leaves the phases as they were; only a failed start crosses a station.
    if (want.view === 'failed' || want.view === 'viewFailed') failStation()
    const pose = capture()
    stopLoop()
    setBase(0.2, 0.6)
    // Reduced motion: no inline opacity on the ^ ^ arcs, which would hide them from a later
    // html[data-eyes=happy] (a celebrating hand-off after a retry).
    if (reduced()) { root.dataset.eyes = 'heavy'; return }
    happy.forEach(arc => to(arc, { opacity: '0' }, { duration: 120, easing: 'ease-out' }))
    const shape = spring('shape')
    release(pose, shape)
    eyes.forEach((eye, k) => slide(eye, pose.eyes[k], 'translateY(1.5px) scaleY(.55)', shape))
    to(body, { scale: '1' }, shape)
    await until(to(move, { transform: 'translateY(4px) rotate(4deg)' }, shape).done)
  }
  async function lift() {
    if (D.pose !== 'down') return
    D.pose = 'lift'
    setBase(0.4, -0.4)
    if (reduced()) return
    const shape = spring('shape')
    eyes.forEach(eye => to(eye, { transform: 'translateY(1px) scaleY(.8)' }, shape))
    await until(to(move, { transform: 'translateY(2px)' }, shape).done)
  }
  async function shakeOff() {
    D.pose = 'loop'
    delete root.dataset.eyes
    setBase(0, 0)
    if (D.failed !== undefined) {
      const i = D.failed
      D.failed = undefined
      setStation(i, 'pending')
      armActive()
    }
    if (reduced()) { for (const el of [move, ...eyes]) el.style.removeProperty('transform'); return }
    const shape = spring('shape')
    to(move, { transform: 'none' }, shape)
    eyes.forEach(eye => to(eye, { transform: 'none' }, shape))
    drop(body)
    const s = play(body, kf([{ scale: '1' }, { scale: '.94 1.08', offset: 0.4 }, { scale: '1.03 .97', offset: 0.75 }, { scale: '1' }], OUT), { duration: 800 })
    await s.done
    settle(s, body)
  }
  async function resetRun() {
    // A new folder or a blank team: sink, empty the ring while under, resurface. No spout while
    // the whale is under (D.sinking).
    D.sinking = true
    petEnd()
    stopHop()
    const pose = capture()
    stopLoop()
    if (!reduced()) {
      release(pose, spring('shape'))
      to(move, { transform: `translateY(${SINK}px)` }, spring('shape'))
      play(move, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })
      await wait(spring('shape').duration)
    } else await play(lane, [{ opacity: Number(cs(lane).opacity) }, { opacity: 0 }], { duration: 160 }).done
    for (let i = 0; i < 3; i += 1) setStation(i, 'pending')
    D.at = 0
    D.checks = 0
    D.failed = undefined
    D.since = [performance.now()]
    D.activeAt = []
    delete root.dataset.eyes
    for (const el of [move, body, lane, ...eyes]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('opacity'); el.style.removeProperty('scale') }
    D.sinking = false
    D.pose = 'loop'
    setBase(0, 0)
    if (!reduced()) {
      const up = play(move, [{ transform: `translateY(${SINK}px) rotate(-12deg)` }, { transform: 'none' }], { ...spring('stretch'), fill: 'none' })
      await up.done
    }
    armActive()
  }
  // Another state on the same card (a stage done, a retry that missed): the rest starts over.
  function restAgain(mine) {
    if (D.pose === 'alert' && !D.hop) D.pose = 'rest'
    if (D.pose !== 'rest' || D.restMine === mine) return
    leanAt(mine, 0)
    resting(mine)
  }
  async function cardPose() {
    const kind = want.view === 'watchdog' ? 'watchdog' : want.card
    const mine = token
    if (kind === D.card && !(want.missed && !D.missed)) { restAgain(mine); return }
    const previous = D.card
    D.card = kind
    if (kind !== D.clockKind) { D.clockKind = kind; D.cardAt = performance.now(); D.hopsStopped = false }
    if (kind === 'missing' && want.missed && !D.missed) {
      D.missed = true
      if (previous === 'missing') { lookAround(); restAgain(mine); return }
    }
    if (kind !== 'missing') D.missed = false
    if (kind === 'copying' || kind === 'newerUpdating') { stopHop(); D.pose = 'loop'; setBase(0, 0); await startLoop('working'); return }
    if (kind === 'importFailed') return goDown()
    stopHop()
    const pose = capture()
    stopLoop()
    if (!reduced()) release(pose, spring('shape'))
    setBase(0.2, 0.6)
    // Cards the user caused (picked, rejected, the stop confirmation) do not hop; they lean in
    // as the morph starts (the content veils in 70 ms later).
    const count = { recommend: 2, missing: 2, import: 2, newer: 2, watchdog: 2, importSpace: 1 }[kind] ?? 0
    if (!count || reduced()) { D.pose = 'rest'; leanAt(mine, 70); resting(mine); return }
    D.pose = 'alert'
    const began = performance.now()
    const a = hop(count)
    D.hop = a
    leanAt(mine, (count - 1) * HOP_MS + LANDED)
    await until(a.done)
    if (D.hop === a) stopHop()
    if (mine !== token) return
    D.pose = 'rest'
    resting(mine)
    if (tier() === 'lively' && count === 2) moreHops(mine, began)
  }
  async function phaseLoop() {
    stopHop()
    petEnd()
    D.card = ''
    D.clockKind = ''
    D.missed = false
    D.pose = 'loop'
    setBase(0, 0)
    if (reduced()) root.dataset.eyes = D.slow >= 2 ? 'squint' : ''
    const name = D.slow >= 2 ? 'pondering' : !first ? (D.workReady ? 'working' : '') : ({ data: 'searching', engine: 'working', team: 'sending' }[want.phase] ?? '')
    if (name) await startLoop(name)
    else if (D.loop || D.lean) { const pose = capture(); stopLoop(); release(pose, { duration: 240, easing: 'ease-out' }) }
  }
  // The hand-off, the same for every kind of start: the arcs not yet done fill at once, the ring
  // closes into one circle (html[data-ring=closed]), and the whale goes. Every path shows the
  // team window well inside the main process's fallback (start-window.mjs fallbackMs).
  async function handoff() {
    if (D.handed) return
    clearTimeout(activeTimer)
    stopHop()
    petEnd()
    for (let i = D.checks; i < 3; i += 1) popCheck(i)
    D.at = 2
    root.dataset.ring = 'closed'
    D.handed = true
    D.pose = 'dive'
    clearTimeout(happyTimer)
    applyGaze()
    const begin = performance.now()
    const at = ms => sleep(Math.max(0, begin + ms - performance.now()))
    const pose = capture()
    stopLoop()
    if (reduced()) return stillHandoff(at)
    release(pose, { duration: 200, easing: 'ease-out' })
    if (want.celebrate) return spoutHandoff(at)
    // A beat for the ring to close, then the dive: handoffShow at 220 ms.
    await at(100)
    root.dataset.exit = 'caption all'
    dive(12, DEEP(), 18, spring('tap'))
    await at(220)
    act('handoffShow')
    await at(390)
    act('handoffDone')
  }
  // A celebrating hand-off (a first start, or the first success after a failure) spouts as the
  // ring closes and dives once the column has opened: handoffShow at 720 ms.
  async function spoutHandoff(at) {
    drop(body)
    play(body, kf([{ scale: '1' }, { scale: '1.12 .88', offset: 240 / 460 }, { scale: '.93 1.09' }], OUT), { duration: 460 })
    if (playful()) { happyEyes(true); play(tail, [{ transform: 'none' }, { transform: 'rotate(12deg)' }, { transform: 'none' }], { duration: 400, easing: 'ease-in-out', fill: 'none' }) }
    spout()
    await at(160)
    root.dataset.exit = 'caption'
    await at(560)
    root.dataset.exit = 'caption all'
    dive(18, DEEP(), 24, spring('shape'))
    await at(660)
    sendRipple()
    await at(720)
    act('handoffShow')
    await at(980)
    act('handoffDone')
  }
  // Reduced motion: the arcs' .12 s fill and the closed ring are seen before the content fades;
  // the celebration is only the ^ ^ eyes.
  async function stillHandoff(at) {
    if (want.celebrate && tier() !== 'quiet') root.dataset.eyes = 'happy'
    await at(300)
    root.dataset.exit = 'caption all lane'
    await at(420)
    act('handoffShow')
    await at(440)
    act('handoffDone')
  }
  // 1.25 x the whale's height: fully under the waterline within about 200 ms, so the window
  // can grow around an empty sheet.
  const DEEP = () => Math.round(125 * u)
  function dive(dx, dy, deg, curve) {
    to(body, { scale: '1' }, curve)
    to(move, { transform: `translate(${dx}px, ${dy}px) rotate(${deg}deg)` }, curve)
    if (playful() && first) play(tail, [{ transform: 'none' }, { transform: 'rotate(-12deg)', offset: 0.48 }, { transform: 'none' }], { duration: 420, easing: 'ease-out', fill: 'none' })
  }

  // ---- pointer and keyboard focus ----
  let pointer = null
  let focused = null
  let keyboard = false
  let frame = 0
  function setGaze(gx, gy) {
    x.style.setProperty('--gx', gx.toFixed(3))
    x.style.setProperty('--gy', gy.toFixed(3))
  }
  // The eyes look at the pointer, or at a control that keyboard focus reached, until the next
  // pointer move. The whale's hit box shrinks and rises with the pond when a card comes, so it is
  // measured each time.
  function applyGaze() {
    frame = 0
    if (reduced()) return setGaze(0, 0)
    let gx = D.bx
    let gy = D.by
    const control = focused && focused === document.activeElement && focused.checkVisibility() ? focused.getBoundingClientRect() : null
    const target = control ? { x: control.left + control.width / 2, y: control.top + control.height / 2 } : pointer
    if (target && playful() && !D.gazeHold && !D.handed && !failure() && !['down', 'lift', 'dive'].includes(D.pose)) {
      const rect = hit.getBoundingClientRect()
      gx = clamp((target.x - (rect.left + rect.width / 2)) / 160)
      gy = clamp((target.y - (rect.top + rect.height / 2)) / 160)
    }
    setGaze(gx, gy)
  }
  function setBase(bx, by) { D.bx = bx; D.by = by; applyGaze() }
  window.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY }; focused = null; frame ||= requestAnimationFrame(applyGaze) }, { passive: true })
  root.addEventListener('pointerleave', () => { pointer = null; applyGaze() })
  hit.addEventListener('pointerenter', petStart)
  hit.addEventListener('pointerleave', petEnd)
  hit.addEventListener('click', spoutClick)
  // Keyboard focus only: the card's own focus move after a pointer answer is not followed.
  window.addEventListener('keydown', () => { keyboard = true }, true)
  window.addEventListener('pointerdown', () => { keyboard = false }, true)
  document.addEventListener('focusin', (event) => {
    const el = event.target
    if (!keyboard || !el.matches?.('button, input[type=checkbox]') || !el.closest('.sheet, .caption') || !el.matches(':focus-visible')) return
    focused = el
    applyGaze()
  })

  // ---- answering a card: press anticipation, nod, lean released ----
  const answering = target => { const button = target?.closest?.('.card button[data-act]'); return button && !LOCAL.has(button.dataset.act) ? button : null }
  function unpress() {
    const button = D.press
    if (!button) return
    D.press = null
    button.removeEventListener('pointerleave', unpress)
    to(body, { scale: '1' }, spring('tap'))
  }
  document.addEventListener('pointerdown', (event) => {
    const button = answering(event.target)
    if (!button || event.button !== 0 || instant || !stirs() || D.handed || D.legging || ['down', 'lift', 'dive', 'sunk', 'enter'].includes(D.pose)) return
    unpress()
    D.press = button
    button.addEventListener('pointerleave', unpress)
    to(body, { scale: '1.03 .97' }, { duration: 120, easing: OUT })
  })
  document.addEventListener('pointercancel', unpress)
  // A press that ends without a click (the button went away under it) springs back too.
  document.addEventListener('pointerup', () => { if (D.press) setTimeout(unpress, 0) })
  // Capture phase: this runs before start.js sends the act, so a state that the act brings
  // drops the lean's return timer with the old token. The act itself is never delayed.
  document.addEventListener('click', (event) => {
    const button = answering(event.target)
    if (!button) return
    unpress()
    if (!stirs()) return
    const mine = token
    D.hopsStopped = true
    D.leanOff = true
    leanOut()
    // A card that stays (a model picked on the import card, logs opened) leans in again.
    later(mine, 1000, () => { D.leanOff = false; leanIn() })
    nod()
  }, true)

  // ---- coming back to the window: one glance at the user ----
  let blurAt = 0
  let hiddenAt = 0
  function returnGlance(since) {
    if (!since || performance.now() - since < 5000) return
    if (!stirs() || D.legging || D.handed || D.hop || D.pet) return
    glance(['loop', 'rest'])
  }
  window.addEventListener('blur', () => { blurAt = performance.now() })
  window.addEventListener('focus', () => { returnGlance(blurAt); blurAt = 0 })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = performance.now(); return }
    returnGlance(hiddenAt)
    hiddenAt = 0
  })

  // ---- reconcile ----
  async function step() {
    await entered
    if (want.view === 'handoff') return handoff()
    if (D.pose === 'enter') { D.pose = 'loop'; armActive() }
    if (D.over || want.station < D.checks) { D.over = false; await resetRun() }
    if (!failure() && ['down', 'lift', 'redo'].includes(D.pose)) await shakeOff()
    await runLegs()
    if (want.view === 'handoff') return handoff()
    if (failure()) {
      if (D.pose === 'redo') D.pose = 'loop'
      await goDown()
      if (['available', 'downloading', 'installing'].includes(want.update)) await lift()
      else if (want.update === 'failed' && D.pose === 'lift') { D.pose = 'loop'; await goDown() }
      return
    }
    if (want.view === 'card' || want.view === 'watchdog') return cardPose()
    return phaseLoop()
  }
  // A resumed page shows the arcs it catches up on without drawing them (start.css
  // html[data-resume]); once that has been painted, later arcs draw again.
  const caughtUp = () => requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.resume))
  let pumping = false
  let again = false
  function kick() {
    again = true
    if (pumping) return
    pumping = true
    ;(async () => {
      try {
        while (again) { again = false; await step(); if (instant) caughtUp(); instant = false }
      } catch (error) { console.error(error) } finally { pumping = false; instant = false }
    })()
  }

  return {
    update(s) {
      const done = s.done ?? []
      const now = performance.now()
      if (done.includes('data') && !want.done.includes('data')) D.since[1] = now
      if (done.includes('engine') && !want.done.includes('engine')) D.since[2] = now
      let station = 0
      if (done.includes('data')) station = done.includes('engine') ? 2 : 1
      const next = { station, view: s.view, phase: s.phase, done, card: s.card?.kind ?? '', missed: Boolean(s.card?.missedRetry), celebrate: Boolean(s.celebrate), update: s.update?.state ?? '' }
      // Stages taken back mean a start in another folder: the whale starts over even when the
      // next snapshot, a moment later, has the first stage done again.
      if (D.started && station < want.station) D.over = true
      const changed = !D.started || ['station', 'view', 'phase', 'card', 'missed', 'update'].some(key => next[key] !== want[key])
      want = next
      D.started = true
      if (changed) { bump(); kick() }
    },
    slow(level) {
      if (level === D.slow) return
      const previous = D.slow
      D.slow = level
      if (level === 0) {
        D.glanced = false
        for (const el of [loop, tail, pair, move, ...eyes]) for (const a of el.getAnimations()) if (a.playbackRate !== 1) a.updatePlaybackRate(1)
      }
      if (level === 1) { calm(); if (!D.glanced) { D.glanced = true; glance() } }
      if (level === 2 || previous === 2) { bump(); kick() }
    },
    nod,
    // Live switch of reduced motion or of the tier: running one-shots jump to their end.
    refresh() {
      stopBreath()
      D.press = null
      for (const el of [body, move, loop, tail, pair, lane, ripple, ...eyes, ...happy]) for (const a of scripted(el)) settle(a, el)
      D.hop = null
      D.pet = null
      D.lean = false
      if (reduced()) {
        for (const el of [gazeLayer, body, move, loop, ...eyes, ...happy]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('scale'); el.style.removeProperty('opacity') }
        root.dataset.eyes = ['down', 'lift'].includes(D.pose) ? 'heavy' : D.slow >= 2 ? 'squint' : ''
        applyGaze()
        return
      }
      delete root.dataset.eyes
      if (['down', 'lift'].includes(D.pose)) D.pose = 'redo'
      D.loop = ''
      D.card = ''
      bump()
      kick()
    },
  }
}
