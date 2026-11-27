// The inbox page drawn from a real host's answer: the host's list in three groups,
// every waiting item directly actionable as one flat card with no nested boxes, and
// answers going to the host through the client's real actions (team-actions.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { openHost } from './inbox-team.js'
import { loadClientBundle, makeStatefulReact } from './stateful-react.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function load() {
  const code = await loadClientBundle("export { InboxPane, InboxEntry } from './src/client/inbox.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? { createPortal: el => el } : harness.React))
  return { harness, ...mod.exports }
}

// A window and document for the listeners the cards add; it goes after what was drawn
// has unmounted.
function withDom() {
  const before = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  const noop = () => {}
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = noop
  const listens = { addEventListener: noop, removeEventListener: noop }
  globalThis.window = { ...listens, matchMedia: () => ({ matches: false, ...listens }) }
  globalThis.document = { ...listens, body: { dataset: {}, hasAttribute: () => false }, documentElement: { hasAttribute: () => false }, activeElement: null, querySelector: () => null, hasFocus: () => true }
  return () => Object.assign(globalThis, before)
}

const all = (tree, match, out = []) => {
  if (Array.isArray(tree)) { for (const child of tree) all(child, match, out); return out }
  if (!tree || typeof tree !== 'object') return out
  if (match(tree)) out.push(tree)
  all(tree.children ?? [], match, out)
  return out
}
const textOf = node => (node === null || node === undefined || typeof node === 'boolean' ? ''
  : typeof node !== 'object' ? String(node)
    : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.children ?? []))
const hasClass = (node, name) => String(node.props?.className ?? '').split(/\s+/).includes(name)
const rows = tree => all(tree, node => hasClass(node, 'bt-ib-row'))
const rowOf = (tree, id) => all(tree, node => hasClass(node, 'bt-ib-row') && node.props['data-item-id'] === id)[0]
const button = (tree, label) => all(tree, node => node.type === 'button' && textOf(node) === label)[0]

// The page over a real host: the roster is the host's state answer, the actions the
// client's own, each request going to that host.
async function openPage(t) {
  const restore = withDom()
  const host = openHost(t)
  await host.rt.load()
  const page = await load()
  const read = async () => {
    const answer = await host.call('state', {})
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const value = answer.value
    return {
      ...value,
      byId: Object.fromEntries(value.bots.map(bot => [bot.id, bot])),
      roomsById: Object.fromEntries(value.rooms.map(room => [room.id, room])),
    }
  }
  const roster = createSource(await read())
  const ui = createSource({ inbox: true })
  const opened = []
  const call = async (endpoint, payload) => {
    const answer = await host.call(endpoint, payload)
    if (answer.ok !== true) throw new Error(answer.error?.message ?? endpoint)
    return answer.value
  }
  const actions = {
    ...teamActions({ call, after: async promise => { const value = await promise; roster.set(await read()); return value }, partFor: id => id, roster, ui, live: createSource({}), cards: createSource({}), heldCards: createSource({}) }),
    openSession: id => opened.push(id),
    reportError: (error) => { throw error },
  }
  const completions = createSource({})
  const draw = () => {
    const snap = roster.getSnapshot()
    return page.harness.render(page.harness.React.createElement(page.InboxPane, {
      paneLeft: 280, roster: snap, actions,
      useWork: pick => pick(snap.work), useComputer: pick => pick(snap.computerLive),
      useBrowserHolds: pick => pick(snap.browserHolds ?? {}), useSessionStatus: pick => pick(new Map()),
      useBotCompletions: pick => pick(completions.getSnapshot()),
    }))
  }
  t.after(() => { page.harness.unmount(); restore() })
  const refresh = async () => roster.set(await read())
  return { ...host, page, roster, ui, actions, opened, completions, draw, refresh }
}

