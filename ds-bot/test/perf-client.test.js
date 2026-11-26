import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createAvatarRefCache } from '../src/client/avatar-refs.js'
import { lruGet, lruSet } from '../src/client/memo.js'
import { installFrameWatch } from '../src/client/frame-watch.js'
import { installMotionRest } from '../src/client/motion-rest.js'
import { openCapture } from '../src/client/speech.js'
import { createAppViewProxy, createBotBrowsers } from '../src/client/bot-browsers.js'
import { installAgentForks } from '../src/client/agent-fork.js'
import { teamActions } from '../src/client/team-actions.js'
import { createSource } from '../src/client/sources.js'
import { characterMarkup, markupCache, maskCache, maskOf } from '../src/client/characters.js'
import { readSkinSurfaceVars, writeSkinSurfaceVars } from '../src/client/skin.js'
import { STORAGE } from '../src/client/storage.js'
import { install as installMobile } from '../src/host/mobile.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')
const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const tick = () => new Promise(resolve => setImmediate(resolve))

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

async function loadClientModule(entry, extraGlobals = {}, reactOverrides = {}) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const mod = { exports: {} }
  const states = []
  const refs = []
  const callbacks = []
  const memos = []
  const effectSlots = []
  const pendingEffects = []
  let stateCursor = 0
  let refCursor = 0
  let callbackCursor = 0
  let memoCursor = 0
  let effectCursor = 0
  const scheduleEffect = (fn, deps) => {
    const idx = effectCursor++
    const prev = effectSlots[idx]
    if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) {
      pendingEffects.push({ idx, fn, deps })
    }
  }
  const react = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    createContext: (initial) => {
      const ctx = { value: initial }
      ctx.Provider = ({ value, children }) => { ctx.value = value; return children }
      return ctx
    },
    useContext: ctx => ctx.value,
    useId: () => 'test-id',
    useCallback: (fn, deps) => {
      const idx = callbackCursor++
      const prev = callbacks[idx]
      if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) {
        callbacks[idx] = { fn, deps }
      }
      return callbacks[idx].fn
    },
    useMemo: (make, deps) => {
      const idx = memoCursor++
      const prev = memos[idx]
      if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) {
        memos[idx] = { value: make(), deps }
      }
      return memos[idx].value
    },
    useRef: (initial) => {
      const idx = refCursor++
      if (!(idx in refs)) refs[idx] = { current: initial }
      return refs[idx]
    },
    useState: (initial) => {
      const idx = stateCursor++
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next
      }
      return [states[idx], setState]
    },
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
    useSyncExternalStore: (_sub, get) => get(),
    ...reactOverrides,
  }
  const platform = {
    react,
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
  }
  const vmSandbox = {
    module: mod,
    exports: mod.exports,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    AbortController,
    AbortSignal,
    btoa,
    atob,
    console,
    require: (name) => {
      if (name in platform) return platform[name]
      throw new Error(`unexpected require ${name}`)
    },
  }
  Object.defineProperties(vmSandbox, Object.getOwnPropertyDescriptors(extraGlobals))
  runInNewContext(bundled.outputFiles[0].text, vmSandbox)
  return {
    exports: mod.exports,
    states,
    refs,
    resetRender: () => { stateCursor = 0; refCursor = 0; callbackCursor = 0; memoCursor = 0; effectCursor = 0 },
    flushEffects: () => {
      while (pendingEffects.length > 0) {
        const { idx, fn, deps } = pendingEffects.shift()
        if (typeof effectSlots[idx]?.cleanup === 'function') effectSlots[idx].cleanup()
        const cleanup = fn()
        effectSlots[idx] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
      }
    },
    unmount: () => {
      for (const slot of effectSlots) {
        if (typeof slot?.cleanup === 'function') slot.cleanup()
      }
      effectSlots.length = 0
    },
  }
}

async function bootClientIndex({ rpc, dsBotApp, storage = makeStorage(), initialSessions = {} } = {}) {
  const dom = new JSDOM('<!doctype html><head></head><body><div id="root"></div></body>', { url: 'http://localhost/' })
  const { window } = dom
  const { document } = window
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const timers = new Map()
  const intervals = new Map()
  let timerSeq = 0
  let intervalSeq = 0
  const trackedSetTimeout = (fn, ms = 0) => {
    const id = ++timerSeq
    timers.set(id, { fn, ms })
    return id
  }
  const trackedClearTimeout = (id) => { timers.delete(id) }
  const trackedSetInterval = (fn, ms = 0) => {
    const id = ++intervalSeq
    intervals.set(id, { fn, ms })
    return id
  }
  const trackedClearInterval = (id) => { intervals.delete(id) }

  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  if (dsBotApp !== undefined) window.dsBotApp = dsBotApp

  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    try {
      const value = await rpc(body.endpoint, body.payload)
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    } catch (error) {
      if (error?.network) throw error
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? 'failed' } }),
      }
    }
  }

  const sessionsList = createSource({ byId: initialSessions })
  const effectDisposers = []
  const slotsMap = new Map()
  const ctx = {
    get: (name) => {
      if (name === 'locale') {
        const source = createSource({ locale: 'en', revision: 0 })
        return { ...source, bind: () => key => key }
      }
      return undefined
    },
    on: () => () => {},
    effect: (fn, label) => {
      const dispose = fn()
      effectDisposers.push({ label, dispose })
      return { dispose: () => { if (typeof dispose === 'function') dispose() } }
    },
    inject: () => ({ dispose() {} }),
    theme: { overrideTokens: () => () => {} },
    layout: { selectPanel() {}, toggleSidebar() {} },
    uiWorkspace: { openSession() {} },
    uiConversation: {},
    slots: {
      entries: name => slotsMap.get(name) ?? [],
      subscribe: () => () => {},
      inject: (_name, register) => { register(); return () => {} },
      register: (spec, component) => {
        const list = slotsMap.get(spec.name) ?? []
        list.push({ ...spec, component })
        slotsMap.set(spec.name, list)
        return () => {}
      },
      spec: () => ({}),
    },
    sessions: {
      list: sessionsList,
      fork: async () => 'forked-session',
      refresh: async () => {},
      refreshProjections: async () => {},
      binding: () => undefined,
    },
  }

  const loaded = await loadClientModule('index.js', {
    window,
    document,
    localStorage: storage,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({ width: '240px', getPropertyValue: () => '' }),
    fetch: fetchMock,
    dsBotApp,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  })

  loaded.exports.apply(ctx)

  const dispose = async () => {
    const jobs = []
    while (effectDisposers.length > 0) {
      const { dispose: fn } = effectDisposers.pop()
      if (typeof fn === 'function') jobs.push(Promise.resolve(fn()))
    }
    await Promise.allSettled(jobs)
  }

  const disposeEffect = async (label) => {
    for (let i = effectDisposers.length - 1; i >= 0; i -= 1) {
      if (effectDisposers[i].label === label) {
        const [{ dispose: fn }] = effectDisposers.splice(i, 1)
        if (typeof fn === 'function') await fn()
      }
    }
  }

  return { window, document, storage, sessionsList, timers, intervals, dispose, disposeEffect }
}

// -------------------------------------------------------------------------
// #1967 avatar-refs against REAL mobile.js slimAvatars + avatar contract

