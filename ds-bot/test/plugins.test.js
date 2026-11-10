import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The engine's plugin manager behind Settings → Plugins: entries from the running
// profile, the official catalog, and the switches that go through the manager.

function manager() {
  const calls = []
  const state = {
    bundles: [
      { name: 'ds-bot', official: false, enabled: true, installed: true, availability: 'profile' },
      { name: 'official-one', official: true, enabled: true, installed: true, version: '1.0.0', meta: { title: 'One' }, availability: 'profile' },
      { name: 'official-optional', official: true, enabled: false, installed: false, listedByDefault: true, meta: { title: { en: 'Optional', zh: '可选插件' } }, availability: 'installation' },
      { name: 'official-missing', official: true, enabled: false, installed: false, listedByDefault: true, installTarget: { spec: 'official-missing@2.0.0', version: '2.0.0' }, availability: 'missing' },
      { name: 'official-hidden', official: true, enabled: false, installed: false, listedByDefault: false, availability: 'missing' },
      { name: 'third-party', official: false, enabled: false, installed: false, availability: 'profile' },
    ],
  }
  return {
    calls,
    listBundles() { return state.bundles },
    async setBundleEnabled(name, enabled) { calls.push(['bundle', name, enabled]) },
    async installBundle(spec) { calls.push(['install', spec]) },
  }
}

function start(pluginManager) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-plugins-'))
  const ctx = fakeContext({ services: pluginManager === undefined ? {} : { pluginManager } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, rt }
}

test('the plugins page lists the profile packages and the official catalog', async (t) => {
  const fake = manager()
  const { call, stop } = start(fake)
  t.after(stop)
  const answer = await call('plugins')
  assert.equal(answer.ok, true)
  const view = answer.value
  assert.equal(view.available, true)
  // A shipped-off bundle is switchable without installing; a missing catalog entry
  // needs the install first; a hidden or unselected non-official entry stays out.
  assert.deepEqual(view.bundles.map(bundle => [bundle.name, bundle.enabled, bundle.installed, bundle.selectable, bundle.installable]), [
    ['ds-bot', true, true, false, false],
    ['official-one', true, true, true, false],
    ['official-optional', false, false, true, false],
    ['official-missing', false, false, false, true],
  ])
  // DS Bot's own bundle is listed but never switched off from its own page.
  assert.equal(view.bundles[0].readOnlyReason, 'management-required')
})

test('the page follows the interface language for a localized plugin name', async (t) => {
  const fake = manager()
  const { call, stop, rt } = start(fake)
  t.after(stop)
  rt.uiLanguage = () => 'Chinese (简体中文)'
  const view = (await call('plugins')).value
  assert.equal(view.bundles.find(bundle => bundle.name === 'official-optional').title, '可选插件')
})

test('a switch goes through the plugin manager and reads the list again', async (t) => {
  const fake = manager()
  const { call, stop } = start(fake)
  t.after(stop)
  const bundle = (await call('plugin-bundle', { name: 'official-one', enabled: false })).value
  assert.deepEqual(fake.calls.at(-1), ['bundle', 'official-one', false])
  assert.equal(bundle.available, true)
})

test('an install from the catalog uses the offered spec', async (t) => {
  const fake = manager()
  const { call, stop } = start(fake)
  t.after(stop)
  await call('plugin-install', { name: 'official-missing' })
  assert.deepEqual(fake.calls.at(-1), ['install', 'official-missing@2.0.0'])
  const unknown = await call('plugin-install', { name: 'nope' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error.message, /No plugin named nope/)
})

test('a host without a plugin manager says so instead of showing an empty list', async (t) => {
  const { call, stop } = start(undefined)
  t.after(stop)
  const view = (await call('plugins')).value
  assert.deepEqual([view.available, view.bundles], [false, []])
  const refused = await call('plugin-bundle', { name: 'official-one', enabled: true })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /no plugin manager/)
})
