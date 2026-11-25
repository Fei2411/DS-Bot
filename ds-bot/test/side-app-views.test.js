import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

async function load(source) {
  const { outputFiles } = await build({
    stdin: { contents: source, resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  let slots = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
    useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
    useState: (init) => { const at = index++; slots[at] ??= { value: typeof init === 'function' ? init() : init }; return [slots[at].value, (next) => { slots[at].value = typeof next === 'function' ? next(slots[at].value) : next }] },
    useSyncExternalStore: (sub, get) => get(),
    useId: () => 'id',
    useCallback: fn => fn,
    createContext: value => ({ Provider: () => null, _currentValue: value }),
    useContext: context => context?._currentValue,
    memo: component => component,
    forwardRef: component => component,
  }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, body: {} }, localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 0 }, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : { MarkdownText: () => null, writeClipboard: () => Promise.resolve(true) }),
  })
  return { exports: module.exports, render: (fn) => { slots = []; index = 0; return fn() } }
}

const walk = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => walk(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...walk(node.props?.children, check)]
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return String(node ?? '')
  return textOf(node.props?.children)
}
const plain = value => JSON.parse(JSON.stringify(value))

const views = await load("export * from './src/client/side-file-views.js'")
const card = await load("export * from './src/client/side-app-card.js'; export { opensToClaim } from './src/client/side-app-opens.js'")
const canvas = await load("export * from './src/client/canvas-app.js'")

const descriptor = { v: 1, app: 'canvas', workspaceTag: 't1', displayPath: 'site/index.html', sessionId: 's1' }
const result = text => [{ type: 'text', text }]

test('the mode switch labels Canvas Render and Reader Read, and shows how many changes wait', () => {
  const { ModeSwitch, MODE_LABELS } = views.exports
  assert.equal(MODE_LABELS.canvas.preview, 'Render')
  assert.equal(MODE_LABELS.reader.preview, 'Read')
  const picked = []
  const tree = views.render(() => ModeSwitch({ app: 'canvas', mode: 'source', onMode: id => picked.push(id), changes: 3 }))
  const buttons = walk(tree, node => node.type === 'button')
  assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [false, true, false])
  assert.ok(textOf(buttons[2]).includes('3'))
  buttons[0].props.onClick()
  buttons[2].props.onClick()
  assert.deepEqual(picked, ['preview', 'diff'])
})

test('a missing file and a failed read say different things, and only a failure offers a retry by itself', () => {
  const { FileEmpty } = views.exports
  const missing = views.render(() => FileEmpty({ status: 'missing', path: 'a.html', onRetry: () => {} }))
  assert.ok(textOf(missing).includes('File not found'))
  assert.ok(textOf(missing).includes('a.html'))
  const failed = views.render(() => FileEmpty({ status: 'error', path: 'a.html', message: 'Denied', onRetry: () => {} }))
  assert.ok(textOf(failed).includes('Denied'))
  assert.equal(walk(failed, node => node.type === 'button').length, 1)
  assert.ok(textOf(views.render(() => FileEmpty({ status: 'loading', path: 'a.html' }))).includes('Loading'))
})

test('the source view shows every line numbered and cuts a very large file with a notice', () => {
  const { SourceView } = views.exports
  const small = views.render(() => SourceView({ text: 'a\nb\nc' }))
  assert.equal(walk(small, node => node.props?.className === 'bt-sapp-line').length, 3)
  const huge = views.render(() => SourceView({ text: 'x'.repeat(600 * 1024) }))
  assert.ok(textOf(huge).includes('Showing the first 512 KiB'))
})

test('the diff view marks added and removed lines for assistive tech and folds the quiet middle', () => {
  const { DiffView } = views.exports
  const file = { text: 'one\nTWO\nthree', base: 'one\ntwo\nthree', revision: 'r2', baseRevision: 'r1', reviewed: false }
  const tree = views.render(() => DiffView({ file, host: null, onReviewed: () => {} }))
  const lines = walk(tree, node => node.props?.className === 'bt-sapp-line')
  assert.deepEqual(lines.map(line => line.props['data-kind']), ['same', 'del', 'add', 'same'])
  assert.ok(textOf(tree).includes('removed'))
  assert.ok(textOf(tree).includes('added'))
  assert.ok(textOf(tree).includes('since this tab opened'))
  const same = views.render(() => DiffView({ file: { ...file, text: file.base }, host: null, onReviewed() {} }))
  assert.ok(textOf(same).includes('No changes to review'))
  const hosted = views.render(() => DiffView({ file, host: { kind: 'host', before: 'zero\ntwo\nthree', baseRevision: 'rb', revision: 'r2' }, onReviewed() {} }))
  assert.ok(textOf(hosted).includes("last edit"))
  const waiting = views.render(() => DiffView({ file: { text: null, base: null }, host: null, onReviewed() {} }))
  assert.ok(textOf(waiting).includes('Nothing to compare yet'))
})

