import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: "export * from './src/client/model-menu.js'\nexport { stepMenuFocus } from './src/client/motion.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const sandbox = {
  document: { activeElement: null },
  module, exports: module.exports,
  require: name => {
    const platform = {
      react: { Fragment: 'fragment', createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}],
        useEffect: () => {},
        useRef: initial => ({ current: initial }),
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
}
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { groupModels, ModelChoiceDock, ModelKeyCard, effortRows, effortStops, EffortBar, stepMenuFocus, ModelRows, ModelGroupList, groupOpen, toggledGroup, manualFor } = module.exports

function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))]
}

// `harness`: the window has Settings and DSH's onboarding editors to send the user to.
function dock(models, { model, ready = true, harness = true } = {}) {
  const picked = []
  const bot = { id: 'chief', name: 'Chief', model }
  const roster = { ready, byId: { chief: bot }, models, defaultModel: models[0]?.ref }
  const tree = ModelChoiceDock({
    sessionId: bot.id, useRoster: select => select(roster),
    actions: {
      updateBot: (id, patch) => { picked.push([id, patch.model]); return Promise.resolve() },
      ...(harness ? { openSettings: () => {}, openHarnessOnboarding: () => {} } : {}),
    },
  })
  return { tree, picked }
}

const models = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
]

test('the first model choice shows provider groups and keeps each model route', () => {
  const { tree, picked } = dock(models)
  const groups = nodes(tree, node => node.props.className === 'bt-model-choice-group')
  assert.deepEqual(groups.map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.deepEqual(groups.map(group => nodes(group, node => node.props.className === 'bt-model-choice-provider')[0].children[0]), ['DeepSeek', 'Ollama'])
  const buttons = groups.map(group => nodes(group, node => node.type === 'button'))
  assert.deepEqual(buttons.map(list => list.map(button => button.children[0])), [['DeepSeek Flash', 'DeepSeek Pro'], ['DeepSeek Flash']])
  assert.match(buttons[0][0].props.title, /official\/flash.*Harness default/)
  buttons[1][0].props.onClick()
  buttons[0][0].props.onClick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'official/flash']])
  assert.equal(nodes(tree, node => node.type === 'button' && node.children.includes('Manage models')).length, 1)
})

test('providers with the same display name stay distinct, and unnamed providers use their id', () => {
  const entries = [
    { ...models[0], providerName: 'Cloud' },
    { ...models[1], providerName: 'Cloud' },
    { ref: 'custom/flash', provider: 'custom', name: 'Flash' },
  ]
  const groups = groupModels(entries)
  assert.deepEqual(Array.from(groups, ([label, list]) => [label, Array.from(list, model => model.ref)]), [
    ['Cloud (official)', ['official/flash']],
    ['Cloud (local)', ['local/flash']],
    ['custom', ['custom/flash']],
  ])
})

test('an unavailable model offers the same provider groups', () => {
  const { tree } = dock(models, { model: 'gone/flash' })
  assert.deepEqual(nodes(tree, node => node.props.className === 'bt-model-choice-group').map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.ok(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0].includes('not available anymore'))
})

test('an empty catalog offers setup choices, and a ready model needs no choice dock', () => {
  const { tree } = dock([])
  assert.deepEqual(nodes(tree, node => node.type === 'button').map(button => button.children[0]), [
    'Enter a DeepSeek API key', 'Open settings to set up a custom model',
  ])
  assert.equal(dock(models, { model: models[0].ref }).tree, null)
  assert.equal(dock(models, { ready: false }).tree, null)
})

test('without DSH\'s own settings, the choice offers no way into them', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock(models, { harness: false }).tree), ['DeepSeek Flash', 'DeepSeek Pro', 'DeepSeek Flash'])
  assert.deepEqual(buttons(dock([], { harness: false }).tree), [])
})

