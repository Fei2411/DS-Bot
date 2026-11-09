import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { downloadArchive, primaryRuntimeManifest, runtimeReusable, runtimeTarget } from '../scripts/prepare-runtime.mjs'

/** An answer the download can read, standing in for fetch's Response. */
function answer(status, body = '') {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer }
}

/** Collect what the download logs, and stop the retry delays from being real. */
function recorder() {
  const logged = []
  const delays = []
  const original = { warn: console.warn, error: console.error }
  console.warn = (line) => { logged.push(`warn ${String(line)}`) }
  console.error = (line) => { logged.push(`error ${String(line)}`) }
  return {
    logged,
    delays,
    sleepImpl: async (ms) => { delays.push(ms) },
    restore: () => { console.warn = original.warn; console.error = original.error },
  }
}

describe('downloadArchive', () => {
  const url = 'https://example.invalid/archive.tar.gz'

  test('retries a gateway error with the configured backoff and returns the bytes', async () => {
    const log = recorder()
    try {
      const answers = [answer(504), answer(502), answer(200, 'payload')]
      const bytes = await downloadArchive(url, 1000, {
        fetchImpl: async () => answers.shift(),
        sleepImpl: log.sleepImpl,
      })
      assert.equal(bytes.toString(), 'payload')
      assert.deepEqual(log.delays, [5000, 20000])
      assert.equal(log.logged.length, 2)
      assert.match(log.logged[0], /attempt 1\/4 failed/u)
      assert.match(log.logged[0], /504/u)
    } finally { log.restore() }
  })

  test('gives up after three retries and reports every attempt', async () => {
    const log = recorder()
    try {
      let calls = 0
      await assert.rejects(
        downloadArchive(url, 1000, { fetchImpl: async () => { calls += 1; return answer(504) }, sleepImpl: log.sleepImpl }),
        /504/u,
      )
      assert.equal(calls, 4)
      assert.deepEqual(log.delays, [5000, 20000, 60000])
      assert.equal(log.logged.length, 4)
      assert.match(log.logged[3], /attempt 4\/4 failed, giving up/u)
    } finally { log.restore() }
  })

  test('does not retry a refusal the next attempt cannot change', async () => {
    const log = recorder()
    try {
      let calls = 0
      await assert.rejects(
        downloadArchive(url, 1000, { fetchImpl: async () => { calls += 1; return answer(404) }, sleepImpl: log.sleepImpl }),
        /404/u,
      )
      assert.equal(calls, 1)
      assert.deepEqual(log.delays, [])
      assert.match(log.logged[0], /giving up/u)
    } finally { log.restore() }
  })

  test('retries a dropped connection', async () => {
    const log = recorder()
    try {
      let calls = 0
      const bytes = await downloadArchive(url, 1000, {
        fetchImpl: async () => {
          calls += 1
          if (calls === 1) throw new TypeError('fetch failed')
          return answer(200, 'payload')
        },
        sleepImpl: log.sleepImpl,
      })
      assert.equal(bytes.toString(), 'payload')
      assert.equal(calls, 2)
      assert.deepEqual(log.delays, [5000])
      assert.match(log.logged[0], /TypeError: fetch failed/u)
    } finally { log.restore() }
  })
})

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
