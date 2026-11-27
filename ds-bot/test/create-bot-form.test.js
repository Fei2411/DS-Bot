import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The Create Bot form, bundled once and rendered with the minimal React stand-in of
// connectors-page.test.js: hooks are numbered by expansion order, effects never run.
const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const rerender = () => { idx = 0; concrete = expand(module.exports.CreateBot(props)) }
// The props of the last ModelMenu and CliList elements the form created, caught at
// element creation time: expand() inlines function components, so the elements
// themselves never survive into the tree a test can search. Their callbacks close
// over the render that made them, so a test must use the props of the latest render
// — in local mode without a picked CLI the menu does not render at all, and stale
// props would act on the wrong mode.
let modelMenuProps = null
let cliListProps = null
const react = {
  createElement: (type, p, ...children) => {
    if (typeof type === 'function' && type.name === 'ModelMenu') modelMenuProps = p
    if (typeof type === 'function' && type.name === 'CliList') cliListProps = p
    return { type, props: { ...p, children } }
  },
  Fragment: 'fragment',
  useCallback: fn => fn,
  useMemo: make => make(),
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, btoa, atob,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const button = text => collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
const render = (roster, extra = {}) => {
  slots.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {}, ...extra }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens on Built-in engine and can create at once', () => {
  render({ models: MODELS })
  assert.equal(button('Built-in engine').props['aria-pressed'], true)
  assert.equal(button('Local agent').props['aria-pressed'], false)
  assert.equal(button('Create').props.disabled, false)
})

test('a name another Bot has blocks Create on both sides', () => {
  render({ models: MODELS, bots: [{ id: 'a', name: 'Ada' }] })
  collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.onChange({ target: { value: 'Ada' } })
  assert.match(flatten(concrete).join(' '), /A Bot named Ada already exists/)
  assert.equal(button('Create').props.disabled, true)
  button('Local agent').props.onClick()
  assert.equal(button('Create').props.disabled, true)
})

test('on Local agent, Create waits for a CLI', () => {
  render({ models: MODELS })
  const presetPickers = () => collect(n => String(n.props?.className ?? '').includes('bt-preset-trigger'))
  assert.equal(presetPickers().length, 1)
  button('Local agent').props.onClick()
  assert.equal(presetPickers().length, 0)
  assert.equal(button('Local agent').props['aria-pressed'], true)
  assert.match(flatten(concrete).join(' '), /Looking for agent CLIs/)
  assert.equal(button('Create').props.disabled, true)
  button('Built-in engine').props.onClick()
  assert.equal(presetPickers().length, 1)
  assert.equal(button('Create').props.disabled, false)
})

test('a thinking level picked for a local agent reaches the creation payload', async () => {
  const created = []
  const reading = []
  render({ models: MODELS })
  props.actions = { createBot: async payload => { created.push(payload); return { id: 'new' } }, agentModels: route => reading.push(route) }
  rerender()
  button('Local agent').props.onClick()
  // The CLI list is empty in tests (effects never run), so pick through the same
  // onPick the list rows call: the agent ref resets the level and asks for models.
  cliListProps.onPick({ route: 'local-grok-cli' })
  modelMenuProps.onPick('local-grok-cli/grok-4.7')
  modelMenuProps.onPickEffort('high')
  const [nameInput] = collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')
  nameInput.props.onChange({ target: { value: 'Grokky' } })
  assert.equal(button('Create').props.disabled, false)
  button('Create').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(created[0].model, 'local-grok-cli/grok-4.7')
  assert.equal(created[0].effort, 'high')
})

test('picking the CLI default level on a local agent clears the effort to null', async () => {
  const created = []
  render({ models: MODELS })
  props.actions = { createBot: async payload => { created.push(payload); return { id: 'new' } } }
  rerender()
  // The DS Bot model side keeps its own level and never leaks into the agent pick.
  modelMenuProps.onPickEffort('low')
  button('Local agent').props.onClick()
  cliListProps.onPick({ route: 'local-grok-cli' })
  modelMenuProps.onPick('local-grok-cli/grok-4.7')
  modelMenuProps.onPickEffort(null)
  const [nameInput] = collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')
  nameInput.props.onChange({ target: { value: 'Grokky' } })
  button('Create').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(created[0].effort, null)
  assert.equal(created[0].model, 'local-grok-cli/grok-4.7')
})

test('a thinking level picked for a DS Bot model reaches the creation payload', async () => {
  const created = []
  render({ models: MODELS })
  props.actions = { createBot: async payload => { created.push(payload); return { id: 'new' } } }
  rerender()
  modelMenuProps.onPickEffort('low')
  button('Create').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(created[0].effort, 'low')
  assert.equal(created[0].model, MODELS[0].ref)
})

test('re-picking the current model keeps the selected thinking level on both modes', async () => {
  const created = []
  render({ models: MODELS })
  props.actions = { createBot: async payload => { created.push(payload); return { id: 'new' } }, agentModels() {} }
  rerender()

  // DS Bot model mode: re-picking the active model ref preserves effort.
  modelMenuProps.onPickEffort('low')
  modelMenuProps.onPick(MODELS[0].ref)
  assert.equal(modelMenuProps.bot.effort, 'low')
  modelMenuProps.onPick(MODELS[1].ref)
  assert.equal(modelMenuProps.bot.effort, undefined)

  // Local agent mode: re-picking the same agent card or same model ref preserves effort.
  button('Local agent').props.onClick()
  cliListProps.onPick({ route: 'local-grok-cli' })
  modelMenuProps.onPickEffort('high')
  cliListProps.onPick({ route: 'local-grok-cli' })
  assert.equal(modelMenuProps.bot.effort, 'high')
  modelMenuProps.onPick('local-grok-cli/default')
  assert.equal(modelMenuProps.bot.effort, 'high')
  modelMenuProps.onPick('local-grok-cli/grok-4.7')
  assert.equal(modelMenuProps.bot.effort, undefined)
})

test('inline Settings subpage does not autoFocus Name below the avatar picker', () => {
  render({ models: MODELS }, { inline: true })
  assert.equal(collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.autoFocus, false)
  render({ models: MODELS }, { inline: false })
  assert.equal(collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.autoFocus, true)
})
