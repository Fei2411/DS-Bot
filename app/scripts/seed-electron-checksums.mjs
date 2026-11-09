// Write Electron's checksums where electron-builder looks for them before it downloads SHASUMS256.txt.
// Even with the Electron zip in its cache, @electron/get fetches SHASUMS256.txt from GitHub releases
// on every build to check the zip. electron-builder skips that fetch when the cache root holds
// SHASUMS256.txt-<version>. The checksums come from the installed electron package, which npm
// checked against the lock file.
// Usage: node scripts/seed-electron-checksums.mjs (after npm ci)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const electron = new URL('../node_modules/electron/', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', electron), 'utf8'))
const checksums = JSON.parse(readFileSync(new URL('checksums.json', electron), 'utf8'))

// @electron/get's default cache root; electron-builder downloads Electron with no other.
const root = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'electron')
  : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron')

mkdirSync(root, { recursive: true })
const file = join(root, `SHASUMS256.txt-${version}`)
writeFileSync(file, Object.entries(checksums).map(([name, sum]) => `${sum} *${name}\n`).join(''))
console.log(`${Object.keys(checksums).length} checksums of Electron ${version} in ${file}`)
