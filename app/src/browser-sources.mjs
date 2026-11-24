// Import cookies (and open-tab localStorage when connected live) from browsers installed on
// this machine — zero browser extensions required:
//   1. Live CDP via DevToolsActivePort (Chrome/Edge/Brave 144+ `chrome://inspect/#remote-debugging`):
//      connects directly to the running browser with its own Allow dialog — no restart, no
//      Windows v20 App-Bound Encryption block, and also captures open-tab localStorage.
//   2. macOS direct Keychain + SQLite snapshot: decrypts Chromium v10 cookies in-process
//      (including Chrome 130+ meta v24 domain-hash prefixes) without launching or closing the
//      source browser — works for Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium, etc.
//   4. Linux Chromium v10 direct decryption (peanuts / empty password) without launching a browser.
//   5. Clone + self-decrypt over CDP pipe (Linux v11, older Windows v10, fallback): snapshots Local State
//      and the profile's Cookies db into a throwaway user-data-dir and launches the source binary
//      with --profile-directory so it decrypts its own store.
//   6. Firefox & Zen: cookies.sqlite is plain sqlite, snapshotted atomically via VACUUM INTO.
//   7. macOS Safari: native Cookies.binarycookies parser + multi-profile discovery (SafariTabs.db).
import { spawn, execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative, win32 } from 'node:path'
import WebSocket from 'ws'
import {
  checkSafariAccess,
  countBinaryCookies,
  harvestSafari,
  parseBinaryCookies,
  SAFARI_FULL_DISK_ACCESS_URL,
  safariContainerLibrary,
  safariProfiles,
} from './safari-cookies.mjs'

export {
  checkSafariAccess,
  countBinaryCookies,
  harvestSafari,
  parseBinaryCookies,
  SAFARI_FULL_DISK_ACCESS_URL,
  safariContainerLibrary,
  safariProfiles,
}

const WEBKIT_EPOCH_OFFSET = 11644473600 // seconds between 1601-01-01 and 1970-01-01
const LIVE_CONNECT_TIMEOUT_MS = 60_000  // allow time for Chrome's "Allow remote debugging?" dialog
const TAB_STORAGE_TIMEOUT_MS = 1_500
const MAX_STORAGE_ORIGINS = 25
const MAX_STORAGE_ENTRIES = 500
const MAX_STORAGE_BYTES = 512 * 1024
const EXE_CACHE_TTL_MS = 60_000

