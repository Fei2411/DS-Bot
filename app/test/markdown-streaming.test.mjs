// End-to-end test of the streaming Markdown fast path in app/ui/src/primitives.js, with
// the real react-markdown pipeline and the real React reconciler (jsdom). It proves two
// things the unit tests cannot:
//
//  1. The split render's DOM is identical to the settled full-document render, so a reply
//     that streamed in pieces looks exactly like one rendered whole.
//  2. While chunks arrive, the closed blocks never re-parse: counting every react-markdown
//     invocation shows the per-chunk cost stays flat instead of growing with the reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
// jsdom comes from the plugin's harness install, as the other DOM tests load it.
const harness = process.env.DSH_HARNESS ?? fileURLToPath(new URL('../../ds-bot/dev/harness', import.meta.url))
const { JSDOM } = createRequire(join(harness, 'package.json'))('jsdom')

// jsdom globals must exist before react-dom evaluates.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (globalThis[key] === undefined) globalThis[key] = dom.window[key]
}
if (globalThis.window === undefined) globalThis.window = dom.window

const reactMarkdown = fileURLToPath(import.meta.resolve('react-markdown'))

// Bundle primitives.js and the whole React pipeline into one ESM file, counting every
// invocation of react-markdown's component through a shim. One bundle means one copy of
// React, which memoization needs.
const entryCode = `
  export { createElement, Fragment } from 'react'
  export { createRoot } from 'react-dom/client'
  export { flushSync } from 'react-dom'
  export { MarkdownText } from './ui/src/primitives.js'
`
// A tiny real file stands in for the react-markdown import inside the bundle and counts
// every component invocation, so the test can measure how often anything re-parses.
const dir = mkdtempSync(join(tmpdir(), 'md-stream-test-'))
const shimPath = join(dir, 'counting-markdown.mjs')
writeFileSync(shimPath, `
import RealMarkdown from ${JSON.stringify(reactMarkdown)}
export default function CountingMarkdown(props) {
  globalThis.__mdCount = (globalThis.__mdCount || 0) + 1
  return RealMarkdown(props)
}
`)

const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  alias: { 'react-markdown': shimPath },
})

const bundlePath = join(dir, 'bundle.mjs')
writeFileSync(bundlePath, outputFiles[0].text)
const { createElement: h, createRoot, flushSync, MarkdownText } = await import(bundlePath)

const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' } }
const renderCount = () => globalThis.__mdCount ?? 0

