// Source of DS Bot's characters. Each one is a small 3D model made of
// signed-distance primitives (spheres, ellipsoids, round cones, a torus, and extrusions),
// seen from one fixed three-quarter view and traced into flat layers in a 100-unit box:
// the body silhouette and optional decals. The eyes are capsules laid on the model's front
// surface and projected the same way, so the near eye is wider than the far one and both
// lean with the surface. The whale also keeps its shade and highlight layers for the
// desktop app's start-window animation.
//
//   node dev/characters.mjs                   prints the CHARACTERS block for src/client/characters.js
//   node dev/characters.mjs --preview a.html  also writes a preview gallery
import { writeFileSync } from 'node:fs'
import { cross, dot, gradient, mm, mul, norm, rx, ry, rz, surfaceAt, tr } from '../src/client/avatar/sdf.js'
import { createModels, VIEW } from '../src/client/avatar/models.js'

// The models and their signed-distance primitives live in src/client/avatar/ (models.js,
// sdf.js), which the avatar engine also meshes at run time to turn them in 3D.
const toWorld = mm(rz(VIEW.roll), mm(rx(VIEW.pitch), ry(VIEW.yaw)))
const toObject = tr(toWorld)
const MODELS = createModels()

function contours(field) {
  const at = (i, j) => field[i * (N + 1) + j]
  const point = (i, j, di, dj) => {
    const a = at(i, j)
    const b = at(i + di, j + dj)
    const k = a / (a - b)
    return [-EXTENT + (j + dj * k) * STEP, EXTENT - (i + di * k) * STEP]
  }
  const segments = []
  const edge = {
    top: (i, j) => [`h${i},${j}`, () => point(i, j, 0, 1)],
    bottom: (i, j) => [`h${i + 1},${j}`, () => point(i + 1, j, 0, 1)],
    left: (i, j) => [`v${i},${j}`, () => point(i, j, 1, 0)],
    right: (i, j) => [`v${i},${j + 1}`, () => point(i, j + 1, 1, 0)],
  }
  const PAIRS = {
    1: [['left', 'bottom']], 2: [['bottom', 'right']], 3: [['left', 'right']], 4: [['top', 'right']],
    5: [['left', 'top'], ['bottom', 'right']], 6: [['top', 'bottom']], 7: [['left', 'top']], 8: [['left', 'top']],
    9: [['top', 'bottom']], 10: [['left', 'bottom'], ['top', 'right']], 11: [['top', 'right']], 12: [['left', 'right']],
    13: [['bottom', 'right']], 14: [['left', 'bottom']],
  }
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const code = (at(i, j) < 0 ? 8 : 0) | (at(i, j + 1) < 0 ? 4 : 0) | (at(i + 1, j + 1) < 0 ? 2 : 0) | (at(i + 1, j) < 0 ? 1 : 0)
      for (const [a, b] of PAIRS[code] ?? []) segments.push([edge[a](i, j), edge[b](i, j)])
    }
  }
  const byEdge = new Map()
  segments.forEach(([a, b], index) => {
    for (const [key] of [a, b]) byEdge.set(key, [...(byEdge.get(key) ?? []), index])
  })
  const used = new Set()
  const loops = []
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue
    const loop = []
    let index = start
    let [[fromKey, fromPoint], [toKey]] = segments[start]
    loop.push(fromPoint())
    for (;;) {
      used.add(index)
      const [a, b] = segments[index]
      const [nextKey, nextPoint] = a[0] === fromKey ? b : a
      loop.push(nextPoint())
      fromKey = nextKey
      const next = (byEdge.get(nextKey) ?? []).find(other => !used.has(other))
      if (next === undefined) break
      index = next
    }
    void toKey
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}

function simplify(points, tolerance) {
  if (points.length < 3) return points
  const [a, b] = [points[0], points.at(-1)]
  let far = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l
    if (d > far) { far = d; index = i }
  }
  if (far <= tolerance) return [a, b]
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}

// ---------------------------------------------------------------------------
// Tracing. Each grid ray keeps the smallest distance it meets: negative inside the
// silhouette, about the distance to it outside, so marching squares finds a smooth edge.
const N = 300
const EXTENT = 1.7
const STEP = (2 * EXTENT) / N

// Light from the upper left, a little in front. The side turned away from it is the
// shade; the patch facing it is the highlight, which is what shapes a black body.
const LIGHT = norm([-0.62, 0.68, 0.4])
const SHADE_AT = 0.06
const LIGHT_AT = 0.86


// The ray's smallest distance and, when it hits, the hit point and normal (object space).
function rayMin(sdf, X, Y) {
  let t = 2.4
  let best = Infinity
  let hit = null
  for (let i = 0; i < 400 && t > -2.4; i += 1) {
    const p = mul(toObject, [X, Y, t])
    const d = sdf(p)
    if (d < best) best = d
    if (d < 1e-3 && hit === null) hit = { p, n: gradient(sdf, p) }
    t -= Math.max(Math.abs(d) * 0.8, 0.002)
  }
  return [best, hit]
}


const f = n => String(+n.toFixed(1))

