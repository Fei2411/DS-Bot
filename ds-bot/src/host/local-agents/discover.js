// Finding agent CLIs and the environment they run in: PATH plus the user's
// login-shell PATH plus the usual install folders, and an environment that
// keeps their own sign-in but leaks nothing of ours.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// The CLI signs in by itself; an API key or another agent's backend variable in
// our environment would shadow that or leak, so neither reaches the child.
const DROP_EXACT = new Set([
  'ACP_BACKEND', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
])
const DROP_PREFIX = ['DS_BOT_', 'DSH_', 'ANTIGRAVITY_', 'AGY_', 'DEEPSEEK_']
export const PROBE_FORCE_KILL_AFTER_MS = 1_000
const DEFAULT_FORCE_KILL_AFTER_MS = 5_000
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024
const POST_KILL_CLOSE_MS = 250

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function findEnvKey(env, upperName) {
  if (env === undefined || env === null) return undefined
  return Object.keys(env).find(key => key.toUpperCase() === upperName && env[key] !== undefined)
}

function setCaseInsensitiveEnv(env, name, value) {
  const upper = name.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && key !== name) delete env[key]
  }
  env[name] = value
}

export function isDroppedEnvKey(key) {
  const upper = String(key ?? '').toUpperCase()
  return /^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(upper)
    || DROP_EXACT.has(upper)
    || DROP_PREFIX.some(prefix => upper.startsWith(prefix))
}

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Git's injected config is one group; dropping only KEY leaves COUNT/VALUE malformed.
    if (isDroppedEnvKey(key)) continue
    env[key] = value
  }
  // A CLI found outside our sparse PATH (a script with `#!/usr/bin/env node`)
  // needs the same folders to find its interpreter. Windows spells it `Path`.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = searchDirs().join(delimiter)
  for (const [key, value] of Object.entries(extra)) {
    setCaseInsensitiveEnv(env, key, value)
  }
  return env
}

// Background probes disable mise auto-install/network metadata fetches unless the
// user explicitly configured a non-empty MISE_OFFLINE; live sessions keep plain cleanEnv().
export function withProbeEnv(env = cleanEnv()) {
  const next = { ...env }
  const existingKey = findEnvKey(next, 'MISE_OFFLINE')
  if (existingKey === undefined || String(next[existingKey]).trim() === '') {
    setCaseInsensitiveEnv(next, existingKey ?? 'MISE_OFFLINE', '1')
  }
  return next
}

export function probeEnv(extra = {}) {
  return withProbeEnv(cleanEnv(extra))
}

// Builds a probe environment from sanitized host env + explicit caller/profile
// overrides (CLAUDE_CONFIG_DIR, CODEX_HOME, MISE_OFFLINE, etc.)
// without leaking dropped host secrets or losing PATH when overrideEnv is sparse.
function probeEnvWithOverride(overrideEnv, extraEnv) {
  const merged = {}
  if (overrideEnv !== undefined && overrideEnv !== null && overrideEnv !== process.env) {
    for (const [key, value] of Object.entries(overrideEnv)) {
      if (value === undefined || isDroppedEnvKey(key)) continue
      setCaseInsensitiveEnv(merged, key, String(value))
    }
  }
  if (extraEnv !== undefined && extraEnv !== null) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined || isDroppedEnvKey(key)) continue
      setCaseInsensitiveEnv(merged, key, String(value))
    }
  }
  return probeEnv(merged)
}

export function agentEnv(executable, env, { platform = process.platform, find = name => findExecutable(name, { platform, env }) } = {}) {
  if (platform !== 'win32' || !/^pi-acp(?:\.(?:cmd|bat|exe))?$/iu.test(win32.basename(executable)) || Object.keys(env).some(key => key.toUpperCase() === 'PI_ACP_PI_COMMAND')) return env
  const pi = find('pi')
  return pi === undefined ? env : { ...env, PI_ACP_PI_COMMAND: pi }
}

function isChildAlive(child) {
  return child !== undefined && child.exitCode == null && child.signalCode == null
}

