// Eyes. The eyes carry most of a character's feeling, so each expression is a shape
// for each eye, drawn in the eye's own box: x across the face, y down, in the units of
// the mark's 100-unit box. W and H are the eye's neutral width and height at that spot
// (a capsule W wide and H tall), already shrunk by how far the spot turns away.
//
// Two kinds of shape:
// - capsule: the neutral eye, resized and cut by an upper and a lower lid. A lid meets
//   the eye in a rounded corner, so a lidded eye stays soft and never turns into a
//   box. Any two capsules blend, so neutral → focused → sleepy is one smooth change.
// - stroke: a curve with round ends (closed happy eyes, closed sleeping eyes, a cross).
//   A change to or from a stroke happens behind a blink.

// Lid tilt is in degrees: positive raises the eye's inner corner (worried), negative
// lowers it (determined). `top`/`bottom` are how much of the eye a lid covers.
// `bottomCurve` bows the lower lid up in the middle, the shape of smiling eyes.
const CAPSULE = { kind: 'capsule', w: 1, h: 1, dx: 0, dy: 0, top: 0, topTilt: 0, bottom: 0, bottomTilt: 0, bottomCurve: 0 }

const eye = shape => ({ ...CAPSULE, ...shape })
const both = shape => [eye(shape), eye(shape)]

export const FACES = {
  neutral: both({}),
  // Attention: a little bigger, as when someone looks up at you.
  wide: both({ w: 1.1, h: 1.12 }),
  // Surprise pops wider still; the engine plays it short.
  surprised: both({ w: 1.2, h: 1.2 }),
  // Calm concentration: the upper lids come down to a level line.
  focus: both({ top: 0.3, h: 0.98 }),
  // Pondering: lower lids raised, the far eye a touch narrower.
  think: [eye({ bottom: 0.2, bottomTilt: 8, top: 0.06 }), eye({ bottom: 0.26, bottomTilt: 8, top: 0.16 })],
  // Inspecting something: one eye opens, the other narrows.
  curious: [eye({ w: 1.08, h: 1.1 }), eye({ w: 0.92, h: 0.86, top: 0.18, topTilt: -8 })],
  // At ease: softer, shorter eyes that sit a little low, the lower lids bowed up.
  content: both({ w: 1.08, h: 0.7, dy: 0.08, bottom: 0.08, bottomCurve: 0.06 }),
  // Drowsy: heavy lids that droop to the outside.
  sleepy: both({ top: 0.58, topTilt: 10 }),
  // Sorry or unsure: the inner corners rise.
  worried: both({ top: 0.24, topTilt: 18, h: 0.95 }),
  // Set on a task: the inner corners drop.
  determined: both({ top: 0.28, topTilt: -16 }),
  // Closed and happy: upturned arcs.
  happy: [{ kind: 'stroke', curve: 'arch' }, { kind: 'stroke', curve: 'arch' }],
  // Closed and at rest: gentle downturned arcs.
  asleep: [{ kind: 'stroke', curve: 'rest' }, { kind: 'stroke', curve: 'rest' }],
  wink: [{ kind: 'stroke', curve: 'arch' }, eye({ w: 1.04, h: 1.04 })],
  // Pretending to sleep: one eye open a crack.
  peek: [{ kind: 'stroke', curve: 'rest' }, eye({ w: 0.96, top: 0.46, topTilt: 4, bottom: 0.06, bottomCurve: 0.03 })],
  dizzy: [{ kind: 'stroke', curve: 'cross' }, { kind: 'stroke', curve: 'cross' }],
}
export const FACE_NAMES = Object.keys(FACES)

const lerp = (a, b, t) => a + (b - a) * t
// Two eye shapes blended by t; only capsules blend, a stroke swaps at the midpoint.
export function mixEye(a, b, t) {
  if (t <= 0) return a
  if (t >= 1) return b
  if (a.kind !== 'capsule' || b.kind !== 'capsule') return t < 0.5 ? a : b
  const out = { kind: 'capsule' }
  for (const key of Object.keys(CAPSULE)) if (key !== 'kind') out[key] = lerp(a[key], b[key], t)
  return out
}
export const blendable = (a, b) => a.every((shape, index) => shape.kind === 'capsule' && b[index].kind === 'capsule')

// Points per cap, and per straight side, of the neutral eye.
const CAP_POINTS = 16
const SIDE_POINTS = 8

