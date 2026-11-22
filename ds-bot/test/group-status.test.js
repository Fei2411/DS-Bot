import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_REPLY_TIMEOUT_MS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'

let rt

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-status-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      // What the Session has not taken up yet; a test empties it when the turn starts.
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex(message => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep, steer: keep, cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  const archived = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async (id, options) => { archived.push([id, options]) } },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const askApproval = (sessionId, extra = {}, next = () => 'from-dsh') => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox', ...extra }, next)
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  await tool('list_bots', {}, 'a')
  return { agentOf, emit, tool, call, askApproval, stop, archived, rt }
}

// Waits on real I/O (state writes) without timers, which some tests mock.
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')

// Starts a round in 'r1' and opens Writer's turn in 'gb'; the round stops with the test.
async function openTurn(t, { agentOf, emit, tool }) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
  await settle(() => agentOf('gb').calls.length === 1)
  const message = agentOf('gb').calls[0]
  agentOf('gb').inbox.nextTurn.length = 0
  emit('gb', 'turn/start', { turn: 1 })
  emit('gb', 'user/message', { content: message.content, source: message.source })
  const read = () => result
  read.stop = () => rt.stopRoomRound('r1')
  return read
}

test('a group Session\'s approval waits in the team view, frees the round, and the late reply reaches the group', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'Copy-Item a.md E:/docs', description: 'Copy the doc' }) })
  const outcome = host.askApproval('gb', { callId: 'k1' })

  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['approval', 'Writer']])

  const { value } = await host.call('state', {})
  assert.equal(value.activity.b, 'alert')
  const [approval] = value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.tool, approval.answerable], ['b', 'r1', 'pwsh', true])
  assert.deepEqual(approval.detail, { text: 'Copy the doc', code: 'Copy-Item a.md E:/docs' })
  assert.equal(value.work.bots.b.roomId, 'r1')
  assert.equal(value.work.bots.b.tool, 'pwsh')

  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).ok, true)
  assert.equal(await outcome, 'allowed-once')
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Writer: Copied the doc to E:/docs.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.late, post.source.senderSessionId], ['post', true, 'b'])
  assert.equal(text(post), '[Group post from Writer]\nCopied the doc to E:/docs.')
})

test('an own chat\'s approval races DSH\'s card and is listed while it waits', async (t) => {
  const host = await start()
  t.after(host.stop)
  let release
  const outcome = host.askApproval('a', {}, () => new Promise((resolve) => { release = resolve }))
  const [approval] = (await host.call('state', {})).value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.answerable], ['a', undefined, true])
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).ok, true)
  assert.equal(await outcome, 'allowed-once')
  // DSH's card answering late is ignored once DS Bot settled the race.
  release('rejected')
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  // Sessions off the team are not DS Bot's to answer.
  assert.equal(await host.askApproval('elsewhere'), 'from-dsh')
})

test('an own chat\'s approval propagates a DSH answerer failure and settles', async (t) => {
  const host = await start()
  t.after(host.stop)
  const settled = []
  host.rt.onApproval((kind, payload) => { if (kind === 'settled') settled.push(payload) })
  const outcome = host.askApproval('a', {}, () => Promise.reject(new Error('dsh card broke')))
  const [approval] = host.rt.approvalsView()
  assert.equal(approval.answerable, true)
  await assert.rejects(outcome, /dsh card broke/)
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  assert.deepEqual(settled.map(entry => [entry.id, entry.outcome]), [[approval.id, 'cancelled']])
})

test('a member still going keeps its turn; one quiet for the whole wait is missed, and a later [PASS] stays out of the group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  // A team tool is quick: it does not let the round go on without the member.
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  await settle(() => true)
  assert.equal(result(), undefined)

  t.mock.timers.tick(1000)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['missed', 'Writer']])

  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

// Real I/O that does not end in a condition the test can see.
const idle = () => new Promise(resolve => setTimeout(resolve, 50))

