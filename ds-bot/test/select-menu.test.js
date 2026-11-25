import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function loadBundle() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { SelectMenu, measureSelectPlace, flattenOptions, snapListMaxHeight } from './src/client/select-menu.js'
        export { ownedPopups } from './src/client/popup-ownership.js'
        export { useEscape } from './src/client/overlay-hooks.js'
      `,
      resolveDir: join(repoRoot, 'ds-bot'),
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom'],
  })
  return outputFiles[0].text
}

function makeHarness() {
  const states = new Map()
  const effects = new Map()
  const prevDeps = new Map()
  const cleanups = new Map()
  let path = ''
  let idx = 0

  const slot = () => `${path}#${idx++}`
  const changed = (a, b) => {
    if (a === undefined || b === undefined || a.length !== b.length) return true
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return true
    return false
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    useState(init) {
      const k = slot()
      if (!states.has(k)) states.set(k, typeof init === 'function' ? init() : init)
      return [states.get(k), next => states.set(k, typeof next === 'function' ? next(states.get(k)) : next)]
    },
    useRef(init) {
      const k = slot()
      if (!states.has(k)) states.set(k, { current: init })
      return states.get(k)
    },
    useMemo(fn) {
      const k = slot()
      const val = fn()
      states.set(k, val)
      return val
    },
    useId() { return 'sel-id' },
    useEffect(fn, deps) { effects.set(slot(), { fn, deps }) },
    useLayoutEffect(fn, deps) { effects.set(slot(), { fn, deps }) },
  }

  const expand = (node, p = 'root') => {
    if (Array.isArray(node)) return node.map((c, i) => expand(c, `${p}[${i}]`))
    if (!node || typeof node !== 'object') return node
    if (node.type === React.Fragment) return expand(node.children, `${p}.F`)
    if (typeof node.type === 'function') {
      const cp = `${p}/${node.type.name || 'Fn'}:${node.props?.key ?? ''}`
      path = cp
      idx = 0
      return expand(node.type({ ...node.props, children: node.children }), cp)
    }
    return { ...node, children: expand(node.children ?? [], `${p}.${node.type}`) }
  }

  const flush = () => {
    for (const [k, { fn, deps }] of effects.entries()) {
      if (!changed(prevDeps.get(k), deps)) continue
      cleanups.get(k)?.()
      prevDeps.set(k, deps)
      const c = fn()
      if (typeof c === 'function') cleanups.set(k, c)
      else cleanups.delete(k)
    }
    effects.clear()
  }

  return {
    React,
    render(el, onCommit) {
      effects.clear()
      const tree = expand(el)
      onCommit?.(tree)
      flush()
      return tree
    },
    unmount() {
      for (const c of cleanups.values()) c()
      cleanups.clear()
    },
  }
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) findAll(c, pred, out)
  return out
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

async function withWindow(fn) {
  const prevWin = globalThis.window
  const prevDoc = globalThis.document
  const captureListeners = new Map()
  const bubbleListeners = new Map()
  const add = (map, type, cb) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(cb)
  }
  const remove = (map, type, cb) => { map.get(type)?.delete(cb) }
  globalThis.window = {
    innerWidth: 1360,
    innerHeight: 860,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, cb, capture) { add(capture ? captureListeners : bubbleListeners, type, cb) },
    removeEventListener(type, cb, capture) { remove(capture ? captureListeners : bubbleListeners, type, cb) },
  }
  globalThis.document = {
    body: { dataset: {} },
    documentElement: { dataset: {} },
    activeElement: null,
  }
  const dispatch = (type, event) => {
    let stopped = false
    let immStopped = false
    const ev = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { stopped = true },
      stopImmediatePropagation() { stopped = true; immStopped = true },
      ...event,
    }
    for (const cb of Array.from(captureListeners.get(type) ?? [])) {
      cb(ev)
      if (immStopped) break
    }
    if (!stopped) {
      for (const cb of Array.from(bubbleListeners.get(type) ?? [])) {
        cb(ev)
        if (immStopped) break
      }
    }
    return ev
  }
  try {
    return await fn({ dispatch })
  } finally {
    globalThis.window = prevWin
    globalThis.document = prevDoc
  }
}