// A capsule outline W wide and H tall around (0, 0), as [x0, y0, x1, y1, ...].
function capsule(W, H) {
  const r = W / 2
  const a = Math.max(0, H / 2 - r)
  const ry = Math.min(r, H / 2)
  const points = []
  // Top cap (left to right), right side down, bottom cap (right to left), left side up.
  for (let i = 0; i <= CAP_POINTS; i += 1) {
    const angle = Math.PI + (Math.PI * i) / CAP_POINTS
    points.push(Math.cos(angle) * r, -a + Math.sin(angle) * ry)
  }
  for (let i = 1; i < SIDE_POINTS; i += 1) points.push(r, -a + (2 * a * i) / SIDE_POINTS)
  for (let i = 0; i <= CAP_POINTS; i += 1) {
    const angle = (Math.PI * i) / CAP_POINTS
    points.push(Math.cos(angle) * r, a + Math.sin(angle) * ry)
  }
  for (let i = 1; i < SIDE_POINTS; i += 1) points.push(-r, a - (2 * a * i) / SIDE_POINTS)
  return points
}

// A lidded eye is the capsule and its lids as one distance (negative inside), joined
// with rounded corners, and traced along rays from its middle in EYE_POINTS points. A
// lid never cuts a square corner, and where lids close in on a side the eye narrows to
// a round end instead of folding. A corner's rounding is as deep as its lid cuts, up to
// LID_ROUND eye widths: a lid that only just comes down rounds by as little, so an eye
// gains its lids smoothly from the plain capsule.
const LID_ROUND = 0.6
const EYE_POINTS = 56
function liddedEye(w, h, top, bottom) {
  const r = w / 2
  const a = Math.max(0, h / 2 - r)
  const ry = Math.min(r, h / 2)
  // How far each lid comes into the eye at its deepest, across the eye's width.
  const deepest = lid => [-r, 0, r].map(x => lid.at(x))
  const kTop = top ? Math.min(LID_ROUND * w, Math.max(0, Math.max(...deepest(top)) + h / 2)) : 0
  const kBottom = bottom ? Math.min(LID_ROUND * w, Math.max(0, h / 2 - Math.min(...deepest(bottom)))) : 0
  const body = (x, y) => (a > 0 ? Math.hypot(x, Math.max(Math.abs(y) - a, 0)) - r : (Math.hypot(x / r, y / ry) - 1) * ry)
  const inside = (x, y) => {
    let d = body(x, y)
    if (top) d = smoothMax(d, top.distance(x, y, 1), kTop)
    if (bottom) d = smoothMax(d, bottom.distance(x, y, -1), kBottom)
    return d
  }
  const upper = top ? Math.max(-h / 2, top.at(0)) : -h / 2
  const lower = bottom ? Math.min(h / 2, bottom.at(0)) : h / 2
  const cy = (upper + lower) / 2
  const reach = Math.hypot(w, h)
  const points = []
  for (let i = 0; i < EYE_POINTS; i += 1) {
    const angle = Math.PI + (2 * Math.PI * i) / EYE_POINTS
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const t = edgeAlong(s => inside(dx * s, cy + dy * s), reach)
    points.push(dx * t, cy + dy * t)
  }
  return points
}
// Where a distance along a ray from inside (at 0) crosses zero before `reach`
// (regula falsi, Illinois).
function edgeAlong(f, reach) {
  let lo = 0, hi = reach
  let flo = f(lo), fhi = f(hi)
  if (flo >= 0) return 0
  let t = hi
  let last = 0
  for (let i = 0; i < 24; i += 1) {
    t = (lo * fhi - hi * flo) / (fhi - flo)
    const ft = f(t)
    if (Math.abs(ft) < 1e-4) break
    if (ft < 0) { lo = t; flo = ft; if (last < 0) fhi /= 2; last = -1 }
    else { hi = t; fhi = ft; if (last > 0) flo /= 2; last = 1 }
  }
  return t
}

// A lid: its height `at(x)` (y down) across a `width` wide eye, a line through y0 or,
// with `bow`, a curve that rises by `bow` at the middle; and the distance of a point
// from it, negative on the eye's side (`side` 1 for the upper lid, -1 for the lower).
function lidOf(y0, slope, bow, width) {
  const at = (x) => {
    const k = (2 * x) / width
    return y0 + slope * x - bow * Math.max(0, 1 - k * k)
  }
  const tilt = (x) => {
    const k = (2 * x) / width
    return slope + (Math.abs(k) < 1 ? (8 * bow * x) / (width * width) : 0)
  }
  return { at, distance: (x, y, side) => (side * (at(x) - y)) / Math.hypot(1, tilt(x)) }
}

