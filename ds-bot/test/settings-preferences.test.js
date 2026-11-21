import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import Schema from '@deepseek-ai/schemastery'
import { Config as ChatConfig } from '@deepseek-ai/dsh-client-ui-chat'
import { Config as ConversationConfig } from '@deepseek-ai/dsh-client-ui-conversation'
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const source = (await build({
  stdin: { contents: "export * from './src/client/settings-preferences.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})).outputFiles[0].text
const changes = []
const hookValues = []
let hookIndex = 0
const react = {
  Component: class {}, Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id',
  useState: (initial) => {
    const index = hookIndex++
    return [index in hookValues ? hookValues[index] : typeof initial === 'function' ? initial() : initial, next => changes.push(next)]
  },
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  createContext: value => ({ value }), useContext: context => context.value,
}
const module = { exports: {} }
runInNewContext(source, {
  module, exports: module.exports, setTimeout, clearTimeout, Promise,
  require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key }),
})
const { chatPreference, savePreference, PreferenceRow, PreferenceSelect, SettingsPreferences, settingsPreferences, permissionOptions, PREFERENCE_ITEMS } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const form = (value, extra = {}) => ({ getSnapshot: () => ({ status: 'ready', writable: true, value, ...extra }), subscribe: () => () => {}, set: async () => true })
const schema = { rehydrate: wire => new Schema(wire), nodeAtPath: (root, [field]) => root.dict?.[field] }
const describe = (configs) => {
  const snapshot = { status: 'ready', error: null, view: { writable: true, hasDocument: false, namespaces: Object.entries(configs).map(([ns, config]) => ({ ns, schema: config.toJSON() })) } }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}
const chatWithCollapse = Schema.object({
  ...ChatConfig.dict,
  collapseTiming: Schema.union(['completion', 'next-input']),
  foldedReplies: Schema.union(['all', 'final']),
})
const locale = {
  bind: namespace => key => `${namespace}:${key}`,
  getSnapshot: () => ({ active: 'zh-TW', locales: [{ id: 'zh', label: '中文' }, { id: 'zh-TW', label: '繁體中文' }] }),
}
const preferences = (chat = {}, conversation = {}, extra = {}) => ({
  locale, forms: { 'ui-chat': form(chat, extra), 'ui-conversation': form(conversation, extra), permission: form({}, extra) },
  schema, describe: describe({ 'ui-chat': chatWithCollapse, 'ui-conversation': ConversationConfig, permission: PermissionPresetService.Config }),
  browser: { subscribe: () => () => {}, getSnapshot: () => true },
})
const rows = (id, prefs) => {
  hookIndex = 0
  const entry = SettingsPreferences({ id, preferences: prefs })
  return entry.type(entry.props)
}

test('chat preferences retain DSH defaults and legacy work-details values', () => {
  assert.deepEqual(plain(chatPreference()), { transcriptView: 'detailed', collapseTiming: 'completion', foldedReplies: 'all', performanceUsage: 'detailed', linkOpening: 'sidebar' })
  assert.equal(chatPreference({}, true).transcriptView, 'standard')
  for (const transcriptView of ['normal', 'expanded']) assert.equal(chatPreference({ transcriptView }).transcriptView, 'detailed')
  assert.equal(chatPreference({ transcriptView: null }).transcriptView, 'detailed')
})

test('work detail rows use the public chat schema fields and dictionary keys', async () => {
  const prefs = preferences({ transcriptView: 'standard', collapseTiming: 'next-input', foldedReplies: 'final' })
  const writes = []
  prefs.forms['ui-chat'].set = async (...args) => { writes.push(args); return true }
  const result = rows('transcript-view', prefs)
  assert.deepEqual(plain(result.map(row => row.props.value)), ['standard', 'next-input', 'final'])
  assert.equal(result[0].props.title, 'chat:settings.transcript.title')
  assert.equal(result[1].props.options[1].label, 'chat:settings.collapse.nextInput')
  await result[1].props.save('completion')
  await result[2].props.save('all')
  assert.deepEqual(writes, [['collapseTiming', 'completion'], ['foldedReplies', 'all']])
  assert.equal(rows('transcript-view', preferences({ transcriptView: 'verbose' })).length, 2)
})

test('work detail capabilities follow the real harness Chat schema, including rc.2 without collapse fields', () => {
  const prefs = preferences({ transcriptView: 'standard', collapseTiming: 'next-input', foldedReplies: 'final' })
  prefs.describe = describe({ 'ui-chat': ChatConfig })
  const result = rows('transcript-view', prefs)
  const supported = ['transcriptView', 'collapseTiming', 'foldedReplies'].filter(field => field in ChatConfig.dict)
  assert.deepEqual(plain(result.map(row => row.props.key)), supported)
  assert.equal(result[0].props.value, 'standard')
  assert.equal(rows('performance-usage', prefs)[0].props.value, 'detailed')
  assert.equal(rows('link-opening', prefs)[0].props.value, 'sidebar')
  const defaults = rows('transcript-view', preferences())
  assert.deepEqual(plain(defaults.map(row => row.props.value)), ['detailed', 'completion', 'all'])
})

test('unknown, pending and missing schema fields never produce unsupported preference rows', () => {
  const prefs = preferences()
  prefs.describe = describe({ 'ui-chat': Schema.object({}), 'ui-conversation': Schema.object({}), permission: Schema.object({}) })
  for (const id of ['transcript-view', 'performance-usage', 'link-opening']) assert.deepEqual(plain(rows(id, prefs)), [])
  assert.equal(rows('composer-enter', prefs), null)
  assert.equal(rows('permission', prefs), null)
  prefs.describe = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading', view: undefined, error: null }) }
  assert.deepEqual(plain(rows('transcript-view', prefs)), [])
  prefs.describe = describe({})
  assert.deepEqual(plain(rows('transcript-view', prefs)), [])
})

test('the harness fields and dictionaries cover every preference offered on that DSH version', () => {
  const copy = name => readFileSync(new URL('lib/client.js', import.meta.resolve(`${name}/package.json`)), 'utf8')
  const check = (source, keys) => {
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      assert.match(source, new RegExp(`(?:["']${escaped}["']|\\b${escaped})\\s*:`), key)
    }
  }
  const prefs = preferences()
  prefs.describe = describe({ 'ui-chat': ChatConfig })
  const chatRows = ['transcript-view', 'performance-usage', 'link-opening'].flatMap(id => rows(id, prefs))
  check(copy('@deepseek-ai/dsh-client-ui-chat'), chatRows.flatMap(row => [row.props.title, row.props.description, ...row.props.options.map(option => option.label)]).map(key => key.replace(/^chat:/, '')))
  assert.ok(ConversationConfig.dict.busyEnter)
  assert.ok(PermissionPresetService.Config.dict.defaultPreset)
  check(copy('@deepseek-ai/dsh-client-ui-conversation'), ['title', 'description', 'queue', 'steer'].map(key => `settings.enter.${key}`))
  check(copy('@deepseek-ai/dsh-client-locale'), ['language.title'])
  check(copy('@deepseek-ai/dsh-client-ui-permission-presets'), ['title', 'description', 'preset.readOnly', 'preset.workspaceWrite', 'preset.fullAccess', 'unavailable', 'confirm.title', 'confirm.description', 'confirm.acknowledge', 'confirm.cancel', 'close', 'confirm.enable'])
})

test('busy send reads and writes ui-conversation.busyEnter without a DSH Menu', async () => {
  const prefs = preferences({}, { busyEnter: 'steer' })
  const writes = []
  prefs.forms['ui-conversation'].set = async (...args) => { writes.push(args); return true }
  const row = rows('composer-enter', prefs)
  assert.equal(row.props.value, 'steer')
  assert.deepEqual(plain(row.props.options), [
    { id: 'queue', label: 'conversation:settings.enter.queue' }, { id: 'steer', label: 'conversation:settings.enter.steer' },
  ])
  await row.props.save('queue')
  assert.deepEqual(writes, [['busyEnter', 'queue']])
  const rendered = row.type(row.props)
  assert.equal(rendered.props.children[1].props.children[0].type, PreferenceSelect)
})

test('unavailable namespaces disappear and loading/read-only namespaces cannot write', async () => {
  assert.equal(rows('composer-enter', preferences({}, {}, { status: 'unavailable' })), null)
  for (const extra of [{ status: 'loading' }, { writable: false }]) {
    const prefs = preferences({}, {}, extra)
    assert.equal(rows('composer-enter', prefs).props.disabled, true)
    await assert.rejects(savePreference(prefs.forms['ui-conversation'], 'busyEnter', 'steer'))
  }
  const prefs = preferences()
  prefs.browser.getSnapshot = () => false
  assert.equal(rows('link-opening', prefs), null)
  const empty = PreferenceSelect({ label: 'Empty', value: '', options: [], pick() {} })
  assert.equal(empty.props.children[0].props.disabled, true)
})

test('refused and failed writes surface a retryable error; unchanged choices do not write', async () => {
  await assert.rejects(savePreference({ ...form({}), set: async () => false }, 'busyEnter', 'steer'))
  const failure = new Error('transport failed')
  await assert.rejects(savePreference({ ...form({}), set: async () => { throw failure } }, 'busyEnter', 'steer'), error => error === failure)
  const tree = PreferenceRow({ title: 'Busy', value: 'queue', options: [], save: async () => { throw failure } })
  const select = tree.props.children[1].props.children[0]
  changes.length = 0
  select.props.pick('queue')
  assert.deepEqual(changes, [])
  select.props.pick('steer')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(changes, [true, false, true, false])
})

test('language choices come from the public locale catalog, retaining Simplified and Traditional ids', () => {
  const selected = []
  const prefs = { locale: { ...locale, setLocale: id => selected.push(id) } }
  const row = rows('language', prefs)
  assert.equal(row.props.value, 'zh-TW')
  assert.deepEqual(plain(row.props.options), [{ id: 'zh', label: '中文' }, { id: 'zh-TW', label: '繁體中文' }])
  row.props.save('zh')
  assert.deepEqual(selected, ['zh'])
})

test('explicitly choosing the detected language already on screen still persists it', async () => {
  const selected = []
  const prefs = { locale: { ...locale, setLocale: async id => { selected.push(id) } } }
  const row = rows('language', prefs)
  const tree = row.type(row.props)
  const select = tree.props.children[1].props.children[0]
  assert.equal(select.props.value, 'zh-TW')
  select.props.pick('zh-TW')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(selected, ['zh-TW'])
})

test('permission options use the catalog defaults only, localize builtins, and retain custom names', () => {
  assert.deepEqual(plain(permissionOptions(null, key => key)), [])
  assert.deepEqual(plain(permissionOptions({ defaultOptions: [
    { value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'My policy' }, { value: 'review', name: 'team-review' },
  ] }, key => `translated:${key}`)), [
    { id: 'read-only', label: 'translated:preset.readOnly' }, { id: 'workspace-write', label: 'My policy' }, { id: 'review', label: 'Team Review' },
  ])
})

test('Full access requires acknowledgement and confirmation before writing the default', async () => {
  const prefs = preferences()
  const writes = []
  prefs.forms.permission.set = async (...args) => { writes.push(args); return true }
  changes.length = 0
  let result = rows('permission', prefs)
  const pending = result.props.children[0].props.save('danger-full-access')
  assert.deepEqual(writes, [])
  const confirmation = changes.find(value => value && typeof value === 'object' && value.value === 'danger-full-access')
  assert.ok(confirmation)
  hookValues[3] = confirmation
  result = rows('permission', prefs)
  const risk = result.props.children[2]
  assert.equal(risk.props.open, true)
  risk.props.onConfirm()
  assert.deepEqual(writes, [])
  hookValues[4] = true
  result = rows('permission', prefs)
  result.props.children[2].props.onConfirm()
  await pending
  assert.deepEqual(writes, [['defaultPreset', 'danger-full-access']])
  hookValues.length = 0
})

test('the shell adapter uses public configForms, locale and dotted Remote services, leaving unknown plugin rows alone', async () => {
  assert.equal(settingsPreferences({ get: () => undefined }), undefined)
  const namespaces = []
  const catalog = { defaultPreset: 'workspace-write', defaultOptions: [] }
  const descriptors = describe({ 'ui-chat': ChatConfig })
  const services = { locale, settingsSchema: schema, configForms: { get: id => { namespaces.push(id); return form({}) }, describe: () => descriptors }, 'remote.permissionPresets': { catalog: async () => ({ ok: true, value: catalog }) } }
  const prefs = settingsPreferences({ get: name => services[name] })
  assert.deepEqual(namespaces, ['ui-chat', 'ui-conversation', 'permission'])
  assert.equal(prefs.locale, locale)
  assert.equal(prefs.describe, descriptors)
  assert.equal(prefs.schema, schema)
  assert.equal((await prefs.permissionCatalog()).value, catalog)
  assert.equal(PREFERENCE_ITEMS.has('composer-enter'), true)
  assert.equal(PREFERENCE_ITEMS.has('another-plugin'), false)
  assert.equal(settingsPreferences({ get: name => name === 'settingsSchema' ? undefined : services[name] }), undefined)
})

test('a stored value outside the options shows itself, and only an empty list shows Loading', () => {
  const label = element => element.props.children[0].props.children[0]
  assert.equal(label(PreferenceSelect({ label: 'Mode', value: 'custom', options: [{ id: 'a', label: 'A' }], pick() {} })), 'custom')
  assert.equal(label(PreferenceSelect({ label: 'Mode', value: 'a', options: [{ id: 'a', label: 'A' }], pick() {} })), 'A')
  assert.equal(label(PreferenceSelect({ label: 'Mode', value: 'custom', options: [], pick() {} })), 'Loading…')
})

test('a host without Remote or the permission presets service does not throw', async () => {
  const services = { locale, settingsSchema: schema, configForms: { get: () => form({}), describe: () => describe({ 'ui-chat': ChatConfig }) } }
  const prefs = settingsPreferences({ get: name => services[name], on: () => () => {} })
  assert.deepEqual(plain(await prefs.permissionCatalog()), { ok: false })
  const stop = prefs.subscribePermission(() => {})
  assert.doesNotThrow(() => stop())
  const listeners = []
  const wired = settingsPreferences({
    get: name => name === 'remote' ? { $on: event => { listeners.push(event); return () => listeners.push(`off ${event}`) } } : services[name],
    on: (event) => { listeners.push(event); return () => listeners.push(`off ${event}`) },
  })
  wired.subscribePermission(() => {})()
  assert.deepEqual(listeners, ['permission-presets/catalog-changed', 'connection/reset', 'off permission-presets/catalog-changed', 'off connection/reset'])
})

test('the preference schema is rehydrated through useMemo keyed on the described schema', () => {
  const source = readFileSync(new URL('../src/client/settings-preferences.js', import.meta.url), 'utf8')
  assert.match(source, /useMemo\(\(\) => wire === undefined \? undefined : preferences\.schema\.rehydrate\(wire\), \[preferences\.schema, wire\]\)/)
  assert.doesNotMatch(source, /return entry \? preferences\.schema\.rehydrate/)
})