test('#1967 avatar-refs works against real host mobile.js slimAvatars/avatar, handles transient failure retry, authoritative empty, and out-of-order GC', async () => {
  const bots = new Map([
    ['b1', { id: 'b1', name: 'A', avatar: { shape: 'whale', image: 'data:image/png;base64,imgA1' } }],
    ['b2', { id: 'b2', name: 'B', avatar: { shape: 'star', image: 'data:image/png;base64,imgA1' } }],
    ['b3', { id: 'b3', name: 'Inline', avatar: { shape: 'moon', image: 'data:image/png;base64,inline' } }],
  ])
  const rooms = new Map([
    ['r1', { id: 'r1', name: 'Room', avatar: { image: 'data:image/png;base64,imgRoom' } }],
  ])
  const rt = {
    ctx: { sessionController: {}, on: () => () => {}, effect: () => () => {} },
    state: {},
    botOf: id => bots.get(id),
    roomOf: id => rooms.get(id),
  }
  installMobile(rt)

  const calls = []
  let failRefs = new Set()
  const gates = new Map()
  const cache = createAvatarRefCache(async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (gates.has(payload.ref)) await gates.get(payload.ref)
    if (failRefs.has(payload.ref)) throw Object.assign(new Error('network blip'), { code: 'NETWORK' })
    return rt.mobileEndpoint(endpoint, payload)
  })

  // 1) Initial hydration using real rt.slimAvatars (keeping b3 inline to test mixed payloads).
  const slim1 = rt.slimAvatars({
    bots: [bots.get('b1'), bots.get('b2')],
    rooms: [rooms.get('r1')],
  })
  slim1.bots.push(bots.get('b3'))

  let releaseSlow
  const refA1 = slim1.bots[0].avatar.imageRef
  gates.set(refA1, new Promise(resolve => { releaseSlow = resolve }))
  const p1 = cache.hydrate(slim1)
  const p2 = cache.hydrate(slim1)
  releaseSlow()
  const [r1, r2] = await Promise.all([p1, p2])
  gates.clear()

  assert.equal(calls.length, 2, 'shared ref and concurrent hydrate must fetch each unique ref once')
  assert.equal(r1.incomplete, false)
  assert.equal(r1.state.bots[0].avatar.image, 'data:image/png;base64,imgA1')
  assert.equal(r1.state.bots[0].avatar.imageRef, undefined)
  assert.equal(r1.state.bots[1].avatar.image, 'data:image/png;base64,imgA1')
  assert.equal(r1.state.bots[2].avatar.image, 'data:image/png;base64,inline')
  assert.equal(r1.state.rooms[0].avatar.image, 'data:image/png;base64,imgRoom')
  assert.equal(r2.state.bots[0].avatar.image, 'data:image/png;base64,imgA1')

  // Cache hit makes zero calls.
  const r3 = await cache.hydrate(slim1)
  assert.equal(calls.length, 2)
  assert.equal(r3.incomplete, false)

  // 2) Transient failure when b1 switches to a new photo:
  //    preserves b1's previous cached photo, reports incomplete=true, and self-heals on retry.
  bots.set('b1', { id: 'b1', name: 'A', avatar: { shape: 'whale', image: 'data:image/png;base64,imgA2' } })
  const slim2 = rt.slimAvatars({ bots: [bots.get('b1')], rooms: [] })
  const refA2 = slim2.bots[0].avatar.imageRef
  failRefs = new Set([refA2])

  const failed = await cache.hydrate(slim2)
  assert.equal(failed.incomplete, true, 'transient fetch failure must report incomplete=true')
  assert.equal(failed.state.bots[0].avatar.image, 'data:image/png;base64,imgA1', 'must preserve prior cached photo during transient error')
  assert.equal(failed.state.bots[0].avatar.imageRef, undefined)

  // Clear network failure: retry hydrates cleanly and updates photo.
  failRefs.clear()
  const healed = await cache.hydrate(slim2)
  assert.equal(healed.incomplete, false)
  assert.equal(healed.resolved, true)
  assert.equal(healed.state.bots[0].avatar.image, 'data:image/png;base64,imgA2')

  // 3) Authoritative empty: host removes b1's photo before client fetches a stale ref.
  //    mobile.js returns { botId: 'b1', ref: null, image: null } -> NOT incomplete, clears photo!
  bots.set('b1', { id: 'b1', name: 'A', avatar: { shape: 'whale' } })
  const emptyReply = await rt.mobileEndpoint('avatar', { botId: 'b1', ref: 'stale-ref' })
  assert.deepEqual(emptyReply, { botId: 'b1', ref: null, image: null })
  const authEmpty = await cache.hydrate({ bots: [{ id: 'b1', avatar: { shape: 'whale', imageRef: 'stale-ref' } }], rooms: [] })
  assert.equal(authEmpty.incomplete, false, 'authoritative { ref: null, image: null } must NOT set incomplete')
  assert.equal(authEmpty.state.bots[0].avatar.image, undefined, 'authoritative empty must clear stale fallback image')

  // 4) Out-of-order concurrent hydrate: slow pull #1 (refSlow) finishes AFTER fast pull #2 (refFast).
  //    Pull #1 must NOT evict refFast cached by pull #2!
  bots.set('b1', { id: 'b1', name: 'A', avatar: { shape: 'whale', image: 'data:image/png;base64,slowPhoto' } })
  const slimSlow = rt.slimAvatars({ bots: [bots.get('b1')], rooms: [] })
  const refSlow = slimSlow.bots[0].avatar.imageRef
  let releaseOld
  gates.set(refSlow, new Promise(resolve => { releaseOld = resolve }))
  const slowJob = cache.hydrate(slimSlow)

  bots.set('b1', { id: 'b1', name: 'A', avatar: { shape: 'whale', image: 'data:image/png;base64,fastPhoto' } })
  const slimFast = rt.slimAvatars({ bots: [bots.get('b1')], rooms: [] })
  const refFast = slimFast.bots[0].avatar.imageRef
  const fastResult = await cache.hydrate(slimFast)
  assert.equal(fastResult.state.bots[0].avatar.image, 'data:image/png;base64,fastPhoto')
  assert.equal(cache.has(refFast), true)

  releaseOld()
  await slowJob
  gates.clear()
  assert.equal(cache.has(refFast), true, 'stale slow pull #1 must NEVER evict refFast cached by newer pull #2')
  assert.equal(cache.has(refSlow), false, 'stale slow pull #1 must not leave dead refSlow in cache')
})

// -------------------------------------------------------------------------
// #1812 draft-keep: debouncing, cross-tab storage merge, dirty deletions, DraftKeeper flush

test('#1812 draft-keep merges cross-tab storage events and fresh snapshots without clobbering Tab B drafts', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const storage = makeStorage()
  let setCount = 0
  let getCount = 0
  const trackedStorage = {
    getItem: (key) => { getCount += 1; return storage.getItem(key) },
    setItem: (key, value) => { setCount += 1; storage.setItem(key, value) },
    removeItem: (key) => { storage.removeItem(key) },
  }
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: trackedStorage })

  const prevWin = globalThis.window
  const prevStorage = globalThis.localStorage
  try {
    globalThis.window = dom.window
    globalThis.localStorage = trackedStorage
    const { exports } = await loadClientModule('draft-keep.js', {
      window: dom.window,
      localStorage: trackedStorage,
    })

    // Seed an existing draft for bot-del so we can test dirty deletion too.
    storage.setItem(STORAGE.drafts, JSON.stringify({
      'bot-del': { part: 'pd1', text: 'to clear' },
      'bot-keep': { part: 'pk1', text: 'untouched' },
    }))

    // Tab A types 5 keystrokes in bot-a (debounced) and clears bot-del (debounced).
    for (let i = 1; i <= 5; i += 1) {
      exports.keepDraft({ chatId: 'bot-a', part: 'pa1', text: `draft A ${i}`, files: [] }, trackedStorage, { deferMs: 300 })
    }
    exports.keepDraft({ chatId: 'bot-del', part: 'pd1', text: '', files: [] }, trackedStorage, { deferMs: 300 })
    assert.equal(setCount, 0, 'debounced typing must not write immediately')
    assert.equal(getCount, 1, 'initial cache load reads storage once')

    // Tab B writes bot-b to localStorage and dispatches a real storage event while Tab A is dirty!
    const tabBSnapshot = JSON.stringify({
      'bot-del': { part: 'pd1', text: 'to clear' },
      'bot-keep': { part: 'pk1', text: 'untouched' },
      'bot-b': { part: 'pb1', text: 'draft from Tab B' },
    })
    storage.setItem(STORAGE.drafts, tabBSnapshot)
    const storageEvt = new dom.window.Event('storage')
    Object.defineProperty(storageEvt, 'key', { value: STORAGE.drafts })
    Object.defineProperty(storageEvt, 'newValue', { value: tabBSnapshot })
    dom.window.dispatchEvent(storageEvt)

    // Before Tab A flushes, Tab C ALSO writes bot-c directly to storage (racing flush without storage event).
    const tabCSnapshot = JSON.stringify({
      'bot-del': { part: 'pd1', text: 'to clear' },
      'bot-keep': { part: 'pk1', text: 'untouched' },
      'bot-b': { part: 'pb1', text: 'draft from Tab B' },
      'bot-c': { part: 'pc1', text: 'draft from Tab C' },
    })
    storage.setItem(STORAGE.drafts, tabCSnapshot)

    // Tab A flushes: must merge ONLY Tab A's dirty keys (bot-a set, bot-del deleted) onto latest storage!
    exports.flushDrafts(trackedStorage)
    assert.equal(setCount, 1)

    const finalSaved = JSON.parse(storage.getItem(STORAGE.drafts))
    assert.deepEqual(finalSaved, {
      'bot-keep': { part: 'pk1', text: 'untouched' },
      'bot-b': { part: 'pb1', text: 'draft from Tab B' },
      'bot-c': { part: 'pc1', text: 'draft from Tab C' },
      'bot-a': { part: 'pa1', text: 'draft A 5' },
    })
    assert.equal(exports.takeDraft({ chatId: 'bot-a', part: 'pa2', text: '', attached: 0 }, trackedStorage).text, 'draft A 5')
    assert.equal(exports.takeDraft({ chatId: 'bot-b', part: 'pb2', text: '', attached: 0 }, trackedStorage).text, 'draft from Tab B')
    assert.equal(exports.takeDraft({ chatId: 'bot-c', part: 'pc2', text: '', attached: 0 }, trackedStorage).text, 'draft from Tab C')
    assert.equal(exports.takeDraft({ chatId: 'bot-del', part: 'pd2', text: '', attached: 0 }, trackedStorage).text, '')
  } finally {
    globalThis.window = prevWin
    globalThis.localStorage = prevStorage
  }
})

test('#1812 DraftKeeper flushes on beforeunload and visibilitychange (hidden) and cleans up listeners on unmount', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const storage = makeStorage()
  let hidden = false
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden })
  const winAdded = new Map()
  const docAdded = new Map()
  const origWinAdd = dom.window.addEventListener.bind(dom.window)
  const origWinRem = dom.window.removeEventListener.bind(dom.window)
  const origDocAdd = dom.window.document.addEventListener.bind(dom.window.document)
  const origDocRem = dom.window.document.removeEventListener.bind(dom.window.document)
  dom.window.addEventListener = (type, fn, opts) => { winAdded.set(type, (winAdded.get(type) ?? 0) + 1); return origWinAdd(type, fn, opts) }
  dom.window.removeEventListener = (type, fn, opts) => { winAdded.set(type, (winAdded.get(type) ?? 0) - 1); return origWinRem(type, fn, opts) }
  dom.window.document.addEventListener = (type, fn, opts) => { docAdded.set(type, (docAdded.get(type) ?? 0) + 1); return origDocAdd(type, fn, opts) }
  dom.window.document.removeEventListener = (type, fn, opts) => { docAdded.set(type, (docAdded.get(type) ?? 0) - 1); return origDocRem(type, fn, opts) }

  const { exports, resetRender, flushEffects, unmount } = await loadClientModule('composer.js', {
    window: dom.window,
    document: dom.window.document,
    localStorage: storage,
  })
  const roster = { byId: { b1: { id: 'b1', sessionId: 'b1', parts: ['b1'] } }, roomsById: {} }
  let draftText = 'unsent beforeunload'
  const render = () => {
    resetRender()
    exports.DraftKeeper({
      sessionId: 'b1',
      inputActions: { setDraft() {}, addAttachments: () => true },
      useRoster: select => select(roster),
      useInput: select => select({ phase: 'plain', draft: draftText, attachmentIds: [] }),
      actions: { draftFiles: () => [], restoreDraftFiles: () => [], reopenPastes() {} },
    })
    flushEffects()
  }

  render()
  assert.equal(storage.getItem(STORAGE.drafts), null, 'debounced write should still be pending')
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
  assert.equal(JSON.parse(storage.getItem(STORAGE.drafts)).b1.text, 'unsent beforeunload')

  draftText = 'unsent hidden'
  render()
  assert.equal(JSON.parse(storage.getItem(STORAGE.drafts)).b1.text, 'unsent beforeunload')
  hidden = false
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  assert.equal(JSON.parse(storage.getItem(STORAGE.drafts)).b1.text, 'unsent beforeunload', 'visible change must not flush prematurely')
  hidden = true
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  assert.equal(JSON.parse(storage.getItem(STORAGE.drafts)).b1.text, 'unsent hidden')

  unmount()
  assert.equal(winAdded.get('pagehide'), 0)
  assert.equal(winAdded.get('beforeunload'), 0)
  assert.equal(docAdded.get('visibilitychange'), 0)
})

