// A real DSH agent turn through the local-agent adapter: the loop, its tool
// dispatch and its steering deliver to the fake ACP CLI, not stubs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { output } from '../src/host/tools.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const TEAM = ['message_bot', 'approve_agent_action']

function makeAdapter(records = {}) {
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE] }, { findExecutable: path => path }),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: options => (options.tools ?? []).filter(tool => TEAM.includes(tool.name)),
  })
}

async function boot({ approval } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = makeAdapter()
  ctx.llm.registerAdapter(['acp-fake'], adapter)
  if (approval !== undefined) ctx.provide('approval', approval)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'acp-fake', model: 'default' })
  return { ctx, agent, adapter }
}

const send = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

const texts = agent => agent.session.snapshotEvents()
  .filter(event => event.type === 'assistant/message')
  .map(event => (event.data.message.content ?? []).map(block => block.text ?? '').join('')).join('\n')
const eventTypes = agent => agent.session.snapshotEvents().map(event => event.type)

test('a real loop turn streams the CLI answer and ends completed', async (t) => {
  const { ctx, agent, adapter } = await boot()
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })
  // The first turn replays the conversation (system section first); the next
  // message goes out as a delta prompt carrying the new text verbatim.
  send(agent, 'kick off')
  await waitForIdle(ctx, agent)
  send(agent, 'hello there')
  await waitForIdle(ctx, agent)
  assert.match(texts(agent), /ok: hello there/)
  assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})

test('a bridged team tool round-trips through real DSH dispatch', async (t) => {
  const { ctx, agent, adapter } = await boot()
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })
  const calls = []
  ctx.tools.register({
    name: 'message_bot',
    description: 'Message another Bot',
    parameters: { type: 'object', properties: { bot: { type: 'string' }, text: { type: 'string' } } },
    output,
    async execute(args) { calls.push(args); return `delivered to ${args.to ?? args.bot}` },
  })
  send(agent, 'call-tool please')
  await waitForIdle(ctx, agent)
  assert.equal(calls.length, 1)
  assert.match(texts(agent), /tool said: delivered to Chief/)
  const types = eventTypes(agent)
  assert.ok(types.includes('tool/call') && types.includes('tool/result'))
})

test('input during a running turn reaches the CLI as the next prompt', async (t) => {
  const { ctx, agent, adapter } = await boot()
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })
  send(agent, 'first turn')
  send(agent, 'and this too')
  await waitForIdle(ctx, agent)
  const all = texts(agent)
  // Both inputs reached the CLI as prompts in order — never two prompts at once.
  assert.match(all, /ok: and this too/)
  assert.equal((all.match(/ok: /g) ?? []).length, 2)
  for (const event of agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
    assert.equal(event.data.reason.kind, 'completed')
})

test('a permission prompt reaches the approval service and fails closed', async (t) => {
  const requests = []
  const { ctx, agent, adapter } = await boot({
    approval: { request: (req) => { requests.push(req); return Promise.resolve('allowed-once') } },
  })
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })
  ctx.tools.register({
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action',
    parameters: { type: 'object', properties: { action: { type: 'string' }, detail: { type: 'string' } } },
    output,
    async execute(args, exec) {
      const outcome = await ctx.get('approval').request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: args.action })
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })
  send(agent, 'ask-permission')
  await waitForIdle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'approve_agent_action')
  assert.match(texts(agent), /allowed via allow-once/)
})
