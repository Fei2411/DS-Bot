import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/approval-queue.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { ApprovalQueue, approvalsOf, closedApprovals, waitingIn, approvalCellKey, approvalCellWanted, vanishedApprovals, closeVanishedApprovals, APPROVAL_STALE } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

const roster = {
  byId: { a: { id: 'a', name: 'Anvil' }, b: { id: 'b', name: 'Flint' } },
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], sessionId: 'r1-part' } },
  questions: {},
}
const approval = (id, extra = {}) => ({ id, botId: 'a', sessionId: 'a', tool: 'pwsh', reason: 'escalate sandbox', detail: { code: 'Copy-Item a.md E:/docs' }, at: 1, answerable: true, ...extra })

// The shim keeps component nodes unrendered; the cards are components of their own.
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return [{ ...node, children: (node.children ?? []).flatMap(expand) }]
}
const render = (sessionId, work, state = { closed: {} }, actions = {}) => {
  const tree = expand(ApprovalQueue({
    sessionId, useRoster: pick => pick(roster), useWork: pick => pick(work), useApprovals: pick => pick(state), actions,
  }))
  return tree.length === 1 ? tree[0] : tree
}
const all = (node, className) => {
  const found = []
  const walk = (item) => {
    if (Array.isArray(item)) { for (const one of item) walk(one); return }
    if (item === null || typeof item !== 'object') return
    if (item.props?.className === className) found.push(item)
    for (const child of item.children ?? []) walk(child)
  }
  walk(node)
  return found
}
const cardIds = node => all(node, 'bt-aq-card').map(card => card.props['aria-label'])

test('a conversation lists its own approvals: a Bot\'s chat by Session, a group by its room', () => {
  const work = {
    approvals: [
      approval('one', { at: 2 }),
      approval('two', { at: 1 }),
      approval('group', { botId: 'b', sessionId: 'gb', roomId: 'r1', at: 3 }),
      approval('elsewhere', { botId: 'b', sessionId: 'b', at: 4 }),
    ],
  }
  assert.deepEqual(plain(approvalsOf(work, 'a').map(entry => entry.id)), ['two', 'one'])
  assert.deepEqual(plain(approvalsOf(work, 'r1').map(entry => entry.id)), ['group'])
  assert.deepEqual(plain(approvalsOf(work, 'b').map(entry => entry.id)), ['elsewhere'])
})

test('a failed answer stays until dismissed, and never doubles a waiting card', () => {
  const open = approval('one')
  const closed = {
    one: { approval: open, message: 'This approval is no longer open', at: 2 },
    two: { approval: approval('two'), message: 'This approval is no longer open', at: 3 },
  }
  assert.deepEqual(plain(closedApprovals({ closed: { a: closed } }, 'a', [open]).map(entry => entry.approval.id)), ['two'])
  assert.equal(waitingIn({ approvals: [] }, { closed: { a: closed } }, 'a'), true)
  assert.equal(waitingIn({ approvals: [] }, { closed: {} }, 'a'), false)
  // A decision that opens or closes re-registers the composer's entry.
  assert.equal(approvalCellKey({ approvals: [open] }, { closed: {} }), approvalCellKey({ approvals: [open] }, { closed: {} }))
  assert.notEqual(approvalCellKey({ approvals: [open] }, { closed: {} }), approvalCellKey({ approvals: [] }, { closed: {} }))
  assert.notEqual(approvalCellKey({ approvals: [open] }, { closed: {} }), approvalCellKey({ approvals: [open] }, { closed: { a: closed } }))
})

test('every waiting approval gets its own card, each answering with its own id', async () => {
  const answered = []
  const work = { approvals: [approval('one', { at: 1 }), approval('two', { at: 2, botId: 'b' })] }
  const node = render('a', work, { closed: {} }, { answerApproval: (id, choice) => { answered.push([id, choice]); return Promise.resolve() } })
  assert.equal(node.props['data-count'], 2)
  assert.deepEqual(all(node, 'bt-aq-count').map(entry => entry.children.join('')), ['2 waiting for approval'])
  assert.deepEqual(cardIds(node), ['Anvil is waiting for your approval', 'Flint is waiting for your approval'])
  const [first, second] = all(node, 'bt-aq-card')
  const allow = card => all(card, 'bt-aq-go')[0]
  const reject = card => all(card, 'bt-aq-btn')[0]
  allow(first).props.onClick()
  reject(second).props.onClick()
  await Promise.resolve()
  assert.deepEqual(answered, [['one', 'allow'], ['two', 'reject']])
  // The queue keeps both cards while both requests wait.
  assert.equal(all(node, 'bt-aq-card').length, 2)
})