function abortError() {
  const err = new Error('Browser import cancelled')
  err.code = 'import-cancelled'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

const KIND_ORDER = [
  'chrome', 'chrome-beta', 'chrome-canary', 'chrome-dev',
  'edge', 'edge-beta',
  'brave', 'arc', 'vivaldi', 'opera', 'opera-gx', 'chromium',
  'safari',
  'firefox', 'zen',
]

const BROWSER_META = {
  chrome: { name: 'Chrome', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Chrome Safe Storage'] },
  'chrome-beta': { name: 'Chrome Beta', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Chrome Safe Storage'] },
  'chrome-canary': { name: 'Chrome Canary', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Chrome Canary Safe Storage', 'Chrome Safe Storage'] },
  'chrome-dev': { name: 'Chrome Dev', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Chrome Safe Storage'] },
  edge: { name: 'Edge', engine: 'chromium', inspectUrl: 'edge://inspect/#remote-debugging', keychain: ['Microsoft Edge Safe Storage'] },
  'edge-beta': { name: 'Edge Beta', engine: 'chromium', inspectUrl: 'edge://inspect/#remote-debugging', keychain: ['Microsoft Edge Safe Storage'] },
  brave: { name: 'Brave', engine: 'chromium', inspectUrl: 'brave://inspect/#remote-debugging', keychain: ['Brave Safe Storage'] },
  arc: { name: 'Arc', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Arc Safe Storage'] },
  vivaldi: { name: 'Vivaldi', engine: 'chromium', inspectUrl: 'vivaldi://inspect/#remote-debugging', keychain: ['Vivaldi Safe Storage'] },
  opera: { name: 'Opera', engine: 'chromium', inspectUrl: 'opera://inspect/#remote-debugging', keychain: ['Opera Safe Storage'], flat: true },
  'opera-gx': { name: 'Opera GX', engine: 'chromium', inspectUrl: 'opera://inspect/#remote-debugging', keychain: ['Opera Safe Storage'], flat: true },
  chromium: { name: 'Chromium', engine: 'chromium', inspectUrl: 'chrome://inspect/#remote-debugging', keychain: ['Chromium Safe Storage'] },
  safari: { name: 'Safari', engine: 'safari', inspectUrl: null, keychain: [] },
  firefox: { name: 'Firefox', engine: 'firefox', inspectUrl: null, keychain: [] },
  zen: { name: 'Zen', engine: 'firefox', inspectUrl: null, keychain: [] },
}

// ------------------------------------------------------------------ installed binaries

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/

export function kindOfExe(exePath) {
  const p = String(exePath ?? '').toLowerCase().replace(/\//g, '\\')
  const base = win32.basename(p)
  if (base.startsWith('zen') || p.includes('\\zen browser\\') || p.includes('zen.app')) return 'zen'
  if (base.startsWith('firefox')) return 'firefox'
  if (p.includes('edge beta') || p.includes('microsoft-edge-beta')) return 'edge-beta'
  if (base === 'msedge.exe' || p.includes('microsoft edge') || p.includes('microsoft-edge')) return 'edge'
  if (p.includes('chrome canary') || p.includes('chrome sxs')) return 'chrome-canary'
  if (p.includes('chrome beta') || p.includes('google-chrome-beta')) return 'chrome-beta'
  if (p.includes('chrome dev') || p.includes('google-chrome-unstable')) return 'chrome-dev'
  if (p.includes('brave')) return 'brave'
  if (p.includes('\\arc\\') || p.includes('arc.app') || base === 'arc.exe') return 'arc'
  if (p.includes('vivaldi')) return 'vivaldi'
  if (p.includes('opera gx')) return 'opera-gx'
  if (p.includes('opera')) return 'opera'
  if (p.includes('chromium')) return 'chromium'
  if (p.includes('chrome')) return 'chrome'
  return null
}

async function exeVersion(exePath) {
  // The version-named folder next to the exe; `--version` would open a window in a running browser.
  try {
    const names = await readdir(dirname(exePath))
    return names.filter((n) => VERSION_DIR.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null
  } catch { return null }
}

function regQuery(key, view) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve', `/reg:${view}`], { encoding: 'buffer', windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const m = stdout.toString('utf8').match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)
      resolve(m ? m[1].replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : null)
    })
  })
}

function exeCandidates() {
  const home = homedir()
  if (platform() === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Google\\Chrome Beta\\Application\\chrome.exe',
      'Google\\Chrome SxS\\Application\\chrome.exe',
      'Google\\Chrome Dev\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Microsoft\\Edge Beta\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Microsoft\\WindowsApps\\Arc.exe',
      'Vivaldi\\Application\\vivaldi.exe',
      'Programs\\Opera\\opera.exe',
      'Programs\\Opera GX\\opera.exe',
      'Chromium\\Application\\chrome.exe',
      'Mozilla Firefox\\firefox.exe',
      'Zen Browser\\zen.exe',
    ]
    return roots.flatMap((r) => rels.map((rel) => join(r, rel)))
  }
  if (platform() === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Arc.app/Contents/MacOS/Arc',
      'Vivaldi.app/Contents/MacOS/Vivaldi',
      'Opera.app/Contents/MacOS/Opera',
      'Opera GX.app/Contents/MacOS/Opera',
      'Chromium.app/Contents/MacOS/Chromium',
      'Firefox.app/Contents/MacOS/firefox',
      'Zen.app/Contents/MacOS/zen',
      'Zen Browser.app/Contents/MacOS/zen',
    ]
    return ['/Applications', join(home, 'Applications')].flatMap((d) => apps.map((a) => join(d, a)))
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome-beta', '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome-unstable', '/opt/google/chrome-unstable/chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge',
    '/usr/bin/microsoft-edge-beta', '/opt/microsoft/msedge-beta/msedge',
    '/usr/bin/brave-browser', '/usr/bin/brave',
    '/usr/bin/vivaldi', '/usr/bin/vivaldi-stable',
    '/usr/bin/opera',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox',
    '/usr/bin/zen-browser', '/opt/zen-browser/zen',
  ]
}

let exeCache = null

export function clearBrowserExeCache() {
  exeCache = null
}

/** → Map<kind, { exe, version }> of installed browsers (cached briefly to avoid reg.exe storms). */
export async function findBrowserExes({ fresh = false } = {}) {
  if (!fresh && exeCache && (Date.now() - exeCache.at) < EXE_CACHE_TTL_MS) {
    return new Map(exeCache.found)
  }
  const candidates = exeCandidates()
  if (platform() === 'win32') {
    for (const exe of ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe', 'firefox.exe']) {
      for (const hive of ['HKLM', 'HKCU']) {
        for (const view of ['64', '32']) {
          const path = await regQuery(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, view)
          if (path) candidates.unshift(path)
        }
      }
    }
  }
  const found = new Map()
  for (const path of candidates) {
    const kind = kindOfExe(path)
    if (!kind || found.has(kind)) continue
    try {
      const real = await realpath(path)
      if (existsSync(real)) found.set(kind, { exe: real, version: await exeVersion(real) })
    } catch { /* not installed */ }
  }
  exeCache = { at: Date.now(), found }
  return new Map(found)
}

// ------------------------------------------------------------------ profile enumeration

async function asyncWindowsArcRoots(local) {
  const pkgs = join(local, 'Packages')
  try {
    const entries = await readdir(pkgs, { withFileTypes: true })
    return entries
      .filter((d) => d.isDirectory() && d.name.startsWith('TheBrowserCompany.Arc_'))
      .map((d) => join(pkgs, d.name, 'LocalCache', 'Local', 'Arc', 'User Data'))
  } catch { return [] }
}

export async function userDataRoots({ platformOverride, homeOverride, envOverride } = {}) {
  const plat = platformOverride ?? platform()
  const pathJoin = plat === 'win32' ? win32.join : posix.join
  const home = homeOverride ?? homedir()
  const env = envOverride ?? process.env
  const local = env.LOCALAPPDATA ?? pathJoin(home, 'AppData', 'Local')
  const roaming = env.APPDATA ?? pathJoin(home, 'AppData', 'Roaming')
  if (plat === 'win32') {
    return {
      chrome: [pathJoin(local, 'Google', 'Chrome', 'User Data')],
      'chrome-beta': [pathJoin(local, 'Google', 'Chrome Beta', 'User Data')],
      'chrome-canary': [pathJoin(local, 'Google', 'Chrome SxS', 'User Data')],
      'chrome-dev': [pathJoin(local, 'Google', 'Chrome Dev', 'User Data')],
      edge: [pathJoin(local, 'Microsoft', 'Edge', 'User Data')],
      'edge-beta': [pathJoin(local, 'Microsoft', 'Edge Beta', 'User Data')],
      brave: [pathJoin(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      arc: await asyncWindowsArcRoots(local),
      vivaldi: [pathJoin(local, 'Vivaldi', 'User Data')],
      opera: [pathJoin(roaming, 'Opera Software', 'Opera Stable')],
      'opera-gx': [pathJoin(roaming, 'Opera Software', 'Opera GX Stable')],
      chromium: [pathJoin(local, 'Chromium', 'User Data')],
      safari: [],
      firefox: [pathJoin(roaming, 'Mozilla', 'Firefox')],
      zen: [pathJoin(roaming, 'zen')],
    }
  }
  if (plat === 'darwin') {
    const appSupport = pathJoin(home, 'Library', 'Application Support')
    return {
      chrome: [pathJoin(appSupport, 'Google', 'Chrome')],
      'chrome-beta': [pathJoin(appSupport, 'Google', 'Chrome Beta')],
      'chrome-canary': [pathJoin(appSupport, 'Google', 'Chrome Canary')],
      'chrome-dev': [pathJoin(appSupport, 'Google', 'Chrome Dev')],
      edge: [pathJoin(appSupport, 'Microsoft Edge')],
      'edge-beta': [pathJoin(appSupport, 'Microsoft Edge Beta')],
      brave: [pathJoin(appSupport, 'BraveSoftware', 'Brave-Browser')],
      arc: [pathJoin(appSupport, 'Arc', 'User Data')],
      vivaldi: [pathJoin(appSupport, 'Vivaldi')],
      opera: [pathJoin(appSupport, 'com.operasoftware.Opera')],
      'opera-gx': [pathJoin(appSupport, 'com.operasoftware.OperaGX')],
      chromium: [pathJoin(appSupport, 'Chromium')],
      safari: [pathJoin(home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library')],
      firefox: [pathJoin(appSupport, 'Firefox')],
      zen: [pathJoin(appSupport, 'zen')],
    }
  }
  const config = env.XDG_CONFIG_HOME ?? pathJoin(home, '.config')
  return {
    chrome: [pathJoin(config, 'google-chrome')],
    'chrome-beta': [pathJoin(config, 'google-chrome-beta')],
    'chrome-canary': [],
    'chrome-dev': [pathJoin(config, 'google-chrome-unstable')],
    edge: [pathJoin(config, 'microsoft-edge')],
    'edge-beta': [pathJoin(config, 'microsoft-edge-beta')],
    brave: [pathJoin(config, 'BraveSoftware', 'Brave-Browser')],
    arc: [],
    vivaldi: [pathJoin(config, 'vivaldi')],
    opera: [pathJoin(config, 'opera')],
    'opera-gx': [],
    chromium: [pathJoin(config, 'chromium')],
    safari: [],
    firefox: [
      pathJoin(home, '.mozilla', 'firefox'),
      pathJoin(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
      pathJoin(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
    ],
    zen: [
      pathJoin(home, '.zen'),
      pathJoin(home, '.var', 'app', 'app.zen_browser.zen', '.zen'),
      pathJoin(home, 'snap', 'zen-browser', 'common', '.zen'),
    ],
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Chromium profiles under one user-data root: `info_cache` names/emails + a scan for Network/Cookies. */
export async function chromiumProfiles(root, { flat = false } = {}) {
  if (flat) {
    const cookieDb = join(root, 'Network', 'Cookies')
    const legacy = join(root, 'Cookies')
    const hasCookies = existsSync(cookieDb) || existsSync(legacy)
    if (!hasCookies) return []
    return [{
      dir: '', name: 'Default', email: null, activeTime: 0, isLastUsed: true,
      cookieDb: existsSync(cookieDb) ? cookieDb : legacy, hasCookies: true,
    }]
  }
  const localState = readJson(join(root, 'Local State'))
  const infoCache = localState?.profile?.info_cache ?? {}
  const lastUsed = typeof localState?.profile?.last_used === 'string' ? localState.profile.last_used : null
  const meta = new Map()
  for (const [dir, info] of Object.entries(infoCache)) {
    const name = info?.name || info?.gaia_name || dir
    const userName = typeof info?.user_name === 'string' && info.user_name.trim() ? info.user_name.trim() : null
    const email = userName && userName !== name ? userName : null
    meta.set(dir, { name, email, activeTime: Number(info?.active_time) || 0 })
  }
  let dirs = []
  try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const profiles = []
  for (const dir of dirs) {
    if (dir === 'System Profile' || dir === 'Guest Profile') continue
    const cookieDb = join(root, dir, 'Network', 'Cookies')
    const legacy = join(root, dir, 'Cookies')
    const hasCookies = existsSync(cookieDb) || existsSync(legacy)
    if (!hasCookies && !meta.has(dir)) continue
    const info = meta.get(dir)
    profiles.push({
      dir,
      name: info?.name ?? dir,
      email: info?.email ?? null,
      activeTime: info?.activeTime ?? 0,
      isLastUsed: dir === lastUsed,
      cookieDb: existsSync(cookieDb) ? cookieDb : legacy,
      hasCookies,
    })
  }
  profiles.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })))
  return profiles
}

/** Firefox / Zen profiles from profiles.ini (sections ProfileN with Path/IsRelative/Default). */
export async function firefoxProfiles(root) {
  let text
  try { text = await readFile(join(root, 'profiles.ini'), 'utf8') } catch { return [] }
  const profiles = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      if (current?.path) profiles.push(current)
      current = /^Profile\d+$/i.test(section[1]) ? { path: null, name: null, relative: true } : null
      continue
    }
    if (!current) continue
    const m = line.match(/^([^=]+)=(.*)$/)
    if (!m) continue
    const [, key, value] = m
    if (key === 'Path') current.path = value.trim()
    else if (key === 'Name') current.name = value.trim()
    else if (key === 'IsRelative') current.relative = value.trim() !== '0'
  }
  if (current?.path) profiles.push(current)
  return profiles
    .map((p) => {
      const dir = p.relative ? join(root, p.path) : p.path
      return { dir, path: dir, name: p.name ?? basename(dir), hasCookies: existsSync(join(dir, 'cookies.sqlite')) }
    })
    .filter((p) => p.hasCookies || p.name)
}

// ------------------------------------------------------------------ DevToolsActivePort & ABE inspection

/** Read `<userDataDir>/DevToolsActivePort` written by Chrome/Edge 144+ remote debugging. */
export function readDevToolsActivePort(userDataDir) {
  if (!userDataDir) return null
  try {
    const text = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8')
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null
    const port = Number(lines[0])
    const wsPath = lines[1]
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    if (!wsPath.startsWith('/devtools/')) return null
    return { port, wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}` }
  } catch {
    return null
  }
}

/** Fast loopback TCP connect check — confirms a DevToolsActivePort is actually listening without sending WS bytes. */
export function isLoopbackPortOpen(port, { timeoutMs = 400, signal } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false)
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ok, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (err) reject(err)
      else resolve(ok)
    }
    const onAbort = () => finish(false, abortError())
    const timer = setTimeout(() => finish(false), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Lightweight live-debug check for one source: reads only its DevToolsActivePort and probes loopback TCP. */
export async function checkSourceLiveDebug(source, { probePort = isLoopbackPortOpen, signal } = {}) {
  if (!source || (source.engine && source.engine !== 'chromium')) return false
  const { userDataDir } = resolveSourceLayout(source)
  const active = readDevToolsActivePort(userDataDir)
  if (!active) return false
  return Boolean(await probePort(active.port, { signal }))
}

/** Lightweight readiness probe for one source: DevTools loopback check (Chromium) or FDA access check (Safari). */
export async function probeSource(source, opts = {}) {
  if (!source) return { liveDebugReady: false, permissionGranted: false }
  if (source.engine === 'safari') {
    const access = await checkSafariAccess({
      home: opts.home,
      containerLib: source.userDataDir || undefined,
    })
    return {
      liveDebugReady: false,
      permissionGranted: access.accessible || access.containerReadable === true,
    }
  }
  return {
    liveDebugReady: await checkSourceLiveDebug(source, opts),
    permissionGranted: true,
  }
}

/** True when Local State declares a Windows App-Bound Encryption key (readable even while locked). */
export function hasAppBoundKey(userDataDir) {
  if (!userDataDir) return false
  const localState = readJson(join(userDataDir, 'Local State'))
  return typeof localState?.os_crypt?.app_bound_encrypted_key === 'string' && localState.os_crypt.app_bound_encrypted_key.length > 0
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii')

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

/** Fast, non-blocking cookie row count for profile selection UI. Never throws; returns null when locked/unreadable. */
export function countSqliteCookies(dbPath, tableName) {
  if (!dbPath || (tableName !== 'cookies' && tableName !== 'moz_cookies')) return null
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 100')
    if (!hasTable(db, tableName)) return 0
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
    return typeof row?.count === 'number' ? row.count : Number(row?.count) || 0
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * Every importable profile on this machine.
 * → [{ id, kind, name, label, engine:'chromium'|'firefox'|'safari', userDataDir, profilePath, profileDir,
 *      profileName, email, cookieDb, cookieFile, hasCookies, cookieCount, needsPermission, exe, exeVersion,
 *      inspectUrl, liveDebugReady, keychainServices, flat }]
 */
export async function listSources({ probePort = isLoopbackPortOpen, freshExes = false, safariEnumerator = safariProfiles } = {}) {
  const exes = await findBrowserExes({ fresh: freshExes })
  const roots = await userDataRoots()
  const isMac = platform() === 'darwin'
  const sources = []
  const seenIds = new Set()
  for (const kind of KIND_ORDER) {
    const meta = BROWSER_META[kind]
    if (!meta) continue
    if (meta.engine === 'safari') {
      if (!isMac) continue
      const safariRoot = roots.safari?.[0] ?? safariContainerLibrary()
      for (const p of await safariEnumerator({ containerLib: safariRoot })) {
        const id = `safari:${p.dir}`
        if (seenIds.has(id)) continue
        seenIds.add(id)
        sources.push({
          id, kind: 'safari', engine: 'safari', name: meta.name,
          label: p.displayName ? `${meta.name} — ${p.displayName}` : meta.name,
          userDataDir: safariRoot, profilePath: p.cookieFile ? dirname(p.cookieFile) : safariRoot,
          profileDir: p.dir, profileName: p.name, email: null,
          cookieDb: p.cookieFile, cookieFile: p.cookieFile,
          hasCookies: p.hasCookies, cookieCount: p.cookieCount ?? null,
          needsPermission: p.needsPermission === true,
          exe: null, exeVersion: null,
          inspectUrl: null, liveDebugReady: false, keychainServices: [], flat: false,
        })
      }
      continue
    }
    const exe = exes.get(kind)
    for (const root of roots[kind] ?? []) {
      if (meta.engine === 'firefox') {
        for (const p of await firefoxProfiles(root)) {
          if (!p.hasCookies) continue
          const id = `${kind}:${p.path}`
          if (seenIds.has(id)) continue
          seenIds.add(id)
          const cookieDb = join(p.path, 'cookies.sqlite')
          sources.push({
            id, kind, engine: 'firefox', name: meta.name, label: `${meta.name} — ${p.name}`,
            userDataDir: root, profilePath: p.path, profileDir: basename(p.path), profileName: p.name, email: null,
            cookieDb, hasCookies: true, cookieCount: countSqliteCookies(cookieDb, 'moz_cookies'),
            needsPermission: false,
            exe: exe?.exe ?? null, exeVersion: exe?.version ?? null,
            inspectUrl: null, liveDebugReady: false, keychainServices: [], flat: false,
          })
        }
        continue
      }
      const activePort = readDevToolsActivePort(root)
      const liveDebugReady = activePort !== null && Boolean(await probePort(activePort.port))
      // Chromium on macOS can decrypt via Keychain without launching the binary; on Linux, v10
      // cookies can be decrypted directly in JS; on Windows, MSIX installs like Arc can still
      // enter the guided remote-debugging flow without a resolved exe.
      const canHarvest = Boolean(exe) || liveDebugReady || (isMac && meta.keychain.length > 0) || platform() === 'linux' || (platform() === 'win32' && kind === 'arc')
      if (!canHarvest) continue
      for (const p of await chromiumProfiles(root, { flat: meta.flat === true })) {
        if (!p.hasCookies) continue
        const profilePath = meta.flat ? root : join(root, p.dir)
        const idSuffix = p.dir || 'Default'
        const id = seenIds.has(`${kind}:${idSuffix}`) ? `${kind}:${profilePath}` : `${kind}:${idSuffix}`
        if (seenIds.has(id)) continue
        seenIds.add(id)
        sources.push({
          id, kind, engine: 'chromium', name: meta.name,
          label: p.name && p.name !== meta.name ? `${meta.name} — ${p.name}` : meta.name,
          userDataDir: root, profilePath, profileDir: p.dir, profileName: p.name, email: p.email,
          cookieDb: p.cookieDb, hasCookies: p.hasCookies, cookieCount: countSqliteCookies(p.cookieDb, 'cookies'),
          needsPermission: false,
          exe: exe?.exe ?? null, exeVersion: exe?.version ?? null,
          inspectUrl: meta.inspectUrl, liveDebugReady,
          keychainServices: meta.keychain, flat: meta.flat === true,
        })
      }
    }
  }
  return sources
}

// ------------------------------------------------------------------ the clone layout

const LOCKED = (error) => error?.code === 'EBUSY' || error?.code === 'EPERM'
const SQLITE_LOCKED = (error) => LOCKED(error)
  || error?.errcode === 5
  || error?.errcode === 6
  || /database is locked|database table is locked/i.test(String(error?.message ?? ''))

async function removeSqliteFamily(dbPath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await rm(`${dbPath}${suffix}`, { force: true }).catch(() => {})
  }
}

function resolveSourceLayout(source) {
  const flat = source.flat === true
  const userDataDir = source.userDataDir ?? (flat ? source.profilePath : dirname(source.profilePath))
  const profileDir = source.profileDir ?? (flat ? '' : basename(source.profilePath))
  const relCookieDir = source.cookieDb
    ? relative(userDataDir, dirname(source.cookieDb))
    : (flat ? 'Network' : join(profileDir, 'Network'))
  return { userDataDir, profileDir, relCookieDir }
}

async function isSqliteFile(filePath) {
  let fh
  try {
    fh = await open(filePath, 'r')
    const head = Buffer.alloc(SQLITE_HEADER.length)
    const { bytesRead } = await fh.read(head, 0, SQLITE_HEADER.length, 0)
    return bytesRead === SQLITE_HEADER.length && head.equals(SQLITE_HEADER)
  } catch (error) {
    if (LOCKED(error)) { const e = new Error('the source browser is running'); e.code = 'locked'; throw e }
    throw error
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Atomically export a live SQLite database (including active WAL frames) into a single
 * self-contained file using SQLite's read-only VACUUM INTO.
 * Throws {code:'locked'} when SQLite reports an exclusive/busy lock rather than falling back
 * to a torn multi-file copy. Returns false only for non-SQLite inputs or non-lock open errors
 * (such as read-only source directories unable to create -shm).
 */
export async function snapshotSqliteDatabase(fromPath, toPath, { busyTimeoutMs = 2000 } = {}) {
  if (!(await isSqliteFile(fromPath))) return false
  mkdirSync(dirname(toPath), { recursive: true })
  await removeSqliteFamily(toPath)
  let db
  try {
    db = new DatabaseSync(fromPath, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`)
    db.prepare('VACUUM INTO ?').run(toPath)
    return true
  } catch (error) {
    await removeSqliteFamily(toPath)
    if (SQLITE_LOCKED(error)) {
      const e = new Error('the source browser is running')
      e.code = 'locked'
      throw e
    }
    return false
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** Snapshot the files a harvest needs into workDir. Throws {code:'locked'} when the source is running. */
export async function cloneCookieStore(source, workDir, { needLocalState = true, skipCookieDb = false, busyTimeoutMs } = {}) {
  const copied = []
  const copyJobs = []
  let dbFrom
  let dbTo

  if (source.engine === 'firefox') {
    dbFrom = join(source.profilePath, 'cookies.sqlite')
    dbTo = join(workDir, 'cookies.sqlite')
  } else {
    const { userDataDir, relCookieDir } = resolveSourceLayout(source)
    if (needLocalState) {
      copyJobs.push({ from: join(userDataDir, 'Local State'), to: join(workDir, 'Local State'), required: true })
    }
    const dbName = source.cookieDb ? basename(source.cookieDb) : 'Cookies'
    const fromDir = source.cookieDb ? dirname(source.cookieDb) : join(source.profilePath, 'Network')
    const toDir = join(workDir, relCookieDir)
    dbFrom = join(fromDir, dbName)
    dbTo = join(toDir, dbName)
  }

  for (const job of copyJobs) {
    try {
      mkdirSync(dirname(job.to), { recursive: true })
      await copyFile(job.from, job.to)
      copied.push(job.from)
    } catch (error) {
      if (LOCKED(error)) { const e = new Error('the source browser is running'); e.code = 'locked'; throw e }
      if (!job.required && error?.code === 'ENOENT') continue
      if (job.required) throw error
    }
  }

  if (skipCookieDb) return copied

  // Prefer an atomic SQLite VACUUM INTO snapshot over multi-file copy so an active browser
  // WAL checkpoint can never leave half-copied pages in workDir.
  const snapshotted = await snapshotSqliteDatabase(dbFrom, dbTo, busyTimeoutMs !== undefined ? { busyTimeoutMs } : undefined)
  if (snapshotted) {
    copied.push(dbFrom)
    return copied
  }

  // Clear any prior destination db + sidecars before copying so a vanished source -wal
  // cannot leave behind a stale workDir -wal on retry.
  await removeSqliteFamily(dbTo)
  const sidecars = source.engine === 'firefox'
    ? ['', '-wal', '-shm']
    : ['', '-journal', '-wal', '-shm']
  for (const suffix of sidecars) {
    const from = `${dbFrom}${suffix}`
    const to = `${dbTo}${suffix}`
    const required = suffix === ''
    try {
      mkdirSync(dirname(to), { recursive: true })
      await copyFile(from, to)
      copied.push(from)
    } catch (error) {
      if (LOCKED(error)) { const e = new Error('the source browser is running'); e.code = 'locked'; throw e }
      if (!required && error?.code === 'ENOENT') continue
      if (required) throw error
    }
  }
  return copied
}

/** A fresh throwaway dir for a clone; remove() deletes it. */
export async function cloneWorkDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-cookie-import-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }) }
}

