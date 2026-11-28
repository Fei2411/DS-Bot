import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function makeClaudeAdapter({ records = {}, claude, claudeArgs = [], claudeOpts = {} } = {}) {
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new ClaudeEngine(
      route,
      { ...spec, command: process.execPath, args: [claude, ...claudeArgs] },
      { findExecutable: path => path, ...claudeOpts },
    ),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => 'workspace-write',
    reviewFor: () => false,
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [],
  })
  return adapter
}

function options(sessionId, messages, extra = {}) {
  return {
    provider: 'local-claude-code',
    model: 'claude-sonnet',
    sessionId,
    messages,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  }
}

async function collect(stream) {
  let text = ''
  let finish
  let usage
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, finish, usage }
}

test('claude: completes turn and retires wedged child when stream-json omits result (#2382)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-no-result-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fixture = join(dir, 'fake-claude-no-result.mjs')
  writeFileSync(fixture, `
const resumeAt = process.argv.indexOf('--resume')
const resumed = resumeAt === -1 ? 'none' : process.argv[resumeAt + 1]
const sessionId = resumed === 'none' ? 'claude-2382-' + process.pid : resumed
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let turn = 0
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    turn += 1
    if (turn === 1) send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet' })
    const text = (msg.message?.content ?? []).map(b => b.text ?? '').join('\\n')
    const id = 'msg_' + process.pid + '_' + turn
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, usage: { input_tokens: 12, output_tokens: 1 } } } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply:' + text + ':resume=' + resumed } } })
    send({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: 'reply:' + text + ':resume=' + resumed }], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } })
    if (text.includes('hang-no-stop')) continue
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
    if (text.includes('hang-after-compact')) {
      send({ type: 'system', subtype: 'status', status: 'compacting' })
      setTimeout(() => send({ type: 'system', subtype: 'compact_boundary' }), 30)
      continue
    }
    if (text.includes('hang-no-result')) continue
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', usage: { input_tokens: 12, output_tokens: 7 } })
  }
})
`)
  const records = {}
  const adapter = makeClaudeAdapter({ records, claude: fixture, claudeOpts: { resultGraceMs: 60, resultFallbackMs: 120 } })
  t.after(() => adapter.dispose())

  // Turn 1: normal round-trip with result.
  const t1 = await collect(adapter.stream(options('s1', [user('m1', 'first')])))
  assert.equal(t1.finish?.kind, 'stop')
  assert.match(t1.text, /reply:[\s\S]*first:resume=none/)
  const firstSession = adapter.engines.get('local-claude-code').sessions.get('s1')
  const savedId = records.s1.cliSessionId
  assert.match(savedId, /^claude-2382-/)

  // Turn 2: stream-json omits result and process stays alive; finishes cleanly and retires wedged child.
  const t2 = await collect(adapter.stream(options('s1', [user('m1', 'first'), user('m2', 'hang-no-result')])))
  assert.equal(t2.finish?.kind, 'stop')
  assert.match(t2.text, /reply:[\s\S]*hang-no-result:resume=none/)
  assert.equal(t2.usage?.inputTokens, 12)
  assert.equal(t2.usage?.outputTokens, 7)
  assert.equal(firstSession.dead, true, 'wedged Claude child must be retired after synthetic completion')

  // Turn 3: next message opens a fresh child resuming the saved session id.
  const t3 = await collect(adapter.stream(options('s1', [user('m1', 'first'), user('m2', 'hang-no-result'), user('m3', 'after-hang')])))
  assert.equal(t3.finish?.kind, 'stop')
  assert.match(t3.text, new RegExp(`reply:[\\s\\S]*after-hang:resume=${savedId}`))

  // Turn 4: message_delta(end_turn) without message_stop or result also finishes cleanly.
  const t4 = await collect(adapter.stream(options('s1', [user('m1', 'first'), user('m2', 'hang-no-result'), user('m3', 'after-hang'), user('m4', 'hang-no-stop')])))
  assert.equal(t4.finish?.kind, 'stop')
  assert.match(t4.text, new RegExp(`reply:[\\s\\S]*hang-no-stop:resume=${savedId}`))

  // Turn 5: compact_boundary after message_stop re-arms fallback when result is omitted.
  const t5 = await collect(adapter.stream(options('s1', [user('m1', 'first'), user('m2', 'hang-no-result'), user('m3', 'after-hang'), user('m4', 'hang-no-stop'), user('m5', 'hang-after-compact')])))
  assert.equal(t5.finish?.kind, 'stop')
  assert.match(t5.text, new RegExp(`reply:[\\s\\S]*hang-after-compact:resume=${savedId}`))
})