// -------------------------------------------------------------------------
// #1812 ComposerPlus with REAL enter-steer.js contract

test('#1812 ComposerPlus skips [role="listbox"] on normal typing and enforces real enter-steer contract', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><div data-composer-card><div contenteditable="true" id="ed"></div><button id="plus"></button></div></body>',
    { url: 'http://localhost/' },
  )
  const { window } = dom
  const { document } = window
  const editor = document.getElementById('ed')
  const plusBtn = document.getElementById('plus')
  const docQueries = []
  const origQuery = document.querySelector.bind(document)
  document.querySelector = (sel) => { docQueries.push(sel); return origQuery(sel) }

  let inputState = {
    phase: 'plain',
    draft: 'hello',
    attachmentIds: [],
    queue: [{ id: 'q1', source: { kind: 'user' } }],
  }
  const steered = []
  const { exports, refs, resetRender, flushEffects, unmount } = await loadClientModule('composer.js', {
    window,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
  })

  const render = () => {
    resetRender()
    exports.ComposerPlus({
      sessionId: 'b1',
      useRoster: select => select({ ready: true, byId: { b1: { id: 'b1', name: 'Bot' } }, roomsById: {}, prefs: {} }),
      useInput: select => select(inputState),
      actions: {
        openSettings() {},
        steerQueued: async (sid) => { steered.push(sid) },
        canReferenceChat: () => false,
      },
    })
    // ComposerPlus ref #0 is the `button` ref attached to `.bt-plus`.
    refs[0].current = plusBtn
    flushEffects()
  }
  render()

  const fireKey = (init) => {
    const evt = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    editor.dispatchEvent(evt)
    return evt
  }

  // 1) Normal typing with non-empty draft: zero [role="listbox"] queries.
  for (const key of ['a', 'b', 'c', 'Backspace', 'ArrowLeft', 'Enter']) {
    fireKey({ key })
  }
  assert.equal(docQueries.length, 0, 'non-steerable keys must perform zero [role="listbox"] queries')
  assert.deepEqual(steered, [])

  // 2) Flip to steerable input (empty draft, no attachments, user queue item):
  //    Plain Enter triggers steerQueued.
  inputState = {
    phase: 'plain',
    draft: '   ',
    attachmentIds: [],
    queue: [{ id: 'q1', source: { kind: 'user' } }],
  }
  render()
  // Normal non-Enter key while steerable still does zero DOM queries.
  fireKey({ key: 'x' })
  assert.equal(docQueries.length, 0)

  // IME composition (isComposing: true) must NOT steer.
  const imeEvt = fireKey({ key: 'Enter', isComposing: true })
  assert.equal(imeEvt.defaultPrevented, false)
  assert.deepEqual(steered, [])

  // Open [role="listbox"] in the document must block steering.
  const listbox = document.createElement('div')
  listbox.setAttribute('role', 'listbox')
  document.body.appendChild(listbox)
  const blockedEvt = fireKey({ key: 'Enter' })
  assert.equal(blockedEvt.defaultPrevented, false)
  assert.deepEqual(steered, [])
  listbox.remove()

  // Plain Enter with no listbox and no IME triggers steerQueued!
  const steerEvt = fireKey({ key: 'Enter' })
  assert.equal(steerEvt.defaultPrevented, true)
  await tick()
  assert.deepEqual(steered, ['b1'])
  unmount()
})

// -------------------------------------------------------------------------
// motion-rest with REAL JSDOM MutationObserver (no fake callback!)

test('motion-rest tracks subtree [aria-modal="true"], aria-modal toggles, body-direct .bt-scrim, and ::after infinite animations with real JSDOM MutationObserver', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><div id="root"><div id="bg"></div></div></body>',
    { url: 'http://localhost/' },
  )
  const { window } = dom
  const { document } = window
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })

  class FakeAnim {
    constructor(target, iterations = Infinity) {
      this.effect = { target, getTiming: () => ({ iterations }) }
      this.playState = 'running'
    }
    pause() { this.playState = 'paused' }
    play() { this.playState = 'running' }
  }

  let docGetCalls = 0
  const bgEl = document.getElementById('bg')
  const bgLoop = new FakeAnim(bgEl, Infinity)
  const animations = [bgLoop]
  document.getAnimations = () => { docGetCalls += 1; return [...animations] }
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }

  const undo = installMotionRest({ doc: document, win: window, now: () => 0 })
  assert.equal(docGetCalls, 1)
  assert.equal(bgLoop.playState, 'running')

  // 1) Finite non-pseudo animation on unwatched element skips doc.getAnimations().
  const finiteEl = document.createElement('div')
  finiteEl.getAnimations = () => [new FakeAnim(finiteEl, 1)]
  document.getElementById('root').appendChild(finiteEl)
  const finiteStart = new window.Event('animationstart', { bubbles: true })
  finiteEl.dispatchEvent(finiteStart)
  const finiteEnd = new window.Event('animationend', { bubbles: true })
  finiteEl.dispatchEvent(finiteEnd)
  await tick()
  assert.equal(docGetCalls, 1, 'finite non-pseudo animation must skip doc.getAnimations()')

  // 2) Mount [aria-modal="true"] nested inside #root (not a direct child of body!).
  const modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  const modalInner = document.createElement('span')
  modal.appendChild(modalInner)
  const modalLoop = new FakeAnim(modalInner, Infinity)
  animations.push(modalLoop)
  document.getElementById('root').appendChild(modal)
  await tick()
  // Sync once to register modalLoop (or fire animationstart on modalInner)
  const modalStart = new window.Event('animationstart', { bubbles: true })
  modalInner.dispatchEvent(modalStart)
  await tick()
  assert.equal(bgLoop.playState, 'paused', 'subtree [aria-modal="true"] must pause background loops')
  assert.equal(modalLoop.playState, 'running', 'loop inside modal must keep running')

  // 3) Toggle aria-modal attribute off via setAttribute (element stays mounted!).
  modal.setAttribute('aria-modal', 'false')
  await tick()
  assert.equal(bgLoop.playState, 'running', 'toggling aria-modal off must resume background loops')

  // 4) Direct-body .bt-scrim must NOT promote cover to document.body!
  const scrim = document.createElement('div')
  scrim.className = 'bt-scrim'
  document.body.appendChild(scrim)
  await tick()
  assert.equal(bgLoop.playState, 'paused', 'direct-body .bt-scrim must pause background loops (not promote to body)')
  scrim.remove()
  await tick()
  assert.equal(bgLoop.playState, 'running', 'removing .bt-scrim must resume background loops')

  // 5) ::after pseudo-element infinite animation on an element whose own getAnimations() only shows a finite animation.
  const micEl = document.createElement('button')
  micEl.className = 'bt-mic'
  micEl.getAnimations = () => [new FakeAnim(micEl, 1)]
  document.getElementById('root').appendChild(micEl)
  const pseudoLoop = new FakeAnim(micEl, Infinity)
  animations.push(pseudoLoop)
  const beforePseudoCalls = docGetCalls
  const pseudoStart = new window.Event('animationstart', { bubbles: true })
  Object.defineProperty(pseudoStart, 'pseudoElement', { value: '::after' })
  micEl.dispatchEvent(pseudoStart)
  await tick()
  assert.ok(docGetCalls > beforePseudoCalls, '::after animationstart must NOT short-circuit even when host has own finite animation')

  // Opening a modal now pauses the newly tracked ::after infinite loop too!
  modal.setAttribute('aria-modal', 'true')
  await tick()
  assert.equal(pseudoLoop.playState, 'paused', 'tracked ::after infinite loop must pause under modal cover')

  undo()
  assert.equal(pseudoLoop.playState, 'running')
})

// -------------------------------------------------------------------------
// cells.js: TOOL_ROSTER_FIELDS includes 'connectors' & MailToolCell updates live

