import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareComputerHelper } from '../../ds-bot/src/host/computer/mac-helper.js'

const BUNDLE = 'a'.repeat(64)
const EXECUTABLE = join('DSH Computer Use.app', 'Contents', 'MacOS', 'dsh-cua-native')
const binDir = (runtimeDir, arch = 'arm64') => join(runtimeDir, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos', 'native', 'bin', `darwin-${arch}`)

function fixture(t, bundle = BUNDLE, content = 'helper v1') {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-computer-helper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeDir = join(root, 'DS Bot.app', 'Contents', 'Resources')
  const dir = binDir(runtimeDir)
  mkdirSync(dirname(join(dir, bundle, EXECUTABLE)), { recursive: true })
  writeFileSync(join(dir, bundle, EXECUTABLE), content)
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ bundle }))
  return { runtimeDir, home: join(root, 'support', 'computer-use') }
}
const copy = (from, to) => cpSync(from, to, { recursive: true })
const verify = () => {}

test('the helper runs from a copy outside the app bundle', async (t) => {
  const { runtimeDir, home } = fixture(t)
  const helper = await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  assert.equal(helper, join(home, BUNDLE, EXECUTABLE))
  assert.equal(readFileSync(helper, 'utf8'), 'helper v1')
})

test('a matching copy is reused without copying again', async (t) => {
  const { runtimeDir, home } = fixture(t)
  await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  let copies = 0
  let checks = 0
  await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy: (a, b) => { copies++; copy(a, b) }, verify: () => { checks++ } })
  assert.equal(copies, 0)
  assert.equal(checks, 1)
})

test('a cached copy whose bundle signature fails is replaced', async (t) => {
  const { runtimeDir, home } = fixture(t)
  await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  let copies = 0
  let checks = 0
  await prepareComputerHelper({
    runtimeDir, home, arch: 'arm64',
    copy: (a, b) => { copies++; copy(a, b) },
    verify: () => { if (++checks === 1) throw new Error('a resource in the bundle was modified') },
  })
  assert.equal(copies, 1)
  assert.equal(checks, 2)
})

test('a copy that differs from the packaged helper is replaced', async (t) => {
  const { runtimeDir, home } = fixture(t)
  const first = await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  writeFileSync(first, 'changed on disk')
  const second = await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  assert.equal(readFileSync(second, 'utf8'), 'helper v1')
})

test('a new helper version removes the old copy', async (t) => {
  const { runtimeDir, home } = fixture(t)
  await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  const next = 'b'.repeat(64)
  const dir = binDir(runtimeDir)
  mkdirSync(dirname(join(dir, next, EXECUTABLE)), { recursive: true })
  writeFileSync(join(dir, next, EXECUTABLE), 'helper v2')
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ bundle: next }))
  const helper = await prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify })
  assert.equal(readFileSync(helper, 'utf8'), 'helper v2')
  assert.deepEqual(readdirSync(home), [next])
})

test('a copy that fails its signature check is dropped and reports the error', async (t) => {
  const { runtimeDir, home } = fixture(t)
  const failure = new Error('invalid signature')
  await assert.rejects(prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify: () => { throw failure } }), failure)
  assert.deepEqual(readdirSync(home), [])
})

test('a receipt cannot point out of the helper folder', async (t) => {
  const { runtimeDir, home } = fixture(t)
  writeFileSync(join(binDir(runtimeDir), 'current.json'), JSON.stringify({ bundle: '../../elsewhere' }))
  await assert.rejects(prepareComputerHelper({ runtimeDir, home, arch: 'arm64', copy, verify }), /Invalid computer-use helper receipt/)
})

// The real signed helper, with the real ditto and codesign.
const packaged = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-experimental-cua-macos/native/bin', import.meta.url))
test('a real copy keeps DeepSeek\'s signature and drops quarantine', { skip: process.platform !== 'darwin' || !existsSync(join(packaged, `darwin-${process.arch}`, 'current.json')) }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-computer-helper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeDir = join(root, 'DS Bot.app', 'Contents', 'Resources')
  const dir = binDir(runtimeDir, process.arch)
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(join(packaged, `darwin-${process.arch}`), dir, { recursive: true, verbatimSymlinks: true })
  const { bundle } = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
  const application = join(dir, bundle, 'DSH Computer Use.app')
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Test;', application])
  const helper = await prepareComputerHelper({ runtimeDir, home: join(root, 'support'), arch: process.arch })
  const copied = join(root, 'support', bundle, 'DSH Computer Use.app')
  assert.equal(helper, join(root, 'support', bundle, EXECUTABLE))
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', copied])
  assert.doesNotMatch(execFileSync('/usr/bin/xattr', [copied], { encoding: 'utf8' }), /com\.apple\.quarantine/)

  // A cached copy whose executable still matches but whose bundle signature is broken is replaced.
  const plist = join(copied, 'Contents', 'Info.plist')
  writeFileSync(plist, `${readFileSync(plist, 'utf8')}\n<!-- tampered -->\n`)
  assert.throws(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', copied], { stdio: 'pipe' }))
  await prepareComputerHelper({ runtimeDir, home: join(root, 'support'), arch: process.arch })
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', copied])
})