test('claude: completes turn without result on clean exit 0 or non-partial assistant fallback (#2382)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-fallback-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fixture = join(dir, 'fake-claude-fallback.mjs')
  writeFileSync(fixture, `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const text = (msg.message?.content ?? []).map(b => b.text ?? '').join('\\n')
    send({ type: 'system', subtype: 'init', session_id: 'claude-fb-' + process.pid })
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'ans:' + text }], stop_reason: null, usage: { input_tokens: 5, output_tokens: 3 } } })
    if (text.includes('exit-zero')) process.exit(0)
  }
})
`)
  const adapter = makeClaudeAdapter({ claude: fixture, claudeOpts: { resultGraceMs: 50, resultFallbackMs: 80 } })
  t.after(() => adapter.dispose())

  const outExit = await collect(adapter.stream(options('s-exit', [user('m1', 'exit-zero')])))
  assert.equal(outExit.finish?.kind, 'stop')
  assert.match(outExit.text, /ans:[\s\S]*exit-zero/)

  const outQuiet = await collect(adapter.stream(options('s-quiet', [user('m1', 'quiet-hang')])))
  assert.equal(outQuiet.finish?.kind, 'stop')
  assert.match(outQuiet.text, /ans:[\s\S]*quiet-hang/)
})

test('claude: slow tool_use, Stop hooks, and max_tokens auto-continue do not trigger fallback early (#2382)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-no-cutoff-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fixture = join(dir, 'fake-claude-long-turn.mjs')
  writeFileSync(fixture, `
const hasHookFlag = process.argv.includes('--include-hook-events')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const text = (msg.message?.content ?? []).map(b => b.text ?? '').join('\\n')
    send({ type: 'system', subtype: 'init', session_id: 'claude-long-' + process.pid })
    if (text.includes('stop-hook')) {
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mh1', usage: { input_tokens: 10, output_tokens: 1 } } } })
      send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'mh1', content: [{ type: 'text', text: 'Draft.' }], stop_reason: null } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
      // Only emit hook events when --include-hook-events was passed (matches real Claude Code).
      if (hasHookFlag) send({ type: 'system', subtype: 'hook_started', hook_id: 'stop-1', hook_event: 'Stop' })
      setTimeout(() => {
        if (hasHookFlag) send({ type: 'system', subtype: 'hook_response', hook_id: 'stop-1', outcome: 'blocked' })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mh2', usage: { input_tokens: 15, output_tokens: 1 } } } })
        send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'mh2', content: [{ type: 'text', text: 'Hook-continued.' }], stop_reason: null } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
        send({ type: 'result', subtype: 'success', session_id: 'claude-long-' + process.pid, result: 'Hook-continued.', usage: { input_tokens: 15, output_tokens: 6 } })
      }, 150)
    } else if (text.includes('max-tokens')) {
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mt1', usage: { input_tokens: 10, output_tokens: 1 } } } })
      send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'mt1', content: [{ type: 'text', text: 'Part1.' }], stop_reason: null } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 50 } } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
      send({ type: 'system', subtype: 'api_retry', attempt: 1 })
      setTimeout(() => {
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mt2', usage: { input_tokens: 60, output_tokens: 1 } } } })
        send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'mt2', content: [{ type: 'text', text: 'Part2.' }], stop_reason: null } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
        send({ type: 'result', subtype: 'success', session_id: 'claude-long-' + process.pid, result: 'Part2.', usage: { input_tokens: 60, output_tokens: 20 } })
      }, 150)
    } else {
      // Slow tool_use streaming + tool execution
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } } } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Checking...' }], stop_reason: null } })
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
      setTimeout(() => {
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Glob' } } })
        send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: '*.js' } }], stop_reason: null } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } } })
        send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
        setTimeout(() => {
          send({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } })
          send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 20, output_tokens: 1 } } } })
          send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'All done.' }], stop_reason: null } })
          send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } })
          send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
          send({ type: 'result', subtype: 'success', session_id: 'claude-long-' + process.pid, result: 'All done.', usage: { input_tokens: 20, output_tokens: 5 } })
        }, 140)
      }, 140)
    }
  }
})
`)
  const adapter = makeClaudeAdapter({ claude: fixture, claudeOpts: { resultGraceMs: 60, resultFallbackMs: 80 } })
  t.after(() => adapter.dispose())

  const outHook = await collect(adapter.stream(options('s-hook', [user('m1', 'stop-hook')])))
  assert.equal(outHook.finish?.kind, 'stop')
  assert.match(outHook.text, /Draft\./)
  assert.match(outHook.text, /Hook-continued\./)
  assert.equal(adapter.engines.get('local-claude-code').sessions.get('s-hook').dead, false)

  const outMax = await collect(adapter.stream(options('s-max', [user('m1', 'max-tokens')])))
  assert.equal(outMax.finish?.kind, 'stop')
  assert.match(outMax.text, /Part1\./)
  assert.match(outMax.text, /Part2\./)
  assert.equal(adapter.engines.get('local-claude-code').sessions.get('s-max').dead, false)

  const outTool = await collect(adapter.stream(options('s-tool', [user('m1', 'check files')])))
  assert.equal(outTool.finish?.kind, 'stop')
  assert.match(outTool.text, /Checking\.\.\./)
  assert.match(outTool.text, /All done\./)
  assert.equal(adapter.engines.get('local-claude-code').sessions.get('s-tool').dead, false)
})

