import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { HANDOFF_ACK, SOURCE_KIND } from '../src/host/constants.js'
import { ownChatSessions, pushThreadPart, threadCurrentOfPart } from '../src/host/threads.js'
import { fakeContext } from './fake-ctx.js'

const waitFor = async (check, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

const makeTeam = (over = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
    b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
    ...over.bots,
  },
  rooms: over.rooms ?? {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  works: over.works ?? {},
  questions: {},
  views: {},
  prefs: {},
  revision: 0,
})

async function startEnv({ team = makeTeam(), forkImpl, jobsList = () => [], approvalOutcome = 'allowed-once', services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const approvalRequests = []
  const presetApplies = []
  const ctx = fakeContext({
    services: {
      jobs: {
        list: jobsList,
        kill: (jobId, owner, reason) => killedJobs.push({ jobId, owner, reason }),
      },
      sandboxPolicy: {
        resolve: () => ({ mode: 'workspace-write' }),
      },
      approval: {
        request: async (req) => {
          approvalRequests.push(req)
          return typeof approvalOutcome === 'function' ? approvalOutcome(req) : approvalOutcome
        },
      },
      permissionPresets: {
        catalog: () => ({ defaultPreset: 'workspace-write', options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'full-access' }] }),
        resolve: (name) => ({ value: name }),
        set: (session, preset) => { presetApplies.push({ sessionId: session.id, preset }) },
      },
      ...services,
    },
  })
  const killedJobs = []
  const agentMap = new Map()
  const deliveries = []
  const createdSessions = []
  const forkedCalls = []
  const archivedSessions = []
  let seqId = 0

  const makeAgent = (id, cwd = workDir) => {
    const events = []
    const followups = []
    const steers = []
    const cancelled = []
    const session = {
      id,
      header: { cwd },
      events,
      requestHeader: () => undefined,
      snapshotEvents: () => [...events],
    }
    const agent = {
      id,
      session,
      status: 'idle',
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
        on: () => () => {},
        effect: fn => fn?.(),
      },
      inbox: { nextStep: [], nextTurn: [], prepend() {}, append() {}, remove() { return false } },
      followup: (msg) => {
        followups.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      steer: (msg) => {
        steers.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      inject: (msg) => { followups.push(msg) },
      cancel: (cause) => cancelled.push(cause),
      followups,
      steers,
      cancelled,
    }
    agentMap.set(id, agent)
    return agent
  }

  for (const bot of Object.values(team.bots)) makeAgent(bot.sessionId ?? bot.id)

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: workDir }),
      list: () => [{ id: 'w1', path: workDir }],
      resolveByPath: async () => undefined,
      create: async p => ({ id: 'w1', path: p }),
      archiveSession: async (sid, opts) => { archivedSessions.push({ sid, opts }) },
    },
    sessionController: {
      create: async ({ title, cwd }) => {
        const sessionId = `ses-${++seqId}`
        createdSessions.push({ sessionId, title, cwd })
        makeAgent(sessionId, cwd)
        return { sessionId }
      },
      fork: async (opts) => {
        forkedCalls.push(opts)
        if (forkImpl !== undefined) return forkImpl(opts, () => {
          const sessionId = `fork-${++seqId}`
          makeAgent(sessionId)
          return sessionId
        })
        const sessionId = `fork-${++seqId}`
        makeAgent(sessionId)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => ({ agent: agentMap.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      inspect: async (sessionId) => ({ events: agentMap.get(sessionId)?.session.snapshotEvents() ?? [] }),
      page: async (sessionId) => ({ records: agentMap.get(sessionId)?.session.snapshotEvents() ?? [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  let apiRoute
  ctx.connection.fetch.register = (route) => { apiRoute = route; return () => {} }
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })

  const rt = createRuntime(ctx, { home })
  await rt.load()
  const origDeliver = rt.deliver
  rt.deliver = async (opts) => {
    deliveries.push(opts)
    return origDeliver(opts)
  }

  const tool = (name) => rt.teamTools.find(t => t.name === name)
  const callApi = async (endpoint, payload) => {
    const res = await apiRoute.fetch({ json: async () => ({ endpoint, payload }) })
    return res.json()
  }
  const emit = async (sessionId, type, data = {}) => {
    const agent = agentMap.get(sessionId) ?? makeAgent(sessionId)
    const event = { type, seq: agent.session.events.length + 1, data }
    agent.session.events.push(event)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener(agent.session, event)
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, workDir, ctx, rt, agentMap, deliveries, createdSessions, forkedCalls, archivedSessions, killedJobs, approvalRequests, presetApplies, tool, callApi, emit, stop }
}

const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'task_start', signal: AbortSignal.timeout(10_000) })

test('task_start forks foreground chat, delivers via rt.deliver, and settles completed task out of chatOwners', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const events = []
  env.rt.onTaskEvent(ev => events.push(ev))

  const dmA = env.agentMap.get('dm-a')
  const out = await env.tool('task_start').execute({ title: 'Audit logs', brief: 'Inspect recent logs and summarize' }, execOf(dmA))
  assert.match(out, /Started background task "Audit logs" \(k_[0-9a-f]+\) with full chat context/)
  assert.equal(env.forkedCalls.length, 1)
  assert.equal(env.forkedCalls[0].sessionId, 'dm-a')

  const bot = env.rt.botOf('a')
  assert.equal(bot.tasks.length, 1)
  const task = bot.tasks[0]
  assert.equal(task.status, 'running')
  assert.equal(env.rt.taskOwners.get(task.sessionId)?.taskId, task.id)
  assert.equal(env.rt.chatOwners.get(task.sessionId), 'a')
  assert.equal(env.deliveries.length, 1)
  assert.equal(env.deliveries[0].role, 'task')
  assert.equal(env.deliveries[0].sessionId, task.sessionId)

  // Task runs and finishes normally.
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'All logs clean.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  assert.equal(task.status, 'completed')
  assert.equal(env.rt.taskOwners.has(task.sessionId), false, 'settled task must leave taskOwners')
  assert.equal(env.rt.chatOwners.has(task.sessionId), false, 'settled task must leave chatOwners')
  assert.equal(env.rt.pastOwners.get(task.sessionId)?.botId, 'a')
  assert.equal(ownChatSessions(bot).includes(task.sessionId), false, 'settled task must leave ownChatSessions')

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.ok(report !== undefined)
  assert.equal(report.sessionId, 'dm-a')
  assert.match(report.text, /All logs clean\./)
  assert.deepEqual(events.map(e => e.type), ['task.started', 'task.completed'])
})

test('first-turn fork-unavailable falls back to fresh session with recent chat context', async (t) => {
  const env = await startEnv({
    forkImpl: async () => { throw Object.assign(new Error('session has no completed turn to fork from'), { code: 'session/fork-unavailable' }) },
  })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.session.events.push({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Please check repo status' }] } })

  const out = await env.tool('task_start').execute({ title: 'Check repo', brief: 'Run git status' }, execOf(dmA))
  assert.match(out, /in a fresh session with recent summary/)
  assert.equal(env.createdSessions.length, 1)
  assert.match(env.deliveries[0].text, /Please check repo status/)
})

test('turn/end state machine ignores disposed, switched/blocked, HANDOFF_ACK, running jobs, and open outgoing works', async (t) => {
  let activeJobs = []
  const env = await startEnv({ jobsList: (sid) => activeJobs.filter(j => j.owner === sid) })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Long job', brief: 'Do multi-step work' }, execOf(dmA))
  const bot = env.rt.botOf('a')
  const task = bot.tasks[0]
  const sid = task.sessionId

  // 1. Host shutdown (`disposed`) keeps task active for restart reconciliation.
  await env.emit(sid, 'turn/start', { turn: 1 })
  await env.emit(sid, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(task.status, 'running')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)

  // 2. Context rollover (`blocked` / `switched`) must not mark task completed.
  await env.emit(sid, 'turn/start', { turn: 2 })
  env.rt.live.get(sid).switched = true
  await env.emit(sid, 'turn/end', { turn: 2, reason: { kind: 'blocked' } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(task.status, 'running')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)

  // 3. Part switch handoff ack must not trigger a fake report.
  const newSid = 'task-part-2'
  pushThreadPart(bot, sid, newSid, { sessionId: sid, endedAt: Date.now() })
  await env.rt.save()
  await env.emit(newSid, 'turn/start', { turn: 1 })
  await env.emit(newSid, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: HANDOFF_ACK }] } })
  await env.emit(newSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(task.status, 'running')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)

  // 4. Running background shell job keeps task running.
  activeJobs = [{ id: 'j1', owner: newSid, status: 'running' }]
  await env.emit(newSid, 'turn/start', { turn: 2 })
  await env.emit(newSid, 'assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting on build...' }] } })
  await env.emit(newSid, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(task.status, 'running')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)
  activeJobs = []

  // 5. Open outgoing work from this task sets waiting_work and holds completion.
  env.rt.openWork('w-out-1', { from: 'a', to: 'b', fromPart: newSid })
  await env.emit(newSid, 'turn/start', { turn: 3 })
  await env.emit(newSid, 'assistant/message', { turn: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'Asked Helper.' }] } })
  await env.emit(newSid, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'waiting_work')
  assert.equal(task.status, 'waiting_work')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)

  // 6. Once outgoing work closes, the final turn completes and reports once.
  env.rt.closeWork('w-out-1', 'Helper', 'looks good')
  await env.emit(newSid, 'turn/start', { turn: 4 })
  await env.emit(newSid, 'assistant/message', { turn: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'Final verified answer.' }] } })
  await env.emit(newSid, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))
  assert.equal(task.status, 'completed')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 1)
  assert.match(env.deliveries.find(d => d.role === 'task-report').text, /Final verified answer\./)
})

