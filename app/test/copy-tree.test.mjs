import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
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

test('relinking finishes out of order with at most four workers', async (t) => {
  const { from, into } = setup(t)
  const { symlink } = disk.promises
  const started = []
  const finished = []
  const batch = Promise.withResolvers()
  const secondFinished = Promise.withResolvers()
  const watchdog = new AbortController()
  const deadline = setTimeout(1000, undefined, { signal: watchdog.signal }).catch(() => {})
  t.after(() => { watchdog.abort() })
  let active = 0
  let peak = 0
  const copyTree = await mockRelink(t, async (target, path, type) => {
    const index = started.push({ target, path, type }) - 1
    peak = Math.max(peak, ++active)
    if (index === 3) batch.resolve()
    await Promise.race([batch.promise, deadline])
    if (index === 0) await Promise.race([secondFinished.promise, deadline])
    await symlink(target, path, type)
    finished.push(path)
    if (index === 1) secondFinished.resolve()
    active--
  })

  assert.deepEqual(await copyTree(from, into), [])
  assert.equal(peak, 4)
  assert.ok(finished.indexOf(started[1].path) < finished.indexOf(started[0].path))
  assert.deepEqual(started.map(entry => entry.path).sort(), names.map(name => join(into, name)))
  for (const { target, path, type } of started) {
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

for (const [kind, firstName, secondName] of [
  ['ASCII case', 'Link', 'link'],
  ['Unicode case', 'ß', 'ẞ'],
  ['Unicode normalization', 'café', 'cafe\u0301'],
  ['Unicode case and normalization', 'ßé', 'ẞe\u0301'],
]) {
  test(`the first link wins when destination names alias by ${kind}`, async (t) => {
    const { from, into } = setup(t)
    const first = join(into, firstName)
    const second = join(into, secondName)
    let made
    const attempts = []
    const exists = { isSymbolicLink: () => true }
    const { promises } = disk
    let firstSource
    t.mock.method(promises, 'cp', async (origin, _into, { filter }) => {
      firstSource = join(origin, firstName)
      await filter(firstSource)
      await filter(join(origin, secondName))
    })
    t.mock.method(promises, 'lstat', async path => {
      if ((path !== first && path !== second) || made !== undefined) return exists
      throw new Error('destination does not exist')
    })
    t.mock.method(promises, 'readlink', async path => path === firstSource ? 'first-target' : 'second-target')
    t.mock.method(promises, 'realpath', async path => path)
    t.mock.method(promises, 'stat', async () => ({ isDirectory: () => false }))
    const copyTree = await mockRelink(t, async (target, path) => {
      attempts.push(path)
      if (path === first) await setImmediate()
      if (made !== undefined) throw new Error('destination already exists')
      made = target
    })

    const skipped = await copyTree(from, into, { force: false, skip: true })
    assert.equal(made, 'first-target')
    assert.deepEqual(attempts, [first])
    assert.deepEqual(skipped, [])
  })
}

for (const abort of [true, false]) {
  test(`relinking drains pending writes before reporting ${abort ? 'an abort' : 'a failure'}`, { timeout: 5000 }, async (t) => {
    const { from, into } = setup(t)
    const controller = new AbortController()
    const batch = Promise.withResolvers()
    const stop = Promise.withResolvers()
    const drain = Promise.withResolvers()
    const started = []
    const finished = []
    const failure = new Error('relink stopped')
    const copyTree = await mockRelink(t, async (_target, path) => {
      const index = started.push(path) - 1
      if (index === 3) batch.resolve()
      if (!abort && index === 0) {
        await stop.promise
        throw failure
      }
      await drain.promise
      finished.push(path)
    })

    let settled = false
    const result = copyTree(from, into, { signal: controller.signal, skip: abort }).finally(() => { settled = true })
    const rejected = assert.rejects(result, error => error === failure)
    try {
      await Promise.race([batch.promise, result])
      if (abort) controller.abort(failure)
      else stop.resolve()
      await setImmediate()
      assert.equal(settled, false)
    } finally {
      drain.resolve()
    }
    await rejected
    assert.equal(started.length, 4)
    assert.deepEqual(finished, abort ? started : started.slice(1))
  })
}
