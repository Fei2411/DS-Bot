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

test('a capability choice changes only that Bot and item, and reselecting the current mode does nothing', async () => {
  const calls = []
  const pending = []
  const tree = render({ capabilities: ['echo'], packs: ['guide'] }, {
    actions: { setBotCapability: (...args) => calls.push(args) },
    run: promise => { pending.push(promise); return promise },
  })
  const group = groups(tree).find(node => node.props.label === 'echo')
  for (const button of group.props.children) button.props.onClick()
  await Promise.all(pending)
  assert.deepEqual(calls, [['writer', 'echo', true, 'catalog'], ['writer', 'echo', false, 'always']])
  const off = groups(render({}, { actions: { setBotCapability: (...args) => calls.push(args) } })).find(node => node.props.label === 'echo')
  off.props.children[0].props.onClick()
  assert.deepEqual(calls.at(-1), ['writer', 'echo', true, 'always'])
})

function deferredRow(initial = {}) {
  const refs = []
  const calls = []
  const saves = []
  const errors = []
  let bot = initial
  const tree = () => {
    const original = react.useRef
    let slot = 0
    react.useRef = value => { const index = slot++; return refs[index] ??= { current: value } }
    try {
      return render(bot, {
        actions: { setBotCapability: (id, name, attached, mode) => {
          calls.push([id, name, attached, mode])
          const gate = Promise.withResolvers()
          saves.push(gate)
          return gate.promise.then(() => {
            bot = {
              ...bot,
              capabilities: [...(bot.capabilities ?? []).filter(value => value !== name), ...(attached && mode === 'always' ? [name] : [])],
              packs: [...(bot.packs ?? []).filter(value => value !== name), ...(attached && mode === 'catalog' ? [name] : [])],
            }
          })
        } },
        run: promise => promise.catch(error => errors.push(error)),
      })
    } finally { react.useRef = original }
  }
  const group = (name = 'echo') => groups(tree()).find(node => node.props.label === name)
  return {
    calls, errors,
    mode: name => group(name).props.value,
    click: (label, name) => group(name).props.children.find(button => textOf(button) === label).props.onClick(),
    settle: async (index, error) => {
      if (error) saves[index].reject(error)
      else saves[index].resolve()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

test('Off → Always on → Off queues detachment while the first save and refresh are pending', async () => {
  const row = deferredRow()
  row.click('Always on')
  assert.equal(row.mode(), 'always')
  row.click('Off')
  assert.equal(row.mode(), 'off')
  assert.deepEqual(row.calls, [['writer', 'echo', true, 'always']])
  await row.settle(0)
  assert.deepEqual(row.calls, [['writer', 'echo', true, 'always'], ['writer', 'echo', false, 'always']])
  assert.equal(row.mode(), 'off')
  await row.settle(1)
  assert.equal(row.mode(), 'off')
})

test('Always on → In catalog → Off sends only the latest queued choice', async () => {
  const row = deferredRow({ capabilities: ['echo'] })
  row.click('In catalog')
  assert.equal(row.mode(), 'catalog')
  row.click('Always on')
  row.click('Off')
  assert.equal(row.mode(), 'off')
  assert.equal(row.calls.length, 1)
  await row.settle(0)
  assert.deepEqual(row.calls, [['writer', 'echo', true, 'catalog'], ['writer', 'echo', false, 'always']])
  await row.settle(1)
  assert.equal(row.mode(), 'off')
})

test('returning to the in-flight choice avoids a redundant queued save', async () => {
  const row = deferredRow()
  row.click('Always on')
  row.click('In catalog')
  row.click('Always on')
  await row.settle(0)
  assert.equal(row.mode(), 'always')
  assert.equal(row.calls.length, 1)
})

test('a queued save failure restores the latest roster state and reports the error', async () => {
  const row = deferredRow()
  row.click('Always on')
  row.click('Off')
  await row.settle(0)
  const failure = new Error('Read-only team')
  await row.settle(1, failure)
  assert.equal(row.mode(), 'always')
  assert.deepEqual(row.errors, [failure])
  assert.equal(row.calls.length, 2)
})

test('an initial save failure discards the queued choice and restores the roster', async () => {
  const row = deferredRow()
  row.click('Always on')
  row.click('In catalog')
  const failure = new Error('Read-only team')
  await row.settle(0, failure)
  assert.equal(row.mode(), 'off')
  assert.deepEqual(row.errors, [failure])
  assert.equal(row.calls.length, 1)
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
