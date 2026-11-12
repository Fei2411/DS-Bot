import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { absoluteLinks } from '../src/host/links.js'
import { announcesWork, claimsFor, fileRefs, missingFileRefs } from '../src/host/claims.js'

test('only deliberate local Markdown file links are checked, never URLs, bare names, code spans or plain paths', () => {
  const text = [
    'Cleaned up `./out/old.pptx` and missing `config/local.json`, plain /tmp/data.xlsx.',
    'See [the note](../notes/todo.md), [deck](./out/report.pptx) and [site](https://example.test/report.pptx).',
    'Anchor [go](#section), folder [dir](./out/), glob [all](out/*.pptx), mail [me](mailto:a@b.test).',
    '```md\n[example](./inside-code-block.md)\n```',
  ].join('\n')
  assert.deepEqual(fileRefs(text), [
    '../notes/todo.md',
    './out/report.pptx',
  ])
})

test('slash commands, URL paths and deleted-file diagnostics are never misreported', () => {
  const text = 'Run `/goal` to set the goal, then `/compact` to shrink the context. Deleted `src/old.js`; endpoint `/api/bot`.'
  assert.deepEqual(fileRefs(text), [])
  assert.deepEqual(missingFileRefs(text, '/definitely/not/a/folder'), [])
  assert.deepEqual(fileRefs('[notes](/tmp/notes)'), ['/tmp/notes'])
})

test('a linked file is missing only when not on disk, with no 3-file truncation and line suffixes respected', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'out', 'done.js'), 'x')
  const text = [
    '[ok](./out/done.js:12)',
    '[m1](./out/m1.md)',
    '[m2](./out/m2.md)',
    '[m3](./out/m3.md)',
    '[m4](./out/m4.md)',
  ].join(' ')
  assert.deepEqual(missingFileRefs(text, root), [
    './out/m1.md',
    './out/m2.md',
    './out/m3.md',
    './out/m4.md',
  ])
})

test('encoded links in folders with spaces (such as ~/DS Bot) resolve cleanly after absoluteLinks', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-space-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const workspace = join(base, 'DS Bot')
  mkdirSync(join(workspace, 'out'), { recursive: true })
  writeFileSync(join(workspace, 'out', 'Quarter 1 (final).md'), '# Report')
  const rewritten = absoluteLinks('已生成 [报告](<./out/Quarter 1 (final).md#L1>)。', workspace)
  assert.match(rewritten, /DS%20Bot/)
  assert.deepEqual(missingFileRefs(rewritten, workspace), [])
})

test('a reply announcing work in progress is recognised per sentence, and code or past-to-done prose is not', () => {
  for (const said of [
    '正在导出 PPTX，稍后汇报。',
    '还在处理附件，马上回来。',
    '第一部分已完成，第二部分正在导出，稍后汇报。',
    "I'm still exporting the deck. I'll report back shortly.",
    'Working on it — will share the file when done.',
    `Started on the long report. ${'Context. '.repeat(40)}正在整理第 12 页，稍后发你。`,
  ]) assert.equal(announcesWork(said), true, said)
  for (const said of [
    '已导出到 [report](./out/report.pptx)。',
    '刚才还在检查配置，现在已经完成了。',
    'The deck is done, here it is.',
    '好的，我检查过了，配置没问题。',
    '```js\nconsole.log("正在导出，稍后汇报")\n```',
    '',
  ]) assert.equal(announcesWork(said), false, said)
})

test('the marker combines missing linked files with work that is not running, unless a peer was called', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = '正在导出报告到 [report](./out/report.pptx)，稍后汇报。'
  assert.deepEqual(claimsFor({ text, base: root }), { missingFiles: ['./out/report.pptx'], inProgress: true })
  assert.deepEqual(claimsFor({ text, base: root, worked: true }), { missingFiles: ['./out/report.pptx'] })
  assert.deepEqual(claimsFor({ text, base: root, subagents: true }), { missingFiles: ['./out/report.pptx'] })
  assert.deepEqual(claimsFor({ text, base: root, runningJobs: 1 }), { missingFiles: ['./out/report.pptx'] })
  assert.deepEqual(claimsFor({ text, base: root, calledPeer: true }), { missingFiles: ['./out/report.pptx'] })
  writeFileSync(join(root, 'report.pptx'), 'x')
  assert.deepEqual(claimsFor({ text: '正在导出报告到 [report](./report.pptx)，稍后汇报。', base: root }), { inProgress: true })
  assert.equal(claimsFor({ text: '@Writer 请先出初稿，我稍后汇报。', base: root, calledPeer: true }), undefined)
  assert.equal(claimsFor({ text: '正在整理报告，稍后汇报。', base: root, runningJobs: null }), undefined)
})
