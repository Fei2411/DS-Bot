import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const read = file => readFileSync(join(PLUGIN, file), 'utf8')
const staticImports = source => [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1])

// DSH leaves out the browser half of an entry that failed to import, and DS Bot's
// bundle patch turns DSH's own settings shell off: a host module that failed to load
// left no Settings and no way back to the classic view (#1237, #1314). The entry DSH
// loads imports no host module before `apply`.
test('the package entry is the thin plugin.js', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.exports['.'], './plugin.js')
  assert.equal(pkg.main, 'plugin.js')
  assert.ok(pkg.files.includes('plugin.js'))
  assert.deepEqual(staticImports(read('plugin.js')), ['./src/host/entry.js'])
  assert.deepEqual(staticImports(read('src/host/entry.js')), [])
})

test('plugin.js declares the host\'s name and services', async () => {
  const entry = await import('../plugin.js')
  const host = await import('../index.js')
  assert.equal(entry.name, 'ds-bot')
  assert.equal(entry.name, host.name)
  assert.deepEqual(entry.inject, host.inject)
})

// A real child process whose loader makes index.js throw on load, as a dependency
// resolved to another version did in #1237: plugin.js still imports, and the
// failure arrives through `apply`, where DSH records a failed activation.
test('a host module that fails to load fails apply, not the import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-entry-'))
  try {
    const target = pathToFileURL(join(PLUGIN, 'index.js')).href
    writeFileSync(join(dir, 'hooks.mjs'), `export async function load(url, context, next) {
  if (url === ${JSON.stringify(target)}) return { format: 'module', source: "throw new Error('host failed to load')", shortCircuit: true }
  return next(url, context)
}\n`)
    writeFileSync(join(dir, 'register.mjs'), "import { register } from 'node:module'\nregister('./hooks.mjs', import.meta.url)\n")
    const script = `const entry = await import(${JSON.stringify(pathToFileURL(join(PLUGIN, 'plugin.js')).href)})
console.log('imported', entry.name)
await entry.apply({}, {}).then(() => console.log('applied'), error => console.log('apply failed:', error.message))`
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'register.mjs')).href, '--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(run.stdout.trim().split('\n'), ['imported ds-bot', 'apply failed: host failed to load'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
