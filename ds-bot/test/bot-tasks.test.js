import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Background tasks (#783 decision changed): a Bot's own chat starts a task part that
// is forked from the chat at its latest completed turn; when a turn of the task ends with
// no background job left, its last reply goes back to the chat's current part.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Crew', memberIds: ['m1', 'w1'], sessions: { w1: 'g1' }, createdAt: 3 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const agentOf = (id, events = []) => {
  const sent = []
  return {
    id,
    status: 'idle',
    sent,
    session: { id, snapshotEvents: () => events, requestHeader: () => undefined },
    followup: message => sent.push(['followup', message.content[0].text, message.source]),
    steer: message => sent.push(['steer', message.content[0].text, message.source]),
    cancel: reason => sent.push(['cancel', reason]),
  }
}

async function team(t, { fork = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tasks-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const agents = new Map()
  const forks = []
  const ctx = fakeContext({ services: { agents: { get: id => agents.get(id) } } })
  ctx.sessions = { flush: async () => {}, get: id => agents.get(id)?.session }
  ctx.sessionController = fork ? { fork: async (request) => { forks.push(request); return { sessionId: 't1' } } } : {}
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await call('state')
  agents.set('w2', agentOf('w2', [{ seq: 4, type: 'turn/end' }, { seq: 5, type: 'turn/start' }]))
  rt.resolveAgent = async (id) => {
    if (!agents.has(id)) agents.set(id, agentOf(id))
    return agents.get(id)
  }
  rt.createSession = async () => 'f1'
  rt.applyPermission = async () => {}
  const tool = name => rt.teamTools.find(item => item.name === name)
  const run = (name, args, from = 'w2') => tool(name).execute(args, { agent: { id: from } })
  const turnEnd = (id, events) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id, snapshotEvents: () => events }, { type: 'turn/end', data: {} })
  }
  return { home, rt, call, agents, forks, run, turnEnd }
}

const saved = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('task_start forks the chat at its latest completed turn and briefs the task part', async (t) => {
  const { home, rt, agents, forks, run } = await team(t)
  const said = await run('task_start', { title: 'Draft the report', brief: 'Write the Q3 report from notes.md' })
  assert.match(said, /^Started background task "Draft the report" \(k_[0-9a-f]{6}\)/)
  // No atSeq: DSH cuts at the latest completed turn, also while a turn runs there.
  assert.deepEqual(forks, [{ sessionId: 'w2' }])
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w2')
  assert.equal(writer.openParts.length, 1)
  assert.equal(writer.openParts[0].sessionId, 't1')
  assert.equal(writer.openParts[0].task.title, 'Draft the report')
  assert.equal(writer.openParts[0].task.from, 'w2')
  assert.equal(rt.chatOwners.get('t1'), 'w1')
  const [kind, text, source] = agents.get('t1').sent[0]
  assert.equal(kind, 'followup')
  assert.match(text, /^\[Background task "Draft the report" \(k_[0-9a-f]{6}\) · from your own chat\]\nWrite the Q3 report from notes\.md\n/)
  assert.equal(source.role, 'task')
})

test('a DSH without fork gives the task a fresh part', async (t) => {
  const { home, run } = await team(t, { fork: false })
  await run('task_start', { title: 'Look it up', brief: 'Find the release date' })
  assert.equal(saved(home).bots.w1.openParts[0].sessionId, 'f1')
})

test('a task turn that ends with no job left reports its last reply to the chat', async (t) => {
  const { home, rt, agents, run, turnEnd } = await team(t)
  await run('task_start', { title: 'Draft the report', brief: 'Write it' })
  rt.runningJobs = id => (id === 't1' ? [{ id: 'job1' }] : [])
  turnEnd('t1', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Still building.' }] } } }])
  await tick()
  assert.equal(agents.get('w2').sent.length, 0, 'a job still runs: no report yet')
  rt.runningJobs = () => []
  turnEnd('t1', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The report is in report.md.' }] } } }])
  await tick()
  const [kind, text, source] = agents.get('w2').sent[0]
  assert.equal(kind, 'followup')
  assert.match(text, /^\[Background task "Draft the report" \(k_[0-9a-f]{6}\) finished\]\nThe report is in report\.md\.$/)
  assert.equal(source.role, 'task-report')
  assert.equal(saved(home).bots.w1.openParts[0].task.status, 'done')
  assert.match(await run('task_list', {}), /^k_[0-9a-f]{6} · Draft the report · done · started /)
})

test('task_send passes a follow-up into the task; task_stop stops it and no report follows', async (t) => {
  const { home, agents, run, turnEnd, call } = await team(t)
  await run('task_start', { title: 'Draft the report', brief: 'Write it' })
  agents.get('t1').status = 'running'
  assert.equal(await run('task_send', { task: 'Draft the report', text: 'Use the new numbers' }), 'Passed to task "Draft the report".')
  assert.deepEqual(agents.get('t1').sent.at(-1).slice(0, 2), ['steer', '[Follow-up from your own chat]\nUse the new numbers'])
  const id = saved(home).bots.w1.openParts[0].task.id
  const state = await call('state')
  assert.deepEqual(state.value.bots.find(bot => bot.id === 'w1').openParts[0].task, { id, title: 'Draft the report', status: 'running' })
  assert.equal((await call('bot-stop-task', { botId: 'w1', taskId: id })).ok, true)
  assert.equal(agents.get('t1').sent.at(-1)[0], 'cancel')
  turnEnd('t1', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Partial.' }] } } }])
  await tick()
  assert.equal(agents.get('w2').sent.length, 0)
  assert.equal(saved(home).bots.w1.openParts[0].task.status, 'stopped')
  assert.match(await run('task_send', { task: id, text: 'more' }), /was stopped/)
})

test('a group Session cannot start a task', async (t) => {
  const { run } = await team(t)
  await assert.rejects(run('task_start', { title: 'x', brief: 'y' }, 'g1'), /Only a Bot's own chat/)
})