function killWindowsTree(child, spawnKiller = spawn) {
  if (!isChildAlive(child)) return
  const pid = child.pid
  const fallback = () => {
    if (isChildAlive(child)) {
      try { child.kill() } catch {}
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    fallback()
    return
  }
  try {
    // On Windows, child.kill('SIGTERM') immediately calls TerminateProcess on the
    // parent only and orphans descendants. Run taskkill /T /F first and only fall
    // back to child.kill() if taskkill itself fails while the parent is still alive.
    const killer = spawnKiller('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    let fellBack = false
    const onFail = () => {
      if (fellBack) return
      fellBack = true
      fallback()
    }
    killer?.once?.('error', onFail)
    killer?.once?.('close', (code) => { if (code !== 0) onFail() })
    killer?.unref?.()
  } catch {
    fallback()
  }
}

function signalChild(child, signal, { processGroup = false, platform = process.platform, spawnKiller = spawn } = {}) {
  if (!isChildAlive(child)) return
  if (platform === 'win32') {
    killWindowsTree(child, spawnKiller)
    return
  }
  const pid = child.pid
  // Negative PID targets the detached child's process group so grandchildren holding
  // stdout/stderr pipes die together; guard pid > 1 to never signal pgid 0 or -1.
  if (processGroup && Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal)
      return
    } catch {}
  }
  try { child.kill(signal) } catch {}
}

// Runs a short-lived probe child with bounded timeout, SIGTERM->SIGKILL escalation
// across its process group/tree, and capped output so a hung or SIGTERM-ignoring CLI
// never stalls discovery or leaks orphan processes.
export function runProbeCommand(file, args, {
  env,
  timeoutMs = 5_000,
  forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS,
  maxOutputBytes = MAX_PROBE_OUTPUT_BYTES,
  signal,
  spawnOptions = {},
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, timedOut: false, aborted: true, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error: new Error('probe aborted') })
  }
  if (timeoutMs <= 0) {
    return Promise.resolve({ ok: false, timedOut: true, aborted: false, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error: new Error('probe timed out') })
  }
  return new Promise((resolve) => {
    const processGroup = process.platform !== 'win32'
    let child
    try {
      child = spawn(file, args, {
        ...spawnOptions,
        env: withProbeEnv(env ?? cleanEnv()),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: processGroup,
      })
    } catch (error) {
      resolve({ ok: false, timedOut: false, aborted: false, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error })
      return
    }

    let settled = false
    let timedOut = false
    let aborted = false
    let overflowed = false
    let killing = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let timeoutTimer
    let forceKillTimer
    let postKillTimer

    const cleanup = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(forceKillTimer)
      clearTimeout(postKillTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = ({ code = null, sig = null, spawnError } = {}) => {
      if (settled) return
      settled = true
      cleanup()
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      const ok = spawnError === undefined && !timedOut && !aborted && !overflowed && code === 0 && sig === null
      const error = ok ? null : (spawnError ?? new Error(
        timedOut ? 'probe timed out'
          : aborted ? 'probe aborted'
            : overflowed ? 'probe output limit exceeded'
              : `probe exited${sig !== null ? ` on ${sig}` : code !== null ? ` with code ${code}` : ''}`,
      ))
      resolve({ ok, timedOut, aborted, overflowed, stdout, stderr, code, signal: sig, error })
    }

    const schedulePostKillClose = (fallbackSig) => {
      postKillTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish({ code: child.exitCode, sig: child.signalCode ?? fallbackSig })
      }, POST_KILL_CLOSE_MS)
      postKillTimer.unref?.()
    }

    const beginKill = () => {
      if (killing || settled) return
      killing = true
      clearTimeout(timeoutTimer)
      if (process.platform === 'win32') {
        signalChild(child, 'SIGKILL', { processGroup: false })
        schedulePostKillClose('SIGKILL')
        return
      }
      signalChild(child, 'SIGTERM', { processGroup })
      forceKillTimer = setTimeout(() => {
        if (settled) return
        signalChild(child, 'SIGKILL', { processGroup })
        schedulePostKillClose('SIGKILL')
      }, Math.max(0, forceKillAfterMs))
      forceKillTimer.unref?.()
    }

    const onAbort = () => {
      if (killing || settled) return
      aborted = true
      beginKill()
    }

    child.stdout?.on('data', (chunk) => {
      if (overflowed || killing || settled) return
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stdoutBytes + size > maxOutputBytes) {
        overflowed = true
        beginKill()
        return
      }
      stdoutBytes += size
      stdout += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (overflowed || killing || settled) return
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stderrBytes + size > maxOutputBytes) {
        overflowed = true
        beginKill()
        return
      }
      stderrBytes += size
      stderr += Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk)
    })

    child.once('error', spawnError => finish({ spawnError }))
    child.once('close', (code, sig) => finish({ code, sig }))

    timeoutTimer = setTimeout(() => {
      if (killing || settled) return
      timedOut = true
      beginKill()
    }, timeoutMs)
    timeoutTimer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// A command's output, or undefined. Never synchronous: this runs inside the DSH
