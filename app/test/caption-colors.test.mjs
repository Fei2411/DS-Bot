import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const PRELOAD_SOURCE = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8')

function mountCaptionColors({
  mica = true,
  columnBg = 'rgb(250, 250, 250)',
  columnFg = 'rgb(20, 20, 20)',
  overlayLayers = [],
  canvasPixel = [10, 20, 30, 255],
  hidden = false,
} = {}) {
  const sent = []
  const observed = []
  let observerCallback
  let canvasCreated = 0
  const timers = new Map()
  let nextTimerId = 1
  const rafs = new Map()
  let nextRafId = 1
  const docListeners = new Map()
  const winListeners = new Map()
  const headListeners = new Map()

  const addTo = (map, type, fn) => { (map.get(type) ?? map.set(type, new Set()).get(type)).add(fn) }
  const fire = (map, type, event = {}) => { for (const fn of [...(map.get(type) ?? [])]) fn(event) }

  let bg = columnBg
  let fg = columnFg
  let layers = overlayLayers
  let isHidden = hidden

  const frame = {
    nodeType: 1,
    nodeName: 'DIV',
    parentElement: null,
    contains(el) { return el === this || el === col },
  }
  const col = {
    nodeType: 1,
    nodeName: 'DIV',
    parentElement: frame,
    getBoundingClientRect: () => ({ width: 320, height: 600 }),
    contains(el) { return el === this },
  }
  const titleEl = { nodeType: 1, nodeName: 'TITLE', parentElement: null }
  const titleText = { nodeType: 3, nodeName: '#text', parentElement: titleEl }
  const styleEl = { nodeType: 1, nodeName: 'STYLE', parentElement: null }
  const head = {
    nodeType: 1,
    nodeName: 'HEAD',
    contains(el) { return el === head || el === titleEl || el === titleText || el === styleEl },
    addEventListener(type, fn) { addTo(headListeners, type, fn) },
  }
  titleEl.parentElement = head
  styleEl.parentElement = head
  const body = {
    nodeType: 1,
    nodeName: 'BODY',
    dataset: {},
    getAttribute: () => null,
  }
  const root = {
    nodeType: 1,
    nodeName: 'HTML',
    dataset: {},
    style: { setProperty() {} },
    getAttribute: () => null,
  }

  class FakeMutationObserver {
    constructor(cb) {
      if (observed.length >= 1) observerCallback = cb
      this.cb = cb
    }
    observe(target, options) {
      observed.push({ target, options, cb: this.cb })
      // Identify captionColors' observer (observes document.body with childList: true).
      if (target === body && options?.childList === true) observerCallback = this.cb
    }
  }

  const document = {
    readyState: 'complete',
    documentElement: root,
    body,
    head,
    get hidden() { return isHidden },
    querySelector(selector) {
      if (selector.includes('_sidebarCol') || selector.includes('_rightbarCol') || selector.includes('_centerCol')) return col
      return null
    },
    elementsFromPoint() {
      return [...layers, col, frame]
    },
    createElement(tag) {
      if (tag === 'canvas') {
        canvasCreated += 1
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              clearRect() {},
              fillRect() {},
              set fillStyle(v) { this._fill = v },
              getImageData() { return { data: canvasPixel } },
            }
          },
        }
      }
      return { style: {}, dataset: {}, append() {}, setAttribute() {}, addEventListener() {} }
    },
    addEventListener(type, fn) { addTo(docListeners, type, fn) },
    removeEventListener() {},
  }

  const windowObj = {
    innerWidth: 1200,
    addEventListener(type, fn) { addTo(winListeners, type, fn) },
    removeEventListener() {},
  }

  const ipcRenderer = {
    send(channel, ...args) { if (channel === 'ds-bot:caption-colors') sent.push(args) },
    on() {},
    invoke: async () => undefined,
    removeAllListeners() {},
  }

  const fakeProcess = {
    platform: 'win32',
    argv: [
      'electron',
      '--ds-bot-origin=http://127.0.0.1:43117',
      '--ds-bot-caption=36',
      ...(mica ? ['--ds-bot-material=mica'] : []),
    ],
  }

  const sandbox = {
    process: fakeProcess,
    require(name) {
      if (name === 'electron') return { contextBridge: { exposeInMainWorld() {} }, ipcRenderer }
      throw new Error(`unexpected require ${name}`)
    },
    location: { origin: 'http://127.0.0.1:43117', href: 'http://127.0.0.1:43117/' },
    document,
    window: windowObj,
    innerWidth: 1200,
    MutationObserver: FakeMutationObserver,
    HTMLElement: class {},
    getComputedStyle(element, pseudo) {
      if (element === col) return { backgroundColor: bg, color: fg }
      if (element === frame) return { backgroundColor: 'rgba(0, 0, 0, 0)', color: fg }
      const found = layers.find(layer => layer === element)
      if (found) {
        if (pseudo === '::before') return { backgroundColor: found.before ?? 'rgba(0, 0, 0, 0)' }
        if (pseudo === '::after') return { backgroundColor: found.after ?? 'rgba(0, 0, 0, 0)' }
        return { backgroundColor: found.bg ?? 'rgba(0, 0, 0, 0)' }
      }
      return { backgroundColor: 'rgba(0, 0, 0, 0)', color: fg }
    },
    setTimeout(fn, ms) {
      const id = nextTimerId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame(fn) {
      const id = nextRafId++
      rafs.set(id, fn)
      return id
    },
    cancelAnimationFrame(id) { rafs.delete(id) },
    console,
  }

  runInNewContext(PRELOAD_SOURCE, sandbox)

  const flushTimers = () => {
    for (const [id, entry] of [...timers]) {
      timers.delete(id)
      entry.fn()
    }
  }
  const flushRafs = () => {
    for (const [id, fn] of [...rafs]) {
      rafs.delete(id)
      fn()
    }
  }

  return {
    sent,
    observed,
    body,
    root,
    head,
    frame,
    titleEl,
    titleText,
    styleEl,
    get canvasCreated() { return canvasCreated },
    get pendingTimers() { return timers.size },
    get pendingRafs() { return rafs.size },
    setColors(nextBg, nextFg = fg) { bg = nextBg; fg = nextFg },
    setLayers(next) { layers = next },
    setHidden(value) { isHidden = value; fire(docListeners, 'visibilitychange') },
    mutate(records) { observerCallback?.(records) },
    resize() { fire(winListeners, 'resize') },
    headLoad() { fire(headListeners, 'load') },
    flushTimers,
    flushRafs,
  }
}

