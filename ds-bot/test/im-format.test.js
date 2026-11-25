import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkMarkdown, chunkTelegram, toPlain } from '../src/host/im/format.js'

// What Telegram is sent for a message that fits one chunk.
const toTelegramHtml = (markdown) => {
  const chunks = chunkTelegram(markdown)
  assert.equal(chunks.length, 1)
  return chunks[0].html
}

test('Markdown becomes Telegram HTML', () => {
  assert.equal(toTelegramHtml('**bold** and _ital_'), '<b>bold</b> and <i>ital</i>')
  assert.equal(toTelegramHtml('run `rm -rf` now'), 'run <code>rm -rf</code> now')
  assert.equal(toTelegramHtml('see [the docs](https://a.b/c)'), 'see <a href="https://a.b/c">the docs</a>')
  assert.equal(toTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
  const fenced = toTelegramHtml('before\n```js\nlet x = 1 < 2\n```\nafter')
  assert.equal(fenced, 'before\n<pre><code class="language-js">let x = 1 &lt; 2</code></pre>\nafter')
  assert.equal(toTelegramHtml('done ~~deal~~'), 'done <s>deal</s>')
})

test('Telegram preserves headings and tables inside tilde and backtick code fences', () => {
  for (const [open, shorter, other, close] of [
    ['~~~sh', '~~', '   ```', '~~~'],
    ['```sh', '``', '~~~~', '```'],
  ]) {
    const code = ['# keep this comment', shorter, other, '| A | B |', '| --- | --- |', '| x | y |'].join('\n')
    const fenced = [open, code, close].join('\n')
    const markdown = fenced + '\n# Real heading'
    const isBacktick = open.startsWith('`')
    assert.deepEqual(chunkTelegram(markdown), [{
      html: isBacktick ? '<pre><code class="language-sh">' + code + '</code></pre>\n<b>Real heading</b>' : markdown,
      text: isBacktick ? code + '\nReal heading' : markdown,
    }])
    assert.equal(toPlain(fenced), isBacktick ? code : fenced)
  }
})

test('a tab after a closing backtick fence leaves later Telegram prose outside code', () => {
  const markdown = '```sh\n# keep this comment\n```\t\nAfter'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<pre><code class="language-sh"># keep this comment</code></pre>\nAfter',
    text: '# keep this comment\nAfter',
  }])
})

test('an unclosed tilde fence keeps the comment literal like dev', () => {
  const markdown = '~~~sh\n# code comment'
  assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
})

test('Telegram leaves headings and tables inside indented backtick fences literal', () => {
  const comment = '   ```sh\n   # Literal shell comment\n   ``` '
  assert.deepEqual(chunkTelegram(comment), [{ html: comment, text: comment }])

  const table = '  ```\n  # Literal heading\n\n  | Key | Value |\n  | --- | --- |\n  | A | B |\n  ```'
  assert.deepEqual(chunkTelegram(table + '\n# Actual heading'), [{
    html: table.replace('\n\n', '\n') + '\n# Actual heading',
    text: table.replace('\n\n', '\n') + '\n# Actual heading',
  }])
})

test('a literal backtick fence disables formatting even across a dev code block', () => {
  const markdown = '   ```sh\n   # Literal comment\n```\t\n# Dev code\n```\n# Actual heading'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '   ```sh\n   # Literal comment\n<pre><code># Dev code</code></pre>\n# Actual heading',
    text: '   ```sh\n   # Literal comment\n# Dev code\n# Actual heading',
  }])
})

test('an unclosed indented backtick fence keeps a heading and table literal to EOF', () => {
  const comment = '  ```sh\n  # keep this comment'
  for (const markdown of [comment, comment + '\n  | A | B |\n  | --- | --- |\n  | x | y |']) {
    assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
  }
})

test('a four-space fence inside a list keeps its headings and table literal', () => {
  const markdown = '- Item\n    ```sh\n  # Literal comment\n  | A | B |\n  | --- | --- |\n  | x | y |\n    ```'
  assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
})

