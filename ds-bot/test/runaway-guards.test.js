import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRuntime } from '../index.js'
import {
  ALWAYS_AUX_RETRY_MAX,
  ALWAYS_RETRY_MAX,
  CONSECUTIVE_TOOL_ERROR_PAUSE,
  GOAL_STAGE_REWORK_LIMIT,
  REPEAT_TOOL_CALL_PAUSE,
  REPEAT_TOOL_CYCLE_PAUSE,
  ROOM_ZERO_WORK_RELAY_LIMIT,
} from '../src/host/constants.js'
import { resumeGoal, reworkGoal, startGoal } from '../src/host/goals.js'
import { assembleLlmStream, install as installModels } from '../src/host/models.js'
import weixinPlatform from '../src/host/im/platforms/weixin.js'
import { failureText } from '../src/client/turn-error.js'
import { fakeContext } from './fake-ctx.js'

function createBotHarness(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-runaway-'))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const delivered = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async (path) => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          status: 'idle',
          session: { id: sessionId, header: { cwd: home }, seq: 0, eventAt: () => undefined },
          inbox: { nextTurn: [], nextStep: [], remove: () => false },
          followup: message => delivered.push({ sessionId, message }),
          send: message => delivered.push({ sessionId, message }),
        },
      }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      await listener({ id: sessionId }, event)
    }
  }
  return { ctx, rt, call, emit, delivered, home }
}

test('consecutive tool-error steps pause visibly with TURN_PAUSED_LOOP, reset on success, and carry across part switches', async (t) => {
  const { rt, call, emit, delivered } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  // 4 error steps followed by 1 success resets the streak.
  for (let step = 1; step <= 4; step += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `ok-reset-e${step}`, name: 'bash', arguments: JSON.stringify({ command: `cmd-${step}` }) } })
    await emit(sid, { type: 'tool/result', data: { callId: `ok-reset-e${step}`, isError: true } })
    rt.checkRunawayBeforeStep({ id: sid }, { turn: 1, step: step + 1 })
  }
  await emit(sid, { type: 'tool/call', data: { callId: 'ok-1', name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) } })
  await emit(sid, { type: 'tool/result', data: { callId: 'ok-1', isError: false } })
  rt.checkRunawayBeforeStep({ id: sid }, { turn: 1, step: 6 })

  // Now run CONSECUTIVE_TOOL_ERROR_PAUSE - 2 error steps on old part, carry across a
  // resume part switch, and hit the final 2 error steps on the fresh part.
  for (let i = 1; i <= CONSECUTIVE_TOOL_ERROR_PAUSE - 2; i += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `err-${i}`, name: 'bash', arguments: JSON.stringify({ command: `bad-${i}` }) } })
    await emit(sid, { type: 'tool/result', data: { callId: `err-${i}`, isError: true } })
    rt.checkRunawayBeforeStep({ id: sid }, { turn: 1, step: 6 + i })
  }
  const freshSid = 's-fresh-part'
  rt.chatOwners.set(freshSid, botId)
  rt.carryRunawayGuard(sid, freshSid)

  await emit(freshSid, { type: 'tool/call', data: { callId: 'err-prev', name: 'bash', arguments: JSON.stringify({ command: 'bad-prev' }) } })
  await emit(freshSid, { type: 'tool/result', data: { callId: 'err-prev', isError: true } })
  rt.checkRunawayBeforeStep({ id: freshSid }, { turn: 2, step: 2 })

  await emit(freshSid, { type: 'tool/call', data: { callId: 'err-last', name: 'bash', arguments: JSON.stringify({ command: 'bad-last' }) } })
  await emit(freshSid, { type: 'tool/result', data: { callId: 'err-last', isError: true } })
  assert.throws(
    () => rt.checkRunawayBeforeStep({ id: freshSid }, { turn: 2, step: 3 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
    'consecutive error steps carried across part switches must pause with TURN_PAUSED_LOOP',
  )

  // resumeBot clears the guard and sends a loop-aware Continue prompt.
  const bot = rt.botOf(botId)
  bot.failures = { [sid]: { turn: 1, code: 'TURN_PAUSED_LOOP', message: 'paused' } }
  rt.live.get(sid).turn = undefined
  await rt.resumeBot(bot)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].message.content[0].text, /automatically paused/i)
})

