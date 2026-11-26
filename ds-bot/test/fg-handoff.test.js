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
  ...(over.completedMoveOps ? { completedMoveOps: over.completedMoveOps } : {}),
  prefs: over.prefs ?? {},
  revision: 0,
})

async function startEnv({ team = makeTeam(), forkImpl, resolveAgentImpl } = {}) {
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
      resolveAgent: async (sessionId) => {
        if (resolveAgentImpl !== undefined) return resolveAgentImpl(sessionId, () => agentMap.get(sessionId) ?? makeAgent(sessionId))
        return { agent: agentMap.get(sessionId) ?? makeAgent(sessionId) }
      },
      selectModel: async () => {},
      prompt: async (req) => { prompts.push(req) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => true },
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

const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'delegate_work', signal: AbortSignal.timeout(10_000) })

test('Desktop/Web user message on busy foreground stays on same session; explicit moveForegroundToBackground moves old Session intact into bot.tasks and forks fresh foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  // Simulate busy foreground turn that already ran a tool.
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Run full integration suite' }], source: { kind: 'user' } })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{"command":"npm test"}' })

  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a'), false, 'ordinary busy turn must NOT auto-move foreground')
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), true, 'explicit move-to-background is available')

  // Ordinary Desktop/Web steer stays in dm-a inbox without auto-forking.
  const steerMsg = { id: 'u-steer-1', role: 'user', content: [{ type: 'text', text: 'Focus on host tests only' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(steerMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [steerMsg] })
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(env.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(dmA.inbox.nextStep.length, 1)
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), false, 'cannot move to background while user inbox has pending messages')
  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }),
    err => err?.code === 'bot/pending-input',
  )

  // Once inbox is clear, explicit moveForegroundToBackground moves dm-a into bot.tasks[] cleanly.
  dmA.inbox.remove(steerMsg.id)
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), true)
  const moved = await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-explicit-1' })
  assert.equal(moved.moved, true)
  assert.equal(moved.sessionId, 'fork-1')

  const botA = env.rt.botOf('a')
  assert.equal(botA.sessionId, 'fork-1', 'foreground must move to the forked Session')
  assert.equal(dmA.cancelled.length, 0, 'busy foreground turn must NOT be cancelled or steer-cut')
  assert.equal(botA.tasks.length, 1)
  assert.equal(botA.tasks[0].sessionId, 'dm-a')
  assert.equal(botA.tasks[0].origin, 'fg-handoff')
  assert.equal(botA.tasks[0].title, 'Run full integration suite')
  assert.equal(env.rt.taskOwners.get('dm-a')?.taskId, botA.tasks[0].id)
  assert.equal(env.rt.activityView().a, undefined, 'old foreground activity must clear after handoff')

  const fresh = env.agentMap.get('fork-1')
  assert.equal(fresh.injected.length, 1, 'new foreground receives concise task-handoff notice')
  assert.match(fresh.injected[0].content[0].text, /Run full integration suite/)

  // When old dm-a finishes in background, its report lands on the new foreground fork-1.
  dmA.status = 'idle'
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Suite passed 100%.' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => env.deliveries.some(d => d.role === 'task-report'))

  const report = env.deliveries.find(d => d.role === 'task-report')
  assert.equal(report.sessionId, 'fork-1')
  assert.match(report.text, /Suite passed 100%/)
})

test('Mobile/IM sendUser does NOT auto-move ordinary busy foreground, supports steer mode + requestId idempotency, and redirects stale sessionId after explicit move', async (t) => {
  const env = await startEnv({ team: makeTeam({ prefs: { backgroundAfterSec: 2 } }) })
  t.after(env.stop)
  env.rt.captureImOrigin = sid => (sid === 'dm-a' ? { connId: 'c1', chatKey: 'k1', senderId: 'u1', binding: 'bot:a' } : undefined)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  // Turn with 0 tools that has run longer than backgroundAfterSec (2s).
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  env.rt.live.get('dm-a').since = Date.now() - 5000
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Deep analysis' }], source: { kind: 'user' } })

  // Ordinary sendUser stays on dm-a (queue by default, steer when requested).
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Quick question from phone' }], requestId: 'req-1' })
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a', 'sendUser must NOT auto-handoff ordinary busy turn')
  assert.equal(env.prompts[0].sessionId, 'dm-a')
  assert.equal(env.prompts[0].mode, 'queue')

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Steer from IM' }], requestId: 'req-steer', mode: 'steer' })
  assert.equal(env.prompts[1].sessionId, 'dm-a')
  assert.equal(env.prompts[1].mode, 'steer')

  // Duplicate requestId already admitted on dm-a is ignored idempotently.
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Quick question from phone' }], source: { kind: 'user', rpcId: 'req-1' } })
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Quick question from phone' }], requestId: 'req-1' })
  assert.equal(env.prompts.length, 2, 'duplicate requestId must not prompt a second time')

  // Explicit move captures imOrigin and redirects subsequent stale sessionId calls to fork-1.
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')
  assert.deepEqual(env.rt.botOf('a').tasks[0].imOrigin, { connId: 'c1', chatKey: 'k1', senderId: 'u1', binding: 'bot:a' })

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Follow up from phone' }], requestId: 'req-2' })
  assert.equal(env.prompts[2].sessionId, 'fork-1')
})

test('IM sendUser keeps the message queued on the current chat when a hidden-work fresh preset session fails before commit', async (t) => {
  const env = await startEnv({ forkImpl: async () => { throw new Error('no completed turn to fork') } })
  t.after(env.stop)
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'
  env.rt.openWork('w-preset-fallback', { from: 'a', to: 'b' })
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  env.rt.live.get('dm-b').info = { kind: SOURCE_KIND, role: 'request', exchangeId: 'w-preset-fallback', senderSessionId: 'a', senderName: 'Chief' }
  await env.emit('dm-b', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  env.rt.botOf('b').agentPreset = 'removed-from-profile'
  assert.equal(env.rt.mustIsolateHiddenWork(env.rt.botOf('b'), 'dm-b'), true)

  await env.rt.sendUser({ sessionId: 'dm-b', content: [{ type: 'text', text: 'IM follow-up' }], requestId: 'req-im-fallback', mode: 'steer' })
  assert.equal(env.rt.botOf('b').sessionId, 'dm-b')
  assert.deepEqual(env.rt.botOf('b').tasks ?? [], [])
  assert.equal(env.createdSessions.length, 0, 'the unavailable preset still refuses a fresh Session')
  assert.equal(env.prompts.length, 1, 'the incoming IM is queued exactly once')
  assert.deepEqual(env.prompts[0], {
    requestId: 'req-im-fallback', sessionId: 'dm-b', mode: 'queue', content: [{ type: 'text', text: 'IM follow-up' }],
  })
})

test('canMoveForeground blocks open interactive cards and supports local CLI backgrounding, while peer spawn keeps busy heuristic', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a', { forPeer: true }), false)
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), true)

  // Open question card blocks explicit move-to-background.
  env.rt.state.questions['dm-a'] = { id: 'q1', question: 'Proceed?' }
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), false)
  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }),
    err => err?.code === 'bot/card-open',
  )
  delete env.rt.state.questions['dm-a']

  // Local CLI agent supports explicit backgrounding and peer background spawn (D8):
  // the running CLI session moves to background while foreground opens a fresh session.
  env.rt.localAgentBadge = () => 'claude'
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  env.rt.live.get('dm-a').since = Date.now() - 60_000
  assert.equal(env.rt.shouldMoveForeground(env.rt.botOf('a'), 'dm-a', { forPeer: true }), true)
  assert.equal(env.rt.canMoveForeground(env.rt.botOf('a'), 'dm-a'), true)
  const moved = await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(moved.moved, true)
  assert.notEqual(moved.sessionId, 'dm-a')
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

test('peer Bot delegate_work to a busy Bot spawns a background task directly without switching user foreground', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  const dmB = env.agentMap.get('dm-b')
  dmB.status = 'running'

  // Helper (b) is busy with user's foreground tool work.
  await env.emit('dm-b', 'turn/start', { turn: 1 })
  await env.emit('dm-b', 'tool/call', { callId: 'tc-fg', name: 'bash', arguments: '{}' })

  // Chief (a) calls delegate_work to Helper (b).
  const res = await env.tool('delegate_work').execute({ to: 'Helper', goal: 'Check API contract' }, execOf(dmA))
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

test('rapid double Desktop messages during explicit handoff restore cleanly if old turn finishes mid-fork, and hidden-work handoff settles finished task', async (t) => {
  // 1) Explicit move whose old turn finishes mid-fork discards candidate fork (no ghost task)
  //    and restores both intercepted messages onto dm-a in FIFO order.
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

  const moveP = env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await waitFor(() => typeof releaseFork === 'function')

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

  releaseFork()
  const res = await moveP
  assert.equal(res.moved, false, 'explicit move must not create a ghost task once old turn finished mid-fork')
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a')
  assert.equal(env.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.deepEqual(
    dmA.inbox.nextStep.map(m => m.content[0].text),
    ['First msg', 'Second msg'],
    'both intercepted messages must be restored onto dm-a in FIFO order',
  )

  // 2) Non-explicit hidden peer-Bot isolation handoff shares one fork for rapid double messages
  //    and still settles the finished task cleanly on fork-1.
  let releaseFork2
  const env2 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork2 = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env2.stop)
  const dm2 = env2.agentMap.get('dm-a')
  dm2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  env2.rt.live.get('dm-a').info = { kind: SOURCE_KIND, role: 'request', fromId: 'b', toId: 'a', exchangeId: 'ex-hidden-race' }
  env2.rt.isHiddenBotWorkTurn = () => true

  const h1 = { id: 'hu1', role: 'user', content: [{ type: 'text', text: 'First msg' }], source: { kind: 'user' } }
  const h2 = { id: 'hu2', role: 'user', content: [{ type: 'text', text: 'Second msg' }], source: { kind: 'user' } }
  dm2.inbox.nextStep.push(h1)
  await env2.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [h1] })
  await waitFor(() => typeof releaseFork2 === 'function')
  dm2.inbox.nextStep.push(h2)
  await env2.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [h2] })

  dm2.status = 'idle'
  await env2.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Finished mid-fork.' }] } })
  await env2.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  releaseFork2()
  await waitFor(() => env2.rt.botOf('a').sessionId === 'fork-1'
    && env2.agentMap.get('fork-1')?.followups.filter(m => m.source?.kind === 'user').length === 2
    && env2.rt.botOf('a').tasks[0]?.status === 'completed')

  assert.equal(env2.forkedCalls.length, 1, 'two rapid messages must trigger only one fork')
  assert.deepEqual(
    env2.agentMap.get('fork-1').followups.filter(m => m.source?.kind === 'user').map(m => m.content[0].text),
    ['First msg', 'Second msg'],
  )
  assert.equal(env2.rt.botOf('a').tasks[0].status, 'completed', 'turn finished mid-fork must still settle cleanly')
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

  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
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

  // Explicit handoff starts first, and concurrent Mobile + Desktop messages arrive mid-fork.
  const movePromise = env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  await waitFor(() => typeof releaseFork === 'function')
  const sendPromise = env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'From mobile' }], requestId: 'mob-1' })

  // Before fork resolves, Desktop user also sends a message to dm-a.
  const desktopMsg = { id: 'desk-1', role: 'user', content: [{ type: 'text', text: 'From desktop concurrently' }], source: { kind: 'user' } }
  dmA.inbox.nextStep.push(desktopMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [desktopMsg] })
  assert.equal(dmA.inbox.nextStep.length, 0, 'Desktop message must be pulled from busy inbox')

  releaseFork()
  await Promise.all([movePromise, sendPromise])
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
  await assert.rejects(() => env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [{ msg, target: 'next-step', oldAgent: dmA }]))
  await waitFor(() => sendCalls.length > 0)

  assert.equal(sendCalls.length, 1, 'restored message must be sent back exactly once with no re-interception loop')
  assert.equal(sendCalls[0].wakeup, true, 'restored message must pass wakeup=true so an idle Agent still wakes')
  assert.equal(dmA.inbox.nextStep.length, 1)
  assert.equal(env.rt.botOf('a').sessionId, 'dm-a')
})