// ------------------------------------------------------------------ Strategy 1: Live DevToolsActivePort CDP

/** Minimal CDP client over a loopback WebSocket (no HTTP probe — Chrome 144+ is WS-only). */
function wsCdpConnect(wsUrl, { connectTimeoutMs = LIVE_CONNECT_TIMEOUT_MS, WebSocketImpl = WebSocket, signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl)
    const pending = new Map()
    let nextId = 1
    let settled = false

    const failPending = (reason, code = 'WS_CLOSED') => {
      for (const p of pending.values()) {
        const err = code === 'import-cancelled' ? abortError() : new Error(`CDP connection closed (${reason})`)
        if (code !== 'import-cancelled') err.code = code
        p.reject(err)
      }
      pending.clear()
    }

    const onAbort = () => {
      clearTimeout(timer)
      try { ws.terminate?.() ?? ws.close() } catch { /* ignore */ }
      if (!settled) {
        settled = true
        reject(abortError())
      } else {
        failPending('cancelled', 'import-cancelled')
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try { ws.terminate?.() ?? ws.close() } catch { /* ignore */ }
      const err = new Error('Timed out waiting for the browser to accept remote debugging.')
      err.code = 'devtools-timeout'
      reject(err)
    }, connectTimeoutMs)

    ws.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        send(method, params = {}, { sessionId, timeoutMs = connectTimeoutMs } = {}) {
          if (signal?.aborted) return Promise.reject(abortError())
          const id = nextId++
          return new Promise((res, rej) => {
            const cmdTimer = setTimeout(() => {
              pending.delete(id)
              const err = new Error(`${method} timed out`)
              err.code = 'devtools-timeout'
              rej(err)
            }, timeoutMs)
            pending.set(id, {
              resolve: (value) => { clearTimeout(cmdTimer); res(value) },
              reject: (error) => { clearTimeout(cmdTimer); rej(error) },
            })
            const msg = sessionId ? { id, method, params, sessionId } : { id, method, params }
            try { ws.send(JSON.stringify(msg)) } catch (err) { pending.delete(id); clearTimeout(cmdTimer); rej(err) }
          })
        },
        close() {
          signal?.removeEventListener('abort', onAbort)
          try { ws.close() } catch { /* already closed */ }
        },
      })
    })

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.error) { const err = new Error(msg.error.message); err.code = msg.error.code; p.reject(err) }
        else p.resolve(msg.result)
      }
    })

    ws.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        const code = error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' ? 'devtools-stale' : 'devtools-denied'
        const wrapped = new Error(error?.message ?? 'Could not connect to browser remote debugging')
        wrapped.code = code
        reject(wrapped)
      } else {
        failPending(error?.message ?? 'socket error', 'devtools-denied')
      }
    })

    ws.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        const err = new Error('The browser closed the remote debugging request.')
        err.code = 'devtools-denied'
        reject(err)
      } else {
        failPending(`close ${code}`, 'devtools-denied')
      }
    })
  })
}

