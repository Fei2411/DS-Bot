import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseLoginShellPath, readLoginShellPath } from '../src/login-shell-env.mjs'

const MARKER = '_DS_BOT_LOGIN_PATH_'
const dump = (path) => `\0${MARKER}\0${path}\0\0${MARKER}\0`

// A shell that ignores its arguments and prints what the test wants: the probe
// command is not what these tests check, only that its output is read safely.
function fakeShell(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-login-shell-'))
  const file = join(dir, 'shell')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return { file, dir }
}

test('the PATH between the markers is taken, rc noise around it is dropped', () => {
  assert.equal(
    parseLoginShellPath(`some rc line\n${dump('/opt/homebrew/bin:/usr/bin:/bin')}`),
    '/opt/homebrew/bin:/usr/bin:/bin',
  )
})

test('a shell that dies before the second marker yields nothing', () => {
  assert.equal(parseLoginShellPath(`\0${MARKER}\0/usr/bin\0`), undefined)
  assert.equal(parseLoginShellPath('no markers at all'), undefined)
})

test('relative entries are not taken and duplicates keep their first place', () => {
  assert.equal(
    parseLoginShellPath(dump('relative/bin:/usr/bin:/usr/bin:/opt/bin')),
    '/usr/bin:/opt/bin',
  )
  assert.equal(parseLoginShellPath(dump('relative/bin:')), undefined)
})

test('the login shell PATH is read from an interactive login shell', async () => {
  const { file, dir } = fakeShell([
    `printf '\\0${MARKER}\\0'`,
    `printf '%s\\0' "$FAKE_PATH"`,
    `printf '\\0${MARKER}\\0'`,
  ].join('\n'))
  try {
    const found = await readLoginShellPath({ shells: [file], env: { PATH: '/usr/bin:/bin', FAKE_PATH: '/opt/homebrew/bin:/usr/bin' } })
    assert.equal(found, '/opt/homebrew/bin:/usr/bin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shell that fails, or prints nothing usable, is skipped', async () => {
  const failing = fakeShell('exit 3')
  const empty = fakeShell('exit 0')
  try {
    assert.equal(await readLoginShellPath({ shells: [failing.file], env: { PATH: '/usr/bin:/bin' } }), undefined)
    assert.equal(await readLoginShellPath({ shells: [empty.file], env: { PATH: '/usr/bin:/bin' } }), undefined)
    assert.equal(await readLoginShellPath({ shells: [], env: { PATH: '/usr/bin:/bin' } }), undefined)
  } finally {
    rmSync(failing.dir, { recursive: true, force: true })
    rmSync(empty.dir, { recursive: true, force: true })
  }
})

test('a hanging shell is killed at the deadline', async () => {
  const { file, dir } = fakeShell('sleep 10')
  const started = Date.now()
  try {
    assert.equal(await readLoginShellPath({ shells: [file], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 150 }), undefined)
    assert.ok(Date.now() - started < 5_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing shell file is not an error', async () => {
  assert.equal(await readLoginShellPath({ shells: ['/nonexistent/ds-bot-shell'], env: { PATH: '/usr/bin:/bin' } }), undefined)
})
