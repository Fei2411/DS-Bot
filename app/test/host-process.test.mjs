import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as host from '../src/host-process.mjs'

test('Linux uses the bundled plain Node, not Electron in Node mode', () => {
  const resources = join('application', 'resources')
  assert.equal(host.hostExecutable(resources, 'linux'), join(resources, 'primary-runtime', 'dependencies', 'node', 'bin', 'node'))
  for (const platform of ['darwin', 'win32']) {
    assert.equal(host.hostExecutable(resources, platform), process.execPath)
  }
})

test('the Linux Host loads sharp only in its plain Node child', { skip: process.platform === 'win32' }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-linux-image-'))
  const node = join(work, 'primary-runtime', 'dependencies', 'node', 'bin', 'node')
  mkdirSync(dirname(node), { recursive: true })
  symlinkSync(process.execPath, node)
  const app = dirname(dirname(fileURLToPath(import.meta.url)))
  const failures = []
  const child = new host.HostProcess({
    entry: join(app, 'test', 'fixtures', 'image-host.mjs'),
    cwd: work,
    env: { ...process.env, DS_BOT_RUNTIME_DIR: work },
    pnpm: join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    onFailure: error => failures.push(error),
  }, 'linux')
  try {
    const { injections } = await child.start()
    assert.deepEqual(injections, [{ executable: node, electron: null, width: 2, height: 2 }])
    assert.equal(Object.keys(createRequire(import.meta.url).cache).some(file => /[/\\]sharp[/\\]/u.test(file)), false)
    assert.deepEqual(failures, [])
  } finally {
    await child.stop()
    rmSync(work, { recursive: true, force: true })
  }
})
