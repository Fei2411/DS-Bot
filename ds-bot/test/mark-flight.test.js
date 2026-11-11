import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { FLIGHT_ENDS, createFlight, flightBox, flightEnd, flightStart, planFlight, uniqueIds } from '../src/client/mark-flight.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })

// The Bot's mark flies between the details page and the strip's Bot tab. These
// pin the parts that went wrong in the app: which switch flies, where the copy is each
// frame, and that nothing of the copy or the hiding is left once the flight is over.
test('a switch names the ends of its flight', () => {
  assert.equal(flightEnd('browser'), 'tab')
  assert.equal(flightEnd('side'), 'tab')
  assert.equal(flightEnd('details'), 'drawer')
  assert.equal(flightStart('browser'), 'drawer')
  assert.equal(flightStart('side'), 'drawer')
  assert.equal(flightStart('details'), 'tab')
})

test('a switch during a flight keeps it, turns it round, or starts one', () => {
  assert.equal(planFlight(null, 'browser'), 'start')
  assert.equal(planFlight(null, 'details'), 'start')
  // Heading for the strip already: another switch away from details changes nothing.
  assert.equal(planFlight('tab', 'side'), 'keep')
  assert.equal(planFlight('tab', 'browser'), 'keep')
  assert.equal(planFlight('drawer', 'details'), 'keep')
  // Going back the way it came.
  assert.equal(planFlight('tab', 'details'), 'reverse')
  assert.equal(planFlight('drawer', 'browser'), 'reverse')
  assert.equal(planFlight('drawer', 'side'), 'reverse')
})

test('the copy goes from the take-off box to the target box', () => {
  const from = box(100, 100, 36, 36)
  const to = box(10, 12, 20, 20)
  assert.deepEqual(flightBox(from, to, 0), { left: 100, top: 100, width: 36, height: 36 })
  assert.deepEqual(flightBox(from, to, 1), { left: 10, top: 12, width: 20, height: 20 })
  assert.deepEqual(flightBox(from, to, 0.5), { left: 55, top: 56, width: 28, height: 28 })
  // A spring may pass the target a little before it settles.
  assert.equal(flightBox(from, to, 1.02).left < 10, true)
})

