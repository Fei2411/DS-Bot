// Login-shell environment for POSIX launches that inherit only the session
// manager's environment. A Finder, Dock or launcher start gets
// `/usr/bin:/bin:/usr/sbin:/sbin`; the Host copies that env and the DSH bash
// tool passes it to every command, so node from nvm, pnpm and anything else the
// login shell adds are missing. Read the login shell once and merge it into the
// Host's environment. Windows GUI launches inherit the registry environment and
// skip the read.
// Follows DeepSeek Harness apps/desktop/src/login-shell-environment.ts (MIT);
// see NOTICE.
import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const MARKER = Buffer.from(`\0${DELIMITER}\0`)
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh']
// Keep oh-my-zsh update prompts and tmux autostart plugins from blocking a
// non-terminal read.
const PROBE_ENVIRONMENT = { DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' }
// Variables that describe the probe shell process rather than the user's
// configuration.
const SHELL_SESSION_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', ...Object.keys(PROBE_ENVIRONMENT)])
// The launcher resolves paths such as DS_BOT_HOME / DSH_HOME before the read,
// so the Host keeps those inherited values.
const LAUNCHER_OWNED_PREFIXES = ['DS_BOT_', 'DSH_', 'ELECTRON_']

const TIMEOUT_KEY = 'DS_BOT_LOGIN_SHELL_TIMEOUT_MS'
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Resolve the login-shell read settings.
 * @param {NodeJS.ProcessEnv} env - The app's process environment.
 * @returns {{ timeoutMs: number }} Per-candidate deadline.
 */
export function resolveLoginShellConfig(env) {
  const raw = env[TIMEOUT_KEY]
  if (raw === undefined || raw === '') return { timeoutMs: DEFAULT_TIMEOUT_MS }
  if (!/^\d+$/u.test(raw) || Number(raw) < 1_000 || Number(raw) > 2_147_483_647) {
    throw new Error(`${TIMEOUT_KEY} must be an integer from 1000 through 2147483647`)
  }
  return { timeoutMs: Number(raw) }
}

/**
 * Candidate shells in order: the account record's login shell (not `$SHELL`),
 * then fixed system shells.
 * @param {() => { shell?: string | null }} [account] - Test seam for the account record.
 * @returns {string[]} Distinct absolute candidates.
 */
export function loginShellCandidates(account = userInfo) {
  let shell = null
  try { shell = account().shell ?? null } catch { /* No account record for this uid. */ }
  return [...new Set([...shell === null || shell === '' ? [] : [shell], ...FALLBACK_SHELLS])]
}

/**
 * Extract the variables printed between the two delimiters of the dump command.
 * @param {string} stdout - Probe output, including anything rc files printed.
 * @returns {Record<string, string> | undefined} Variables, or undefined without both delimiters.
 */
export function parseLoginShellOutput(stdout) {
  const parts = stdout.split('\0')
  const first = parts.indexOf(DELIMITER)
  const last = parts.lastIndexOf(DELIMITER)
  if (first === -1 || first === last) return undefined
  const variables = {}
  for (const entry of parts.slice(first + 1, last)) {
    const separator = entry.indexOf('=')
    if (separator > 0) variables[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return variables
}

/**
 * Overlay login-shell variables on the inherited environment; shell values win
 * except for probe-session variables and launcher-owned names.
 * @param {NodeJS.ProcessEnv} base - The environment the app inherited.
 * @param {Record<string, string>} shell - Variables printed by the login shell.
 * @returns {NodeJS.ProcessEnv} A new environment; neither argument is modified.
 */
export function mergeLoginShellEnvironment(base, shell) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(shell)) {
    if (SHELL_SESSION_KEYS.has(key) || LAUNCHER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    merged[key] = value
  }
  return merged
}

function readShell(shell, base, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve('aborted'); return }
    let child
    try {
      // Interactive login mode runs ~/.zprofile and ~/.zshrc (or the shell's
      // equivalents); stdin is closed so prompts in rc files read EOF instead
      // of waiting.
      child = spawn(shell, ['-ilc', DUMP], {
        cwd, env: { ...base, ...PROBE_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
      })
    } catch (error) {
      resolve(String(error))
      return
    }
    const chunks = []
    let tail = Buffer.alloc(0)
    let markers = 0
    const output = () => parseLoginShellOutput(Buffer.concat(chunks).toString('utf8')) ?? 'unparsed'
    const onData = (chunk) => {
      chunks.push(chunk)
      const window = Buffer.concat([tail, chunk])
      for (let index = window.indexOf(MARKER); index !== -1; index = window.indexOf(MARKER, index + MARKER.length)) markers++
      tail = window.subarray(Math.max(0, window.length - MARKER.length + 1))
      // Background children started by rc files inherit stdout and can hold it
      // open long after the shell exits, so the read completes at the closing
      // delimiter rather than at `close`.
      if (markers >= 2) finish(output())
    }
    const killGroup = () => {
      // An asynchronous spawn failure settles through the error listener before
      // a timer or abort listener can run, so the pid is present here.
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* The group already exited. */ }
    }
    // Members that left the process group can keep stdout open after SIGKILL,
    // so a stopped read resolves without waiting for `close`.
    const stop = (reason) => { finish(reason); killGroup() }
    const onAbort = () => { stop('aborted') }
    const timer = setTimeout(() => { stop('timeout') }, timeoutMs)
    function finish(result) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Keep draining so rc-started children that write to stdout do not fail
      // with EPIPE.
      child.stdout.off('data', onData)
      child.stdout.resume()
      resolve(result)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', onData)
    child.on('error', (error) => { finish(error.message) })
    child.on('close', (code, closeSignal) => {
      if (code !== 0) { finish(closeSignal ?? `exit ${String(code)}`); return }
      finish(output())
    })
  })
}

/**
 * Read the user's login-shell environment once. Never rejects: each failing
 * candidate is recorded and the next one tried, and `base` comes back when all
 * fail or the read is aborted. `win32` returns `base` unchanged.
 *
 * @param {NodeJS.ProcessEnv} base - The environment the app inherited.
 * @param {{ timeoutMs: number }} config - Validated read settings.
 * @param {{ platform?: NodeJS.Platform, shells?: string[], signal?: AbortSignal }} [options]
 * @returns {Promise<{ environment: NodeJS.ProcessEnv, failures: { shell: string, reason: string }[] }>}
 */
export async function readLoginShellEnvironment(base, config, options = {}) {
  const { platform = process.platform, shells = loginShellCandidates(), signal } = options
  if (platform === 'win32') return { environment: base, failures: [] }
  const failures = []
  for (const shell of shells) {
    const result = await readShell(shell, base, homedir(), config.timeoutMs, signal)
    if (typeof result !== 'string') return { environment: mergeLoginShellEnvironment(base, result), failures }
    failures.push({ shell, reason: result })
    if (result === 'aborted') break
  }
  return { environment: base, failures }
}
