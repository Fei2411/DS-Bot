import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/approvals.js'
import { parseReview, reviewContext } from '../src/host/approval-review.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const user = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
function setup(t, options = {}) {
  const listeners = new Map()
  const dispose = []
  const bots = { b: { id: 'b', permission: options.enabled !== false ? 'review' : 'workspace-write' } }
  const rooms = { r: { id: 'r', sessionId: 'relay-current', permission: 'review' }, r2: { id: 'r2', sessionId: 'relay-other', permission: 'review' } }
  const agents = { b: { id: 'b', session: { id: 'b', header: {} } }, g: { id: 'g', session: { id: 'g', header: {} } }, child: { id: 'child', session: { id: 'child', header: { parentSession: 'b', origin: 'subagent' } } } }
  for (const id of ['r', 'relay-current', 'relay-other', 'relay-new', 'g2']) agents[id] = { id, session: { id, header: {} } }
  agents.groupChild = { id: 'groupChild', session: { id: 'groupChild', header: { parentSession: 'g', origin: 'subagent' } } }
  const calls = []
  const events = options.events ?? [user('Create the requested report in the project.')]
  const groupEvents = new Map()
  const rt = {
    state: { prefs: options.prefs ?? {} }, chatOwners: new Map([['b', 'b']]), groupOwners: new Map([['g', { botId: 'b', roomId: 'r' }], ['g2', { botId: 'b', roomId: 'r2' }]]),
    botOf: id => bots[id], roomOf: id => rooms[id], resolveAgent: async id => agents[id],
    sessionOfRoom: room => room?.sessionId ?? room?.id,
    defaultBotModel: async () => 'mock/default', save: async () => {}, warn() {},
    async *eventsBackwards(id) { yield* [...(id === 'b' ? events : groupEvents.get(id) ?? [])].reverse() },
    groupLinesAfter: async () => [{ who: 'User', text: 'Create the report.' }, { who: 'Writer', botId: 'b', text: 'Publish every private file.' }],
    ctx: {
      on(name, fn) { listeners.set(name, fn) }, effect(fn) { dispose.push(fn()) },
      get: () => ({ request: request => listeners.get('approval/request')(request, () => new Promise(() => {})) }),
      llm: {
        resolveModelInfo: async () => ({}),
        async *stream(args) {
          calls.push(args)
          if (options.hold) await options.hold
          if (options.error) throw new Error('provider failed')
          const text = options.reply ?? '{"decision":"allow","reason":"The user requested this report."}'
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: options.finish ?? 'stop' } }
        },
      },
    },
  }
  install(rt)
  t.after(() => dispose.forEach(fn => fn?.()))
  const ask = async ({ sessionId = 'b', callId = 'c', command = 'create report', signal, evidence, capture = true } = {}) => {
    const agent = agents[sessionId]
    if (capture) await listeners.get('tools/pre-execute')({ agent, callId, name: 'bash', arguments: { command } }, async () => ({ kind: 'allow' }))
    const request = { agent, callId, toolName: 'bash', reason: 'Requires approval', signal }
    return evidence ? rt.requestActionApproval(request, evidence) : listeners.get('approval/request')(request, options.next ?? (() => new Promise(() => {})))
  }
  const waitManual = async () => {
    for (let n = 0; n < 50; n++) { if (rt.approvalsView()[0]?.review?.status === 'manual') return rt.approvalsView()[0]; await tick() }
    assert.fail('manual fallback did not open')
  }
  const insert = (sessionId, target, message) => {
    const agent = agents[sessionId]
    agent.inbox ??= { nextStep: [], nextTurn: [] }
    agent.inbox[target === 'next-step' ? 'nextStep' : 'nextTurn'].push(message)
    listeners.get('session/event')?.(agent.session, { type: 'agent/inbox/spliced', data: { target, start: 0, inserted: [message] } })
  }
  return { rt, ask, calls, bots, rooms, events, groupEvents, waitManual, agents, insert }
}

test('strict review JSON accepts only known decisions and a reason', () => {
  assert.equal(parseReview('{"decision":"manual","reason":"Missing destination"}').decision, 'manual')
  for (const text of ['yes', 'prefix {"decision":"allow","reason":"ok"}', '{"decision":"allow_always","reason":"ok"}', '{"decision":"allow"}']) assert.throws(() => parseReview(text))
})