test('measureSelectPlace aligns right in Settings rows, flips above near bottom, and centers compact pickers', async () => {
  const code = await loadBundle()
  await withWindow(async () => {
    const harness = makeHarness()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { measureSelectPlace, flattenOptions } = mod.exports

    assert.deepEqual(
      flattenOptions([{ group: 'Bots', options: [{ value: 'a', label: 'A' }] }, { value: 'b', label: 'B' }]).map(o => o.value),
      ['a', 'b'],
    )

    // Standard trigger on right half of Settings row opens below & right-aligned.
    const rightTrigger = { getBoundingClientRect: () => ({ left: 900, right: 1060, top: 200, bottom: 234, width: 160, height: 34 }) }
    const belowRight = measureSelectPlace(rightTrigger)
    assert.equal(belowRight.top, 238)
    assert.equal(belowRight.bottom, undefined)
    assert.equal(belowRight.minWidth, 180)
    assert.equal(belowRight.left, 1060 - 180)
    assert.equal(belowRight['--bt-origin'], 'top right')

    // Trigger near bottom flips above without overflowing.
    const bottomTrigger = { getBoundingClientRect: () => ({ left: 900, right: 1060, top: 790, bottom: 824, width: 160, height: 34 }) }
    const aboveRight = measureSelectPlace(bottomTrigger)
    assert.equal(aboveRight.top, undefined)
    assert.equal(aboveRight.bottom, 860 - 790 + 4)
    assert.equal(aboveRight['--bt-origin'], 'bottom right')

    // Wide menu clamps horizontally inside viewport.
    const edgeTrigger = { getBoundingClientRect: () => ({ left: 1290, right: 1350, top: 120, bottom: 154, width: 60, height: 34 }) }
    const clamped = measureSelectPlace(edgeTrigger, { menuWidth: 260 })
    assert.ok(clamped.left >= 8 && clamped.left + 260 <= 1360 - 8)

    // Compact variant centers beneath trigger with compact minWidth.
    const ymTrigger = { getBoundingClientRect: () => ({ left: 400, right: 460, top: 180, bottom: 208, width: 60, height: 28 }) }
    const compact = measureSelectPlace(ymTrigger, { variant: 'compact' })
    assert.equal(compact.minWidth, 112)
    assert.equal(compact.left, Math.round(400 + (60 - 112) / 2))
    assert.equal(compact['--bt-origin'], 'top center')
  })
})

