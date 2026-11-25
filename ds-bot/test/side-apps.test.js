import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// The pure modules, bundled the way the client is and run with only what they need.
async function load(entry) {
  const { outputFiles } = await build({
    stdin: { contents: `export * from './src/client/${entry}'`, resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  const react = { createElement: () => null, useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }), useState: init => [init, () => {}], useSyncExternalStore: (sub, get) => get() }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: false }) }, document: { hidden: false }, localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => { throw new Error('no network in tests') },
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  return module.exports
}

const plain = value => JSON.parse(JSON.stringify(value))
const apps = await load('side-apps.js')
const diff = await load('line-diff.js')

const descriptor = { v: 1, app: 'reader', workspaceTag: 'tag1', displayPath: 'docs/report.md', sessionId: 's1' }

test('a descriptor needs a known file App, a tag and a path; anything else is refused', () => {
  assert.deepEqual(plain(apps.parseDescriptor(descriptor)), descriptor)
  assert.equal(apps.parseDescriptor({ ...descriptor, app: 'browser' }), undefined)
  assert.equal(apps.parseDescriptor({ ...descriptor, v: 2 }), undefined)
  assert.equal(apps.parseDescriptor({ ...descriptor, workspaceTag: '' }), undefined)
  assert.equal(apps.parseDescriptor({ ...descriptor, displayPath: '' }), undefined)
  assert.equal(apps.parseDescriptor(null), undefined)
  assert.equal(apps.parseDescriptor({ ...descriptor, tab: 'weird' }).tab, undefined)
  assert.equal(apps.parseDescriptor({ ...descriptor, tab: 'diff' }).tab, 'diff')
})

test('the first line of an open tool result is its descriptor', () => {
  assert.deepEqual(plain(apps.descriptorFromResult(`${JSON.stringify(descriptor)}\nReader opened for docs/report.md.`)), descriptor)
  assert.equal(apps.descriptorFromResult('Could not open the file: nope'), undefined)
  assert.equal(apps.descriptorFromResult('{not json'), undefined)
  assert.equal(apps.descriptorFromResult(''), undefined)
})

test('opening the same file twice focuses its tab instead of adding one', () => {
  const tab = apps.tabFromDescriptor(apps.parseDescriptor(descriptor), 's1')
  const first = apps.openFileTab([], tab)
  assert.equal(first.tabs.length, 1)
  assert.equal(first.active, tab.key)
  const again = apps.openFileTab(first.tabs, { ...tab, mode: 'preview' })
  assert.equal(again.tabs.length, 1)
  assert.equal(again.active, tab.key)
  const other = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: 'docs/other.md' }), 's1')
  assert.equal(apps.openFileTab(again.tabs, other).tabs.length, 2)
})

test('a descriptor that names a mode switches an open tab to it; one that does not leaves its mode alone', () => {
  const tab = apps.tabFromDescriptor(apps.parseDescriptor(descriptor), 's1')
  const withSource = apps.setTabMode([tab], tab.key, 'source')
  assert.equal(apps.openFileTab(withSource, { ...tab, mode: 'preview' }).tabs[0].mode, 'source')
  assert.equal(apps.openFileTab(withSource, { ...tab, mode: 'diff' }).tabs[0].mode, 'diff')
})

test('a full strip refuses a ninth tab instead of dropping one that may hold an unreviewed diff', () => {
  let tabs = []
  for (let index = 0; index < apps.FILE_TABS_MAX; index += 1) {
    tabs = apps.openFileTab(tabs, apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: `d/${index}.md` }), 's1')).tabs
  }
  const extra = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: 'd/extra.md' }), 's1')
  const result = apps.openFileTab(tabs, extra)
  assert.equal(result.full, true)
  assert.equal(result.tabs.length, apps.FILE_TABS_MAX)
  assert.equal(result.active, null)
  assert.equal(apps.closeFileTab(tabs, tabs[0].key).length, apps.FILE_TABS_MAX - 1)
})

test('same-named files tell themselves apart by their folder', () => {
  const a = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: 'a/notes.md' }), 's1')
  const b = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: 'b/notes.md' }), 's1')
  const c = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, displayPath: 'plan.md' }), 's1')
  const labels = apps.tabLabels([a, b, c])
  assert.equal(labels.get(a.key), 'a/notes.md')
  assert.equal(labels.get(b.key), 'b/notes.md')
  assert.equal(labels.get(c.key), 'plan.md')
})

test('storage keeps a tab\'s identity and mode, and a damaged entry is skipped on the way back', () => {
  const tab = apps.tabFromDescriptor(apps.parseDescriptor({ ...descriptor, tab: 'source' }), 's1')
  const saved = apps.persistAll({ s1: [tab], empty: [] })
  assert.deepEqual(Object.keys(saved), ['s1'])
  assert.equal(JSON.stringify(saved).includes('text'), false)
  const back = apps.restoreAll(JSON.parse(JSON.stringify(saved)))
  assert.equal(back.s1[0].key, tab.key)
  assert.equal(back.s1[0].mode, 'source')
  assert.deepEqual(plain(apps.restoreAll({ s1: [{ app: 'canvas' }, 'junk', null] })), {})
  assert.deepEqual(plain(apps.restoreAll('nope')), {})
  assert.deepEqual(plain(apps.restoreAll([1, 2])), {})
})

