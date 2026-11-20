import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const waitFor = async (check, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

async function startEnv({ roomWorkDir, roomPermission, botPermission } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-gtask-'))
  const workDir = join(home, 'team')
  const groupDir = roomWorkDir ? mkdtempSync(join(tmpdir(), 'ds-bot-grpdir-')) : undefined
  mkdirSync(workDir, { recursive: true })

  const team = {
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'dm-a', createdAt: 1, ...(botPermission ? { permission: botPermission } : {}) },
      b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'BuildGroup',
        sessionId: 'room-r1',
        members: ['a', 'b', 'c'],
        admin: 'a',
        mode: 'admin',
        sessions: { a: 'grp-r1-a', b: 'grp-r1-b', c: 'grp-r1-c' },
        log: [],
        seen: {},
        seq: 0,
        ...(groupDir ? { workDir: groupDir } : {}),
        ...(roomPermission ? { permission: roomPermission } : {}),
      },
    },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    views: {},
    prefs: {},
    revision: 0,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const presetApplies = []
  const ctx = fakeContext({
    services: {
      approval: { request: async () => 'allowed-once' },
      permissionPresets: {
        catalog: () => ({ defaultPreset: 'workspace-write', options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'full-access' }] }),
        resolve: name => ({ value: name }),
        set: (session, preset) => { presetApplies.push({ sessionId: session.id, preset }) },
      },
    },
  })
  const agentMap = new Map()
  const deliveries = []
  const createdSessions = []
  const prompts = []
  let seqId = 0

  const makeAgent = (id, cwd = workDir) => {
    const events = []
    const followups = []
    const cancelled = []
    const inbox = {
      nextStep: [],
      nextTurn: [],
      prepend(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg) },
      append(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg) },
      remove(msgId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) { list.splice(at, 1); return true }
        }
        return false
      },
    }
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
      inbox,
      followup: (msg) => {
        followups.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      steer: (msg) => {
        followups.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      inject: (msg) => { followups.push(msg) },
      cancel: (cause) => cancelled.push(cause),
      followups,
      cancelled,
    }
    agentMap.set(id, agent)
    return agent
  }

  for (const id of ['dm-a', 'dm-b', 'dm-c', 'room-r1']) makeAgent(id, workDir)
  for (const id of ['grp-r1-a', 'grp-r1-b', 'grp-r1-c']) makeAgent(id, groupDir ?? workDir)

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: workDir }),
      list: () => [{ id: 'w1', path: workDir }],
      resolveByPath: async () => undefined,
      create: async p => ({ id: 'w1', path: p }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async ({ title, cwd }) => {
        const sessionId = `ses-${++seqId}`
        createdSessions.push({ sessionId, title, cwd })
        makeAgent(sessionId, cwd ?? workDir)
        return { sessionId }
      },
      fork: async ({ sessionId: fromSid }) => {
        const sessionId = `fork-${++seqId}`
        const cwd = agentMap.get(fromSid)?.session.header.cwd ?? workDir
        makeAgent(sessionId, cwd)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentMap.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      prompt: async req => { prompts.push(req) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  ctx.connection.fetch.register = () => () => {}
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })

  const rt = createRuntime(ctx, { home })
  await rt.load()
  const origDeliver = rt.deliver
  rt.deliver = async (opts) => {
    deliveries.push(opts)
    return origDeliver(opts)
  }
  const tool = name => rt.teamTools.find(item => item.name === name)
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
    if (groupDir) rmSync(groupDir, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, workDir, groupDir, ctx, rt, agentMap, deliveries, createdSessions, presetApplies, prompts, tool, emit, stop }
}

const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'task_start', signal: AbortSignal.timeout(10_000) })

