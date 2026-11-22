// Finding agent CLIs and the environment they run in: PATH plus the user's
// login-shell PATH plus the usual install folders, and an environment that
// keeps their own sign-in but leaks nothing of ours.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, win32 } from 'node:path'

// The CLI signs in by itself; an API key or another agent's backend variable in
// our environment would shadow that or leak, so neither reaches the child.
const DROP_EXACT = new Set([
  'ACP_BACKEND', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
])
const DROP_PREFIX = ['DS_BOT_', 'DSH_', 'ANTIGRAVITY_', 'AGY_', 'DEEPSEEK_']

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    // Git's injected config is one group; dropping only KEY leaves COUNT/VALUE malformed.
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(upper) || DROP_EXACT.has(upper) || DROP_PREFIX.some(prefix => upper.startsWith(prefix))) continue
    env[key] = value
  }
  // A CLI found outside our sparse PATH (a script with `#!/usr/bin/env node`)
  // needs the same folders to find its interpreter. Windows spells it `Path`.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = searchDirs().join(delimiter)
  return { ...env, ...extra }
}

export function agentEnv(executable, env, { platform = process.platform, find = name => findExecutable(name, { platform, env }) } = {}) {
  if (platform !== 'win32' || !/^pi-acp(?:\.(?:cmd|bat|exe))?$/iu.test(win32.basename(executable)) || Object.keys(env).some(key => key.toUpperCase() === 'PI_ACP_PI_COMMAND')) return env
  const pi = find('pi')
  return pi === undefined ? env : { ...env, PI_ACP_PI_COMMAND: pi }
}

// A command's output, or undefined. Never synchronous: this runs inside the DSH
// host, and a blocking child process there freezes every Session.
const outputOf = (file, args) => new Promise((resolve) => {
  try {
    execFile(file, args, { encoding: 'utf8', timeout: 5_000, env: cleanEnv() }, (error, stdout) => resolve(error === null ? stdout : undefined))
  } catch { resolve(undefined) }
})

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
  for (const dir of dirs) {
    if (windows && !win32.isAbsolute(dir)) continue
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
  const expand = path => win32.resolve(dir, path.replace(/^%~?dp0%?\\?/iu, ''))
  const target = expand(paths.at(-1))
  if (paths.length === 1 && /\.exe$/iu.test(target)) return { file: target }
  const named = paths.length > 1 && paths[0] !== '%_prog%' ? expand(paths[0]) : undefined
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
export function terminateChild(child) {
  if (child === undefined) return
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
}

export function spawnAgent(executable, args, options) {
  const launch = launchOf(executable, args)
  return spawn(launch.file, launch.args, { ...options, ...launch.options, env: agentEnv(executable, options?.env ?? process.env) })
}

// One `--version` call, bounded; the version line is for display only.
export function probeVersion(executable, args, env) {
  return new Promise((resolve) => {
    try {
      const launch = launchOf(executable, args)
      execFile(launch.file, launch.args, { encoding: 'utf8', timeout: 10_000, env, windowsHide: true, ...launch.options }, (error, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`.split('\n').map(line => line.trim()).find(Boolean)
        resolve({ ok: error === null, version: text })
      })
    } catch { resolve({ ok: false, version: undefined }) }
  })
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
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|no (?:active )?(?:account|credentials|token)|please (?:log ?in|sign ?in|authenticate)/iu.test(text)) {
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
const SIGN_IN_TIMEOUT_MS = 8_000

function probeMacKeychain({ service, account }, spawnKeychain, timeoutMs = SIGN_IN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      // Without -g or -w this looks up metadata only. A miss proves nothing:
      // the CLI may be using a fallback credential store.
      const child = spawnKeychain('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], {
        env: cleanEnv(), stdio: 'ignore', signal: AbortSignal.timeout(timeoutMs), killSignal: 'SIGKILL',
      })
      child.once('error', () => resolve(null))
      child.once('close', (code) => resolve(code === 0 ? true : null))
    } catch { resolve(null) }
  })
}

// The per-user data folder as CodeBuddy resolves it from the home directory
// (it ignores XDG_DATA_HOME and LOCALAPPDATA).
const APP_DATA = { darwin: ['Library', 'Application Support'], win32: ['AppData', 'Local'] }

function hasJsonPaths(file, paths, mode = 'every') {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return paths[mode]((path) => {
      const value = path.reduce((current, key) => current?.[key], data)
      return typeof value === 'string' ? value.trim() !== '' : Boolean(value)
    })
  } catch {
    return false
  }
}

function matchesFile(file, pattern) {
  try {
    return pattern.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

function probeFile(file, { loggedOut, has = [], any = [], match } = {}) {
  if (!isFile(file) || (loggedOut !== undefined && isFile(`${file}${loggedOut}`))) return null
  if (has.length > 0 && !hasJsonPaths(file, has, 'every')) return null
  if (any.length > 0 && !hasJsonPaths(file, any, 'some')) return null
  if (match !== undefined && !matchesFile(file, match)) return null
  return true
}

const isAbsoluteFor = (value, platform) => (platform === 'win32' ? win32.isAbsolute(value) : isAbsolute(value))

function envValue(env, name, platform) {
  if (env === undefined || env === null || name === undefined) return ''
  if (platform !== 'win32') return String(env[name] ?? '').trim()
  const upper = name.toUpperCase()
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === upper)
  return key === undefined ? '' : String(env[key] ?? '').trim()
}

function resolvePlatformFile(spec, home, platform, env) {
  const entry = spec[platform] ?? spec.default
  if (entry === undefined) return undefined
  const envRoot = envValue(env, entry.env, platform)
  const base = envRoot !== '' && isAbsoluteFor(envRoot, platform) ? envRoot : join(home, ...(entry.base ?? []))
  return join(base, ...entry.path)
}

function probeOne(executable, check, { home, platform, env, spawnKeychain, timeoutMs }) {
  if (check.macKeychain !== undefined) {
    return platform === 'darwin' ? probeMacKeychain(check.macKeychain, spawnKeychain, timeoutMs) : Promise.resolve(null)
  }
  if (check.file !== undefined) return Promise.resolve(probeFile(join(home, ...check.file)))
  if (check.appDataFile !== undefined) {
    return Promise.resolve(probeFile(join(home, ...(APP_DATA[platform] ?? ['.local', 'share']), ...check.appDataFile.path), check.appDataFile))
  }
  if (check.platformFile !== undefined) {
    const file = resolvePlatformFile(check.platformFile, home, platform, env)
    return Promise.resolve(file === undefined ? null : probeFile(file, check.platformFile))
  }
  if (check.args === undefined) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const launch = launchOf(executable, check.args)
      execFile(launch.file, launch.args, { encoding: 'utf8', timeout: timeoutMs, env: cleanEnv(), windowsHide: true, ...launch.options }, (error, stdout, stderr) => {
        resolve(classifySignIn(error, stdout, stderr, check))
      })
    } catch { resolve(null) }
  })
}

// true, false, or null when the check cannot tell. Only a CLI's status command
// can say false; a missing credential in one store proves nothing.
export async function probeSignIn(executable, check, { home = homedir(), platform = process.platform, env = process.env, spawnKeychain = spawn, timeoutMs = SIGN_IN_TIMEOUT_MS } = {}) {
  for (let current = check; current !== undefined; current = current.fallback) {
    const result = await probeOne(executable, current, { home, platform, env, spawnKeychain, timeoutMs })
    if (result !== null) return result
  }
  return null
}
