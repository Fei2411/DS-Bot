import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/changes.js'

// A Windows-style event record, as the Session log hands it over.
const event = (seq, turn) => ({ seq, type: 'workspace/changes', data: { turn } })

const summaryOf = (turn, files) => ({
  turn,
  cwd: '/work',
  total: files.length,
  added: files.reduce((sum, file) => sum + file.added, 0),
  deleted: files.reduce((sum, file) => sum + file.deleted, 0),
  files,
})

function harness({ service, page } = {}) {
  const listeners = []
  const pages = []
  const ctx = {
    on: (type, listener) => { if (type === 'session/event') listeners.push(listener) },
    get: name => (name === 'workspaceChanges' ? service : undefined),
    sessionController: {
      page: async (request) => {
        pages.push(request)
        return { records: (page ?? []).map(item => ({ event: item })), hasMore: false }
      },
    },
  }
  const rt = { ctx }
  install(rt)
  const emit = (session, item) => { for (const listener of listeners) listener(session, item) }
  return { rt, emit, pages }
}

const file = (display, added, deleted) => ({ path: display, display, added, deleted })

test('a turn with changes becomes the line a group row carries', async () => {
  const summary = summaryOf(3, [file('src/a.js', 12, 4), file('src/b.js', 1, 0)])
  const { rt, emit } = harness({ service: { summary: (id, seq) => (seq === 7 ? summary : undefined) } })
  emit({ id: 's1' }, event(7, 3))
  assert.deepEqual(await rt.turnChanges('s1'), {
    sessionId: 's1', seq: 7, turn: 3, total: 2, added: 13, deleted: 4,
    files: [{ path: 'src/a.js', added: 12, deleted: 4 }, { path: 'src/b.js', added: 1, deleted: 0 }],
  })
})

test('a turn that changed nothing adds no row', async () => {
  const { rt, emit } = harness({ service: { summary: () => summaryOf(2, []) } })
  emit({ id: 's1' }, event(5, 2))
  assert.equal(await rt.turnChanges('s1'), undefined)
})

test('with no workspace-changes service mounted there is no row and no page read', async () => {
  const { rt, pages } = harness({ service: undefined, page: [event(5, 2)] })
  assert.equal(await rt.turnChanges('s1'), undefined)
  assert.equal(pages.length, 0)
})

test('a Session whose event came before this process listened is read from its log tail', async () => {
  const summary = summaryOf(9, [file('README.md', 3, 1)])
  const { rt, pages } = harness({
    service: { summary: (id, seq) => (seq === 11 ? summary : undefined) },
    page: [event(4, 8), { seq: 11, type: 'workspace/changes', data: { turn: 9 } }],
  })
  const line = await rt.turnChanges('s1')
  assert.equal(line?.turn, 9)
  assert.equal(line?.files[0].path, 'README.md')
  assert.equal(pages.length, 1)
})

test('a summary the Host no longer serves leaves the row out, and the review reports it gone', async () => {
  const service = { summary: () => undefined }
  const { rt, emit } = harness({ service })
  emit({ id: 's1' }, event(7, 3))
  assert.equal(await rt.turnChanges('s1'), undefined)
  assert.equal(rt.changesAvailable('s1', 7), false)
})

test('the review can open only while the summary is still served', async () => {
  const service = { summary: (id, seq) => (id === 's1' && seq === 7 ? summaryOf(3, [file('a.js', 1, 1)]) : undefined) }
  const { rt } = harness({ service })
  assert.equal(rt.changesAvailable('s1', 7), true)
  assert.equal(rt.changesAvailable('s1', 8), false)
  assert.equal(rt.changesAvailable('s2', 7), false)
  assert.equal(rt.changesAvailable('s1', undefined), false)
  assert.equal(rt.changesMounted(), true)
  // A service that throws is a refusal, not a crash.
  assert.equal(harness({ service: { summary: () => { throw new Error('disposed') } } }).rt.changesAvailable('s1', 7), false)
})

test('the line keeps at most eight names and its totals count the rest', async () => {
  const files = Array.from({ length: 10 }, (_, index) => file(`src/f${index}.js`, 1, 0))
  const summary = { ...summaryOf(4, files.slice(0, 8)), total: 10, added: 10, deleted: 0 }
  const { rt, emit } = harness({ service: { summary: () => summary } })
  emit({ id: 's1' }, event(3, 4))
  const line = await rt.turnChanges('s1')
  assert.equal(line.files.length, 8)
  assert.equal(line.total, 10)
  assert.equal(line.added, 10)
})

test('a paging failure adds no row rather than failing the turn', async () => {
  const { rt } = harness({ service: { summary: () => undefined } })
  rt.ctx.sessionController.page = async () => { throw new Error('no session') }
  assert.equal(await rt.turnChanges('s1'), undefined)
})


test('a later unchanged turn cannot reuse the last changed turn, live or after reload', async () => {
  const summary = summaryOf(3, [file('a.js', 1, 0)])
  const service = { summary: () => summary }
  const live = harness({ service })
  live.emit({ id: 's1' }, event(7, 3))
  assert.ok(await live.rt.turnChanges('s1'))
  live.emit({ id: 's1' }, { type: 'turn/start', seq: 8, data: { turn: 4 } })
  live.emit({ id: 's1' }, { type: 'turn/end', seq: 9, data: { turn: 4 } })
  assert.equal(await live.rt.turnChanges('s1'), undefined)
  const cold = harness({ service, page: [event(7, 3), { type: 'turn/start', seq: 8, data: { turn: 4 } }, { type: 'turn/end', seq: 9, data: { turn: 4 } }] })
  assert.equal(await cold.rt.turnChanges('s1'), undefined)
})

test('a review reads its recorded file index through the service', async () => {
  const calls = []
  const summary = summaryOf(3, [file('a.js', 1, 0)])
  const service = { summary: () => summary, diff: (...args) => { calls.push(args); return { kind: 'binary', path: 'a.js', display: 'a.js' } } }
  const { rt } = harness({ service })
  const signal = new AbortController().signal
  assert.equal(rt.changesSummary('s1', 7), summary)
  assert.equal((await rt.changesDiff('s1', 7, 0, signal)).kind, 'binary')
  assert.deepEqual(calls[0], ['s1', 7, 0, signal])
  await assert.rejects(rt.changesDiff('s1', 7, -1, signal), /No such file/)
  await assert.rejects(rt.changesDiff('s1', 7, 1, signal), /No such file/)
  await assert.rejects(rt.changesDiff('s1', 7, 'a.js', signal), /No such file/)
})
