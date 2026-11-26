import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/side-file-source.js'; export { chooseBase } from './src/client/side-file-views.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = { createElement: () => null, useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }), useState: init => [init, () => {}], useSyncExternalStore: (sub, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, atob, Blob, Uint8Array,
  window: { matchMedia: () => ({ matches: false }) }, document: { hidden: false }, localStorage: { getItem: () => null, setItem() {} },
  fetch: async () => { throw new Error('no network in tests') },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { createFileSession, startPolling, sessionFor, dropSession, chooseBase, nextPreview, POLL_MS } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
// Promises made in the bundle's context take extra turns; a macrotask lets them all land.
const settle = () => new Promise(resolve => setImmediate(resolve))

const text = (body, revision) => ({ kind: 'text', text: body, revision })
const refuse = (code, message = code) => Object.assign(new Error(message), { code })

test('the first read becomes the baseline; later reads change the text and keep it', async () => {
  const answers = [text('one', 'r1'), text('two', 'r2')]
  const session = createFileSession(async () => answers.shift())
  assert.equal(session.getSnapshot().status, 'loading')
  await session.poll()
  let state = session.getSnapshot()
  assert.deepEqual(plain({ status: state.status, text: state.text, base: state.base, revision: state.revision }), { status: 'ready', text: 'one', base: 'one', revision: 'r1' })
  await session.poll()
  state = session.getSnapshot()
  assert.equal(state.text, 'two')
  assert.equal(state.base, 'one', 'the baseline waits for the user to mark a version reviewed')
  assert.equal(state.revision, 'r2')
})

test('the session asks with the revision it holds, and an unchanged answer keeps the text', async () => {
  const asked = []
  const answers = [text('one', 'r1'), { kind: 'unchanged', revision: 'r1' }]
  const session = createFileSession(async (known) => { asked.push(known); return answers.shift() })
  await session.poll()
  await session.poll()
  assert.deepEqual(asked, [undefined, 'r1'])
  assert.equal(session.getSnapshot().text, 'one')
  assert.equal(session.getSnapshot().status, 'ready')
})

test('marking a version reviewed moves the baseline there and says so', async () => {
  const answers = [text('one', 'r1'), text('two', 'r2')]
  const session = createFileSession(async () => answers.shift())
  await session.poll()
  await session.poll()
  session.markReviewed()
  const state = session.getSnapshot()
  assert.equal(state.base, 'two')
  assert.equal(state.baseRevision, 'r2')
  assert.equal(state.reviewed, true)
})

test('a vanished file keeps its last text, and comes back when the file does', async () => {
  const answers = [text('one', 'r1'), refuse('bot/not-found'), text('one again', 'r3')]
  const session = createFileSession(async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next })
  await session.poll()
  await session.poll()
  let state = session.getSnapshot()
  assert.equal(state.status, 'missing')
  assert.equal(state.text, 'one')
  assert.equal(state.base, 'one')
  await session.poll()
  state = session.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.text, 'one again')
  assert.equal(state.error, null)
})

test('other failures read as an error with the host\'s own words, and widen the wait', async () => {
  const session = createFileSession(async () => { throw refuse('bot/forbidden', 'That path leaves the working folder') })
  const base = session.delay()
  await session.poll()
  const state = session.getSnapshot()
  assert.equal(state.status, 'error')
  assert.equal(state.error.code, 'bot/forbidden')
  assert.equal(state.error.message, 'That path leaves the working folder')
  assert.ok(session.delay() > base)
  await session.poll()
  await session.poll()
  await session.poll()
  await session.poll()
  await session.poll()
  assert.ok(session.delay() <= 30_000)
})

test('two reads of one file never run at once', async () => {
  let running = 0
  let peak = 0
  let calls = 0
  const session = createFileSession(async () => {
    running += 1
    calls += 1
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 5))
    running -= 1
    return text('x', 'r1')
  })
  await Promise.all([session.poll(), session.poll(), session.poll()])
  assert.equal(peak, 1)
  assert.equal(calls, 1)
})

test('an older answer never replaces a newer one', async () => {
  let release
  const first = new Promise((resolve) => { release = resolve })
  const answers = [first.then(() => text('old', 'r1')), Promise.resolve(text('new', 'r2'))]
  const session = createFileSession(() => answers.shift())
  const slow = session.poll()
  // The slow read is out; nothing else can start until it ends, so it is the only one to land.
  release()
  await slow
  await session.poll()
  assert.equal(session.getSnapshot().text, 'new')
})

