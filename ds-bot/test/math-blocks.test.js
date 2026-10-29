import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mathBlocks } from '../src/client/math-blocks.js'

test('display formulas become cards without changing surrounding Markdown', () => {
  const source = '$$\nC_t=N_t \\cdot \\bar{T}_t\n$$'
  const parts = mathBlocks(`Before **formula**.\n\n${source}\n\nAfter.`)
  assert.deepEqual(parts.map(part => part.type), ['markdown', 'math', 'markdown'])
  assert.equal(parts[0].text, 'Before **formula**.\n\n')
  assert.equal(parts[1].source, source)
  assert.equal(parts[1].tex, 'C_t=N_t \\cdot \\bar{T}_t')
  assert.equal(parts[2].text, '\n\nAfter.')
})

test('latex code copies its exact contents and previews without outer delimiters', () => {
  for (const language of ['latex', 'TeX', 'math']) {
    const raw = '$$\n\\underbrace{N_t}_{\\text{任务数}}\n$$'
    const [part] = mathBlocks(`\`\`\`${language}\n${raw}\n\`\`\``)
    assert.equal(part.source, raw)
    assert.equal(part.tex, '\\underbrace{N_t}_{\\text{任务数}}')
  }
})

test('single-line display math and bracketed display math become cards', () => {
  for (const source of ['$$a^2+b^2=c^2$$', '\\[\na^2+b^2=c^2\n\\]']) {
    const [part] = mathBlocks(source)
    assert.equal(part.source, source)
    assert.equal(part.tex, 'a^2+b^2=c^2')
  }
})

test('inline math, ordinary code, nested lists and quotes remain with DSH', () => {
  for (const source of ['Inline $x$ and `$y$`.', '```js\nconst x = "$$"\n```', '> $$\n> x\n> $$', '- item\n\n  $$\n  x\n  $$']) {
    assert.equal(mathBlocks(source), null, source)
  }
})

test('reference links on either side still receive the full document definitions', () => {
  const parts = mathBlocks('[First][ref]\n\n$$\nx\n$$\n\n[Second][ref]\n\n[ref]: https://example.com')
  for (const part of parts.filter(part => part.type === 'markdown')) {
    assert.match(part.text, /\[ref\]: https:\/\/example\.com/)
  }
})

test('footnote documents remain intact so numbering and placement do not change', () => {
  assert.equal(mathBlocks('A[^1]\n\n$$\nx\n$$\n\n[^1]: Note'), null)
})

test('multiple formulas have distinct stable source positions', () => {
  const parts = mathBlocks('$$\na\n$$\n\n$$\nb\n$$')
  assert.deepEqual(parts.map(part => part.tex), ['a', 'b'])
  assert.equal(new Set(parts.map(part => part.key)).size, 2)
})

test('a formula repeated as LaTeX source renders once without a source heading', () => {
  const raw = '$$\nL(N,D)=L_\\infty+\\frac{A}{N^\\alpha}\n$$'
  for (const label of ['源码：', '源代码：', 'Source code:']) {
    const parts = mathBlocks(`Before.\n\n${raw}\n\n${label}\n\n\`\`\`latex\n${raw}\n\`\`\`\n\nAfter.`)
    assert.deepEqual(parts.map(part => part.type), ['markdown', 'math', 'markdown'])
    assert.equal(parts[1].source, raw)
    assert.equal(parts[0].text, 'Before.\n\n')
    assert.equal(parts[2].text, '\n\nAfter.')
  }
})

test('source labels disappear but different formulas and explanations remain', () => {
  const parts = mathBlocks('$$\na\n$$\n\n源码：\n\n```latex\nb\n```\n\n源码：这里是解释。')
  assert.deepEqual(parts.filter(part => part.type === 'math').map(part => part.tex), ['a', 'b'])
  assert.equal(parts.at(-1).text, '\n\n源码：这里是解释。')
})
