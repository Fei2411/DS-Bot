import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { HANDOFF_ACK, SOURCE_KIND, TASK_FORK_MAX_EVENTS } from '../src/host/constants.js'
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

async function startEnv({ team: seededTeam = makeTeam(), existingHome, forkImpl, jobsList = () => [], approvalOutcome = 'allowed-once', services = {}, config = {} } = {}) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  const statePath = join(home, 'state.json')
  if (existingHome === undefined) writeFileSync(statePath, JSON.stringify(seededTeam))
  const team = existingHome === undefined ? seededTeam : JSON.parse(readFileSync(statePath, 'utf8'))
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
    sessions: { flush: async () => true },
  })
  const origGet = ctx.get
  let apiRoute
  ctx.connection.fetch.register = (route) => { apiRoute = route; return () => {} }
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })

  const rt = createRuntime(ctx, { home, ...config })
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

const settledTasks = count => Array.from({ length: count }, (_, n) => ({
  id: `old-task-${n}`, title: `Old task ${n}`, origin: 'user', status: 'completed',
  sessionId: `old-session-${n}`, startedAt: n + 1, updatedAt: n + 2, endedAt: n + 2,
}))

test('pruning after a task stops archives only its oldest retired task’s exclusive parts', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(50)
  team.bots.a.segments = [{ sessionId: 'foreground-history' }]
  team.bots.a.tasks[0].segments = ['exclusive-history', 'foreground-history', 'inherited', 'agent-session', 'dm-b']
    .map(sessionId => ({ sessionId }))
  team.bots.a.tasks[0].inheritedSegments = [{ sessionId: 'inherited' }]
  team.bots.a.tasks[0].reportFile = 'old-task-0.txt'
  team.agents.plain = { id: 'plain', name: 'DSH', sessions: ['agent-session'] }
  const env = await startEnv({ team })
  t.after(env.stop)
  const report = join(env.home, 'task-reports', 'old-task-0.txt')
  mkdirSync(join(env.home, 'task-reports'))
  writeFileSync(report, 'Archived task report')
  env.rt.state.closedCards['old-session-0'] = { taskCard: 'dismissed' }
  env.rt.state.closedCards['foreground-history'] = { sharedCard: 'answered' }
  const archive = env.ctx.workspaceRegistry.archiveSession
  env.ctx.workspaceRegistry.archiveSession = async (id, options) => {
    const onDisk = JSON.parse(readFileSync(env.rt.statePath, 'utf8'))
    assert.ok(onDisk.retiredTasks.some(entry => entry.sessionIds.includes(id)))
    assert.ok(existsSync(report))
    await archive(id, options)
  }
  await env.tool('task_start').execute({ title: 'Current task', brief: 'Check simulated output' }, execOf(env.agentMap.get('dm-a')))
  const task = env.rt.botOf('a').tasks.at(-1)
  assert.equal((await env.callApi('bot-stop-task', { botId: 'a', taskId: task.id })).ok, true)
  assert.equal(env.rt.botOf('a').tasks.length, 50)
  assert.deepEqual(env.archivedSessions.map(item => item.sid), ['old-session-0', 'exclusive-history'])
  assert.equal(env.rt.state.closedCards['old-session-0'], undefined)
  assert.deepEqual(env.rt.state.closedCards['foreground-history'], { sharedCard: 'answered' })
  assert.equal(existsSync(report), false)
})

test('a stopped running task can be pruned after its cancelled turn ends', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(50)
  const env = await startEnv({ team })
  t.after(env.stop)
  await env.tool('task_start').execute({ title: 'Running task', brief: 'Wait for cancellation' }, execOf(env.agentMap.get('dm-a')))
  const tasks = env.rt.botOf('a').tasks
  const task = tasks.pop()
  tasks.unshift(task)
  const agent = env.agentMap.get(task.sessionId)
  agent.status = 'running'
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  const { source, content } = agent.followups[0]
  await env.emit(task.sessionId, 'user/message', { source, content })
  assert.deepEqual(env.rt.unreadOf(task.sessionId), [])
  assert.equal(env.rt.hasPendingRecovery(task.sessionId), true)

  assert.equal((await env.callApi('bot-stop-task', { botId: 'a', taskId: task.id })).ok, true)
  assert.equal(env.rt.isBotSession(task.sessionId), false)
  assert.equal(agent.cancelled.length, 1)
  assert.equal(env.archivedSessions.length, 0)

  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: agent.cancelled[0] } })
  agent.status = 'idle'
  env.ctx.emit('agent/status', { agent, status: 'idle' })
  await waitFor(() => env.archivedSessions.some(({ sid }) => sid === task.sessionId))
  assert.equal(env.rt.hasPendingRecovery(task.sessionId), false)
  assert.equal(env.rt.botOf('a').tasks.length, 50)
  assert.deepEqual(env.archivedSessions.map(({ sid }) => sid), [task.sessionId])
})

test('pruning a task moved from the first Bot chat archives the old Session, not the new chat', async (t) => {
  const team = makeTeam()
  delete team.bots.a.sessionId
  const env = await startEnv({ team })
  t.after(env.stop)
  const bot = env.rt.botOf('a')
  const firstChat = env.rt.chatOf(bot.id)
  assert.equal(firstChat, bot.id)
  const agent = env.agentMap.get(firstChat)
  agent.status = 'running'
  await env.emit(firstChat, 'turn/start', { turn: 1 })
  const newChat = await env.rt.handoffForeground(bot, firstChat)
  const [task] = bot.tasks
  assert.equal(task.sessionId, firstChat)
  assert.notEqual(newChat, firstChat)
  bot.tasks.push(...settledTasks(50))

  assert.equal((await env.callApi('bot-stop-task', { botId: bot.id, taskId: task.id })).ok, true)
  await env.emit(firstChat, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: agent.cancelled[0] } })
  agent.status = 'idle'
  env.ctx.emit('agent/status', { agent, status: 'idle' })
  await waitFor(() => bot.tasks.length === 50 && (env.rt.state.retiredTasks ?? []).length === 0)
  assert.equal(bot.tasks.length, 50)
  assert.equal(env.rt.chatOf(bot.id), newChat)
  assert.deepEqual(env.archivedSessions.map(({ sid }) => sid), [firstChat])
})

