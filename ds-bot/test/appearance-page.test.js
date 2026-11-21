import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientBundle, makeStatefulReact } from './stateful-react.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// A slider or color rests this long before it saves (useResting), plus a margin.
const REST_MS = 400

async function load() {
  const code = await loadClientBundle("export { BackgroundEditor, ColorsSection } from './src/client/appearance-page.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? { createPortal: el => el } : harness.React))
  return { harness, ...mod.exports }
}

// The page's shell parts, reduced to their children.
const Row = ({ children }) => children
const Section = ({ children }) => children
const Choice = () => null

function find(tree, match) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = find(child, match)
      if (found) return found
    }
    return undefined
  }
  if (!tree || typeof tree !== 'object') return undefined
  if (match(tree)) return tree
  return find(tree.children ?? [], match)
}
const byLabel = (tree, label) => find(tree, node => node.props?.['aria-label'] === label)
const kindButton = (tree, kind) => find(tree, node => node.props?.['data-kind'] === kind)

function withDocument(t) {
  const before = { document: globalThis.document, FileReader: globalThis.FileReader }
  globalThis.document = { body: { hasAttribute: () => false } }
  t.after(() => Object.assign(globalThis, before))
}

const GRADIENT = { kind: 'gradient', from: '#223344', to: '#445566', angle: 90 }

test('a background slider that rests after "None" was picked changes nothing', async (t) => {
  withDocument(t)
  const { harness, BackgroundEditor } = await load()
  const saves = []
  const save = (background) => { saves.push(background); return new Promise(() => {}) }
  const draw = value => harness.render(harness.React.createElement(BackgroundEditor, { value, save, actions: {}, run: p => p, Row, Choice }))
  const tree = draw(GRADIENT)
  byLabel(tree, 'Dim').props.onChange({ target: { value: '40' } })
  kindButton(tree, 'none').props.onClick()
  await sleep(REST_MS)
  assert.deepEqual(saves, [null])
  harness.unmount()
})

test('a kind picked right after a slider keeps what the slider set', async (t) => {
  withDocument(t)
  const { harness, BackgroundEditor } = await load()
  const saves = []
  const save = (background) => { saves.push(background); return new Promise(() => {}) }
  const tree = harness.render(harness.React.createElement(BackgroundEditor, { value: GRADIENT, save, actions: {}, run: p => p, Row, Choice }))
  byLabel(tree, 'Surface opacity').props.onChange({ target: { value: '90' } })
  await sleep(REST_MS)
  // The opacity is sent and not back yet when the color is picked.
  kindButton(tree, 'color').props.onClick()
  assert.equal(saves.length, 2)
  assert.equal(saves[1].kind, 'color')
  assert.equal(saves[1].surface, 90)
  harness.unmount()
})

test('a picture still uploading gives way to a kind picked meanwhile; one that lands keeps the newest dim', async (t) => {
  withDocument(t)
  globalThis.FileReader = class {
    readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/png;base64,AA=='; this.onload() }) }
  }
  const { harness, BackgroundEditor } = await load()
  const saves = []
  const save = (background) => { saves.push(background); return new Promise(() => {}) }
  let uploaded
  const actions = { addBackground: () => new Promise((resolve) => { uploaded = resolve }) }
  const tree = harness.render(harness.React.createElement(BackgroundEditor, { value: GRADIENT, save, actions, run: p => p, Row, Choice }))
  const picker = find(tree, node => node.type === 'input' && node.props?.type === 'file')
  const file = { size: 10 }

  // "None" while the picture uploads: the picture does not come back afterwards.
  picker.props.onChange({ target: { files: [file], value: 'x' } })
  await sleep(5)
  kindButton(tree, 'none').props.onClick()
  uploaded({ id: 'a'.repeat(64) })
  await sleep(5)
  assert.deepEqual(saves, [null])

  // Dim moved while another picture uploads: the picture lands with it.
  harness.unmount()
  saves.length = 0
  const again = harness.render(harness.React.createElement(BackgroundEditor, { value: GRADIENT, save, actions, run: p => p, Row, Choice }))
  find(again, node => node.type === 'input' && node.props?.type === 'file').props.onChange({ target: { files: [file], value: 'x' } })
  await sleep(5)
  byLabel(again, 'Dim').props.onChange({ target: { value: '40' } })
  await sleep(REST_MS)
  uploaded({ id: 'b'.repeat(64) })
  await sleep(5)
  assert.deepEqual(saves.at(-1), { kind: 'image', image: 'b'.repeat(64), dim: 40 })
  harness.unmount()
})

