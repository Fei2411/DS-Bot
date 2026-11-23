// macOS Safari cookie store discovery and Cookies.binarycookies parser.
// Pure JS, zero native dependencies, reads the cookie store without quitting Safari.
//
// Apple's Cookies.binarycookies layout:
//   Header (big-endian): 'cook' (4B) + pageCount (u32BE) + pageSizes[pageCount] (u32BE each)
//   Page (little-endian): 0x00000100 (4B BE) + cookieCount (u32LE) + offsets[cookieCount] (u32LE) + 0x00000000 (4B)
//   Cookie record (little-endian, relative to record start):
//     +0  size (u32LE)
//     +4  version (u32LE)
//     +8  flags (u32LE): 0x01 Secure, 0x04 HttpOnly
//     +12 hasPort / reserved (u32LE)
//     +16 domainOffset (u32LE)
//     +20 nameOffset (u32LE)
//     +24 pathOffset (u32LE)
//     +28 valueOffset (u32LE)
//     +32 commentOffset / reserved (u64LE)
//     +40 expiry (f64LE, seconds since 2001-01-01T00:00:00Z)
//     +48 creation (f64LE, seconds since 2001-01-01T00:00:00Z)
import { existsSync } from 'node:fs'
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SAFARI_FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

const MAC_EPOCH_OFFSET = 978307200 // seconds between 1970-01-01 and 2001-01-01
const MAGIC = 'cook'
const PAGE_HEADER_BE = 0x00000100
const COOKIE_HEADER_BYTES = 56
const FLAG_SECURE = 0x01
const FLAG_HTTP_ONLY = 0x04
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SAFARI_APPS = [
  '/Applications/Safari.app',
  '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app',
]

function isPermissionError(error) {
  return error?.code === 'EPERM' || error?.code === 'EACCES'
}

function safariCorruptError(message) {
  const err = new Error(message)
  err.code = 'safari-corrupt'
  return err
}

function safariPermissionError() {
  const err = new Error('Full Disk Access is required to read Safari cookies.')
  err.code = 'safari-permission'
  return err
}

