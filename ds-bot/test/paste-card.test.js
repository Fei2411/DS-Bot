import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// jsdom comes from the harness that test/harness-resolve.mjs found.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><body></body>')
const { File, Event, document } = dom.window
// jsdom has no DataTransfer; the hand-off only builds one to fill the file input.
class DataTransfer {
  constructor() { this.list = [] }
  get items() { return { add: file => this.list.push(file) } }
  get files() { return this.list }
}

const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/paste-card.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
// The minimal React stand-in the other client tests use: hooks keep their first value,
// effects never run, and a component is expanded through its function.
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'fragment',
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useRef: current => ({ current }),
}
const timers = []
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document, File, DataTransfer, Event,
  MutationObserver: dom.window.MutationObserver,
  setTimeout: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle },
  clearTimeout: (handle) => { const index = timers.indexOf(handle); if (index !== -1) timers.splice(index, 1) },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { PASTE_LIMIT, foldPastedText, handOffPaste, liveBlocks: _live, blockLives, pastedName, putBackText, PasteDock, PasteGuard } = module.exports
void _live

const text = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(item => text(item, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  return text(node.props?.children, out)
}
const walk = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(item => walk(item, out)); return out }
  out.push(node)
  walk(node.props?.children, out)
  return out
}

test('a paste folds only when it is longer than the limit', () => {
  assert.equal(PASTE_LIMIT, 1500)
  assert.equal(foldPastedText('x'.repeat(PASTE_LIMIT)), null)
  assert.equal(foldPastedText('x'.repeat(PASTE_LIMIT + 1)).length, PASTE_LIMIT + 1)
  assert.equal(foldPastedText(null), null)
  assert.equal(foldPastedText(undefined), null)
})

test('the card names the paste by its size', () => {
  assert.equal(pastedName('x'.repeat(3200)), 'Pasted text (3200 characters).txt')
})

test('a card lives while its attachment is in the box, or while it waits for one', () => {
  const waiting = { id: 'a', attachmentId: null }
  const linked = { id: 'b', attachmentId: 'att-1' }
  assert.equal(blockLives(waiting, []), true)
  assert.equal(blockLives(linked, ['att-1']), true)
  assert.equal(blockLives(linked, ['att-2']), false)
})

// The composer facade: every call the card makes is recorded, and its draft is whatever
// the test says the caret can take.
function inputActions({ takes = true } = {}) {
  const calls = []
  return {
    calls,
    removeAttachment: id => calls.push(['removeAttachment', id]),
    captureInsertion: () => ({ caret: 3, draftRev: 7 }),
    insertText: (value, span) => { calls.push(['insertText', value, span]); return takes },
    setDraft: value => calls.push(['setDraft', value]),
  }
}

test('putting a card back takes it out of the box and returns its text at the caret', () => {
  const actions = inputActions()
  const block = { id: 'p', text: 'x'.repeat(2000), attachmentId: 'att-9' }
  assert.equal(putBackText({ block, inputActions: actions, draft: 'before ' }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(actions.calls)), [
    ['removeAttachment', 'att-9'],
    ['insertText', 'x'.repeat(2000), { caret: 3, draftRev: 7 }],
  ])
})

test('a draft that moved under the caret still gets the text', () => {
  const actions = inputActions({ takes: false })
  const block = { id: 'p', text: 'kept text', attachmentId: 'att-1' }
  putBackText({ block, inputActions: actions, draft: 'before ' })
  assert.deepEqual(JSON.parse(JSON.stringify(actions.calls.at(-1))), ['setDraft', 'before kept text'])
})

test('a card with no composer to write to does nothing', () => {
  assert.equal(putBackText({ block: { id: 'p', text: 'kept' }, inputActions: undefined }), false)
})

test('the dock draws one card per paste, with its size and its two actions', () => {
  const blocks = [{ id: 'p', text: 'x'.repeat(3200), name: 'n', attachmentId: 'att-1' }]
  const tree = expand(PasteDock({
    sessionId: 'bot-1', inputActions: inputActions(), actions: { removePaste() {} },
    useUi: select => select({ paste: { 'bot-1': blocks } }),
    useInput: select => select({ draft: '' }),
  }))
  const text_ = text(tree).join('')
  assert.match(text_, /Pasted text · 3,200 characters/)
  assert.ok(text_.includes('Put back'))
  const buttons = walk(tree).filter(node => node.type === 'button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props.title, 'Put back into the box')
  assert.equal(buttons[1].props['aria-label'], 'Remove pasted text')
})

test('the card drops the shell attachment and its own block', () => {
  const calls = []
  const actions = inputActions()
  const tree = expand(PasteDock({
    sessionId: 'bot-1', inputActions: actions,
    actions: { removePaste: (sessionId, ids) => calls.push(['removePaste', sessionId, ids]) },
    useUi: select => select({ paste: { 'bot-1': [{ id: 'p', text: 'x'.repeat(2000), name: 'n', attachmentId: 'att-4' }] } }),
    useInput: select => select({ draft: '' }),
  }))
  walk(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Remove pasted text').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(actions.calls)), [['removeAttachment', 'att-4']])
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['removePaste', 'bot-1', ['p']]])
})