test('the page shows the host\'s list in its three groups, directly actionable without expanding', async (t) => {
  const { draw } = await openPage(t)
  const tree = draw()
  const sections = all(tree, node => hasClass(node, 'bt-ib-sec'))
  assert.deepEqual(sections.map(section => textOf(all(section, node => node.type === 'h3')[0])), ['Your call6', 'Needs a fix3'])
  assert.deepEqual(rows(tree).map(row => row.props['data-item-id']), [
    'connector:con-1', 'secret:sec-1', 'question:q-own', 'question:q-group', 'goal:goal-1', 'mail:mail-1',
    'room-paused:desk', 'paused:work-1', 'blocked:coder',
  ])
  const headerOf = (id) => {
    const row = rowOf(tree, id)
    return [
      textOf(all(row, node => hasClass(node, 'bt-ib-name'))[0]),
      textOf(all(row, node => hasClass(node, 'bt-ib-kind'))[0]),
    ].join(' | ')
  }
  assert.equal(headerOf('question:q-group'), 'Writer · Desk | Question')
  assert.equal(headerOf('secret:sec-1'), 'Writer | Secret')
  assert.equal(headerOf('mail:mail-1'), 'Chief | Email')
  assert.equal(headerOf('room-paused:desk'), 'Desk | Paused')
  assert.equal(headerOf('paused:work-1'), 'Chief | Paused')
  assert.equal(headerOf('blocked:coder'), 'Coder | Stopped')
  // Every item's own card or action is already rendered directly in the list.
  assert.match(textOf(rowOf(tree, 'question:q-group')), /Which branch\?/)
  assert.match(textOf(rowOf(tree, 'secret:sec-1')), /XHS_COOKIE/)
  assert.match(textOf(rowOf(tree, 'room-paused:desk')), /Paused after 40 relays/)
  assert.match(textOf(rowOf(tree, 'blocked:coder')), /RATE_LIMIT 429/)
  assert.ok(button(rowOf(tree, 'question:q-group'), 'Open in chat'))
  // The tabs count what waits; the filter pills list every Bot and group something waits in.
  assert.deepEqual(all(tree, node => node.type === 'button' && node.props['aria-pressed'] !== undefined && !hasClass(node, 'bt-ib-pill')).map(textOf), ['Waiting for you9', 'New replies'])
  assert.deepEqual(all(tree, node => hasClass(node, 'bt-ib-pill')).map(textOf), ['All', 'Chief', 'Writer', 'Desk', 'Coder'])
})

test('answering an item directly in the list settles it in the host and leaves after the grace period', async (t) => {
  const { draw, rt, roster, refresh } = await openPage(t)
  let tree = draw()
  // The paused group's Continue button is immediately clickable without opening any detail view.
  button(rowOf(tree, 'room-paused:desk'), 'Continue').props.onClick()
  for (let tries = 0; roster.getSnapshot().inbox.items.some(item => item.id === 'room-paused:desk'); tries += 1) {
    assert.ok(tries < 200, 'the client roster settled the resumed group')
    await sleep(10)
  }
  tree = draw()
  tree = draw()
  // It says it is handled for a moment, then leaves.
  assert.match(textOf(rowOf(tree, 'room-paused:desk')), /Handled/)
  assert.equal(rowOf(tree, 'room-paused:desk').props['data-gone'], true)
  // The list comes again meanwhile (each save sends it); the row still leaves on time.
  await refresh()
  draw()
  for (let tries = 0; rowOf(tree, 'room-paused:desk') !== undefined; tries += 1) {
    assert.ok(tries < 60, 'the handled row left after the grace period')
    await sleep(50)
    tree = draw()
  }
  assert.equal(rowOf(tree, 'room-paused:desk'), undefined)
  assert.equal(rt.inboxView().items.some(item => item.id === 'room-paused:desk'), false)
})

test('an approval is answered directly in the list without opening a second view', async (t) => {
  const { ctx, roster, draw, refresh } = await openPage(t)
  const request = ctx.listeners.get('approval/request')[0]
  void request({ agent: { id: 'writer', session: { id: 'writer' } }, toolName: 'bash', reason: 'Requires approval', callId: 'call-1', signal: new AbortController().signal }, () => new Promise(() => {}))
  await sleep(0)
  await refresh()
  let tree = draw()
  const approval = rows(tree).find(row => row.props['data-item-id'].startsWith('approval:'))
  assert.ok(approval, 'the approval is listed')
  assert.match(textOf(approval), /Writer·Approval/)
  button(approval, 'Allow once').props.onClick()
  for (let tries = 0; roster.getSnapshot().inbox.items.some(item => item.kind === 'approval'); tries += 1) {
    assert.ok(tries < 200, 'the client roster settled the approval')
    await sleep(10)
  }
  tree = draw()
  assert.equal(rows(tree).filter(row => row.props['data-item-id'].startsWith('approval:') && row.props['data-gone'] !== true).length, 0)
})

