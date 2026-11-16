// Shrinks one photo off the main thread: decoding a camera JPEG takes long enough to
// stall every Bot's turn if it ran beside them. Pure JS, so it needs nothing built.
import { parentPort } from 'node:worker_threads'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

parentPort?.on('message', ({ id, bytes, mime, edge, quality }) => {
  try {
    parentPort.postMessage({ id, data: shrink(Buffer.from(bytes), mime, edge, quality) })
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) })
  }
})

function decode(bytes, mime) {
  if (mime === 'image/png') return PNG.sync.read(bytes)
  return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 64, maxMemoryUsageInMB: 512 })
}

// Area average into a box at most `edge` on its long side, over white where it is
// transparent. Null when the photo is already that small.
export function shrink(bytes, mime, edge, quality) {
  const { width, height, data } = decode(bytes, mime)
  if (Math.max(width, height) <= edge) return null
  const scale = edge / Math.max(width, height)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const sums = new Float64Array(w * h * 3)
  const counts = new Uint32Array(w * h)
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(h - 1, Math.floor((y * h) / height)) * w
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      const cell = row + Math.min(w - 1, Math.floor((x * w) / width))
      const alpha = data[at + 3] / 255
      const white = 255 * (1 - alpha)
      sums[cell * 3] += data[at] * alpha + white
      sums[cell * 3 + 1] += data[at + 1] * alpha + white
      sums[cell * 3 + 2] += data[at + 2] * alpha + white
      counts[cell] += 1
    }
  }
  const out = Buffer.alloc(w * h * 4)
  for (let cell = 0; cell < w * h; cell += 1) {
    const count = counts[cell] || 1
    out[cell * 4] = sums[cell * 3] / count
    out[cell * 4 + 1] = sums[cell * 3 + 1] / count
    out[cell * 4 + 2] = sums[cell * 3 + 2] / count
    out[cell * 4 + 3] = 255
  }
  return jpeg.encode({ data: out, width: w, height: h }, quality).data
}
