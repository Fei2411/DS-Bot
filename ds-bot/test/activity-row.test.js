import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { makeStatefulReact } from './stateful-react.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The activity row and the diagnostics it reports into, bundled once and run with a
// minimal React stand-in; the row's DOM helpers only read `document` at call time.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { findHost, releaseHost, rowVisible, pickActivity, freshInputAt } from './src/client/activity-row.js'",
      "export { clientErrors } from './src/client/diagnostics.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: fn => setTimeout(fn, 0),
  cancelAnimationFrame: id => clearTimeout(id),
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { findHost, releaseHost, rowVisible, pickActivity, freshInputAt, clientErrors } = module.exports

// The shell renders its running status inside the flow, before the pending steering
// rows, so hosting the row there puts it above an interjection's echo until the echo
// commits to the transcript — the row first sits between two user messages and then
// jumps below the new one. The row mounts at the flow (the column around the shell's
// slot), where it stays after those rows, even under an extra wrapper.
test('the activity row mounts at the flow around the running slot, not at the slot', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow id="flow"><div class="wrap"><div data-chat-running id="slot"></div></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'flow')
})

test('the activity row stays after a pending steer echo, and after the message once it commits', () => {
  dom.window.document.body.innerHTML = [
    '<div data-chat-flow id="flow">',
    '<div data-slot="conversation.chat.flow">',
    '<div data-chat-flow-key="u1" data-chat-flow-kind="user" id="first">first message</div>',
    '<div data-chat-running id="slot"></div>',
    '<div data-chat-flow-key="s1" data-chat-flow-kind="steering" id="echo">a steer</div>',
    '</div>',
    '</div>',
  ].join('')
  const doc = dom.window.document
  const row = doc.createElement('div')
  row.className = 'bt-typing'
  findHost().appendChild(row)
  const echo = doc.getElementById('echo')
  const first = doc.getElementById('first')
  // Document order is what the eye reads: the pending echo draws before the row.
  assert.ok(echo.compareDocumentPosition(row) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING, 'the pending steer draws above the row')
  assert.ok(first.compareDocumentPosition(echo) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)
  // The echo commits into the transcript: the row must still come after it.
  echo.remove()
  const committed = doc.createElement('div')
  committed.id = 'committed'
  committed.setAttribute('data-chat-flow-key', 's1')
  committed.setAttribute('data-chat-flow-kind', 'steering')
  doc.getElementById('slot').before(committed)
  assert.ok(committed.compareDocumentPosition(row) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING, 'the committed steer still draws above the row')
})

test('without the running slot the row mounts at the flow tail', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow id="flow"><div data-chat-flow-key="1"></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'flow')
})

// The search walks the whole transcript, so it runs again only when the slot it found
// leaves its flow.
test('the activity row keeps its flow while the slot stays, and follows the slot when it leaves', () => {
  const doc = dom.window.document
  doc.body.innerHTML = '<div data-chat-flow id="one"><div data-chat-running id="slot"></div></div><div data-chat-flow id="two"></div>'
  assert.equal(findHost()?.id, 'one')
  const query = doc.querySelector
  let queries = 0
  doc.querySelector = (selector) => { queries += 1; return query.call(doc, selector) }
  try {
    for (let i = 0; i < 5; i++) assert.equal(findHost()?.id, 'one')
    assert.equal(queries, 0)
    doc.getElementById('two').appendChild(doc.getElementById('slot'))
    assert.equal(findHost()?.id, 'two')
    doc.getElementById('slot').remove()
    assert.equal(findHost()?.id, 'one')
    doc.getElementById('one').insertAdjacentHTML('beforeend', '<div data-chat-running></div>')
    assert.equal(findHost()?.id, 'one')
  } finally {
    delete doc.querySelector
  }
})

test('a slot that stops running or a released row searches again', () => {
  const doc = dom.window.document
  doc.body.innerHTML = '<div data-chat-flow id="one"></div><div data-chat-flow id="two"><div data-chat-running id="slot"></div></div>'
  assert.equal(findHost()?.id, 'two')
  doc.getElementById('slot').removeAttribute('data-chat-running')
  assert.equal(findHost()?.id, 'one')
  doc.getElementById('slot').setAttribute('data-chat-running', '')
  assert.equal(findHost()?.id, 'two')
  const query = doc.querySelector
  let queries = 0
  doc.querySelector = (selector) => { queries += 1; return query.call(doc, selector) }
  try {
    releaseHost()
    assert.equal(findHost()?.id, 'two')
    assert.equal(queries, 1)
  } finally {
    delete doc.querySelector
  }
})

