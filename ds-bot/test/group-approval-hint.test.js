import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #1623: a group's member Bot asks for an approval, and the shell draws its card in that
// Bot's own Session. The group chat, where the user asked for the work, said nothing: it
// looked stuck. The group has to say who needs what, and offer the way there.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { GroupApprovalHints, groupApprovals } from './src/client/group-approvals.js'",
      "export { GroupReplies } from './src/client/cells.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: h, Fragment,
  useEffect: () => {}, useLayoutEffect: () => {},
  useMemo: make => make(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: current => ({ current }),
  useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: ({ text }) => text, writeClipboard: () => Promise.resolve(true) } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} } },
  navigator: { clipboard: {} },
  setTimeout: () => 0, clearTimeout() {},
})
const { GroupApprovalHints, GroupReplies, groupApprovals } = module.exports

const writer = { id: 'writer', name: 'Writer', color: 'blue', sessionId: 'writer' }
const chief = { id: 'chief', name: 'Chief', color: 'green', sessionId: 'chief' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief', sessionId: 'room-part2' }
const roster = { bots: [writer, chief], byId: { writer, chief }, rooms: [room], roomsById: { 'room-part2': room, room }, prefs: {}, revision: 1 }
const approval = (over = {}) => ({ id: 'a1', botId: 'chief', roomId: 'room', tool: 'computer', reason: 'open a window', at: 1, ...over })

// Every element of a rendered tree, components run as plain functions.
function expand(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') { expand(node.type(node.props), out); return out }
  out.push(node)
  expand(node.props?.children, out)
  return out
}
const strings = (value) => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value === null || typeof value !== 'object') return []
  return strings(value.props?.children)
}
const text = node => expand(node).flatMap(element => strings(element.props?.children)).join(' ')

test('the group lists the approvals its members wait on, and only those', () => {
  const listed = groupApprovals({ sessionId: 'room-part2', roster, approvals: [approval(), approval({ id: 'a2', botId: 'writer', roomId: 'elsewhere' }), approval({ id: 'a3', botId: 'chief', roomId: undefined })] })
  assert.deepEqual([...listed.map(entry => entry.id)], ['a1', 'a3'])
  // Another Session draws nothing of it.
  assert.equal(groupApprovals({ sessionId: 'chief', roster, approvals: [approval()] }).length, 0)
})

test('the group shows who needs the approval, with a way to that Bot', () => {
  const opened = []
  const tree = h(GroupApprovalHints, {
    sessionId: 'room-part2', roster, actions: { openSession: id => opened.push(id) },
    useWork: select => select({ approvals: [approval()] }),
  })
  const shown = text(tree)
  assert.match(shown, /Chief needs your approval to run computer/)
  const button = expand(tree).find(element => element.type === 'button')
  assert.ok(button, 'there is a way to the Bot')
  assert.equal(strings(button.props.children).join(''), "Open Chief's chat")
  button.props.onClick()
  assert.deepEqual(opened, ['chief'])
})

test('the group turn that waits for an approval draws the notice instead of an empty cell', () => {
  const opened = []
  const tree = h(GroupReplies, {
    sessionId: 'room-part2', callId: 'call-1', done: true, content: [],
    roster, actions: { roomProgress: async () => [], openSession: id => opened.push(id) },
    useUi: select => select({ reactions: {} }),
    useWork: select => select({ approvals: [approval()] }),
  })
  const elements = expand(tree)
  assert.ok(!elements.some(element => element.props?.['data-bt-empty'] === true), 'the group is not drawn as empty')
  assert.match(text(tree), /Chief needs your approval/)
})
