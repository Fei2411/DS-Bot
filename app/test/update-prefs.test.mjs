// Auto-update preference persistence under userData.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readAutoUpdate, writeAutoUpdate } from '../src/update-prefs.mjs'

describe('update-prefs', () => {
  test('defaults to true when missing or unreadable, and persists false/true atomically', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-prefs-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'nested', 'update-prefs.json')

    assert.equal(readAutoUpdate(file), true)

    writeAutoUpdate(file, false)
    assert.equal(readAutoUpdate(file), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { autoUpdate: false })

    writeAutoUpdate(file, true)
    assert.equal(readAutoUpdate(file), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { autoUpdate: true })

    writeFileSync(file, '{not json')
    assert.equal(readAutoUpdate(file), true)
  })
})
