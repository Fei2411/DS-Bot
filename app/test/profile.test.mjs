import { LEGACY_ENGINE } from '../src/legacy.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { BUNDLES, claimBundles, loadAppProfile } from '../src/profile.mjs'

// Packages of DSH's own Web front end and its browser runtime, which the desktop app must never load.
// Also forbids dsh-host-directory-picker-auto, which dynamically loads dsh-client-ui-directory-picker-* at runtime.
// Note: @deepseek-ai/dsh-experimental-voice-input-bundle carries a no-op stub `ui-voice-input` (empty `apply()`)
// alongside the host SenseVoice/ASR service; no browser surface is served.
const DSH_WEB_FRONT_END = /^@deepseek-ai\/dsh-(client-ui-|web-app|web-frontend|client-modules|host-frontend-static|cordis-client-runner|client-hmr|host-directory-picker-auto)/u

// Every row of an entry list, with the rows inside groups and agent presets.
function rows(entries) {
  return entries.flatMap((entry) => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

describe('the app profile', () => {
  let home
  let entries
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-profile-'))
    process.env.DSH_HOME = home
    const profile = loadAppProfile()
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), BUNDLES)
    assert.deepEqual(profile.skippedBundles, [])
    entries = composeEntries([...profile.layers.map((layer) => layer.patches), profile.patches])
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('mounts dsbot-engine and the Bot team with zero DSH Web front-end rows', () => {
    const on = new Set(entries.filter((entry) => entry.disabled !== true).map((entry) => entry.id))
    for (const id of [
      'webserver', 'connection', 'engine-index', 'workspace', 'workspace-changes',
      'session-controller', 'cordis-host-runner', 'cordis-inspect-providers',
      'session-stats', 'session-turn-outline', 'agent-preset-registry',
      'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis', 'bot',
    ]) assert.ok(on.has(id), `${id} is mounted`)
    const leaked = rows(entries)
      .filter((entry) => entry.disabled !== true && DSH_WEB_FRONT_END.test(entry.name ?? ''))
      .map((entry) => `${entry.id}:${entry.name}`)
    assert.deepEqual(leaked, [], 'no DSH Web front-end rows are mounted in the desktop app profile')
  })
})

describe('claimBundles', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-bot-app-bundles-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (bundles) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-bot', private: true, dependencies: { 'a-plugin': '1.0.0' }, dsh: { profile: { bundles } } }, undefined, 2)}\n`)
  }
  const read = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  test('puts the app bundles first, keeps the user bundles and drops the retired ones (including dsh-web-app)', () => {
    write(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', LEGACY_ENGINE, 'ds-bot', 'a-plugin'])
    claimBundles(dir)
    assert.deepEqual(read().dsh.profile.bundles, [...BUNDLES, 'a-plugin'])
    assert.deepEqual(read().dependencies, { 'a-plugin': '1.0.0' })
  })

  test('leaves a profile that already lists them alone', () => {
    write([...BUNDLES, 'a-plugin'])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    claimBundles(dir)
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
  })
})
