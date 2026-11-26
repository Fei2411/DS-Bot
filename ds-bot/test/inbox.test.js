import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHost, team } from './inbox-team.js'

test('the inbox lists what waits on the user, by group, the longest wait first', async (t) => {
  const { rt, call } = openHost(t)
  await rt.load()
  const inbox = rt.inboxView()
  assert.deepEqual(inbox.items.map(item => item.id), [
    'connector:con-1', 'secret:sec-1', 'question:q-own', 'question:q-group', 'goal:goal-1', 'mail:mail-1',
    'room-paused:desk', 'paused:work-1', 'blocked:coder',
  ])
  assert.deepEqual(inbox.counts, { decide: 6, fix: 3, suggest: 0 })
  assert.equal(inbox.count, 9)
  const byId = Object.fromEntries(inbox.items.map(item => [item.id, item]))
  // A card asked in a group belongs to that group and the member who asked it.
  assert.deepEqual(
    { botId: byId['question:q-group'].botId, roomId: byId['question:q-group'].roomId, sessionId: byId['question:q-group'].sessionId },
    { botId: 'writer', roomId: 'desk', sessionId: 'desk-writer' },
  )
  assert.equal(byId['question:q-own'].roomId, undefined)
  // A card left in an earlier part of a chat is not shown there, so not listed (q-old).
  assert.equal(byId['question:q-own'].taskId, undefined)
  assert.equal(byId['question:q-own'].text, 'Top or bottom?')
  assert.equal(byId['secret:sec-1'].need, 'fill')
  assert.equal(byId['secret:sec-1'].text, 'XHS_COOKIE')
  assert.equal(byId['mail:mail-1'].to, 'team@example.com')
  assert.equal(byId['goal:goal-1'].text, 'Ship the release')
  assert.equal(byId['goal:goal-1'].botId, 'chief')
  assert.deepEqual([byId['room-paused:desk'].roomId, byId['room-paused:desk'].limit], ['desk', 40])
  assert.deepEqual([byId['paused:work-1'].botId, byId['paused:work-1'].to, byId['paused:work-1'].reason, byId['paused:work-1'].text], ['chief', 'writer', 'ask_back', 'Which version is this for?'])
  assert.deepEqual([byId['blocked:coder'].text, byId['blocked:coder'].status], ['RATE_LIMIT', 429])
  // Every window reads the same list with the live state.
  const state = await call('state', {})
  assert.equal(state.ok, true, JSON.stringify(state.error))
  assert.deepEqual(state.value.inbox.items.map(item => item.id), inbox.items.map(item => item.id))
})