test('a copy gets ids of its own, and what points at them follows', () => {
  const { document } = new JSDOM(`<!doctype html><body><span id="mark"><svg>
    <defs><mask id="m1"><rect/></mask><linearGradient id="g1"/></defs>
    <g mask="url(#m1)"><use href="#g1"/><path fill="url( #g1 )" style="stroke:url(#other)"/></g>
    <use xlink:href="#m1"/>
  </svg></span></body>`).window
  const original = document.getElementById('mark')
  const before = original.outerHTML
  const copy = uniqueIds(original.cloneNode(true))
  assert.equal(original.outerHTML, before)
  assert.notEqual(copy.id, 'mark')
  const mask = copy.querySelector('mask')
  const gradient = copy.querySelector('linearGradient')
  assert.notEqual(mask.id, 'm1')
  assert.notEqual(gradient.id, 'g1')
  assert.equal(copy.querySelector('g').getAttribute('mask'), `url(#${mask.id})`)
  assert.equal(copy.querySelector('use').getAttribute('href'), `#${gradient.id}`)
  assert.equal(copy.querySelector('path').getAttribute('fill'), `url(#${gradient.id})`)
  // An id the copy does not define is not its to rename.
  assert.equal(copy.querySelector('path').getAttribute('style'), 'stroke:url(#other)')
  assert.equal(copy.querySelectorAll('use')[1].getAttribute('xlink:href'), `#${mask.id}`)
  // Two copies of the same mark never share an id.
  const second = uniqueIds(original.cloneNode(true))
  assert.notEqual(second.querySelector('mask').id, mask.id)
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('a spring shape reads as a curve a script can follow', async () => {
  const bundle = await build({
    stdin: { contents: "export { SPRING_SHAPE } from './src/client/motion.js'", resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => new Proxy({}, { get: () => () => ({}) }) })
  const { SPRING_SHAPE: shape } = module.exports
  assert.equal(shape.progress(0), 0)
  assert.equal(shape.progress(-5), 0)
  assert.equal(shape.progress(shape.duration), 1)
  assert.equal(shape.progress(shape.duration * 3), 1)
  const mid = shape.progress(shape.duration / 4)
  assert.equal(mid > 0 && mid < 1.1, true)
})

// A panel with a strip tab and a drawer avatar, a clock and frame queue the test drives.
function rig() {
  const { window } = new JSDOM(`<!doctype html><body><aside class="bt-panel">
    <div class="bt-ptabs"><div class="bt-ptabs-in"><button class="bt-ptab bt-ptab-bot"><span class="bt-mark" id="tab"></span></button></div></div>
    <div class="bt-panel-view"><div class="bt-drawer-id"><span class="bt-mark" id="drawer"></span></div></div>
    <div class="bt-panel-ghost"><div class="bt-panel-view"><div class="bt-drawer-id"><span class="bt-mark" id="ghost"></span></div></div></div>
  </aside></body>`)
  const { document } = window
  const panel = document.querySelector('aside')
  const place = (node, rect) => { node.getBoundingClientRect = () => rect }
  place(panel, box(1000, 0, 320, 800))
  const tab = document.getElementById('tab')
  const drawer = document.getElementById('drawer')
  place(tab, box(1012, 12, 20, 20))
  place(drawer, box(1150, 110, 36, 36))
  let serial = 0
  let clock = 0
  const frames = new Map()
  const timers = new Map()
  const flight = createFlight({
    shape: { duration: 100, progress: ms => Math.min(1, Math.max(0, ms / 100)) },
    frame: (run) => { frames.set(++serial, run); return serial },
    unframe: id => frames.delete(id),
    later: (run, ms) => { timers.set(++serial, { run, at: clock + ms }); return serial },
    unlater: id => timers.delete(id),
  })
  const mark = () => { const node = document.createElement('span'); node.className = 'bt-mark'; return node }
  return {
    document, panel, tab, drawer, flight, place, mark, frames, timers,
    // Run the frame that is waiting, at time `ms`. The first frame after take-off starts the glide.
    frame(ms) { clock = ms; const run = [...frames.values()]; frames.clear(); for (const step of run) step(ms) },
    // Move the clock to `ms` and fire the timers that are due.
    fire(ms) { clock = ms; for (const [id, timer] of Array.from(timers)) if (timer.at <= clock) { timers.delete(id); timer.run() } },
    clones: () => document.querySelectorAll('.bt-mark-fly'),
  }
}

test('the copy takes off from its box, lands on the target and leaves nothing behind', () => {
  const r = rig()
  const node = r.mark()
  assert.equal(r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) }), true)
  assert.equal(r.flight.active(), 'tab')
  assert.equal(node.parentNode, r.panel)
  assert.equal(r.panel.dataset.flying, 'tab')
  // Placed at once, from the panel's own corner: 1150 - 1000, 110 - 0.
  assert.equal(node.style.transform, 'translate(150px, 110px) scale(1, 1)')
  assert.equal(node.style.width, '36px')
  // The first frame after take-off starts the glide's clock.
  r.frame(1000)
  assert.equal(node.style.transform, 'translate(150px, 110px) scale(1, 1)')
  r.frame(1050)
  // Half way between the take-off box (1150, 110) and the tab (1012, 12), from the panel's corner.
  assert.equal(node.style.transform, `translate(81px, 61px) scale(${28 / 36}, ${28 / 36})`)
  assert.equal(r.panel.dataset.flying, 'tab')
  r.frame(1100)
  // Landing and showing the real mark are one step.
  assert.equal(node.style.transform, 'translate(12px, 12px) scale(0.5555555555555556, 0.5555555555555556)')
  assert.equal(node.isConnected, false)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.flight.active(), null)
  assert.equal(r.frames.size, 0)
  assert.equal(r.timers.size, 0)
})

test('a target that moves while the copy flies is still met', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.frame(0)
  r.frame(50)
  // The panel settles to a new width: the tab ends up 200px to the left of where it stood.
  r.place(r.tab, box(812, 12, 20, 20))
  r.place(r.panel, box(800, 0, 520, 800))
  r.frame(100)
  assert.equal(node.style.transform, 'translate(12px, 12px) scale(0.5555555555555556, 0.5555555555555556)')
  assert.equal(r.flight.active(), null)
})

