// A real DSH agent turn through the local-agent adapter: the loop, its tool
// dispatch and its steering deliver to the fake ACP CLI, not stubs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { output } from '../src/host/tools.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import { install as installParts } from '../src/host/parts.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const TEAM = ['message_bot', 'approve_agent_action']

function makeAdapter(ctx, records = {}) {
  return new LocalAgentAdapter({
    rt: { warn: () => {}, ctx },
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

async function boot({ approval, attachmentsHome } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (attachmentsHome !== undefined) ctx.plugin(LocalAttachmentStore, { dshHome: attachmentsHome })
  const adapter = makeAdapter(ctx)
  ctx.llm.registerAdapter(['local-acp-fake'], adapter)
  if (approval !== undefined) ctx.provide('approval', approval)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'local-acp-fake', model: 'default' })
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

test('a stored Bot on a taken local route fails without calling the owning adapter (#1390)', async (t) => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  t.after(() => ctx.fiber.dispose())
  let calls = 0
  const other = new LlmAdapter()
  other.stream = async function* () {
    calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.llm.registerAdapter(['local-acp-taken'], other)
  const bot = { id: 's1', model: 'local-acp-taken/default' }
  const rt = {
    ctx, state: { bots: { s1: bot } }, teamTools: [], warn() {},
    selfOf: id => id, botOf: id => id === bot.id ? bot : undefined,
    config: {}, load: async () => {}, readOnly: () => undefined,
    pastOwners: new Map(), chatOwners: new Map(), groupOwners: new Map(), roomOwners: new Map(),
    isBotSession: () => false, ownRequest: () => true,
  }
  installLocalAgents(rt)
  installParts(rt)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'local-acp-taken', model: 'default' })
  send(agent, 'Do not send my input to another adapter')
  await waitForIdle(ctx, agent)
  const reason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
  assert.equal(calls, 0)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.error.code, 'LOCAL_AGENT_MISSING')
  assert.match(reason.error.message, /local agent.*unavailable/i)
  const external = await ctx.agentLoop.create(SessionId('external'), { provider: 'local-acp-taken', model: 'default' })
  send(external, 'An unrelated Session can still use its adapter')
  await waitForIdle(ctx, external)
  assert.equal(calls, 1)
  assert.equal(external.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})

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

test('user image saved in LocalAttachmentStore reaches the local agent through the real loop', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-att-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { ctx, agent, adapter } = await boot({ attachmentsHome: home })
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  const ref = await ctx.get('attachments').saveImage({ mediaType: 'image/png', data: png, name: 'image.png' })
  const stored = await ctx.get('attachments').readImage(ref)
  const expectedBase64 = Buffer.from(stored.data).toString('base64')

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'inspect attached image' }, { type: 'image', attachment: ref }],
    source: { kind: 'user' },
  }))
  await waitForIdle(ctx, agent)
  assert.match(texts(agent), new RegExp(`"mimeType":"${stored.ref.mediaType}","data":"${expectedBase64}"`))
})

// An ordinary DSH Session (no Bot) on a custom local-agent route: install()
// alone must serve the CLI's permission prompt, as it does for a Bot (#2466).
async function bootWithoutBot(t, { approval, preset, spec, catalogDefault } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  t.after(() => ctx.fiber.dispose())
  if (approval !== undefined) ctx.provide('approval', approval)
  if (preset !== undefined) {
    ctx.provide('permissionPresets', {
      current: () => preset,
      resolve: name => {
        if (spec instanceof Error) throw spec
        return spec ?? { sandbox: name, approval: name === 'danger-full-access' ? 'never' : 'ask' }
      },
      catalog: () => ({ options: [], defaultPreset: 'workspace-write' }),
    })
  }
  const rt = {
    ctx, state: { bots: {}, localAgents: { custom: [{ id: 'fake', name: 'Fake ACP', command: process.execPath, args: [FIXTURE] }], profiles: [], sessions: {} } },
    teamTools: [], warn() {}, save: async () => {},
    selfOf: () => undefined, botOf: () => undefined, roomOf: () => undefined,
    config: {}, load: async () => {}, readOnly: () => undefined,
    pastOwners: new Map(), chatOwners: new Map(), groupOwners: new Map(), roomOwners: new Map(), taskOwners: new Map(),
    isBotSession: () => false, ownRequest: () => true,
    ...(catalogDefault !== undefined ? { permissionCatalog: () => ({ defaultPreset: catalogDefault }) } : {}),
  }
  installLocalAgents(rt, { probeSignIn: async () => ({ signedIn: true }), probeVersion: async () => '1.0.0' })
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('plain'), { provider: 'local-acp-fake', model: 'default' })
  return { ctx, agent }
}

