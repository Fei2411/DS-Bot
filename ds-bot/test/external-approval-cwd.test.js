import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install } from '../src/host/local-agents/index.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { reviewApproval } from '../src/host/approval-review.js'
import { install as installApprovals } from '../src/host/approvals.js'

const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url))
const cwd = resolve(fileURLToPath(new URL('.', import.meta.url)))
const otherCwd = resolve(cwd, '..')
const request = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf ./cache' } }
const agent = { session: { id: 's', header: { cwd: '/model-claimed-folder' } } }
const options = { signal: new AbortController().signal }

function setup(t) {
  let adapter
  const evidence = []
  const rt = {
    state: { bots: { b: { model: 'local-claude-code/default' } } },
    ctx: {
      llm: { registerAdapter(routes, value) { adapter = value; return Object.assign(() => {}, { replace() {} }) } },
      effect() {}, get: () => ({}),
    },
    requestActionApproval: async (req, value) => { evidence.push(value); return 'rejected' },
  }
  install(rt)
  t.after(() => { adapter.live.clear(); return adapter.dispose() })
  adapter.deps.presetFor = () => 'workspace-write'
  adapter.deps.reviewFor = () => true
  return { adapter, rt, evidence }
}

async function bridge(adapter, event, sessionId = 's') {
  const live = { sessionId, pending: new Map(), engineSession: { dead: false }, events: [event], state: 'running' }
  live.next = async () => live.events.shift()
  adapter.live.set(sessionId, live)
  let call
  for await (const chunk of adapter.drain(live, options)) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') call = chunk.block
  }
  return { call, live }
}

async function claude(t, directory = cwd) {
  const engine = new ClaudeEngine('local-claude-code', { name: 'Fake Claude', command: process.execPath, args: [fixture('fake-claude.mjs')] }, { findExecutable: value => value })
  t.after(() => engine.close())
  const session = await engine.open('s', { cwd: directory })
  return { engine, session }
}

async function permission(session, id = 'p', value = request) {
  session.onLine(JSON.stringify({ type: 'control_request', request_id: id, request: value }))
  return session.next()
}

test('identical Claude relative commands in different spawn directories produce distinct review evidence', async t => {
  const { adapter, rt, evidence } = setup(t)
  for (const directory of [cwd, otherCwd]) {
    const { session } = await claude(t, directory)
    const event = await permission(session)
    const { call } = await bridge(adapter, event)
    await rt.localAgentTools[0].execute(JSON.parse(call.arguments), { agent, callId: call.id, name: call.name })
  }
  assert.equal(evidence[0].cwd, cwd)
  assert.equal(evidence[1].cwd, otherCwd)
  assert.notDeepEqual(evidence[0], evidence[1])
})

