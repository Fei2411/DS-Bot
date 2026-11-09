import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPayload } from '../src/client/bot-draft.js'
import { createReader, defaultPreset, normalizePresets, presetHint, presetRows, presetState, presetUpdate } from '../src/client/agent-preset.js'
import { DICTIONARY, hostText, installLocale, t } from '../src/client/i18n.js'

// The Agent preset of a Bot: the directory the profile serves, the choice a Bot
// keeps, and what the picker and the Bot's hint say about it.

const directory = [
  { id: 'standard', name: 'Standard', description: 'The standard harness' },
  { id: 'ptc', name: 'PTC', broken: 'failed to start' },
  { id: 'writer', name: 'Writer' },
]

test('the profile directory is the only source of presets', () => {
  assert.deepEqual(normalizePresets({ presets: directory }), [
    { id: 'standard', name: 'Standard', description: 'The standard harness', broken: undefined },
    { id: 'ptc', name: 'PTC', description: undefined, broken: 'failed to start' },
    { id: 'writer', name: 'Writer', description: undefined, broken: undefined },
  ])
  // A bare list is accepted too, and an entry without an id is not a preset.
  assert.deepEqual(normalizePresets([{ id: 'x' }]), [{ id: 'x', name: 'x', description: undefined, broken: undefined }])
  assert.deepEqual(normalizePresets({ presets: [{ name: 'No id' }, null, { id: '' }] }), [])
  assert.deepEqual(normalizePresets(null), [])
  assert.deepEqual(normalizePresets({ presets: 'no' }), [])
})

test('the picker offers the default first and every preset the profile serves', () => {
  const rows = presetRows(null, directory)
  assert.deepEqual(rows.map(row => row.id), [null, 'standard', 'ptc', 'writer'])
  assert.equal(rows[0].name, 'Default (Standard)')
  assert.equal(rows[0].disabled, false)
  // The directory names the presets; nothing else is offered.
  assert.deepEqual(rows.slice(1).map(row => row.name), ['Standard', 'PTC', 'Writer'])
})

test('a broken preset stays in the list, disabled, with its reason', () => {
  const rows = presetRows(null, directory)
  const ptc = rows.find(row => row.id === 'ptc')
  assert.equal(ptc.disabled, true)
  assert.equal(ptc.description, 'failed to start')
  assert.equal(ptc.broken, 'failed to start')
  // A broken preset with no reason still says that it cannot start.
  const rows2 = presetRows(null, [{ id: 'ptc', name: 'PTC', broken: true }])
  assert.equal(rows2[1].disabled, true)
  assert.equal(rows2[1].description, 'This preset cannot start.')
})

test('the default follows the directory: the standard preset, or the DSH default', () => {
  // The profile serves a usable standard: the default is that one.
  assert.deepEqual(defaultPreset([{ id: 'standard', name: 'Standard' }]), {
    name: 'Default (Standard)', description: 'The standard agent preset',
  })
  // Without it the host leaves the choice to DeepSeek Harness, and the name says so.
  assert.deepEqual(defaultPreset([{ id: 'ptc', name: 'PTC' }]), {
    name: 'Default (DSH default)', description: 'The default for new tasks in DeepSeek Harness.',
  })
  // A standard that cannot start is no standard.
  assert.equal(defaultPreset([{ id: 'standard', name: 'Standard', broken: 'failed to start' }]).name, 'Default (DSH default)')
  // A directory that has not loaded yet promises neither.
  assert.deepEqual(defaultPreset(null), { name: 'Default', description: undefined })
  assert.equal(presetState(undefined, null).name, 'Default')
  assert.equal(presetState(undefined, []).name, 'Default (DSH default)')
})

test('the default stays a choice, so a Bot can go back to the old behaviour', () => {
  const rows = presetRows('ptc', directory)
  const fallback = rows.find(row => row.id === null)
  assert.equal(fallback.disabled, false)
  assert.equal(fallback.name, 'Default (Standard)')
})

test('a saved preset the profile no longer serves is shown as missing, not replaced', () => {
  const state = presetState('gone', directory)
  assert.equal(state.missing, true)
  assert.equal(state.id, 'gone')
  const rows = presetRows('gone', directory)
  assert.deepEqual(rows.map(row => row.id), [null, 'standard', 'ptc', 'writer', 'gone'])
  const missing = rows.at(-1)
  assert.equal(missing.missing, true)
  assert.equal(missing.disabled, true)
  assert.equal(missing.name, 'Missing preset')
  // The saved id stays visible, so the user knows which preset is gone.
  assert.equal(missing.description, 'gone')
})

test('a directory that has not loaded yet is not called missing', () => {
  const state = presetState('gone', null)
  assert.equal(state.missing, false)
  assert.equal(state.pending, true)
  assert.equal(state.name, 'gone')
})

test('a Bot without a saved preset runs on the default', () => {
  assert.deepEqual(presetState(undefined, directory), { id: null, name: 'Default (Standard)', missing: false, broken: undefined, pending: false })
  assert.equal(presetState('', directory).id, null)
})

