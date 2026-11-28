// Writes what a release offers for download: the "Download / 下载" table at the top of its notes,
// SHA256SUMS.txt, and a copy of each package without the version in its name, which a fixed
// releases/latest/download/ link can name.
//
// Usage:
//   node scripts/release-notes.mjs <version> <folder with the packages> <folder for the files to attach> [<current notes>]
//     [--external-package <file>=<version>[:<sizeBytes>]]
//     [--pending <file>]
//     [--write-manifest <manifest.json>]
//     [--merge-manifest <manifest.json>]
//
// It prints the notes with the table on top. MIRROR_BASE, when set, is a URL that holds the
// packages under the same names; GITHUB_REPOSITORY names the repository (default Fei-Craft/DS-Bot).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Fei-Craft/DS-Bot'
// The order of the table: Windows first, where most downloads are; the phone app last.
export const PACKAGES = [
  { file: 'win-x64.exe', system: '**Windows 10/11 (64-bit / 64 位)**', note: 'Double-click to install / 双击安装' },
  { file: 'mac-arm64.zip', system: 'macOS, Apple chip / Apple 芯片' },
  { file: 'mac-x64.zip', system: 'macOS, Intel' },
  { file: 'linux-x86_64.AppImage', system: 'Linux, AppImage' },
  { file: 'linux-amd64.deb', system: 'Linux, deb (Debian, Ubuntu)' },
  { file: 'android.apk', system: 'Android (phone app / 手机 App)' },
]
export const SUMS = 'SHA256SUMS.txt'
// The table sits between these, so a second run replaces it instead of adding another.
const START = '<!-- downloads -->'
const END = '<!-- /downloads -->'

export const packageName = (version, entry) => `DS-Bot-${version}-${entry.file}`
export const copyName = entry => `DS-Bot-${entry.file}`

/** @returns {string[]} the required packages of `version` that are not among `names` */
export function missingPackages(version, names, { optionalFiles = [] } = {}) {
  const have = new Set(names)
  const optional = new Set(optionalFiles)
  return PACKAGES
    .filter(entry => !optional.has(entry.file))
    .map(entry => packageName(version, entry))
    .filter(name => !have.has(name))
}

export function formatSize(bytes) {
  return `${String(Math.max(1, Math.round(bytes / 1024 ** 2)))} MB`
}