test('a triple-backtick line inside a four-backtick fence does not expose headings or tables', () => {
  const body = '# Literal comment\n| A | B |\n| --- | --- |\n| x | y |'
  const markdown = '````\ncode\n```\n' + body + '\n````'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<pre><code class="language-`">code</code></pre>\n' + body + '\n<pre><code class="language-`"></code></pre>',
    text: 'code\n' + body + '\n',
  }])
})

test('a standalone triple-backtick span cannot expose a later fence body', () => {
  const body = '# Literal comment\n| A | B |\n| --- | --- |\n| x | y |'
  const markdown = '```run```\n\n```\n' + body + '\n```\nAfter'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<pre><code class="language-run```"></code></pre>\n' + body + '\n<pre><code>After</code></pre>',
    text: body + '\nAfter',
  }])
})

test('a literal fence with pipes in its info is not a Telegram table row', () => {
  const fence = '  ```sh | label\n# Literal heading\n   ``` '
  const markdown = 'Key | Value\n--- | ---\na | b\n' + fence
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '• <b>Key:</b> a\n• <b>Value:</b> b\n' + fence,
    text: '• Key: a\n• Value: b\n' + fence,
  }])
})

test('a closing code fence can have different indentation from its opener', () => {
  const markdown = '- Item\n  ~~~sh\n  # comment\n   ~~~\nAfter the list\n# Actual heading'
  assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
})

test('Telegram leaves a four-space literal fence marker alone', () => {
  const markdown = '    ```\n\n# Actual heading'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '    ```\n# Actual heading',
    text: '    ```\n# Actual heading',
  }])
})

test('a four-space backtick marker inside a fence does not close it', () => {
  const code = 'code\n    ```\n# comment'
  assert.deepEqual(chunkTelegram('```\n' + code + '\n```\n# Actual heading'), [{
    html: '<pre><code>' + code + '</code></pre>\n<b>Actual heading</b>',
    text: code + '\nActual heading',
  }])
})

test('an unclosed indented fence leaves later Telegram headings and tables literal', () => {
  const item = '- Item\n  ```sh\n    # code comment'
  const markdown = item + '\n\n# Actual heading\n| A | B |\n| --- | --- |\n| x | y |'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: markdown.replace('\n\n', '\n'),
    text: markdown.replace('\n\n', '\n'),
  }])
})

test('a fence after a list marker keeps its contents and later prose literal', () => {
  const item = '- ```sh\n  # Literal comment\n  | A | B |\n  | --- | --- |\n  | x | y |'
  assert.deepEqual(chunkTelegram(item + '\n\n# Actual heading'), [{
    html: item + '\n# Actual heading',
    text: item + '\n# Actual heading',
  }])
})

test('an unclosed flush-left backtick fence keeps shell wildcards literal', () => {
  const command = 'cat *.log *.txt'
  const markdown = '```sh\n' + command
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<pre><code class="language-sh">' + command + '</code></pre>',
    text: command,
  }])
  assert.equal(toPlain(markdown), command)
})

test('indented fences preserve code indentation', () => {
  const markdown = '  ```python\n  if ok:\n      run()\n  ```'
  assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
})

test('list-like prose before an indented fence does not change its boundaries', () => {
  for (const before of ['- - -', 'Text\n2. Not a list start']) {
    const markdown = before + '\n   ~~~\n# code comment\n   ~~~'
    assert.deepEqual(chunkTelegram(markdown + '\n# Actual heading'), [{
      html: markdown + '\n# Actual heading',
      text: markdown + '\n# Actual heading',
    }])
  }
})

test('a thematic break before a backtick fence does not expose a flush-left comment', () => {
  const fence = '- - -\n  ```sh\n# Shell comment\n  ```'
  assert.deepEqual(chunkTelegram(fence + '\n# Actual heading'), [{
    html: fence + '\n# Actual heading',
    text: fence + '\n# Actual heading',
  }])
})

