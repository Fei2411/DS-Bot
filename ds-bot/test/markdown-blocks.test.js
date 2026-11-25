import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitMarkdownBlocks } from '../src/client/markdown-blocks.js'

test('paragraphs split at blank lines, and the pieces join back into the input exactly', () => {
  const text = 'first paragraph\n\nsecond paragraph\n\nthird\n'
  const blocks = splitMarkdownBlocks(text)
  assert.deepEqual(blocks, ['first paragraph\n\n', 'second paragraph\n\n', 'third\n'])
  assert.equal(blocks.join(''), text)
  // A single trailing newline closes the block too; several blank lines stay with it.
  assert.deepEqual(splitMarkdownBlocks('one\n\ntwo'), ['one\n\n', 'two'])
  assert.deepEqual(splitMarkdownBlocks('one\n\n\n\ntwo'), ['one\n\n\n\n', 'two'])
  // Without any blank line there is one piece: the whole text.
  assert.deepEqual(splitMarkdownBlocks('no breaks\nat all\n'), ['no breaks\nat all\n'])
})

test('unsafe input falls back: empty, CRLF, BOM, link definitions, footnotes, html, directives, math, setext, duplicate headings', () => {
  assert.equal(splitMarkdownBlocks(''), null)
  assert.equal(splitMarkdownBlocks('a\r\n\r\nb\n'), null)
  assert.equal(splitMarkdownBlocks('﻿# bom\n\nbody\n'), null)
  // Link reference definitions reach across the whole document.
  assert.equal(splitMarkdownBlocks('see [x][y]\n\n[y]: https://example.com\n'), null)
  assert.equal(splitMarkdownBlocks('paragraph\n\n  [id]: /url\n\ntail\n'), null)
  // Footnotes: a reference or its definition anywhere stops the split.
  assert.equal(splitMarkdownBlocks('text[^a]\n\n[^a]: the note\n'), null)
  assert.equal(splitMarkdownBlocks('first\n\nsecond uses [^late] before its note\n'), null)
  // Raw HTML blocks can hold blank lines, so any block-level tag stops the split.
  assert.equal(splitMarkdownBlocks('<div>\nmarkup\n</div>\n\npara\n'), null)
  assert.equal(splitMarkdownBlocks('para\n\n<!-- a comment -->\n\ntail\n'), null)
  assert.equal(splitMarkdownBlocks('para\n\n</div>\n\ntail\n'), null)
  // Inline angle brackets that are no tag do not stop it.
  assert.ok(splitMarkdownBlocks('a < b and c > d\n\nnext\n') !== null)
  // Container directives and display math fences span blank lines.
  assert.equal(splitMarkdownBlocks('::: note\ncontent\n:::\n\npara\n'), null)
  assert.equal(splitMarkdownBlocks('$$\nx^2\n$$\n\npara\n'), null)
  assert.equal(splitMarkdownBlocks('text\n\n  $$\nmath\n'), null)
  // Setext underlines: a line of dashes or equals right behind text.
  assert.equal(splitMarkdownBlocks('title\n===\n\nbody\n'), null)
  assert.equal(splitMarkdownBlocks('title\n---\n\nbody\n'), null)
  // ...but a thematic break after a blank line is not an underline and splits fine.
  assert.deepEqual(splitMarkdownBlocks('one\n\n---\n\ntwo\n'), ['one\n\n', '---\n\n', 'two\n'])
  assert.deepEqual(splitMarkdownBlocks('one\n\n***\n\ntwo\n'), ['one\n\n', '***\n\n', 'two\n'])
  // Duplicate ATX heading slugs are numbered document-wide.
  assert.equal(splitMarkdownBlocks('# Same\n\nbody\n\n# Same\n\nmore\n'), null)
  assert.equal(splitMarkdownBlocks('# Same\n\nbody\n\n# same\n\nmore\n'), null)
  assert.equal(splitMarkdownBlocks('# Same ##\n\nbody\n\n# Same\n\nmore\n'), null)
  // Distinct headings keep the split.
  assert.deepEqual(splitMarkdownBlocks('# One\n\nbody\n\n# Two\n\nmore\n'), ['# One\n\n', 'body\n\n', '# Two\n\n', 'more\n'])
})