export function releaseUrl({ repo = REPO, version, name }) {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`
}

function mirrorUrl(mirror, name) {
  return `${mirror.replace(/\/+$/u, '')}/${encodeURIComponent(name)}`
}

function mirrorBaseForVersion(mirror, currentVersion, targetVersion) {
  if (!mirror || currentVersion === targetVersion) return mirror
  const cleanCurrent = String(currentVersion).replace(/^v/u, '')
  const cleanTarget = String(targetVersion).replace(/^v/u, '')
  const escaped = cleanCurrent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // Rewrite versioned mirror path segment (e.g. .../v0.4.2 -> .../v0.4.0) so reused
  // historical packages never 404 under the current release's mirror folder.
  const versionSegment = new RegExp(`(/v?)${escaped}(?=/|$)`, 'u')
  return versionSegment.test(mirror) ? mirror.replace(versionSegment, `$1${cleanTarget}`) : mirror
}

/**
 * Render the Markdown download table block.
 * - `sizes`: bytes by package name for packages attached to `version`.
 * - `externalPackages`: map of `entry.file` -> `{ version, size?, mirror? }` for packages reused unchanged from an earlier release (e.g. Android APK during desktop-only hotfixes).
 * - `pendingPackages`: iterable of `entry.file` currently building asynchronously (e.g. `mac-x64.zip`).
 */
export function downloadBlock({
  version,
  sizes = {},
  repo = REPO,
  mirror,
  externalPackages = {},
  pendingPackages = [],
}) {
  const pendingSet = new Set(pendingPackages)
  const links = (targetVersion, name, customMirror) => {
    const github = releaseUrl({ repo, version: targetVersion, name })
    const effectiveMirror = customMirror ?? mirrorBaseForVersion(mirror, version, targetVersion)
    return effectiveMirror
      ? `${name}: [Mirror / 国内镜像](${mirrorUrl(effectiveMirror, name)}) · [GitHub](${github})`
      : `[${name}](${github})`
  }
  const rows = PACKAGES.map((entry) => {
    const system = entry.note === undefined ? entry.system : `${entry.system}<br>${entry.note}`
    const name = packageName(version, entry)
    if (sizes[name] !== undefined) {
      return `| ${system} | ${links(version, name)} | ${formatSize(sizes[name])} |`
    }
    const ext = externalPackages?.[entry.file]
    if (ext && typeof ext.version === 'string' && ext.version.trim() !== '') {
      const extVersion = ext.version.trim().replace(/^v/u, '')
      const extName = packageName(extVersion, entry)
      const sizeCell = Number.isFinite(ext.size) && ext.size > 0 ? formatSize(ext.size) : '—'
      return `| ${system} | ${links(extVersion, extName, ext.mirror)} *(unchanged since v${extVersion} / 同 v${extVersion})* | ${sizeCell} |`
    }
    if (pendingSet.has(entry.file)) {
      return `| ${system} | Building… / 构建中… | — |`
    }
    return `| ${system} | ${links(version, name)} | ${formatSize(sizes[name])} |`
  })
  const sums = releaseUrl({ repo, version, name: SUMS })
  return [
    START,
    '## Download / 下载',
    '',
    '| System / 系统 | Download / 下载 | Size / 大小 |',
    '|---|---|---|',
    ...rows,
    '',
    'The `.blockmap`, `latest*.yml` and `ds-bot-*.tgz` files and the source code archives are for updates and the plugin: you do not need to download them.',
    '',
    '`.blockmap`、`latest*.yml`、`ds-bot-*.tgz` 和源代码是给自动更新和插件用的，不用下载。',
    '',
    `To check a download, compare its SHA-256 with [${SUMS}](${sums}). / 下载后可以用 [${SUMS}](${sums}) 核对 SHA-256。`,
    END,
  ].join('\n')
}

/** `hashes`: SHA-256 hex by package name. Lists only packages actually present in `hashes`, never fabricating checksums for omitted/external/pending files. */
export function checksums(version, hashes) {
  const lines = PACKAGES.flatMap((entry) => {
    const name = packageName(version, entry)
    const hash = hashes[name]
    if (typeof hash !== 'string' || hash === '') return []
    return [`${hash}  ${name}`, `${hash}  ${copyName(entry)}`]
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** The release notes with `block` on top, in place of a table from an earlier run. */
export function withDownloads(notes, block) {
  const start = notes.indexOf(START)
  const end = notes.indexOf(END, start)
  const rest = start === -1 || end === -1 ? notes : notes.slice(0, start) + notes.slice(end + END.length)
  const body = rest.trim()
  return body === '' ? `${block}\n` : `${block}\n\n${body}\n`
}

/** Parse `<file>=<version>[:<sizeBytes>]` CLI specs into `{ file, version, size }`. */
export function parseExternalPackageSpec(raw) {
  const match = /^([A-Za-z0-9._-]+)=v?([0-9A-Za-z._-]+)(?::(\d+))?$/u.exec(String(raw || '').trim())
  if (match === null) {
    throw new Error(`Invalid --external-package value "${String(raw)}"; expected <file>=<version>[:<sizeBytes>]`)
  }
  const file = match[1]
  if (!PACKAGES.some(entry => entry.file === file)) {
    throw new Error(`Unknown package key "${file}" in --external-package`)
  }
  const version = match[2]
  const size = match[3] !== undefined ? Number(match[3]) : undefined
  return { file, version, ...(size !== undefined ? { size } : {}) }
}

export function parseCliArgs(argv) {
  const positional = []
  const externalPackages = {}
  const pendingPackages = []
  let writeManifest = null
  let mergeManifest = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--external-package') {
      const spec = parseExternalPackageSpec(argv[++i])
      externalPackages[spec.file] = { version: spec.version, ...(spec.size !== undefined ? { size: spec.size } : {}) }
    } else if (arg === '--pending') {
      const file = String(argv[++i] || '').trim()
      if (!PACKAGES.some(entry => entry.file === file)) {
        throw new Error(`Unknown package key "${file}" in --pending`)
      }
      pendingPackages.push(file)
    } else if (arg === '--write-manifest') {
      writeManifest = argv[++i] ?? null
    } else if (arg === '--merge-manifest') {
      mergeManifest = argv[++i] ?? null
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  return {
    version: positional[0],
    from: positional[1],
    to: positional[2],
    notesFile: positional[3],
    externalPackages,
    pendingPackages,
    writeManifest,
    mergeManifest,
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main(argv) {
  let opts
  try {
    opts = parseCliArgs(argv)
  } catch (err) {
    console.error(`release-notes: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const { version, from, to, notesFile, writeManifest, mergeManifest } = opts
  if (!version || !from || !to) {
    console.error('release-notes: usage: node scripts/release-notes.mjs <version> <folder with the packages> <folder for the files to attach> [<current notes>]')
    process.exit(2)
  }

  let baseSizes = {}
  let baseHashes = {}
  let baseExternal = {}
  if (mergeManifest) {
    const loaded = JSON.parse(readFileSync(mergeManifest, 'utf8'))
    if (loaded.version && loaded.version !== version) {
      console.error(`release-notes: manifest version ${loaded.version} does not match ${version}`)
      process.exit(1)
    }
    baseSizes = { ...(loaded.sizes ?? {}) }
    baseHashes = { ...(loaded.hashes ?? {}) }
    baseExternal = { ...(loaded.externalPackages ?? {}) }
  }

  const externalPackages = { ...baseExternal, ...opts.externalPackages }
  const presentInFrom = new Set(readdirSync(from))
  const knownNames = new Set([...presentInFrom, ...Object.keys(baseSizes)])
  const optionalFiles = [...Object.keys(externalPackages), ...opts.pendingPackages]
  const missing = missingPackages(version, [...knownNames], { optionalFiles })
  if (missing.length > 0) {
    console.error(`release-notes: ${from} has no ${missing.join(', ')}`)
    process.exit(1)
  }

  mkdirSync(to, { recursive: true })
  const sizes = { ...baseSizes }
  const hashes = { ...baseHashes }

  await Promise.all(PACKAGES.map(async (entry) => {
    const name = packageName(version, entry)
    if (!presentInFrom.has(name)) return
    const source = join(from, name)
    sizes[name] = statSync(source).size
    const [hash] = await Promise.all([
      sha256(source),
      copyFile(source, join(to, copyName(entry))),
    ])
    hashes[name] = hash
    delete externalPackages[entry.file]
  }))

  writeFileSync(join(to, SUMS), checksums(version, hashes))

  if (writeManifest) {
    const dir = dirname(resolve(writeManifest))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(writeManifest, `${JSON.stringify({ version, sizes, hashes, externalPackages }, null, 2)}\n`)
  }

  const effectivePending = opts.pendingPackages.filter((file) => {
    const entry = PACKAGES.find(p => p.file === file)
    return entry ? sizes[packageName(version, entry)] === undefined : false
  })

  const block = downloadBlock({
    version,
    sizes,
    repo: process.env.GITHUB_REPOSITORY || REPO,
    mirror: process.env.MIRROR_BASE || undefined,
    externalPackages,
    pendingPackages: effectivePending,
  })
  process.stdout.write(withDownloads(notesFile === undefined ? '' : readFileSync(notesFile, 'utf8'), block))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