export function safariContainerLibrary(home = homedir()) {
  return join(home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library')
}

async function probeFile(filePath) {
  let fh
  try {
    fh = await open(filePath, 'r')
    return 'readable'
  } catch (error) {
    if (isPermissionError(error)) return 'permission'
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing'
    return 'unreadable'
  } finally {
    await fh?.close().catch(() => {})
  }
}

async function probeDir(dirPath) {
  try {
    await readdir(dirPath)
    return 'readable'
  } catch (error) {
    if (isPermissionError(error)) return 'permission'
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing'
    return 'unreadable'
  }
}

/**
 * Inspect whether DS Bot can read Safari's cookie store on macOS.
 * Distinguishes TCC permission denial (EPERM/EACCES) from an absent store (ENOENT),
 * because existsSync() swallows EPERM and would wrongly hide Safari.
 * Also recognizes Safari installations that only have named-profile cookie stores
 * (WebKit/WebsiteDataStore/<UUID> or Safari/Profiles/<UUID>) without a default store.
 */
export async function checkSafariAccess({ home = homedir(), containerLib = safariContainerLibrary(home), appPaths = SAFARI_APPS } = {}) {
  const containerCookie = join(containerLib, 'Cookies', 'Cookies.binarycookies')
  const legacyCookie = join(home, 'Library', 'Cookies', 'Cookies.binarycookies')

  const containerStatus = await probeFile(containerCookie)
  if (containerStatus === 'readable') {
    return { accessible: true, needsPermission: false, cookieFile: containerCookie }
  }
  if (containerStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }

  // Container directories can throw EPERM before reaching Cookies.binarycookies.
  const cookiesDirStatus = await probeDir(join(containerLib, 'Cookies'))
  if (cookiesDirStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }
  const websiteDataStatus = await probeDir(join(containerLib, 'WebKit', 'WebsiteDataStore'))
  if (websiteDataStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }
  const profilesDirStatus = await probeDir(join(containerLib, 'Safari', 'Profiles'))
  if (profilesDirStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }
  const containerRootStatus = await probeDir(dirname(dirname(containerLib)))
  if (containerRootStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }

  const legacyStatus = await probeFile(legacyCookie)
  if (legacyStatus === 'readable') {
    return { accessible: true, needsPermission: false, cookieFile: legacyCookie }
  }
  if (legacyStatus === 'permission') {
    return { accessible: false, needsPermission: true, cookieFile: null }
  }

  // Container is readable without TCC denial: check if any named Safari profile has cookies.
  const uuids = await scanProfileUuids(containerLib)
  for (const uuid of uuids) {
    const namedFile = await findSafariProfileCookieFile(containerLib, uuid)
    if (namedFile) {
      return { accessible: true, needsPermission: false, cookieFile: null, hasNamedProfiles: true }
    }
  }

  const containerReadable = cookiesDirStatus === 'readable' || websiteDataStatus === 'readable' || profilesDirStatus === 'readable'
  return {
    accessible: false,
    containerReadable,
    needsPermission: false,
    cookieFile: null,
    installed: appPaths.some((p) => existsSync(p)),
  }
}

function readStrictCString(buf, base, relOffset, limit) {
  if (relOffset < COOKIE_HEADER_BYTES || base + relOffset >= limit) return null
  const start = base + relOffset
  let end = start
  while (end < limit && buf[end] !== 0) end += 1
  if (end >= limit) return null // missing NUL terminator inside record bounds
  return buf.subarray(start, end).toString('utf8')
}

/** Parse an Apple Cookies.binarycookies buffer into normalized cookies + skipped entries. */
export function parseBinaryCookies(input, { now = Date.now() / 1000 } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])
  if (buf.length === 0) return { cookies: [], origins: [], skipped: [] }
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw safariCorruptError('Invalid Safari Cookies.binarycookies header')
  }

  const pageCount = buf.readUInt32BE(4)
  const headerBytes = 8 + pageCount * 4
  if (headerBytes > buf.length) {
    throw safariCorruptError('Truncated Safari Cookies.binarycookies page table')
  }

  const pageSizes = []
  let totalPageBytes = 0
  for (let i = 0; i < pageCount; i += 1) {
    const size = buf.readUInt32BE(8 + i * 4)
    pageSizes.push(size)
    totalPageBytes += size
  }
  if (headerBytes + totalPageBytes > buf.length) {
    throw safariCorruptError('Truncated Safari Cookies.binarycookies page payload')
  }

  const cookies = []
  const skipped = []
  let entryIndex = 0
  let pageOffset = headerBytes

  for (let p = 0; p < pageCount; p += 1) {
    const pageSize = pageSizes[p]
    const pageEnd = pageOffset + pageSize
    if (pageSize < 12) {
      pageOffset = pageEnd
      continue
    }
    if (buf.readUInt32BE(pageOffset) !== PAGE_HEADER_BE) {
      throw safariCorruptError(`Invalid Safari cookie page header at page ${p}`)
    }
    const cookieCount = buf.readUInt32LE(pageOffset + 4)
    if (8 + cookieCount * 4 > pageSize) {
      throw safariCorruptError(`Truncated Safari cookie offset table at page ${p}`)
    }

    for (let j = 0; j < cookieCount; j += 1) {
      entryIndex += 1
      const where = `entry ${entryIndex}`
      const relOffset = buf.readUInt32LE(pageOffset + 8 + j * 4)
      const cOff = pageOffset + relOffset
      if (cOff < pageOffset || cOff + COOKIE_HEADER_BYTES > pageEnd) {
        skipped.push({ where, name: null, domain: null, code: 'corrupt', reason: 'corrupted Safari cookie record' })
        continue
      }
      const recordSize = buf.readUInt32LE(cOff)
      if (recordSize < COOKIE_HEADER_BYTES || cOff + recordSize > pageEnd) {
        skipped.push({ where, name: null, domain: null, code: 'corrupt', reason: 'corrupted Safari cookie record' })
        continue
      }
      const recordEnd = cOff + recordSize

      const flags = buf.readUInt32LE(cOff + 8)
      const domainOff = buf.readUInt32LE(cOff + 16)
      const nameOff = buf.readUInt32LE(cOff + 20)
      const pathOff = buf.readUInt32LE(cOff + 24)
      const valueOff = buf.readUInt32LE(cOff + 28)

      const rawDomain = readStrictCString(buf, cOff, domainOff, recordEnd)
      const name = readStrictCString(buf, cOff, nameOff, recordEnd)
      const rawPath = readStrictCString(buf, cOff, pathOff, recordEnd)
      const value = readStrictCString(buf, cOff, valueOff, recordEnd)
      const domain = rawDomain === null ? null : rawDomain.trim()
      if (!domain || !name || rawPath === null || value === null) {
        skipped.push({ where, name: name || null, domain: domain || null, code: 'corrupt', reason: 'corrupted Safari cookie record' })
        continue
      }
      const path = rawPath || '/'

      const expiryRaw = buf.readDoubleLE(cOff + 40)
      let expires
      if (Number.isFinite(expiryRaw) && expiryRaw !== 0) {
        expires = expiryRaw + MAC_EPOCH_OFFSET
        if (expires <= now) {
          skipped.push({ where, name, domain, code: 'expired', reason: 'already expired' })
          continue
        }
      }

      const cookie = {
        name,
        value,
        domain,
        path,
        secure: (flags & FLAG_SECURE) !== 0,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
      }
      if (expires !== undefined) cookie.expires = expires
      cookies.push(cookie)
    }

    pageOffset = pageEnd
  }

  return { cookies, origins: [], skipped }
}