test('group member task_start inherits group workDir/permissions/memory, isolates task_list, and reports back to group session', async (t) => {
  const env = await startEnv({ roomWorkDir: true, roomPermission: 'read-only', botPermission: 'full-access' })
  t.after(env.stop)

  const grpA = env.agentMap.get('grp-r1-a')
  const dmA = env.agentMap.get('dm-a')

  // Outside room.workDir is refused.
  const extDir = mkdtempSync(join(tmpdir(), 'ds-bot-ext-'))
  t.after(() => rmSync(extDir, { recursive: true, force: true }))
  const refused = await env.tool('task_start').execute({ title: 'Bad dir', brief: 'Try outside', workdir: extDir }, execOf(grpA))
  assert.match(refused, /must stay inside/)

  // Valid group task starts from grp-r1-a.
  const started = await env.tool('task_start').execute({ title: 'Build audit', brief: 'Inspect group build' }, execOf(grpA))
  assert.match(started, /Started background task "Build audit"/)

  const botA = env.rt.botOf('a')
  assert.equal(botA.tasks.length, 1)
  const task = botA.tasks[0]
  assert.equal(task.roomId, 'r1')
  assert.equal(env.rt.taskOwners.get(task.sessionId)?.roomId, 'r1')
  assert.equal(env.rt.hasRoomTasks('r1', 'a'), true)

  // Group permission (read-only) was applied to the group task, NOT bot's own full-access!
  const applied = env.presetApplies.filter(p => p.sessionId === task.sessionId)
  assert.equal(applied.at(-1)?.preset, 'read-only')

  // Group folder is inherited.
  assert.equal(realpathSync(env.agentMap.get(task.sessionId).session.header.cwd), realpathSync(env.groupDir))

  // roomWorkView surfaces the active group task.
  const roomWork = env.rt.roomWorkView().r1 ?? []
  assert.ok(roomWork.some(item => item.botId === 'a' && item.tool === 'task' && item.note === 'Build audit'))

  // Scoping: group sees this task; DM does NOT see group tasks.
  assert.match(await env.tool('task_list').execute({}, execOf(grpA)), /Build audit/)
  assert.equal(await env.tool('task_list').execute({}, execOf(dmA)), 'No background tasks.')

  // Group task cannot call message_bot directly.
  const taskAgent = env.agentMap.get(task.sessionId)
  await assert.rejects(
    () => env.tool('message_bot').execute({ to: 'Helper', message: 'Hi outside' }, execOf(taskAgent)),
    /Background tasks in a group chat cannot call message_bot/,
  )

  // Updating group permission propagates to active group tasks.
  await env.rt.setRoomPermission(env.rt.roomOf('r1'), 'workspace-write')
  assert.equal(env.presetApplies.filter(p => p.sessionId === task.sessionId).at(-1)?.preset, 'workspace-write')

  // Memory writes inside a group task land in group memory (NOT private DM memory).
  const rememberRes = await env.tool('bot_remember').execute({ text: 'Group build uses Node 24' }, execOf(taskAgent))
  assert.match(rememberRes, /Saved to/)
  const groupRecall = await env.tool('bot_recall').execute({ query: 'Node 24' }, execOf(grpA))
  const dmRecall = await env.tool('bot_recall').execute({ query: 'Node 24' }, execOf(dmA))
  assert.match(groupRecall, /Group build uses Node 24/)
  assert.ok(!dmRecall.includes('Group build uses Node 24'), 'group task memory must not leak into private DM')

  // Completion delivers task-report to grp-r1-a (group Session), NOT dm-a!
  await env.emit(task.sessionId, 'turn/start', { turn: 1 })
  await env.emit(task.sessionId, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Group audit green.' }] } })
  await env.emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed' && env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.sessionId, 'grp-r1-a', 'group task report must land in member group Session, never private DM')
  assert.equal(report.roomId, 'r1')
  assert.equal(env.rt.hasRoomTasks('r1', 'a'), false)
})

test('group task approval carries roomId + taskId and lateRoomReply keeps batch open while group task runs', async (t) => {
  const env = await startEnv()
  t.after(env.stop)

  const grpB = env.agentMap.get('grp-r1-b')
  await env.tool('task_start').execute({ title: 'Run migration', brief: 'Check DB' }, execOf(grpB))
  const task = env.rt.botOf('b').tasks[0]

  // Open an approval inside the group background task.
  const opened = []
  env.rt.onApproval((kind, data) => { if (kind === 'open') opened.push(data) })
  const approvalListeners = env.ctx.listeners.get('approval/request') ?? []
  const reqPromise = approvalListeners[0](
    { agent: env.agentMap.get(task.sessionId), toolName: 'bash', reason: 'Run db script', callId: 'c1', signal: AbortSignal.timeout(5000) },
    () => new Promise(() => {}),
  )
  assert.equal(opened.length, 1)
  assert.equal(opened[0].roomId, 'r1', 'group task approval must carry roomId for group header island')
  assert.equal(opened[0].taskId, task.id)
  assert.equal(opened[0].taskTitle, 'Run migration')
  assert.equal(opened[0].answerable, true)

  env.rt.answerApproval(opened[0].id, 'allow')
  assert.equal(await reqPromise, 'allowed-once')

  // Register a group batch waiting on Helper ('b'), then fire lateRoomReply while task is still running.
  env.rt.state.roomBatches = {
    b1: { key: 'b1', roomId: 'r1', by: 'a', pending: ['b'], done: [], doneIds: [], results: [], worked: true, answered: false, at: Date.now() },
  }
  await env.rt.lateRoomReply('grp-r1-b', { role: 'room', roomId: 'r1', askedBy: 'a' }, 'Started background task for migration.', { shown: false, toolCount: 1 })
  assert.deepEqual(env.rt.state.roomBatches.b1.pending, ['b'], 'batch must stay open while member has an active group task')

  // Stopping the group task via stopMemberWork stops the task and removes member from batch.
  const stopped = await env.rt.stopMemberWork('r1', 'b')
  assert.equal(stopped, true)
  assert.equal(task.status, 'stopped')
  assert.equal(env.rt.hasRoomTasks('r1', 'b'), false)
  assert.equal(env.rt.state.roomBatches.b1, undefined, 'stopMemberWork must close waiting batch')
})

test('deleting room or removing member stops active group tasks and sendUser redirects group task sessionId to room', async (t) => {
  const env = await startEnv()
  t.after(env.stop)

  const grpA = env.agentMap.get('grp-r1-a')
  const grpB = env.agentMap.get('grp-r1-b')
  await env.tool('task_start').execute({ title: 'Task A', brief: 'Work A' }, execOf(grpA))
  await env.tool('task_start').execute({ title: 'Task B', brief: 'Work B' }, execOf(grpB))
  const taskA = env.rt.botOf('a').tasks[0]
  const taskB = env.rt.botOf('b').tasks[0]

  // sendUser targeting a group task sessionId must route to room-r1, never private DM.
  await env.rt.sendUser({ sessionId: taskA.sessionId, content: [{ type: 'text', text: 'Ping group' }] })
  assert.equal(env.prompts.at(-1).sessionId, 'room-r1')

  // Removing Helper from group stops Helper's group task (Task B) while leaving Chief's (Task A) running.
  await env.rt.updateRoom('r1', { members: ['a', 'c'] })
  assert.equal(taskB.status, 'stopped')
  assert.equal(taskA.status, 'running')

  // Deleting room stops remaining group tasks (Task A) without delivering to DM.
  await env.rt.deleteRoom('r1')
  assert.equal(taskA.status, 'stopped')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)
})

