import { createModels, VIEW } from './models.js'
import { meshSteps } from './mesh.js'
import { silhouette } from './silhouette.js'
import { cross, norm, surfaceAt } from './sdf.js'
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

// The same work in slices (see meshSteps); the return value is the rig.
export function* rigSteps(model, { view = VIEW, cell = model.cell ?? 0.05 } = {}) {
  for (const profile of model.prepare ?? []) yield* profile.rows()
  const mesh = yield* meshSteps(model.sdf, { cell })
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
  const eyes = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(model.sdf, x, y)
    // The surface's own directions at the spot, along which a glance moves the eye.
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    return { p, u, v, size: model.eye ?? 1, w: 10, h: 23 }
  })
  yield
  const paints = (model.paints ?? []).map(paint => ({ fill: paint.fill, opacity: paint.opacity ?? 1, faces: clipFaces(mesh, paint.region) }))
  return { sdf: model.sdf, mesh, view, cx, cy, scale, bottom: 50 + ((cy - y0) * scale), eyes, paints }
}

// The parts of each triangle inside a decal's region (negative inside), with the
// triangle's own normal, so a frame keeps the parts facing the viewer.
function clipFaces(mesh, region) {
  const { pos, tri } = mesh
  const values = new Float32Array(pos.length / 3)
  for (let v = 0; v < values.length; v += 1) values[v] = region([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])
  const faces = []
  const point = v => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
  for (let t = 0; t < tri.length; t += 3) {
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