const MAX_STORAGE_ATTEMPTS = 60

async function harvestOpenTabLocalStorage(cdp, defaultBrowserContextId, { signal } = {}) {
  const origins = []
  throwIfAborted(signal)
  let targetInfos = []
  try {
    const res = await cdp.send('Target.getTargets', {}, { timeoutMs: 3_000 })
    targetInfos = Array.isArray(res?.targetInfos) ? res.targetInfos : []
  } catch (error) {
    if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
    return origins
  }
  const pageTargets = targetInfos.filter((t) => t.type === 'page' && typeof t.url === 'string')
  // Strictly stay within the active profile's browserContextId so tabs from other profiles or
  // incognito windows are never mixed into this import.
  let scopedPages = pageTargets
  if (typeof defaultBrowserContextId === 'string' && defaultBrowserContextId.length > 0) {
    const hasContextIds = pageTargets.some((t) => typeof t.browserContextId === 'string' && t.browserContextId.length > 0)
    if (hasContextIds) {
      scopedPages = pageTargets.filter((t) => t.browserContextId === defaultBrowserContextId)
    }
  } else {
    const distinctContexts = new Set(pageTargets.map((t) => t.browserContextId).filter(Boolean))
    if (distinctContexts.size > 1) return origins
  }

  // Group page targets by origin so a suspended/frozen tab can fall back to another open tab of
  // the same origin instead of hiding its localStorage.
  const targetsByOrigin = new Map()
  for (const t of scopedPages) {
    let origin
    try {
      const u = new URL(t.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      origin = u.origin
    } catch { continue }
    let list = targetsByOrigin.get(origin)
    if (!list) { list = []; targetsByOrigin.set(origin, list) }
    list.push(t.targetId)
  }

  const readScript = `(() => {
    try {
      const out = [];
      let bytes = 0;
      for (let i = 0; i < localStorage.length && out.length < ${MAX_STORAGE_ENTRIES}; i += 1) {
        const k = localStorage.key(i);
        if (k === null) continue;
        const v = localStorage.getItem(k);
        if (typeof v !== 'string') continue;
        bytes += k.length + v.length;
        if (bytes > ${MAX_STORAGE_BYTES}) break;
        out.push({ name: k, value: v });
      }
      return JSON.stringify(out);
    } catch { return '[]'; }
  })()`

  let attempts = 0
  for (const [origin, targetIds] of targetsByOrigin) {
    if (origins.length >= MAX_STORAGE_ORIGINS || attempts >= MAX_STORAGE_ATTEMPTS) break
    for (const targetId of targetIds) {
      throwIfAborted(signal)
      if (attempts >= MAX_STORAGE_ATTEMPTS) break
      attempts += 1
      let sessionId = null
      try {
        const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: TAB_STORAGE_TIMEOUT_MS })
        sessionId = attached?.sessionId ?? null
        if (!sessionId) continue
        const evaluated = await cdp.send('Runtime.evaluate', { expression: readScript, returnByValue: true }, { sessionId, timeoutMs: TAB_STORAGE_TIMEOUT_MS })
        const raw = evaluated?.result?.value
        if (typeof raw === 'string') {
          const entries = JSON.parse(raw)
          if (Array.isArray(entries)) {
            if (entries.length > 0) origins.push({ origin, localStorage: entries })
            break // readable tab for this origin succeeded (even if localStorage is empty)
          }
        }
      } catch (error) {
        if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
        // Frozen/suspended or restricted tab: try the next open tab for this origin.
      } finally {
        if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 1_000 }).catch(() => {})
      }
    }
  }
  return origins
}

function readLastUsedProfile(userDataDir) {
  const val = readJson(join(userDataDir, 'Local State'))?.profile?.last_used
  return typeof val === 'string' && val.length > 0 ? val : null
}

function wrongProfileError(source, profileDir) {
  const err = new Error(`Another browser profile is active; switch to ${source.profileName || profileDir} in ${source.name || 'the browser'} and try again.`)
  err.code = 'devtools-wrong-profile'
  return err
}

function readCookieSignatureFromDb(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    if (!hasTable(db, 'cookies')) return null
    const cols = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((r) => r.name))
    const hasExpiresUtc = cols.has('expires_utc')
    const hasExpiresFlag = cols.has('has_expires')
    const select = [
      'host_key',
      'name',
      hasExpiresUtc ? 'expires_utc / 1000000 AS expires_sec' : '0 AS expires_sec',
      hasExpiresFlag ? 'has_expires' : '1 AS has_expires',
    ]
    const rows = db.prepare(`SELECT ${select.join(', ')} FROM cookies`).all()
    const keys = new Set()
    const fingerprints = new Set()
    for (const row of rows) {
      const key = `${row.host_key}\u0000${row.name}`
      keys.add(key)
      if (hasExpiresUtc && row.has_expires !== 0 && typeof row.expires_sec === 'number' && row.expires_sec > 0) {
        const expSec = Math.floor(row.expires_sec - WEBKIT_EPOCH_OFFSET)
        if (expSec > 0) fingerprints.add(`${key}\u0000${expSec}`)
      }
    }
    return { keys, fingerprints }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * Defense-in-depth profile verification when cookie DBs are readable on disk: compare
 * target-exclusive vs sibling-exclusive (domain, name) keys and (domain, name, expires)
 * fingerprints so shared common cookie names (e.g. .google.com/NID) cannot bypass the check.
 */
function verifyCookiesNotFromSiblingProfile(profiles, targetProfileDir, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return true
  const target = profiles.find((p) => p.dir === targetProfileDir)
  if (!target?.cookieDb) return true
  const targetSig = readCookieSignatureFromDb(target.cookieDb)
  if (!targetSig) return true

  const siblingKeys = new Set()
  const siblingFps = new Set()
  for (const sibling of profiles) {
    if (sibling.dir === targetProfileDir || !sibling.cookieDb) continue
    const sig = readCookieSignatureFromDb(sibling.cookieDb)
    if (!sig) continue
    for (const k of sig.keys) siblingKeys.add(k)
    for (const fp of sig.fingerprints) siblingFps.add(fp)
  }
  if (siblingKeys.size === 0 && siblingFps.size === 0) return true

  let hitsSiblingExclusiveKey = 0
  let hitsTargetExclusiveKey = 0
  let hitsSiblingExclusiveFp = 0
  let hitsTargetExclusiveFp = 0
  for (const c of cookies) {
    const key = `${c.domain}\u0000${c.name}`
    const inTargetKey = targetSig.keys.has(key)
    const inSiblingKey = siblingKeys.has(key)
    if (inSiblingKey && !inTargetKey) hitsSiblingExclusiveKey += 1
    else if (inTargetKey && !inSiblingKey) hitsTargetExclusiveKey += 1

    const expSec = (!c.session && typeof c.expires === 'number' && c.expires > 0) ? Math.floor(c.expires) : null
    if (expSec !== null) {
      const fp = `${key}\u0000${expSec}`
      const inTargetFp = targetSig.fingerprints.has(fp)
      const inSiblingFp = siblingFps.has(fp)
      if (inSiblingFp && !inTargetFp) hitsSiblingExclusiveFp += 1
      else if (inTargetFp && !inSiblingFp) hitsTargetExclusiveFp += 1
    }
  }

  if (hitsSiblingExclusiveKey > 0) return false
  if (hitsSiblingExclusiveFp > 0 && hitsTargetExclusiveKey === 0 && hitsTargetExclusiveFp === 0) return false
  return true
}