test('New replies lists the chats with a reply not read yet; opening one leaves the inbox', async (t) => {
  const { draw, completions, ui, opened } = await openPage(t)
  let tree = draw()
  all(tree, node => node.type === 'button' && textOf(node).startsWith('New replies'))[0].props.onClick()
  tree = draw()
  assert.match(textOf(tree), /No new replies/)
  completions.set({ writer: true })
  tree = draw()
  const [reply] = rows(tree)
  assert.equal(textOf(all(reply, node => hasClass(node, 'bt-ib-name'))[0]), 'Writer')
  reply.props.onClick()
  assert.deepEqual(opened, ['writer'])
  assert.equal(ui.getSnapshot().inbox, false)
})

test('the sidebar entry counts what waits and opens or closes the page', async (t) => {
  const restore = withDom()
  const { harness, InboxEntry } = await load()
  t.after(() => { harness.unmount(); restore() })
  const calls = []
  const actions = { openInbox: () => calls.push('open'), closeInbox: () => calls.push('close') }
  const draw = (count, open, rail = false) => harness.render(harness.React.createElement(InboxEntry, { roster: { inbox: { count, counts: {}, items: [] } }, open, rail, actions }))
  let entry = draw(0, false)
  assert.equal(entry.props['aria-label'], 'Inbox')
  assert.equal(all(entry, node => hasClass(node, 'bt-ib-badge')).length, 0)
  entry = draw(3, false)
  assert.equal(entry.props['aria-label'], 'Inbox, 3 waiting for you')
  assert.equal(textOf(all(entry, node => hasClass(node, 'bt-ib-badge'))[0]), '3')
  entry.props.onClick()
  draw(3, true).props.onClick()
  assert.deepEqual(calls, ['open', 'close'])
  assert.equal(textOf(all(draw(120, false, true), node => hasClass(node, 'bt-ib-badge'))[0]), '99+')
})

test('Take over on a handoff card closes the inbox and focuses the Bot panel; approval buttons guard double clicks', async (t) => {
  const restore = withDom()
  const { harness, InboxPane } = await load()
  t.after(() => { harness.unmount(); restore() })
  const events = []
  let answerCalls = 0
  let resolveAnswer
  const roster = {
    bots: [{ id: 'writer', name: 'Writer', sessionId: 'writer', createdAt: 1 }],
    rooms: [],
    byId: { writer: { id: 'writer', name: 'Writer', sessionId: 'writer', createdAt: 1 } },
    roomsById: {},
    inbox: {
      count: 2,
      counts: { decide: 2, fix: 0, suggest: 0 },
      items: [
        { id: 'handoff:bh-1', kind: 'handoff', group: 'decide', ref: 'bh-1', at: 10, botId: 'writer', sessionId: 'writer', surface: 'browser', text: 'Sign in' },
        { id: 'approval:ap-1', kind: 'approval', group: 'decide', ref: 'ap-1', at: 20, botId: 'writer', sessionId: 'writer', tool: 'bash', text: 'ls' },
      ],
    },
  }
  const actions = {
    closeInbox: () => events.push('closeInbox'),
    openSession: id => events.push(`openSession:${id}`),
    openBrowser: id => events.push(`openBrowser:${id}`),
    browserTakeover: async id => { events.push(`takeover:${id}`) },
    answerApproval: () => { answerCalls += 1; return new Promise(resolve => { resolveAnswer = resolve }) },
    reportError: (err) => { throw err },
  }
  const draw = () => harness.render(harness.React.createElement(InboxPane, {
    paneLeft: 280, roster, actions,
    useWork: pick => pick({ approvals: [{ id: 'ap-1', botId: 'writer', tool: 'bash', detail: { code: 'ls' }, answerable: true }], paused: [] }),
    useComputer: pick => pick({ asks: {}, holds: {} }),
    useBrowserHolds: pick => pick({ writer: { by: 'bot', reason: 'login', note: 'Sign in', callId: 'bh-1' } }),
    useSessionStatus: pick => pick(new Map()),
    useBotCompletions: pick => pick({}),
  }))

  let tree = draw()
  // Double-clicking Allow once returns the same in-flight promise so the button stays disabled until settled.
  const apRow = rowOf(tree, 'approval:ap-1')
  button(apRow, 'Allow once').props.onClick()
  tree = draw()
  assert.equal(button(rowOf(tree, 'approval:ap-1'), 'Allow once').props.disabled, true)
  button(apRow, 'Allow once').props.onClick()
  await sleep(0)
  assert.equal(answerCalls, 1)
  tree = draw()
  assert.equal(button(rowOf(tree, 'approval:ap-1'), 'Allow once').props.disabled, true, 'duplicate click does not clear busy before request resolves')
  resolveAnswer()
  await sleep(0)

  // Clicking Take over directly on the browser handoff card closes inbox before opening browser.
  button(rowOf(tree, 'handoff:bh-1'), 'Take over').props.onClick()
  await sleep(10)
  assert.deepEqual(events, ['takeover:writer', 'openSession:writer', 'closeInbox', 'openBrowser:writer'])
})

