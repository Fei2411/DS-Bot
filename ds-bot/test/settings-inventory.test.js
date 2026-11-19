import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const source = (await build({
  stdin: { contents: "export * from './src/client/settings-inventory.js'; export { loadInventory } from './src/client/settings-preferences.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})).outputFiles[0].text
let values = [], index = 0, effects = []
const react = {
  Component: class {}, Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => { const slot = index++; if (!(slot in values)) values[slot] = initial; return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value }] },
  useEffect: effect => effects.push(effect), useLayoutEffect() {}, useId: () => 'id', useRef: current => ({ current }),
  useSyncExternalStore: (_, snapshot) => snapshot(), useMemo: fn => fn(), useCallback: fn => fn,
}
const module = { exports: {} }
runInNewContext(source, { module, exports: module.exports, console, setTimeout, clearTimeout, require: name => name === 'react' ? react : {} })
const api = module.exports
const draw = (component, props) => { index = 0; effects = []; return component(props) }
const fresh = () => { values = [] }
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const locale = { bind: namespace => (key, params) => `${namespace}:${key}${params ? JSON.stringify(params) : ''}`, resolveText: value => value.en }
// PluginInventorySnapshot / AgentPresetPluginGroup / PluginInventoryEntry, from
// @deepseek-ai/dsh-host-plugin-inventory/src/types.ts (published rc.5).
const row = (moduleName, enabled = true, fiberPhase = 'active') => ({ moduleName, enabled, fiberPhase, entryId: `include:${moduleName}` })
const snapshot = {
  entries: [row('global'), row('failed', false, 'failed'), row('shared', false, null)],
  agentPresets: [
    { id: 'standard', isDefault: true, rows: [row('shared'), row('searchable', 'conditional', null)] },
    { id: 'custom', name: 'My preset', isDefault: false, rows: [row('searchable', false, null)] },
  ],
}

test('inventory defaults to the engine default preset, falls back after removal, and sorts failures first', () => {
  assert.equal(api.inventoryView(snapshot, null, '', locale).selected.id, 'standard')
  assert.equal(api.inventoryView(snapshot, 'removed', '', locale).selected.id, 'standard')
  assert.equal(api.inventoryView(snapshot, 'custom', '', locale).selected.id, 'custom')
  assert.equal(api.inventoryView(snapshot, null, '', locale).entries[0].moduleName, 'failed')
  const empty = api.inventoryView({ entries: [] }, null, '', locale)
  assert.equal(empty.selected, undefined)
  assert.equal(empty.entries.length, 0)
})

test('inventory search matches metadata and identities across presets without changing the engine default', () => {
  const result = api.inventoryView(snapshot, null, ' SEARCHABLE ', locale)
  assert.equal(result.rows.length, 1)
  assert.equal(result.others[0].id, 'custom')
  assert.equal(result.otherCount, 1)
  assert.equal(result.entries.length, 0)
  assert.equal(api.inventoryView(snapshot, null, 'absent', locale).rows.length, 0)
  assert.equal(snapshot.agentPresets[0].isDefault, true)
  assert.equal(api.inventoryText({ moduleName: '@example/fallback', meta: { title: { en: 'Title' }, description: { en: 'Details' } } }, locale).title, 'Title')
  assert.equal(api.inventoryPresetName({ id: 'standard' }, locale), 'settings.agentPreset:presetStandardName')
  assert.equal(api.inventoryPresetName(snapshot.agentPresets[1], locale), 'My preset')
  assert.equal(api.inventoryPresetName({ id: 'unknown' }, locale), 'unknown')
})

test('the preset switcher only changes the local view and keeps public translated labels', () => {
  fresh()
  let chosen
  const tree = draw(api.InventoryContent, { snapshot, query: '', chosen: null, setChosen: id => { chosen = id }, setQuery() {}, locale })
  const [select] = walk(tree, node => node.type?.name === 'PreferenceSelect')
  assert.equal(select.props.value, 'standard')
  assert.match(select.props.options[0].label, /presetOptionDefault/)
  select.props.pick('custom')
  assert.equal(chosen, 'custom')
  const [card] = walk(tree, node => node.type?.name === 'InventoryCard')
  assert.equal(card.props.row.moduleName, 'shared')
})

test('public inventory reads preserve errors and refused results', async () => {
  assert.equal(await api.loadInventory({ list: async () => ({ ok: true, value: snapshot }) }), snapshot)
  await assert.rejects(api.loadInventory({ list: async () => ({ ok: false, error: 'unavailable' }) }), /refused/)
  await assert.rejects(api.loadInventory({ list: async () => { throw new Error('offline') } }), /offline/)
})

test('the inventory exposes loading, error/retry, successful reads and client synchronization failures', async () => {
  fresh()
  let retry = 0
  const inventory = {
    load: async () => { throw new Error('offline') },
    client: { subscribe: () => () => {}, getSnapshot: () => ({ syncing: false, failures: [{ id: 'failed', message: 'offline' }] }) },
    retryClient: () => { retry++ },
  }
  const props = { preferences: { inventory, locale } }
  let tree = draw(api.SettingsInventory, props)
  assert.equal(tree.props['aria-busy'], true)
  effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  tree = draw(api.SettingsInventory, props)
  assert.equal(tree.props['aria-busy'], false)
  assert.ok(walk(tree, node => node.props?.role === 'alert').length >= 2)
  const buttons = walk(tree, node => node.type === 'button')
  buttons[0].props.onClick()
  assert.equal(retry, 1)
  buttons[1].props.onClick()
  inventory.load = async () => snapshot
  draw(api.SettingsInventory, props)
  effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  tree = draw(api.SettingsInventory, props)
  assert.equal(walk(tree, node => node.type?.name === 'InventoryContent')[0].props.snapshot, snapshot)
})

test('owned Plugins composition keeps feature tabs public and mounted after visiting; empty ledgers stay safe', () => {
  fresh()
  const rendered = []
  const props = { tabs: [{ id: 'all', label: 'Inventory' }, { id: 'feature', label: 'Feature' }], preferences: { inventory: {} }, renderSlot: (...args) => { rendered.push(args); return null } }
  let tree = draw(api.PluginsSettings, props)
  assert.equal(walk(tree, node => node.type?.name === 'SettingsInventory').length, 1)
  effects[0]()
  walk(tree, node => node.props?.role === 'tab')[1].props.onClick()
  tree = draw(api.PluginsSettings, props)
  assert.equal(rendered[0][0], 'settings.plugins.tab')
  assert.equal(rendered[0][2].only, 'feature')
  assert.equal(walk(tree, node => node.type?.name === 'SettingsInventory').length, 1)
  fresh()
  assert.doesNotThrow(() => draw(api.PluginsSettings, { ...props, tabs: [] }))
})
