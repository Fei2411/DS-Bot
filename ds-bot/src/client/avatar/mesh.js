// Meshes a signed distance into a closed triangle mesh (naive surface nets), so a
// character can be turned and drawn many times a second without tracing it again.
//
// The mesh keeps the smooth normal of the distance at each vertex. A frame then finds
// the silhouette where that normal turns away from the viewer (silhouette.js), which
// stays a smooth curve even on a coarse mesh.

import { clock, STEP_MS } from './steps.js'

const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
]

// `sdf(p)` → distance; `bounds` [[x0, y0, z0], [x1, y1, z1]]; `cell` the grid step.
export function meshDistance(sdf, options) {
  const steps = meshSteps(sdf, options)
  for (;;) {
    const { done, value } = steps.next()
    if (done) return value
  }
}

// The same work in slices: it yields about every STEP_MS (steps.js), so a page can
// mesh between frames without a long task. The generator's return value is the mesh.
export function* meshSteps(sdf, { bounds = [[-1.7, -1.7, -1.7], [1.7, 1.7, 1.7]], cell = 0.05 } = {}) {
  const [lo, hi] = bounds
  const nx = Math.ceil((hi[0] - lo[0]) / cell) + 1
  const ny = Math.ceil((hi[1] - lo[1]) / cell) + 1
  const nz = Math.ceil((hi[2] - lo[2]) / cell) + 1
  const at = (i, j, k) => (k * ny + j) * nx + i
  const values = new Float32Array(nx * ny * nz)
  const p = [0, 0, 0]
  // A coarse pass skips the far field: a sample farther than its block's reach from
  // the surface cannot change sign inside the block.
  const B = 4
  let since = clock()
  for (let k0 = 0; k0 < nz; k0 += B) {
    for (let j0 = 0; j0 < ny; j0 += B) {
      for (let i0 = 0; i0 < nx; i0 += B) {
        if (clock() - since > STEP_MS) { yield; since = clock() }
        const ci = Math.min(i0 + B / 2, nx - 1)
        const cj = Math.min(j0 + B / 2, ny - 1)
        const ck = Math.min(k0 + B / 2, nz - 1)
        p[0] = lo[0] + ci * cell; p[1] = lo[1] + cj * cell; p[2] = lo[2] + ck * cell
        const d = sdf(p)
        const reach = cell * B * 0.9
        for (let k = k0; k < Math.min(k0 + B, nz); k += 1) {
          for (let j = j0; j < Math.min(j0 + B, ny); j += 1) {
            for (let i = i0; i < Math.min(i0 + B, nx); i += 1) {
              if (Math.abs(d) > reach) { values[at(i, j, k)] = d; continue }
              p[0] = lo[0] + i * cell; p[1] = lo[1] + j * cell; p[2] = lo[2] + k * cell
              values[at(i, j, k)] = sdf(p)
            }
          }
        }
      }
    }
  }

  // One vertex per cube that the surface crosses, at the mean of its edge crossings.
  const cubeVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const cubeAt = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i
  const positions = []
  const corner = new Float32Array(8)
  for (let k = 0; k < nz - 1; k += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      for (let i = 0; i < nx - 1; i += 1) {
        let inside = 0
        for (let c = 0; c < 8; c += 1) {
          corner[c] = values[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]
          if (corner[c] < 0) inside += 1
        }
        if (inside === 0 || inside === 8) continue
        let sx = 0, sy = 0, sz = 0, count = 0
        for (const [a, b] of EDGES) {
          const va = corner[a]
          const vb = corner[b]
          if ((va < 0) === (vb < 0)) continue
          const t = va / (va - vb)
          sx += (a & 1) + ((b & 1) - (a & 1)) * t
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t
          count += 1
        }
        cubeVertex[cubeAt(i, j, k)] = positions.length / 3
        positions.push(lo[0] + (i + sx / count) * cell, lo[1] + (j + sy / count) * cell, lo[2] + (k + sz / count) * cell)
      }
    }
  }

  // One quad per grid edge the surface crosses, joining the four cubes around it and
  // facing out of the solid.
  const triangles = []
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    const [q0, q1, q2, q3] = flip ? [a, d, c, b] : [a, b, c, d]
    // Split along the shorter diagonal.
    const d02 = dist2(positions, q0, q2)
    const d13 = dist2(positions, q1, q3)
    if (d02 <= d13) triangles.push(q0, q1, q2, q0, q2, q3)
    else triangles.push(q0, q1, q3, q1, q2, q3)
  }
  for (let k = 1; k < nz - 1; k += 1) {
    for (let j = 1; j < ny - 1; j += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      for (let i = 0; i < nx - 1; i += 1) {
        const a = values[at(i, j, k)] < 0
        if (a === (values[at(i + 1, j, k)] < 0)) continue
        quad(cubeVertex[cubeAt(i, j - 1, k - 1)], cubeVertex[cubeAt(i, j, k - 1)], cubeVertex[cubeAt(i, j, k)], cubeVertex[cubeAt(i, j - 1, k)], !a)
      }
    }
  }
  for (let k = 1; k < nz - 1; k += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      for (let i = 1; i < nx - 1; i += 1) {
        const a = values[at(i, j, k)] < 0
        if (a === (values[at(i, j + 1, k)] < 0)) continue
        quad(cubeVertex[cubeAt(i - 1, j, k - 1)], cubeVertex[cubeAt(i - 1, j, k)], cubeVertex[cubeAt(i, j, k)], cubeVertex[cubeAt(i, j, k - 1)], !a)
      }
    }
  }
  for (let k = 0; k < nz - 1; k += 1) {
    for (let j = 1; j < ny - 1; j += 1) {
      if (clock() - since > STEP_MS) { yield; since = clock() }
      for (let i = 1; i < nx - 1; i += 1) {
        const a = values[at(i, j, k)] < 0
        if (a === (values[at(i, j, k + 1)] < 0)) continue
        quad(cubeVertex[cubeAt(i - 1, j - 1, k)], cubeVertex[cubeAt(i, j - 1, k)], cubeVertex[cubeAt(i, j, k)], cubeVertex[cubeAt(i - 1, j, k)], !a)
      }
    }
  }

  // Settle each vertex onto the surface and take the distance's own normal there.
  yield
  since = clock()
  const count = positions.length / 3
  const pos = new Float32Array(count * 3)
  const nrm = new Float32Array(count * 3)
  const q = [0, 0, 0]
  const e = cell * 0.05
  const grad = (out) => {
    const x = q[0], y = q[1], z = q[2]
    q[0] = x + e; const gx1 = sdf(q); q[0] = x - e; const gx0 = sdf(q); q[0] = x
    q[1] = y + e; const gy1 = sdf(q); q[1] = y - e; const gy0 = sdf(q); q[1] = y
    q[2] = z + e; const gz1 = sdf(q); q[2] = z - e; const gz0 = sdf(q); q[2] = z
    out[0] = gx1 - gx0; out[1] = gy1 - gy0; out[2] = gz1 - gz0
    const l = Math.hypot(out[0], out[1], out[2]) || 1
    out[0] /= l; out[1] /= l; out[2] /= l
  }
  const g = [0, 0, 0]
  for (let v = 0; v < count; v += 1) {
    if (clock() - since > STEP_MS) { yield; since = clock() }
    q[0] = positions[v * 3]; q[1] = positions[v * 3 + 1]; q[2] = positions[v * 3 + 2]
    for (let step = 0; step < 2; step += 1) {
      const d = sdf(q)
      if (Math.abs(d) > cell) break
      grad(g)
      q[0] -= g[0] * d; q[1] -= g[1] * d; q[2] -= g[2] * d
    }
    grad(g)
    pos[v * 3] = q[0]; pos[v * 3 + 1] = q[1]; pos[v * 3 + 2] = q[2]
    nrm[v * 3] = g[0]; nrm[v * 3 + 1] = g[1]; nrm[v * 3 + 2] = g[2]
  }
  yield
  const tri = count < 65536 ? new Uint16Array(triangles) : new Uint32Array(triangles)
  return { pos, nrm, tri }
}

const dist2 = (positions, a, b) => {
  const dx = positions[a * 3] - positions[b * 3]
  const dy = positions[a * 3 + 1] - positions[b * 3 + 1]
  const dz = positions[a * 3 + 2] - positions[b * 3 + 2]
  return dx * dx + dy * dy + dz * dz
}