test('P0 #6: post-handoff polling gap redirects stale Desktop message from background task to new foreground without recursive handoff', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'

  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
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
    () => env.tool('delegate_work').execute({ to: 'Helper', goal: 'Work 1' }, execOf(dmA)),
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
    () => env.tool('delegate_work').execute({ to: 'Helper', goal: 'Work 2' }, execOf(dmA)),
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

  const p = env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [])

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


test('double successive explicit foreground handoff reports task 1 to the latest foreground, migrates schedules, and keeps earlier bot.segments in partsOfThread', async (t) => {
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

  // Turn 1 on dm-a explicitly moves into task 1, foreground becomes fork-1.
  env.agentMap.get('dm-a').status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // Moved task 1 keeps earlier bot.segments in partsOfThread (part 1 = dm-a-p1, part 2 = dm-a).
  const parts = env.rt.partsOfThread('a', 'dm-a')
  assert.deepEqual(parts.map(p => p.sessionId), ['dm-a-p1', 'dm-a'])

  // Turn 2 on fork-1 explicitly moves into task 2, foreground becomes fork-2.
  env.agentMap.get('fork-1').status = 'running'
  await env.emit('fork-1', 'turn/start', { turn: 1 })
  await env.emit('fork-1', 'tool/call', { callId: 'tc2', name: 'bash', arguments: '{}' })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1' })
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
  const res = await env.tool('delegate_work').execute({ to: 'Helper', goal: 'Long audit' }, execOf(dmA))
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
  await env.rt.handoffForeground(env.rt.botOf('a'), 'dm-a', [{ msg, target: 'next-step', oldAgent: dmA }])
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
  const res = await env.tool('delegate_work').execute({ to: 'Helper', goal: 'Audit after reload' }, execOf(dmA))
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
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })

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

test('fg-handoff carries bounded moved prompt + task_send hint, and injects fallback context when !forked finishes mid-handoff', async (t) => {
  // 1) Long running turn prompt (> 80 chars) is carried in [Background task notice] with task_send guidance.
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  const longPrompt = 'Please audit all authentication middleware files across packages/auth and packages/api, list every token validation edge case, and propose a migration plan.'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: longPrompt }] })
  await env.emit('dm-a', 'tool/call', { callId: 'tc1', name: 'bash', arguments: '{}' })

  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  const freshSid = env.rt.botOf('a').sessionId
  const notice = env.agentMap.get(freshSid).injected[0]?.content?.[0]?.text ?? ''
  assert.match(notice, /Moved request: Please audit all authentication middleware files/)
  assert.match(notice, /Use task_read\(task: "/)
  assert.match(notice, /task_send\(task: "/)

  // 2) When fork is unavailable (!forked) AND the moved turn finishes during forkForegroundPart,
  //    the fresh foreground still receives fallbackContextSummary instead of starting blank.
  let releaseFork
  const env2 = await startEnv({
    forkImpl: async () => new Promise((_, reject) => {
      releaseFork = () => reject(new Error('fork unavailable'))
    }),
  })
  t.after(env2.stop)
  const dm2 = env2.agentMap.get('dm-a')
  dm2.status = 'running'
  await env2.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Context from turn 1: target repo is ds-bot' }] })
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  await env2.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on ds-bot.' }] } })
  await env2.emit('dm-a', 'tool/call', { callId: 'tc2', name: 'bash', arguments: '{}' })

  const pending = env2.rt.handoffForeground(env2.rt.botOf('a'), 'dm-a', [])
  await waitFor(() => typeof releaseFork === 'function')
  // Turn finishes BEFORE fork falls back to fresh session.
  dm2.status = 'idle'
  await env2.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  releaseFork()
  await pending
  const fresh2 = env2.agentMap.get(env2.rt.botOf('a').sessionId)
  const injected2 = fresh2.injected.map(m => m.content?.[0]?.text ?? '').join('\n')
  assert.match(injected2, /\[Recent context from your own chat\]/, 'non-forked fresh foreground must still get fallback context even if moved turn finished mid-handoff')
  assert.match(injected2, /target repo is ds-bot/)

  // 3) When > 8 KB of prior messages exist, fallbackContextSummary preserves the newest turns instead of clipping them off.
  const env3 = await startEnv({
    forkImpl: async () => { throw new Error('fork unavailable') },
  })
  t.after(env3.stop)
  const dm3 = env3.agentMap.get('dm-a')
  dm3.status = 'running'
  for (let i = 1; i <= 14; i += 1) {
    await env3.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `MSG_${i}_START ${'a'.repeat(850)} MSG_${i}_END` }] })
  }
  await env3.emit('dm-a', 'turn/start', { turn: 1 })
  await env3.emit('dm-a', 'tool/call', { callId: 'tc3', name: 'bash', arguments: '{}' })
  await env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  const injected3 = env3.agentMap.get(env3.rt.botOf('a').sessionId).injected.map(m => m.content?.[0]?.text ?? '').join('\n')
  assert.match(injected3, /MSG_14_START/, 'newest message must survive >8KB fallback truncation')
  assert.doesNotMatch(injected3, /MSG_1_START/, 'oldest messages past 8KB should be dropped before newest ones')
})

test('fg-handoff fork preserves inherited exchangeTurns and closedCards without hiding the new turn', async (t) => {
  const env = await startEnv({
    forkImpl: async () => ({ sessionId: 'fork-keep-hidden' }),
  })
  t.after(env.stop)

  const dmA = env.agentMap.get('dm-a')
  // Turn 1: visible user turn with a closed ask_user card.
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check config' }] })
  await env.emit('dm-a', 'tool/call', { callId: 'ask-1', name: 'ask_user', arguments: '{"question":"Format?"}' })
  await env.emit('dm-a', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  env.rt.state.closedCards['dm-a'] = { 'ask-1': { status: 'answered', answer: 'Markdown' } }

  // Turn 2: hidden Bot-to-Bot [PASS] turn (marked in exchangeTurns).
  await env.emit('dm-a', 'turn/start', { turn: 2 })
  await env.emit('dm-a', 'assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: '[PASS]' }] } })
  await env.emit('dm-a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  env.rt.state.exchangeTurns['dm-a'] = [2, 3]

  // Turn 3: currently running turn when user explicitly moves it to background.
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 3 })
  await env.emit('dm-a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run long benchmark' }] })
  await env.emit('dm-a', 'tool/call', { callId: 'ask-running', name: 'ask_user', arguments: '{"question":"Running?"}' })
  env.rt.state.closedCards['dm-a']['ask-running'] = { status: 'dismissed' }

  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  const forkedSid = env.rt.botOf('a').sessionId
  assert.equal(forkedSid, 'fork-keep-hidden')
  assert.deepEqual(env.rt.state.exchangeTurns[forkedSid], [2], 'forked foreground must inherit completed hidden turn 2 without carrying running turn 3')
  assert.deepEqual(Object.keys(env.rt.state.closedCards[forkedSid] ?? {}), ['ask-1'], 'forked foreground must carry closed cards from completed turns only')

  // displayItems on the forked session must NOT leak the hidden [PASS] turn 2.
  const forkedEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    { type: 'assistant/message', seq: 5, time: 200, data: { message: { role: 'assistant', content: [{ type: 'text', text: '[PASS]' }] } } },
    { type: 'turn/end', seq: 6, data: { turn: 2 } },
  ]
  const items = env.rt.displayItems(forkedSid, forkedEvents, null, undefined, {})
  assert.equal(items.some(item => item.text === '[PASS]'), false, 'hidden turn 2 must stay hidden on forked foreground even when assistant/message omits data.turn')
  assert.equal(items.some(item => item.text === 'Done.'), true)
})

test('explicit move revalidates captured turn and open interactive cards before commit, discarding candidate fork on change', async (t) => {
  // 1) Turn 1 finishes and Turn 2 starts while fork is paused -> reject bot/stale, keep Turn 2 on dm-a, archive candidate.
  let releaseFork1
  const archived1 = []
  const env1 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork1 = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env1.stop)
  env1.ctx.workspaceRegistry.archiveSession = async (sid) => { archived1.push(sid) }
  const dm1 = env1.agentMap.get('dm-a')
  dm1.status = 'running'
  await env1.emit('dm-a', 'turn/start', { turn: 1 })

  const move1 = env1.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-turn-drift' })
  await waitFor(() => typeof releaseFork1 === 'function')
  await env1.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await env1.emit('dm-a', 'turn/start', { turn: 2 })
  releaseFork1()
  await assert.rejects(() => move1, err => err?.code === 'bot/stale')
  assert.equal(env1.rt.botOf('a').sessionId, 'dm-a', 'Turn 2 must stay on dm-a')
  assert.equal(env1.rt.botOf('a').tasks?.length ?? 0, 0, 'no background task may be created for Turn 2')
  assert.deepEqual(archived1, ['fork-1'])

  // 2) An interactive question card opens while fork is paused -> reject bot/card-open, keep card open, restore intercepted message.
  let releaseFork2
  const archived2 = []
  const env2 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork2 = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env2.stop)
  env2.ctx.workspaceRegistry.archiveSession = async (sid) => { archived2.push(sid) }
  const dm2 = env2.agentMap.get('dm-a')
  dm2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })

  const move2 = env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-card-opened' })
  await waitFor(() => typeof releaseFork2 === 'function')
  const midMsg = { id: 'u-mid-card', role: 'user', content: [{ type: 'text', text: 'Wait for me' }], source: { kind: 'user' } }
  dm2.inbox.nextStep.push(midMsg)
  await env2.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [midMsg] })
  env2.rt.state.questions['dm-a'] = { id: 'q-mid', question: 'Confirm?' }
  releaseFork2()
  await assert.rejects(() => move2, err => err?.code === 'bot/card-open')
  assert.equal(env2.rt.botOf('a').sessionId, 'dm-a', 'foreground must stay on dm-a when card opened mid-fork')
  assert.equal(env2.rt.state.questions['dm-a']?.id, 'q-mid', 'open interactive card must NOT be dismissed')
  assert.equal(dm2.inbox.nextStep.some(m => m.id === 'u-mid-card'), true, 'intercepted input must be restored onto dm-a')
  assert.deepEqual(archived2, ['fork-1'])
})