test('Inbox suppresses bare option letter shortcuts across mixed question/view cards and respects defaultPrevented arrow keys', async (t) => {
  const keyListeners = new Set()
  const before = {
    window: globalThis.window, document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    HTMLInputElement: globalThis.HTMLInputElement, HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement, HTMLElement: globalThis.HTMLElement,
  }
  class FakeElement {}
  globalThis.HTMLElement = FakeElement
  globalThis.HTMLInputElement = class extends FakeElement {}
  globalThis.HTMLTextAreaElement = class extends FakeElement {}
  globalThis.HTMLSelectElement = class extends FakeElement {}
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  const add = (type, fn) => { if (type === 'keydown') keyListeners.add(fn) }
  const remove = (type, fn) => { if (type === 'keydown') keyListeners.delete(fn) }
  globalThis.window = { addEventListener: add, removeEventListener: remove, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) }
  globalThis.document = { addEventListener: add, removeEventListener: remove, body: { dataset: {}, hasAttribute: () => false }, documentElement: { hasAttribute: () => false }, activeElement: null, querySelector: () => null, hasFocus: () => true }
  const code = await loadClientBundle("export { InboxPane } from './src/client/inbox.js'; export { PendingQuestion } from './src/client/questions.js'")
  const harness = makeStatefulReact()
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (id === 'react-dom' ? { createPortal: el => el } : harness.React))
  t.after(() => { harness.unmount(); Object.assign(globalThis, before) })

  const answered = []
  const roster = {
    bots: [
      { id: 'alpha', name: 'Alpha', sessionId: 'alpha', createdAt: 1 },
      { id: 'beta', name: 'Beta', sessionId: 'beta', createdAt: 2 },
    ],
    rooms: [],
    byId: {
      alpha: { id: 'alpha', name: 'Alpha', sessionId: 'alpha', createdAt: 1 },
      beta: { id: 'beta', name: 'Beta', sessionId: 'beta', createdAt: 2 },
    },
    roomsById: {},
    questions: { alpha: { id: 'q-a', question: 'Use staging?', options: [{ label: 'Yes' }, { label: 'No' }] } },
    views: { beta: { id: 'v-b', title: 'Pick a lane', view: { type: 'options', id: 'lane', options: [{ label: 'Fast' }, { label: 'Safe' }] } } },
    inbox: {
      count: 3,
      counts: { decide: 3, fix: 0, suggest: 0 },
      items: [
        { id: 'question:q-a', kind: 'question', group: 'decide', ref: 'q-a', at: 10, botId: 'alpha', sessionId: 'alpha', text: 'Use staging?' },
        { id: 'view:v-b', kind: 'view', group: 'decide', ref: 'v-b', at: 20, botId: 'beta', sessionId: 'beta', text: 'Pick a lane' },
        { id: 'approval:missing', kind: 'approval', group: 'decide', ref: 'missing', at: 30, botId: 'alpha', sessionId: 'alpha', tool: 'bash', text: 'ls' },
      ],
    },
  }
  const actions = {
    closeInbox: () => {},
    openSession: () => {},
    answerQuestion: (sid, id, ans) => { answered.push(['q', sid, id, ans]); return Promise.resolve() },
    answerView: (sid, id, ans) => { answered.push(['v', sid, id, ans]); return Promise.resolve() },
    reportError: (err) => { throw err },
  }
  const draw = (showInbox) => harness.render(harness.React.createElement('div', null,
    // Covered chat behind the inbox holding a question card.
    harness.React.createElement(mod.exports.PendingQuestion, { sessionId: 'alpha', question: roster.questions.alpha, actions, inline: false }),
    showInbox ? harness.React.createElement(mod.exports.InboxPane, {
      paneLeft: 280, roster, actions,
      useWork: pick => pick({ approvals: [], paused: [] }),
      useComputer: pick => pick({ asks: {}, holds: {} }),
      useBrowserHolds: pick => pick({}),
      useSessionStatus: pick => pick(new Map()),
      useBotCompletions: pick => pick({}),
    }) : null))

  const tree = draw(true)
  // Missing approval detail falls back to one Open in chat button (no duplicate in header).
  const missingRow = rowOf(tree, 'approval:missing')
  assert.equal(all(missingRow, node => node.type === 'button' && textOf(node) === 'Open in chat').length, 1)

  // Re-render after OptionKeyGuard effects settle: no card displays misleading A/B letter hints while Inbox is open.
  const settledTree = draw(true)
  assert.equal(all(settledTree, node => hasClass(node, 'bt-key') || hasClass(node, 'dv-key')).length, 0)

  // While Inbox is open with mixed question + view + covered chat card, pressing bare 'a' answers none and does not preventDefault.
  const letterA = { key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  for (const fn of [...keyListeners]) fn(letterA)
  assert.equal(letterA.defaultPrevented, false)
  assert.deepEqual(answered, [])

  // ArrowDown already handled by a child widget (e.g. a chart calling preventDefault) must not pull focus away.
  const page = all(settledTree, node => hasClass(node, 'bt-ib-page'))[0]
  let focused = 0
  const fakeRow = { focus() { focused += 1 }, scrollIntoView() {}, contains: () => false }
  rowOf(settledTree, 'question:q-a').props.ref?.(fakeRow)
  page.props.onKeyDown({ key: 'ArrowDown', defaultPrevented: true, metaKey: false, ctrlKey: false, altKey: false, target: null, preventDefault() {} })
  assert.equal(focused, 0, 'handled ArrowDown does not move Inbox focus')
  page.props.onKeyDown({ key: 'ArrowDown', defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, target: null, preventDefault() {} })
  assert.equal(focused, 1, 'unhandled ArrowDown steps focus to the first card')

  // Unmounting Inbox releases the guard so the lone revealed chat question answers 'a' again.
  draw(false)
  const aloneA = { key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  for (const fn of [...keyListeners]) fn(aloneA)
  await sleep(0)
  assert.equal(aloneA.defaultPrevented, true)
  assert.equal(answered.length, 1)
  assert.deepEqual(answered[0].slice(0, 3), ['q', 'alpha', 'q-a'])
})

