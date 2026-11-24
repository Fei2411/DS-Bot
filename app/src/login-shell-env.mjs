// macOS and Linux apps opened from Finder, the Dock or a launcher inherit the
// session manager's sparse PATH (`/usr/bin:/bin:/usr/sbin:/sbin`): tools the
// user installed — node from nvm, pnpm, anything on the login shell's PATH —
// are missing, and every child process of the Host, the bash tool included,
// inherits that PATH. Read the login shell's PATH once before the Host starts.
// Follows DeepSeek Harness apps/desktop/src/login-shell-environment.ts (MIT);
// see NOTICE.
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { delimiter, isAbsolute } from 'node:path'

// The dump prints one marker, the PATH, and the marker again, so rc files that
// print something themselves cannot be mistaken for the value.
const MARKER_TEXT = '_DS_BOT_LOGIN_PATH_'
const MARKER = `\0${MARKER_TEXT}\0`
const DUMP = `printf '\\0%s\\0' '${MARKER_TEXT}'; printf '%s\\0' "$PATH"; printf '\\0%s\\0' '${MARKER_TEXT}'; exit`

// Shipped app bundles are at the same place on every Mac; the account record
// still names the shell the user actually logs in with.
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh']

const DEFAULT_TIMEOUT_MS = 10_000

// The value between the two markers; anything a rc file printed before the
// first marker or after the last one is dropped. Undefined when a shell died
// before both markers were printed (an rc file that runs `exit`, say).
export function parseLoginShellPath(stdout) {
  const parts = stdout.split('\0')
  const first = parts.indexOf(MARKER_TEXT)
  if (first === -1) return undefined
  const value = parts[first + 1]
  if (value === undefined || parts.indexOf(MARKER_TEXT, first + 2) === -1) return undefined
  const dirs = value.split(delimiter).filter((dir) => isAbsolute(dir))
  return dirs.length === 0 ? undefined : [...new Set(dirs)].join(delimiter)
}

// Every shell worth asking, the account's login shell first. Windows GUI apps
// inherit the registry environment, so no shell is asked there.
function loginShellCandidates() {
  if (process.platform === 'win32') return []
  let account
  try { account = userInfo().shell } catch { account = undefined }
  return [...new Set([account, ...FALLBACK_SHELLS].filter((shell) => typeof shell === 'string' && shell !== ''))]
}

/**
 * The PATH the user's login shell builds, or undefined when no shell answered.
 * Never rejects: a slow or broken rc file must not stop the app from starting.
 * `DS_BOT_LOGIN_SHELL_TIMEOUT_MS` caps the whole read.
 *
 * @param {{ env?: NodeJS.ProcessEnv, shells?: string[], timeoutMs?: number }} [options]
 * @returns {Promise<string | undefined>}
 */
export async function readLoginShellPath({
  env = process.env,
  shells = loginShellCandidates(),
  timeoutMs = Number(env.DS_BOT_LOGIN_SHELL_TIMEOUT_MS) > 0 ? Number(env.DS_BOT_LOGIN_SHELL_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  for (const shell of shells) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const found = await readOne(shell, env, remaining)
    if (found !== undefined) return found
  }
  return undefined
}

function readOne(shell, env, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      // `-i` as well: nvm and friends live in `.zshrc`, which a non-interactive
      // shell does not read. The shell runs in its own group so a 10 s timeout
      // can take its whole tree down.
      child = spawn(shell, ['-ilc', DUMP], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(undefined)
      return
    }
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => {
      finish(undefined)
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { chunks.push(chunk) })
    child.on('error', () => { finish(undefined) })
    child.on('close', (code) => {
      finish(code === 0 ? parseLoginShellPath(Buffer.concat(chunks).toString('utf8')) : undefined)
    })
  })
}
