// End-to-end test of the streaming Markdown fast path in app/ui/src/primitives.js, with
// the real react-markdown pipeline and the real React 19 reconciler (mini-dom). It proves two
// things the unit tests cannot:
//
//  1. The split render's DOM is identical to the settled full-document render, so a reply
//     that streamed in pieces looks exactly like one rendered whole.
//  2. While chunks arrive, the closed blocks never re-parse: counting every react-markdown
//     invocation shows the per-chunk cost stays flat instead of growing with the reply.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMiniDom } from './mini-dom.mjs'

// Minimal DOM globals must exist before react-dom evaluates.
installMiniDom()

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

const appDir = fileURLToPath(new URL('..', import.meta.url))
const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: appDir,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  alias: { 'react-markdown': shimPath },
  // Resolve React and Markdown deps strictly from app/node_modules so standalone
  // `Desktop app profile` CI (without ds-bot/node_modules) bundles ../ds-bot/src/client/*.
  nodePaths: [join(appDir, 'node_modules')],
})

const bundlePath = join(dir, 'bundle.mjs')
writeFileSync(bundlePath, outputFiles[0].text)
const { createElement: h, createRoot, flushSync, MarkdownText } = await import(pathToFileURL(bundlePath).href)

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


test('reference definitions in containers and escaped labels fall back to the whole-document parse', async () => {
  // The detector over-approximates exactly the lines micromark would read as a link
  // reference definition wherever containers can hide them; every one of these must
  // render byte-identically to the settled whole-document render — and since a definition
  // anywhere is a definition everywhere, that is the one correct parse.
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const cases = {
    inBlockquote: `[x] the link\n\n${prose}\n\n> [x]: https://example.com\n\ntail paragraph\n`,
    inNestedBlockquote: `[x] the link\n\n${prose}\n\n> > [x]: https://example.com\n\ntail paragraph\n`,
    inListItem: `[x] the link\n\n${prose}\n\n- item\n\n    [x]: https://example.com\n\ntail paragraph\n`,
    escapedLabel: `[a\\]b] the link\n\n${prose}\n\n[a\\]b]: https://example.com\n\ntail paragraph\n`,
  }
  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length > 512, `${name} passes the split threshold`)
    assert.equal(splitMarkdownBlocks(text), null, `${name} never splits`)
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} matches the settled render byte for byte`)
    assert.match(streamed.container.innerHTML, /href="https:\/\/example\.com"/, `${name} resolves the reference`)
    streamed.unmount()
  }
})


test('a definition on the final line without a trailing newline never splits', async () => {
  // The streaming steady state has no trailing newline; a reference definition or a
  // footnote definition that lands there reaches backwards across the document exactly
  // as any other, so these fall back to the one correct whole-document parse.
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const cases = {
    finalLineLinkDef: `See [the link] you need.

${prose}

[the link]: https://example.com`,
    finalLineFootnoteDef: `The text carries a note[^1] inside it.

${prose}

[^1]: the note itself`,
  }
  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length > 512, `${name} passes the split threshold`)
    assert.ok(!text.endsWith('\n'), `${name} ends without a trailing newline`)
    assert.equal(splitMarkdownBlocks(text), null, `${name} never splits`)
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} matches the settled render byte for byte`)
    streamed.unmount()
  }
  // The reference actually resolves and the footnote actually links in the fallback.
  const linked = mounted()
  linked.render(h(MarkdownText, { text: cases.finalLineLinkDef, streaming: true, labels }))
  assert.match(linked.container.innerHTML, /href="https:\/\/example\.com"/)
  linked.unmount()
})

test('tab-prefixed container definitions fall back to the whole-document parse', async () => {
  // A tab separates a list marker or blockquote marker from its content exactly as a
  // space does, so a definition behind one is a definition all the same.
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const cases = {
    tabAfterDashMarker: `Use [x] inline.

${prose}

-	[x]: /url

tail
`,
    tabAfterOrderedMarker: `Use [x] inline.

${prose}

1.	[x]: /url

tail
`,
    tabAfterQuoteMarker: `Use [x] inline.

${prose}

>	[x]: /url

tail
`,
    tabListContinuation: `Use [x] inline.

${prose}

- item

	[x]: /url

tail
`,
  }
  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length > 512, `${name} passes the split threshold`)
    assert.equal(splitMarkdownBlocks(text), null, `${name} never splits`)
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} matches the settled render byte for byte`)
    streamed.unmount()
  }
})