async function ensureLiveProfileActive(source, userDataDir, profileDir, opts = {}) {
  const { signal, spawnImpl = spawn, focusTimeoutMs = 1_500, focusVerifyMs = 3_000, focusPollMs = 150 } = opts
  throwIfAborted(signal)
  if (!source.exe) {
    // Without the binary we cannot switch the active window: fail closed unless Local State confirms it.
    if (readLastUsedProfile(userDataDir) !== profileDir) throw wrongProfileError(source, profileDir)
    return
  }

  // Always invoke ProcessSingleton handoff when the binary is available: Chrome debounces
  // Local State.last_used on disk (~10s), so a stale disk match cannot guarantee the active window
  // is profileDir. Fail closed on timeout or non-zero exit.
  const focused = await new Promise((resolve, reject) => {
    let settled = false
    const done = (ok, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(ok)
    }
    const onAbort = () => done(false, abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    let child
    try {
      child = spawnImpl(source.exe, [`--user-data-dir=${userDataDir}`, `--profile-directory=${profileDir}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
    } catch {
      return done(false)
    }
    const timer = setTimeout(() => done(false), focusTimeoutMs)
    child.once('error', () => done(false))
    child.once('exit', (code) => done(code === 0))
    child.unref?.()
  })
  if (!focused) throw wrongProfileError(source, profileDir)

  // Confirm Local State actually reflects the chosen profile before attaching CDP.
  const deadline = Date.now() + focusVerifyMs
  while (readLastUsedProfile(userDataDir) !== profileDir) {
    if (Date.now() >= deadline) throw wrongProfileError(source, profileDir)
    await sleepMs(Math.min(focusPollMs, Math.max(1, deadline - Date.now())), signal)
  }
}

/**
 * Harvest cookies (and best-effort open-tab localStorage) from a running Chromium browser
 * with remote debugging enabled (`chrome://inspect/#remote-debugging`).
 */
export async function harvestLiveChromium(source, opts = {}) {
  const { signal } = opts
  throwIfAborted(signal)
  const { userDataDir, profileDir } = resolveSourceLayout(source)
  const activePort = opts.activePort ?? readDevToolsActivePort(userDataDir)
  if (!activePort) {
    const err = new Error('Browser remote debugging is not active')
    err.code = 'devtools-missing'
    throw err
  }
  // Probe port liveness BEFORE trying to focus/spawn the browser, so a stale DevToolsActivePort
  // left behind by a closed browser never launches the browser or locks the Windows clone path.
  const probe = opts.probePort ?? isLoopbackPortOpen
  const portAlive = await probe(activePort.port, { signal })
  if (!portAlive) {
    const err = new Error('Browser remote debugging port is not listening')
    err.code = 'devtools-stale'
    throw err
  }
  // Chrome's single DevToolsActivePort routes Storage.getCookies() to the last-focused profile.
  // Verify or activate the chosen profile before harvesting so another account is never imported.
  let profiles = []
  let multiProfile = false
  if (!opts.skipFocus && profileDir && !source.flat) {
    profiles = await chromiumProfiles(userDataDir)
    multiProfile = profiles.length > 1
    if (multiProfile) {
      await ensureLiveProfileActive(source, userDataDir, profileDir, opts)
    }
  }
  const cdp = await wsCdpConnect(activePort.wsUrl, {
    connectTimeoutMs: opts.connectTimeoutMs ?? LIVE_CONNECT_TIMEOUT_MS,
    WebSocketImpl: opts.WebSocketImpl ?? WebSocket,
    signal,
  })
  try {
    if (multiProfile && readLastUsedProfile(userDataDir) !== profileDir) {
      throw wrongProfileError(source, profileDir)
    }
    const { cookies = [] } = await cdp.send('Storage.getCookies', {}, { timeoutMs: opts.connectTimeoutMs ?? LIVE_CONNECT_TIMEOUT_MS })
    if (multiProfile) {
      if (readLastUsedProfile(userDataDir) !== profileDir) {
        throw wrongProfileError(source, profileDir)
      }
      if (!verifyCookiesNotFromSiblingProfile(profiles, profileDir, cookies)) {
        throw wrongProfileError(source, profileDir)
      }
    }
    const now = opts.now ?? Date.now() / 1000
    const normalized = []
    const skipped = []
    cookies.forEach((raw, index) => {
      const cookie = cdpCookie(raw)
      if (typeof cookie.expires === 'number' && cookie.expires <= now) {
        skipped.push({ where: `entry ${index + 1}`, name: cookie.name, domain: cookie.domain, code: 'expired', reason: 'already expired' })
        return
      }
      normalized.push(cookie)
    })
    let defaultBrowserContextId = null
    if (opts.includeLocalStorage !== false) {
      try {
        const ctxs = await cdp.send('Target.getBrowserContexts', {}, { timeoutMs: 2_000 })
        if (typeof ctxs?.defaultBrowserContextId === 'string' && ctxs.defaultBrowserContextId) {
          defaultBrowserContextId = ctxs.defaultBrowserContextId
        }
      } catch (error) {
        if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
        /* older browsers or stubs without getBrowserContexts */
      }
    }
    const origins = opts.includeLocalStorage === false ? [] : await harvestOpenTabLocalStorage(cdp, defaultBrowserContextId, { signal })
    return { cookies: normalized, origins, skipped }
  } finally {
    // Only close our debugging socket — never Browser.close the user's real browser.
    cdp.close()
  }
}

// ------------------------------------------------------------------ Strategy 2: macOS Keychain + direct SQLite

/** Derive Chromium's macOS AES-128-CBC cookie key from its Keychain Safe Storage password. */
export function deriveMacChromiumKey(password) {
  return pbkdf2Sync(Buffer.from(String(password), 'utf8'), 'saltysalt', 1003, 16, 'sha1')
}

/** Derive Chromium's Linux v10 AES-128-CBC cookie key (1 PBKDF2 iteration, default password "peanuts"). */
export function deriveLinuxChromiumKey(password = 'peanuts') {
  return pbkdf2Sync(Buffer.from(String(password), 'utf8'), 'saltysalt', 1, 16, 'sha1')
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// Chromium 131 ParsedCookie::IsValidCookieValue rejects HttpUtil::IsControlChar (0x00–0x1F, 0x7F) and ';'.
const INVALID_PRE24_COOKIE_VALUE = /[\x00-\x1f;\x7f]/

/** Decrypt a single Chromium v10 cookie blob (enforcing v24+ SHA-256 domain digest and valid UTF-8 cookie bytes). */
export function decryptChromiumV10(encrypted, key, { hostKey = '', stripDomainHash = false } = {}) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted ?? [])
  if (buf.length <= 3 || buf[0] !== 0x76 || buf[1] !== 0x31 || buf[2] !== 0x30) return null
  const iv = Buffer.alloc(16, 0x20)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
  if (stripDomainHash) {
    if (plain.length < 32) return null
    const digest = createHash('sha256').update(String(hostKey), 'utf8').digest()
    if (!plain.subarray(0, 32).equals(digest)) return null
    plain = plain.subarray(32)
  }
  let text
  try {
    text = UTF8_DECODER.decode(plain)
  } catch {
    return null
  }
  // Reject bytes Chromium's cookie value validator forbids, filtering accidental PKCS#7 collisions under a wrong pre-v24 key.
  if (!stripDomainHash && INVALID_PRE24_COOKIE_VALUE.test(text)) return null
  return text
}

const DB_SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' }

function chromiumCookieIdentity(cookie) {
  const domain = String(cookie?.domain ?? '').toLowerCase()
  const name = String(cookie?.name ?? '')
  const path = cookie?.path || '/'
  const secure = cookie?.secure ? '1' : '0'
  const topSite = cookie?.partitionKey?.topLevelSite ? String(cookie.partitionKey.topLevelSite) : ''
  const crossSite = topSite ? (cookie.partitionKey.hasCrossSiteAncestor === false ? '0' : '1') : ''
  const opaque = cookie?.partitionKeyOpaque === true ? '1' : '0'
  return `${domain}\0${name}\0${path}\0${secure}\0${topSite}\0${crossSite}\0${opaque}`
}

function applyAmbiguousFilter(result, ambiguousEntries) {
  if (!ambiguousEntries || ambiguousEntries.length === 0) return result
  const blocked = new Set(ambiguousEntries.map((entry) => entry.key))
  const cookies = (result.cookies ?? []).filter((cookie) => !blocked.has(chromiumCookieIdentity(cookie)))
  const skipped = [...(result.skipped ?? []), ...ambiguousEntries.map((entry) => entry.skipped)]
  return { ...result, cookies, skipped }
}

function decryptWithCandidateKeys(encrypted, keys, opts, { rejectAmbiguous = false } = {}) {
  let matched = null
  let matchedIndex = -1
  let matchCount = 0
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (!key) continue
    try {
      const decrypted = decryptChromiumV10(encrypted, key, opts)
      if (decrypted !== null) {
        if (!rejectAmbiguous) return { value: decrypted, ambiguous: false, keyIndex: i }
        if (matched !== null && matched !== decrypted) {
          return { value: null, ambiguous: true, keyIndex: -1 }
        }
        matched = decrypted
        matchedIndex = i
        matchCount += 1
      }
    } catch { /* try next candidate key */ }
  }
  return { value: matched, ambiguous: false, keyIndex: matchCount === 1 ? matchedIndex : -1 }
}

function readChromiumSqliteCookiesDetailed(dbPath, { key, keys, rejectAmbiguous = false, now = Date.now() / 1000 } = {}) {
  const candidateKeys = Array.isArray(keys) ? keys.filter(Boolean) : (key ? [key] : [])
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (!hasTable(db, 'cookies')) {
      return { cookies: [], origins: [], skipped: [], dbVersion: 0, decryptedCount: 0, decryptFailedCount: 0, ambiguousCount: 0, ambiguousEntries: [], usedKeyCount: 0, unsupportedEncryptionCount: 0 }
    }
    let dbVersion = 0
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get()
      dbVersion = Number(meta?.value) || 0
    } catch { /* older db without meta table */ }
    const stripDomainHash = dbVersion >= 24

    const cols = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((r) => r.name))
    const select = [
      'host_key', 'name', 'value', 'encrypted_value', 'path',
      'is_secure', 'is_httponly', 'expires_utc / 1000000 AS expires_sec',
      cols.has('samesite') ? 'samesite' : '-1 AS samesite',
      cols.has('has_expires') ? 'has_expires' : '1 AS has_expires',
      cols.has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key",
      cols.has('has_cross_site_ancestor') ? 'has_cross_site_ancestor' : '1 AS has_cross_site_ancestor',
    ]
    const rows = db.prepare(`SELECT ${select.join(', ')} FROM cookies`).all()
    const cookies = []
    const skipped = []
    const ambiguousEntries = []
    let decryptedCount = 0
    let decryptFailedCount = 0
    let ambiguousCount = 0
    let unsupportedEncryptionCount = 0
    const usedKeyIndices = new Set()
    rows.forEach((row, index) => {
      const where = `entry ${index + 1}`
      let expires
      if (row.has_expires !== 0 && typeof row.expires_sec === 'number' && row.expires_sec > 0) {
        expires = row.expires_sec - WEBKIT_EPOCH_OFFSET
        if (expires <= now) {
          skipped.push({ where, name: row.name, domain: row.host_key, code: 'expired', reason: 'already expired' })
          return
        }
      }
      const partitionKey = typeof row.top_frame_site_key === 'string' && row.top_frame_site_key
        ? {
            topLevelSite: row.top_frame_site_key,
            hasCrossSiteAncestor: row.has_cross_site_ancestor === null || row.has_cross_site_ancestor === undefined
              ? true
              : Boolean(row.has_cross_site_ancestor),
          }
        : undefined
      let value = typeof row.value === 'string' ? row.value : ''
      const enc = row.encrypted_value ? Buffer.from(row.encrypted_value) : null
      if (enc && enc.length > 0) {
        const prefix = enc.length >= 3 ? enc.subarray(0, 3).toString('latin1') : ''
        if (prefix === 'v20') {
          skipped.push({ where, name: row.name, domain: row.host_key, code: 'app-bound', reason: 'locked by app-bound encryption — only the browser itself can read it' })
          return
        }
        if (prefix === 'v10') {
          if (candidateKeys.length === 0) {
            decryptFailedCount += 1
            skipped.push({ where, name: row.name, domain: row.host_key, code: 'decrypt-failed', reason: 'could not decrypt cookie value' })
            return
          }
          const outcome = decryptWithCandidateKeys(
            enc,
            candidateKeys,
            { hostKey: row.host_key, stripDomainHash },
            { rejectAmbiguous: rejectAmbiguous && !stripDomainHash },
          )
          if (outcome.value === null) {
            decryptFailedCount += 1
            const skipEntry = {
              where,
              name: row.name,
              domain: row.host_key,
              code: 'decrypt-failed',
              reason: outcome.ambiguous ? 'could not determine cookie decryption key unambiguously' : 'could not decrypt cookie value',
            }
            if (outcome.ambiguous) {
              ambiguousCount += 1
              ambiguousEntries.push({
                key: chromiumCookieIdentity({
                  domain: row.host_key,
                  name: row.name,
                  path: row.path || '/',
                  secure: Boolean(row.is_secure),
                  partitionKey,
                }),
                skipped: skipEntry,
              })
            }
            skipped.push(skipEntry)
            return
          }
          value = outcome.value
          decryptedCount += 1
          if (outcome.keyIndex >= 0) usedKeyIndices.add(outcome.keyIndex)
        } else {
          unsupportedEncryptionCount += 1
          skipped.push({ where, name: row.name, domain: row.host_key, code: 'unsupported-encryption', reason: 'unsupported cookie encryption format' })
          return
        }
      }
      const cookie = {
        name: row.name, value, domain: row.host_key, path: row.path || '/',
        secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly),
      }
      const ss = DB_SAMESITE[row.samesite]
      if (ss && (ss !== 'None' || cookie.secure)) cookie.sameSite = ss
      if (expires !== undefined) cookie.expires = expires
      if (partitionKey) cookie.partitionKey = partitionKey
      cookies.push(cookie)
    })
    return {
      cookies,
      origins: [],
      skipped,
      dbVersion,
      decryptedCount,
      decryptFailedCount,
      ambiguousCount,
      ambiguousEntries,
      usedKeyCount: usedKeyIndices.size,
      unsupportedEncryptionCount,
    }
  } finally {
    db.close()
  }
}

/**
 * Pure JS Linux Chromium v10 decryption trying both "peanuts" and empty password.
 * On v24+ stores, the SHA-256 domain digest authenticates each row unambiguously across mixed keys.
 * On pre-v24 stores (no MAC), tests both keys per row so any row that validly decodes to different
 * values under both keys is flagged as ambiguous and skipped rather than guessed (Chromium itself
 * tries "peanuts" first without a MAC, so CDP fallback cannot disambiguate those rows either).
 * Delegates to clone + CDP pipe when source.exe is available and the store has v11/keyring rows,
 * mixed pre-v24 keys, or all non-ambiguous v10 rows failed; reports any detected ambiguous rows via
 * `onAmbiguous` so the caller filters them out of CDP results and keeps their skipped reasons.
 */
export async function harvestLinuxChromiumV10(source, workDir, { signal, now, onAmbiguous } = {}) {
  throwIfAborted(signal)
  const { relCookieDir } = resolveSourceLayout(source)
  const dbName = source.cookieDb ? basename(source.cookieDb) : 'Cookies'
  const clonedDb = join(workDir, relCookieDir, dbName)
  const peanutsKey = deriveLinuxChromiumKey('peanuts')
  const emptyKey = deriveLinuxChromiumKey('')

  const detailed = readChromiumSqliteCookiesDetailed(clonedDb, {
    keys: [peanutsKey, emptyKey],
    rejectAmbiguous: true,
    now,
  })
  if (typeof onAmbiguous === 'function' && detailed.ambiguousEntries.length > 0) {
    onAmbiguous(detailed.ambiguousEntries)
  }
  if (source.exe) {
    const nonAmbiguousFailed = detailed.decryptFailedCount - detailed.ambiguousCount
    if (detailed.unsupportedEncryptionCount > 0) return null
    if (detailed.dbVersion < 24 && detailed.usedKeyCount > 1) return null
    if (nonAmbiguousFailed > 0 && detailed.decryptedCount === 0) return null
  }
  return { cookies: detailed.cookies, origins: detailed.origins, skipped: detailed.skipped }
}

/** Read and decrypt a Chromium Cookies SQLite snapshot using a macOS AES-128-CBC key. */
export function readChromiumSqliteCookies(dbPath, opts = {}) {
  const { cookies, origins, skipped } = readChromiumSqliteCookiesDetailed(dbPath, opts)
  return { cookies, origins, skipped }
}

function readOneMacKeychainPassword(service, { signal, execFileImpl = execFile } = {}) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    execFileImpl('/usr/bin/security', ['find-generic-password', '-w', '-s', service], { encoding: 'utf8', timeout: 60_000, signal }, (err, stdout, stderr) => {
      if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return reject(abortError())
      }
      if (!err) return resolve({ ok: true, password: stdout.replace(/\r?\n$/, '') })
      const msg = `${stderr ?? ''} ${err.message ?? ''}`
      // macOS Keychain denial: exit 128 or errSecUserCanceled (-128) / errSecAuthFailed (-25293) / interaction denied
      if (err.code === 128 || /denied|canceled|cancelled|not allowed|-128|-25293/i.test(msg)) {
        return resolve({ ok: false, denied: true })
      }
      resolve({ ok: false, denied: false })
    })
  })
}

