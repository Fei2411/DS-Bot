// Local editor, terminal, and file-manager detection, launching, and per-directory
// default preference storage for the desktop app's "Open in app" right-panel feature.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i
const STRIPPED_ENV_RE = /^(DS_BOT_|DSBOT_|DSH_|ELECTRON_RUN_AS_NODE$|ACP_BACKEND$|DEEPSEEK_|ANTIGRAVITY_|AGY_)/i
const MAX_STORED_DIR_DEFAULTS = 200

function scrubbedLaunchEnv(env = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (SENSITIVE_ENV_RE.test(key) || STRIPPED_ENV_RE.test(key)) continue
    out[key] = value
  }
  return out
}

function findInPath(names, env = process.env, platform = process.platform, existsFn = existsSync) {
  const pathKey = platform === 'win32'
    ? (Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH')
    : 'PATH'
  const rawPath = env[pathKey] ?? ''
  const sep = platform === 'win32' ? ';' : ':'
  const dirs = rawPath.split(sep).map(s => s.trim()).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name)
      try {
        if (existsFn(full)) return full
      } catch { /* unreadable dir */ }
    }
  }
  return null
}

function firstExisting(paths, existsFn = existsSync) {
  for (const candidate of paths) {
    if (!candidate) continue
    try {
      if (existsFn(candidate)) return candidate
    } catch { /* inaccessible */ }
  }
  return null
}

function findJetBrainsWindowsExe(baseDirs, subDirPrefix, exeName, existsFn, readdirFn) {
  for (const base of baseDirs) {
    if (!base) continue
    try {
      if (!existsFn(base)) continue
      const entries = readdirFn(base)
      for (const name of entries) {
        if (!name.toLowerCase().startsWith(subDirPrefix.toLowerCase())) continue
        const candidate = `${base}\\${name}\\bin\\${exeName}`
        if (existsFn(candidate)) return candidate
      }
    } catch { /* ignore */ }
  }
  return null
}

function findMacAppBundle(bundleNames, home, existsFn) {
  const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', join(home, 'Applications')]
  for (const bundle of bundleNames) {
    for (const root of roots) {
      const full = join(root, bundle)
      try {
        if (existsFn(full)) return full
      } catch { /* ignore */ }
    }
  }
  return null
}

