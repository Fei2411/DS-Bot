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
  export { createElement, Fragment, Profiler } from 'react'
  export { createRoot } from 'react-dom/client'
  export { flushSync } from 'react-dom'
  export { MarkdownText } from './ui/src/primitives.js'
  export { MathExpression, ensureKatex, normalizeMathDelimiters } from './ui/src/math-render.js'
  export { ensureLanguage } from './ui/src/code-highlight.js'
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
const {
  createElement: h,
  Profiler,
  createRoot,
  flushSync,
  MarkdownText,
  MathExpression,
  ensureKatex,
  normalizeMathDelimiters,
  ensureLanguage,
} = await import(pathToFileURL(bundlePath).href)

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

test('display math (\\[...\\] and $$...$$) keeps block splitting intact and matches settled render', async () => {
  await ensureKatex()
  const { splitMarkdownBlocks } = await import('../../ds-bot/src/client/markdown-blocks.js')
  const normalized = normalizeMathDelimiters('Intro paragraph \\[a^2 + b^2\\] outro paragraph')
  assert.equal(normalized, 'Intro paragraph\n\n$$\na^2 + b^2\n$$\n\noutro paragraph')
  assert.deepEqual(splitMarkdownBlocks(normalized), ['Intro paragraph\n\n', '$$\na^2 + b^2\n$$\n\n', 'outro paragraph'])

  const mathReply = [
    'Introduction with enough text to exceed the streaming split threshold smoothly. '.repeat(8).trim(),
    '',
    '\\[',
    '\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}',
    '\\]',
    '',
    'Middle explanation with inline $E = mc^2$ and \\(\\alpha + \\beta\\) and $5 and $10 currency.',
    '',
    '$$',
    '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
    '$$',
    '',
    'Closing summary paragraph.',
  ].join('\n')

  const settled = mounted()
  settled.render(h(MarkdownText, { text: mathReply, labels }))
  const fold = html => html.replace(/>\n</g, '><')
  const reference = fold(settled.container.innerHTML)
  settled.unmount()

  const streamed = mounted()
  let acc = ''
  let beforeCount = renderCount()
  const perChunk = []
  for (let at = 0; at < mathReply.length; at += 19) {
    acc = mathReply.slice(0, at + 19)
    streamed.render(h(MarkdownText, { text: acc, streaming: true, labels }))
    perChunk.push(renderCount() - beforeCount)
    beforeCount = renderCount()
  }
  const beforeSettle = renderCount()
  streamed.render(h(MarkdownText, { text: mathReply, streaming: false, labels }))
  const settleParses = renderCount() - beforeSettle
  assert.equal(fold(streamed.container.innerHTML), reference, 'streamed display math matches settled render')
  assert.equal(streamed.container.querySelectorAll('.dsb-math-block').length, 2, 'both \\[...\\] and $$...$$ render as display math')
  assert.ok(settleParses <= 1, `streaming -> settled transition only touches tail block, got ${settleParses} parses`)
  streamed.unmount()
})

