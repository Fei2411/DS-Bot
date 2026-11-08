// macOS attributes Screen Recording for an application nested in another signed application to
// the outer one, so a grant to "DSH Computer Use" does nothing while the helper lies inside
// DS Bot.app (#1066). The Host runs a copy from outside the bundle: the copy keeps DeepSeek's
// signature, so the grant stays with the helper and survives DS Bot's own updates.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HELPER_PACKAGE = ['node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos']
const HELPER_APP = 'DSH Computer Use.app'
const HELPER_EXECUTABLE = join(HELPER_APP, 'Contents', 'MacOS', 'dsh-cua-native')

// A first launch from a quarantined copy would stop at Gatekeeper's prompt with nobody looking
// at a background helper; the outer app has already passed that check.
const copyApplication = async (from, to) => {
  await run('/usr/bin/ditto', [from, to])
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', to])
}
const verifyApplication = application => run('/usr/bin/codesign', ['--verify', '--strict', application])

const sameFile = async (a, b) => existsSync(b) && (await readFile(a)).equals(await readFile(b))

async function placeCopy({ source, home, bundle, copy, verify }) {
  const target = join(home, bundle)
  const installed = join(target, HELPER_EXECUTABLE)
  if (await sameFile(join(source, HELPER_EXECUTABLE), installed)) return installed
  await mkdir(home, { recursive: true })
  await rm(target, { recursive: true, force: true })
  const partial = join(home, `.${bundle}-${process.pid}`)
  await rm(partial, { recursive: true, force: true })
  try {
    await mkdir(partial)
    await copy(join(source, HELPER_APP), join(partial, HELPER_APP))
    await verify(join(partial, HELPER_APP))
    await rename(partial, target)
  } finally {
    await rm(partial, { recursive: true, force: true })
  }
  return installed
}

const pruneOthers = async (home, bundle) => {
  for (const name of await readdir(home)) {
    if (name !== bundle) await rm(join(home, name), { recursive: true, force: true })
  }
}

/**
 * Place the packaged helper outside the app bundle and report where it runs from.
 * @param {{ runtimeDir: string, home: string, arch?: string, copy?: Function, verify?: Function }} options
 *   `runtimeDir` is the packaged app's resources; `home` is a folder outside the bundle.
 * @returns {Promise<{ path: string, error?: Error } | undefined>} undefined outside a packaged
 *   macOS app. When the copy fails, `path` is the helper inside the bundle: it still runs, only
 *   Screen Recording goes to the outer app.
 */
export async function prepareComputerHelper({ runtimeDir, home, arch = process.arch, copy = copyApplication, verify = verifyApplication }) {
  const directory = join(runtimeDir, 'app.asar.unpacked', ...HELPER_PACKAGE, 'native', 'bin', `darwin-${arch}`)
  const receipt = join(directory, 'current.json')
  if (!existsSync(receipt)) return undefined
  const { bundle } = JSON.parse(await readFile(receipt, 'utf8'))
  if (typeof bundle !== 'string' || bundle === '' || basename(bundle) !== bundle) throw new Error(`Invalid computer-use helper receipt: ${receipt}`)
  const source = join(directory, bundle)
  try {
    const path = await placeCopy({ source, home, bundle, copy, verify })
    await pruneOthers(home, bundle).catch(() => {})
    return { path }
  } catch (error) {
    return { path: join(source, HELPER_EXECUTABLE), error }
  }
}

/**
 * Export the helper's location for the plugin. Computer use is optional: no failure here may
 * stop the Host from starting.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function reconcileComputerHelper(env = process.env) {
  const { DS_BOT_RUNTIME_DIR: runtimeDir, DS_BOT_COMPUTER_HELPER_HOME: home } = env
  if (process.platform !== 'darwin' || !runtimeDir || !home) return
  try {
    const helper = await prepareComputerHelper({ runtimeDir, home })
    if (helper === undefined) return
    if (helper.error !== undefined) console.warn(`ds-bot: computer-use helper not copied out of the app: ${String(helper.error?.message ?? helper.error)}`)
    env.DS_BOT_COMPUTER_HELPER = helper.path
  } catch (error) {
    console.warn(`ds-bot: computer-use helper not prepared: ${String(error?.message ?? error)}`)
  }
}
