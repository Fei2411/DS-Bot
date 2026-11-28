// Upload GitHub release assets concurrently with retry backoff so a multi-gigabyte
// release does not wait on one serial `gh release upload` stream or fail on a transient 5xx.
// Usage: node scripts/release-upload.mjs <tag> <file>...
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONCURRENCY = 5
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]
// GitHub's REST rate-limit guidance requires waiting at least 60s after a secondary rate limit
// when Retry-After is unavailable, increasing the backoff on repeated throttles.
const DEFAULT_RATE_LIMIT_RETRY_DELAYS_MS = [60_000, 120_000, 180_000]
const RATE_LIMIT_STDERR = /\bHTTP 429\b|rate limit|secondary rate|abuse detection/iu
// GitHub returns HTTP 403 for primary/secondary rate limits and HTTP 422 with
// `ReleaseAsset.name already exists` when an earlier 502 leaves an empty starter asset;
// both are transient and recoverable via a fresh `gh release upload --clobber` attempt.
const RETRYABLE_OVERRIDE_STDERR = /rate limit|secondary rate|abuse detection|ReleaseAsset\.name already exists|\balready_exists\b/iu
// Deterministic client/auth/target errors will not succeed on retry (408 and 429 are transient).
const NON_RETRYABLE_STDERR = /\bHTTP (?:400|401|403|404|405|410|413|422)\b|release not found|not found \(HTTP 404\)|authentication|Bad credentials/iu

export function isRateLimitError(stderr) {
  return typeof stderr === 'string' && RATE_LIMIT_STDERR.test(stderr)
}

export function isRetryableUploadError(stderr) {
  if (typeof stderr !== 'string' || stderr.trim() === '') return true
  if (RETRYABLE_OVERRIDE_STDERR.test(stderr)) return true
  return !NON_RETRYABLE_STDERR.test(stderr)
}

function sleep(ms, signal) {
  return new Promise((done) => {
    if (signal?.aborted) { done(); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      done()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      done()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Do not kill an already-started `gh release upload --clobber` process on sibling failure:
// `--clobber` deletes an existing release asset before streaming the replacement, so
// terminating it mid-transfer could leave a rerun release missing that asset.
export function runGhUpload(tag, file) {
  return new Promise((done, fail) => {
    const child = spawn('gh', ['release', 'upload', tag, file, '--clobber'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk) })
    child.once('error', fail)
    child.once('close', (code, signal) => { done({ code, signal, stderr: stderr.trim() }) })
  })
}

async function uploadOne(tag, file, { runImpl, sleepImpl, retryDelaysMs, rateLimitRetryDelaysMs, log, abortSignal }) {
  const label = basename(file)
  for (let attempt = 1; ; attempt += 1) {
    if (abortSignal.aborted) return
    const { code, signal, stderr } = await runImpl(tag, file)
    if (code === 0 && signal === null) {
      log(`release-upload: uploaded ${label}`)
      return
    }
    if (abortSignal.aborted) return
    const detail = signal !== null ? `signal ${signal}` : `exit ${String(code)}${stderr ? `: ${stderr}` : ''}`
    if (signal !== null) {
      throw new Error(`release-upload: ${label} terminated (${detail})`)
    }
    const schedule = isRateLimitError(stderr) ? rateLimitRetryDelaysMs : retryDelaysMs
    const attempts = schedule.length + 1
    const delay = isRetryableUploadError(stderr) ? schedule[attempt - 1] : undefined
    if (delay === undefined || abortSignal.aborted) {
      throw new Error(`release-upload: failed ${label} after ${String(attempt)}/${String(attempts)} attempts (${detail})`)
    }
    log(`release-upload: ${label} attempt ${String(attempt)}/${String(attempts)} failed (${detail}); retrying in ${String(delay / 1000)} s`)
    await sleepImpl(delay, abortSignal)
  }
}

export async function uploadReleaseAssets(tag, files, options = {}) {
  if (!tag || !Array.isArray(files) || files.length === 0) {
    throw new Error('release-upload: usage: node scripts/release-upload.mjs <tag> <file>...')
  }
  const requested = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('release-upload: concurrency must be a positive integer')
  }
  const concurrency = Math.min(files.length, requested)
  const runImpl = options.runImpl ?? runGhUpload
  const sleepImpl = options.sleepImpl ?? sleep
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const rateLimitRetryDelaysMs = options.rateLimitRetryDelaysMs
    ?? (retryDelaysMs.length === 0 ? [] : DEFAULT_RATE_LIMIT_RETRY_DELAYS_MS)
  const log = options.log ?? ((line) => { console.error(line) })

  const controller = new AbortController()
  let next = 0
  let failure
  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = next
      if (index >= files.length) return
      next += 1
      try {
        await uploadOne(tag, files[index], { runImpl, sleepImpl, retryDelaysMs, rateLimitRetryDelaysMs, log, abortSignal: controller.signal })
      } catch (error) {
        if (failure === undefined) failure = error
        controller.abort()
        return
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (failure !== undefined) throw failure
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, ...files] = process.argv.slice(2)
  if (!tag || files.length === 0) {
    console.error('release-upload: usage: node scripts/release-upload.mjs <tag> <file>...')
    process.exit(2)
  }
  const raw = process.env.DS_BOT_UPLOAD_CONCURRENCY
  const parsed = raw === undefined || raw === '' ? undefined : Number(raw)
  if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 1)) {
    console.error('release-upload: DS_BOT_UPLOAD_CONCURRENCY must be a positive integer')
    process.exit(2)
  }
  try {
    await uploadReleaseAssets(tag, files, { concurrency: parsed })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
