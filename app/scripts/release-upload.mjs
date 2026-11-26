// Upload GitHub release assets concurrently with retry backoff so a multi-gigabyte
// release does not wait on one serial `gh release upload` stream or fail on a transient 5xx.
// Usage: node scripts/release-upload.mjs <tag> <file>...
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONCURRENCY = 5
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

function runGhUpload(tag, file) {
  return new Promise((done, fail) => {
    const child = spawn('gh', ['release', 'upload', tag, file, '--clobber'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk) })
    child.once('error', fail)
    child.once('close', (code, signal) => { done({ code, signal, stderr: stderr.trim() }) })
  })
}

async function uploadOne(tag, file, { runImpl, sleepImpl, retryDelaysMs, log }) {
  const label = basename(file)
  const attempts = retryDelaysMs.length + 1
  for (let attempt = 1; ; attempt += 1) {
    const { code, signal, stderr } = await runImpl(tag, file)
    if (code === 0 && signal === null) {
      log(`release-upload: uploaded ${label}`)
      return
    }
    const detail = signal !== null ? `signal ${signal}` : `exit ${String(code)}${stderr ? `: ${stderr}` : ''}`
    const delay = retryDelaysMs[attempt - 1]
    if (delay === undefined) {
      throw new Error(`release-upload: failed ${label} after ${String(attempts)} attempts (${detail})`)
    }
    log(`release-upload: ${label} attempt ${String(attempt)}/${String(attempts)} failed (${detail}); retrying in ${String(delay / 1000)} s`)
    await sleepImpl(delay)
  }
}

export async function uploadReleaseAssets(tag, files, options = {}) {
  if (!tag || !Array.isArray(files) || files.length === 0) {
    throw new Error('release-upload: usage: node scripts/release-upload.mjs <tag> <file>...')
  }
  const concurrency = Math.max(1, Math.min(files.length, options.concurrency ?? DEFAULT_CONCURRENCY))
  const runImpl = options.runImpl ?? runGhUpload
  const sleepImpl = options.sleepImpl ?? sleep
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const log = options.log ?? ((line) => { console.error(line) })

  let next = 0
  let failure
  const worker = async () => {
    while (failure === undefined) {
      const index = next
      if (index >= files.length) return
      next += 1
      try {
        await uploadOne(tag, files[index], { runImpl, sleepImpl, retryDelaysMs, log })
      } catch (error) {
        failure ??= error
        return
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (failure !== undefined) throw failure
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, ...files] = process.argv.slice(2)
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