// host, and a blocking child process there freezes every Session.
const outputOf = async (file, args, options) => {
  const result = await runProbeCommand(file, args, { timeoutMs: 5_000, forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS, env: probeEnv(), ...options })
  return result.ok ? result.stdout : undefined
}

// macOS/Linux apps launched from a dock icon inherit a sparse PATH; the login
// shell knows where the user actually installed things, and so does npm's global
// prefix. Both are looked up in the background and kept for a minute.
let found = { at: 0, dirs: [] }
let looking
export function refreshSearchDirs() {
  if (Date.now() - found.at < 60_000) return Promise.resolve()
  const windows = process.platform === 'win32'
  looking ??= Promise.all([
    windows ? undefined : outputOf(process.env.SHELL ?? '/bin/sh', ['-l', '-c', 'printf %s "$PATH"']),
    // `npm bin -g` is gone since npm 9; the prefix holds the bin folder. Node starts
    // no `.cmd` without a shell, and npm's Windows prefix is fixed, so it is not asked.
    windows ? undefined : outputOf('npm', ['prefix', '-g']),
  ]).then(([loginPath, prefix]) => {
    const npmBin = windows ? (process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined)
      : prefix?.trim() ? join(prefix.trim(), 'bin') : undefined
    found = { at: Date.now(), dirs: [...(loginPath ?? '').split(delimiter).filter(Boolean), ...(npmBin ? [npmBin] : [])] }
  }).finally(() => { looking = undefined })
  return looking
}

// Every folder a CLI may hide in, in lookup order.
function searchDirs() {
  const home = homedir()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const extra of [
    ...found.dirs,
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'devin', 'cli', '_versions', 'current', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
    process.platform === 'darwin' ? join(home, 'Library', 'pnpm') : join(home, '.local', 'share', 'pnpm'),
    process.platform === 'win32' ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm') : '',
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agy', 'bin') : '',
    process.platform === 'win32' ? join(home, 'scoop', 'shims') : '',
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    if (extra !== '' && !dirs.includes(extra) && existsSync(extra)) dirs.push(extra)
  }
  return dirs
}

// The executable's full path, or undefined when the CLI is not installed. Only
// file checks: the folders from refreshSearchDirs() join once it has run.
export function findExecutable(name, { platform = process.platform, env = process.env, isFile: fileExists = isFile } = {}) {
  const windows = platform === 'win32'
  const pathJoin = windows ? win32.join : join
  const allowedExt = ['.cmd', '.exe', '.bat', '.com']
  const hasExtension = allowedExt.includes(win32.extname(name).toLowerCase())
  if (name.includes('/') || name.includes('\\')) {
    if (windows && !hasExtension) return undefined
    const path = name.startsWith('~') ? join(homedir(), name.slice(1)) : name
    return fileExists(path) ? path : undefined
  }
  const pathExt = env.PATHEXT === undefined ? allowedExt : env.PATHEXT.split(';').map(ext => ext.toLowerCase()).filter(ext => allowedExt.includes(ext))
  const extensions = windows && !hasExtension ? pathExt : ['']
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs = windows ? [...(env[pathKey] ?? '').split(';').filter(Boolean), ...(platform === process.platform ? searchDirs() : [])] : searchDirs()
  const seen = windows ? new Set() : undefined
  for (const dir of dirs) {
    if (seen !== undefined) {
      if (!win32.isAbsolute(dir)) continue
      const key = win32.normalize(dir).replace(/\\+$/u, '')
      if (seen.has(key)) continue
      seen.add(key)
    }
    for (const ext of extensions) {
      const path = pathJoin(dir, `${name}${ext}`)
      if (fileExists(path)) return path
    }
  }
  return undefined
}