test('captionColors parses rgb/rgba and composites dialog overlays in pure JS without creating a canvas', () => {
  const layer = {
    contains: () => false,
    bg: 'rgba(0, 0, 0, 0.5)',
    before: 'rgba(0, 0, 0, 0)',
    after: 'rgba(0, 0, 0, 0)',
  }
  const env = mountCaptionColors({
    columnBg: 'rgb(200, 100, 50)',
    columnFg: 'rgb(10, 20, 30)',
    overlayLayers: [layer],
  })
  // 50% black over rgb(200, 100, 50) => rgb(100, 50, 25)
  assert.deepEqual(env.sent, [['rgb(100, 50, 25)', 'rgb(10, 20, 30)']])
  assert.equal(env.canvasCreated, 0, 'pure-JS parser handles standard rgb/rgba without canvas readback')
})

test('captionColors falls back to lazy canvas only for exotic color formats', () => {
  const env = mountCaptionColors({
    columnBg: 'oklch(0.7 0.1 200)',
    columnFg: 'rgb(15, 15, 15)',
    canvasPixel: [120, 130, 140, 255],
  })
  assert.deepEqual(env.sent, [['rgb(120, 130, 140)', 'rgb(15, 15, 15)']])
  assert.equal(env.canvasCreated, 1, 'canvas is lazily created once for exotic color format')
})

