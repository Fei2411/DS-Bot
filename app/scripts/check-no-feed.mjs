// A build of this fork must carry no update feed. `publish` is gone from electron-builder.yml
// for exactly that reason, so resources/app-update.yml cannot exist in a package — and with no
// feed file the installed app has nowhere to look for an upstream release. This check notices
// the moment either one comes back, before the package reaches the install script.
// Usage: node scripts/check-no-feed.mjs (after npm run pack / npm run dist)
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-pack')

if (!existsSync(out)) {
  console.error('check-no-feed: no dist-pack yet. Run npm run pack or npm run dist first.')
  process.exit(2)
}

const found = []

// Every packaged app puts its resources beside the executable.
for (const entry of readdirSync(out, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'build') continue
  const resources = join(out, entry.name, 'resources')
  for (const name of ['app-update.yml', 'app-update.yaml', 'app-update.json']) {
    const path = join(resources, name)
    if (existsSync(path)) found.push(relative(root, path))
  }
}

// Electron-builder writes latest.yml (and a channel file) next to an installer, never by itself.
for (const name of readdirSync(out)) {
  if (name === 'builder-debug.yml' || name === 'builder-effective-config.yaml') continue
  if (name.endsWith('.yml') || name.endsWith('.yaml')) found.push(relative(root, join(out, name)))
}

if (found.length > 0) {
  console.error(`check-no-feed: FAILED: this build would offer an update feed:\n  ${found.join('\n  ')}`)
  console.error('check-no-feed: electron-builder.yml must keep no publish block (see its comment).')
  process.exit(1)
}

console.log('check-no-feed: ok, the package carries no update feed')
