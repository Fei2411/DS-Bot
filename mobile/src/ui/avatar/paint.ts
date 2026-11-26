import { drawShapes } from '../../../../ds-bot/src/client/avatar/render.js'
import type { Shapes } from './clock.ts'

// The phone has no 2D canvas, so a live mark is drawn as SVG. Rather than drawing the
// shapes a second way, the desktop's own drawing (avatar/render.js drawShapes) runs on a
// stand-in for a canvas that writes down what it is asked to paint: each fill or stroke
// becomes a path in the mark's 100-unit box, and the canvas's ways of laying paint over
// paint become SVG structure:
//
//   source-over       on top of what is there
//   source-atop       on top, clipped to what is there (the decals on the body)
//   destination-over  under what is there (the confetti behind the body)
//   destination-out   cut out of what is there, by a mask (the eyes)
//
// Only what drawShapes uses is here: paths of lines and curves, arcs, rectangles,
// translate/rotate/scale, save/restore, alpha, and linear gradients.

export class Gradient {
  readonly from: [number, number]
  readonly to: [number, number]
  readonly stops: [number, string][] = []
  constructor(from: [number, number], to: [number, number]) { this.from = from; this.to = to }
  addColorStop(offset: number, color: string) { this.stops.push([offset, color]) }
}
export type Ink = string | Gradient

export interface Op {
  d: string
  fill?: Ink
  stroke?: Ink
  width?: number
  cap?: string
  join?: string
  alpha: number
}
export type Node =
  | { op: Op }
  | { clip: string; nodes: Node[] }
  | { cut: { d: string; alpha: number }[]; nodes: Node[] }

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const mul = (m: Matrix, [a, b, c, d, e, f]: Matrix): Matrix => [
  m[0] * a + m[2] * b, m[1] * a + m[3] * b,
  m[0] * c + m[2] * d, m[1] * c + m[3] * d,
  m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5],
]
const fmt = (v: number) => (Math.round(v * 100) / 100).toString()

interface Style {
  m: Matrix
  fillStyle: Ink
  strokeStyle: Ink
  globalAlpha: number
  lineWidth: number
  lineCap: string
  lineJoin: string
  globalCompositeOperation: string
}

export class PaintRecorder {
  // Canvas state; drawShapes sets these as on a canvas.
  fillStyle: Ink = '#000'
  strokeStyle: Ink = '#000'
  globalAlpha = 1
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  globalCompositeOperation = 'source-over'
  private m: Matrix = IDENTITY
  private readonly stack: Style[] = []
  private path = ''
  private open = false
  // What has been painted, bottom first, and the fills that cover the current layer
  // (the shape a later source-atop paint is clipped to).
  private nodes: Node[] = []
  private cover: string[] = []

  scene(): Node[] { return this.nodes }