test('a missing chat flow is reported once per page, not on every retry', () => {
  dom.window.document.body.innerHTML = '<div></div>'
  const before = clientErrors().filter(entry => entry.text.startsWith('activity row:')).length
  assert.equal(findHost(), null)
  assert.equal(findHost(), null)
  const entries = clientErrors().filter(entry => entry.text.startsWith('activity row:'))
  assert.equal(entries.length, before + 1)
  assert.match(entries.at(-1).text, /activity row:/)
})

// The row hides while a reply streams — but a turn that streams first and runs a
// tool after keeps the row once the tool starts.
test('the row shows while a turn runs, also when text streamed before a tool', () => {
  const bot = {}
  const cases = [
    [{ running: true, streaming: false, tools: [], relaying: false, bot }, true],
    [{ running: true, streaming: true, tools: [], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: true, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: false, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [], relaying: false }, false],
    [{ running: true, streaming: false, tools: [], relaying: false, room: {} }, true],
  ]
  for (const [input, expected] of cases) assert.equal(rowVisible(input), expected, JSON.stringify(input))
})

// A queued message waits for the next turn; a transcript or steering send counts
// as fresh input, and a steer the host saw counts from when it landed.
test('fresh input ignores queued sends and takes the newest of the rest', () => {
  const submissions = [
    { placement: 'queued', time: 300 },
    { placement: 'steering', time: 100 },
    { placement: 'transcript', time: 200 },
  ]
  assert.equal(freshInputAt(submissions, undefined), 200)
  assert.equal(freshInputAt(submissions, 400), 400)
  assert.equal(freshInputAt(submissions, 50), 200)
  assert.equal(freshInputAt([{ placement: 'queued', time: 300 }], undefined), 0)
  assert.equal(freshInputAt(undefined, 400), 400)
  assert.equal(freshInputAt([], undefined), 0)
})