test('SelectMenu opens in portal, isolates Escape from outer dialog, supports groups/disabled/compact, and selects cleanly', async () => {
  const code = await loadBundle()
  await withWindow(async ({ dispatch }) => {
    const harness = makeHarness()
    const mod = { exports: {} }
    const portals = []
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === 'react-dom'
        ? { createPortal: (el, target) => { portals.push(target); return el } }
        : harness.React
    ))
    const { SelectMenu, useEscape } = mod.exports

    let outerEscapes = 0
    let picked = []
    let value = 'en'
    const options = [
      { value: 'auto', label: 'System default' },
      { value: 'en', label: 'English' },
      { value: 'zh', label: '简体中文' },
      { value: 'locked', label: 'Locked', disabled: true },
    ]
    function Host() {
      useEscape(() => { outerEscapes += 1 }, true)
      return harness.React.createElement(SelectMenu, {
        'aria-label': 'Language',
        value,
        options,
        onChange: next => { picked.push(next); value = next },
      })
    }

    let tree = harness.render(harness.React.createElement(Host))
    assert.equal(findAll(tree, n => n.type === 'select').length, 0, 'never renders raw HTML <select>')
    const trigger = () => findAll(tree, n => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0]
    assert.equal(trigger().props['aria-expanded'], false)
    assert.equal(textOf(trigger()), 'English')
    assert.equal(findAll(tree, n => n.props?.role === 'listbox').length, 0)

    // Open menu via click -> portal renders listbox on document.body.
    portals.length = 0
    trigger().props.onClick({ detail: 1 })
    tree = harness.render(harness.React.createElement(Host))
    assert.equal(trigger().props['aria-expanded'], true)
    assert.equal(portals.at(-1), globalThis.document.body)
    const listbox = findAll(tree, n => n.props?.role === 'listbox')[0]
    assert.ok(listbox)
    const opts = findAll(listbox, n => n.props?.role === 'option')
    assert.equal(opts.length, 4)
    assert.equal(opts[1].props['aria-selected'], true)
    assert.equal(opts[3].props.disabled, true)

    // Disabled option does not fire onChange.
    opts[3].props.onClick()
    assert.deepEqual(picked, [])

    // Escape closes ONLY SelectMenu and MUST NOT trigger outer useEscape (Settings dialog stays open!).
    const esc = dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
    assert.equal(esc.defaultPrevented, true)
    assert.equal(outerEscapes, 0, 'Escape while SelectMenu is open must not close Settings')
    tree = harness.render(harness.React.createElement(Host))
    assert.equal(trigger().props['aria-expanded'], false)

    // Second Escape (now that SelectMenu is closed) reaches outer dialog.
    dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 27 })
    assert.equal(outerEscapes, 1)

    // Reopen with ArrowDown and choose 简体中文 -> fires onChange and closes.
    trigger().props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
    tree = harness.render(harness.React.createElement(Host))
    assert.equal(trigger().props['aria-expanded'], true)
    findAll(tree, n => n.props?.role === 'option' && textOf(n) === '简体中文')[0].props.onClick()
    assert.deepEqual(picked, ['zh'])
    tree = harness.render(harness.React.createElement(Host))
    assert.equal(trigger().props['aria-expanded'], false)
    assert.equal(textOf(trigger()), '简体中文')

    // Clicking already-selected option does not re-fire onChange.
    trigger().props.onClick({ detail: 1 })
    tree = harness.render(harness.React.createElement(Host))
    findAll(tree, n => n.props?.role === 'option' && textOf(n) === '简体中文')[0].props.onClick()
    assert.deepEqual(picked, ['zh'])
    harness.unmount()

    // Grouped options + placeholder + compact variant.
    const harness2 = makeHarness()
    const mod2 = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod2, mod2.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : harness2.React
    ))
    let groupTree = harness2.render(harness2.React.createElement(mod2.exports.SelectMenu, {
      'aria-label': 'Send to',
      variant: 'compact',
      value: '',
      placeholder: 'Choose a Bot…',
      options: [
        { group: 'Bots', options: [{ value: 'b1', label: 'Chief' }] },
        { group: 'Group chats', options: [{ value: 'r1', label: 'Team' }] },
      ],
      onChange() {},
    }))
    const gTrigger = findAll(groupTree, n => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0]
    assert.equal(gTrigger.props['data-variant'], 'compact')
    assert.equal(gTrigger.props['data-placeholder'], '')
    assert.equal(textOf(gTrigger), 'Choose a Bot…')
    gTrigger.props.onClick({ detail: 1 })
    groupTree = harness2.render(harness2.React.createElement(mod2.exports.SelectMenu, {
      'aria-label': 'Send to',
      variant: 'compact',
      value: '',
      placeholder: 'Choose a Bot…',
      options: [
        { group: 'Bots', options: [{ value: 'b1', label: 'Chief' }] },
        { group: 'Group chats', options: [{ value: 'r1', label: 'Team' }] },
      ],
      onChange() {},
    }))
    assert.equal(findAll(groupTree, n => n.props?.role === 'group').length, 2)
    harness2.unmount()
  })
})