test('streaming tail defers syntax highlighting for unclosed code fences and defers KaTeX for unclosed math until closed', async () => {
  await ensureLanguage('javascript')
  await ensureKatex()

  const prefix = 'Closed introductory paragraph long enough to pass the streaming block threshold. '.repeat(8).trim()
  const view = mounted()
  try {
    // Unclosed JS fence in streaming tail renders plain code without hljs tokens.
    const unclosedCode = `${prefix}\n\n\`\`\`javascript\nconst value = 42\nexport function run() {`
    view.render(h(MarkdownText, { text: unclosedCode, streaming: true, labels }))
    assert.equal(view.container.querySelectorAll('.hljs-keyword').length, 0, 'unclosed fence skips syntax highlighting while streaming')
    assert.ok(view.container.textContent.includes('const value = 42'), 'unclosed fence still shows plain code text')

    // Closing the fence highlights immediately.
    const closedCode = `${unclosedCode}\n  return value\n}\n\`\`\``
    view.render(h(MarkdownText, { text: closedCode, streaming: true, labels }))
    assert.ok(view.container.querySelectorAll('.hljs-keyword').length > 0, 'closed fence syntax-highlights')

    // Unclosed `$$` display math in streaming tail skips KaTeX until closing `$$`.
    const unclosedDollar = `${prefix}\n\n$$\n\\frac{a + b}{c`
    view.render(h(MarkdownText, { text: unclosedDollar, streaming: true, labels }))
    assert.equal(view.container.innerHTML.includes('class="katex"'), false, 'unclosed $$ skips KaTeX while streaming')
    assert.ok(view.container.textContent.includes('\\frac{a + b}{c'), 'unclosed $$ displays raw TeX fallback')

    const closedDollar = `${unclosedDollar}}\n$$`
    view.render(h(MarkdownText, { text: closedDollar, streaming: true, labels }))
    assert.equal(view.container.innerHTML.includes('class="katex"'), true, 'closed $$ renders KaTeX')

    // Unclosed single-line `$$` and unclosed inline `$` skip KaTeX while streaming.
    const unclosedInlineDollar = `${prefix}\n\nThe partial formula is $E = m c^2`
    view.render(h(MarkdownText, { text: unclosedInlineDollar, streaming: true, labels }))
    assert.equal(view.container.innerHTML.includes('class="katex"'), false, 'unclosed single $ skips KaTeX')

    const unclosedSingleLineDisplay = `${prefix}\n\n$$x^2 + y^2`
    view.render(h(MarkdownText, { text: unclosedSingleLineDisplay, streaming: true, labels }))
    assert.equal(view.container.innerHTML.includes('class="katex"'), false, 'unclosed single-line $$ skips KaTeX')

    // Unclosed ```math fence skips KaTeX until closed.
    const unclosedMathFence = `${prefix}\n\n\`\`\`math\nx^2 + y^2`
    view.render(h(MarkdownText, { text: unclosedMathFence, streaming: true, labels }))
    assert.equal(view.container.innerHTML.includes('class="katex"'), false, 'unclosed ```math fence skips KaTeX')
  } finally {
    view.unmount()
  }
})

test('MathExpression is memoized and skips re-render when tex and display are unchanged', async () => {
  await ensureKatex()
  assert.equal(MathExpression.$$typeof, Symbol.for('react.memo'), 'MathExpression is wrapped in React.memo')
  let renders = 0
  const origType = MathExpression.type
  MathExpression.type = function SpyMathExpression(props) {
    renders += 1
    return origType(props)
  }
  function Wrapper({ tick, tex }) {
    return h('div', { 'data-tick': tick },
      h(MathExpression, { tex, display: false }))
  }
  const view = mounted()
  try {
    view.render(h(Wrapper, { tick: 1, tex: 'E = mc^2' }))
    assert.equal(renders, 1)
    view.render(h(Wrapper, { tick: 2, tex: 'E = mc^2' }))
    view.render(h(Wrapper, { tick: 3, tex: 'E = mc^2' }))
    assert.equal(renders, 1, 'memoized MathExpression does not re-render on unrelated parent updates')
    view.render(h(Wrapper, { tick: 4, tex: 'a^2 + b^2' }))
    assert.equal(renders, 2, 'memoized MathExpression re-renders when tex changes')
  } finally {
    MathExpression.type = origType
    view.unmount()
  }
})