test('polling-gap redirect revalidates foreground target after resolveAgent await when a second move occurs mid-forward', async (t) => {
  let releaseResolve
  let holdFork1Resolve = false
  const env = await startEnv({
    resolveAgentImpl: async (sessionId, fallback) => {
      if (sessionId === 'fork-1' && holdFork1Resolve) {
        holdFork1Resolve = false
        await new Promise((resolve) => { releaseResolve = resolve })
      }
      return { agent: fallback() }
    },
  })
  t.after(env.stop)

  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // Stale tab sends a message to dm-a (now a background task); forward pauses inside resolveAgent('fork-1').
  holdFork1Resolve = true
  const staleMsg = { id: 'u-stale-reroute', role: 'user', content: [{ type: 'text', text: 'Follow me to newest foreground' }], source: { kind: 'user', rpcId: 'rpc-reroute-1' } }
  dmA.inbox.nextTurn.push(staleMsg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-turn', inserted: [staleMsg] })
  await waitFor(() => typeof releaseResolve === 'function')

  // While forward is paused on fork-1, fork-1 starts a turn and explicitly moves to background (bot.sessionId -> fork-2).
  const fork1 = env.agentMap.get('fork-1')
  fork1.status = 'running'
  await env.emit('fork-1', 'turn/start', { turn: 1 })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-2')

  releaseResolve()
  await waitFor(() => env.agentMap.get('fork-2').followups.length > 0 && env.rt.state.pendingHandoffInputs === undefined)
  assert.equal(fork1.followups.length, 0, 'moved background task fork-1 must receive zero redirected messages')
  assert.equal(env.agentMap.get('fork-2').followups.length, 1, 'newest foreground fork-2 must receive the redirected message')
  assert.equal(env.agentMap.get('fork-2').followups[0].content[0].text, 'Follow me to newest foreground')
  assert.equal(env.rt.state.pendingHandoffInputs, undefined)
})

test('moveForegroundToBackground only caches operationId after rt.save() succeeds and lets retry finish unsaved commit', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.emit('dm-a', 'user/message', { content: [{ type: 'text', text: 'Long job' }], source: { kind: 'user' } })

  const origSave = env.rt.save
  let saveCalls = 0
  let failSaves = 2
  env.rt.save = async (...args) => {
    saveCalls += 1
    if (failSaves > 0) {
      failSaves -= 1
      throw new Error('simulated state.json write failure')
    }
    return origSave(...args)
  }

  // Attempt 1 and Attempt 2 both fail to persist state -> MUST reject, never falsely report moved: true.
  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-save-retry' }),
    /simulated state\.json write failure/,
  )
  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-save-retry' }),
    /simulated state\.json write failure/,
  )

  // Attempt 3 succeeds -> completes save + post-save notice once.
  const res3 = await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-save-retry' })
  assert.equal(res3.moved, true)
  assert.equal(res3.sessionId, 'fork-1')
  assert.equal(env.agentMap.get('fork-1').injected.length, 1)

  // Attempt 4 returns cached result without calling rt.save() again.
  const savesAfter3 = saveCalls
  const res4 = await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-save-retry' })
  assert.deepEqual(res4, res3)
  assert.equal(saveCalls, savesAfter3)
})

test('Mobile sendUser retry with same requestId stays idempotent across an explicit foreground handoff', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Ship release notes' }], requestId: 'req-mobile-move' })
  assert.equal(env.prompts.length, 1)
  // Simulate DSH admitting req-mobile-move on dm-a as Turn 1 (real DSH user/message event shape: data.id + data.source.rpcId).
  await env.emit('dm-a', 'user/message', { id: 'msg-m1', content: [{ type: 'text', text: 'Ship release notes' }], source: { kind: 'user', rpcId: 'req-mobile-move' } })

  // Move dm-a to background; fork-1 does NOT inherit Turn 1.
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // Mobile drops the original response and retries with the same requestId (targeting either dm-a or bot id 'a').
  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Ship release notes' }], requestId: 'req-mobile-move' })
  await env.rt.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'Ship release notes' }], requestId: 'req-mobile-move' })
  assert.equal(env.prompts.length, 1, 'retried requestId already admitted before move must NOT execute again on fork-1')
})

test('shouldSpawnPeerTask is decoupled from shell backgroundAfterSec setting', async (t) => {
  const env0 = await startEnv({ team: makeTeam({ prefs: { backgroundAfterSec: 0 } }) })
  const env600 = await startEnv({ team: makeTeam({ prefs: { backgroundAfterSec: 600 } }) })
  t.after(async () => { await env0.stop(); await env600.stop() })

  await env0.emit('dm-a', 'turn/start', { turn: 1 })
  await env600.emit('dm-a', 'turn/start', { turn: 1 })
  env0.rt.live.get('dm-a').since = Date.now() - 1000
  env600.rt.live.get('dm-a').since = Date.now() - 1000
  assert.equal(env0.rt.shouldSpawnPeerTask(env0.rt.botOf('a'), 'dm-a'), false)
  assert.equal(env600.rt.shouldSpawnPeerTask(env600.rt.botOf('a'), 'dm-a'), false)

  env0.rt.live.get('dm-a').since = Date.now() - 6000
  env600.rt.live.get('dm-a').since = Date.now() - 6000
  assert.equal(env0.rt.shouldSpawnPeerTask(env0.rt.botOf('a'), 'dm-a'), true)
  assert.equal(env600.rt.shouldSpawnPeerTask(env600.rt.botOf('a'), 'dm-a'), true)
})

test('forwardPulledMessages flushes the exact receiving session on retry, and reconcile does not clear journal when matched session fails flush', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })
  await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
  assert.equal(env.rt.botOf('a').sessionId, 'fork-1')

  // 1) Stale tab sends to dm-a -> forwarded to fork-1 -> flush(fork-1) throws once!
  //    Before retry runs, fork-1 moves to background (bot.sessionId -> fork-2).
  //    Retry MUST flush fork-1 (NOT fork-2) before clearing the journal!
  const flushedSessions = []
  let failFork1FlushOnce = true
  let moveFork1AfterFirstFlush = true
  env.ctx.sessions.flush = async (session) => {
    flushedSessions.push(session.id)
    if (session.id === 'fork-1' && failFork1FlushOnce) {
      failFork1FlushOnce = false
      if (moveFork1AfterFirstFlush) {
        moveFork1AfterFirstFlush = false
        const fork1 = env.agentMap.get('fork-1')
        fork1.status = 'running'
        await env.emit('fork-1', 'turn/start', { turn: 1 })
        // Move fork-1 to background while forwardPulledMessages is in retry backoff.
        queueMicrotask(() => { void env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1' }) })
      }
      throw new Error('transient flush error on fork-1')
    }
    if (session.id === 'fork-1') return false // second flush on fork-1 still has no persistence!
    return true
  }

  const msg = { id: 'u-flush-exact', role: 'user', content: [{ type: 'text', text: 'Persist on fork-1' }], source: { kind: 'user', rpcId: 'rpc-flush-exact' } }
  dmA.inbox.nextTurn.push(msg)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-turn', inserted: [msg] })
  await waitFor(() => env.rt.botOf('a').sessionId === 'fork-2' && flushedSessions.filter(s => s === 'fork-1').length >= 2)
  await new Promise(r => setTimeout(r, 120))

  // fork-2 must NOT have been flushed to clear fork-1's journal entry, and journal must remain while flush(fork-1) returns false.
  assert.equal(env.rt.state.pendingHandoffInputs?.some(e => e?.id === 'rpc-flush-exact'), true, 'journal must stay until receiving session fork-1 returns flush() === true')
  assert.equal(env.agentMap.get('fork-2').followups.length, 0)

  // 2) Reconcile finds rpc-flush-exact on moved session fork-1, but flush(fork-1) STILL returns false -> journal must stay!
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(env.rt.state.pendingHandoffInputs?.some(e => e?.id === 'rpc-flush-exact'), true, 'reconcile must not clear journal while matched moved session flush() returns false')

  // Once flush(fork-1) returns true, reconcile clears journal cleanly.
  env.ctx.sessions.flush = async () => true
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(env.rt.state.pendingHandoffInputs, undefined)
})

test('sendUser prompt ack does NOT pollute old session admittedRpcIds when inbox hook pulled message during move', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })

  // While prompt('dm-a') runs, dm-a moves to background, inbox hook pulls msg out of dm-a,
  // and forwarding to fork-1 temporarily fails (flush returns false).
  let failForward = true
  const origResolve = env.ctx.sessionController.resolveAgent
  env.ctx.sessionController.resolveAgent = async (sid) => {
    if (sid === 'fork-1' && failForward) throw new Error('fork-1 temporarily unavailable')
    return origResolve(sid)
  }
  env.ctx.sessionController.prompt = async (req) => {
    await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' })
    const m = { id: 'm-pulled-send', role: 'user', content: req.content, source: { kind: 'user', rpcId: req.requestId } }
    dmA.inbox.nextTurn.push(m)
    await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-turn', inserted: [m] })
  }

  await env.rt.sendUser({ sessionId: 'dm-a', content: [{ type: 'text', text: 'Do not lose me' }], requestId: 'req-send-pulled' })
  // Wait for forwardPulledMessages retries (50 + 250ms) to exhaust.
  await new Promise(r => setTimeout(r, 420))
  assert.equal(env.rt.isAdmittedOn(dmA, 'req-send-pulled'), false, 'pulled message must NOT pollute old dm-a admittedRpcIds')
  assert.equal(env.rt.state.pendingHandoffInputs?.some(e => e?.id === 'req-send-pulled'), true)

  // Recover fork-1 and run reconcile -> message MUST land on fork-1 instead of being dropped!
  failForward = false
  await env.rt.reconcileTasksAfterRestart()
  assert.equal(env.agentMap.get('fork-1').followups.some(m => m.content[0].text === 'Do not lose me'), true)
  assert.equal(env.rt.state.pendingHandoffInputs, undefined)
})