test('nested task_* tools and interactive cards (ask_user/show_view/request_secret) are blocked for tasks, and tasks stay read-only', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Worker', brief: 'Do work' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]
  const taskAgent = env.agentMap.get(task.sessionId)

  for (const name of ['task_start', 'task_send', 'task_stop', 'task_list', 'task_read']) {
    const res = await env.tool(name).execute({ title: 'Sub', brief: 'Nested', task: task.id, text: 'hi' }, execOf(taskAgent))
    assert.match(res, /cannot manage other background tasks/i, `${name} must be refused inside a background task`)
  }
  const askRes = await env.tool('ask_user').execute({ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }, execOf(taskAgent))
  assert.match(askRes, /Background tasks cannot show question cards/)
  const viewRes = await env.tool('show_view').execute({ title: 'V', view: { type: 'text', text: 'hi' } }, execOf(taskAgent))
  assert.match(viewRes, /Background tasks cannot show view cards/)
  const secRes = await env.tool('request_secret').execute({ name: 'MY_API_KEY', purpose: 'call api' }, execOf(taskAgent))
  assert.match(secRes, /Background tasks cannot show secret cards/)

  // Session switching is removed, so tasks can never swap bot.sessionId.
  assert.equal(env.rt.switchPart, undefined)
  const openRes = await env.callApi('bot-open-part', { botId: 'a', sessionId: task.sessionId })
  assert.equal(openRes.ok, false)
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a', 'bot.sessionId must remain unchanged')
  assert.equal(env.rt.botOf('a').tasks[0].id, task.id, 'task metadata must remain intact')

  // Read-only task paging endpoint works without swapping foreground.
  const pageRes = await env.callApi('bot-task-read', { botId: 'a', taskId: task.id })
  assert.equal(pageRes.ok, true)
  assert.equal(pageRes.value.sessionId, task.sessionId)
})

