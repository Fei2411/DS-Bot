import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientBundle, makeStatefulReact } from './stateful-react.js'

async function load() {
  const code = await loadClientBundle("export { Chart, USAGE_CSS } from './src/client/usage-page.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? { createPortal: el => el } : harness.React))
  return { harness, ...mod.exports }
}

function findAll(node, match, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  findAll(node.children ?? [], match, out)
  return out
}

const textOf = node => (typeof node === 'string' || typeof node === 'number'
  ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : (node?.children ?? []).map(textOf).join(''))

test('Usage Chart renders cohesive hairline-seamed stacks, legend cross-highlighting, and tooltip share %', async (t) => {
  const before = { cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.cancelAnimationFrame = () => {}
  t.after(() => Object.assign(globalThis, before))
  const { harness, Chart, USAGE_CSS } = await load()

  // Cohesive stacked column CSS: rounded container + flat inner segments with 1px seam + hover dimming.
  assert.match(USAGE_CSS, /\.bt-us-stack\{[^}]*gap:1px[^}]*border-radius:6px;overflow:hidden/)
  assert.match(USAGE_CSS, /\.bt-us-stack>i\{[^}]*border-radius:0/)
  assert.match(USAGE_CSS, /\.bt-us-plot\[data-series-hover\] \.bt-us-stack>i:not\(\[data-match\]\)\{opacity:\.2\}/)

  const range = { id: '7d', unit: 'day', stride: 1 }
  const series = [
    { key: 'm0', name: 'DeepSeek-V4', fill: 'var(--bt-ink-deepseek)', pick: { kind: 'model', key: 'deepseek/v4' } },
    { key: 'm1', name: 'Claude 4', fill: 'var(--bt-ink-tangerine)', pick: { kind: 'model', key: 'anthropic/claude' } },
    { key: 'more', name: 'More models', fill: 'var(--bt-us-more)' },
  ]
  const columns = [
    {
      key: '2026-11-23',
      tick: '11/23',
      title: 'Nov 23',
      total: 1000,
      parts: [['m0', 700], ['m1', 200], ['more', 100]],
      tip: [['m0', 700], ['m1', 200], ['more', 100]],
    },
    {
      key: '2026-11-24',
      tick: '11/24',
      title: 'Nov 24',
      total: 500,
      parts: [['m0', 500], ['m1', 0], ['more', 0]],
      tip: [['m0', 500], ['m1', 0], ['more', 0]],
    },
  ]

  const draw = () => harness.render(harness.React.createElement(Chart, {
    range, columns, series, tipSeries: series, by: 'model', onBy: () => {}, onPick: () => {},
  }))

  let tree = draw()
  const plot = () => findAll(tree, n => n.props?.className === 'bt-us-plot')[0]
  assert.equal(plot().props['data-series-hover'], undefined)

  // Hovering a legend pill marks plot data-series-hover, matching <i> data-match, and dims sibling pills.
  const claudeKey = findAll(tree, n => n.props?.className === 'bt-us-key' && n.props?.['data-series'] === 'm1')[0]
  assert.ok(claudeKey)
  claudeKey.props.onMouseEnter()
  tree = draw()
  assert.equal(plot().props['data-series-hover'], '')
  const segments = findAll(tree, n => n.type === 'i' && n.props?.['data-series'])
  assert.deepEqual(
    segments.map(seg => [seg.props['data-series'], seg.props['data-match'] !== undefined]),
    [['m0', false], ['m1', true], ['more', false], ['m0', false]],
  )
  const legendKeys = findAll(tree, n => n.props?.className === 'bt-us-key')
  assert.equal(legendKeys.find(k => k.props['data-series'] === 'm1').props['data-on'], '')
  assert.equal(legendKeys.find(k => k.props['data-series'] === 'm0').props['data-dim'], '')

  // Leaving legend clears highlight cleanly.
  findAll(tree, n => n.props?.className === 'bt-us-legend')[0].props.onMouseLeave()
  tree = draw()
  assert.equal(plot().props['data-series-hover'], undefined)

  // Hovering a multi-series column shows share % next to compact tokens.
  const cols = findAll(tree, n => n.props?.className === 'bt-us-col')
  cols[0].props.onMouseEnter()
  tree = draw()
  const multiRows = findAll(tree, n => n.props?.className === 'bt-us-tip-row')
  assert.equal(multiRows.length, 3)
  assert.deepEqual(
    multiRows.map(row => textOf(findAll(row, n => n.props?.className === 'bt-us-tip-share')[0])),
    ['70%', '20%', '10%'],
  )

  // Hovering a single-series column omits redundant 100% share %.
  cols[1].props.onMouseEnter()
  tree = draw()
  const singleRows = findAll(tree, n => n.props?.className === 'bt-us-tip-row')
  assert.equal(singleRows.length, 1)
  assert.equal(findAll(singleRows[0], n => n.props?.className === 'bt-us-tip-share').length, 0)
  harness.unmount()
})