test('stopping a round stops the member turn it started, and that turn posts nothing', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  result.stop()
  await settle(() => result() !== undefined)
  await settle(() => host.agentOf('gb').cancelled.length === 1)
  assert.equal(host.agentOf('gb').cancelled[0].reason, 'ds-bot/stopped')
  // The turn may end with text before the stop lands.
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Done anyway.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await idle()
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('stopping a round withdraws a member turn that has not started', async (t) => {
  const host = await start()
  t.after(host.stop)
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  rt.stopRoomRound('r1')
  await settle(() => result !== undefined)
  await settle(() => host.agentOf('gb').inbox.nextTurn.length === 0)
  assert.deepEqual(host.agentOf('gb').cancelled, [])
})

test('deleting a group cancels its members\' waiting approvals and stops their Sessions', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  const outcome = host.askApproval('gb')
  assert.equal((await host.call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(await outcome, 'cancelled')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  assert.deepEqual(host.archived.find(([id]) => id === 'gb'), ['gb', { stopActivity: true }])
})

test('a report back names the members still waiting for an approval', async (t) => {
  const host = await start()
  t.after(host.stop)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: 'Copy the doc', report_back: true }, 'a')
  assert.match(posted, /^Posted in "Ops"/)
  const post = host.agentOf('r1').calls[0]
  host.emit('r1', 'user/message', { content: post.content, source: post.source })
  const result = await openTurn(t, host)
  void host.askApproval('gb')
  await settle(() => result() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Nobody replied to your post\./)
  assert.match(report, /Waiting for the user's approval: Writer\./)
})

test('a member that fails after the round moved on shows the failure in the group, and nobody answers it', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  const outcome = host.askApproval('gb')
  await settle(() => result() !== undefined)
  const [approval] = (await host.call('state', {})).value.work.approvals
  await host.call('approval-answer', { id: approval.id, choice: 'allow' })
  await outcome
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.agentOf('r1').calls[0]
  assert.deepEqual([post.source.late, post.source.quiet, post.source.failed], [true, true, { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' }])

  host.emit('r1', 'user/message', { content: post.content, source: post.source })
  const round = await afterRound(rt, 'r1', await host.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  // The failure shows where it happened, before the post that tells the group.
  assert.deepEqual(rt.groupRows('r1', 1).filter(reply => reply.kind === 'failed').map(reply => [reply.kind, reply.name, reply.code, reply.status]), [['failed', 'Writer', 'RATE_LIMIT', 429]])
  assert.deepEqual(round.replies, [])
  assert.deepEqual(round.failed, ['Writer'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const program = (emit, sessionId, callId, code = 'await main()') => emit(sessionId, 'tool/call', { callId, name: 'run_code', arguments: JSON.stringify({ code }) })
const dispatch = (emit, sessionId, parentCallId, n, name, args = {}) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args, isError: false, content: [] })
}

test('a Bot running a PTC program shows the tool the program is in', async (t) => {
  const host = await start()
  t.after(host.stop)
  const now = async () => {
    const { value } = await host.call('state', {})
    return [value.activity.b, value.work.bots.b?.tool]
  }
  host.emit('b', 'turn/start', { turn: 1 })
  program(host.emit, 'b', 'k1')
  assert.deepEqual(await now(), ['working', 'run_code'])
  const messaged = dispatch(host.emit, 'b', 'k1', 1, 'message_bot', { to: 'Chief', message: 'Done?' })
  assert.deepEqual(await now(), ['sending', 'message_bot'])
  const read = dispatch(host.emit, 'b', 'k1', 2, 'read_group_chat', { group: 'Ops' })
  assert.deepEqual(await now(), ['searching', 'read_group_chat'])
  read()
  assert.deepEqual(await now(), ['sending', 'message_bot'])
  messaged()
  assert.deepEqual(await now(), ['working', 'run_code'])
  dispatch(host.emit, 'b', 'k1', 3, 'ask_user', { question: 'Ship it?', options: [{ label: 'Yes' }] })()
  assert.deepEqual(await now(), ['working', 'run_code'])
  host.emit('b', 'tool/result', { callId: 'k1' })
  assert.deepEqual(await now(), ['thinking', undefined])
})

test('an approval asked inside a PTC program shows what that call does', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  program(host.emit, 'gb', 'k1')
  dispatch(host.emit, 'gb', 'k1', 1, 'pwsh', { command: 'Copy-Item a.md E:/docs', description: 'Copy the doc' })
  void host.askApproval('gb', { callId: 'k1:ptc:1' })
  await settle(() => result() !== undefined)
  const { value } = await host.call('state', {})
  const [approval] = value.work.approvals
  assert.deepEqual(approval.detail, { text: 'Copy the doc', code: 'Copy-Item a.md E:/docs' })
  assert.equal(value.work.bots.b.tool, 'pwsh')
})


test('a local CLI member streams live work, keeps the round alive, frees it after the grace and counts its tools', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)

  // A thought without a tool still refreshes the round's reply timeout.
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  host.rt.noteLocalAgentEvent('gb', { type: 'thought', text: 'Inspecting the schema first.' })
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  await settle(() => true)
  assert.equal(result(), undefined)

  // A bridged team call is dispatched by DSH and must not start the CLI work grace.
  host.rt.noteLocalAgentEvent('gb', { type: 'activity', text: '▸ mcp__dsbot__list_bots', team: true })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => true)
  assert.equal(result(), undefined)

  // A read shows up as searching; a later shell action shows as working.
  host.rt.noteLocalAgentEvent('gb', { type: 'activity', text: '▸ Read src/schema.js' })
  let state = (await host.call('state', {})).value
  assert.equal(state.activity.b, 'searching')
  assert.deepEqual([state.work.bots.b.roomId, state.work.bots.b.tool, state.work.bots.b.note], ['r1', 'read', 'Read src/schema.js'])
  assert.deepEqual(state.work.rooms.r1.map(item => [item.botId, item.tool, item.note]), [['b', 'read', 'Read src/schema.js']])

  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(result(), undefined)

  host.rt.noteLocalAgentEvent('gb', { type: 'activity', text: '▸ Run `npm test`' })
  state = (await host.call('state', {})).value
  assert.equal(state.activity.b, 'working')
  assert.deepEqual([state.work.bots.b.tool, state.work.bots.b.note], ['cli', 'Run npm test'])
  assert.equal(host.rt.liveOf('gb').toolCount, 2)

  t.mock.timers.tick(1)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['working', 'Writer']])

  // Suspending or finishing the CLI stream clears its action, while toolCount keeps
  // the work it ran.
  host.rt.noteLocalAgentEvent('gb', { type: 'idle' })
  state = (await host.call('state', {})).value
  assert.equal(state.activity.b, 'thinking')
  assert.equal(state.work.bots.b.tool, undefined)

  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'I checked src/schema.js.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  // A turn that actually ran tools is not retried as a promise with no work.
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.equal(text(host.agentOf('r1').calls[0]), '[Group post from Writer]\nI checked src/schema.js.')
})