test('a color typed in one theme is saved to it when another theme is picked before it rests', async (t) => {
  withDocument(t)
  const { harness, ColorsSection } = await load()
  const theme = label => ({
    label,
    light: { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' },
    dark: { bg: '#101010', sidebar: '#181818', bubble: '#262626', card: '#1c1c1c', text: '#f0f0f0', user: '#f0f0f0', userText: '#101010', accent: '#5b7bff' },
  })
  const themes = { 'my-dawn': theme('Dawn'), 'my-dusk': theme('Dusk') }
  const sent = []
  const actions = { setPrefs: (change) => { sent.push(change); return new Promise(() => {}) } }
  const draw = current => harness.render(harness.React.createElement(ColorsSection, { prefs: { theme: current, themes }, actions, run: p => p, Section, Row, Choice }))
  let tree = draw('my-dawn')
  byLabel(tree, 'Background color #RRGGBB').props.onChange({ target: { value: '#203040' } })
  tree = draw('my-dawn')
  byLabel(tree, 'Background color #RRGGBB').props.onBlur()
  // Dusk is picked before the change rests: it is saved at once, to Dawn, and Dusk stays in use.
  tree = draw('my-dusk')
  assert.equal(sent.length, 1)
  assert.deepEqual(Object.keys(sent[0].themes), ['my-dawn'])
  assert.equal(sent[0].themes['my-dawn'].light.bg, '#203040')
  assert.equal(sent[0].theme, undefined)
  // The field shows Dusk's color (each state an effect sets is drawn once more here).
  tree = draw('my-dusk')
  tree = draw('my-dusk')
  assert.equal(byLabel(tree, 'Background color #RRGGBB').props.value, '#FAFAFA')
  await sleep(REST_MS)
  assert.equal(sent.length, 1)
  harness.unmount()
})

test('two quick color changes both land when the first comes back before the second rests', async (t) => {
  withDocument(t)
  const { harness, ColorsSection } = await load()
  const colors = { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' }
  let themes = { 'my-dawn': { label: 'Dawn', light: colors, dark: colors } }
  const sent = []
  const back = []
  const actions = { setPrefs: (change) => { sent.push(change); return new Promise((resolve) => { back.push(resolve) }) } }
  const draw = () => harness.render(harness.React.createElement(ColorsSection, { prefs: { theme: 'my-dawn', themes }, actions, run: p => p, Section, Row, Choice }))
  // Both colors are picked on the same drawing, the second a moment after the first.
  const tree = draw()
  byLabel(tree, 'Background color').props.onChange({ target: { value: '#203040' } })
  await sleep(200)
  byLabel(tree, 'Text color').props.onChange({ target: { value: '#eeeeee' } })
  await sleep(250)
  // The background is saved and comes back before the text rests.
  assert.equal(sent.length, 1)
  themes = { 'my-dawn': { ...sent[0].themes['my-dawn'], light: sent[0].themes['my-dawn'].light } }
  back[0]()
  await sleep(5)
  draw()
  await sleep(REST_MS)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].themes['my-dawn'].light.bg, '#203040')
  assert.equal(sent[1].themes['my-dawn'].light.text, '#eeeeee')
  harness.unmount()
})
