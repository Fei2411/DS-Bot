import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/learning-card.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let opened = false
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout,
  require: () => ({
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({}),
    useState: initial => [initial === false ? opened : initial, value => { opened = value }],
    useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useMemo: make => make(), useId: () => 'title',
  }),
})
const { PendingLearning, LEARNING_CSS } = module.exports
const skill = { id: 'skill', botId: 'b', name: 'Review', content: 'Run tests', at: 100 }
const agents = { id: 'agents', botId: 'b', kind: 'agents', folder: '/project', edits: [{ op: 'add', text: 'Run lint' }] }
const show = (proposals, sessionId = 'current') => PendingLearning({
  sessionId, useRoster: select => select({ byId: { current: { id: 'b', sessionId: 'current' }, old: { id: 'b', sessionId: 'current' } }, learning: { b: proposals } }),
  actions: { learningAnswer: () => { throw new Error('Opening must not answer') } },
})
function collect(node, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach(child => collect(child, found)); return found }
  if (typeof node.type === 'function') return collect(node.type(node.props), found)
  found.push(node)
  collect(node.props?.children, found)
  return found
}
test('the fixed entry exists even when proposals belong to much earlier turns', () => {
  opened = false
  const tree = show([skill, agents])
  const button = tree.props.children[0]
  assert.equal(button.props['aria-expanded'], false)
  assert.ok(button.props.children.includes(' · 2'))
  button.props.onClick()
  const cards = collect(show([skill, agents])).filter(node => node.type === 'section')
  assert.equal(cards.length, 2)
  assert.ok(cards.every(card => card.props.className.includes('bt-learning-card')))
})
test('handling proposals removes each entry and the last leaves no space', () => {
  opened = true
  assert.equal(collect(show([agents])).filter(node => node.type === 'section').length, 1)
  assert.equal(show([]), null)
})
test('old parts do not show current proposals', () => {
  assert.equal(show([skill], 'old'), null)
})
test('pending panels fit the header column instead of the viewport at every breakpoint', () => {
  const rule = name => LEARNING_CSS.match(new RegExp(`\\.${name}\\{([^}]+)\\}`))[1]
  assert.match(rule('bt-learning-pending'), /position:static/)
  const panel = rule('bt-learning-pending-panel')
  assert.match(panel, /position:absolute/)
  assert.match(panel, /left:16px;right:16px/)
  assert.match(panel, /width:auto;max-width:560px;margin:0 auto/)
  assert.doesNotMatch(panel, /vw/)
  assert.doesNotMatch(LEARNING_CSS, /\.bt-learning-pending-panel[^{}]*\{[^}]*position:fixed/)
  assert.match(LEARNING_CSS, /\.bt-learning-pending-panel \.bt-q-head\{flex-wrap:wrap\}/)
  assert.match(LEARNING_CSS, /\.bt-learning-pending-panel \.bt-q-text\{flex-basis:140px\}/)
})
