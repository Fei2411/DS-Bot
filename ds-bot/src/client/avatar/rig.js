import { createModels, VIEW } from './models.js'
import { meshSteps } from './mesh.js'
import { edgeSteps, silhouette } from './silhouette.js'
import { cross, norm, surfaceAt } from './sdf.js'
import { clock, STEP_MS } from './steps.js'
import { eyePolygons, FACES } from './face.js'
import { CHARACTERS } from '../characters.js'

// A rig is a character made ready to turn: its mesh, where it sits in the mark's
// 100-unit box at rest, its eye spots, and its decals. Building one takes tens of
// milliseconds, so rigs are made once per shape and kept.

let MODELS = null
// The 2D outlines (star, squircle) bake coarser than the traced art; a live mark is
// small and the mesh is coarser still.
export const models = () => (MODELS ??= createModels({ grid: 110 }))

// The rotation from object space to the view: roll · pitch · yaw, as a flat 3×3.
export function rotation(yaw, pitch, roll, out = new Float64Array(9)) {
  const r = Math.PI / 180
  const cy = Math.cos(yaw * r), sy = Math.sin(yaw * r)
  const cp = Math.cos(pitch * r), sp = Math.sin(pitch * r)
  const cr = Math.cos(roll * r), sr = Math.sin(roll * r)
  // Rx·Ry
  const m00 = cy, m01 = 0, m02 = sy
  const m10 = sp * sy, m11 = cp, m12 = -sp * cy
  const m20 = -cp * sy, m21 = sp, m22 = cp * cy
  out[0] = cr * m00 - sr * m10; out[1] = cr * m01 - sr * m11; out[2] = cr * m02 - sr * m12
  out[3] = sr * m00 + cr * m10; out[4] = sr * m01 + cr * m11; out[5] = sr * m02 + cr * m12
  out[6] = m20; out[7] = m21; out[8] = m22
  return out
}

// `model`: { sdf, eyes: [[x, y]...], eye?, paints?, cell?, prepare? }. `view` is the
// rest view.
export function buildRig(model, options) {
  const steps = rigSteps(model, options)
  for (;;) {
    const { done, value } = steps.next()
    if (done) return value
  }
}

// The same work in steps of about STEP_MS (steps.js); the return value is the rig.
export function* rigSteps(model, { view = VIEW, cell = model.cell ?? 0.05 } = {}) {
  for (const profile of model.prepare ?? []) yield* profile.rows()
  const mesh = yield* meshSteps(model.sdf, { cell })
  yield
  yield* edgeSteps(mesh)
  yield
  const R = rotation(view.yaw, view.pitch, view.roll)
  const loops = silhouette(mesh, [R[6], R[7], R[8]])
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 3) {
      const wx = R[0] * loop[i] + R[1] * loop[i + 1] + R[2] * loop[i + 2]
      const wy = R[3] * loop[i] + R[4] * loop[i + 1] + R[5] * loop[i + 2]
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy)
    }
  }
  // The same placement the traced art uses: the rest silhouette fills 92 of 100 units.
  const scale = 92 / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  yield
  const eyes = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(model.sdf, x, y)
    // The surface's own directions at the spot: the eye's width and height lie along them.
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    return { p, u, v, size: model.eye ?? 1, w: 10, h: 23 }
  })
  const box = (wx, wy) => [50 + (wx - cx) * scale, 50 - (wy - cy) * scale]
  const outline = loops.map((loop) => {
    const out = new Float32Array((loop.length / 3) * 2)
    for (let i = 0, j = 0; i < loop.length; i += 3, j += 2) {
      const [bx, by] = box(R[0] * loop[i] + R[1] * loop[i + 1] + R[2] * loop[i + 2], R[3] * loop[i] + R[4] * loop[i + 1] + R[5] * loop[i + 2])
      out[j] = bx; out[j + 1] = by
    }
    return out
  })
  const paints = []
  for (const paint of model.paints ?? []) paints.push({ fill: paint.fill, opacity: paint.opacity ?? 1, faces: yield* clipSteps(mesh, paint.region) })
  yield
  // Decals at rest, in the box: the faces turned to the viewer.
  const decals = []
  for (const { faces } of paints) {
    for (const { points, normal } of faces) {
      if (normal[0] * R[6] + normal[1] * R[7] + normal[2] * R[8] <= 0) continue
      const out = new Float32Array((points.length / 3) * 2)
      for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
        const [bx, by] = box(R[0] * points[i] + R[1] * points[i + 1] + R[2] * points[i + 2], R[3] * points[i] + R[4] * points[i + 1] + R[5] * points[i + 2])
        out[j] = bx; out[j + 1] = by
      }
      decals.push(out)
    }
  }
  yield
  const free = yield* freeSteps(outline, decals)
  yield
  const look = yield* lookSteps(free, eyes.map((eye) => {
    const n = cross(eye.u, eye.v)
    const facing = n[0] * R[6] + n[1] * R[7] + n[2] * R[8]
    const across = (d) => Math.hypot(R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2])
    const [x, y] = box(R[0] * eye.p[0] + R[1] * eye.p[1] + R[2] * eye.p[2], R[3] * eye.p[0] + R[4] * eye.p[1] + R[5] * eye.p[2])
    // As drawn (render.js): leaning with the surface's up direction.
    const tilt = Math.atan2(R[0] * eye.v[0] + R[1] * eye.v[1] + R[2] * eye.v[2], R[3] * eye.v[0] + R[4] * eye.v[1] + R[5] * eye.v[2])
    return { x, y, tilt, w: eye.w * eye.size * across(eye.u) * Math.min(1, facing / 0.15), h: eye.h * eye.size * across(eye.v) }
  }))
  return { sdf: model.sdf, mesh, view, cx, cy, scale, bottom: 50 + ((cy - y0) * scale), eyes, look, paints }
}

