import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/capability-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [initial, () => {}], useEffect() {}, useLayoutEffect() {},
  useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { BotCapabilitiesCard } = module.exports
const Card = () => {}
const items = [{ name: 'echo', kind: 'mcp' }, { name: 'guide', kind: 'skill' }, { name: 'bundle', kind: 'pack' }]
const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
  ? node.flatMap(walk) : [node, ...walk(node.props?.children)]
const textOf = node => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(textOf).join('') : textOf(node?.props?.children ?? '')
const render = (bot = {}, extra = {}) => BotCapabilitiesCard({
  bot: { id: 'writer', ...bot }, roster: { capabilities: items }, Card,
  actions: { setBotCapability() {} }, run: promise => promise, ...extra,
})
const groups = tree => walk(tree).filter(node => node.type?.name === 'Segmented')

test('each capability kind renders Always on, In catalog and Off from the saved Bot lists', () => {
  for (const item of items) {
    for (const [mode, fields] of [['always', { capabilities: [item.name] }], ['catalog', { packs: [item.name] }], ['off', {}]]) {
      const group = groups(render(fields)).find(node => node.props.label === item.name)
      assert.equal(group.props.value, mode)
      assert.deepEqual(Array.from(group.props.children, textOf), ['Always on', 'In catalog', 'Off'])
      assert.deepEqual(Array.from(group.props.children, node => node.props['aria-pressed']), ['always', 'catalog', 'off'].map(value => value === mode))
    }
  }
})

test('a capability choice changes only that Bot and item, and reselecting the current mode does nothing', () => {
  const calls = []
  const tree = render({ capabilities: ['echo'], packs: ['guide'] }, {
    actions: { setBotCapability: (...args) => calls.push(args) },
  })
  const group = groups(tree).find(node => node.props.label === 'echo')
  for (const button of group.props.children) button.props.onClick()
  assert.deepEqual(calls, [['writer', 'echo', true, 'catalog'], ['writer', 'echo', false, 'always']])
  const off = groups(render({}, { actions: { setBotCapability: (...args) => calls.push(args) } })).find(node => node.props.label === 'echo')
  off.props.children[0].props.onClick()
  assert.deepEqual(calls.at(-1), ['writer', 'echo', true, 'always'])
})

test('empty libraries omit the card, and old Bot data without packs still renders', () => {
  assert.equal(render({}, { roster: {} }), null)
  assert.ok(groups(render({ capabilities: ['echo'] })).some(node => node.props.label === 'echo' && node.props.value === 'always'))
  assert.ok(textOf(render()).includes('Items in catalog load only when the Bot calls use_pack.'))
})

test('connection status belongs only to always-on items, not inactive catalog entries', () => {
  const tree = render({ capabilities: ['echo'], packs: ['guide'] }, {
    roster: { capabilities: items, capabilityStatuses: { writer: { echo: { state: 'error', error: 'Offline' }, guide: { state: 'ready' } } } },
  })
  assert.ok(textOf(tree).includes('Could not connect: Offline'))
  assert.ok(!textOf(tree).includes('Ready'))
})

test('private and ordinary Bots keep the same user-facing attachment controls', () => {
  for (const fields of [{ private: true }, {}]) {
    const buttons = groups(render(fields)).flatMap(node => node.props.children)
    assert.equal(buttons.length, 9)
    assert.ok(buttons.every(button => !button.props.disabled))
  }
})

test('a refused change goes through the existing error runner without changing the selected mode', async () => {
  const errors = []
  const pending = []
  const failure = new Error('Read-only team')
  const tree = render({ packs: ['echo'] }, {
    actions: { setBotCapability: () => Promise.reject(failure) },
    run: promise => { const result = promise.catch(error => errors.push(error)); pending.push(result); return result },
  })
  const group = groups(tree).find(node => node.props.label === 'echo')
  group.props.children[0].props.onClick()
  await Promise.all(pending)
  assert.deepEqual(errors, [failure])
  assert.equal(group.props.value, 'catalog')
})
