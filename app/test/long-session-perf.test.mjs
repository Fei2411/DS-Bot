// Regression tests for W4 part 3 (#2472):
//  - Step 5: content-visibility: auto on message rows/cards + top IntersectionObserver auto-load
//  - Step 6: byte-budgeted LRU image cache with refcounted blob URLs + lightbox full-size revocation
//  - Step 7: ChatRows stable keys & memoized rows across appends/prepends + incremental room merges
//  - Step 8: matchMedia narrow breakpoint (0 resizes inside wide/narrow bands) + narrowed terminal observer
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { installMiniDom } from './mini-dom.mjs'

installMiniDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.window.matchMedia = globalThis.matchMedia
}

const appDir = fileURLToPath(new URL('..', import.meta.url))
const reactEntry = fileURLToPath(import.meta.resolve('react'))
const reactDomEntry = fileURLToPath(import.meta.resolve('react-dom'))
const reactDomClientEntry = fileURLToPath(import.meta.resolve('react-dom/client'))

const dir = mkdtempSync(join(tmpdir(), 'dsb-long-perf-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })

const entryCode = `
  export { createElement, act, useState } from 'react'
  export { createRoot } from 'react-dom/client'
  export { flushSync } from 'react-dom'
  export { computeImageCacheBudgetBytes, createImageCache, buildImageUrl } from './ui/src/image-cache.js'
  export { ImageLightbox } from './ui/src/image-lightbox.js'
  export { useNarrowViewport } from './ui/src/app.js'
  export { mergeIncrementalItems, mergeLatestPage, adaptRoomItems } from './ui/src/chat.js'
  export { ChatRows } from '../ds-bot/src/client/cells.js'
  export { installLocale } from '../ds-bot/src/client/i18n.js'
  export { WorkspaceTerminal } from './ui/src/workspace-terminal.js'
`

const { outputFiles } = await build({
  stdin: { contents: entryCode, resolveDir: appDir, loader: 'js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  nodePaths: [join(appDir, 'node_modules')],
  plugins: [{
    name: 'long-perf-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^react$/ }, () => ({ path: reactEntry }))
      bundler.onResolve({ filter: /^react-dom$/ }, () => ({ path: reactDomEntry }))
      bundler.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomClientEntry }))
      bundler.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'stub' }))
      bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({
        path: fileURLToPath(new URL('../ui/src/primitives.js', import.meta.url)),
      }))
      bundler.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export class Terminal { loadAddon(){} open(){} dispose(){} write(){} onData(){ return { dispose(){} } } options = {} }\nexport class FitAddon { fit(){} }\n',
        loader: 'js',
      }))
    },
  }],
})

const bundlePath = join(dir, 'bundle.mjs')
writeFileSync(bundlePath, outputFiles[0].text)
const {
  createElement: h,
  act,
  createRoot,
  flushSync,
  computeImageCacheBudgetBytes,
  createImageCache,
  buildImageUrl,
  ImageLightbox,
  useNarrowViewport,
  mergeIncrementalItems,
  mergeLatestPage,
  adaptRoomItems,
  ChatRows,
  installLocale,
  WorkspaceTerminal,
} = await import(pathToFileURL(bundlePath).href)

