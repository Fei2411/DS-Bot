import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { indexRoster } from '../src/client/sources.js'
import { SOURCE_KIND } from '../src/host/constants.js'
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
  prefs: over.prefs ?? {},
  revision: 0,
})

async function startEnv({ team = makeTeam(), forkImpl } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-fg-'))
  const workDir = join(home, 'team')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const agentMap = new Map()
  const prompts = []
  const forkedCalls = []
  const createdSessions = []
  const deliveries = []
  let seqId = 0

  const makeAgent = (id) => {
    const events = []
    const followups = []
    const injected = []
    const cancelled = []
    const session = {
      id,
      header: { cwd: workDir },
      events,
      _appending: false,
      requestHeader: () => undefined,
      snapshotEvents: () => [...events],
    }
    const inbox = {
      nextStep: [],
      nextTurn: [],
      locate(msgId) {
        for (const [target, list] of [['next-turn', this.nextTurn], ['next-step', this.nextStep]]) {
          const index = list.findIndex(item => item?.id === msgId)
          if (index !== -1) return { target, index }
        }
        return undefined
      },
      prepend(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg) },
      append(queue, msg) { (queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg) },
      remove(msgId) {
        if (session._appending) throw new Error('session append cannot reenter while another append is being published')
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) { list.splice(at, 1); return true }
        }
        return false
      },
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
      send: (msg, target = 'next-turn') => { inbox.append(target, msg) },
      followup: (msg) => {
        followups.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      steer: (msg) => {
        followups.push(msg)
        events.push({ type: 'user/message', seq: events.length + 1, data: { source: msg.source, message: msg, content: msg.content } })
      },
      inject: (msg) => { injected.push(msg) },
      cancel: (cause) => cancelled.push(cause),
      followups,
      injected,
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
      archiveSession: async () => {},
    },
    sessionController: {
      create: async ({ title, cwd }) => {
        const sessionId = `ses-${++seqId}`
        createdSessions.push({ sessionId, title, cwd })
        makeAgent(sessionId)
        return { sessionId }
      },
      fork: async (opts) => {
        forkedCalls.push(opts)
        if (forkImpl !== undefined) {
          return forkImpl(opts, () => {
            const sessionId = `fork-${++seqId}`
            makeAgent(sessionId)
            return sessionId
          })
        }
        const sessionId = `fork-${++seqId}`
        makeAgent(sessionId)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => ({ agent: agentMap.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      prompt: async (req) => { prompts.push(req) },
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
    agent.session._appending = true
    try {
      for (const listener of ctx.listeners.get('session/event') ?? []) {
        if (listener.length >= 2) await listener(agent.session, event)
      }
    } finally {
      agent.session._appending = false
    }
    if (type === 'agent/inbox/spliced') {
      for (const message of data.inserted ?? []) {
        for (const listener of ctx.listeners.get('agent/inbox/inserted') ?? []) {
          listener({ agent, message })
        }
      }
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, ctx, rt, agentMap, prompts, forkedCalls, createdSessions, deliveries, tool, emit, stop }
}

const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'message_bot', signal: AbortSignal.timeout(10_000) })

test('Desktop/Web user message on busy foreground moves old Session intact into bot.tasks and forks fresh foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  // Simulate busy foreground turn that already ran a tool.
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Run full integration suite' }], source: { kind: 'user' } })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{"command":"npm test"}' })

  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a'), true)

  // User hits Enter in Desktop/Web composer -> spliced into dm-a inbox.
  const userMsg = { id: 'u-new-1', role: 'user', content: [{ type: 'text', text: 'By the way, how is the release going?' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(userMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMsg] })
  await waitFor(() => env.rt.botOf('a').sessionId !== 'dm-a' && env.agentMap.get(env.rt.botOf('a').sessionId)?.followups.length === 1)

  const botA = env.rt.botOf('a')
  assert.equal(botA.sessionId, 'fork-1', 'foreground must move to the forked Session')
  assert.equal(dmA.cancelled.length, 0, 'busy foreground turn must NOT be cancelled or steer-cut')
  assert.equal(dmA.inbox.nextStep.length, 0, 'user message must be pulled synchronously out of old inbox')
  assert.equal(botA.tasks.length, 1)
  assert.equal(botA.tasks[0].sessionId, 'dm-a')
  assert.equal(botA.tasks[0].origin, 'fg-handoff')
  assert.equal(botA.tasks[0].title, 'Run full integration suite')
  assert.equal(env.rt.taskOwners.get('dm-a')?.taskId, botA.tasks[0].id)
  assert.equal(env.rt.activityView().a, undefined, 'old foreground activity must clear after handoff')

  const fresh = env.agentMap.get('fork-1')
  assert.equal(fresh.injected.length, 1, 'new foreground receives concise task-handoff notice')
  assert.match(fresh.injected[0].content[0].text, /Run full integration suite/)
  assert.equal(fresh.followups.length, 1)
  assert.equal(fresh.followups[0].content[0].text, 'By the way, how is the release going?')

  // When old dm-a finishes in background, its report lands on the new foreground fork-1.
  dmA.status = 'idle'
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Suite passed 100%.' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.sessionId, 'fork-1')
  assert.match(report.text, /Suite passed 100%/)
})

