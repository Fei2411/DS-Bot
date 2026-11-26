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
const MAX_CONCURRENT = 2
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 }

let worker = null
let idle
let nextId = 0
const waiting = new Map()
const queue = []

function scheduleIdle() {
  clearTimeout(idle)
  if (worker === null || waiting.size > 0 || queue.length > 0) return
  worker.unref()
  idle = setTimeout(() => {
    if (waiting.size === 0 && queue.length === 0) stopWorker()
  }, IDLE_MS)
  idle.unref()
}

function failWorker(target, error) {
  for (const [id, job] of waiting.entries()) {
    if (job.worker !== target) continue
    waiting.delete(id)
    clearTimeout(job.timer)
    job.reject(error)
  }
}

function stopWorker(target = worker) {
  if (target === null) return
  if (worker === target) worker = null
  clearTimeout(idle)
  failWorker(target, new Error('The preview worker stopped'))
  void target.terminate()
}

function start() {
  if (worker !== null) return worker
  const current = new Worker(new URL('./preview-worker.js', import.meta.url), {
    resourceLimits: WORKER_RESOURCE_LIMITS,
  })
  worker = current
  current.on('message', ({ id, data, error }) => {
    const job = waiting.get(id)
    if (job === undefined || job.worker !== current) return
    waiting.delete(id)
    clearTimeout(job.timer)
    if (error !== undefined) job.reject(new Error(error))
    else job.resolve(data === null ? null : Buffer.from(data))
    pump()
    scheduleIdle()
  })
  current.on('error', (error) => {
    if (worker !== current) return
    worker = null
    failWorker(current, error)
    void current.terminate()
    pump()
    scheduleIdle()
  })
  current.on('exit', () => {
    if (worker !== current) return
    worker = null
    failWorker(current, new Error('The preview worker stopped'))
    pump()
    scheduleIdle()
  })
  current.unref()
  return current
}

function pump() {
  while (waiting.size < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()
    clearTimeout(idle)
    const id = nextId++
    const current = start()
    current.ref()
    const timer = setTimeout(() => {
      const held = waiting.get(id)
      if (held === undefined) return
      waiting.delete(id)
      held.reject(new Error('The preview took too long'))
      stopWorker(current)
      pump()
      scheduleIdle()
    }, JOB_TIMEOUT_MS)
    timer.unref()
    waiting.set(id, { resolve: item.resolve, reject: item.reject, timer, worker: current })
    current.postMessage({
      id,
      bytes: item.bytes,
      mime: item.mime,
      edge: PREVIEW_EDGE,
      quality: QUALITY,
    })
  }
}

/** A JPEG preview of `bytes`, or null when the photo is small already or of a kind kept as it is. */
export function previewImage(bytes, mime) {
  if (!SHRINKS.has(String(mime).toLowerCase()) || bytes.length < PREVIEW_MIN_BYTES) return Promise.resolve(null)
  const normalized = String(mime).toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg'
  return new Promise((resolve, reject) => {
    queue.push({ bytes, mime: normalized, resolve, reject })
    pump()
  })
}
