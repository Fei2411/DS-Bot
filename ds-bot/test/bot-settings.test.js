import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/bot-settings.js'; export { registerShape } from './src/client/themes.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { AvatarEditor, BotSettingsForm, CharacterGrid, InlineText, registerShape } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot, { main = false, rooms = [] } = {}) {
  const roster = { mainBotIds: main ? [bot.id] : [], mainBotId: main ? bot.id : null, rooms, models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }

test('the primary Main Bot keeps its name and avatar editing controls', () => {
  const writes = []
  const chief = { ...bot, id: 'chief', name: 'Chief' }
  const roster = { mainBotId: chief.id, mainBotIds: [chief.id], rooms: [], models: [] }
  const actions = { updateBot: (id, patch) => writes.push([id, patch]) }
  const nodes = walk(BotSettingsForm({ bot: chief, roster, actions, run: value => value }))
  nodes.find(node => node.type === InlineText && node.props.label === 'Name').props.onSave('Captain')
  assert.equal(nodes.some(node => node.props?.['aria-label'] === 'Edit Bot avatar'), true)
  assert.equal(JSON.stringify(writes), JSON.stringify([['chief', { name: 'Captain' }]]))
  assert.equal(roster.mainBotId, chief.id)
})

test('group photo reset and removal only clear the group avatar', () => {
  const writes = []
  const actions = { updateRoom: (id, patch) => writes.push([id, patch]) }
  const room = { id: 'room', avatar: { image: 'data:image/png;base64,AA==' } }
  const nodes = walk(AvatarEditor({ room, actions, run: value => value, onClose() {} }))
  assert.equal(nodes.filter(node => node.props?.role === 'tab').length, 2)
  nodes.find(node => node.props?.className === 'bt-avedit-tab bt-avedit-reset').props.onClick()
  nodes.find(node => node.props?.children?.includes('Remove photo')).props.onClick()
  assert.equal(JSON.stringify(writes), JSON.stringify([['room', { avatar: null }], ['room', { avatar: null }]]))
})

test('the group library selection writes an image without Bot-only fields', () => {
  const real = react.useState
  let first = true
  react.useState = initial => [first ? (first = false, 'library') : initial, () => {}]
  const writes = []
  try {
    const nodes = walk(AvatarEditor({ room: { id: 'room' }, actions: { updateRoom: (id, patch) => writes.push([id, patch]) }, run: value => value, onClose() {} }))
    nodes.find(node => node.props?.onPick).props.onPick({ image: 'data:image/png;base64,AA==' })
    assert.equal(JSON.stringify(writes), JSON.stringify([['room', { avatar: { image: 'data:image/png;base64,AA==' } }]]))
  } finally { react.useState = real }
})

test('the Private switch is enabled only for a state the host accepts', () => {
  const noFolder = settings(bot).find(node => node.props?.label === 'Private')
  assert.equal(noFolder.props.disabled, true)
  assert.equal(noFolder.props.hint, 'Choose a working folder of its own first.')

  const grouped = settings({ ...bot, workDir: '/work' }, { rooms: [{ id: 'r', members: ['b'] }] }).find(node => node.props?.label === 'Private')
  assert.equal(grouped.props.disabled, true)
  assert.equal(grouped.props.hint, 'Leave its group chats before making it private.')

  const main = settings({ ...bot, workDir: '/work' }, { main: true }).find(node => node.props?.label === 'Private')
  assert.equal(main.props.disabled, true)
  assert.equal(main.props.hint, 'A Main Bot cannot be private.')

  const allowed = settings({ ...bot, workDir: '/work' }).find(node => node.props?.label === 'Private')
  assert.equal(allowed.props.disabled, false)
  assert.equal(allowed.props.on, false)
})

test('a private Bot can always turn privacy off, and cannot become Main or be duplicated', () => {
  const tree = settings({ ...bot, workDir: '/work', private: true })
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.on, true)
  assert.equal(privacy.props.disabled, false)
  assert.equal(tree.find(node => node.props?.label === 'Main Bot').props.disabled, true)
  assert.equal(tree.some(node => node.props?.onClick && node.props.className === 'bt-set-row bt-bs-row' && JSON.stringify(node).includes('Duplicate')), false)
})