test('Mobile/IM sendUser triggers foreground handoff after wait threshold and redirects stale sessionId', async (t) => {
  const env = await startEnv({ team: makeTeam({ prefs: { backgroundAfterSec: 2 } }) })
  t.after(env.stop)
  env.rt.captureImOrigin = sid => (sid === 'dm-a' ? { connId: 'c1', chatKey: 'k1', senderId: 'u1', binding: 'bot:a' } : undefined)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  // Turn with 0 tools that has run longer than backgroundAfterSec (2s).
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  env.rt.live.get('dm-a').since = Date.now() - 5000
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Deep analysis' }], source: { kind: 'user' } })

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Quick question from phone' }], requestId: 'req-1' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')
  assert.equal(env.prompts[0].sessionId, 'fork-1')
  assert.deepEqual(env.rt.botOf('a').tasks[0].imOrigin, { connId: 'c1', chatKey: 'k1', senderId: 'u1', binding: 'bot:a' })

  // A second in-flight phone message still targeting stale 'dm-a' redirects to 'fork-1'.
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Follow up from phone' }], requestId: 'req-2' })
  assert.equal(env.prompts[1].sessionId, 'fork-1')
})

test('quick model-only turn under wait threshold and local CLI agents do NOT auto-move foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  // 0 tool calls, just started (< 5s).
  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a'), false)

  // Local CLI agent stays exempt even with tools and elapsed time (Decision 5①).
  env.rt.localAgentBadge = () => 'claude'
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  env.rt.live.get('dm-a').since = Date.now() - 60_000
  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a'), false)
})

test('hidden peer-Bot turn moved to background gets bot-handoff origin, never leaks to user chat, and settles work if stopped', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  // Helper (b) is currently answering Chief (a) in its foreground chat.
  env.rt.openWork('w-peer-1', { from: 'a', to: 'b' })
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  env.rt.live.get('dm-b').info = { kind: SOURCE_KIND, role: 'request', exchangeId: 'w-peer-1', senderSessionId: 'a', senderName: 'Chief' }
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  // Human sends a message to Helper -> Helper's peer work moves to background as bot-handoff.
  await env.rt.sendUser({ sessionId: 'dm-b', content: [{ type: 'text', text: 'Hi Helper' }] })
  const botB = env.rt.botOf('b')
  assert.equal(botB.sessionId, 'fork-1')
  assert.equal(botB.tasks[0].origin, 'bot-handoff')
  assert.equal(botB.tasks[0].exchangeId, 'w-peer-1')
  assert.equal(env.agentMap.get('fork-1').injected.length, 0, 'hidden bot-handoff must NOT inject notice into user chat')

  // Stopping the moved bot-handoff task while idle notifies Chief and never posts task-report to user foreground.
  dmB.status = 'idle'
  env.rt.live.get('dm-b').turn = undefined
  await env.rt.stopTask('b', botB.tasks[0].id)
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0)
  const replyToChief = env.deliveries.find(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === 'w-peer-1')
  assert.ok(replyToChief !== undefined, 'stopping idle bot-handoff task must reply to asking Bot so handoff tree does not deadlock')
})