test('each App has its own width range, and the Reader never grows past its reading width', () => {
  assert.deepEqual(plain(apps.widthRangeOf('details', 1400)), [320, 520])
  assert.deepEqual(plain(apps.widthRangeOf('browser', 1400)), [360, 980])
  assert.deepEqual(plain(apps.widthRangeOf('canvas', 1400)), [400, 980])
  assert.deepEqual(plain(apps.widthRangeOf('reader', 1400)), [360, 720])
  // A window with no room still gets a usable minimum: the panel covers the chat instead.
  assert.deepEqual(plain(apps.widthRangeOf('canvas', 500)), [400, 400])
  assert.equal(apps.clampWidth(5000, [400, 980]), 980)
  assert.equal(apps.clampWidth(10, [400, 980]), 400)
  assert.deepEqual(plain(apps.PANEL_MINIMUMS), { details: 320, browser: 360, side: 320, task: 320, canvas: 400, reader: 360 })
  assert.equal(apps.isSideApp('canvas'), true)
  assert.equal(apps.isSideApp('nope'), false)
  assert.equal(apps.isFileApp('browser'), false)
})

test('a selection finds its lines only when it appears once in the file', () => {
  const source = '# Title\n\nFirst paragraph.\n\nSecond paragraph\nruns on.\n\nFirst paragraph.\n'
  assert.equal(apps.lineRangeOf(source, 'First paragraph.'), null)
  assert.deepEqual(plain(apps.lineRangeOf(source, 'Second paragraph\nruns on.')), [5, 6])
  assert.equal(apps.lineRangeOf(source, 'not there'), null)
  assert.equal(apps.lineRangeOf(source, '   '), null)
})

test('the revision message names the file and section, quotes the text, and guesses no lines', () => {
  const source = 'one\n\ntwo two\n'
  const message = apps.revisionMessage({ displayPath: 'docs/a.md', section: 'Risks', quote: 'two two', source, request: 'Make it shorter' })
  assert.equal(message, '[Reader revision] docs/a.md §"Risks" (lines 3-3)\n> two two\n\nMake it shorter')
  const twice = apps.revisionMessage({ displayPath: 'docs/a.md', section: '', quote: 'x', source: 'x\nx\n', request: '' })
  assert.equal(twice, '[Reader revision] docs/a.md\n> x')
  const long = apps.revisionMessage({ displayPath: 'a.md', section: '', quote: 'y'.repeat(2500), source: '', request: '' })
  assert.ok(long.includes('…'))
  assert.ok(long.length < 2100)
  const multi = apps.revisionMessage({ displayPath: 'a.md', section: '', quote: 'l1\r\nl2', source: '', request: 'ok' })
  assert.equal(multi, '[Reader revision] a.md\n> l1\n> l2\n\nok')
})

test('reading a file never loads a pixel, a page or a script', () => {
  const safe = apps.readableMarkdown('Hello ![logo](https://evil.example/x.png) <img src=x onerror=alert(1)> <script>alert(1)</script>\n![](a.png)')
  assert.equal(safe.includes('<img'), false)
  assert.equal(safe.includes('<script'), false)
  assert.equal(safe.includes('evil.example'), false)
  assert.ok(safe.includes('&lt;script'))
  assert.ok(safe.includes('[Image: logo]'))
  assert.ok(safe.endsWith('[Image]'))
  // Code stays as written.
  const code = apps.readableMarkdown('```html\n<div>![x](y.png)</div>\n```\nand `<b>inline</b>` here')
  assert.ok(code.includes('<div>![x](y.png)</div>'))
  assert.ok(code.includes('`<b>inline</b>`'))
})

test('only a Markdown file beside the open one is a link the Reader follows', () => {
  assert.equal(apps.siblingPath('docs/a.md', 'b.md'), 'docs/b.md')
  assert.equal(apps.siblingPath('docs/a.md', './sub/c.markdown#part'), 'docs/sub/c.markdown')
  assert.equal(apps.siblingPath('docs/sub/a.md', '../b.md'), 'docs/b.md')
  assert.equal(apps.siblingPath('docs/a.md', 'https://example.com/b.md'), null)
  assert.equal(apps.siblingPath('docs/a.md', '/etc/passwd.md'), null)
  assert.equal(apps.siblingPath('docs/a.md', '../../../out.md'), null)
  assert.equal(apps.siblingPath('docs/a.md', 'image.png'), null)
  assert.equal(apps.siblingPath('docs/a.md', '#top'), null)
  assert.equal(apps.siblingPath('a.md', '..\\b.md'), null)
  assert.equal(apps.siblingPath('a.md', 'javascript:alert(1).md'), null)
})

// ---- the line diff ------------------------------------------------------------------

