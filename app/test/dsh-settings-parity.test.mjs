import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as acorn from 'acorn'
import { transformSync } from 'esbuild'

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = resolve(APP_DIR, '..')
const DSH_SCOPE_DIR = join(APP_DIR, 'node_modules', '@deepseek-ai')
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'design', 'dsh-settings-parity.json')
const appRequire = createRequire(join(APP_DIR, 'package.json'))

// Packages containing documentation/catalog examples rather than real runtime UI slots.
const EXCLUDED_SLOT_PACKAGES = new Set(['dsh-cordis-client-runner'])

// Upstream DSH packages whose fields are currently non-volatile (so DSH omits them from
// settings.describe() and rejects settings.mutate()), kept under parity watch so any
// upstream change that marks them .volatile() triggers CI immediately.
const NON_VOLATILE_WATCH_PACKAGES = ['dsh-web-fetch-http']

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

function staticStringOf(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw
  }
  return null
}

function propertyKeyOf(prop) {
  if (!prop || prop.type !== 'Property' || prop.computed) return null
  if (prop.key.type === 'Identifier') return prop.key.name
  return staticStringOf(prop.key)
}

function isSlotsRegisterCallee(callee) {
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false
  if (callee.property?.type !== 'Identifier' || callee.property.name !== 'register') return false
  const obj = callee.object
  if (!obj) return false
  if (obj.type === 'Identifier' && obj.name === 'slots') return true
  if (obj.type === 'MemberExpression' && !obj.computed && obj.property?.type === 'Identifier' && obj.property.name === 'slots') {
    return true
  }
  return false
}

function loaderForFile(filePath) {
  const ext = extname(filePath || '').toLowerCase()
  if (ext === '.tsx') return 'tsx'
  if (ext === '.ts') return 'ts'
  if (ext === '.jsx') return 'jsx'
  return 'js'
}

/**
 * AST-based extractor for `slots.register({ ... })` calls.
 * Parses TypeScript/JSX (`src/`) and bundled JS (`lib/`) via esbuild + acorn so comments,
 * string/regex literals, template literals, and deeply nested/long option objects are handled exactly.
 */
export function extractSlotRegistrations(text, filePath = 'input.tsx') {
  if (!text.includes('slots') || !text.includes('register')) return []
  const loader = loaderForFile(filePath)
  const js = loader === 'js'
    ? text
    : transformSync(text, { loader, legalComments: 'none', jsx: 'preserve' }).code
  let ast
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    const transformed = transformSync(text, { loader, legalComments: 'none' }).code
    ast = acorn.parse(transformed, { ecmaVersion: 'latest', sourceType: 'module' })
  }
  const results = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && isSlotsRegisterCallee(node.callee)) {
      const arg0 = node.arguments?.[0]
      if (arg0?.type === 'ObjectExpression') {
        let name = null
        let id = null
        for (const prop of arg0.properties) {
          const key = propertyKeyOf(prop)
          if (key === 'name') name = staticStringOf(prop.value)
          else if (key === 'id') id = staticStringOf(prop.value)
        }
        if (name && (name.startsWith('settings.') || name.startsWith('plugins.item'))) {
          results.push({ name, id: id || '(no-id)' })
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
      } else if (value && typeof value.type === 'string') {
        visit(value)
      }
    }
  }
  visit(ast)
  return results
}

function discoverDshSettingsSlots({ prefer = 'auto' } = {}) {
  const discovered = new Set()
  if (!existsSync(DSH_SCOPE_DIR)) return discovered
  for (const pkg of readdirSync(DSH_SCOPE_DIR).sort()) {
    if (EXCLUDED_SLOT_PACKAGES.has(pkg)) continue
    const pkgDir = join(DSH_SCOPE_DIR, pkg)
    const srcDir = join(pkgDir, 'src')
    const libDir = join(pkgDir, 'lib')
    const root = prefer === 'src'
      ? srcDir
      : prefer === 'lib'
        ? libDir
        : (existsSync(srcDir) ? srcDir : libDir)
    walkSourceFiles(root, (file) => {
      const text = readFileSync(file, 'utf8')
      for (const reg of extractSlotRegistrations(text, file)) {
        discovered.add(`${reg.name}::${reg.id}::${pkg}`)
      }
    })
  }
  return discovered
}

function schemaHasVolatile(schema, depth = 0) {
  if (!schema || depth > 5) return false
  if (schema.meta?.volatile === true || schema.meta?.extra?.volatile === true) return true
  if (schema.dict) return Object.values(schema.dict).some(v => schemaHasVolatile(v, depth + 1))
  if (schema.list) return schema.list.some(v => schemaHasVolatile(v, depth + 1))
  if (schema.inner) return schemaHasVolatile(schema.inner, depth + 1)
  return false
}

async function importDshPackage(pkg) {
  const specifier = `@deepseek-ai/${pkg}`
  try {
    return await import(specifier)
  } catch {
    try {
      const resolved = appRequire.resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      return null
    }
  }
}

