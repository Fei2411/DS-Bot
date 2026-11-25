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
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
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

const physicalTarget = path => realpath(path).catch(() => undefined)
const targetIsFolder = source => stat(source).then(info => info.isDirectory(), () => undefined)

async function inspectLink(source, roots) {
  const text = (await readlink(source)).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '')
  const written = resolve(dirname(source), text)
  const direct = roots.some(folder => within(written, folder))
  const [physical, folder] = await Promise.all([direct ? undefined : physicalTarget(written), targetIsFolder(source)])
  return { text, written, direct, physical, folder }
}

// A link that leads inside the copied folder leads to the same place inside the copy: a relative
// one keeps its text, an absolute one is moved over. One that leads outside keeps leading
// there, as an absolute link. Windows gives a junction's target with \\?\, and makes only
// junctions, which hold absolute paths, without special rights.
async function linkTarget(source, roots, to, inspected, refresh) {
  const { text, written, direct } = inspected
  let { physical, folder } = inspected
  // An earlier write can make a missing target reachable through another link.
  if (refresh && (folder === undefined || (!direct && physical === undefined))) {
    [physical, folder] = await Promise.all([
      direct ? undefined : physical ?? physicalTarget(written),
      folder ?? targetIsFolder(source),
    ])
  }
  const target = direct ? written : physical ?? written
  const root = roots.find(folder => within(target, folder))
  const windows = process.platform === 'win32'
  const inside = root === undefined ? written : join(to, relative(root, target))
  return {
    target: direct && !isAbsolute(text) && !(windows && folder) ? text : inside,
    type: folder ? (windows ? 'junction' : 'dir') : 'file',
  }
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
  const to = resolve(as)
  signal?.throwIfAborted()
  let writes = 0
  const prepare = path => {
    const source = join(origin, path)
    const before = writes
    return inspectLink(source, roots).then(inspected => {
      // A Windows junction can briefly exist as a regular directory during creation.
      if (process.platform === 'win32' && before !== writes) {
        inspected.physical = undefined
        inspected.folder = undefined
      }
      return { source, before, inspected }
    }, error => ({ error }))
  }
  const pending = links.slice(0, 4).map(prepare)
  try {
    for (const [index, path] of links.entries()) {
      signal?.throwIfAborted()
      const slot = index % pending.length
      const at = join(into, path)
      // Only the destination filesystem knows which names alias. Publish in discovery order.
      const keep = !force && await lstat(at).then(() => true, () => false)
      const prepared = await pending[slot]
      signal?.throwIfAborted()
      if (!keep) {
        try {
          if ('error' in prepared) throw prepared.error
          const { source, before, inspected } = prepared
          const { target, type } = await linkTarget(source, roots, to, inspected, before !== writes)
          if (!signal?.aborted) {
            writes++
            await symlink(target, at, type)
          }
        } catch (error) {
          if (!skip) throw error
          skipped.push(path)
        }
      }
      signal?.throwIfAborted()
      const next = index + pending.length
      if (next < links.length) pending[slot] = prepare(links[next])
    }
  } finally {
    await Promise.all(pending)
  }
  return skipped
}
