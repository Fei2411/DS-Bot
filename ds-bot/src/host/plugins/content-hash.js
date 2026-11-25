// Deterministic SHA-256 content hashing of an installed plugin directory tree.
//
// The hash feeds the plugin consent fingerprint: when the executable bytes of a
// locally installed plugin change, the fingerprint changes and prior consent no
// longer covers the new code. Hashing is deterministic across platforms and runs:
// entries are visited in sorted byte order, file content is hashed together with
// its relative path and entry kind, and symlink targets are hashed as text without
// following them. A symlink that would escape the plugin directory is rejected
// outright, and zip/symlink bombs are capped by file-count and byte limits.
import { createHash } from 'node:crypto'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const CONTENT_HASH_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxBytes: 50 * 1024 * 1024,
})

export class ContentHashError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContentHashError'
    this.code = code
  }
}

async function hashFileInto(hash, filePath, remaining) {
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => {
      remaining.bytes -= chunk.byteLength
      if (remaining.bytes < 0) {
        stream.destroy()
        reject(new ContentHashError('too-large', `Plugin directory exceeds the ${CONTENT_HASH_LIMITS.maxBytes} byte content hash limit.`))
        return
      }
      hash.update(chunk)
    })
    stream.on('end', resolvePromise)
  })
}

/**
 * Compute a deterministic SHA-256 over the directory tree rooted at `dir`.
 *
 * @param {string} dir - absolute path of the installed plugin directory
 * @param {{ maxFiles?: number, maxBytes?: number }} [limits]
 * @returns {Promise<{ hash: string, files: number, bytes: number }>}
 * @throws {ContentHashError} `symlink-escape` when a symlink resolves outside the tree,
 *   `too-many-files` / `too-large` past the caps, or rethrows fs errors for unreadable trees.
 */
export async function hashPluginTree(dir, { maxFiles = CONTENT_HASH_LIMITS.maxFiles, maxBytes = CONTENT_HASH_LIMITS.maxBytes } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('hashPluginTree requires a directory path.')
  const root = resolve(dir)
  let rootReal
  try {
    rootReal = await realpath(root)
  } catch {
    throw new ContentHashError('unreadable', `Plugin directory "${root}" cannot be read.`)
  }
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory()) {
    throw new ContentHashError('not-directory', `Plugin path "${root}" is not a directory.`)
  }

  const hash = createHash('sha256')
  const remaining = { bytes: maxBytes }
  let files = 0

  // The hash covers structure + content: for each entry, its kind, its root-relative
  // path (posix-separated so hashes are platform-stable), and either the file bytes
  // or the symlink target text. Directory names matter because file paths do.
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relative(rootReal, full).split(sep).join('/')
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) {
        const target = await readlink(full)
        // Never follow symlinks. A symlink that would leave the plugin tree means the
        // tree's content is not self-contained: refuse to fingerprint it at all rather
        // than binding consent to bytes outside the hashed boundary.
        const resolvedTarget = resolve(current, target)
        const inner = relative(rootReal, resolvedTarget)
        const inside = inner === '' || (!isAbsolute(inner) && inner !== '..' && !inner.startsWith(`..${sep}`))
        if (!inside) {
          throw new ContentHashError('symlink-escape', `Symlink "${rel}" escapes the plugin directory.`)
        }
        hash.update('link\0')
        hash.update(rel, 'utf8')
        hash.update('\0')
        hash.update(target, 'utf8')
        hash.update('\0')
        files += 1
      } else if (stat.isDirectory()) {
        hash.update('dir\0')
        hash.update(rel, 'utf8')
        hash.update('\0')
        files += 1
        if (files > maxFiles) {
          throw new ContentHashError('too-many-files', `Plugin directory exceeds the ${maxFiles} file content hash limit.`)
        }
        await walk(full)
        continue
      } else if (stat.isFile()) {
        hash.update('file\0')
        hash.update(rel, 'utf8')
        hash.update('\0')
        files += 1
        if (files > maxFiles) {
          throw new ContentHashError('too-many-files', `Plugin directory exceeds the ${maxFiles} file content hash limit.`)
        }
        await hashFileInto(hash, full, remaining)
        hash.update('\0')
      } else {
        // Sockets, fifos and device nodes have no portable content; record kind + path only.
        hash.update('other\0')
        hash.update(rel, 'utf8')
        hash.update('\0')
        files += 1
      }
      if (files > maxFiles) {
        throw new ContentHashError('too-many-files', `Plugin directory exceeds the ${maxFiles} file content hash limit.`)
      }
    }
  }

  await walk(rootReal)
  return { hash: hash.digest('hex'), files, bytes: maxBytes - remaining.bytes }
}

/**
 * Resolve the on-disk directory a locally installed plugin spec points at, or null
 * when the spec is not a local path (registry name, git address, URL). Mirrors the
 * documented pnpm forms (`file:` / `link:` made absolute) and plain absolute paths;
 * relative paths are never resolved because the host's working directory means
 * nothing to a browser-side install request.
 */
export function localPluginDirOf(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return null
  let text = spec.trim()
  if (/^(?:file|link):/i.test(text)) {
    text = text.replace(/^(?:file|link):/i, '')
    if (text.startsWith('~')) return null
  }
  const posixAbs = text.startsWith('/')
  const winAbs = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')
  if (!posixAbs && !winAbs) return null
  return resolve(text)
}