export function findEngineExecutable(spec, find = findExecutable) {
  for (const command of spec.commands ?? [spec.command]) {
    const path = find(command)
    if (path !== undefined) return path
  }
  return undefined
}

// npm's shims name their runner in _prog: "%dp0%\node.exe" when one lies beside them, else "node".
const SHIM_PROGRAM = /SET "_prog=(?:%dp0%\\)?([^"\\]+?)(?:\.exe)?"/iu
const CMD_SAFE = /^[\w\-.:/\\=@+,~ ]*$/u

// What a Windows shim starts: the quoted paths on its last line that passes the
// arguments on (%*), with the shim's folder (npm "%dp0%", pnpm "%~dp0") filled in.
function shimLaunch(shim, dir, { exists, find }) {
  const line = shim.split(/\r?\n/u).filter(text => text.includes('%*')).at(-1) ?? ''
  const paths = [...line.matchAll(/"([^"]+)"/gu)].map(match => match[1])
  if (paths.length === 0) return undefined
  const stripShimDir = path => path.replace(/^%~?dp0%?\\?/iu, '')
  const script = stripShimDir(paths.at(-1))
  if (/%[^%\\/]+%/u.test(script)) return undefined
  const target = win32.resolve(dir, script)
  if (paths.length === 1 && /\.exe$/iu.test(target)) return { file: target }
  const named = paths.length > 1 && paths[0] !== '%_prog%' ? win32.resolve(dir, stripShimDir(paths[0])) : undefined
  const program = SHIM_PROGRAM.exec(shim)?.[1] ?? 'node'
  const runner = named !== undefined && exists(named) ? named : exists(win32.join(dir, `${program}.exe`)) ? win32.join(dir, `${program}.exe`) : find(program)
  return runner !== undefined && /\.exe$/iu.test(runner) ? { file: runner, script: target } : undefined
}

// The program and arguments that start `executable`. Node starts no `.cmd` or
// `.bat` without a shell (spawn EINVAL), and a shell would mangle a system prompt
// with quotes or line breaks. The shims that npm and pnpm install for a CLI only
// start a script with Node or a program beside them, so that runs directly.
export function launchOf(executable, args, { platform = process.platform, readFile = readFileSync, exists = existsSync, find = findExecutable } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) return { file: executable, args }
  let shim = ''
  try { shim = readFile(executable, 'utf8') } catch { /* started through cmd.exe below */ }
  const shimmed = shimLaunch(shim, win32.dirname(executable), { exists, find })
  if (shimmed !== undefined) return { file: shimmed.file, args: shimmed.script === undefined ? args : [shimmed.script, ...args] }
  // Another kind of batch file goes through cmd.exe, which only passes plain arguments intact.
  if (![executable, ...args].every(arg => CMD_SAFE.test(arg))) {
    throw new Error(`${win32.basename(executable)} is a batch file that DS Bot cannot start with these arguments. Point the agent at its .exe or Node script instead.`)
  }
  const line = [executable, ...args].map(arg => (arg === '' || arg.includes(' ') ? `"${arg}"` : arg)).join(' ')
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
}

