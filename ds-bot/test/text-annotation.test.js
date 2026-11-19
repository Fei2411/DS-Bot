import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: { contents: "export { annotatedMessage, annotationKey, insertAnnotation, quoteMarkdown, TextSelectionAction } from './src/client/text-annotation.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react'],
})
let runtime = hookRuntime()
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  window: { matchMedia: () => ({ matches: true }) },
  require: name => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return runtime.react
  },
})
const { annotatedMessage, annotationKey, insertAnnotation, quoteMarkdown, TextSelectionAction } = module.exports
function hookRuntime() {
  const values = []
  let index = 0
  return {
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      useState(initial) {
        const cell = values[index++] ??= { value: initial }
        return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
      },
      useRef(current) { return (values[index++] ??= { current }) },
      useEffect() { index += 1 },
    },
    render(component, props) { index = 0; return component(props) },
    reset() { values.length = 0; index = 0 },
  }
}
const findAll = (node, type, found = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, type, found); return found }
  if (node === null || typeof node !== 'object') return found
  if (node.type === type) found.push(node)
  for (const child of node.children ?? []) findAll(child, type, found)
  return found
}

function bench({ team = true, sessionId = 'bot' } = {}) {
  runtime.reset()
  const sent = []
  const inserted = []
  const errors = []
  const calls = { clear: 0, dismiss: 0 }
  let selectedText = 'The selected text'
  const roster = { byId: team && sessionId === 'bot' ? { bot: {} } : {}, roomsById: team && sessionId === 'room' ? { room: {} } : {} }
  const props = {
    sessionId,
    useSession: select => select({ removed: false, subagent: null }),
    useRoster: select => select(roster),
    readText: () => selectedText,
    setSelectedText(next) { selectedText = next },
    clearSelection: () => { calls.clear += 1; selectedText = null },
    dismiss: () => { calls.dismiss += 1 },
    inputActions: {
      insertQuote: text => { inserted.push(['quote', text]); return true },
      captureInsertion: () => ({ draftRev: 2 }),
      insertText: (text, span) => { inserted.push(['text', text, span]); return true },
    },
    actions: {
      send: async (...args) => { sent.push(args) },
      reportError: (...args) => { errors.push(args) },
    },
    t: key => key === 'quote.add' ? 'Quote text' : key,
  }
  const render = () => runtime.render(TextSelectionAction, props)
  const openEditor = () => {
    const buttons = findAll(render(), 'button')
    const annotate = buttons.find(button => button.children[0] === 'Annotate')
    assert.ok(annotate)
    annotate.props.onClick()
    return render()
  }
  return { props, sent, inserted, errors, calls, render, openEditor, setSelectedText(next) { selectedText = next } }
}
const key = patch => ({ key: 'Enter', prevented: 0, stopped: 0, preventDefault() { this.prevented += 1 }, stopPropagation() { this.stopped += 1 }, ...patch })

beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout'] }))

const drain = () => new Promise(resolve => setImmediate(resolve))

const settle = async t => {
  // Drain the VM's cross-realm send promise before advancing its exit timer.
  await drain()
  t.mock.timers.tick(0)
}

test('an annotation becomes one Markdown message with a multiline quote', () => {
  assert.equal(quoteMarkdown('First\r\nSecond\rThird'), '> First\n> Second\n> Third')
  assert.equal(annotatedMessage('First\nSecond', '  Explain this.\nWith two lines.  '), '> First\n> Second\n> \n> Explain this.\n> With two lines.')
  assert.equal(annotatedMessage('A quote', ' \n '), '> A quote')
})

test('composer insertion keeps the annotation inside the host quote', () => {
  const inserted = []
  const actions = {
    insertQuote: text => { inserted.push(['quote', text]); return true },
    captureInsertion: () => ({ draftRev: 3 }),
    insertText: (text, span) => { inserted.push(['text', text, span]); return true },
  }
  assert.equal(insertAnnotation(actions, 'A quote', ' Note'), true)
  assert.deepEqual(inserted, [['quote', 'A quote\n\nNote']])
  inserted.length = 0
  assert.equal(insertAnnotation(actions, 'A quote', ' \n'), true)
  assert.deepEqual(inserted, [['quote', 'A quote']])
  actions.insertQuote = () => false
  assert.equal(insertAnnotation(actions, 'A quote', 'Note'), false)
})

test('Enter adds, Ctrl or Command+Enter sends, and Shift+Enter or IME composition stays in the field', () => {
  assert.equal(annotationKey(key({})), 'add')
  assert.equal(annotationKey(key({ ctrlKey: true })), 'send')
  assert.equal(annotationKey(key({ metaKey: true })), 'send')
  assert.equal(annotationKey(key({ shiftKey: true })), null)
  assert.equal(annotationKey(key({ isComposing: true })), null)
  assert.equal(annotationKey(key({ isComposing: false, keyCode: 229 })), null)
  assert.equal(annotationKey(key({ key: 'a' })), null)
})

