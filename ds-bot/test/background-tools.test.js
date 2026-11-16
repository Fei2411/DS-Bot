// Real DSH loop, job registry and tool-jobs: a slow call in a Bot's own chat goes on
// as a background job after the wait, the turn ends, and the result wakes the Session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { install as installBackground } from '../src/host/background.js'

const textOf = message => (message.content ?? []).map(part => part.text ?? (part.type === 'tool-call' ? `<call ${part.name}>` : '')).join('')
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

// The model calls the tool the user names, then says what it got.
class ScriptedModel extends LlmAdapter {
  requests = []
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
  async *stream(req) {
    const messages = (req.messages ?? []).filter(message => message.role !== 'system')
    this.requests.push(messages.map(message => `${message.role}: ${textOf(message)}`))
    const last = messages.at(-1)
    const call = last.role === 'user' ? /^call (\w+)/.exec(textOf(last))?.[1] : undefined
    if (call !== undefined) {
      const block = { type: 'tool-call', id: `c${this.requests.length}`, name: call, arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: call, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `saw: ${textOf(last).slice(0, 200)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function boot(t, { waitSec = 0.2, bot = true, room = false } = {}) {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root)
  const model = new ScriptedModel()
  root.llm.registerAdapter(['mock'], model)
  await root.plugin(LocalJobRegistry)
  await root.plugin(ToolJobs.default ?? ToolJobs)
  const stopped = []
  const slow = (name, ms, value, output = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }) => root.tools.register(defineTool({
    name,
    description: name,
    parameters: {},
    output,
    async execute(_args, exec) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        exec.signal.addEventListener('abort', () => { clearTimeout(timer); stopped.push(name); reject(new Error('stopped')) }, { once: true })
      })
      return value
    },
  }))
  slow('fetch_slow', 600, 'page body 1234')
  slow('fetch_fast', 10, 'quick body')
  slow('report_slow', 600, { rows: 3 }, { schema: { type: 'object', additionalProperties: false, properties: { rows: { type: 'number' } } }, render: (_a, v) => [{ type: 'text', text: `rows=${v.rows}` }] })
  await mountAgentLoopTestHarness(root)
  const id = 'bot-a'
  const rt = {
    ctx: root,
    state: { prefs: { backgroundAfterSec: waitSec } },
    chatOwners: new Map(bot ? [[id, 'a']] : []),
    groupOwners: new Map(room ? [[id, 'r1']] : []),
    isBotSession: sid => bot && sid === id,
    redactText: text => text.replaceAll('1234', '[secret:PIN]'),
  }
  installBackground(rt)
  const agent = await root.agentLoop.create(SessionId(id), { provider: 'mock', model: 'm' })
  rt.shadowTools(agent)
  const statuses = []
  root.on('agent/status', ({ agent: subject, status }) => { if (subject === agent) statuses.push(status) })
  const say = text => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  const turns = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
  const jobRecords = () => agent.session.snapshotEvents().filter(event => event.type?.startsWith('job/')).map(event => event.type)
  // An older DSH (0.2.0) has no definitions() view to shadow from: calls stay in the step.
  const supported = typeof root.tools.definitions === 'function' && typeof rt.shadowTools(agent) !== 'undefined' && agent.ctx.tools.get?.('fetch_slow') !== undefined
  return { root, agent, model, statuses, say, turns, jobRecords, stopped, supported }
}

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await tick(20)
  assert.ok(check(), 'condition not reached')
}

test('a slow call goes to the background after the wait, the turn ends, and its result wakes the Session', async (t) => {
  const { model, statuses, say, turns, jobRecords, supported } = await boot(t)
  if (!supported) return t.skip('this DSH cannot shadow tools per Session')
  say('call fetch_slow')
  await until(() => turns() >= 1)
  // The step came back before the tool did: the first turn ended with the job running.
  assert.match(model.requests[1].at(-1), /^tool: \[Still running after 0s; it goes on as background job tool-/)
  await until(() => turns() >= 2)
  const woken = model.requests.at(-1).at(-1)
  assert.match(woken, /background job tool-\w+ \(tool: fetch_slow \{\}\) finished \[status: completed\]/)
  // The result is redacted before it reaches the model as a message.
  assert.match(woken, /page body \[secret:PIN\]/)
  assert.deepEqual(jobRecords(), ['job/registered', 'job/settled'])
  assert.deepEqual(statuses, ['running', 'idle', 'running', 'idle'])
})

test('a call that ends within the wait comes back in the step and leaves no job or notice behind', async (t) => {
  const { model, say, turns } = await boot(t)
  say('call fetch_fast')
  await until(() => turns() >= 1)
  await tick(300)
  assert.equal(turns(), 1)
  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[1].at(-1), 'tool: quick body')
})

test('a tool with a structured result takes the background note and still renders its own result in time', async (t) => {
  const { model, say, turns, supported } = await boot(t)
  if (!supported) return t.skip('this DSH cannot shadow tools per Session')
  say('call report_slow')
  await until(() => turns() >= 2)
  assert.match(model.requests[1].at(-1), /it goes on as background job tool-/)
  assert.match(model.requests.at(-1).at(-1), /finished \[status: completed\]\. Output:\nrows=3/)
})

test('a group Session and a Session that is no Bot keep the call in the step', async (t) => {
  for (const shape of [{ room: true }, { bot: false }]) {
    const { model, say, turns, jobRecords } = await boot(t, shape)
    say('call fetch_slow')
    await until(() => turns() >= 1)
    assert.equal(model.requests[1].at(-1), 'tool: page body 1234')
    assert.equal(jobRecords().length, 0)
  }
})