test('captionColors scopes MutationObservers to exclude body subtree and head characterData/title updates', () => {
  const env = mountCaptionColors()
  const bodyObs = env.observed.find(entry => entry.target === env.body && entry.options.childList === true)
  assert.ok(bodyObs, 'body observer registered')
  assert.equal(bodyObs.options.subtree, undefined, 'body observer must not watch subtree')
  assert.deepEqual([...bodyObs.options.attributeFilter], ['data-ds-dark-theme', 'data-bt-material', 'data-bt-bg', 'style'])

  const headObs = env.observed.find(entry => entry.target === env.head)
  assert.ok(headObs, 'head observer registered')
  assert.equal(headObs.options.characterData, undefined, 'head observer must not watch characterData')

  const frameObs = env.observed.find(entry => entry.target === env.frame)
  assert.ok(frameObs, 'frame observer registered')
  assert.equal(frameObs.options.childList, true, 'frame observer tracks drawer mask/overlay children')
  assert.ok(frameObs.options.attributeFilter.includes('data-rightbar-collapsed'))
  assert.ok(frameObs.options.attributeFilter.includes('data-sidebar-drawer'))
  assert.ok(frameObs.options.attributeFilter.includes('data-drawer-open'))

  // Title text change in <head> must NOT schedule work.
  env.setColors('rgb(1, 2, 3)')
  env.mutate([{ type: 'childList', target: env.titleEl, addedNodes: [env.titleText], removedNodes: [] }])
  assert.equal(env.pendingTimers, 0)
  assert.equal(env.pendingRafs, 0)

  // Adding a <style> node in <head> DOES schedule a coalesced update.
  env.mutate([{ type: 'childList', target: env.head, addedNodes: [env.styleEl], removedNodes: [] }])
  assert.equal(env.pendingTimers, 1)
  env.flushTimers()
  env.flushRafs()
  assert.deepEqual(env.sent.at(-1), ['rgb(1, 2, 3)', 'rgb(20, 20, 20)'])

  // Persistent portal root added under body gets observed (shallow childList) without watching #root.
  const modalRoot = { nodeType: 1, nodeName: 'DIV', id: 'modal-root' }
  const appRoot = { nodeType: 1, nodeName: 'DIV', id: 'root' }
  env.mutate([{ type: 'childList', target: env.body, addedNodes: [modalRoot, appRoot], removedNodes: [] }])
  assert.ok(env.observed.some(entry => entry.target === modalRoot && entry.options.childList === true && !entry.options.subtree))
  assert.equal(env.observed.some(entry => entry.target === appRoot), false, 'must never watch #root')
})

test('captionColors pauses while document is hidden and updates immediately on visibilitychange or theme flip', () => {
  const env = mountCaptionColors({ hidden: true })
  assert.equal(env.sent.length, 0, 'skips measuring while hidden')

  // Resize and mutations while hidden schedule nothing.
  env.resize()
  env.mutate([{ type: 'attributes', target: env.body, attributeName: 'data-ds-dark-theme' }])
  assert.equal(env.pendingTimers, 0)
  assert.equal(env.pendingRafs, 0)

  // Becoming visible updates immediately.
  env.setHidden(false)
  assert.equal(env.sent.length, 1)

  // Theme attribute flip schedules immediate rAF without 80ms coalesce timer.
  env.setColors('rgb(30, 30, 32)', 'rgb(240, 240, 240)')
  env.mutate([{ type: 'attributes', target: env.body, attributeName: 'data-ds-dark-theme' }])
  assert.equal(env.pendingTimers, 0)
  assert.equal(env.pendingRafs, 1)
  env.flushRafs()
  assert.deepEqual(env.sent.at(-1), ['rgb(30, 30, 32)', 'rgb(240, 240, 240)'])
})