test('individual rt.stopTask on a group task reconciles waiting group batch so caller is woken', async (t) => {
  const env = await startEnv()
  t.after(env.stop)

  const grpB = env.agentMap.get('grp-r1-b')
  await env.tool('task_start').execute({ title: 'Solo task', brief: 'Work' }, execOf(grpB))
  const taskB = env.rt.botOf('b').tasks[0]

  // Batch where Reviewer ('c') already finished and Helper ('b') is the last pending member.
  env.rt.state.roomBatches = {
    b2: { key: 'b2', roomId: 'r1', by: 'a', pending: ['b'], done: ['Reviewer'], doneIds: ['c'], results: [], worked: true, answered: false, at: Date.now() },
  }

  await env.rt.stopTask('b', taskB.id)
  assert.equal(taskB.status, 'stopped')
  // Group's own Session receives the batch-closing post to wake Chief ('a').
  const roomAgent = env.agentMap.get('room-r1')
  const wakePost = roomAgent.followups.find(m => m.source?.role === 'post' && m.source?.batch === 'b2' && m.source?.batchEnd === true)
  assert.ok(wakePost !== undefined, 'stopping the last pending member task must wake the batch caller')
  assert.equal(wakePost.source.askedBy, 'a')
})


test('P0-1: real agent/pre-step on group task with room.workDir does NOT trigger infinite folder rollover, and followFolder({ botId }) skips group tasks', async (t) => {
  const env = await startEnv({ roomWorkDir: true })
  t.after(env.stop)

  const grpA = env.agentMap.get('grp-r1-a')
  await env.tool('task_start').execute({ title: 'Group dir check', brief: 'Stay in group folder' }, execOf(grpA))
  const task = env.rt.botOf('a').tasks[0]
  const taskAgent = env.agentMap.get(task.sessionId)
  const createdBefore = env.createdSessions.length

  // Fire real agent/pre-step hook installed by parts.js: (payload, next) with payload.agent.
  const preStepListeners = env.ctx.listeners.get('agent/pre-step') ?? []
  let nextCalled = 0
  const payload = { agent: taskAgent, messages: [], signal: AbortSignal.timeout(5000) }
  const runChain = async (idx) => {
    if (idx >= preStepListeners.length) { nextCalled += 1; return payload }
    return preStepListeners[idx](payload, () => runChain(idx + 1))
  }
  await runChain(0)

  assert.equal(nextCalled, 1, 'agent/pre-step must proceed without taking over for a folder switch')
  assert.equal(env.createdSessions.length, createdBefore, 'must not create a rollover session when already in room.workDir')
  assert.equal(env.rt.isSwitchingPart(task.sessionId), false)

  // followFolder for the Bot's own DM folder must not move its group background task.
  await env.rt.followFolder({ botId: 'a' })
  assert.equal(env.createdSessions.length, createdBefore, 'followFolder({ botId }) must skip group tasks')
})

