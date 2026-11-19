import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toQqMarkdown } from '../src/host/im/qq-markdown.js'

test('a GFM table becomes named list rows', () => {
  assert.equal(
    toQqMarkdown('| 客户端 | 状态 |\n| --- | --- |\n| Web | 支持 |\n| iOS | 测试 |'),
    '- 客户端：Web；状态：支持\n- 客户端：iOS；状态：测试',
  )
})

test('headings, emphasis and links reach QQ untouched', () => {
  const source = '## 标题\n\n**加粗**与[文档](https://example.com)'
  assert.equal(toQqMarkdown(source), source)
})

test('an image QQ cannot fetch becomes a caption, a public URL stays', () => {
  assert.equal(toQqMarkdown('截图 ![架构图](/tmp/a.png) 结束'), '截图 ［图片：架构图］ 结束')
  assert.equal(toQqMarkdown('![](file:///tmp/a.png)'), '［图片］')
  const hosted = '![图](https://cdn.example.com/a.png)'
  assert.equal(toQqMarkdown(hosted), hosted)
})

test('HTML line breaks become newlines and other tags are dropped', () => {
  assert.equal(toQqMarkdown('第一行<br>第二行'), '第一行\n第二行')
  assert.equal(toQqMarkdown('<b>加粗</b>文本'), '加粗文本')
})

test('a table inside a code fence is left alone', () => {
  const source = '```md\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```'
  assert.equal(toQqMarkdown(source), source)
})

test('plain prose is unchanged and empty input stays empty', () => {
  const prose = '第一行\n\n第二行，包含 1.5 和 a_b。'
  assert.equal(toQqMarkdown(prose), prose)
  assert.equal(toQqMarkdown(''), '')
  assert.equal(toQqMarkdown(undefined), '')
})

test('autolinks keep their address instead of being read as HTML', () => {
  assert.equal(
    toQqMarkdown('Open <https://example.com/docs> for details.'),
    'Open <https://example.com/docs> for details.',
  )
  assert.equal(
    toQqMarkdown('Write to <dev@example.com> anytime.'),
    'Write to <dev@example.com> anytime.',
  )
})

test('HTML inside an inline code span is left as written', () => {
  assert.equal(
    toQqMarkdown('Use `<div>` and `</div>` tags.'),
    'Use `<div>` and `</div>` tags.',
  )
  assert.equal(
    toQqMarkdown('The syntax is `![alt](/tmp/a.png)` here.'),
    'The syntax is `![alt](/tmp/a.png)` here.',
  )
  assert.equal(toQqMarkdown('打断用 `<br>` 标签。'), '打断用 `<br>` 标签。')
})

test('a code span keeps the full run of backticks', () => {
  assert.equal(toQqMarkdown('值 ``a`b`` 保留'), '值 ``a`b`` 保留')
})

test('an escaped pipe stays inside its table cell', () => {
  assert.equal(
    toQqMarkdown('| Expression | Meaning |\n| --- | --- |\n| a \\| b | bitwise OR |'),
    '- Expression：a | b；Meaning：bitwise OR',
  )
})

test('an escaped backtick is literal and does not swallow the column between them', () => {
  assert.equal(
    toQqMarkdown('| Syntax | Meaning |\n| --- | --- |\n| \\` | a \\` character |'),
    '- Syntax：`；Meaning：a ` character',
  )
})

test('an escaped backtick does not hide a local image from the conversion', () => {
  assert.equal(toQqMarkdown('看图 \\`![x](/tmp/a.png)\\` 结束'), '看图 `［图片：x］` 结束')
})

test('a line break inside a table cell keeps the row on one list item', () => {
  assert.equal(
    toQqMarkdown('| 项目 | 说明 |\n| --- | --- |\n| a | 第一步<br>第二步 |\n| b | 单行 |'),
    '- 项目：a；说明：第一步 第二步\n- 项目：b；说明：单行',
  )
  assert.equal(
    toQqMarkdown('| 说明<br>补充 | 值 |\n| --- | --- |\n| x | 1 |'),
    '- 说明 补充：x；值：1',
  )
  assert.equal(
    toQqMarkdown('| a | b |\n| --- | --- |\n| x<br>y | z |'),
    '- a：x y；b：z',
  )
})
