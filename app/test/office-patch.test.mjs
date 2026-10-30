import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parse } from 'yaml'
import { OFFICE_PATCH_NAME, officeCli, officeRuntime, reconcileOfficeRuntime } from '../src/office-patch.mjs'

let home
let runtimeDir
// A stand-in payload: the manifest and the standalone Node are what the Host checks.
function makePayload() {
  const source = join(runtimeDir, 'primary-runtime')
  const node = join(source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  mkdirSync(dirname(node), { recursive: true })
  writeFileSync(node, '')
  writeFileSync(join(source, 'runtime.json'), '{}')
  mkdirSync(join(runtimeDir, 'office-skills', 'office'), { recursive: true })
  writeFileSync(join(runtimeDir, 'office-skills', 'office', 'SKILL.md'), '---\ndescription: office\n---\n')
}
// A stand-in profile under a throwaway DSH_HOME.
function profile() {
  const dir = join(home, 'profiles', 'ds-bot')
  mkdirSync(dir, { recursive: true })
  return { name: 'ds-bot', dir, patchPath: join(dir, 'cordis.patch.yml'), skippedBundles: [], layers: [], patches: [] }
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ds-bot-office-patch-'))
  runtimeDir = join(home, 'runtime')
})
after(() => { rmSync(home, { recursive: true, force: true }) })

describe('officeRuntime', () => {
  test('sees a complete payload and nothing else', () => {
    assert.equal(officeRuntime(runtimeDir), undefined)
    makePayload()
    const runtime = officeRuntime(runtimeDir)
    assert.equal(runtime.source, join(runtimeDir, 'primary-runtime'))
    assert.ok(existsSync(runtime.node))
    rmSync(join(runtime.source, 'runtime.json'))
    assert.equal(officeRuntime(runtimeDir), undefined)
  })
})

describe('officeCli', () => {
  test('runs the CLI from the unpacked tree, not through the asar', () => {
    const packed = join('program', 'resources', 'app.asar', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'package.json')
    assert.equal(officeCli(packed), join('program', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))
  })

  test('leaves an unpacked checkout alone', () => {
    const unpacked = join('checkout', 'app', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'package.json')
    assert.equal(officeCli(unpacked), join('checkout', 'app', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))
  })
})

describe('reconcileOfficeRuntime', () => {
  test('inserts the workspace tool and the Office skills against the payload', () => {
    makePayload()
    const { patchFiles, node } = reconcileOfficeRuntime(profile(), runtimeDir)
    assert.equal(node, join(runtimeDir, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
    assert.deepEqual(patchFiles, [join(home, 'profiles', OFFICE_PATCH_NAME)])
    const [row] = parse(readFileSync(patchFiles[0], 'utf8'))
    assert.equal(row.insert.length, 2)
    const [tool, skills] = row.insert
    assert.equal(tool.id, 'workspace-dependencies')
    assert.equal(tool.name, '@deepseek-ai/dsh-tool-workspace-dependencies')
    assert.equal(tool.config.source, join(runtimeDir, 'primary-runtime'))
    assert.equal(skills.id, 'skill-office')
    assert.equal(skills.name, '@deepseek-ai/dsh-skill-office')
    assert.equal(skills.config.assetRoot, join(runtimeDir, 'office-skills'))
    assert.equal(skills.config.node, node)
    assert.ok(skills.config.cli.endsWith(join('libreoffice-kit', 'lib', 'cli.js')))
  })

  test('writes no overlay and drops a stale one when the payload is gone', () => {
    makePayload()
    const p = profile()
    const [file] = reconcileOfficeRuntime(p, runtimeDir).patchFiles
    assert.ok(existsSync(file))
    rmSync(join(runtimeDir, 'primary-runtime', 'runtime.json'))
    assert.deepEqual(reconcileOfficeRuntime(p, runtimeDir), { patchFiles: [] })
    assert.equal(existsSync(file), false)
  })

  test('writes no overlay without a runtime directory', () => {
    assert.deepEqual(reconcileOfficeRuntime(profile(), undefined), { patchFiles: [] })
  })
})

// The first-run check reads chats without the team or the Office payload: the Host asks for
// the overlay only for the main profile.
test('the check profile boots without the Office overlay', () => {
  const source = readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8')
  assert.match(source, /check === undefined \? reconcileOfficeRuntime\(profile\) : \{ patchFiles: \[\] \}/u)
})