test('the copy ends when its target is gone', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.frame(0)
  r.frame(30)
  assert.equal(r.clones().length, 1)
  // The strip folds away mid-flight.
  r.tab.remove()
  r.frame(60)
  assert.equal(r.clones().length, 0)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.flight.active(), null)
  assert.equal(r.frames.size, 0)
})

test('the copy ends when its target has no size', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.place(r.tab, box(0, 0, 0, 0))
  r.frame(30)
  assert.equal(node.isConnected, false)
  assert.equal(r.panel.dataset.flying, undefined)
})

test('the copy lands on the drawer avatar and not on its fading twin in the ghost', () => {
  const r = rig()
  const ghost = r.document.getElementById('ghost')
  r.place(ghost, box(1150, 400, 36, 36))
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'drawer', node, from: box(1012, 12, 20, 20) })
  r.frame(0)
  r.frame(100)
  assert.equal(node.style.transform, 'translate(150px, 110px) scale(1.8, 1.8)')
  assert.equal(r.panel.querySelector(FLIGHT_ENDS.drawer), r.drawer)
  assert.equal(r.panel.querySelector(FLIGHT_ENDS.tab), r.tab)
})

test('turning the flight round starts from where the copy is', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.frame(0)
  r.frame(50)
  node.getBoundingClientRect = () => box(1055, 56, 28, 28)
  assert.equal(r.flight.retarget('drawer'), true)
  assert.equal(r.flight.active(), 'drawer')
  assert.equal(r.panel.dataset.flying, 'drawer')
  // The turn starts where the copy is: its first frame changes nothing.
  r.frame(60)
  assert.equal(node.style.transform, `translate(55px, 56px) scale(${28 / 36}, ${28 / 36})`)
  r.frame(110)
  // Half way from the mid-air box (1055, 56, 28) toward the drawer (1150, 110, 36).
  assert.equal(node.style.transform, `translate(102.5px, 83px) scale(${32 / 36}, ${32 / 36})`)
  r.frame(160)
  assert.equal(node.style.transform, 'translate(150px, 110px) scale(1, 1)')
  assert.equal(r.flight.active(), null)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.clones().length, 0)
})

test('a new flight ends the one in the air: never two copies', () => {
  const r = rig()
  const first = r.mark()
  const second = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node: first, from: box(1150, 110, 36, 36) })
  r.frame(0)
  r.frame(20)
  r.flight.begin({ panel: r.panel, end: 'tab', node: second, from: box(1150, 110, 36, 36) })
  assert.equal(first.isConnected, false)
  assert.equal(second.isConnected, true)
  assert.equal(r.clones().length, 1)
  assert.equal(r.frames.size, 1)
  assert.equal(r.timers.size, 1)
  r.frame(200)
  r.frame(400)
  assert.equal(r.clones().length, 0)
})

test('finishing is safe to repeat and clears the hiding at once', () => {
  const r = rig()
  assert.doesNotThrow(() => r.flight.finish())
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.flight.finish()
  r.flight.finish()
  assert.equal(node.isConnected, false)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.frames.size, 0)
  assert.equal(r.timers.size, 0)
  assert.equal(r.flight.active(), null)
  assert.equal(r.flight.retarget('drawer'), false)
})

test('a mark with no box has nothing to fly', () => {
  const r = rig()
  const node = r.mark()
  assert.equal(r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(0, 0, 0, 0) }), false)
  assert.equal(r.clones().length, 0)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.flight.active(), null)
})

test('a window that draws no frames still gets the mark back', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.fire(100)
  assert.equal(r.clones().length, 1)
  r.fire(600)
  assert.equal(r.clones().length, 0)
  assert.equal(r.panel.dataset.flying, undefined)
  assert.equal(r.flight.active(), null)
})

test('a panel that is gone ends the flight', () => {
  const r = rig()
  const node = r.mark()
  r.flight.begin({ panel: r.panel, end: 'tab', node, from: box(1150, 110, 36, 36) })
  r.panel.remove()
  r.frame(40)
  assert.equal(r.flight.active(), null)
  assert.equal(r.frames.size, 0)
  assert.equal(r.timers.size, 0)
})
