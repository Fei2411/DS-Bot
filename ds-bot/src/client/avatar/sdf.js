import { clock, STEP_MS } from './steps.js'

// Signed-distance building blocks for the characters' 3D models. dev/characters.mjs
// traces them into the flat marks in characters.js, and the avatar engine meshes the
// same models at run time to turn them in 3D. Both must read the same numbers, so the
// operations here keep their order: a changed rounding would move the traced art.

// ---------------------------------------------------------------------------
// Vectors and rotations. Object space: x right, y up, z toward the viewer.
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const len = a => Math.hypot(a[0], a[1], a[2])
export const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const rad = deg => (deg * Math.PI) / 180
export const mul = (m, p) => [dot(m[0], p), dot(m[1], p), dot(m[2], p)]
export const mm = (a, b) => a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
export const tr = m => [0, 1, 2].map(i => [m[0][i], m[1][i], m[2][i]])
export const rx = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[1, 0, 0], [0, c, -s], [0, s, c]] }
export const ry = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
export const rz = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]] }

// ---------------------------------------------------------------------------
// Primitives (Inigo Quilez's formulas).
export const sphere = (c, r) => p => len(sub(p, c)) - r
export function ellipsoid(c, radii, turn) {
  const m = turn ? tr(rz(turn)) : null
  return (p) => {
    let q = sub(p, c)
    if (m) q = mul(m, q)
    const k0 = len([q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]])
    const k1 = len([q[0] / radii[0] ** 2, q[1] / radii[1] ** 2, q[2] / radii[2] ** 2])
    return k1 === 0 ? -Math.min(...radii) : (k0 * (k0 - 1)) / k1
  }
}
export function roundBox(c, half, r) {
  return (p) => {
    const q = sub(p, c).map((v, i) => Math.abs(v) - (half[i] - r))
    return len(q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - r
  }
}
export function capsule(a, b, r) {
  const ba = sub(b, a)
  return (p) => {
    const pa = sub(p, a)
    const h = Math.max(0, Math.min(1, dot(pa, ba) / dot(ba, ba)))
    return len(sub(pa, ba.map(v => v * h))) - r
  }
}
export function roundCone(a, b, r1, r2) {
  const ba = sub(b, a)
  const l2 = dot(ba, ba)
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  return (p) => {
    const pa = sub(p, a)
    const y = dot(pa, ba)
    const z = y - l2
    const xv = sub(pa.map(v => v * l2), ba.map(v => v * y))
    const x2 = dot(xv, xv)
    const y2 = y * y * l2
    const z2 = z * z * l2
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
  }
}
// A ring standing in the xy plane, facing the viewer.
export const torus = (c, R, r) => (p) => { const q = sub(p, c); return Math.hypot(Math.hypot(q[0], q[1]) - R, q[2]) - r }
// A 2D profile in the xy plane, pushed `depth` back and forth, its edges rounded by `round`.
export const extrude = (profile, depth, round) => (p) => {
  const d = profile(p[0], p[1])
  const w = Math.abs(p[2]) - depth
  return Math.min(Math.max(d, w), 0) + Math.hypot(Math.max(d, 0), Math.max(w, 0)) - round
}
// A soft slab: the outline pushed back and forth `depth`, its rim rounded by `round`.
export const puffy = (profile, depth, round) => extrude((x, y) => profile(x, y) + round, depth, round)
export const box2 = (cx, cy, hx, hy) => (x, y) => {
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
}
export const circle2 = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r
export const smin = (k, ...parts) => p => parts.map(f => f(p)).reduce((a, b) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k / 4
})
export const clipBelow = (f, y) => p => Math.max(f(p), y - p[1])