test('brackets that never open a definition split normally: task lists, inline links, bracketed expressions', async () => {
  // The split only yields to real reference definitions; ordinary bracket syntax in LLM
  // output keeps the streaming fast path, and the pieces render exactly the whole.
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const cases = {
    taskList: `- [ ] the first task
- [x] the second task

${prose}

A closing paragraph.
`,
    linkInListItem: `- [the docs](https://example.com) and more prose

${prose}

A closing paragraph.
`,
    inlineLinkLine: `[the docs](https://example.com) starts this line as an inline link

${prose}

A closing paragraph.
`,
    bracketExpression: `para

    [x] = compute()

${prose}

A closing paragraph.
`,
  }
  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length > 512, `${name} passes the split threshold`)
    const blocks = splitMarkdownBlocks(text)
    assert.ok(blocks !== null && blocks.length > 1, `${name} splits into real blocks`)
    assert.equal(blocks.join(''), text, `${name} joins back exactly`)
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    // Stream it chunk by chunk, as a reply arrives.
    let acc = ''
    for (let at = 0; at < text.length; at += 13) {
      acc = text.slice(0, at + 13)
      streamed.render(h(MarkdownText, { text: acc, streaming: true, labels }))
    }
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} streamed matches the settled render byte for byte`)
    streamed.unmount()
  }
})

test('backtick fence lookalikes with backticks in info string never hide definitions or invert real fences', async () => {
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const linkCase = `Use [x] inline.\n\n${prose}\n\n\`\`\`a\`b\n\n[x]: https://example.com\n`
  assert.equal(splitMarkdownBlocks(linkCase), null)
  const codeCase = `${prose}\n\n\`\`\`markdown example: \`code\`\n\n\`\`\`\nreal code line one\n\nreal code line two\n\`\`\`\n\ntail\n`
  const blocks = splitMarkdownBlocks(codeCase)
  assert.ok(blocks !== null && blocks.length > 1)
  assert.equal(blocks.join(''), codeCase)

  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of [['hiddenLinkDef', linkCase], ['invertedRealFence', codeCase]]) {
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} streamed matches settled byte for byte`)
    streamed.unmount()
  }
})

test('list-hosted fences never truncate top-level code blocks or restart numbered steps during streaming', async () => {
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const prose = 'prose that fills the reply well past the split threshold. '.repeat(12)
  const unclosedListFence = `${prose}\n\n- Example:\n  \`\`\`text\n  inside\n\nOutside the list.\n\n\`\`\`\nline one\n\nline two\n\`\`\`\n\nDone.\n`
  assert.equal(splitMarkdownBlocks(unclosedListFence), null)

  const numberedWithCode = `${prose}\n\n1. Step one\n\n   \`\`\`sh\n   echo one\n   \`\`\`\n\n1. Step two\n\nClosing paragraph.\n`
  const blocks = splitMarkdownBlocks(numberedWithCode)
  assert.ok(blocks !== null && blocks.length >= 2, 'keeps splitting outside the list')
  assert.equal(blocks.join(''), numberedWithCode)

  const fold = html => html.replace(/>\n</g, '><')
  for (const [name, text] of [['unclosedListFence', unclosedListFence], ['numberedWithCode', numberedWithCode]]) {
    const settled = mounted()
    settled.render(h(MarkdownText, { text, labels }))
    const reference = fold(settled.container.innerHTML)
    settled.unmount()
    const streamed = mounted()
    streamed.render(h(MarkdownText, { text, streaming: true, labels }))
    assert.equal(fold(streamed.container.innerHTML), reference, `${name} streamed matches settled byte for byte`)
    if (name === 'unclosedListFence') {
      const codes = streamed.container.querySelectorAll('code')
      assert.ok(codes.some(node => node.textContent.includes('line one') && node.textContent.includes('line two')), 'top-level code block keeps both lines intact')
    } else {
      const lists = streamed.container.querySelectorAll('ol')
      assert.equal(lists.length, 1, 'both numbered steps stay in a single ordered list')
      assert.equal(lists[0].querySelectorAll('li').length, 2, 'ordered list contains both items')
    }
    streamed.unmount()
  }
  // Ordered list with unindented lazy continuation line followed by blank line and next `1.` item.
  const lazyOrderedList = `${'Introduction paragraph with enough text to pass the 512-byte streaming threshold cleanly. '.repeat(7)}\n\n1. First step wraps\non second line\n\n1. Second step\n`
  const settledLazy = mounted()
  settledLazy.render(h(MarkdownText, { text: lazyOrderedList, labels }))
  const lazyRef = fold(settledLazy.container.innerHTML)
  settledLazy.unmount()
  const streamedLazy = mounted()
  streamedLazy.render(h(MarkdownText, { text: lazyOrderedList, streaming: true, labels }))
  assert.equal(fold(streamedLazy.container.innerHTML), lazyRef, 'lazy-continuation ordered list matches settled byte for byte')
  assert.equal(streamedLazy.container.querySelectorAll('ol').length, 1, 'lazy-continuation ordered list stays one <ol>')
  assert.equal(streamedLazy.container.querySelectorAll('li').length, 2, 'lazy-continuation ordered list keeps both items')
  streamedLazy.unmount()

  // 4-6 space closing fence inside a list item followed by an indented link reference definition.
  const deepClosingFenceWithDef = `${'Intro paragraph referencing [deep] with enough text to exceed the streaming threshold. '.repeat(8)}\n\n- Item:\n  \`\`\`js\n  code()\n    \`\`\`\n  [deep]: https://example.com/deep\n`
  const settledDeep = mounted()
  settledDeep.render(h(MarkdownText, { text: deepClosingFenceWithDef, labels }))
  const deepRef = fold(settledDeep.container.innerHTML)
  settledDeep.unmount()
  const streamedDeep = mounted()
  streamedDeep.render(h(MarkdownText, { text: deepClosingFenceWithDef, streaming: true, labels }))
  assert.equal(fold(streamedDeep.container.innerHTML), deepRef, '4-space closing fence inside list followed by link def matches settled')
  assert.ok(streamedDeep.container.querySelectorAll('a').length > 0, 'link definition after 4-space closing fence still resolves')
  streamedDeep.unmount()
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})