test('repeating identical calls and 2-step alternating tool cycles pause with TURN_PAUSED_LOOP', async (t) => {
  const { rt, call, emit } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  for (let i = 1; i <= REPEAT_TOOL_CALL_PAUSE - 1; i += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `same-${i}`, name: 'read_file', arguments: '{"path":"a.txt"}' } })
    await emit(sid, { type: 'tool/result', data: { callId: `same-${i}`, isError: false } })
    rt.checkRunawayBeforeStep({ id: sid }, { turn: 1, step: i + 1 })
  }
  await emit(sid, { type: 'tool/call', data: { callId: 'same-last', name: 'read_file', arguments: '{"path":"a.txt"}' } })
  await emit(sid, { type: 'tool/result', data: { callId: 'same-last', isError: false } })
  assert.throws(
    () => rt.checkRunawayBeforeStep({ id: sid }, { turn: 1, step: REPEAT_TOOL_CALL_PAUSE + 1 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
  )

  // 2-step alternating loop: A -> B -> A -> B ...
  for (let pair = 1; pair <= REPEAT_TOOL_CYCLE_PAUSE; pair += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `a-${pair}`, name: 'screenshot', arguments: '{}' } })
    await emit(sid, { type: 'tool/result', data: { callId: `a-${pair}`, isError: false } })
    await emit(sid, { type: 'tool/call', data: { callId: `b-${pair}`, name: 'click', arguments: '{"x":10,"y":20}' } })
    await emit(sid, { type: 'tool/result', data: { callId: `b-${pair}`, isError: false } })
    if (pair < REPEAT_TOOL_CYCLE_PAUSE) {
      rt.checkRunawayBeforeStep({ id: sid }, { turn: 2, step: pair + 1 })
    }
  }
  assert.throws(
    () => rt.checkRunawayBeforeStep({ id: sid }, { turn: 2, step: REPEAT_TOOL_CYCLE_PAUSE + 1 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
    '2-step alternating tool cycle must trigger TURN_PAUSED_LOOP',
  )
})

test('failed work tool calls do not mark workToolCount or clear group idle streaks; succeeded calls do', async (t) => {
  const { rt, call, emit } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  await emit(sid, { type: 'tool/call', data: { callId: 'fail-bash', name: 'bash', arguments: '{"command":"false"}' } })
  assert.equal(rt.live.get(sid).workToolCount, 0, 'tool/call alone must not increment workToolCount before result')
  await emit(sid, { type: 'tool/result', data: { callId: 'fail-bash', isError: true } })
  assert.equal(rt.live.get(sid).workToolCount, 0, 'errored tool/result must not increment workToolCount')

  await emit(sid, { type: 'tool/call', data: { callId: 'ok-bash', name: 'bash', arguments: '{"command":"true"}' } })
  await emit(sid, { type: 'tool/result', data: { callId: 'ok-bash', isError: false } })
  assert.equal(rt.live.get(sid).workToolCount, 1, 'successful work tool/result must increment workToolCount')
})

test('retryPolicy.mode=always short-circuits fatal codes and caps retries in both agent/request-error and assembleLlmStream', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const alwaysPolicy = { ...resolveRetryPolicy({ mode: 'always' }, 'mock'), initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  ctx.plugin(llmRetry)
  installModels({ ctx, state: { bots: {} }, isBotSession: () => true, warn() {} })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('retry-always'), { provider: 'mock', model: 'mock' })
  const signal = new AbortController().signal
  const fatalRes = await ctx.waterfall('agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    signal,
    provider: 'mock',
    retryPolicy: alwaysPolicy,
    failure: { code: 'QUOTA', message: 'out of balance' },
  }, () => undefined)
  assert.equal(fatalRes, undefined, 'fatal QUOTA under mode=always must not retry')

  const authRes = await ctx.waterfall('agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    signal,
    provider: 'mock',
    retryPolicy: alwaysPolicy,
    failure: { code: 'AUTH', message: 'invalid key' },
  }, () => undefined)
  assert.equal(authRes, undefined, 'fatal AUTH under mode=always must not retry')

  let retried = 0
  for (let i = 0; i < ALWAYS_RETRY_MAX + 5; i += 1) {
    const decision = await ctx.waterfall('agent/request-error', {
      agent,
      turn: 1,
      step: 2,
      signal,
      provider: 'mock',
      retryPolicy: alwaysPolicy,
      failure: { code: 'SERVER', message: 'upstream 500' },
    }, () => undefined)
    if (decision?.kind === 'retry') retried += 1
    else break
  }
  assert.equal(retried, ALWAYS_RETRY_MAX, `transient errors under mode=always must cap at ${ALWAYS_RETRY_MAX}`)

  // Auxiliary stream helper `assembleLlmStream` must also cap retries under mode=always.
  let streamAttempts = 0
  const fakeLlmCtx = {
    get: name => (name === 'llm' ? {
      providerRetryPolicy: () => alwaysPolicy,
      stream: async function* () {
        streamAttempts += 1
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'socket hangup' } } }
      },
    } : undefined),
  }
  const assembler = await assembleLlmStream(fakeLlmCtx, { provider: 'mock', model: 'mock', messages: [] }, {
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    random: () => 0.5,
  })
  assert.equal(assembler.finish.kind, 'error')
  assert.equal(streamAttempts, ALWAYS_AUX_RETRY_MAX + 1, `assembleLlmStream under mode=always must stop after ${ALWAYS_AUX_RETRY_MAX} retries`)
})

