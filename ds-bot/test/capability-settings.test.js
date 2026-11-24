import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

function deferredRow(initial = {}, library = items) {
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
        roster: { capabilities: library },
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
    text: () => textOf(tree()),
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
  assert.ok(textOf(render()).includes('In catalog: the Bot loads this only when it needs it.'))
})

test('Off items show every active pack source without changing or disabling the direct choice', () => {
  const library = [
    ...items,
    { name: 'research-tools', kind: 'pack', items: ['echo', 'guide'] },
    { name: 'writing-tools', kind: 'pack', items: ['guide'] },
    { name: 'unused-tools', kind: 'pack', items: ['guide'] },
  ]
  const calls = []
  const tree = render({ capabilities: ['research-tools'], packs: ['writing-tools'] }, {
    roster: { capabilities: library }, actions: { setBotCapability: (...args) => calls.push(args) },
  })
  const rows = walk(tree).filter(node => node.props?.className === 'bt-set-row bt-bs-row bt-bs-stack')
  const guide = rows.find(node => textOf(node).startsWith('guide'))
  assert.ok(textOf(guide).includes('Off · Always on via research-tools'))
  assert.ok(textOf(guide).includes('Off · In catalog via writing-tools'))
  assert.ok(!textOf(guide).includes('unused-tools'))
  assert.ok(textOf(rows.find(node => textOf(node).startsWith('echo'))).includes('Always on via research-tools'))
  const group = groups(guide)[0]
  assert.equal(group.props.value, 'off')
  assert.ok(group.props.children.every(button => !button.props.disabled))
  group.props.children[1].props.onClick()
  assert.deepEqual(calls, [['writer', 'guide', true, 'catalog']])
})

test('inactive packs and direct attachments do not show inherited Off hints', () => {
  const library = [...items, { name: 'research-tools', kind: 'pack', items: ['echo'] }]
  const extra = { roster: { capabilities: library } }
  assert.ok(!textOf(render({}, extra)).includes('via research-tools'))
  assert.ok(!textOf(render({ capabilities: ['echo', 'research-tools'] }, extra)).includes('via research-tools'))
  const catalog = render({ capabilities: ['research-tools'], packs: ['echo'] }, extra)
  assert.ok(textOf(catalog).includes('Always on via research-tools'))
  assert.ok(!textOf(catalog).includes('Off · Always on via research-tools'))
  assert.equal(groups(catalog).find(node => node.props.label === 'echo').props.value, 'catalog')
  assert.ok(!textOf(render({ packs: ['research-tools', 'echo'] }, extra)).includes('via research-tools'))
})

test('Off → In catalog keeps an Always-on pack source before and after saving', async () => {
  const library = [
    { name: 'writing-guide', kind: 'skill' },
    { name: 'research-tools', kind: 'pack', items: ['writing-guide'] },
  ]
  const row = deferredRow({ capabilities: ['research-tools'] }, library)
  assert.ok(row.text().includes('Off · Always on via research-tools'))
  row.click('In catalog', 'writing-guide')
  assert.equal(row.mode('writing-guide'), 'catalog')
  assert.ok(row.text().includes('Always on via research-tools'))
  assert.ok(!row.text().includes('Off · Always on via research-tools'))
  await row.settle(0)
  assert.equal(row.mode('writing-guide'), 'catalog')
  assert.ok(row.text().includes('Always on via research-tools'))
  assert.deepEqual(row.calls, [['writer', 'writing-guide', true, 'catalog']])
})

test('inherited sources follow pending pack choices immediately and restore on failure', async () => {
  const row = deferredRow({}, [...items, { name: 'research-tools', kind: 'pack', items: ['echo'] }])
  row.click('Always on', 'research-tools')
  assert.ok(row.text().includes('Off · Always on via research-tools'))
  row.click('In catalog', 'research-tools')
  assert.ok(row.text().includes('Off · In catalog via research-tools'))
  assert.ok(!row.text().includes('Always on via research-tools'))
  await row.settle(0, new Error('Read-only team'))
  assert.ok(!row.text().includes('via research-tools'))
})

test('configured local MCPs show library approval guidance separately from connection status', () => {
  const local = { name: 'local-server', kind: 'mcp', transport: 'stdio', approved: false }
  const library = [local, { name: 'research-tools', kind: 'pack', items: [local.name] }]
  const extra = { roster: { capabilities: library, capabilityStatuses: { writer: { [local.name]: { state: 'ready' } } } } }
  for (const bot of [{ packs: [local.name] }, { capabilities: [local.name] }, { capabilities: ['research-tools'] }, { packs: ['research-tools'] }]) {
    const tree = render(bot, extra)
    assert.ok(textOf(tree).includes('Needs approval · Allow it in Shared capabilities.'))
    assert.ok(!textOf(tree).includes('Ready'))
  }
  assert.ok(!textOf(render({}, extra)).includes('Needs approval'))
  for (const item of [{ ...local, approved: true }, { ...local, transport: 'streamable-http' }]) {
    assert.ok(!textOf(render({ packs: [local.name] }, { roster: { capabilities: [item] } })).includes('Needs approval'))
  }
})

test('catalog helper uses plain copy and the standard secondary text color', () => {
  const helper = walk(render()).find(node => textOf(node) === 'In catalog: the Bot loads this only when it needs it.')
  const hint = walk(helper).find(node => node.type === 'span')
  assert.ok(hint.props.className.includes('bt-capability-hint'))
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-set-hint\.bt-capability-hint\{color:var\(--bt-ink-2\)\}/)
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
