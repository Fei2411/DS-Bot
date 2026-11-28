import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmError, createToolResultMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
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
} from '../src/host/constants.js'
import { resumeGoal, reworkGoal, startGoal } from '../src/host/goals.js'
import { assembleLlmStream, install as installModels } from '../src/host/models.js'
import weixinPlatform from '../src/host/im/platforms/weixin.js'
import { failureText } from '../src/client/turn-error.js'
import { fakeContext } from './fake-ctx.js'

// Matches real DSH `@deepseek-ai/dsh-tools` `tool/result` event contract:
// `{ turn, step, message: createToolResultMessage({ callId, content, isError }) }`.
function toolResultEvent(callId, { isError = false, turn = 1, step = 1, text = isError ? 'boom' : 'ok', surfaceOp } = {}) {
  return {
    type: 'tool/result',
    ...(surfaceOp ? { surfaceOp } : {}),
    data: {
      turn,
      step,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text }],
        isError,
      }),
    },
  }
}

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
      page: async () => ({ records: [] }),
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
  const runPreStep = async (sessionId, { turn = 1, step = 1 } = {}) => {
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: rt.teamFolder() }, seq: 0, eventAt: () => undefined, requestHeader: () => undefined },
      inbox: { nextTurn: [], nextStep: [] },
    }
    const payload = { agent, turn, step, messages: [], signal: new AbortController().signal }
    const listeners = ctx.listeners.get('agent/pre-step') ?? []
    let idx = 0
    const next = async () => {
      if (idx >= listeners.length) return { kind: 'enter', messages: [] }
      return listeners[idx++](payload, next)
    }
    return next()
  }
  return { ctx, rt, call, emit, runPreStep, delivered, home }
}

test('real DSH tool/result contract: consecutive tool-error steps pause via parts agent/pre-step, reset on success, and carry across part switches', async (t) => {
  const { rt, call, emit, runPreStep, delivered } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  // 4 error steps followed by 1 success resets the streak.
  for (let step = 1; step <= 4; step += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `ok-reset-e${step}`, name: 'bash', arguments: JSON.stringify({ command: `cmd-${step}` }) } })
    await emit(sid, toolResultEvent(`ok-reset-e${step}`, { isError: true, turn: 1, step }))
    await runPreStep(sid, { turn: 1, step: step + 1 })
  }
  await emit(sid, { type: 'tool/call', data: { callId: 'ok-1', name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) } })
  await emit(sid, toolResultEvent('ok-1', { isError: false, turn: 1, step: 5 }))
  // A pruned replacement `tool/result` with surfaceOp replace must be ignored.
  await emit(sid, toolResultEvent('ok-1', { isError: true, turn: 1, step: 5, surfaceOp: { op: 'replace' } }))
  await runPreStep(sid, { turn: 1, step: 6 })
  assert.equal(rt.live.get(sid).workToolCount, 1, 'real createToolResultMessage success increments workToolCount')

  // Run CONSECUTIVE_TOOL_ERROR_PAUSE - 2 error steps on old part, carry across part switch,
  // and hit the final 2 error steps on the fresh part through real `agent/pre-step`.
  for (let i = 1; i <= CONSECUTIVE_TOOL_ERROR_PAUSE - 2; i += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `err-${i}`, name: 'bash', arguments: JSON.stringify({ command: `bad-${i}` }) } })
    await emit(sid, toolResultEvent(`err-${i}`, { isError: true, turn: 1, step: 5 + i }))
    await runPreStep(sid, { turn: 1, step: 6 + i })
  }
  const freshSid = 's-fresh-part'
  rt.chatOwners.set(freshSid, botId)
  rt.carryRunawayGuard(sid, freshSid)

  await emit(freshSid, { type: 'tool/call', data: { callId: 'err-prev', name: 'bash', arguments: JSON.stringify({ command: 'bad-prev' }) } })
  await emit(freshSid, toolResultEvent('err-prev', { isError: true, turn: 2, step: 1 }))
  await runPreStep(freshSid, { turn: 2, step: 2 })

  await emit(freshSid, { type: 'tool/call', data: { callId: 'err-last', name: 'bash', arguments: JSON.stringify({ command: 'bad-last' }) } })
  await emit(freshSid, toolResultEvent('err-last', { isError: true, turn: 2, step: 2 }))
  await assert.rejects(
    () => runPreStep(freshSid, { turn: 2, step: 3 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
    'consecutive error steps carried across part switches must pause with TURN_PAUSED_LOOP in agent/pre-step',
  )

  // resumeBot clears the guard and sends a loop-aware Continue prompt.
  const bot = rt.botOf(botId)
  bot.failures = { [sid]: { turn: 1, code: 'TURN_PAUSED_LOOP', message: 'paused' } }
  rt.live.get(sid).turn = undefined
  await rt.resumeBot(bot)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].message.content[0].text, /automatically paused/i)
})