// spawn() for an agent CLI, also when Windows found it as a `.cmd` shim.
export function terminateChild(child, { forceKillAfterMs = DEFAULT_FORCE_KILL_AFTER_MS, processGroup = false, platform = process.platform, spawnKiller = spawn } = {}) {
  if (!isChildAlive(child) || !Number.isSafeInteger(child.pid) || child.pid <= 0) return
  if (platform === 'win32') {
    killWindowsTree(child, spawnKiller)
    return
  }
  signalChild(child, 'SIGTERM', { processGroup, platform, spawnKiller })
  if (!isChildAlive(child)) return
  const clear = () => {
    clearTimeout(timer)
    child.off?.('exit', clear)
    child.off?.('close', clear)
    child.off?.('error', clear)
  }
  const timer = setTimeout(() => {
    clear()
    if (isChildAlive(child)) signalChild(child, 'SIGKILL', { processGroup, platform, spawnKiller })
  }, Math.max(0, forceKillAfterMs))
  timer.unref?.()
  if (typeof child.once === 'function') {
    child.once('exit', clear)
    child.once('close', clear)
    child.once('error', clear)
  }
}

export function spawnAgent(executable, args, options) {
  const launch = launchOf(executable, args)
  return spawn(launch.file, launch.args, { ...options, ...launch.options, env: agentEnv(executable, options?.env ?? process.env) })
}

// One `--version` call, bounded; the version line is for display only.
export async function probeVersion(executable, args, env, { timeoutMs = 10_000, forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS, maxOutputBytes = MAX_PROBE_OUTPUT_BYTES, signal } = {}) {
  try {
    const launch = launchOf(executable, args)
    const result = await runProbeCommand(launch.file, launch.args, {
      timeoutMs,
      forceKillAfterMs,
      maxOutputBytes,
      signal,
      env: withProbeEnv(env ?? cleanEnv()),
      spawnOptions: launch.options,
    })
    if (result.timedOut || result.aborted || result.overflowed) return { ok: false, version: undefined }
    const text = `${result.stdout}${result.stderr}`.split('\n').map(line => line.trim()).find(Boolean)
    return { ok: result.ok, version: text }
  } catch {
    return { ok: false, version: undefined }
  }
}

function parseJsonSignIn(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (trimmed === '') return null
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}$/u)?.[0]
  if (!candidate) return null
  try {
    const parsed = JSON.parse(candidate)
    if (parsed === null || typeof parsed !== 'object') return null
    for (const key of ['loggedIn', 'logged_in', 'authenticated', 'signedIn', 'signed_in']) {
      if (typeof parsed[key] === 'boolean') return parsed[key]
    }
  } catch {}
  return null
}

function classifySignIn(error, stdout, stderr, check) {
  const fromJson = parseJsonSignIn(stdout)
  if (fromJson !== null) return fromJson
  const text = `${stdout ?? ''}${stderr ?? ''}`
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|partially authenticated|no (?:active )?(?:account|credentials|token)|please (?:log ?in|sign ?in|authenticate)/iu.test(text)) {
    return false
  }
  if (/(?:logged|signed) in/iu.test(text) || /^authenticated(?:\s|$|[:.,])/imu.test(text)) {
    return true
  }
  if (check.nonEmpty === true && error === null && String(stdout ?? '').trim() !== '') return true
  return null
}

// Network-backed status commands (e.g. `devin auth status`, `cursor-agent status`)
// routinely take 2-4s under concurrent startup; 3s killed them before stdout flushed.
const SIGN_IN_TIMEOUT_MS = 6_000
const KEYCHAIN_TIMEOUT_MS = 2_000

function probeMacKeychainItem(service, account, spawnKeychain, timeoutMs, signal) {
  if (signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
      // Without -g or -w this looks up metadata only. A miss proves nothing:
      // the CLI may be using a fallback credential store.
      const child = spawnKeychain('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], {
        env: probeEnv(), stdio: 'ignore', signal: combined, killSignal: 'SIGKILL',
      })
      child.once('error', () => resolve(null))
      child.once('close', (code) => resolve(code === 0 ? true : null))
    } catch { resolve(null) }
  })
}