test('reworkGoal auto-pauses after GOAL_STAGE_REWORK_LIMIT consecutive reworks and resumeGoal resets the streak', () => {
  const room = { id: 'r1', name: 'Team', members: ['b1', 'b2'], admin: 'b1' }
  const members = { Alice: { id: 'b1', name: 'Alice' }, Bob: { id: 'b2', name: 'Bob' } }
  const memberOf = name => members[name]
  const memberNames = Object.keys(members)
  const created = startGoal(room, {
    title: 'Ship fix',
    objective: 'Fix all bugs',
    acceptance: 'Tests pass',
    stages: [{ title: 'Implement', acceptance: 'Green', tasks: [{ bot: 'Bob', task: 'Fix bug' }] }],
  }, 'b1', memberOf, memberNames)
  assert.equal(created.error, undefined)

  for (let i = 1; i < GOAL_STAGE_REWORK_LIMIT; i += 1) {
    const res = reworkGoal(room, { reason: `Try ${i}` }, 'b1', memberOf, memberNames)
    assert.equal(res.error, undefined)
    assert.equal(res.autoPaused, undefined)
    assert.equal(room.goal.status, 'active')
  }
  const paused = reworkGoal(room, { reason: 'Still broken' }, 'b1', memberOf, memberNames)
  assert.equal(paused.autoPaused, true)
  assert.equal(room.goal.status, 'paused')
  assert.equal(room.goal.pausedBy, 'system')
  assert.equal(paused.reply.event, 'pause')

  const resumed = resumeGoal(room, 'user')
  assert.equal(resumed.error, undefined)
  assert.equal(room.goal.status, 'active')
  assert.equal(room.goal.stages[0].reworksSinceResume, 0)

  const afterResume = reworkGoal(room, { reason: 'Fresh rework after user resume' }, 'b1', memberOf, memberNames)
  assert.equal(afterResume.autoPaused, undefined)
  assert.equal(room.goal.status, 'active')
})

test('weixin adapter persists sync_buf cursor and synthesizes deterministic messageId when ids are missing', async () => {
  const received = []
  const runtimes = []
  let pollCount = 0
  let runtime = {}
  const adapter = weixinPlatform.connect(
    { token: 'tok', base: 'https://ilinkai.weixin.qq.com/' },
    {
      runtime: {
        get: () => runtime,
        set: patch => { runtime = { ...runtime, ...patch }; runtimes.push(runtime) },
      },
      config: { pollRetryMs: 1, startRetryDelaysMs: [1] },
      fetch: async (url) => {
        if (String(url).includes('getupdates')) {
          pollCount += 1
          if (pollCount === 1) {
            return new Response(JSON.stringify({
              ret: 0,
              sync_buf: 'cursor-from-sync-buf',
              msgs: [{
                from_user_id: 'u-1',
                create_time: 1700000000,
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              }],
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          await new Promise(resolve => setTimeout(resolve, 200))
          return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'cursor-from-sync-buf', msgs: [] }), { status: 200 })
        }
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      },
      log: { warn() {} },
    },
    {
      onMessage: async msg => { received.push(msg) },
      onStatus() {},
    },
  )
  await adapter.start?.()
  for (let i = 0; i < 40 && (received.length === 0 || runtimes.length === 0); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await adapter.stop?.()
  assert.equal(received.length, 1)
  assert.match(received[0].messageId, /^wx:[0-9a-f]{24}$/, 'missing client_id/message_id must get deterministic fallback id')
  assert.equal(runtime.cursor, 'cursor-from-sync-buf', 'sync_buf must be persisted as cursor when get_updates_buf is omitted')
})

test('turn-error renders dedicated copy for TURN_PAUSED_LOOP and TURN_PAUSED_SWITCH_LIMIT', () => {
  const loopText = failureText('TURN_PAUSED_LOOP', { name: 'Chief', provider: 'DeepSeek' })
  const switchText = failureText('TURN_PAUSED_SWITCH_LIMIT', { name: 'Chief', provider: 'DeepSeek' })
  assert.match(loopText, /Chief/)
  assert.match(loopText, /Continue/)
  assert.match(switchText, /Chief/)
  assert.match(switchText, /Continue/)
  assert.ok(ROOM_ZERO_WORK_RELAY_LIMIT >= 2)
})

test('wakeFailedTurnInbox does not auto-wake queued messages after paused or blocking failures', async (t) => {
  const { ctx, rt, call } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  for (const [code, shouldWake] of [
    ['TURN_PAUSED_LOOP', false],
    ['TURN_PAUSED_SWITCH_LIMIT', false],
    ['QUOTA', false],
    ['AUTH', false],
    ['LOCAL_AGENT_SESSION_LOST', false],
    ['TRANSPORT', true],
  ]) {
    const endEvent = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code, message: 'err' } } } }
    const queuedMsg = { id: `m-${code}`, role: 'user', content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } }
    const sent = []
    const agent = {
      id: sid,
      status: 'idle',
      session: { id: sid, seq: 1, eventAt: seq => (seq === 0 ? endEvent : undefined) },
      inbox: {
        nextTurn: [queuedMsg],
        nextStep: [],
        remove(id) {
          const i = this.nextTurn.findIndex(m => m.id === id)
          if (i === -1) return false
          this.nextTurn.splice(i, 1)
          return true
        },
      },
      send(msg, target, wake) { sent.push({ msg, target, wake }) },
    }
    for (const listener of ctx.listeners.get('agent/status') ?? []) {
      await listener({ agent, status: 'idle' })
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.length > 0, shouldWake, `code=${code} expected wake=${shouldWake}`)
  }
})
