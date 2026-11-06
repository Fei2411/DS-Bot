// Finding agent CLIs and the environment they run in: PATH plus the user's
// login-shell PATH plus the usual install folders, and an environment that
// keeps their own sign-in but leaks nothing of ours.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// The CLI signs in by itself; an API key or another agent's backend variable in
// our environment would shadow that or leak, so neither reaches the child.
const DROP_EXACT = new Set([
  'ACP_BACKEND', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
])
const DROP_PREFIX = ['DS_BOT_', 'DSH_']

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (DROP_EXACT.has(key) || DROP_PREFIX.some(prefix => key.startsWith(prefix))) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

// macOS/Linux apps launched from a dock icon inherit a sparse PATH; the login
// shell knows where the user actually installed things. Cached for a minute:
// a lookup burst (a page that scans every engine) pays for it once.
let loginPath = { at: 0, value: undefined }
function loginShellPath() {
  if (Date.now() - loginPath.at < 60_000) return loginPath.value
  loginPath = { at: Date.now(), value: undefined }
  if (process.platform === 'win32') return undefined
  const shell = process.env.SHELL ?? '/bin/sh'
  try {
    const out = execFileSync(shell, ['-l', '-c', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000, env: cleanEnv() })
    loginPath.value = out.split(delimiter).filter(Boolean)
  } catch { /* no login shell PATH; what we have is enough */ }
  return loginPath.value
}

function npmGlobalBin() {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['bin', '-g'], { encoding: 'utf8', timeout: 5_000, env: cleanEnv() }).trim()
  } catch { return undefined }
}

const WIN_EXT = ['.cmd', '.exe', '.bat', '']
const candidates = (name) => (process.platform === 'win32' ? WIN_EXT.map(ext => `${name}${ext}`) : [name])

// Every folder a CLI may hide in, in lookup order.
function searchDirs() {
  const home = homedir()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of loginShellPath() ?? []) if (!dirs.includes(dir)) dirs.push(dir)
  for (const extra of [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'devin', 'cli', '_versions', 'current', 'bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    npmGlobalBin(),
  ]) {
    if (extra !== undefined && extra !== '' && !dirs.includes(extra) && existsSync(extra)) dirs.push(extra)
  }
  return dirs
}

// The executable's full path, or undefined when the CLI is not installed.
export function findExecutable(name) {
  if (name.includes('/') || name.includes('\\')) {
    const path = name.startsWith('~') ? join(homedir(), name.slice(1)) : name
    return existsSync(path) ? path : undefined
  }
  for (const dir of searchDirs()) {
    for (const file of candidates(name)) {
      const path = join(dir, file)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

// One `--version` call, bounded; the version line is for display only.
export function probeVersion(executable, args, env) {
  return new Promise((resolve) => {
    execFile(executable, args, { encoding: 'utf8', timeout: 10_000, env }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.split('\n').map(line => line.trim()).find(Boolean)
      resolve({ ok: error === null, version: text })
    })
  })
}