function build(model) {
  const size = (N + 1) * (N + 1)
  const field = new Float64Array(size)
  const paints = model.paints ?? []
  // Every layer lies inside the body: its field is the body's field where the layer
  // applies and outside everywhere else, so no layer spills past the silhouette.
  const layers = { shade: new Float64Array(size), light: new Float64Array(size), paints: paints.map(() => new Float64Array(size)) }
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const k = i * (N + 1) + j
      const [d, hit] = rayMin(model.sdf, -EXTENT + j * STEP, EXTENT - i * STEP)
      field[k] = d
      const off = Math.max(d, STEP)
      if (hit === null) {
        layers.shade[k] = off
        layers.light[k] = off
        layers.paints.forEach((layer) => { layer[k] = off })
        continue
      }
      const lit = dot(mul(toWorld, hit.n), LIGHT)
      layers.shade[k] = Math.max(d, (lit - SHADE_AT) * 0.25)
      layers.light[k] = Math.max(d, (LIGHT_AT - lit) * 0.25)
      paints.forEach((paint, index) => {
        layers.paints[index][k] = hit.n[2] > 0.1 ? Math.max(d, paint.region(hit.p)) : off
      })
    }
  }
  const loops = contours(field)
  const all = loops.flat()
  const xs = all.map(p => p[0])
  const ys = all.map(p => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = 92 / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const place = ([X, Y]) => [50 + (X - cx) * scale, 50 - (Y - cy) * scale]
  const toPath = loopList => loopList.map((loop) => {
    // A closed loop starts and ends on the same point, so split it at its far side
    // before simplifying; otherwise every point is "on" the zero-length chord.
    const ring = loop.map(place)
    const far = ring.reduce((best, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best), 0)
    const points = [...simplify(ring.slice(0, far + 1), 0.25).slice(0, -1), ...simplify(ring.slice(far), 0.25)].slice(0, -1)
    // Relative steps on a 0.1 grid keep the strings short; rounding the running point
    // rather than each step stops the error from adding up around the loop.
    const grid = points.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)])
    const steps = grid.slice(1).map(([x, y], k) => [x - grid[k][0], y - grid[k][1]]).filter(([dx, dy]) => dx || dy)
    const num = v => (v < 0 ? '-' : ' ') + String(Math.abs(v) / 10).replace(/^0\./, '.')
    return `M${f(grid[0][0] / 10)} ${f(grid[0][1] / 10)}l${steps.map(([dx, dy]) => `${num(dx)}${num(dy)}`).join('').trim()}z`
  }).join('')
  const eyeSize = model.eye ?? 1
  const eyes = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(model.sdf, x, y)
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    const [wp, wu, wv] = [mul(toWorld, p), mul(toWorld, u), mul(toWorld, v)]
    const [ex, ey] = place([wp[0], wp[1]])
    const vs = [wv[0], -wv[1]]
    const tilt = (Math.atan2(vs[0], -vs[1]) * 180) / Math.PI
    return [ex, ey, 10 * eyeSize * Math.hypot(wu[0], wu[1]), 23 * eyeSize * Math.hypot(...vs), tilt].map(value => +value.toFixed(1))
  })
  return {
    ...(model.label ? { label: model.label } : {}),
    body: toPath(loops),
    ...(paints.length ? { paints: paints.map((paint, index) => [toPath(contours(layers.paints[index])), paint.fill, paint.opacity]) } : {}),
    ...(model.keepShading ? { shade: toPath(contours(layers.shade)), light: toPath(contours(layers.light)) } : {}),
    eyes,
  }
}

export const CHARACTERS = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, build(model)]))

const block = Object.entries(CHARACTERS).map(([id, character]) => `  ${id}: ${JSON.stringify(character).replace(/"(\w+)":/g, '$1:').replaceAll('"', "'")},`).join('\n')
console.log(`export const CHARACTERS = {\n${block}\n}`)

const out = process.argv.indexOf('--preview')
if (out > 0) {
  const colors = ['#A27952', '#FF3E51', '#FF781C', '#FFAF38', '#00C972', '#1CC3B0', '#2A92FE', '#A97EFE', '#FF5EB1', '#959595']
  const INK = { whale: '#4D6BFE', star: '#0AA8D6', moon: '#FFAF38', cloud: '#38BDF8', spark: '#FF781C', bear: '#A27952', puppy: '#D98A4E', octopus: '#FF3E51', sprout: '#00C972', bloom: '#A97EFE', squircle: '#FF6900' }
  let serial = 0
  const mark = (c, color, size) => {
    serial += 1
    const holes = c.eyes.map(([ex, ey, w, h, tilt]) => `<g transform="translate(${ex} ${ey}) rotate(${tilt})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('')
    const paint = (c.paints ?? []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`).join('')
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"><defs><mask id="m${serial}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${holes}</mask></defs><g mask="url(#m${serial})" fill-rule="evenodd"><path d="${c.body}" fill="${color}"/>${paint}</g></svg>`
  }
  const cells = dark => Object.entries(CHARACTERS).map(([id, c], index) => {
    const color = INK[id] || colors[index % colors.length]
    return `<div class="cell"><div>${mark(c, color, 96)}</div><div class="row">${mark(c, color, 40)}${mark(c, dark ? '#fff' : '#000', 28)}${mark(c, color, 20)}</div><div class="name">${id}</div></div>`
  }).join('')
  writeFileSync(process.argv[out + 1], `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px -apple-system,system-ui,sans-serif;background:#fcfcfc}section{padding:12px 20px;display:grid;grid-template-columns:repeat(5,104px);gap:4px}.dark{background:#141414}.cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0}.row{display:flex;align-items:center;gap:6px}.name{color:#777}</style><section>${cells(false)}</section><section class="dark">${cells(true)}</section>`)
}
