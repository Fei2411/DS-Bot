// Prepare the app's Office payload: a pinned, relocatable CPython with the document
// libraries, a standalone Node for the LibreOffice Kit CLI, and the Office skill
// assets, all downloaded against the lock in primary-runtime.lock.json without
// installing into the build host. electron-builder's beforePack calls it for the
// platform being packed; `npm run runtime` builds the same tree for development.
// Follows DeepSeek Harness scripts/primary-runtime/prepare.ts and
// prune-python-tests.ts (MIT); see NOTICE. Unlike DSH's, this payload ships no pnpm.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { copyPrimaryRuntime, parsePrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import extractZip from 'extract-zip'
import Papa from 'papaparse'
import { x as extractTar } from 'tar'

const lock = JSON.parse(readFileSync(new URL('./primary-runtime.lock.json', import.meta.url), 'utf8'))

// The targets the lock pins, named by the platform and architecture electron-builder packs for.
const RUNTIME_TARGET = {
  win32: { x64: 'win-x64' },
  darwin: { x64: 'mac-x64', arm64: 'mac-arm64' },
  linux: { x64: 'linux-x64', arm64: 'linux-arm64' },
}

/**
 * The lock's target for a platform and architecture, or undefined when the lock pins none.
 * @param {string} platform - process.platform of the payload's system.
 * @param {string} arch - process.arch of the payload's system.
 * @returns {keyof typeof lock.targets | undefined}
 */
export function runtimeTarget(platform, arch) {
  return RUNTIME_TARGET[platform]?.[arch]
}

/**
 * Download or reuse an archive only when its bytes match the release lock.
 * @param {string} url - Locked archive URL.
 * @param {string} sha256 - Expected hexadecimal sha256 digest.
 * @param {string} cache - Download cache directory.
 * @returns {Promise<string>} verified local archive path
 */
