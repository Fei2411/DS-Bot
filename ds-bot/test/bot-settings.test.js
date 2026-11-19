import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
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
const { BotSettingsForm, BotResponseCard, InlineText, ResponsibilityCard } = module.exports

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

// Responding to Bots
const textOf = nodes => nodes.flatMap(node => node.props?.children ?? []).filter(child => typeof child === 'string').join(' ')
const others = [{ id: 'a', name: 'Chief' }, { id: 'c', name: 'Reviewer' }]
const card = (policy, onChange = () => {}) => walk(BotResponseCard({ policy, candidates: others, onChange }))

test('the response card offers OFF, SELECTED BOTS and ALL BOTS, and starts with none chosen', () => {
  const nodes = card(undefined)
  const modes = nodes.filter(node => node.type === 'button' && node.props['aria-pressed'] !== undefined)
  assert.deepEqual(modes.map(node => node.props.children[0]), ['Off', 'Selected Bots', 'All Bots'])
  assert.deepEqual(modes.map(node => node.props['aria-pressed']), [false, false, false])
  assert.ok(textOf(nodes).includes('Not chosen yet'))
  assert.equal(nodes.some(node => node.props?.role === 'note'), false)
})

test('ALL BOTS warns, SELECTED BOTS lists identities to tick, and picking saves the stable ID', () => {
  const warned = card({ mode: 'all' })
  assert.ok(warned.some(node => node.props?.role === 'note'), 'ALL shows a warning')
  assert.ok(textOf(warned).includes('choose this only for Bots you trust'))
  const saved = []
  const selected = card({ mode: 'selected', allow: ['a'] }, value => saved.push(value))
  const chips = selected.filter(node => node.props?.role === 'checkbox')
  assert.deepEqual(chips.map(node => node.props['aria-checked']), [true, false])
  chips[1].props.onClick()
  chips[0].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ mode: 'selected', allow: ['a', 'c'] }, { mode: 'selected', allow: [] }])
  assert.ok(textOf(selected).includes('A Bot message can be ignored'), 'it says why a message may be suppressed')
  assert.ok(textOf(card({ mode: 'selected', allow: [] })).includes('Pick at least one Bot'))
})

test('reset goes back to the default, and the Bot settings carry the card', () => {
  const saved = []
  const reset = card({ mode: 'off' }, value => saved.push(value)).find(node => node.type === 'button' && node.props.className === 'bt-mini')
  reset.props.onClick()
  assert.deepEqual(saved, [null])
  assert.ok(settings({ ...bot, botResponse: { mode: 'off' } }).some(node => node.type === BotResponseCard))
})

test('selecting, editing, and restoring a responsibility requires Apply', async () => {
  const slots = []
  let cursor = 0
  const original = react.useState
  react.useState = initial => {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], value => { slots[slot] = value }]
  }
  try {
    const saved = []
    const settings = { ...bot, instructions: 'Original user instructions' }
    const render = () => {
      cursor = 0
      const nodes = walk(ResponsibilityCard({ bot: settings, coordinator: true, onSave: async patch => { saved.push(patch) } }))
      return {
        select: nodes.find(node => node.type === 'select'),
        instructions: nodes.find(node => node.type === 'textarea'),
        apply: nodes.find(node => node.type === 'button' && node.props.children.includes('Apply responsibility')),
        categories: nodes.filter(node => node.props.role === 'checkbox' && node.props['aria-checked']).map(node => node.props.children[0]),
      }
    }
    assert.equal(render().select.props.value, 'custom')
    assert.equal(render().instructions.props.value, 'Original user instructions')
    assert.equal(render().apply, undefined)
    render().select.props.onChange({ target: { value: 'coding' } })
    assert.match(render().instructions.props.value, /Implement/)
    assert.deepEqual(render().categories, ['Coding'])
    render().instructions.props.onChange({ target: { value: 'Use the local test harness.' } })
    assert.equal(saved.length, 0)
    await render().apply.props.onClick()
    assert.equal(saved[0].instructions, 'Use the local test harness.')
    assert.equal(saved[0].responsibility.custom.instructions, 'Original user instructions')
    Object.assign(settings, saved[0])
    render().select.props.onChange({ target: { value: 'custom' } })
    assert.equal(render().instructions.props.value, 'Original user instructions')
    assert.equal(saved.length, 1)
  } finally {
    react.useState = original
  }
})