async function probeMacKeychain({ service, services, account }, spawnKeychain, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal) {
  const cap = Math.min(timeoutMs, KEYCHAIN_TIMEOUT_MS)
  const list = services ?? (service === undefined ? [] : [service])
  if (list.length === 0) return null
  const results = await Promise.all(list.map(name => probeMacKeychainItem(name, account, spawnKeychain, cap, signal)))
  return results.every(result => result === true) ? true : null
}

// The per-user data folder as CodeBuddy resolves it from the home directory
// (it ignores XDG_DATA_HOME and LOCALAPPDATA).
const APP_DATA = { darwin: ['Library', 'Application Support'], win32: ['AppData', 'Local'] }

const pathValue = (data, path) => path.reduce((current, key) => current?.[key], data)
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== ''
function isNonEmptyValue(value) {
  if (typeof value === 'string') return value.trim() !== ''
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
  return Boolean(value)
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function parseTomlStringValue(raw) {
  const quote = raw[0]
  if (quote !== '"' && quote !== "'") return undefined
  if (quote === "'") {
    const end = raw.indexOf("'", 1)
    if (end === -1) return undefined
    const tail = raw.slice(end + 1).trim()
    return tail === '' || tail.startsWith('#') ? raw.slice(1, end) : undefined
  }
  let out = ''
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      if (i + 1 >= raw.length) return undefined
      out += raw[++i]
      continue
    }
    if (ch === '"') {
      const tail = raw.slice(i + 1).trim()
      return tail === '' || tail.startsWith('#') ? out : undefined
    }
    out += ch
  }
  return undefined
}

// Checks top-level TOML string keys (stops at the first `[table]` header so
// keys nested inside sections cannot spoof top-level credentials).
function hasTomlTopLevelStrings(file, keys) {
  try {
    const found = new Set()
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const trimmed = rawLine.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('[')) break
      const eq = rawLine.indexOf('=')
      if (eq === -1) continue
      const key = rawLine.slice(0, eq).trim()
      if (!keys.includes(key)) continue
      const value = parseTomlStringValue(rawLine.slice(eq + 1).trim())
      if (value !== undefined && value.trim() !== '') found.add(key)
    }
    return keys.every(key => found.has(key))
  } catch {
    return false
  }
}

function probeFile(file, { loggedOut, has = [], stringGroups = [], tomlStrings = [] } = {}) {
  if (!isFile(file) || (loggedOut !== undefined && isFile(`${file}${loggedOut}`))) return null
  if (has.length > 0 || stringGroups.length > 0) {
    const data = readJsonFile(file)
    if (data === undefined) return null
    if (has.length > 0 && !has.every(path => isNonEmptyValue(pathValue(data, path)))) return null
    if (stringGroups.length > 0 && !stringGroups.some(group => group.every(path => isNonEmptyString(pathValue(data, path))))) return null
  }
  if (tomlStrings.length > 0 && !hasTomlTopLevelStrings(file, tomlStrings)) return null
  return true
}

const isAbsoluteFor = (value, platform) => (platform === 'win32' ? win32.isAbsolute(value) : (posix.isAbsolute(value) || isAbsolute(value)))

function envValue(env, name, platform) {
  if (env === undefined || env === null || name === undefined) return ''
  if (platform !== 'win32') return String(env[name] ?? '').trim()
  const upper = name.toUpperCase()
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === upper)
  return key === undefined ? '' : String(env[key] ?? '').trim()
}

function resolvePlatformFile(spec, home, platform, env, { isolated = false } = {}) {
  const entry = spec[platform] ?? spec.default
  if (entry === undefined) return undefined
  const envRoot = envValue(env, entry.env, platform)
  if (envRoot !== '' && isAbsoluteFor(envRoot, platform)) return join(envRoot, ...entry.path)
  // An isolated profile must not silently fall back to the default global home directory.
  if (isolated) return undefined
  return join(home, ...(entry.base ?? []), ...entry.path)
}

function resolveSimpleFile(check, home, platform, env, { isolated = false } = {}) {
  if (check.envDir !== undefined) {
    const envRoot = envValue(env, check.envDir, platform)
    if (envRoot !== '' && isAbsoluteFor(envRoot, platform)) {
      return join(envRoot, ...check.file.slice(1))
    }
  }
  if (isolated) return undefined
  return join(home, ...check.file)
}

