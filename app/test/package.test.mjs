import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { parse } from 'yaml'

// npm installs the peers that the DSH packages ask for, but electron-builder packs only the
// dependencies it finds through `dependencies` and `optionalDependencies`. A package that npm
// installed only as a peer would be left out of the installer, and the Host would not boot.
test('every package that the app runs on is a dependency, not only a peer', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const peerOnly = Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && entry.peer && !entry.dev && !entry.devOptional)
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//u, '')}@${entry.version}`)
  assert.deepEqual(peerOnly, [], `add these to "dependencies" in app/package.json: ${peerOnly.join(' ')}`)
})

test('sharp native modules and versioned libvips libraries are unpacked together', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const root = resolve('app-fixture')
  const filter = new FileMatcher(root, root, value => value, config.asarUnpack).createFilter()
  const stat = { isDirectory: () => false }
  for (const file of [
    '@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node',
    '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-linux-arm64/lib/sharp-linux-arm64.node',
    '@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
    '@img/sharp-win32-x64/lib/libvips-42.dll',
    'pnpm/bin/pnpm.cjs',
  ]) assert.equal(filter(join(root, 'node_modules', file), stat), true, file)
  assert.equal(filter(join(root, 'node_modules/yaml/dist/index.js'), stat), false)
})

// A release is tagged with the version of ds-bot, and the installed apps compare their own
// version with the one in the release's latest.yml.
test('the app has the version of ds-bot', () => {
  const version = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).version
  assert.equal(version('../package.json'), version('../../ds-bot/package.json'))
})