test('the Thinking section always offers Default, so a picked level can be cleared', () => {
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  // Array.from: the rows come from the bundle's realm, whose arrays are not this one's.
  assert.deepEqual(Array.from(effortRows({ efforts, defaultEffort: 'high' }), row => row.effort), [undefined, 'low', 'high'])
  assert.deepEqual(Array.from(effortRows({ efforts }), row => row.effort), [undefined, 'low', 'high'])
  assert.equal(effortRows({ efforts: [] }).length, 0)
  // Slider stops use the model's levels when defaultEffort is known (reset clears to Default),
  // and include a leading Default stop when the provider did not name one.
  assert.deepEqual(Array.from(effortStops({ efforts, defaultEffort: 'high' }), row => row.effort), ['low', 'high'])
  assert.deepEqual(Array.from(effortStops({ efforts }), row => row.effort), [undefined, 'low', 'high'])
  const picked = []
  const bar = EffortBar({ reasoning: { efforts, defaultEffort: 'high' }, current: 'low', onPick: value => picked.push(value) })
  const slider = nodes(bar, node => node.props.role === 'slider')[0]
  assert.equal(slider.props['aria-valuenow'], 0)
  assert.equal(slider.props['aria-valuetext'], 'Low')
  slider.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} })
  const reset = nodes(bar, node => node.props.className === 'bt-effort-reset')[0]
  reset.props.onClick()
  assert.deepEqual(picked, ['high', undefined])
})

test('menu focus stepping starts from menu items or the trigger, not other controls', () => {
  const focused = []
  const item = name => ({ name, focus: () => focused.push(name) })
  const first = item('first')
  const second = item('second')
  const slider = item('slider')
  const source = item('source')
  const menu = {
    querySelectorAll: () => [first, second],
    contains: target => [first, second, slider].includes(target),
  }
  const trigger = source
  const event = key => {
    const out = { key, prevented: false, stopped: false }
    out.preventDefault = () => { out.prevented = true }
    out.stopPropagation = () => { out.stopped = true }
    return out
  }

  sandbox.document.activeElement = slider
  const arrow = event('ArrowDown')
  assert.equal(stepMenuFocus(menu, arrow, trigger), false)
  assert.equal(arrow.prevented, false)
  assert.equal(arrow.stopped, false)

  sandbox.document.activeElement = source
  assert.equal(stepMenuFocus(menu, event('ArrowDown'), trigger), true)
  sandbox.document.activeElement = first
  assert.equal(stepMenuFocus(menu, event('ArrowDown'), trigger), true)
  sandbox.document.activeElement = item('unrelated')
  assert.equal(stepMenuFocus(menu, event('ArrowDown'), trigger), false)
  assert.deepEqual(focused, ['first', 'second'])
})

const keyless = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash', needsKey: true },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro', needsKey: true },
]

test('models that need an API key are no choice', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock([...keyless, models[1]], { harness: false }).tree), ['DeepSeek Flash'])
  // Without the host's key endpoint, DSH's own settings take the key.
  assert.deepEqual(buttons(dock(keyless).tree), ['Enter a DeepSeek API key', 'Open settings to set up a custom model'])
})

test('the first choice asks for the missing API key through the host', () => {
  const saved = []
  const bot = { id: 'chief', name: 'Chief' }
  const tree = ModelChoiceDock({
    sessionId: bot.id,
    useRoster: select => select({ ready: true, byId: { chief: bot }, models: keyless }),
    actions: { setProviderKey: (provider, value) => { saved.push([provider, value]) } },
  })
  assert.match(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0], /need a DeepSeek API key/)
  const [card] = nodes(tree, node => node.props.model !== undefined)
  assert.equal(card.props.model.provider, 'official')
  assert.equal(nodes(tree, node => node.props.className === 'bt-model-chips').length, 0)
})

test('the DeepSeek API key card links to the key page and says the API is billed by usage', () => {
  const card = model => ModelKeyCard({ model, actions: { setProviderKey: () => {} } })
  const official = card({ provider: 'deepseek-official', providerName: 'DeepSeek' })
  const [link] = nodes(official, node => node.type === 'a')
  assert.equal(link.props.href, 'https://platform.deepseek.com/api_keys')
  assert.equal(link.props.target, '_blank')
  assert.match(link.props.rel, /noopener/)
  assert.deepEqual(link.children, ['Create a key on the DeepSeek platform ↗'])
  assert.ok(nodes(official, node => node.children.includes('The API is billed by usage; the account needs a balance first.')).length === 1)
  const other = card({ provider: 'router', providerName: 'Router' })
  assert.equal(nodes(other, node => node.type === 'a').length, 0)
  assert.equal(nodes(other, node => node.props.className === 'bt-model-key-help').length, 0)
})