// The larger of a and b, rounded over k (a quadratic blend).
function smoothMax(a, b, k) {
  if (k <= 0) return Math.max(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.max(a, b) + (h * h * k) / 4
}

// A curve as a filled stroke with round ends.
function stroke(centerline, width, out) {
  const n = centerline.length / 2
  const left = []
  const right = []
  const half = width / 2
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 1)
    const i1 = Math.min(n - 1, i + 1)
    let tx = centerline[i1 * 2] - centerline[i0 * 2]
    let ty = centerline[i1 * 2 + 1] - centerline[i0 * 2 + 1]
    const l = Math.hypot(tx, ty) || 1
    tx /= l; ty /= l
    const x = centerline[i * 2]
    const y = centerline[i * 2 + 1]
    left.push(x - ty * half, y + tx * half)
    right.push(x + ty * half, y - tx * half)
  }
  const points = [...left]
  const cap = (cx, cy, from) => {
    for (let k = 1; k < 8; k += 1) {
      const angle = from - (Math.PI * k) / 8
      points.push(cx + Math.cos(angle) * half, cy + Math.sin(angle) * half)
    }
  }
  const ex = centerline[(n - 1) * 2], ey = centerline[(n - 1) * 2 + 1]
  cap(ex, ey, Math.atan2(left[left.length - 1] - ey, left[left.length - 2] - ex))
  for (let i = n - 1; i >= 0; i -= 1) points.push(right[i * 2], right[i * 2 + 1])
  const sx = centerline[0], sy = centerline[1]
  cap(sx, sy, Math.atan2(right[1] - sy, right[0] - sx))
  out.push(points)
}

function quadratic(x0, y0, cx, cy, x1, y1, steps = 10) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const m = 1 - t
    points.push(m * m * x0 + 2 * m * t * cx + t * t * x1, m * m * y0 + 2 * m * t * cy + t * t * y1)
  }
  return points
}

// The polygons of one eye in its own box. `side` is -1 for the eye on the character's
// left (the viewer's left at rest), 1 for the other; a lid's inner corner faces the
// other eye. `closed` (0–1) is the blink: the eye flattens toward a line a little below
// its middle, keeping a thin slit.
export function eyePolygons(shape, W, H, side, closed = 0) {
  const out = []
  if (shape.kind === 'capsule') {
    const w = W * shape.w
    const h = H * shape.h
    // Inner corner: toward the other eye, so slope sign follows the side.
    const inner = -side
    const top = shape.top > 0 ? lidOf(-h / 2 + shape.top * h, Math.tan((shape.topTilt * Math.PI) / 180) * -inner, 0, w) : null
    const bottom = shape.bottom > 0 ? lidOf(h / 2 - shape.bottom * h, Math.tan((shape.bottomTilt * Math.PI) / 180) * -inner, shape.bottomCurve * h, w) : null
    const points = top || bottom ? liddedEye(w, h, top, bottom) : capsule(w, h)
    for (let i = 0; i < points.length; i += 2) { points[i] += shape.dx * W; points[i + 1] += shape.dy * H }
    out.push(points)
  } else if (shape.curve === 'arch') {
    stroke(quadratic(-0.6 * W, 0.1 * H, 0, -0.3 * H, 0.6 * W, 0.1 * H, 14), 0.48 * W, out)
  } else if (shape.curve === 'rest') {
    stroke(quadratic(-0.58 * W, 0.02 * H, 0, 0.26 * H, 0.58 * W, 0.02 * H), 0.38 * W, out)
  } else if (shape.curve === 'cross') {
    const r = 0.62 * W
    stroke([-r, -r, r, r], 0.36 * W, out)
    stroke([-r, r, r, -r], 0.36 * W, out)
  }
  if (closed > 0) {
    // The slit keeps about a fifth of the eye's width, so a closed eye still reads.
    let top = Infinity
    let bottom = -Infinity
    for (const points of out) for (let i = 1; i < points.length; i += 2) { top = Math.min(top, points[i]); bottom = Math.max(bottom, points[i]) }
    const height = bottom - top
    const pivot = top + height * 0.62
    const slit = Math.min(1, (0.2 * W) / Math.max(height, 1e-6))
    const k = 1 - Math.min(1, closed) * (1 - slit)
    for (const points of out) for (let i = 1; i < points.length; i += 2) points[i] = pivot + (points[i] - pivot) * k
  }
  return out
}