/** Fast header-only cookie count for one Cookies.binarycookies file (no string decoding). */
export async function countBinaryCookies(filePath) {
  if (!filePath) return null
  try {
    const buf = await readFile(filePath)
    if (buf.length === 0) return 0
    if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== MAGIC) return null
    const pageCount = buf.readUInt32BE(4)
    const headerBytes = 8 + pageCount * 4
    if (headerBytes > buf.length) return null
    let offset = headerBytes
    let total = 0
    for (let i = 0; i < pageCount; i += 1) {
      const size = buf.readUInt32BE(8 + i * 4)
      if (offset + size > buf.length) return null
      if (size >= 12 && buf.readUInt32BE(offset) === PAGE_HEADER_BE) {
        total += buf.readUInt32LE(offset + 4)
      }
      offset += size
    }
    return total
  } catch {
    return null
  }
}

async function readSafariProfileNames(tabsDbPath) {
  const names = new Map()
  if (!existsSync(tabsDbPath)) return names
  let tempDir = null
  let dbPath = tabsDbPath
  try {
    // Snapshot SafariTabs.db atomically via VACUUM INTO when possible so live Safari WAL frames are seen cleanly.
    tempDir = await mkdtemp(join(tmpdir(), 'dsb-safari-tabs-'))
    const snapPath = join(tempDir, 'SafariTabs.db')
    let src
    try {
      src = new DatabaseSync(tabsDbPath, { readOnly: true })
      src.exec('PRAGMA busy_timeout = 200')
      src.prepare('VACUUM INTO ?').run(snapPath)
      dbPath = snapPath
    } catch {
      dbPath = tabsDbPath
    } finally {
      try { src?.close() } catch { /* ignore */ }
    }

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const hasBookmarks = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks'").get())
      if (!hasBookmarks) return names
      const cols = new Set(db.prepare('PRAGMA table_info(bookmarks)').all().map((r) => r.name))
      if (!cols.has('external_uuid') || !cols.has('title') || !cols.has('type') || !cols.has('subtype')) return names
      const notDeleted = cols.has('deleted') ? ' AND (deleted IS NULL OR deleted = 0)' : ''
      const rows = db.prepare(`SELECT title, external_uuid FROM bookmarks WHERE type = 1 AND subtype = 2${notDeleted}`).all()
      for (const row of rows) {
        if (typeof row.external_uuid === 'string' && row.external_uuid.trim()) {
          names.set(row.external_uuid.trim(), typeof row.title === 'string' ? row.title.trim() : '')
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // SafariTabs.db unavailable or unreadable — fall back to directory discovery.
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  return names
}

async function findSafariProfileCookieFile(containerLib, uuid) {
  const candidates = [
    join(containerLib, 'WebKit', 'WebsiteDataStore', uuid, 'Cookies', 'Cookies.binarycookies'),
    join(containerLib, 'Safari', 'Profiles', uuid, 'Cookies', 'Cookies.binarycookies'),
    join(containerLib, 'Safari', 'Profiles', uuid, 'Cookies.binarycookies'),
    join(containerLib, 'WebKit', 'WebsiteDataStore', uuid, 'Cookies.binarycookies'),
    join(containerLib, 'Cookies', `${uuid}.binarycookies`),
  ]
  for (const candidate of candidates) {
    if (await probeFile(candidate) === 'readable') return candidate
  }
  return null
}

async function scanProfileUuids(containerLib) {
  const uuids = new Set()
  for (const dir of [join(containerLib, 'WebKit', 'WebsiteDataStore'), join(containerLib, 'Safari', 'Profiles')]) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && UUID_RE.test(entry.name)) uuids.add(entry.name)
      }
    } catch { /* directory missing or unreadable */ }
  }
  return uuids
}

