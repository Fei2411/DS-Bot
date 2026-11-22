import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><body></body>')
const { document } = dom.window

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { pinWatch } from './src/client/header.js'",
      "export { NewDivider, newDividerIn } from './src/client/cells.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const layoutEffects = []
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect: (fn) => { layoutEffects.push(fn) }, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document, window: dom.window,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : {}),
})
const { pinWatch, NewDivider, newDividerIn } = module.exports

// Mounts a NewDivider the way React would: the element gets the ref, then the layout
// effect runs. Returns the node and its unmount.
const mountDivider = (parent) => {
  const element = NewDivider()
  const node = document.createElement('div')
  node.className = element.props.className
  element.props.ref.current = node
  parent.appendChild(node)
  const cleanup = layoutEffects.pop()()
  return { node, unmount: () => { cleanup(); node.remove() } }
}

const chat = (pinned) => {
  document.body.innerHTML = [
    '<div data-conversation-scroll id="scroller"><div class="x_frame">',
    `<div class="x_root" ${pinned ? 'data-chat-following-tail' : ''}><div data-chat-flow id="flow"><div>a reply</div></div></div>`,
    pinned ? '' : '<div class="EvIC1a_toBottomSlot"><button type="button">down</button></div>',
    '</div></div>',
  ].join('')
  return document.getElementById('scroller')
}

test('the pin check reads the following-tail flag and the Back to bottom slot like the old query', () => {
  const unpinned = pinWatch()
  let scroller = chat(true)
  assert.equal(unpinned(scroller), false)
  assert.equal(unpinned(scroller), false)
  scroller = chat(false)
  assert.equal(unpinned(scroller), true)
  assert.equal(unpinned(scroller), true)
  // The shell drops the button but keeps the slot: no longer unpinned.
  scroller.querySelector('button').remove()
  assert.equal(unpinned(scroller), false)
  scroller = chat(true)
  assert.equal(unpinned(scroller), false)
})

test('the pin check flips with the shell in place, without a new chat', () => {
  const unpinned = pinWatch()
  const scroller = chat(true)
  const root = scroller.querySelector('.x_root')
  assert.equal(unpinned(scroller), false)
  root.removeAttribute('data-chat-following-tail')
  scroller.querySelector('.x_frame').insertAdjacentHTML('beforeend', '<div class="EvIC1a_toBottomSlot"><button type="button">down</button></div>')
  assert.equal(unpinned(scroller), true)
  scroller.querySelector('.EvIC1a_toBottomSlot').remove()
  root.setAttribute('data-chat-following-tail', '')
  assert.equal(unpinned(scroller), false)
})

test('the pin check keeps the walk off the transcript while pinned', () => {
  const unpinned = pinWatch()
  const scroller = chat(true)
  unpinned(scroller)
  let queries = 0
  const query = scroller.querySelector.bind(scroller)
  scroller.querySelector = (selector) => { queries += 1; return query(selector) }
  for (let i = 0; i < 5; i++) assert.equal(unpinned(scroller), false)
  assert.equal(queries, 0)
})

test('the pills find the first mounted new-message divider inside the scroller', () => {
  const scroller = chat(true)
  const flow = scroller.querySelector('#flow')
  assert.equal(newDividerIn(scroller), null)
  const later = mountDivider(flow)
  const earlier = { node: null }
  Object.assign(earlier, mountDivider(flow))
  flow.insertBefore(earlier.node, flow.firstChild)
  const outside = mountDivider(document.body)
  assert.equal(newDividerIn(scroller), earlier.node)
  earlier.unmount()
  assert.equal(newDividerIn(scroller), later.node)
  later.unmount()
  assert.equal(newDividerIn(scroller), null)
  outside.unmount()
})
