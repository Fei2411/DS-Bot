import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The side chat's follow-up field shares the composer preference: while Enter sends,
// a plain Enter asks; off, it is the field's own newline and the send button asks.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/side-chat.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
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
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: 'fish', MarkdownText: () => null, writeClipboard: () => {} }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {} },
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} } },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: () => { throw new Error('no fetch in test') },
})
const { SideChatView } = module.exports
const mount = (props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = SideChatView(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
  }
  return instance
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props.children, check)]
}
const textarea = node => all(node, child => child.type === 'textarea')[0]
const sendButton = node => all(node, child => child.type === 'button' && child.props?.className === 'bt-side-send')[0]
const enter = (extra = {}) => ({
  key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, prevented: false,
  preventDefault() { this.prevented = true }, ...extra,
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

const chat = {
  id: 'c1',
  entries: [{ id: 'e1', question: 'What ran?', answer: 'Two reads.', status: 'answered' }],
}
// Mounts the view, types a follow-up, and returns the rendered tree accessor.
const view = (prefs, ready = true) => {
  const asked = []
  const instance = mount({
    subject: 'b1', chat,
    roster: { ready, prefs },
    actions: { askSide: async (subject, chatId, text) => { asked.push([subject, chatId, text]) } },
  })
  textarea(instance.render()).props.onChange({ target: { value: 'and then?' } })
  return { asked, tree: () => instance.render() }
}

test('with Enter sending on, a plain Enter asks the follow-up and clears the draft', async () => {
  const { asked, tree } = view({ enterToSend: true })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(asked), [['b1', 'c1', 'and then?']])
  assert.equal(textarea(tree()).props.value, '')
})

test('with Enter sending off, a plain Enter is a newline and the send button asks', async () => {
  const { asked, tree } = view({ enterToSend: false })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, false)
  assert.deepEqual(plain(asked), [])
  assert.equal(textarea(tree()).props.value, 'and then?')
  // The explicit send control carries the same ask.
  sendButton(tree()).props.onClick()
  await tick()
  assert.deepEqual(plain(asked), [['b1', 'c1', 'and then?']])
  assert.equal(textarea(tree()).props.value, '')
})

test('a roster still loading keeps a saved off and a first-time default', async () => {
  // The pre-pull roster stays ready:false but already carries the window's saved prefs.
  const saved = view({ enterToSend: false }, false)
  const off = enter()
  textarea(saved.tree()).props.onKeyDown(off)
  await tick()
  assert.equal(off.prevented, false)
  assert.deepEqual(plain(saved.asked), [])
  // A window with nothing saved keeps the default: Enter sends, it is not stuck off.
  const fresh = view({}, false)
  const on = enter()
  textarea(fresh.tree()).props.onKeyDown(on)
  await tick()
  assert.equal(on.prevented, true)
  assert.deepEqual(plain(fresh.asked), [['b1', 'c1', 'and then?']])
})

test('Shift+Enter and IME confirmation keep their default behavior', async () => {
  for (const extra of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }]) {
    const { asked, tree } = view({ enterToSend: true })
    const event = enter(extra)
    textarea(tree()).props.onKeyDown(event)
    await tick()
    assert.equal(event.prevented, false)
    assert.deepEqual(plain(asked), [])
  }
})

test('while an answer runs, Enter and the send button stay quiet', async () => {
  const answering = { id: 'c1', entries: [{ id: 'e1', question: 'q', status: 'answering' }] }
  const asked = []
  const instance = mount({
    subject: 'b1', chat: answering,
    roster: { ready: true, prefs: { enterToSend: true } },
    actions: { askSide: async (...args) => { asked.push(args) } },
  })
  const event = enter()
  textarea(instance.render()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(asked), [])
  assert.equal(sendButton(instance.render()).props.disabled, true)
})