export async function harvestMacChromium(source, workDir, { signal, readPassword, now } = {}) {
  throwIfAborted(signal)
  const { relCookieDir } = resolveSourceLayout(source)
  const dbName = source.cookieDb ? basename(source.cookieDb) : 'Cookies'
  const clonedDb = join(workDir, relCookieDir, dbName)
  const services = Array.isArray(source.keychainServices) ? source.keychainServices : [source.keychainServices].filter(Boolean)
  for (const service of services) {
    throwIfAborted(signal)
    let password = null
    if (typeof readPassword === 'function') {
      password = await readPassword(service, { signal })
    } else {
      const outcome = await readOneMacKeychainPassword(service, { signal })
      if (outcome.denied) {
        const err = new Error('Keychain access was denied.')
        err.code = 'keychain-denied'
        throw err
      }
      if (outcome.ok) password = outcome.password
    }
    if (password === null || password === undefined) continue
    const key = deriveMacChromiumKey(password)
    const detailed = readChromiumSqliteCookiesDetailed(clonedDb, { key, now })
    // If every encrypted cookie failed to decrypt (0 decrypted), the Keychain password does not
    // match this store — do not return an empty success that masks decryption failure.
    if (detailed.decryptFailedCount > 0 && detailed.decryptedCount === 0) continue
    return { cookies: detailed.cookies, origins: detailed.origins, skipped: detailed.skipped }
  }
  return null
}