test('selecting text in a Bot chat first offers Quote and Annotate without opening the editor', () => {
  const app = bench()
  const tree = app.render()
  assert.equal(findAll(tree, 'textarea').length, 0)
  const buttons = findAll(tree, 'button')
  assert.deepEqual(buttons.map(button => button.children[0]), ['Quote text', 'Annotate'])
  for (const button of buttons) {
    let prevented = 0
    button.props.onPointerDown({ preventDefault() { prevented += 1 } })
    assert.equal(prevented, 1)
  }
  buttons[0].props.onClick()
  assert.deepEqual(app.inserted, [['quote', 'The selected text']])
  assert.deepEqual(app.sent, [])
  assert.deepEqual(app.calls, { clear: 1, dismiss: 1 })
})

test('adding from a Bot selection sends quote and annotation to the current composer after choosing Annotate', async t => {
  const app = bench()
  const editor = app.openEditor()
  // Focusing the annotation textarea may collapse the browser selection later.
  app.setSelectedText(null)
  const field = findAll(editor, 'textarea')[0]
  field.props.onChange({ target: { value: 'Explain this' } })
  const event = key({})
  findAll(app.render(), 'textarea')[0].props.onKeyDown(event)
  assert.equal(event.prevented, 1)
  assert.equal(event.stopped, 1)
  assert.equal(findAll(app.render(), 'section')[0].props['data-leaving'], true)
  await settle(t)
  assert.deepEqual(app.inserted, [['quote', 'The selected text\n\nExplain this']])
  assert.deepEqual(app.sent, [])
  assert.deepEqual(app.calls, { clear: 1, dismiss: 1 })
})

test('Ctrl+Enter sends the annotated quote to a group through the existing send action', async t => {
  const app = bench({ sessionId: 'room' })
  findAll(app.openEditor(), 'textarea')[0].props.onChange({ target: { value: 'Check this part' } })
  findAll(app.render(), 'textarea')[0].props.onKeyDown(key({ ctrlKey: true }))
  await drain()
  assert.deepEqual(app.sent, [['room', '> The selected text\n> \n> Check this part']])
  assert.deepEqual(app.inserted, [])
  assert.equal(app.calls.clear, 1)
  assert.equal(app.calls.dismiss, 0)
  t.mock.timers.tick(0)
  assert.equal(app.calls.dismiss, 1)
})

test('an empty annotation is a normal quote, including on direct send', async t => {
  const app = bench()
  app.openEditor()
  findAll(app.render(), 'textarea')[0].props.onKeyDown(key({ ctrlKey: true }))
  await settle(t)
  assert.deepEqual(app.sent, [['bot', '> The selected text']])
})

test('Shift+Enter leaves the annotation open and Escape dismisses it without sending', async t => {
  const app = bench()
  const field = findAll(app.openEditor(), 'textarea')[0]
  const newline = key({ shiftKey: true })
  field.props.onKeyDown(newline)
  assert.equal(newline.prevented, 0)
  assert.equal(newline.stopped, 0)
  field.props.onKeyDown(key({ key: 'Escape' }))
  await settle(t)
  assert.deepEqual(app.sent, [])
  assert.deepEqual(app.inserted, [])
  assert.deepEqual(app.calls, { clear: 1, dismiss: 1 })
})

test('a failed send reports the error and retains the annotation editor', async t => {
  const app = bench()
  app.props.actions.send = async () => { throw new Error('offline') }
  const field = findAll(app.openEditor(), 'textarea')[0]
  field.props.onChange({ target: { value: 'Keep this draft' } })
  findAll(app.render(), 'textarea')[0].props.onKeyDown(key({ ctrlKey: true }))
  await settle(t)
  assert.equal(app.errors.length, 1)
  assert.equal(app.errors[0][0].message, 'offline')
  assert.equal(app.errors[0][1], 'text-annotation')
  assert.deepEqual(app.calls, { clear: 0, dismiss: 0 })
  assert.equal(findAll(app.render(), 'textarea').length, 1)
})

test('a plain Session retains the host quote-only action', () => {
  const app = bench({ team: false })
  const tree = app.render()
  assert.equal(findAll(tree, 'textarea').length, 0)
  const button = findAll(tree, 'button')[0]
  assert.equal(button.children[0], 'Quote text')
  button.props.onClick()
  assert.deepEqual(app.inserted, [['quote', 'The selected text']])
  assert.deepEqual(app.sent, [])
  assert.deepEqual(app.calls, { clear: 1, dismiss: 1 })
})