test('unfinished work keeps a task readable and the retirement record retries only unfinished parts', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(51)
  team.bots.a.tasks[0].segments = [{ sessionId: 'second-part' }]
  team.bots.a.tasks[0].reportFile = 'old-task-0.txt'
  const env = await startEnv({ team })
  t.after(env.stop)
  const report = join(env.home, 'task-reports', 'old-task-0.txt')
  mkdirSync(join(env.home, 'task-reports'))
  writeFileSync(report, 'Keep the report until both parts are archived')
  env.agentMap.set('old-session-0', { status: 'running' })
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(env.rt.botOf('a').tasks.length, 51)
  const archive = env.ctx.workspaceRegistry.archiveSession
  env.ctx.workspaceRegistry.archiveSession = async (id, options) => {
    if (id === 'second-part') throw new Error('Temporary archive failure')
    await archive(id, options)
  }
  env.agentMap.delete('old-session-0')
  await env.rt.reconcileTasksAfterRestart()
  assert.deepEqual(env.archivedSessions.map(item => item.sid), ['old-session-0'])
  const journal = JSON.parse(readFileSync(env.rt.statePath, 'utf8')).retiredTasks
  assert.deepEqual(journal[0].sessionIds, ['second-part'])
  assert.equal(existsSync(report), true)
  env.ctx.workspaceRegistry.archiveSession = archive
  await env.rt.reconcileTasksAfterRestart()
  assert.deepEqual(env.archivedSessions.map(item => item.sid), ['old-session-0', 'second-part'])
  assert.deepEqual(JSON.parse(readFileSync(env.rt.statePath, 'utf8')).retiredTasks, [])
  assert.equal(existsSync(report), false)
})

test('an idle pruned task Session retries a failed archive without new activity', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(50)
  team.bots.a.tasks[0].reportFile = 'old-task-0.txt'
  const env = await startEnv({ team })
  t.after(env.stop)
  const dir = join(env.home, 'task-reports')
  const report = join(dir, 'old-task-0.txt')
  mkdirSync(dir)
  writeFileSync(report, 'Report for retry')
  const archive = env.ctx.workspaceRegistry.archiveSession
  let attempts = 0
  env.ctx.workspaceRegistry.archiveSession = async (id, options) => {
    assert.equal(id, 'old-session-0')
    if (++attempts === 1) throw new Error('Temporary registry write failure')
    await archive(id, options)
  }

  await env.tool('task_start').execute({ title: 'Another task', brief: 'Trigger pruning' }, execOf(env.agentMap.get('dm-a')))
  const task = env.rt.botOf('a').tasks.at(-1)
  assert.equal((await env.callApi('bot-stop-task', { botId: 'a', taskId: task.id })).ok, true)
  assert.equal(attempts, 1)
  assert.deepEqual(env.archivedSessions, [])
  assert.equal(existsSync(report), true)

  const journal = () => JSON.parse(readFileSync(env.rt.statePath, 'utf8')).retiredTasks
  await waitFor(() => journal().length === 0, 5000)
  assert.deepEqual(journal(), [])
  assert.equal(attempts, 2)
  assert.deepEqual(env.archivedSessions.map(({ sid }) => sid), ['old-session-0'])
  assert.equal(existsSync(report), false)
})

test('a host with an unusable write lock keeps reports and pending archives for a later host', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(52)
  for (const task of team.bots.a.tasks) task.reportFile = `${task.id}.txt`
  const originalWrite = fs.writeFileSync
  const patch = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('state.lock')) throw Object.assign(new Error('Lock unavailable'), { code: 'EACCES' })
    return originalWrite(file, ...args)
  })
  syncBuiltinESMExports()
  let env
  try {
    env = await startEnv({ team })
  } finally {
    patch.mock.restore()
    syncBuiltinESMExports()
  }
  t.after(env.stop)
  const dir = join(env.home, 'task-reports')
  mkdirSync(dir)
  for (const task of team.bots.a.tasks) writeFileSync(join(dir, task.reportFile), 'Task report')
  await env.rt.reconcileTasksAfterRestart()
  const saved = JSON.parse(readFileSync(env.rt.statePath, 'utf8'))
  assert.equal(saved.bots.a.tasks.length, 50)
  assert.deepEqual(saved.retiredTasks, [0, 1].map(n => ({
    botId: 'a', sessionIds: [`old-session-${n}`], reportFile: `old-task-${n}.txt`,
  })))
  assert.deepEqual(env.archivedSessions, [])
  assert.equal(existsSync(join(dir, 'old-task-0.txt')), true)
  assert.equal(existsSync(join(dir, 'old-task-1.txt')), true)

  await env.ctx.dispose()
  const reopened = await startEnv({ existingHome: env.home })
  t.after(reopened.stop)
  await reopened.rt.reconcileTasksAfterRestart()
  assert.deepEqual(reopened.archivedSessions.map(({ sid }) => sid), ['old-session-0', 'old-session-1'])
  assert.deepEqual(JSON.parse(readFileSync(reopened.rt.statePath, 'utf8')).retiredTasks, [])
  assert.equal(existsSync(join(dir, 'old-task-0.txt')), false)
  assert.equal(existsSync(join(dir, 'old-task-1.txt')), false)
  assert.equal(existsSync(join(dir, 'old-task-2.txt')), true)
})

test('active and paused reminders move before the former foreground Session can archive', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(51)
  team.bots.a.tasks[0].origin = 'fg-handoff'
  const reminders = ['active', 'paused'].map(status => ({ id: status, status, target: { kind: 'session', sessionId: 'old-session-0' } }))
  let failPaused = true
  const schedule = {
    catalog: async () => reminders,
    edit: async ({ id, patch }) => {
      if (id === 'paused' && failPaused) throw new Error('Temporary schedule failure')
      reminders.find(item => item.id === id).target = patch.target
    },
  }
  const env = await startEnv({ team, services: { schedule } })
  t.after(env.stop)
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(reminders[0].target.sessionId, 'dm-a')
  assert.equal(reminders[1].target.sessionId, 'old-session-0')
  assert.deepEqual(env.archivedSessions, [])
  failPaused = false
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(reminders[1].target.sessionId, 'dm-a')
  assert.equal(reminders[1].status, 'paused')
  assert.deepEqual(env.archivedSessions.map(item => item.sid), ['old-session-0'])
})

test('an idle retirement retry deletes the old legacy reminder without copying it again', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(50)
  const reminder = { id: 'reminder', kind: 'every', title: 'Check in', prompt: 'Check the status', everySeconds: 3600 }
  const copies = []
  let active = true
  let deletions = 0
  const schedule = {
    list: async ({ sessionId }) => sessionId === 'old-session-0' && active ? [reminder] : [],
    create: async (sessionId, request) => {
      copies.push({ sessionId, request })
      return { id: 'copy' }
    },
    delete: async () => {
      if (++deletions === 1) throw new Error('Temporary deletion failure')
      active = false
      return { deleted: true }
    },
  }
  const env = await startEnv({ team, services: { schedule } })
  t.after(env.stop)
  const archive = env.ctx.workspaceRegistry.archiveSession
  env.ctx.workspaceRegistry.archiveSession = async (id, options) => {
    if (id === 'old-session-0' && active) throw new Error('Session has an active reminder')
    await archive(id, options)
  }
  await env.tool('task_start').execute({ title: 'Another task', brief: 'Trigger pruning' }, execOf(env.agentMap.get('dm-a')))
  const task = env.rt.botOf('a').tasks.at(-1)
  assert.equal((await env.callApi('bot-stop-task', { botId: 'a', taskId: task.id })).ok, true)
  assert.equal(deletions, 1)
  assert.equal(copies.length, 1)
  assert.deepEqual(env.archivedSessions, [])

  await waitFor(() => env.archivedSessions.some(({ sid }) => sid === 'old-session-0'), 5000)
  assert.deepEqual(env.archivedSessions.map(({ sid }) => sid), ['old-session-0'])
  assert.equal(deletions, 2)
  assert.deepEqual(copies, [{
    sessionId: 'dm-a',
    request: { title: reminder.title, prompt: reminder.prompt, every_seconds: reminder.everySeconds },
  }])
})

