import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = resolve(APP_DIR, '..')
const DSH_SCOPE_DIR = join(APP_DIR, 'node_modules', '@deepseek-ai')
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'design', 'dsh-settings-parity.json')

const SCHEMA_PACKAGES = [
  'dsh-web',
  'dsh-web-deepseek-api',
  'dsh-web-search-deepseek',
  'dsh-web-fetch-http',
  'dsh-agent-default-model',
  'dsh-agent-loop',
  'dsh-bash-sandbox',
  'dsh-bash-local',
  'dsh-pwsh-sandbox',
  'dsh-pwsh-local',
  'dsh-session-log-deepseek',
]

function walkSourceFiles(dir, visit) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'test', 'tests', 'locales', 'assets'].includes(entry.name)) continue
      walkSourceFiles(full, visit)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      visit(full)
    }
  }
}

function discoverDshSettingsSlots() {
  const discovered = new Set()
  if (!existsSync(DSH_SCOPE_DIR)) return discovered
  for (const pkg of readdirSync(DSH_SCOPE_DIR).sort()) {
    const pkgDir = join(DSH_SCOPE_DIR, pkg)
    const srcDir = join(pkgDir, 'src')
    const root = existsSync(srcDir) ? srcDir : join(pkgDir, 'lib')
    walkSourceFiles(root, (file) => {
      const text = readFileSync(file, 'utf8')
      const re = /slots\.register\(\s*\{([\s\S]{0,600}?)\}/g
      let match
      while ((match = re.exec(text)) !== null) {
        const nameMatch = /\bname\s*:\s*['"]((?:settings\.|plugins\.item)[^'"]*)['"]/.exec(match[1])
        if (!nameMatch) continue
        const idMatch = /\bid\s*:\s*['"]([^'"]+)['"]/.exec(match[1])
        const id = idMatch ? idMatch[1] : '(no-id)'
        discovered.add(`${nameMatch[1]}::${id}::${pkg}`)
      }
    })
  }
  return discovered
}

async function discoverDshSchemaFields() {
  const discovered = new Set()
  for (const pkg of SCHEMA_PACKAGES) {
    const entry = join(DSH_SCOPE_DIR, pkg, 'lib', 'index.js')
    assert.equal(existsSync(entry), true, `Expected installed DSH schema package ${pkg} at ${entry}`)
    const mod = await import(pathToFileURL(entry).href)
    const schema = mod.Config ?? mod.default?.Config
    const dict = schema?.dict ?? schema?.list?.find?.(item => item?.dict)?.dict ?? null
    assert.ok(dict && typeof dict === 'object', `Expected Schemastery object dict in ${pkg}`)
    for (const field of Object.keys(dict)) {
      discovered.add(`${pkg}::${field}`)
    }
  }
  return discovered
}

function assertManifestEntryValid(kind, key, entry, fileCache) {
  assert.ok(entry && typeof entry === 'object', `${kind} "${key}" must map to an object`)
  assert.ok(['implemented', 'excluded'].includes(entry.status), `${kind} "${key}" has invalid status "${entry.status}"`)
  if (entry.status === 'excluded') {
    assert.equal(typeof entry.reason, 'string', `${kind} "${key}" is excluded and must provide a reason`)
    assert.ok(entry.reason.trim().length >= 12, `${kind} "${key}" exclusion reason is too short`)
    return
  }
  assert.ok(entry.anchor && typeof entry.anchor.file === 'string' && typeof entry.anchor.pattern === 'string',
    `${kind} "${key}" is implemented and must declare anchor.file and anchor.pattern`)
  const abs = join(REPO_ROOT, entry.anchor.file)
  assert.equal(existsSync(abs), true, `${kind} "${key}" anchor file does not exist: ${entry.anchor.file}`)
  let contents = fileCache.get(abs)
  if (contents === undefined) {
    contents = readFileSync(abs, 'utf8')
    fileCache.set(abs, contents)
  }
  assert.equal(
    contents.includes(entry.anchor.pattern),
    true,
    `${kind} "${key}" anchor pattern "${entry.anchor.pattern}" not found in ${entry.anchor.file}`,
  )
}

test('every DSH settings slot registration is covered by Desktop or explicitly excluded with rationale', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const discovered = discoverDshSettingsSlots()
  assert.ok(discovered.size >= 20, `Expected to discover DSH settings slots, found ${discovered.size}`)

  const manifestKeys = new Set(Object.keys(manifest.slots ?? {}))
  const missing = [...discovered].filter(key => !manifestKeys.has(key)).sort()
  const stale = [...manifestKeys].filter(key => !discovered.has(key)).sort()
  assert.deepEqual(missing, [], `Uncovered DSH settings slots missing from docs/design/dsh-settings-parity.json:\n${missing.join('\n')}`)
  assert.deepEqual(stale, [], `Stale DSH settings slots no longer present in installed DSH packages:\n${stale.join('\n')}`)

  const fileCache = new Map()
  for (const [key, entry] of Object.entries(manifest.slots)) {
    assertManifestEntryValid('slot', key, entry, fileCache)
  }
})

test('every DSH settings schema field and parity capability is covered by Desktop or explicitly excluded', async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const discovered = await discoverDshSchemaFields()
  assert.ok(discovered.size >= 40, `Expected to discover DSH schema fields, found ${discovered.size}`)

  const manifestKeys = new Set(Object.keys(manifest.schemaFields ?? {}))
  const missing = [...discovered].filter(key => !manifestKeys.has(key)).sort()
  const stale = [...manifestKeys].filter(key => !discovered.has(key)).sort()
  assert.deepEqual(missing, [], `Uncovered DSH schema fields missing from docs/design/dsh-settings-parity.json:\n${missing.join('\n')}`)
  assert.deepEqual(stale, [], `Stale DSH schema fields no longer present in installed DSH packages:\n${stale.join('\n')}`)

  const fileCache = new Map()
  for (const [key, entry] of Object.entries(manifest.schemaFields)) {
    assertManifestEntryValid('schemaField', key, entry, fileCache)
  }
  assert.ok(Object.keys(manifest.capabilities ?? {}).length >= 10, 'Expected parity capabilities in manifest')
  for (const [key, entry] of Object.entries(manifest.capabilities)) {
    assertManifestEntryValid('capability', key, entry, fileCache)
  }
})
