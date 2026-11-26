import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/about.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useLayoutEffect: () => {},
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    return {}
  },
})
const { AboutPage, ownAppRow } = module.exports

// The DS Bot row in Settings → About, with the row's hint and its buttons' text, class
// and clicks. `update` is the value the update source holds.
function page(update) {
  const calls = []
  const actions = new Proxy({ repoStars: async () => null }, {
    get: (target, name) => target[name] ?? ((...args) => calls.push(args.length > 0 ? [name, ...args] : name)),
  })
  const run = promise => promise
  const tree = AboutPage({ useUpdate: select => select(update), actions, run, Section: 'section', Row: 'row', Switch: 'switch' })
  const find = (node, pick) => (Array.isArray(node) ? node.flatMap(one => find(one, pick))
    : node && typeof node === 'object' ? [...pick(node), ...find(node.children, pick)] : [])
  const [row] = find(tree, node => (node.props?.label === 'DS Bot' ? [node] : []))
  const [autoRow] = find(tree, node => (node.props?.label === 'Automatic updates' ? [node] : []))
  const [autoSwitch] = find(autoRow?.children ?? [], node => (node.type === 'switch' ? [node] : []))
  const buttons = find(row?.children ?? [], node => (node.type === 'button' ? [node] : []))
  return {
    hint: row?.props?.hint,
    buttons: buttons.map(node => ({ text: node.children[0], className: node.props.className, click: () => node.props.onClick() })),
    autoSwitch: autoSwitch ? { on: autoSwitch.props.on, toggle: next => autoSwitch.props.onChange(next) } : null,
    calls,
  }
}

// 公开#499: in the desktop app the DS Bot row shows the app's own update state.
test('the app update states set the DS Bot row\'s hint and button', () => {
  const cases = [
    [{ phase: 'idle', autoUpdate: false }, 'Automatic updates are off.',
      [{ text: 'Check for updates', className: 'bt-soft bt-soft-sm', action: 'checkOwnApp' }]],
    [{ phase: 'checking', autoUpdate: true }, 'Checking for updates…', []],
    [{ phase: 'current', autoUpdate: true }, 'Up to date', [{ text: 'Check for updates', className: 'bt-soft bt-soft-sm', action: 'checkOwnApp' }]],
    [{ phase: 'downloading', version: '0.2.2', autoUpdate: true }, 'Downloading 0.2.2…', []],
    [{ phase: 'downloaded', version: '0.2.2', autoUpdate: true, autoInstall: true }, '0.2.2 is ready; it installs when you restart',
      [{ text: 'Restart to update', className: 'bt-fb-primary', action: 'installOwnApp' }]],
    [{ phase: 'downloaded', version: '0.2.2', autoUpdate: false, autoInstall: false }, '0.2.2 is ready',
      [{ text: 'Restart to update', className: 'bt-fb-primary', action: 'installOwnApp' }]],
    [{ phase: 'available', version: '0.2.2', canDownload: true, autoUpdate: false }, '0.2.2 is available',
      [{ text: 'Download', className: 'bt-soft bt-soft-sm', action: 'downloadOwnApp' }]],
    [{ phase: 'available', version: '0.2.2', page: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.2.2', autoUpdate: true }, '0.2.2 is available',
      [{ text: 'Download', className: 'bt-soft bt-soft-sm', action: 'openOwnApp' }]],
    [{ phase: 'failed', autoUpdate: true }, 'Could not check for updates.', [{ text: 'Check for updates', className: 'bt-soft bt-soft-sm', action: 'checkOwnApp' }]],
  ]
  for (const [ownApp, hint, buttons] of cases) {
    const view = page({ source: 'app', ownApp })
    assert.equal(view.hint, hint)
    assert.equal(view.buttons.length, buttons.length)
    assert.equal(view.autoSwitch?.on, ownApp.autoUpdate)
    for (const [index, expected] of buttons.entries()) {
      assert.equal(view.buttons[index].text, expected.text)
      assert.equal(view.buttons[index].className, expected.className)
      view.buttons[index].click()
      assert.deepEqual(view.calls, [expected.action])
      view.calls.length = 0
    }
  }
})

test('automatic updates switch calls setOwnAppAutoUpdate and stays hidden outside the app', () => {
  const onView = page({ source: 'app', ownApp: { phase: 'current', autoUpdate: true } })
  assert.equal(onView.autoSwitch?.on, true)
  onView.autoSwitch.toggle(false)
  assert.deepEqual(onView.calls, [['setOwnAppAutoUpdate', false]])

  const offView = page({ source: 'app', ownApp: { phase: 'idle', autoUpdate: false } })
  assert.equal(offView.autoSwitch?.on, false)
  offView.autoSwitch.toggle(true)
  assert.deepEqual(offView.calls, [['setOwnAppAutoUpdate', true]])

  const webView = page({ source: 'registry', checkedAt: Date.now(), latest: '0.2.1', ownApp: { phase: 'current', autoUpdate: true } })
  assert.equal(webView.autoSwitch, null)

  const legacyView = page({ source: 'app', ownApp: { phase: 'current' } })
  assert.equal(legacyView.autoSwitch, null)
})

test('without an app update state the row keeps today\'s text and no button', () => {
  for (const ownApp of [undefined, null, 'checking', {}]) {
    const view = page({ source: 'app', ownApp })
    assert.equal(view.hint, 'Updates come with the DS Bot app.')
    assert.deepEqual(view.buttons, [])
  }
})

test('an app update state is ignored outside the app', () => {
  const view = page({ source: 'registry', checkedAt: Date.now(), latest: '0.2.1', ownApp: { phase: 'downloaded', version: '0.2.2' } })
  assert.match(view.hint, /^Up to date · Checked /)
  assert.equal(view.buttons.length, 1)
  assert.equal(view.buttons[0].text, 'Check for updates')
})

test('ownAppRow maps each phase to its hint and button kind', () => {
  assert.equal(ownAppRow(null), null)
  assert.equal(ownAppRow('downloaded'), null)
  // The bundled module's realm has its own Object, so compare the fields.
  const checking = ownAppRow({ phase: 'checking' })
  assert.equal(checking.hint, 'Checking for updates…')
  assert.equal(checking.button, null)
  const downloaded = ownAppRow({ phase: 'downloaded', version: '0.2.2' })
  assert.equal(downloaded.hint, '0.2.2 is ready; it installs when you restart')
  assert.equal(downloaded.button, 'restart')
})

test('inlineFeedback hides the redundant Report a problem link row', () => {
  const find = (node, pick) => (Array.isArray(node) ? node.flatMap(one => find(one, pick))
    : node && typeof node === 'object' ? [...pick(node), ...find(node.children, pick)] : [])
  const actions = { repoStars: async () => null, openSettings() {} }
  const standalone = AboutPage({ useUpdate: s => s({}), actions, run: p => p, Section: 'section', Row: 'row' })
  const inline = AboutPage({ useUpdate: s => s({}), actions, run: p => p, Section: 'section', Row: 'row', inlineFeedback: true })
  assert.equal(find(standalone, n => (n.props?.label === 'Report a problem' ? [n] : [])).length, 1)
  assert.equal(find(inline, n => (n.props?.label === 'Report a problem' ? [n] : [])).length, 0)
})
