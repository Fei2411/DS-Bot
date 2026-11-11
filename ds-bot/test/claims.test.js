import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { absoluteLinks } from '../src/host/links.js'
import { announcesWork, claimsFor, fileRefs, missingFileRefs } from '../src/host/claims.js'

test('local file references are the marked links and code paths, never URLs or bare names', () => {
  const text = [
    'The deck is at ./out/report.pptx, the sheet at `/tmp/data.xlsx`.',
    'See [the note](../notes/todo.md) and [site](https://example.test/report.pptx).',
    'A bare `report.md` says nothing about a folder.',
    'Windows: `C:\\Users\\me\\Desktop\\deck.pptx`, UNC `\\\\server\\share\\a.docx`.',
    'Anchor [go](#section), glob `out/*.pptx`, mail [me](mailto:a@b.test).',
  ].join('\n')
  assert.deepEqual(fileRefs(text), [
    '../notes/todo.md',
    '/tmp/data.xlsx',
    'C:\\Users\\me\\Desktop\\deck.pptx',
    '\\\\server\\share\\a.docx',
    './out/report.pptx',
  ])
})

test('slash commands and URL paths are not files, and a folder reference is not checked', () => {
  const text = 'Run `/goal` to set the goal, then `/compact` to shrink the context. The endpoint is `/api/bot`. Output lands in `./out/`.'
  assert.deepEqual(fileRefs(text), [])
  assert.deepEqual(missingFileRefs(text, '/definitely/not/a/folder'), [])
  // A markdown link is a deliberate file reference, so it keeps the wider rule.
  assert.deepEqual(fileRefs('[notes](/tmp/notes)'), ['/tmp/notes'])
})

test('a reference is missing only when the path is not on disk', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'out', 'done.pptx'), 'x')
  const text = 'Here: `./out/done.pptx`, `./out/never.pptx`, and `/definitely/not/here.txt`.'
  assert.deepEqual(missingFileRefs(text, root), ['./out/never.pptx', '/definitely/not/here.txt'])
})

test('a reply announcing work in progress is recognised, a finished report is not', () => {
  for (const said of [
    '正在导出 PPTX，稍后汇报。',
    '还在处理附件，马上回来。',
    "I'm still exporting the deck. I'll report back shortly.",
    'Working on it — will share the file when done.',
    `Started on the long report. ${'Context. '.repeat(40)}正在整理第 12 页，稍后发你。`,
  ]) assert.equal(announcesWork(said), true, said)
  for (const said of [
    '已导出到 ./out/report.pptx。',
    'The deck is done, here it is.',
    '好的，我检查过了，配置没问题。',
    '查完了，原因是端口冲突。',
    '',
  ]) assert.equal(announcesWork(said), false, said)
})

test('the marker combines a missing file with work that is not running', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = '正在导出报告到 ./out/report.pptx，稍后汇报。'
  assert.deepEqual(claimsFor({ text, base: root }), { missingFiles: ['./out/report.pptx'], inProgress: true })
  assert.deepEqual(claimsFor({ text, base: root, worked: true }), { missingFiles: ['./out/report.pptx'] })
  assert.deepEqual(claimsFor({ text, base: root, subagents: true }), { missingFiles: ['./out/report.pptx'] })
  assert.deepEqual(claimsFor({ text, base: root, runningJobs: 1 }), { missingFiles: ['./out/report.pptx'] })
  writeFileSync(join(root, 'report.pptx'), 'x')
  assert.deepEqual(claimsFor({ text: '正在导出报告到 ./report.pptx，稍后汇报。', base: root }), { inProgress: true })
})

test('file checks open encoded links and line anchors exactly as the chat does', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-claims-links-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'out', 'Quarter 1 (final).md'), '# Report')
  const reply = absoluteLinks('[Report](<./out/Quarter 1 (final).md#L1>)', root)
  assert.deepEqual(missingFileRefs(reply, root), [])
  assert.deepEqual(missingFileRefs('[Report](<./out/Quarter 1 (final).md#L1>)', root), [])
  assert.deepEqual(claimsFor({ text: '正在整理报告，稍后汇报。', base: root, runningJobs: null }), undefined)
})