test('the diff count is what the mode switch shows', () => {
  const { diffCount } = views.exports
  assert.equal(diffCount({ text: 'a\nb', base: 'a\nb', revision: 'r' }, null), 0)
  assert.equal(diffCount({ text: 'a\nB\nc\nD', base: 'a\nb\nc\nd', revision: 'r' }, null), 2)
  assert.equal(diffCount({ text: null, base: null }, null), 0)
})

test('the card draws from the call alone, and only a good result can be opened again', () => {
  const { SideAppCard } = card.exports
  const opened = []
  const actions = { openSideApp: (...args) => { opened.push(args); return Promise.resolve() }, reportError() {} }
  const arg = name => (name === 'path' ? 'site/index.html' : undefined)
  const done = card.render(() => SideAppCard({ tool: 'open_canvas', done: true, isError: false, content: result(`${JSON.stringify(descriptor)}\nCanvas opened.`), arg, sessionId: 's1', actions }))
  assert.ok(textOf(done).includes('index.html'))
  assert.ok(textOf(done).includes('site/index.html'))
  const button = walk(done, node => node.type === 'button')[0]
  button.props.onClick()
  assert.equal(opened.length, 1)
  assert.equal(opened[0][0], 's1')
  assert.deepEqual(plain(opened[0][1]), descriptor)
  assert.equal(opened[0][2].reopen, true)
  const running = card.render(() => SideAppCard({ tool: 'open_canvas', done: false, content: [], arg, sessionId: 's1', actions }))
  assert.ok(textOf(running).includes('Opening'))
  assert.equal(walk(running, node => node.type === 'button').length, 0)
  const refused = card.render(() => SideAppCard({ tool: 'open_reader', done: true, isError: false, content: result('Could not open the file: The file is no longer there'), arg: name => (name === 'path' ? 'gone.md' : undefined), sessionId: 's1', actions }))
  assert.ok(textOf(refused).includes("Couldn't open gone.md"))
  assert.equal(walk(refused, node => node.type === 'button').length, 0)
  assert.equal(card.exports.isOpenTool('open_reader'), true)
  assert.equal(card.exports.isOpenTool('show_view'), false)
})

test('a window claims an open only when it is in front and shows that conversation', () => {
  const { opensToClaim } = card.exports
  const opens = { s1: { openId: 'o1', v: 1, app: 'canvas', workspaceTag: 't1', displayPath: 'a.html', sessionId: 's1' }, s2: { openId: 'o2', v: 1, app: 'reader', workspaceTag: 't1', displayPath: 'b.md', sessionId: 's2' } }
  const claimed = new Set()
  const mine = opensToClaim({ opens, current: 's1', hidden: false, claimed })
  assert.equal(mine.length, 1)
  assert.equal(mine[0].openId, 'o1')
  assert.equal(mine[0].descriptor.displayPath, 'a.html')
  assert.equal(opensToClaim({ opens, current: 's1', hidden: true, claimed }).length, 0)
  assert.equal(opensToClaim({ opens, current: null, hidden: false, claimed }).length, 0)
  assert.equal(opensToClaim({ opens, current: 's3', hidden: false, claimed }).length, 0)
  claimed.add('o1')
  assert.equal(opensToClaim({ opens, current: 's1', hidden: false, claimed }).length, 0)
  assert.equal(opensToClaim({ opens: null, current: 's1', hidden: false, claimed: new Set() }).length, 0)
  assert.equal(opensToClaim({ opens: { s1: { openId: 'o9', app: 'browser' } }, current: 's1', hidden: false, claimed: new Set() }).length, 0)
})

test('the preview frame loads the ticketed address with the revision that made it new, and has no way out', () => {
  const { frameSrc, CANVAS_SANDBOX, DEVICES } = canvas.exports
  assert.equal(frameSrc('http://h/api/bot-canvas/tk/index.html', 'abc'), 'http://h/api/bot-canvas/tk/index.html?r=abc')
  assert.equal(frameSrc('http://h/x?y=1', 'a b'), 'http://h/x?y=1&r=a%20b')
  assert.equal(frameSrc('', 'abc'), '')
  const flags = CANVAS_SANDBOX.split(' ')
  assert.deepEqual(plain(flags), ['allow-scripts'])
  for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-downloads', 'allow-modals', 'allow-forms']) assert.equal(flags.includes(forbidden), false, forbidden)
  assert.deepEqual(plain(DEVICES.map(device => device[0])), ['fit', 'phone', 'tablet'])
})