test('never splits inside a fence: blank lines, fence lookalikes and boundaries inside it all stay whole', () => {
  const text = 'intro\n\n```js\nconst a = 1\n\nconst b = 2\n\n```\n\nafter\n'
  const blocks = splitMarkdownBlocks(text)
  assert.deepEqual(blocks, ['intro\n\n', '```js\nconst a = 1\n\nconst b = 2\n\n```\n\n', 'after\n'])
  assert.equal(blocks.join(''), text)
  // An unclosed fence reaches the end of the text; nothing inside it can close a block.
  assert.deepEqual(splitMarkdownBlocks('intro\n\n```\nopen forever\n\nmore\n'), ['intro\n\n', '```\nopen forever\n\nmore\n'])
  // Tilde fences close on tildes, and a closing fence shorter than the opening does not close.
  assert.deepEqual(
    splitMarkdownBlocks('a\n\n~~~~\nx\n~~~\n\ny\n~~~~\n\nz\n'),
    ['a\n\n', '~~~~\nx\n~~~\n\ny\n~~~~\n\n', 'z\n'],
  )
  // A fence of the other character inside does nothing.
  assert.deepEqual(
    splitMarkdownBlocks('a\n\n```\n~~~\n\n~~~\n```\n\nafter\n'),
    ['a\n\n', '```\n~~~\n\n~~~\n```\n\n', 'after\n'],
  )
  // The closing fence may be longer than the opening and may be indented up to 3 spaces.
  assert.deepEqual(
    splitMarkdownBlocks('a\n\n```\nx\n   ````\n\nafter\n'),
    ['a\n\n', '```\nx\n   ````\n\n', 'after\n'],
  )
})

test('never splits before a list continuation or an indented continuation', () => {
  // List items separated by blank lines form one loose list, so the marker blocks the split.
  assert.deepEqual(splitMarkdownBlocks('- a\n\n- b\n\npara\n'), ['- a\n\n- b\n\n', 'para\n'])
  assert.deepEqual(splitMarkdownBlocks('1. a\n\n2. b\n\npara\n'), ['1. a\n\n2. b\n\n', 'para\n'])
  // An indented line after blank lines may continue the item (or be indented code inside it).
  assert.deepEqual(splitMarkdownBlocks('- a\n\n  continuation\n\npara\n'), ['- a\n\n  continuation\n\n', 'para\n'])
  assert.deepEqual(splitMarkdownBlocks('- a\n\n\tcontinuation\n\npara\n'), ['- a\n\n\tcontinuation\n\n', 'para\n'])
  // An indented line after blank lines can continue an indented code block (or a list
  // item's indentation), so the split holds off even before the first one; the whole
  // indented run and the unindented text before it stay together in one piece.
  assert.deepEqual(
    splitMarkdownBlocks('intro\n\n    code one\n\n    code two\n\nplain\n'),
    ['intro\n\n    code one\n\n    code two\n\n', 'plain\n'],
  )
  // A list that plainly ended (plain unindented text) does split afterwards.
  assert.deepEqual(splitMarkdownBlocks('- a\n\nplain now\n\npara\n'), ['- a\n\n', 'plain now\n\n', 'para\n'])
  // A marker after plain prose starts a new list, so the split before it stands.
  assert.deepEqual(splitMarkdownBlocks('intro\n\n- a\n- b\n\ntail\n'), ['intro\n\n', '- a\n- b\n\n', 'tail\n'])
  // Nested markers count as list lines: an indented item keeps the next marker blocked.
  assert.deepEqual(splitMarkdownBlocks('- a\n  - nested\n\n- b\n\npara\n'), ['- a\n  - nested\n\n- b\n\n', 'para\n'])
})