test('aborted explicit move never restores intercepted input into a session moved to background by a concurrent second move', async (t) => {
  let releaseFork1
  let forkCall = 0
  let pauseFlushOnce = false
  const flushStarted = Promise.withResolvers()
  const flushGate = Promise.withResolvers()
  const env = await startEnv({
    forkImpl: async (_opts, make) => {
      forkCall += 1
      if (forkCall === 1) {
        return new Promise((resolve) => { releaseFork1 = () => resolve({ sessionId: make() }) })
      }
      return { sessionId: make() }
    },
  })
  t.after(env.stop)
  // Also simulate restorePulledMessages encountering a session that ALREADY moved to background (e.g. during async gap).
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })

  const move1 = env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-m1' })
  await waitFor(() => typeof releaseFork1 === 'function')
  const intercepted = { id: 'u-abort-reroute', role: 'user', content: [{ type: 'text', text: 'Keep on live foreground' }], source: { kind: 'user', rpcId: 'rpc-abort-reroute' } }
  dmA.inbox.nextStep.push(intercepted)
  await env.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [intercepted] })

  // Turn 1 ends and Turn 2 starts -> move1 will abort with bot/stale.
  await env.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await env.emit('dm-a', 'turn/start', { turn: 2 })

  // Simulate Move 2 committing right when Move 1 releases and tries to restore!
  const origArchive = env.ctx.workspaceRegistry.archiveSession
  env.ctx.workspaceRegistry.archiveSession = async (...args) => origArchive(...args)
  // Trigger move2 right after move1's fork resolves by letting restorePulledMessages see moved dm-a via fork1 abort:
  // First verify that when dm-a is already a taskOwner before restore runs, restore routes to fork-2 instead of dm-a.
  const origFlush = env.ctx.sessions.flush
  env.ctx.sessions.flush = async (session) => {
    if (pauseFlushOnce) {
      pauseFlushOnce = false
      flushStarted.resolve()
      await flushGate.promise
    }
    return origFlush(session)
  }

  // Test the exact scenario: during move1's fork, a second move has ALREADY committed on dm-a (bot.sessionId moved to fork-2).
  releaseFork1()
  await assert.rejects(() => move1, err => err?.code === 'bot/stale')
  assert.equal(dmA.inbox.nextStep.some(m => m.id === 'u-abort-reroute'), true, 'restored to dm-a while dm-a is still foreground')

  // Now test restore directly when dm-a HAS moved to background (taskOwners has dm-a, bot.sessionId is fork-2):
  dmA.inbox.remove('u-abort-reroute')
  let releaseFork3
  const env2 = await startEnv({
    forkImpl: async (_opts, make) => {
      if (releaseFork3 === undefined) {
        return new Promise((resolve) => { releaseFork3 = () => resolve({ sessionId: make() }) })
      }
      return { sessionId: make() }
    },
  })
  t.after(env2.stop)
  const dm2 = env2.agentMap.get('dm-a')
  dm2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  const moveA = env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1 })
  await waitFor(() => typeof releaseFork3 === 'function')
  const msgA = { id: 'u-race-move2', role: 'user', content: [{ type: 'text', text: 'Must reach fork-2' }], source: { kind: 'user', rpcId: 'rpc-race-move2' } }
  dm2.inbox.nextStep.push(msgA)
  await env2.emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [msgA] })
  // Simulate another move committing dm-a -> fork-2 before moveA's fork returns.
  env2.rt.botOf('a').sessionId = 'fork-2'
  env2.rt.chatOwners.set('fork-2', 'a')
  env2.rt.taskOwners.set('dm-a', { botId: 'a', taskId: 'k_other' })
  releaseFork3()
  await moveA
  await waitFor(() => env2.agentMap.get('fork-2')?.followups.length === 1)
  assert.equal(dm2.inbox.nextStep.length, 0, 'background task dm-a must NOT receive rolled-back user input')
  assert.equal(env2.agentMap.get('fork-2').followups[0].content[0].text, 'Must reach fork-2')
})

test('moveForegroundToBackground fails closed when team lock is lost (required save) and persists operationId across restart', async (t) => {
  const env = await startEnv()
  t.after(env.stop)
  const dmA = env.agentMap.get('dm-a')
  dmA.status = 'running'
  await env.emit('dm-a', 'turn/start', { turn: 1 })

  // 1) Simulate store.js losing state.lock: optional save() resolves silently, save({ required: true }) rejects!
  const origSave = env.rt.save
  let lockLost = true
  env.rt.save = async (opts = {}) => {
    if (lockLost) {
      if (opts?.required) throw new Error('This host cannot save the Bot team: another window owns it')
      return undefined
    }
    return origSave(opts)
  }

  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-lock-1' }),
    /cannot save the Bot team/,
  )
  // Retrying while lock is STILL lost must STILL reject (never falsely report moved: true).
  await assert.rejects(
    () => env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-lock-1' }),
    /cannot save the Bot team/,
  )
  assert.equal(env.rt.state.completedMoveOps?.['op-lock-1'], undefined, 'unsaved move must not stay persisted in state.completedMoveOps')

  // Regain lock -> retry succeeds and persists op-lock-1 into state.completedMoveOps!
  lockLost = false
  const ok = await env.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', expectedTurn: 1, operationId: 'op-lock-1' })
  assert.equal(ok.moved, true)
  assert.equal(env.rt.state.completedMoveOps?.['op-lock-1']?.sessionId, ok.sessionId)

  // 2) Simulate host restart: state.completedMoveOps is loaded from disk, new Turn 2 is running on fork-1,
  //    replaying op-lock-1 returns cached receipt and MUST NOT move Turn 2!
  const envRestart = await startEnv({
    team: makeTeam({
      bots: {
        a: {
          id: 'a',
          name: 'Chief',
          role: 'Boss',
          sessionId: 'fork-1',
          tasks: [{ id: ok.taskId, origin: 'fg-handoff', sessionId: 'dm-a', status: 'completed', startedAt: 1, updatedAt: 2 }],
          createdAt: 1,
        },
      },
    }),
  })
  t.after(envRestart.stop)
  envRestart.rt.state.completedMoveOps = { 'op-lock-1': { sessionId: 'fork-1', taskId: ok.taskId, moved: true, at: Date.now() } }
  const fork1 = envRestart.agentMap.get('fork-1')
  fork1.status = 'running'
  await envRestart.emit('fork-1', 'turn/start', { turn: 2 })

  const replayed = await envRestart.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-lock-1' })
  assert.equal(replayed.sessionId, 'fork-1')
  assert.equal(replayed.taskId, ok.taskId)
  assert.equal(envRestart.rt.botOf('a').sessionId, 'fork-1', 'replayed operationId after restart must NOT move Turn 2')
  assert.equal(envRestart.rt.botOf('a').tasks.length, 1)
})

test('Mobile sendUser retry stays idempotent after host restart via real DSH sessionQuery.inspectSession even when completed fg-handoff task session is unloaded', async (t) => {
  const env = await startEnv({
    team: makeTeam({
      bots: {
        a: {
          id: 'a',
          name: 'Chief',
          role: 'Boss',
          sessionId: 'fork-1',
          tasks: [{ id: 'k_done', origin: 'fg-handoff', sessionId: 'dm-a-cold', status: 'completed', startedAt: 1, updatedAt: 2 }],
          createdAt: 1,
        },
      },
    }),
  })
  t.after(env.stop)

  // Real DSH 0.2.2-rc.5 SessionController has NO inspect(); cold reads use sessionQuery.inspectSession().
  delete env.ctx.sessionController.inspect
  assert.equal(env.agentMap.has('dm-a-cold'), false)
  let inspectCalls = 0
  const sessionQuery = {
    inspectSession: async (sid, read) => {
      inspectCalls += 1
      const events = sid === 'dm-a-cold'
        ? [{ type: 'user/message', seq: 1, data: { id: 'msg-cold-1', content: [{ type: 'text', text: 'Ship notes' }], source: { kind: 'user', rpcId: 'req-cold-1' } } }]
        : []
      return read({ snapshotEvents: () => events })
    },
  }
  const origGet = env.ctx.get
  env.ctx.get = name => (name === 'sessionQuery' ? sessionQuery : origGet(name))

  // Mobile retries req-cold-1 targeting either the cold session or bot id 'a' -> MUST NOT execute on fork-1!
  await env.rt.sendUser({ sessionId: 'dm-a-cold', content: [{ type: 'text', text: 'Ship notes' }], requestId: 'req-cold-1' })
  await env.rt.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'Ship notes' }], requestId: 'req-cold-1' })
  assert.equal(env.prompts.length, 0, 'already-admitted requestId in unloaded cold fg-handoff task must NOT replay after restart')
  assert.equal(inspectCalls, 1, 'settled cold task inspection must be cached in memory')

  // A brand new requestId still delivers normally to fork-1 without re-inspecting dm-a-cold.
  await env.rt.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'New request' }], requestId: 'req-brand-new' })
  assert.equal(env.prompts.length, 1)
  assert.equal(env.prompts[0].sessionId, 'fork-1')
  assert.equal(inspectCalls, 1)
})

