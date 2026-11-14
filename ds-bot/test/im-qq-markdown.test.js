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