test('long task output persists to report file, is readable via task_read, and cleans up on deleteBot', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmB = env.agentMap.get('dm-b')
  await env.tool('task_start').execute({ title: 'Big report', brief: 'Generate long analysis' }, execOf(dmB))
  const task = env.rt.botOf('b').tasks[0]
  const big = 'LINE-'.repeat(1200) // 6000 chars > REPORT_MAX

  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: big }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const reportDelivery = env.deliveries.find(d => d.role === 'task-report')
  assert.match(reportDelivery.text, /Call task_read\(task: "k_/)
  assert.ok(task.reportFile)
  const reportPath = join(env.home, 'task-reports', task.reportFile)
  assert.equal(existsSync(reportPath), true)

  const readBack = await env.tool('task_read').execute({ task: task.id }, execOf(dmB))
  assert.ok(readBack.includes(big), 'task_read must return the complete untruncated report')

  await env.rt.deleteBot('b')
  assert.equal(existsSync(reportPath), false, 'deleteBot must clean up task report files')
})

test('handoff tree holds parent work until background task settles and wakes foreground with parent work', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  // Helper (b) receives a request W1 from Chief (a).
  env.rt.openWork('w-parent', { from: 'a', to: 'b' })
  env.rt.live.set('dm-b', {
    turn: 1,
    info: { role: 'request', exchangeId: 'w-parent', senderSessionId: 'a' },
  })
  const dmB = env.agentMap.get('dm-b')
  await env.tool('task_start').execute({ title: 'Deep review', brief: 'Review PR thoroughly' }, execOf(dmB))

  // While task runs, parent work waits for it (turns.js will not prematurely answer Chief).
  assert.equal(env.rt.waitsWork('w-parent'), true)

  const task = env.rt.botOf('b').tasks[0]
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PR is solid.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.work, 'w-parent', 'task report must carry parentWork to wake the Bot on the original handoff')
  assert.equal(report.replyTo, task.workId, 'task report must carry replyTo=task.workId so turns.js calls takenWork')
  assert.equal(env.rt.state.works['w-parent'].results.length, 1)
  assert.match(env.rt.state.works['w-parent'].results[0].text, /PR is solid\./)

  // When the foreground turn reads the task-report message, takenWork clears the wait on w-parent.
  await env.emit('dm-b', 'user/message', {
    content: [{ type: 'text', text: report.text }],
    source: { kind: SOURCE_KIND, role: 'task-report', work: report.work, replyTo: report.replyTo, taskId: task.id },
  })
  assert.equal(env.rt.waitsWork('w-parent'), false, 'reading task-report must unblock parent handoff work')
})

test('stopping a parent-linked task wakes foreground with replyTo so parent handoff never deadlocks', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  env.rt.openWork('w-stop-parent', { from: 'a', to: 'b' })
  env.rt.live.set('dm-b', {
    turn: 1,
    texts: [],
    info: { role: 'request', exchangeId: 'w-stop-parent', senderSessionId: 'a' },
  })
  const dmB = env.agentMap.get('dm-b')
  await env.tool('task_start').execute({ title: 'Will be stopped', brief: 'Long work' }, execOf(dmB))
  const task = env.rt.botOf('b').tasks[0]
  assert.equal(env.rt.waitsWork('w-stop-parent'), true)

  const res = await env.callApi('bot-stop-task', { botId: 'b', taskId: task.id })
  assert.equal(res.ok, true)
  assert.equal(task.status, 'stopped')
  const report = env.deliveries.find(d => d.role === 'task-report' && d.taskId === task.id)
  assert.ok(report !== undefined, 'stopping a parent-linked task must still wake foreground')
  assert.equal(report.work, 'w-stop-parent')
  assert.equal(report.replyTo, task.workId)
})

