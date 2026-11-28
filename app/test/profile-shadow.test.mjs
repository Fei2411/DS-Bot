import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  composeEntries,
  createRuntimeResolution,
  getDshRuntimeVersion,
  PluginPackages,
  prepareProfileEntries,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { BUNDLES, INSTALL_ANCHOR, loadAppProfile, PROFILE, RETIRED_BUNDLES } from '../src/profile.mjs'
import { bundledOfficialPackages, formatShadowedNames, removeShadowed, shadowedBundles } from '../src/profile-shadow.mjs'

const OWN = ['@deepseek-ai/dsh-base', 'ds-bot']

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-shadow-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}

const plant = (dir, name, version) => {
  const pkg = join(dir, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version }))
}

const profile = (dir, deps) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'ds-bot-profile', dependencies: deps }, null, 2)}\n`)

test('a profile-installed bundle is detected with its own version', (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(dir, 'other-plugin', '1.0.0')
  assert.deepEqual(shadowedBundles(dir, OWN), [{ name: 'ds-bot', version: '0.2.7' }])
})

test('no manifest, missing package and foreign dependencies are not shadows', (t) => {
  const dir = folder(t)
  assert.deepEqual(shadowedBundles(dir, OWN), [])
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  // Declared but not on disk: nothing resolves from it.
  assert.deepEqual(shadowedBundles(dir, OWN), [])
  plant(dir, 'other-plugin', '1.0.0')
  assert.deepEqual(shadowedBundles(dir, OWN), [])
})

test('removal drops the dependency row and the profile link, and leaves the pnpm store alone', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', 'other-plugin': '1.0.0' })
  plant(dir, 'other-plugin', '1.0.0')
  const store = join(dir, 'node_modules', '.pnpm', 'ds-bot@0.2.7', 'node_modules', 'ds-bot')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7' }))
  symlinkSync(store, join(dir, 'node_modules', 'ds-bot'), 'junction')
  assert.equal(shadowedBundles(dir, OWN).length, 1)
  await removeShadowed(dir, ['ds-bot'])
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'other-plugin': '1.0.0' })
  assert.equal(existsSync(join(dir, 'node_modules', 'ds-bot')), false)
  // Another package may still link into the store entry.
  assert.equal(existsSync(join(store, 'package.json')), true)
  assert.equal(existsSync(join(dir, 'node_modules', 'other-plugin')), true)
  assert.deepEqual(shadowedBundles(dir, OWN), [])
})

test('a plain copy and the engine fallback copy are removed', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(join(dir, '.dsh-module-fallback'), 'ds-bot', '0.2.7')
  await removeShadowed(dir, ['ds-bot'])
  assert.equal(existsSync(join(dir, 'node_modules', 'ds-bot')), false)
  assert.equal(existsSync(join(dir, '.dsh-module-fallback', 'node_modules', 'ds-bot')), false)
})

test('a failed removal throws and keeps the dependency row, so the copy is found again', async (t) => {
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7' })
  plant(dir, 'ds-bot', '0.2.7')
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('read-only folders do not block removal here'); return }
  // A file inside a read-only folder cannot be unlinked.
  const pkg = join(dir, 'node_modules', 'ds-bot')
  chmodSync(pkg, 0o555)
  try { await assert.rejects(removeShadowed(dir, ['ds-bot'])) } finally { chmodSync(pkg, 0o755) }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'ds-bot': '0.2.7' })
  assert.equal(shadowedBundles(dir, OWN).length, 1)
})

test('a failure on a later name keeps only the rows of the packages that are still there', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('read-only folders do not block removal here'); return }
  const dir = folder(t)
  profile(dir, { 'ds-bot': '0.2.7', '@deepseek-ai/dsh-base': '1.0.0' })
  plant(dir, 'ds-bot', '0.2.7')
  plant(dir, '@deepseek-ai/dsh-base', '1.0.0')
  const stuck = join(dir, 'node_modules', '@deepseek-ai', 'dsh-base')
  chmodSync(stuck, 0o555)
  try { await assert.rejects(removeShadowed(dir, ['ds-bot', '@deepseek-ai/dsh-base'])) } finally { chmodSync(stuck, 0o755) }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh-base': '1.0.0' })
  assert.deepEqual(shadowedBundles(dir, OWN).map(entry => entry.name), ['@deepseek-ai/dsh-base'])
})

const plantWithManifest = (dir, name, pkg) => {
  const target = join(dir, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, ...pkg }))
}

test('detects and removes stale official DSH plugins (pinned, hoisted, fallback) and retired bundles', async (t) => {
  const dir = folder(t)
  const official = bundledOfficialPackages(INSTALL_ANCHOR)
  const runtimeVersion = getDshRuntimeVersion()
  assert.equal(official.get('@deepseek-ai/dsh-tool-subagent'), runtimeVersion)

  profile(dir, {
    '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.4',
    '@deepseek-ai/dsh-web-app': '0.2.1-rc.4',
    'other-plugin': '1.0.0',
  })
  // Pinned stale official plugin + retired bundle + hoisted stale official plugin (not in package.json) + matching-version official plugin + non-bundled official plugin.
  plantWithManifest(dir, '@deepseek-ai/dsh-tool-subagent', {
    version: '0.2.1-rc.4',
    peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.4' },
  })
  plant(dir, '@deepseek-ai/dsh-web-app', '0.2.1-rc.4')
  plantWithManifest(dir, '@deepseek-ai/dsh-schedule', {
    version: '0.2.1-rc.4',
    peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.4' },
  })
  plant(dir, '@deepseek-ai/dsh-tool-todo', runtimeVersion)
  plant(dir, '@deepseek-ai/dsh-not-bundled-xyz', '0.1.0')
  plant(dir, 'other-plugin', '1.0.0')

  const found = shadowedBundles(dir, BUNDLES, {
    retiredNames: RETIRED_BUNDLES,
    bundledOfficial: official,
    runtimeVersion,
  })
  assert.deepEqual(found, [
    { name: '@deepseek-ai/dsh-web-app', version: '0.2.1-rc.4' },
    { name: '@deepseek-ai/dsh-schedule', version: '0.2.1-rc.4' },
    { name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.1-rc.4' },
  ])

  await removeShadowed(dir, found.map(entry => entry.name))
  const saved = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(saved.dependencies, { 'other-plugin': '1.0.0' })
  assert.equal(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent')), false)
  assert.equal(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-schedule')), false)
  assert.equal(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app')), false)
  assert.equal(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tool-todo')), true)
  assert.equal(existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-not-bundled-xyz')), true)
  assert.deepEqual(shadowedBundles(dir, BUNDLES, {
    retiredNames: RETIRED_BUNDLES,
    bundledOfficial: official,
    runtimeVersion,
  }), [])
})

test('formatShadowedNames collapses long lists cleanly', () => {
  assert.equal(
    formatShadowedNames([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }]),
    'a 1.0.0, b 2.0.0',
  )
  assert.equal(
    formatShadowedNames([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
      { name: 'c', version: '3.0.0' },
      { name: 'd', version: '4.0.0' },
      { name: 'e', version: '5.0.0' },
    ]),
    'a 1.0.0, b 2.0.0, c 3.0.0 (+2)',
  )
})

test('real dsh-app-boot contract: removing shadowed dsh-tool-subagent@0.2.1-rc.4 restores disabled subagent rows', async (t) => {
  const home = folder(t)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  const profileDir = resolveProfileDir(PROFILE, home)
  loadAppProfile()
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), '@deepseek-ai/dsh-tool-subagent': '0.2.1-rc.4' }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  plantWithManifest(profileDir, '@deepseek-ai/dsh-tool-subagent', {
    version: '0.2.1-rc.4',
    exports: {
      '.': './index.js',
      './model-selection-settings': './settings.js',
    },
    peerDependencies: {
      '@deepseek-ai/dsh-agent': '0.2.1-rc.4',
      '@deepseek-ai/dsh-tools': '0.2.1-rc.4',
    },
  })

  const collectRows = (entries) => entries.flatMap(entry => [
    entry,
    ...collectRows(Array.isArray(entry.config) ? entry.config : []),
    ...collectRows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])

  const preflightApp = async () => {
    const loaded = loadAppProfile()
    const entries = composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches])
    const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile: loaded, home })
    const ctx = new Context()
    ctx.provide('profileContext')
    ctx.profileContext = { dir: loaded.dir, name: PROFILE, home }
    const fiber = ctx.plugin(PluginPackages, { resolution })
    try {
      const parentURL = pathToFileURL(join(loaded.dir, 'cordis.patch.yml')).href
      // Check host entries and the standard preset's plugins just as DSH does on startup.
      const hostRows = prepareProfileEntries(ctx, entries, parentURL, 'dsh')
      const standardPreset = hostRows.find(row => row.id === 'preset-standard')
      const presetRows = prepareProfileEntries(ctx, standardPreset.config.plugins, parentURL, 'dsh')
      return {
        settingsRow: hostRows.find(row => row.id === 'subagent-model-selection-settings'),
        presetSubagent: collectRows(presetRows).find(row => row.id === 'tool-subagent'),
        presetFork: collectRows(presetRows).find(row => row.id === 'tool-subagent-fork'),
      }
    } finally {
      await fiber.dispose()
    }
  }

  // Before cleanup: DSH disables all three rows due to the stale profile copy.
  const before = await preflightApp()
  assert.equal(before.settingsRow?.disabled, true, 'stale profile copy must disable subagent-model-selection-settings')
  assert.equal(before.presetSubagent?.disabled, true, 'stale profile copy must disable tool-subagent')
  assert.equal(before.presetFork?.disabled, true, 'stale profile copy must disable tool-subagent-fork')

  // Detect and remove via profile-shadow.
  const shadowed = shadowedBundles(profileDir, BUNDLES, {
    retiredNames: RETIRED_BUNDLES,
    bundledOfficial: bundledOfficialPackages(INSTALL_ANCHOR),
    runtimeVersion: getDshRuntimeVersion(),
  })
  assert.deepEqual(shadowed, [{ name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.1-rc.4' }])
  await removeShadowed(profileDir, shadowed.map(entry => entry.name))

  // After cleanup: DSH resolves @deepseek-ai/dsh-tool-subagent from the bundled app installation and keeps all three enabled.
  const after = await preflightApp()
  assert.notEqual(after.settingsRow?.disabled, true, 'subagent-model-selection-settings must be enabled after cleanup')
  assert.notEqual(after.presetSubagent?.disabled, true, 'tool-subagent must be enabled after cleanup')
  assert.notEqual(after.presetFork?.disabled, true, 'tool-subagent-fork must be enabled after cleanup')
})
