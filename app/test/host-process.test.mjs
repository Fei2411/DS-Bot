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

// The engine's own report of a failed start is on the Host's stderr; the
// error box gets its tail with the message (#516).
test('withLogTail attaches the stderr tail so the real cause reaches the box', () => {
  const stderr = 'dsh: warning: 7 entries did not activate\n'
    + '  workspace (@deepseek-ai/dsh-workspace): Error: corrupt session log "/data/sessions/_deleted/s1/session.v4.jsonl.zstd": header id "s1" and cwd identify "/data/sessions/ws/s1/session.v4.jsonl.zstd"\n'
    + '  session-controller: pending (waiting for service: workspaceRegistry)\n'
  const message = host.withLogTail('The profile in /data did not start sessionController, workspaceRegistry; the engine log has the cause', stderr)
  assert.match(message, /^The profile in \/data did not start sessionController, workspaceRegistry/)
  assert.match(message, /corrupt session log "\/data\/sessions\/_deleted\/s1\/session\.v4\.jsonl\.zstd"/)
})

test('withLogTail redacts launch tokens and skips an empty tail', () => {
  assert.equal(
    host.withLogTail('The DSH Host stopped (exit 1)', 'launch http://127.0.0.1:43117/?token=abc123 other'),
    'The DSH Host stopped (exit 1):\nlaunch http://127.0.0.1:43117/?token=<hidden> other')
  assert.equal(host.withLogTail('The DSH Host stopped (exit 0)', '   \n'), 'The DSH Host stopped (exit 0)')
})
