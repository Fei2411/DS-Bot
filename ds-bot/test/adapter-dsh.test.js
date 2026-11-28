import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { installDshAdapter, syncDshNode, syncDshAncestors } from './src/client/adapter-dsh.js'",
      "export { CellEmpty } from './src/client/cell-empty.js'",
      "export { GroupMessage, syncGroupChains } from './src/client/cells.js'",
      "export { findHost, releaseHost } from './src/client/activity-row.js'",
      "export { useTranscriptView } from './src/client/header.js'",
      "export { syncHostAncestors } from './src/client/chat-room.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function loadAdapterEnv(html = '<!doctype html><body></body>') {
  const dom = new JSDOM(html)
  const layoutEffects = []
  const passiveEffects = []
  const refs = []
  let stateVal = null
  const states = []
  const react = {
    Fragment: Symbol('Fragment'),
    createContext: (init) => { const ctx = { value: init }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: (init) => { const r = { current: init }; refs.push(r); return r },
    useLayoutEffect: (fn) => { layoutEffects.push(fn) },
    useEffect: (fn) => { passiveEffects.push(fn) },
    useState: (init) => {
      const idx = states.length
      const v = typeof init === 'function' ? init() : init
      states.push(v)
      return [v, (next) => {
        const prev = states[idx]
        const resolved = typeof next === 'function' ? next(prev) : next
        states[idx] = resolved
        stateVal = resolved
      }]
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useId: () => 'id',
    memo: fn => fn,
  }
  const mod = { exports: {} }
  let resizeCb = null
  const observedResize = []
  let rafQueue = []
  runInNewContext(outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    document: dom.window.document,
    window: Object.assign(dom.window, {
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ getPropertyValue: () => '0px' }),
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '0px' }),
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      constructor(cb) { resizeCb = cb }
      observe(el) { observedResize.push(el) }
      disconnect() {}
    },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
    cancelAnimationFrame: () => {},
    queueMicrotask,
    setTimeout,
    clearTimeout,
    require: (name) => (
      name === 'react' ? react
        : name === 'react-dom' ? { createPortal: node => node }
          : { MarkdownText: () => null, writeClipboard: async () => true }
    ),
  })
  return {
    dom,
    exports: mod.exports,
    layoutEffects,
    passiveEffects,
    refs,
    getLastState: () => stateVal,
    getResizeCb: () => resizeCb,
    observedResize,
    flushRaf: () => { const q = rafQueue; rafQueue = []; for (const fn of q) fn() },
  }
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0))

test('synchronous bridge stamps newly mounted DSH ancestors in useLayoutEffect before MutationObserver fires (CellEmpty & GroupMessage)', async () => {
  const env = loadAdapterEnv()
  const { document } = env.dom.window
  const { installDshAdapter, CellEmpty, GroupMessage } = env.exports
  const stop = installDshAdapter(document)
  try {
    // Append brand-new DSH nodes AFTER installDshAdapter — do NOT await microtasks,
    // simulating React running useLayoutEffect synchronously during commit before MO fires.
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation.chat.node')
    const marker = document.createElement('span')
    marker.setAttribute('data-bt-empty', '')
    slot.appendChild(marker)
    document.body.appendChild(slot)
    assert.equal(slot.hasAttribute('data-bt-slot'), false, 'MO must not have run synchronously yet')

    CellEmpty({})
    env.refs.at(-1).current = marker
    const cleanupCell = env.layoutEffects.pop()()
    assert.equal(slot.getAttribute('data-bt-slot'), 'conversation.chat.node', 'sync bridge must stamp data-bt-slot synchronously')
    assert.equal(slot.hasAttribute('data-bt-emptied'), true, 'CellEmpty must mark data-bt-emptied on first mount')
    cleanupCell?.()

    // Same synchronous mount test for GroupMessage inside newly mounted [data-chat-flow] > [data-chat-group-key]
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    const turn1 = document.createElement('div')
    turn1.setAttribute('data-chat-group-key', 't1')
    const msg1 = document.createElement('div')
    msg1.className = 'bt-group-msg'
    msg1.dataset.botId = 'b1'
    turn1.appendChild(msg1)
    const turn2 = document.createElement('div')
    turn2.setAttribute('data-chat-group-key', 't2')
    const msg2 = document.createElement('div')
    msg2.className = 'bt-group-msg'
    msg2.dataset.botId = 'b1'
    turn2.appendChild(msg2)
    flow.append(turn1, turn2)
    document.body.appendChild(flow)
    assert.equal(flow.hasAttribute('data-bt-flow'), false, 'MO must not have stamped flow yet')

    GroupMessage({
      bot: { id: 'b1', name: 'Bot' },
      text: 'hi',
      room: { id: 'r1' },
      roster: { prefs: {}, byId: { b1: { id: 'b1', name: 'Bot' } } },
      actions: { openSession() {} },
    })
    env.refs.at(-1).current = msg2
    const cleanupGroup = env.layoutEffects.pop()()
    assert.equal(flow.hasAttribute('data-bt-flow'), true, 'GroupMessage must synchronously stamp data-bt-flow')
    await flushMicrotasks()
    assert.equal(msg1.dataset.chainNext, '', 'first group message should chain forward')
    assert.equal(msg2.dataset.chainPrev, '', 'second group message should chain backward')
    assert.equal(turn1.dataset.btChainNext, '', 'first turn wrapper should receive data-bt-chain-next')
    assert.equal(turn2.dataset.btChainPrev, '', 'second turn wrapper should receive data-bt-chain-prev')
    cleanupGroup?.()
  } finally {
    stop()
  }
})