test('pruning a group task keeps its reminder in the group member chat', async (t) => {
  const team = makeTeam({ rooms: { r: { id: 'r', name: 'Room', members: ['a'], sessions: { a: 'room-a' } } } })
  team.bots.a.tasks = settledTasks(51)
  team.bots.a.tasks[0].roomId = 'r'
  const reminder = { id: 'reminder', status: 'active', target: { kind: 'session', sessionId: 'old-session-0' } }
  const schedule = {
    catalog: async () => [reminder],
    edit: async ({ patch }) => { reminder.target = patch.target },
  }
  const env = await startEnv({ team, services: { schedule } })
  t.after(env.stop)
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(reminder.target.sessionId, 'room-a')
  assert.deepEqual(env.archivedSessions, [{ sid: 'old-session-0', opts: undefined }])
})

test('a task archive whose completion cannot be saved keeps its report and is retryable', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(51)
  team.bots.a.tasks[0].reportFile = 'old-task-0.txt'
  const env = await startEnv({ team })
  t.after(env.stop)
  const report = join(env.home, 'task-reports', 'old-task-0.txt')
  mkdirSync(join(env.home, 'task-reports'))
  writeFileSync(report, 'Keep this when a write fails')
  const save = env.rt.save
  env.rt.save = async (opts) => {
    if (opts?.required && env.rt.state.retiredTasks?.some(entry => entry.sessionIds.length === 0)) throw new Error('Disk write failed')
    await save(opts)
  }
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(existsSync(report), true)
  const disk = JSON.parse(readFileSync(env.rt.statePath, 'utf8'))
  assert.deepEqual(disk.retiredTasks[0].sessionIds, ['old-session-0'])
  const reopened = await startEnv({ team: disk })
  t.after(reopened.stop)
  await reopened.rt.reconcileTasksAfterRestart()
  assert.deepEqual(reopened.archivedSessions.map(item => item.sid), ['old-session-0'])
  assert.deepEqual(JSON.parse(readFileSync(reopened.rt.statePath, 'utf8')).retiredTasks, [])
})

test('the earliest task can finish last and keep its complete report and IM origin until the report is read', async (t) => {
  const team = makeTeam()
  team.bots.a.tasks = settledTasks(51)
  const oldest = team.bots.a.tasks[0]
  oldest.status = 'running'
  oldest.imOrigin = { connId: 'fake-connection', chatKey: 'fake-chat', senderId: 'fake-sender' }
  const env = await startEnv({ team })
  t.after(env.stop)
  const fullText = 'Complete result '.repeat(300)
  const agent = await env.rt.resolveAgent(oldest.sessionId)
  agent.status = 'running'
  await env.emit(oldest.sessionId, 'turn/start', { turn: 1 })
  await env.emit(oldest.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: fullText }] } })
  await env.emit(oldest.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.status = 'idle'
  await waitFor(() => env.rt.hasPendingTaskReport(oldest.id))
  const stored = env.rt.taskById(oldest.id)?.task
  assert.equal(stored.status, 'completed')
  assert.deepEqual(stored.imOrigin, oldest.imOrigin)
  assert.equal(readFileSync(join(env.home, 'task-reports', stored.reportFile), 'utf8'), fullText.trim())
  assert.equal(env.archivedSessions.length, 0)
  const report = env.agentMap.get('dm-a').followups.find(message => message.source?.taskId === oldest.id)
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { source: report.source, message: report })
  await env.rt.reconcileTasksAfterRestart()
  assert.ok(env.rt.taskById(oldest.id), 'the report is still being processed')
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  env.ctx.emit('agent/status', { agent: env.agentMap.get('dm-a'), status: 'idle' })
  await waitFor(() => env.archivedSessions.length > 0)
  assert.equal(env.rt.taskById(oldest.id), undefined)
  assert.deepEqual(env.archivedSessions.map(item => item.sid), [oldest.sessionId])
})

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

test('API group tasks do not inherit an IM dispatch approval route', async t => {
  const env = await startEnv({ team: makeTeam({ rooms: {
    r1: { id: 'r1', name: 'Team', members: ['a', 'b'], sessionId: 'room-1', sessions: { a: 'room-a', b: 'room-b' }, createdAt: 1 },
  } }) })
  t.after(env.stop)
  let captured = 0
  env.rt.captureImOrigin = () => undefined
  env.rt.roomReportImOrigin = () => { captured += 1; return { connId: 'im-connection', chatKey: 'im-chat' } }
  env.rt.desiredModel = async () => 'deepseek/model'
  const task = await env.rt.startTask('room-a', { title: 'API group work', brief: 'Separate output' }, undefined, { api: true })
  assert.equal(task.origin, 'api')
  assert.equal(task.imOrigin, undefined)
  assert.equal(task.dispatchApprovalOrigin, undefined)
  assert.equal(captured, 0)
})

test('API tasks do not inherit an IM claim or report into its foreground turn', async t => {
  const env = await startEnv()
  t.after(env.stop)
  let captured = 0
  const origin = { connId: 'im-connection', chatKey: 'im-chat' }
  env.rt.captureImOrigin = () => { captured += 1; return origin }
  const task = await env.rt.startTask('dm-a', { title: 'API work', brief: 'Separate output' }, undefined, { api: true })
  assert.equal(task.origin, 'api')
  assert.equal(task.imOrigin, undefined)
  assert.equal(captured, 0)
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'API-only result' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed')
  assert.equal(env.deliveries.some(entry => entry.role === 'task-report'), false)
  assert.deepEqual(env.rt.captureImOrigin('dm-a'), origin)
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
  await waitFor(() => task.status === 'completed' && env.deliveries.some(d => d.role === 'task-report'))
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
  assert.equal(env.rt.activityView().a, undefined, 'background task approval must not overwrite idle foreground mascot')

  // A foreground DM turn keeps its own activity while the background task approval waits.
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'dm-1', name: 'bash', arguments: '{}' })
  assert.equal(env.rt.activityView().a, 'working', 'background task approval must not clobber running foreground DM activity')
  await env.emit('dm-a', 'tool/result', { callId: 'dm-1' })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

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