function reviewer() {
  const inputs = []
  return {
    inputs, state: { prefs: { approvalModel: 'mock/reviewer' } }, resolveAgent: async () => agent,
    async *eventsBackwards() { yield { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remove the cache in the project.' }] } } },
    ctx: { llm: {
      resolveModelInfo: async () => ({}),
      async *stream(args) {
        inputs.push(JSON.parse(args.messages[0].content[0].text))
        yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"Requested cleanup."}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } },
  }
}

for (const value of [undefined, '', 'relative/path']) test('external review requires an absolute trusted cwd: ' + value, async () => {
  const rt = reviewer()
  await assert.rejects(reviewApproval(rt, {
    request: { toolName: 'approve_agent_action' }, owner: { sessionId: 's', ownerSessionId: 's' },
    evidence: { kind: 'external-agent', cwd: value, action: { ...request, cwd, evidence: JSON.stringify({ cwd }) } },
    signal: options.signal, onModel() {},
  }), /working directory/)
  assert.equal(rt.inputs.length, 0)
})

test('trusted callback evidence reaches the reviewer and cannot be supplied by tool arguments', async t => {
  const { adapter, rt, evidence } = setup(t)
  const { session } = await claude(t)
  const event = await permission(session)
  const { call, live } = await bridge(adapter, event)
  const forged = { action: 'Harmless read', cwd: otherCwd, evidence: JSON.stringify({ cwd: otherCwd }) }
  const exec = { agent, callId: call.id, name: call.name }
  await rt.localAgentTools[0].execute(forged, exec)
  assert.equal(evidence[0].cwd, cwd)
  assert.equal(evidence[0].action.action, 'Run Bash')
  const review = reviewer()
  assert.equal((await reviewApproval(review, {
    request: { toolName: call.name }, owner: { sessionId: 's', ownerSessionId: 's' }, evidence: evidence[0],
    signal: options.signal, onModel() {},
  })).decision, 'allow')
  assert.equal(review.inputs[0].action.cwd, cwd)

  await rt.localAgentTools[0].execute(forged, { ...exec, callId: 'model-made-call' })
  await rt.localAgentTools[0].execute(forged, { ...exec, agent: { session: { id: 'other' } } })
  live.engineSession.dead = true
  await rt.localAgentTools[0].execute(forged, exec)
  live.engineSession.dead = false
  live.pending.delete(call.id)
  await rt.localAgentTools[0].execute(forged, exec)
  for (const value of evidence.slice(1)) assert.equal(value.cwd, undefined)
})

test('a direct MCP approval call has no trusted runtime permission evidence', async t => {
  const { adapter, rt, evidence } = setup(t)
  adapter.live.set('s', { engineSession: {}, pending: new Map([['dsbot-model', { name: 'approve_agent_action', mcpCallId: 'model' }]]) })
  await rt.localAgentTools[0].execute({ action: 'Run Bash', cwd, evidence: JSON.stringify({ cwd }) }, { agent, name: 'approve_agent_action', callId: 'dsbot-model' })
  assert.equal(evidence[0].cwd, undefined)
})

test('Claude keeps the actual live process directory when open is called again', async t => {
  const { engine, session } = await claude(t)
  assert.equal(await engine.open('s', { cwd: otherCwd }), session)
  const event = await permission(session, 'p', { ...request, input: { ...request.input, cwd: otherCwd } })
  assert.equal(event.cwd, cwd)
  event.reply('deny')
  assert.equal((await permission(session, 'next')).cwd, cwd)
})

test('Claude stops claiming the startup cwd after a possibly directory-changing tool', async t => {
  const { session } = await claude(t)
  const event = await permission(session)
  event.reply('allow')
  assert.equal((await permission(session, 'next')).cwd, undefined)
  session.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fresh', cwd: otherCwd }))
  assert.equal((await permission(session, 'reported')).cwd, otherCwd)
  session.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd somewhere' } }] } }))
  assert.equal((await session.next()).type, 'activity')
  assert.equal((await permission(session, 'after-tool')).cwd, undefined)
})

test('Claude resume needs runtime cwd confirmation before automatic review', async t => {
  const { engine } = await claude(t)
  const session = await engine.open('resumed', { cwd, resumeId: 'previous' })
  assert.equal((await permission(session)).cwd, undefined)
})

test('ACP permission cwd follows host session/new and session/load, not rawInput', async t => {
  const engine = new AcpEngine('local-acp-fake', { name: 'Fake ACP', command: process.execPath, args: [fixture('fake-acp.mjs')] }, { findExecutable: value => value })
  t.after(() => engine.close())
  const session = await engine.open('s', { cwd })
  const ask = async () => {
    const result = engine.onRequest('session/request_permission', {
      sessionId: session.acpSessionId,
      toolCall: { toolCallId: 'call', title: 'Run command', kind: 'execute', rawInput: { command: 'rm -rf ./cache', cwd: '/forged' } },
      options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    })
    const event = await session.next()
    event.reply('deny')
    await result
    return event
  }
  assert.equal((await ask()).cwd, cwd)
  await engine.open('s', { cwd: otherCwd, resumeId: session.acpSessionId })
  assert.equal((await ask()).cwd, otherCwd)
  engine.onNotice('session/update', { sessionId: session.acpSessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'changed', kind: 'execute', status: 'completed' } })
  assert.equal((await session.next()).type, 'activity')
  assert.equal((await ask()).cwd, undefined)
})

test('Codex uses command execution cwd and the host thread cwd for file approvals', async t => {
  const engine = new CodexEngine('local-codex-cli', { name: 'Fake Codex', command: process.execPath, args: [fixture('fake-codex.mjs')] }, { findExecutable: value => value })
  t.after(() => engine.close())
  const thread = await engine.open('s', { cwd })
  const ask = async (method, params = {}) => {
    const result = engine.onRequest(method, { threadId: thread.threadId, command: 'rm -rf ./cache', ...params })
    const event = await thread.next()
    event.reply('decline')
    await result
    return event
  }
  assert.equal((await ask('item/fileChange/requestApproval')).cwd, cwd)
  await engine.open('s', { cwd: otherCwd, resumeId: thread.threadId })
  assert.equal((await ask('item/fileChange/requestApproval')).cwd, otherCwd)
  assert.equal((await ask('item/commandExecution/requestApproval', { cwd })).cwd, cwd)
  assert.equal((await ask('execCommandApproval', { cwd })).cwd, cwd)
  assert.equal((await ask('item/commandExecution/requestApproval', { input: { cwd } })).cwd, undefined)
})

test('missing external cwd opens an answerable manual card without invoking the reviewer', async t => {
  const { rt } = setup(t)
  const listeners = new Map()
  const disposers = []
  const review = reviewer()
  Object.assign(rt, {
    chatOwners: new Map([['s', 'b']]), groupOwners: new Map(),
    botOf: () => ({ permission: 'review' }), roomOf: () => undefined,
    resolveAgent: review.resolveAgent, eventsBackwards: review.eventsBackwards,
    save: async () => {}, warn() {},
  })
  rt.state.prefs = review.state.prefs
  Object.assign(rt.ctx, {
    on: (name, handler) => listeners.set(name, handler),
    effect: fn => disposers.push(fn()),
    get: () => ({ request: req => listeners.get('approval/request')(req, () => new Promise(() => {})) }),
  })
  Object.assign(rt.ctx.llm, review.ctx.llm)
  installApprovals(rt)
  t.after(() => disposers.forEach(dispose => dispose?.()))
  const result = rt.localAgentTools[0].execute({ action: 'Run Bash', cwd, detail: JSON.stringify(request) }, {
    agent, name: 'approve_agent_action', callId: 'model-claimed',
  })
  for (let n = 0; n < 50 && rt.approvalsView()[0]?.review?.status !== 'manual'; n++) await new Promise(resolve => setImmediate(resolve))
  const entry = rt.approvalsView()[0]
  assert.equal(entry?.review?.status, 'manual')
  assert.equal(entry.answerable, true)
  assert.equal(review.inputs.length, 0)
  rt.answerApproval(entry.id, 'reject')
  assert.deepEqual(JSON.parse(await result), { decision: 'deny' })
})
