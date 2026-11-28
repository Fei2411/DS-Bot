import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  FILE_TABS_MAX,
  clampWidth,
  closeFileTab,
  descriptorFromResult,
  fileTabKey,
  lineRangeOf,
  openFileTab,
  parseDescriptor,
  readableMarkdown,
  restoreAll,
  restoreTabs,
  revisionMessage,
  siblingPath,
  tabFromDescriptor,
  tabLabels,
  widthRangeOf,
} from '../src/client/side-apps.js'
import { createFileSession, dropSession, sessionFor, startPolling } from '../src/client/side-file-source.js'
import { changeRuns, diffLines, foldRows } from '../src/client/line-diff.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const flush = async (rounds = 4) => { for (let i = 0; i < rounds; i += 1) await tick() }

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// Canvas and Reader components are client modules that import host-provided UI
// primitives, so their pure constants are probed through the same esbuild boundary
// the client bundle uses rather than a direct Node import.
async function bundled(entry) {
  const { outputFiles } = await build({
    stdin: { contents: `export * from './src/client/${entry}'`, resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  const react = {
    createElement: () => null,
    createContext: initial => ({ Provider: () => null, _currentValue: initial }),
    useContext: ctx => ctx?._currentValue,
    useEffect() {},
    useLayoutEffect() {},
    useMemo: make => make(),
    useCallback: fn => fn,
    useRef: current => ({ current }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useSyncExternalStore: (sub, get) => get(),
    memo: component => component,
    forwardRef: component => component,
    Fragment: Symbol('Fragment'),
  }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: false }) }, document: { hidden: false }, localStorage: { getItem: () => null, setItem() {} },
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  return module.exports
}

const canvas = await bundled('canvas-app.js')

const descriptor = {
  v: 1,
  app: 'reader',
  sessionId: 's1',
  workspaceTag: 'tag',
  displayPath: 'docs/article.md',
  tab: 'source',
}

test('the canvas iframe sandbox permits scripts but forbids forms, popups, navigation and same-origin access', () => {
  const tokens = new Set(String(canvas.CANVAS_SANDBOX).split(/\s+/).filter(Boolean))
  assert.equal(tokens.has('allow-scripts'), true, 'interactive drafts need their scripts')
  for (const forbidden of ['allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-same-origin', 'allow-downloads']) {
    assert.equal(tokens.has(forbidden), false, `${forbidden} violates the V1 canvas isolation contract`)
  }
  assert.equal(canvas.CANVAS_SANDBOX.includes('allow-same-origin'), false)
})

test('the canvas frame address carries the preview revision without replacing the ticket path', () => {
  assert.equal(canvas.frameSrc('/api/bot-canvas/ticket/entry.html', 'r1'), '/api/bot-canvas/ticket/entry.html?r=r1')
  assert.equal(canvas.frameSrc('/api/bot-canvas/ticket/entry.html?x=1', 'rev/2'), '/api/bot-canvas/ticket/entry.html?x=1&r=rev%2F2')
  assert.equal(canvas.frameSrc('', 'r1'), '')
})

test('file tab keys never contain absolute paths and duplicate opens focus instead of duplicating', () => {
  const key = fileTabKey('reader', 'tag', 'docs/article.md')
  assert.equal(key.includes('\0'), true)
  const tab = tabFromDescriptor(descriptor)
  let result = openFileTab([], tab)
  assert.equal(result.tabs.length, 1)
  assert.equal(result.active, key)
  result = openFileTab(result.tabs, { ...tab, mode: 'diff' })
  assert.equal(result.tabs.length, 1, 'the same workspace file never opens twice')
  assert.equal(result.active, key)
  assert.equal(result.tabs[0].mode, 'diff')
  result = openFileTab(result.tabs, { ...tab, mode: 'preview' })
  assert.equal(result.tabs[0].mode, 'preview', 'an explicitly asked preview switches the tab back to preview')
})

test('an explicit preview reopens an open tab in preview while a silent open leaves its mode alone', () => {
  const diffTab = tabFromDescriptor({ ...descriptor, tab: 'diff' })
  let tabs = openFileTab([], diffTab).tabs
  assert.equal(tabs[0].mode, 'diff')

  const silent = openFileTab(tabs, tabFromDescriptor({ v: 1, app: descriptor.app, workspaceTag: descriptor.workspaceTag, displayPath: descriptor.displayPath, sessionId: 's1' }))
  assert.equal(silent.tabs[0].mode, 'diff', 'an open that names no mode leaves the tab where the user put it')

  const explicit = openFileTab(tabs, tabFromDescriptor({ ...descriptor, tab: 'preview' }))
  assert.equal(explicit.tabs[0].mode, 'preview', 'a card that explicitly asks for preview switches back to it')

  const askedDiff = openFileTab(explicit.tabs, tabFromDescriptor({ ...descriptor, tab: 'diff' }))
  assert.equal(askedDiff.tabs[0].mode, 'diff')
})

test('the strip holds at most eight file tabs and refuses overflow instead of dropping one', () => {
  let tabs = []
  for (let index = 0; index < FILE_TABS_MAX; index += 1) {
    tabs = openFileTab(tabs, tabFromDescriptor({ ...descriptor, displayPath: `file-${index}.md` })).tabs
  }
  const overflow = openFileTab(tabs, tabFromDescriptor({ ...descriptor, displayPath: 'overflow.md' }))
  assert.equal(overflow.full, true)
  assert.equal(overflow.active, null)
  assert.equal(overflow.tabs.length, FILE_TABS_MAX, 'the tab with a possibly unreviewed diff is not silently discarded')
  const closed = closeFileTab(tabs, tabs[0].key)
  assert.equal(closed.length, FILE_TABS_MAX - 1)
})

test('same-named tabs shorten labels only as far as the parent directory', () => {
  const tabs = ['a/report.md', 'b/report.md', 'a/deep/report.md', 'unique.md'].map(displayPath => tabFromDescriptor({ ...descriptor, displayPath }))
  const labels = tabLabels(tabs)
  assert.equal(labels.get(tabs[0].key), 'a/report.md')
  assert.equal(labels.get(tabs[1].key), 'b/report.md')
  assert.equal(labels.get(tabs[2].key), 'deep/report.md')
  assert.equal(labels.get(tabs[3].key), 'unique.md')
})

test('descriptor parsing accepts only the versioned card shape and restore skips damaged entries', () => {
  assert.equal(parseDescriptor(descriptor).app, 'reader')
  assert.equal(parseDescriptor({ ...descriptor, v: 2 }), undefined)
  assert.equal(parseDescriptor({ ...descriptor, app: 'browser' }), undefined)
  assert.equal(parseDescriptor({ ...descriptor, displayPath: '' }), undefined)
  assert.equal(parseDescriptor({ ...descriptor, sessionId: 42 }).sessionId, undefined)
  assert.equal(parseDescriptor({ ...descriptor, tab: 'weird' }).tab, undefined)

  const result = `{"v":1,"app":"canvas","sessionId":"s1","workspaceTag":"tag","displayPath":"draft.html","tab":"source"}\nCanvas opened for draft.html.`
  assert.deepEqual(descriptorFromResult(result), { v: 1, app: 'canvas', sessionId: 's1', workspaceTag: 'tag', displayPath: 'draft.html', tab: 'source' })
  assert.equal(descriptorFromResult('plain text result'), undefined)

  const missingSession = { ...descriptor, displayPath: 'missing-session.md' }
  delete missingSession.sessionId
  const restored = restoreTabs([
    tabFromDescriptor(descriptor),
    missingSession,
    tabFromDescriptor({ ...descriptor, displayPath: 'second.md' }),
    tabFromDescriptor(descriptor),
  ])
  assert.equal(restored.length, 2, 'missing session identity and duplicate keys are skipped')
  assert.deepEqual(restoreAll({ subject: restored, damaged: [{ app: 'browser' }] }), { subject: restored })
})

test('width ranges preserve the chat minimum and clamp into the available room', () => {
  assert.deepEqual(widthRangeOf('details', 1000), [320, 520])
  assert.deepEqual(widthRangeOf('browser', 1000), [360, 580])
  assert.deepEqual(widthRangeOf('reader', 700), [360, 360])
  assert.equal(clampWidth(900, widthRangeOf('canvas', 1000)), 580)
  assert.equal(clampWidth(100, widthRangeOf('reader', 700)), 360)
})

test('a revision message carries lines only for a unique quote and clips at 2000 characters', () => {
  const source = [
    '# Title',
    '',
    'before',
    'This exact sentence is repeated verbatim later in the fixture.',
    'middle',
    'unique passage',
    'after',
    'This exact sentence is repeated verbatim later in the fixture.',
  ].join('\n')
  assert.equal(lineRangeOf(source, 'unique passage')?.join('-'), '6-6')
  assert.equal(lineRangeOf(source, 'This exact sentence is repeated verbatim later in the fixture.'), null)
  assert.equal(lineRangeOf(source, 'missing'), null)

  const unique = revisionMessage({ displayPath: 'article.md', section: 'Editing contract', quote: 'unique passage', source, request: 'Tighten it.' })
  assert.match(unique, /^\[Reader revision\] article\.md §"Editing contract" \(lines 6-6\)/)
  assert.match(unique, /> unique passage/)
  assert.match(unique, /\n\nTighten it\.$/)

  const repeated = revisionMessage({ displayPath: 'article.md', section: 'Repeated passage', quote: 'This exact sentence is repeated verbatim later in the fixture.', source, request: '' })
  assert.doesNotMatch(repeated, /lines \d+-\d+/)
  assert.equal(repeated.endsWith('fixture.'), true)

  const clipped = revisionMessage({ displayPath: 'article.md', quote: 'x'.repeat(2001), source: 'x'.repeat(2001), request: '' })
  assert.equal(clipped.includes('x'.repeat(2001)), false)
  assert.match(clipped, /…$/)
})

test('readableMarkdown disables raw HTML and every image while leaving code untouched', () => {
  const input = [
    'intro <script>alert(1)</script> end',
    '![diagram](assets/diagram.svg)',
    'remote ![pixel](https://evil.example/pixel.png)',
    '`<b>inline stays</b>` and ![code image](x.png)',
    '```html',
    '<div>fenced stays raw</div>',
    '![inside fence](x.png)',
    '```',
  ].join('\n')
  const output = readableMarkdown(input)
  assert.match(output, /&lt;script>alert\(1\)&lt;\/script>/)
  assert.doesNotMatch(output, /!\[diagram\]\(assets\/diagram\.svg\)/)
  assert.match(output, /\[Image: diagram\]/)
  assert.match(output, /\[Image: pixel\]/)
  assert.doesNotMatch(output, /https:\/\/evil\.example\/pixel\.png/)
  assert.match(output, /`<b>inline stays<\/b>`/)
  assert.match(output, /<div>fenced stays raw<\/div>/)
  assert.match(output, /!\[inside fence\]\(x\.png\)/)
})

test('siblingPath accepts only relative Markdown links and never escapes the workspace', () => {
  assert.equal(siblingPath('docs/article.md', 'other.md#part'), 'docs/other.md')
  assert.equal(siblingPath('docs/article.md', 'nested/page.markdown?x=1'), 'docs/nested/page.markdown')
  assert.equal(siblingPath('docs/article.md', '../shared.md'), 'shared.md')
  assert.equal(siblingPath('docs/article.md', '../../outside.md'), null)
  assert.equal(siblingPath('docs/article.md', 'https://example.com/x.md'), null)
  assert.equal(siblingPath('docs/article.md', '/abs.md'), null)
  assert.equal(siblingPath('docs/article.md', 'C:\\abs.md'), null)
  assert.equal(siblingPath('docs/article.md', 'page.txt'), null)
  assert.equal(siblingPath('docs/article.md', '%E0%A4%A'), null)
  assert.equal(siblingPath('docs/article.md', 'component.MDX'), 'docs/component.MDX')
})

test('file sessions keep the first text as baseline, serialize reads and never apply stale answers', async () => {
  const waits = []
  const calls = []
  const read = (known) => {
    calls.push(known)
    return new Promise((resolve) => {
      waits.push(resolve)
    })
  }
  const session = createFileSession(read)
  void session.poll()
  const second = session.poll()
  assert.equal(waits.length, 1, 'a second ask while one read is out does not start another host request')
  assert.notEqual(second, undefined)

  waits.shift()({ kind: 'text', revision: 'r1', text: 'one' })
  await second
  assert.deepEqual(calls, [undefined])
  assert.equal(session.getSnapshot().status, 'ready')
  assert.equal(session.getSnapshot().base, 'one', 'the first complete text is the fallback diff baseline')
  assert.equal(session.getSnapshot().baseRevision, 'r1')

  const unchanged = session.poll()
  waits.shift()({ kind: 'unchanged', revision: 'r1' })
  await unchanged
  assert.deepEqual(calls, [undefined, 'r1'], 'the next read is conditional on the held revision')

  const changed = session.poll()
  waits.shift()({ kind: 'text', revision: 'r2', text: 'two' })
  await changed
  assert.equal(session.getSnapshot().text, 'two')
  assert.equal(session.getSnapshot().base, 'one', 'a refresh does not move the baseline')
  session.markReviewed()
  assert.equal(session.getSnapshot().base, 'two')
  assert.equal(session.getSnapshot().reviewed, true)

  session.setBase('host-before', 'host-base-revision')
  assert.equal(session.getSnapshot().base, 'host-before')
  assert.equal(session.getSnapshot().baseRevision, 'host-base-revision')
})

test('file sessions classify missing files without discarding their last text and back off after errors', async () => {
  const failures = [
    Object.assign(new Error('gone'), { code: 'bot/not-found' }),
    Object.assign(new Error('denied'), { code: 'bot/forbidden' }),
  ]
  const read = async () => { throw failures.shift() }
  const session = createFileSession(read)
  assert.equal(session.delay(), 2000, 'the first cadence is the two-second V1 interval')
  await session.poll()
  assert.equal(session.getSnapshot().status, 'missing')
  assert.equal(session.getSnapshot().text, null)
  assert.equal(session.delay(), 4000, 'one consecutive failure doubles the read interval')
  await session.poll()
  assert.equal(session.getSnapshot().status, 'error')
  assert.equal(session.delay(), 8000, 'two consecutive failures keep backing off exponentially')

  const healthy = createFileSession(async () => ({ kind: 'text', revision: 'r', text: 'alive' }))
  await healthy.poll()
  const failingRead = async () => { throw Object.assign(new Error('gone'), { code: 'bot/not-found' }) }
  const replacement = createFileSession(failingRead)
  await replacement.poll()
  assert.equal(replacement.getSnapshot().status, 'missing')
})

test('startPolling ticks immediately, pauses while inactive or hidden, and resumes with an immediate check', async () => {
  let ticks = 0
  const timers = []
  const fakeTimers = {
    set(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clear(timer) { if (timer) timer.cleared = true },
  }
  const listeners = new Map()
  const doc = {
    hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  }
  let active = true
  const stop = startPolling({ tick: async () => { ticks += 1 }, delay: () => 2000, active: () => active, doc, timers: fakeTimers })
  await flush()
  assert.equal(ticks, 1, 'activation reads immediately')
  assert.equal(timers.at(-1).ms, 2000)

  active = false
  timers.at(-1).fn()
  await flush()
  assert.equal(ticks, 1, 'an inactive tab does not read the file')
  active = true
  timers.at(-1).fn()
  await flush()
  assert.equal(ticks, 2)

  doc.hidden = true
  timers.at(-1).fn()
  await flush()
  assert.equal(ticks, 2, 'a hidden page does not read the file')
  doc.hidden = false
  listeners.get('visibilitychange')()
  await flush()
  assert.equal(ticks, 3, 'returning to the page checks at once')
  stop()
  const count = ticks
  timers.at(-1)?.fn?.()
  await flush()
  assert.equal(ticks, count, 'stopping ends the lifecycle')
})

test('file session cache is keyed by tab and drops with the tab lifecycle', () => {
  const tab = tabFromDescriptor({ ...descriptor, displayPath: 'cache.md' })
  let reads = 0
  const readFile = async () => { reads += 1; return { kind: 'unchanged', revision: 'r' } }
  const first = sessionFor(tab, readFile)
  const again = sessionFor({ ...tab }, readFile)
  assert.equal(first, again)
  dropSession(tab.key)
  const fresh = sessionFor(tab, readFile)
  assert.notEqual(fresh, first)
})

test('file sessions never bleed across two sessions that share one workspace file', () => {
  const own = tabFromDescriptor({ ...descriptor, displayPath: 'shared.md', sessionId: 's1' })
  const other = tabFromDescriptor({ ...descriptor, displayPath: 'shared.md', sessionId: 's2' })
  const readFile = async () => ({ kind: 'unchanged', revision: 'r' })
  const first = sessionFor(own, readFile)
  const second = sessionFor(other, readFile)
  assert.notEqual(first, second, 'the same file in a different conversation must not reuse the reading state')
})

test('marking one version reviewed does not suppress the host base of a later version', async () => {
  const bundledViews = await bundled('side-file-views.js')
  const answers = [
    { kind: 'text', revision: 'r1', text: 'one' },
    { kind: 'text', revision: 'r2', text: 'two' },
  ]
  const session = createFileSession(async () => answers.shift())
  await session.poll()
  await session.poll()
  session.markReviewed()
  answers.push({ kind: 'text', revision: 'r3', text: 'three' })
  await session.poll()
  const file = session.getSnapshot()
  assert.equal(file.revision, 'r3')
  // The host's before-text for r3 starts at r2, the version the user reviewed.
  const host = { kind: 'host', before: 'host-before-r3', baseRevision: 'r2', revision: 'r3' }
  const chosen = bundledViews.chooseBase({ file, host })
  assert.equal(chosen.source, 'host', 'a newer revision was never reviewed, so the host base applies again')
  assert.equal(chosen.text, 'host-before-r3')
  const reachesBack = bundledViews.chooseBase({ file, host: { ...host, baseRevision: 'r1', before: 'one' } })
  assert.equal(reachesBack.source, 'snapshot', 'a base from before the review would show reviewed changes as new')
  const sameReviewed = bundledViews.chooseBase({ file: { ...file, revision: 'r2' }, host: { kind: 'host', before: 'wrong', baseRevision: 'r1', revision: 'r2' } })
  assert.equal(sameReviewed.source, 'snapshot', 'the version the user actually reviewed stays snapshot-backed')
})

test('a claimed open re-checks the front conversation before opening the panel', async () => {
  const opensModule = await bundled('side-app-opens.js')
  assert.equal(typeof opensModule.stillInFront, 'function')
  assert.equal(opensModule.stillInFront({ sessionId: 's1', current: 's1', hidden: false }), true)
  assert.equal(opensModule.stillInFront({ sessionId: 's1', current: 's2', hidden: false }), false, 'the user moved to another conversation while the claim was out')
  assert.equal(opensModule.stillInFront({ sessionId: 's1', current: null, hidden: false }), false)
  assert.equal(opensModule.stillInFront({ sessionId: 's1', current: 's1', hidden: true }), false, 'a hidden window never opens the panel behind the user')
})

test('diffLines produces numbered rows, counts changes and normalizes line endings', () => {
  const diff = diffLines('one\r\ntwo\nthree\n', 'one\ntwo changed\nthree\nfour')
  assert.equal(diff.tooLarge, undefined)
  assert.deepEqual(diff.rows.map(row => row.kind), ['same', 'del', 'add', 'same', 'add'], 'removed lines come before the added lines that replace them')
  assert.equal(diff.rows[1].text, 'two')
  assert.equal(diff.rows[1].from, 2)
  assert.equal(diff.rows[1].to, null)
  assert.equal(diff.rows[2].text, 'two changed')
  assert.equal(diff.rows[2].from, null)
  assert.equal(diff.rows[2].to, 2)
  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 1)
  assert.equal(changeRuns(diff.rows), 2)

  const empty = diffLines('', '')
  assert.deepEqual(empty.rows, [])
  assert.equal(diffLines('same\n', 'same\n').rows.every(row => row.kind === 'same'), true)
  assert.equal(diffLines('x'.repeat(1024 * 1024 + 1), 'x').tooLarge, true)
  assert.equal(diffLines(Array.from({ length: 5001 }, (_, i) => `line ${i}`).join('\n'), 'x').tooLarge, true)
})

test('foldRows hides long unchanged runs with context and can reopen them', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 5', 'line 5 changed').replace('line 26', 'line 26 changed')
  const rows = diffLines(before, after).rows
  const folded = foldRows(rows)
  const folds = folded.filter(row => row.kind === 'fold')
  assert.equal(folds.length, 1, 'the long middle run folds while short edge runs stay open')
  assert.equal(folds[0].count, 14, 'three context lines remain on both sides of the change')
  assert.equal(folded.some(row => row.kind === 'same' && row.text === 'line 8'), true)
  assert.equal(folded.some(row => row.kind === 'same' && row.text === 'line 12'), false)
  assert.equal(folded.some(row => row.kind === 'same' && row.text === 'line 23'), true)
  const open = foldRows(rows, new Set([folds[0].id]))
  assert.equal(open.some(row => row.kind === 'fold'), false, 'the fold row id actually reopens its hidden rows')
  assert.equal(open.length, rows.length, 'opening the fold renders the whole row list')
  assert.equal(open.some(row => row.kind === 'same' && row.text === 'line 12'), true, 'the hidden middle rows are visible once opened')
})

test('a card that names preview takes an open diff tab back to preview, a plain open leaves it', () => {
  const { tab: _named, ...plain } = descriptor
  const diff = openFileTab([], tabFromDescriptor({ ...plain, tab: 'diff' })).tabs
  assert.equal(diff[0].mode, 'diff')
  assert.equal(openFileTab(diff, tabFromDescriptor(plain)).tabs[0].mode, 'diff', 'no view named: the tab stays')
  assert.equal(openFileTab(diff, tabFromDescriptor({ ...plain, tab: 'preview' })).tabs[0].mode, 'preview', 'preview named: the tab goes back')
  assert.equal('asked' in diff[0], false, 'the request flag is not kept on the tab')
})