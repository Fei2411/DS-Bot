import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/kept-private.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
// State survives between renders, as in a mounted component; effects never run.
let slots = []
let index = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: (initial) => {
    const at = index
    index += 1
    slots[at] ??= { value: initial }
    return [slots[at].value, (next) => { slots[at].value = next }]
  },
  useEffect() {},
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}) })
const { KeptPrivateSection } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}

function mount(privateArchives) {
  slots = []
  const released = []
  const props = {
    roster: { privateArchives }, actions: { releasePrivate: (id) => { released.push(id); return Promise.resolve() } },
    run: fn => fn, Section: 'Section', Row: 'Row',
  }
  const render = () => {
    index = 0
    return KeptPrivateSection(props)
  }
  return { released, render, nodes: () => walk(render()) }
}

test('nothing is listed while no private Bot has been deleted', () => {
  assert.equal(mount([]).render(), null)
  assert.equal(mount(undefined).render(), null)
})

test('each kept place is listed and is lifted by a second click', () => {
  const { released, nodes } = mount([{ id: 'x', name: 'Diary', workDir: '/diary' }, { id: 'y', name: 'Ledger' }])
  const shown = nodes()
  assert.equal(shown.find(node => node.type === 'Section').props.title, 'Closed after deletion · 2')
  const rows = shown.filter(node => node.type === 'Row')
  assert.deepEqual(rows.map(row => [row.props.label, row.props.hint]), [['Diary', '/diary'], ['Ledger', undefined]])

  shown.filter(node => node.type === 'button')[0].props.onClick()
  assert.deepEqual(released, [])
  const asked = nodes()
  assert.match(asked.filter(node => node.type === 'Row')[0].props.hint, /Click again to remove/)
  // Asking about one entry leaves the other as it was.
  assert.equal(asked.filter(node => node.type === 'Row')[1].props.hint, undefined)

  asked.filter(node => node.type === 'button')[0].props.onClick()
  assert.deepEqual(released, ['x'])
  assert.equal(nodes().filter(node => node.type === 'Row')[0].props.hint, '/diary')
})

test('a click on another entry moves the question to it instead of lifting the first', () => {
  const { released, nodes } = mount([{ id: 'x', name: 'Diary' }, { id: 'y', name: 'Ledger' }])
  nodes().filter(node => node.type === 'button')[0].props.onClick()
  nodes().filter(node => node.type === 'button')[1].props.onClick()
  assert.deepEqual(released, [])
  nodes().filter(node => node.type === 'button')[1].props.onClick()
  assert.deepEqual(released, ['y'])
})