test('RunModeCard combines Engine and Model into one card without prose hints', () => {
  const tree = settings(bot)
  const runCard = tree.find(node => typeof node.type === 'function' && node.type.name === 'RunModeCard')
  assert.ok(runCard, 'BotSettingsForm mounts RunModeCard')
  const rendered = walk(runCard.type(runCard.props))
  const text = JSON.stringify(rendered)
  assert.match(text, /Engine/)
  assert.match(text, /Built-in engine/)
  assert.match(text, /Switch/)
  assert.match(text, /Model/)
  assert.doesNotMatch(text, /Answers with a model served by DS Bot/)
  assert.doesNotMatch(text, /Answers through this CLI/)
})

test('extra folders are listed under the working folder and saved as one list', () => {
  const saved = []
  const actions = { updateBot: (id, patch) => saved.push([id, patch]) }
  const roster = { mainBotIds: [], mainBotId: null, rooms: [], models: [], memory: false }
  const tree = walk(BotSettingsForm({ bot: { ...bot, workDir: '/work', extraDirs: ['/site', '/api'] }, roster, actions, run: fn => fn }))
  const list = tree.find(node => node.props?.value?.[0] === '/site' && typeof node.props.onSave === 'function')
  const rows = walk(list.type(list.props))
  const remove = rows.find(node => node.props?.['aria-label'] === 'Remove /site')
  remove.props.onClick()
  const adder = rows.find(node => node.props?.adding === true)
  adder.props.onPick('/docs')
  adder.props.onPick('/api')
  // The lists come from the bundle's own realm.
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [['b', { extraDirs: ['/api'] }], ['b', { extraDirs: ['/site', '/api', '/docs'] }]])
  // A Bot with extra folders clears them before it becomes private.
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.disabled, true)
  assert.equal(privacy.props.hint, 'Remove its extra folders first.')
  // A local agent owns its file permissions and has no extra-folder controls.
  const local = settings({ ...bot, workDir: '/work', engine: 'local-codex', extraDirs: ['/site'] })
  assert.equal(local.some(node => typeof node.props?.onSave === 'function' && Array.isArray(node.props.value ?? [])), false)
  // A private Bot has no list to edit.
  const closed = settings({ ...bot, workDir: '/work', private: true })
  assert.equal(closed.some(node => typeof node.props?.onSave === 'function' && Array.isArray(node.props.value ?? [])), false)
})

// One InlineText with working state, so a test can type into it, press keys and blur it.
function field(props) {
  const cells = []
  let slot = 0
  const real = { useState: react.useState, useRef: react.useRef }
  react.useState = initial => { const mine = slot++; cells[mine] ??= { value: initial }; return [cells[mine].value, next => { cells[mine].value = next }] }
  react.useRef = initial => { const mine = slot++; cells[mine] ??= { value: { current: initial } }; return cells[mine].value }
  const render = () => { slot = 0; return InlineText(props).props }
  const api = {
    props: render,
    type: text => render().onChange({ target: { value: text } }),
    blur: () => render().onBlur(),
    key: name => render().onKeyDown({ key: name, nativeEvent: {}, stopPropagation() {}, currentTarget: { blur: () => api.blur() } }),
  }
  return { api, restore: () => Object.assign(react, real) }
}
function editing(props, steps) {
  const log = []
  const { api, restore } = field({ ...props, onSave: next => log.push(['save', next]), onDone: () => log.push(['done']) })
  try { steps(api) } finally { restore() }
  return log
}

test('an inline field saves the trimmed text on blur and then reports the edit done', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('  Editor '); api.blur() }), [['save', 'Editor'], ['done']])
})

test('Enter in a single-line field saves; Enter in a multiline one adds a line', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Editor'); api.key('Enter') }), [['save', 'Editor'], ['done']])
  assert.deepEqual(editing({ label: 'Instructions', value: '', multiline: true }, (api) => { api.type('A'); api.key('Enter') }), [])
})