test('background task approval bubbles directly as answerable with taskId/taskTitle and updates task status', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Deploy check', brief: 'Check deploy script' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]
  const taskAgent = env.agentMap.get(task.sessionId)

  let nextCalled = false
  const listeners = env.ctx.listeners.get('approval/request') ?? []
  const pendingApproval = listeners[0]({
    agent: taskAgent,
    toolName: 'bash',
    reason: 'Needs full access',
    callId: 'call-appr',
    signal: AbortSignal.timeout(5000),
  }, () => { nextCalled = true; return 'rejected' })

  assert.equal(nextCalled, false, 'background task approval must be owned by DS Bot, not raced against unseen DSH card')
  const view = env.rt.approvalsView()
  assert.equal(view.length, 1)
  assert.equal(view[0].taskId, task.id)
  assert.equal(view[0].taskTitle, 'Deploy check')
  assert.equal(view[0].answerable, true)
  assert.equal(task.status, 'waiting_approval')

  env.rt.answerApproval(view[0].id, 'allow')
  assert.equal(await pendingApproval, 'allowed-once')
  assert.equal(task.status, 'running')
})

test('background task preserves IM origin in state and delivers taskId without one-shot token', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  env.rt.captureImOrigin = (sid) => (sid === 'dm-a' ? { connId: 'feishu-1', chatKey: 'chat-9', senderId: 'u1', binding: 'bot:a' } : undefined)

  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'IM report', brief: 'Fetch metrics' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]
  assert.deepEqual(task.imOrigin, { connId: 'feishu-1', chatKey: 'chat-9', senderId: 'u1', binding: 'bot:a' })

  // Foreground finishes its initial reply ("Started background task..."), clearing live origins.
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // Task completes later and delivers task-report with taskId so im/index.js resolves persisted task.imOrigin even across deferred redelivery or restart.
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Metrics: 99.9%.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.taskId, task.id)
  assert.equal(report.imOrigin, undefined)
  assert.deepEqual(env.rt.taskById(task.id).task.imOrigin, { connId: 'feishu-1', chatKey: 'chat-9', senderId: 'u1', binding: 'bot:a' })
})

test('reconcileTasksAfterRestart marks orphaned idle tasks interrupted while preserving inflight, inbox-queued, switching, and waiting_work tasks', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Orphaned shell wait', brief: 'Wait for shell' }, execOf(dmA))
  await env.tool('task_start').execute({ title: 'Inflight turn', brief: 'Still running' }, execOf(dmA))
  await env.tool('task_start').execute({ title: 'Queued inbox', brief: 'Waiting in inbox' }, execOf(dmA))
  await env.tool('task_start').execute({ title: 'Switching part', brief: 'Mid rollover' }, execOf(dmA))
  await env.tool('task_start').execute({ title: 'Waiting peer', brief: 'Asked Helper' }, execOf(dmA))
  const [tOrphan, tInflight, tQueued, tSwitching, tWaiting] = env.rt.botOf('a').tasks
  // Simulate that tOrphan and tWaiting already consumed their initial queued delivery
  // (e.g. finished turn 1 waiting on a shell job / peer work before restart).
  for (const t of [tOrphan, tWaiting]) {
    const firstMsg = env.agentMap.get(t.sessionId).followups[0]
    await env.emit(t.sessionId, 'user/message', { source: firstMsg.source, content: firstMsg.content })
  }
  env.agentMap.get(tQueued.sessionId).inbox.nextTurn.push({ id: 'm1', source: { kind: SOURCE_KIND } })
  env.rt.state.switching[tSwitching.sessionId] = { botId: 'a' }
  env.rt.openWork('w-peer', { from: 'a', to: 'b', fromPart: tWaiting.sessionId })

  await env.rt.reconcileTasksAfterRestart(new Set([tInflight.sessionId]))
  assert.equal(tOrphan.status, 'interrupted')
  assert.equal(tInflight.status, 'running')
  assert.equal(tQueued.status, 'running')
  assert.equal(tSwitching.status, 'running')
  assert.equal(tWaiting.status, 'waiting_work')
  const interruptReport = env.deliveries.find(d => d.role === 'task-report' && d.taskId === tOrphan.id)
  assert.ok(interruptReport !== undefined)
  assert.match(interruptReport.text, /restarted/)

  // reconcileEndedTask settles a task whose turn ended during plugin reload using durable log.
  const inflightAgent = env.agentMap.get(tInflight.sessionId)
  const firstMsg = inflightAgent.followups[0]
  await env.emit(tInflight.sessionId, 'user/message', { source: firstMsg.source, content: firstMsg.content })
  inflightAgent.session.events.push(
    { type: 'turn/start', seq: 10, data: { turn: 1 } },
    { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Reload finished work.' }] } } },
  )
  const settled = await env.rt.reconcileEndedTask(tInflight.sessionId, { type: 'turn/end', reason: { kind: 'completed' } })
  assert.equal(settled, true)
  assert.equal(tInflight.status, 'completed')
  assert.ok(env.deliveries.some(d => d.role === 'task-report' && d.taskId === tInflight.id && d.text.includes('Reload finished work.')))
})