test('spawnBotHandoffTask never forks busy foreground session, passes delegation prompt cleanly, and isolates foreground chat', async (t) => {
  const team = makeTeam({
    bots: {
      b: {
        id: 'b',
        name: 'Helper',
        role: 'Dev',
        sessionId: 'dm-b',
        createdAt: 2,
        segments: [{ sessionId: 'dm-b-p1', endedAt: 50, note: 'Earlier helper note' }],
      },
    },
  })
  const env = await startEnv({ team })
  t.after(env.stop)

  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'
  // Simulate a huge busy foreground user session on Helper.
  dmB.session.seq = 25_000
  await env.emit('dm-b', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Private foreground user chat' }] })
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc-busy', name: 'bash', arguments: '{}' })

  const res = await env.tool('delegate_work').execute({ to: 'Helper', goal: 'Run isolated contract check' }, execOf(dmA))
  assert.match(res, /background task while its foreground chat is busy/)
  assert.equal(env.forkedCalls.length, 0, 'spawnBotHandoffTask must NEVER fork the target Bot foreground session')
  assert.equal(env.createdSessions.length, 1, 'spawnBotHandoffTask must open a fresh lightweight Session')

  const task = env.rt.botOf('b').tasks[0]
  assert.equal(task.origin, 'bot-handoff')
  assert.equal(task.startSeq, 0)
  assert.deepEqual(task.inheritedSegments, [{ sessionId: 'dm-b-p1', endedAt: 50 }], 'bot-handoff must not leak live foreground user chat into inheritedSegments')

  const delivered = env.deliveries.find(d => d.sessionId === task.sessionId && d.role === 'request')
  assert.ok(delivered !== undefined)
  assert.match(delivered.text, /Run isolated contract check/)
  assert.doesNotMatch(delivered.text, /Private foreground user chat/)

  // Verify the lightweight bot-handoff task settles and returns its answer to Chief cleanly.
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'user/message', {
    content: [{ type: 'text', text: delivered.text }],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: task.exchangeId, senderSessionId: 'a', senderName: 'Chief' },
  })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Contract check passed.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed' && env.deliveries.some(d => d.toId === 'a' && d.role === 'reply'))

  const reply = env.deliveries.find(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId)
  assert.ok(reply !== undefined)
  assert.match(reply.text, /Contract check passed\./)
})