test('Escape closes the inbox on the first press, and filtering holds steady during leave grace', async (t) => {
  const keyListeners = new Set()
  const before = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  const add = (type, fn) => { if (type === 'keydown') keyListeners.add(fn) }
  const remove = (type, fn) => { if (type === 'keydown') keyListeners.delete(fn) }
  globalThis.window = { addEventListener: add, removeEventListener: remove, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) }
  globalThis.document = { addEventListener: add, removeEventListener: remove, body: { dataset: {}, hasAttribute: () => false }, documentElement: { hasAttribute: () => false }, activeElement: null, querySelector: () => null, hasFocus: () => true }
  const { harness, InboxPane } = await load()
  t.after(() => { harness.unmount(); Object.assign(globalThis, before) })

  let closed = 0
  const baseRoster = {
    bots: [
      { id: 'chief', name: 'Chief', sessionId: 'chief', createdAt: 1 },
      { id: 'writer', name: 'Writer', sessionId: 'writer', createdAt: 2 },
    ],
    rooms: [],
    byId: {
      chief: { id: 'chief', name: 'Chief', sessionId: 'chief', createdAt: 1 },
      writer: { id: 'writer', name: 'Writer', sessionId: 'writer', createdAt: 2 },
    },
    roomsById: {},
    questions: { writer: { id: 'q1', question: 'Ready?', options: [{ label: 'Yes' }] } },
    inbox: {
      count: 2,
      counts: { decide: 1, fix: 1, suggest: 0 },
      items: [
        { id: 'question:q1', kind: 'question', group: 'decide', ref: 'q1', at: 10, botId: 'writer', sessionId: 'writer', text: 'Ready?' },
        { id: 'blocked:chief', kind: 'blocked', group: 'fix', ref: 'chief', at: 20, botId: 'chief', sessionId: 'chief', text: 'RATE_LIMIT' },
      ],
    },
  }
  let currentRoster = baseRoster
  const actions = { closeInbox: () => { closed += 1 }, openSession: () => {}, reportError: (err) => { throw err } }
  const draw = () => harness.render(harness.React.createElement(InboxPane, {
    paneLeft: 280, roster: currentRoster, actions,
    useWork: pick => pick({ approvals: [], paused: [] }),
    useComputer: pick => pick({ asks: {}, holds: {} }),
    useBrowserHolds: pick => pick({}),
    useSessionStatus: pick => pick(new Map()),
    useBotCompletions: pick => pick({}),
  }))

  let tree = draw()
  // Filter to Writer, then settle Writer's only item.
  all(tree, node => hasClass(node, 'bt-ib-pill') && textOf(node) === 'Writer')[0].props.onClick()
  tree = draw()
  assert.ok(rowOf(tree, 'question:q1'))
  assert.equal(rowOf(tree, 'blocked:chief'), undefined)

  // Settle Writer's item: during the 900ms leave grace, filter stays on Writer (Chief does not flash in).
  currentRoster = {
    ...baseRoster,
    inbox: { count: 1, counts: { decide: 0, fix: 1, suggest: 0 }, items: [baseRoster.inbox.items[1]] },
  }
  tree = draw()
  tree = draw()
  assert.equal(rowOf(tree, 'question:q1')?.props['data-gone'], true)
  assert.equal(rowOf(tree, 'blocked:chief'), undefined, 'other Bot does not jump in while Writer item leaves')

  // A single Escape closes the inbox immediately.
  const esc = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
  for (const fn of [...keyListeners]) fn(esc)
  assert.equal(closed, 1, 'single Escape closes inbox')
})