// ------------------------------------------------------------------ Strategy 3: Clone + CDP pipe self-decrypt

const QUIET_ARGS = [
  '--headless', '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-breakpad',
]

/** Minimal pipe CDP: commands on fd 3, events on fd 4, JSON + NUL. */
function pipeConnection(child) {
  const writer = child.stdio[3]
  const reader = child.stdio[4]
  const pending = new Map()
  let nextId = 1
  let chunks = []
  reader.on('data', (buf) => {
    let start = 0
    for (;;) {
      const end = buf.indexOf(0, start)
      if (end === -1) { if (start < buf.length) chunks.push(buf.subarray(start)); break }
      chunks.push(buf.subarray(start, end))
      const text = Buffer.concat(chunks).toString('utf8')
      chunks = []
      start = end + 1
      if (!text) continue
      let msg
      try { msg = JSON.parse(text) } catch { continue }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; p.reject(e) }
        else p.resolve(msg.result)
      }
    }
  })
  const die = (reason) => {
    for (const p of pending.values()) { const e = new Error(`CDP pipe closed (${reason})`); e.code = 'PIPE_CLOSED'; p.reject(e) }
    pending.clear()
  }
  reader.on('error', (err) => die(err?.message ?? 'pipe read error'))
  writer.on('error', (err) => die(err?.message ?? 'pipe write error'))
  reader.on('close', () => die('pipe close'))
  child.once('exit', (code) => die(`exit ${code}`))
  return {
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        // Chrome's pipe transport frames messages with a trailing NUL.
        try {
          writer.write(`${JSON.stringify({ id, method, params })}\0`)
        } catch (err) {
          pending.delete(id)
          reject(err)
        }
      })
    },
  }
}

/** Build the command-line flags for harvesting a cloned Chromium user-data-dir. */
export function chromiumCloneArgs(source, workDir) {
  const { profileDir } = resolveSourceLayout(source)
  const args = ['--remote-debugging-pipe', `--user-data-dir=${workDir}`, ...QUIET_ARGS]
  if (profileDir) args.push(`--profile-directory=${profileDir}`)
  args.push('about:blank')
  return args
}

/** Harvest a Chromium clone: the source's own exe decrypts its cookies for us. */
async function harvestChromium(source, workDir, { signal } = {}) {
  throwIfAborted(signal)
  if (!source.exe) throw new Error(`${source.name ?? 'This browser'} executable was not found`)
  const child = spawn(source.exe, chromiumCloneArgs(source, workDir),
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const browser = pipeConnection(child)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    throwIfAborted(signal)
    const { cookies } = await withTimeout(browser.send('Storage.getCookies'), 20_000, 'Storage.getCookies', signal)
    return cookies.map(cdpCookie)
  } finally {
    browser.send('Browser.close').catch(() => {})
    const done = await Promise.race([exited, sleepMs(3000).then(() => 'timeout')])
    if (done === 'timeout') { try { child.kill('SIGKILL') } catch { /* gone */ } await Promise.race([exited, sleepMs(5000)]) }
  }
}

function cdpCookie(c) {
  const cookie = {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
  }
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || (c.sameSite === 'None' && cookie.secure)) cookie.sameSite = c.sameSite
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) cookie.expires = c.expires
  if (c.partitionKey && typeof c.partitionKey === 'object' && typeof c.partitionKey.topLevelSite === 'string' && c.partitionKey.topLevelSite) {
    cookie.partitionKey = { topLevelSite: c.partitionKey.topLevelSite, hasCrossSiteAncestor: Boolean(c.partitionKey.hasCrossSiteAncestor) }
  } else if (typeof c.partitionKey === 'string' && c.partitionKey) {
    cookie.partitionKey = { topLevelSite: c.partitionKey, hasCrossSiteAncestor: true }
  }
  if (c.partitionKeyOpaque === true) cookie.partitionKeyOpaque = true
  return cookie
}

// ------------------------------------------------------------------ Strategy 4: Firefox & Zen

// Mozilla nsICookie SameSite enum: 0=NONE, 1=LAX, 2=STRICT, 3=UNSET.
const FIREFOX_SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' }

function parseOriginAttributes(suffix) {
  const body = suffix.startsWith('^') ? suffix.slice(1) : suffix
  const attrs = new Map()
  for (const pair of body.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq === -1) attrs.set(pair, '')
    else attrs.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return attrs
}

/** Read cookies from a Firefox / Zen cookies.sqlite snapshot, adapting to schema 15+ (no rawSameSite) and 16+ (ms expiry). */
export function readFirefoxSqliteCookies(dbPath, { now = Date.now() / 1000 } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (!hasTable(db, 'moz_cookies')) return { cookies: [], origins: [], skipped: [] }
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0
    const cols = new Set(db.prepare('PRAGMA table_info(moz_cookies)').all().map((r) => r.name))
    const hasRawSameSite = cols.has('rawSameSite')
    const select = [
      'host', 'name', 'value', 'path',
      cols.has('isHttpOnly') ? 'isHttpOnly' : '0 AS isHttpOnly',
      cols.has('isSecure') ? 'isSecure' : '0 AS isSecure',
      cols.has('expiry') ? 'expiry' : 'NULL AS expiry',
      cols.has('sameSite') ? 'sameSite' : 'NULL AS sameSite',
      hasRawSameSite ? 'rawSameSite' : 'NULL AS rawSameSite',
      cols.has('originAttributes') ? 'originAttributes' : "'' AS originAttributes",
    ]
    const rows = db.prepare(`SELECT ${select.join(', ')} FROM moz_cookies`).all()
    const cookies = []
    const skipped = []
    rows.forEach((row, index) => {
      const where = `entry ${index + 1}`
      let expires
      if (typeof row.expiry === 'number' && Number.isFinite(row.expiry) && row.expiry > 0) {
        // Firefox schema 16+ stores expiry in milliseconds instead of seconds.
        const expirySec = (schemaVersion >= 16 || row.expiry >= 1e11) ? row.expiry / 1000 : row.expiry
        if (expirySec <= now) {
          skipped.push({ where, name: row.name, domain: row.host, code: 'expired', reason: 'already expired' })
          return
        }
        expires = expirySec
      }
      if (typeof row.originAttributes === 'string' && row.originAttributes !== '') {
        const attrs = parseOriginAttributes(row.originAttributes)
        const hasPartition = attrs.has('partitionKey')
        const hasUserContext = attrs.has('userContextId') && attrs.get('userContextId') !== '0'
        skipped.push(hasPartition && !hasUserContext
          ? { where, name: row.name, domain: row.host, code: 'partitioned', reason: 'partitioned cookie (cannot keep third-party isolation when imported)' }
          : { where, name: row.name, domain: row.host, code: 'container', reason: `a Firefox container cookie (${row.originAttributes}); importing it flat would mix it into the default context` })
        return
      }
      // In Gecko schema <= 14 with laxByDefault, an omitted SameSite attribute was stored as
      // sameSite=1 (Lax) with rawSameSite=0; schema 15 migration maps that back to UNSET.
      const isLegacyUnset = hasRawSameSite && row.sameSite === 1 && row.rawSameSite === 0
      const rawSs = isLegacyUnset ? 3 : (row.sameSite ?? row.rawSameSite)
      const ss = FIREFOX_SAMESITE[rawSs]
      const cookie = {
        name: row.name,
        value: row.value ?? '',
        domain: row.host,
        path: row.path || '/',
        secure: Boolean(row.isSecure),
        httpOnly: Boolean(row.isHttpOnly),
      }
      if (expires !== undefined) cookie.expires = expires
      if (ss && (ss !== 'None' || cookie.secure)) cookie.sameSite = ss
      cookies.push(cookie)
    })
    return { cookies, origins: [], skipped }
  } finally {
    db.close()
  }
}

/** Firefox / Zen: cookies.sqlite is plain — read the snapshotted db directly. */
function harvestFirefox(workDir, now = Date.now() / 1000) {
  return readFirefoxSqliteCookies(join(workDir, 'cookies.sqlite'), { now })
}

function withTimeout(p, ms, label, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => done(reject, abortError())
    const timer = setTimeout(() => done(reject, new Error(`${label} timed out`)), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    p.then((v) => done(resolve, v), (e) => done(reject, e))
  })
}

function sleepMs(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Rows a Chromium clone can never have its browser decrypt: app-bound (v20) values only
 * decrypt inside the real profile — launched on a copy, the browser gets a temporary key
 * error and drops them silently. Names and domains stay plain text; only the value is locked.
 * → { locked: skipped entries, readable } or null when unreadable.
 */
export function appBoundRows(dbPath) {
  let db
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return null }
  try {
    if (!hasTable(db, 'cookies')) return { locked: [], readable: 0 }
    const rows = db.prepare('SELECT name, host_key AS domain, hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies').all()
    const locked = []
    let readable = 0
    rows.forEach((row, index) => {
      if (row.prefix === '763230') {
        locked.push({ where: `entry ${index + 1}`, name: row.name, domain: row.domain, code: 'app-bound', reason: 'locked by app-bound encryption — only the browser itself can read it' })
      } else readable += 1
    })
    return { locked, readable }
  } finally { db.close() }
}

async function harvestCloned(source, workDir, { signal } = {}) {
  throwIfAborted(signal)
  if (source.engine === 'firefox') return harvestFirefox(workDir)
  const { relCookieDir } = resolveSourceLayout(source)
  const dbName = source.cookieDb ? basename(source.cookieDb) : 'Cookies'
  const census = appBoundRows(join(workDir, relCookieDir, dbName))
  if (census && census.readable === 0 && census.locked.length > 0) {
    const error = new Error(`${census.locked.length} cookies locked by app-bound encryption`)
    error.code = 'app-bound'
    error.lockedCount = census.locked.length
    throw error
  }
  return { cookies: await harvestChromium(source, workDir, { signal }), origins: [], skipped: census?.locked ?? [] }
}