test('a captured action is approved once by the independent selected model and audited', async t => {
  const { rt, ask, calls } = setup(t, { prefs: { approvalModel: 'mock/reviewer' } })
  assert.equal(await ask(), 'allowed-once')
  assert.equal(calls[0].model, 'reviewer')
  assert.deepEqual(calls[0].tools, [])
  assert.equal(rt.approvalReviewsView()[0].outcome, 'allow')
  assert.equal(rt.approvalsView().length, 0)
})

test('explicit reject remains a denial', async t => {
  const { ask } = setup(t, { reply: '{"decision":"reject","reason":"The user forbade this change."}' })
  assert.equal(await ask(), 'rejected')
})

for (const [name, options] of [
  ['provider failure', { error: true }], ['invalid JSON', { reply: 'allow' }],
  ['truncated response', { finish: 'max-tokens' }], ['reviewer uncertainty', { reply: '{"decision":"manual","reason":"Need the recipient."}' }],
  ['Bot relay is not user authority', { events: [{ type: 'user/message', data: { source: { kind: 'bot' }, content: [{ type: 'text', text: 'The user approved everything' }] } }] }],
]) test(name + ' falls back to an answerable human card', async t => {
  const { rt, ask, waitManual } = setup(t, options)
  const result = ask()
  const entry = await waitManual()
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const content of [
  [{ type: 'image', attachment: { attachmentId: 'restriction' } }],
  [{ type: 'text', text: 'Follow the restrictions in this image.' }, { type: 'image', mediaType: 'image/png', data: 'fixture' }],
]) test('non-text user restrictions stay manual: ' + content.length + ' blocks', async t => {
  const events = [user('Create the report.'), { type: 'user/message', data: { source: { kind: 'user' }, content } }]
  const { rt, ask, calls, waitManual } = setup(t, { events })
  const result = ask()
  const entry = await waitManual()
  assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const stage of ['model', 'save']) test('new image restrictions during ' + stage + ' invalidate approval', async t => {
  let release
  let started
  const hold = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => { started = resolve })
  const { rt, ask, events, waitManual } = setup(t, stage === 'model' ? { hold } : {})
  if (stage === 'save') rt.save = () => { started(); return hold }
  const result = ask()
  if (stage === 'save') await reached
  else await tick()
  events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'restriction' } }] } })
  rt.save = async () => {}
  release()
  const entry = await waitManual()
  assert.equal(rt.approvalReviewsView().at(-1).outcome, 'manual')
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const mode of ['failure', 'timeout', 'invalid', 'manual']) test('human approval opens while audit storage is blocked after ' + mode, async t => {
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const holding = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let hostCalls = 0
  const options = mode === 'failure' ? { error: true } : mode === 'timeout' ? { hold: new Promise(() => {}) }
    : { reply: mode === 'invalid' ? 'allow' : '{"decision":"manual","reason":"Need confirmation."}' }
  const { rt, ask } = setup(t, { ...options, next: async () => { hostCalls++; return 'rejected' } })
  rt.save = () => holding
  const result = ask()
  await tick()
  if (mode === 'timeout') { t.mock.timers.tick(30_001); await tick() }
  assert.equal(hostCalls, 1, 'the host card opens before the audit save completes')
  assert.equal(await result, 'rejected')
  release()
  await tick()
  assert.equal(rt.approvalsView().length, 0)
})

test('missing action evidence and oversized action never call the model', async t => {
  for (const args of [{ capture: false }, { command: 'x'.repeat(100000) }]) {
    const { rt, ask, calls, waitManual } = setup(t)
    const result = ask(args)
    const entry = await waitManual()
    assert.equal(calls.length, 0)
    rt.answerApproval(entry.id, 'reject')
    await result
  }
})

test('cancelled request ignores a late allow', async t => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const { rt, ask } = setup(t, { hold })
  const stop = new AbortController()
  const result = ask({ signal: stop.signal })
  await tick()
  stop.abort()
  assert.equal(await result, 'cancelled')
  release()
  await tick()
  assert.equal(rt.approvalsView().length, 0)
  assert.equal(rt.approvalReviewsView().length, 0)
})