/**
 * Enumerate Safari profiles on macOS.
 * When Full Disk Access has not been granted, still exposes one Safari entry marked
 * `needsPermission: true` so the user can open the guided permission card directly.
 */
export async function safariProfiles({ home = homedir(), containerLib = safariContainerLibrary(home), appPaths = SAFARI_APPS } = {}) {
  const access = await checkSafariAccess({ home, containerLib, appPaths })
  if (access.needsPermission) {
    return [{
      dir: 'permission',
      name: 'Default',
      displayName: null,
      cookieFile: null,
      hasCookies: true,
      needsPermission: true,
      cookieCount: null,
    }]
  }

  const profileNames = await readSafariProfileNames(join(containerLib, 'Safari', 'SafariTabs.db'))
  const uuidSet = await scanProfileUuids(containerLib)
  for (const uuid of profileNames.keys()) {
    if (uuid !== 'DefaultProfile') uuidSet.add(uuid)
  }

  const namedProfiles = []
  for (const uuid of uuidSet) {
    const cookieFile = await findSafariProfileCookieFile(containerLib, uuid)
    if (!cookieFile) continue
    const title = profileNames.get(uuid) || uuid.slice(0, 8)
    namedProfiles.push({
      dir: uuid,
      name: title,
      displayName: title,
      cookieFile,
      hasCookies: true,
      needsPermission: false,
      cookieCount: await countBinaryCookies(cookieFile),
    })
  }
  namedProfiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const profiles = []
  if (access.accessible && access.cookieFile) {
    const defaultTitle = profileNames.get('DefaultProfile') || (namedProfiles.length > 0 ? 'Personal' : null)
    profiles.push({
      dir: 'Default',
      name: defaultTitle ?? 'Default',
      displayName: defaultTitle,
      cookieFile: access.cookieFile,
      hasCookies: true,
      needsPermission: false,
      cookieCount: await countBinaryCookies(access.cookieFile),
    })
  }
  profiles.push(...namedProfiles)
  return profiles
}

/** Read and parse cookies for one Safari source profile. Throws {code:'safari-permission'} on TCC denial. */
export async function harvestSafari(source, { home = homedir(), containerLib, now = Date.now() / 1000, signal } = {}) {
  if (signal?.aborted) {
    const err = new Error('Browser import cancelled')
    err.code = 'import-cancelled'
    throw err
  }
  const lib = containerLib ?? source?.userDataDir ?? safariContainerLibrary(home)
  let cookieFile = source?.cookieFile ?? source?.cookieDb ?? null

  if (!cookieFile) {
    if (source?.profileDir && source.profileDir !== 'Default') {
      cookieFile = await findSafariProfileCookieFile(lib, source.profileDir)
    } else {
      const access = await checkSafariAccess({ home, containerLib: lib })
      if (access.needsPermission) throw safariPermissionError()
      cookieFile = access.cookieFile
    }
  }

  if (!cookieFile) {
    // Re-check whether the container became permission-protected or has no cookie store yet.
    const access = await checkSafariAccess({ home, containerLib: lib })
    if (access.needsPermission) throw safariPermissionError()
    return { cookies: [], origins: [], skipped: [] }
  }

  let buf
  try {
    buf = await readFile(cookieFile)
  } catch (error) {
    if (isPermissionError(error)) throw safariPermissionError()
    if (error?.code === 'ENOENT') return { cookies: [], origins: [], skipped: [] }
    throw error
  }
  if (signal?.aborted) {
    const err = new Error('Browser import cancelled')
    err.code = 'import-cancelled'
    throw err
  }
  return parseBinaryCookies(buf, { now })
}
