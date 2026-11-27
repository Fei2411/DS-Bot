import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientBundle, makeStatefulReact } from './stateful-react.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// A slider or color rests this long before it saves (useResting), plus a margin.
const REST_MS = 400

async function load() {
  const code = await loadClientBundle(`
    export { APPEARANCE_PAGE_CSS, AppearancePage, BackgroundEditor, CODE_FONT_PRESETS, ColorsSection, FontField, UI_FONT_PRESETS } from './src/client/appearance-page.js'
    export { triggerColorMorph } from './src/client/appearance.js'
  `)
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
const textOfNode = node => (typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOfNode).join('') : (node?.children ?? []).map(textOfNode).join(''))
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

test('AppearancePage makes the entire ThemeCard clickable, removes noisy notes, and labels More/Fewer settings', async (t) => {
  withDocument(t)
  const { harness, AppearancePage } = await load()
  const textOf = node => (typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : (node?.children ?? []).map(textOf).join(''))
  const findAll = (node, match, out = []) => {
    if (Array.isArray(node)) { for (const c of node) findAll(c, match, out); return out }
    if (!node || typeof node !== 'object') return out
    if (match(node)) out.push(node)
    findAll(node.children ?? [], match, out)
    return out
  }
  const picked = []
  const actions = { setPrefs: change => { picked.push(change); return Promise.resolve() } }
  const colors = { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' }
  const roster = {
    bots: [{ id: 'chief', name: 'Chief' }],
    byId: { chief: { id: 'chief', name: 'Chief' } },
    mainBotIds: ['chief'],
    prefs: { theme: 'deepseek', themes: { 'my-custom': { label: 'Custom', light: colors, dark: colors } } },
  }
  const RowWithHint = ({ label, hint, children }) => harness.React.createElement('div', { 'data-row': label, 'data-hint': hint }, children)
  const SwitchStub = () => null
  const draw = () => harness.render(harness.React.createElement(AppearancePage, {
    roster, actions, run: p => p, Section, Row: RowWithHint, Choice, Switch: SwitchStub, ownWindow: true,
  }))
  let tree = draw()
  const fullText = textOf(tree)
  assert.equal(fullText.includes('Changing a color saves a theme of your own'), false)
  assert.equal(find(tree, n => n.props?.['data-row'] === 'Accent').props['data-hint'], undefined)

  // Built-in theme card (Mono) is one full-card <button> containing both swatch and label.
  const monoBtn = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-look-theme' && textOf(n) === 'Mono')[0]
  assert.ok(monoBtn, 'built-in ThemeCard should be a full-card button')
  assert.ok(find(monoBtn, n => n.props?.className === 'bt-look-tname'), 'label lives inside the clickable button')
  monoBtn.props.onClick()
  assert.deepEqual(picked.at(-1), { theme: 'mono' })

  // Custom theme card wraps swatch + name in a pick button and isolates OwnThemeActions without nested buttons.
  const customPick = findAll(tree, n => n.type === 'button' && n.props?.className === 'bt-look-theme-pick' && textOf(n) === 'Custom')[0]
  assert.ok(customPick, 'custom ThemeCard should expose a full-width pick button covering swatch + title')
  assert.equal(findAll(customPick, n => n.type === 'button' && n !== customPick).length, 0, 'no nested <button> tags')
  customPick.props.onClick({ stopPropagation() {} })
  assert.deepEqual(picked.at(-1), { theme: 'my-custom' })

  // Row 1 uses "Color mode" instead of repeating the page title "Appearance".
  assert.ok(find(tree, n => n.props?.['data-row'] === 'Color mode'), 'first row should be labeled Color mode')

  // More settings / Fewer settings full-width footer button toggles cleanly.
  const moreBtn = () => findAll(tree, n => n.type === 'button' && String(n.props?.className ?? '').split(' ').includes('bt-look-more'))[0]
  assert.equal(textOf(moreBtn()), 'More settings')
  moreBtn().props.onClick()
  tree = draw()
  assert.equal(textOf(moreBtn()), 'Fewer settings')

  // Corners slider and misnamed "Shape and density" section are removed; Density stays cleanly.
  assert.equal(find(tree, n => n.props?.['data-row'] === 'Corners'), undefined, 'Corners slider must be removed')
  assert.equal(fullText.includes('Shape and density'), false, 'Shape and density heading must be removed')
  assert.ok(find(tree, n => n.props?.['data-row'] === 'Density'), 'Density control stays rendered')

  // Custom CSS renders label, hint, and textarea in one unified stacked row without a split divider.
  const cssRow = find(tree, n => String(n.props?.className ?? '').includes('bt-look-css-row'))
  assert.ok(cssRow, 'StylesheetField wraps label + hint + textarea in bt-look-css-row')
  assert.ok(find(cssRow, n => n.type === 'textarea' && n.props?.['aria-label'] === 'Your stylesheet'))
  assert.equal(find(tree, n => n.props?.['data-row'] === 'Your stylesheet'), undefined, 'no separate header Row above textarea')

  // Interface motion and Bot animation both increase monotonically from left to right.
  const choices = new Map()
  const CaptureChoice = ({ label, options }) => { choices.set(label, options); return null }
  harness.render(harness.React.createElement(AppearancePage, {
    roster, actions, run: p => p, Section, Row: RowWithHint, Choice: CaptureChoice, Switch: SwitchStub, ownWindow: true,
  }))
  assert.deepEqual(choices.get('Interface motion').map(([id]) => id), ['off', 'reduced', 'full'])
  assert.deepEqual(choices.get('Bot animation').map(([id]) => id), ['quiet', 'normal', 'lively'])
  harness.unmount()
})

test('FontField provides a searchable portaled dropdown with presets, local fonts, and custom font fallback', async (t) => {
  withDocument(t)
  const { harness, FontField, UI_FONT_PRESETS, CODE_FONT_PRESETS } = await load()
  const textOf = node => (typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : (node?.children ?? []).map(textOf).join(''))
  const findAll = (node, match, out = []) => {
    if (Array.isArray(node)) { for (const c of node) findAll(c, match, out); return out }
    if (!node || typeof node !== 'object') return out
    if (match(node)) out.push(node)
    findAll(node.children ?? [], match, out)
    return out
  }
  const saved = []
  let loadedCount = 0
  let currentValue = undefined
  const draw = (kind = 'ui') => harness.render(harness.React.createElement(FontField, {
    label: kind === 'code' ? 'Code font' : 'Interface font',
    kind,
    value: currentValue,
    fonts: ['Inter', 'Avenir Next', 'Menlo', 'Zed Sans'],
    load: () => { loadedCount += 1 },
    save: next => { saved.push(next); currentValue = next ?? undefined },
  }))

  let tree = draw('ui')
  assert.equal(find(tree, n => n.type === 'datalist'), undefined, 'no raw datalist')
  const trigger = find(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-look-font-btn'))
  assert.ok(trigger, 'renders SelectMenu-style trigger button')
  assert.equal(textOf(trigger), 'System default')

  // Opening triggers local font discovery and renders Recommended + deduplicated Installed groups.
  trigger.props.onClick()
  tree = draw('ui')
  assert.equal(loadedCount, 1)
  const options = findAll(tree, n => n.type === 'button' && n.props?.role === 'option')
  assert.ok(options.some(opt => opt.props['data-font-value'] === '' && opt.props['aria-selected'] === true))
  for (const preset of UI_FONT_PRESETS) {
    assert.ok(options.some(opt => opt.props['data-font-value'] === preset), `includes UI preset ${preset}`)
  }
  // Inter is deduplicated out of Installed fonts; Avenir Next and Zed Sans stay in Installed fonts.
  assert.equal(options.filter(opt => opt.props['data-font-value'] === 'Inter').length, 1)
  assert.ok(options.some(opt => opt.props['data-font-value'] === 'Avenir Next'))
  assert.ok(options.some(opt => opt.props['data-font-value'] === 'Zed Sans'))

  // Picking a preset saves it and renders it in its own fontFamily on the trigger.
  options.find(opt => opt.props['data-font-value'] === 'Inter').props.onClick()
  assert.deepEqual(saved, ['Inter'])
  tree = draw('ui')
  const triggerAfter = find(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-look-font-btn'))
  assert.equal(textOf(triggerAfter), 'Inter')

  // Reopen, search for a custom font not in list, and pick via Enter.
  triggerAfter.props.onClick()
  tree = draw('ui')
  const searchInput = find(tree, n => n.type === 'input' && n.props?.className === 'bt-font-search-input')
  assert.ok(searchInput)
  searchInput.props.onChange({ target: { value: 'IBM Plex Sans' } })
  tree = draw('ui')
  const customOpt = find(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-font-custom-opt'))
  assert.ok(customOpt, 'shows Custom font… option for unmatched valid font')
  find(tree, n => n.type === 'input' && n.props?.className === 'bt-font-search-input').props.onKeyDown({
    key: 'Enter', isComposing: false, preventDefault() {}, stopPropagation() {},
  })
  assert.deepEqual(saved, ['Inter', 'IBM Plex Sans'])

  // Invalid CSS characters yield No matching fonts and no custom option.
  tree = draw('ui')
  find(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-look-font-btn')).props.onClick()
  tree = draw('ui')
  find(tree, n => n.type === 'input' && n.props?.className === 'bt-font-search-input').props.onChange({ target: { value: 'Bad;Font{}' } })
  tree = draw('ui')
  assert.equal(find(tree, n => String(n.props?.className ?? '').includes('bt-font-custom-opt')), undefined)
  assert.ok(find(tree, n => n.props?.className === 'bt-font-empty'))

  // Code font picker shows code presets (JetBrains Mono, SF Mono, etc.).
  harness.unmount()
  currentValue = undefined
  tree = draw('code')
  find(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-look-font-btn')).props.onClick()
  tree = draw('code')
  const codeOptions = findAll(tree, n => n.type === 'button' && n.props?.role === 'option')
  for (const preset of CODE_FONT_PRESETS) {
    assert.ok(codeOptions.some(opt => opt.props['data-font-value'] === preset), `includes code preset ${preset}`)
  }
  harness.unmount()
})

test('triggerColorMorph sets and clears data-bt-color-morph and respects effects=off and reduced motion', async () => {
  const { APPEARANCE_PAGE_CSS, triggerColorMorph } = await load()
  assert.match(APPEARANCE_PAGE_CSS, /@keyframes bt-swatch-pop/)
  assert.match(APPEARANCE_PAGE_CSS, /body\[data-bt-color-morph\]/)

  const attrs = new Map()
  const body = {
    dataset: {},
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: k => attrs.delete(k),
  }
  assert.equal(triggerColorMorph(20, { body }, { matchMedia: () => ({ matches: false }) }), true)
  assert.equal(attrs.has('data-bt-color-morph'), true)
  await sleep(35)
  assert.equal(attrs.has('data-bt-color-morph'), false)

  // Disabled when effects=off.
  body.dataset.btEffects = 'off'
  assert.equal(triggerColorMorph(20, { body }, { matchMedia: () => ({ matches: false }) }), false)
  assert.equal(attrs.has('data-bt-color-morph'), false)

  // Disabled when prefers-reduced-motion: reduce.
  delete body.dataset.btEffects
  assert.equal(triggerColorMorph(20, { body }, { matchMedia: () => ({ matches: true }) }), false)
  assert.equal(attrs.has('data-bt-color-morph'), false)
})

test('Derive from 2 colors rebuilds the mode palette through the same save path as a color edit', async (t) => {
  withDocument(t)
  const { harness, ColorsSection } = await load()
  const colors = { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' }
  const themes = { 'my-dawn': { label: 'Dawn', light: colors, dark: colors, own: true } }
  const sent = []
  const actions = { setPrefs: (change) => { sent.push(change); return Promise.resolve() } }
  const draw = () => harness.render(harness.React.createElement(ColorsSection, { prefs: { theme: 'my-dawn', themes }, actions, run: p => p, Section, Row, Choice }))
  let tree = draw()
  const canvasWell = find(tree, node => node.props?.['data-derive'] === 'canvas')
  const accentWell = find(tree, node => node.props?.['data-derive'] === 'accent')
  assert.ok(canvasWell && accentWell, 'the derive row shows a canvas and an accent well')
  assert.equal(canvasWell.props.value, '#fafafa', 'prefilled with the current background')
  const deriveButton = find(tree, node => node.type === 'button' && textOfNode(node) === 'Derive')
  assert.ok(deriveButton, 'the derive button is there')
  canvasWell.props.onChange({ target: { value: '#101418' } })
  accentWell.props.onChange({ target: { value: '#ff8a2e' } })
  tree = draw()
  find(tree, node => node.type === 'button' && textOfNode(node) === 'Derive').props.onClick()
  await sleep(5)
  assert.equal(sent.length, 1)
  const saved = sent[0].themes['my-dawn']
  assert.equal(sent[0].accent, null, 'the team accent gives way to the derived one')
  assert.equal(saved.light.bg, '#101418', 'the canvas is taken over exactly')
  assert.equal(saved.light.accent, '#ff8a2e')
  assert.equal(saved.light.user, '#ff8a2e')
  assert.equal(saved.light.sidebar === '#101418', false, 'surfaces step off the canvas')
  assert.equal(saved.base, undefined)
  assert.equal(saved.light.base, undefined, 'a derived palette starts without move-basics anchors')
  // Only the edited mode is derived; the other one is untouched.
  assert.deepEqual(saved.dark, colors)
  harness.unmount()
})

test('theme import accepts both ds-bot theme files and VS Code themes', async (t) => {
  withDocument(t)
  globalThis.FileReader = class {
    readAsText(file) { queueMicrotask(() => { this.result = file.text; this.onload() }) }
    readAsDataURL() { queueMicrotask(() => { this.result = 'data:,'; this.onload() }) }
  }
  const { harness, AppearancePage } = await load()
  const sent = []
  const actions = { setPrefs: (change) => { sent.push(change); return Promise.resolve() } }
  const roster = { bots: [], byId: {}, mainBotIds: [], prefs: { theme: 'deepseek' } }
  const errors = []
  const run = p => p.catch(error => errors.push(error))
  const draw = () => harness.render(harness.React.createElement(AppearancePage, {
    roster, actions, run, Section, Row, Choice, Switch: () => null, ownWindow: false,
  }))
  const tree = draw()
  const picker = find(tree, node => node.type === 'input' && node.props?.type === 'file' && node.props?.accept === 'application/json,.json,.jsonc')
  assert.ok(picker, 'the import file input is there')

  // A VS Code theme imports as a theme of your own, without touching the appearance.
  picker.props.onChange({ target: { files: [{ text: '{ "name": "One Dark Pro", "type": "dark", "colors": { "editor.background": "#282c34", "editor.foreground": "#abb2bf" } }' }], value: 'x' } })
  await sleep(10)
  assert.equal(sent.length, 1)
  const vscode = sent[0]
  assert.match(Object.keys(vscode.themes)[0], /^my-/)
  const vscodeTheme = Object.values(vscode.themes)[0]
  assert.equal(vscodeTheme.label, 'One Dark Pro')
  assert.equal(vscodeTheme.dark.bg, '#282c34')
  assert.equal(vscodeTheme.dark.text, '#abb2bf')
  assert.ok(/^#[0-9a-f]{6}$/.test(vscodeTheme.light.bg), 'the light side is derived')
  assert.equal(vscode.appearance, undefined, 'a VS Code theme carries no appearance: the teams stays as it is')
  assert.equal(vscode.accent, null)

  // A ds-bot theme file imports as before, with its appearance along.
  const colors = { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' }
  const file = { format: 'ds-bot-theme', version: 1, theme: { label: 'Dusk', light: colors, dark: colors }, appearance: { radius: 40 } }
  picker.props.onChange({ target: { files: [{ text: JSON.stringify(file) }], value: 'x' } })
  await sleep(10)
  assert.equal(sent.length, 2)
  const dsbot = sent[1]
  assert.equal(Object.values(dsbot.themes)[0].label, 'Dusk')
  assert.equal(dsbot.appearance.radius, 40, 'the file appearance is applied')
  assert.equal(dsbot.appearance.density, null, 'fields the file leaves out go back to default')

  // Neither kind: the friendly refusal surfaces, and nothing is saved.
  picker.props.onChange({ target: { files: [{ text: 'definitely not json' }], value: 'x' } })
  await sleep(10)
  assert.equal(sent.length, 2)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /not a DS Bot theme/)
  harness.unmount()
})

test('the derive wells resync when the palette changes under them', async (t) => {
  withDocument(t)
  const { harness, ColorsSection } = await load()
  const dawn = { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' }
  const dusk = { bg: '#101010', sidebar: '#181818', bubble: '#262626', card: '#1c1c1c', text: '#f0f0f0', user: '#f0f0f0', userText: '#101010', accent: '#5b7bff' }
  let prefs = { theme: 'my-dawn', themes: { 'my-dawn': { label: 'Dawn', light: dawn, dark: dawn, own: true }, 'my-dusk': { label: 'Dusk', light: dusk, dark: dusk, own: true } } }
  const actions = { setPrefs: () => Promise.resolve() }
  const draw = () => harness.render(harness.React.createElement(ColorsSection, { prefs, actions, run: p => p, Section, Row, Choice }))
  let tree = draw()
  assert.equal(find(tree, node => node.props?.['data-derive'] === 'canvas').props.value, '#fafafa')
  // Another theme is picked: the wells follow its palette without remounting the section.
  prefs = { ...prefs, theme: 'my-dusk' }
  tree = draw()
  tree = draw() // the resync effect commits after the first draw, so the state shows on the next
  assert.equal(find(tree, node => node.props?.['data-derive'] === 'canvas').props.value, '#101010')
  assert.equal(find(tree, node => node.props?.['data-derive'] === 'accent').props.value, '#5b7bff')
  harness.unmount()
})