test('an unmarked DS Bot MCP call from a local CLI is team work and starts no grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)

  // No team marker: the leading tool name still shows this is DS Bot's own MCP server,
  // which DSH dispatches and counts, so it must not start the CLI work grace.
  host.rt.noteLocalAgentEvent('gb', { type: 'activity', text: '▸ mcp__dsbot__list_bots' })
  assert.equal(host.rt.liveOf('gb').toolCount ?? 0, 0)
  assert.equal(host.rt.liveOf('gb').localDoing, undefined)
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => true)
  assert.equal(result(), undefined)
})

test('a dsbot/ path inside a local CLI command is the CLI\'s own work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)

  // A command that only mentions a local `dsbot/` path is the CLI's own work: it
  // counts, shows what the member does, and starts the grace.
  host.rt.noteLocalAgentEvent('gb', { type: 'activity', text: '▸ ls /home/user/dsbot/work' })
  const state = (await host.call('state', {})).value
  assert.equal(host.rt.liveOf('gb').toolCount, 1)
  assert.deepEqual([state.activity.b, state.work.bots.b.tool, state.work.bots.b.note], ['searching', 'read', 'ls /home/user/dsbot/work'])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['working', 'Writer']])
})

test('recorded Devin ACP team MCP sequence stays team work and starts no grace; non-team MCP counts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)

  const engine = new AcpEngine('local-devin-cli', { name: 'Devin' }, { findExecutable: () => undefined })
  const session = engine.sessionFor('gb')
  session.acpSessionId = 'acp-1'
  session.push = event => host.rt.noteLocalAgentEvent('gb', event)

  // Recorded Devin ACP shape: server identity arrives in _meta['cognition.ai/toolName']
  // before session/request_permission carries cognition.ai/permissionRule.
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp_call_tool:0#1',
      title: 'Calling message_bot from dsbot',
      rawInput: { to: 'River', message: 'ping' },
      _meta: { 'cognition.ai/toolName': 'mcp__dsbot__message_bot', 'cognition.ai/eventType': 'mcp_tool_call' },
    },
  })
  assert.equal(host.rt.liveOf('gb').toolCount ?? 0, 0)
  assert.equal(host.rt.liveOf('gb').localDoing, undefined)
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => true)
  assert.equal(result(), undefined)

  // A non-team MCP server in the same Devin shape still counts as CLI work and starts grace.
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp_call_tool:0#2',
      title: 'Calling message_bot from github',
      rawInput: { to: 'River', message: 'ping' },
      _meta: { 'cognition.ai/toolName': 'mcp__github__message_bot', 'cognition.ai/eventType': 'mcp_tool_call' },
    },
  })
  assert.equal(host.rt.liveOf('gb').toolCount, 1)
  assert.equal(host.rt.liveOf('gb').localDoing?.note, 'Calling message_bot from github')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['working', 'Writer']])
})