test('subscribers hear every change and can leave', async () => {
  const answers = [text('a', 'r1'), text('b', 'r2')]
  const session = createFileSession(async () => answers.shift())
  let heard = 0
  const off = session.subscribe(() => { heard += 1 })
  await session.poll()
  off()
  await session.poll()
  assert.equal(heard, 1)
})

// ---- the polling loop -----------------------------------------------------------------

function clock() {
  const timers = new Map()
  let next = 1
  return {
    set: (fn, ms) => { timers.set(next, { fn, ms }); return next++ },
    clear: (id) => { timers.delete(id) },
    pending: () => timers.size,
    delays: () => [...timers.values()].map(timer => timer.ms),
    async fire() { const first = [...timers.entries()][0]; assert.ok(first, 'a timer is waiting'); timers.delete(first[0]); await first[1].fn(); await settle() },
  }
}
const doc = (hidden = false) => {
  const listeners = new Set()
  return {
    hidden,
    addEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.add(fn) },
    removeEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.delete(fn) },
    show() { this.hidden = false; for (const fn of listeners) fn() },
    listeners,
  }
}

test('polling reads at once, then after each delay, and stops cleanly', async () => {
  const timers = clock()
  let reads = 0
  const stop = startPolling({ tick: async () => { reads += 1 }, delay: () => 2000, active: () => true, doc: doc(), timers })
  await settle()
  assert.equal(reads, 1)
  assert.deepEqual(timers.delays(), [2000])
  await timers.fire()
  assert.equal(reads, 2)
  stop()
  assert.equal(timers.pending(), 0)
})

test('a hidden window or an inactive tab reads nothing, and a returning window checks at once', async () => {
  const timers = clock()
  const page = doc(true)
  let reads = 0
  let on = false
  const stop = startPolling({ tick: async () => { reads += 1 }, delay: () => 2000, active: () => on, doc: page, timers })
  await settle()
  assert.equal(reads, 0)
  await timers.fire()
  assert.equal(reads, 0, 'hidden: the tick passes without a read')
  on = true
  await timers.fire()
  assert.equal(reads, 0, 'still hidden')
  page.show()
  await settle()
  assert.equal(reads, 1, 'visible again: checked without waiting out the delay')
  stop()
  assert.equal(page.listeners.size, 0)
})

test('a failing read does not stop the loop', async () => {
  const timers = clock()
  let reads = 0
  const stop = startPolling({ tick: async () => { reads += 1; throw new Error('boom') }, delay: () => 2000, active: () => true, doc: doc(), timers })
  await settle()
  await timers.fire()
  assert.equal(reads, 2)
  stop()
})

test('the tick is the documented two seconds', () => {
  assert.equal(POLL_MS, 2000)
})

// ---- sessions per tab and the diff base --------------------------------------------------

test('a tab keeps one session while it is open and loses it on close', () => {
  const tab = { key: 'canvas\0t\0a.html', app: 'canvas', displayPath: 'a.html', workspaceTag: 't', sessionId: 's1' }
  const calls = []
  const read = (file, subject, known) => { calls.push({ file, subject, known }); return Promise.resolve(text('x', 'r1')) }
  const one = sessionFor(tab, read)
  assert.equal(sessionFor(tab, read), one)
  return one.poll().then(() => {
    assert.deepEqual(plain(calls[0].file), { app: 'canvas', displayPath: 'a.html', workspaceTag: 't' })
    assert.equal(calls[0].subject, 's1')
    dropSession(tab.key)
    assert.notEqual(sessionFor(tab, read), one)
    dropSession(tab.key)
  })
})

test('the host\'s base is used only for the text on screen, and never after a review', () => {
  const file = { text: 'after', revision: 'r2', base: 'first', baseRevision: 'r1', reviewed: false }
  const host = { kind: 'host', before: 'before', baseRevision: 'rb', revision: 'r2' }
  assert.deepEqual(plain(chooseBase({ file, host })), { text: 'before', source: 'host' })
  assert.deepEqual(plain(chooseBase({ file, host: { ...host, revision: 'r-old' } })), { text: 'first', source: 'snapshot' })
  assert.deepEqual(plain(chooseBase({ file, host: { kind: 'unavailable' } })), { text: 'first', source: 'snapshot' })
  assert.deepEqual(plain(chooseBase({ file, host: null })), { text: 'first', source: 'snapshot' })
  assert.deepEqual(plain(chooseBase({ file: { ...file, reviewed: true, base: 'after' }, host })), { text: 'after', source: 'snapshot' })
})