test('a Session with no Bot on a local route asks for the CLI permission prompt (#2466)', async (t) => {
  const requests = []
  const { ctx, agent } = await bootWithoutBot(t, {
    preset: 'workspace-write',
    approval: { request: (req) => { requests.push(req); return Promise.resolve('allowed-once') } },
  })
  send(agent, 'ask-permission')
  await waitForIdle(ctx, agent)
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  assert.equal(result?.data.error?.code, undefined, result?.data.message.content[0]?.text)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'approve_agent_action')
  assert.match(texts(agent), /allowed via allow-once/)
})

test('a Session with no Bot on a local route follows its own full-access preset (#2466)', async (t) => {
  const requests = []
  const { ctx, agent } = await bootWithoutBot(t, {
    preset: 'danger-full-access',
    approval: { request: (req) => { requests.push(req); return Promise.resolve('denied') } },
  })
  send(agent, 'ask-permission')
  await waitForIdle(ctx, agent)
  assert.equal(requests.length, 0)
  assert.match(texts(agent), /allowed via allow-once/)
})

test('a Session with no Bot on Auto review still asks for the CLI permission prompt (#2466)', async (t) => {
  const requests = []
  const { ctx, agent } = await bootWithoutBot(t, {
    preset: 'auto',
    spec: { sandbox: 'danger-full-access', approval: 'ask' },
    approval: { request: (req) => { requests.push(req); return Promise.resolve('allowed-once') } },
  })
  send(agent, 'ask-permission')
  await waitForIdle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.match(texts(agent), /allowed via allow-once/)
})

test('a Session with no Bot follows the sandbox its preset writes through (#2466)', async (t) => {
  const requests = []
  const { ctx, agent } = await bootWithoutBot(t, {
    preset: 'workspace-write',
    spec: { sandbox: 'danger-full-access', approval: 'never' },
    approval: { request: (req) => { requests.push(req); return Promise.resolve('denied') } },
  })
  send(agent, 'ask-permission')
  await waitForIdle(ctx, agent)
  assert.equal(requests.length, 0)
  assert.match(texts(agent), /allowed via allow-once/)
})

test('a local agent refuses to review its own pending action instead of stalling (#2466)', async () => {
  const adapter = makeAdapter(new Context())
  const stream = adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's-review', purpose: 'auto-review', messages: [] })
  await assert.rejects(stream.next(), /cannot review its own actions/)
})

for (const [name, options] of [
  ['an unresolvable preset', { preset: 'custom', spec: new Error('custom knobs resolve to no preset') }],
  ['no preset service', {}],
]) {
  test(`a Session with no Bot and ${name} runs read-only, not on the profile default (#2466)`, async (t) => {
    const requests = []
    const { ctx, agent } = await bootWithoutBot(t, {
      ...options,
      catalogDefault: 'danger-full-access',
      approval: { request: (req) => { requests.push(req); return Promise.resolve('allowed-once') } },
    })
    send(agent, 'ask-permission')
    await waitForIdle(ctx, agent)
    assert.equal(requests.length, 0)
    assert.doesNotMatch(texts(agent), /allowed via allow-once/)
  })
}