function mounted() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return {
    container,
    render(element) {
      flushSync(() => root.render(element))
    },
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

const reply = [
  'Here is the plan, laid out in detail with enough prose to pass the split threshold.',
  '',
  '## First section',
  '',
  'A paragraph of explanation that goes on for a while, with `inline code` and **bold**',
  'text spread over two lines so the paragraphs have some realistic bulk to them.',
  '',
  '- the first step, explained',
  '- the second step, also explained',
  '',
  '```js',
  'const inputs = collect()',
  'validate(inputs)',
  'run(inputs)',
  '```',
  '',
  '## Second section',
  '',
  'More prose follows here. It keeps the reply long enough that splitting happens well',
  'before the text is done streaming, which is exactly what the fast path is for.',
  '',
  '| step | owner |',
  '| ---- | ----- |',
  '| one  | bot   |',
  '',
  'The closing paragraph wraps everything up and ends the reply.',
].join('\n')

test('the split streaming render ends byte-identical to the settled full render', () => {
  assert.ok(reply.length > 512, 'the fixture passes the split threshold')
  // Settled, one parse of the whole document.
  const settled = mounted()
  settled.render(h(MarkdownText, { text: reply, labels }))
  const settledHtml = settled.container.innerHTML
  settled.unmount()

  // Streamed in small chunks, one render per chunk, then the same document.
  const streamed = mounted()
  const chunks = []
  for (let at = 0; at < reply.length; at += 11) chunks.push(reply.slice(at, at + 11))
  let text = ''
  for (const chunk of chunks) {
    text += chunk
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
  }
  // react-markdown emits a newline text node between the top-level blocks of one parse,
  // which a concatenation of pieces has no reason to produce. They are whitespace between
  // block elements — no rendering can depend on them — so the comparison folds them away
  // and everything else must be byte-identical.
  const fold = html => html.replace(/>\n</g, '><')
  assert.equal(fold(streamed.container.innerHTML), fold(settledHtml), 'streamed split render matches the settled full render')
  streamed.unmount()

  // A settled render of the same text through the streaming path (streaming still on at
  // the end, as the last chunk leaves it) also matches: the pieces concatenate cleanly.
  const hybrid = mounted()
  hybrid.render(h(MarkdownText, { text: reply, streaming: true, labels }))
  assert.equal(fold(hybrid.container.innerHTML), fold(settledHtml))
  hybrid.unmount()
})

test('closed blocks never re-parse as chunks arrive: the parse count stays flat per chunk', () => {
  const view = mounted()
  const chunks = []
  for (let at = 0; at < reply.length; at += 9) chunks.push(reply.slice(at, at + 9))
  let text = ''
  const increments = []
  let last = renderCount()
  for (const chunk of chunks) {
    text += chunk
    view.render(h(MarkdownText, { text, streaming: true, labels }))
    increments.push(renderCount() - last)
    last = renderCount()
  }
  view.unmount()
  // One chunk is allowed a burst: the first time the text passes the split threshold the
  // already closed blocks mount once. After that every chunk re-parses only the live tail
  // (1) plus at most one newly closed block's first mount (2) — a closed block never
  // parses a second time.
  const bursts = increments.map((n, i) => [n, i]).filter(([n]) => n > 2)
  assert.ok(bursts.length <= 1, `at most one initial-mount burst, got ${increments.join(',')}`)
  if (bursts.length === 1) {
    const afterBurst = increments.slice(bursts[0][1] + 1)
    assert.ok(afterBurst.every(n => n <= 2), `chunks after the burst stay flat, got ${afterBurst.join(',')}`)
  }
  const total = increments.reduce((sum, n) => sum + n, 0)
  // Whole-document parsing would re-parse every block per chunk; here the total is
  // bounded by the chunks plus the handful of block mounts.
  const naive = chunks.length * 5
  assert.ok(total < naive / 2, `total parses ${total} stay far below whole-document parsing (${naive}+)`)
  assert.ok(total <= chunks.length + 8, `total parses ${total} track chunk count ${chunks.length} plus block mounts`)
})

test('short replies and document-wide syntax keep the single whole-document parse', () => {
  const short = 'a short **reply** without enough length to split'
  assert.ok(short.length <= 512)
  const view = mounted()
  view.render(h(MarkdownText, { text: short, streaming: true, labels }))
  assert.match(view.container.innerHTML, /<strong>reply<\/strong>/)
  view.unmount()

  // A link reference definition anywhere means no split, but the output is unchanged.
  const refs = `${'prose with a [link][ref] and more words to pass the threshold. '.repeat(8)}\n\n[ref]: https://example.com\n`
  const linked = mounted()
  linked.render(h(MarkdownText, { text: refs, streaming: true, labels }))
  assert.match(linked.container.innerHTML, /href="https:\/\/example\.com"/, 'the reference-style link resolves in the whole-document fallback')
  linked.unmount()

  // Non-streaming renders behave exactly as before this change.
  const plain = mounted()
  plain.render(h(MarkdownText, { text: reply, streaming: false, labels }))
  const settled = mounted()
  settled.render(h(MarkdownText, { text: reply, labels }))
  assert.equal(plain.container.innerHTML, settled.container.innerHTML)
  plain.unmount()
  settled.unmount()
})

test('the split keeps one flat .md_markdown wrapper: no nested markdown divs, blocks as direct children', () => {
  const view = mounted()
  view.render(h(MarkdownText, { text: reply, streaming: true, labels }))
  const root = view.container.querySelector('.md_markdown')
  assert.ok(root, 'the outer markdown wrapper exists')
  assert.equal(root.querySelectorAll('.md_markdown').length, 0, 'no nested markdown wrappers inside')
  // Top-level blocks (headings, paragraphs, lists, pre) sit directly in the wrapper,
  // exactly as a single-parse render lays them out.
  const tags = [...root.children].map(node => node.tagName.toLowerCase())
  assert.deepEqual(tags, ['p', 'h2', 'p', 'ul', 'div', 'h2', 'p', 'table', 'p'])
  view.unmount()
})

test('teardown: the bundle file goes away with the temp directory', () => {
  rmSync(dir, { recursive: true, force: true })
})
