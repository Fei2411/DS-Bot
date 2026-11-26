// The inbox page drawn from a real host's answer: the host's list in three groups, the
// chat's own cards inside it, and answers that go to the host through the client's
// real actions (team-actions.js), so what is settled here is settled in the chat too.
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
  globalThis.document = { ...listens, body: { dataset: {}, hasAttribute: () => false }, documentElement: { ...listens, hasAttribute: () => false }, activeElement: null, querySelector: () => null, hasFocus: () => true }
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
const rowOf = (tree, id) => all(tree, node => hasClass(node, 'bt-ib-row') && node.props['data-flip'] === id)[0]
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

test('the page shows the host\'s list in its three groups, the longest wait first', async (t) => {
  const { draw } = await openPage(t)
  const tree = draw()
  const sections = all(tree, node => hasClass(node, 'bt-ib-sec'))
  assert.deepEqual(sections.map(section => textOf(all(section, node => node.type === 'h3')[0])), ['Your call6', 'Needs a fix3'])
  assert.deepEqual(rows(tree).map(row => row.props['data-flip']), [
    'connector:con-1', 'secret:sec-1', 'question:q-own', 'question:q-group', 'goal:goal-1', 'mail:mail-1',
    'room-paused:desk', 'paused:work-1', 'blocked:coder',
  ])
  const line = id => textOf(all(rowOf(tree, id), node => hasClass(node, 'bt-ib-copy'))[0])
  // Summary first, then who and kind: a group card names the member and the group.
  assert.equal(line('question:q-group'), 'Which branch?Writer · Desk·Question')
  assert.equal(line('secret:sec-1'), 'Asks for the secret XHS_COOKIEWriter·Secret')
  assert.equal(line('mail:mail-1'), 'Wants to send “Weekly report” to team@example.comChief·Email')
  assert.equal(line('room-paused:desk'), 'Paused after 40 relaysDesk·Paused')
  assert.equal(line('paused:work-1'), 'Hand-off to Writer paused · Which version is this for?Chief·Paused')
  assert.equal(line('blocked:coder'), 'The model failed (RATE_LIMIT 429)Coder·Stopped')
  // The tabs count what waits; the filter pills list every Bot and group something waits in.
  assert.deepEqual(all(tree, node => node.type === 'button' && node.props['aria-pressed'] !== undefined && !hasClass(node, 'bt-ib-pill')).map(textOf), ['Waiting for you9', 'New replies'])
  assert.deepEqual(all(tree, node => hasClass(node, 'bt-ib-pill')).map(textOf), ['All', 'Chief', 'Writer', 'Desk', 'Coder'])
})

test('a row opens into the chat\'s own card; answering it there settles it in the host', async (t) => {
  const { draw, rt, refresh } = await openPage(t)
  let tree = draw()
  // A group card opens with the group's question card, as the group's chat shows it.
  all(rowOf(tree, 'question:q-group'), node => hasClass(node, 'bt-ib-sum'))[0].props.onClick()
  tree = draw()
  const open = rowOf(tree, 'question:q-group')
  assert.equal(open.props['data-open'], true)
  assert.match(textOf(all(open, node => hasClass(node, 'bt-ib-detail'))[0]), /Which branch\?/)
  assert.ok(button(open, 'Open in chat'), 'it can be seen in its chat')

  // The group paused at its relay limit goes on from the page; the host resumes it.
  all(rowOf(tree, 'room-paused:desk'), node => hasClass(node, 'bt-ib-sum'))[0].props.onClick()
  tree = draw()
  button(rowOf(tree, 'room-paused:desk'), 'Continue').props.onClick()
  for (let tries = 0; rt.state.rooms.desk.idlePaused !== undefined; tries += 1) {
    assert.ok(tries < 100, 'the host resumed the group')
    await sleep(10)
  }
  await sleep(20)
  tree = draw()
  tree = draw()
  // It says it is handled for a moment, then leaves.
  assert.match(textOf(rowOf(tree, 'room-paused:desk')), /Handled/)
  assert.equal(rowOf(tree, 'room-paused:desk').props['data-gone'], true)
  // The list comes again meanwhile (each save sends it); the row still leaves on time.
  await refresh()
  draw()
  await sleep(950)
  tree = draw()
  assert.equal(rowOf(tree, 'room-paused:desk'), undefined)
  assert.equal(rt.inboxView().items.some(item => item.id === 'room-paused:desk'), false)
})

test('an approval is answered from its row without opening it', async (t) => {
  const { ctx, rt, draw, refresh } = await openPage(t)
  const request = ctx.listeners.get('approval/request')[0]
  void request({ agent: { id: 'writer', session: { id: 'writer' } }, toolName: 'bash', reason: 'Requires approval', callId: 'call-1', signal: new AbortController().signal }, () => new Promise(() => {}))
  await sleep(0)
  await refresh()
  let tree = draw()
  const approval = rows(tree).find(row => row.props['data-flip'].startsWith('approval:'))
  assert.ok(approval, 'the approval is listed')
  assert.match(textOf(approval), /Writer·Approval/)
  button(approval, 'Allow once').props.onClick()
  for (let tries = 0; rt.inboxView().items.some(item => item.kind === 'approval'); tries += 1) {
    assert.ok(tries < 100, 'the host settled the approval')
    await sleep(10)
  }
  await sleep(20)
  tree = draw()
  assert.equal(rows(tree).filter(row => row.props['data-flip'].startsWith('approval:') && row.props['data-gone'] !== true).length, 0)
})

test('New replies lists the chats with a reply not read yet; opening one leaves the inbox', async (t) => {
  const { draw, completions, ui, opened } = await openPage(t)
  let tree = draw()
  button(tree, 'New replies').props.onClick()
  tree = draw()
  assert.match(textOf(tree), /No new replies/)
  completions.set({ writer: true })
  tree = draw()
  const [reply] = rows(tree)
  assert.equal(textOf(all(reply, node => hasClass(node, 'bt-ib-name'))[0]), 'Writer')
  all(reply, node => hasClass(node, 'bt-ib-sum'))[0].props.onClick()
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