test('repeating identical calls, 2-step cycles, and failing run_code programs pause with TURN_PAUSED_LOOP', async (t) => {
  const { rt, call, emit, runPreStep } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  for (let i = 1; i <= REPEAT_TOOL_CALL_PAUSE - 1; i += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `same-${i}`, name: 'read_file', arguments: '{"path":"a.txt"}' } })
    await emit(sid, toolResultEvent(`same-${i}`, { isError: false, turn: 1, step: i }))
    await runPreStep(sid, { turn: 1, step: i + 1 })
  }
  await emit(sid, { type: 'tool/call', data: { callId: 'same-last', name: 'read_file', arguments: '{"path":"a.txt"}' } })
  await emit(sid, toolResultEvent('same-last', { isError: false, turn: 1, step: REPEAT_TOOL_CALL_PAUSE }))
  await assert.rejects(
    () => runPreStep(sid, { turn: 1, step: REPEAT_TOOL_CALL_PAUSE + 1 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
  )

  // 2-step alternating loop: A -> B -> A -> B ...
  for (let pair = 1; pair <= REPEAT_TOOL_CYCLE_PAUSE; pair += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `a-${pair}`, name: 'screenshot', arguments: '{}' } })
    await emit(sid, toolResultEvent(`a-${pair}`, { isError: false, turn: 2, step: pair }))
    await emit(sid, { type: 'tool/call', data: { callId: `b-${pair}`, name: 'click', arguments: '{"x":10,"y":20}' } })
    await emit(sid, toolResultEvent(`b-${pair}`, { isError: false, turn: 2, step: pair }))
    if (pair < REPEAT_TOOL_CYCLE_PAUSE) {
      await runPreStep(sid, { turn: 2, step: pair + 1 })
    }
  }
  await assert.rejects(
    () => runPreStep(sid, { turn: 2, step: REPEAT_TOOL_CYCLE_PAUSE + 1 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
    '2-step alternating tool cycle must trigger TURN_PAUSED_LOOP',
  )

  // Repeated failing `run_code` programs (with no sub-calls) must also pause without counting as workToolCount.
  await emit(sid, { type: 'turn/start', data: { turn: 3 } })
  for (let step = 1; step <= CONSECUTIVE_TOOL_ERROR_PAUSE; step += 1) {
    await emit(sid, { type: 'tool/call', data: { callId: `ptc-${step}`, name: 'run_code', arguments: `{"code":"bad(${step})"}` } })
    await emit(sid, toolResultEvent(`ptc-${step}`, { isError: true, turn: 3, step }))
    if (step < CONSECUTIVE_TOOL_ERROR_PAUSE) {
      await runPreStep(sid, { turn: 3, step: step + 1 })
    }
  }
  assert.equal(rt.live.get(sid).workToolCount, 0, 'failing run_code must not count as workToolCount')
  await assert.rejects(
    () => runPreStep(sid, { turn: 3, step: CONSECUTIVE_TOOL_ERROR_PAUSE + 1 }),
    err => err instanceof LlmError && err.code === 'TURN_PAUSED_LOOP',
    'repeated failing run_code programs must trigger TURN_PAUSED_LOOP',
  )
})

test('failed work tool calls do not mark workToolCount; succeeded real tool/result calls do', async (t) => {
  const { rt, call, emit } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  await emit(sid, { type: 'turn/start', data: { turn: 1 } })
  await emit(sid, { type: 'tool/call', data: { callId: 'fail-bash', name: 'bash', arguments: '{"command":"false"}' } })
  assert.equal(rt.live.get(sid).workToolCount, 0, 'tool/call alone must not increment workToolCount before result')
  await emit(sid, toolResultEvent('fail-bash', { isError: true }))
  assert.equal(rt.live.get(sid).workToolCount, 0, 'errored tool/result must not increment workToolCount')

  await emit(sid, { type: 'tool/call', data: { callId: 'ok-bash', name: 'bash', arguments: '{"command":"true"}' } })
  await emit(sid, toolResultEvent('ok-bash', { isError: false }))
  assert.equal(rt.live.get(sid).workToolCount, 1, 'successful work tool/result must increment workToolCount')
})