test('deliverToTask follows stable taskId across context part switches and stopTask kills jobs cleanly', async (t) => {
  let activeJobs = []
  const env = await startEnv({ jobsList: (sid) => activeJobs.filter(j => j.owner === sid) })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Follow me', brief: 'Watch PR' }, execOf(dmA))
  const bot = env.rt.botOf('a')
  const task = bot.tasks[0]
  const oldSid = task.sessionId

  // Task rolls over to a fresh part; taskId stays the same while sessionId changes.
  pushThreadPart(bot, oldSid, 'rolled-2', { sessionId: oldSid, endedAt: Date.now() })
  await env.rt.save()

  const routed = await env.rt.deliverToTask(task.id, { text: 'CI failed on lint', role: 'task-followup', steer: true })
  assert.equal(routed.sessionId, 'rolled-2', 'deliverToTask must route to the latest sessionId of stable taskId')
  assert.equal(env.deliveries.at(-1).sessionId, 'rolled-2')

  // Stopping via API kills running shell jobs and prevents subsequent turn/end from reporting done.
  activeJobs = [{ id: 'j-stop', owner: 'rolled-2', status: 'running' }]
  const stopRes = await env.callApi('bot-stop-task', { botId: 'a', taskId: task.id })
  assert.equal(stopRes.ok, true)
  assert.equal(task.status, 'stopped')
  assert.equal(env.killedJobs.length, 1)
  assert.equal(env.killedJobs[0].jobId, 'j-stop')

  await env.emit('rolled-2', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)
})

test('background tasks do not pollute activityView/workView or send intermediate mobile notifications', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const notices = []
  env.rt.publishFeed = (kind, data) => { if (kind === 'notice') notices.push(data) }
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Silent worker', brief: 'Work quietly' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]

  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Intermediate thought' }] } })

  assert.equal(env.rt.workView().a, undefined, 'background task turn must not overwrite foreground workView')
  assert.equal(env.rt.activityView().a, undefined, 'background task activity must not overwrite foreground mascot')
  assert.equal(notices.filter(n => n.kind === 'message').length, 0, 'intermediate task messages must not spam mobile notifications')
})

test('task_start workdir validates existence, data folder, private clashes, and runs real approveFolder', async (t) => {
  const extBase = mkdtempSync(join(tmpdir(), 'ds-bot-ext-'))
  const extDir = join(extBase, 'wt-feature')
  const privDir = join(extBase, 'secret-vault')
  mkdirSync(extDir, { recursive: true })
  mkdirSync(privDir, { recursive: true })
  t.after(() => rmSync(extBase, { recursive: true, force: true, maxRetries: 5 }))

  let outcome = 'allowed-once'
  const team = makeTeam({
    bots: {
      p: { id: 'p', name: 'Vault', role: 'Private', sessionId: 'dm-p', workDir: realpathSync(privDir), private: true, createdAt: 3 },
    },
  })
  const env = await startEnv({ team, approvalOutcome: () => outcome })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmP = env.agentMap.get('dm-p')

  // 1. Non-existent directory fails cleanly.
  const bad = await env.tool('task_start').execute({ title: 'Bad dir', brief: 'Check', workdir: join(extBase, 'missing') }, execOf(dmA))
  assert.match(bad, /There is no folder/)

  // 2. DSH data folder is rejected.
  const inDataRes = await env.tool('task_start').execute({ title: 'Data dir', brief: 'Check', workdir: env.home }, execOf(dmA))
  assert.match(inDataRes, /DeepSeek Harness data|data folder/i)

  // 3. Private Bot's folder is rejected for another Bot.
  const clashRes = await env.tool('task_start').execute({ title: 'Clash', brief: 'Check', workdir: privDir }, execOf(dmA))
  assert.match(clashRes, /private Bot/i)

  // 4. Private Bot cannot escape its own folder via workdir.
  const escapeRes = await env.tool('task_start').execute({ title: 'Escape', brief: 'Check', workdir: extDir }, execOf(dmP))
  assert.match(escapeRes, /private Bot.*stay inside/i)

  // 5. External directory triggers real approveFolder with proper { path, sessions, who }; rejected blocks creation.
  outcome = 'rejected'
  const denied = await env.tool('task_start').execute({ title: 'Denied', brief: 'Check', workdir: extDir }, execOf(dmA))
  assert.match(denied, /not allowed/i)
  assert.equal(env.approvalRequests.length, 1)
  assert.match(env.approvalRequests[0].reason, /Chief's background task/)
  assert.equal(env.rt.botOf('a').tasks?.length ?? 0, 0)

  // 6. When approved, task starts in a fresh session bound to realpath(extDir).
  outcome = 'allowed-once'
  const okRes = await env.tool('task_start').execute({ title: 'Approved wt', brief: 'Check worktree', workdir: extDir }, execOf(dmA))
  assert.match(okRes, /Started background task "Approved wt"/)
  const expectedDir = realpathSync.native(extDir)
  assert.equal(env.rt.botOf('a').tasks[0].workDir, expectedDir)
  assert.equal(env.createdSessions.at(-1).cwd, expectedDir)

  // 7. Relative links in task replies resolve against task.workDir, not the foreground folder.
  const wtTask = env.rt.botOf('a').tasks[0]
  await env.emit(wtTask.sessionId, 'turn/start', { turn: 1 })
  await env.emit(wtTask.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'See [Report](report.md).' }] } })
  await env.emit(wtTask.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report' && d.taskId === wtTask.id))
  const wtReport = env.deliveries.find(d => d.role === 'task-report' && d.taskId === wtTask.id)
  assert.ok(wtReport.text.includes(join(expectedDir, 'report.md').replaceAll('\\', '/')), `expected absolute link in ${expectedDir}, got: ${wtReport.text}`)
})

