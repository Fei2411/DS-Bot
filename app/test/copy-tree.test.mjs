import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
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

const folderLink = process.platform === 'win32' ? 'junction' : 'dir'
const names = ['a', 'b', 'c', 'd', 'e', 'f']

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-copy-tree-')))
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  const from = join(root, 'from')
  const into = join(root, 'into')
  const target = join(from, 'target')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'note.txt'), 'copied')
  for (const name of names) symlinkSync(target, join(from, name), folderLink)
  return { from, into }
}

async function mockRelink(t, symlink) {
  t.mock.method(disk.promises, 'symlink', symlink)
  const url = new URL('../src/copy-tree.mjs', import.meta.url)
  url.searchParams.set('test', t.name)
  return (await import(url.href)).copyTree
}

test('relink preparation finishes out of order with at most four workers', async (t) => {
  const { from, into } = setup(t)
  const { readlink, symlink } = disk.promises
  const started = []
  const finished = []
  const writes = []
  const batch = Promise.withResolvers()
  const secondFinished = Promise.withResolvers()
  const watchdog = new AbortController()
  const deadline = setTimeout(1000, undefined, { signal: watchdog.signal }).catch(() => {})
  t.after(() => { watchdog.abort() })
  let active = 0
  let peak = 0
  t.mock.method(disk.promises, 'readlink', async path => {
    const index = started.push(path) - 1
    peak = Math.max(peak, ++active)
    if (index === 3) batch.resolve()
    await Promise.race([batch.promise, deadline])
    if (index === 0) await Promise.race([secondFinished.promise, deadline])
    const text = await readlink(path)
    finished.push(path)
    if (index === 1) secondFinished.resolve()
    active--
    return text
  })
  const copyTree = await mockRelink(t, async (target, path, type) => {
    writes.push({ target, path, type })
    await symlink(target, path, type)
  })

  assert.deepEqual(await copyTree(from, into), [])
  assert.equal(peak, 4)
  assert.ok(finished.indexOf(started[1]) < finished.indexOf(started[0]))
  const written = writes.map(entry => entry.path)
  assert.deepEqual(written, started.map(path => join(into, basename(path))))
  assert.deepEqual([...written].sort(), names.map(name => join(into, name)))
  for (const { target, path, type } of writes) {
    assert.equal(type, folderLink)
    assert.equal(target, join(into, 'target'))
    assert.equal(readFileSync(join(path, 'note.txt'), 'utf8'), 'copied')
  }
})

test('skip order follows the walk, and force false keeps an existing destination', async (t) => {
  const { from, into } = setup(t)
  const kept = join(into, 'a')
  mkdirSync(into)
  writeFileSync(kept, 'kept')
  const walked = []
  const attempted = []
  const failure = new Error('cannot recreate link')
  const copyTree = await mockRelink(t, async (_target, path) => {
    attempted.push(path)
    if (attempted.length === 1) await setImmediate()
    throw failure
  })

  const skipped = await copyTree(from, into, { force: false, skip: true, leave: path => { walked.push(path); return path === 'f' } })
  assert.deepEqual(skipped, walked.filter(path => ['b', 'c', 'd', 'e'].includes(path)))
  assert.deepEqual(attempted.sort(), ['b', 'c', 'd', 'e'].map(name => join(into, name)))
  assert.equal(readFileSync(kept, 'utf8'), 'kept')
})

test('later links use targets made resolvable by earlier links', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-copy-tree-')))
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  const from = join(root, 'from')
  const into = join(root, 'into')
  const sourceInner = join(from, 'inner')
  const destInner = join(into, 'inner')
  const destZ = join(into, 'z')
  mkdirSync(sourceInner, { recursive: true })
  mkdirSync(into)
  symlinkSync(process.platform === 'win32' ? join(from, 'bridge') : 'bridge', join(from, 'z'), folderLink)
  symlinkSync(sourceInner, join(from, 'bridge'), folderLink)
  symlinkSync(destZ, join(from, 'a'), folderLink)
  symlinkSync(sourceInner, join(into, 'bridge'), folderLink)

  const { promises } = disk
  const { cp, stat, symlink } = promises
  const unresolved = Promise.withResolvers()
  const watchdog = new AbortController()
  const deadline = setTimeout(1000, undefined, { signal: watchdog.signal }).catch(() => {})
  t.after(() => { watchdog.abort() })
  t.mock.method(promises, 'cp', async (origin, _destination, { filter }) => {
    await cp(sourceInner, destInner, { recursive: true })
    for (const name of ['z', 'bridge', 'a']) await filter(join(origin, name))
  })
  t.mock.method(promises, 'stat', async path => {
    try {
      return await stat(path)
    } catch (error) {
      if (path === join(from, 'a')) unresolved.resolve()
      throw error
    }
  })
  const recreate = await mockRelink(t, async (target, path, type) => {
    if (path === destZ) await Promise.race([unresolved.promise, deadline])
    return symlink(target, path, type)
  })

  assert.deepEqual(await recreate(from, into, { force: false, skip: true }), [])
  assert.equal(realpathSync(destZ), realpathSync(sourceInner))
  assert.equal(realpathSync(join(into, 'a')), realpathSync(destInner))
})