test('round-3 invariants: transfer ownership token, unreadable recipient defer, concurrent save join, stale tombstone, joined/noop receipts, IM rebind dedup, and capacity rollback', async (t) => {
  // 1) Ownership token: positive flush(B) must NOT clear journal after C takes ownership of the same input.
  const env1 = await startEnv()
  t.after(env1.stop)
  const dm1 = env1.agentMap.get('dm-a')
  dm1.status = 'running'
  await env1.emit('dm-a', 'turn/start', { turn: 1 })
  await env1.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a' }) // -> fork-1 (B)
  let releaseFlushB
  let holdFlushB = true
  let flushCResult = false
  env1.ctx.sessions.flush = async (session) => {
    if (session.id === 'fork-1' && holdFlushB) {
      holdFlushB = false
      await new Promise((resolve) => { releaseFlushB = resolve })
      return true
    }
    if (session.id === 'fork-2') return flushCResult
    return true
  }
  const msgX = { id: 'u-chain-x', role: 'user', content: [{ type: 'text', text: 'Chained input X' }], source: { kind: 'user', rpcId: 'rpc-chain-x' } }
  dm1.inbox.nextTurn.push(msgX)
  await env1.emit('dm-a', 'agent/inbox/spliced', { target: 'next-turn', inserted: [msgX] })
  await waitFor(() => typeof releaseFlushB === 'function')
  // Pull X from fork-1 (B) for a hidden-work handoff onto fork-2 (C) while flush(B) is still paused.
  const forkB = env1.agentMap.get('fork-1')
  forkB.status = 'running'
  await env1.emit('fork-1', 'turn/start', { turn: 1 })
  env1.rt.live.get('fork-1').info = { kind: SOURCE_KIND, role: 'request', fromId: 'b', toId: 'a', exchangeId: 'ex-chain' }
  env1.rt.isHiddenBotWorkTurn = () => true
  const xCopy = { id: 'u-chain-x2', role: 'user', content: [{ type: 'text', text: 'Chained input X' }], source: { kind: 'user', rpcId: 'rpc-chain-x' } }
  forkB.inbox.nextStep.push(xCopy)
  await env1.emit('fork-1', 'agent/inbox/spliced', { target: 'next-step', inserted: [xCopy] })
  // Release B's positive flush now that C owns rpc-chain-x!
  releaseFlushB()
  await waitFor(() => env1.rt.botOf('a').sessionId === 'fork-2' && env1.agentMap.get('fork-2').followups.length > 0)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(
    env1.rt.state.pendingHandoffInputs?.some(e => e?.id === 'rpc-chain-x'),
    true,
    'older positive flush(B) must NOT clear journal once C owns rpc-chain-x and flush(C) returned false',
  )
  flushCResult = true
  await env1.rt.reconcileTasksAfterRestart()
  assert.equal(env1.rt.state.pendingHandoffInputs, undefined)

  // 2) Restart recovery defers replay when intermediate recipient B is transiently unreadable.
  const env2 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'fg-c', createdAt: 1 },
      },
    }),
  })
  t.after(env2.stop)
  env2.rt.state.pendingHandoffInputs = [{
    id: 'rpc-unreadable-b',
    originalSessionId: 'fg-a',
    recipientSessionId: 'fg-b',
    visitedSessionIds: ['fg-a', 'fg-b'],
    botId: 'a',
    content: [{ type: 'text', text: 'Maybe already on B' }],
    source: { kind: 'user', rpcId: 'rpc-unreadable-b' },
    at: Date.now() - 5000,
  }]
  const origResolve2 = env2.ctx.sessionController.resolveAgent
  env2.ctx.sessionController.resolveAgent = async (sid) => {
    if (sid === 'fg-b') throw new Error('transient disk error reading fg-b')
    return origResolve2(sid)
  }
  await env2.rt.reconcileTasksAfterRestart()
  assert.equal(env2.agentMap.get('fg-c').followups.length, 0, 'must NOT replay onto C while intermediate recipient B is unreadable')
  assert.equal(env2.rt.state.pendingHandoffInputs?.length, 1, 'journal must stay intact while B is unreadable')

  // 3) Concurrent retry joins paused save({ required: true }); rejecting save rejects BOTH and never falsely caches moved:true;
  //    capacity rollback preserves all 64 original receipts; stale pending save leaves tombstone so replay without expectedSessionId cannot move Turn 3.
  const env3 = await startEnv()
  t.after(env3.stop)
  env3.rt.state.completedMoveOps = {}
  for (let i = 0; i < 64; i += 1) {
    env3.rt.state.completedMoveOps[`old-op-${i}`] = { sessionId: `s-${i}`, taskId: `k-${i}`, moved: true, at: i + 1 }
  }
  const dm3 = env3.agentMap.get('dm-a')
  dm3.status = 'running'
  await env3.emit('dm-a', 'turn/start', { turn: 1 })
  let rejectSave
  const origSave3 = env3.rt.save
  let pauseSaveOnce = true
  env3.rt.save = async (opts = {}) => {
    if (pauseSaveOnce && opts?.required) {
      pauseSaveOnce = false
      return new Promise((_res, rej) => { rejectSave = () => rej(new Error('save failed')) })
    }
    return origSave3(opts)
  }
  const firstMove = env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-conc-1' })
  await waitFor(() => typeof rejectSave === 'function')
  // Concurrent retry while save is paused MUST join the save (not read staged receipt as completed!).
  let secondSettled = false
  const secondMove = env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-conc-1' })
    .finally(() => { secondSettled = true })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(secondSettled, false, 'concurrent retry must wait on outstanding required save')
  rejectSave()
  await assert.rejects(() => firstMove, /save failed/)
  await assert.rejects(() => secondMove, /save failed/)
  // Capacity rollback must preserve ALL 64 original receipts (including old-op-0)!
  assert.equal(Object.keys(env3.rt.state.completedMoveOps).length, 64)
  assert.ok(env3.rt.state.completedMoveOps['old-op-0'] !== undefined, 'failed save rollback must restore evicted oldest receipt')

  // Simulate another move superseding bot.sessionId -> stale retry rejects AND records tombstone so replay without expectedSessionId also throws bot/stale!
  env3.rt.botOf('a').sessionId = 'other-fg'
  env3.rt.chatOwners.set('other-fg', 'a')
  const otherAgent = (await env3.ctx.sessionController.resolveAgent('other-fg')).agent
  otherAgent.status = 'running'
  await env3.emit('other-fg', 'turn/start', { turn: 3 })
  await assert.rejects(
    () => env3.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-conc-1' }),
    err => err?.code === 'bot/stale',
  )
  await assert.rejects(
    () => env3.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-conc-1' }),
    err => err?.code === 'bot/stale',
  )
  assert.equal(env3.rt.botOf('a').sessionId, 'other-fg', 'replaying superseded operationId without expectedSessionId must NEVER move Turn 3')

  // 4) Joined IM operationId is durably persisted with Desktop move, AND natural-completion no-op fails when required save fails.
  let releaseFork4
  const env4 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork4 = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env4.stop)
  const dm4 = env4.agentMap.get('dm-a')
  dm4.status = 'running'
  await env4.emit('dm-a', 'turn/start', { turn: 1 })
  const deskP = env4.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-desk-join' })
  await waitFor(() => typeof releaseFork4 === 'function')
  const imP = env4.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-im-join' })
  releaseFork4()
  const [deskRes, imRes] = await Promise.all([deskP, imP])
  assert.equal(deskRes.moved, true)
  assert.equal(imRes.moved, true)
  assert.ok(env4.rt.state.completedMoveOps?.['op-desk-join'] !== undefined)
  assert.ok(env4.rt.state.completedMoveOps?.['op-im-join'] !== undefined, 'joined IM operationId must also be durably persisted')

  // Natural completion no-op must reject if required save fails.
  let releaseFork5
  const env5 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => {
      releaseFork5 = () => resolve({ sessionId: make() })
    }),
  })
  t.after(env5.stop)
  const dm5 = env5.agentMap.get('dm-a')
  dm5.status = 'running'
  await env5.emit('dm-a', 'turn/start', { turn: 1 })
  env5.rt.save = async (opts = {}) => { if (opts?.required) throw new Error('noop save failed') }
  const noopP = env5.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-noop-fail' })
  await waitFor(() => typeof releaseFork5 === 'function')
  dm5.status = 'idle'
  await env5.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  releaseFork5()
  await assert.rejects(() => noopP, /noop save failed/)

  // 5) Ordinary IM message after restart + rebind from Bot A to Bot B finds original request on Bot A's cold session and does NOT prompt Bot B.
  const env6 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a-cold-im', createdAt: 1 },
        b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b-new', createdAt: 2 },
      },
    }),
  })
  t.after(env6.stop)
  delete env6.ctx.sessionController.inspect
  env6.agentMap.delete('dm-a-cold-im')
  const imQuery = {
    inspectSession: async (sid, read) => {
      const events = sid === 'dm-a-cold-im'
        ? [{ type: 'user/message', seq: 1, data: { id: 'm-im-1', content: [{ type: 'text', text: 'Original IM msg' }], source: { kind: 'user', rpcId: 'im:telegram:c1:dm-u1:msg-rebind-1' } } }]
        : []
      return read({ snapshotEvents: () => events })
    },
  }
  const origGet6 = env6.ctx.get
  env6.ctx.get = name => (name === 'sessionQuery' ? imQuery : origGet6(name))
  await env6.rt.sendUser({
    sessionId: 'b',
    content: [{ type: 'text', text: 'Original IM msg' }],
    requestId: 'im:telegram:c1:dm-u1:msg-rebind-1',
  })
  assert.equal(env6.prompts.length, 0, 'redelivered IM message after restart + rebind must NOT prompt newly bound Bot B')
})

