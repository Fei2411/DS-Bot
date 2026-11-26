// Deterministic SHA-256 content hashing of an installed plugin directory tree.
//
// The hash feeds the plugin consent fingerprint: when the executable bytes of a
// locally installed plugin change, the fingerprint changes and prior consent no
// longer covers the new code. Hashing is deterministic across platforms and runs:
// entries are visited in sorted byte order and NFC-normalized form (macOS stores
// filenames in NFD), file content is hashed together with its relative path and
// entry kind, and symlink targets are hashed as text without following them. A
// symlink that would escape the plugin directory is rejected outright, and
// zip/symlink bombs are capped by file-count and byte limits.
//
// `node_modules` and `.git` directory CONTENTS are deliberately excluded: registry
// and file installs carry dependency trees a fingerprint cannot meaningfully bind
// (pnpm hardlink stores are shared across packages), and a local `link:` plugin's
// development dependencies would blow the file-count cap without adding any signal
// about the plugin's own executable surface. Their presence is still structural:
// the directory entry itself is hashed, only its children are skipped. A plugin
// that smuggles executable code into `node_modules` is covered indirectly — the
// version pin and the package's own files are what executes first, and the kill
// list covers supply-chain incidents by id, range, or hash.
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

function updateField(hash, value) {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32BE(buf.byteLength, 0)
  hash.update(len)
  hash.update(buf)
}

async function hashFileDigest(filePath, remaining) {
  const fileHash = createHash('sha256')
  let bytes = 0
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
      bytes += chunk.byteLength
      fileHash.update(chunk)
    })
    stream.on('end', resolvePromise)
  })
  return { digest: fileHash.digest(), bytes }
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
  // The entry point itself may be a symlink: pnpm's isolated layout links
  // `<profile>/node_modules/<pkg>` into `.pnpm/`, and `link:` installs link the
  // development folder, so validating `lstat(root)` would reject every real
  // installation. The tree being hashed is the RESOLVED directory — validate that.
  // Symlink escapes are still caught strictly INSIDE the resolved tree below.
  const rootStat = await lstat(rootReal).catch(() => null)
  if (!rootStat?.isDirectory()) {
    throw new ContentHashError('not-directory', `Plugin path "${root}" is not a directory.`)
  }

  const hash = createHash('sha256')
  const remaining = { bytes: maxBytes }
  let files = 0

  // Directory names whose contents are excluded from the hash (see module header).
  const SKIP_DIR_CONTENTS = new Set(['node_modules', '.git'])

  // The hash covers structure + content: for each entry, its kind, its root-relative
  // path (posix-separated and NFC-normalized so hashes are platform-stable), and either
  // the file bytes or the symlink target text. Directory names matter because file paths do.
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    // Sort on NFC-normalized names in codepoint order so macOS (NFD filenames) and
    // Linux/Windows (usually NFC) hash one tree identically.
    entries.sort((a, b) => {
      const an = a.name.normalize('NFC')
      const bn = b.name.normalize('NFC')
      return an < bn ? -1 : an > bn ? 1 : 0
    })
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relative(rootReal, full).split(sep).join('/').normalize('NFC')
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) {
        const target = await readlink(full)
        // Never follow symlinks. A symlink that would leave the plugin tree means the
        // tree's content is not self-contained: refuse to fingerprint it at all rather
        // than binding consent to bytes outside the hashed boundary.
        const resolvedTarget = resolve(current, target)
        // Canonicalize existing targets via `realpath` so an intra-tree absolute
        // symlink spelled through a symlinked ancestor (e.g. `/var/...` vs
        // `/private/var/...` on macOS) is not misread as an escape, while also
        // catching multi-hop chains that ultimately resolve outside `rootReal`.
        // Dangling targets fall back to lexical resolution so escapes fail closed.
        const canonicalTarget = await realpath(resolvedTarget).catch(() => resolvedTarget)
        const inner = relative(rootReal, canonicalTarget)
        const inside = inner === '' || (!isAbsolute(inner) && inner !== '..' && !inner.startsWith(`..${sep}`))
        if (!inside) {
          throw new ContentHashError('symlink-escape', `Symlink "${rel}" escapes the plugin directory.`)
        }
        // Length-prefixed binary framing ensures arbitrary bytes (including NULs) inside
        // filenames, symlink targets, or file contents can never collide across entries.
        updateField(hash, 'link')
        updateField(hash, rel)
        updateField(hash, target.normalize('NFC'))
        files += 1
      } else if (stat.isDirectory()) {
        updateField(hash, 'dir')
        updateField(hash, rel)
        files += 1
        if (files > maxFiles) {
          throw new ContentHashError('too-many-files', `Plugin directory exceeds the ${maxFiles} file content hash limit.`)
        }
        if (!SKIP_DIR_CONTENTS.has(entry.name)) {
          await walk(full)
        }
        continue
      } else if (stat.isFile()) {
        files += 1
        if (files > maxFiles) {
          throw new ContentHashError('too-many-files', `Plugin directory exceeds the ${maxFiles} file content hash limit.`)
        }
        const { digest, bytes } = await hashFileDigest(full, remaining)
        updateField(hash, 'file')
        updateField(hash, rel)
        updateField(hash, String(bytes))
        updateField(hash, digest)
      } else {
        // Sockets, fifos and device nodes have no portable content; record kind + path only.
        updateField(hash, 'other')
        updateField(hash, rel)
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