test('cells.js TOOL_ROSTER_FIELDS includes connectors and MailToolCell updates live on roster.connectors changes', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const { exports, resetRender } = await loadClientModule('cells.js', {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    localStorage: makeStorage(),
  })

  assert.ok(exports.TOOL_ROSTER_FIELDS.includes('connectors'), 'TOOL_ROSTER_FIELDS must include connectors')

  const rosterSource = createSource({
    bots: [{ id: 'b1', name: 'Mailer', color: 'blue' }],
    byId: { b1: { id: 'b1', name: 'Mailer', color: 'blue' } },
    rooms: [],
    roomsById: {},
    exchangeTurns: {},
    prefs: {},
    closedCards: {},
    questions: {},
    views: {},
    secrets: [],
    secretRequests: {},
    connectors: { mail: { accounts: [{ id: 'acc-1', address: 'old@example.com' }] } },
    connectorRequests: {},
    mailRequests: {
      b1: [{ id: 'req-1', callId: 'c1', sessionId: 'b1', status: 'pending', account: 'acc-1', subject: 'Hi', to: 'to@example.com', body: 'Hello' }],
    },
    browser: false,
    computer: {},
    imStatus: { slack: 'connected' },
  })
  const useRoster = select => select(rosterSource.getSnapshot())
  const node = {
    key: 'k1',
    location: { turn: { turn: 1 } },
    data: { root: { kind: 'tool-call', callId: 'c1', name: 'mail_send', args: {} } },
  }
  const actions = { noteLive() {}, noteCards() {} }

  const findMailCard = (tree) => {
    if (!tree || typeof tree !== 'object') return null
    if (tree.type?.name === 'MailToolCell') {
      const rendered = tree.type(tree.props)
      return findMailCard(rendered)
    }
    if (tree.type?.name === 'MailSendCard') {
      const rendered = tree.type(tree.props)
      return rendered?.props?.view ?? null
    }
    for (const child of tree.children ?? []) {
      const hit = findMailCard(child)
      if (hit) return hit
    }
    return null
  }
  const fromFieldOf = view => view?.children?.[0]?.fields?.find(f => f.id === 'from')?.value

  resetRender()
  const tree1 = exports.ToolCell({ node, sessionId: 'b1', useRoster, actions })
  const view1 = findMailCard(tree1)
  assert.equal(fromFieldOf(view1), 'old@example.com')

  // Update roster.connectors live (same revision/mailRequests): ToolCell must pick up the new address!
  rosterSource.set(prev => ({
    ...prev,
    connectors: { mail: { accounts: [{ id: 'acc-1', address: 'new@example.com' }] } },
  }))
  resetRender()
  const tree2 = exports.ToolCell({ node, sessionId: 'b1', useRoster, actions })
  const view2 = findMailCard(tree2)
  assert.equal(fromFieldOf(view2), 'new@example.com')
})

// -------------------------------------------------------------------------
// header.js: remounted [data-conversation-scroll] still receives scroll updates

test('header.js useTranscriptView rebinds and processes scroll events after [data-conversation-scroll] remounts', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><div id="s1" data-conversation-scroll><div data-chat-following-tail></div></div></body>',
    { url: 'http://localhost/' },
  )
  const { window } = dom
  const { document } = window
  const rafs = []
  const s1 = document.getElementById('s1')
  s1.getBoundingClientRect = () => ({ left: 0, top: 50, right: 800, bottom: 700, width: 800, height: 650 })

  const { exports, resetRender, flushEffects, unmount } = await loadClientModule('header.js', {
    window,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ getPropertyValue: () => '152' }),
    requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length },
    cancelAnimationFrame: () => {},
  })

  const render = () => {
    resetRender()
    const view = exports.useTranscriptView()
    flushEffects()
    return view
  }

  render()
  while (rafs.length > 0) rafs.shift()()
  let view = render()
  assert.equal(view.unpinned, false)
  assert.equal(view.center, 400)

  // Unrelated scroll while s1 is connected must be ignored (schedules 0 frames).
  const other = document.createElement('div')
  document.body.appendChild(other)
  other.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  assert.equal(rafs.length, 0, 'unrelated scroll while watched is connected must be ignored')

  // Disconnect s1 and mount a replacement [data-conversation-scroll] that is unpinned.
  s1.remove()
  const s2 = document.createElement('div')
  s2.setAttribute('data-conversation-scroll', '')
  const slot = document.createElement('div')
  slot.className = '_toBottomSlot_1'
  slot.appendChild(document.createElement('button'))
  s2.appendChild(slot)
  s2.getBoundingClientRect = () => ({ left: 100, top: 50, right: 900, bottom: 700, width: 800, height: 650 })
  document.body.appendChild(s2)

  // Scroll event on the replacement scroller MUST schedule measure() and rebind!
  s2.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  assert.equal(rafs.length, 1, 'scroll on remounted scroller must not be blocked by stale disconnected watched')
  while (rafs.length > 0) rafs.shift()()
  view = render()
  assert.equal(view.unpinned, true)
  assert.equal(view.center, 500)
  unmount()
})

// -------------------------------------------------------------------------
// activity-row.js: findHost ownerDocument invalidation + 0-height placeholder contract

test('#1970 activity-row findHost caches connected running slot, refreshes on disconnect and on document swap', async () => {
  const dom1 = new JSDOM('<!doctype html><div data-chat-flow><div data-chat-running></div></div>')
  const dom2 = new JSDOM('<!doctype html><div data-chat-flow id="flow2"><div data-chat-running></div></div>')
  const flow1 = dom1.window.document.querySelector('[data-chat-flow]')
  const slot1 = dom1.window.document.querySelector('[data-chat-running]')
  const flow2 = dom2.window.document.getElementById('flow2')
  let queries1 = 0
  const origQuery1 = dom1.window.document.querySelector.bind(dom1.window.document)
  dom1.window.document.querySelector = (sel) => { queries1 += 1; return origQuery1(sel) }

  let activeDoc = dom1.window.document
  const globals = { window: dom1.window }
  Object.defineProperty(globals, 'document', { enumerable: true, get: () => activeDoc })
  const { exports } = await loadClientModule('activity-row.js', globals)

  assert.equal(exports.findHost(), flow1)
  assert.equal(queries1, 1)
  assert.equal(exports.findHost(), flow1)
  assert.equal(queries1, 1)

  // Swapping to a new document while slot1 is still connected in dom1 must NOT return stale flow1.
  activeDoc = dom2.window.document
  assert.equal(exports.findHost(), flow2)

  // Switch back to dom1 and verify disconnect invalidation.
  activeDoc = dom1.window.document
  assert.equal(exports.findHost(), flow1)
  const beforeRemove = queries1
  slot1.remove()
  assert.equal(exports.findHost(), flow1)
  assert.ok(queries1 > beforeRemove)
})

test('activity-row useRowEntrances does NOT mark 0-height placeholders seen during initial 800ms window', async () => {
  const dom = new JSDOM('<!doctype html><body><div data-chat-flow id="flow"></div></body>', { url: 'http://localhost/' })
  const { window } = dom
  const { document } = window
  const flow = document.getElementById('flow')

  const row1 = document.createElement('div')
  row1.setAttribute('data-chat-flow-key', 'r1')
  Object.defineProperty(row1, 'offsetHeight', { configurable: true, get: () => 40 })
  flow.appendChild(row1)

  let placeholderHeight = 0
  const placeholder = document.createElement('div')
  placeholder.setAttribute('data-chat-flow-key', 'r2')
  placeholder.dataset.chatFlowKind = 'assistant-step'
  Object.defineProperty(placeholder, 'offsetHeight', { configurable: true, get: () => placeholderHeight })
  flow.appendChild(placeholder)

  let nowMs = 1000
  const FakeDate = class extends Date {
    static now() { return nowMs }
  }
  const rafs = []
  const { exports, flushEffects, unmount } = await loadClientModule('activity-row.js', {
    window,
    document,
    Date: FakeDate,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length },
    cancelAnimationFrame: () => {},
  })

  exports.ActivityIndicator({
    sessionId: 'b1',
    useRoster: select => select({ byId: { b1: { id: 'b1', name: 'Bot' } }, roomsById: {} }),
    useSessionStatus: () => false,
    useLive: () => '{}',
    useSession: () => 0,
    useWork: () => 0,
    actions: { clearLive() {} },
  })
  flushEffects()
  // Initial scan ran within <800ms: row1 (offsetHeight=40) is seen, placeholder (offsetHeight=0) must NOT be seen.
  assert.equal(placeholder.dataset.btEnter, undefined)

  // Advance past 800ms, placeholder receives content (offsetHeight > 0), and a flow mutation triggers scan.
  nowMs += 1000
  placeholderHeight = 36
  const tail = document.createElement('span')
  flow.appendChild(tail)
  await tick()
  while (rafs.length > 0) rafs.shift()()

  assert.equal(placeholder.dataset.btEnter, 'new', '0-height placeholder mounted <800ms must still animate once content arrives')
  unmount()
})

// -------------------------------------------------------------------------
// bot-tasks.js: TaskReaderView does NOT drop final refresh when task finishes during in-flight poll