test('blocks stay safe structures: tables, blockquotes, multiline paragraphs', () => {
  // A table ends at the blank line; nothing splits inside it.
  assert.deepEqual(
    splitMarkdownBlocks('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n'),
    ['| a | b |\n| - | - |\n| 1 | 2 |\n\n', 'after\n'],
  )
  // A blank line ends a blockquote in CommonMark, so the split between two quotes is safe.
  assert.deepEqual(splitMarkdownBlocks('> one\n\n> two\n\ntail\n'), ['> one\n\n', '> two\n\n', 'tail\n'])
  // A multiline paragraph has no blank line inside and stays whole.
  assert.deepEqual(splitMarkdownBlocks('line one\nline two\nline three\n\nnext\n'), ['line one\nline two\nline three\n\n', 'next\n'])
})

test('streaming a realistic reply: exact join at every chunk, closed pieces end blank, and the closed prefix grows monotonically', () => {
  const reply = [
    'The plan has three parts, each explained below.',
    '',
    '## Part one',
    '',
    'First we look at the data, with some prose long enough to be realistic.',
    '',
    '- collect the inputs',
    '- validate them',
    '',
    '```js',
    'const inputs = collect()',
    'validate(inputs)',
    '```',
    '',
    '## Part two',
    '',
    '| step | owner |',
    '| ---- | ----- |',
    '| one  | bot   |',
    '',
    'Then a closing paragraph wraps the whole thing up.',
    '',
  ].join('\n')
  // The reply arrives in irregular chunks, as the model streams it.
  const chunks = []
  for (let at = 0; at < reply.length; at += 7) chunks.push(reply.slice(at, at + 7))
  let text = ''
  let closedBefore = []
  let previousPrefix = ''
  for (const chunk of chunks) {
    text += chunk
    const blocks = splitMarkdownBlocks(text)
    assert.ok(blocks !== null, 'a clean streaming reply always splits')
    assert.equal(blocks.join(''), text)
    const closed = blocks.length >= 2 ? blocks.slice(0, -1) : []
    // Once a piece has closed, its text never changes again.
    for (let index = 0; index < Math.min(closed.length, closedBefore.length); index += 1) {
      assert.equal(closed[index], closedBefore[index], `closed block ${index} must be final`)
    }
    assert.ok(closed.length >= closedBefore.length, 'closed pieces never disappear in this stream')
    for (const piece of closed) assert.match(piece, /\n\n$|^$/, 'a closed piece ends on blank lines')
    const prefix = closed.join('')
    assert.ok(prefix.startsWith(previousPrefix), 'the frozen prefix only grows in this stream')
    previousPrefix = prefix
    closedBefore = closed
  }
  // At the end the document splits into its real blocks.
  const final = splitMarkdownBlocks(reply)
  assert.deepEqual(final, [
    'The plan has three parts, each explained below.\n\n',
    '## Part one\n\n',
    'First we look at the data, with some prose long enough to be realistic.\n\n',
    '- collect the inputs\n- validate them\n\n',
    '```js\nconst inputs = collect()\nvalidate(inputs)\n```\n\n',
    '## Part two\n\n',
    '| step | owner |\n| ---- | ----- |\n| one  | bot   |\n\n',
    'Then a closing paragraph wraps the whole thing up.\n',
  ])
})

test('adversarial growth: a bare dash and a bare digit keep their splits correct for the text as it stands', () => {
  // '-' alone already is an empty list item, and it parses the same alone or in the whole
  // document, so the split before it is correct for the text as it stands.
  assert.deepEqual(splitMarkdownBlocks('alpha\n\n-'), ['alpha\n\n', '-'])
  // Once it reads as an item, later content may close the list instead.
  const grown = splitMarkdownBlocks('alpha\n\n- x\n\nbeta\n')
  assert.deepEqual(grown, ['alpha\n\n', '- x\n\n', 'beta\n'])
  // '1' alone is no ordered marker, so the split before it stands as written.
  assert.deepEqual(splitMarkdownBlocks('alpha\n\n1'), ['alpha\n\n', '1'])
  // '1.' is a marker, but after plain prose it starts a new list, so the split stays.
  assert.deepEqual(splitMarkdownBlocks('alpha\n\n1.\n\nbeta\n'), ['alpha\n\n', '1.\n\n', 'beta\n'])
  // ...while after a marker line it is kept inside the same list's piece.
  assert.deepEqual(splitMarkdownBlocks('- a\n\n1.\n\nbeta\n'), ['- a\n\n1.\n\n', 'beta\n'])
})