test('peer Bot message_bot to a busy Bot spawns a background task directly without switching user foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  // Helper (b) is busy with user's foreground tool work.
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc-fg', name: 'bash', arguments: '{}' })

  // Chief (a) calls message_bot to Helper (b).
  const res = await env.tool('message_bot').execute({ to: 'Helper', message: 'Check API contract' }, execOf(dmA))
  assert.match(res, /background task while its foreground chat is busy/)
  assert.equal(env.rt.botOf('b').sessionId, 'dm-b', 'user foreground sessionId must NOT switch when another Bot messages')
  assert.equal(env.rt.botOf('b').tasks.length, 1)
  const task = env.rt.botOf('b').tasks[0]
  assert.equal(task.origin, 'bot-handoff')
  assert.ok(task.exchangeId)

  // Task runs and answers Chief via turns.js without posting a task-report to Helper's user foreground.
  const taskSid = task.sessionId
  const deliveredReq = env.deliveries.find(d => d.sessionId === taskSid && d.role === 'request')
  assert.ok(deliveredReq !== undefined)
  await env.emit(taskSid, 'turn/start', { turn: 1 })
  await env.emit(taskSid, 'user/message', {
    content: [{ type: 'text', text: deliveredReq.text }],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: task.exchangeId, senderSessionId: 'a', senderName: 'Chief' },
  })
  await env.emit(taskSid, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'API contract verified.' }] } })
  await env.emit(taskSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed' && env.deliveries.some(d => d.toId === 'a' && d.role === 'reply'))

  assert.equal(task.status, 'completed')
  assert.equal(env.deliveries.filter(d => d.role === 'task-report').length, 0, 'bot-handoff completion must not spam user foreground')
  const reply = env.deliveries.find(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId)
  assert.ok(reply !== undefined)
  assert.match(reply.text, /API contract verified\./)
})

test('rapid double Desktop messages share one handoff and post-commit race settles finished task', async (t) => {
  let releaseFork
  const env = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  const m1 = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'First msg' }], source: { kind: 'user' } }
  const m2 = { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Second msg' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(m1)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [m1] })
  dmA.inbox.nextStep.push(m2)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [m2] })

  // Old turn finishes while fork is still awaiting!
  dmA.status = 'idle'
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Finished mid-fork.' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  await waitFor(() => typeof releaseFork === 'function')
  releaseFork()
  await waitFor(() => env.rt.botOf('a').sessionId === 'fork-1'
    && env.agentMap.get('fork-1')?.followups.filter(m => m.source?.kind === 'user').length === 2
    && env.rt.botOf('a').tasks[0]?.status === 'completed'
    && env.agentMap.get('fork-1')?.followups.some(m => m.source?.role === 'task-report'))

  assert.equal(env.forkedCalls.length, 1, 'two rapid messages must trigger only one fork')
  assert.deepEqual(
    env.agentMap.get('fork-1').followups.filter(m => m.source?.kind === 'user').map(m => m.content[0].text),
    ['First msg', 'Second msg'],
  )
  assert.equal(env.rt.botOf('a').tasks[0].status, 'completed', 'turn finished mid-fork must still settle cleanly')
  assert.ok(env.agentMap.get('fork-1').followups.some(m => m.source?.role === 'task-report' && m.content[0].text.includes('Finished mid-fork.')))
})

test('client indexRoster indexes task sessions so mainView auto-follows new foreground sessionId', () => {
  const roster = indexRoster({
    bots: [{
      id: 'a',
      name: 'Chief',
      sessionId: 'fork-1',
      tasks: [{ id: 'k_1', sessionId: 'dm-a', parts: ['dm-a-0'] }],
    }],
    rooms: [],
  })
  assert.equal(roster.byId['dm-a']?.id, 'a')
  assert.equal(roster.byId['dm-a-0']?.id, 'a')
  assert.equal(roster.byId['fork-1']?.id, 'a')
})

