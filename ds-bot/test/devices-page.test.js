import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DevicesPage, NodeRow, DevicesStrip, deviceSummary, sharedSessionLink } from './src/client/devices-page.js'",
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
const copied = []
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
  navigator: { clipboard: { writeText: async text => { copied.push(text) } } },
  URL,
}, { filename: 'bundle.cjs' })
const { DevicesPage, NodeRow, DevicesStrip, deviceSummary, sharedSessionLink } = module.exports

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
    for (const key of ['children', 'label', 'title', 'hint']) if (node.props?.[key]) texts(node.props[key], found)
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
      daemon: { command: 'npm run lan:daemon -- install --hub http://192.168.1.5:8787 --name other-pc' },
    },
  }
  const tree = render(DevicesPage, { roster, actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch })
  const found = texts(tree)
  assert.ok(found.includes('Enable multi-device on this computer'))
  assert.ok(found.includes('Listening'))
  assert.ok(found.includes('http://192.168.1.5:8787'))
  assert.ok(found.includes('Machines · 1'))
  assert.ok(found.includes('Machines run read-only commands directly: hostname, whoami, uname, echo (built in). Anything else asks you first.'))
  assert.ok(found.includes('npm run lan:daemon -- install --hub http://192.168.1.5:8787 --name other-pc'))
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

test('the sidebar strip shows how many paired machines are online and opens Devices', () => {
  const multiDevice = {
    available: true,
    enabled: true,
    nodes: [
      { id: 'nd_1', name: 'win-pc', online: true },
      { id: 'nd_2', name: 'old-mac', online: false },
    ],
  }
  assert.deepEqual(
    { ...deviceSummary(multiDevice), names: undefined },
    { available: true, enabled: true, total: 2, online: 1, names: undefined },
  )
  const opened = []
  const wide = render(DevicesStrip, { multiDevice, actions: { openSettings: page => opened.push(page) }, wide: true })
  assert.equal(wide.type, 'button')
  assert.ok(texts(wide).includes('Devices · 1 of 2 online'))
  assert.match(wide.props.title, /win-pc \(online\), old-mac \(offline\)/)
  wide.props.onClick()
  assert.deepEqual(opened, ['devices'])

  const rail = render(DevicesStrip, { multiDevice, actions: { openSettings: () => {} }, wide: false })
  assert.equal(texts(rail).includes('1'), true)
  assert.match(rail.props['aria-label'], /1 of 2 online/)
})

test('the sidebar strip stays out when multi-device is off or unavailable', () => {
  assert.equal(DevicesStrip({ multiDevice: { available: true, enabled: false, nodes: [] }, actions: {} }), null)
  assert.equal(DevicesStrip({ multiDevice: { available: false, enabled: true, nodes: [] }, actions: {} }), null)
  const none = render(DevicesStrip, { multiDevice: { available: true, enabled: true, nodes: [] }, actions: {}, wide: true })
  assert.ok(texts(none).includes('Devices · no machines paired'))
})

test('a session link is direct on the LAN and a port forward on loopback', () => {
  const direct = sharedSessionLink('http://192.168.1.5:3080')
  assert.equal(direct.kind, 'url')
  assert.equal(direct.url, 'http://192.168.1.5:3080')
  const loopback = sharedSessionLink('http://127.0.0.1:3080')
  assert.equal(loopback.kind, 'forward')
  assert.equal(loopback.port, '3080')
  assert.equal(loopback.command, 'ssh -L 3080:127.0.0.1:3080 <user>@<this-machine>')
  assert.equal(sharedSessionLink('http://localhost:3080').kind, 'forward')
  assert.equal(sharedSessionLink('http://[::1]:3080').kind, 'forward')
  assert.equal(sharedSessionLink('').kind, 'none')
  assert.equal(sharedSessionLink('not a url').kind, 'none')
  assert.equal(sharedSessionLink(undefined).kind, 'none')
})

test('the Devices page shows the shared address, or a port forward for a loopback server', () => {
  const base = {
    available: true,
    enabled: true,
    hub: { state: 'listening', url: 'http://192.168.1.5:8787' },
    nodes: [],
    policy: [],
  }
  const remote = render(DevicesPage, {
    roster: { multiDevice: { ...base, hub: { ...base.hub, webUrl: 'http://192.168.1.5:3080' } } },
    actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch,
  })
  assert.ok(texts(remote).includes('Other machines open this address in a browser to see the same conversation.'))
  assert.ok(texts(remote).includes('http://192.168.1.5:3080'))

  const local = render(DevicesPage, {
    roster: { multiDevice: { ...base, hub: { ...base.hub, webUrl: 'http://127.0.0.1:3080' } } },
    actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch,
  })
  assert.ok(texts(local).includes('This DSH Web listens on 127.0.0.1 only. On the other machine, forward the port first, then open this address.'))
  assert.ok(texts(local).includes('ssh -L 3080:127.0.0.1:3080 <user>@<this-machine>'))

  const none = render(DevicesPage, {
    roster: { multiDevice: base },
    actions: {}, run: promise => promise, Section: Frame, Row: Frame, Switch,
  })
  assert.ok(texts(none).includes('This DSH does not report a Web address. Start DSH Web on this computer, then reopen this page.'))
  assert.equal(texts(none).includes('Other machines open this address in a browser to see the same conversation.'), false)
})

test('the sidebar strip copies the shared address', async () => {
  copied.length = 0
  const multiDevice = {
    available: true,
    enabled: true,
    nodes: [{ id: 'nd_1', name: 'win-pc', online: true }],
    hub: { webUrl: 'http://192.168.1.5:3080' },
  }
  const tree = render(DevicesStrip, { multiDevice, actions: {}, wide: true })
  const [, copy] = tree.props.children
  assert.equal(copy.props['aria-label'], 'Copy session link')
  copy.props.onClick()
  await Promise.resolve()
  assert.deepEqual(copied, ['http://192.168.1.5:3080'])

  // A loopback server has no address another machine can open, so there is no copy button.
  const local = render(DevicesStrip, { multiDevice: { ...multiDevice, hub: { webUrl: 'http://127.0.0.1:3080' } }, actions: {}, wide: true })
  assert.equal(local.type, 'button')
})