  // ---- State.
  save() {
    this.stack.push({ m: this.m, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin, globalCompositeOperation: this.globalCompositeOperation })
  }
  restore() {
    const s = this.stack.pop()
    if (!s) return
    this.m = s.m
    this.fillStyle = s.fillStyle
    this.strokeStyle = s.strokeStyle
    this.globalAlpha = s.globalAlpha
    this.lineWidth = s.lineWidth
    this.lineCap = s.lineCap
    this.lineJoin = s.lineJoin
    this.globalCompositeOperation = s.globalCompositeOperation
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.m = [a, b, c, d, e, f] }
  translate(x: number, y: number) { this.m = mul(this.m, [1, 0, 0, 1, x, y]) }
  rotate(angle: number) { const c = Math.cos(angle), s = Math.sin(angle); this.m = mul(this.m, [c, s, -s, c, 0, 0]) }
  scale(x: number, y: number) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]) }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number) { return new Gradient([x0, y0], [x1, y1]) }
  clearRect() {}

  // ---- Paths, written in the box with the transform applied.
  private pt(x: number, y: number) {
    const [a, b, c, d, e, f] = this.m
    return `${fmt(a * x + c * y + e)} ${fmt(b * x + d * y + f)}`
  }
  beginPath() { this.path = ''; this.open = false }
  moveTo(x: number, y: number) { this.path += `M${this.pt(x, y)}`; this.open = true }
  lineTo(x: number, y: number) { this.path += `L${this.pt(x, y)}` }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) { this.path += `Q${this.pt(cx, cy)} ${this.pt(x, y)}` }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) { this.path += `C${this.pt(c1x, c1y)} ${this.pt(c2x, c2y)} ${this.pt(x, y)}` }
  closePath() { if (this.open) this.path += 'Z' }
  // An arc as cubic pieces of at most a quarter turn, so any transform keeps it exact.
  // As on a canvas, it joins the path with a line, or starts it.
  arc(x: number, y: number, r: number, from: number, to: number, ccw = false) {
    const full = 2 * Math.PI
    const sweep = ccw
      ? (from - to >= full ? -full : -((((from - to) % full) + full) % full))
      : (to - from >= full ? full : (((to - from) % full) + full) % full)
    const sx = x + r * Math.cos(from), sy = y + r * Math.sin(from)
    if (this.open) this.path += `L${this.pt(sx, sy)}`
    else { this.path += `M${this.pt(sx, sy)}`; this.open = true }
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
    const step = sweep / pieces
    const k = (4 / 3) * Math.tan(step / 4)
    let a = from
    for (let i = 0; i < pieces; i += 1) {
      const b = a + step
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b)
      this.path += `C${this.pt(x + r * (ca - k * sa), y + r * (sa + k * ca))} ${this.pt(x + r * (cb + k * sb), y + r * (sb - k * cb))} ${this.pt(x + r * cb, y + r * sb)}`
      a = b
    }
  }

  // ---- Painting.
  fill() { if (this.path) this.place({ d: this.path, fill: this.ink(this.fillStyle), alpha: this.globalAlpha }) }
  stroke() {
    if (!this.path) return
    const [a, b, c, d] = this.m
    const width = this.lineWidth * Math.sqrt(Math.abs(a * d - b * c))
    this.place({ d: this.path, stroke: this.ink(this.strokeStyle), width, cap: this.lineCap, join: this.lineJoin, alpha: this.globalAlpha })
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const d = `M${this.pt(x, y)}L${this.pt(x + w, y)}L${this.pt(x + w, y + h)}L${this.pt(x, y + h)}Z`
    this.place({ d, fill: this.ink(this.fillStyle), alpha: this.globalAlpha })
  }

  // A gradient lies in the space it is painted in, as on a canvas.
  private ink(paint: Ink): Ink {
    const [a, b, c, d, e, f] = this.m
    if (!(paint instanceof Gradient) || (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0)) return paint
    const at = ([x, y]: [number, number]): [number, number] => [a * x + c * y + e, b * x + d * y + f]
    const moved = new Gradient(at(paint.from), at(paint.to))
    for (const [offset, color] of paint.stops) moved.addColorStop(offset, color)
    return moved
  }

  private place(op: Op) {
    switch (this.globalCompositeOperation) {
      case 'source-atop': {
        const last = this.nodes[this.nodes.length - 1]
        const clip = this.cover.join('')
        if (last && 'clip' in last && last.clip === clip) last.nodes.push({ op })
        else this.nodes.push({ clip, nodes: [{ op }] })
        return
      }
      case 'destination-over':
        this.nodes.unshift({ op })
        if (op.fill) this.cover.push(op.d)
        return
      case 'destination-out': {
        const last = this.nodes.length === 1 ? this.nodes[0] : undefined
        if (last && 'cut' in last) last.cut.push({ d: op.d, alpha: op.alpha })
        else this.nodes = [{ cut: [{ d: op.d, alpha: op.alpha }], nodes: this.nodes }]
        return
      }
      default:
        this.nodes.push({ op })
        if (op.fill) this.cover.push(op.d)
    }
  }
}

// A mark's shapes as SVG: the body's paint (a color, or a gradient made with
// `gradient`), and the colors a spin's confetti mixes with it.
export function paintShapes(shapes: Shapes, ink: string | [number, string][], confetti?: string[]): Node[] {
  const recorder = new PaintRecorder()
  let paint: Ink
  if (typeof ink === 'string') paint = ink
  else {
    // The same gradient the page paints (avatar/live.js ink), over the 100-unit box.
    const gradient = recorder.createLinearGradient(18, 10, 78, 92)
    for (const [offset, color] of ink) gradient.addColorStop(offset, color)
    paint = gradient
  }
  drawShapes(recorder, shapes, paint, confetti)
  return recorder.scene()
}