test('the dock draws nothing while no paste waits', () => {
  assert.equal(PasteDock({ sessionId: 'bot-1', useUi: select => select({ paste: {} }), actions: {} }), null)
})

// A paste event over the composer's own file input, as the guard receives it.
function pasteEvent(value, files = []) {
  return {
    clipboardData: { files, getData: kind => (kind === 'text/plain' ? value : '') },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true },
  }
}

test('a long paste becomes the shell file the card carries', () => {
  document.body.innerHTML = '<div data-composer-card><input type="file"></div>'
  const card = document.body.firstElementChild
  const input = card.querySelector('input[type=file]')
  // jsdom takes only a FileList here; the browser takes the DataTransfer's own list.
  Object.defineProperty(input, 'files', { value: [], writable: true, configurable: true })
  const files = []
  const added = []
  const event = pasteEvent('x'.repeat(3200))
  const name = handOffPaste({ event, card, sessionId: 'bot-1', actions: { addPaste: (...args) => added.push(args) } })
  assert.equal(name, 'Pasted text (3200 characters).txt')
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  assert.equal(input.files.length, 1)
  files.push(input.files[0])
  assert.equal(files[0].name, 'Pasted text (3200 characters).txt')
  assert.deepEqual(JSON.parse(JSON.stringify(added)), [['bot-1', 'x'.repeat(3200), 'Pasted text (3200 characters).txt']])
})

test('a short paste stays the shell’s own text', () => {
  document.body.innerHTML = '<div data-composer-card><input type="file"></div>'
  const card = document.body.firstElementChild
  const event = pasteEvent('short')
  assert.equal(handOffPaste({ event, card, sessionId: 'bot-1', actions: { addPaste() { throw new Error('no card') } } }), null)
  assert.equal(event.prevented, false)
})

test('a paste that carries a file belongs to the shell’s file path', () => {
  document.body.innerHTML = '<div data-composer-card><input type="file"></div>'
  const card = document.body.firstElementChild
  const event = pasteEvent('x'.repeat(3200), [new File(['x'], 'shot.png', { type: 'image/png' })])
  assert.equal(handOffPaste({ event, card, sessionId: 'bot-1', actions: { addPaste() { throw new Error('no card') } } }), null)
})

test('the guard draws nothing in the composer', () => {
  const tree = PasteGuard({
    sessionId: 'bot-1', inputActions: inputActions(), actions: {},
    useUi: select => select({ paste: {} }), useInput: select => select({ attachmentIds: [] }),
  })
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.className, 'bt-paste-guard')
})

// The shell's attachment rail, in id order: one titled file card per name.
function composerRail(names) {
  document.body.innerHTML = ''
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const guard = document.createElement('span')
  guard.className = 'bt-paste-guard'
  card.append(guard)
  if (names.length > 0) {
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation.input.attachments')
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    for (const name of names) {
      const item = document.createElement('div')
      const file = document.createElement('div')
      file.title = name
      item.append(file)
      group.append(item)
    }
    slot.append(group)
    card.append(slot)
  }
  document.body.append(card)
  return guard
}

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

function dismissPaste(ui, actions, recorder) {
  const tree = expand(PasteDock({
    sessionId: 'bot-1', inputActions: recorder, actions,
    useUi: select => select(ui.getSnapshot()),
    useInput: select => select({ draft: '' }),
  }))
  walk(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Remove pasted text').props.onClick()
}

test('a user file added while a paste card waits is not claimed or deleted', () => {
  const kept = 'x'.repeat(3200)
  const name = pastedName(kept)
  const ui = createSource({})
  const actions = teamActions({ call: async () => {}, after: promise => promise, partFor: id => id, roster: createSource({}), ui })
  const removed = []
  const recorder = { removeAttachment: id => { removed.push(id) }, insertText: () => false, captureInsertion: () => ({}) }
  let ids = []
  const props = () => ({
    sessionId: 'bot-1', inputActions: recorder, actions,
    useUi: select => select(ui.getSnapshot()),
    useInput: select => select({ attachmentIds: ids, draft: '' }),
  })
  const guard = guardMount()
  const paint = (fileNames) => {
    const node = composerRail(fileNames)
    const tree = guard.render(props())
    tree.props.ref.current = node
    guard.flush()
  }
  try {
    // The card is already waiting. The first paint only learns the empty rail.
    actions.addPaste('bot-1', kept, name)
    paint([])
    // The user then drops their own file. It appears before the paste's file does.
    ids = ['user-1']
    paint(['notes.pdf'])
    const waiting = ui.getSnapshot().paste['bot-1'][0]
    assert.equal(waiting.attachmentId, null)
    dismissPaste(ui, actions, recorder)
    assert.deepEqual(removed, [])
    // Once the paste's own file is in the rail, dismissing the card removes that file.
    actions.addPaste('bot-1', kept, name)
    ids = ['user-1', 'paste-1']
    paint(['notes.pdf', name])
    assert.equal(ui.getSnapshot().paste['bot-1'][0].attachmentId, 'paste-1')
    dismissPaste(ui, actions, recorder)
    assert.deepEqual(removed, ['paste-1'])
    assert.equal(ui.getSnapshot().paste['bot-1'].length, 0)
  } finally {
    guard.stop()
  }
})