test('watchBotCompletions marks replies on the active chat unread while Inbox covers it, and clears when Inbox closes', async () => {
  const { watchBotCompletions } = await import('../src/client/bot-completions.js')
  const makeStore = (initial) => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      set: next => { value = typeof next === 'function' ? next(value) : next; for (const fn of [...listeners]) fn() },
    }
  }
  const roster = makeStore({
    bots: [
      { id: 'w1', sessionId: 'w1', parts: ['w1'] },
      { id: 'w2', sessionId: 'w2', parts: ['w2'] },
    ],
    exchangeTurns: {},
  })
  const sessions = makeStore({
    ids: ['w1', 'w2'],
    byId: {
      w1: { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }] } },
      w2: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }] } },
    },
  })
  const statuses = makeStore(new Map([
    ['w1', { running: false, completionUnread: false }],
    ['w2', { running: false, completionUnread: false }],
  ]))
  const unread = makeStore({})
  const ui = makeStore({ inbox: false, inboxTarget: null })

  const stop = watchBotCompletions({ roster, sessions, statuses, unread, ui })
  assert.deepEqual(unread.getSnapshot(), {}, 'visible chat starts read')

  // Open Inbox while w1 stays retained in mainView, then replies arrive on both w1 and w2.
  ui.set({ inbox: true, inboxTarget: null })
  sessions.set({
    ids: ['w1', 'w2'],
    byId: {
      w1: { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }, { turn: 2, response: 'done' }] } },
      w2: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }, { turn: 2, response: 'ready' }] } },
    },
  })
  assert.equal(unread.getSnapshot().w1, true, 'reply while Inbox covers active chat is marked unread')
  assert.equal(unread.getSnapshot().w2, true, 'reply on background chat is marked unread')

  // Navigating from Inbox to w2 closes Inbox before mainView moves: w1 must stay unread!
  ui.set({ inbox: false, inboxTarget: 'w2' })
  assert.equal(unread.getSnapshot().w1, true, 'navigating to w2 does not clear w1 unread')
  assert.equal(unread.getSnapshot().w2, true, 'w2 stays unread until mainView switches to it')
  sessions.set({
    ids: ['w1', 'w2'],
    byId: {
      w1: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }, { turn: 2, response: 'done' }] } },
      w2: { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }, { turn: 2, response: 'ready' }] } },
    },
  })
  assert.deepEqual(unread.getSnapshot(), { w1: true }, 'switching mainView to w2 clears w2 while keeping w1 unread')

  // Part rotation on w2 (without a new Inbox click) must not re-arm the consumed inboxTarget.
  roster.set({
    bots: [
      { id: 'w1', sessionId: 'w1', parts: ['w1'] },
      { id: 'w2', sessionId: 'w2-2', parts: ['w2', 'w2-2'] },
    ],
    exchangeTurns: {},
  })
  sessions.set({
    ids: ['w1', 'w2', 'w2-2'],
    byId: {
      w1: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }, { turn: 2, response: 'done' }] } },
      w2: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }, { turn: 2, response: 'ready' }] } },
      'w2-2': { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'rotated' }] } },
    },
  })
  assert.deepEqual(unread.getSnapshot(), { w1: true }, 'reply in rotated active part stays read')
  // Restore w2 as active part for the direct Inbox dismissal check below.
  roster.set({
    bots: [
      { id: 'w1', sessionId: 'w1', parts: ['w1'] },
      { id: 'w2', sessionId: 'w2', parts: ['w2'] },
    ],
    exchangeTurns: {},
  })
  sessions.set({
    ids: ['w1', 'w2'],
    byId: {
      w1: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }, { turn: 2, response: 'done' }] } },
      w2: { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }, { turn: 2, response: 'ready' }] } },
    },
  })

  // Closing Inbox directly without navigating clears the revealed active chat (w2).
  ui.set({ inbox: true, inboxTarget: null })
  sessions.set({
    ids: ['w1', 'w2'],
    byId: {
      w1: { retainedBy: { mainView: 0 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hi' }, { turn: 2, response: 'done' }] } },
      w2: { retainedBy: { mainView: 1 }, projectionValues: { turnOutline: [{ turn: 1, response: 'hello' }, { turn: 2, response: 'ready' }, { turn: 3, response: 'again' }] } },
    },
  })
  assert.equal(unread.getSnapshot().w2, true)
  ui.set({ inbox: false, inboxTarget: null })
  assert.deepEqual(unread.getSnapshot(), { w1: true }, 'closing Inbox without navigating clears the revealed chat')
  stop()
})

