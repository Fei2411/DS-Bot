import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkMentions, normalizeFileLinks } from '../src/client/text.js'

// CommonMark's destination rule (`\` + ASCII punctuation collapses to the punctuation),
// as micromark implements it, followed by the slash normalisation the file resolver
// applies. Used so the "before" side of a case is the path the resolver would open.
const commonmarkDestination = destination => destination.replace(/\\([!-/:-@[-`{-~])/g, '$1')
const resolverPath = destination => commonmarkDestination(destination).replace(/\\/g, '/')

const destinationOf = (markdown) => {
  const match = /^\[[^\]]*\]\(([^)]*)\)$/.exec(markdown)
  assert.ok(match, `not a single link: ${markdown}`)
  return match[1]
}

test('a drive-letter link keeps its dot directories', () => {
  const report = '报告.md'
  const windowsPath = `C:\\work\\.dsh\\bot\\workspace\\${report}`
  const raw = `[${report}](${windowsPath})`

  assert.equal(resolverPath(destinationOf(raw)), `C:/work.dsh/bot/workspace/${report}`)

  const fixed = normalizeFileLinks(raw)
  assert.equal(destinationOf(fixed), `C:/work/.dsh/bot/workspace/${report}`)
  assert.equal(resolverPath(destinationOf(fixed)), `C:/work/.dsh/bot/workspace/${report}`)
})

test('every backslash in a destination is normalised, not just the first', () => {
  const raw = '[a](./x) [build.log](C:\\logs\\2026\\build.log)'
  assert.equal(normalizeFileLinks(raw), '[a](./x) [build.log](C:/logs/2026/build.log)')
})

test('a deep path keeps every directory, including every dot directory', () => {
  const windowsPath = 'C:\\a\\b\\c\\d\\e\\f\\.dsh\\g\\.git\\h\\i\\j\\k\\file.md'
  const posixPath = 'C:/a/b/c/d/e/f/.dsh/g/.git/h/i/j/k/file.md'
  const raw = `[file.md](${windowsPath})`
  assert.equal(resolverPath(destinationOf(raw)), 'C:/a/b/c/d/e/f.dsh/g.git/h/i/j/k/file.md')
  assert.equal(destinationOf(normalizeFileLinks(raw)), posixPath)
  assert.equal(resolverPath(destinationOf(normalizeFileLinks(raw))), posixPath)
})

test('an already-posix destination is unchanged', () => {
  const raw = '[build.log](C:/logs/2026/build.log)'
  assert.equal(normalizeFileLinks(raw), raw)
})

test('urls and relative links are left alone', () => {
  const text = '[docs](https://example.com/a\\b) [rel](./docs/a.md) [anchor](#section)'
  assert.equal(normalizeFileLinks(text), text)
})

test('a path outside a link destination is left alone', () => {
  const text = 'saved to `C:\\work\\.dsh\\bot\\workspace\\report.md`\nnext line'
  assert.equal(normalizeFileLinks(text), text)
})

test('text without a link destination is returned as-is', () => {
  assert.equal(normalizeFileLinks('no links here'), 'no links here')
  assert.equal(normalizeFileLinks(''), '')
  assert.equal(normalizeFileLinks(undefined), undefined)
})

test('the bubble pipeline keeps bot mentions working', () => {
  const bots = [{ id: 'a', name: '新 Bot' }, { id: 'b', name: '新 Bot 2' }]
  const text = '[report.md](C:\\work\\.dsh\\report.md) then ask @新 Bot 2'
  const rendered = linkMentions(normalizeFileLinks(text), bots, 'a')
  assert.equal(
    rendered,
    '[report.md](C:/work/.dsh/report.md) then ask [新 Bot 2](https://bots.local/b)',
  )
})

test('an inline-code example keeps its backslashes', () => {
  const text = 'example `[report.md](C:\\work\\.dsh\\report.md)` stays literal'
  assert.equal(normalizeFileLinks(text), text)
})

test('a fenced code example keeps its backslashes', () => {
  const text = 'before\n```\n[report.md](C:\\work\\.dsh\\report.md)\n```\nafter'
  assert.equal(normalizeFileLinks(text), text)
})

test('a tilde fence is left alone too', () => {
  const text = '~~~\n[report.md](C:\\work\\.dsh\\report.md)\n~~~'
  assert.equal(normalizeFileLinks(text), text)
})

test('a Markdown title is left untouched', () => {
  const raw = '[report.md](C:\\work\\.dsh\\report.md "C:\\work\\.dsh\\report.md")'
  assert.equal(normalizeFileLinks(raw), '[report.md](C:/work/.dsh/report.md "C:\\work\\.dsh\\report.md")')
})

test('a pointy destination is rewritten, its title is not', () => {
  const raw = '[report.md](<C:\\work\\.dsh\\report.md> "saved as C:\\work\\.dsh\\report.md")'
  assert.equal(
    normalizeFileLinks(raw),
    '[report.md](<C:/work/.dsh/report.md> "saved as C:\\work\\.dsh\\report.md")',
  )
})

test('Markdown escapes in a posix drive link stay escapes', () => {
  const raw = '[report](C:/docs/report\\[final\\].md)'
  assert.equal(normalizeFileLinks(raw), raw)
})

test('doubled backslashes in a posix destination stay doubled', () => {
  const raw = '[report](C:/docs/foo\\\\bar.md)'
  assert.equal(normalizeFileLinks(raw), raw)
})

test('an image with a Windows destination is rewritten the same way', () => {
  assert.equal(
    normalizeFileLinks('![alt](C:\\work\\.dsh\\shot.png)'),
    '![alt](C:/work/.dsh/shot.png)',
  )
})
