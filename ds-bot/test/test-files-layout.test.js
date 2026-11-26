import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'

// npm test runs with --test-force-exit, which ends a test file's process once the tests
// declared so far are done. A top-level await after the first test is declared lets that
// happen before the tests below it are declared, and they never run, without a failure.
const TESTS = dirname(fileURLToPath(import.meta.url))
// acorn comes with the DSH packages (dsh-ptc-runtime-node), from the harness that
// test/harness-resolve.mjs found, as jsdom does for the client tests.
const { parse } = createRequire(join(process.env.DSH_HARNESS ?? join(dirname(TESTS), '..', 'deepseek-harness'), 'package.json'))('acorn')
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
  entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []
))

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const DECLARERS = new Set(['test', 'describe', 'suite', 'it'])

// Whether a top-level statement awaits, not counting the functions it only defines.
function awaits(node) {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(awaits)
  if (FUNCTIONS.has(node.type)) return false
  if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) return true
  return Object.entries(node).some(([key, value]) => key !== 'loc' && value !== null && typeof value === 'object' && awaits(value))
}

// test(...), test.skip(...), describe(...) and the like, as a statement of its own.
function declares(statement) {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return false
  const callee = statement.expression.callee
  const name = callee.type === 'MemberExpression' ? callee.object.name : callee.name
  return DECLARERS.has(name)
}

test('no test file awaits at the top level after its first test is declared', () => {
  const late = []
  for (const file of files(TESTS)) {
    const program = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true })
    const first = program.body.findIndex(declares)
    if (first === -1) continue
    for (const statement of program.body.slice(first + 1)) {
      if (awaits(statement)) late.push(`${file.slice(TESTS.length + 1)}:${statement.loc.start.line}`)
    }
  }
  assert.deepEqual(late, [])
})