test('setting up a custom model opens the Models page of Settings', () => {
  const opened = []
  const choices = actions => nodes(ModelChoiceDock({
    sessionId: 'chief', useRoster: select => select({ ready: true, byId: { chief: { id: 'chief', name: 'Chief' } }, models: [] }), actions,
  }), node => node.type === 'button')
  const custom = list => list.find(button => button.children[0] === 'Open settings to set up a custom model')
  custom(choices({ openModels: () => opened.push('models'), openSettings: page => opened.push(`settings:${page}`) })).props.onClick()
  custom(choices({ openSettings: page => opened.push(`settings:${page}`) })).props.onClick()
  assert.deepEqual(opened, ['models', 'settings:models'])
})

// The provider groups of the Bot model menu: a heading opens and closes its group, and
// only the current model's provider is open when the menu opens.
const menuModels = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'Ollama Flash' },
  { ref: 'relay/k3', provider: 'relay', providerName: 'Relay', name: 'Relay K3' },
]
const menuRoster = (models = menuModels) => ({ models, defaultModel: models[0]?.ref })
// Function components render here by running them: the fake createElement keeps the
// element, and the menu rows are one.
const rendered = element => (Array.isArray(element)
  ? element.flatMap(rendered)
  : element !== null && typeof element === 'object' && typeof element.type === 'function'
    ? rendered(element.type(element.props))
    : element)
const inside = (element, match) => Array.from(rendered(element)).flatMap(node => nodes(node, match))
const menuRows = (current, extra = {}) => ModelRows({ roster: menuRoster(), current, onPick: () => {}, ...extra })
const headingOf = (tree, label) => inside(tree, node => node.props?.role === 'menuitem' && node.props['aria-expanded'] !== undefined
  && node.children.some(child => child?.props?.className === 'bt-menu-label' && child.children?.[0] === label))[0]
const modelNames = tree => Array.from(inside(tree, node => node.props?.role === 'menuitemradio'), node => node.children[0].children[0])
const modelRows = tree => Array.from(inside(tree, node => node.props?.role === 'menuitemradio'))

test('only the provider of the current model is open when the menu opens', () => {
  const tree = menuRows('relay/k3')
  assert.deepEqual(['DeepSeek', 'Ollama', 'Relay'].map(label => headingOf(tree, label).props['aria-expanded']), [false, false, true])
  assert.deepEqual(modelNames(tree), ['Relay K3'])
})

test('without a current model, or with one no longer served, the first provider is open', () => {
  for (const current of [undefined, 'gone/flash']) {
    const tree = menuRows(current)
    assert.equal(headingOf(tree, 'DeepSeek').props['aria-expanded'], true)
    assert.equal(headingOf(tree, 'Ollama').props['aria-expanded'], false)
    assert.deepEqual(modelNames(tree), ['DeepSeek Flash', 'DeepSeek Pro'])
  }
})

test('two providers with the same display name open independently, by provider id', () => {
  const twins = menuModels.map(model => ({ ...model, providerName: 'Cloud' }))
  const tree = ModelRows({ roster: menuRoster(twins), current: 'local/flash', onPick: () => {} })
  assert.equal(headingOf(tree, 'Cloud (official)').props['aria-expanded'], false)
  assert.equal(headingOf(tree, 'Cloud (local)').props['aria-expanded'], true)
  assert.deepEqual(modelNames(tree), ['Ollama Flash'])
})

test('a group opens by the search, then the manual pick, then the current model, then the first', () => {
  const open = (options = {}) => groupOpen({ id: 'local', index: 1, currentId: 'relay', filtering: false, manual: {}, ...options })
  // A search opens every group it matched, and the manual state only applies again without it.
  assert.equal(open({ filtering: true, manual: { local: false } }), true)
  assert.equal(open({ manual: { local: false } }), false)
  assert.equal(open({ manual: { local: true } }), true)
  // Otherwise the current model's provider is open, and the first provider without one.
  assert.equal(open(), false)
  assert.equal(open({ currentId: 'local' }), true)
  assert.equal(open({ currentId: undefined, index: 0 }), true)
  assert.equal(open({ currentId: undefined, index: 1 }), false)
})

