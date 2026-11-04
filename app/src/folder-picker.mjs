// The app's own folder and file picker, in place of the system's: the file system side. The page
// only draws what these return (preload.cjs showPicker), and every path that it sends back is
// checked here again. Errors are answers, never throws: the page shows them in place.
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'

// A folder with more entries than this lists the first ones and says so.
export const LIST_MAX = 2000
// A network drive that is gone can keep a check waiting for many seconds; it is listed instead,
// and opening it says what is wrong.
const DRIVE_WAIT_MS = 300
const KNOWN = ['home', 'desktop', 'documents', 'downloads']
const WINDOWS_BAD = /[<>:"/\\|?*]/u
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu

const within = (promise, ms, late) => Promise.race([promise, new Promise((done) => { setTimeout(() => { done(late) }, ms).unref?.() })])
const reachable = path => access(path).then(() => true, () => false)

/**
 * Where the picker's side column starts: the known folders that exist, and the drives (Windows)
 * or the root and the mounted volumes (macOS, Linux).
 * @param {{ getPath: (name: string) => string, platform?: string, home?: string }} options
 */
export async function roots({ getPath, platform = process.platform, home = homedir() }) {
  const places = []
  for (const key of KNOWN) {
    let path
    try { path = key === 'home' ? (getPath('home') || home) : getPath(key) } catch { continue }
    if (path && !places.some(place => place.path === path) && await reachable(path)) places.push({ key, path })
  }
  return { places, drives: await drives(platform) }
}

async function drives(platform) {
  if (platform === 'win32') {
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`)
    const found = await Promise.all(letters.map(path => within(reachable(path), DRIVE_WAIT_MS, true)))
    return letters.filter((_path, index) => found[index]).map(path => ({ path, label: path.slice(0, 2) }))
  }
  const mounts = platform === 'darwin' ? ['/Volumes'] : [`/media/${user()}`, `/run/media/${user()}`, '/mnt']
  const volumes = [{ path: '/', label: '/' }]
  for (const folder of mounts) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name)
      // macOS lists the start disk again under /Volumes, as a link to /.
      if (entry.isSymbolicLink() && platform === 'darwin') continue
      if (entry.isDirectory()) volumes.push({ path, label: entry.name })
    }
  }
  return volumes
}

function user() {
  try { return basename(homedir()) } catch { return '' }
}

/** The steps from the path's root down to it, for the breadcrumb. */
export function crumbs(path) {
  const { root } = parse(path)
  const steps = [{ name: root.replace(/[\\/]+$/u, '') || root, path: root }]
  let at = root
  for (const part of path.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    at = join(at, part)
    steps.push({ name: part, path: at })
  }
  return steps
}

/** A path that the user typed: `~` is the home folder, a relative one starts at `from`. */
export function typed(text, from, home = homedir()) {
  const value = String(text).trim().replace(/^["']|["']$/gu, '')
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(1))
  return isAbsolute(value) ? resolve(value) : resolve(from, value)
}

/** What went wrong with a path, as the page names it. */
export async function problemOf(error, path) {
  switch (error?.code) {
    case 'ENOENT': return await reachable(parse(path).root) ? 'missing' : 'drive'
    case 'EACCES': case 'EPERM': return 'denied'
    case 'ENOTDIR': return 'notFolder'
    case 'ENAMETOOLONG': return 'tooLong'
    case 'ENODEV': case 'ENXIO': case 'EIO': case 'UNKNOWN': return 'drive'
    default: return 'unreadable'
  }
}

/**
 * One folder's entries, folders first, each sorted the way people read them. Hidden entries
 * (a leading dot, Windows' `$` system folders) are left out.
 * @param {string} path
 * @param {{ files?: boolean, extensions?: string[] }} [options] `files` lists the files too;
 *   `extensions` (without the dot) keeps only those.
 */
export async function list(path, { files = false, extensions } = {}) {
  const folder = resolve(path)
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    return { path: folder, error: await problemOf(error, folder) }
  }
  const wanted = extensions?.length ? new Set(extensions.map(ext => `.${ext.toLowerCase()}`)) : undefined
  const rows = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('$') || entry.name === 'System Volume Information') continue
    const full = join(folder, entry.name)
    let dir = entry.isDirectory()
    // A link or a junction is what it points to; a broken one is left out.
    if (entry.isSymbolicLink()) {
      try { dir = (await stat(full)).isDirectory() } catch { continue }
    } else if (!dir && !entry.isFile()) continue
    if (!dir && (!files || (wanted !== undefined && !wanted.has(extname(entry.name).toLowerCase())))) continue
    rows.push({ name: entry.name, path: full, dir })
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  rows.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
  return { path: folder, crumbs: crumbs(folder), parent: dirname(folder) === folder ? undefined : dirname(folder), entries: rows.slice(0, LIST_MAX), ...(rows.length > LIST_MAX ? { more: rows.length } : {}) }
}

/** Whether `name` can be one file or folder name here. */
export function nameOk(name, platform = process.platform) {
  if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || name.length > 255) return false
  if (name.includes('/') || name.includes('\0')) return false
  if (platform === 'win32') return !WINDOWS_BAD.test(name) && ![...name].some(char => char.charCodeAt(0) < 32) && !WINDOWS_RESERVED.test(name) && !/[ .]$/u.test(name)
  return true
}

/**
 * A new folder in `parent`.
 * @returns {Promise<{ path: string } | { error: string }>}
 */
export async function makeFolder(parent, name, platform = process.platform) {
  if (!nameOk(name, platform)) return { error: 'name' }
  const path = join(resolve(parent), name)
  try {
    await mkdir(path)
    return { path }
  } catch (error) {
    if (error?.code === 'EEXIST') return { error: 'exists' }
    return { error: await problemOf(error, path) }
  }
}

/**
 * Where a save goes: a valid name in a folder that exists. `exists` says that a file of that name
 * is there already, which the page asks about before it replaces it.
 * @returns {Promise<{ path: string, exists?: true } | { error: string }>}
 */
export async function saveTarget(folder, name, platform = process.platform) {
  if (!nameOk(name, platform)) return { error: 'name' }
  const into = resolve(folder)
  try {
    if (!(await stat(into)).isDirectory()) return { error: 'notFolder' }
  } catch (error) {
    return { error: await problemOf(error, into) }
  }
  const path = join(into, name)
  try {
    const found = await stat(path)
    return found.isDirectory() ? { error: 'isFolder' } : { path, exists: true }
  } catch (error) {
    return error?.code === 'ENOENT' ? { path } : { error: await problemOf(error, path) }
  }
}

/** A path that the picker can choose: a folder (`folder` mode) or a file (`file` mode). */
export async function chosen(path, mode) {
  const target = resolve(path)
  try {
    const found = await stat(target)
    if (mode === 'folder' && !found.isDirectory()) return { error: 'notFolder' }
    if (mode === 'file' && !found.isFile()) return { error: 'notFile' }
    return { path: target }
  } catch (error) {
    return { error: await problemOf(error, target) }
  }
}

/** The folder a picker opens in: `from`, or the nearest folder above it that exists. */
export async function startIn(from, home = homedir()) {
  let at = typeof from === 'string' && from !== '' ? resolve(from) : home
  for (;;) {
    try {
      if ((await stat(at)).isDirectory()) return at
    } catch {}
    const up = dirname(at)
    if (up === at) return home
    at = up
  }
}