test('P0 #1/#2/#3: task-handoff before user message preserves turns.js userAnswered, historyEntry skip, and IM isolation', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  let userAnsweredCount = 0
  const origUserAnswered = env.rt.userAnswered
  env.rt.userAnswered = (botId) => { userAnsweredCount += 1; return origUserAnswered?.(botId) }
  let clearedOriginFor
  const origClear = env.rt.clearImOrigin
  env.rt.clearImOrigin = (sid) => { clearedOriginFor = sid; return origClear?.(sid) }

  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'New question' }], requestId: 'req-im' })
  assert.equal(clearedOriginFor, 'dm-a', 'moving foreground into background task must clear live IM origin on oldSid')

  const freshSid = env.rt.botOf('a').sessionId
  const fresh = env.agentMap.get(freshSid)
  const handoffMsg = fresh.injected[0]
  assert.equal(handoffMsg.source.role, 'task-handoff')

  // Simulate real DSH next-step before next-turn order: task-handoff arrives FIRST in turn 1!
  await env.emit(freshSid, 'turn/start', { turn: 1 })
  await env.emit(freshSid, 'user/message', { content: handoffMsg.content, source: handoffMsg.source })
  assert.equal(env.rt.live.get(freshSid).info, undefined, 'task-handoff must not claim turn or set entry.info')
  assert.equal(env.rt.live.get(freshSid).opened, false, 'task-handoff must not mark turn opened')
  await env.emit(freshSid, 'user/message', { content: [{ type: 'text', text: 'New question' }], source: { kind: 'user' } })
  await env.emit(freshSid, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Foreground answer' }] } })
  await env.emit(freshSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.equal(userAnsweredCount, 1, 'userAnswered must still fire when task-handoff preceded the user message')
  const entry = env.rt.historyEntry({ type: 'user/message', data: { content: handoffMsg.content, source: handoffMsg.source } }, false)
  assert.equal(entry.text, '', 'historyEntry must skip task-handoff text')
})

test('P0 #4: sendUser initiating handoff drains concurrent Desktop spliced message onto new foreground', async (t) => {
  let releaseFork
  const env = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  // Mobile/IM sendUser starts the handoff first.
  const sendPromise = env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'From mobile' }], requestId: 'mob-1' })

  // Before fork resolves, Desktop user also sends a message to dm-a.
  const desktopMsg = { id: 'desk-1', role: 'user', content: [{ type: 'text', text: 'From desktop concurrently' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(desktopMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [desktopMsg] })
  assert.equal(dmA.inbox.nextStep.length, 0, 'Desktop message must be pulled from busy inbox')

  await waitFor(() => typeof releaseFork === 'function')
  releaseFork()
  await sendPromise
  await waitFor(() => env.agentMap.get('fork-1')?.followups.some(m => m.content?.[0]?.text === 'From desktop concurrently'))

  assert.equal(env.prompts[0].sessionId, 'fork-1')
  assert.ok(env.agentMap.get('fork-1').followups.some(m => m.content?.[0]?.text === 'From desktop concurrently'), 'concurrent Desktop message must not be silently dropped')
})