test('differential streaming contract: final streaming:false DOM matches whole-document render byte-for-byte across adversarial and random Markdown corpuses', async () => {
  await ensureKatex()
  await ensureLanguage('javascript')
  await ensureLanguage('python')
  const fold = html => html.replace(/>\n</g, '><')
  const pad = 'Introductory prose long enough to cross the 512-byte streaming split threshold cleanly. '.repeat(7).trim()

  const corpus = [
    ['orderedListSplitMidDigit2', `${pad}\n\n1. First item\n\n2. Second item\n\nAfter.\n`],
    ['orderedListSplitMidDigit1', `${pad}\n\n1. First item\n\n1. Second item\n\nAfter.\n`],
    ['unclosedLiteralLatexBeforeLinkDef', `See [x]. ${pad}\n\nHere is a literal \\[ bracket.\n\n[x]: https://example.com\n`],
    ['multilineInlineCodeLatexBeforeLinkDef', `See [x]. ${pad}\n\nHere is \`multi-line\ncode with \\[ inside\` end.\n\n[x]: https://example.com\n`],
    ['unclosedLatexBeforeFenceWithCloseBracket', `See [x]. ${pad}\n\nStart \\[ unclosed\n\n\`\`\`js\nconst s = "\\\\]"\n\`\`\`\n\n[x]: https://example.com\n`],
    ['literalLatexClosedInInlineCodeAfterLinkDef', `See [x]. ${pad}\n\nLiteral \\[ open\n\n[x]: https://example.com\n\n\`\\]\`\n`],
    ['inlineDollarWithCjkPunctBeforeDisplayAndDef', `See [x]. ${pad}\n\n$$x^2$$。\n$$\na + b\n$$\n\n[x]: https://example.com\n`],
    ['inlineDollarWithProseThenPara', `${pad}\n\n$$x^2$$ and more prose.\n\nNext paragraph with $y = 2$.\n`],
    ['indentedSetextInList', `${pad}\n\n## item\n\n- item\n  -\n\nNext.\n`],
    ['nestedLooseLists', `${pad}\n\n- outer 1\n\n  - inner a\n\n  - inner b\n\n- outer 2\n\nDone.\n`],
    ['codeFenceContainingMathTokens', `${pad}\n\n\`\`\`js\nconst a = "$$x^2$$"\nconst b = "\\\\[y\\\\]"\nconst c = "$5"\n\`\`\`\n\nAfter.\n`],
    ['inlineCodeContainingDollars', `${pad}\n\nUse \`$$raw$$\` and \`\\[raw\\]\` inline.\n\nNext.\n`],
    ['currencyAndEscapedDollars', `${pad}\n\nItems cost $5 and $10, or \\$20 total, while $x + y = z$.\n\nNext.\n`],
    ['tableWithMathAndCurrency', `${pad}\n\n| expr | price |\n| --- | --- |\n| $a^2$ | $5 |\n| \\(b^2\\) | $10 |\n\nAfter.\n`],
    ['blockquoteWithDisplayMath', `${pad}\n\n> $$\n> x^2 + 1\n> $$\n\n> \\[\n> y^2\n> \\]\n\nAfter.\n`],
    ['rawHtmlBlock', `${pad}\n\n<div>\n<p>raw</p>\n</div>\n\nAfter.\n`],
    ['footnoteAcrossBlocks', `${pad} with note[^1].\n\nMiddle paragraph.\n\n[^1]: Footnote body.\n`],
    ['crlfDocument', `${pad}\r\n\r\n$$\r\nx^2\r\n$$\r\n\r\nAfter.\r\n`],
    ['cjkAndEmoji', `${pad}\n\n中文段落 🚀 与行内公式 $E=mc^2$ 和 $$a+b$$。\n\n下一段。\n`],
    ['unclosedFenceAtEof', `${pad}\n\n\`\`\`javascript\nconst a = 1\nexport function f() {`],
    ['unclosedIndentedFenceAtEof', `${pad}\n\n  \`\`\`javascript\n  const a = 1\n  return a`],
    ['unclosedLatexAtEof', `${pad}\n\n\\[\n\\sum_{k=1}^n k`],
    ['unclosedMultilineDollarWithMetaText', `${pad}\n\n$$x^2 + y\n+ z`],
    ['closedMultilineDollarWithBody', `${pad}\n\n$$\n\\frac{1}{2}\n\n+ \\frac{1}{3}\n$$\n\nAfter.\n`],
    ['closedLatexDisplayWithBlankLine', `${pad}\n\n\\[\n\\int_0^1 x\\,dx\n\n= \\frac{1}{2}\n\\]\n\nAfter.\n`],
    ['duplicateCodeBlocksNoSplit', `See [x]. ${pad}\n\n\`\`\`javascript\nconst dup = 1\n\`\`\`\n\n\`\`\`javascript\nconst dup = 1\n\`\`\`\n\n[x]: https://example.com\n`],
    ['lazyContinuationList', `${pad}\n\n1. First line\nlazy second line\n\n2. Second item\n\nDone.\n`],
    ['indentedCodeContinuation', `${pad}\n\n    line one\n\n    line two\n\nPlain.\n`],
    ['listWithIndentedFence', `${pad}\n\n1. Step\n\n   \`\`\`python\n   x = 1\n   \`\`\`\n\n2. Step two\n\nDone.\n`],
    ['thematicBreakAndSetext', `${pad}\n\nHeading\n---\n\n***\n\nAfter.\n`],
    ['containerDirective', `${pad}\n\n::: note\ninside\n:::\n\nAfter.\n`],
    ['inlineLatexDisplayMidParagraph', `${pad}\n\nBefore \\[a^2 + b^2\\] after.\n\nDone.\n`],
  ]

  // Deterministic seeded pseudo-random Markdown generator to catch unexpected boundary interactions.
  let seed = 0x5eed1234
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const fragments = [
    'Plain paragraph with $E = mc^2$ and $5 currency.',
    '## Section Heading',
    '1. Ordered item one\n\n2. Ordered item two',
    '- Bullet item one\n\n- Bullet item two',
    '```javascript\nconst k = 42\nreturn k + 1\n```',
    '$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$',
    '\\[\n\\int_0^1 x^2\\,dx\n\\]',
    '$$x^2$$。',
    'Literal \\[ without close.',
    'See [ref] in text.',
    '[ref]: https://example.com/ref',
    '> Quoted line\n> second line',
  ]
  for (let i = 0; i < 8; i += 1) {
    const parts = [pad]
    const count = 4 + Math.floor(rand() * 5)
    for (let j = 0; j < count; j += 1) {
      parts.push(fragments[Math.floor(rand() * fragments.length)])
    }
    corpus.push([`randomDoc_${i}`, `${parts.join('\n\n')}\n`])
  }

  for (const [name, doc] of corpus) {
    const settled = mounted()
    settled.render(h(MarkdownText, { text: doc, streaming: false, labels }))
    const expected = fold(settled.container.innerHTML)
    settled.unmount()

    // Test multiple chunking schedules including prime sizes and randomized variable steps.
    const schedules = [
      () => {
        const cuts = []
        for (let at = 17; at < doc.length; at += 17) cuts.push(at)
        return cuts
      },
      () => {
        const cuts = []
        let at = 0
        while (at < doc.length) {
          at += 1 + Math.floor(rand() * 37)
          if (at < doc.length) cuts.push(at)
        }
        return cuts
      },
    ]

    for (let sIdx = 0; sIdx < schedules.length; sIdx += 1) {
      const view = mounted()
      try {
        for (const cut of schedules[sIdx]()) {
          view.render(h(MarkdownText, { text: doc.slice(0, cut), streaming: true, labels }))
        }
        view.render(h(MarkdownText, { text: doc, streaming: true, labels }))
        view.render(h(MarkdownText, { text: doc, streaming: false, labels }))
        assert.equal(
          fold(view.container.innerHTML),
          expected,
          `differential mismatch on ${name} (schedule ${sIdx})`,
        )
      } finally {
        view.unmount()
      }
    }
  }

  // Exact targeted boundary repros:
  // (a) Chunk cut right after bare digit `2` in loose ordered list.
  const orderedDoc = `${pad}\n\n1. First item\n\n2. Second item\n\nAfter.\n`
  const orderedCut = orderedDoc.indexOf('2. Second') + 1
  const settledOrdered = mounted()
  settledOrdered.render(h(MarkdownText, { text: orderedDoc, streaming: false, labels }))
  const expectedOrdered = fold(settledOrdered.container.innerHTML)
  settledOrdered.unmount()

  const streamedOrdered = mounted()
  streamedOrdered.render(h(MarkdownText, { text: orderedDoc.slice(0, orderedCut), streaming: true, labels }))
  streamedOrdered.render(h(MarkdownText, { text: orderedDoc, streaming: true, labels }))
  streamedOrdered.render(h(MarkdownText, { text: orderedDoc, streaming: false, labels }))
  assert.equal(fold(streamedOrdered.container.innerHTML), expectedOrdered, 'exact bare-digit cut keeps single loose <ol>')
  streamedOrdered.unmount()

  // (b) Tail rewrite from plain text to `- second item`.
  const rewriteBefore = `${pad}\n\n- first item\n\nplain text`
  const rewriteAfter = `${pad}\n\n- first item\n\n- second item\n`
  const settledRewrite = mounted()
  settledRewrite.render(h(MarkdownText, { text: rewriteAfter, streaming: false, labels }))
  const expectedRewrite = fold(settledRewrite.container.innerHTML)
  settledRewrite.unmount()

  const streamedRewrite = mounted()
  streamedRewrite.render(h(MarkdownText, { text: rewriteBefore, streaming: true, labels }))
  streamedRewrite.render(h(MarkdownText, { text: rewriteAfter, streaming: true, labels }))
  streamedRewrite.render(h(MarkdownText, { text: rewriteAfter, streaming: false, labels }))
  assert.equal(fold(streamedRewrite.container.innerHTML), expectedRewrite, 'tail rewrite to list item keeps single loose <ul>')
  streamedRewrite.unmount()
})

