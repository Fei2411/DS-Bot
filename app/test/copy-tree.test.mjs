import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyTree, disk } from '../src/copy-tree.mjs'

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

test('links into a folder starting with .. lead into the copy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-copy-tree-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = join(root, 'workspace')
  const into = join(root, 'copy')
  const notes = join(from, '..notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, 'note.txt'), 'a note')
  symlinkSync(notes, join(from, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')

  await copyTree(from, into)
  rmSync(from, { recursive: true })

  assert.equal(readFileSync(join(into, 'notes', 'note.txt'), 'utf8'), 'a note')
})