test('Escape drops the typed text, still reports the edit done, and the saved value stays', () => {
  const log = editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Editor'); api.key('Escape') })
  assert.deepEqual(log, [['done']])
})

test('an unchanged or untouched field saves nothing but still reports done', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Writer'); api.blur() }), [['done']])
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.blur() }), [['done']])
})

test('a required field never saves empty', () => {
  assert.deepEqual(editing({ label: 'Name', value: 'Ada', required: true }, (api) => { api.type('  '); api.blur() }), [['done']])
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type(''); api.blur() }), [['save', ''], ['done']])
})

test('a failed save keeps the typed draft in the field and does not end the edit', async () => {
  const done = []
  const { api, restore } = field({ label: 'Instructions', value: 'Old', onSave: () => Promise.resolve(false), onDone: () => done.push('done') })
  try {
    api.type('Unsaved draft')
    api.blur()
    await Promise.resolve()
    assert.equal(api.props().value, 'Unsaved draft')
    assert.deepEqual(done, [])
  } finally {
    restore()
  }
})

test('a field takes its class from the page it sits in, and defaults to the Settings page look', () => {
  assert.equal(InlineText({ label: 'Label', value: '' }).props.className, 'bt-bs-input')
  assert.equal(InlineText({ label: 'Instructions', value: '', multiline: true }).props.className, 'bt-bs-input bt-bs-area')
  assert.equal(InlineText({ label: 'Label', value: '', className: 'bt-drawer-role-input' }).props.className, 'bt-drawer-role-input')
})

test('CharacterGrid stays a flat 20-button grid for legacy and aliased Bot shapes', () => {
  // Legacy render-only shapes do not append an extra 21st button to the picker.
  for (const legacy of ['ring', 'gem', 'magnet']) {
    const grid = walk(CharacterGrid({ look: { shape: legacy, color: 'blue' }, onShape() {}, onColor() {} }))
    const buttons = grid.filter(node => node.props?.className === 'bt-shape')
    assert.equal(buttons.length, 20, `${legacy} should not add a 21st picker button`)
    assert.equal(grid.some(node => node.props?.className === 'bt-shape-row'), false)
    assert.equal(buttons.some(node => node.props['aria-pressed']), false)
  }
  // Aliased shapes resolve through AvatarEditor and highlight their active target button.
  const editorNodes = walk(AvatarEditor({ bot: { id: 'old', name: 'Old', avatar: { shape: 'wave' }, color: 'red' }, actions: {}, run: v => v, onClose() {} }))
  const gridEl = editorNodes.find(node => node.type === CharacterGrid)
  assert.equal(gridEl.props.look.shape, 'octopus')
  const buttons = walk(CharacterGrid(gridEl.props)).filter(node => node.props?.className === 'bt-shape')
  assert.equal(buttons.length, 20)
  const pressed = buttons.filter(node => node.props['aria-pressed'])
  assert.equal(pressed.length, 1)
  assert.equal(pressed[0].props['aria-label'], 'Octopus')

  // Plugin-registered shapes overriding a retired legacy id still appear in the picker,
  // and disappear again when unregistered.
  const unregisterRing = registerShape('ring', {
    label: 'Custom Ring',
    body: paint => `<circle cx="50" cy="50" r="36" fill="${paint}"/>`,
    eyes: { at: [[40, 45], [60, 45]] },
  })
  try {
    const withCustom = walk(CharacterGrid({ look: { shape: 'ring', color: 'blue' }, onShape() {}, onColor() {} })).filter(node => node.props?.className === 'bt-shape')
    assert.equal(withCustom.length, 21)
    assert.equal(withCustom.some(node => node.props['aria-label'] === 'Custom Ring' && node.props['aria-pressed']), true)
  } finally {
    unregisterRing()
  }
  const afterUnregister = walk(CharacterGrid({ look: { shape: 'ring', color: 'blue' }, onShape() {}, onColor() {} })).filter(node => node.props?.className === 'bt-shape')
  assert.equal(afterUnregister.length, 20)
})