test('the Bot hint follows the directory it is given', () => {
  const served = [{ id: 'standard', name: 'Standard' }]
  assert.equal(presetHint({ agentPreset: 'ptc' }, served, ''), 'This preset is not in the profile anymore. Pick another one.')
  assert.equal(presetHint({ agentPreset: 'ptc' }, null, ''), 'Loading…')
  assert.equal(presetHint({ agentPreset: 'ptc' }, null, 'Could not reach DSH.'), 'The preset list could not be loaded.')
  assert.equal(presetHint({ agentPreset: 'ptc' }, [{ id: 'ptc', name: 'PTC', broken: 'failed to start' }], ''),
    'This preset cannot start (failed to start). Pick another one.')
  assert.equal(presetHint({}, served, ''), 'The standard agent preset')
  assert.equal(presetHint({}, [{ id: 'ptc', name: 'PTC' }], ''), 'The default for new tasks in DeepSeek Harness.')
  assert.equal(presetHint({ agentPreset: 'ptc' }, [{ id: 'ptc', name: 'PTC' }], ''), 'Applies from the next conversation segment.')
})

test('a create sends only the preset the user picked', () => {
  const look = { shape: 'star', color: 'blue' }
  assert.equal('agentPreset' in createPayload({ name: 'A', look }), false)
  assert.equal('agentPreset' in createPayload({ name: 'A', look, agentPreset: null }), false)
  assert.equal(createPayload({ name: 'A', look, agentPreset: 'ptc' }).agentPreset, 'ptc')
  const grouped = createPayload({ name: 'A', look, agentPreset: 'ptc', sectionId: 'research', ownLook: true })
  assert.equal(grouped.agentPreset, 'ptc')
  assert.equal(grouped.sectionId, 'research')
})

test('an update clears the choice with null and sends nothing when it did not change', () => {
  assert.equal(presetUpdate(null, undefined), undefined)
  assert.equal(presetUpdate(null, 'ptc'), null)
  assert.equal(presetUpdate('ptc', 'ptc'), undefined)
  assert.equal(presetUpdate('ptc', undefined), 'ptc')
  assert.equal(presetUpdate('', 'ptc'), null)
})

test('an older answer never overwrites a newer one', async () => {
  const pending = []
  const reader = createReader(() => new Promise(resolve => pending.push(resolve)))
  const first = reader()
  const second = reader()
  // The newer answer lands first, and it is the one that counts.
  pending[1]({ presets: [{ id: 'ptc', name: 'PTC' }] })
  assert.deepEqual(await second, { presets: [{ id: 'ptc', name: 'PTC', description: undefined, broken: undefined }], error: '' })
  // The older one lands afterwards and is dropped.
  pending[0]({ presets: [{ id: 'standard', name: 'Standard' }] })
  assert.equal(await first, undefined)
})

test('a reader that fails brings the failure, not an empty directory', async () => {
  const reader = createReader(async () => { throw new Error('Could not reach DSH.') })
  assert.deepEqual(await reader(), { presets: null, error: 'Could not reach DSH.' })
})

test('the copy for the Agent preset picker is translated', () => {
  for (const key of [
    'Agent preset',
    'Agent preset: {preset}',
    'Default',
    'Default (Standard)',
    'Default (DSH default)',
    'The standard agent preset',
    'The default for new tasks in DeepSeek Harness.',
    'Missing preset',
    'This preset cannot start.',
    'This preset cannot start ({reason}). Pick another one.',
    'This preset is not in the profile anymore. Pick another one.',
    'The preset list could not be loaded.',
    'Applies from the next conversation segment.',
    'The Bot runs on the default agent preset.',
    'The Bot runs on the {name} agent preset.',
  ]) assert.ok(Object.hasOwn(DICTIONARY.zh, key), key)
})

test('the host errors about a preset are translated where the interface shows them', () => {
  const dicts = new Map()
  const locale = {
    register: (ns, name, dict) => { dicts.set(`${ns}:${name}`, dict); return () => dicts.delete(`${ns}:${name}`) },
    bind: ns => (key, params) => {
      const text = dicts.get(`${ns}:zh`)?.[key] ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active: 'zh' }),
  }
  const off = installLocale(locale)
  try {
    assert.equal(t('Default (Standard)'), '默认（标准）')
    assert.equal(t('Default (DSH default)'), '默认（DSH 默认）')
    assert.equal(t('The preset list could not be loaded.'), '无法加载预设列表。')
    assert.equal(hostText('The agent preset "gone" is not available in this DeepSeek Harness. Pick another preset in the Bot\'s settings.'),
      '这个 Agent 预设「gone」在当前 DeepSeek Harness 中不可用。请在 Bot 设置里换一个预设。')
    assert.equal(hostText('The agent preset "ptc" cannot run: failed to start. Pick another preset in the Bot\'s settings.'),
      '这个 Agent 预设「ptc」无法运行：failed to start。请在 Bot 设置里换一个预设。')
  } finally {
    off()
  }
})