test('P0-2: reconcileStoppedRoomTask wakes batch caller even when a group round is currently running', async (t) => {
  const env = await startEnv()
  t.after(env.stop)

  const grpB = env.agentMap.get('grp-r1-b')
  await env.tool('task_start').execute({ title: 'Active round stop', brief: 'Work' }, execOf(grpB))
  const taskB = env.rt.botOf('b').tasks[0]

  // Simulate an active running round in room r1!
  let nudged = 0
  const activeRound = {
    roomId: 'r1',
    from: 1,
    slots: [],
    started: [],
    failed: [],
    passed: [],
    nudge: () => { nudged += 1 },
    closed: false,
    starting: false,
    abort: new AbortController(),
  }
  env.rt.roomProgress.set('call-active', activeRound)
  env.rt.state.roomBatches = {
    b3: { key: 'b3', roomId: 'r1', by: 'a', pending: ['b'], done: ['Reviewer'], doneIds: ['c'], results: [], worked: true, answered: false, at: Date.now() },
  }

  await env.rt.stopTask('b', taskB.id)
  env.rt.roomProgress.delete('call-active')

  assert.equal(taskB.status, 'stopped')
  assert.ok(activeRound.slots.some(slot => slot.id === 'a'), 'batch caller Chief must be queued into the active round')
  assert.ok(nudged >= 1, 'active round must be nudged to run the woken caller')
  assert.equal(env.rt.state.roomBatches.b3, undefined, 'batch must close after waking caller')
})

test('P0-3: valid subdirectory inside room.workDir passes realpath within() check (even via symlink path)', async (t) => {
  const env = await startEnv({ roomWorkDir: true })
  t.after(env.stop)

  const subDir = join(env.groupDir, 'sub-pkg')
  mkdirSync(subDir, { recursive: true })
  const grpA = env.agentMap.get('grp-r1-a')
  const started = await env.tool('task_start').execute({ title: 'Subdir task', brief: 'Work in sub', workdir: subDir }, execOf(grpA))
  assert.match(started, /Started background task "Subdir task"/)
  const task = env.rt.botOf('a').tasks[0]
  assert.equal(realpathSync(task.workDir), realpathSync(subDir))
})