test('bot-tasks TaskReaderView runs follow-up final refresh when task completes while quiet poll is in flight', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false })
  const intervals = new Map()
  let nextInterval = 0
  const { exports, resetRender, flushEffects, unmount } = await loadClientModule('bot-tasks.js', {
    window: dom.window,
    document: dom.window.document,
    setInterval: (fn, ms) => { const id = ++nextInterval; intervals.set(id, { fn, ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
  })

  let pollResolve
  const reads = []
  const readTask = async (botId, taskId) => {
    const seq = reads.length + 1
    reads.push({ seq, botId, taskId })
    if (seq === 1) return { items: [{ seq: 1, kind: 'bot', text: 'initial' }], cursor: null }
    if (seq === 2) {
      await new Promise(resolve => { pollResolve = resolve })
      return { items: [{ seq: 1, kind: 'bot', text: 'stale-mid-run' }], cursor: null }
    }
    return { items: [{ seq: 1, kind: 'bot', text: 'stale-mid-run' }, { seq: 2, kind: 'bot', text: 'final answer' }], cursor: null }
  }

  let task = { id: 't1', status: 'running', title: 'Job' }
  const bot = { id: 'b1', name: 'Worker' }
  const render = () => {
    resetRender()
    const tree = exports.TaskReaderView({ bot, task, actions: { readTask } })
    flushEffects()
    return tree
  }

  // Initial mount loads seq 1.
  render()
  await tick()
  assert.equal(reads.length, 1)

  // Trigger the 2.5s quiet poll (seq 2), which stays in-flight!
  const pollEntry = [...intervals.values()].find(t => t.ms === 2500)
  assert.ok(pollEntry, 'active task must register 2500ms poll interval')
  pollEntry.fn()
  assert.equal(reads.length, 2)

  // Task transitions active: true -> false WHILE seq 2 is still in flight!
  task = { id: 't1', status: 'completed', title: 'Job' }
  render()
  assert.equal(reads.length, 2, 'must wait for in-flight poll rather than overlapping it')

  // Now resolve the stale in-flight poll: TaskReaderView must immediately execute seq 3!
  pollResolve()
  await tick()
  await tick()
  assert.equal(reads.length, 3, 'final completion refresh must NOT be dropped when a quiet poll was in flight')
  unmount()
})

// -------------------------------------------------------------------------
// bot-browsers.js: live=false guard + silent readyOnce + 1x event deduplication

test('bot-browsers handles change.live=false without overwriting live or calling preview, and prevents dom-ready double-fire after silent update', async () => {
  let viewListener = null
  let previewCalls = 0
  let storageWrites = 0
  const storageMap = new Map()
  const storage = {
    getItem: k => storageMap.get(k) ?? null,
    setItem: (k, v) => { storageWrites += 1; storageMap.set(k, v) },
    removeItem: k => { storageMap.delete(k) },
  }
  const createdViews = []
  const bridge = {
    views: {
      create: async (botId, tabId, url) => {
        createdViews.push({ botId, tabId, url, title: 'Example', loading: false, canGoBack: false, canGoForward: false })
        return {}
      },
      sync: async () => createdViews,
      navigate: async () => ({}),
      read: async () => { previewCalls += 1; return 'Example page excerpt' },
      place: async () => ({}),
      close: async () => ({}),
      command: async () => ({}),
      focus: async () => ({}),
      subscribe: (fn) => { viewListener = fn; return () => { viewListener = null } },
    },
  }

  // 1) createAppViewProxy: silent update with loading=false marks readyOnce so later non-silent update does NOT double-fire dom-ready.
  const proxy = createAppViewProxy(bridge, 'bot-1', 'tab-1')
  const fired = []
  proxy.addEventListener('dom-ready', () => { fired.push('dom-ready') })
  proxy.addEventListener('did-navigate', () => { fired.push('did-navigate') })
  proxy.update({ url: 'https://example.com/a', title: 'A', loading: false }, { silent: true })
  assert.deepEqual(fired, [])
  proxy.update({ url: 'https://example.com/b', title: 'B', loading: false })
  assert.deepEqual(fired, ['did-navigate'], 'must not double-fire dom-ready after a silent ready update')

  // 2) Live appViewEvents deduplication + change.live === false handling.
  const browsers = createBotBrowsers({ bridge, createSource, storage })
  const tabId = await browsers.openTab('bot-1', 'https://example.com')
  await browsers.show(tabId)
  await new Promise(resolve => setTimeout(resolve, 10))
  const writesAfterOpen = storageWrites
  const previewsAfterOpen = previewCalls

  viewListener({ botId: 'bot-1', tabId, url: 'https://example.com/next', title: 'Next', loading: false, canGoBack: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(storageWrites - writesAfterOpen, 1)
  assert.equal(previewCalls - previewsAfterOpen, 1)
  assert.ok(browsers.openPages()['bot-1'])

  // Identical state event produces zero extra storage writes and zero extra previews.
  viewListener({ botId: 'bot-1', tabId, url: 'https://example.com/next', title: 'Next', loading: false, canGoBack: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(storageWrites - writesAfterOpen, 1)
  assert.equal(previewCalls - previewsAfterOpen, 1)

  // change.live === false: must set ready=false, keep live: false, omit from openPages(), and NOT call preview()!
  const previewsBeforeDead = previewCalls
  viewListener({ botId: 'bot-1', tabId, url: 'https://example.com/dead', title: 'Dead', loading: false, live: false })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(browsers.pages.getSnapshot()[tabId].live, false, 'live: false must not be overwritten with live: true')
  assert.equal(browsers.openPages()['bot-1'], undefined, 'non-live view must not appear in openPages()')
  assert.equal(previewCalls, previewsBeforeDead, 'live: false must not invoke preview()')
  browsers.dispose()
})

// -------------------------------------------------------------------------
// index.js real apply(ctx) integration tests:
// - computer-cursor-wait 2s backoff isolation
// - agent-fork cleanup (no orphan interval) & cross-tab storage polling activation
// - #1967 avatar-refs pull loop does not advance `since` on transient error
// - installMentions identical-length PNG IEND trailer update

test('index.js computer-cursor-wait 2s error backoff is NOT broken by unrelated roster updates and cancels cleanly on dispose', async () => {
  let cursorCalls = 0
  let stateRev = 1
  let botName = 'Bot 1'
  const app = await bootClientIndex({
    dsBotApp: {
      computerCursor: () => {},
    },
    rpc: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: stateRev,
          modelsKey: 'm1',
          bots: [{ id: 'b1', name: botName, color: 'blue' }],
          rooms: [],
          computer: { enabled: true },
        }
      }
      if (endpoint === 'computer-cursor-wait') {
        cursorCalls += 1
        throw Object.assign(new Error('cursor down'), { code: 'NETWORK' })
      }
      return {}
    },
  })

  await tick()
  await tick()
  assert.equal(cursorCalls, 1)
  const backoffTimers = () => [...app.timers.entries()].filter(([, t]) => t.ms === 2000)
  assert.equal(backoffTimers().length, 1, 'failed cursor poll must schedule a 2000ms backoff')

  // Trigger unrelated roster update (same computer.enabled=true, new revision/name):
  // must NOT cancel the 2000ms backoff or trigger an immediate retry!
  stateRev = 2
  botName = 'Bot 1 renamed'
  const statePoll = [...app.timers.entries()].find(([, t]) => t.ms === 1500)
  assert.ok(statePoll)
  app.timers.delete(statePoll[0])
  statePoll[1].fn()
  await tick()
  await tick()
  assert.equal(cursorCalls, 1, 'unrelated roster update must NOT break 2000ms error backoff')
  assert.equal(backoffTimers().length, 1, '2000ms backoff timer must stay active')

  // Disposing must cancel the active 2000ms backoff timer immediately.
  await app.dispose()
  assert.equal(backoffTimers().length, 0, 'dispose must cancel active 2000ms backoff timer')
})

test('index.js agent-fork prevents orphan 5s setInterval on dispose and activates polling on cross-tab storage writes', async () => {
  let releaseAdopt
  let adoptCalls = 0
  const storage = makeStorage()
  storage.setItem(STORAGE.agentForks, JSON.stringify([{ agentId: 'a1', sessionId: 's-pending' }]))

  // Part A: Dispose while adopt/reconcile is in flight -> zero orphan 5000ms interval!
  const appA = await bootClientIndex({
    storage,
    initialSessions: { 's-pending': { id: 's-pending' } },
    rpc: async (endpoint) => {
      if (endpoint === 'state') {
        return {
          revision: 1,
          modelsKey: 'm1',
          bots: [],
          rooms: [],
          agents: [{ id: 'a1', sessions: [] }],
        }
      }
      if (endpoint === 'agent-adopt') {
        adoptCalls += 1
        await new Promise(resolve => { releaseAdopt = resolve })
        throw new Error('transient adopt failure')
      }
      return {}
    },
  })
  await tick()
  await tick()
  assert.equal(adoptCalls, 1)

  const disposePromise = appA.disposeEffect('ds-bot: Agent forks')
  // Reject the in-flight adopt AFTER dispose started:
  releaseAdopt()
  await disposePromise
  await tick()
  const orphanIntervals = [...appA.intervals.values()].filter(t => t.ms === 5000)
  assert.equal(orphanIntervals.length, 0, 'in-flight reconcile finishing after dispose must NEVER leak a 5000ms setInterval')
  await appA.dispose()

  // Part B: Cross-tab storage write activates 5000ms polling until adopted, then clears it!
  const storageB = makeStorage()
  let adoptB = 0
  let revB = 1
  const adoptedSessionsB = []
  const appB = await bootClientIndex({
    storage: storageB,
    initialSessions: {},
    rpc: async (endpoint, payload) => {
      if (endpoint === 'state') {
        if (payload?.since === revB) return { unchanged: true, revision: revB }
        return {
          revision: revB,
          modelsKey: 'm1',
          bots: [],
          rooms: [],
          agents: [{ id: 'a1', sessions: [...adoptedSessionsB] }],
        }
      }
      if (endpoint === 'agent-adopt') {
        adoptB += 1
        adoptedSessionsB.push(payload.sessionId)
        revB += 1
        return { ok: true }
      }
      return {}
    },
  })
  await tick()
  await tick()
  const forkTimersB = () => [...appB.intervals.values()].filter(t => t.ms === 5000)
  assert.equal(forkTimersB().length, 0, 'idle window with empty storage must have 0 fork intervals')

  // Another tab writes a pending fork for a session not listed yet, firing a storage event.
  const crossTabVal = JSON.stringify([{ agentId: 'a1', sessionId: 's-cross' }])
  storageB.setItem(STORAGE.agentForks, crossTabVal)
  const evt = new appB.window.Event('storage')
  Object.defineProperty(evt, 'key', { value: STORAGE.agentForks })
  Object.defineProperty(evt, 'newValue', { value: crossTabVal })
  appB.window.dispatchEvent(evt)
  await tick()
  await tick()
  assert.equal(forkTimersB().length, 1, 'cross-tab pending fork in storage must activate 5000ms retry interval')

  // Once the session appears in sessions.list, reconcile adopts it and clears the interval!
  appB.sessionsList.set({ byId: { 's-cross': { id: 's-cross' } } })
  await tick()
  await tick()
  assert.equal(adoptB, 1)
  assert.equal(forkTimersB().length, 0, 'interval must stop once cross-tab pending fork is adopted')
  await appB.dispose()
})

test('index.js pull loop keeps retrying avatar on transient failure without advancing since, and installMentions detects same-length PNG IEND changes', async () => {
  // Two valid PNG-like data URLs with IDENTICAL length and IDENTICAL last 24 characters (IEND trailer).
  const trailer = 'AAAAAElFTkSuQmCC12345678'
  const img1 = `data:image/png;base64,FIRST_IMAGE_BODY_${trailer}`
  const img2 = `data:image/png;base64,OTHER_IMAGE_BODY_${trailer}`
  assert.equal(img1.length, img2.length)
  assert.equal(img1.slice(-24), img2.slice(-24))

  let currentImg = img1
  let revision = 5
  const rt = {
    ctx: { sessionController: {}, on: () => () => {}, effect: () => () => {} },
    state: {},
    botOf: id => (id === 'b1' ? { id: 'b1', name: 'Ava', color: 'blue', avatar: { shape: 'whale', image: currentImg } } : undefined),
    roomOf: () => undefined,
  }
  installMobile(rt)

  const stateSinceCalls = []
  let failFirstAvatar = true
  const app = await bootClientIndex({
    rpc: async (endpoint, payload) => {
      if (endpoint === 'state') {
        stateSinceCalls.push(payload.since)
        if (payload.since === revision) return { unchanged: true, revision }
        return rt.slimAvatars({
          revision,
          modelsKey: 'm1',
          bots: [{ id: 'b1', name: 'Ava', color: 'blue', avatar: { shape: 'whale', image: currentImg } }],
          rooms: [],
        })
      }
      if (endpoint === 'avatar') {
        if (failFirstAvatar) {
          failFirstAvatar = false
          throw Object.assign(new Error('temporary avatar failure'), { code: 'NETWORK' })
        }
        return rt.mobileEndpoint('avatar', payload)
      }
      return {}
    },
  })

  await tick()
  await tick()
  assert.deepEqual(stateSinceCalls, [-1])
  const mentionStyle = () => [...app.document.querySelectorAll('style')].find(s => s.dataset.dshBot === 'mentions')?.textContent ?? ''
  assert.equal(mentionStyle().includes(img1), false, 'first avatar fetch failed transiently')

  // Next poll must NOT advance `since` to 5 (must pass -1) so avatar self-heals!
  const runNextPoll = async () => {
    const entry = [...app.timers.entries()].find(([, t]) => t.ms === 1500 || t.ms === 3000 || t.ms === 5000)
    assert.ok(entry)
    app.timers.delete(entry[0])
    entry[1].fn()
    await tick()
    await tick()
  }

  await runNextPoll()
  assert.deepEqual(stateSinceCalls, [-1, -1], 'must not advance since while avatar hydration is incomplete')
  assert.ok(mentionStyle().includes(img1), 'avatar must self-heal on retry and render in mentions style')

  // Subsequent poll now advances `since` to 5.
  await runNextPoll()
  assert.deepEqual(stateSinceCalls, [-1, -1, 5], 'must advance since once hydration succeeds')

  // Now update avatar to img2 (same length, same last 24 chars) at revision 6 -> mentions CSS must update!
  currentImg = img2
  revision = 6
  await runNextPoll()
  assert.ok(mentionStyle().includes(img2), 'installMentions must update when same-length PNG with identical trailer changes')
  assert.equal(mentionStyle().includes(img1), false)

  // Authoritative empty at the SAME revision after a transient failure must clear the stale fallback photo.
  revision = 7
  currentImg = img1
  failFirstAvatar = true
  await runNextPoll()
  assert.ok(mentionStyle().includes(img2), 'transient error preserves previous fallback photo')
  // Before retry succeeds, host clears the bot avatar authoritatively while staying at revision 7!
  currentImg = undefined
  await runNextPoll()
  assert.equal(mentionStyle().includes(img2), false, 'authoritative empty at same revision must clear stale fallback photo')
  assert.equal(mentionStyle().includes(img1), false)

  await app.dispose()

  // Dedicated clean harness for deterministic overlapping pull #1 (fills cache, superseded by order < applied)
  // + pull #2 (wins order & hits cache with resolved=false -> must still update roster via avatarsChanged!).
  currentImg = img1
  let avatarFails = true
  let releaseAvatar1
  let releaseState2
  let stateCalls = 0
  let avatarCalls = 0
  const app2 = await bootClientIndex({
    initialSessions: {
      's-agent-1': { id: 's-agent-1', retainedBy: { mainView: 1 } },
    },
    rpc: async (endpoint, payload) => {
      if (endpoint === 'state') {
        stateCalls += 1
        if (payload.since === 8) return { unchanged: true, revision: 8 }
        const snap = rt.slimAvatars({
          revision: 8,
          modelsKey: 'm1',
          bots: [{ id: 'b1', name: 'Ava', color: 'blue', avatar: { shape: 'whale', image: img1 } }],
          rooms: [],
          agents: [{ id: 'a1', sessions: ['s-agent-1'] }],
        })
        if (stateCalls === 3) {
          return new Promise((resolve) => { releaseState2 = () => resolve(snap) })
        }
        return snap
      }
      if (endpoint === 'avatar') {
        avatarCalls += 1
        if (avatarFails) {
          avatarFails = false
          throw new Error('transient')
        }
        return new Promise((resolve) => {
          releaseAvatar1 = () => resolve(rt.mobileEndpoint('avatar', payload))
        })
      }
      if (endpoint === 'agent-adopt') return { ok: true }
      return {}
    },
  })
  await tick()
  await tick()
  // Switch back to Bot surface 'b1' to inspect mentions style cleanly.
  const showBot = () => app2.sessionsList.set({
    byId: {
      b1: { id: 'b1', retainedBy: { mainView: 1 } },
      's-agent-1': { id: 's-agent-1', retainedBy: { mainView: 0 } },
    },
  })
  const style2 = () => [...app2.document.querySelectorAll('style')].find(s => s.dataset.dshBot === 'mentions')?.textContent ?? ''
  assert.equal(style2().includes(img1), false, 'initial rev 8 avatar fetch failed')
  // Pull #1 (order = 2) starts via timer and pauses inside call('avatar').
  const pollEntry = [...app2.timers.entries()].find(([, t]) => t.ms === 1500 || t.ms === 3000 || t.ms === 5000)
  assert.ok(pollEntry)
  app2.timers.delete(pollEntry[0])
  pollEntry[1].fn()
  await tick()
  assert.equal(typeof releaseAvatar1, 'function', 'pull #1 is in-flight inside avatar fetch')
  // Trigger concurrent pull #2 (order = 3) via agent-adopt; it reaches call('state') and waits.
  app2.sessionsList.set({
    byId: {
      's-agent-1': { id: 's-agent-1', retainedBy: { mainView: 0 } },
      's-agent-2': { id: 's-agent-2', blank: true, retainedBy: { mainView: 1 } },
    },
  })
  await tick()
  assert.equal(typeof releaseState2, 'function', 'pull #2 is in-flight overlapping pull #1')
  // Release pull #2's state (sets applied = 3 > pull #1's order = 2) right as pull #1 writes cache!
  releaseAvatar1()
  releaseState2()
  await tick()
  await tick()
  await tick()
  showBot()
  await tick()
  assert.equal(stateCalls, 3)
  assert.equal(avatarCalls, 2, 'pull #2 hit the cache populated by superseded pull #1 without issuing a 3rd avatar fetch')
  assert.ok(style2().includes(img1), 'pull #2 hitting cache written by superseded pull #1 must still update roster')
  await app2.dispose()
})

// -------------------------------------------------------------------------
// Existing performance/leak regression tests (updated to real contracts)

test('#2050 TeamSidebar caps 300ms collapse retries when shell stays uncollapsed', async () => {
  const dom = new JSDOM('<!doctype html><div data-frame><div class="_sidebarCol_x" style="width:240px"></div><button aria-label="Collapse sidebar"></button></div>')
  const { window } = dom
  const { document } = window
  let clicks = 0
  document.querySelector('button').addEventListener('click', () => { clicks += 1 })
  let timerSeq = 0
  const timers = new Map()
  const fakeWin = Object.assign(Object.create(window), {
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout: (fn, ms) => { timerSeq += 1; timers.set(timerSeq, { fn, ms }); return timerSeq },
    clearTimeout: id => { timers.delete(id) },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  const { exports, resetRender, flushEffects, unmount } = await loadClientModule('sidebar.js', {
    window: fakeWin,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    getComputedStyle: () => ({ width: '240px', getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: fakeWin.setTimeout,
    clearTimeout: fakeWin.clearTimeout,
  })
  const { MAX_COLLAPSE_RETRIES, TeamSidebar } = exports
  assert.equal(MAX_COLLAPSE_RETRIES, 3)

  const renderSidebar = () => {
    resetRender()
    TeamSidebar({
      useRoster: select => select({ ready: true, bots: [], rooms: [], sections: [], byId: {}, roomsById: {}, agents: [], prefs: {} }),
      useSessions: select => select({ byId: {}, ids: [] }),
      useSessionStatus: () => new Map(),
      useSessionRetainInfo: () => false,
      useActivity: () => ({}),
      useWork: () => ({ bots: {}, rooms: {}, approvals: [] }),
      useComputer: () => ({}),
      useRegistry: () => null,
      useUi: select => select({ unread: {}, leftDrawer: false }),
      useFrame: select => select({ viewport: 1280, collapsedWidth: 0, collapsed: false }),
      actions: { toggleSidebar: () => { clicks += 1 }, openSession() {}, openNewChat() {}, openSettings() {}, openPalette() {}, openMenu() {}, setLeftDrawer() {} },
    })
    flushEffects()
  }

  renderSidebar()
  for (let step = 0; step < 10; step += 1) {
    const pending = [...timers.entries()].filter(([, t]) => t.ms === 300)
    if (pending.length === 0) break
    for (const [id, t] of pending) {
      timers.delete(id)
      t.fn()
    }
    renderSidebar()
  }
  assert.equal(clicks, MAX_COLLAPSE_RETRIES, `expected exactly ${MAX_COLLAPSE_RETRIES} collapse attempts, got ${clicks}`)
  assert.equal([...timers.values()].filter(t => t.ms === 300).length, 0)
  assert.equal(document.documentElement.hasAttribute('data-bt-collapsing'), false)
  unmount()
})

test('residual #1968 frame-watch does not rescan columns infinitely when only 1 column exists', async () => {
  const dom = new JSDOM('<!doctype html><div class="_sidebarCol_1"></div><div class="other"></div>')
  const prevWin = globalThis.window
  const prevDoc = globalThis.document
  const prevMO = globalThis.MutationObserver
  const prevRAF = globalThis.requestAnimationFrame
  const prevCAF = globalThis.cancelAnimationFrame
  const prevRO = globalThis.ResizeObserver
  const prevCS = globalThis.getComputedStyle
  try {
    globalThis.window = dom.window
    globalThis.document = dom.window.document
    globalThis.MutationObserver = dom.window.MutationObserver
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    globalThis.getComputedStyle = () => ({ width: '240px', getPropertyValue: () => '' })
    const rafs = []
    globalThis.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }
    globalThis.cancelAnimationFrame = () => {}

    let queryAllCount = 0
    let sidebarColQueries = 0
    const origQAll = dom.window.document.querySelectorAll.bind(dom.window.document)
    const origQ = dom.window.document.querySelector.bind(dom.window.document)
    dom.window.document.querySelectorAll = (sel) => { queryAllCount += 1; return origQAll(sel) }
    dom.window.document.querySelector = (sel) => {
      if (sel === '[class*="_sidebarCol"]') sidebarColQueries += 1
      return origQ(sel)
    }

    const frame = createSource({ viewport: 1280, collapsedWidth: 0, collapsed: false })
    const dispose = installFrameWatch(frame)
    assert.equal(queryAllCount, 1)
    assert.equal(sidebarColQueries, 0, 'cached sidebarColumn from initial scan avoids separate querySelector')

    for (let i = 0; i < 5; i += 1) {
      const span = dom.window.document.createElement('span')
      dom.window.document.querySelector('.other').appendChild(span)
      await Promise.resolve()
      while (rafs.length > 0) rafs.shift()()
    }
    assert.equal(queryAllCount, 1, 'must not rescan querySelectorAll when watched column stayed connected and no column was added')
    assert.equal(sidebarColQueries, 0)
    dispose()
  } finally {
    globalThis.window = prevWin
    globalThis.document = prevDoc
    globalThis.MutationObserver = prevMO
    globalThis.requestAnimationFrame = prevRAF
    globalThis.cancelAnimationFrame = prevCAF
    globalThis.ResizeObserver = prevRO
    globalThis.getComputedStyle = prevCS
  }
})

test('skin.js reuses a single 1x1 canvas with willReadFrequently, guards null context, and skips no-op removeProperty', () => {
  let canvases = 0
  let removed = 0
  const contextOptions = []
  const styles = new Map()
  const doc = {
    createElement: (tag) => {
      if (tag === 'canvas') canvases += 1
      return {
        width: 0,
        height: 0,
        getContext: (kind, opts) => {
          contextOptions.push([kind, opts])
          return {
            fillStyle: '',
            clearRect() {},
            fillRect() {},
            getImageData: () => ({ data: [255, 255, 255, 128] }),
          }
        },
      }
    },
    defaultView: {
      getComputedStyle: () => ({
        getPropertyValue: (name) => (name === '--dsw-alias-bg-base' ? 'oklch(0.95 0.01 240 / 0.5)' : 'color-mix(in srgb, white 50%, transparent)'),
      }),
    },
    body: {
      hasAttribute: () => false,
      style: {
        getPropertyValue: name => styles.get(name) ?? '',
        setProperty: (name, value) => { styles.set(name, value) },
        removeProperty: (name) => { removed += 1; styles.delete(name) },
      },
    },
  }
  const theme = { light: { bg: '#ffffff', sidebar: '#f5f5f5', card: '#ffffff' }, dark: { bg: '#111111', sidebar: '#181818', card: '#222222' } }
  readSkinSurfaceVars(doc, theme)
  readSkinSurfaceVars(doc, theme)
  readSkinSurfaceVars(doc, theme)
  assert.equal(canvases, 1, 'canvas probe must be created once per document')
  assert.deepEqual(contextOptions, [['2d', { willReadFrequently: true }]])

  // Null 2d context must not throw and falls back safely to empty vars.
  const nullCtxDoc = {
    ...doc,
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  }
  assert.deepEqual(readSkinSurfaceVars(nullCtxDoc, theme), {})

  writeSkinSurfaceVars(doc, () => ({}))
  assert.equal(removed, 0)
})

test('mark.js shares one pointer listener and one observer across marks, skips a repeated pointer position, and sameRoomAvatar checks resolved members, +N count, and image fallback', async () => {
  const winListeners = new Map()
  let observers = 0
  const dom = new JSDOM('<!doctype html><body></body>')
  // A page in view: JSDOM reports itself hidden unless told otherwise.
  Object.defineProperty(dom.window.document, 'hidden', { value: false })
  const fakeWin = Object.assign(Object.create(dom.window), {
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn) },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { constructor() { observers += 1 } observe() {} disconnect() {} },
  })
  const rafs = []
  let measured = 0
  const nodes = []
  const mkNode = () => {
    const node = {
      isConnected: true,
      dataset: {},
      getBoundingClientRect: () => { measured += 1; return { left: 100, top: 100, width: 36, height: 36 } },
      style: { setProperty() {}, removeProperty() {} },
    }
    nodes.push(node)
    return node
  }
  const { exports, flushEffects, unmount } = await loadClientModule('mark.js', {
    window: fakeWin,
    document: dom.window.document,
    MutationObserver: fakeWin.MutationObserver,
    IntersectionObserver: fakeWin.IntersectionObserver,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length },
    cancelAnimationFrame: () => {},
  }, {
    memo: (comp, compare) => Object.assign(props => comp(props), { compare }),
    // The mark's element ref is the one made with null.
    useRef: init => ({ current: init === null ? mkNode() : init }),
  })
  for (let k = 0; k < 5; k += 1) {
    exports.BotMark({ bot: { id: `b${k}`, name: `B${k}`, color: 'blue', avatar: { shape: 'whale' } }, size: 36, gaze: true })
  }
  flushEffects()

  // Every mark shares the live clock's listeners: one for the pointer, one observer of
  // the motion settings.
  assert.equal(winListeners.get('pointermove')?.size ?? 0, 1)
  assert.equal(observers, 1)

  const move = [...winListeners.get('pointermove')][0]
  move({ clientX: 220, clientY: 160 })
  while (rafs.length > 0) rafs.shift()()
  assert.equal(measured, 5)
  // In mark radii from the middle: (220 - 118) / 18 across, (160 - 118) / 18 down.
  for (const node of nodes) assert.deepEqual({ ...node.__btLive.engine.gazeTarget }, { x: 102 / 18, y: 42 / 18 })

  // The same position again measures nothing.
  move({ clientX: 220, clientY: 160 })
  while (rafs.length > 0) rafs.shift()()
  assert.equal(measured, 5)

  // Verify RoomAvatar comparator on resolved visible slots, +N count, and image fallback.
  const cmp = exports.RoomAvatar.compare
  assert.equal(typeof cmp, 'function')
  const mkBot = (id, color) => ({ id, color, avatar: { shape: 'whale' } })
  const room = { id: 'r1', members: ['ghost', 'b1', 'b2', 'b3', 'b4', 'b5'], avatar: { image: 'https://broken.test/a.png' } }
  const byIdA = { b1: mkBot('b1', 'red'), b2: mkBot('b2', 'blue'), b3: mkBot('b3', 'green'), b4: mkBot('b4', 'pink'), b5: mkBot('b5', 'gray') }
  const byIdB = { ...byIdA, b4: mkBot('b4', 'gold') }
  // b4 is the 4th resolved member (index 4 because 'ghost' is filtered out) AND room has an image URL that may fall back!
  assert.equal(cmp({ room, roster: { byId: byIdA }, size: 36 }, { room, roster: { byId: byIdB }, size: 36 }), false)
  // Removing b5 changes total resolved count (+N overflow badge!).
  const byIdC = { b1: byIdA.b1, b2: byIdA.b2, b3: byIdA.b3, b4: byIdA.b4 }
  assert.equal(cmp({ room, roster: { byId: byIdA }, size: 36 }, { room, roster: { byId: byIdC }, size: 36 }), false)
  // Same resolved members and count returns true.
  assert.equal(cmp({ room, roster: { byId: byIdA }, size: 36 }, { room, roster: { byId: { ...byIdA } }, size: 36 }), true)

  unmount()
  assert.equal(winListeners.get('pointermove')?.size ?? 0, 0)
})

test('reading.js invalidates cachedHeadings when a cached heading is disconnected', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><div data-conversation-scroll id="sc"><div id="box"><h2>Old Title</h2><p>Body</p><h2>Second</h2></div></div></body>',
    { url: 'http://localhost/' },
  )
  const { window } = dom
  const { document } = window
  const scroller = document.getElementById('sc')
  const box = document.getElementById('box')
  scroller.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 })
  box.getBoundingClientRect = () => ({ left: 20, top: -120, right: 700, bottom: 800, width: 680, height: 920 })
  const [h1, h2] = box.querySelectorAll('h2')
  h1.getBoundingClientRect = () => ({ top: 20, bottom: 40 })
  h2.getBoundingClientRect = () => ({ top: 400, bottom: 420 })

  const rafs = []
  const { exports, resetRender, flushEffects, unmount } = await loadClientModule('reading.js', {
    window,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    ResizeObserver: class {
      constructor(cb) { this.cb = cb }
      observe(target) { this.cb([{ target }]) }
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => '152' }),
    requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length },
    cancelAnimationFrame: () => {},
  })

  const findLabel = (tree) => {
    if (!tree || typeof tree !== 'object') return null
    if (tree.props?.className === 'bt-reading-label') return tree.children.join('')
    for (const child of tree.children ?? []) {
      const hit = findLabel(child)
      if (hit !== null) return hit
    }
    return null
  }

  const render = () => {
    resetRender()
    const tree = exports.ReplyGuide({ box: { current: box }, active: true })
    flushEffects()
    return tree
  }

  render()
  while (rafs.length > 0) rafs.shift()()
  render()
  while (rafs.length > 0) rafs.shift()()
  render()
  assert.equal(findLabel(render()), 'Old Title')

  // Replace the heading DOM node without scrolling (cached heading becomes disconnected!).
  box.querySelector('h2').remove()
  const freshH2 = document.createElement('h2')
  freshH2.textContent = 'Fresh Title'
  freshH2.getBoundingClientRect = () => ({ top: 20, bottom: 40 })
  box.prepend(freshH2)

  assert.equal(findLabel(render()), 'Fresh Title', 'disconnected cached heading must invalidate cache and re-query headingsIn')
  unmount()
})