async function downloadPrimaryRuntimeAsset(url, sha256, cache) {
  mkdirSync(cache, { recursive: true })
  const destination = join(cache, sha256)
  let bytes
  let cached = true
  try { bytes = readFileSync(destination) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    cached = false
    const timeout = Number(process.env.DS_BOT_RUNTIME_DOWNLOAD_TIMEOUT_MS ?? '300000')
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error('DS_BOT_RUNTIME_DOWNLOAD_TIMEOUT_MS must be an integer from 1 to 2147483647')
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`primary runtime download: ${String(response.status)} ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    rmSync(destination, { force: true })
    throw new Error(`primary runtime download: checksum mismatch for ${url}`)
  }
  if (cached) return destination
  const temporary = join(cache, `.${randomUUID()}`)
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return destination
}

/**
 * Prepare the locked standalone Node for the target.
 * @param {keyof typeof lock.targets} target - Target interpreter platform.
 * @param {string} destination - Directory receiving bin/node and LICENSE.
 * @param {string} cache - Verified archive cache.
 */
async function downloadNodeRuntime(target, destination, cache) {
  const artifact = lock.targets[target]
  const filename = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
  const archive = await downloadPrimaryRuntimeAsset(`https://nodejs.org/dist/v${lock.nodeVersion}/${filename}`, artifact.nodeSha256, cache)
  const staging = mkdtempSync(join(tmpdir(), 'ds-bot-node-'))
  try {
    if (target === 'win-x64') await extractZip(archive, { dir: staging })
    else await extractTar({ file: archive, cwd: staging })
    const source = join(staging, filename.replace(/\.(?:zip|tar\.gz)$/u, ''))
    mkdirSync(join(destination, 'bin'), { recursive: true })
    cpSync(join(source, ...(target === 'win-x64' ? ['node.exe'] : ['bin', 'node'])),
      join(destination, 'bin', target === 'win-x64' ? 'node.exe' : 'node'))
    cpSync(join(source, 'LICENSE'), join(destination, 'LICENSE'))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function pythonArchive(target, cache) {
  const artifact = lock.targets[target]
  const filename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  return downloadPrimaryRuntimeAsset(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(filename)}`, artifact.pythonSha256, cache)
}

/**
 * Identify the inputs that assemble one target's payload, excluding unrelated target locks.
 * @param {keyof typeof lock.targets} target - Runtime target whose archives are installed.
 * @returns {string} sha256 payload identity for installation reuse
 */
function primaryRuntimePayloadDigest(target) {
  const { pythonVersion, pythonRelease, nodeVersion, wheels, pythonPackages } = lock
  return createHash('sha256').update(JSON.stringify({
    format: 7, target, pythonVersion, pythonRelease, nodeVersion,
    artifact: lock.targets[target], wheels, pythonPackages,
  })).digest('hex')
}

/**
 * The runtime.json written into a target's payload.
 * @param {keyof typeof lock.targets} target - Runtime target the manifest describes.
 * @param {string} version - The app's version, recorded in the legacy desktopVersion field.
 * @returns {object} validated manifest
 */
export function primaryRuntimeManifest(target, version) {
  return {
    desktopVersion: version,
    platform: target === 'win-x64' ? 'win32' : target.startsWith('linux-') ? 'linux' : 'darwin',
    arch: target.endsWith('-arm64') ? 'arm64' : 'x64',
    payloadDigest: primaryRuntimePayloadDigest(target),
    python: lock.pythonVersion,
    node: lock.nodeVersion,
    pythonPackages: lock.pythonPackages,
  }
}

/**
 * Whether an output directory already holds a complete payload for the manifest.
 * @param {string} output - Directory receiving primary-runtime/.
 * @param {object} manifest - The manifest the payload must match.
 * @returns {boolean}
 */
export function runtimeReusable(output, manifest) {
  const root = join(output, 'primary-runtime')
  let existing
  try { existing = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'))) } catch { return false }
  if (existing.payloadDigest !== manifest.payloadDigest) return false
  const entries = workspaceDependencyPaths(root, manifest)
  return [entries.python, entries.node].every(path => existsSync(path)) && existsSync(entries.pythonPackages)
}

/**
 * Unpack a locked library wheel, retaining auxiliary scripts in its distribution data directory.
 * @param {string} archive - Hash-verified wheel archive.
 * @param {string} destination - Absolute site-packages directory.
 */
async function unpackPrimaryRuntimeWheel(archive, destination) {
  await extractZip(archive, {
    dir: destination,
    onEntry: (entry) => {
      const [directory, scheme] = entry.fileName.split('/')
      if (directory?.endsWith('.data') && scheme !== '' && scheme !== 'scripts') {
        throw new Error(`primary runtime: wheel requires unsupported installation paths: ${entry.fileName}`)
      }
    },
  })
}

function removeTestDirectories(root, directory) {
  const removed = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = `${directory}/${entry.name}`
    if (entry.name === 'tests') {
      rmSync(join(root, path), { recursive: true })
      removed.push(path)
    } else {
      removed.push(...removeTestDirectories(root, path))
    }
  }
  return removed
}

/**
 * Prune NumPy/pandas tests and their RECORD rows, preserving testing helpers and native extensions.
 * @param {string} sitePackages - Staged site-packages directory containing the locked wheels.
 * @throws If a locked distribution's RECORD is missing or malformed.
 */
export function prunePrimaryRuntimePythonTests(sitePackages) {
  for (const name of ['numpy', 'pandas']) {
    const record = join(sitePackages, `${name}-${lock.pythonPackages[name]}.dist-info`, 'RECORD')
    const { data, errors } = Papa.parse(readFileSync(record, 'utf8'), { delimiter: ',', skipEmptyLines: true })
    if (errors.length > 0 || data.length === 0
      || !data.every((row) => row.length === 3 && Boolean(row[0]))) {
      throw new Error(`primary runtime: invalid wheel RECORD: ${record}`)
    }
    const removed = removeTestDirectories(sitePackages, name)
    if (removed.length === 0) continue
    const retained = data.filter(([path]) => !removed.some(directory => path.startsWith(`${directory}/`)))
    writeFileSync(record, `${Papa.unparse(retained, { newline: '\n' })}\n`)
  }
}

/**
 * Copy the skill package's complete asset tree to ordinary filesystem resources.
 * @param {string} source - The package's assets directory.
 * @param {string} destination - External Office skill resource directory.
 */
async function prepareOfficeSkillAssets(source, destination) {
  rmSync(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

/**
 * Materialize locked interpreters, libraries and Office resources without executing target code.
 * @param {{ target: keyof typeof lock.targets, output: string, cache: string, version: string, skillSource?: string }} options
 *   target: payload platform. output: directory receiving primary-runtime/ and office-skills/.
 *   cache: sha256-addressed archive cache. version: the app's version for the manifest.
 */
export async function preparePrimaryRuntime(options) {
  const { target } = options
  const artifact = lock.targets[target]
  if (artifact === undefined) throw new Error(`primary runtime: unknown target ${String(target)}`)
  const paths = { runtime: resolve(options.output), downloads: resolve(options.cache) }
  const manifest = primaryRuntimeManifest(target, options.version)
  mkdirSync(paths.runtime, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  if (runtimeReusable(paths.runtime, manifest)) {
    console.log(`primary-runtime: payload in ${paths.runtime} is current (digest ${manifest.payloadDigest.slice(0, 12)}…)`)
  } else {
    const staging = mkdtempSync(join(tmpdir(), 'ds-bot-primary-'))
    try {
      const output = join(staging, 'payload')
      const dependencies = join(output, 'dependencies')
      mkdirSync(dependencies, { recursive: true })
      const node = join(dependencies, 'node')
      await downloadNodeRuntime(target, node, paths.downloads)
      mkdirSync(join(node, 'node_modules'))
      writeFileSync(join(node, 'node_modules', 'README.txt'), 'Reserved for bundled Node packages.\n')
      await extractTar({ file: await pythonArchive(target, paths.downloads), cwd: dependencies })
      const entries = workspaceDependencyPaths(output, manifest)
      for (const wheel of [...artifact.wheels, ...lock.wheels]) {
        await unpackPrimaryRuntimeWheel(await downloadPrimaryRuntimeAsset(wheel.url, wheel.sha256, paths.downloads), entries.pythonPackages)
      }
      prunePrimaryRuntimePythonTests(entries.pythonPackages)
      writeFileSync(join(output, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
      const destination = join(paths.runtime, 'primary-runtime')
      rmSync(destination, { recursive: true, force: true })
      await copyPrimaryRuntime(output, destination, manifest)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  const assets = options.skillSource ?? join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-skill-office/package.json'))), 'assets')
  await prepareOfficeSkillAssets(assets, join(paths.runtime, 'office-skills'))
}

/**
 * Run the freshly prepared payload's interpreter and libraries; skipped when the
 * target is not the build host's own platform and architecture.
 * @param {string} root - Final payload directory.
 */
function smokePrimaryRuntime(root) {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  const entries = workspaceDependencyPaths(root, manifest)
  execFileSync(entries.python, ['-I', '-B', '-c', 'import docx, pptx, openpyxl, pandas, lxml, PIL'], { stdio: 'inherit', timeout: 120_000 })
  execFileSync(entries.node, ['--version'], { stdio: 'inherit', timeout: 30_000 })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' },
  } })
  const here = dirname(fileURLToPath(import.meta.url))
  const target = values.target ?? runtimeTarget(process.platform, process.arch)
  if (target === undefined || !Object.hasOwn(lock.targets, target)) {
    throw new Error(`Usage: node scripts/prepare-runtime.mjs [--target <${Object.keys(lock.targets).join('|')}>] [--output <directory>] [--cache <directory>]`)
  }
  const output = resolve(values.output ?? join(here, '..', 'build', 'runtime'))
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  await preparePrimaryRuntime({
    target, output,
    cache: values.cache ?? process.env.DS_BOT_RUNTIME_CACHE ?? join(here, '..', 'build', 'runtime-cache'),
    version,
  })
  smokePrimaryRuntime(join(output, 'primary-runtime'))
}