test('after a review the host base is used again once it starts at the reviewed version', () => {
  const reviewed = { text: 'v2', revision: 'r2', base: 'v2', baseRevision: 'r2', reviewed: true }
  // The Bot edits again: the host's before is the reviewed text itself.
  const edit = { kind: 'host', before: 'v2', baseRevision: 'r2', revision: 'r3' }
  assert.deepEqual(plain(chooseBase({ file: { ...reviewed, text: 'v3', revision: 'r3' }, host: edit })), { text: 'v2', source: 'host' })
  // A base that reaches back past the review would show reviewed changes as new again.
  const wide = { kind: 'host', before: 'v1', baseRevision: 'r1', revision: 'r3' }
  assert.deepEqual(plain(chooseBase({ file: { ...reviewed, text: 'v3', revision: 'r3', base: 'v2' }, host: wide })), { text: 'v2', source: 'snapshot' })
})

test('the same file in two conversations keeps two sessions, and closing the tab drops both', () => {
  const base = { key: 'reader\0t\0a.md', app: 'reader', displayPath: 'a.md', workspaceTag: 't' }
  const read = () => Promise.resolve(text('x', 'r1'))
  const one = sessionFor({ ...base, sessionId: 's1' }, read)
  const two = sessionFor({ ...base, sessionId: 's2' }, read)
  assert.notEqual(one, two)
  assert.equal(sessionFor({ ...base, sessionId: 's1' }, read), one)
  dropSession(base.key)
  assert.notEqual(sessionFor({ ...base, sessionId: 's1' }, read), one)
  assert.notEqual(sessionFor({ ...base, sessionId: 's2' }, read), two)
  dropSession(base.key)
})

test('a renewed ticket for unchanged content moves the frame to the new address', () => {
  const ready = { status: 'ready', frameUrl: '/t/old/index.html', previewRevision: 'p1', error: null, unavailable: null }
  const renewed = nextPreview(ready, { kind: 'unchanged', previewRevision: 'p1', frameUrl: '/t/new/index.html' })
  assert.equal(renewed.frameUrl, '/t/new/index.html')
  assert.equal(renewed.previewRevision, 'p1', 'the content did not change')
  assert.equal(nextPreview(ready, { kind: 'unchanged', previewRevision: 'p1', frameUrl: '/t/old/index.html' }), ready, 'nothing moved, nothing re-renders')
  assert.equal(nextPreview(ready, { kind: 'preview', previewRevision: 'p2', frameUrl: '/t/old/index.html' }).previewRevision, 'p2')
  const failed = { ...ready, error: { code: 'bot/error' } }
  assert.equal(nextPreview(failed, { kind: 'unchanged', previewRevision: 'p1', frameUrl: '/t/old/index.html' }).error, null)
})

const { fetchImage, IMAGE_MIMES, IMAGE_MAX_BYTES } = module.exports
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const tab = { key: 'k', sessionId: 's1', app: 'reader', displayPath: 'docs/a.md', workspaceTag: 'w1' }

test('a picture is requested for its own path with the tab\'s authority', async () => {
  const seen = []
  const got = await fetchImage(tab, 'docs/img/a.png', undefined, async (body) => { seen.push(plain(body)); return { kind: 'bytes', revision: 'r1', mime: 'image/png', data: PNG, size: 8 } })
  assert.deepEqual(seen, [{ sessionId: 's1', file: { app: 'reader', displayPath: 'docs/img/a.png', article: 'docs/a.md', workspaceTag: 'w1' } }])
  assert.equal(got.kind, 'image')
  assert.equal(got.revision, 'r1')
  assert.equal(got.blob.type, 'image/png')
  assert.equal(got.blob.size, 8)
  await fetchImage(tab, 'docs/img/a.png', 'r1', async (body) => { seen.push(plain(body)); return { kind: 'unchanged', revision: 'r1' } })
  assert.equal(seen[1].knownRevision, 'r1')
})

test('a picture the host sends outside the allowed types or size is refused', async () => {
  const answer = (extra) => async () => ({ kind: 'bytes', revision: 'r', mime: 'image/png', data: PNG, ...extra })
  for (const extra of [{ mime: 'text/html' }, { mime: 'application/javascript' }, { mime: '' }, { data: 5 }, { kind: 'text' }]) {
    await assert.rejects(fetchImage(tab, 'docs/a.png', undefined, answer(extra)), { code: 'bot/invalid' })
  }
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1).toString('base64')
  await assert.rejects(fetchImage(tab, 'docs/a.png', undefined, answer({ data: big })), { code: 'bot/too-large' })
  await assert.rejects(fetchImage(tab, 'docs/a.png', undefined, async () => { throw refuse('bot/forbidden') }), { code: 'bot/forbidden' })
  assert.ok(IMAGE_MIMES.has('image/svg+xml') && !IMAGE_MIMES.has('text/html'))
})