import { eyePolygons } from './face.js'
import { rotation } from './rig.js'
import { silhouette } from './silhouette.js'

// Turns a rig and an engine frame into flat shapes in the mark's 100-unit box (y down):
// the body's loops (filled with the nonzero rule), the decals, and the eyes, which
// are cut out of everything so they show what lies behind the mark.

// How far the eyes travel across the face at full glance, in object units.
const GAZE_X = 0.17
const GAZE_Y = 0.12

export function shapesOf(rig, frame, scratch = {}) {
  const { view, cx, cy, scale, bottom, mesh, sdf } = rig
  const R = rotation(view.yaw + frame.yaw, view.pitch + frame.pitch, view.roll + frame.roll, scratch.R)
  scratch.R = R
  const dir = [R[6], R[7], R[8]]
  // The pose's flat part: squash on the feet, grow from the middle, then move.
  const sy = 1 - clamp(frame.sq, -0.4, 0.4)
  const sx = 1 / sy
  const s = 1 + frame.scale
  const ox = 50 + frame.x
  const oy = 50 + frame.y
  const place = (wx, wy, out, at) => {
    const bx = 50 + (wx - cx) * scale
    const by = 50 - (wy - cy) * scale
    out[at] = ox + s * sx * (bx - 50)
    out[at + 1] = oy + s * (bottom + sy * (by - bottom) - 50)
  }

  const body = silhouette(mesh, dir, scratch).map((loop) => {
    const out = new Float32Array((loop.length / 3) * 2)
    for (let i = 0, j = 0; i < loop.length; i += 3, j += 2) {
      place(R[0] * loop[i] + R[1] * loop[i + 1] + R[2] * loop[i + 2], R[3] * loop[i] + R[4] * loop[i + 1] + R[5] * loop[i + 2], out, j)
    }
    return out
  })

  const paints = rig.paints.map(({ fill, opacity, faces }) => {
    const polys = []
    for (const { points, normal } of faces) {
      if (normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2] <= 0) continue
      const out = new Float32Array((points.length / 3) * 2)
      for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
        place(R[0] * points[i] + R[1] * points[i + 1] + R[2] * points[i + 2], R[3] * points[i] + R[4] * points[i + 1] + R[5] * points[i + 2], out, j)
      }
      polys.push(out)
    }
    return { fill, opacity, polys }
  })

  const eyes = []
  const pupil = 1 + frame.pupil
  rig.eyes.forEach((eye, index) => {
    // The spot, moved across the surface by the glance.
    const gx = frame.gx * GAZE_X
    const gy = frame.gy * GAZE_Y
    const p = [
      eye.p[0] + gx * eye.u[0] - gy * eye.v[0],
      eye.p[1] + gx * eye.u[1] - gy * eye.v[1],
      eye.p[2] + gx * eye.u[2] - gy * eye.v[2],
    ]
    if (gx !== 0 || gy !== 0) onSurface(sdf, p)
    const { n, u, v } = surfaceFrame(sdf, p)
    const facing = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]
    if (facing <= 0.02) return
    const ux = R[0] * u[0] + R[1] * u[1] + R[2] * u[2]
    const uy = R[3] * u[0] + R[4] * u[1] + R[5] * u[2]
    const vx = R[0] * v[0] + R[1] * v[1] + R[2] * v[2]
    const vy = R[3] * v[0] + R[4] * v[1] + R[5] * v[2]
    // As in the traced art: the eye's width and height shrink with the surface's turn,
    // and it leans with the surface's up direction.
    const W = eye.w * eye.size * Math.hypot(ux, uy) * Math.min(1, facing / 0.15) * pupil
    const H = eye.h * eye.size * Math.hypot(vx, vy) * pupil
    const tilt = Math.atan2(vx, vy)
    const c = Math.cos(tilt), sn = Math.sin(tilt)
    const center = [0, 0]
    place(R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], center, 0)
    const shape = frame.face[index] ?? frame.face[0]
    for (const poly of eyePolygons(shape, W, H, index === 0 ? -1 : 1, frame.closed[index] ?? 0)) {
      const out = new Float32Array(poly.length)
      for (let i = 0; i < poly.length; i += 2) {
        // Local box → screen box, then the squash around the eye's own center.
        const lx = poly[i] * c - poly[i + 1] * sn
        const ly = poly[i] * sn + poly[i + 1] * c
        out[i] = center[0] + lx * s * sx
        out[i + 1] = center[1] + ly * s * sy
      }
      eyes.push(out)
    }
  })
  return { body, paints, eyes, accent: frame.accent, offset: [frame.x, frame.y] }
}

function surfaceFrame(sdf, p) {
  const n = normalAt(sdf, p)
  let u = [n[2], 0, -n[0]] // cross([0, 1, 0], n)
  const l = Math.hypot(u[0], u[2])
  u = l < 1e-6 ? [1, 0, 0] : [u[0] / l, 0, u[2] / l]
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  return { n, u, v }
}

function normalAt(sdf, p) {
  const e = 1e-3
  const q = [p[0], p[1], p[2]]
  const g = [0, 0, 0]
  for (let axis = 0; axis < 3; axis += 1) {
    q[axis] = p[axis] + e
    const a = sdf(q)
    q[axis] = p[axis] - e
    const b = sdf(q)
    q[axis] = p[axis]
    g[axis] = a - b
  }
  const l = Math.hypot(g[0], g[1], g[2]) || 1
  return [g[0] / l, g[1] / l, g[2] / l]
}