test('sidebar.js sameBotRow comparator checks roster.mainBotIds', async () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const captured = {}
  await loadClientModule('sidebar.js', {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    localStorage: makeStorage(),
  }, {
    memo: (comp, compare) => {
      captured[comp.name] = compare
      return comp
    },
  })
  const sameBotRow = captured.BotRow
  assert.equal(typeof sameBotRow, 'function')
  const baseRoster = {
    mainBotId: 'b1',
    mainBotIds: ['b1'],
    byId: {},
    roomsById: {},
    exchangeTurns: {},
    learning: {},
    secretRequests: {},
    connectorRequests: {},
    mailRequests: {},
    questions: {},
    views: {},
  }
  const base = {
    bot: { id: 'b2' },
    wide: true,
    marked: false,
    actions: {},
    onDragStart: null,
    useSessions: null,
    useSessionStatus: null,
    useSessionRetainInfo: null,
    useActivity: null,
    useWork: null,
    useComputer: null,
    roster: baseRoster,
  }
  assert.equal(sameBotRow(base, { ...base, roster: { ...baseRoster } }), true)
  assert.equal(sameBotRow(base, { ...base, roster: { ...baseRoster, mainBotIds: ['b1', 'b2'] } }), false)
})

test('speech.js openCapture stops MediaStream tracks and closes AudioContext when recorder.start throws', async () => {
  const prevNav = globalThis.navigator
  const prevAC = globalThis.AudioContext
  const prevMR = globalThis.MediaRecorder
  let trackStopped = 0
  let audioClosed = 0
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => { trackStopped += 1 } }],
          }),
        },
      },
    })
    globalThis.AudioContext = class {
      createAnalyser() { return { fftSize: 512 } }
      createMediaStreamSource() { return { connect() {} } }
      close() { audioClosed += 1; return Promise.resolve() }
    }
    globalThis.MediaRecorder = class {
      start() { throw new Error('recorder-boom') }
    }
    await assert.rejects(openCapture(), /recorder-boom/)
    assert.equal(trackStopped, 1)
    assert.equal(audioClosed, 1)
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav })
    globalThis.AudioContext = prevAC
    globalThis.MediaRecorder = prevMR
  }
})

