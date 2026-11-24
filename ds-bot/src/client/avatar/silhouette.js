// The silhouette of a meshed character for one view.
//
// The front of the model is where its smooth normal faces the viewer (n·d > 0). The
// edge of that region, oriented with the front on its left, projects to closed loops
// whose winding number at a point counts the front sheets over it. Filled with the
// nonzero rule they cover exactly the silhouette: holes stay open (a ring, a magnet),
// and a limb in front of the body adds a sheet instead of cutting one away.

// `view` [dx, dy, dz]: toward the viewer, in object space. Returns loops of object-space
// points as flat arrays [x0, y0, z0, x1, ...].
export function silhouette(mesh, view, scratch = {}) {
  const { pos, nrm, tri } = mesh
  const vertexCount = pos.length / 3
  const facing = scratch.facing?.length >= vertexCount ? scratch.facing : (scratch.facing = new Float32Array(vertexCount))
  const [dx, dy, dz] = view
  for (let v = 0; v < vertexCount; v += 1) {
    const g = nrm[v * 3] * dx + nrm[v * 3 + 1] * dy + nrm[v * 3 + 2] * dz
    // Exact zeros would put a crossing on a vertex; nudge them to the back.
    facing[v] = g === 0 ? -1e-7 : g
  }
  // Each segment runs from a crossing on one edge to a crossing on another; edges are
  // keyed by their vertex pair, so the next segment starts where this one ends.
  const next = new Map()
  const point = new Map()
  const crossing = (a, b) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a
    if (!point.has(key)) {
      const t = facing[a] / (facing[a] - facing[b])
      point.set(key, [
        pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t,
        pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t,
        pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t,
      ])
    }
    return key
  }
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2]
    const fa = facing[a] > 0, fb = facing[b] > 0, fc = facing[c] > 0
    if (fa === fb && fb === fc) continue
    // Turn the triangle (keeping its order) so its odd vertex comes first.
    let [l, m, n] = [a, b, c]
    if (fb !== fa && fb !== fc) [l, m, n] = [b, c, a]
    else if (fc !== fa && fc !== fb) [l, m, n] = [c, a, b]
    const lm = crossing(l, m)
    const nl = crossing(n, l)
    // A lone front corner is bounded lm → nl; a lone back corner the other way.
    if (facing[l] > 0) next.set(lm, nl)
    else next.set(nl, lm)
  }
  const loops = []
  for (const start of next.keys()) {
    if (!next.has(start)) continue
    const loop = []
    let key = start
    while (next.has(key)) {
      const p = point.get(key)
      loop.push(p[0], p[1], p[2])
      const to = next.get(key)
      next.delete(key)
      key = to
    }
    if (loop.length >= 9) loops.push(loop)
  }
  return loops
}