function onSurface(sdf, p) {
  for (let step = 0; step < 3; step += 1) {
    const d = sdf(p)
    if (Math.abs(d) < 1e-4) return
    const n = normalAt(sdf, p)
    p[0] -= n[0] * d; p[1] -= n[1] * d; p[2] -= n[2] * d
  }
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

// ---------------------------------------------------------------------------
// Drawing.

// A closed loop through midpoints, so the body's outline is smooth between samples.
function smoothLoop(ctx, pts) {
  const n = pts.length / 2
  if (n < 3) return
  const mx = (pts[(n - 1) * 2] + pts[0]) / 2
  const my = (pts[(n - 1) * 2 + 1] + pts[1]) / 2
  ctx.moveTo(mx, my)
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n
    ctx.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[j * 2]) / 2, (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2)
  }
  ctx.closePath()
}
function polygon(ctx, pts) {
  ctx.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
  ctx.closePath()
}

// `ink` is the body's paint: a color string or a CanvasGradient.
export function drawShapes(ctx, shapes, ink) {
  ctx.fillStyle = ink
  ctx.beginPath()
  for (const loop of shapes.body) smoothLoop(ctx, loop)
  ctx.fill('nonzero')
  // Decals only land on the body: near the outline a facet can face the viewer
  // while the smooth surface has already turned away.
  ctx.globalCompositeOperation = 'source-atop'
  for (const paint of shapes.paints) {
    if (paint.polys.length === 0) continue
    ctx.globalAlpha = paint.opacity
    ctx.fillStyle = paint.fill
    ctx.beginPath()
    for (const poly of paint.polys) polygon(ctx, poly)
    ctx.fill('nonzero')
    ctx.globalAlpha = 1
  }
  ctx.globalCompositeOperation = 'source-over'
  if (shapes.eyes.length > 0) {
    // Only the fill's opacity counts when cutting out; the body's own ink is opaque.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = ink
    ctx.beginPath()
    for (const eye of shapes.eyes) polygon(ctx, eye)
    ctx.fill('nonzero')
    ctx.globalCompositeOperation = 'source-over'
  }
  if (shapes.accent) drawAccent(ctx, shapes.accent, ink, shapes.offset)
}

const wave = t => 0.5 - 0.5 * Math.cos(t * Math.PI * 2)

// Flourishes around the body, in its own color.
function drawAccent(ctx, accent, ink, [ox, oy]) {
  const { kind, t } = accent
  ctx.save()
  ctx.translate(ox * 0.5, oy * 0.5)
  ctx.fillStyle = ink
  ctx.strokeStyle = ink
  if (kind === 'dots') {
    // A thought, one dot after another.
    const dots = [[82, 10, 3.4], [93, 0, 4.4], [106, -12, 5.6]]
    dots.forEach(([x, y, r], index) => {
      const phase = ((t - index * 0.24) % 1.5 + 1.5) % 1.5
      const k = phase < 0.9 ? wave(phase / 0.9) : 0
      ctx.globalAlpha = Math.min(1, t * 2) * (0.28 + 0.6 * k)
      ctx.beginPath()
      ctx.arc(x, y - k * 1.5, r * (0.9 + 0.15 * k), 0, Math.PI * 2)
      ctx.fill()
    })
  } else if (kind === 'z') {
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let index = 0; index < 2; index += 1) {
      const phase = ((t / 2.6 - index * 0.5) % 1 + 1) % 1
      const size = 7 + phase * 5
      const x = 80 + phase * 14
      const y = 16 - phase * 26
      ctx.globalAlpha = Math.min(1, t) * Math.sin(phase * Math.PI) * 0.8
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + size, y)
      ctx.lineTo(x, y + size)
      ctx.lineTo(x + size, y + size)
      ctx.stroke()
    }
  } else if (kind === 'sparkle') {
    // Small four-point stars burst out and fade.
    const k = Math.min(1, t / 1.1)
    for (let index = 0; index < 5; index += 1) {
      const angle = -Math.PI / 2 + (index - 2) * 0.62
      const reach = 40 + 24 * easeOut(k)
      const x = 50 + Math.cos(angle) * reach
      const y = 48 + Math.sin(angle) * reach * 0.9
      const r = (index % 2 ? 4.2 : 5.6) * Math.sin(Math.min(1, k * 1.3) * Math.PI)
      if (r <= 0) continue
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(x, y - r)
      ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.quadraticCurveTo(x, y, x, y + r)
      ctx.quadraticCurveTo(x, y, x - r, y)
      ctx.quadraticCurveTo(x, y, x, y - r)
      ctx.fill()
    }
  }
  ctx.restore()
}
const easeOut = t => 1 - (1 - t) ** 3

// SVG path data for the same shapes, for renderers without a canvas (the phone app).
const fmt = v => (Math.round(v * 100) / 100).toString()
export function pathsOf(shapes) {
  const loop = (pts) => {
    const n = pts.length / 2
    if (n < 3) return ''
    let d = `M${fmt((pts[(n - 1) * 2] + pts[0]) / 2)} ${fmt((pts[(n - 1) * 2 + 1] + pts[1]) / 2)}`
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      d += `Q${fmt(pts[i * 2])} ${fmt(pts[i * 2 + 1])} ${fmt((pts[i * 2] + pts[j * 2]) / 2)} ${fmt((pts[i * 2 + 1] + pts[j * 2 + 1]) / 2)}`
    }
    return `${d}Z`
  }
  const poly = (pts) => {
    let d = `M${fmt(pts[0])} ${fmt(pts[1])}`
    for (let i = 2; i < pts.length; i += 2) d += `L${fmt(pts[i])} ${fmt(pts[i + 1])}`
    return `${d}Z`
  }
  return {
    body: shapes.body.map(loop).join(''),
    paints: shapes.paints.map(paint => ({ fill: paint.fill, opacity: paint.opacity, d: paint.polys.map(poly).join('') })),
    eyes: shapes.eyes.map(poly).join(''),
  }
}
