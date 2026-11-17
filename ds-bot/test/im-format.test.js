import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkMarkdown, chunkTelegram, toPlain, toTelegramHtml } from '../src/host/im/format.js'

test('Markdown becomes Telegram HTML', () => {
  assert.equal(toTelegramHtml('**bold** and _ital_'), '<b>bold</b> and <i>ital</i>')
  assert.equal(toTelegramHtml('run `rm -rf` now'), 'run <code>rm -rf</code> now')
  assert.equal(toTelegramHtml('see [the docs](https://a.b/c)'), 'see <a href="https://a.b/c">the docs</a>')
  assert.equal(toTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
  const fenced = toTelegramHtml('before\n```js\nlet x = 1 < 2\n```\nafter')
  assert.equal(fenced, 'before\n<pre><code class="language-js">let x = 1 &lt; 2</code></pre>\nafter')
  assert.equal(toTelegramHtml('done ~~deal~~'), 'done <s>deal</s>')
})

test('Markdown becomes plain text', () => {
  assert.equal(toPlain('**bold** `code` [site](https://a.b)'), 'bold code site (https://a.b)')
  assert.equal(toPlain('```\nlet x = 1\n```'), 'let x = 1')
})

test('chunks stay under the limit and keep whole fences', () => {
  const fence = '```\n' + 'x'.repeat(200) + '\n```'
  const chunks = chunkTelegram(`start\n\n${fence}\n\nend`, 100)
  assert.ok(chunks.length > 1)
  const whole = chunks.find(chunk => chunk.html.includes('<pre><code>'))
  assert.ok(whole.html.length <= 100)
  // The 200-char fence cannot fit, so it is split into several fenced blocks.
  for (const chunk of chunks) assert.ok(chunk.html.length <= 100, chunk.html.length)
  // A fence that fits is not cut.
  const fits = chunkTelegram(`a\n\n${fence}`, 300)
  assert.equal(fits.length, 1)
  assert.ok(fits[0].html.includes('<pre><code>'))
})

test('an oversized line is hard cut and stays under the limit', () => {
  const chunks = chunkTelegram('y'.repeat(9000), 4096)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.html.length <= 4096)
})

test('chunkMarkdown drops blank lines at the start and end of a message', () => {
  assert.deepEqual(chunkMarkdown('\n\nbody\n\n', 4096), ['body'])
  assert.deepEqual(chunkMarkdown('\n\n \n\t\nbody\n\n  \n', 4096), ['body'])
  assert.deepEqual(chunkMarkdown('\r\n\r\nbody\r\n   \r\n', 4096), ['body'])
  // Full-width spaces on edge lines are dropped too, while many internal blank lines stay linear.
  assert.deepEqual(chunkMarkdown('\u3000\n\u3000\nbody\n\u3000\n', 4096), ['body'])
  const manyNewlines = `a${'\n'.repeat(30_000)}b`
  const started = performance.now()
  assert.deepEqual(chunkMarkdown(manyNewlines, 40_000), [manyNewlines])
  assert.ok(performance.now() - started < 200)
  // Blank lines inside the text and indentation of a content line stay as written.
  assert.deepEqual(chunkMarkdown('\n\none\n\ntwo\n\n', 4096), ['one\n\ntwo'])
  assert.deepEqual(chunkMarkdown('\n  indented\n\n', 4096), ['  indented'])
  assert.deepEqual(chunkMarkdown('\n\n```js\n\nlet x = 1\n\n```\n\n', 4096), ['```js\n\nlet x = 1\n\n```'])
})

test('chunkMarkdown sends nothing for a message that is only whitespace', () => {
  assert.deepEqual(chunkMarkdown('', 4096), [])
  assert.deepEqual(chunkMarkdown('\n\n   \n\t\n', 4096), [])
  assert.deepEqual(chunkMarkdown('   ', 4096), [])
})

test('chunkMarkdown trims the edges of a message cut into several chunks', () => {
  const body = 'a'.repeat(60)
  const chunks = chunkMarkdown(`\n\n${body}\n\n${body}\n\n`, 60)
  assert.deepEqual(chunks, [body, body])
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 60)
})