test('adapter-dsh removes data-bt-* flags when DSH removes source attributes and updates tail state on _toBottomSlot class change', async () => {
  const env = loadAdapterEnv(`<!doctype html><body>
    <div class="x_centerCol" id="center">
      <div data-conversation-scroll id="scroll">
        <div data-chat-flow id="flow">
          <div data-chat-running id="run"></div>
        </div>
        <div id="slotWrap"><button id="toBottomBtn">v</button></div>
      </div>
      <div data-composer-card id="card">
        <div role="textbox" contenteditable="true" id="tb"></div>
      </div>
    </div>
  </body>`)
  const { document } = env.dom.window
  const { installDshAdapter, findHost, releaseHost } = env.exports
  const stop = installDshAdapter(document)
  try {
    const center = document.getElementById('center')
    const scroll = document.getElementById('scroll')
    const run = document.getElementById('run')
    const slotWrap = document.getElementById('slotWrap')
    const toBottomBtn = document.getElementById('toBottomBtn')
    const card = document.getElementById('card')
    const tb = document.getElementById('tb')

    assert.equal(center.hasAttribute('data-bt-center'), true)
    assert.equal(run.hasAttribute('data-bt-running'), true)
    assert.equal(tb.hasAttribute('data-bt-composer-input'), true)
    assert.equal(scroll.getAttribute('data-bt-following-tail'), 'true')
    assert.equal(findHost()?.id, 'flow')

    // 1. Removing data-chat-running must remove data-bt-running (not leave it stuck)
    run.removeAttribute('data-chat-running')
    await flushMicrotasks()
    assert.equal(run.hasAttribute('data-bt-running'), false, 'data-bt-running must be removed when data-chat-running is removed')
    releaseHost()

    // 2. Adding/removing _toBottomSlot class updates data-bt-to-bottom AND data-bt-following-tail
    slotWrap.className = 'abc_toBottomSlot'
    await flushMicrotasks()
    assert.equal(toBottomBtn.hasAttribute('data-bt-to-bottom'), true, 'button inside _toBottomSlot gets data-bt-to-bottom')
    assert.equal(scroll.getAttribute('data-bt-following-tail'), 'false', 'scroller flips unpinned when _toBottomSlot activates')

    slotWrap.className = 'abc_hidden'
    await flushMicrotasks()
    assert.equal(toBottomBtn.hasAttribute('data-bt-to-bottom'), false, 'data-bt-to-bottom must be removed when _toBottomSlot leaves')
    assert.equal(scroll.getAttribute('data-bt-following-tail'), 'true', 'scroller returns to pinned when _toBottomSlot leaves')

    // 3. Removing _centerCol class and data-composer-card cleans up flags
    center.className = 'plain'
    card.removeAttribute('data-composer-card')
    await flushMicrotasks()
    assert.equal(center.hasAttribute('data-bt-center'), false)
    assert.equal(card.hasAttribute('data-bt-composer'), false)
    assert.equal(tb.hasAttribute('data-bt-composer-input'), false)
  } finally {
    stop()
  }
})

test('useTranscriptView observes [data-bt-scroll] with ResizeObserver and recomputes bottom when desktop composer grows', () => {
  const env = loadAdapterEnv('<!doctype html><body><div data-bt-scroll data-bt-following-tail="false" id="s"></div></body>')
  const { document, window } = env.dom.window
  const scroller = document.getElementById('s')
  let boxBottom = 700
  scroller.getBoundingClientRect = () => ({ left: 200, top: 0, right: 1000, bottom: boxBottom, width: 800, height: boxBottom })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })

  env.exports.useTranscriptView({ current: null })
  const cleanup = env.passiveEffects.pop()()
  env.flushRaf()
  assert.equal(env.observedResize.includes(scroller), true, 'ResizeObserver must observe [data-bt-scroll]')
  assert.equal(env.getLastState().bottom, 108)

  // Composer grows by 80px -> scroller shrinks so box.bottom drops from 700 to 620.
  boxBottom = 620
  env.getResizeCb()()
  env.flushRaf()
  assert.equal(env.getLastState().bottom, 188, 'down-pill bottom must rise with growing composer')
  cleanup?.()
})
