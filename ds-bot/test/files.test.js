import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearTimeout as realClearTimeout, setTimeout as realTimeout } from 'node:timers'
import { replaceFile } from '../src/host/files.js'

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-files-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('replaces a file that another program holds open for a moment', { skip: process.platform !== 'win32' && 'only Windows refuses it' }, async (t) => {
  const dir = folder(t)
  const path = join(dir, 'state.json')
  writeFileSync(path, 'old')
  writeFileSync(`${path}.tmp`, 'new')
  const reader = openSync(path, 'r')
  setTimeout(() => { closeSync(reader) }, 60)
  await replaceFile(`${path}.tmp`, path)
  assert.equal(readFileSync(path, 'utf8'), 'new')
})

test('stops trying when the check before a new try throws, and leaves the file as it was', { skip: process.platform !== 'win32' && 'only Windows refuses it' }, async (t) => {
  const dir = folder(t)
  const path = join(dir, 'state.json')
  writeFileSync(path, 'old')
  writeFileSync(`${path}.tmp`, 'new')
  const reader = openSync(path, 'r')
  const lost = new Error('lost the lock')
  try {
    await assert.rejects(replaceFile(`${path}.tmp`, path, () => { throw lost }), lost)
  } finally {
    closeSync(reader)
  }
  assert.equal(readFileSync(path, 'utf8'), 'old')
})

test('gives up at once on an error that waiting does not fix', async (t) => {
  const dir = folder(t)
  const wait = t.mock.method(globalThis, 'setTimeout')
  await assert.rejects(replaceFile(join(dir, 'missing.tmp'), join(dir, 'state.json')), { code: 'ENOENT' })
  assert.equal(wait.mock.callCount(), 0)
})

test('a Windows file retry finishes while the application clock is frozen', async (t) => {
  const dir = folder(t)
  const path = join(dir, 'state.json')
  writeFileSync(path, 'old')
  writeFileSync(`${path}.tmp`, 'new')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const rename = fsp.rename
  let attempts = 0
  let deadline
  Object.defineProperty(process, 'platform', { value: 'win32' })
  fsp.rename = async (...args) => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('file is busy'), { code: 'EPERM' })
    return rename(...args)
  }
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = replaceFile(`${path}.tmp`, path)
    const finished = await Promise.race([
      pending.then(() => true),
      new Promise(resolve => { deadline = realTimeout(resolve, 1000, false) }),
    ])
    // Release the old implementation too, so a regression fails instead of hanging.
    t.mock.timers.runAll()
    await pending
    assert.equal(finished, true, 'the real filesystem must not wait for a mock timer tick')
    assert.equal(attempts, 2)
    assert.equal(readFileSync(path, 'utf8'), 'new')
  } finally {
    realClearTimeout(deadline)
    t.mock.timers.reset()
    fsp.rename = rename
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', platform)
  }
})