test('partsOfThread, settled task pastOwners routing, post_to_group(report_back), card guards, and setPermission work end-to-end', async (t) => {
  const team = makeTeam({
    rooms: {
      r1: { id: 'r1', name: 'DevGroup', named: true, members: ['a', 'b'], admin: 'a', sessionId: 'room-1', sessions: { a: 'g-a', b: 'g-b' }, log: [], seen: {}, seq: 0, createdAt: 1 },
    },
  })
  const env = await startEnv({ team })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')

  await env.tool('task_start').execute({ title: 'Full checks', brief: 'Verify integration' }, execOf(dmA))
  const botA = env.rt.botOf('a')
  const task = botA.tasks[0]
  const taskAgent = env.agentMap.get(task.sessionId)

  // 1. partsOfThread isolates a task thread cleanly from foreground segments.
  assert.deepEqual(env.rt.partsOfThread('a', task.sessionId).map(p => p.sessionId), [task.sessionId])

  // 2. setPermission propagates to active background task sessions too.
  await env.rt.setPermission(botA, 'read-only')
  assert.ok(env.presetApplies.some(entry => entry.sessionId === task.sessionId && entry.preset === 'read-only'))

  // 3. post_to_group(report_back: true) from a task opens state.works and holds completion until group replies.
  const postRes = await env.tool('post_to_group').execute({ group: 'DevGroup', message: '@Helper please verify', report_back: true }, execOf(taskAgent))
  assert.match(postRes, /Posted in "DevGroup"/)
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting on group.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'waiting_work')
  assert.equal(task.status, 'waiting_work', 'post_to_group(report_back) must keep task waiting_work instead of completing early')

  // 4. Cards and handoffs are refused in background tasks.
  const connRes = await env.tool('request_connector')?.execute({ id: 'mail', purpose: 'check' }, execOf(taskAgent))
  if (connRes !== undefined) assert.match(connRes, /Background tasks cannot show connector cards|already connected|No connector/i)
  const guardResults = env.ctx.guards.map(fn => fn({ agent: taskAgent, name: 'browser_handoff', arguments: {} })).filter(Boolean)
  assert.ok(guardResults.some(msg => /Background tasks cannot hand the browser/.test(msg)))
  const schedResults = env.ctx.guards.map(fn => fn({ agent: taskAgent, name: 'schedule_create', arguments: { target: 'this_session' } })).filter(Boolean)
  assert.ok(schedResults.some(msg => /Background tasks cannot create or change schedules/.test(msg)))

  // 5. Settling task clears threadCurrentOfPart so late messages forward to foreground dm-a, never self-looping into task.sessionId.
  await env.rt.stopTask('a', task.id)
  assert.equal(threadCurrentOfPart(botA, task.sessionId), undefined, 'settled task must not be a live delivery target')
  const preStepListeners = env.ctx.listeners.get('agent/pre-step') ?? []
  const lateMsg = { id: 'late-1', role: 'user', content: [{ type: 'text', text: 'Late reply' }], source: { kind: SOURCE_KIND, exchangeId: 'late-ex-1' } }
  const payload = { agent: taskAgent, step: 1, messages: [lateMsg], signal: AbortSignal.timeout(5000) }
  let idx = 0
  const runNext = async () => {
    const fn = preStepListeners[idx++]
    return fn === undefined ? { kind: 'continue', messages: payload.messages } : fn(payload, runNext)
  }
  await runNext()
  assert.equal(dmA.followups.some(m => m.source?.exchangeId === 'late-ex-1'), true, 'late input to settled task must forward to foreground dm-a')
  assert.equal(taskAgent.followups.some(m => m.source?.exchangeId === 'late-ex-1'), false, 'settled task must never self-forward into itself')
})

