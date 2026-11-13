import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// #1502: Settings → Bot models lists every Bot with its model; a Bot on a local agent
// is shown but cannot be selected, and the results of a batch are visible per Bot.

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-models-page.js', import.meta.url))],
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
const { BotModelsPage, modelLine, resultLine, summaryLine } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
const textOf = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'string') { out.push(node); return out }
  if (node && typeof node === 'object') textOf(node.props?.children, out)
  return out
}
const hasText = (node, text) => textOf(node).includes(text)

const MODELS = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'Pro' },
]
const chiefs = [
  { id: 'chief', name: 'Chief', model: 'official/pro' },
  { id: 'claude', name: 'Claude', model: 'local-claude-code/default' },
  { id: 'newbie', name: 'Newbie' },
]
const roster = {
  bots: chiefs, byId: Object.fromEntries(chiefs.map(bot => [bot.id, bot])), models: MODELS,
  prefs: { defaultBotModel: 'official/flash' }, defaultModel: 'official/flash',
}
const actions = { updateBot: async () => {} }
const Section = 'section'
const page = () => BotModelsPage({ roster, actions, run: promise => promise, Section })

test('the page lists every Bot with model, and a local agent Bot cannot be selected', () => {
  const rows = walk(page()).filter(node => String(node.props?.className ?? '').includes('bt-set-row bt-bm-row'))
  assert.equal(rows.length, 3)
  const rowOf = name => rows.find(row => hasText(row, name))
  for (const bot of chiefs) assert.ok(rowOf(bot.name), `${bot.name} is listed`)
  const boxOf = name => walk(rowOf(name)).find(node => node.type === 'input')
  assert.equal(boxOf('Claude').props.disabled, true)
  assert.equal(boxOf('Chief').props.disabled, false)
  assert.equal(boxOf('Claude').props.checked, false)
})

test('a Bot with no model shows the team default, one whose model is gone says so', () => {
  assert.equal(modelLine({ id: 'n', name: 'N' }, roster), 'No model picked yet')
  assert.equal(modelLine({ id: 'g', name: 'G', model: 'official/gone' }, roster), 'gone (not available)')
  assert.equal(modelLine({ id: 'c', name: 'C', model: 'official/pro' }, roster), 'Pro')
})

test('each result names its outcome, and a failure keeps the reason', () => {
  assert.equal(resultLine({ status: 'updated' }), 'Changed')
  assert.equal(resultLine({ status: 'unchanged' }), 'Already on this model')
  assert.equal(resultLine({ status: 'skipped', reason: 'local-agent' }), 'Skipped: runs on a local agent')
  assert.equal(resultLine({ status: 'skipped', reason: 'unavailable' }), 'Skipped: not available now')
  assert.equal(resultLine({ status: 'failed', message: 'The model is not available' }), 'Could not change: The model is not available')
})

test('the summary counts changed and failed Bots', () => {
  assert.equal(summaryLine([
    { status: 'updated' }, { status: 'updated' }, { status: 'failed', message: 'x' }, { status: 'skipped', reason: 'local-agent' },
  ]), 'Changed 2 of 4 Bots. · Skipped: 1 · Failed: 1')
})