test('a thematic break before an unclosed backtick fence keeps its contents literal', () => {
  const markdown = '- - -\n  ```sh\n# Literal comment\n| A | B |\n| --- | --- |\n| x | y |'
  assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
})

test('a fence in a list cannot expose the contents of a later independent fence', () => {
  for (const [item, marker] of [
    ['- Item', '```'],
    ['- Item', '~~~'],
    ['- First line\n  second line', '```'],
    ['- Parent\n  - Nested\n    continuation', '~~~'],
  ]) {
    const inside = item + '\n  ' + marker + 'sh\n  # unclosed'
    const outside = '  ' + marker + '\n  # Literal comment\n  | A | B |\n  | --- | --- |\n  | x | y |\n  ' + marker
    assert.deepEqual(chunkTelegram(inside + '\n\n# Actual heading\n\n' + outside), [{
      html: inside + '\n# Actual heading\n' + outside,
      text: inside + '\n# Actual heading\n' + outside,
    }])
  }
})

test('Telegram heading and table label code does not overlap bold or italic entities', () => {
  const markdown = '## **Run** *before `npm test` after*\n| `id` | Status |\n| --- | --- |\n| 1 | good |'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<b>Run <i>before </i></b><code>npm test</code><b><i> after</i></b>\n• <code>id</code><b>:</b> 1\n• <b>Status:</b> good',
    text: 'Run before npm test after\n• id: 1\n• Status: good',
  }])
})

test('a heading and table label with linked code preserve clickable text', () => {
  const markdown = '## [`npm test`](https://a.b/run)\n| [`id`](https://a.b/id) | Status |\n| --- | --- |\n| 1 | good |'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<b><a href="https://a.b/run">npm test</a></b>\n• <b><a href="https://a.b/id">id</a>:</b> 1\n• <b>Status:</b> good',
    text: 'npm test (https://a.b/run)\n• id (https://a.b/id): 1\n• Status: good',
  }])
})

test('a fence dedented from padded list content protects flush-left comments', () => {
  for (const item of ['-   Item', '-\tItem']) {
    const fence = item + '\n  ```sh\n# Literal comment\n| A | B |\n| --- | --- |\n| x | y |\n  ```'
    assert.deepEqual(chunkTelegram(fence + '\n# Actual heading'), [{
      html: fence + '\n# Actual heading',
      text: fence + '\n# Actual heading',
    }])
  }
})

test('a fence on an ordered list marker is kept literal after other Markdown blocks', () => {
  const fence = '2. ```sh\n   # Literal comment\n   | A | B |\n   | --- | --- |\n   | x | y |\n   ```'
  for (const [prefix, expected] of [
    ['Title\n===', { html: 'Title\n===', text: 'Title\n===' }],
    ['| Key | Value |\n| --- | --- |\n| a | b |', { html: '• <b>Key:</b> a\n• <b>Value:</b> b', text: '• Key: a\n• Value: b' }],
  ]) {
    assert.deepEqual(chunkTelegram(prefix + '\n' + fence), [{
      html: expected.html + '\n' + fence,
      text: expected.text + '\n' + fence,
    }])
  }
})

test('Telegram renders headings and Markdown tables as readable rows (#2173)', () => {
  const markdown = [
    '## Results ##',
    '',
    '| Bot | Status | Owner |',
    '| :--- | ---: | :---: |',
    '| **Alpha** | Ready & tested | Ann |',
    '| Beta | `Queued` | R&D \\| Ops |',
    '',
    '### Notes',
    'Ordinary prose with a | pipe.',
    '```',
    '# Literal heading',
    '| A | B |',
    '| --- | --- |',
    '| x | y |',
    '```',
  ].join('\n')
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<b>Results</b>\n• <b>Bot:</b> <b>Alpha</b>\n• <b>Status:</b> Ready &amp; tested\n• <b>Owner:</b> Ann\n\n'
      + '• <b>Bot:</b> Beta\n• <b>Status:</b> <code>Queued</code>\n• <b>Owner:</b> R&amp;D | Ops\n'
      + '<b>Notes</b>\nOrdinary prose with a | pipe.\n<pre><code># Literal heading\n| A | B |\n| --- | --- |\n| x | y |</code></pre>',
    text: 'Results\n• Bot: Alpha\n• Status: Ready & tested\n• Owner: Ann\n\n'
      + '• Bot: Beta\n• Status: Queued\n• Owner: R&D | Ops\n'
      + 'Notes\nOrdinary prose with a | pipe.\n# Literal heading\n| A | B |\n| --- | --- |\n| x | y |',
  }])
})