async function discoverDshSchemaPackages() {
  const volatilePackages = new Map()
  const watchPackages = new Map()
  if (!existsSync(DSH_SCOPE_DIR)) return { volatilePackages, watchPackages }

  for (const pkg of readdirSync(DSH_SCOPE_DIR).sort()) {
    const pkgJsonPath = join(DSH_SCOPE_DIR, pkg, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    if (!pkgJson.exports && !pkgJson.main && !pkgJson.module) continue

    const mod = await importDshPackage(pkg)
    if (!mod) continue
    const schema = mod.Config ?? mod.default?.Config
    if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) continue
    const dict = schema.dict ?? schema.list?.find?.(item => item?.dict)?.dict ?? null
    if (!dict || typeof dict !== 'object') continue
    const fields = Object.keys(dict)
    if (fields.length === 0) continue

    const volatileFields = new Set(fields.filter(f => schemaHasVolatile(dict[f])))
    if (schemaHasVolatile(schema) || volatileFields.size > 0) {
      volatilePackages.set(pkg, { fields, volatileFields })
    } else if (NON_VOLATILE_WATCH_PACKAGES.includes(pkg)) {
      watchPackages.set(pkg, { fields, volatileFields })
    }
  }
  return { volatilePackages, watchPackages }
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

test('slot parser handles built lib/ outputs, >600-char nested objects, template literals, and excludes catalog examples', () => {
  const fromSrc = discoverDshSettingsSlots({ prefer: 'src' })
  const fromLib = discoverDshSettingsSlots({ prefer: 'lib' })
  assert.ok(fromSrc.size >= 30, `Expected >= 30 settings slots in src/, found ${fromSrc.size}`)
  assert.deepEqual([...fromLib].sort(), [...fromSrc].sort(), 'lib/ slot discovery must match src/ slot discovery exactly')
  assert.equal([...fromLib].some(key => key.includes('dsh-cordis-client-runner') || key.includes('my-entry')), false,
    'doc/example slots from dsh-cordis-client-runner must never be discovered')

  const longPadding = 'x'.repeat(700)
  const synthetic = `
    // Leading comment with slots.register({ name: 'settings.section', id: 'commented-out' })
    ctx.slots.register({
      inject: () => ({
        nested: { a: { b: "${longPadding}" }, tpl: \`inner \${foo({ k: 1 })} text\` },
        cb: () => { return { name: 'settings.section', id: 'inner-should-not-match' } },
      }),
      /* block comment */
      name: \`settings.section\`,
      id: \`deep-entry\`,
    }, Component)
  `
  assert.deepEqual(extractSlotRegistrations(synthetic), [{ name: 'settings.section', id: 'deep-entry' }])
})

test('every DSH settings slot registration is covered by Desktop or explicitly excluded with rationale', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const discovered = discoverDshSettingsSlots()
  assert.ok(discovered.size >= 30, `Expected to discover DSH settings slots, found ${discovered.size}`)

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

test('every DSH volatile settings schema package, field, and parity capability is covered by Desktop or explicitly excluded', async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const { volatilePackages, watchPackages } = await discoverDshSchemaPackages()
  assert.ok(volatilePackages.size >= 20, `Expected dynamically discovered volatile DSH schema packages, found ${volatilePackages.size}`)

  const excludedPackages = manifest.excludedSchemaPackages ?? {}
  for (const [pkg, entry] of Object.entries(excludedPackages)) {
    assert.equal(volatilePackages.has(pkg), true, `Stale excludedSchemaPackages entry "${pkg}" is no longer a volatile DSH package`)
    assert.equal(entry?.status, 'excluded', `excludedSchemaPackages "${pkg}" must have status "excluded"`)
    assert.equal(typeof entry?.reason, 'string', `excludedSchemaPackages "${pkg}" must provide a reason`)
    assert.ok(entry.reason.trim().length >= 12, `excludedSchemaPackages "${pkg}" reason is too short`)
  }

  // Track every field of every non-excluded volatile package + watched non-volatile packages.
  const discoveredFields = new Set()
  for (const [pkg, info] of volatilePackages) {
    if (Object.prototype.hasOwnProperty.call(excludedPackages, pkg)) continue
    for (const field of info.fields) discoveredFields.add(`${pkg}::${field}`)
  }
  for (const [pkg, info] of watchPackages) {
    for (const field of info.fields) discoveredFields.add(`${pkg}::${field}`)
  }
  assert.ok(discoveredFields.size >= 45, `Expected to discover DSH schema fields, found ${discoveredFields.size}`)

  // Alert immediately if upstream DSH marks currently non-volatile watched gaps as volatile.
  assert.equal(volatilePackages.has('dsh-web-fetch-http'), false,
    'dsh-web-fetch-http now has .volatile() fields in DSH — implement Desktop UI and update docs/design/dsh-settings-parity.json')
  assert.equal(volatilePackages.get('dsh-session-log-deepseek')?.volatileFields.has('maxBytes'), false,
    'dsh-session-log-deepseek::maxBytes is now .volatile() in DSH — implement Desktop UI and update docs/design/dsh-settings-parity.json')

  const manifestKeys = new Set(Object.keys(manifest.schemaFields ?? {}))
  const missing = [...discoveredFields].filter(key => !manifestKeys.has(key)).sort()
  const stale = [...manifestKeys].filter(key => !discoveredFields.has(key)).sort()
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