test('notifications.js matches real preload.cjs onOpenSession (returns undefined), also supports optional unsubscribe, caches prefs, and deduplicates setBadge', async () => {
  // 1) Real preload.cjs contract: onOpenSession returns undefined (single-slot ipcRenderer listener).
  let registeredHandler = null
  const opened = []
  const badges = []
  let storageReads = 0
  const fakeWin = {
    addEventListener() {},
    removeEventListener() {},
    dsBotApp: {
      onOpenSession: (run) => { registeredHandler = run },
      setBadge: count => { badges.push(count) },
    },
  }
  const fakeDoc = { hasFocus: () => true, visibilityState: 'visible' }
  const fakeStorage = {
    getItem: () => { storageReads += 1; return null },
    setItem() {},
  }
  const mod1 = await loadClientModule('notifications.js', {
    window: fakeWin,
    document: fakeDoc,
    localStorage: fakeStorage,
  })
  const readsAtInit = storageReads
  const props = {
    useSessions: select => select({ byId: {} }),
    useSessionStatus: select => select(new Map([['b1', { completionUnread: true }]])),
    useRoster: select => select({ ready: true, bots: [{ id: 'b1', name: 'Bot' }], rooms: [], questions: {} }),
    useWork: select => select({ approvals: [] }),
    actions: { openSession: id => { opened.push(id) } },
  }
  mod1.exports.NotificationWatcher(props)
  mod1.flushEffects()
  mod1.resetRender()
  mod1.exports.NotificationWatcher(props)
  mod1.flushEffects()

  assert.equal(typeof registeredHandler, 'function')
  registeredHandler('b1')
  assert.deepEqual(opened, ['b1'])
  assert.equal(storageReads, readsAtInit, 'NotificationWatcher must read cached prefs without reparsing localStorage')
  assert.deepEqual(badges, [1], 'setBadge must only be called when badge count changes')
  assert.doesNotThrow(() => mod1.unmount(), 'unmount must handle preload.cjs undefined return safely')

  // 2) Optional unsubscribe function return is invoked on unmount.
  let openUnsubscribed = 0
  const mod2 = await loadClientModule('notifications.js', {
    window: {
      addEventListener() {},
      removeEventListener() {},
      dsBotApp: {
        onOpenSession: () => () => { openUnsubscribed += 1 },
        setBadge() {},
      },
    },
    document: fakeDoc,
    localStorage: fakeStorage,
  })
  mod2.exports.NotificationWatcher(props)
  mod2.flushEffects()
  mod2.unmount()
  assert.equal(openUnsubscribed, 1, 'optional unsubscribe returned by onOpenSession must be called on unmount')
})