test('P0 #5: failed pre-commit fork restores pulled message with wakeup=true without infinite re-interception', async (t) => {
  const env = await startEnv({
    forkImpl: async () => { throw new Error('simulated fork failure') },
  })
  t.after(env.stop)
  // Also make createSession fail so forkForegroundPart itself rejects pre-commit.
  env.ctx.sessionController.create = async () => { throw new Error('simulated create failure') }

  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'idle'
  const sendCalls = []
  dmA.send = (msg, target, wakeup) => {
    sendCalls.push({ msg, target, wakeup })
    dmA.inbox.append(target, msg)
    // Simulate DSH emitting session/event then agent/inbox/inserted synchronously on send() — must NOT infinite-loop!
    dmA.session._appending = true
    try {
      for (const listener of env.ctx.listeners.get('session/event') ?? []) {
        if (listener.length >= 2) listener(dmA.session, { type: 'agent/inbox/spliced', data: { target, inserted: [msg] } })
      }
    } finally {
      dmA.session._appending = false
    }
    for (const listener of env.ctx.listeners.get('agent/inbox/inserted') ?? []) {
      listener({ agent: dmA, message: msg })
    }
  }

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  const msg = { id: 'u-restore-1', role: 'user', content: [{ type: 'text', text: 'Do not lose me' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(msg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [msg] })
  await waitFor(() => sendCalls.length > 0)

  assert.equal(sendCalls.length, 1, 'restored message must be sent back exactly once with no re-interception loop')
  assert.equal(sendCalls[0].wakeup, true, 'restored message must pass wakeup=true so an idle Agent still wakes')
  assert.equal(dmA.inbox.nextStep.length, 1)
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a')
})

test('P0 #6: post-handoff polling gap redirects stale Desktop message from background task to new foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Trigger handoff' }] })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // Desktop tab hasn't polled roster yet and sends a user message to stale dm-a (now in taskOwners).
  const staleMsg = { id: 'u-stale-1', role: 'user', content: [{ type: 'text', text: 'Sent during polling gap' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(staleMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [staleMsg] })
  await waitFor(() => env.agentMap.get('fork-1')?.followups.some(m => m.content?.[0]?.text === 'Sent during polling gap'))

  assert.equal(dmA.inbox.nextStep.length, 0, 'message must be removed from background task inbox')
  assert.ok(env.agentMap.get('fork-1').followups.some(m => m.content?.[0]?.text === 'Sent during polling gap'))
})

test('P0 #7: stopping a running bot-handoff task sends exactly ONE reply to the asking Bot', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  // Simulate real DSH agent.cancel emitting turn/end (aborted).
  const origCancel = dmB.cancel
  dmB.cancel = (cause) => {
    origCancel(cause)
    dmB.status = 'idle'
    void env.emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: cause } })
  }

  env.rt.openWork('w-run-1', { from: 'a', to: 'b' })
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'user/message', {
    content: [{ type: 'text', text: 'Check logs' }],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w-run-1', senderSessionId: 'a', senderName: 'Chief' },
  })
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  // Move running peer turn to background.
  await env.rt.sendUser({ sessionId: 'dm-b', content: [{ type: 'text', text: 'Hi Helper' }] })
  const task = env.rt.botOf('b').tasks[0]
  assert.equal(task.origin, 'bot-handoff')

  // Stop the still-running bot-handoff task.
  await env.rt.stopTask('b', task.id)
  await waitFor(() => env.deliveries.some(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === 'w-run-1'))
  await new Promise(r => setTimeout(r, 30))

  const replies = env.deliveries.filter(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === 'w-run-1')
  assert.equal(replies.length, 1, 'stopping a running bot-handoff task must send exactly one reply, never two')
})

test('P0 #8: spawnBotHandoffTask failure in openTaskPart or deliver leaks zero works and sends no duplicate reply', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  // Case 1: openTaskPart fails -> zero leaked entries in state.works.
  const origOpenTaskPart = env.rt.openTaskPart
  env.rt.openTaskPart = async () => { throw new Error('disk full during openTaskPart') }
  await assert.rejects(
    () => env.tool('message_bot').execute({ to: 'Helper', message: 'Work 1' }, execOf(dmA)),
    /disk full during openTaskPart/,
  )
  assert.equal(Object.keys(env.rt.state.works).length, 0, 'failed openTaskPart must not leak state.works')

  // Case 2: deliver fails -> forgetDelivery + dropWork + zero duplicate async reply.
  env.rt.openTaskPart = origOpenTaskPart
  const forgotten = []
  const origForget = env.rt.forgetDelivery
  env.rt.forgetDelivery = (id) => { forgotten.push(id); return origForget?.(id) }
  env.rt.deliver = async () => { throw new Error('delivery exploded') }
  await assert.rejects(
    () => env.tool('message_bot').execute({ to: 'Helper', message: 'Work 2' }, execOf(dmA)),
    /delivery exploded/,
  )
  assert.equal(Object.keys(env.rt.state.works).length, 0, 'failed deliver must drop state.works')
  assert.equal(forgotten.length, 1, 'failed deliver must call forgetDelivery to avoid ghost inflight replay')
  assert.equal(env.deliveries.filter(d => d.toId === 'a' && d.role === 'reply').length, 0, 'failed deliver must not also send an async failure reply')
})