test('New replies falls back to sessions preview and timestamp for unread groups', async (t) => {
  const before = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) }
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, body: { dataset: {}, hasAttribute: () => false }, documentElement: { hasAttribute: () => false }, activeElement: null, querySelector: () => null, hasFocus: () => true }
  const { harness, InboxPane } = await load()
  t.after(() => { harness.unmount(); Object.assign(globalThis, before) })
  const roster = {
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', lastAt: 100, preview: 'Older bot reply', createdAt: 1 }],
    rooms: [{ id: 'ops', name: 'Ops', sessionId: 'ops', members: ['chief'] }],
    byId: { chief: { id: 'chief', name: 'Chief', sessionId: 'chief', lastAt: 100, preview: 'Older bot reply', createdAt: 1 } },
    roomsById: { ops: { id: 'ops', name: 'Ops', sessionId: 'ops', members: ['chief'] } },
    inbox: { count: 0, counts: { decide: 0, fix: 0, suggest: 0 }, items: [] },
  }
  const sessions = {
    ids: ['ops'],
    byId: { ops: { updatedAt: 500, projectionValues: { turnOutline: [{ turn: -1, response: 'Group finished deploying' }] } } },
  }
  const draw = () => harness.render(harness.React.createElement(InboxPane, {
    paneLeft: 280, roster, actions: { closeInbox: () => {}, openSession: () => {} },
    useSessions: pick => pick(sessions),
    useWork: pick => pick({ approvals: [], paused: [] }),
    useComputer: pick => pick({ asks: {}, holds: {} }),
    useBrowserHolds: pick => pick({}),
    useSessionStatus: pick => pick(new Map([['ops', { completionUnread: true }]])),
    useBotCompletions: pick => pick({ chief: true }),
  }))
  let tree = draw()
  all(tree, node => node.type === 'button' && textOf(node).startsWith('New replies'))[0].props.onClick()
  tree = draw()
  const rows = all(tree, node => hasClass(node, 'bt-ib-row'))
  assert.equal(rows.length, 2)
  assert.match(textOf(rows[0]), /Ops/)
  assert.match(textOf(rows[0]), /Group finished deploying/)
  assert.match(textOf(rows[1]), /Chief/)
})