test('round-4 invariants: concurrent Bot rollback isolation, superseded tombstone persistence, coalesced failed-save retry, natural-completion archival race, cold inbox splice & fail-closed, and deferred reconcile retry', async (t) => {
  // 1) Per-key rollback: Bot A save fails after Bot B save succeeds -> Bot B receipt stays intact!
  const env1 = await startEnv()
  t.after(env1.stop)
  const dmA1 = env1.agentMap.get('dm-a')
  const dmB1 = env1.agentMap.get('dm-b')
  dmA1.status = 'running'
  dmB1.status = 'running'
  await env1.emit('dm-a', 'turn/start', { turn: 1 })
  await env1.emit('dm-b', 'turn/start', { turn: 1 })
  const origSave1 = env1.rt.save
  let rejectSaveA
  let saveIdx = 0
  env1.rt.save = async (opts = {}) => {
    if (opts?.required) {
      saveIdx += 1
      if (saveIdx === 1) {
        return new Promise((_res, rej) => { rejectSaveA = () => rej(new Error('save A failed')) })
      }
    }
    return origSave1(opts)
  }
  const moveA = env1.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-bot-a' })
  await waitFor(() => typeof rejectSaveA === 'function')
  const resB = await env1.rt.moveForegroundToBackground({ botId: 'b', expectedSessionId: 'dm-b', operationId: 'op-bot-b' })
  assert.equal(resB.moved, true)
  rejectSaveA()
  await assert.rejects(() => moveA, /save A failed/)
  assert.ok(env1.rt.state.completedMoveOps?.['op-bot-b'] !== undefined, 'Bot A rollback must NOT wipe Bot B committed receipt')
  assert.equal(env1.rt.state.completedMoveOps?.['op-bot-a'], undefined)

  // 2) Failed Move 1 -> newer Move 2 commits & saves -> Move 1 stale tombstone is persisted atomically!
  //    Simulating restart from that saved state: replaying Move 1 ID without expectedSessionId throws bot/stale (does NOT move Turn 3).
  const env2 = await startEnv()
  t.after(env2.stop)
  const dmA2 = env2.agentMap.get('dm-a')
  dmA2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave2 = env2.rt.save
  let failOnce2 = true
  env2.rt.save = async (opts = {}) => {
    if (failOnce2 && opts?.required) { failOnce2 = false; throw new Error('first move save failed') }
    return origSave2(opts)
  }
  await assert.rejects(
    () => env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-move-1' }),
    /first move save failed/,
  )
  // Now start Turn 2 on the new in-memory foreground (fork-1) and complete Move 2 (op-move-2).
  const fork1_2 = env2.agentMap.get('fork-1')
  fork1_2.status = 'running'
  await env2.emit('fork-1', 'turn/start', { turn: 2 })
  const res2 = await env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1', operationId: 'op-move-2' })
  assert.equal(res2.moved, true)
  assert.equal(env2.rt.state.completedMoveOps?.['op-move-1']?.stale, true, 'Move 2 must persist stale tombstone for superseded op-move-1')
  // Simulate restart with persisted state.completedMoveOps and Turn 3 running on fork-2.
  const persistedOps = structuredClone(env2.rt.state.completedMoveOps)
  const env2Restart = await startEnv({
    team: makeTeam({
      bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'fork-2', createdAt: 1 } },
    }),
  })
  t.after(env2Restart.stop)
  env2Restart.rt.state.completedMoveOps = persistedOps
  const fork2R = env2Restart.agentMap.get('fork-2')
  fork2R.status = 'running'
  await env2Restart.emit('fork-2', 'turn/start', { turn: 3 })
  await assert.rejects(
    () => env2Restart.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-move-1' }),
    err => err?.code === 'bot/stale',
  )
  assert.equal(env2Restart.rt.botOf('a').sessionId, 'fork-2', 'replaying old op-move-1 after restart must NOT move Turn 3')

  // 3) Coalesced Desktop/IM failed save retry saves BOTH IDs into state.completedMoveOps!
  let releaseFork3
  const env3 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => { releaseFork3 = () => resolve({ sessionId: make() }) }),
  })
  t.after(env3.stop)
  const dmA3 = env3.agentMap.get('dm-a')
  dmA3.status = 'running'
  await env3.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave3 = env3.rt.save
  let failSave3 = true
  env3.rt.save = async (opts = {}) => {
    if (failSave3 && opts?.required) { failSave3 = false; throw new Error('coalesced save failed') }
    return origSave3(opts)
  }
  const desk3 = env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-coal-desk' })
  await waitFor(() => typeof releaseFork3 === 'function')
  const im3 = env3.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-coal-im' })
  releaseFork3()
  await assert.rejects(() => desk3, /coalesced save failed/)
  await assert.rejects(() => im3, /coalesced save failed/)
  const [retryDesk, retryIm] = await Promise.all([
    env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-coal-desk' }),
    env3.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-coal-im' }),
  ])
  assert.equal(retryDesk.moved, true)
  assert.equal(retryIm.moved, true)
  assert.ok(env3.rt.state.completedMoveOps?.['op-coal-desk'] !== undefined)
  assert.ok(env3.rt.state.completedMoveOps?.['op-coal-im'] !== undefined, 'shared retry must persist BOTH Desktop and IM operationIds')

  // 4) Natural completion mid-fork while archiveSession is paused + Turn 2 starts + same-ID retry MUST join no-op and NOT move Turn 2!
  let releaseFork4
  let releaseArchive4
  const env4 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => { releaseFork4 = () => resolve({ sessionId: make() }) }),
  })
  t.after(env4.stop)
  env4.ctx.workspaceRegistry.archiveSession = async () => new Promise((resolve) => { releaseArchive4 = resolve })
  const dmA4 = env4.agentMap.get('dm-a')
  dmA4.status = 'running'
  await env4.emit('dm-a', 'turn/start', { turn: 1 })
  const p4 = env4.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-noop-race' })
  await waitFor(() => typeof releaseFork4 === 'function')
  dmA4.status = 'idle'
  await env4.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  releaseFork4()
  await waitFor(() => typeof releaseArchive4 === 'function')
  // Turn 2 starts on dm-a while archival of candidate fork is still paused!
  dmA4.status = 'running'
  await env4.emit('dm-a', 'turn/start', { turn: 2 })
  const retry4 = env4.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-noop-race' })
  releaseArchive4()
  const [res4a, res4b] = await Promise.all([p4, retry4])
  assert.equal(res4a.moved, false)
  assert.equal(res4b.moved, false)
  assert.equal(env4.rt.botOf('a').sessionId, 'dm-a', 'same-ID retry during natural-completion archival must NOT move Turn 2')
  assert.equal(env4.rt.botOf('a').tasks?.length ?? 0, 0)

  // 5) Cold session queued via agent/inbox/spliced (no user/message yet) is detected; removed splice is ignored; unreadable cold session fails closed!
  const env5 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a-queued-cold', createdAt: 1 },
        b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b-target', createdAt: 2 },
      },
    }),
  })
  t.after(env5.stop)
  delete env5.ctx.sessionController.inspect
  env5.agentMap.delete('dm-a-queued-cold')
  let coldMode = 'queued'
  const query5 = {
    inspectSession: async (sid, read) => {
      if (sid === 'dm-a-queued-cold') {
        if (coldMode === 'error') {
          throw Object.assign(new Error('disk I/O failure'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
        }
        const events = coldMode === 'queued'
          ? [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'mq-1', role: 'user', content: [{ type: 'text', text: 'Queued IM' }], source: { kind: 'user', rpcId: 'im:telegram:c1:dm-u1:q-1' } }] } }]
          : [
              { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'mq-2', role: 'user', content: [{ type: 'text', text: 'Removed IM' }], source: { kind: 'user', rpcId: 'im:telegram:c1:dm-u1:q-2' } }] } },
              { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
            ]
        return read({ snapshotEvents: () => events })
      }
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }
  const origGet5 = env5.ctx.get
  env5.ctx.get = name => (name === 'sessionQuery' ? query5 : origGet5(name))

  await env5.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Queued IM' }], requestId: 'im:telegram:c1:dm-u1:q-1' })
  assert.equal(env5.prompts.length, 0, 'cold queued agent/inbox/spliced on Bot A must prevent duplicate prompt on newly bound Bot B')

  coldMode = 'removed'
  await env5.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Removed IM' }], requestId: 'im:telegram:c1:dm-u1:q-2' })
  assert.equal(env5.prompts.length, 1, 'splice-removed message on Bot A must NOT falsely suppress delivery')

  coldMode = 'error'
  await assert.rejects(
    () => env5.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Unreadable check' }], requestId: 'im:telegram:c1:dm-u1:q-3' }),
    /disk I\/O failure/,
    'unreadable cold session must fail closed instead of treating error as a miss',
  )

  // 6) Deferred unreadable recipient automatically retries once readable!
  const env6 = await startEnv({
    team: makeTeam({
      bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'fg-c', createdAt: 1 } },
    }),
  })
  t.after(env6.stop)
  env6.rt.state.pendingHandoffInputs = [{
    id: 'rpc-retry-sched',
    originalSessionId: 'fg-a',
    recipientSessionId: 'fg-b',
    visitedSessionIds: ['fg-a', 'fg-b'],
    botId: 'a',
    content: [{ type: 'text', text: 'Recover automatically' }],
    source: { kind: 'user', rpcId: 'rpc-retry-sched' },
    at: Date.now() - 5000,
  }]
  let blockB = true
  const origResolve6 = env6.ctx.sessionController.resolveAgent
  env6.ctx.sessionController.resolveAgent = async (sid) => {
    if (sid === 'fg-b' && blockB) throw new Error('fg-b temporarily offline')
    return origResolve6(sid)
  }
  await env6.rt.reconcileTasksAfterRestart()
  assert.equal(env6.rt.state.pendingHandoffInputs?.length, 1)
  blockB = false
  await waitFor(() => env6.rt.state.pendingHandoffInputs === undefined && env6.agentMap.get('fg-c').followups.length === 1, 2500)
  assert.equal(env6.rt.state.pendingHandoffInputs, undefined, 'scheduled reconcile retry must drain deferred entry once fg-b becomes readable')
  assert.equal(env6.agentMap.get('fg-c').followups[0].content[0].text, 'Recover automatically')

  // 7) Two consecutive failed move saves -> retrying Move 2 MUST still persist Move 1's stale tombstone!
  const env7 = await startEnv()
  t.after(env7.stop)
  const dm7 = env7.agentMap.get('dm-a')
  dm7.status = 'running'
  await env7.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave7 = env7.rt.save
  let failSaves7 = 2
  env7.rt.save = async (opts = {}) => {
    if (opts?.required && failSaves7 > 0) { failSaves7 -= 1; throw new Error('consecutive save failure') }
    return origSave7(opts)
  }
  await assert.rejects(
    () => env7.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-fail-1' }),
    /consecutive save failure/,
  )
  const fork7_1 = env7.agentMap.get('fork-1')
  fork7_1.status = 'running'
  await env7.emit('fork-1', 'turn/start', { turn: 2 })
  await assert.rejects(
    () => env7.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1', operationId: 'op-fail-2' }),
    /consecutive save failure/,
  )
  const res7 = await env7.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1', operationId: 'op-fail-2' })
  assert.equal(res7.moved, true)
  assert.equal(env7.rt.state.completedMoveOps?.['op-fail-2']?.moved, true)
  assert.equal(env7.rt.state.completedMoveOps?.['op-fail-1']?.stale, true, 'retrying Move 2 after two consecutive failed saves must still persist Move 1 stale tombstone')

  // 8) Reconcile whose foreground flush() returns false schedules automatic retry and drains once flush succeeds!
  const env8 = await startEnv({
    team: makeTeam({
      bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
    }),
  })
  t.after(env8.stop)
  env8.rt.state.pendingHandoffInputs = [{
    id: 'rpc-fg-unflushed',
    botId: 'a',
    content: [{ type: 'text', text: 'Retry fg flush automatically' }],
    source: { kind: 'user', rpcId: 'rpc-fg-unflushed' },
    at: Date.now() - 5000,
  }]
  let allowFgFlush = false
  env8.ctx.sessions.flush = async () => allowFgFlush
  await env8.rt.reconcileTasksAfterRestart()
  assert.equal(env8.rt.state.pendingHandoffInputs?.length, 1, 'journal stays while foreground flush returns false')
  allowFgFlush = true
  await waitFor(() => env8.rt.state.pendingHandoffInputs === undefined, 2500)
  assert.equal(env8.rt.state.pendingHandoffInputs, undefined, 'scheduled reconcile retry must drain once foreground flush returns true')
  assert.equal(env8.agentMap.get('dm-a').followups.length, 1, 'already-admitted message must not be duplicated on scheduled flush retry')
})

test('round-5 invariants: room.segments object does not crash IM sendUser, reconcileRetryTimer does not sweep live tasks, and superseded op-1 survives failed stale replay', async (t) => {
  // 1) P0: Group chat with object `room.segments` + array `room.parts` must NOT throw TypeError on IM sendUser,
  //    and cold IM admission lookup must scan `room.parts` safely.
  const env1 = await startEnv({
    team: makeTeam({
      rooms: {
        r1: {
          id: 'r1',
          name: 'Ops',
          sessionId: 'room-cur',
          parts: ['room-old-part'],
          segments: { a: [{ sessionId: 'grp-r1-a-seg1', endedAt: 1 }] },
          members: ['a', 'b'],
          sessions: { a: 'grp-r1-a', b: 'grp-r1-b' },
        },
      },
    }),
  })
  t.after(env1.stop)
  delete env1.ctx.sessionController.inspect
  const query1 = {
    inspectSession: async (sid, read) => {
      if (sid === 'room-old-part') {
        return read({
          snapshotEvents: () => [
            { type: 'user/message', seq: 1, data: { id: 'm-room-1', content: [{ type: 'text', text: 'Hi group' }], source: { kind: 'user', rpcId: 'im:telegram:c1:g1:room-msg-1' } } },
          ],
        })
      }
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }
  const origGet1 = env1.ctx.get
  env1.ctx.get = name => (name === 'sessionQuery' ? query1 : origGet1(name))

  // Previously threw `TypeError: room?.segments ?? [] is not iterable` on EVERY inbound IM message!
  await env1.rt.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'Brand new IM msg' }], requestId: 'im:telegram:c1:dm-u1:fresh-1' })
  assert.equal(env1.prompts.length, 1)
  // And an IM message already logged in `room.parts` must be deduplicated even if rebound to Bot a!
  await env1.rt.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'Hi group' }], requestId: 'im:telegram:c1:g1:room-msg-1' })
  assert.equal(env1.prompts.length, 1, 'IM message logged in room.parts must NOT replay on Bot a')

  // 2) P1: Deferred reconcileRetryTimer must ONLY replay pendingHandoffInputs and NEVER re-run startup zombie-task sweep!
  const env2 = await startEnv({
    team: makeTeam({
      bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
    }),
  })
  t.after(env2.stop)
  // Let resume.js's 0ms startup reconcile settle, then add a live active task (simulating a task
  // kept via keepSessions or started mid-run before its first turn begins) and defer a pending transfer.
  await new Promise(r => setTimeout(r, 20))
  env2.rt.botOf('a').tasks = [{ id: 'k_live', origin: 'fg-handoff', sessionId: 'task-live-1', status: 'running', startedAt: 1, updatedAt: 1 }]
  env2.rt.state.pendingHandoffInputs = [{
    id: 'rpc-timer-only',
    botId: 'a',
    content: [{ type: 'text', text: 'Retry without killing tasks' }],
    source: { kind: 'user', rpcId: 'rpc-timer-only' },
    at: Date.now() - 5000,
  }]
  let allowFlush2 = false
  env2.ctx.sessions.flush = async () => allowFlush2
  await env2.rt.reconcileTasksAfterRestart(new Set(['task-live-1']))
  assert.equal(env2.rt.botOf('a').tasks[0].status, 'running')
  allowFlush2 = true
  await waitFor(() => env2.rt.state.pendingHandoffInputs === undefined, 2500)
  assert.equal(env2.rt.botOf('a').tasks[0].status, 'running', 'reconcileRetryTimer must NOT settle live tasks as interrupted')

  // 3) P1: Replaying superseded op-1 while Move 2's save also failed must NOT drop op-1 from pendingSaveMoveOps,
  //    so Move 2's subsequent retry STILL persists op-1's stale:true tombstone!
  const env3 = await startEnv()
  t.after(env3.stop)
  const dm3 = env3.agentMap.get('dm-a')
  dm3.status = 'running'
  await env3.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave3 = env3.rt.save
  let blockSaves3 = true
  env3.rt.save = async (opts = {}) => {
    if (opts?.required && blockSaves3) throw new Error('disk offline')
    return origSave3(opts)
  }
  await assert.rejects(
    () => env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-sup-1' }),
    /disk offline/,
  )
  const fork3_1 = env3.agentMap.get('fork-1')
  fork3_1.status = 'running'
  await env3.emit('fork-1', 'turn/start', { turn: 2 })
  await assert.rejects(
    () => env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1', operationId: 'op-sup-2' }),
    /disk offline/,
  )
  // Replay superseded op-1 while disk is STILL offline -> throws bot/stale AND keeps op-1 in pendingSaveMoveOps!
  await assert.rejects(
    () => env3.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-sup-1' }),
    err => err?.code === 'bot/stale',
  )
  // Now disk recovers and Move 2 retries -> MUST still persist op-sup-1's stale tombstone!
  blockSaves3 = false
  const ok3 = await env3.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'fork-1', operationId: 'op-sup-2' })
  assert.equal(ok3.moved, true)
  assert.equal(env3.rt.state.completedMoveOps?.['op-sup-2']?.moved, true)
  assert.equal(env3.rt.state.completedMoveOps?.['op-sup-1']?.stale, true, 'Move 2 retry must still persist stale tombstone for op-sup-1 after failed stale replay')
})