test('stopTask cancels approvals, kills jobs, and cancels agent even when rt.save throws', async (t) => {
  let activeJobs = []
  const env = await startEnv({ jobsList: (sid) => activeJobs.filter(j => j.owner === sid) })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Disk full stop', brief: 'Long command' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]
  const taskAgent = env.agentMap.get(task.sessionId)
  activeJobs = [{ id: 'j-disk-full', owner: task.sessionId, status: 'running' }]

  env.rt.save = async () => { throw new Error('ENOSPC: no space left on device') }
  await assert.rejects(env.rt.stopTask('a', task.id), /ENOSPC/)
  assert.equal(env.killedJobs.some(j => j.jobId === 'j-disk-full'), true, 'jobs must still be killed when save fails')
  assert.equal(taskAgent.cancelled.length > 0, true, 'agent must still be cancelled when save fails')
})

test('task_read resolves unloaded cold task sessions and bot-task-read works on read-only hosts', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Medium report', brief: 'Produce medium output' }, execOf(dmA))
  const task = env.rt.botOf('a').tasks[0]
  const mediumText = 'PARAGRAPH-A\n\n'.repeat(40) // >300 chars, <4000 chars (no reportFile)
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: mediumText }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed')

  // Simulate post-restart cold session: removed from in-memory agents map, still resolvable via resolveAgent.
  const coldAgent = env.agentMap.get(task.sessionId)
  env.agentMap.delete(task.sessionId)
  env.ctx.sessionController.resolveAgent = async (sid) => ({ agent: sid === task.sessionId ? coldAgent : env.agentMap.get(sid) })
  const readBack = await env.tool('task_read').execute({ task: task.id }, execOf(dmA))
  assert.ok(readBack.includes(mediumText.trim()), 'cold task_read must recover full output beyond 300-char summary')

  // Read-only host must allow bot-task-read.
  env.rt.readOnly = () => 'Another host holds the team.'
  const roRes = await env.callApi('bot-task-read', { botId: 'a', taskId: task.id })
  assert.equal(roRes.ok, true, 'bot-task-read must be allowed in READS for read-only hosts')
})

