// Moving the app's data to another folder. The copy is put together in a folder beside the new
// one and takes its name only once it is whole, so a copy that stopped or failed leaves nothing
// that looks like data. The old folder stays as it was.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { copyTree, real, within } from './copy-tree.mjs'

export { copyReason } from './copy-tree.mjs'

// The engine's lock on the team belongs to the old folder; the first-run copy and its check
// leave their temporary folders only when they were cut short.
const LEFT_BEHIND = [/^bot[\\/]state\.lock$/u, /^\.import(-check)?-\d+$/u]
// Marks a staging folder as this app's, so that only those are removed.
const MARK = '.ds-bot-moving'

/** The folder that an update or uninstall replaces: on macOS the whole .app bundle. */
export function installFolder(exe, platform = process.platform) {
  if (platform === 'darwin') {
    for (let at = dirname(exe); dirname(at) !== at; at = dirname(at)) if (at.endsWith('.app')) return at
  }
  return dirname(exe)
}

/**
 * What keeps `to` from being the new data location, or undefined.
 * @param {{ from: string, to: string, workspace?: string, dshHome: string, program?: string }} places
 * @returns {'drive' | 'nested' | 'workspace' | 'dsh' | 'program' | 'notEmpty' | undefined}
 */
export function moveProblem(places) {
  const [from, to, dshHome] = [places.from, places.to, places.dshHome].map(real)
  const workspace = places.workspace === undefined ? undefined : real(places.workspace)
  const program = places.program === undefined ? undefined : real(places.program)
  if (dirname(to) === to) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (within(to, dshHome) || within(dshHome, to)) return 'dsh'
  if (program !== undefined && within(to, program)) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Copy the data in `from` to `to`, an empty or new folder. The signal stops it between files.
 * @param {string} from @param {string} to @param {AbortSignal} [signal]
 */
export async function copyData(from, to, signal) {
  const parent = dirname(resolve(to))
  await mkdir(parent, { recursive: true })
  // A run that was killed can leave its staging folder behind.
  const staging = new RegExp(`^\\.${escaped(basename(to))}\\.moving-\\d+$`, 'u')
  for (const name of readdirSync(parent).filter(entry => staging.test(entry) && existsSync(join(parent, entry, MARK)))) {
    await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 })
  }
  const stage = join(parent, `.${basename(to)}.moving-${String(Date.now())}`)
  await mkdir(stage)
  try {
    await writeFile(join(stage, MARK), '')
    // Anything left out would be missing from the data the app moves on to, so it stops the move.
    await copyTree(from, stage, { as: to, leave: path => LEFT_BEHIND.some(pattern => pattern.test(path)), signal })
    signal?.throwIfAborted()
    if (existsSync(to)) await rmdir(to)
    await rename(stage, to)
  } catch (error) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 })
    throw error
  }
  // Only now: a staging folder cut short before its rename keeps the mark that lets it go.
  await rm(join(to, MARK), { force: true })
}
