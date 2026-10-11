import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const platform = {
  react: {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: Symbol('Fragment'), useEffect: () => {},
  },
  'react-dom': {},
  '@deepseek-ai/dsh-client-ui-primitives': Object.fromEntries(
    ['DisclosureRow', 'TextShimmer', 'IconThinkOutlineRegular', 'MarkdownText'].map(name => [name, name])),
}
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: Object.keys(platform),
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => {
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell } = module.exports

function cell(blocks, { status = 'running', groupPart, hidden = false, step = 1, steps = [] } = {}) {
  const sessionId = 'chief'
  const roster = { bots: [], byId: { chief: { id: sessionId } }, roomsById: hidden ? { chief: {} } : {}, exchangeTurns: {} }
  return AssistantCell({
    node: { key: `step-${step}`, data: { turn: 1, step, status, blocks } }, sessionId, groupPart,
    useRoster: select => select(roster), useDisclosure: () => ({ expanded: false, toggle() {} }),
    useTurnSteps: () => steps,
    actions: {},
  })
}

function thinking(tree, expanded = false) {
  const row = tree.children.find(child => child && child.type.name === 'ThinkingRow')
  assert.ok(row, 'the reasoning row stays visible')
  return row.type({ ...row.props, useDisclosure: () => ({ expanded, toggle() {} }) })
}

test('live reasoning uses the native animated disclosure and shared shimmer', () => {
  const tree = cell([{ kind: 'reasoning', text: 'Check the request\nDetails' }])
  const row = thinking(tree)
  const disclosure = row.children.find(child => child?.type === 'DisclosureRow')
  assert.equal(disclosure.props.running, true)
  assert.equal(disclosure.props.open, false)
  assert.equal(disclosure.props.title, 'Thinking…')
  assert.equal(disclosure.props.expandOnRowClick, true)
  const preview = disclosure.props.collapsedContent.children[1]
  assert.equal(preview.children[0].type, 'TextShimmer')
  assert.equal(preview.children[0].children[0], 'Check the request')
})

test('the streaming preview updates incomplete lines as each chunk arrives', () => {
  for (const [text, want] of [
    ['Unfinished', 'Unfinished'],
    ['First\nDetails\n\nUnfinished', 'Unfinished'],
    ['First\n\n**Newest**\nDetails', 'Newest'],
    ['First\r\n \r\n\t\r\nNewest\r\n', 'Newest'],
    ['First\n\n\n', 'First'],
  ]) {
    const row = thinking(cell([{ kind: 'reasoning', text }]))
    const disclosure = row.children.find(child => child?.type === 'DisclosureRow')
    assert.equal(disclosure.props.collapsedContent.children[1].children[0].children[0], want)
  }
})

test('a following response or tool stops the reasoning shimmer even while the step runs', () => {
  for (const next of [{ kind: 'text', text: '' }, { kind: 'tool-call', name: 'read' }]) {
    const row = thinking(cell([{ kind: 'reasoning', text: 'First\n\nNewest\n' }, next], { groupPart: 'reasoning' }))
    const disclosure = row.children.find(child => child?.type === 'DisclosureRow')
    assert.equal(disclosure.props.running, false)
    assert.equal(disclosure.props.collapsedContent.children[1].children[0].children[0], 'First')
  }
})

test('empty live reasoning has an animated title, but an empty settled row has no gap', () => {
  const blocks = [{ kind: 'reasoning', text: '' }]
  const row = thinking(cell(blocks))
  assert.equal(row.children.find(child => child?.type === 'DisclosureRow').props.running, true)
  assert.equal(cell(blocks, { status: 'complete' }), null)
  assert.equal(cell(blocks, { hidden: true }), null)
  assert.equal(cell(blocks, { groupPart: 'response' }), null)
})

test('expanded reasoning keeps its disclosure state and renders compact streaming Markdown', () => {
  const text = '**First**\n\nDetails'
  for (const status of ['running', 'complete', 'interrupted']) {
    const row = thinking(cell([{ kind: 'reasoning', text }], { status }), true)
    const disclosure = row.children.find(child => child?.type === 'DisclosureRow')
    assert.equal(disclosure.props.open, true)
    const markdown = disclosure.children[0].children[0]
    assert.equal(markdown.type, 'MarkdownText')
    assert.equal(markdown.props.text, text)
    assert.equal(markdown.props.streaming, status === 'running')
    assert.equal(markdown.props.variant, 'compact')
  }
})

test('a long tool Turn keeps one disclosure with every loaded reasoning step in order', () => {
  const steps = Array.from({ length: 24 }, (_, index) => ({
    turn: 1, step: index + 1, status: 'settled',
    blocks: [{ kind: 'reasoning', text: `Reasoning ${index + 1}` }, { kind: 'tool-call', name: 'read' }],
  }))
  steps.at(-1).blocks.push({ kind: 'text', text: 'Final reply' })
  const trees = steps.map(data => cell(data.blocks, { ...data, steps }))
  assert.equal(trees.filter(tree => tree?.children.some(child => child?.type.name === 'ThinkingRow')).length, 1)
  const row = thinking(trees[0], true)
  const disclosure = row.children.find(child => child?.type === 'DisclosureRow')
  assert.equal(disclosure.children[0].children[0].props.text, steps.map((_, index) => `Reasoning ${index + 1}`).join('\n\n'))
  assert.ok(trees.at(-1).children.some(child => child?.type.name === 'Bubbles'), 'the final reply remains in place')
})

test('the Turn disclosure stays on its first loaded step while a later step streams', () => {
  const first = { turn: 1, step: 3, status: 'settled', blocks: [{ kind: 'text', text: 'Starting' }] }
  const latest = { turn: 1, step: 4, status: 'running', blocks: [{ kind: 'reasoning', text: '**Latest**\nDetails' }] }
  const steps = [first, latest]
  const row = thinking(cell(first.blocks, { ...first, steps }))
  assert.equal(row.props['data-state'], 'running')
  assert.equal(cell(latest.blocks, { ...latest, steps }), null)
  assert.equal(cell(first.blocks, { ...first, steps, groupPart: 'response' }).children.some(child => child?.type.name === 'ThinkingRow'), false)
  assert.equal(cell(first.blocks, { ...first, steps, hidden: true }), null)
})