test('follow-up durability invariants: capacity eviction during save, failed no-op save, corrupt cold session, and live flush=false auto-retry', async (t) => {
  // 1) At 64-entry capacity after restart (cold in-memory LRU), while Bot A's save is in flight
  //    and provisionally evicts op-cap-0, replaying op-cap-0 on busy Bot B must hit op-cap-0's
  //    durable receipt and NOT move Bot B; when A's save fails, op-cap-0 is restored cleanly.
  const seededOps = {}
  for (let i = 0; i < 64; i += 1) {
    seededOps[`op-cap-${i}`] = { sessionId: `hist-${i}`, taskId: `k_hist_${i}`, moved: true, at: 100 + i }
  }
  const env1 = await startEnv({
    team: makeTeam({
      completedMoveOps: seededOps,
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
        b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      },
    }),
  })
  t.after(env1.stop)
  const dmA1 = env1.agentMap.get('dm-a')
  const dmB1 = env1.agentMap.get('dm-b')
  dmA1.status = 'running'
  dmB1.status = 'running'
  await env1.emit('dm-a', 'turn/start', { turn: 1 })
  await env1.emit('dm-b', 'turn/start', { turn: 1 })
  const origSave1 = env1.rt.save
  let rejectSaveA
  let interceptSaveA = true
  env1.rt.save = async (opts = {}) => {
    if (opts?.required && interceptSaveA) {
      interceptSaveA = false
      return new Promise((_, reject) => { rejectSaveA = reject })
    }
    return origSave1(opts)
  }
  const moveA = env1.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-cap-64' })
  await waitFor(() => typeof rejectSaveA === 'function')
  // While A's save is pending (having provisionally evicted op-cap-0), replay op-cap-0 against busy Bot B!
  const replay0 = await env1.rt.moveForegroundToBackground({ botId: 'b', operationId: 'op-cap-0' })
  assert.deepEqual(replay0, { sessionId: 'hist-0', taskId: 'k_hist_0', moved: true })
  assert.equal(env1.rt.botOf('b').sessionId, 'dm-b', 'replaying provisionally evicted durable receipt must NOT move Bot B')
  assert.equal(env1.rt.botOf('b').tasks?.length ?? 0, 0)
  // Now fail A's save -> op-cap-0 must be back in state.completedMoveOps and op-cap-64 unstaged.
  rejectSaveA(new Error('disk full for A'))
  await assert.rejects(() => moveA, /disk full for A/)
  assert.equal(env1.rt.state.completedMoveOps?.['op-cap-0']?.sessionId, 'hist-0')
  assert.equal(env1.rt.state.completedMoveOps?.['op-cap-64'], undefined)
  assert.equal(env1.rt.botOf('b').sessionId, 'dm-b')

  // 2) Natural completion mid-fork whose required save fails MUST retain the no-op in pendingSaveMoveOps
  //    so retrying the same operationId after Turn 2 starts returns moved:false without moving Turn 2,
  //    AND if a newer Move 2 commits instead, it also persists op-1's moved:false receipt atomically.
  let releaseFork2
  const env2 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => { releaseFork2 = () => resolve({ sessionId: make() }) }),
  })
  t.after(env2.stop)
  const dmA2 = env2.agentMap.get('dm-a')
  dmA2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave2 = env2.rt.save
  let failNoOpSave = true
  env2.rt.save = async (opts = {}) => {
    if (opts?.required && failNoOpSave) { failNoOpSave = false; throw new Error('no-op save failed') }
    return origSave2(opts)
  }
  const pNoOp = env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-noop-fail' })
  await waitFor(() => typeof releaseFork2 === 'function')
  dmA2.status = 'idle'
  await env2.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  releaseFork2()
  await assert.rejects(() => pNoOp, /no-op save failed/)
  // Turn 2 starts on dm-a; retrying op-noop-fail must persist & return moved:false, NOT move Turn 2!
  dmA2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 2 })
  const retryNoOp = await env2.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-noop-fail' })
  assert.deepEqual(retryNoOp, { sessionId: 'dm-a', taskId: null, moved: false })
  assert.equal(env2.rt.botOf('a').sessionId, 'dm-a', 'retrying failed no-op save must NOT move Turn 2')
  assert.equal(env2.rt.botOf('a').tasks?.length ?? 0, 0)
  assert.equal(env2.rt.state.completedMoveOps?.['op-noop-fail']?.moved, false)

  // 3) SESSION_QUERY_CORRUPT_SESSION whose message includes "not found in surface" must FAIL CLOSED,
  //    never be misclassified as missing session!
  const env3 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a-corrupt', createdAt: 1 },
        b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b-target', createdAt: 2 },
      },
    }),
  })
  t.after(env3.stop)
  delete env3.ctx.sessionController.inspect
  env3.agentMap.delete('dm-a-corrupt')
  const query3 = {
    inspectSession: async (sid) => {
      if (sid === 'dm-a-corrupt') {
        throw Object.assign(new Error('session dm-a-corrupt not found in surface index'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
      }
      throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }
  const origGet3 = env3.ctx.get
  env3.ctx.get = name => (name === 'sessionQuery' ? query3 : origGet3(name))
  await assert.rejects(
    () => env3.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Retry' }], requestId: 'im:telegram:c1:dm-u1:corrupt-1' }),
    err => err?.code === 'SESSION_QUERY_CORRUPT_SESSION',
    'SESSION_QUERY_CORRUPT_SESSION containing "not found in surface" must fail closed instead of admitting duplicate',
  )
  assert.equal(env3.prompts.length, 0)

  // 4) Live forwardPulledMessages encountering flush() === false MUST schedule automatic retry
  //    so pendingHandoffInputs drains once flush() returns true (without manual reconcile).
  let releaseFork4
  const env4 = await startEnv({
    forkImpl: async (_opts, make) => new Promise((resolve) => { releaseFork4 = () => resolve({ sessionId: make() }) }),
  })
  t.after(env4.stop)
  let allowFlush4 = false
  env4.ctx.sessions.flush = async () => allowFlush4
  const dmA4 = env4.agentMap.get('dm-a')
  dmA4.status = 'running'
  await env4.emit('dm-a', 'turn/start', { turn: 1 })
  const msg4 = { id: 'm-live-unflushed', content: [{ type: 'text', text: 'Drain automatically' }], source: { kind: 'user', rpcId: 'rpc-live-unflushed' } }
  const handoff4 = env4.rt.handoffForeground(env4.rt.botOf('a'), 'dm-a', [{ msg: msg4, target: 'next-turn', oldAgent: dmA4, originalSessionId: 'dm-a' }])
  await waitFor(() => typeof releaseFork4 === 'function')
  releaseFork4()
  const newSid4 = await handoff4
  assert.equal(env4.rt.state.pendingHandoffInputs?.length, 1, 'journal stays while live recipient flush returns false')
  // Now flush becomes available -> automatic scheduled replay must drain the journal without manual reconcile!
  allowFlush4 = true
  await waitFor(() => env4.rt.state.pendingHandoffInputs === undefined, 2500)
  assert.equal(env4.rt.state.pendingHandoffInputs, undefined, 'live flush=false must auto-schedule replay and drain once flush returns true')
  assert.equal(env4.agentMap.get(newSid4).followups.length, 1, 'already-admitted message must not duplicate on auto-replay')
})

test('round-1 review invariants: repeat cold lookup preserves durable, non-im scoping, concurrent op-1/op-2 serialization, and ENOENT fail-closed', async (t) => {
  // 1) Repeat cold-session lookup preserves durable: true and exact cold sessionId (including cache hits),
  //    and non-im requestIds reused across Bots stay scoped to each Bot's own ownerKey.
  const env1 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
        b: {
          id: 'b',
          name: 'Helper',
          role: 'Dev',
          sessionId: 'dm-b-cur',
          segments: [{ sessionId: 'dm-b-cold', endedAt: 10 }],
          createdAt: 2,
        },
      },
    }),
  })
  t.after(env1.stop)
  delete env1.ctx.sessionController.inspect
  env1.agentMap.delete('dm-b-cold')
  const query1 = {
    inspectSession: async (sid, read) => {
      if (sid === 'dm-b-cold') {
        return read({
          snapshotEvents: () => [
            { type: 'user/message', seq: 1, data: { id: 'm-cold-repeat', content: [{ type: 'text', text: 'Cold' }], source: { kind: 'user', rpcId: 'im:telegram:c1:dm-u1:cold-repeat' } } },
          ],
        })
      }
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }
  const origGet1 = env1.ctx.get
  env1.ctx.get = name => (name === 'sessionQuery' ? query1 : origGet1(name))
  const cold1 = await env1.rt.findAdmittedForSend({ ref: 'a', requestId: 'im:telegram:c1:dm-u1:cold-repeat', callerSupplied: true })
  assert.deepEqual(cold1, { admitted: true, sessionId: 'dm-b-cold', durable: true })
  const cold2 = await env1.rt.findAdmittedForSend({ ref: 'a', requestId: 'im:telegram:c1:dm-u1:cold-repeat', callerSupplied: true })
  assert.deepEqual(cold2, { admitted: true, sessionId: 'dm-b-cold', durable: true }, 'repeat cold lookup must retain durable: true and exact cold sessionId')

  // Non-im requestId shared by Bot A and Bot B must stay scoped to each Bot's ownerKey.
  env1.rt.noteAdmittedRpc('dm-a', 'req-shared')
  env1.rt.noteAdmittedRpc('dm-b-cur', 'req-shared')
  const foundB = await env1.rt.findAdmittedForSend({ ref: 'b', requestId: 'req-shared', callerSupplied: true })
  assert.equal(foundB.admitted, true)
  assert.equal(foundB.sessionId, 'dm-b-cur', 'non-im lookup on Bot B must never return Bot A sessionId')

  // 2) Concurrent op-1 (no-op) + op-2 (move) pending-save retries:
  //    (a) dual failure leaves state.completedMoveOps completely clean (no leaked uncommitted op-1);
  //    (b) retrying op-1 first atomically persists BOTH op-1 (moved: false) AND op-2 (moved: true)!
  let releaseForkA
  let holdFirstFork = true
  const env2 = await startEnv({
    forkImpl: async (_opts, make) => {
      if (holdFirstFork) {
        holdFirstFork = false
        return new Promise((resolve) => { releaseForkA = () => resolve({ sessionId: make() }) })
      }
      return { sessionId: make() }
    },
  })
  t.after(env2.stop)
  const dmA2 = env2.agentMap.get('dm-a')
  dmA2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 1 })
  const origSave2 = env2.rt.save
  let failSaves2 = true
  let saveCalls2 = 0
  let releasePendingSave2
  let pauseNextSave2 = false
  env2.rt.save = async (opts = {}) => {
    if (opts?.required) {
      saveCalls2 += 1
      if (pauseNextSave2) {
        pauseNextSave2 = false
        await new Promise((resolve) => { releasePendingSave2 = resolve })
      }
      if (failSaves2) throw new Error('disk offline')
    }
    return origSave2(opts)
  }
  // op-1 completes naturally mid-fork and its required save fails -> stored as pending no-op.
  const pOp1 = env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-noop-1' })
  await waitFor(() => typeof releaseForkA === 'function')
  dmA2.status = 'idle'
  await env2.emit('dm-a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  releaseForkA()
  await assert.rejects(() => pOp1, /disk offline/)
  // Turn 2 starts and moves with op-2 whose required save ALSO fails -> both op-1 and op-2 are pending!
  dmA2.status = 'running'
  await env2.emit('dm-a', 'turn/start', { turn: 2 })
  await assert.rejects(
    () => env2.rt.moveForegroundToBackground({ botId: 'a', expectedSessionId: 'dm-a', operationId: 'op-move-2' }),
    /disk offline/,
  )
  // Now retry op-2 and op-1 CONCURRENTLY while disk is still offline -> must share ONE serialized batch and leak NOTHING!
  pauseNextSave2 = true
  const savesBeforeConcurrent = saveCalls2
  const retryOp2 = env2.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-move-2' })
  await waitFor(() => typeof releasePendingSave2 === 'function')
  const retryOp1 = env2.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-noop-1' })
  releasePendingSave2()
  await assert.rejects(() => retryOp2, /disk offline/)
  await assert.rejects(() => retryOp1, /disk offline/)
  assert.equal(saveCalls2, savesBeforeConcurrent + 1, 'concurrent retries for same Bot must coalesce into a single serialized save')
  assert.equal(env2.rt.state.completedMoveOps, undefined, 'dual failure must NOT leak uncommitted op-noop-1 into state.completedMoveOps')

  // Now disk recovers and caller retries ONLY op-noop-1 -> MUST atomically persist op-move-2 alongside Move 2 state!
  failSaves2 = false
  const resOp1 = await env2.rt.moveForegroundToBackground({ botId: 'a', operationId: 'op-noop-1' })
  assert.deepEqual(resOp1, { sessionId: 'dm-a', taskId: null, moved: false })
  assert.equal(env2.rt.state.completedMoveOps?.['op-noop-1']?.moved, false)
  assert.equal(env2.rt.state.completedMoveOps?.['op-move-2']?.moved, true, 'saving op-1 must atomically include active pending op-2 receipt')
  assert.equal(env2.rt.state.completedMoveOps?.['op-move-2']?.sessionId, env2.rt.botOf('a').sessionId)

  // 3) Bare ENOENT must fail closed (not treated as missing session); SessionPersistenceNotFoundError is missing.
  const env3 = await startEnv({
    team: makeTeam({
      bots: {
        a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a-enoent', createdAt: 1 },
        b: { id: 'b', name: 'Helper', role: 'Dev', sessionId: 'dm-b-ok', createdAt: 2 },
      },
    }),
  })
  t.after(env3.stop)
  delete env3.ctx.sessionController.inspect
  env3.agentMap.delete('dm-a-enoent')
  let errKind = 'enoent'
  const query3 = {
    inspectSession: async (sid) => {
      if (sid === 'dm-a-enoent') {
        if (errKind === 'enoent') throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
        if (errKind === 'notfound') {
          const e = new Error('missing session')
          e.name = 'SessionPersistenceNotFoundError'
          throw e
        }
        const e = new Error('session not found in corrupted index')
        e.name = 'SessionPersistenceCorruptionError'
        throw e
      }
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }
  const origGet3 = env3.ctx.get
  env3.ctx.get = name => (name === 'sessionQuery' ? query3 : origGet3(name))
  await assert.rejects(
    () => env3.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Test' }], requestId: 'im:telegram:c1:dm-u1:enoent-1' }),
    err => err?.code === 'ENOENT',
    'bare ENOENT must fail closed',
  )
  errKind = 'corrupt-name'
  await assert.rejects(
    () => env3.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Test' }], requestId: 'im:telegram:c1:dm-u1:enoent-2' }),
    err => err?.name === 'SessionPersistenceCorruptionError',
    'SessionPersistenceCorruptionError without code must still fail closed',
  )
  errKind = 'notfound'
  await env3.rt.sendUser({ sessionId: 'b', content: [{ type: 'text', text: 'Test' }], requestId: 'im:telegram:c1:dm-u1:enoent-3' })
  assert.equal(env3.prompts.length, 1, 'SessionPersistenceNotFoundError must be treated as missing session')

  // 4) Busy-boundary flush barrier race: when an inbox-pending item transitions to claimed + user/message
  //    around flush #1, confirmSessionFlushed MUST perform an unconditional second flush (and return false
  //    if flush #2 fails), and agent/disposed `{ agent }` payload must exit waitForClaimedAdmission immediately.
  const env4 = await startEnv()
  t.after(env4.stop)
  const dmA4 = env4.agentMap.get('dm-a')
  dmA4.status = 'running'
  const raceReqId = 'im:telegram:c1:dm-u1:busy-barrier-1'
  dmA4.session.events.push({
    type: 'agent/inbox/spliced',
    seq: 1,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'm-barrier-1', role: 'user', content: [{ type: 'text', text: 'Queued' }], source: { kind: 'user', rpcId: raceReqId } }],
    },
  })
  let flushCount4 = 0
  let flush2Result = false
  env4.ctx.sessions.flush = async () => {
    flushCount4 += 1
    if (flushCount4 === 1) {
      // Simulate claim splice inside barrier #1, then user/message appended AFTER barrier #1 resolves!
      dmA4.session.events.push({ type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      queueMicrotask(() => {
        dmA4.session.events.push({
          type: 'user/message',
          seq: 3,
          data: { id: 'm-barrier-1', content: [{ type: 'text', text: 'Queued' }], source: { kind: 'user', rpcId: raceReqId } },
        })
      })
      return true
    }
    return flush2Result
  }
  const confirmedWhenFlush2Fails = await env4.rt.confirmSessionFlushed('dm-a', raceReqId)
  assert.equal(flushCount4, 2, 'transitioning inbox item must trigger an unconditional second flush')
  assert.equal(confirmedWhenFlush2Fails, false, 'failing flush #2 must return false instead of trusting flush #1')

  // Reset to inbox-pending and let flush #2 succeed -> must invoke 2 flushes and confirm true!
  const raceReqId2 = 'im:telegram:c1:dm-u1:busy-barrier-2'
  dmA4.session.events.length = 0
  dmA4.session.events.push({
    type: 'agent/inbox/spliced',
    seq: 1,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'm-barrier-2', role: 'user', content: [{ type: 'text', text: 'Queued 2' }], source: { kind: 'user', rpcId: raceReqId2 } }],
    },
  })
  flushCount4 = 0
  flush2Result = true
  env4.ctx.sessions.flush = async () => {
    flushCount4 += 1
    if (flushCount4 === 1) {
      dmA4.session.events.push({ type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
      dmA4.session.events.push({
        type: 'user/message',
        seq: 3,
        data: { id: 'm-barrier-2', content: [{ type: 'text', text: 'Queued 2' }], source: { kind: 'user', rpcId: raceReqId2 } },
      })
      return true
    }
    return flush2Result
  }
  const confirmedWhenFlush2Succeeds = await env4.rt.confirmSessionFlushed('dm-a', raceReqId2)
  assert.equal(flushCount4, 2, 'even if user/message became visible before post-flush check, flush #2 must run')
  assert.equal(confirmedWhenFlush2Succeeds, true)

  // Remove + reinsert rollback across flush #1 barrier MUST also require flush #2 (cannot trust flush #1!).
  const reinsertReqId = 'im:telegram:c1:dm-u1:remove-reinsert-1'
  dmA4.session.events.length = 0
  dmA4.session.events.push({
    type: 'agent/inbox/spliced',
    seq: 1,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'm-reins-1', role: 'user', content: [{ type: 'text', text: 'Reinserted' }], source: { kind: 'user', rpcId: reinsertReqId } }],
    },
  })
  flushCount4 = 0
  env4.ctx.sessions.flush = async () => {
    flushCount4 += 1
    if (flushCount4 === 1) {
      // Removal included in flush #1; rollback reinsertion lands right after barrier #1 resolves!
      dmA4.session.events.push({ type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
      queueMicrotask(() => {
        dmA4.session.events.push({
          type: 'agent/inbox/spliced',
          seq: 3,
          data: {
            target: 'next-turn',
            start: 0,
            inserted: [{ id: 'm-reins-1', role: 'user', content: [{ type: 'text', text: 'Reinserted' }], source: { kind: 'user', rpcId: reinsertReqId } }],
          },
        })
      })
      return true
    }
    return false
  }
  const reinsertFlush2Fails = await env4.rt.confirmSessionFlushed('dm-a', reinsertReqId)
  assert.equal(flushCount4, 2, 'remove+reinsert across flush #1 must trigger a second flush barrier')
  assert.equal(reinsertFlush2Fails, false, 'failed second flush after reinsert must return false')

  // When flush #2 succeeds with no further splices, confirmSessionFlushed returns true on flush #2.
  flushCount4 = 0
  env4.ctx.sessions.flush = async () => {
    flushCount4 += 1
    if (flushCount4 === 1) {
      dmA4.session.events.push({ type: 'agent/inbox/spliced', seq: 4, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
      dmA4.session.events.push({
        type: 'agent/inbox/spliced',
        seq: 5,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: 'm-reins-1', role: 'user', content: [{ type: 'text', text: 'Reinserted' }], source: { kind: 'user', rpcId: reinsertReqId } }],
        },
      })
    }
    return true
  }
  const reinsertFlush2Succeeds = await env4.rt.confirmSessionFlushed('dm-a', reinsertReqId)
  assert.equal(flushCount4, 2)
  assert.equal(reinsertFlush2Succeeds, true)

  // Verify real DSH `agent/disposed` payload `{ agent }` exits waitForClaimedAdmission immediately (not 5s timeout).
  const disposeReqId = 'im:telegram:c1:dm-u1:dispose-fast-1'
  dmA4.session.events.length = 0
  dmA4.session.events.push(
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'm-disp-1', role: 'user', content: [{ type: 'text', text: 'Claimed' }], source: { kind: 'user', rpcId: disposeReqId } }] } },
    { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  )
  const startedAt = Date.now()
  const waitPromise = env4.rt.confirmSessionFlushed('dm-a', disposeReqId)
  await new Promise(r => setTimeout(r, 20))
  for (const listener of env4.ctx.listeners.get('agent/disposed') ?? []) listener({ agent: dmA4 })
  const disposedResult = await waitPromise
  assert.equal(disposedResult, false)
  assert.ok(Date.now() - startedAt < 1000, 'agent/disposed { agent } payload must settle confirmSessionFlushed immediately')
})
