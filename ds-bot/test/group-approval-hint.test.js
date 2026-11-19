import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install as installApprovals } from '../src/host/approvals.js'

// #1623: a group member's approval lives in the group's details drawer under that group's
// roomId. Only the open group round shows an inline notice pointing to group details, and
// own-chat or other-group approvals must never bleed into this group.
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
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: ({ text }) => h('span', null, text), writeClipboard: () => Promise.resolve(true) } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} } },
  navigator: { clipboard: {} },
  setTimeout: () => 0, clearTimeout() {},
})
const { GroupApprovalHints, GroupReplies, groupApprovals } = module.exports

const writer = { id: 'writer', name: 'Writer', color: 'blue', sessionId: 'writer' }
const chief = { id: 'chief', name: 'Chief', color: 'green', sessionId: 'chief' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief', sessionId: 'room-part2' }
const otherRoom = { id: 'elsewhere', name: 'Other', members: ['writer', 'chief'], admin: 'writer', sessionId: 'elsewhere' }
const roster = {
  bots: [writer, chief],
  byId: { writer, chief },
  rooms: [room, otherRoom],
  roomsById: { 'room-part2': room, room, elsewhere: otherRoom },
  prefs: {},
  revision: 1,
}
const approval = (over = {}) => ({ id: 'a1', sessionId: 'g-chief', botId: 'chief', roomId: 'room', tool: 'computer', reason: 'open a window', detail: {}, at: 1, answerable: true, ...over })

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

test('groupApprovals matches only this group and rejects own-chat or other-group approvals (real host approvalsView contract)', () => {
  // Produce real approval entries through host approvals.js.
  let handler
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'approval/request') handler = fn } },
    groupOwners: new Map([
      ['g-chief-room', { roomId: 'room', botId: 'chief' }],
      ['g-writer-other', { roomId: 'elsewhere', botId: 'writer' }],
    ]),
    chatOwners: new Map([['chief', 'chief']]),
    warn() {},
  }
  installApprovals(rt)
  const ctrl = new AbortController()
  // Group approval in `room`, group approval in `elsewhere`, and own-chat approval for `chief`.
  void handler({ agent: { session: { id: 'g-chief-room' } }, toolName: 'bash', reason: 'run script', signal: ctrl.signal }, () => new Promise(() => {}))
  void handler({ agent: { session: { id: 'g-writer-other' } }, toolName: 'edit', reason: 'write file', signal: ctrl.signal }, () => new Promise(() => {}))
  void handler({ agent: { session: { id: 'chief' } }, toolName: 'bash', reason: 'own chat', signal: ctrl.signal }, () => new Promise(() => {}))
  const realEntries = rt.approvalsView()
  assert.equal(realEntries.length, 3)

  const listed = groupApprovals({ sessionId: 'room-part2', roster, approvals: realEntries })
  assert.equal(listed.length, 1, 'only the approval belonging to this room is returned')
  assert.equal(listed[0].botId, 'chief')
  assert.equal(listed[0].roomId, 'room')
  assert.equal(listed[0].tool, 'bash')
  assert.equal(listed[0].answerable, true)

  // Own-chat approval must never bleed into an idle group that shares the same member.
  const onlyOwnChat = realEntries.filter(entry => entry.roomId === undefined)
  assert.equal(groupApprovals({ sessionId: 'room-part2', roster, approvals: onlyOwnChat }).length, 0)
  // A non-group Session draws nothing.
  assert.equal(groupApprovals({ sessionId: 'chief', roster, approvals: realEntries }).length, 0)
  ctrl.abort()
})

test('group approval notice opens the group details drawer where ApprovalCard lives', () => {
  const details = []
  const opened = []
  const tree = h(GroupApprovalHints, {
    sessionId: 'room-part2', roster,
    actions: { showDetails: id => details.push(id), openSession: id => opened.push(id) },
    useWork: select => select({ approvals: [approval()] }),
  })
  const shown = text(tree)
  assert.match(shown, /Chief needs your approval to run computer/)
  const button = expand(tree).find(element => element.type === 'button')
  assert.ok(button)
  assert.equal(strings(button.props.children).join(''), 'Review approval')
  button.props.onClick()
  assert.deepEqual(details, ['room'], 'must open group details drawer, not the member own chat')
  assert.deepEqual(opened, [])

  // Unanswerable fallback still opens the member chat.
  const fallbackTree = h(GroupApprovalHints, {
    sessionId: 'room-part2', roster,
    actions: { showDetails: id => details.push(id), openSession: id => opened.push(id) },
    useWork: select => select({ approvals: [approval({ answerable: false })] }),
  })
  const fallbackBtn = expand(fallbackTree).find(element => element.type === 'button')
  assert.equal(strings(fallbackBtn.props.children).join(''), "Open Chief's chat")
  fallbackBtn.props.onClick()
  assert.deepEqual(opened, ['chief'])
})

test('GroupReplies renders the approval notice only on open rounds, never on settled history rounds', () => {
  const actions = { roomProgress: async () => [], showDetails() {}, openSession() {} }
  const useUi = select => select({ reactions: {} })
  const useWork = select => select({ approvals: [approval()] })

  // An active (open) round shows the notice instead of an empty cell.
  const openTree = h(GroupReplies, {
    sessionId: 'room-part2', callId: 'call-live', done: false, content: [],
    roster, actions, useUi, useWork,
  })
  const openElements = expand(openTree)
  assert.ok(!openElements.some(element => element.props?.['data-bt-empty'] === true))
  assert.match(text(openTree), /Chief needs your approval to run computer/)

  // A settled historical empty round must NOT duplicate the notice and must stay empty.
  const closedEmpty = h(GroupReplies, {
    sessionId: 'room-part2', callId: 'call-old-empty', done: true,
    content: [{ type: 'text', text: JSON.stringify({ replies: [] }) }],
    roster, actions, useUi, useWork,
  })
  assert.ok(expand(closedEmpty).some(element => element.props?.['data-bt-empty'] === true), 'settled empty round stays CellEmpty')
  assert.doesNotMatch(text(closedEmpty), /needs your approval/)

  // A settled historical round with earlier messages must NOT repeat the live approval notice.
  const closedHistory = h(GroupReplies, {
    sessionId: 'room-part2', callId: 'call-old-1', done: true,
    content: [{ type: 'text', text: JSON.stringify({ replies: [{ who: 'Writer', botId: 'writer', text: 'Earlier message' }] }) }],
    roster, actions, useUi, useWork,
  })
  assert.match(text(closedHistory), /Earlier message/)
  assert.doesNotMatch(text(closedHistory), /needs your approval/, 'historical rounds must not repeat live approvals')
})
