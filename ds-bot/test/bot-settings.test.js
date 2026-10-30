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
const { BotSettingsForm } = module.exports

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
