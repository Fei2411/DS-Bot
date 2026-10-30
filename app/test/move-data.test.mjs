import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { test } from 'node:test'
import { copyTree } from '../src/copy-tree.mjs'
import { copyData, installFolder, moveProblem } from '../src/move-data.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The app's data with a team, a chat and a key, plus what stays behind: the engine's lock and
// the temporary folders of a first-run copy and check that were cut short.
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-move-'))
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  const from = join(root, 'data')
  write(join(from, 'bot', 'state.json'), '{"bots":{"a":{}}}')
  write(join(from, 'bot', 'state.lock'), '{}')
  write(join(from, 'sessions', 'g', 's1', 'log.jsonl'), 'chat')
  write(join(from, '.credentials.yaml'), 'key: test')
  write(join(from, '.import-12', 'bot', 'state.json'), '{}')
  write(join(from, '.import-check-34', 'check.json'), '[]')
  return { root, from }
}

const files = (dir) => {
  const found = []
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`)
      else found.push(`${prefix}${entry.name}`)
    }
  }
  walk(dir, '')
  return found.sort()
}

test('the new data location is an empty or new folder apart from the data, the team workspace, DSH and the program', (t) => {
  const { root, from } = setup(t)
  const places = { from, workspace: join(root, 'work'), dshHome: join(root, 'dsh'), program: join(root, 'program') }
  const problem = to => moveProblem({ ...places, to })
  assert.equal(problem(join(root, 'new')), undefined)
  mkdirSync(join(root, 'empty'))
  assert.equal(problem(join(root, 'empty')), undefined)
  assert.equal(problem(parse(root).root), 'drive')
  assert.equal(problem(from), 'nested')
  assert.equal(problem(join(from, 'inside')), 'nested')
  assert.equal(problem(root), 'nested')
  assert.equal(problem(join(root, 'work', 'data')), 'workspace')
  assert.equal(moveProblem({ ...places, workspace: join(root, 'new', 'work'), to: join(root, 'new') }), 'workspace')
  assert.equal(problem(join(root, 'dsh', 'data')), 'dsh')
  assert.equal(moveProblem({ ...places, dshHome: join(root, 'new', '.dsh'), to: join(root, 'new') }), 'dsh')
  assert.equal(problem(join(root, 'program', 'data')), 'program')
  write(join(root, 'full', 'note.txt'), 'x')
  assert.equal(problem(join(root, 'full')), 'notEmpty')
  assert.equal(problem(join(root, 'full', 'note.txt')), 'notEmpty')
})

test('the program folder is the whole app bundle on macOS', () => {
  assert.equal(installFolder('/Applications/DeepSeek Bot.app/Contents/MacOS/DeepSeek Bot', 'darwin'), '/Applications/DeepSeek Bot.app')
  assert.equal(installFolder(join('C:', 'Programs', 'DeepSeek Bot', 'DeepSeek Bot.exe'), 'win32'), join('C:', 'Programs', 'DeepSeek Bot'))
})

test('the data is copied whole, without the lock and the temporary folders, and the old folder stays', async (t) => {
  const { root, from } = setup(t)
  const before = files(from)
  for (const to of [join(root, 'new', 'data'), join(root, 'empty')]) {
    mkdirSync(join(root, 'empty'), { recursive: true })
    await copyData(from, to)
    assert.deepEqual(files(to), ['.credentials.yaml', 'bot/state.json', 'sessions/g/s1/log.jsonl'])
    assert.equal(readFileSync(join(to, 'sessions', 'g', 's1', 'log.jsonl'), 'utf8'), 'chat')
    assert.deepEqual(readdirSync(dirname(to)).filter(name => name.includes('.moving-')), [])
  }
  assert.deepEqual(files(from), before)
})

test('a copy that is stopped or fails leaves no new folder and no staging folder', async (t) => {
  const { root, from } = setup(t)
  const to = join(root, 'new')
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(copyData(from, to, stopped.signal), { name: 'AbortError' })
  // Stopped part way through, after some files are copied.
  let seen = 0
  const midway = new AbortController()
  const signal = { throwIfAborted: () => { if (++seen === 4) midway.abort(); midway.signal.throwIfAborted() } }
  await assert.rejects(copyData(from, to, signal), { name: 'AbortError' })
  assert.ok(seen >= 4)
  assert.equal(existsSync(to), false)
  assert.deepEqual(readdirSync(root).filter(name => name.includes('.moving-')), [])
})

test('only the staging folders of an earlier move go before the next copy', async (t) => {
  const { root, from } = setup(t)
  write(join(root, '.new.moving-1', '.ds-bot-moving'), '')
  write(join(root, '.new.moving-2', 'notes.txt'), 'mine')
  write(join(root, '.new.moving-backup', 'notes.txt'), 'mine')
  await copyData(from, join(root, 'new'))
  assert.deepEqual(readdirSync(root).sort(), ['.new.moving-2', '.new.moving-backup', 'data', 'new'])
  assert.equal(existsSync(join(root, 'new', '.ds-bot-moving')), false)
})

// Windows makes a junction without special rights; it always holds an absolute path.
const folderLink = process.platform === 'win32' ? 'junction' : 'dir'

test('a folder that a link leads into counts as that folder', (t) => {
  const { root, from } = setup(t)
  mkdirSync(join(root, 'dsh'))
  symlinkSync(join(root, 'dsh'), join(root, 'dsh-link'), folderLink)
  assert.equal(moveProblem({ from, to: join(root, 'dsh-link', 'data'), dshHome: join(root, 'dsh') }), 'dsh')
  symlinkSync(from, join(root, 'data-link'), folderLink)
  assert.equal(moveProblem({ from, to: join(root, 'data-link', 'inside'), dshHome: join(root, 'dsh') }), 'nested')
})

test('a data folder that is itself a link moves with its contents', async (t) => {
  const { root, from } = setup(t)
  symlinkSync(from, join(root, 'data-link'), folderLink)
  await copyData(join(root, 'data-link'), join(root, 'new'))
  assert.deepEqual(files(join(root, 'new')), ['.credentials.yaml', 'bot/state.json', 'sessions/g/s1/log.jsonl'])
})

test('links in the data lead inside the copy, not back into the old folder', async (t) => {
  const { root, from } = setup(t)
  symlinkSync(join(from, 'sessions'), join(from, 'bot', 'absolute'), folderLink)
  write(join(root, 'elsewhere', 'file.txt'), 'x')
  symlinkSync(join(root, 'elsewhere'), join(from, 'bot', 'outside'), folderLink)
  // Into the data through another link.
  symlinkSync(from, join(root, 'data-alias'), folderLink)
  symlinkSync(join(root, 'data-alias', 'sessions'), join(from, 'bot', 'chained'), folderLink)
  if (process.platform !== 'win32') {
    symlinkSync(join('..', 'sessions'), join(from, 'bot', 'relative'), 'dir')
    symlinkSync(join('..', '..', 'elsewhere'), join(from, 'bot', 'relative-outside'), 'dir')
    symlinkSync(join('..', '..', 'data-alias', 'sessions'), join(from, 'bot', 'relative-alias'), 'dir')
  }
  // Deeper than the old folder, so that a relative link out of it would lead elsewhere.
  const to = join(root, 'deeper', 'new')
  await copyData(from, to)
  const target = name => readlinkSync(join(to, 'bot', name)).replace(/^\\\\\?\\/u, '').replace(/[\\/]+$/u, '')
  assert.equal(target('absolute'), join(to, 'sessions'))
  assert.equal(target('outside'), join(root, 'elsewhere'))
  assert.equal(target('chained'), join(to, 'sessions'))
  if (process.platform !== 'win32') {
    assert.equal(target('relative'), join('..', 'sessions'))
    // The copy writes an outside link through the real path of the old folder, which macOS
    // spells /private/var where the temporary folder is /var; both lead to the same folder.
    const outside = target('relative-outside')
    assert.ok(isAbsolute(outside))
    assert.equal(realpathSync(outside), realpathSync(join(root, 'elsewhere')))
    assert.equal(readFileSync(join(to, 'bot', 'relative-outside', 'file.txt'), 'utf8'), 'x')
    assert.equal(target('relative-alias'), join(to, 'sessions'))
  }
  assert.equal(readFileSync(join(to, 'bot', 'absolute', 'g', 's1', 'log.jsonl'), 'utf8'), 'chat')
})

// Windows makes a link to nothing that is not a folder only with special rights, which the
// tests do not have, so there it is a link the copy cannot make again.
test('a link the move cannot make again stops the move; the import skips it', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, from } = setup(t)
  symlinkSync(join(root, 'gone'), join(from, 'lost'), 'junction')
  const to = join(root, 'new')
  await assert.rejects(copyData(from, to), { code: 'EPERM' })
  assert.equal(existsSync(to), false)
  assert.deepEqual(readdirSync(root).filter(name => name.includes('.moving-')), [])
  assert.deepEqual(await copyTree(from, join(root, 'files'), { skip: true }), ['lost'])
  assert.equal(readFileSync(join(root, 'files', 'sessions', 'g', 's1', 'log.jsonl'), 'utf8'), 'chat')
})