<<<<<<< HEAD
test('pickActivity prefers a newer host activity over an older chat note and hides host-only work while streaming', () => {
  const olderTool = { label: 'Opening a file', state: 'searching', at: 100 }
  const newerHost = { label: 'Running shell commands', state: 'working' }
  const picked = pickActivity({ tools: [olderTool], localNote: newerHost, localAt: 200, streaming: false })
  assert.equal(picked?.source, 'local')
  assert.equal(picked?.label, 'Running shell commands')
  assert.equal(picked?.at, 200)

  // A newer chat tool still wins over an older host activity.
  const newerTool = { label: 'Writing changes', state: 'working', at: 300 }
  const toolPicked = pickActivity({ tools: [newerTool], localNote: newerHost, localAt: 200, streaming: false })
  assert.equal(toolPicked?.source, 'tool')
  assert.equal(toolPicked?.label, 'Writing changes')

  // Host status alone stays hidden while reply text is already streaming.
  assert.equal(pickActivity({ tools: [], localNote: newerHost, localAt: 200, streaming: true }), undefined)
=======
// The move-to-background action stays invisible and borderless at rest so the
// activity row remains quiet, reveals smoothly on hover/focus/touch-open/busy
// (except while exiting), keeps :disabled dimmed, and respects reduced motion.
test('activity-row background action stays hidden and borderless at rest, with valid cascade and reduced-motion rules', async () => {
  const { outputFiles: styleFiles } = await build({
    stdin: { contents: "export { CONVERSATION_CSS } from './src/client/styles.js'", resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const styleMod = { exports: {} }
  runInNewContext(styleFiles[0].text, {
    module: styleMod, exports: styleMod.exports,
    require: () => react,
  })
  const styleDom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const styleEl = styleDom.window.document.createElement('style')
  styleEl.textContent = styleMod.exports.CONVERSATION_CSS
  styleDom.window.document.head.appendChild(styleEl)
  const rules = [...styleEl.sheet.cssRules]
  const rowRule = rules.find(rule => rule.selectorText === '.bt-typing')
  const bgRule = rules.find(rule => rule.selectorText === '.bt-typing-bg')
  const wrapRule = rules.find(rule => rule.selectorText === '.bt-typing-bg-wrap')
  const revealSel = '.bt-typing:is(:focus-within,[data-bg-open],[data-bg-busy]):not([data-exiting])'
  const revealWrapRule = rules.find(rule => rule.selectorText === `${revealSel}>.bt-typing-bg-wrap`)
  const revealBgRule = rules.find(rule => rule.selectorText === `${revealSel} .bt-typing-bg`)
  const revealDisabledRule = rules.find(rule => rule.selectorText === `${revealSel} .bt-typing-bg:disabled`)
  const hoverBlock = rules.find(rule => rule.conditionText?.replace(/\s+/g, '') === '(hover:hover)'
    && [...rule.cssRules].some(inner => inner.selectorText?.includes('.bt-typing:hover:not([data-exiting])')))
  const reducedBlock = rules.find(rule => rule.conditionText?.replace(/\s+/g, '') === '(prefers-reduced-motion:reduce)'
    && [...rule.cssRules].some(inner => inner.selectorText?.includes('.bt-typing-bg')))
  const offTransformRule = rules.find(rule => rule.selectorText?.includes('body[data-bt-effects=off]')
    && rule.selectorText.includes('.bt-typing-bg:hover:not(:disabled) .bt-typing-bg-ico'))
  const offScaleRule = rules.find(rule => rule.selectorText === 'body[data-bt-effects=off] .bt-typing-bg:active:not(:disabled)')
  assert.ok(rowRule && bgRule && wrapRule && revealWrapRule && revealBgRule && revealDisabledRule && hoverBlock && reducedBlock && offTransformRule && offScaleRule)
  // Unconditional reveal must not include :hover so touch sticky-hover cannot block tap dismissal.
  assert.equal(rules.some(r => r.selectorText?.includes('.bt-typing') && r.selectorText.includes(':hover') && r.selectorText.includes('.bt-typing-bg-wrap')), false)
  assert.equal(rowRule.style.getPropertyValue('box-sizing'), 'border-box')
  assert.equal(bgRule.style.getPropertyValue('border-width') || bgRule.style.getPropertyValue('border'), '0px')
  assert.equal(bgRule.style.getPropertyValue('opacity'), '0')
  assert.equal(bgRule.style.getPropertyValue('pointer-events'), 'none')
  assert.equal(wrapRule.style.getPropertyValue('grid-template-columns'), '0fr')
  assert.equal(revealWrapRule.style.getPropertyValue('grid-template-columns'), '1fr')
  assert.equal(revealBgRule.style.getPropertyValue('opacity'), '1')
  assert.equal(revealBgRule.style.getPropertyValue('pointer-events'), 'auto')
  assert.equal(Number(revealDisabledRule.style.getPropertyValue('opacity')), 0.55)
  const hoverInner = [...hoverBlock.cssRules]
  assert.ok(hoverInner.some(r => r.selectorText === '.bt-typing:hover:not([data-exiting])>.bt-typing-bg-wrap' && r.style.getPropertyValue('grid-template-columns') === '1fr'))
  assert.ok(hoverInner.some(r => r.selectorText === '.bt-typing:hover:not([data-exiting]) .bt-typing-bg' && r.style.getPropertyValue('opacity') === '1' && r.style.getPropertyValue('pointer-events') === 'auto'))
  assert.ok(hoverInner.some(r => r.selectorText === '.bt-typing:hover:not([data-exiting]) .bt-typing-bg:disabled' && Number(r.style.getPropertyValue('opacity')) === 0.55))
  const reducedInner = [...reducedBlock.cssRules]
  assert.ok(reducedInner.some(r => r.selectorText?.includes('.bt-typing-bg:hover:not(:disabled) .bt-typing-bg-ico') && r.style.getPropertyValue('transform') === 'none'))
  assert.ok(reducedInner.some(r => r.selectorText === '.bt-typing-bg:active:not(:disabled)' && r.style.getPropertyValue('scale') === 'none'))
  assert.equal(offTransformRule.style.getPropertyValue('transform'), 'none')
  assert.equal(offScaleRule.style.getPropertyValue('scale'), 'none')
})

test('ActivityIndicator renders wrapped background button, sets data-bg-busy on click, and supports touch tap-to-toggle', async () => {
  const { outputFiles: compFiles } = await build({
    stdin: { contents: "export { ActivityIndicator } from './src/client/activity-row.js'", resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const { React: baseReact, render: baseRender, unmount } = makeStatefulReact()
  // Real React commits useLayoutEffect before useEffect; mirror that order so
  // ActivityIndicator's collapse cleanup does not run after its phrase effect.
  const deferredEffects = []
  const React = {
    ...baseReact,
    useEffect: (fn, deps) => baseReact.useEffect(() => {
      let cleanup
      deferredEffects.push(() => { cleanup = fn() })
      return () => { if (typeof cleanup === 'function') cleanup() }
    }, deps),
  }
  const render = (el, attach) => {
    const tree = baseRender(el, attach)
    while (deferredEffects.length > 0) deferredEffects.shift()()
    return tree
  }
  const compDom = new JSDOM('<!doctype html><body><div data-chat-flow id="flow"><div data-chat-running></div></div></body>')
  let isTouch = true
  const listeners = new Map()
  const win = {
    matchMedia: query => ({ matches: query === '(hover: none)' ? isTouch : false }),
    addEventListener: (type, fn) => { listeners.set(type, fn) },
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) },
  }
  const compMod = { exports: {} }
  runInNewContext(compFiles[0].text, {
    module: compMod, exports: compMod.exports,
    document: compDom.window.document,
    window: win,
    Element: compDom.window.Element,
    MutationObserver: compDom.window.MutationObserver,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: id => clearTimeout(id),
    setTimeout, clearTimeout,
    require: name => (name === 'react' ? React : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  const { ActivityIndicator } = compMod.exports
  const calls = []
  let rejectMove
  const props = {
    sessionId: 's1',
    useRoster: sel => sel({ byId: { s1: { id: 'b1', name: 'Chief' } }, roomsById: {} }),
    useSessionStatus: sel => sel(new Map([['s1', { running: true }]])),
    useSession: sel => sel({ pendingSubmissions: [] }),
    useLive: sel => sel({}),
    useWork: sel => sel({ canBackground: { s1: { botId: 'b1', turn: 3 } }, turns: { s1: 1000 } }),
    actions: {
      clearLive() {},
      reportError() {},
      moveToBackground: (...args) => new Promise((_res, rej) => { calls.push(args); rejectMove = rej }),
    },
  }
  const findNode = (node, pred) => {
    if (!node || typeof node !== 'object') return null
    if (pred(node)) return node
    for (const child of node.children ?? []) {
      const hit = findNode(child, pred)
      if (hit) return hit
    }
    return null
  }
  const fakeRowEl = compDom.window.document.createElement('div')
  const fakeOutsideEl = compDom.window.document.createElement('div')
  const attachRef = (tree) => {
    const row = findNode(tree, n => n.props?.className === 'bt-typing')
    if (row?.props?.ref) row.props.ref.current = fakeRowEl
  }
  try {
    // First render commits layout + passive effects (host, phase, shown); second draws the row.
    let tree = render(React.createElement(ActivityIndicator, props), attachRef)
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    const row = findNode(tree, n => n.props?.className === 'bt-typing')
    const wrap = findNode(row, n => n.props?.className === 'bt-typing-bg-wrap')
    const inner = findNode(wrap, n => n.props?.className === 'bt-typing-bg-in')
    const btn = findNode(inner, n => n.type === 'button' && n.props?.className === 'bt-typing-bg')
    assert.ok(row && wrap && inner && btn)
    assert.equal(row.props['data-bg-open'], undefined)
    assert.equal(row.props['data-bg-busy'], undefined)
    assert.equal(btn.props.disabled, false)

    // Pointer device: tapping status text does not set data-bg-open.
    isTouch = false
    row.props.onClick({ target: { closest: () => null } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-open'], undefined)

    // Touch device: tapping mark does not toggle; tapping text toggles open and a second tap closes + removes listener.
    isTouch = true
    row.props.onClick({ target: { closest: sel => (sel.includes('.bt-typing-mark') ? {} : null) } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-open'], undefined)

    row.props.onClick({ target: { closest: () => null } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-open'], '')
    assert.equal(listeners.has('pointerdown'), true)

    // Second tap on the row toggles closed and detaches pointerdown listener.
    findNode(tree, n => n.props?.className === 'bt-typing').props.onClick({ target: { closest: () => null } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-open'], undefined)
    assert.equal(listeners.has('pointerdown'), false)

    // Reopen and verify outside pointerdown also dismisses and detaches listener.
    findNode(tree, n => n.props?.className === 'bt-typing').props.onClick({ target: { closest: () => null } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(listeners.has('pointerdown'), true)
    listeners.get('pointerdown')({ target: fakeOutsideEl })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-open'], undefined)
    assert.equal(listeners.has('pointerdown'), false)

    // Clicking the button moves to background, clears data-bg-open, sets data-bg-busy + disabled.
    findNode(tree, n => n.props?.className === 'bt-typing').props.onClick({ target: { closest: () => null } })
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    findNode(tree, n => n.props?.className === 'bt-typing-bg').props.onClick()
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.deepEqual(calls, [['b1', 's1', 3]])
    const busyRow = findNode(tree, n => n.props?.className === 'bt-typing')
    assert.equal(busyRow.props['data-bg-open'], undefined)
    assert.equal(busyRow.props['data-bg-busy'], '')
    assert.equal(findNode(busyRow, n => n.props?.className === 'bt-typing-bg').props.disabled, true)

    // Rejected RPC clears busy/disabled state.
    rejectMove(new Error('boom'))
    await new Promise(resolve => setImmediate(resolve))
    tree = render(React.createElement(ActivityIndicator, props), attachRef)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing').props['data-bg-busy'], undefined)
    assert.equal(findNode(tree, n => n.props?.className === 'bt-typing-bg').props.disabled, false)
  } finally {
    unmount()
  }
>>>>>>> upstream/dev
})