test('a card asked in a background task names the task', async (t) => {
  const state = team()
  // A task a restart left running is settled at start (bot-tasks.js); once it is,
  // the start is over and a task added now stays.
  state.bots.coder.tasks = [{ id: 'task-0', sessionId: 'coder-old-task', title: 'Left over', status: 'running' }]
  const { rt } = openHost(t, state)
  await rt.load()
  for (let tries = 0; rt.state.bots.coder.tasks.some(task => task.id === 'task-0' && task.status === 'running'); tries += 1) {
    assert.ok(tries < 200, 'the left-over task is settled at start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  rt.state.bots.coder.tasks.push({ id: 'task-1', sessionId: 'coder-task', title: 'Nightly check', status: 'running' })
  rt.state.questions['coder-task'] = { id: 'q-task', question: 'Skip the flaky test?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, askedAt: 38 }
  await rt.save()
  const item = rt.inboxView().items.find(entry => entry.id === 'question:q-task')
  assert.ok(item, 'the task\'s question is listed')
  assert.deepEqual([item.botId, item.taskId, item.roomId, item.sessionId], ['coder', 'task-1', undefined, 'coder-task'])
})

test('a settled item leaves the inbox; a new one is announced once, and not the ones there at start', async (t) => {
  const { rt } = openHost(t)
  await rt.load()
  const added = []
  rt.onInboxAdded(item => added.push(item.id))
  await rt.save()
  assert.deepEqual(added, [], 'what waited before is not news')

  rt.state.secretRequests.writer.find(request => request.id === 'sec-1').status = 'allowed'
  delete rt.state.bots.coder.blocked
  await rt.save()
  const ids = rt.inboxView().items.map(item => item.id)
  assert.equal(ids.includes('secret:sec-1'), false)
  assert.equal(ids.includes('blocked:coder'), false)

  rt.state.connectorRequests.chief.push({ id: 'con-2', sessionId: 'chief', connectorId: 'github', name: 'GitHub', purpose: '', status: 'pending', askedAt: 80 })
  await rt.save()
  await rt.save()
  assert.deepEqual(added, ['connector:con-2'])
})

test('an approval waits in the inbox until it is answered; a DSH Agent one is not a Bot\'s', async (t) => {
  const { ctx, rt } = openHost(t)
  await rt.load()
  const added = []
  rt.onInboxAdded(item => added.push(item))
  // approvals.js asks the user; it registers ahead of extra-folders.js (MODULES order).
  const request = ctx.listeners.get('approval/request')[0]
  void request({ agent: { id: 'writer', session: { id: 'writer' } }, toolName: 'bash', reason: 'Requires approval', callId: 'call-1', signal: new AbortController().signal }, () => new Promise(() => {}))
  await new Promise(resolve => setImmediate(resolve))
  const approval = rt.inboxView().items.find(item => item.kind === 'approval')
  assert.ok(approval, 'the approval is listed')
  assert.deepEqual([approval.group, approval.botId, approval.tool], ['decide', 'writer', 'bash'])
  assert.deepEqual(added.map(item => item.kind), ['approval'])
  rt.answerApproval(approval.ref, 'reject')
  assert.equal(rt.inboxView().items.some(item => item.kind === 'approval'), false)
})

test('a learning proposal is a suggestion, and a source can add its own items', async (t) => {
  const { rt } = openHost(t)
  await rt.load()
  const real = rt.learningView
  rt.learningView = () => ({ writer: [{ id: 'p-1', kind: 'skill', botId: 'writer', name: 'release-notes', at: 90 }] })
  t.after(() => { rt.learningView = real })
  const off = rt.addInboxSource(() => [
    { kind: 'stalled', ref: 'turn-7', group: 'fix', botId: 'writer', taskId: 'bg-9', at: 1, text: 'No progress for 20 minutes' },
    { kind: 'stalled', ref: 'turn-8', botId: 'gone' },
    { kind: '', ref: 'nothing' },
  ])
  const items = rt.inboxView().items
  const learning = items.find(item => item.kind === 'learning')
  assert.deepEqual([learning.group, learning.text, learning.proposal], ['suggest', 'skills/release-notes/SKILL.md', 'skill'])
  assert.equal(items.at(-1).id, 'learning:p-1')
  const stalled = items.filter(item => item.kind === 'stalled')
  assert.deepEqual(stalled.map(item => [item.id, item.group, item.text, item.taskId]), [['stalled:turn-7', 'fix', 'No progress for 20 minutes', 'bg-9']])
  off()
  assert.equal(rt.inboxView().items.some(item => item.kind === 'stalled'), false)
})

test('the phone hears of a new inbox item, a group card under its group', async (t) => {
  const { rt, call } = openHost(t)
  await rt.load()
  const before = (await call('notices', { boot: 'other' })).value.notices.length
  rt.state.questions['desk-writer'] = undefined
  delete rt.state.questions['desk-writer']
  await rt.save()
  rt.state.questions['desk-writer'] = { id: 'q-new', question: 'Merge now?', options: [{ label: 'Yes' }], multiSelect: false, askedAt: 100 }
  rt.state.mailRequests.chief.push({ id: 'mail-2', sessionId: 'chief', to: 'x@example.com', subject: 'Invoice', status: 'pending', askedAt: 101 })
  await rt.save()
  const notices = (await call('notices', { boot: 'other' })).value.notices.slice(before)
  assert.deepEqual(notices.map(notice => [notice.kind, notice.botId, notice.roomId ?? null, notice.text]), [
    ['question', 'writer', 'desk', 'Merge now?'],
    ['mail', 'chief', null, 'Invoice'],
  ])
})

test('browser handoff carries a real timestamp preserved across takeover and signals inbox changes', async (t) => {
  const previous = process.env.DS_BOT_APP
  process.env.DS_BOT_APP = '1'
  t.after(() => { if (previous === undefined) delete process.env.DS_BOT_APP; else process.env.DS_BOT_APP = previous })
  const { rt, call } = openHost(t, team(), { services: { profileContext: { name: 'ds-bot' } } })
  await rt.load()
  let changes = 0
  const off = rt.onInboxChanged(() => { changes += 1 })
  t.after(off)
  const before = Date.now()
  rt.browserChannel.setHold('writer', { by: 'bot', reason: 'login', note: 'Sign in', callId: 'call-bh-1', sessionId: 'writer' })
  const item = rt.inboxView().items.find(entry => entry.id === 'handoff:call-bh-1')
  assert.ok(item, 'browser handoff is listed')
  assert.ok(item.at >= before, 'browser handoff records a positive timestamp')
  assert.ok(changes >= 1, 'adding a browser handoff triggers onInboxChanged')

  const originalAt = item.at
  const takeover = await call('browser-takeover', { botId: 'writer' })
  assert.equal(takeover.ok, true)
  const afterTakeover = rt.inboxView().items.find(entry => entry.id === 'handoff:call-bh-1')
  assert.equal(afterTakeover.at, originalAt, 'browser-takeover preserves original handoff timestamp')

  const changesBeforeClear = changes
  rt.browserChannel.setHold('writer', null)
  assert.equal(rt.inboxView().items.some(entry => entry.id === 'handoff:call-bh-1'), false)
  assert.ok(changes > changesBeforeClear, 'clearing a browser handoff triggers onInboxChanged')
})

test('archived-part and id-less secret, connector, and mail requests are excluded from the inbox', async (t) => {
  const state = team()
  state.secretRequests.coder = [
    { id: 'sec-archived', sessionId: 'coder', name: 'OLD_KEY', kind: 'fill', status: 'pending', askedAt: 10 },
    { sessionId: 'coder-p2', name: 'NO_ID', kind: 'fill', status: 'pending', askedAt: 11 },
  ]
  state.connectorRequests.coder = [
    { id: 'con-archived', sessionId: 'coder', connectorId: 'slack', name: 'Slack', status: 'pending', askedAt: 12 },
    { id: '', sessionId: 'coder-p2', connectorId: 'jira', name: 'Jira', status: 'pending', askedAt: 13 },
  ]
  state.mailRequests.coder = [
    { id: 'mail-archived', sessionId: 'coder', subject: 'Old mail', to: 'a@example.com', status: 'pending', askedAt: 14 },
  ]
  const { rt } = openHost(t, state)
  await rt.load()
  const ids = rt.inboxView().items.map(item => item.id)
  for (const dropped of ['secret:sec-archived', 'secret:undefined', 'connector:con-archived', 'connector:', 'mail:mail-archived']) {
    assert.equal(ids.includes(dropped), false, `${dropped} should be excluded`)
  }
})

test('computer handoff stays in the inbox after Take over until settled, while a plain user takeover does not enter', async (t) => {
  const { rt } = openHost(t)
  await rt.load()
  const realComputerLive = rt.computerLive
  let holds = {
    writer: { id: 'ch-1', by: 'bot', fromBot: true, surface: 'computer', reason: 'login', note: 'Sign in', at: 1234 },
    chief: { id: 'ch-user', by: 'user', surface: 'computer', reason: 'takeover', note: 'User started', at: 1235 },
  }
  rt.computerLive = () => ({ asks: {}, holds })
  t.after(() => { rt.computerLive = realComputerLive })

  let changes = 0
  const off = rt.onInboxChanged(() => { changes += 1 })
  t.after(off)

  // Bot-initiated computer handoff is listed; plain user takeover is not.
  assert.equal(rt.inboxView().items.some(item => item.id === 'handoff:ch-1'), true)
  assert.equal(rt.inboxView().items.some(item => item.id === 'handoff:ch-user'), false)

  // After user clicks Take over, `by` becomes 'user' while `fromBot: true` keeps it in the inbox.
  holds = {
    writer: { id: 'ch-1', by: 'user', fromBot: true, surface: 'computer', reason: 'login', note: 'Sign in', at: 1234 },
  }
  rt.inboxChanged()
  const stillThere = rt.inboxView().items.find(item => item.id === 'handoff:ch-1')
  assert.ok(stillThere, 'computer handoff remains listed after Take over until Skip / Done')
  assert.equal(stillThere.at, 1234)

  // Settling the hold removes it and fires onInboxChanged.
  holds = {}
  rt.inboxChanged()
  assert.equal(rt.inboxView().items.some(item => item.id === 'handoff:ch-1'), false)
  assert.ok(changes >= 1)

  // Saving state does not fire redundant live pings through onInboxChanged.
  const beforeSave = changes
  rt.state.connectorRequests.chief.push({ id: 'con-save-only', sessionId: 'chief', connectorId: 'linear', name: 'Linear', purpose: '', status: 'pending', askedAt: 200 })
  await rt.save()
  assert.equal(changes, beforeSave)
})