test('an answer the host no longer knows shows its reason on the card, until dismissed', async () => {
  const stale = approval('gone', { at: 1 })
  const state = { closed: { a: { gone: { approval: stale, message: 'This approval is no longer open', at: 5 } } } }
  const dismissed = []
  const work = { approvals: [approval('waiting', { at: 2 })] }
  const node = render('a', work, state, { dismissApproval: entry => dismissed.push(entry.id) })
  const cards = all(node, 'bt-aq-card')
  assert.equal(cards.length, 2)
  const staleCard = cards[1]
  assert.deepEqual(all(staleCard, 'bt-aq-error').map(entry => entry.children.join('')), ['This approval is no longer open'])
  // A card that can no longer be answered offers no decision, only the note.
  assert.equal(all(staleCard, 'bt-aq-actions').length, 0)
  all(staleCard, 'bt-aq-btn')[0].props.onClick()
  assert.deepEqual(dismissed, ['gone'])
})

// #966: another window's decision reaches this one only as a shorter work list. The
// card must stay, stale, instead of vanishing with the approval it asked about.
test('an approval another window decided stays as a stale card, not gone', () => {
  const gone = approval('gone', { at: 1 })
  const prev = { approvals: [gone] }
  const next = { approvals: [] }
  assert.deepEqual(plain(vanishedApprovals(prev, next).map(entry => entry.id)), ['gone'])
  assert.deepEqual(plain(vanishedApprovals(next, prev)), [])
  const state = closeVanishedApprovals({ closed: {}, settled: {} }, prev, next, { at: 9 })
  assert.equal(state.closed.a.gone.approval, gone)
  assert.equal(state.closed.a.gone.message, APPROVAL_STALE)
  assert.equal(state.closed.a.gone.at, 9)
  // The composer's place stays held until the card is dismissed.
  assert.equal(waitingIn(next, state, 'a'), true)
  assert.equal(approvalCellWanted(roster, next, state, 'a'), true)
  const node = render('a', next, state, { dismissApproval: () => {} })
  assert.deepEqual(all(node, 'bt-aq-error').map(entry => entry.children.join('')), ['This approval is no longer open'])
  assert.deepEqual(all(node, 'bt-aq-btn').map(entry => entry.children.join('')), ['Dismiss'])
})

test('an approval this window answered just goes when the host drops it', () => {
  const answered = approval('answered', { at: 1 })
  const state = closeVanishedApprovals({ closed: {}, settled: { answered: true } }, { approvals: [answered] }, { approvals: [] }, { at: 9 })
  assert.deepEqual(plain(state.closed), {})
  assert.deepEqual(plain(state.settled), {})
  assert.equal(waitingIn({ approvals: [] }, state, 'a'), false)
})

test('a vanished approval already closed keeps its first reason, and a settled one beside it does not block the rest', () => {
  const gone = approval('gone', { at: 1 })
  const mine = approval('mine', { at: 2 })
  const early = { approval: gone, message: 'first reason', at: 3 }
  const state = closeVanishedApprovals(
    { closed: { a: { gone: early } }, settled: { mine: true } },
    { approvals: [gone, mine] },
    { approvals: [] },
  )
  assert.equal(state.closed.a.gone, early)
  assert.deepEqual(plain(state.settled), {})
  // A list with nothing missing leaves the sources as they were.
  const quiet = { closed: {}, settled: {} }
  assert.equal(closeVanishedApprovals(quiet, { approvals: [gone] }, { approvals: [gone] }), quiet)
})

test('a group\'s approvals show above its composer, a Bot\'s own chat keeps them for the composer cell', () => {
  const work = { approvals: [approval('group', { botId: 'b', sessionId: 'gb', roomId: 'r1' })] }
  const group = render('r1', work)
  assert.equal(all(group, 'bt-aq-card').length, 1)
  // The Bot's own chat has nothing to show for a group's approvals.
  assert.equal(render('a', work), null)
  assert.equal(render('a', { approvals: [] }), null)
})

test('only a Bot\'s own chat, with an approval or a failed answer, takes the composer\'s place', () => {
  const own = { approvals: [approval('one')] }
  const room = { approvals: [approval('group', { botId: 'b', sessionId: 'gb', roomId: 'r1' })] }
  const quiet = { closed: {} }
  assert.equal(approvalCellWanted(roster, own, quiet, 'a'), true)
  // A group keeps its composer; its queue is the dock.
  assert.equal(approvalCellWanted(roster, room, quiet, 'r1'), false)
  // No approval and no failed answer: DSH's own composer stays.
  assert.equal(approvalCellWanted(roster, { approvals: [] }, quiet, 'a'), false)
  // A pending question owns the composer's place, as it does in DSH.
  assert.equal(approvalCellWanted({ ...roster, questions: { a: { id: 'q1' } } }, own, quiet, 'a'), false)
  // A failed answer keeps the cell until dismissed: the card is the only place it shows.
  const closed = { closed: { a: { one: { approval: own.approvals[0], message: 'This approval is no longer open', at: 1 } } } }
  assert.equal(approvalCellWanted(roster, { approvals: [] }, closed, 'a'), true)
})