test('P0-4: reconcileTasksAfterRestart before settleRoomBatches settles zombie group task and unblocks batch', async (t) => {
  const env = await startEnv()
  t.after(env.stop)

  const grpB = env.agentMap.get('grp-r1-b')
  await env.tool('task_start').execute({ title: 'Zombie group task', brief: 'Will orphan on restart' }, execOf(grpB))
  const taskB = env.rt.botOf('b').tasks[0]

  // Simulate that the initial prompt was already consumed before restart (no unread inflight left),
  // and drop Helper's group session so task-report cannot be delivered.
  const delivered = env.deliveries.find(d => d.sessionId === taskB.sessionId)
  if (delivered?.exchangeId) env.rt.forgetDelivery?.(delivered.exchangeId)
  const taskAgent = env.agentMap.get(taskB.sessionId)
  taskAgent.inbox.nextStep.length = 0
  taskAgent.inbox.nextTurn.length = 0
  env.rt.unreadOf = () => []
  delete env.rt.roomOf('r1').sessions.b
  env.rt.state.roomBatches = {
    b4: { key: 'b4', roomId: 'r1', by: 'a', pending: ['b'], done: ['Reviewer'], doneIds: ['c'], results: [], worked: true, answered: false, at: Date.now() },
  }

  // Exact resume.js order: reconcileTasksAfterRestart BEFORE settleRoomBatches.
  await env.rt.reconcileTasksAfterRestart(new Set())
  assert.equal(taskB.status, 'interrupted')
  assert.equal(env.rt.hasRoomTasks('r1', 'b'), false)

  await env.rt.settleRoomBatches()
  const roomAgent = env.agentMap.get('room-r1')
  const wakePost = roomAgent.followups.find(m => m.source?.role === 'post' && m.source?.batch === 'b4')
  assert.ok(wakePost !== undefined, 'settleRoomBatches must wake batch caller once zombie group task is interrupted')
})

test('P1: setPermission respects room.permission, tools isolate (bot, roomId), and spliced user msg on group task redirects to room', async (t) => {
  const env = await startEnv({ roomPermission: 'read-only', botPermission: 'workspace-write' })
  t.after(env.stop)

  const grpA = env.agentMap.get('grp-r1-a')
  const dmA = env.agentMap.get('dm-a')
  await env.tool('task_start').execute({ title: 'Grp Task', brief: 'In group' }, execOf(grpA))
  await env.tool('task_start').execute({ title: 'DM Task', brief: 'In DM' }, execOf(dmA))
  const grpTask = env.rt.botOf('a').tasks.find(item => item.title === 'Grp Task')
  const dmTask = env.rt.botOf('a').tasks.find(item => item.title === 'DM Task')

  // Cross-scope isolation on task_read, task_send, task_stop.
  assert.match(await env.tool('task_read').execute({ task: grpTask.id }, execOf(dmA)), /No such task/)
  assert.match(await env.tool('task_send').execute({ task: dmTask.id, text: 'hi' }, execOf(grpA)), /No such task/)
  assert.match(await env.tool('task_stop').execute({ task: grpTask.id }, execOf(dmA)), /No such task/)

  // Changing Bot permission updates DM task but does NOT override room.permission on group task.
  env.presetApplies.length = 0
  await env.rt.setPermission(env.rt.botOf('a'), 'full-access')
  assert.ok(env.presetApplies.some(p => p.sessionId === dmTask.sessionId && p.preset === 'full-access'))
  assert.ok(!env.presetApplies.some(p => p.sessionId === grpTask.sessionId), 'group task with room.permission must not be overwritten by setPermission')

  // Spliced user message on group task redirects to room-r1, never dm-a.
  const grpTaskAgent = env.agentMap.get(grpTask.sessionId)
  const msg = { id: 'u-grp-gap', role: 'user', content: [{ type: 'text', text: 'Group redirect' }], source: { kind: 'user' } }
  grpTaskAgent.inbox.nextStep.push(msg)
  await env.emit(grpTask.sessionId, 'agent/inbox/spliced', { target: 'next-step', inserted: [msg] })
  await waitFor(() => env.agentMap.get('room-r1').followups.some(m => m.content?.[0]?.text === 'Group redirect'))
  assert.equal(grpTaskAgent.inbox.nextStep.length, 0)
  assert.equal(env.agentMap.get('dm-a').followups.some(m => m.content?.[0]?.text === 'Group redirect'), false)
})
