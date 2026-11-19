import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TRANSCRIPT_VIEW, DEFAULT_WORK_PROCESS_MODE, WORK_PROCESS_MODES, callSummary, drawnCalls, foldingOf, isWorkCall, transcriptViewOf, workProcessOf } from '../src/client/work-process.js'

// A call as the transcript hands one over: a name, its raw arguments, and for a
// settled call the result the host recorded, with the two times a row measures.
const call = (name, extra = {}) => ({ callId: `${name}-1`, name, argsRaw: '{}', ...extra })
const settled = (name, extra = {}) => call(name, { kind: 'tool-result', time: 1300, callTime: 1000, content: [], isError: false, ...extra })

test('the work-process modes are the three the setting offers', () => {
  assert.deepEqual(WORK_PROCESS_MODES, ['off', 'thinking', 'full'])
  assert.equal(DEFAULT_WORK_PROCESS_MODE, 'full')
})

test('workProcessOf keeps a known mode and falls back for anything else', () => {
  assert.equal(workProcessOf({ workProcess: 'off' }), 'off')
  assert.equal(workProcessOf({ workProcess: 'thinking' }), 'thinking')
  assert.equal(workProcessOf({ workProcess: 'full' }), 'full')
  assert.equal(workProcessOf({}), DEFAULT_WORK_PROCESS_MODE)
  assert.equal(workProcessOf(undefined), DEFAULT_WORK_PROCESS_MODE)
  assert.equal(workProcessOf({ workProcess: 'verbose' }), DEFAULT_WORK_PROCESS_MODE)
  assert.equal(workProcessOf({ workProcess: null }), DEFAULT_WORK_PROCESS_MODE)
})

test('transcriptViewOf reads the legacy values as detailed', () => {
  for (const mode of ['compact', 'standard', 'detailed', 'verbose']) assert.equal(transcriptViewOf(mode), mode)
  assert.equal(transcriptViewOf('normal'), 'detailed')
  assert.equal(transcriptViewOf('expanded'), 'detailed')
  assert.equal(transcriptViewOf(undefined), DEFAULT_TRANSCRIPT_VIEW)
  assert.equal(transcriptViewOf(''), DEFAULT_TRANSCRIPT_VIEW)
  assert.equal(transcriptViewOf('huge'), DEFAULT_TRANSCRIPT_VIEW)
})

test('foldingOf draws no rows below full, and follows DSH above it', () => {
  for (const view of ['compact', 'standard', 'detailed', 'verbose', undefined]) {
    assert.equal(foldingOf('off', view), 'none')
    assert.equal(foldingOf('thinking', view), 'none')
  }
  assert.equal(foldingOf('full', 'compact'), 'folded')
  assert.equal(foldingOf('full', 'standard'), 'folded')
  assert.equal(foldingOf('full', 'detailed'), 'live')
  assert.equal(foldingOf('full', 'soon'), 'folded', 'an unknown view reads as standard')
  // A saved value of the two-mode generation reads as detailed.
  assert.equal(foldingOf('full', 'normal'), 'live')
  assert.equal(foldingOf('full', 'expanded'), 'live')
  assert.equal(foldingOf('full', 'verbose'), 'open')
})

test('drawnCalls keeps the team events, the cards and the computer in every mode', () => {
  const calls = [
    call('message_bot'),
    call('ask_user'),
    call('show_view'),
    call('computer_handoff'),
    call('cua_driver_native__click'),
    call('bash'),
    call('read'),
  ]
  for (const mode of WORK_PROCESS_MODES) {
    const names = drawnCalls(calls, { mode }).map(entry => entry.name)
    assert.ok(names.includes('message_bot'), `${mode} keeps message_bot`)
    assert.ok(names.includes('ask_user'), `${mode} keeps ask_user`)
    assert.ok(names.includes('show_view'), `${mode} keeps show_view`)
    assert.ok(names.includes('computer_handoff'), `${mode} keeps computer_handoff`)
    assert.ok(names.includes('cua_driver_native__click'), `${mode} keeps a computer call`)
    const work = names.filter(name => name === 'bash' || name === 'read')
    assert.deepEqual(work, mode === 'full' ? ['bash', 'read'] : [], `${mode} draws the work rows only when it is full`)
  }
})

test('drawnCalls reads a program sub-call by its own name, and leaves the input alone', () => {
  const sub = call('glob')
  const root = call('run_code', { subCalls: [sub] })
  const tree = [root, sub]
  const full = drawnCalls(tree, { mode: 'full' })
  assert.deepEqual(full.map(entry => entry.name), ['run_code', 'glob'])
  assert.notEqual(full, tree, 'the answer is a new list')
  assert.deepEqual(tree.map(entry => entry.name), ['run_code', 'glob'], 'the input keeps its order')
  assert.deepEqual(drawnCalls(tree, { mode: 'thinking' }), [], 'a program and its sub-calls are work rows')
  // A sub-call of a team tool draws with its parent, whatever the mode.
  const parent = call('message_bot', { subCalls: [sub] })
  assert.deepEqual(drawnCalls([parent, sub], { mode: 'off' }).map(entry => entry.name), ['message_bot'])
})

test('drawnCalls defaults to the rows the client draws', () => {
  assert.deepEqual(drawnCalls([call('bash')]).map(entry => entry.name), ['bash'])
  assert.deepEqual(drawnCalls(undefined, { mode: 'full' }), [])
})

test('isWorkCall holds for a tool with no row of its own', () => {
  assert.equal(isWorkCall(call('bash')), true)
  assert.equal(isWorkCall(call('ops_bash')), true)
  assert.equal(isWorkCall(call('message_bot')), false)
  assert.equal(isWorkCall(call('mail_send')), false)
  assert.equal(isWorkCall(call('cua')), false)
})

test('callSummary names what a call worked on and what it answered', () => {
  const summary = callSummary(settled('bash', {
    argsRaw: '{"command":"npm test","description":"Run the tests"}',
    content: [{ type: 'text', text: 'first line\nsecond line' }],
  }))
  assert.deepEqual(summary, { tool: 'bash', detail: 'npm test', result: 'first line second line', failed: false, duration: 300 })
})

test('callSummary marks a failure, and a running call has no result yet', () => {
  const failed = callSummary(settled('read', {
    argsRaw: '{"path":"src/client/cells.js"}',
    content: [{ type: 'text', text: 'ENOENT: no such file' }],
    isError: true,
    error: { name: 'Error', code: 'ENOENT' },
  }))
  assert.equal(failed.detail, 'src/client/cells.js')
  assert.equal(failed.failed, true)
  assert.equal(failed.duration, 300)
  const running = callSummary(call('glob', { argsRaw: '{"pattern":"**/*.js"}', time: 2000 }))
  assert.deepEqual(running, { tool: 'glob', detail: '**/*.js', result: '', failed: false, duration: undefined })
})

test('callSummary keeps one line and cuts it at the limits', () => {
  const summary = callSummary(settled('bash', {
    argsRaw: JSON.stringify({ command: `echo ${'x'.repeat(200)}` }),
    content: [{ type: 'text', text: 'y'.repeat(300) }],
  }), { detailLimit: 20, resultLimit: 30 })
  assert.equal(summary.detail.length, 20)
  assert.ok(summary.detail.endsWith('…'))
  assert.equal(summary.result.length, 30)
  assert.ok(summary.result.endsWith('…'))
  // A result whose call head left the window is measured from the result's own time.
  const orphan = callSummary(settled('bash', { callTime: null, content: [{ type: 'text', text: 'ok' }] }))
  assert.equal(orphan.duration, 0)
})