test('LRU helpers and client caches enforce upper bounds (markupCache, maskCache, turnClock)', () => {
  const m = new Map()
  lruSet(m, 'a', 1, 2)
  lruSet(m, 'b', 2, 2)
  assert.equal(lruGet(m, 'a'), 1)
  lruSet(m, 'c', 3, 2)
  assert.equal(m.has('b'), false)
  assert.equal(m.has('a'), true)
  assert.equal(m.has('c'), true)

  markupCache.clear()
  for (let i = 0; i < 300; i += 1) characterMarkup('whale', `color-${i}`)
  assert.ok(markupCache.size <= 256)
  markupCache.clear()

  maskCache.clear()
  for (let i = 0; i < 160; i += 1) maskOf(`shape-${i}`)
  assert.ok(maskCache.size <= 128)
  maskCache.clear()

  const turnClock = createSource({})
  const actions = teamActions({
    call: async () => ({}),
    after: p => p,
    partFor: id => id,
    roster: createSource({ byId: {}, roomsById: {} }),
    ui: createSource({}),
    live: createSource({}),
    cards: createSource({}),
    heldCards: createSource({}),
    turnClock,
  })
  for (let i = 0; i < 60; i += 1) actions.noteTurnTime(`s-${i}`, 1, 'first', i * 1000)
  assert.equal(Object.keys(turnClock.getSnapshot()).length, 40)
  assert.equal('s-0' in turnClock.getSnapshot(), false)
  assert.equal('s-59' in turnClock.getSnapshot(), true)
})

test('agent-fork reports hasPending and tracks cross-tab storage entries during reconcile', async () => {
  const changes = []
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
  const forks = installAgentForks({
    sessions: { list: { getSnapshot: () => ({ byId: {} }) }, fork: async () => 'x' },
    ownerOf: () => undefined,
    hasAgent: () => false,
    pending: new Map(),
    adopt: async () => ({}),
    refresh: async () => {},
    report: () => {},
    storage,
    ready: async () => {},
    onPendingChange: () => { changes.push(forks.hasPending()) },
  })
  assert.equal(forks.hasPending(), false)

  // Another tab writes a pending entry to storage; reconcile must surface it via hasPending().
  storage.setItem(STORAGE.agentForks, JSON.stringify([{ agentId: 'a1', sessionId: 's-other' }]))
  await forks.reconcile()
  assert.equal(forks.hasPending(), true)

  // Clearing storage in the other tab resets hasPending() back to false.
  storage.setItem(STORAGE.agentForks, '[]')
  await forks.reconcile()
  assert.equal(forks.hasPending(), false)

  await forks.dispose()
  assert.deepEqual(changes, [true, false])
})

test('BtwDock skips turnFacts and watchTurns when the session has no btw cards', async () => {
  let factsCalls = 0
  let watchCalls = 0
  const { exports, flushEffects } = await loadClientModule('btw.js')
  const tree = exports.BtwDock({
    sessionId: 'b1',
    useRoster: select => select({ ready: true, byId: { b1: { id: 'b1' } }, roomsById: {}, btwCards: {} }),
    actions: {
      turnFacts: () => { factsCalls += 1; return { turns: new Map() } },
      watchTurns: () => { watchCalls += 1; return () => {} },
    },
  })
  flushEffects()
  assert.equal(tree, null)
  assert.equal(factsCalls, 0)
  assert.equal(watchCalls, 0)
})

test('GPU animations avoid box-shadow and background-position infinite loops', async () => {
  const { readFileSync } = await import('node:fs')
  const stylesSrc = readFileSync(`${clientDir}styles.js`, 'utf8')
  const imSrc = readFileSync(`${clientDir}im-page.js`, 'utf8')
  const usageSrc = readFileSync(`${clientDir}usage-page.js`, 'utf8')

  const micKeyframes = /@keyframes bt-mic-pulse\{[^}]+\}/.exec(stylesSrc)?.[0] ?? ''
  assert.ok(micKeyframes.includes('transform:scale'), 'bt-mic-pulse must use composited transform:scale')
  assert.equal(micKeyframes.includes('box-shadow'), false, 'bt-mic-pulse must not animate box-shadow')

  for (const [label, src, name] of [
    ['styles.js', stylesSrc, 'bt-mem-skel'],
    ['im-page.js', imSrc, 'bt-im-sheen'],
    ['usage-page.js', usageSrc, 'bt-us-shine'],
  ]) {
    const kf = new RegExp(`@keyframes ${name}\\{[^}]+\\}`).exec(src)?.[0] ?? ''
    assert.ok(kf.includes('translateX'), `${label} ${name} must use composited translateX`)
    assert.equal(kf.includes('background-position'), false, `${label} ${name} must not animate background-position`)
  }
})
