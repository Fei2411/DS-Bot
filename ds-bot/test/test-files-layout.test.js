import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// npm test runs with --test-force-exit, which ends a test file's process once the tests
// declared so far are done. A top-level await after the first test() lets that happen
// before the tests below it are declared, and they never run, without a failure.
const TESTS = dirname(fileURLToPath(import.meta.url))
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
  entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []
))

test('no test file awaits at the top level after its first test is declared', () => {
  const late = []
  for (const file of files(TESTS)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    const first = lines.findIndex(line => /^test\(/.test(line))
    if (first === -1) continue
    // A line inside a template literal (a script a test runs) is not this file's code.
    let quoted = false
    lines.forEach((line, index) => {
      if (!quoted && index > first && /^(?:(?:const|let|var)\s[^=]+=\s*)?await\s/.test(line)) late.push(`${file.slice(TESTS.length + 1)}:${index + 1}`)
      if ((line.match(/(?<!\\)`/g) ?? []).length % 2 === 1) quoted = !quoted
    })
  }
  assert.deepEqual(late, [])
})
