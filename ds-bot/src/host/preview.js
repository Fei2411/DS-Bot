// Small JPEG previews of chat photos for windows on a slow link (the phone app): the
// chat shows the preview and fetches the original only when the photo is opened.
import { Worker } from 'node:worker_threads'

// Long side in pixels: a chat tile is about 120 points, three pixels each on a phone.
export const PREVIEW_EDGE = 512
const QUALITY = 72
// A file this small costs less to send than to shrink.
export const PREVIEW_MIN_BYTES = 100_000
const SHRINKS = new Set(['image/jpeg', 'image/jpg', 'image/png'])
const JOB_TIMEOUT_MS = 20_000
// The worker holds a decoded photo's memory; it goes when nothing asked for a while.
const IDLE_MS = 60_000

let worker = null
let idle
let nextId = 0
const waiting = new Map()

function failAll(error) {
  for (const job of waiting.values()) { clearTimeout(job.timer); job.reject(error) }
  waiting.clear()
}

function stopWorker() {
  const running = worker
  worker = null
  void running?.terminate()
}

function start() {
  if (worker !== null) return worker
  worker = new Worker(new URL('./preview-worker.js', import.meta.url))
  worker.unref()
  worker.on('message', ({ id, data, error }) => {
    const job = waiting.get(id)
    if (job === undefined) return
    waiting.delete(id)
    clearTimeout(job.timer)
    if (error !== undefined) job.reject(new Error(error))
    else job.resolve(data === null ? null : Buffer.from(data))
  })
  worker.on('error', error => { failAll(error); stopWorker() })
  worker.on('exit', () => { failAll(new Error('The preview worker stopped')); worker = null })
  return worker
}

/** A JPEG preview of `bytes`, or null when the photo is small already or of a kind kept as it is. */
export function previewImage(bytes, mime) {
  if (!SHRINKS.has(String(mime).toLowerCase()) || bytes.length < PREVIEW_MIN_BYTES) return Promise.resolve(null)
  clearTimeout(idle)
  idle = setTimeout(stopWorker, IDLE_MS)
  idle.unref()
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('The preview took too long'))
      stopWorker()
    }, JOB_TIMEOUT_MS)
    timer.unref()
    waiting.set(id, { resolve, reject, timer })
    start().postMessage({ id, bytes, mime: String(mime).toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg', edge: PREVIEW_EDGE, quality: QUALITY })
  })
}
