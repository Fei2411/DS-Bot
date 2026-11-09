// Run separately: an unhandled spawn error must fail this subprocess, not the test host.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpEngine } from '../../src/host/local-agents/acp.js'
import { CodexEngine } from '../../src/host/local-agents/codex.js'

const [kind, failure] = process.argv.slice(2)
const root = mkdtempSync(join(tmpdir(), 'dsbot-startup-'))
let command = join(root, 'broken-cli')
if (failure === 'interpreter') writeFileSync(command, `#!${join(root, 'missing-runtime')}\n`, { mode: 0o755 })
if (failure === 'permission') writeFileSync(command, '#!/bin/sh\n', { mode: 0o644 })
const Engine = kind === 'acp' ? AcpEngine : CodexEngine
const fixture = fileURLToPath(new URL(`./fake-${kind}.mjs`, import.meta.url))
const engine = new Engine('local-test', { name: 'Test CLI', command: 'test', args: [fixture] }, { findExecutable: () => command })
try {
  const attempts = await Promise.allSettled([engine.ensure(), engine.ensure()])
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected')
    assert.equal(attempt.reason.code, 'LOCAL_AGENT_EXIT')
    assert.equal(attempt.reason.cause.code, failure === 'permission' ? 'EACCES' : 'ENOENT')
  }
  assert.equal(engine.peer, undefined)
  assert.equal(engine.child, undefined)
  command = process.execPath
  const session = await engine.open('recovered', { cwd: root })
  assert.ok(kind === 'acp' ? session.acpSessionId : session.threadId)
  process.stdout.write('recovered\n')
} finally {
  await engine.close()
  rmSync(root, { recursive: true, force: true })
}