test('claude: late result within grace window preserves real success and error, and clean exit before stdout drains never double-finishes (#2382)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-late-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fixture = join(dir, 'fake-claude-late.mjs')
  writeFileSync(fixture, `
import { spawn } from 'node:child_process'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const text = (msg.message?.content ?? []).map(b => b.text ?? '').join('\\n')
    send({ type: 'system', subtype: 'init', session_id: 'claude-late-' + process.pid })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'ml1', usage: { input_tokens: 10, output_tokens: 1 } } } })
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'ml1', content: [{ type: 'text', text: 'partial' }], stop_reason: null } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } })
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })

    if (text.includes('late-success')) {
      setTimeout(() => send({ type: 'result', subtype: 'success', session_id: 'claude-late-' + process.pid, result: 'ok', usage: { input_tokens: 99, output_tokens: 42 } }), 80)
    } else if (text.includes('late-error')) {
      setTimeout(() => send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-late-' + process.pid, result: 'late upstream failure' }), 80)
    } else if (text.includes('after-grace-result')) {
      // Ignore SIGTERM briefly and emit a late result after the grace window already retired the session.
      process.on('SIGTERM', () => {})
      setTimeout(() => {
        send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-late-' + process.pid, result: 'too late' })
        process.exit(0)
      }, 150)
    } else if (text.includes('exit-before-drain-success') || text.includes('exit-before-drain-error')) {
      // Spawn a helper that inherits stdout, writes the closing result AFTER this process exits 0, then closes stdout.
      const payload = text.includes('exit-before-drain-error')
        ? JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-late-' + process.pid, result: 'late drain failure' })
        : JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-late-' + process.pid, result: 'ok', usage: { input_tokens: 77, output_tokens: 11 } })
      const helper = spawn(process.execPath, ['-e', 'setTimeout(() => { process.stdout.write(process.argv[1] + String.fromCharCode(10)); process.exit(0) }, 60)', payload], {
        stdio: ['ignore', 1, 'ignore'],
      })
      helper.unref()
      process.exit(0)
    }
  }
})
`)

  // 1. Late success and late error within the grace window are both preserved accurately.
  const adapter = makeClaudeAdapter({ claude: fixture, claudeOpts: { resultGraceMs: 250, resultFallbackMs: 400 } })
  t.after(() => adapter.dispose())

  const ok = await collect(adapter.stream(options('s-ok', [user('m1', 'late-success')])))
  assert.equal(ok.finish?.kind, 'stop')
  assert.equal(ok.usage?.inputTokens, 99)
  assert.equal(ok.usage?.outputTokens, 42)
  assert.equal(adapter.engines.get('local-claude-code').sessions.get('s-ok').dead, false)

  await assert.rejects(
    () => collect(adapter.stream(options('s-err', [user('m1', 'late-error')]))),
    /late upstream failure/,
  )

  // 2. Clean exit before stdout drains: direct ClaudeEngine inspection proves exactly one terminal event.
  const engine = new ClaudeEngine(
    'local-claude-code',
    { name: 'Claude Code', kind: 'claude', command: process.execPath, args: [fixture] },
    { findExecutable: p => p, resultGraceMs: 250, resultFallbackMs: 400 },
  )
  t.after(() => engine.close())

  const drainEvents = async (sessionId, promptText) => {
    const session = await engine.open(sessionId, { cwd: dir, mode: 'default', model: 'claude-sonnet' })
    await engine.prompt(session, [{ type: 'text', text: promptText }])
    const terminal = []
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const event = await Promise.race([
        session.next(),
        new Promise(resolve => setTimeout(() => resolve(null), 180)),
      ])
      if (event === null) break
      if (event.type === 'done' || event.type === 'error') terminal.push(event)
    }
    return terminal
  }

  const okDrain = await drainEvents('d-ok', 'exit-before-drain-success')
  assert.equal(okDrain.length, 1, `expected exactly one terminal event, got ${JSON.stringify(okDrain)}`)
  assert.equal(okDrain[0].type, 'done')
  assert.equal(okDrain[0].usage?.inputTokens, 77)

  const errDrain = await drainEvents('d-err', 'exit-before-drain-error')
  assert.equal(errDrain.length, 1, `expected exactly one terminal event, got ${JSON.stringify(errDrain)}`)
  assert.equal(errDrain[0].type, 'error')
  assert.match(errDrain[0].error.message, /late drain failure/)

  // 3. Result arriving after the grace window already retired the turn is ignored (no second terminal event).
  const shortEngine = new ClaudeEngine(
    'local-claude-code',
    { name: 'Claude Code', kind: 'claude', command: process.execPath, args: [fixture] },
    { findExecutable: p => p, resultGraceMs: 50, resultFallbackMs: 80 },
  )
  t.after(() => shortEngine.close())
  const lateSession = await shortEngine.open('d-after', { cwd: dir, mode: 'default', model: 'claude-sonnet' })
  await shortEngine.prompt(lateSession, [{ type: 'text', text: 'after-grace-result' }])
  const afterGrace = []
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const event = await Promise.race([
      lateSession.next(),
      new Promise(resolve => setTimeout(() => resolve(null), 250)),
    ])
    if (event === null) break
    if (event.type === 'done' || event.type === 'error') afterGrace.push(event)
  }
  assert.equal(afterGrace.length, 1, `expected exactly one terminal event after grace, got ${JSON.stringify(afterGrace)}`)
  assert.equal(afterGrace[0].type, 'done')
})