test('a diff marks added and removed lines and keeps both sides\' line numbers', () => {
  const result = diff.diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
  assert.equal(result.added, 2)
  assert.equal(result.removed, 1)
  assert.deepEqual(plain(result.rows.map(row => `${row.kind}:${row.text}`)), ['same:a', 'del:b', 'add:B', 'same:c', 'same:d', 'add:e'])
  const added = result.rows.find(row => row.text === 'B')
  assert.equal(added.to, 2)
  assert.equal(added.from, null)
  assert.equal(result.rows.find(row => row.text === 'b').from, 2)
})

test('equal texts, line-ending differences and an empty side behave', () => {
  assert.equal(diff.diffLines('x\ny', 'x\ny').added, 0)
  assert.equal(diff.diffLines('x\r\ny\r\n', 'x\ny\n').removed, 0)
  const fresh = diff.diffLines('', 'one\ntwo')
  assert.equal(fresh.added, 2)
  assert.equal(fresh.removed, 0)
  assert.equal(diff.diffLines('one\ntwo', '').removed, 2)
})

test('a diff too large to compute says so instead of freezing the panel', () => {
  const big = Array.from({ length: diff.DIFF_LINES_MAX + 1 }, (_, index) => `line ${index}`).join('\n')
  assert.equal(diff.diffLines(big, 'x').tooLarge, true)
  assert.equal(diff.diffLines('x', big).tooLarge, true)
  assert.equal(diff.diffLines('a'.repeat(diff.DIFF_CHARS_MAX + 1), 'b').tooLarge, true)
})

test('long unchanged runs fold, an opened fold shows its lines, short runs stay', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `l${index}`)
  const changed = [...lines]
  changed[15] = 'CHANGED'
  const { rows } = diff.diffLines(lines.join('\n'), changed.join('\n'))
  const folded = diff.foldRows(rows)
  const folds = folded.filter(row => row.kind === 'fold')
  assert.equal(folds.length, 2)
  assert.equal(folds[0].count, 15 - 3)
  assert.equal(folds[1].count, 30 - 16 - 3)
  const opened = diff.foldRows(rows, new Set([folds[0].id]))
  assert.equal(opened.filter(row => row.kind === 'fold').length, 1)
  const small = diff.diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne')
  assert.equal(diff.foldRows(small.rows).filter(row => row.kind === 'fold').length, 0)
})

test('the change count counts separate runs, not lines', () => {
  const { rows } = diff.diffLines('a\nb\nc\nd\ne\nf', 'a\nB\nB2\nd\ne\nF')
  assert.equal(diff.changeRuns(rows), 2)
  assert.equal(diff.changeRuns(diff.diffLines('a', 'a').rows), 0)
})

test('a picture is shown only when it stands alone on its line and points into the article folder', () => {
  const parts = apps.readerParts('# T\n\n![fig one](img/a.png)\nlead ![inline](b.png) text\n![up](../c.png)\n![away](https://evil.example/d.png)\n![abs](/e.png)\n![bad](f.exe)\n![](g.webp)\n', 'docs/post.md')
  const images = JSON.parse(JSON.stringify(parts.filter(part => part.kind === 'image').map(part => [part.path, part.alt])))
  assert.deepEqual(images, [['docs/img/a.png', 'fig one'], ['docs/g.webp', '']])
  const words = parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
  assert.ok(words.includes('[Image: inline]') && words.includes('[Image: up]') && words.includes('[Image: away]') && words.includes('[Image: abs]') && words.includes('[Image: bad]'))
  assert.ok(!words.includes('](') || !/!\[/.test(words))
})

test('image paths cannot leave the article folder or pick another kind of file', () => {
  assert.equal(apps.siblingImagePath('docs/a.md', 'x.png'), 'docs/x.png')
  assert.equal(apps.siblingImagePath('docs/a.md', './img/x%20y.JPG?raw=1#top'), 'docs/img/x y.JPG')
  assert.equal(apps.siblingImagePath('a.md', 'x.png'), 'x.png')
  for (const bad of ['../x.png', 'img/../../x.png', 'img/..\\x.png', '/x.png', '\\x.png', '//host/x.png', 'C:/x.png', 'file:///x.png', 'data:image/png;base64,AA', 'x.html', 'x', '', 'img/', '%2e%2e/x.png', 'x%00.png']) {
    assert.equal(apps.siblingImagePath('docs/a.md', bad), null, bad)
  }
})

test('pictures inside code fences stay text and the number of pictures is capped', () => {
  const fenced = apps.readerParts('```md\n![a](a.png)\n```\n~~~\n![b](b.png)\n~~~', 'p.md')
  assert.equal(fenced.filter(part => part.kind === 'image').length, 0)
  const many = Array.from({ length: apps.READER_IMAGES_MAX + 5 }, (_, i) => `![n](${i}.png)`).join('\n')
  const parts = apps.readerParts(many, 'p.md')
  assert.equal(parts.filter(part => part.kind === 'image').length, apps.READER_IMAGES_MAX)
  assert.ok(parts.at(-1).kind === 'text' && parts.at(-1).text.includes('[Image: n]'))
})