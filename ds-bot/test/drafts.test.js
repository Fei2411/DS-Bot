import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><body></body>')

// The guard and the kept-draft map ride one bundle, so the tests read the same map the
// guard writes.
const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/paste-card.js'\nexport * from './src/client/drafts.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
// The minimal React stand-in the other client tests use: hooks keep their first value,
// effects never run, and a component is expanded through its function.
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'fragment',
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useRef: current => ({ current }),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  MutationObserver: dom.window.MutationObserver,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { PasteGuard, keepDraft, keptDraft, dropDraft } = module.exports

// One PasteGuard instance: refs and effects persist across renders, as React's do.
function guardMount() {
  const slots = []
  const effectSlots = []
  let cursor = 0
  let effectCursor = 0
  const useRef = (current) => {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { current }
    return slots[i]
  }
  const useEffect = (fn, deps) => {
    const i = effectCursor++
    const prev = effectSlots[i]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined
      || deps.some((dep, n) => !Object.is(dep, prev.deps[n]))
    if (prev === undefined) effectSlots[i] = { deps, fn, pending: true, cleanup: undefined }
    else if (changed) { prev.fn = fn; prev.deps = deps; prev.pending = true }
  }
  return {
    render(props) {
      const prevRef = react.useRef
      const prevEffect = react.useEffect
      react.useRef = useRef
      react.useEffect = useEffect
      cursor = 0
      effectCursor = 0
      try { return PasteGuard(props) }
      finally { react.useRef = prevRef; react.useEffect = prevEffect }
    },
    flush() {
      for (const slot of effectSlots) {
        if (slot === undefined || slot.pending !== true) continue
        slot.pending = false
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = slot.fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    },
    stop() {
      for (const slot of effectSlots) if (typeof slot?.cleanup === 'function') slot.cleanup()
    },
  }
}

// The composer facade the guard sees, and the recorder its calls land in.
function composer({ draft = '', attachmentIds = [] } = {}) {
  const calls = []
  return {
    calls,
    inputActions: { setDraft: value => calls.push(['setDraft', value]) },
    useInput: select => select({ draft, attachmentIds }),
    useUi: select => select({ paste: {} }),
    notice: text => calls.push(['notice', text]),
  }
}

test('a kept draft holds the box text and the staged files, and an empty box keeps nothing', () => {
  keepDraft('bot-1', { draft: 'hello', attachmentIds: ['att-1', '', 42] })
  assert.deepEqual(JSON.parse(JSON.stringify(keptDraft('bot-1'))), { draft: 'hello', attachmentIds: ['att-1'] })
  keepDraft('bot-1', { draft: '', attachmentIds: [] })
  assert.equal(keptDraft('bot-1'), undefined)
  keepDraft('bot-2', {})
  assert.equal(keptDraft('bot-2'), undefined)
})

test('only so many chats keep a draft; the oldest one gives way', () => {
  const probes = Array.from({ length: 32 }, (_, i) => `bot-lru-${i}`)
  for (const id of probes) keepDraft(id, { draft: id, attachmentIds: [] })
  keepDraft('bot-lru-new', { draft: 'new', attachmentIds: [] })
  assert.equal(keptDraft('bot-lru-0'), undefined)
  assert.equal(keptDraft('bot-lru-1')?.draft, 'bot-lru-1')
  assert.equal(keptDraft('bot-lru-new')?.draft, 'new')
  dropDraft('bot-lru-new')
})

test('a chat keeps its draft while it is typed, and switching chats keeps both apart', () => {
  const one = composer({ draft: 'report notes' })
  const guard = guardMount()
  try {
    guard.render({ sessionId: 'bot-1', inputActions: one.inputActions, useInput: one.useInput, useUi: one.useUi, actions: { notice: one.notice } })
    guard.flush()
    assert.equal(keptDraft('bot-1')?.draft, 'report notes')
    // The other chat's empty box neither keeps a draft of its own nor touches this one.
    const two = composer()
    guard.render({ sessionId: 'bot-2', inputActions: two.inputActions, useInput: two.useInput, useUi: two.useUi, actions: { notice: two.notice } })
    guard.flush()
    assert.equal(keptDraft('bot-2'), undefined)
    assert.equal(keptDraft('bot-1')?.draft, 'report notes')
  } finally { guard.stop() }
})

test('coming back to a chat puts its draft back into the empty box, once', () => {
  const one = composer({ draft: 'report notes' })
  const guard = guardMount()
  try {
    guard.render({ sessionId: 'bot-1', inputActions: one.inputActions, useInput: one.useInput, useUi: one.useUi, actions: { notice: one.notice } })
    guard.flush()
    const back = composer()
    guard.render({ sessionId: 'bot-1', inputActions: back.inputActions, useInput: back.useInput, useUi: back.useUi, actions: { notice: back.notice } })
    guard.flush()
    assert.deepEqual(JSON.parse(JSON.stringify(back.calls)), [['setDraft', 'report notes']])
    // The kept draft is consumed, so a later mount of the same chat does not restore again.
    const again = composer({ draft: 'report notes' })
    guard.render({ sessionId: 'bot-1', inputActions: again.inputActions, useInput: again.useInput, useUi: again.useUi, actions: { notice: again.notice } })
    guard.flush()
    assert.deepEqual(again.calls, [])
  } finally { guard.stop() }
})

test('a draft the user wrote in the meantime is never overwritten', () => {
  const one = composer({ draft: 'kept text' })
  const guard = guardMount()
  try {
    guard.render({ sessionId: 'bot-1', inputActions: one.inputActions, useInput: one.useInput, useUi: one.useUi, actions: { notice: one.notice } })
    guard.flush()
    const back = composer({ draft: 'fresh text' })
    guard.render({ sessionId: 'bot-1', inputActions: back.inputActions, useInput: back.useInput, useUi: back.useUi, actions: { notice: back.notice } })
    guard.flush()
    assert.deepEqual(back.calls, [])
    // The fresh draft is what the chat now keeps.
    assert.equal(keptDraft('bot-1')?.draft, 'fresh text')
  } finally { guard.stop() }
})

test('staged files that did not survive the switch say so, once; kept files say nothing', () => {
  const one = composer({ draft: '', attachmentIds: ['att-1'] })
  const guard = guardMount()
  const mount = (sessionId, comp) => {
    guard.render({ sessionId, inputActions: comp.inputActions, useInput: comp.useInput, useUi: comp.useUi, actions: { notice: comp.notice } })
    guard.flush()
  }
  try {
    mount('bot-1', one)
    assert.deepEqual(JSON.parse(JSON.stringify(keptDraft('bot-1'))), { draft: '', attachmentIds: ['att-1'] })
    // The files are gone on the return: the notice says so and no text is restored.
    const away = composer()
    mount('bot-2', away)
    const gone = composer()
    mount('bot-1', gone)
    assert.deepEqual(JSON.parse(JSON.stringify(gone.calls.map(call => [call[0], call[1] !== undefined]))), [['notice', true]])
    // The chat stages the file again, and a return where it is still in the box stays quiet.
    mount('bot-2', away)
    const alive = composer({ draft: '', attachmentIds: ['att-1'] })
    mount('bot-1', alive)
    assert.deepEqual(JSON.parse(JSON.stringify(keptDraft('bot-1'))), { draft: '', attachmentIds: ['att-1'] })
    mount('bot-2', away)
    const again = composer({ draft: '', attachmentIds: ['att-1'] })
    mount('bot-1', again)
    assert.deepEqual(again.calls, [])
  } finally { guard.stop() }
})