test('post-fork race inspects turn/end error reason and skips still-running notice', async (t) => {
  let releaseFork
  const env = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  const p = env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Next' }] })

  // Old turn errors while fork is awaiting!
  dmA.status = 'idle'
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 busy' } } })

  await waitFor(() => typeof releaseFork === 'function')
  releaseFork()
  await p
  await waitFor(() => env.rt.botOf('a').tasks[0]?.status === 'failed')

  assert.equal(env.rt.botOf('a').tasks[0].status, 'failed', 'failed mid-fork turn must settle as failed, not completed')
  assert.equal(env.agentMap.get('fork-1').injected.length, 0, 'already-finished mid-fork turn must not inject a still-running notice')
})


test('double successive foreground handoff reports task 1 to the latest foreground, migrates schedules, and keeps earlier bot.segments in partsOfThread', async (t) => {
  const env = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', segments: [{ sessionId: 'dm-a-p1', endedAt: 10 }], createdAt: 1 },
      },
    }),
  })
  t.after(env.stop)

  const movedSchedules = []
  env.rt.moveSchedules = async (from, to) => { movedSchedules.push([from, to]) }

  // Turn 1 on dm-a gets interrupted -> moves into task 1, foreground becomes fork-1.
  env.agentMap.get('dm-a').status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Task 2 work' }] })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // Moved task 1 keeps earlier bot.segments in partsOfThread (part 1 = dm-a-p1, part 2 = dm-a).
  const parts = env.rt.partsOfThread('a', 'dm-a')
  assert.deepEqual(parts.map(p => p.sessionId), ['dm-a-p1', 'dm-a'])

  // Turn 2 on fork-1 ALSO gets interrupted -> moves into task 2, foreground becomes fork-2.
  env.agentMap.get('fork-1').status = 'running'
  await env.emit('fork-1', 'turn/start', { turn: 1 })
  await env.emit('fork-1', 'tool/call', { callId: 'tc2', name: 'bash', arguments: '{}' })
  await env.rt.sendUser({ sessionId: 'fork-1', content: [{ type: 'text', text: 'Task 3 work' }] })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-2')
  assert.deepEqual(movedSchedules, [['dm-a', 'fork-1'], ['fork-1', 'fork-2']])

  // Now task 1 (whose `from` was 'fork-1', now task 2!) finishes: its report MUST go to latest foreground 'fork-2', NOT task 2!
  env.agentMap.get('dm-a').status = 'idle'
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Task 1 result' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.sessionId, 'fork-2', 'first fg-handoff task must report to latest foreground fork-2, not second task fork-1')
})

test('long (>20k) completed bot-handoff reply holding attachLong does NOT trigger false stopped fallback', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  // Hold attachLong unresolved only for the >20k reply (not the short incoming request).
  let releaseAttach
  const origAttachLong = env.rt.attachLong
  env.rt.attachLong = async (text, name) => {
    if (text.length <= 20_000) return origAttachLong(text, name)
    return new Promise((resolve) => {
      releaseAttach = () => resolve({ text: text.slice(0, 100), files: [], length: text.length })
    })
  }

  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  const res = await env.tool('message_bot').execute({ to: 'Helper', message: 'Long audit' }, execOf(dmA))
  assert.match(res, /background task/)
  const task = env.rt.botOf('b').tasks[0]
  const taskSid = task.sessionId

  await env.emit(taskSid, 'turn/start', { turn: 1 })
  await env.emit(taskSid, 'user/message', {
    content: [{ type: 'text', text: 'Long audit' }],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: task.exchangeId, senderSessionId: 'a', senderName: 'Chief' },
  })
  const longText = 'X'.repeat(25_000)
  await env.emit(taskSid, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] } })
  await env.emit(taskSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => task.status === 'completed')

  // While attachLong is still pending, zero false "stopped" replies must have been sent!
  assert.equal(env.deliveries.filter(d => d.toId === 'a' && d.role === 'reply').length, 0)

  // Release attachLong -> single real reply lands cleanly.
  releaseAttach()
  await waitFor(() => env.deliveries.some(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId))
  const replies = env.deliveries.filter(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId)
  assert.equal(replies.length, 1)
  assert.ok(!replies[0].text.includes('was stopped'))
})

