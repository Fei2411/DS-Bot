import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><body></body>')
const { document } = dom.window

const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/reading.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useState: init => [init, () => {}],
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document, window: dom.window, getComputedStyle: node => dom.window.getComputedStyle(node),
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { headingsIn, outlineOf: outlineIn, pillPlace: placeIn, readingBand: bandIn, sectionAt } = module.exports
// Values made in the bundle's context have its prototypes; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value))
const outlineOf = headings => plain(outlineIn(headings))
const pillPlace = (rect, band, above) => plain(placeIn(rect, band, above))
const readingBand = scroller => plain(bandIn(scroller))

const reply = (html) => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

test('a reply lists its own headings, not those in a quote, a table or a folded detail', () => {
  const root = reply(`
    <h2>Plan</h2><p>…</p>
    <blockquote><h3>Quoted</h3></blockquote>
    <table><tr><td><h4>In a cell</h4></td></tr></table>
    <details><summary>More</summary><h3>Hidden</h3></details>
    <h3>  Step   one </h3><h5>Too deep</h5><h2> </h2><h3>Step two</h3>`)
  assert.deepEqual(plain(headingsIn(root).map(node => node.textContent.trim())), ['Plan', 'Step   one', 'Step two'])
})

test('the outline needs two sections and indents from the highest level the reply uses', () => {
  assert.deepEqual(outlineOf(headingsIn(reply('<h2>Only one</h2>'))), [])
  const outline = outlineOf(headingsIn(reply('<h2>A</h2><h3>A.1</h3><h4>A.1.a</h4><h2>B\n  part</h2>')))
  assert.deepEqual(outline, [
    { text: 'A', depth: 0 }, { text: 'A.1', depth: 1 }, { text: 'A.1.a', depth: 2 }, { text: 'B part', depth: 0 },
  ])
  assert.deepEqual(outlineOf(headingsIn(reply('<h1>Top</h1><h4>Deep</h4>'))).map(entry => entry.depth), [0, 2])
})

test('the section being read is the last heading at or above the reading line', () => {
  assert.equal(sectionAt([], 100), -1)
  assert.equal(sectionAt([150, 400], 100), -1)
  assert.equal(sectionAt([100, 400], 100), 0)
  assert.equal(sectionAt([-900, -20, 101], 100), 1)
  assert.equal(sectionAt([-900, -20, 90], 100), 2)
})

test('the pill shows only inside a reply taller than the band whose start has scrolled away', () => {
  const band = { top: 66, bottom: 700, left: 200, right: 1160 }
  const rect = (top, height, left = 240) => ({ top, bottom: top + height, height, left })
  // Fits the band: nothing to come back to.
  assert.equal(pillPlace(rect(-100, 600), band), null)
  // Its start is still in view.
  assert.equal(pillPlace(rect(60, 2000), band), null)
  // Too little of it is left under the pill.
  assert.equal(pillPlace(rect(-1900, 2000), band), null)
  assert.deepEqual(pillPlace(rect(-500, 2000), band), { top: 66, left: 240 })
  // A reply wider than the scroller keeps the pill inside it.
  assert.deepEqual(pillPlace(rect(-500, 2000, 150), band), { top: 66, left: 208 })
  // The "N new messages ↑" pill keeps its place; this one goes under it, or stays beside it.
  assert.deepEqual(pillPlace(rect(-500, 2000), band, { left: 400, right: 560, top: 66, bottom: 94 }), { top: 102, left: 240 })
  assert.deepEqual(pillPlace(rect(-500, 2000), band, { left: 640, right: 800, top: 66, bottom: 94 }), { top: 66, left: 240 })
})

test('the band starts under DS Bot\'s header over the scroller and ends above DSH\'s composer', () => {
  const scroller = document.createElement('div')
  scroller.style.setProperty('--dsh-composer-height', '140px')
  const head = document.createElement('div')
  head.className = 'bt-head'
  document.body.append(scroller, head)
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 300, right: 1200, height: 800 })
  head.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 300, right: 1200, height: 40 })
  assert.deepEqual(readingBand(scroller), { top: 58, bottom: 660, left: 300, right: 1200 })
  // The desktop app's composer sits below its scroller, so nothing is taken off.
  scroller.style.removeProperty('--dsh-composer-height')
  // A header beside the scroller (another pane's) is not this chat's.
  head.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 280, height: 40 })
  assert.deepEqual(readingBand(scroller), { top: 8, bottom: 800, left: 300, right: 1200 })
  scroller.remove()
  head.remove()
})

test('the pill is a glass surface that pops in with the tap spring and stays still with reduced motion', () => {
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The whole line: the rule's spring interpolates, so a brace does not end it.
  const rule = bundle.match(/\n\.bt-reading\{(.*)\r?\n/)?.[1]
  assert.ok(rule, 'no .bt-reading rule')
  assert.match(rule, /position:fixed/)
  assert.match(rule, /background:var\(--bt-glass-bg\)/)
  assert.match(rule, /animation:bt-pop-drop \$\{SPRING_TAP\.duration\}ms \$\{SPRING_TAP\.easing\}/)
  assert.match(bundle, /\.bt-reading\[data-leaving\]\{pointer-events:none;animation:bt-pop-out \.12s/)
  assert.match(bundle, /@media \(prefers-reduced-motion:reduce\)\{\.bt-reading\{animation:none\}\}/)
  // A Bot reply carries the guide, idle while it streams or is folded.
  assert.match(bundle, /\(ReplyGuide, \{ box: bubble, active: !live && !folded \}\)/)
})
