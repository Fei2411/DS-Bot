import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeFileLinks } from '../src/client/text.js'

test('rewrites Windows drive-letter backslash destinations so dot directories survive CommonMark', () => {
  const input = 'See [报告.md](C:\\work\\demo\\.dsh\\bot\\workspace\\报告.md) and [log](d:\\.config\\out.txt#L12).'
  assert.equal(
    normalizeFileLinks(input),
    'See [报告.md](C:/work/demo/.dsh/bot/workspace/报告.md) and [log](d:/.config/out.txt#L12).',
  )
})

test('supports angle-bracketed destinations with spaces and balanced parentheses', () => {
  assert.equal(
    normalizeFileLinks('[a](<C:\\work\\My Folder\\.dsh\\bot\\r.md>)'),
    '[a](<C:/work/My Folder/.dsh/bot/r.md>)',
  )
  assert.equal(
    normalizeFileLinks('[b](C:\\work\\foo(1)\\.dsh\\bar.md)'),
    '[b](C:/work/foo(1)/.dsh/bar.md)',
  )
})

test('supports CommonMark newline between ]( and destination, and leaves link title untouched', () => {
  assert.equal(
    normalizeFileLinks('[r](\nC:\\work\\.dsh\\r.md)'),
    '[r](\nC:/work/.dsh/r.md)',
  )
  assert.equal(
    normalizeFileLinks('[r](\r\n  C:\\work\\.dsh\\r.md "Use [x](C:\\work\\x.md)")'),
    '[r](\r\n  C:/work/.dsh/r.md "Use [x](C:\\work\\x.md)")',
  )
})

test('preserves valid Markdown escapes in already-forward-slash C:/ destinations', () => {
  const input = '[report](C:/docs/report\\[final\\].md)'
  assert.equal(normalizeFileLinks(input), input)
})

test('leaves UNC paths, URLs, and relative paths untouched', () => {
  const input = '[unc](\\\\server\\share\\.dsh\\a.md) [web](https://example.com/a\\b) [rel](.dsh\\a.md)'
  assert.equal(normalizeFileLinks(input), input)
})

test('a message showing the path in code and in a title only rewrites the real destination', () => {
  // The three shapes a reviewer asked about, in one message: inline code, a
  // fenced block, and a link title. Only the destination may change.
  const input = [
    'Try `[r](C:\\work\\.dsh\\r.md)` in a shell:',
    '',
    '```md',
    '[r](C:\\work\\.dsh\\r.md)',
    '```',
    '',
    'Write it as [r](C:/work/r.md "copied from C:\\work\\r.md").',
  ].join('\n')
  const expected = [
    'Try `[r](C:\\work\\.dsh\\r.md)` in a shell:',
    '',
    '```md',
    '[r](C:\\work\\.dsh\\r.md)',
    '```',
    '',
    'Write it as [r](C:/work/r.md "copied from C:\\work\\r.md").',
  ].join('\n')
  assert.equal(normalizeFileLinks(input), expected)
})

test('skips inline code spans, multi-backtick spans, fenced blocks (``` and ~~~), and indented code blocks', () => {
  const input = [
    'Inline `[a](C:\\work\\.dsh\\a.md)` and multi `` ``` [b](C:\\work\\.dsh\\b.md) `` plus [real](C:\\work\\.dsh\\real.md).',
    'Escaped ticks \\` [after-escaped](C:\\work\\.dsh\\esc.md) \\` stay active.',
    '```md',
    '[fence1](C:\\work\\.dsh\\f1.md)',
    '```',
    '~~~',
    '[fence2](C:\\work\\.dsh\\f2.md)',
    '~~~',
    '',
    '    [indented](C:\\work\\.dsh\\ind.md)',
    '',
    '[after](C:\\work\\.dsh\\after.md)',
  ].join('\n')

  const expected = [
    'Inline `[a](C:\\work\\.dsh\\a.md)` and multi `` ``` [b](C:\\work\\.dsh\\b.md) `` plus [real](C:/work/.dsh/real.md).',
    'Escaped ticks \\` [after-escaped](C:/work/.dsh/esc.md) \\` stay active.',
    '```md',
    '[fence1](C:\\work\\.dsh\\f1.md)',
    '```',
    '~~~',
    '[fence2](C:\\work\\.dsh\\f2.md)',
    '~~~',
    '',
    '    [indented](C:\\work\\.dsh\\ind.md)',
    '',
    '[after](C:/work/.dsh/after.md)',
  ].join('\n')

  assert.equal(normalizeFileLinks(input), expected)
})