test('recorded Cursor ACP anonymous MCP placeholder defers counting until provider arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)

  const engine = new AcpEngine('local-cursor-cli', { name: 'Cursor' }, { findExecutable: () => undefined })
  const session = engine.sessionFor('gb')
  session.acpSessionId = 'acp-1'
  session.push = event => host.rt.noteLocalAgentEvent('gb', event)

  // Recorded Cursor ACP team MCP sequence: placeholder opens empty, then names dsbot.
  const teamCallId = 'call-1\nfc_1_0'
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call', toolCallId: teamCallId, title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} },
  })
  assert.equal(host.rt.liveOf('gb').toolCount ?? 0, 0)
  assert.equal(host.rt.liveOf('gb').localDoing, undefined)
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: teamCallId, title: 'dsbot: message_bot', rawInput: { providerIdentifier: 'dsbot', toolName: 'message_bot', args: { to: 'River', message: 'ping' } } },
  })
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: teamCallId, status: 'in_progress' },
  })
  assert.equal(host.rt.liveOf('gb').toolCount ?? 0, 0)
  assert.equal(host.rt.liveOf('gb').localDoing, undefined)
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => true)
  assert.equal(result(), undefined)

  // Recorded Cursor ACP non-team MCP sequence: placeholder stays uncounted until github arrives.
  const otherCallId = 'call-2\nfc_2_0'
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call', toolCallId: otherCallId, title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} },
  })
  assert.equal(host.rt.liveOf('gb').toolCount ?? 0, 0)
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: otherCallId, title: 'github: message_bot', rawInput: { providerIdentifier: 'github', toolName: 'message_bot', args: { to: 'River', message: 'ping' } } },
  })
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: otherCallId, status: 'in_progress' },
  })
  assert.equal(host.rt.liveOf('gb').toolCount, 1)
  assert.equal(host.rt.liveOf('gb').localDoing?.note, 'github: message_bot')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS + 10)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['working', 'Writer']])
})