test('unclosed streaming code fence targets only the last block by position, defers indented fences, and keeps multi-line $$ opening text visible', async () => {
  await ensureLanguage('javascript')
  await ensureKatex()

  const view = mounted()
  try {
    // 1. Duplicate code block (split === false): an unclosed second fence with identical text
    //    must NOT strip syntax highlighting from the earlier closed code block.
    const dupStreaming = 'Short doc\n\n```javascript\nconst x = 1\n```\n\n```javascript\nconst x = 1'
    view.render(h(MarkdownText, { text: dupStreaming, streaming: true, labels }))
    const codeBlocks = view.container.querySelectorAll('.md-code')
    assert.equal(codeBlocks.length, 2)
    assert.ok(codeBlocks[0].querySelectorAll('.hljs-keyword').length > 0, 'earlier closed duplicate code block keeps highlighting')
    assert.equal(codeBlocks[1].querySelectorAll('.hljs-keyword').length, 0, 'only the trailing unclosed code block defers highlighting')

    // 2. Indented unclosed code fence (2 spaces) still defers highlighting while streaming.
    const indentedStreaming = 'Short doc\n\n  ```javascript\n  const y = 2\n  return y'
    view.render(h(MarkdownText, { text: indentedStreaming, streaming: true, labels }))
    assert.equal(view.container.querySelectorAll('.hljs-keyword').length, 0, 'indented unclosed fence defers highlighting')

    // 3. Multi-line unclosed `$$x^2 + y\n+ z` keeps `x^2 + y` visible instead of swallowing it as meta.
    const multiLineUnclosedMath = 'Short doc\n\n$$x^2 + y\n+ z'
    view.render(h(MarkdownText, { text: multiLineUnclosedMath, streaming: true, labels }))
    assert.ok(view.container.textContent.includes('x^2 + y'), 'multi-line unclosed $$ keeps opening-line body visible')
    assert.equal(view.container.innerHTML.includes('class="katex"'), false, 'unclosed multi-line $$ skips KaTeX')
  } finally {
    view.unmount()
  }
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})