/**
 * Cookies from one cloned source profile. → { cookies, origins, skipped }.
 * Throws {code:'locked'} when the source holds its store open (Windows), and
 * {code:'app-bound'} when every row is app-bound encrypted — there is nothing to harvest.
 */
export async function harvestCookies(source, workDir, opts = {}) {
  await cloneCookieStore(source, workDir)
  return harvestCloned(source, workDir, opts)
}

/**
 * The whole live import:
 *   0. macOS Safari native Cookies.binarycookies (surfaces Full Disk Access guidance on EPERM)
 *   1. Live DevToolsActivePort CDP (if enabled in the running Chromium browser — works on Windows v20!)
 *   2. macOS direct Keychain + SQLite decryption (no browser launch or close)
 *   3. Linux pure-JS v10 ("peanuts") decryption before falling back to browser pipe
 *   4. Windows pre-check for App-Bound Encryption before ever asking to close the browser
 *   5. Snapshot → (close & relaunch on Windows when needed for non-v20/Firefox) → harvest
 */
function browserLockedError() {
  const err = new Error('This browser cookie database is locked; quit the browser and try again.')
  err.code = 'browser-locked'
  return err
}

export async function importFromBrowser(source, { close = false, platformOverride, liveHarvester, macHarvester, linuxHarvester, safariHarvester, cloneHarvester, cloner = cloneCookieStore, browserCloser = closeBrowser, browserRelauncher = relaunchBrowser, signal } = {}) {
  throwIfAborted(signal)
  const currentPlatform = platformOverride ?? platform()

  // 0. macOS Safari: native Cookies.binarycookies parser, no browser close needed.
  if (source.engine === 'safari') {
    try {
      const result = await (safariHarvester ?? harvestSafari)(source, { signal })
      return { running: false, restarted: false, method: 'safari-binarycookies', result }
    } catch (error) {
      if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
      if (error?.code === 'safari-permission') {
        return {
          running: false,
          restarted: false,
          needsFullDiskAccess: true,
          browserName: source.name,
          label: source.label,
          kind: source.kind,
        }
      }
      throw error
    }
  }

  const { userDataDir } = resolveSourceLayout(source)

  // 1. Live remote-debugging connection (zero restart, decrypts Windows v20 natively).
  if (source.engine === 'chromium' && readDevToolsActivePort(userDataDir)) {
    try {
      const result = await (liveHarvester ?? harvestLiveChromium)(source, { signal })
      return { running: false, restarted: false, method: 'live-cdp', result }
    } catch (error) {
      if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
      if (error?.code === 'devtools-denied' || error?.code === 'devtools-timeout') throw error
      if (error?.code === 'devtools-wrong-profile' && currentPlatform === 'win32' && hasAppBoundKey(userDataDir)) throw error
      // devtools-stale / devtools-missing / non-ABE profile mismatch: fall through to profile-isolated local strategies.
    }
  }

  throwIfAborted(signal)
  const work = await cloneWorkDir()
  let closed = false
  let cookieDbCloned = false
  try {
    // 2. macOS direct Keychain decryption (never closes or launches the browser).
    if (source.engine === 'chromium' && currentPlatform === 'darwin' && (source.keychainServices?.length ?? 0) > 0) {
      try {
        await cloner(source, work.dir, { needLocalState: false })
        cookieDbCloned = true
      } catch (error) {
        if (error?.code === 'locked') throw browserLockedError()
        throw error
      }
      throwIfAborted(signal)
      const macResult = await (macHarvester ?? harvestMacChromium)(source, work.dir, { signal })
      throwIfAborted(signal)
      if (macResult !== null) {
        return { running: false, restarted: false, method: 'keychain', result: macResult }
      }
      // Keychain item absent or wrong password: fall through to clone + binary if available.
      if (!source.exe) {
        const err = new Error('Could not find the browser encryption key in macOS Keychain.')
        err.code = 'keychain-missing'
        throw err
      }
    }

    // 3. Linux pure-JS v10 decryption ("peanuts" / empty password) without launching Chromium.
    let linuxAmbiguous = []
    if (source.engine === 'chromium' && currentPlatform === 'linux') {
      try {
        await cloner(source, work.dir, { needLocalState: false })
        cookieDbCloned = true
      } catch (error) {
        if (error?.code === 'locked') throw browserLockedError()
        throw error
      }
      throwIfAborted(signal)
      const linuxResult = await (linuxHarvester ?? harvestLinuxChromiumV10)(source, work.dir, {
        signal,
        onAmbiguous: (entries) => { linuxAmbiguous = entries },
      })
      throwIfAborted(signal)
      if (linuxResult !== null) {
        return { running: false, restarted: false, method: 'linux-v10', result: linuxResult }
      }
    }

    throwIfAborted(signal)
    // 4. Snapshot store (reusing the SQLite snapshot from step 2/3 so ambiguity detection and CDP
    //    always read the exact same immutable database state; only copies Local State on fallback).
    try {
      await (cookieDbCloned ? cloner(source, work.dir, { needLocalState: true, skipCookieDb: true }) : cloner(source, work.dir))
    } catch (error) {
      if (error?.code !== 'locked') throw error
      if (currentPlatform !== 'win32') throw browserLockedError()
      if (source.engine === 'chromium' && hasAppBoundKey(userDataDir)) {
        return {
          running: true,
          needsRemoteDebugging: true,
          inspectUrl: source.inspectUrl ?? 'chrome://inspect/#remote-debugging',
          browserName: source.name,
          label: source.label,
          kind: source.kind,
        }
      }
      if (!close) return { running: true }
      const pids = await browserCloser(source.exe, source, {
        signal,
        onClosing: () => { closed = true },
      })
      if (pids.length > 0) closed = true
      throwIfAborted(signal)
      await cloner(source, work.dir) // still locked → throws 'locked' again
    }

    throwIfAborted(signal)
    // 4. Harvest from the clone; turn Windows all-v20 into guided remote-debugging setup.
    try {
      const rawResult = await (cloneHarvester ?? harvestCloned)(source, work.dir, { signal })
      const result = linuxAmbiguous.length > 0 ? applyAmbiguousFilter(rawResult, linuxAmbiguous) : rawResult
      return { running: false, restarted: closed, method: source.engine === 'firefox' ? 'firefox-sqlite' : 'clone-cdp', result }
    } catch (error) {
      if (error?.code === 'import-cancelled' || signal?.aborted) throw abortError()
      if (error?.code === 'app-bound') {
        return {
          running: false,
          restarted: closed,
          needsRemoteDebugging: true,
          inspectUrl: source.inspectUrl ?? 'chrome://inspect/#remote-debugging',
          browserName: source.name,
          label: source.label,
          kind: source.kind,
          lockedCount: error.lockedCount ?? 0,
        }
      }
      throw error
    }
  } finally {
    if (closed) browserRelauncher(source.exe, source.kind)
    await work.remove().catch(() => {})
  }
}

// ------------------------------------------------------------------ closing a running source (Windows)

const powershell = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr?.trim() || err.message))
    else resolve(stdout)
  })
})

/** Processes (pid + command line) of one exe, Windows only. */
export async function browserProcesses(exe) {
  const name = basename(exe)
  const out = await powershell(
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`)
  if (!out.trim()) return []
  const rows = JSON.parse(out)
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, commandLine: r.CommandLine ?? '' }))
}

const userDataDirOf = (commandLine) => {
  const m = String(commandLine).match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i)
  return m ? (m[1] ?? m[2]) : null
}

/**
 * Does this process hold the lock on the profile's user-data root? A Chromium instance binds
 * one user-data-dir: none given = the default root, which is where our sources live.
 */
export function locksProfile(process, source) {
  const dir = userDataDirOf(process.commandLine)
  if (dir === null) return true // standard invocation binds the standard root
  const norm = (p) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  const root = source.userDataDir ?? (source.flat ? source.profilePath : win32.dirname(source.profilePath))
  return norm(dir) === norm(root)
}

/** Ask a running source browser to quit (graceful; its session comes back on relaunch). */
export async function closeBrowser(exe, source, { signal, onClosing, platformOverride, listProcesses = browserProcesses, killPid, pollMs = 500 } = {}) {
  if ((platformOverride ?? platform()) !== 'win32') return []
  throwIfAborted(signal)
  const targets = (await listProcesses(exe)).filter((p) => locksProfile(p, source))
  if (!targets.length) return []
  // Only cancel before issuing the first taskkill; once we begin closing the user's browser,
  // finish waiting for its exit so the caller's finally block always relaunches it cleanly.
  throwIfAborted(signal)
  onClosing?.()
  const doKill = killPid ?? ((pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid)], { windowsHide: true }, () => resolve())))
  for (const p of targets) {
    await doKill(p.pid)
  }
  const deadline = Date.now() + 20_000
  for (;;) {
    const alive = (await listProcesses(exe)).filter((p) => targets.some((t) => t.pid === p.pid))
    if (!alive.length) return targets.map((t) => t.pid)
    if (Date.now() > deadline) { const e = new Error('the source browser did not close'); e.code = 'still-running'; throw e }
    await sleepMs(pollMs)
  }
}

/** Reopen a browser we closed, with its previous session. */
export function relaunchBrowser(exe, kind) {
  const args = kind === 'firefox' || kind === 'zen' ? [] : ['--restore-last-session']
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/** Launch or focus a Chromium browser binary so the user can toggle remote debugging. */
export function launchBrowserForDebug(source) {
  if (!source?.exe) return false
  const args = source.profileDir ? [`--profile-directory=${source.profileDir}`] : []
  try {
    const child = spawn(source.exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}