// Where an eye may be, at rest: a grid over the mark's box, FREE_CELL units a cell, set
// on the body and off its decals. The body is filled with the nonzero rule, so a limb
// drawn over it counts as body. In steps of about STEP_MS.
const FREE_CELL = 0.5
const FREE_SIZE = Math.ceil(100 / FREE_CELL)
function* freeSteps(outline, decals) {
  const cells = new Uint8Array(FREE_SIZE * FREE_SIZE)
  let since = clock()
  function* fill(loops, value, nonzero, top = 0, bottom = 100) {
    const first = Math.max(0, Math.floor(top / FREE_CELL - 0.5))
    const last = Math.min(FREE_SIZE - 1, Math.ceil(bottom / FREE_CELL - 0.5))
    for (let row = first; row <= last; row += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      const y = (row + 0.5) * FREE_CELL
      const hits = []
      for (const pts of loops) {
        const n = pts.length / 2
        for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
          const ay = pts[j * 2 + 1], by = pts[i * 2 + 1]
          if ((ay <= y) === (by <= y)) continue
          const ax = pts[j * 2], bx = pts[i * 2]
          hits.push(ax + ((y - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1)
        }
      }
      if (hits.length === 0) continue
      const order = [...Array(hits.length / 2).keys()].sort((p, q) => hits[p * 2] - hits[q * 2])
      let winding = 0
      for (let k = 0; k < order.length; k += 1) {
        const before = winding
        winding += nonzero ? hits[order[k] * 2 + 1] : 1
        const inside = nonzero ? before !== 0 : before % 2 === 1
        if (!inside || k === 0) continue
        const from = Math.max(0, Math.ceil(hits[order[k - 1] * 2] / FREE_CELL - 0.5))
        const to = Math.min(FREE_SIZE - 1, Math.floor(hits[order[k] * 2] / FREE_CELL - 0.5))
        for (let col = from; col <= to; col += 1) cells[row * FREE_SIZE + col] = value
      }
    }
  }
  yield* fill(outline, 1, true)
  // A decal is many small faces; each blocks only the rows it spans.
  for (const decal of decals) {
    let top = Infinity, bottom = -Infinity
    for (let i = 1; i < decal.length; i += 2) { top = Math.min(top, decal[i]); bottom = Math.max(bottom, decal[i]) }
    if (bottom - top < FREE_CELL / 4) continue
    yield* fill([decal], 0, false, top, bottom)
  }
  return (x, y) => {
    const col = Math.floor(x / FREE_CELL)
    const row = Math.floor(y / FREE_CELL)
    return col >= 0 && row >= 0 && col < FREE_SIZE && row < FREE_SIZE && cells[row * FREE_SIZE + col] === 1
  }
}

// How far the eyes can look, in the mark's box at rest: for each of LOOK_WAYS
// directions (from right, turning toward down), the most both eyes can move that way
// together and stay EYE_EDGE inside where an eye may be (freeSteps); the part of an
// eye that lies off it at rest counts from its edge. `ways` is for eyes as drawn
// neutral, `big` for eyes up to their largest (LOOK_BIG times: surprised, and grown on
// top): a smaller eye lies inside a bigger one, so it fits wherever that one does. A
// frame goes from `ways` to `big` as an eye grows LOOK_RAMP past neutral (render.js).
// Each direction keeps the least of its neighbors', so a notch between two directions
// does not catch an eye. A glance moves the eyes across the picture, not around the
// body, so they never slide to its edge and flatten there. In steps of about STEP_MS;
// the return value is the room.
export const LOOK_WAYS = 16
export const LOOK_BIG = 1.35
export const LOOK_RAMP = 0.08
const LOOK_MAX = 9
const EYE_EDGE = 1.5
function* lookSteps(free, eyes) {
  const room = {}
  let since = clock()
  // How far a point goes along (dx, dy) and stays free.
  const reach = (x, y, dx, dy, most) => {
    let t = 0
    while (t < most && free(x + dx * (t + FREE_CELL / 2), y + dy * (t + FREE_CELL / 2))) t += FREE_CELL / 2
    return t
  }
  for (const [name, grown] of [['ways', 1], ['big', LOOK_BIG]]) {
    const ways = room[name] = new Float64Array(LOOK_WAYS).fill(LOOK_MAX)
    // Rays leave from every point of the eye's outline, leaning as drawn: on a notched
    // body any of them may leave first. A point off the free part starts at its edge.
    const rims = []
    for (const eye of eyes) {
      if (!free(eye.x, eye.y)) continue
      const c = Math.cos(eye.tilt), s = Math.sin(eye.tilt)
      const rim = eyePolygons(FACES.neutral[0], eye.w * grown, eye.h * grown, 1)[0]
      for (let i = 0; i < rim.length; i += 2) {
        const ox = rim[i] * c - rim[i + 1] * s
        const oy = rim[i] * s + rim[i + 1] * c
        const length = Math.hypot(ox, oy)
        const edge = Math.min(length, reach(eye.x, eye.y, ox / length, oy / length, length))
        rims.push(eye.x + (ox / length) * edge, eye.y + (oy / length) * edge)
      }
    }
    // No eye on the free part (none of the characters today): the eyes stay put.
    if (rims.length === 0) ways.fill(0)
    for (let k = 0; k < LOOK_WAYS && rims.length > 0; k += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      const angle = (2 * Math.PI * k) / LOOK_WAYS
      const dx = Math.cos(angle)
      const dy = Math.sin(angle)
      for (let i = 0; i < rims.length; i += 2) ways[k] = Math.min(ways[k], Math.max(0, reach(rims[i], rims[i + 1], dx, dy, LOOK_MAX + EYE_EDGE) - EYE_EDGE))
    }
    const each = Float64Array.from(ways)
    for (let k = 0; k < LOOK_WAYS; k += 1) ways[k] = Math.min(each[(k + LOOK_WAYS - 1) % LOOK_WAYS], each[k], each[(k + 1) % LOOK_WAYS])
  }
  return room
}

// The parts of each triangle inside a decal's region (negative inside), with the
// triangle's own normal, so a frame keeps the parts facing the viewer. In steps of
// about STEP_MS; the return value is the faces.
function* clipSteps(mesh, region) {
  const { pos, tri } = mesh
  const values = new Float32Array(pos.length / 3)
  let since = clock()
  for (let v = 0; v < values.length; v += 1) {
    if (v % 64 === 0 && clock() - since > STEP_MS) { yield; since = clock() }
    values[v] = region([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])
  }
  const faces = []
  const point = v => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
  for (let t = 0; t < tri.length; t += 3) {
    if (t % 192 === 0 && clock() - since > STEP_MS) { yield; since = clock() }
    const ids = [tri[t], tri[t + 1], tri[t + 2]]
    const inside = ids.map(v => values[v] < 0)
    if (!inside.some(Boolean)) continue
    const corners = ids.map(point)
    const normal = norm(cross(sub3(corners[1], corners[0]), sub3(corners[2], corners[0])))
    const polygon = []
    for (let k = 0; k < 3; k += 1) {
      const a = ids[k], b = ids[(k + 1) % 3]
      const pa = corners[k], pb = corners[(k + 1) % 3]
      if (values[a] < 0) polygon.push(pa)
      if ((values[a] < 0) !== (values[b] < 0)) {
        const s = values[a] / (values[a] - values[b])
        polygon.push([pa[0] + (pb[0] - pa[0]) * s, pa[1] + (pb[1] - pa[1]) * s, pa[2] + (pb[2] - pa[2]) * s])
      }
    }
    faces.push({ points: Float32Array.from(polygon.flat()), normal })
  }
  return faces
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

// Rigs by shape, built on demand. Only a built-in character still drawing its own art
// has a model to turn; a shape another plugin registers is drawn by its own code, so
// it moves as a whole (see flatTransform in live.js), like an uploaded photo.
const rigs = new Map()
const turns = (id, def) => Object.hasOwn(models(), id) && (!def || (def.body === undefined && def.path === CHARACTERS[id]?.body))
// The rig now, built at once if need be; null for a shape that does not turn.
export function rigFor(id, def) {
  if (!turns(id, def)) return null
  if (!rigs.has(id)) rigs.set(id, buildRig(models()[id]))
  return rigs.get(id)
}
// A job that builds the rig in slices: call it until it returns true.
export function rigJob(id, def) {
  if (!turns(id, def) || rigs.has(id)) return () => true
  const steps = rigSteps(models()[id])
  return () => {
    if (rigs.has(id)) return true
    const step = steps.next()
    if (step.done) rigs.set(id, step.value)
    return step.done
  }
}
// Whether the rig for this shape is known: built, or not needed.
export const rigReady = (id, def) => !turns(id, def) || rigs.has(id)