for (const [kind, ...aliases] of [
  ['ASCII case', 'Link', 'link'],
  ['Unicode case', 'ß', 'ẞ'],
  ['Unicode normalization', 'café', 'cafe\u0301'],
  ['Unicode case and normalization', 'ßé', 'ẞe\u0301'],
  ['an ignored zero-width joiner', 'AB', 'A\u200DB'],
  ['arbitrary filesystem equivalence', 'oldest', 'middle', 'newest'],
]) {
  test(`the first link wins when destination names alias by ${kind}`, async (t) => {
    const { from, into } = setup(t)
    const destinations = aliases.map(name => join(into, name))
    const [first] = destinations
    let made
    const attempts = []
    const exists = { isSymbolicLink: () => true }
    const { promises } = disk
    let sources
    t.mock.method(promises, 'cp', async (origin, _into, { filter }) => {
      sources = aliases.map(name => join(origin, name))
      for (const source of sources) await filter(source)
    })
    t.mock.method(promises, 'lstat', async path => {
      if (!destinations.includes(path) || made !== undefined) return exists
      throw new Error('destination does not exist')
    })
    t.mock.method(promises, 'readlink', async path => {
      const index = sources.indexOf(path)
      if (index !== sources.length - 1) await setImmediate()
      return `target-${String(index)}`
    })
    t.mock.method(promises, 'realpath', async path => path)
    t.mock.method(promises, 'stat', async () => ({ isDirectory: () => false }))
    const copyTree = await mockRelink(t, async (target, path) => {
      attempts.push(path)
      if (path === first) await setImmediate()
      if (made !== undefined) throw new Error('destination already exists')
      made = target
    })

    const skipped = await copyTree(from, into, { force: false, skip: true })
    assert.equal(made, 'target-0')
    assert.deepEqual(attempts, [first])
    assert.deepEqual(skipped, [])
  })
}

for (const abort of [true, false]) {
  test(`relinking drains pending work before reporting ${abort ? 'an abort' : 'a failure'}`, { timeout: 5000 }, async (t) => {
    const { from, into } = setup(t)
    const controller = new AbortController()
    const batch = Promise.withResolvers()
    const writing = Promise.withResolvers()
    const stop = Promise.withResolvers()
    const drain = Promise.withResolvers()
    const started = []
    const finished = []
    const writes = []
    const failure = new Error('relink stopped')
    const { readlink } = disk.promises
    t.mock.method(disk.promises, 'readlink', async path => {
      const index = started.push(path) - 1
      if (index === 3) batch.resolve()
      if (index !== 0) await drain.promise
      const text = await readlink(path)
      finished.push(path)
      return text
    })
    const copyTree = await mockRelink(t, async (_target, path) => {
      writes.push(path)
      writing.resolve()
      await stop.promise
      if (!abort) throw failure
    })

    let settled = false
    const result = copyTree(from, into, { signal: controller.signal, skip: abort }).finally(() => { settled = true })
    const rejected = assert.rejects(result, error => error === failure)
    try {
      await Promise.race([Promise.all([batch.promise, writing.promise]), result])
      if (abort) controller.abort(failure)
      stop.resolve()
      await setImmediate()
      assert.equal(settled, false)
    } finally {
      drain.resolve()
    }
    await rejected
    assert.equal(started.length, 4)
    assert.deepEqual(writes, [join(into, basename(started[0]))])
    assert.deepEqual([...finished].sort(), [...started].sort())
  })
}

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
