import { random } from './engine.js'
import { eyePolygons } from './face.js'
import { LOOK_RAMP, LOOK_WAYS, rotation } from './rig.js'
import { silhouette } from './silhouette.js'

// Turns a rig and an engine frame into flat shapes in the mark's 100-unit box (y down):
// the body's loops (filled with the nonzero rule), the decals, and the eyes, which
// are cut out of everything so they show what lies behind the mark.

export function shapesOf(rig, frame, scratch = {}) {
  const { view, cx, cy, scale, bottom, mesh, sdf, look } = rig
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

  // A decal is many small faces; the ones facing the viewer go into one buffer per decal,
  // kept in `scratch`, as polygons ending at `ends[0 .. count - 1]`.
  if (scratch.paintRig !== rig) {
    scratch.paintRig = rig
    scratch.paints = rig.paints.map(({ fill, opacity, faces }) => ({
      fill, opacity, count: 0,
      points: new Float32Array(faces.reduce((sum, face) => sum + (face.points.length / 3) * 2, 0)),
      ends: new Int32Array(faces.length),
    }))
  }
  const paints = scratch.paints
  rig.paints.forEach(({ faces }, index) => {
    const paint = paints[index]
    let j = 0
    paint.count = 0
    for (const { points, normal } of faces) {
      if (normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2] <= 0) continue
      for (let i = 0; i < points.length; i += 3, j += 2) {
        place(R[0] * points[i] + R[1] * points[i + 1] + R[2] * points[i + 2], R[3] * points[i] + R[4] * points[i + 1] + R[5] * points[i + 2], paint.points, j)
      }
      paint.ends[paint.count] = j
      paint.count += 1
    }
  })

  const eyes = []
  const pupil = 1 + frame.pupil
  // A glance moves the eyes across the picture, as far as the face has room that way
  // for eyes this big (rig.look), turned with the body's lean.
  let gx = 0
  let gy = 0
  const reach = Math.min(1, Math.hypot(frame.gx, frame.gy))
  if (reach > 0) {
    const angle = Math.atan2(frame.gy, frame.gx)
    const at = (((angle / (2 * Math.PI)) * LOOK_WAYS) % LOOK_WAYS + LOOK_WAYS) % LOOK_WAYS
    const k = Math.floor(at)
    const grown = Math.min(1, Math.max(0, pupil * Math.max(...frame.face.map(eye => Math.max(eye.w ?? 1, eye.h ?? 1))) - 1) / LOOK_RAMP)
    const way = (i) => look.ways[i] + (look.big[i] - look.ways[i]) * grown
    const room = way(k) + (way((k + 1) % LOOK_WAYS) - way(k)) * (at - k)
    gx = Math.cos(angle) * reach * room
    gy = Math.sin(angle) * reach * room
  }
  const lean = (frame.roll * Math.PI) / 180
  const glance = [s * sx * (gx * Math.cos(lean) + gy * Math.sin(lean)), s * sy * (gy * Math.cos(lean) - gx * Math.sin(lean))]
  rig.eyes.forEach((eye, index) => {
    const { p } = eye
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
    center[0] += glance[0]
    center[1] += glance[1]
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
function polygon(ctx, pts, from = 0, to = pts.length) {
  ctx.moveTo(pts[from], pts[from + 1])
  for (let i = from + 2; i < to; i += 2) ctx.lineTo(pts[i], pts[i + 1])
  ctx.closePath()
}
// The polygons of a decal: [from, to) ranges of its points.
function* decalPolys(paint) {
  for (let k = 0, from = 0; k < paint.count; k += 1) {
    yield [from, paint.ends[k]]
    from = paint.ends[k]
  }
}

// `ink` is the body's paint: a color string or a CanvasGradient. `confetti` lists the
// colors a spin's confetti mixes with the body's own.
export function drawShapes(ctx, shapes, ink, confetti = []) {
  ctx.fillStyle = ink
  ctx.beginPath()
  for (const loop of shapes.body) smoothLoop(ctx, loop)
  ctx.fill('nonzero')
  // Decals only land on the body: near the outline a facet can face the viewer
  // while the smooth surface has already turned away.
  ctx.globalCompositeOperation = 'source-atop'
  for (const paint of shapes.paints) {
    if (paint.count === 0) continue
    ctx.globalAlpha = paint.opacity
    ctx.fillStyle = paint.fill
    ctx.beginPath()
    for (let k = 0, from = 0; k < paint.count; from = paint.ends[k], k += 1) polygon(ctx, paint.points, from, paint.ends[k])
    ctx.fill('nonzero')
    ctx.globalAlpha = 1
  }
  ctx.globalCompositeOperation = 'source-over'
  // Confetti comes from behind the body. It goes in after the decals (which paint only
  // on what is already drawn) and before the eyes are cut out.
  if (shapes.accent?.kind === 'confetti') {
    ctx.globalCompositeOperation = 'destination-over'
    drawConfetti(ctx, shapes.accent, [ink, ...confetti])
    ctx.globalCompositeOperation = 'source-over'
  }
  if (shapes.eyes.length > 0) {
    // Only the fill's opacity counts when cutting out; the body's own ink is opaque.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = ink
    ctx.beginPath()
    for (const eye of shapes.eyes) polygon(ctx, eye)
    ctx.fill('nonzero')
    ctx.globalCompositeOperation = 'source-over'
  }
  if (shapes.accent && shapes.accent.kind !== 'confetti') drawAccent(ctx, shapes.accent, ink, shapes.offset)
}

// A spin throws confetti: paper bits that tumble and streamers that curl, bursting up
// from behind the body, slowing in the air and falling. Each burst has its own start and
// seed (accent.bursts), and it stays inside the canvas margin (MARGIN in stage.js).
const CONFETTI = 18
function drawConfetti(ctx, accent, colors) {
  for (const { at, seed } of accent.bursts) drawBurst(ctx, accent.t - at, seed, colors)
}
function drawBurst(ctx, t, seed, colors) {
  const rng = random(seed)
  const drag = 2.4
  const flight = (1 - Math.exp(-drag * t)) / drag
  const fall = 0.5 * 75 * t * t
  const alpha = Math.min(1, t / 0.06) * Math.max(0, Math.min(1, (1.7 - t) / 0.5))
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  for (let index = 0; index < CONFETTI; index += 1) {
    const angle = -Math.PI / 2 + (rng() * 2 - 1) * 1.2
    const speed = 100 + rng() * 60
    const spin = (rng() * 2 - 1) * 9
    const tilt = rng() * Math.PI
    const x = 50 + Math.cos(angle) * speed * flight
    const y = 40 + Math.sin(angle) * speed * flight + fall
    const color = colors[index % colors.length]
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(tilt + spin * t)
    if (index % 3 === 0) {
      // A streamer: a short ribbon that curls as it flutters.
      const curl = Math.sin(t * 11 + tilt * 3) * 2.6
      ctx.strokeStyle = color
      ctx.lineWidth = 1.7
      ctx.beginPath()
      ctx.moveTo(-5, 0)
      ctx.bezierCurveTo(-2, -curl, 2, curl, 5, 0)
      ctx.stroke()
    } else {
      // A paper bit, turning over: its width narrows as it shows its edge.
      const w = 4.4 * Math.max(0.15, Math.abs(Math.cos(t * 13 + tilt)))
      ctx.fillStyle = color
      ctx.fillRect(-w / 2, -1.3, w, 2.6)
    }
    ctx.restore()
  }
  ctx.restore()
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
  const poly = (pts, from = 0, to = pts.length) => {
    let d = `M${fmt(pts[from])} ${fmt(pts[from + 1])}`
    for (let i = from + 2; i < to; i += 2) d += `L${fmt(pts[i])} ${fmt(pts[i + 1])}`
    return `${d}Z`
  }
  return {
    body: shapes.body.map(loop).join(''),
    paints: shapes.paints.map(paint => ({ fill: paint.fill, opacity: paint.opacity, d: [...decalPolys(paint)].map(([from, to]) => poly(paint.points, from, to)).join('') })),
    eyes: shapes.eyes.map(pts => poly(pts)).join(''),
  }
}
