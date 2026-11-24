// The silhouette of a meshed character for one view.
//
// The front of the model is where its smooth normal faces the viewer (n·d > 0). The
// edge of that region, oriented with the front on its left, projects to closed loops
// whose winding number at a point counts the front sheets over it. Filled with the
// nonzero rule they cover exactly the silhouette: holes stay open (a ring, a magnet),
// and a limb in front of the body adds a sheet instead of cutting one away.
//
// It runs every frame, so the mesh's edges are numbered once (edgeSteps, while the
// rig is built) and a frame only fills typed arrays kept in `scratch`.

import { clock, STEP_MS } from './steps.js'

// The mesh's edges: `a`/`b` the vertices of each edge, `of[t + k]` the edge from corner
// k of the triangle at t to corner k + 1.
const EDGES = new WeakMap()
function edgesOf(mesh) {
  const steps = edgeSteps(mesh)
  for (;;) {
    const { done, value } = steps.next()
    if (done) return value
  }
}
// The same numbering in slices of about STEP_MS; the return value is the table.
export function* edgeSteps(mesh) {
  let edges = EDGES.get(mesh)
  if (edges) return edges
  const { tri } = mesh
  const vertexCount = mesh.pos.length / 3
  const ids = new Map()
  const a = []
  const b = []
  const of = new Int32Array(tri.length)
  let since = clock()
  for (let t = 0; t < tri.length; t += 3) {
    if (t % 384 === 0 && clock() - since > STEP_MS) { yield; since = clock() }
    for (let k = 0; k < 3; k += 1) {
      const p = tri[t + k]
      const q = tri[t + (k + 1) % 3]
      const key = p < q ? p * vertexCount + q : q * vertexCount + p
      let id = ids.get(key)
      if (id === undefined) { id = a.length; ids.set(key, id); a.push(p); b.push(q) }
      of[t + k] = id
    }
  }
  edges = { a: Int32Array.from(a), b: Int32Array.from(b), of, count: a.length }
  EDGES.set(mesh, edges)
  return edges
}

// `view` [dx, dy, dz]: toward the viewer, in object space. Returns loops of object-space
// points as flat arrays [x0, y0, z0, x1, ...].
export function silhouette(mesh, view, scratch = {}) {
  const { pos, nrm, tri } = mesh
  const vertexCount = pos.length / 3
  const edges = edgesOf(mesh)
  if (scratch.edgeMesh !== mesh) {
    scratch.edgeMesh = mesh
    scratch.facing = new Float32Array(vertexCount)
    scratch.next = new Int32Array(edges.count).fill(-1)
    scratch.used = new Int32Array(edges.count)
  }
  const { facing, next, used } = scratch
  const [dx, dy, dz] = view
  for (let v = 0; v < vertexCount; v += 1) {
    const g = nrm[v * 3] * dx + nrm[v * 3 + 1] * dy + nrm[v * 3 + 2] * dz
    // Exact zeros would put a crossing on a vertex; nudge them to the back.
    facing[v] = g === 0 ? -1e-7 : g
  }
  // Each segment runs from the crossing on one edge to the crossing on another, so the
  // next segment starts on the edge where this one ends.
  let usedCount = 0
  const { of } = edges
  for (let t = 0; t < tri.length; t += 3) {
    const fa = facing[tri[t]] > 0, fb = facing[tri[t + 1]] > 0, fc = facing[tri[t + 2]] > 0
    if (fa === fb && fb === fc) continue
    // The odd corner l, with the edges l→m and n→l of the turned triangle (l, m, n).
    let l, lm, nl
    if (fb !== fa && fb !== fc) { l = tri[t + 1]; lm = of[t + 1]; nl = of[t] }
    else if (fc !== fa && fc !== fb) { l = tri[t + 2]; lm = of[t + 2]; nl = of[t + 1] }
    else { l = tri[t]; lm = of[t]; nl = of[t + 2] }
    // A lone front corner is bounded lm → nl; a lone back corner the other way.
    const from = facing[l] > 0 ? lm : nl
    next[from] = facing[l] > 0 ? nl : lm
    used[usedCount] = from
    usedCount += 1
  }
  const loops = []
  for (let u = 0; u < usedCount; u += 1) {
    let key = used[u]
    if (next[key] === -1) continue
    const loop = []
    while (next[key] !== -1) {
      const a = edges.a[key], b = edges.b[key]
      const t = facing[a] / (facing[a] - facing[b])
      loop.push(
        pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t,
        pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t,
        pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t,
      )
      const to = next[key]
      next[key] = -1
      key = to
    }
    if (loop.length >= 9) loops.push(loop)
  }
  return loops
}
