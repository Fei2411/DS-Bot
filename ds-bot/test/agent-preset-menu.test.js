import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// The portal lands in the document, so the document has to exist for the menu. The
// bundle runs in its own realm, so the fixture goes into the sandbox as well.
const documentFixture = { body: { nodeName: 'BODY' } }

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/bot-settings.js'\nexport { AgentPresetMenu } from './src/client/agent-preset-menu.js'\nexport * from './src/client/agent-preset.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
// The menu opens only when its anchor is measured, which happens on the second
// state of the anchored menu. With `menusOpen` the fake state hands that place out,
// so the test draws the menu as it looks when it is open.
let menusOpen = false
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: (initial) => {
    const value = menusOpen && initial === null ? { left: 8, top: 40, width: 240 } : (typeof initial === 'function' ? initial() : initial)
    return [value, () => {}]
  },
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
// The portal keeps what it was given: the node it draws and the container it draws
// into, so the test can tell a menu that went to the document from one that did not.
const portals = []
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: documentFixture,
  require: name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node, container) => { portals.push({ node, container }); return node } }
    return {}
  },
})
const { AgentPresetMenu, BotSettingsForm, presetHint } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', agentPreset: 'ptc' }
const roster = { mainBotIds: [], mainBotId: null, rooms: [], models: [], memory: false }

// The Bot's settings, drawn with the directory the window has.
function settings(actions = {}) {
  return walk(BotSettingsForm({ bot, roster, actions, run: fn => fn }))
}
// The row that holds the Agent preset, found by its label.
function presetRow(tree) {
  return tree.find(node => String(node.props?.className ?? '').includes('bt-bs-row')
    && walk(node).some(child => child.props?.className === 'bt-bs-label' && child.props?.children?.[0] === 'Agent preset'))
}
const hint = tree => walk(presetRow(tree)).find(node => node.props?.className === 'bt-set-hint')?.props?.children?.[0]
// The picker itself, drawn on its own.
function menu(props = {}) {
  return walk(AgentPresetMenu({ value: 'ptc', onPick: () => {}, onRefresh: () => {}, ...props }))
}
const trigger = tree => tree.find(node => String(node.props?.className ?? '').includes('bt-preset-trigger'))
const triggerName = tree => walk(trigger(tree)).find(node => node.props?.className === 'bt-model-name')?.props?.children?.[0]

test('the trigger and the Bot hint read one directory', () => {
  assert.equal(triggerName(menu({ presets: [{ id: 'ptc', name: 'PTC' }] })), 'PTC')
  assert.equal(triggerName(menu({ presets: [{ id: 'standard', name: 'Standard' }] })), 'Missing preset')
  const fresh = [{ id: 'standard', name: 'Standard' }, { id: 'ptc', name: 'PTC' }]
  assert.equal(triggerName(menu({ presets: fresh })), 'PTC')
  assert.equal(presetHint(bot, fresh, ''), 'Applies from the next conversation segment.')
  assert.equal(presetHint(bot, [{ id: 'standard', name: 'Standard' }], ''), 'This preset is not in the profile anymore. Pick another one.')
})

test('the default follows the directory, and the hint says the same', () => {
  const plain = { ...bot, agentPreset: undefined }
  const plainSettings = () => walk(BotSettingsForm({ bot: plain, roster, actions: {}, run: fn => fn }))
  assert.equal(triggerName(menu({ value: undefined, presets: [{ id: 'standard', name: 'Standard' }] })), 'Default (Standard)')
  assert.equal(presetHint(plain, [{ id: 'standard', name: 'Standard' }], ''), 'The standard agent preset')
  assert.equal(triggerName(menu({ value: undefined, presets: [{ id: 'ptc', name: 'PTC' }] })), 'Default (DSH default)')
  assert.equal(presetHint(plain, [{ id: 'ptc', name: 'PTC' }], ''), 'The default for new tasks in DeepSeek Harness.')
  assert.equal(triggerName(menu({ value: undefined, presets: null })), 'Default')
  // The window has no directory yet, so the settings row says so.
  assert.equal(hint(plainSettings()), 'Loading…')
})

test('opening the picker asks for the directory again', () => {
  const asked = []
  trigger(menu({ onRefresh: () => asked.push('refresh') })).props.onClick()
  assert.deepEqual(asked, ['refresh'])
})

test('the Bot settings give the picker and the hint the same directory', () => {
  const tree = settings()
  const picker = tree.find(node => node.type === AgentPresetMenu)
  assert.ok(picker, 'the settings draw the picker')
  assert.equal(hint(tree), presetHint(bot, picker.props.presets, picker.props.error))
})

test('the menu opens into the document, with the failure and the retry inside it', () => {
  menusOpen = true
  try {
    portals.length = 0
    walk(AgentPresetMenu({ value: 'ptc', presets: [{ id: 'ptc', name: 'PTC' }], error: 'Could not reach DSH.', onPick: () => {}, onRefresh: () => {} }))
    assert.equal(portals.length, 1)
    const portal = portals[0]
    // The menu is drawn into the document, not into one of its own children.
    assert.equal(portal.container, documentFixture.body)
    assert.match(String(portal.node.props.className), /bt-preset-menu/)
    const children = portal.node.props.children ?? []
    const of = name => children.filter(child => child && String(child.props?.className ?? '').includes(name))
    assert.equal(of('bt-preset-error').length, 1)
    assert.equal(of('bt-model-foot').length, 1)
    assert.equal(of('bt-model-scroll').length, 1)

    // Without a failure the container is still the document.
    portals.length = 0
    walk(AgentPresetMenu({ value: 'ptc', presets: [{ id: 'ptc', name: 'PTC' }], onPick: () => {}, onRefresh: () => {} }))
    assert.equal(portals.length, 1)
    assert.equal(portals[0].container, documentFixture.body)
    assert.equal((portals[0].node.props.children ?? []).filter(child => child && String(child.props?.className ?? '').includes('bt-preset-error')).length, 0)
  } finally {
    menusOpen = false
  }
})