test('SelectMenu handles Arrow/Home/End/Tab keyboard focus, click-outside, and ownedPopups registration', async () => {
  const code = await loadBundle()
  await withWindow(async ({ dispatch }) => {
    const harness = makeHarness()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SelectMenu, ownedPopups } = mod.exports

    const focused = []
    const makeItem = (label, selected = false) => ({
      textContent: label,
      getAttribute: attr => (attr === 'aria-selected' ? String(selected) : null),
      focus() { focused.push(label); globalThis.document.activeElement = this },
      getBoundingClientRect: () => ({ top: 0, bottom: 30, height: 30 }),
    })
    const items = [makeItem('Alpha', false), makeItem('Beta', true), makeItem('Gamma', false)]
    let triggerFocused = 0
    const triggerNode = {
      getBoundingClientRect: () => ({ left: 200, right: 360, top: 100, bottom: 134, width: 160, height: 34 }),
      contains: target => target === triggerNode,
      focus() { triggerFocused += 1; globalThis.document.activeElement = triggerNode },
    }
    const menuNode = {
      isConnected: true,
      offsetWidth: 180,
      scrollHeight: 100,
      clientHeight: 100,
      scrollTop: 0,
      hasAttribute: () => false,
      contains: target => target === menuNode || items.includes(target),
      querySelectorAll: () => items,
      querySelector: () => items[1],
      focus() { globalThis.document.activeElement = menuNode },
      getBoundingClientRect: () => ({ top: 138, bottom: 238, height: 100 }),
    }
    const outerContainer = { contains: target => target === outerContainer || target === triggerNode }

    const renderSelect = () => {
      const tree = harness.render(harness.React.createElement(SelectMenu, {
        'aria-label': 'Letters',
        value: 'b',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma' },
        ],
        onChange() {},
      }))
      const trig = findAll(tree, n => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0]
      if (trig?.props?.ref) trig.props.ref.current = triggerNode
      const lb = findAll(tree, n => n.props?.role === 'listbox')[0]
      if (lb?.props?.ref) lb.props.ref.current = menuNode
      return { tree, trig, lb }
    }

    let view = renderSelect()
    view.trig.props.onClick({ detail: 1 })
    view = renderSelect()
    assert.ok(view.lb, 'listbox is rendered')
    // Re-run layout effect now that refs are bound to fake DOM elements.
    assert.deepEqual(ownedPopups([outerContainer]), [menuNode], 'SpanPicker container owns open SelectMenu portal')

    globalThis.document.activeElement = menuNode
    dispatch('keydown', { key: 'ArrowDown', isComposing: false })
    assert.equal(focused.at(-1), 'Gamma', 'ArrowDown from selected Beta moves to Gamma')
    dispatch('keydown', { key: 'ArrowDown', isComposing: false })
    assert.equal(focused.at(-1), 'Alpha', 'ArrowDown wraps from last to first')
    dispatch('keydown', { key: 'End', isComposing: false })
    assert.equal(focused.at(-1), 'Gamma', 'End moves to last option')
    dispatch('keydown', { key: 'Home', isComposing: false })
    assert.equal(focused.at(-1), 'Alpha', 'Home moves to first option')
    dispatch('keydown', { key: 'ArrowUp', isComposing: false })
    assert.equal(focused.at(-1), 'Gamma', 'ArrowUp wraps from first to last')

    // Click inside menu stays open; click outside closes.
    dispatch('mousedown', { target: items[0] })
    view = renderSelect()
    assert.equal(view.trig.props['aria-expanded'], true)

    dispatch('mousedown', { target: { closest: () => null } })
    view = renderSelect()
    assert.equal(view.trig.props['aria-expanded'], false)

    // Reopen and press Tab -> focuses trigger and closes menu.
    view.trig.props.onClick({ detail: 1 })
    view = renderSelect()
    assert.equal(view.trig.props['aria-expanded'], true)
    dispatch('keydown', { key: 'Tab', isComposing: false })
    assert.ok(triggerFocused >= 1)
    view = renderSelect()
    assert.equal(view.trig.props['aria-expanded'], false)
    harness.unmount()
  })
})

