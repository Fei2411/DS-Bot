// `npm run dist`: electron-builder, run again when a download from GitHub releases fails with a
// gateway error. electron-builder retries the Electron zip itself, but only for a few seconds, and
// its build tools (7-Zip, NSIS, AppImage, fpm, icons) not at all; the release CDN answers 5xx for
// minutes at a time. Finished downloads stay in electron-builder's cache, so a new run picks up
// where the failed one stopped.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const RETRY_DELAYS_MS = [30_000, 90_000, 180_000]
const TAIL_CHARS = 64 * 1024

// electron-builder ends a failed build with a ⨯ line for the error that stopped it. Only that
// last line counts: prepare-runtime.mjs logs every failed attempt it retries, so a 504 earlier
// in the output says nothing about an archive that then answers 404. The lines it ends with when
// an answer, not the build, failed:
//   ⨯ Response code 504 (Gateway Time-out)  failedTask=build stackTrace=HTTPError: ...
//   ⨯ failed to build AppImage  error=Response code 504 (Gateway Time-out)
//   ⨯ primary runtime download: 504 https://github.com/astral-sh/python-build-standalone/...
const GATEWAY_FAILURE = /Response code (?:5\d\d|429|408)\b|primary runtime download: (?:5\d\d|429|408) /u

/**
 * The line that shows a run failed on a download answer that may succeed later.
 * @param {string} output - The run's output.
 * @returns {string | undefined} the line, or undefined when the build itself failed
 */
export function gatewayFailure(output) {
  const last = output.match(/^\s*⨯ .*$/gmu)?.at(-1)?.trim()
  return last !== undefined && GATEWAY_FAILURE.test(last) ? last : undefined
}

/** @param {number} ms - Delay in milliseconds. @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

/**
 * Run electron-builder once, passing its output through and keeping the end of it.
 * @param {string[]} args - electron-builder arguments.
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, output: string }>} how it ended
 */
function runOnce(args) {
  const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    const keep = (sink) => (chunk) => {
      sink.write(chunk)
      output = (output + chunk.toString('utf8')).slice(-TAIL_CHARS)
    }
    child.stdout.on('data', keep(process.stdout))
    child.stderr.on('data', keep(process.stderr))
    child.once('error', fail)
    child.once('close', (code, signal) => { done({ code, signal, output }) })
  })
}

/**
 * Run electron-builder until it succeeds, fails on its own, or the retries run out.
 * @param {string[]} args - electron-builder arguments.
 * @param {{ runImpl?: typeof runOnce, sleepImpl?: (ms: number) => Promise<void>, retryDelaysMs?: number[], log?: (line: string) => void }} [options] - Test seams.
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} how the last run ended
 */
export async function dist(args, options = {}) {
  const runImpl = options.runImpl ?? runOnce
  const sleepImpl = options.sleepImpl ?? sleep
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const log = options.log ?? ((line) => { console.error(line) })
  const attempts = retryDelaysMs.length + 1
  for (let attempt = 1; ; attempt += 1) {
    const { code, signal, output } = await runImpl(args)
    if (code === 0 || signal !== null) return { code, signal }
    const failure = gatewayFailure(output)
    const delay = failure === undefined ? undefined : retryDelaysMs[attempt - 1]
    if (delay === undefined) {
      if (failure !== undefined) log(`dist: attempt ${String(attempt)}/${String(attempts)} failed on a download, giving up: ${failure}`)
      return { code, signal }
    }
    log(`dist: attempt ${String(attempt)}/${String(attempts)} failed on a download: ${failure}; running again in ${String(delay / 1000)} s`)
    await sleepImpl(delay)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, signal } = await dist(['--publish', 'never', ...process.argv.slice(2)])
  if (signal !== null) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
}