// ---------------------------------------------------------------------------
// 2D outlines from SVG paths. A path is flattened to polygons, and its signed distance
// (negative inside, even-odd per path, union across paths) is baked on a grid the
// first time it is read, so building a model costs nothing until it is drawn.
export function flatten(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g)
  const loops = []
  let loop = []
  let i = 0
  let cmd = 'M'
  let [x, y] = [0, 0]
  let [sx, sy] = [0, 0]
  let control = null
  const num = () => parseFloat(tokens[i++])
  const close = () => { if (loop.length > 2) loops.push(loop); loop = [] }
  const curve = (points, steps = 12) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps
      const m = 1 - t
      const p = points.length === 3
        ? [m * m * points[0][0] + 2 * m * t * points[1][0] + t * t * points[2][0], m * m * points[0][1] + 2 * m * t * points[1][1] + t * t * points[2][1]]
        : [0, 1].map(k => m * m * m * points[0][k] + 3 * m * m * t * points[1][k] + 3 * m * t * t * points[2][k] + t * t * t * points[3][k])
      loop.push(p)
    }
  }
  const arc = (rx, ry, phi, large, sweep, x2, y2) => {
    const c = Math.cos(rad(phi))
    const s = Math.sin(rad(phi))
    const dx = (x - x2) / 2
    const dy = (y - y2) / 2
    const x1p = c * dx + s * dy
    const y1p = -s * dx + c * dy
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda) }
    const sign = large === sweep ? -1 : 1
    const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
    const cxp = (k * rx * y1p) / ry
    const cyp = (-k * ry * x1p) / rx
    const cx = c * cxp - s * cyp + (x + x2) / 2
    const cy = s * cxp + c * cyp + (y + y2) / 2
    const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if (!sweep && dt > 0) dt -= 2 * Math.PI
    if (sweep && dt < 0) dt += 2 * Math.PI
    const steps = Math.max(4, Math.ceil(Math.abs(dt) / 0.12))
    for (let n = 1; n <= steps; n += 1) {
      const t = t1 + (dt * n) / steps
      loop.push([cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c])
    }
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M': close(); x = ox + num(); y = oy + num(); [sx, sy] = [x, y]; loop.push([x, y]); cmd = rel ? 'l' : 'L'; control = null; break
      case 'L': x = ox + num(); y = oy + num(); loop.push([x, y]); control = null; break
      case 'H': x = ox + num(); loop.push([x, y]); control = null; break
      case 'V': y = oy + num(); loop.push([x, y]); control = null; break
      case 'C': { const p1 = [ox + num(), oy + num()]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'S': { const p1 = control ? [2 * x - control[0], 2 * y - control[1]] : [x, y]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'Q': { const p1 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p]); [x, y] = p; control = null; break }
      case 'A': { const [rx, ry, phi, large, sweep] = [num(), num(), num(), num(), num()]; const x2 = ox + num(); const y2 = oy + num(); arc(Math.abs(rx), Math.abs(ry), phi, !!large, !!sweep, x2, y2); [x, y] = [x2, y2]; control = null; break }
      case 'Z': close(); [x, y] = [sx, sy]; control = null; break
      default: throw new Error(`Unsupported path command ${cmd}`)
    }
  }
  close()
  return loops
}

export function polygonDistance(loops, x, y) {
  let best = Infinity
  let inside = false
  for (const loop of loops) {
    for (let a = 0, b = loop.length - 1; a < loop.length; b = a, a += 1) {
      const [x1, y1] = loop[b]
      const [x2, y2] = loop[a]
      const dx = x2 - x1
      const dy = y2 - y1
      const h = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(x - x1 - dx * h, y - y1 - dy * h))
      if ((y1 > y) !== (y2 > y) && x < x1 + ((y - y1) * dx) / dy) inside = !inside
    }
  }
  return inside ? -best : best
}

// An outline as a 2D distance in object units. `map` takes object (x, y) to the path's
// own coordinates and `unit` is how many path units make one object unit; `grow`
// fattens the outline (in path units), which also rounds its corners. `grid` is the
// bake's resolution: the traced art uses 260, a live mark needs less.
export function outline(paths, { map, unit, grow = 0, grid: G = 260 }) {
  const R = 1.6
  let grid = null
  // Bakes a row at a time; `rows()` lets a page spread the bake over idle moments.
  function* rows() {
    if (grid !== null) return
    const shapes = paths.map(flatten)
    const baking = new Float64Array((G + 1) * (G + 1))
    let since = clock()
    for (let i = 0; i <= G; i += 1) {
      for (let j = 0; j <= G; j += 1) {
        const [px, py] = map(-R + (2 * R * j) / G, R - (2 * R * i) / G)
        baking[i * (G + 1) + j] = (Math.min(...shapes.map(loops => polygonDistance(loops, px, py))) - grow) / unit
      }
      if (clock() - since > STEP_MS) { yield; since = clock() }
    }
    grid = baking
  }
  const bake = () => { const steps = rows(); while (!steps.next().done); }
  const profile = (x, y) => {
    if (grid === null) bake()
    const fj = Math.max(0, Math.min(G - 1e-9, ((x + R) / (2 * R)) * G))
    const fi = Math.max(0, Math.min(G - 1e-9, ((R - y) / (2 * R)) * G))
    const [i, j] = [Math.floor(fi), Math.floor(fj)]
    const [ti, tj] = [fi - i, fj - j]
    const at = (a, b) => grid[a * (G + 1) + b]
    const inner = (at(i, j) * (1 - tj) + at(i, j + 1) * tj) * (1 - ti) + (at(i + 1, j) * (1 - tj) + at(i + 1, j + 1) * tj) * ti
    // Outside the baked square the distance only grows.
    return inner + Math.max(0, Math.abs(x) - R, Math.abs(y) - R)
  }
  profile.rows = rows
  return profile
}
// A 512-unit design box seen as object space: its center at the origin, `per` design
// units to one object unit, y up.
export const box512 = (cx, cy, per = 190) => ({ map: (x, y) => [cx + x * per, cy - y * per], unit: per })

// The gradient of a distance at p: the outward surface normal on the surface.
export function gradient(sdf, p) {
  const e = 1e-3
  return norm([0, 1, 2].map((axis) => {
    const plus = [...p]
    const minus = [...p]
    plus[axis] += e
    minus[axis] -= e
    return sdf(plus) - sdf(minus)
  }))
}

// The front surface under (x, y), found by a ray along -z, with its normal.
export function surfaceAt(sdf, x, y) {
  let z = 2.5
  for (let i = 0; i < 300; i += 1) {
    const d = sdf([x, y, z])
    if (d < 1e-4) break
    z -= Math.max(d, 1e-4)
  }
  const p = [x, y, z]
  return { p, n: gradient(sdf, p) }
}
