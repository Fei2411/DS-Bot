// Copying a folder of the user's whole, with its links, for the first-run import and the data move.
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Electron's fs takes every path that ends in .asar for an archive: a file that is none cannot be
// read, one that is looks like a folder and stays locked on Windows, and a name that is not there
// yet is an error that fs.cp stops at. original-fs is the disk as it is, but for a recursive
// readdir, which still goes through Electron; plain Node has only fs.
export const disk = process.getBuiltinModule('original-fs') ?? process.getBuiltinModule('node:fs')
const { existsSync, realpathSync } = disk
const { cp, lstat, readlink, realpath, stat, symlink } = disk.promises

export const within = (inner, outer) => {
  const path = relative(resolve(outer), resolve(inner))
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && !/^[a-z]:/iu.test(path))
}

/**
 * Why a copy failed, in the words of the start page's cards (reason.copy.*); the rest goes into
 * the details.
 * @returns {'inUse' | 'permission' | 'full' | 'other'}
 */
export function copyReason(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'EBUSY') return 'inUse'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'full'
  return 'other'
}

// The path as the file system has it: through links and junctions, from the deepest part that
// exists. A link can make a path that looks apart from a folder lead into it.
export function real(path) {
  const rest = []
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) return resolve(path)
    rest.unshift(basename(at))
    at = up
  }
  return join(realpathSync.native(at), ...rest)
}

// A link that leads inside the copied folder leads to the same place inside the copy: a relative
// one keeps its text, an absolute one is moved over. One that leads outside keeps leading
// there, as an absolute link. Windows gives a junction's target with \\?\, and makes only
// junctions, which hold absolute paths, without special rights.
async function relink(source, path, roots, to) {
  const text = (await readlink(source)).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '')
  const written = resolve(dirname(source), text)
  // Through another link the target can lead inside the copied folder too.
  const physical = await realpath(written).catch(() => written)
  const direct = roots.some(folder => within(written, folder))
  const target = direct ? written : physical
  const root = roots.find(folder => within(target, folder))
  const folder = (await stat(source).catch(() => undefined))?.isDirectory() === true
  const windows = process.platform === 'win32'
  const inside = root === undefined ? written : join(to, relative(root, target))
  await symlink(direct && !isAbsolute(text) && !(windows && folder) ? text : inside, path, folder ? (windows ? 'junction' : 'dir') : 'file')
}

/**
 * Copy the folder `from` into `into`, making its links again (fs.cp makes symbolic links, which
 * Windows refuses without special rights). With `skip`, an entry that cannot be read, such as a
 * junction to nothing, or a link that cannot be made again, is skipped and listed; otherwise it
 * fails the copy.
 * @param {string} from
 * @param {string} into
 * @param {{ force?: boolean, skip?: boolean, leave?: (path: string) => boolean, as?: string, signal?: AbortSignal, seen?: (bytes: number) => void }} [options]
 *   force: false keeps what is there already; leave: relative paths not to copy; as: where the
 *   copy will end up, when `into` is a staging folder that takes that name later; seen: the size
 *   of each file as it is about to be copied
 * @returns {Promise<string[]>} the relative paths that were skipped
 */
export async function copyTree(from, into, { force = true, skip = false, leave = () => false, as = into, signal, seen } = {}) {
  // The folder can itself be a link; its contents are what is copied.
  const origin = real(from)
  const links = []
  const skipped = []
  await cp(origin, into, {
    recursive: true,
    force,
    filter: async (source) => {
      signal?.throwIfAborted()
      const path = relative(origin, source)
      if (path !== '' && leave(path)) return false
      if (path === '') return true
      const info = await lstat(source).catch((error) => { if (!skip) throw error })
      if (info === undefined) skipped.push(path)
      else if (info.isSymbolicLink()) links.push(path)
      else if (info.isFile()) seen?.(info.size)
      return info?.isSymbolicLink() === false
    },
  })
  const roots = [...new Set([resolve(from), origin])]
  for (const path of links) {
    signal?.throwIfAborted()
    const at = join(into, path)
    if (!force && await lstat(at).then(() => true, () => false)) continue
    await relink(join(origin, path), at, roots, resolve(as)).catch((error) => {
      if (!skip) throw error
      skipped.push(path)
    })
  }
  return skipped
}
