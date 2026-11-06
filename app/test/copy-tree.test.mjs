import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { disk } from '../src/copy-tree.mjs'

// Only Electron's fs shows the bug, and this job has no Electron: check-packed.mjs runs the copy
// itself. This keeps the files that touch the user's folders from going back to that fs.
test('the import, the data move and the data location stay off Electron\'s fs', () => {
  for (const name of ['copy-tree', 'import', 'move-data', 'place']) {
    const source = readFileSync(new URL(`../src/${name}.mjs`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'node:fs(\/promises)?'/u, name)
  }
  assert.doesNotMatch(readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8'), /import \{[^}]*\brm\b[^}]*\} from 'node:fs/u)
})

test('outside Electron the disk is plain fs', () => {
  assert.equal(disk, process.getBuiltinModule('node:fs'))
})