test('task_start forks compact parents, skips fork above TASK_FORK_MAX_EVENTS with fallback summary + parent read_own_chat recall, while fg-handoff keeps forking', async (t) => {
  const team = makeTeam({
    bots: {
      a: {
        id: 'a',
        name: 'Chief',
        role: 'Boss',
        sessionId: 'dm-a',
        createdAt: 1,
        segments: [{ sessionId: 'dm-a-p1', endedAt: 100, note: 'Part 1 summary note.' }],
      },
    },
    rooms: {
      r1: { id: 'r1', name: 'OpsGroup', named: true, members: ['a', 'b'], admin: 'a', sessionId: 'room-1', sessions: { a: 'grp-a', b: 'grp-b' }, log: [], seen: {}, seq: 0, createdAt: 1 },
    },
  })
  const env = await startEnv({ team })
  t.after(env.stop)

  // Wire real DSH sessionController.page contract (0-based contiguous seqs) for SQLite FTS5 chat index.
  const pageStore = new Map([
    ['dm-a-p1', [
      { type: 'user/message', seq: 0, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Archived codename FALCON-42 in part 1.' }] } },
      { type: 'assistant/message', seq: 1, time: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Stored FALCON-42.' }] } } },
    ]],
  ])
  env.ctx.sessionController.page = async ({ address, throughSeq, beforeSeq }) => {
    const raw = pageStore.get(address.sessionId) ?? env.agentMap.get(address.sessionId)?.session.snapshotEvents() ?? []
    const filtered = raw.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
    return { records: filtered.map(event => ({ event })), hasMore: false }
  }

  const dmA = env.agentMap.get('dm-a')
  // Seed contiguous 0-based events in dm-a including a structured handoff note and a unique fact.
  dmA.session.events.push(
    {
      type: 'user/message',
      seq: 0,
      time: 200,
      data: {
        source: { kind: SOURCE_KIND, role: 'handoff', handoff: true },
        content: [{ type: 'text', text: '[Handoff · part 2]\n\n## Handoff note\n## Decisions\n- Keep lightweight background tasks.' }],
      },
    },
    {
      type: 'user/message',
      seq: 1,
      time: 201,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Parent foreground fact: deploy token bucket is COBALT-77.' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 202,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted COBALT-77.' }] } },
    },
  )

  // 1) Compact parent (seq === 5 <= options.taskForkMaxEvents 5): MUST fork and NOT duplicate dm-a in inheritedSegments.
  dmA.session.seq = 5
  const compact = await env.rt.startTask('dm-a', { title: 'Compact fork', brief: 'Small session job' }, execOf(dmA), { taskForkMaxEvents: 5 })
  assert.equal(compact.forked, true, 'sourceEventCount === threshold must still fork')
  assert.equal(env.forkedCalls.length, 1)
  assert.deepEqual(compact.inheritedSegments, [{ sessionId: 'dm-a-p1', endedAt: 100 }], 'forked task must not duplicate parent dm-a in inheritedSegments')

  // 2) Above configurable threshold (seq === 6 > 5): MUST skip fork, seed structured fallbackContextSummary,
  // append branch-bounded parent ref { sessionId: 'dm-a', throughSeq: 5 }, and allow read_own_chat to search both part 1 AND live dm-a!
  dmA.session.seq = 6
  const overOpt = await env.rt.startTask('dm-a', { title: 'Threshold fresh', brief: 'Large session job' }, execOf(dmA), { taskForkMaxEvents: 5 })
  assert.equal(overOpt.forked, false, 'sourceEventCount > options.taskForkMaxEvents must skip fork')
  assert.equal(env.forkedCalls.length, 1, 'no new sessionController.fork call when above threshold')
  assert.deepEqual(overOpt.inheritedSegments, [{ sessionId: 'dm-a-p1', endedAt: 100 }, { sessionId: 'dm-a', throughSeq: 5 }])
  const overDelivery = env.deliveries.find(d => d.sessionId === overOpt.sessionId && d.role === 'task')
  assert.match(overDelivery.text, /## Decisions\n- Keep lightweight background tasks\./)
  assert.match(overDelivery.text, /COBALT-77/)

  // Use real read_own_chat (backed by SQLite FTS5 index) from inside the non-forked task!
  const taskAgent = env.agentMap.get(overOpt.sessionId)
  // Reset dmA.session.seq to match its 3 real events (0..2) so FTS5 contiguous check indexes dm-a cleanly.
  dmA.session.seq = dmA.session.events.length
  const foundParent = await env.tool('read_own_chat').execute({ query: 'COBALT-77' }, execOf(taskAgent))
  assert.match(foundParent, /COBALT-77/, 'non-forked task_start must search live parent foreground session via read_own_chat')
  const foundArchived = await env.tool('read_own_chat').execute({ query: 'FALCON-42' }, execOf(taskAgent))
  assert.match(foundArchived, /FALCON-42/, 'non-forked task_start must search archived bot.segments via read_own_chat')
  const part1Note = await env.tool('read_own_chat').execute({ part: 1 }, execOf(taskAgent))
  assert.match(part1Note, /Part 1 summary note\./)
  const parentPartStatus = await env.tool('read_own_chat').execute({ part: 2 }, execOf(taskAgent))
  assert.match(parentPartStatus, /still open and has no closing handoff note yet/)

  // 3) Default TASK_FORK_MAX_EVENTS (600): seq = 601 skips fork cleanly via task_start tool.
  dmA.session.seq = TASK_FORK_MAX_EVENTS + 1
  const outDefault = await env.tool('task_start').execute({ title: 'Huge parent task', brief: 'Run audit' }, execOf(dmA))
  assert.match(outDefault, /in a fresh session with recent summary/)
  assert.equal(env.forkedCalls.length, 1, 'default TASK_FORK_MAX_EVENTS threshold must prevent forking')

  // 4) Group task_start above threshold skips fork, includes group recent summary, and does NOT put group session in inheritedSegments.
  const grpA = (await env.ctx.sessionController.resolveAgent('grp-a')).agent
  grpA.session.events.push({ type: 'user/message', seq: 0, time: 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Group context: release v0.4' }] } })
  grpA.session.seq = TASK_FORK_MAX_EVENTS + 10
  const grpRes = await env.tool('task_start').execute({ title: 'Group heavy job', brief: 'Check release' }, execOf(grpA))
  assert.match(grpRes, /in a fresh session with recent summary/)
  assert.equal(env.forkedCalls.length, 1)
  const grpTask = env.rt.botOf('a').tasks.at(-1)
  assert.equal(grpTask.roomId, 'r1')
  assert.equal(grpTask.inheritedSegments, undefined, 'group task_start must not put group session into inheritedSegments')
  const grpDelivery = env.deliveries.find(d => d.sessionId === grpTask.sessionId && d.role === 'task')
  assert.match(grpDelivery.text, /\[Recent context from group "OpsGroup"\]/)
  assert.match(grpDelivery.text, /release v0\.4/)

  // 5) Foreground handoff (`handoffForeground`) STILL calls fork even when parent session has > TASK_FORK_MAX_EVENTS events!
  dmA.status = 'running'
  dmA.session.seq = TASK_FORK_MAX_EVENTS + 500
  await env.emit('dm-a', 'turn/start', { turn: 9 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc-fg-huge', name: 'bash', arguments: '{}' })
  const newFgSid = await env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [])
  assert.match(newFgSid, /^fork-/, 'fg-handoff must keep forking foreground chats to retain KV cache')
  assert.equal(env.forkedCalls.length, 2)
})

test('thread-boundary isolation: non-forked inherited foreground ref + legacy unsealed ref stay bounded across fg-handoff, SQLite search, partLines, earlierPage, and pruneSettledTasks cold read', async (t) => {
  const team = makeTeam({
    bots: {
      a: {
        id: 'a',
        name: 'Chief',
        role: 'Boss',
        sessionId: 'dm-a',
        createdAt: 1,
        segments: [{ sessionId: 'dm-a-p1', endedAt: 100, note: 'Part 1 archived summary.' }],
      },
    },
  })
  const env = await startEnv({ team })
  t.after(env.stop)

  // Cold event log backing sessionController.page (persists even after dm-a is archived and evicted from agentMap).
  const coldStore = new Map([
    ['dm-a-p1', [
      { type: 'user/message', seq: 0, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Archived part 1 note ARCHIVE-1.' }] } },
      { type: 'assistant/message', seq: 1, time: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Kept ARCHIVE-1.' }] } } },
    ]],
  ])
  const appendEvent = (sid, event) => {
    const agent = env.agentMap.get(sid)
    const list = coldStore.get(sid) ?? []
    if (!coldStore.has(sid)) coldStore.set(sid, list)
    list.push(event)
    if (agent !== undefined) {
      agent.session.events.push(event)
      agent.session.seq = list.length
    }
  }
  env.ctx.sessionController.page = async ({ address, throughSeq, beforeSeq }) => {
    const raw = coldStore.get(address.sessionId) ?? env.agentMap.get(address.sessionId)?.session.snapshotEvents() ?? []
    const filtered = raw.filter(ev => (throughSeq === undefined || ev.seq <= throughSeq) && (beforeSeq === undefined || ev.seq < beforeSeq))
    return { records: filtered.map(event => ({ event })), hasMore: false }
  }
  env.ctx.workspaceRegistry.archiveSession = async (sid, opts) => {
    env.archivedSessions.push({ sid, opts })
    env.agentMap.delete(sid)
  }

  // Turn 1 on foreground dm-a (> taskForkMaxEvents=2): contains pre-branch secret + shared token.
  const dmA = env.agentMap.get('dm-a')
  appendEvent('dm-a', { type: 'turn/start', seq: 0, time: 200, data: { turn: 1 } })
  appendEvent('dm-a', { type: 'user/message', seq: 1, time: 201, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember secret-before-branch and shared-token-omega.' }] } })
  appendEvent('dm-a', { type: 'assistant/message', seq: 2, time: 202, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Stored secret-before-branch.' }] } } })
  appendEvent('dm-a', { type: 'turn/end', seq: 3, time: 203, data: { turn: 1, reason: { kind: 'completed' } } })
  env.rt.state.exchangeTurns['dm-a'] = [99]

  // 1) Non-forked task_start creates T1 (seq=4 > taskForkMaxEvents=2), capturing throughSeq: 3.
  const t1 = await env.rt.startTask('dm-a', { title: 'Task T1', brief: 'Work on T1' }, execOf(dmA), { taskForkMaxEvents: 2 })
  assert.equal(t1.forked, false)
  assert.deepEqual(t1.inheritedSegments, [
    { sessionId: 'dm-a-p1', endedAt: 100 },
    { sessionId: 'dm-a', throughSeq: 3 },
  ])

  // 2) Seed a legacy persisted task (pre-fix) with an unsealed { sessionId: 'dm-a' } (no throughSeq, no endedAt).
  const legacySessionId = 'ses-legacy-t1'
  await env.ctx.sessionController.resolveAgent(legacySessionId)
  const legacyTask = {
    id: 'k_legacy',
    title: 'Legacy Task',
    brief: 'Old task from before throughSeq',
    from: 'dm-a',
    sessionId: legacySessionId,
    segments: [],
    inheritedSegments: [{ sessionId: 'dm-a-p1', endedAt: 100 }, { sessionId: 'dm-a' }],
    status: 'running',
    startedAt: 250,
    updatedAt: 250,
  }
  env.rt.botOf('a').tasks.push(legacyTask)
  env.rt.chatOwners.set(legacySessionId, 'a')
  env.rt.taskOwners.set(legacySessionId, { botId: 'a', taskId: legacyTask.id })
  await env.rt.save()

  // 3) Start Turn 2 on dm-a and move dm-a into T2 via handoffForeground (fg-handoff).
  dmA.status = 'running'
  const turn2Start = { type: 'turn/start', seq: 4, time: 300, data: { turn: 2 } }
  appendEvent('dm-a', turn2Start)
  for (const listener of env.ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) await listener(dmA.session, turn2Start)
  }
  appendEvent('dm-a', { type: 'user/message', seq: 5, time: 301, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run private-t2-prompt with zz and shared-token-omega.' }] } })
  const newFgSid = await env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [])
  assert.notEqual(newFgSid, 'dm-a')

  const bot = env.rt.botOf('a')
  const t1Stored = bot.tasks.find(item => item.id === t1.id)
  const legacyStored = bot.tasks.find(item => item.id === legacyTask.id)
  const t2Stored = bot.tasks.find(item => item.sessionId === 'dm-a')
  assert.ok(t2Stored !== undefined && t2Stored.origin === 'fg-handoff')

  // Both T1 and legacy task must be sealed with endedAt and throughSeq === 3 (excluding Turn 2!).
  const t1Ref = t1Stored.inheritedSegments.find(seg => seg.sessionId === 'dm-a')
  const legacyRef = legacyStored.inheritedSegments.find(seg => seg.sessionId === 'dm-a')
  assert.equal(t1Ref.throughSeq, 3)
  assert.equal(typeof t1Ref.endedAt, 'number')
  assert.equal(legacyRef.throughSeq, 3)
  assert.equal(typeof legacyRef.endedAt, 'number')

  // T2 continues writing private messages (and multiple shared-token rows to test SQL LIMIT crowding) into dm-a.
  appendEvent('dm-a', { type: 'assistant/message', seq: 6, time: 302, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Doing private-t2-work with zz and shared-token-omega #1.' }] } } })
  appendEvent('dm-a', { type: 'assistant/message', seq: 7, time: 303, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'More private-t2-work shared-token-omega #2.' }] } } })
  appendEvent('dm-a', { type: 'assistant/message', seq: 8, time: 304, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Final private-t2-work shared-token-omega #3.' }] } } })

  // Backdate T1's sealed endedAt past SEAL_AFTER_MS (60s) to prove T1's read never prematurely seals active dm-a in chat-index.sqlite.
  t1Ref.endedAt = Date.now() - 120_000

  const t1Agent = env.agentMap.get(t1.sessionId)
  const legacyAgent = env.agentMap.get(legacySessionId)
  const readOwn = env.tool('read_own_chat')

  // 4) Real SQLite chat-index.sqlite isolation checks for BOTH T1 and legacy task!
  for (const [label, agent] of [['T1', t1Agent], ['legacy', legacyAgent]]) {
    const hitBefore = await readOwn.execute({ query: 'secret-before-branch' }, execOf(agent))
    assert.match(hitBefore, /secret-before-branch/, `${label} must still recall pre-branch messages`)
    assert.doesNotMatch(hitBefore, /private-t2-work|private-t2-prompt/, `${label} must never leak T2`)

    const missT2Work = await readOwn.execute({ query: 'private-t2-work' }, execOf(agent))
    assert.match(missT2Work, /^Nothing in your own chat mentions "private-t2-work"\./, `${label} FTS5 search must not see private-t2-work`)

    const missT2Prompt = await readOwn.execute({ query: 'private-t2-prompt' }, execOf(agent))
    assert.match(missT2Prompt, /^Nothing in your own chat mentions "private-t2-prompt"\./, `${label} FTS5 search must not see moved Turn 2 prompt`)

    // Short (<3 char) LIKE query path must also enforce throughSeq!
    const missShort = await readOwn.execute({ query: 'zz' }, execOf(agent))
    assert.match(missShort, /^Nothing in your own chat mentions "zz"\./, `${label} short LIKE search must not leak T2`)

    // Latest messages (omitting query) must return pre-branch messages and NEVER T2!
    const latest = await readOwn.execute({}, execOf(agent))
    assert.match(latest, /secret-before-branch/, `${label} latest read must include pre-branch messages`)
    assert.doesNotMatch(latest, /private-t2-work|private-t2-prompt/, `${label} latest read must never leak T2`)

    // Anchor reads around both pre-branch (#1) and post-branch (#6) must stay bounded!
    const aroundBefore = await readOwn.execute({ around: 'part 2 #1' }, execOf(agent))
    assert.match(aroundBefore, /secret-before-branch/)
    assert.doesNotMatch(aroundBefore, /private-t2-work|private-t2-prompt/)
    const aroundAfter = await readOwn.execute({ around: 'part 2 #6' }, execOf(agent))
    assert.doesNotMatch(aroundAfter, /private-t2-work|private-t2-prompt/)

    // Part summary read must not misreport a sealed inherited ref as context overflow or leak T2.
    const part2 = await readOwn.execute({ part: 2 }, execOf(agent))
    assert.match(part2, /has no closing handoff note/)
    assert.doesNotMatch(part2, /context overflow|private-t2-work/)
  }

  // 5) SQL LIMIT must filter throughSeq BEFORE LIMIT so T2's many hits cannot crowd out T1's pre-branch hit.
  const limited = await env.rt.searchOwnChat('a', 'shared-token-omega', { askingId: t1.sessionId, limit: 1 })
  assert.equal(limited.lines.length, 1, 'T1 limit=1 search must not be crowded out by T2 rows')
  assert.match(limited.lines[0], /secret-before-branch/)
  assert.doesNotMatch(limited.lines[0], /private-t2/)

  // 6) Direct partLines and earlierPage must enforce part.throughSeq.
  const t1Parts = env.rt.partsOfThread('a', t1.sessionId)
  const dmAPart = t1Parts.find(p => p.sessionId === 'dm-a')
  assert.equal(dmAPart.throughSeq, 3)
  const directLines = []
  for await (const line of env.rt.partLines(dmAPart.sessionId, AbortSignal.timeout(5000), { throughSeq: dmAPart.throughSeq })) {
    directLines.push(line.text)
  }
  assert.ok(directLines.some(text => text.includes('secret-before-branch')), 'partLines must include pre-branch lines')
  assert.equal(directLines.some(text => text.includes('private-t2-work') || text.includes('private-t2-prompt')), false, 'partLines must never yield seq > throughSeq')

  const earlier = await env.rt.earlierPage(t1.sessionId)
  const earlierTexts = earlier.items.map(item => item.text ?? '').join('\n')
  assert.match(earlierTexts, /secret-before-branch/)
  assert.doesNotMatch(earlierTexts, /private-t2-work|private-t2-prompt/)

  // 7) T2 itself STILL sees its own messages AND new messages appended after T1's read (dm-a was NOT prematurely sealed!).
  appendEvent('dm-a', { type: 'assistant/message', seq: 9, time: 305, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Post-seal-window private-t2-late.' }] } } })
  const t2Hit = await readOwn.execute({ query: 'private-t2-late' }, execOf(dmA))
  assert.match(t2Hit, /private-t2-late/, 'T2 must still index and find its own messages after T1 read dm-a')
  const t1MissLate = await readOwn.execute({ query: 'private-t2-late' }, execOf(t1Agent))
  assert.match(t1MissLate, /Nothing in your own chat mentions/)

  // 8) Finish T2's turn cleanly and overflow MAX_SETTLED_TASKS so PR #2203's two-phase
  //    pruneSettledTasks + retireTasks prunes T2 from bot.tasks while deferring archive/cleanup
  //    of dm-a via isInherited() as long as T1/legacyTask still inherit dm-a; AND verify cold
  //    archived sessionController.page reads stay bounded.
  const turn2End = { type: 'turn/end', seq: 10, time: 306, data: { turn: 2, reason: { kind: 'completed' } } }
  appendEvent('dm-a', turn2End)
  dmA.status = 'idle'
  for (const listener of env.ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) await listener(dmA.session, turn2End)
  }
  env.ctx.emit('agent/status', { agent: dmA, status: 'idle' })
  await waitFor(() => t2Stored.status === 'completed' && env.deliveries.some(d => d.role === 'task-report' && d.taskId === t2Stored.id))
  // Consume T2's task-report turn on the new foreground so reportPending(t2Stored.id) clears.
  const fgAgent = env.agentMap.get(newFgSid)
  const reportMsg = fgAgent.followups.find(m => m.source?.role === 'task-report' && m.source?.taskId === t2Stored.id)
  assert.ok(reportMsg !== undefined, 'T2 delivered task-report to new foreground')
  await env.emit(newFgSid, 'turn/start', { turn: 1 })
  await env.emit(newFgSid, 'user/message', { source: reportMsg.source, content: reportMsg.content })
  await env.emit(newFgSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Put T2 first among settled tasks, followed by 50 more settled tasks so pruning drops T2.
  const fillerTasks = Array.from({ length: 50 }, (_, idx) => ({
    id: `k_fill_${idx}`,
    title: `Filler ${idx}`,
    brief: 'Done',
    from: newFgSid,
    sessionId: `ses-fill-${idx}`,
    segments: [],
    status: 'completed',
    startedAt: 400 + idx,
    updatedAt: 400 + idx,
    endedAt: 400 + idx,
  }))
  bot.tasks = [t2Stored, ...fillerTasks, t1Stored, legacyStored]
  // Trigger pruneSettledTasks + retireTasks by settling one more task.
  const triggerTask = {
    id: 'k_trigger_prune',
    title: 'Trigger',
    brief: 'Trigger prune',
    from: newFgSid,
    sessionId: 'ses-trigger',
    segments: [],
    status: 'running',
    startedAt: 500,
    updatedAt: 500,
  }
  bot.tasks.push(triggerTask)
  env.rt.chatOwners.set('ses-trigger', 'a')
  env.rt.taskOwners.set('ses-trigger', { botId: 'a', taskId: triggerTask.id })
  const stopTrigger = await env.callApi('bot-stop-task', { botId: 'a', taskId: triggerTask.id })
  assert.equal(stopTrigger.ok, true)
  await waitFor(() => !bot.tasks.some(item => item.id === t2Stored.id))

  assert.equal(bot.tasks.some(item => item.id === t2Stored.id), false, 'T2 was pruned past MAX_SETTLED_TASKS')
  assert.equal(
    (env.rt.state.retiredTasks ?? []).some(entry => entry.sessionIds.includes('dm-a')),
    true,
    'PR #2203 isInherited must keep dm-a deferred in state.retiredTasks while T1/legacyTask still inherit it',
  )
  assert.equal(
    env.archivedSessions.some(item => item.sid === 'dm-a'),
    false,
    'dm-a must not be archived while active tasks still reference it in inheritedSegments',
  )
  assert.deepEqual(env.rt.state.exchangeTurns['dm-a'], [99], 'isInherited deferral preserves exchangeTurns for dm-a')

  // Simulate dm-a archived/evicted from live agentMap: T1's cold reads via sessionController.page
  // must still work cleanly and strictly enforce throughSeq!
  await env.ctx.workspaceRegistry.archiveSession('dm-a', { stopActivity: true })
  assert.equal(env.agentMap.has('dm-a'), false, 'dm-a unloaded from live agents to exercise cold path')
  const coldQuery = await readOwn.execute({ query: 'secret-before-branch' }, execOf(t1Agent))
  assert.match(coldQuery, /secret-before-branch/)
  const coldMiss = await readOwn.execute({ query: 'private-t2-work' }, execOf(t1Agent))
  assert.match(coldMiss, /^Nothing in your own chat mentions "private-t2-work"\./)
  const coldEarlier = await env.rt.earlierPage(t1.sessionId)
  const coldEarlierTexts = coldEarlier.items.map(item => item.text ?? '').join('\n')
  assert.match(coldEarlierTexts, /secret-before-branch/)
  assert.doesNotMatch(coldEarlierTexts, /private-t2-work|private-t2-prompt/)
  const coldLines = []
  for await (const line of env.rt.partLines('dm-a', AbortSignal.timeout(5000), { throughSeq: 3 })) {
    coldLines.push(line.text)
  }
  assert.ok(coldLines.some(text => text.includes('secret-before-branch')))
  assert.equal(coldLines.some(text => text.includes('private-t2-work')), false)

  // 9) Externalized handoff notes in store.js noteCache/disk (e.g. written when dm-a later rolls over
  //    in T2 or foreground) AND inline bot.segments notes must NEVER leak into bounded inherited refs.
  //    Also verify partsOfThread keeps task.startedAt monotonic when trailing bounded ref gains endedAt.
  const wroteExternal = await env.rt.writeSegmentNote('dm-a', 'Externalized post-branch T2 closing note with private-t2-note-secret.')
  assert.equal(wroteExternal, true, 'writeSegmentNote populated store noteCache and segment-notes file')
  assert.match(env.rt.readSegmentNote('dm-a'), /private-t2-note-secret/)

  const sealedParts = env.rt.partsOfThread('a', t1.sessionId)
  const sealedDmA = sealedParts.find(p => p.sessionId === 'dm-a')
  const sealedTail = sealedParts.at(-1)
  assert.equal(sealedDmA.throughSeq, 3)
  assert.equal(env.rt.readSegmentNote(sealedDmA), undefined, 'readSegmentNote must block noteCache/disk reads for bounded throughSeq refs')
  assert.equal(env.rt.noteText(sealedDmA), undefined, 'noteText must return undefined for bounded throughSeq refs')
  assert.equal(sealedTail.startedAt, t1Stored.startedAt, 'task tail startedAt must stay monotonic when trailing bounded ref has endedAt')
  const part2External = await readOwn.execute({ part: 2 }, execOf(t1Agent))
  assert.match(part2External, /has no closing handoff note/)
  assert.doesNotMatch(part2External, /private-t2-note-secret/)

  bot.segments.push({ sessionId: 'dm-a', endedAt: 999, note: 'Post-branch foreground note leaking future work', hasNote: true })
  const hydratedParts = env.rt.partsOfThread('a', t1.sessionId)
  const hydratedDmA = hydratedParts.find(p => p.sessionId === 'dm-a')
  assert.equal(hydratedDmA.throughSeq, 3)
  assert.equal(hydratedDmA.note, undefined)
  assert.equal(env.rt.readSegmentNote(hydratedDmA), undefined)
  assert.equal(env.rt.noteText(hydratedDmA), undefined)
  const part2AfterRollover = await readOwn.execute({ part: 2 }, execOf(t1Agent))
  assert.doesNotMatch(part2AfterRollover, /Post-branch foreground note|private-t2-note-secret/)
})

test('handoffForeground handoffCutSeq edge cases: Turn 1 without turn/end cuts at -1, and empty snapshotEvents prefers forked boundary over session.seq', async (t) => {
  // Case A: Turn 1 where initiating user/message precedes turn/start (no prior turn/end).
  // Legacy unsealed ref must seal to throughSeq: -1 (excluding Turn 1's user/message).
  const envA = await startEnv()
  t.after(envA.stop)
  const botA = envA.rt.botOf('a')
  const dmA = envA.agentMap.get('dm-a')
  dmA.session.events.push(
    { type: 'user/message', seq: 0, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn-1-private-prompt' }] } },
    { type: 'turn/start', seq: 1, time: 101, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 102, data: { callId: 'tc-1', name: 'bash', arguments: '{}' } },
  )
  dmA.session.seq = 3
  dmA.status = 'running'
  envA.rt.live.set('dm-a', { turn: 1, since: 101, toolCount: 1, calls: new Set() })
  botA.tasks = [{
    id: 'k_leg_t1',
    title: 'Legacy T1',
    brief: 'Old task',
    from: 'dm-a',
    sessionId: 'ses-leg-t1',
    segments: [],
    inheritedSegments: [{ sessionId: 'dm-a' }],
    status: 'running',
    startedAt: 50,
    updatedAt: 50,
  }]
  await envA.rt.handoffForeground(botA, 'dm-a', [])
  assert.equal(botA.tasks[0].inheritedSegments[0].throughSeq, -1, 'Turn 1 without turn/end must seal legacy ref to -1 (excluding seq 0 user/message)')

  // Case B: oldEvents.length === 0 while session.seq === 10 and fork succeeds with forkedEvents ending at seq 5.
  // effectiveCutSeq must use lastForkedSeq (5), NOT lastSeqOf(oldSession) (9).
  const envB = await startEnv({
    forkImpl: async (_opts, makeForked) => {
      const forkedId = makeForked()
      const dst = envB.agentMap.get(forkedId)
      dst.session.events.push(
        { type: 'user/message', seq: 0, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] } },
        { type: 'turn/end', seq: 5, time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
      )
      dst.session.seq = 6
      return { sessionId: forkedId }
    },
  })
  t.after(envB.stop)
  const botB = envB.rt.botOf('a')
  const dmB = envB.agentMap.get('dm-a')
  dmB.session.seq = 10 // snapshotEvents() is empty, simulating unavailable/unhydrated in-memory events
  dmB.status = 'running'
  envB.rt.live.set('dm-a', { turn: 2, since: 20, toolCount: 1, calls: new Set() })
  botB.tasks = [{
    id: 'k_leg_fork_events',
    title: 'Legacy Fork Events',
    brief: 'Old task',
    from: 'dm-a',
    sessionId: 'ses-leg-fe',
    segments: [],
    inheritedSegments: [{ sessionId: 'dm-a' }],
    status: 'running',
    startedAt: 10,
    updatedAt: 10,
  }]
  await envB.rt.handoffForeground(botB, 'dm-a', [])
  assert.equal(botB.tasks[0].inheritedSegments[0].throughSeq, 5, 'empty oldEvents with forkedEvents must seal at lastForkedSeq (5), not session.seq - 1 (9)')

  // Case C: oldEvents.length === 0 while session.seq === 10 and fork succeeds with inheritedEventCount === 6 (empty forkedEvents).
  const envC = await startEnv({
    forkImpl: async (_opts, makeForked) => {
      const forkedId = makeForked()
      envC.agentMap.get(forkedId).session.inheritedEventCount = 6
      return { sessionId: forkedId }
    },
  })
  t.after(envC.stop)
  const botC = envC.rt.botOf('a')
  const dmC = envC.agentMap.get('dm-a')
  dmC.session.seq = 10
  dmC.status = 'running'
  envC.rt.live.set('dm-a', { turn: 2, since: 20, toolCount: 1, calls: new Set() })
  botC.tasks = [{
    id: 'k_leg_fork_count',
    title: 'Legacy Fork Count',
    brief: 'Old task',
    from: 'dm-a',
    sessionId: 'ses-leg-fc',
    segments: [],
    inheritedSegments: [{ sessionId: 'dm-a' }],
    status: 'running',
    startedAt: 10,
    updatedAt: 10,
  }]
  await envC.rt.handoffForeground(botC, 'dm-a', [])
  assert.equal(botC.tasks[0].inheritedSegments[0].throughSeq, 5, 'empty oldEvents with forked inheritedEventCount must seal at inheritedEventCount - 1 (5)')

  // Case D: oldEvents.length === 0 while session.seq === 10 and fork fails (non-forked fallback) -> falls back to lastSeqOf (9).
  const envD = await startEnv({
    forkImpl: async () => { throw new Error('fork unavailable') },
  })
  t.after(envD.stop)
  const botD = envD.rt.botOf('a')
  const dmD = envD.agentMap.get('dm-a')
  dmD.session.seq = 10
  dmD.status = 'running'
  envD.rt.live.set('dm-a', { turn: 2, since: 20, toolCount: 1, calls: new Set() })
  botD.tasks = [{
    id: 'k_leg_nofork',
    title: 'Legacy NoFork',
    brief: 'Old task',
    from: 'dm-a',
    sessionId: 'ses-leg-nf',
    segments: [],
    inheritedSegments: [{ sessionId: 'dm-a' }],
    status: 'running',
    startedAt: 10,
    updatedAt: 10,
  }]
  await envD.rt.handoffForeground(botD, 'dm-a', [])
  assert.equal(botD.tasks[0].inheritedSegments[0].throughSeq, 9, 'non-forked handoff with empty oldEvents falls back to session.seq - 1 (9)')

  // Case E: null/empty-string session.seq must not coerce to 0 in lastSeqOf / openTaskPart.
  const envE = await startEnv({ forkImpl: async () => { throw new Error('fork unavailable') } })
  t.after(envE.stop)
  const dmE = envE.agentMap.get('dm-a')
  dmE.session.events.push(
    { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } } },
  )
  dmE.session.seq = null
  const taskNullSeq = await envE.rt.startTask('dm-a', { title: 'Null seq task', brief: 'Check coercion' }, execOf(dmE), { taskForkMaxEvents: 0 })
  assert.deepEqual(taskNullSeq.inheritedSegments, [{ sessionId: 'dm-a', throughSeq: 1 }], 'null session.seq must fall back to snapshotEvents instead of coercing to 0 (-1)')
})