test('ordinary backtick code blocks do not disable Telegram formatting between them', () => {
  const markdown = '```sh\n# code\n```\n# Results\n| Key | Value |\n| --- | --- |\n| a | b |\n```\n# more code\n```'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '<pre><code class="language-sh"># code</code></pre>\n<b>Results</b>\n• <b>Key:</b> a\n• <b>Value:</b> b\n<pre><code># more code</code></pre>',
    text: '# code\nResults\n• Key: a\n• Value: b\n# more code',
  }])
})

test('a blockquote immediately after a Telegram table is not a table row', () => {
  const markdown = '| Key | Value |\n| --- | --- |\n| a | 1 |\n> a | b | c'
  assert.deepEqual(chunkTelegram(markdown), [{
    html: '• <b>Key:</b> a\n• <b>Value:</b> 1\n&gt; a | b | c',
    text: '• Key: a\n• Value: 1\n> a | b | c',
  }])
})

test('lists containing pipes end a Telegram table without losing text', () => {
  for (const item of ['- Use A | B | C after lunch', '+ Use A | B | C', '* Use A | B | C', '2. Use A | B | C', '2) Use A | B | C']) {
    const markdown = '| Key | Value |\n| --- | --- |\n| a | 1 |\n' + item
    assert.deepEqual(chunkTelegram(markdown), [{
      html: '• <b>Key:</b> a\n• <b>Value:</b> 1\n' + item,
      text: '• Key: a\n• Value: 1\n' + item,
    }])
  }
})

test('Telegram table cells keep pipes in inline code and escaped pipes', () => {
  const markdown = "| Key | Value |\n| --- | --- |\n| mode | `'auto' | 'manual'` |\n| owner | R&D \\| Ops |"
  assert.deepEqual(chunkTelegram(markdown), [{
    html: "• <b>Key:</b> mode\n• <b>Value:</b> <code>'auto' | 'manual'</code>\n\n• <b>Key:</b> owner\n• <b>Value:</b> R&amp;D | Ops",
    text: "• Key: mode\n• Value: 'auto' | 'manual'\n\n• Key: owner\n• Value: R&D | Ops",
  }])
})

test('lines with a different column count or missing border end a Telegram table', () => {
  const table = '| Key | Value |\n| --- | --- |\n| a | 1 |'
  for (const line of ['Use A | B | C in config.', '| a | b | c |', 'Use A | B in config.', '| Use A | B in config.', '| only one cell |']) {
    assert.deepEqual(chunkTelegram(table + '\n' + line), [{
      html: '• <b>Key:</b> a\n• <b>Value:</b> 1\n' + line,
      text: '• Key: a\n• Value: 1\n' + line,
    }])
  }
})

test('Telegram leaves underline-like lines unchanged after prose and lists', () => {
  for (const markdown of [
    'item\n---',
    '- Item\n---',
    '1. First item\n   wrapped line\n2. Next item\n---',
    'Release notes\n24. Follow-up\n===',
  ]) {
    assert.deepEqual(chunkTelegram(markdown), [{ html: markdown, text: markdown }])
  }
})

test('Telegram leaves an empty ATX heading as literal text', () => {
  assert.deepEqual(chunkTelegram('### ###'), [{ html: '### ###', text: '### ###' }])
})