test('claude: retries stream, ask, and maintain when older CLI rejects --include-partial-messages and --include-hook-events', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-old-flags-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fixture = join(dir, 'fake-claude-old.mjs')
  writeFileSync(fixture, `
if (process.argv.includes('--include-partial-messages')) {
  process.stderr.write("error: unknown option '--include-partial-messages'\\n")
  process.exit(1)
}
if (process.argv.includes('--include-hook-events')) {
  process.stderr.write("error: unknown option '--include-hook-events'\\n")
  process.exit(1)
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    send({ type: 'system', subtype: 'init', session_id: 'claude-old-1' })
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'old-cli-ok' }] } })
    send({ type: 'result', subtype: 'success', session_id: 'claude-old-1', result: 'old-cli-ok', usage: { input_tokens: 3, output_tokens: 2 } })
  }
})
`)
  const adapter = makeClaudeAdapter({ claude: fixture })
  t.after(() => adapter.dispose())

  const out = await collect(adapter.stream(options('s-old', [user('m1', 'hi')])))
  assert.equal(out.finish?.kind, 'stop')
  assert.equal(out.text, 'old-cli-ok')
  assert.equal(adapter.engines.get('local-claude-code').noPartialMessages, true)
  assert.equal(adapter.engines.get('local-claude-code').noHookEvents, true)

  const askAdapter = makeClaudeAdapter({ claude: fixture })
  t.after(() => askAdapter.dispose())
  const sideReply = await askAdapter.ask('s-side', {
    system: 'Be brief',
    prompt: 'hello',
    route: 'local-claude-code',
    model: 'claude-sonnet',
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(sideReply, 'old-cli-ok')

  const maintRecords = { 's-maint': { route: 'local-claude-code', model: 'claude-sonnet', cliSessionId: 'claude-old-1' } }
  const maintAdapter = makeClaudeAdapter({ records: maintRecords, claude: fixture })
  t.after(() => maintAdapter.dispose())
  const noteReply = await maintAdapter.note('s-maint', 'Write handoff', AbortSignal.timeout(5_000))
  assert.equal(noteReply, 'old-cli-ok')
})
