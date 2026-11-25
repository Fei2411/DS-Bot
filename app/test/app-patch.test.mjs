import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { APP_PATCH_NAME, APP_PATCH_ROWS, writeAppPatch } from '../src/app-patch.mjs'

describe('writeAppPatch', () => {
  let home
  before(() => { home = mkdtempSync(join(tmpdir(), 'ds-bot-app-patch-')) })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('returns no patch files and removes any stale DSH Web onboarding overlay', () => {
    const dir = join(home, 'profiles', 'ds-bot')
    mkdirSync(dir, { recursive: true })
    const stale = join(home, 'profiles', APP_PATCH_NAME)
    writeFileSync(stale, '- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n')
    assert.deepEqual(APP_PATCH_ROWS, [])
    assert.deepEqual(writeAppPatch({ dir, patchPath: join(dir, 'cordis.patch.yml') }), [])
    assert.equal(existsSync(stale), false)
    // Calling again when already absent stays a clean no-op.
    assert.deepEqual(writeAppPatch({ dir }), [])
  })
})