test('an oversized Telegram heading keeps legacy chunks with its inline code intact', () => {
  const markdown = '# Run `**keep**` ' + 'x'.repeat(4096)
  assert.deepEqual(chunkTelegram(markdown), [
    { html: '# Run <code>**keep**</code> ' + 'x'.repeat(4068), text: '# Run keep ' + 'x'.repeat(4085) },
    { html: 'x'.repeat(28), text: 'x'.repeat(11) },
  ])
})

test('Markdown becomes plain text', () => {
  assert.equal(toPlain('**bold** `code` [site](https://a.b)'), 'bold code site (https://a.b)')
  assert.equal(toPlain('```\nlet x = 1\n```'), 'let x = 1')
})

test('long Telegram table cells use legacy HTML and plain-text cuts', () => {
  const value = '😀 & < '.repeat(500).trim()
  const header = 'Bot | Status\n--- | ---'
  const line = 'Alpha | ' + value
  const html = Array.from(line.replaceAll('&', '&amp;').replaceAll('<', '&lt;'))
  assert.deepEqual(chunkTelegram('## Results\n' + header + '\n' + line), [
    { html: '<b>Results</b>\n' + header, text: 'Results\n' + header },
    { html: html.slice(0, 4096).join(''), text: line },
    { html: html.slice(4096).join(''), text: '' },
  ])
})

test('Telegram preserves legacy chunks for an oversized table cell with inline code', () => {
  const value = 'cat *.log *.txt ' + 'x'.repeat(4200)
  const header = 'Command | Output\n--- | ---'
  const html = 'Run | <code>' + value + '</code>'
  const text = 'Run | cat .log .txt ' + 'x'.repeat(4200)
  assert.deepEqual(chunkTelegram(header + '\nRun | `' + value + '`'), [
    { html: header, text: header },
    { html: html.slice(0, 4096), text: text.slice(0, 4096) },
    { html: html.slice(4096), text: text.slice(4096) },
  ])
  assert.equal(toPlain('**Run `cat *.log *.txt` now**'), '*Run cat .log .txt now*')
})

test('Telegram converts a table only when all of its formatted rows fit together', () => {
  const header = 'A | B\n--- | ---'
  const cell = 'x'.repeat(2024)
  const row = 'a | ' + cell
  assert.deepEqual(chunkTelegram(header + '\n' + row), [{
    html: '• <b>A:</b> a\n• <b>B:</b> ' + cell,
    text: '• A: a\n• B: ' + cell,
  }])
  const table = header + '\n' + row + '\n' + row
  assert.deepEqual(chunkTelegram(table), [{ html: table, text: table }])
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

test('a split fence stays under the limit when its text HTML-escapes', () => {
  // "<" and "&" become 4 and 5 characters in the HTML payload, so a fence of them
  // is three times longer once rendered than the text it was measured on.
  const body = '<'.repeat(120) + '\n' + '&'.repeat(120) + '\n' + '>'.repeat(120)
  const chunks = chunkTelegram(`\`\`\`\n${body}\n\`\`\``, 200)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok(chunk.html.length <= 200, chunk.html.length)
  // Nothing is lost or repeated: the code arrives in order, cut only where it had to be.
  assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\n/g, ''), body.replace(/\n/g, ''))
})

test('an oversized line is hard cut and stays under the limit', () => {
  const chunks = chunkTelegram('y'.repeat(9000), 4096)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.html.length <= 4096)
})

test('an oversized unconverted line preserves the legacy HTML and plain chunk cuts', () => {
  const markdown = '~~~sh\necho `**keep**` ' + 'x'.repeat(4096) + '\n~~~'
  assert.deepEqual(chunkTelegram(markdown), [
    { html: '~~~sh', text: '~~~sh' },
    { html: 'echo <code>**keep**</code> ' + 'x'.repeat(4069), text: 'echo keep ' + 'x'.repeat(4086) },
    { html: 'x'.repeat(27) + '\n~~~', text: 'x'.repeat(10) + '\n~~~' },
  ])
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