test('snapListMaxHeight and revealInBox keep scrollable compact Month dropdown aligned to whole rows', async () => {
  const code = await loadBundle()
  await withWindow(async () => {
    const harness = makeHarness()
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : harness.React
    ))
    const { SelectMenu, snapListMaxHeight } = mod.exports

    // 12 compact month rows (28px height, 2px gap -> 358px inner scrollHeight) inside a
    // 6px-padded, 0.5px-bordered .bt-sel-menu (13px frameY). Capped at 320px, maxHeight
    // snaps to 311px -> 298px inner scrollport = 10 whole rows with 0px row peeking at
    // every scrollTop = k * 30 (maxScroll = 60px).
    const scrollState = { v: 0 }
    const monthItems = Array.from({ length: 12 }, (_, i) => ({
      textContent: `M${i + 1}`,
      getAttribute: attr => (attr === 'aria-selected' ? String(i === 9) : null),
      getBoundingClientRect: () => ({ top: 106 + i * 30 - scrollState.v, bottom: 106 + i * 30 + 28 - scrollState.v, height: 28 }),
      focus() {},
    }))
    let currentMaxHeight = 320
    const scroller = {
      scrollHeight: 358,
      get clientHeight() { return currentMaxHeight - 13 },
      get scrollTop() { return scrollState.v },
      set scrollTop(v) { scrollState.v = v },
      querySelector: sel => (sel === '.bt-sel-group' ? null : monthItems[9]),
      querySelectorAll: () => monthItems,
      getBoundingClientRect: () => ({ top: 106, bottom: 106 + currentMaxHeight - 13, height: currentMaxHeight - 13 }),
    }
    const box = {
      get offsetHeight() { return currentMaxHeight },
      offsetWidth: 112,
      querySelector: sel => (sel === '.bt-sel-list' ? scroller : sel === '.bt-sel-group' ? null : monthItems[9]),
      querySelectorAll: () => monthItems,
      getBoundingClientRect: () => ({ top: 100, bottom: 100 + currentMaxHeight, height: currentMaxHeight }),
      focus() {},
    }
    assert.equal(snapListMaxHeight(box, 320, scroller), 311, 'snaps 320px cap down to 10 whole 28px rows')

    const triggerNode = {
      getBoundingClientRect: () => ({ left: 400, right: 460, top: 60, bottom: 88, width: 60, height: 28 }),
      contains: () => false,
    }
    const months = Array.from({ length: 12 }, (_, m) => ({ value: m, label: `M${m + 1}` }))
    const draw = () => {
      let trig
      let lb
      harness.render(harness.React.createElement(SelectMenu, {
        'aria-label': 'Month',
        variant: 'compact',
        value: 9,
        options: months,
        onChange() {},
      }), (tree) => {
        trig = findAll(tree, n => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0]
        if (trig?.props?.ref) trig.props.ref.current = triggerNode
        lb = findAll(tree, n => n.props?.role === 'listbox')[0]
        if (lb?.props?.ref) lb.props.ref.current = box
        if (lb?.props?.style?.maxHeight) currentMaxHeight = lb.props.style.maxHeight
        const inner = findAll(tree, n => n.props?.className === 'bt-sel-list')[0]
        if (inner?.props?.ref) inner.props.ref.current = scroller
      })
      return { trig, lb }
    }
    let view = draw()
    view.trig.props.onClick({ detail: 1 })
    view = draw()
    view = draw()
    assert.equal(view.lb.props.style.maxHeight, 311)
    assert.equal(scroller.clientHeight, 298, 'inner scrollport fits exactly 10 whole 28px rows + 9 gaps')
    assert.equal(scrollState.v % 30, 0, 'scrollTop aligns on exact row stride so no top or bottom row is half-clipped')
    assert.ok(scrollState.v <= 60 && scrollState.v >= 0)
    harness.unmount()

    // Transform-scaled entrance (bt-pop-drop scale: 0.96): getBoundingClientRect() reports
    // 26.88px rows & 28.8px stride, while offsetHeight/offsetTop stay unscaled (28px / 30px).
    // Both snapListMaxHeight and revealInBox must use offsetHeight/offsetTop so maxHeight
    // snaps to 311px (298px scrollport) and scrollTop lands at 60px instead of clipping by 10px.
    const scaledHarness = makeHarness()
    const scaledMod = { exports: {} }
    new Function('module', 'exports', 'require', code)(scaledMod, scaledMod.exports, id => (
      id === 'react-dom' ? { createPortal: el => el } : scaledHarness.React
    ))
    const scale = 0.96
    const scaledScroll = { v: 0 }
    let scaledMaxHeight = 320
    const scaledScroller = {
      scrollHeight: 358,
      get clientHeight() { return scaledMaxHeight - 13 },
      get scrollTop() { return scaledScroll.v },
      set scrollTop(v) { scaledScroll.v = v },
      querySelector: sel => (sel === '.bt-sel-group' ? null : scaledItems[9]),
      querySelectorAll: () => scaledItems,
      getBoundingClientRect: () => ({
        top: 106,
        bottom: 106 + (scaledMaxHeight - 13) * scale,
        height: (scaledMaxHeight - 13) * scale,
      }),
    }
    const scaledItems = Array.from({ length: 12 }, (_, i) => ({
      textContent: `M${i + 1}`,
      offsetParent: scaledScroller,
      offsetTop: i * 30,
      offsetHeight: 28,
      getAttribute: attr => (attr === 'aria-selected' ? String(i === 9) : null),
      getBoundingClientRect: () => ({
        top: 106 + (i * 30 - scaledScroll.v) * scale,
        bottom: 106 + (i * 30 + 28 - scaledScroll.v) * scale,
        height: 28 * scale,
      }),
      focus() {},
    }))
    const scaledBox = {
      get offsetHeight() { return scaledMaxHeight },
      offsetWidth: 112,
      querySelector: sel => (sel === '.bt-sel-list' ? scaledScroller : sel === '.bt-sel-group' ? null : scaledItems[9]),
      querySelectorAll: () => scaledItems,
      getBoundingClientRect: () => ({ top: 100, bottom: 100 + scaledMaxHeight * scale, height: scaledMaxHeight * scale }),
      focus() {},
    }
    assert.equal(
      scaledMod.exports.snapListMaxHeight(scaledBox, 320, scaledScroller),
      311,
      'ignores CSS transform scale(0.96) in getBoundingClientRect and snaps using unscaled offsetHeight/offsetTop',
    )
    const drawScaled = () => {
      let trig
      let lb
      scaledHarness.render(scaledHarness.React.createElement(scaledMod.exports.SelectMenu, {
        'aria-label': 'Month',
        variant: 'compact',
        value: 9,
        options: months,
        onChange() {},
      }), (tree) => {
        trig = findAll(tree, n => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0]
        if (trig?.props?.ref) trig.props.ref.current = triggerNode
        lb = findAll(tree, n => n.props?.role === 'listbox')[0]
        if (lb?.props?.ref) lb.props.ref.current = scaledBox
        if (lb?.props?.style?.maxHeight) scaledMaxHeight = lb.props.style.maxHeight
        const inner = findAll(tree, n => n.props?.className === 'bt-sel-list')[0]
        if (inner?.props?.ref) inner.props.ref.current = scaledScroller
      })
      return { trig, lb }
    }
    let scaledView = drawScaled()
    scaledView.trig.props.onClick({ detail: 1 })
    scaledView = drawScaled()
    scaledView = drawScaled()
    assert.equal(scaledView.lb.props.style.maxHeight, 311, 'scaled entrance still snaps to 311px (298px inner)')
    assert.equal(scaledScroller.clientHeight, 298)
    assert.equal(scaledScroll.v, 60, 'Oct opens at exact row boundary scrollTop = 60px (Mar at y=0, Dec flush at y=298)')
    scaledHarness.unmount()
  })
})
