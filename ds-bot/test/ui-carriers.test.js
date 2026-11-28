import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientBundle, makeStatefulReact } from './stateful-react.js'

const code = await loadClientBundle(`
  export * from './src/client/ui/index.js'
`)

function loadUi(extraGlobals = {}) {
  const fake = makeStatefulReact()
  const mod = { exports: {} }
  const globals = {
    document: { activeElement: null, body: null, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: fn => { fn(); return 1 },
    cancelAnimationFrame() {},
    ...extraGlobals,
  }
  const ReactDOM = { createPortal: node => node }
  const fn = new Function('module', 'exports', 'require', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', code)
  fn(mod, mod.exports, id => (id === 'react-dom' ? ReactDOM : fake.React), globals.document, globals.window, globals.requestAnimationFrame, globals.cancelAnimationFrame)
  const render = (Component, props, ...children) => fake.render(fake.React.createElement(Component, props, ...children))
  return { ui: mod.exports, fake, h: fake.React.createElement, render }
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

test('UI_CSS bundles all canonical carrier stylesheets', () => {
  const { ui } = loadUi()
  assert.match(ui.UI_CSS, /\.bt-island-pod-bar/)
  assert.match(ui.UI_CSS, /\.bt-card-dock/)
  assert.match(ui.UI_CSS, /\.bt-slider-row/)
  assert.match(ui.UI_CSS, /\.bt-ui-dialog-mask/)
  assert.match(ui.UI_CSS, /\.bt-ui-search/)
})

test('ActionCard and SettledCard render unified card anatomy and actions', () => {
  const { ui, render } = loadUi()
  const clicks = []
  let dismissed = 0
  const tree = render(ui.ActionCard, {
    mode: 'dock',
    title: 'Confirm action',
    detail: 'Runs a command',
    error: 'Failed once',
    onDismiss: () => { dismissed += 1 },
    buttons: [
      { label: 'Cancel', variant: 'secondary', onClick: () => clicks.push('cancel') },
      { label: 'Allow', variant: 'primary', onClick: () => clicks.push('allow') },
    ],
  })
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bt-q-dock')).length, 1)
  assert.equal(findAll(tree, n => String(n.props?.className ?? '').includes('bt-q-raised')).length, 1)
  assert.equal(textOf(findAll(tree, n => n.props?.className === 'bt-q-title')[0]), 'Confirm action')
  assert.equal(textOf(findAll(tree, n => n.props?.className === 'bt-card-error')[0]), 'Failed once')
  const dismissBtn = findAll(tree, n => n.props?.className === 'bt-q-x')[0]
  dismissBtn.props.onClick()
  assert.equal(dismissed, 1)
  const allowBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Allow')[0]
  allowBtn.props.onClick()
  assert.deepEqual(clicks, ['allow'])

  const settled = render(ui.SettledCard, {
    title: 'Action approved',
    checked: true,
    answered: true,
  })
  assert.equal(findAll(settled, n => String(n.props?.className ?? '').includes('bt-q-settled')).length, 1)
  assert.equal(findAll(settled, n => n.props?.className === 'bt-q-check').length, 1)
})

test('Slider supports both continuous numeric mode and discrete stops mode', () => {
  const { ui, render } = loadUi()
  const changes = []
  const continuous = render(ui.Slider, {
    label: 'Font size',
    value: 14,
    min: 12,
    max: 20,
    step: 2,
    onChange: v => changes.push(v),
  })
  const sliderEl = findAll(continuous, n => n.props?.role === 'slider')[0]
  assert.equal(sliderEl.props['aria-valuenow'], 14)
  sliderEl.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} })
  sliderEl.props.onKeyDown({ key: 'End', preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(changes, [16, 20])

  const picked = []
  const stepped = render(ui.Slider, {
    label: 'Thinking',
    headerLabel: 'Thinking',
    stops: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    value: 'low',
    onChange: v => picked.push(v),
    onReset: () => picked.push('reset'),
  })
  const stepSlider = findAll(stepped, n => n.props?.role === 'slider')[0]
  assert.equal(stepSlider.props['aria-valuetext'], 'Low')
  stepSlider.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} })
  const resetBtn = findAll(stepped, n => String(n.props?.className ?? '').includes('bt-slider-reset'))[0]
  resetBtn.props.onClick()
  assert.deepEqual(picked, ['high', 'reset'])
})

test('Dialog provides backdrop close, frameless mask marker, and ARIA dialog semantics', () => {
  const { ui, render } = loadUi()
  let closed = 0
  const tree = render(ui.Dialog, {
    open: true,
    label: 'Example dialog',
    title: 'Settings',
    onClose: () => { closed += 1 },
  })
  const mask = findAll(tree, n => n.props?.['data-bt-dialog-mask'] === '')[0]
  assert.ok(mask, 'Dialog renders data-bt-dialog-mask')
  const dlg = findAll(tree, n => n.props?.role === 'dialog')[0]
  assert.equal(dlg.props['aria-modal'], true)
  assert.equal(dlg.props['aria-label'], 'Example dialog')
  mask.props.onMouseDown({ target: mask, currentTarget: mask })
  assert.equal(closed, 1)
  assert.equal(render(ui.Dialog, { open: false, leaving: false, label: 'Hidden' }), null)
})

test('DynamicIsland, IslandPod, IslandPanel, and IslandPager compose cleanly', () => {
  const { ui, h, render } = loadUi()
  let podClicks = 0
  let page = 0
  const tree = render(ui.DynamicIsland, {
    expanded: true,
    pill: h('span', { className: 'bt-pill' }, 'Bot'),
    pods: [{
      id: 'review',
      open: true,
      node: h(ui.IslandPod, {
        dotTone: 'star',
        label: 'Suggestions',
        count: 3,
        open: true,
        onClick: () => { podClicks += 1 },
        panel: h(ui.IslandPanel, {
          label: 'Suggestions',
          footer: h(ui.IslandPager, {
            index: 0,
            count: 3,
            onStep: delta => { page += delta },
          }),
        }, 'Body'),
      }),
    }],
  })
  assert.ok(findAll(tree, n => n.props?.['data-open'] === true).length >= 1)
  const podBtn = findAll(tree, n => String(n.props?.className ?? '').includes('bt-island-pod-bar'))[0]
  podBtn.props.onClick()
  assert.equal(podClicks, 1)
  const nextBtn = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'Next')[0]
  nextBtn.props.onClick()
  assert.equal(page, 1)
})

test('controls.js primitives (Switch, SettingSection, SettingRow, StatusAlert, SearchInput) work cleanly', () => {
  const { ui, render } = loadUi()
  const toggled = []
  const sw = render(ui.Switch, { on: false, label: 'Auto approve', onChange: v => toggled.push(v) })
  const swBtn = findAll(sw, n => n.props?.role === 'switch')[0]
  assert.equal(swBtn.props['aria-checked'], false)
  swBtn.props.onClick()
  assert.deepEqual(toggled, [true])

  const queries = []
  const search = render(ui.SearchInput, { value: 'hello', onChange: v => queries.push(v) })
  const clearBtn = findAll(search, n => n.type === 'button')[0]
  clearBtn.props.onClick()
  assert.deepEqual(queries, [''])

  const alert = render(ui.StatusAlert, { error: 'Offline' })
  assert.equal(findAll(alert, n => n.props?.role === 'alert').length, 1)
})
