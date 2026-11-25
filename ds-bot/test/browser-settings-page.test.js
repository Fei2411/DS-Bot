import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { BrowserPage } from './browser-settings.js'
      export { useEscape } from './overlay-hooks.js'
    `,
    resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function createHarness() {
  let current
  const listeners = new Map()
  const slot = (make) => {
    const index = current.index++
    return current.slots[index] ??= make()
  }
  const effect = (make, deps) => {
    const cell = slot(() => ({}))
    if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
      current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
    }
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    createContext: (v) => ({ Provider: () => null, _currentValue: v }),
    useContext: (ctx) => ctx?._currentValue,
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useEffect: effect,
    useLayoutEffect: effect,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    memo: (c) => c,
    forwardRef: (c) => c,
  }
  const fakeWindow = {
    matchMedia: () => ({ matches: false }),
    addEventListener(type, fn) {
      let set = listeners.get(type)
      if (!set) { set = new Set(); listeners.set(type, set) }
      set.add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type, event) {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn(event)
    },
  }
  const storage = new Map()
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: (node) => node }
      return {}
    },
    window: fakeWindow,
    document: { body: {}, querySelectorAll: () => [] },
    ResizeObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setTimeout,
    clearTimeout,
  })

  const mount = (Component, props) => {
    const instance = {
      slots: [],
      effects: [],
      props,
      render(next = instance.props) {
        instance.props = next
        instance.index = 0
        current = instance
        const out = Component(next)
        current = undefined
        for (const run of instance.effects.splice(0)) run()
        return out
      },
      unmount() {
        for (const s of instance.slots) s?.stop?.()
      },
    }
    return instance
  }

  return { exports: mod.exports, react, window: fakeWindow, mount }
}

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const Section = ({ title, children }) => h('section', { 'data-title': title }, h('h3', null, title), ...(children ?? []))
const Row = ({ label, hint, children }) => h('div', { 'data-row': label }, h('span', null, label), hint ? h('span', null, hint) : null, ...(children ?? []))

const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const allNodes = (node, check) => {
  if (Array.isArray(node)) return node.flatMap((child) => allNodes(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...allNodes(node.props?.children, check)]
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}

test('the Browser page shows the active Browser plugin row with Switch and omits legacy prose', () => {
  const harness = createHarness()
  const opened = []
  const inst = harness.mount(harness.exports.BrowserPage, {
    roster: { bots: [] },
    actions: { openSettings: (page, id) => opened.push([page, id]) },
    run: () => {},
    Section,
    Row,
  })
  const tree = expand(inst.render())
  const text = textOf(tree)
  assert.match(text, /Browser plugin/)
  assert.match(text, /Read-only Browser/)
  assert.match(text, /Allowed actions/)
  assert.match(text, /Nothing allowed yet\./)
  assert.doesNotMatch(text, /browserPlugin/)
  assert.doesNotMatch(text, /DSH profile/)
  assert.doesNotMatch(text, /A Bot can read the page you have open/)
  assert.doesNotMatch(text, /restart DS Bot/)
  assert.doesNotMatch(text, /Import cookies/)

  const findBtn = (node, label) => {
    if (Array.isArray(node)) {
      for (const child of node) { const hit = findBtn(child, label); if (hit) return hit }
      return null
    }
    if (!node || typeof node !== 'object') return null
    if (node.type === 'button' && textOf(node) === label) return node
    return findBtn(node.props?.children, label)
  }
  const switchBtn = findBtn(tree, 'Switch')
  assert.ok(switchBtn, 'Switch button should appear when openSettings is available')
  switchBtn.props.onClick()
  assert.deepEqual(opened, [['plugins', 'browser']])
  inst.unmount()
})

test('BrowserPage renders inline Import cookies section when desktop bridge and bots are available', async () => {
  const harness = createHarness()
  const applied = []
  const canceled = []
  let sourceFetches = 0
  const imports = {
    sources: async () => {
      sourceFetches += 1
      return [
        { id: 'chrome:Default', kind: 'chrome', name: 'Chrome', label: 'Chrome — Personal', email: 'me@example.com', cookieCount: 24 },
      ]
    },
    live: async () => ({
      id: 'pending-1',
      preview: {
        source: { id: 'chrome:Default', kind: 'chrome', label: 'Chrome — Personal' },
        notes: ['session-cookies'],
        warnings: [],
        skipped: [],
        sites: [{ site: 'github.com', cookies: 12, session: 2, localStorage: 0 }],
      },
    }),
    apply: async (botId, pendingId, options) => {
      applied.push({ botId, pendingId, persistSession: options?.persistSession })
      return { stored: 12, originsStored: 0, dropped: [], failed: [] }
    },
    cancel: async (id) => { canceled.push(id) },
    pick: async () => ({ canceled: true }),
    paste: async () => ({ canceled: true }),
  }
  const roster = {
    bots: [
      { id: 'bot-a', name: 'Alpha' },
      { id: 'bot-b', name: 'Beta' },
    ],
  }
  const inst = harness.mount(harness.exports.BrowserPage, {
    roster, actions: { browserImport: imports }, run: () => {}, Section, Row,
  })

  let tree = inst.render()
  await new Promise((r) => setTimeout(r, 0))
  tree = inst.render()
  assert.equal(sourceFetches, 1)

  const importSection = allNodes(tree, (n) => n.type === Section && n.props?.title === 'Import cookies')[0]
  assert.ok(importSection, 'expected Import cookies section')

  const menuNode = allNodes(importSection, (n) => typeof n.type === 'function' && n.props?.inline === true && Array.isArray(n.props?.sources))[0]
  assert.ok(menuNode, 'expected inline ImportMenu')
  assert.equal(menuNode.props.sources.length, 1)

  // Verify real useEscape stack behavior against an outer Settings dialog layer:
  // (a) idle inline ImportMenu does not register on the stack, so outer Settings closes on Escape;
  // (b) active inline ImportCard in preview intercepts Escape and returns to menu;
  // (c) busy inline ImportCard in preview swallows Escape without closing Settings or canceling.
  let outerEscape = 0
  const OuterDialog = () => { harness.exports.useEscape(() => { outerEscape += 1 }); return null }
  const outerInst = harness.mount(OuterDialog, {})
  outerInst.render()

  const menuInst = harness.mount(menuNode.type, menuNode.props)
  menuInst.render()
  harness.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(outerEscape, 1, 'idle inline ImportMenu must let outer Settings Escape run')
  menuInst.unmount()

  // Picking a browser transitions inline to preview.
  await menuNode.props.onSource(menuNode.props.sources[0])
  tree = inst.render()
  const cardNode = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'preview')[0]
  assert.ok(cardNode, 'expected inline ImportCard in preview stage')
  assert.equal(cardNode.props.inline, true)

  // Busy inline ImportCard swallows Escape without firing outer Settings or onCancel.
  let busyCanceled = 0
  const busyCardInst = harness.mount(cardNode.type, { ...cardNode.props, busy: true, onCancel: () => { busyCanceled += 1 } })
  busyCardInst.render()
  harness.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(outerEscape, 1, 'busy inline ImportCard must not leak Escape to outer Settings')
  assert.equal(busyCanceled, 0, 'busy inline ImportCard must not cancel apply on Escape')
  busyCardInst.unmount()

  // Non-busy inline ImportCard intercepts Escape and invokes onCancel (without closing Settings).
  let previewCanceled = 0
  const activeCardInst = harness.mount(cardNode.type, { ...cardNode.props, busy: false, onCancel: () => { previewCanceled += 1 } })
  activeCardInst.render()
  harness.window.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
  assert.equal(outerEscape, 1, 'active inline ImportCard must consume Escape before outer Settings')
  assert.equal(previewCanceled, 1)
  activeCardInst.unmount()
  outerInst.unmount()

  // Switching target Bots mid-preview (batch select) keeps the preview and applies cookies to all selected Bots.
  const selectAllBtn = allNodes(tree, (n) => n.type === 'button' && n.props?.className === 'bt-browser-import-targets-btn')[0]
  assert.ok(selectAllBtn, 'expected Select all button for multiple Bots')
  selectAllBtn.props.onClick()
  tree = inst.render()
  const cardAfterBatch = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'preview')[0]
  assert.ok(cardAfterBatch, 'batch-selecting Bots during preview must preserve harvested preview')
  assert.equal(cardAfterBatch.props.canApply, true)
  assert.equal(canceled.length, 0)

  // Clearing all Bots disables apply cleanly without dropping the preview.
  const clearBtn = allNodes(tree, (n) => n.type === 'button' && n.props?.className === 'bt-browser-import-targets-btn')[0]
  clearBtn.props.onClick()
  tree = inst.render()
  const cardNoBots = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'preview')[0]
  assert.equal(cardNoBots.props.canApply, false)

  // Re-select both Bots via individual chips and apply in one batch.
  const chips = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'checkbox')
  assert.equal(chips.length, 2)
  chips[0].props.onClick()
  chips[1].props.onClick()
  tree = inst.render()
  const cardReady = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'preview')[0]
  assert.equal(cardReady.props.canApply, true)

  await cardReady.props.onApply({ sites: undefined, persistSession: true })
  tree = inst.render()
  assert.equal(applied.length, 1)
  assert.deepEqual(Array.from(applied[0].botId), ['bot-a', 'bot-b'])
  assert.equal(applied[0].pendingId, 'pending-1')
  assert.equal(applied[0].persistSession, true)

  const resultCard = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.flow?.stage === 'result')[0]
  assert.ok(resultCard, 'expected result stage after apply')
  assert.equal(resultCard.props.flow.botCount, 2)

  // Toggling a Bot chip on result stage returns cleanly to inline source menu for the next import.
  const chipsAfter = allNodes(tree, (n) => n.type === 'button' && n.props?.role === 'checkbox')
  chipsAfter[0].props.onClick()
  tree = inst.render()
  const menuAgain = allNodes(tree, (n) => typeof n.type === 'function' && n.props?.inline === true && Array.isArray(n.props?.sources))[0]
  assert.ok(menuAgain, 'toggling Bot on result stage should return to source menu')
  inst.unmount()
})
