import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DevicesPage, NodeRow } from './src/client/devices-page.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
  useCallback: fn => fn,
  useEffect: (make, deps) => effect(make, deps ?? []),
  useState: initial => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = next }]
  },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
}, { filename: 'bundle.cjs' })
const { DevicesPage, NodeRow } = module.exports

function render(component, props) {
  current = { index: 0, slots: [], effects: [] }
  // The page's polling lives in an effect, and this harness never runs effects; the
  // render itself must not start a timer.
  return component(props)
}

const texts = (node, found = []) => {
  if (typeof node === 'string' || typeof node === 'number') found.push(String(node))
  if (Array.isArray(node)) node.forEach(item => texts(item, found))
  if (node && typeof node === 'object') {
    for (const key of ['children', 'label', 'title']) if (node.props?.[key]) texts(node.props[key], found)
  }
  return found
}
const buttons = (node, found = []) => {
  if (Array.isArray(node)) node.forEach(item => buttons(item, found))
  if (node && typeof node === 'object') {
    if (node.type === 'button') found.push(texts(node).join(''))
    for (const key of ['children', 'label', 'title']) if (node.props?.[key]) buttons(node.props[key], found)
  }
  return found
}

const Frame = ({ children }) => ({ type: 'row', props: { children } })
const Switch = ({ label }) => ({ type: 'switch', props: { label } })

test('the Devices page shows the switch, the hub address and each machine', () => {
  const roster = {
    multiDevice: {
      available: true,
      enabled: true,
      hub: { state: 'listening', url: 'http://192.168.1.5:8787', localUrl: 'http://127.0.0.1:8787' },
      nodes: [{ id: 'nd_1', name: 'win-pc', hostname: 'WIN-PC', os: 'win32', arch: 'x64', online: true }],
      policy: ['hostname', 'whoami', 'uname', 'echo (built in)'],
    },
  }
  const tree = render(DevicesPage, { roster, actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch })
  const found = texts(tree)
  assert.ok(found.includes('Enable multi-device on this computer'))
  assert.ok(found.includes('Listening'))
  assert.ok(found.includes('http://192.168.1.5:8787'))
  assert.ok(found.includes('Machines · 1'))
  assert.ok(found.includes('Machines run only hostname, whoami, uname, echo (built in). No shell, no other program.'))
  assert.ok(buttons(tree).includes('Add machine'))

  const row = render(NodeRow, { node: roster.multiDevice.nodes[0], confirming: false, busy: false, onRemove: () => {} })
  assert.ok(texts(row).includes('win-pc'))
  assert.ok(texts(row).includes('WIN-PC · win32/x64'))
  assert.ok(texts(row).includes('Online'))
  assert.ok(buttons(row).includes('Remove'))
})

test('the Devices page keeps the switch and the add button out when multi-device is off', () => {
  const roster = { multiDevice: { available: false, enabled: false, hub: { state: 'off' }, nodes: [], policy: [] } }
  const tree = render(DevicesPage, { roster, actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch })
  const found = texts(tree)
  assert.ok(found.includes('This computer is set up without multi-device (multiDevice: false).'))
  assert.equal(buttons(tree).includes('Add machine'), false)
})
