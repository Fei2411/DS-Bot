import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withLogTail } from '../src/host-process.mjs'

// The engine's own report of a failed start is on the Host's stderr; the
// error box gets its tail with the message (#516).
test('withLogTail attaches the stderr tail so the real cause reaches the box', () => {
  const stderr = 'dsh: warning: 7 entries did not activate\n'
    + '  workspace (@deepseek-ai/dsh-workspace): Error: corrupt session log "/data/sessions/_deleted/s1/session.v4.jsonl.zstd": header id "s1" and cwd identify "/data/sessions/ws/s1/session.v4.jsonl.zstd"\n'
    + '  session-controller: pending (waiting for service: workspaceRegistry)\n'
  const message = withLogTail('The profile in /data did not start sessionController, workspaceRegistry; the engine log has the cause', stderr)
  assert.match(message, /^The profile in \/data did not start sessionController, workspaceRegistry/)
  assert.match(message, /corrupt session log "\/data\/sessions\/_deleted\/s1\/session\.v4\.jsonl\.zstd"/)
})

test('withLogTail redacts launch tokens and skips an empty tail', () => {
  assert.equal(
    withLogTail('The DSH Host stopped (exit 1)', 'launch http://127.0.0.1:43117/?token=abc123 other'),
    'The DSH Host stopped (exit 1):\nlaunch http://127.0.0.1:43117/?token=<hidden> other')
  assert.equal(withLogTail('The DSH Host stopped (exit 0)', '   \n'), 'The DSH Host stopped (exit 0)')
})