function hasIsolatedProfileEnv(env, extraEnv, isolated) {
  if (isolated === true) return true
  const checkKeys = (obj, keys) => obj !== undefined && obj !== null
    && Object.keys(obj).some(key => keys.includes(key.toUpperCase()) && String(obj[key] ?? '').trim() !== '')
  if (checkKeys(extraEnv, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])) return true
  if (env !== process.env && checkKeys(env, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])) return true
  return false
}

function mergeExtraEnv(base, extra) {
  if (extra === undefined || extra === null) return base
  const merged = base !== undefined && base !== null ? { ...base } : {}
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) setCaseInsensitiveEnv(merged, key, value)
  }
  return merged
}

function probeOne(executable, check, { home, platform, env, extraEnv, isolated, spawnKeychain, timeoutMs, forceKillAfterMs, maxOutputBytes, signal, deadline }) {
  if (signal?.aborted) return Promise.resolve(null)
  const isIsolated = hasIsolatedProfileEnv(env, extraEnv, isolated)
  // Isolated profiles must read file-probe roots only from their own `extraEnv`,
  // never falling back to host process.env values like APPDATA or XDG_DATA_HOME.
  const fileEnv = isIsolated
    ? (isolated === true || (extraEnv !== undefined && extraEnv !== null) ? (extraEnv ?? {}) : env)
    : mergeExtraEnv(env, extraEnv)
  if (check.macKeychain !== undefined) {
    // macOS Keychain stores the global default account; never attribute it to an isolated profile.
    if (isIsolated) return Promise.resolve(null)
    return platform === 'darwin' ? probeMacKeychain(check.macKeychain, spawnKeychain, timeoutMs, signal) : Promise.resolve(null)
  }
  if (check.file !== undefined) {
    const file = resolveSimpleFile(check, home, platform, fileEnv, { isolated: isIsolated })
    return Promise.resolve(file === undefined ? null : probeFile(file))
  }
  if (check.appDataFile !== undefined) {
    if (isIsolated) return Promise.resolve(null)
    return Promise.resolve(probeFile(join(home, ...(APP_DATA[platform] ?? ['.local', 'share']), ...check.appDataFile.path), check.appDataFile))
  }
  if (check.platformFile !== undefined) {
    const file = resolvePlatformFile(check.platformFile, home, platform, fileEnv, { isolated: isIsolated })
    return Promise.resolve(file === undefined ? null : probeFile(file, check.platformFile))
  }
  if (check.args === undefined) return Promise.resolve(null)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(null)
  try {
    const launch = launchOf(executable, check.args)
    return runProbeCommand(launch.file, launch.args, {
      timeoutMs: remaining,
      forceKillAfterMs,
      maxOutputBytes,
      signal,
      env: probeEnvWithOverride(env, extraEnv),
      spawnOptions: launch.options,
    }).then((result) => {
      if (result.timedOut || result.aborted || result.overflowed) return null
      return classifySignIn(result.ok ? null : result.error, result.stdout, result.stderr, check)
    })
  } catch {
    return Promise.resolve(null)
  }
}

// true, false, or null when the check cannot tell. Only a CLI's status command
// can say false; a missing credential in one store proves nothing.
export async function probeSignIn(executable, check, { home = homedir(), platform = process.platform, env = process.env, extraEnv, isolated = false, spawnKeychain = spawn, timeoutMs = SIGN_IN_TIMEOUT_MS, forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS, maxOutputBytes = MAX_PROBE_OUTPUT_BYTES, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  for (let current = check; current !== undefined; current = current.fallback) {
    if (signal?.aborted) return null
    const result = await probeOne(executable, current, { home, platform, env, extraEnv, isolated, spawnKeychain, timeoutMs, forceKillAfterMs, maxOutputBytes, signal, deadline })
    if (signal?.aborted) return null
    if (result !== null) return result
  }
  return null
}