function mount(element) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(element))
  return {
    host,
    update(next) { act(() => root.render(next)) },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

test('Step 5: app.css sets content-visibility: auto with intrinsic block heights on desktop message rows and cards', () => {
  const css = readFileSync(join(appDir, 'ui', 'src', 'app.css'), 'utf8')
  assert.match(css, /\.bt-ubody,\.dsb-dsh-user-bubble\{content-visibility:auto;contain-intrinsic-block-size:auto \d+px\}/)
  assert.match(css, /\.dsb-dsh-asst-body\{content-visibility:auto;contain-intrinsic-block-size:auto \d+px\}/)
  assert.match(css, /\.dsb-tool\{content-visibility:auto;contain-intrinsic-block-size:auto \d+px\}/)
  assert.match(css, /\.dsb-deliverables\{content-visibility:auto;contain-intrinsic-block-size:auto \d+px\}/)
})

test('Step 6: image cache derives byte budget from deviceMemory, evicts LRU by bytes, defers revocation while mounted, and reloads cleanly', () => {
  const MiB = 1024 * 1024
  assert.equal(computeImageCacheBudgetBytes(undefined), 64 * MiB)
  assert.equal(computeImageCacheBudgetBytes(1), 32 * MiB)
  assert.equal(computeImageCacheBudgetBytes(4), 64 * MiB)
  assert.equal(computeImageCacheBudgetBytes(16), 128 * MiB)

  const revoked = []
  const cache = createImageCache({ maxBytes: 100, revokeObjectURL: url => revoked.push(url) })

  cache.set('k1', { url: 'blob:img-1', bytes: 60, isBlob: true })
  cache.set('k2', { url: 'blob:img-2', bytes: 40, isBlob: true })
  assert.equal(cache.size, 2)
  assert.equal(cache.totalBytes, 100)

  // Touch k1 so k2 becomes LRU, then insert k3 (40 bytes) -> evicts k2 immediately (unreferenced).
  assert.equal(cache.get('k1'), 'blob:img-1')
  const releaseK1 = cache.acquire('k1', 'blob:img-1')
  cache.set('k3', { url: 'blob:img-3', bytes: 40, isBlob: true })
  assert.equal(cache.has('k2'), false, 'LRU entry k2 evicted to respect byte budget')
  assert.equal(cache.has('k1'), true, 'recently used k1 stays cached')
  assert.deepEqual(revoked, ['blob:img-2'], 'unreferenced evicted blob URL revoked immediately')
  assert.equal(cache.totalBytes, 100)

  // Insert k4 (70 bytes) -> evicts k1 from cache, but k1 is still mounted so revocation waits.
  cache.set('k4', { url: 'blob:img-4', bytes: 70, isBlob: true })
  assert.equal(cache.has('k1'), false)
  assert.equal(cache.has('k3'), false)
  assert.deepEqual(revoked, ['blob:img-2', 'blob:img-3'], 'mounted k1 is not revoked while still held; unreferenced k3 revoked')

  // Unmounting k1 releases the last reference and revokes its blob URL.
  releaseK1()
  assert.deepEqual(revoked, ['blob:img-2', 'blob:img-3', 'blob:img-1'], 'evicted blob URL revoked once last consumer unmounts')

  // Overwriting the same (key, url) via set() must preserve active refs and never revoke while mounted.
  revoked.length = 0
  cache.clear()
  revoked.length = 0
  cache.set('same', { url: 'blob:same-url', bytes: 60, isBlob: true })
  const releaseSame = cache.acquire('same', 'blob:same-url')
  cache.set('same', { url: 'blob:same-url', bytes: 60, isBlob: true })
  cache.set('evictor', { url: 'blob:evictor', bytes: 80, isBlob: true })
  assert.equal(cache.has('same'), false, 'same entry evicted by budget')
  assert.deepEqual(revoked, [], 'same (key, url) overwritten via set() must preserve refs and not revoke while mounted')
  releaseSame()
  assert.deepEqual(revoked, ['blob:same-url'], 'revoked cleanly once active consumer releases')

  // Full-size image helper produces a blob URL when `blob: true` and data URL for compact previews.
  const fullBuilt = buildImageUrl('image/png', 'iVBORw0KGgo=', { blob: true })
  assert.equal(fullBuilt.isBlob, true)
  assert.ok(fullBuilt.url.startsWith('blob:'), 'full-size image uses blob: URL')
  URL.revokeObjectURL(fullBuilt.url)
  const previewBuilt = buildImageUrl('image/png', 'iVBORw0KGgo=', { blob: false })
  assert.equal(previewBuilt.isBlob, false)
  assert.equal(previewBuilt.url, 'data:image/png;base64,iVBORw0KGgo=')
})

test('Step 6: ImageLightbox revokes full-size blob URLs on close, unmount, and late resolution after close', async () => {
  const revoked = []
  const origRevoke = URL.revokeObjectURL
  URL.revokeObjectURL = url => revoked.push(url)
  try {
    let resolveFull
    const loadFull = () => new Promise((resolve) => { resolveFull = resolve })
    const view = mount(h(ImageLightbox, {
      open: true,
      src: 'blob:thumb-1',
      loadFull,
      alt: 'shot',
      onClose() {},
    }))
    await act(async () => {
      resolveFull('blob:full-1')
      await Promise.resolve()
    })
    assert.equal(revoked.length, 0, 'full blob URL stays alive while lightbox is open')

    // Closing lightbox revokes full blob URL, leaving thumbnail untouched.
    view.update(h(ImageLightbox, {
      open: false,
      src: 'blob:thumb-1',
      loadFull,
      alt: 'shot',
      onClose() {},
    }))
    assert.deepEqual(revoked, ['blob:full-1'])

    // Opening again and closing before loadFull resolves revokes the late-arriving blob URL immediately.
    let resolveLate
    const loadLate = () => new Promise((resolve) => { resolveLate = resolve })
    view.update(h(ImageLightbox, {
      open: true,
      src: 'blob:thumb-1',
      loadFull: loadLate,
      alt: 'shot',
      onClose() {},
    }))
    view.unmount()
    await act(async () => {
      resolveLate('blob:full-late')
      await Promise.resolve()
    })
    assert.deepEqual(revoked, ['blob:full-1', 'blob:full-late'])

    // If loadFull returns the thumbnail's own `src` blob URL, closing must NOT revoke the thumbnail.
    revoked.length = 0
    const sameView = mount(h(ImageLightbox, {
      open: true,
      src: 'blob:shared-thumb',
      loadFull: () => Promise.resolve('blob:shared-thumb'),
      alt: 'shot',
      onClose() {},
    }))
    await act(async () => { await Promise.resolve() })
    sameView.update(h(ImageLightbox, {
      open: false,
      src: 'blob:shared-thumb',
      loadFull: () => Promise.resolve('blob:shared-thumb'),
      alt: 'shot',
      onClose() {},
    }))
    sameView.unmount()
    assert.deepEqual(revoked, [], 'lightbox must never revoke the thumbnail src URL when loadFull returns it')
  } finally {
    URL.revokeObjectURL = origRevoke
  }
})

test('Step 7: ChatRows memoizes existing rows across incremental appends and prepends, and mergeIncrementalItems preserves references', () => {
  const roster = {
    bots: [{ id: 'b1', name: 'Chief', color: 'blue' }],
    byId: { b1: { id: 'b1', name: 'Chief', color: 'blue' } },
    rooms: [{ id: 'r1', name: 'Launch', members: ['b1'] }],
    roomsById: { r1: { id: 'r1', name: 'Launch', members: ['b1'] } },
    prefs: {},
  }
  const actions = { openSession() {}, openFile() {}, noteTurnTime() {} }
  const renderedTexts = []
  const renderUserText = ({ text }) => {
    renderedTexts.push(text)
    return text
  }

  const u1 = { id: '1', kind: 'user', text: 'first message', time: 1000 }
  const p1 = { id: 'c1:0', kind: 'post', seq: 'c1:0', botId: 'b1', name: 'Chief', text: 'reply one', time: 1010 }
  const initial = [u1, p1]

  const view = mount(h(ChatRows, {
    items: initial,
    sessionId: 'r1',
    roster,
    actions,
    clock: true,
    renderUserText,
  }))
  try {
    assert.deepEqual(renderedTexts, ['first message'])

    // Incremental append of u2 + p2 preserves u1/p1 references and does NOT re-render u1.
    const u2 = { id: '2', kind: 'user', text: 'second message', time: 1020 }
    const p2 = { id: 'c2:0', kind: 'post', seq: 'c2:0', botId: 'b1', name: 'Chief', text: 'reply two', time: 1030 }
    const afterAppend = mergeIncrementalItems(initial, [
      { ...p1 }, // identical copy of existing item -> must keep p1 identity
      u2,
      p2,
    ])
    assert.equal(afterAppend[0], u1, 'existing u1 object identity preserved')
    assert.equal(afterAppend[1], p1, 'unchanged p1 object identity preserved')
    assert.equal(afterAppend.length, 4)

    // Metadata updates (e.g. color/claims/presented path change with same array length) MUST NOT be dropped by itemsEqual.
    const withMetaUpdate = mergeIncrementalItems(afterAppend, [
      { ...p1, color: 'emerald', presented: [{ path: 'a.txt' }] },
    ])
    assert.notEqual(withMetaUpdate[1], p1, 'metadata update must replace item reference')
    assert.equal(withMetaUpdate[1].color, 'emerald')
    const withPresentedSwap = mergeIncrementalItems(withMetaUpdate, [
      { ...withMetaUpdate[1], presented: [{ path: 'b.txt' }] },
    ])
    assert.notEqual(withPresentedSwap[1], withMetaUpdate[1], 'same-length presented path change must replace item reference')
    assert.equal(withPresentedSwap[1].presented[0].path, 'b.txt')

    renderedTexts.length = 0
    view.update(h(ChatRows, {
      items: afterAppend,
      sessionId: 'r1',
      roster,
      actions,
      clock: true,
      renderUserText,
    }))
    assert.deepEqual(renderedTexts, ['second message'], 'only newly appended user row rendered; existing row u1 skipped')

    // Prepending an earlier page keeps u1 and u2 memoized (only u0 renders).
    const u0 = { id: '0', kind: 'user', text: 'earlier message', time: 500 }
    renderedTexts.length = 0
    view.update(h(ChatRows, {
      items: [u0, ...afterAppend],
      sessionId: 'r1',
      roster,
      actions,
      clock: true,
      renderUserText,
    }))
    assert.deepEqual(renderedTexts, ['earlier message'], 'prepending earlier page does not re-render existing rows')

    // mergeLatestPage also preserves unchanged row identity on full refresh.
    const refreshed = mergeLatestPage(afterAppend, { part: 0, beforeSeq: 1 }, [{ ...u2 }, { ...p2 }], null)
    assert.equal(refreshed.items[2], u2, 'mergeLatestPage reuses unchanged u2 reference')
    assert.equal(refreshed.items[3], p2, 'mergeLatestPage reuses unchanged p2 reference')

    // Multi-part collision regression: part 0 and part 1 both use id '1' and '2'.
    // adaptRoomItems must preserve sessionId on bot -> post and event -> relay, and
    // mergeIncrementalItems must NOT overwrite part 0's id '2' when part 1 appends id '2'.
    const part0Adapted = adaptRoomItems([
      { id: '1', sessionId: 'r1', kind: 'user', text: 'p0-1', time: 100 },
      { id: '2', sessionId: 'r1', kind: 'bot', botId: 'b1', name: 'Chief', text: 'p0-2', time: 110 },
      { id: '3', sessionId: 'r1', kind: 'event', event: 'done', botId: 'b1', name: 'Chief', time: 120 },
    ])
    assert.deepEqual(part0Adapted.map(i => i.sessionId), ['r1', 'r1', 'r1'], 'adaptRoomItems preserves sessionId on all kinds')
    const part1First = adaptRoomItems([
      { id: '1', sessionId: 'r1-p2', kind: 'user', text: 'p1-1', time: 200 },
    ])
    // Rolling over to a freshly created empty part (`items: []`, `cursor: { part: 0 }`)
    // must keep part 0 history on screen instead of wiping it before part 1 gets its first message.
    const afterEmptyRollover = mergeLatestPage(part0Adapted, null, [], { part: 0 })
    assert.deepEqual(afterEmptyRollover.items, part0Adapted, 'empty new part rollover preserves part 0 history')
    const afterRollover = mergeLatestPage(afterEmptyRollover.items, afterEmptyRollover.cursor, part1First, { part: 0 })
    assert.deepEqual(afterRollover.items.map(i => `${i.sessionId}:${i.id}`), ['r1:1', 'r1:2', 'r1:3', 'r1-p2:1'])
    const part1Second = adaptRoomItems([
      { id: '2', sessionId: 'r1-p2', kind: 'bot', botId: 'b1', name: 'Chief', text: 'p1-2', time: 210 },
    ])
    const afterPart1Inc = mergeIncrementalItems(afterRollover.items, part1Second)
    assert.deepEqual(
      afterPart1Inc.map(i => `${i.sessionId}:${i.id}:${i.text ?? i.reply?.kind}`),
      ['r1:1:p0-1', 'r1:2:p0-2', 'r1:3:done', 'r1-p2:1:p1-1', 'r1-p2:2:p1-2'],
      'incremental message in part 1 must append without overwriting part 0 item sharing bare id',
    )

    // Cyclic object safety in valuesEqual / mergeIncrementalItems: must not overflow stack.
    const cyclicA = { id: 'cyc', sessionId: 'r1', kind: 'user', text: 'loop', time: 300 }
    cyclicA.self = cyclicA
    const cyclicB = { id: 'cyc', sessionId: 'r1', kind: 'user', text: 'loop', time: 300 }
    cyclicB.self = cyclicB
    const cyclicMerged = mergeIncrementalItems([cyclicA], [cyclicB])
    assert.equal(cyclicMerged[0], cyclicA, 'cyclic structurally equal items compare cleanly without stack overflow')
  } finally {
    view.unmount()
  }
})

test('Step 7: ChatRows memoized rows re-render with updated copy when active locale changes', () => {
  let active = 'en'
  let revision = 0
  const dicts = new Map()
  const zhDict = { 'No background work detected': '未检测到后台任务', 'Replies from': '回复来自' }
  const fakeLocale = {
    dicts,
    getLocale: () => ({ active, locales: [] }),
    getSnapshot: () => ({ active, revision }),
    register: () => () => {},
    bind: () => (key) => (active === 'zh' && key in zhDict ? zhDict[key] : key),
    subscribe: () => () => {},
  }
  const dispose = installLocale(fakeLocale)
  const roster = {
    bots: [{ id: 'b1', name: 'Chief', color: 'blue' }],
    byId: { b1: { id: 'b1', name: 'Chief', color: 'blue' } },
    rooms: [{ id: 'r1', name: 'Launch', members: ['b1'] }],
    roomsById: { r1: { id: 'r1', name: 'Launch', members: ['b1'] } },
    prefs: {},
  }
  const actions = { openSession() {}, openFile() {}, noteTurnTime() {} }
  const items = [
    { id: 'p1', sessionId: 'r1', kind: 'post', seq: 'p1', botId: 'b1', name: 'Chief', text: 'working', claims: { inProgress: true }, time: 1000 },
    { id: 'e1', sessionId: 'r1', kind: 'event', role: 'report', roomId: 'r1', time: 1010 },
  ]
  const view = mount(h(ChatRows, { items, sessionId: 'r1', roster, actions }))
  try {
    assert.match(view.host.textContent, /No background work detected/)
    assert.match(view.host.textContent, /Replies from/)

    // Switch locale and re-render with the EXACT same items/roster/actions references.
    active = 'zh'
    revision += 1
    view.update(h(ChatRows, { items, sessionId: 'r1', roster, actions }))
    assert.match(view.host.textContent, /未检测到后台任务/, 'MemoGroupMessage must refresh copy on locale switch')
    assert.match(view.host.textContent, /回复来自/, 'MemoGroupEvent must refresh copy on locale switch')
  } finally {
    view.unmount()
    dispose()
  }
})

test('Step 8: useNarrowViewport uses matchMedia and skips re-renders on resizes inside the same breakpoint band', () => {
  const listeners = new Set()
  const mql = {
    matches: false,
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn) },
  }
  let resizeListeners = 0
  const fakeWin = {
    innerWidth: 1280,
    matchMedia: (query) => {
      assert.equal(query, '(max-width: 768px)')
      return mql
    },
    addEventListener(type) { if (type === 'resize') resizeListeners += 1 },
    removeEventListener() {},
  }
  let renders = 0
  let seen = null
  function Probe() {
    renders += 1
    seen = useNarrowViewport(fakeWin)
    return h('div', null, String(seen))
  }
  const view = mount(h(Probe))
  try {
    assert.equal(resizeListeners, 0, 'does not attach a window resize listener when matchMedia is available')
    assert.equal(renders, 1)
    assert.equal(seen, false)

    // Resizing within wide range (1280 -> 1024 -> 900) fires no matchMedia change -> 0 re-renders.
    fakeWin.innerWidth = 1024
    fakeWin.innerWidth = 900
    assert.equal(renders, 1)

    // Crossing below 768px triggers exactly 1 change event -> 1 re-render.
    mql.matches = true
    act(() => { for (const fn of listeners) fn({ matches: true }) })
    assert.equal(renders, 2)
    assert.equal(seen, true)

    // Duplicate change with same matches value triggers 0 extra renders.
    act(() => { for (const fn of listeners) fn({ matches: true }) })
    assert.equal(renders, 2)
  } finally {
    view.unmount()
  }
})

test('Step 8: WorkspaceTerminal observes document.head direct childList only (no subtree/characterData)', () => {
  const observed = []
  const OrigMO = globalThis.MutationObserver
  globalThis.MutationObserver = class RecordingMO {
    constructor(cb) { this.cb = cb }
    observe(target, options) { observed.push({ target, options }) }
    disconnect() {}
    takeRecords() { return [] }
  }
  try {
    const view = mount(h(WorkspaceTerminal, {
      sessionId: 'b1',
      visible: false,
      feed: null,
    }))
    try {
      const headObs = observed.find(entry => entry.target === document.head)
      assert.ok(headObs, 'still observes document.head for theme <style> swaps')
      assert.deepEqual(headObs.options, { childList: true }, 'must not observe document.head subtree or characterData')
      const htmlObs = observed.find(entry => entry.target === document.documentElement)
      assert.ok(Array.isArray(htmlObs?.options?.attributeFilter), 'documentElement observer narrows to theme attributes')
    } finally {
      view.unmount()
    }
  } finally {
    globalThis.MutationObserver = OrigMO
  }
})
