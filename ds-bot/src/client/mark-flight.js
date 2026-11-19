// The Bot's mark between the details page and the panel's strip. When the details page
// gives way to the browser or a side chat, its avatar flies up into the strip's Bot tab;
// when the details page returns, it flies back down. browser-pane.js decides when;
// this file owns how: which mark is which, where the flying copy is at each frame, and
// that nothing of it is left behind.

// Where the mark stands at each end, found from the panel. The flight is named by the
// end it flies to. The fading copy of the view that is leaving is not a place to land.
export const FLIGHT_ENDS = { tab: ':scope > .bt-ptabs .bt-ptab-bot .bt-mark', drawer: ':scope > .bt-panel-view .bt-drawer-id .bt-mark' }

// A switch to `next` flies the mark to the strip, or to the drawer when the details
// page comes back, and takes off from the other end.
export const flightEnd = next => (next === 'details' ? 'drawer' : 'tab')
export const flightStart = next => (next === 'details' ? 'tab' : 'drawer')

// A switch's note is good for this long: the view has to change within it, or the
// note was for a switch that never happened.
export const INTENT_MS = 1500
// A flight whose frames never come (a hidden window) still ends this much after its glide.
const SAFETY_MS = 400

/**
 * What a switch to `next` does with the flight that is under way, if any.
 * @param {'tab'|'drawer'|null} active - the end the flying mark is heading for now
 * @param {string} next - the view the panel switches to
 * @returns {'start'|'keep'|'reverse'} `start`: take off from the end the switch leaves;
 *   `keep`: the mark is already heading where this switch wants it;
 *   `reverse`: turn the flying mark round from where it is
 */
export function planFlight(active, next) {
  if (active === null) return 'start'
  return active === flightEnd(next) ? 'keep' : 'reverse'
}

/**
 * The mark's box at progress `p` of its way from `from` to `to`. `to` is where the
 * target stands in this very frame, so a target that moves meanwhile is still met.
 * @param {{left: number, top: number, width: number, height: number}} from
 * @param {{left: number, top: number, width: number, height: number}} to
 * @param {number} p - 0 at take-off, 1 at landing; a spring may pass 1 a little
 */
export function flightBox(from, to, p) {
  const mix = key => from[key] + (to[key] - from[key]) * p
  return { left: mix('left'), top: mix('top'), width: mix('width'), height: mix('height') }
}

const boxOf = rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

let serial = 0
/**
 * Give every id under `root` (and `root` itself) a name no other copy has, and point what
 * refers to it — `url(#id)` in any attribute, `href="#id"` — at the new name. An SVG
 * mask or gradient is found by id across the whole document, so a copy that keeps its ids
 * draws with whichever twin comes first, and draws nothing when that one is hidden.
 * @template {Element} T
 * @param {T} root
 * @returns {T} `root`
 */
export function uniqueIds(root) {
  const suffix = `-f${++serial}`
  const renamed = new Map()
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    if (node.id === '') continue
    renamed.set(node.id, `${node.id}${suffix}`)
    node.id = renamed.get(node.id)
  }
  if (renamed.size === 0) return root
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const { name, value } of node.attributes) {
      let next = value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (whole, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : whole))
      if ((name === 'href' || name === 'xlink:href') && next.startsWith('#') && renamed.has(next.slice(1))) next = `#${renamed.get(next.slice(1))}`
      if (next !== value) node.setAttribute(name, next)
    }
  }
  return root
}

/**
 * One flying copy of the mark at a time. It lives inside the panel (so the panel's edge
 * clips it, and it goes with the panel when that slides away), and each frame it is
 * placed between where it took off and where its target stands that frame. Whatever the
 * panel does meanwhile — settle to a new width, fold, reflow in a narrow window — the
 * copy lands on the mark that is really there, or is gone when that mark is.
 *
 * `begin` takes the copy's node and the viewport box it takes off from. While the flight
 * is on, the panel carries `data-flying="<end>"`, which hides the real mark at that end
 * (browser-pane.js styles it); every way out of the flight clears it.
 * @param {{shape: {duration: number, progress: (ms: number) => number},
 *   frame?: (run: (now: number) => void) => unknown, unframe?: (id: unknown) => void,
 *   later?: (run: () => void, ms: number) => unknown, unlater?: (id: unknown) => void}} env
 *   `shape` is the glide's spring (motion.js); the rest are the browser's timers, swapped in tests.
 */
export function createFlight(env) {
  const {
    shape,
    frame = run => requestAnimationFrame(run), unframe = id => cancelAnimationFrame(id),
    later = (run, ms) => setTimeout(run, ms), unlater = id => clearTimeout(id),
  } = env
  let live = null

  function finish() {
    if (live === null) return
    const { panel, node, step, safety } = live
    live = null
    if (step !== null) unframe(step)
    unlater(safety)
    node.remove()
    delete panel.dataset.flying
  }

  // `now` is the frame's time, null for the placing that comes with take-off.
  function place(now) {
    const { panel, node, end, from, size } = live
    live.step = null
    const target = panel.isConnected ? panel.querySelector(FLIGHT_ENDS[end]) : null
    const to = target?.getBoundingClientRect()
    // Its target is gone (the panel folded, the view changed under it): nothing to land on.
    if (to === undefined || to.width === 0) { finish(); return }
    // The glide's clock starts with the first frame after take-off: the frame the panel's own
    // transitions start in, so the copy and the panel's edge keep the same time.
    if (live.at === null && now !== null) live.at = now
    const elapsed = live.at === null ? 0 : now - live.at
    const done = elapsed >= shape.duration
    const box = flightBox(from, boxOf(to), done ? 1 : shape.progress(elapsed))
    // The copy is placed from the panel's padding edge, inside its border.
    const edge = panel.getBoundingClientRect()
    const border = panel.ownerDocument.defaultView.getComputedStyle(panel)
    const x = box.left - edge.left - (parseFloat(border.borderLeftWidth) || 0)
    const y = box.top - edge.top - (parseFloat(border.borderTopWidth) || 0)
    node.style.transform = `translate(${x}px, ${y}px) scale(${box.width / size.width}, ${box.height / size.height})`
    // Landing and showing the real mark happen in one frame: the copy goes with the last placement.
    if (done) finish()
    else live.step = frame(place)
  }

  const arm = () => later(finish, shape.duration + SAFETY_MS)

  return {
    /** The end the flying mark is heading for, or null with no flight. */
    active: () => live?.end ?? null,
    finish,
    /**
     * Take off. Whatever flew before ends first.
     * @param {{panel: Element, end: 'tab'|'drawer', node: Element, from: {left: number, top: number, width: number, height: number}}} flight
     * @returns {boolean} false when there is nothing to fly (a mark without a box)
     */
    begin({ panel, end, node, from }) {
      finish()
      if (!(from.width > 0 && from.height > 0)) return false
      node.classList.add('bt-mark-fly')
      Object.assign(node.style, { width: `${from.width}px`, height: `${from.height}px` })
      panel.append(node)
      panel.dataset.flying = end
      live = { panel, node, end, from: boxOf(from), size: { width: from.width, height: from.height }, at: null, step: null, safety: arm() }
      place(null)
      return true
    },
    /**
     * Turn the mark that is flying round, from where it is now toward the other end.
     * @returns {boolean} false when no flight was on
     */
    retarget(end) {
      if (live === null) return false
      live.from = boxOf(live.node.getBoundingClientRect())
      live.end = end
      live.at = null
      live.panel.dataset.flying = end
      unlater(live.safety)
      live.safety = arm()
      return true
    },
  }
}