test('retryPolicy.mode=always short-circuits fatal codes, isolates MALFORMED_RESPONSE retries, and caps transient + auxiliary retries', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const alwaysPolicy = { ...resolveRetryPolicy({ mode: 'always' }, 'mock'), initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  ctx.plugin(llmRetry)
  installModels({ ctx, state: { bots: {} }, isBotSession: () => true, warn() {} })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('retry-always'), { provider: 'mock', model: 'mock' })
  const signal = new AbortController().signal

  for (const fatalCode of ['QUOTA', 'AUTH', 'LOCAL_AGENT_SESSION_LOST', 'IMAGE_OFFLOAD_REQUIRED', 'INVALID_REQUEST']) {
    const res = await ctx.waterfall('agent/request-error', {
      agent,
      turn: 1,
      step: 1,
      signal,
      provider: 'mock',
      retryPolicy: alwaysPolicy,
      failure: { code: fatalCode, message: `fatal ${fatalCode}` },
    }, () => undefined)
    assert.equal(res, undefined, `fatal ${fatalCode} under mode=always must not retry`)
  }

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

  // On the SAME step after SERVER retries exhausted, MALFORMED_RESPONSE still gets its own
  // independent 2-retry budget and never loops infinitely.
  let malformedRetried = 0
  for (let i = 0; i < 5; i += 1) {
    const decision = await ctx.waterfall('agent/request-error', {
      agent,
      turn: 1,
      step: 2,
      signal,
      provider: 'mock',
      retryPolicy: alwaysPolicy,
      failure: { code: 'MALFORMED_RESPONSE', message: 'Tool call "bash" had invalid JSON' },
    }, () => undefined)
    if (decision?.kind === 'retry') malformedRetried += 1
    else break
  }
  assert.equal(malformedRetried, 2, 'MALFORMED_RESPONSE under mode=always keeps its own independent 2-retry cap')

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

test('reworkGoal auto-pauses after GOAL_STAGE_REWORK_LIMIT reworks, refuses Bot self-resume, and resets on user resume', () => {
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

  // A Bot must NOT be able to bypass the system auto-pause via group_goal resume.
  const botResume = resumeGoal(room, 'b1')
  assert.match(botResume.error ?? '', /must be resumed by the user/i)
  assert.equal(room.goal.status, 'paused')

  // User resume lifts the pause and resets reworksSinceResume.
  const resumed = resumeGoal(room, 'user')
  assert.equal(resumed.error, undefined)
  assert.equal(room.goal.status, 'active')
  assert.equal(room.goal.stages[0].reworksSinceResume, 0)

  const afterResume = reworkGoal(room, { reason: 'Fresh rework after user resume' }, 'b1', memberOf, memberNames)
  assert.equal(afterResume.autoPaused, undefined)
  assert.equal(room.goal.status, 'active')
})

test('weixin adapter preserves non-empty sync_buf over empty get_updates_buf and distinguishes duplicate same-batch messages', async () => {
  const received = []
  let pollCount = 0
  let runtime = {}
  const adapter = weixinPlatform.connect(
    { token: 'tok', base: 'https://ilinkai.weixin.qq.com/' },
    {
      runtime: {
        get: () => runtime,
        set: patch => { runtime = { ...runtime, ...patch } },
      },
      config: { pollRetryMs: 1, startRetryDelaysMs: [1] },
      fetch: async (url) => {
        if (String(url).includes('getupdates')) {
          pollCount += 1
          if (pollCount === 1) {
            return new Response(JSON.stringify({
              ret: 0,
              get_updates_buf: '',
              sync_buf: 'cursor-from-sync-buf',
              msgs: [
                { from_user_id: 'u-1', item_list: [{ type: 1, text_item: { text: '1' } }] },
                { from_user_id: 'u-1', item_list: [{ type: 1, text_item: { text: '1' } }] },
              ],
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (pollCount === 2) {
            // Empty get_updates_buf on an idle poll must NOT wipe the persisted cursor.
            return new Response(JSON.stringify({ ret: 0, get_updates_buf: '', msgs: [] }), { status: 200 })
          }
          await new Promise(resolve => setTimeout(resolve, 200))
          return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 })
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
  for (let i = 0; i < 40 && pollCount < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await adapter.stop?.()
  assert.equal(received.length, 2)
  assert.match(received[0].messageId, /^wx:[0-9a-f]{24}$/)
  assert.match(received[1].messageId, /^wx:[0-9a-f]{24}$/)
  assert.notEqual(received[0].messageId, received[1].messageId, 'two identical messages in the same batch must get distinct fallback IDs')
  assert.equal(runtime.cursor, 'cursor-from-sync-buf', 'non-empty sync_buf wins over empty get_updates_buf and is not wiped by later empty responses')
})

test('turn-error renders dedicated copy for TURN_PAUSED_LOOP and TURN_PAUSED_SWITCH_LIMIT', () => {
  const loopText = failureText('TURN_PAUSED_LOOP', { name: 'Chief', provider: 'DeepSeek' })
  const switchText = failureText('TURN_PAUSED_SWITCH_LIMIT', { name: 'Chief', provider: 'DeepSeek' })
  assert.match(loopText, /Chief/)
  assert.match(loopText, /Continue/)
  assert.match(switchText, /Chief/)
  assert.match(switchText, /Continue/)
})

test('wakeFailedTurnInbox does not auto-wake queued messages after paused, blocking, or overflow failures', async (t) => {
  const { ctx, rt, call } = createBotHarness(t)
  const botId = (await call('state', {})).value.mainBotId
  const sid = rt.chatOf(botId)

  for (const [code, shouldWake] of [
    ['TURN_PAUSED_LOOP', false],
    ['TURN_PAUSED_SWITCH_LIMIT', false],
    ['QUOTA', false],
    ['AUTH', false],
    ['LOCAL_AGENT_SESSION_LOST', false],
    ['CONTEXT_WINDOW_EXCEEDED', false],
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