const MAC_APPS = [
  { id: 'cursor', name: 'Cursor', category: 'editor', bundles: ['Cursor.app'], bins: ['cursor'] },
  { id: 'vscode', name: 'VS Code', category: 'editor', bundles: ['Visual Studio Code.app'], bins: ['code'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', category: 'editor', bundles: ['Visual Studio Code - Insiders.app'], bins: ['code-insiders'] },
  { id: 'windsurf', name: 'Windsurf', category: 'editor', bundles: ['Windsurf.app'], bins: ['windsurf'] },
  { id: 'zed', name: 'Zed', category: 'editor', bundles: ['Zed.app'], bins: ['zed'] },
  { id: 'sublime', name: 'Sublime Text', category: 'editor', bundles: ['Sublime Text.app'], bins: ['subl'] },
  { id: 'xcode', name: 'Xcode', category: 'editor', bundles: ['Xcode.app'] },
  { id: 'android-studio', name: 'Android Studio', category: 'editor', bundles: ['Android Studio.app'] },
  { id: 'intellij', name: 'IntelliJ IDEA', category: 'editor', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Ultimate.app'] },
  { id: 'pycharm', name: 'PyCharm', category: 'editor', bundles: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Professional.app'] },
  { id: 'webstorm', name: 'WebStorm', category: 'editor', bundles: ['WebStorm.app'] },
  { id: 'goland', name: 'GoLand', category: 'editor', bundles: ['GoLand.app'] },
  { id: 'rustrover', name: 'RustRover', category: 'editor', bundles: ['RustRover.app'] },
  { id: 'clion', name: 'CLion', category: 'editor', bundles: ['CLion.app'] },
  { id: 'rider', name: 'Rider', category: 'editor', bundles: ['Rider.app'] },
  { id: 'phpstorm', name: 'PhpStorm', category: 'editor', bundles: ['PhpStorm.app'] },
  { id: 'iterm', name: 'iTerm2', category: 'terminal', bundles: ['iTerm.app'] },
  { id: 'ghostty', name: 'Ghostty', category: 'terminal', bundles: ['Ghostty.app'] },
  { id: 'warp', name: 'Warp', category: 'terminal', bundles: ['Warp.app'] },
  { id: 'kitty', name: 'kitty', category: 'terminal', bundles: ['kitty.app'] },
  { id: 'alacritty', name: 'Alacritty', category: 'terminal', bundles: ['Alacritty.app'] },
  { id: 'terminal', name: 'Terminal', category: 'terminal', bundles: ['Terminal.app'] },
]

const LINUX_APPS = [
  { id: 'cursor', name: 'Cursor', category: 'editor', bins: ['cursor'] },
  { id: 'vscode', name: 'VS Code', category: 'editor', bins: ['code'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', category: 'editor', bins: ['code-insiders'] },
  { id: 'windsurf', name: 'Windsurf', category: 'editor', bins: ['windsurf'] },
  { id: 'zed', name: 'Zed', category: 'editor', bins: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', category: 'editor', bins: ['subl'] },
  { id: 'intellij', name: 'IntelliJ IDEA', category: 'editor', bins: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community'] },
  { id: 'pycharm', name: 'PyCharm', category: 'editor', bins: ['pycharm', 'pycharm-professional', 'pycharm-community'] },
  { id: 'webstorm', name: 'WebStorm', category: 'editor', bins: ['webstorm'] },
  { id: 'goland', name: 'GoLand', category: 'editor', bins: ['goland'] },
  { id: 'rustrover', name: 'RustRover', category: 'editor', bins: ['rustrover'] },
  { id: 'clion', name: 'CLion', category: 'editor', bins: ['clion'] },
  { id: 'rider', name: 'Rider', category: 'editor', bins: ['rider'] },
  { id: 'phpstorm', name: 'PhpStorm', category: 'editor', bins: ['phpstorm'] },
  { id: 'ghostty', name: 'Ghostty', category: 'terminal', bins: ['ghostty'] },
  { id: 'kitty', name: 'kitty', category: 'terminal', bins: ['kitty'] },
  { id: 'alacritty', name: 'Alacritty', category: 'terminal', bins: ['alacritty'] },
  { id: 'warp', name: 'Warp', category: 'terminal', bins: ['warp-terminal'] },
  { id: 'gnome-terminal', name: 'GNOME Terminal', category: 'terminal', bins: ['gnome-terminal'] },
  { id: 'konsole', name: 'Konsole', category: 'terminal', bins: ['konsole'] },
]

/**
 * Detects installed editors, terminals, and the system file manager across macOS, Windows, and Linux.
 */
export function detectInstalledApps({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  existsFn = existsSync,
  readdirFn = readdirSync,
} = {}) {
  const apps = []

  if (platform === 'darwin') {
    for (const def of MAC_APPS) {
      const bundle = findMacAppBundle(def.bundles, home, existsFn)
      if (bundle) {
        apps.push({ id: def.id, name: def.name, category: def.category, kind: 'mac-bundle', target: bundle })
        continue
      }
      if (def.bins) {
        const bin = findInPath(def.bins, env, platform, existsFn)
        if (bin) apps.push({ id: def.id, name: def.name, category: def.category, kind: 'bin', target: bin })
      }
    }
    apps.push({ id: 'finder', name: 'Finder', category: 'file-manager', kind: 'finder', target: 'open' })
    return apps
  }

  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA?.trim() || ''
    const pf = env.ProgramFiles?.trim() || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)'
    const sysRoot = env.SystemRoot?.trim() || env.windir?.trim() || 'C:\\Windows'
    const jbDirs = [`${pf}\\JetBrains`, ...(localApp ? [`${localApp}\\Programs`] : [])]

    const winDefs = [
      {
        id: 'cursor', name: 'Cursor', category: 'editor',
        paths: [...(localApp ? [`${localApp}\\Programs\\cursor\\Cursor.exe`] : []), `${pf}\\cursor\\Cursor.exe`],
        bins: ['cursor.cmd', 'cursor.exe'],
      },
      {
        id: 'vscode', name: 'VS Code', category: 'editor',
        paths: [...(localApp ? [`${localApp}\\Programs\\Microsoft VS Code\\Code.exe`] : []), `${pf}\\Microsoft VS Code\\Code.exe`, `${pf86}\\Microsoft VS Code\\Code.exe`],
        bins: ['code.cmd', 'Code.exe'],
      },
      {
        id: 'vscode-insiders', name: 'VS Code Insiders', category: 'editor',
        paths: [...(localApp ? [`${localApp}\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`] : []), `${pf}\\Microsoft VS Code Insiders\\Code - Insiders.exe`],
        bins: ['code-insiders.cmd'],
      },
      {
        id: 'windsurf', name: 'Windsurf', category: 'editor',
        paths: [...(localApp ? [`${localApp}\\Programs\\Windsurf\\Windsurf.exe`] : []), `${pf}\\Windsurf\\Windsurf.exe`],
        bins: ['windsurf.cmd'],
      },
      {
        id: 'zed', name: 'Zed', category: 'editor',
        paths: [...(localApp ? [`${localApp}\\Programs\\Zed\\Zed.exe`] : []), `${pf}\\Zed\\Zed.exe`],
        bins: ['zed.exe'],
      },
      {
        id: 'sublime', name: 'Sublime Text', category: 'editor',
        paths: [`${pf}\\Sublime Text\\sublime_text.exe`, `${pf}\\Sublime Text 3\\sublime_text.exe`],
        bins: ['subl.exe'],
      },
      { id: 'intellij', name: 'IntelliJ IDEA', category: 'editor', jb: ['IntelliJ IDEA', 'idea64.exe'] },
      { id: 'pycharm', name: 'PyCharm', category: 'editor', jb: ['PyCharm', 'pycharm64.exe'] },
      { id: 'webstorm', name: 'WebStorm', category: 'editor', jb: ['WebStorm', 'webstorm64.exe'] },
      { id: 'goland', name: 'GoLand', category: 'editor', jb: ['GoLand', 'goland64.exe'] },
      { id: 'rustrover', name: 'RustRover', category: 'editor', jb: ['RustRover', 'rustrover64.exe'] },
      { id: 'clion', name: 'CLion', category: 'editor', jb: ['CLion', 'clion64.exe'] },
      { id: 'rider', name: 'Rider', category: 'editor', jb: ['Rider', 'rider64.exe'] },
      { id: 'phpstorm', name: 'PhpStorm', category: 'editor', jb: ['PhpStorm', 'phpstorm64.exe'] },
      {
        id: 'windows-terminal', name: 'Windows Terminal', category: 'terminal',
        paths: [...(localApp ? [`${localApp}\\Microsoft\\WindowsApps\\wt.exe`] : [])],
        bins: ['wt.exe'],
      },
      {
        id: 'git-bash', name: 'Git Bash', category: 'terminal',
        paths: [`${pf}\\Git\\git-bash.exe`, `${pf86}\\Git\\git-bash.exe`, ...(localApp ? [`${localApp}\\Programs\\Git\\git-bash.exe`] : [])],
      },
      {
        id: 'pwsh', name: 'PowerShell', category: 'terminal',
        paths: [`${pf}\\PowerShell\\7\\pwsh.exe`, `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`],
        bins: ['pwsh.exe'],
      },
    ]

    for (const def of winDefs) {
      let found = def.paths ? firstExisting(def.paths, existsFn) : null
      if (!found && def.jb) found = findJetBrainsWindowsExe(jbDirs, def.jb[0], def.jb[1], existsFn, readdirFn)
      if (!found && def.bins) found = findInPath(def.bins, env, platform, existsFn)
      if (found) apps.push({ id: def.id, name: def.name, category: def.category, kind: 'win-exe', target: found })
    }
    apps.push({ id: 'explorer', name: 'File Explorer', category: 'file-manager', kind: 'explorer', target: 'explorer.exe' })
    return apps
  }

  // Linux & other POSIX platforms.
  for (const def of LINUX_APPS) {
    const bin = findInPath(def.bins, env, platform, existsFn)
    if (bin) apps.push({ id: def.id, name: def.name, category: def.category, kind: 'bin', target: bin })
  }
  apps.push({ id: 'file-manager', name: 'Files', category: 'file-manager', kind: 'xdg', target: 'xdg-open' })
  return apps
}

/**
 * Builds a safe, shell-free `spawn` specification for opening `targetPath` in `app`.
 */
export function buildLaunchSpec(app, targetPath, { platform = process.platform, isDirectory = true, env = process.env } = {}) {
  const dirTarget = isDirectory ? targetPath : dirname(targetPath)
  const cleanEnv = scrubbedLaunchEnv(env)
  const baseOpts = { detached: true, stdio: 'ignore', shell: false, env: cleanEnv }

  if (app.kind === 'finder') {
    return { command: 'open', args: isDirectory ? [targetPath] : ['-R', targetPath], options: baseOpts }
  }
  if (app.kind === 'mac-bundle') {
    const arg = app.category === 'terminal' ? dirTarget : targetPath
    return { command: 'open', args: ['-a', app.target, arg], options: baseOpts }
  }
  if (app.kind === 'explorer') {
    if (isDirectory) return { command: 'explorer.exe', args: [targetPath], options: baseOpts }
    const safe = targetPath.replace(/"/g, '')
    return { command: 'explorer.exe', args: [`/select,"${safe}"`], options: { ...baseOpts, windowsVerbatimArguments: true } }
  }
  if (app.kind === 'xdg') {
    return { command: 'xdg-open', args: [dirTarget], options: baseOpts }
  }
  if (platform === 'win32' && app.id === 'windows-terminal') {
    return { command: app.target, args: ['-d', dirTarget], options: baseOpts }
  }
  if (platform === 'win32' && app.id === 'git-bash') {
    return { command: app.target, args: [`--cd=${dirTarget}`], options: baseOpts }
  }
  if (platform === 'win32' && app.id === 'pwsh') {
    return { command: app.target, args: ['-NoExit'], options: { ...baseOpts, cwd: dirTarget } }
  }
  if (app.category === 'terminal') {
    if (app.id === 'gnome-terminal') return { command: app.target, args: [`--working-directory=${dirTarget}`], options: baseOpts }
    if (app.id === 'konsole') return { command: app.target, args: ['--workdir', dirTarget], options: baseOpts }
    if (app.id === 'kitty') return { command: app.target, args: ['--directory', dirTarget], options: baseOpts }
    if (app.id === 'alacritty') return { command: app.target, args: ['--working-directory', dirTarget], options: baseOpts }
    if (app.id === 'ghostty') return { command: app.target, args: [`--working-directory=${dirTarget}`], options: baseOpts }
    return { command: app.target, args: [], options: { ...baseOpts, cwd: dirTarget } }
  }
  return { command: app.target, args: [targetPath], options: baseOpts }
}

/**
 * Spawns the chosen external app cleanly without shell interpolation.
 */
export function openInExternalApp(app, targetPath, { platform = process.platform, env = process.env, spawnFn = spawn, statFn = statSync } = {}) {
  if (!app || typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error('Invalid app or target path')
  }
  const info = statFn(targetPath)
  const isDirectory = info.isDirectory()
  const spec = buildLaunchSpec(app, targetPath, { platform, isDirectory, env })
  return new Promise((resolveLaunch, rejectLaunch) => {
    let settled = false
    let child
    try {
      child = spawnFn(spec.command, spec.args, spec.options)
    } catch (err) {
      rejectLaunch(err)
      return
    }
    child.once('error', (err) => {
      if (settled) return
      settled = true
      rejectLaunch(err)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref?.()
      resolveLaunch(true)
    })
  })
}

function normalizeDirKey(dirPath, platform = process.platform) {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') return ''
  const norm = resolve(dirPath).replace(/[\\/]+$/, '')
  return platform === 'win32' ? norm.toLowerCase() : norm
}

/**
 * Persists per-directory default "Open in app" selections in a small JSON file.
 */
export class OpenInAppStore {
  #filePath
  #platform
  #map = null

  constructor(filePath, { platform = process.platform } = {}) {
    this.#filePath = filePath
    this.#platform = platform
  }

  #load() {
    if (this.#map !== null) return this.#map
    this.#map = new Map()
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k === 'string' && typeof v === 'string' && k && v) this.#map.set(k, v)
        }
      }
    } catch { /* missing or corrupt file starts empty */ }
    return this.#map
  }

  #save() {
    const map = this.#load()
    while (map.size > MAX_STORED_DIR_DEFAULTS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true })
      writeFileSync(this.#filePath, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8')
    } catch { /* best-effort persistence */ }
  }

  getDefault(dirPath) {
    const key = normalizeDirKey(dirPath, this.#platform)
    if (!key) return null
    return this.#load().get(key) ?? null
  }

  setDefault(dirPath, appId) {
    const key = normalizeDirKey(dirPath, this.#platform)
    if (!key || typeof appId !== 'string' || !appId) return null
    const map = this.#load()
    // Refresh insertion order for LRU eviction.
    map.delete(key)
    map.set(key, appId)
    this.#save()
    return appId
  }
}
