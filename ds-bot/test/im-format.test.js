import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkTelegram, toPlain, toTelegramHtml } from '../src/host/im/format.js'

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
