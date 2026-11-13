import assert from 'node:assert/strict'
import test from 'node:test'
import { lexer, type Token, type Tokens } from 'marked'
import {
  computeTableWidths,
  listItemInfo,
  normalizeSoftBreaks,
  splitParagraphImages,
  tableToTsv,
} from './markdown-model.ts'

test('normalizeSoftBreaks collapses single newlines to spaces without affecting br tokens', () => {
  assert.equal(normalizeSoftBreaks('line one\nline two\r\nline three'), 'line one line two line three')
  assert.equal(normalizeSoftBreaks('你好\n世界'), '你好 世界')
})

test('computeTableWidths aligns columns using widest cell across header and body', () => {
  const narrow = computeTableWidths(['Col', 'Val'], [['A', '1']], { containerWidth: 300 })
  assert.equal(narrow.reduce((a, b) => a + b, 0), 300)

  const wide = computeTableWidths(
    ['Short', 'Very Long Column Header Text', '中文列名测试较宽'],
    [['x', 'Some detailed explanation inside a cell', '中等长度的数据值']],
    { containerWidth: 300 },
  )
  assert.equal(wide.length, 3)
  assert.ok(wide[1] > wide[0])
  assert.ok(wide[2] > wide[0])
  assert.ok(wide.every(w => w >= 88 && w <= 260))
})

test('tableToTsv flattens tabs and newlines cleanly per row', () => {
  assert.equal(
    tableToTsv(['A', 'B'], [['1\n2', 'x\ty']]),
    'A\tB\n1 2\tx y',
  )
})

test('listItemInfo handles ordered empty start, depth bullets, and GFM checkboxes', () => {
  const tokens = lexer('1. first\n2. second\n\n- [ ] todo\n- [x] done\n  - nested')
  const ordered = tokens[0] as Tokens.List
  assert.equal(listItemInfo({ ordered: true, start: '' }, ordered.items[0], 0).marker, '1.')
  assert.equal(listItemInfo({ ordered: true, start: 5 }, ordered.items[1], 1).marker, '6.')

  const unordered = tokens[2] as Tokens.List
  const todo = listItemInfo(unordered, unordered.items[0], 0, 0)
  assert.deepEqual([todo.isTask, todo.checked, todo.marker], [true, false, '☐'])
  assert.ok(todo.tokens.every(tk => tk.type !== 'checkbox'))

  const done = listItemInfo(unordered, unordered.items[1], 1, 0)
  assert.deepEqual([done.isTask, done.checked, done.marker], [true, true, '☑'])

  const nestedList = unordered.items[1].tokens.find((tk): tk is Tokens.List => tk.type === 'list')!
  const plainItem = nestedList.items[0]
  assert.equal(listItemInfo({ ordered: false, start: '' }, plainItem, 0, 0).marker, '•')
  assert.equal(listItemInfo({ ordered: false, start: '' }, plainItem, 0, 1).marker, '◦')
  assert.equal(listItemInfo({ ordered: false, start: '' }, plainItem, 0, 2).marker, '▪')
})

test('splitParagraphImages separates inline text runs and standalone images', () => {
  const tokens = lexer('Before ![chart](./chart.png) after [![pic](https://example.com/a.png)](https://example.com)')
  const para = tokens[0] as Tokens.Paragraph
  const segments = splitParagraphImages(para.tokens ?? [])
  assert.equal(segments.length, 4)
  assert.equal(segments[0].kind, 'inlines')
  assert.deepEqual(segments[1], { kind: 'image', href: './chart.png', alt: 'chart' })
  assert.equal(segments[2].kind, 'inlines')
  assert.deepEqual(segments[3], {
    kind: 'image',
    href: 'https://example.com/a.png',
    alt: 'pic',
    linkHref: 'https://example.com',
  })

  const formatted = lexer('**![bold-img](a.png)**\n\n*before ![italic-img](b.png) after*\n\n~~[![strike-link](c.png)](https://example.org)~~')
  const boldPara = formatted[0] as Tokens.Paragraph
  assert.deepEqual(splitParagraphImages(boldPara.tokens ?? []), [{ kind: 'image', href: 'a.png', alt: 'bold-img' }])

  const italicSegs = splitParagraphImages((formatted[2] as Tokens.Paragraph).tokens ?? [])
  assert.equal(italicSegs.length, 3)
  assert.equal(italicSegs[0].kind, 'inlines')
  assert.equal((italicSegs[0] as { kind: 'inlines'; tokens: Token[] }).tokens[0].type, 'em')
  assert.deepEqual(italicSegs[1], { kind: 'image', href: 'b.png', alt: 'italic-img' })
  assert.equal(italicSegs[2].kind, 'inlines')
  assert.equal((italicSegs[2] as { kind: 'inlines'; tokens: Token[] }).tokens[0].type, 'em')

  const strikeLink = splitParagraphImages((formatted[4] as Tokens.Paragraph).tokens ?? [])
  assert.deepEqual(strikeLink, [{
    kind: 'image',
    href: 'c.png',
    alt: 'strike-link',
    linkHref: 'https://example.org',
  }])
})
