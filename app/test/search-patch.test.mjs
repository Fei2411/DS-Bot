import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { load } from 'js-yaml'
import { reconcileSearchSelector, SEARCH_PATCH_NAME, searchSelectorPatch } from '../src/search-patch.mjs'

const DSH_WEB = '@deepseek-ai/dsh-web'

// A stand-in profile: dsh-base supplies the web row, ds-bot adds the auto
// provider and points the selector at it, and `user` rows model the profile's
// own cordis.patch.yml.
function profile(user = [], { auto = true, baseConfig = { searchProvider: 'deepseek-official', fetchProvider: 'http' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-search-patch-'))
  return {
    name: 'ds-bot', dir, patchPath: join(dir, 'cordis.patch.yml'), skippedBundles: [],
    layers: [
      { packageName: '@deepseek-ai/dsh-base', packageDir: '', patchPaths: [], patches: [{ insert: [{ id: 'web', name: DSH_WEB, ...(baseConfig === null ? {} : { config: baseConfig }) }] }] },
      { packageName: 'ds-bot', packageDir: '', patchPaths: [], patches: [
        ...(auto ? [{ insert: [{ id: 'web-search-auto', name: 'ds-bot/web-search' }] }] : []),
        { id: 'web', config: { searchProvider: 'auto', fetchProvider: 'http' } },
      ] },
    ],
    patches: user,
  }
}
const disabledAuto = { id: 'web-search-auto', name: 'ds-bot/web-search', disabled: true }

describe('searchSelectorPatch', () => {
  const made = []
  const track = (...args) => { const p = profile(...args); made.push(p.dir); return p }
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

  test('restores the app bundles\' web selection when auto is disabled and still selected', () => {
    assert.deepEqual(searchSelectorPatch(track([disabledAuto])), [
      { id: 'web', name: DSH_WEB, config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    ])
  })

  test('restores a base web row that omits searchProvider (DSH 0.2.2-rc.5 route-based auto-select)', () => {
    const p = track([disabledAuto], { baseConfig: { fetchProvider: 'http' } })
    const overlay = searchSelectorPatch(p)
    assert.deepEqual(overlay, [{ id: 'web', name: DSH_WEB, config: { fetchProvider: 'http' } }])
    const composed = composeEntries([...p.layers.map(layer => layer.patches), p.patches, overlay]).find(entry => entry.id === 'web')
    assert.deepEqual(composed.config, { fetchProvider: 'http' })
  })

  test('reconciles against the real shipped @deepseek-ai/dsh-base and ds-bot patches', () => {
    const readPatch = pkg => load(readFileSync(fileURLToPath(new URL('cordis.patch.yml', import.meta.resolve(`${pkg}/package.json`))), 'utf8'), { schema: entryListSchema })
    const dir = mkdtempSync(join(tmpdir(), 'ds-bot-search-real-'))
    made.push(dir)
    const p = {
      name: 'ds-bot', dir, patchPath: join(dir, 'cordis.patch.yml'), skippedBundles: [],
      layers: [
        { packageName: '@deepseek-ai/dsh-base', packageDir: '', patchPaths: [], patches: readPatch('@deepseek-ai/dsh-base') },
        { packageName: 'ds-bot', packageDir: '', patchPaths: [], patches: readPatch('ds-bot') },
      ],
      patches: [disabledAuto],
    }
    const overlay = searchSelectorPatch(p)
    assert.ok(overlay !== undefined)
    const composed = composeEntries([...p.layers.map(layer => layer.patches), p.patches, overlay]).find(entry => entry.id === 'web')
    assert.notEqual(composed.config?.searchProvider, 'auto')
    assert.equal(composed.config?.fetchProvider, 'http')
  })

  test('clears searchProvider when the base web row has no config object', () => {
    assert.deepEqual(searchSelectorPatch(track([disabledAuto], { baseConfig: null })), [
      { id: 'web', name: DSH_WEB, config: {} },
    ])
  })

  test('does nothing when base bundles select auto or provide no web row', () => {
    assert.equal(searchSelectorPatch(track([disabledAuto], { baseConfig: { searchProvider: 'auto', fetchProvider: 'http' } })), undefined)
    const p = track([disabledAuto])
    p.layers = p.layers.filter(layer => layer.packageName !== '@deepseek-ai/dsh-base')
    assert.equal(searchSelectorPatch(p), undefined)
  })

  test('does nothing while the auto provider is enabled', () => {
    assert.equal(searchSelectorPatch(track()), undefined)
  })

  test('does nothing when the profile already names another provider', () => {
    assert.equal(searchSelectorPatch(track([disabledAuto, { id: 'web', config: { searchProvider: 'custom-one', fetchProvider: 'http' } }])), undefined)
  })
})

describe('reconcileSearchSelector', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-bot-search-reconcile-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  test('writes the overlay where DSH only reads it through patchFiles, and drops it when satisfied', () => {
    const p = profile([disabledAuto])
    try {
      const [file] = reconcileSearchSelector(p)
      // Outside the profile directory itself, so DSH only reads it through patchFiles.
      assert.equal(file, join(p.dir, '..', SEARCH_PATCH_NAME))
      assert.notEqual(file, p.patchPath)
    } finally {
      rmSync(p.dir, { recursive: true, force: true })
    }
  })

  test('removes a stale overlay when the auto provider is on again', () => {
    const p = profile([disabledAuto])
    try {
      const [file] = reconcileSearchSelector(p)
      assert.ok(existsSync(file))
      assert.match(readFileSync(file, 'utf8'), /searchProvider: deepseek-official/)
      // The user re-enables web-search-auto: no profile patch rows, nothing to do.
      p.patches = []
      assert.deepEqual(reconcileSearchSelector(p), [])
      assert.equal(existsSync(file), false)
    } finally {
      rmSync(p.dir, { recursive: true, force: true })
    }
  })
})