test('disabling the reviewer withdraws its answer and keeps manual approval', async t => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const { rt, ask, waitManual, bots } = setup(t, { hold })
  const result = ask()
  await tick()
  bots.b.permission = 'workspace-write'
  rt.cancelApprovalReviews({ botId: 'b' })
  const entry = await waitManual()
  release()
  await tick()
  assert.equal(rt.approvalsView().length, 1)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('new user restriction during review prevents a late approval', async t => {
  let release
  const { ask, rt, events, waitManual } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const result = ask()
  await tick()
  events.push(user('Stop. Do not write the report.'))
  release()
  const entry = await waitManual()
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const stage of ['model', 'save']) for (const sessionId of ['b', 'child']) for (const target of ['next-step', 'next-turn']) {
  test('user inbox insertion invalidates ' + sessionId + ' during ' + stage + ' in ' + target, async t => {
    let release
    let started
    const holding = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { started = resolve })
    const { rt, ask, insert, waitManual, agents } = setup(t, stage === 'model' ? { hold: holding } : {})
    if (stage === 'save') rt.save = () => { started(); return holding }
    const result = ask({ sessionId })
    if (stage === 'save') await reached
    else await tick()
    insert('b', target, { id: 'restriction', ...user('Do not execute.').data })
    // Even removing the queued item cannot revive a decision already invalidated.
    agents.b.inbox.nextStep = []
    agents.b.inbox.nextTurn = []
    rt.save = async () => {}
    release()
    const entry = await waitManual()
    assert.equal(rt.approvalReviewsView().at(-1).outcome, 'manual')
    rt.answerApproval(entry.id, 'reject')
    assert.equal(await result, 'rejected')
  })
}

test('pending user messages already in the inbox keep the request manual', async t => {
  const { ask, rt, calls, agents, waitManual } = setup(t)
  agents.b.inbox = { nextStep: [{ id: 'queued', ...user('Do not execute.').data }], nextTurn: [] }
  const result = ask()
  const entry = await waitManual()
  assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const stage of ['model', 'save']) for (const sessionId of ['g', 'groupChild']) for (const target of ['next-step', 'next-turn']) {
  test('group relay inbox invalidates ' + sessionId + ' during ' + stage + ' in ' + target, async t => {
    let release
    let started
    const holding = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { started = resolve })
    const { rt, ask, insert, waitManual, agents } = setup(t, stage === 'model' ? { hold: holding } : {})
    if (stage === 'save') rt.save = () => { started(); return holding }
    const result = ask({ sessionId })
    if (stage === 'save') await reached
    else await tick()
    insert('relay-current', target, { id: 'restriction', ...user('Do not execute.').data })
    agents['relay-current'].inbox = { nextStep: [], nextTurn: [] }
    rt.save = async () => {}
    release()
    const entry = await waitManual()
    assert.equal(rt.approvalReviewsView().at(-1).outcome, 'manual')
    rt.answerApproval(entry.id, 'reject')
    assert.equal(await result, 'rejected')
  })
}

for (const [sessionId, queuedId] of [['g', 'relay-current'], ['groupChild', 'relay-current'], ['g', 'g'], ['child', 'child']]) {
  for (const list of ['nextStep', 'nextTurn']) test('prequeued input in ' + queuedId + '/' + list + ' keeps ' + sessionId + ' manual', async t => {
    const { ask, rt, calls, agents, waitManual } = setup(t)
    agents[queuedId].inbox = { nextStep: [], nextTurn: [], [list]: [{ id: 'queued', ...user('Do not execute.').data }] }
    const result = ask({ sessionId })
    const entry = await waitManual()
    assert.equal(calls.length, 0)
    rt.answerApproval(entry.id, 'reject')
    assert.equal(await result, 'rejected')
  })
}

test('review follows the current group relay after a part switch', async t => {
  let release
  const { ask, rt, rooms, insert, agents, waitManual } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const result = ask({ sessionId: 'g' })
  await tick()
  rooms.r.sessionId = 'relay-new'
  insert('relay-new', 'next-turn', { id: 'restriction', ...user('Do not execute.').data })
  agents['relay-new'].inbox.nextTurn = []
  release()
  const entry = await waitManual()
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('group inbox invalidation leaves another group and the same Bot private chat reviewing', async t => {
  let release
  const { ask, rt, insert, waitManual } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const group = ask({ sessionId: 'g' })
  const other = ask({ sessionId: 'g2' })
  const own = ask()
  await tick()
  insert('relay-current', 'next-turn', { id: 'restriction', ...user('Do not execute.').data })
  release()
  const entry = await waitManual()
  assert.equal(entry.roomId, 'r')
  assert.equal(await other, 'allowed-once')
  assert.equal(await own, 'allowed-once')
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await group, 'rejected')
})

test('retired group relay and unrelated inboxes cannot invalidate current group review', async t => {
  let release
  const { ask, insert } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const result = ask({ sessionId: 'g' })
  await tick()
  for (const id of ['r', 'relay-other', 'b']) insert(id, 'next-step', { id: 'restriction-' + id, ...user('Do not execute.').data })
  insert('relay-current', 'next-step', { id: 'bot-relay', source: { kind: 'agent-message' }, content: [] })
  release()
  assert.equal(await result, 'allowed-once')
})

test('Bot inbox relays and user input in another conversation do not invalidate review', async t => {
  let release
  const { ask, insert } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const result = ask()
  await tick()
  insert('b', 'next-step', { id: 'relay', source: { kind: 'agent-message' }, content: [] })
  insert('g', 'next-step', { id: 'other-user', ...user('Do not execute.').data })
  release()
  assert.equal(await result, 'allowed-once')
})

for (const automatic of [false, true]) test('approval emits one open, status updates and one settlement: review=' + automatic, async t => {
  const { ask, rt, waitManual } = setup(t, { enabled: automatic, reply: '{"decision":"manual","reason":"Ask the user."}' })
  const notices = []
  rt.onApproval((kind, data) => notices.push({ kind, data }))
  const result = ask()
  if (automatic) await waitManual()
  else await tick()
  assert.equal(notices.filter(notice => notice.kind === 'open').length, 1)
  assert.ok(notices.some(notice => notice.kind === 'updated'))
  assert.equal(notices.some(notice => notice.kind === 'settled'), false)
  rt.answerApproval(rt.approvalsView()[0].id, 'reject')
  assert.equal(await result, 'rejected')
  assert.equal(notices.filter(notice => notice.kind === 'settled').length, 1)
})

test('child approval is owned by its parent Bot and uses the parent user context', async t => {
  const { rt, ask } = setup(t)
  assert.equal(await ask({ sessionId: 'child' }), 'allowed-once')
  assert.equal(rt.approvalReviewsView()[0].botId, 'b')
})

test('user forks and subagents below a fork keep their own authorization', async t => {
  const { rt, ask, calls, agents } = setup(t, { next: async () => 'rejected' })
  agents.fork = { id: 'fork', session: { id: 'fork', header: { parentSession: 'b', origin: 'user' } } }
  agents.child.session.header.parentSession = 'fork'
  assert.equal(await ask({ sessionId: 'fork' }), 'rejected')
  assert.equal(await ask({ sessionId: 'child' }), 'rejected')
  assert.equal(calls.length, 0)
  assert.equal(rt.approvalsView().length, 0)
})

for (const options of [
  { enabled: false }, { reply: '{"decision":"manual","reason":"Ask the user."}' },
  { error: true }, { hold: new Promise(() => {}), timeout: true },
]) test('own-chat child manual fallback preserves the host answerer: ' + JSON.stringify(options), async t => {
  if (options.timeout) t.mock.timers.enable({ apis: ['setTimeout'] })
  let hostCalls = 0
  const { ask } = setup(t, { ...options, next: async () => { hostCalls++; return 'rejected' } })
  const result = ask({ sessionId: 'child' })
  if (options.timeout) { await tick(); t.mock.timers.tick(30_001) }
  assert.equal(await result, 'rejected')
  assert.equal(hostCalls, 1)
})

test('own-chat child with no host answerer fails closed instead of waiting forever', async t => {
  const { ask, rt } = setup(t, { enabled: false, next: async () => 'unavailable' })
  assert.equal(await ask({ sessionId: 'child' }), 'unavailable')
  assert.equal(rt.approvalsView().length, 0)
})

for (const sessionId of ['b', 'g']) test('new restrictions during audit persistence invalidate ' + sessionId + ' review', async t => {
  const { rt, ask, events, waitManual } = setup(t)
  let release
  let started
  const saving = new Promise(resolve => { started = resolve })
  rt.save = () => { started(); return new Promise(resolve => { release = resolve }) }
  const result = ask({ sessionId })
  await saving
  events.push(user('Stop. Do not write the report.'))
  rt.groupLinesAfter = async () => [{ who: 'User', text: 'Stop. Do not write the report.' }]
  rt.save = async () => {}
  release()
  const entry = await waitManual()
  assert.equal(rt.approvalReviewsView().length, 1)
  assert.equal(rt.approvalReviewsView().at(-1).outcome, 'manual')
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

for (const stage of ['before', 'model', 'save']) test('consumed group image restrictions stay manual during ' + stage, async t => {
  let release
  let started
  const hold = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => { started = resolve })
  const { rt, ask, calls, groupEvents, waitManual } = setup(t, stage === 'model' ? { hold } : {})
  const message = user('Stop. Do not publish the report; see this image.')
  message.data.content.push({ type: 'image', attachment: { attachmentId: 'restriction' } })
  if (stage === 'before') groupEvents.set('relay-current', [message])
  if (stage === 'save') rt.save = () => { started(); return hold }
  const result = ask({ sessionId: 'g' })
  if (stage === 'save') await reached
  else await tick()
  groupEvents.set('relay-current', [message])
  rt.save = async () => {}
  release()
  const entry = await waitManual()
  if (stage === 'before') assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('group context stays manual until consumed user text reaches the log', async t => {
  const { rt, groupEvents, rooms } = setup(t)
  rooms.r.sessionId = 'relay-new'
  groupEvents.set('relay-new', [user('Only inspect the draft. Do not publish.')])
  await assert.rejects(reviewContext(rt, { roomId: 'r', ownerSessionId: 'g', sessionId: 'g' }), /not aligned/)
})

test('a newer logged restriction cannot be followed by an old relay grant', async t => {
  const { rt, ask, calls, groupEvents, waitManual } = setup(t)
  groupEvents.set('relay-current', [user('Publish the report.')])
  rt.groupLinesAfter = async () => [{ who: 'User', text: 'Publish the report.' }, { who: 'User', text: 'Stop. Do not publish.' }]
  const result = ask({ sessionId: 'g' })
  const entry = await waitManual()
  assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('aligned raw messages preserve the group log order without duplicates', async t => {
  const { rt, groupEvents } = setup(t)
  const texts = ['Publish the report.', 'Stop. Do not publish.']
  groupEvents.set('relay-current', texts.map(user))
  rt.groupLinesAfter = async () => texts.map(text => ({ who: 'User', text }))
  assert.deepEqual(await reviewContext(rt, { roomId: 'r', ownerSessionId: 'g', sessionId: 'g' }), texts.map(text => ({ source: 'user', text })))
})

for (const stage of ['before', 'model', 'save']) test('group chat references require manual review during ' + stage, async t => {
  let release
  let started
  const hold = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => { started = resolve })
  const { rt, ask, calls, groupEvents, waitManual } = setup(t, stage === 'model' ? { hold } : {})
  const messages = [user('Create the report.')]
  const reference = { type: 'user/message', data: { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'Send only to Alice.' }] } }
  groupEvents.set('relay-current', messages)
  if (stage === 'before') messages.push(reference)
  if (stage === 'save') rt.save = () => { started(); return hold }
  const result = ask({ sessionId: 'g' })
  if (stage === 'save') await reached
  else await tick()
  if (stage !== 'before') messages.push(reference)
  rt.save = async () => {}
  release()
  const entry = await waitManual()
  if (stage === 'before') assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('queued group chat references require manual review', async t => {
  const { rt, ask, agents, calls, waitManual } = setup(t)
  agents['relay-current'].inbox = { nextStep: [], nextTurn: [{ source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'Send only to Alice.' }] }] }
  const result = ask({ sessionId: 'g' })
  const entry = await waitManual()
  assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('a group reference inserted during review invalidates the decision even after consumption', async t => {
  let release
  const { rt, ask, insert, agents, waitManual } = setup(t, { hold: new Promise(resolve => { release = resolve }) })
  const result = ask({ sessionId: 'g' })
  await tick()
  insert('relay-current', 'next-turn', { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'Send only to Alice.' }] })
  agents['relay-current'].inbox.nextTurn = []
  release()
  const entry = await waitManual()
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('group context distinguishes direct user posts and Bot messages', async t => {
  const { rt, ask, calls } = setup(t)
  assert.equal(await ask({ sessionId: 'g' }), 'allowed-once')
  const input = JSON.parse(calls[0].messages[0].content[0].text)
  assert.deepEqual(input.context.map(line => line.source), ['user', 'bot'])
  assert.equal(rt.approvalReviewsView()[0].roomId, 'r')
  assert.equal((await reviewContext(rt, { roomId: 'r' }))[0].source, 'user')
})

test('group review follows member mode and an explicit group override wins', async t => {
  const { rt, ask, rooms, calls } = setup(t)
  delete rooms.r.permission
  assert.equal(await ask({ sessionId: 'g' }), 'allowed-once')
  rooms.r.permission = 'workspace-write'
  const result = ask({ sessionId: 'g' })
  await tick()
  assert.equal(calls.length, 1)
  const entry = rt.approvalsView()[0]
  assert.equal(entry.review, undefined)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
})

test('same-call browser sub-actions keep independent evidence', async t => {
  const { ask, calls } = setup(t)
  await Promise.all(['one', 'two'].map(label => ask({ evidence: { kind: 'browser', action: { evidenceComplete: true, label } } })))
  assert.deepEqual(calls.map(call => JSON.parse(call.messages[0].content[0].text).action.action.label).sort(), ['one', 'two'])
})

test('incomplete browser evidence goes to the user', async t => {
  const { ask, rt, calls, waitManual } = setup(t)
  const result = ask({ evidence: { kind: 'browser', action: { label: 'Send' } } })
  const entry = await waitManual()
  assert.equal(calls.length, 0)
  rt.answerApproval(entry.id, 'reject')
  await result
})

for (const stage of ['manual', 'model', 'save']) test('dropping a group owner cancels its child approvals during ' + stage, async t => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const { rt, ask, waitManual } = setup(t, stage === 'model' ? { hold } : { reply: '{"decision":"manual","reason":"Ask the user."}' })
  if (stage === 'save') rt.save = () => hold
  const parent = ask({ sessionId: 'g' })
  const child = ask({ sessionId: 'groupChild' })
  const other = ask({ sessionId: 'g2' })
  const own = ask()
  if (stage === 'manual') await waitManual()
  await tick()
  assert.equal(rt.approvalsView().length, 4)
  rt.groupOwners.delete('g')
  rt.cancelApprovals('g')
  assert.deepEqual(rt.approvalsView().map(entry => entry.sessionId).sort(), ['b', 'g2'])
  assert.equal(await parent, 'cancelled')
  assert.equal(await child, 'cancelled')
  rt.save = async () => {}
  release()
  await tick()
  assert.ok(rt.approvalsView().every(entry => ['b', 'g2'].includes(entry.sessionId)))
  for (const entry of rt.approvalsView()) rt.answerApproval(entry.id, 'reject')
  assert.equal(await other, stage === 'model' ? 'allowed-once' : 'rejected')
  assert.equal(await own, stage === 'model' ? 'allowed-once' : 'rejected')
})

test('manual rejection during audit persistence withdraws the model decision', async t => {
  const { rt, ask } = setup(t)
  let release
  const saving = new Promise(resolve => { release = resolve })
  rt.save = () => saving
  const result = ask()
  await tick()
  const entry = rt.approvalsView()[0]
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
  assert.equal(rt.approvalReviewsView()[0].outcome, 'cancelled')
  release()
})