test('bot-task-read excludes inherited foreground chat history, renders task-brief/followups/steps, and bot-task-send delivers follow-ups', async (t) => {
  const env = await startEnv({
    forkImpl: async ({ sessionId }, makeForked) => {
      const forkedId = makeForked()
      const src = env.agentMap.get(sessionId)
      const dst = env.agentMap.get(forkedId)
      const copied = src.session.events.map(ev => ({ ...ev }))
      dst.session.events.push(...copied)
      dst.session.inheritedEventCount = copied.length
      dst.session.seq = copied.length
      return { sessionId: forkedId }
    },
  })
  t.after(env.stop)
  // Wire real DSH sessionController.page contract ({ address: { kind: 'session', sessionId } } -> { records: [{ event }], hasMore }).
  env.ctx.sessionController.page = async ({ address, throughSeq, beforeSeq }) => {
    const events = env.agentMap.get(address.sessionId)?.session.snapshotEvents() ?? []
    const filtered = events.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
    return { records: filtered.map(event => ({ event })), hasMore: false }
  }

  const dmA = env.agentMap.get('dm-a')
  // Seed unrelated prior foreground chat turns on dm-a.
  await env.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Prior unrelated foreground chat' }] })
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Foreground greeting reply' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  dmA.session.seq = dmA.session.events.length

  // 1) Forked task_start: taskPage must NOT include prior foreground chat.
  await env.tool('task_start').execute({ title: 'Audit boundaries', brief: 'Inspect isolation boundary' }, execOf(dmA))
  const forkedTask = env.rt.botOf('a').tasks[0]
  assert.ok(forkedTask.startSeq > 0, 'forked task must persist startSeq boundary')
  const forkedAgent = env.agentMap.get(forkedTask.sessionId)
  forkedAgent.session.seq = forkedAgent.session.events.length + 10
  await env.emit(forkedTask.sessionId, 'turn/start', { turn: 2 })
  await env.emit(forkedTask.sessionId, 'tool/call', { callId: 'tc-1', name: 'read_file', arguments: {} })
  await env.emit(forkedTask.sessionId, 'tool/result', { message: { toolCallId: 'tc-1', ok: true, content: [] } })
  await env.emit(forkedTask.sessionId, 'assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Boundary audit clean.' }] } })

  // Send a follow-up via bot-task-send API.
  const sendRes = await env.callApi('bot-task-send', { botId: 'a', taskId: forkedTask.id, text: 'Also check mobile.' })
  assert.equal(sendRes.ok, true)
  forkedAgent.session.seq = forkedAgent.session.events.length + 10

  const pageRes = await env.callApi('bot-task-read', { botId: 'a', taskId: forkedTask.id, steps: true })
  assert.equal(pageRes.ok, true)
  const items = pageRes.value.items
  assert.equal(items.some(it => String(it.text ?? '').includes('Prior unrelated foreground chat')), false, 'must exclude inherited foreground user turns')
  assert.equal(items.some(it => String(it.text ?? '').includes('Foreground greeting reply')), false, 'must exclude inherited foreground bot turns')
  assert.equal(items.some(it => it.kind === 'task-brief' && it.text.includes('Inspect isolation boundary')), true, 'must include cleaned task brief')
  assert.equal(items.some(it => it.kind === 'user' && it.text === 'Also check mobile.'), true, 'must include user follow-up')
  assert.equal(items.some(it => it.kind === 'bot' && it.text === 'Boundary audit clean.'), true, 'must include task reply')
  assert.equal(items.some(it => it.kind === 'steps' && it.tools?.some(tool => tool.name === 'read_file' && tool.ok === true)), true, 'must include steps when requested')

  // 2) fg-handoff: moving a busy foreground turn to background must record startSeq after the prior turn/end
  //    so bot-task-read excludes earlier foreground chat, and pending approvals dynamically resolve taskId/taskTitle.
  await env.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run full release check' }] })
  await env.emit('dm-a', 'turn/start', { turn: 2 })
  dmA.session.seq = dmA.session.events.length + 5
  env.rt.live.set('dm-a', { turn: 2, since: Date.now() - 10_000, toolCount: 1, calls: new Set() })
  await env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [])
  const movedTask = env.rt.botOf('a').tasks.find(item => item.origin === 'fg-handoff')
  assert.ok(movedTask, 'fg-handoff must create a background task')
  assert.ok(movedTask.startSeq > 0, 'fg-handoff must persist startSeq boundary')
  const movedRes = await env.callApi('bot-task-read', { botId: 'a', taskId: movedTask.id })
  assert.equal(movedRes.ok, true)
  const movedItems = movedRes.value.items
  assert.equal(movedItems.some(it => String(it.text ?? '').includes('Prior unrelated foreground chat')), false, 'fg-handoff taskPage must exclude prior foreground turns')
  assert.equal(movedItems.some(it => it.kind === 'user' && it.text === 'Run full release check'), true, 'fg-handoff taskPage must include the moved turn prompt')

  // 3) First-turn fg-handoff (startSeq === 0) + follow-up turn 2 must preserve turn 1 in bot-task-read.
  const dmB = env.agentMap.get('dm-b')
  await env.emit('dm-b', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'First turn prompt' }] })
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  dmB.session.seq = dmB.session.events.length + 10
  Object.assign(env.rt.live.get('dm-b'), { since: Date.now() - 10_000, toolCount: 1 })
  await env.rt.handoffForeground(env.rt.botOf('b'), 'dm-b', [])
  const firstTurnTask = env.rt.botOf('b').tasks[0]
  assert.equal(firstTurnTask.startSeq, 0, 'first-turn fg-handoff must persist startSeq === 0')
  await env.emit('dm-b', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Turn 1 interim reply' }] } })
  // User sends a follow-up starting turn 2 before the task settles (simulated via live turn/end + turn/start).
  await env.callApi('bot-task-send', { botId: 'b', taskId: firstTurnTask.id, text: 'Follow-up for turn 2' })
  await env.emit('dm-b', 'turn/start', { turn: 2 })
  await env.emit('dm-b', 'assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Turn 2 reply' }] } })
  dmB.session.seq = dmB.session.events.length + 10
  const bothTurnsRes = await env.callApi('bot-task-read', { botId: 'b', taskId: firstTurnTask.id })
  assert.equal(bothTurnsRes.ok, true)
  assert.equal(bothTurnsRes.value.items.some(it => it.text === 'First turn prompt'), true, 'turn 1 prompt must be preserved when startSeq === 0')
  assert.equal(bothTurnsRes.value.items.some(it => it.text === 'Turn 1 interim reply'), true, 'turn 1 reply must be preserved')
  assert.equal(bothTurnsRes.value.items.some(it => it.text === 'Follow-up for turn 2'), true, 'turn 2 follow-up must be included')
  assert.equal(bothTurnsRes.value.items.some(it => it.text === 'Turn 2 reply'), true, 'turn 2 reply must be included')

  // 4) bot-task-send rejects cross-Bot taskId and read-only hosts.
  const crossRes = await env.callApi('bot-task-send', { botId: 'a', taskId: firstTurnTask.id, text: 'Wrong bot' })
  assert.equal(crossRes.ok, false)
  env.rt.readOnly = () => 'Another host holds the team.'
  const roSend = await env.callApi('bot-task-send', { botId: 'b', taskId: firstTurnTask.id, text: 'Read-only send' })
  assert.equal(roSend.ok, false)
  assert.equal(roSend.error?.code, 'bot/read-only')
  env.rt.readOnly = () => undefined
})