test('a heading opens and closes its group, the current one included', () => {
  const groups = groupModels(menuModels)
  const toggles = []
  const list = manual => ModelGroupList({
    groups, current: 'relay/k3', currentId: 'relay', defaultModel: undefined, onPick: () => {}, manual, filtering: false,
    onToggle: (id, open) => toggles.push([id, open]),
  })
  headingOf(list({}), 'Ollama').props.onClick()
  headingOf(list({}), 'Relay').props.onClick()
  assert.deepEqual(toggles, [['local', false], ['relay', true]])

  const opened = list(toggledGroup({}, 'local', false))
  assert.deepEqual(modelNames(opened), ['Ollama Flash', 'Relay K3'])
  const currentClosed = list(toggledGroup(toggledGroup({}, 'local', false), 'relay', true))
  assert.deepEqual(modelNames(currentClosed), ['Ollama Flash'])
  assert.equal(headingOf(currentClosed, 'Relay').props['aria-expanded'], false)
})

test('a heading is a menu item button a keyboard can reach and press', () => {
  const heading = headingOf(menuRows('relay/k3'), 'DeepSeek')
  // `stepMenuFocus` walks button[role^="menuitem"], and a native button takes Enter and
  // Space as a click; a collapsed group renders no rows, so its models leave that walk.
  assert.equal(heading.type, 'button')
  assert.equal(heading.props.type, 'button')
  assert.equal(heading.props.role, 'menuitem')
  assert.equal(heading.props.tabIndex, undefined)
  assert.equal(typeof heading.props.onClick, 'function')
  assert.equal(modelRows(menuRows('relay/k3')).length, 1)
})

test('a search opens every matched group and the manual state returns when it clears', () => {
  const matched = menuModels.filter(model => /flash|k3/i.test(`${model.name} ${model.ref}`))
  const groups = groupModels(matched)
  const list = (filtering, manual, currentId) => ModelGroupList({
    groups, current: 'relay/k3', currentId, defaultModel: undefined, onPick: () => {}, manual, filtering, onToggle: () => {},
  })
  // While a search filters the list, a heading has nothing to collapse and every match shows.
  const searching = list(true, { relay: true }, undefined)
  assert.equal(inside(searching, node => node.props?.role === 'menuitem').length, 0)
  assert.equal(inside(searching, node => node.props?.className === 'bt-model-group').length, 3)
  assert.deepEqual(modelNames(searching), ['DeepSeek Flash', 'Ollama Flash', 'Relay K3'])
  // Clearing it brings back the headings and the state the user left them in: the group
  // they opened stays open, the first group is open because no model is current.
  const cleared = list(false, { relay: true }, undefined)
  assert.equal(headingOf(cleared, 'DeepSeek').props['aria-expanded'], true)
  assert.equal(headingOf(cleared, 'Ollama').props['aria-expanded'], false)
  assert.equal(headingOf(cleared, 'Relay').props['aria-expanded'], true)
  assert.deepEqual(modelNames(cleared), ['DeepSeek Flash', 'Relay K3'])
})

test('a reopened menu starts from the default, not the choices of the menu still leaving', () => {
  // The leaving menu lives through its exit animation and the reopen can land on the same
  // rows; the new opening number must read the default instead of the old choices.
  const previous = { opening: 1, manual: toggledGroup({}, 'local', true) }
  assert.equal(manualFor(previous, 1).local, false)
  assert.deepEqual({ ...manualFor(previous, 2) }, {})
  // A click in the reopened menu builds on that empty state, not on the old one.
  assert.deepEqual({ ...toggledGroup(manualFor(previous, 2), 'relay', false) }, { relay: true })
})

test('the Default mark, the tick and the pick stay on the open group\'s rows', () => {
  const picked = []
  const tree = ModelRows({ roster: menuRoster(), current: 'official/flash', onPick: ref => picked.push(ref) })
  const rows = modelRows(tree)
  assert.deepEqual(Array.from(rows, row => row.children[0].children[0]), ['DeepSeek Flash', 'DeepSeek Pro'])
  assert.equal(nodes(rows[0], node => node.props?.className === 'bt-menu-hint')[0].children[0], 'Default')
  assert.equal(nodes(rows[0], node => node.props?.className === 'bt-model-tick')[0].children.length, 1)
  assert.equal(nodes(rows[1], node => node.props?.className === 'bt-model-tick')[0].children[0], null)
  rows[1].props.onClick()
  assert.deepEqual(picked, ['official/pro'])
})
