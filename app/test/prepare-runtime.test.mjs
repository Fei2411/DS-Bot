import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { primaryRuntimeManifest, runtimeReusable, runtimeTarget } from '../scripts/prepare-runtime.mjs'

describe('runtimeTarget', () => {
  test('maps the platforms electron-builder packs for to the lock\'s targets', () => {
    assert.equal(runtimeTarget('win32', 'x64'), 'win-x64')
    assert.equal(runtimeTarget('darwin', 'x64'), 'mac-x64')
    assert.equal(runtimeTarget('darwin', 'arm64'), 'mac-arm64')
    assert.equal(runtimeTarget('linux', 'x64'), 'linux-x64')
    assert.equal(runtimeTarget('linux', 'arm64'), 'linux-arm64')
    assert.equal(runtimeTarget('win32', 'arm64'), undefined)
    assert.equal(runtimeTarget('freebsd', 'x64'), undefined)
  })
})

describe('primaryRuntimeManifest', () => {
  test('carries the platform, both interpreters and the locked wheels, but no pnpm', () => {
    const manifest = primaryRuntimeManifest('win-x64', '0.2.2')
    assert.equal(manifest.platform, 'win32')
    assert.equal(manifest.arch, 'x64')
    assert.equal(manifest.desktopVersion, '0.2.2')
    assert.match(manifest.payloadDigest, /^[a-f0-9]{64}$/u)
    assert.match(manifest.node, /^\d+\.\d+\.\d+$/u)
    assert.equal('pnpm' in manifest, false)
    assert.match(manifest.python, /^\d+\.\d+\.\d+$/u)
    assert.equal(manifest.pythonPackages['python-docx'], '1.2.0')
    // The tool validates the manifest the same way it reads one from a prepared payload.
    assert.deepEqual(parsePrimaryRuntime(manifest).payloadDigest, manifest.payloadDigest)
  })

  test('maps mac and linux targets to the manifest platform names', () => {
    assert.deepEqual([primaryRuntimeManifest('mac-arm64', '1').platform, primaryRuntimeManifest('mac-arm64', '1').arch], ['darwin', 'arm64'])
    assert.deepEqual([primaryRuntimeManifest('linux-x64', '1').platform, primaryRuntimeManifest('linux-x64', '1').arch], ['linux', 'x64'])
  })

  test('changes the digest with the target', () => {
    assert.notEqual(primaryRuntimeManifest('mac-x64', '1').payloadDigest, primaryRuntimeManifest('mac-arm64', '1').payloadDigest)
  })
})

describe('runtimeReusable', () => {
  const target = runtimeTarget(process.platform, process.arch)
  const manifest = primaryRuntimeManifest(target ?? 'win-x64', '1.0.0')
  let output
  let root
  before(() => {
    output = mkdtempSync(join(tmpdir(), 'ds-bot-runtime-'))
    root = join(output, 'primary-runtime')
  })
  after(() => { rmSync(output, { recursive: true, force: true }) })

  test('is false without a payload, true with a complete one, false on a digest change', () => {
    assert.equal(runtimeReusable(output, manifest), false)
    const entries = workspaceDependencyPaths(root, manifest)
    for (const path of [entries.python, entries.node]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    mkdirSync(entries.pythonPackages, { recursive: true })
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(manifest))
    assert.equal(runtimeReusable(output, manifest), true)
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({ ...manifest, payloadDigest: '0'.repeat(64) }))
    assert.equal(runtimeReusable(output, manifest), false)
  })
})