test('forwardPulledMessages retries transient resolveAgent failure without dropping or duplicating messages', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  let resolveAttempts = 0
  const origResolve = env.rt.resolveAgent
  env.rt.resolveAgent = async (sid) => {
    if (sid === 'fork-1') {
      resolveAttempts += 1
      if (resolveAttempts === 2) throw new Error('transient resolve failure')
    }
    return origResolve(sid)
  }

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  const msg = { id: 'u-retry-1', role: 'user', content: [{ type: 'text', text: 'Survive transient error' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(msg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [msg] })
  await waitFor(() => env.agentMap.get('fork-1')?.followups.some(m => m.content?.[0]?.text === 'Survive transient error'))

  const delivered = env.agentMap.get('fork-1').followups.filter(m => m.content?.[0]?.text === 'Survive transient error')
  assert.equal(delivered.length, 1, 'retried message must arrive exactly once')
})

test('plugin reload (adoptLiveWork) on running bot-handoff task restores routing and delivers single real reply', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  const res = await env.tool('message_bot').execute({ to: 'Helper', message: 'Audit after reload' }, execOf(dmA))
  assert.match(res, /background task/)
  const task = env.rt.botOf('b').tasks[0]
  const taskSid = task.sessionId
  const taskAgent = env.agentMap.get(taskSid)
  taskAgent.status = 'running'
  // Simulate turn/start + request consumed BEFORE plugin reload, then clear in-memory `rt.live` as reload does!
  await env.emit(taskSid, 'turn/start', { turn: 1 })
  env.rt.live.clear()
  env.agentMap.list = () => [...env.agentMap.values()]

  await env.rt.adoptLiveWork()
  assert.equal(env.rt.live.get(taskSid)?.info?.exchangeId, task.exchangeId, 'adoptLiveWork must restore bot-handoff routing info')

  // Task finishes after reload -> turns.js delivers the real reply and closes work!
  taskAgent.status = 'idle'
  await env.emit(taskSid, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Audit complete.' }] } })
  await env.emit(taskSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId))

  const replies = env.deliveries.filter(d => d.toId === 'a' && d.role === 'reply' && d.replyTo === task.exchangeId)
  assert.equal(replies.length, 1)
  assert.match(replies[0].text, /Audit complete\./)
  assert.equal(env.rt.state.works[task.exchangeId], undefined, 'work must be closed after adopted reply delivery')
})

test('fg-handoff snapshots inheritedSegments so foreground rollover never shifts task anchors', async (t) => {
  const env = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', segments: [{ sessionId: 'dm-a-p1', endedAt: 10 }], createdAt: 1 },
      },
    }),
  })
  t.after(env.stop)

  env.agentMap.get('dm-a').status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'New fg work' }] })

  const bot = env.rt.botOf('a')
  assert.deepEqual(env.rt.partsOfThread('a', 'dm-a').map(p => p.sessionId), ['dm-a-p1', 'dm-a'])

  // 1) Foreground rolls over (adds a new segment to bot.segments): task anchors MUST NOT shift!
  bot.segments.push({ sessionId: 'fork-1', endedAt: 20 })
  bot.sessionId = 'fg-p3'
  assert.deepEqual(env.rt.partsOfThread('a', 'dm-a').map(p => p.sessionId), ['dm-a-p1', 'dm-a'])

  // 2) User opens a fresh parallel thread (clears bot.segments): task STILL keeps its frozen inherited snapshot!
  bot.segments = []
  assert.deepEqual(env.rt.partsOfThread('a', 'dm-a').map(p => p.sessionId), ['dm-a-p1', 'dm-a'])
})
