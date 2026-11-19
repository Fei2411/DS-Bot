// macOS attributes Screen Recording for an application nested in another signed application to
// the outer one, so a grant to "DSH Computer Use" does nothing while the helper lies inside
// DS Bot.app (#1066). The provider runs a copy from outside the bundle: the copy keeps DeepSeek's
// signature, so the grant stays with the helper and survives DS Bot's own updates.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
const validCopy = async (source, target, verify) => {
  if (!(await sameFile(join(source, HELPER_EXECUTABLE), join(target, HELPER_EXECUTABLE)))) return false
  try {
    await verify(join(target, HELPER_APP))
    return true
  } catch {
    return false
  }
}

async function placeCopy({ source, home, bundle, copy, verify }) {
  const target = join(home, bundle)
  const installed = join(target, HELPER_EXECUTABLE)
  if (await validCopy(source, target, verify)) return installed
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

export async function prepareComputerHelper({ runtimeDir, home, arch = process.arch, copy = copyApplication, verify = verifyApplication }) {
  const directory = join(runtimeDir, 'app.asar.unpacked', ...HELPER_PACKAGE, 'native', 'bin', `darwin-${arch}`)
  const receipt = join(directory, 'current.json')
  const { bundle } = JSON.parse(await readFile(receipt, 'utf8'))
  if (typeof bundle !== 'string' || !/^[a-f0-9]{64}$/u.test(bundle)) throw new Error(`Invalid computer-use helper receipt: ${receipt}`)
  const path = await placeCopy({ source: join(directory, bundle), home, bundle, copy, verify })
  await pruneOthers(home, bundle).catch(() => {})
  return path
}
