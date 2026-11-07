// Finding agent CLIs and the environment they run in: PATH plus the user's
// login-shell PATH plus the usual install folders, and an environment that
// keeps their own sign-in but leaks nothing of ours.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'

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
  // A CLI found outside our sparse PATH (a script with `#!/usr/bin/env node`)
  // needs the same folders to find its interpreter. Windows spells it `Path`.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = searchDirs().join(delimiter)
  return { ...env, ...extra }
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

const WIN_EXT = ['.cmd', '.exe', '.bat', '']
const candidates = (name) => (process.platform === 'win32' ? WIN_EXT.map(ext => `${name}${ext}`) : [name])

// Every folder a CLI may hide in, in lookup order.
function searchDirs() {
  const home = homedir()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const extra of [
    ...found.dirs,
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'devin', 'cli', '_versions', 'current', 'bin'),
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
export function spawnAgent(executable, args, options) {
  const launch = launchOf(executable, args)
  return spawn(launch.file, launch.args, { ...options, ...launch.options })
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
