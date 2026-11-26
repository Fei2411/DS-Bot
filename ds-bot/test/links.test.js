import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { absoluteLinks, fileLinks } from '../src/host/links.js'

const folder = resolve('/work/group folder')
// The path DSH opens for a link, as its chat decodes the destination.
const opened = text => decodeURIComponent(/\]\(([^)#]+)/.exec(text)[1])
const full = path => resolve(folder, path).replace(/\\/g, '/')

test('a relative file link names the file in the folder it was written in', () => {
  assert.equal(opened(absoluteLinks('See [a.txt](sub/a.txt).', folder)), full('sub/a.txt'))
  assert.equal(opened(absoluteLinks('[up](../notes.md)', folder)), full('../notes.md'))
  // A line range and an image keep their form.
  assert.match(absoluteLinks('[main](src/main.js#L12-L20)', folder), /#L12-L20\)$/)
  assert.equal(opened(absoluteLinks('![chart](out/chart.png)', folder)), full('out/chart.png'))
})

test('a name with # or ? still resolves after the link is made absolute', () => {
  // A destination encodes both, because `fileTarget` ends the path at either one.
  const text = absoluteLinks('[out](report%232.md) and [q](why%3F.txt)', folder)
  assert.deepEqual(fileLinks(text), [full('report#2.md'), full('why?.txt')])
  // The line range is added after the path is encoded, so it stays a fragment.
  assert.deepEqual(fileLinks(absoluteLinks('[main](src/main.js#L12-L20)', folder)), [full('src/main.js')])
})

test('a path with spaces, parentheses or a percent sign opens as written', () => {
  assert.equal(opened(absoluteLinks('[r](<my report (v2).md>)', folder)), full('my report (v2).md'))
  assert.equal(opened(absoluteLinks('[r](100%25.txt)', folder)), full('100%.txt'))
})

test('absolute paths, web links, anchors and code are left as they are', () => {
  const kept = [
    '[a](/srv/a.txt)',
    '[a](C:/work/a.txt)',
    '[site](https://example.com/a)',
    '[mail](mailto:a@example.com)',
    '[top](#intro)',
    '[q](a.txt?raw=1)',
    '[home](~/a.txt)',
    'Write `[a](sub/a.txt)` for a link.',
    '```\n[a](sub/a.txt)\n```',
    'No link here.',
  ]
  for (const text of kept) assert.equal(absoluteLinks(text, folder), text)
  assert.equal(absoluteLinks('[a](sub/a.txt)', undefined), '[a](sub/a.txt)')
})

test('only the links outside code change', () => {
  const text = 'Use `[x](x.md)` like [y](y.md).'
  assert.equal(absoluteLinks(text, folder), `Use \`[x](x.md)\` like [y](${full('y.md').replace(/ /g, '%20')}).`)
})
