import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { afterRound } from './relay-rows.js'
import { fakeContext } from './fake-ctx.js'
import { isSilentTurnText, isWorkTool, SOURCE_KIND } from '../src/host/constants.js'

const textOf = content => (Array.isArray(content) ? content.map(block => block.text ?? '').join('\n') : String(content ?? ''))
const textBlock = text => [{ type: 'text', text }]
const assistantText = text => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Assistant', sessionId: 'b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'Ops', sessionId: 'c', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start(seed = team()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-call-return-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const messages = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => messages },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    if (type === 'user/message') agentOf(id).session.deriveMessages().push({ role: 'user', content: data.content, source: data.source })
    if (type === 'assistant/message') agentOf(id).session.deriveMessages().push({ ...data.message, role: 'assistant' })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async (a = 'a', b = 'b') => (await call('exchange', { a, b })).value ?? []
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, agentOf, emit, fire, tool, call, exchanges, home, stop }
}

const settled = async (pred, tries = 100) => {
  for (let i = 0; i < tries && !pred(); i += 1) await delay(5)
}

test('isWorkTool excludes meta/memory tools and isSilentTurnText matches silent stubs only', () => {
  assert.equal(isWorkTool('bash'), true)
  assert.equal(isWorkTool('read'), true)
  assert.equal(isWorkTool('edit'), true)
  assert.equal(isWorkTool('bot_remember'), false)
  assert.equal(isWorkTool('list_bots'), false)
  assert.equal(isWorkTool('delegate_work'), false)
  assert.equal(isWorkTool('note_bot'), false)

  assert.equal(isSilentTurnText(''), true)
  assert.equal(isSilentTurnText('[PASS]'), true)
  assert.equal(isSilentTurnText('（静默。）'), true)
  assert.equal(isSilentTurnText('（收工。）'), true)
  assert.equal(isSilentTurnText('（完。）'), true)
  assert.equal(isSilentTurnText('(silent)'), true)
  assert.equal(isSilentTurnText('我已经改完边栏代码了。'), false)
  assert.equal(isSilentTurnText('收工前请确认这个文件。'), false)
})

test('note_bot leaves silent zero-wake context via agent.inject without waking the target', async (t) => {
  const { agents, tool, exchanges, stop } = await start()
  t.after(stop)

  const receipt = await tool('note_bot', { to: 'Writer', note: '全部收工了，备份已删，插件全最新。' }, 'a')
  assert.match(receipt, /Left a silent note for Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['inject'])
  const msg = agents.get('b').calls[0][1]
  assert.equal(msg.source.role, 'note')
  assert.equal(msg.source.silent, true)
  assert.match(textOf(msg.content), /^\[Note from Chief · FYI only, no reply needed\]/)
  const log = await exchanges('a', 'b')
  assert.equal(log.length, 1)
  assert.equal(log[0].role, 'note')
})

test('zero-work ping-pong guard pauses empty back-and-forth (including bot_remember) and supports Continue', async (t) => {
  const { rt, agents, emit, tool, call, stop } = await start()
  t.after(stop)

  // Work #W1: Chief delegates, Writer replies with 0 real work tools (only bot_remember!).
  const r1 = await tool('delegate_work', { to: 'Writer', goal: '全部收工了，不用再回' }, 'a')
  assert.match(r1, /#W1/)
  const req1 = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req1.content, source: req1.source })
  emit('b', 'tool/call', { callId: 'm1', name: 'bot_remember', arguments: '{}' })
  emit('b', 'tool/result', { callId: 'm1' })
  emit('b', 'assistant/message', assistantText('收到。我已收工，没有待办。'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 1)

  const reply1 = agents.get('a').calls[0][1]
  assert.match(textOf(reply1.content), /^\[Work #W1 completed by Writer · closed/)

  // Chief wakes on W1 completion, runs 0 work tools, and tries to bounce "好。" back to Writer.
  emit('a', 'turn/start', { turn: 2 })
  emit('a', 'user/message', { content: reply1.content, source: reply1.source })
  const r2 = await tool('delegate_work', { to: 'Writer', goal: '好。' }, 'a')
  assert.match(r2, /^Paused work #W2 before waking Writer/)
  // Writer was NOT woken a second time!
  assert.equal(agents.get('b').calls.length, 1)

  const paused = (await call('state', {})).value.work.paused
  assert.equal(paused.length, 1)
  assert.equal(paused[0].ref, 'W2')
  assert.equal(paused[0].reason, 'idle_loop')
  assert.equal(paused[0].goal, '好。')

  // Clicking Continue dispatches the held delegation verbatim without losing it.
  const resumed = await call('resume-work', { id: paused[0].id })
  assert.equal(resumed.ok, true)
  assert.equal(agents.get('b').calls.length, 2)
  assert.equal(agents.get('b').calls[1][0], 'steer')
  assert.equal(rt.pausedWorksView().length, 0)
})

test('real work tool resets zero-work streak, and user message resets rework checkpoint', async (t) => {
  const { agents, emit, tool, call, stop } = await start()
  t.after(stop)

  // 4 consecutive real-work delegations between Chief and Writer hit the rework checkpoint.
  for (let i = 1; i <= 4; i += 1) {
    const out = await tool('delegate_work', { to: 'Writer', goal: `fix step ${i}` }, 'a')
    assert.match(out, new RegExp(`#W${i}`))
    const req = agents.get('b').calls.at(-1)[1]
    emit('b', 'turn/start', { turn: i })
    emit('b', 'user/message', { content: req.content, source: req.source })
    emit('b', 'tool/call', { callId: `c${i}`, name: 'bash', arguments: '{"command":"ls"}' })
    emit('b', 'tool/result', { callId: `c${i}` })
    emit('b', 'assistant/message', assistantText(`done step ${i}`))
    emit('b', 'turn/end', { turn: i, reason: { kind: 'completed' } })
    await settled(() => (agents.get('a')?.calls.length ?? 0) >= i)
  }

  // 5th consecutive delegation without user input pauses at rework_limit.
  const r5 = await tool('delegate_work', { to: 'Writer', goal: 'fix step 5' }, 'a')
  assert.match(r5, /^Paused work #W5 before waking Writer/)
  const paused = (await call('state', {})).value.work.paused
  assert.equal(paused[0].reason, 'rework_limit')

  // Cancel paused work, then user sends a new message to Chief -> resets pair loops.
  assert.equal((await call('cancel-work', { id: paused[0].id })).ok, true)
  emit('a', 'turn/start', { turn: 99 })
  emit('a', 'user/message', { content: textBlock('continue with Writer'), source: { kind: 'user' } })
  emit('a', 'turn/end', { turn: 99, reason: { kind: 'completed' } })

  const r6 = await tool('delegate_work', { to: 'Writer', goal: 'fresh task after user message' }, 'a')
  assert.match(r6, /^Delegated work #W6 to Writer/)
})

test('ask_back suspends work without closing, answer_work resumes it, and closed work rejects answers', async (t) => {
  const { rt, agents, emit, tool, stop } = await start()
  t.after(stop)

  await tool('delegate_work', { to: 'Writer', goal: 'clean old backups' }, 'a')
  const req = agents.get('b').calls[0][1]

  // Writer works on W1 and calls ask_back instead of finishing.
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req.content, source: req.source })
  emit('b', 'tool/call', { callId: 'b1', name: 'bash', arguments: '{"command":"ls"}' })
  emit('b', 'tool/result', { callId: 'b1' })
  const asked = await tool('ask_back', { question: '删 10 月还是 11 月的备份？' }, 'b')
  assert.match(asked, /Sent your question on work #W1 to Chief/)
  emit('b', 'assistant/message', assistantText('waiting for Chief'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 1)

  // Work W1 is still open in need_input state; Chief received exactly 1 ask_back (no auto-reply close).
  assert.equal(agents.get('a').calls.length, 1)
  const askMsg = agents.get('a').calls[0][1]
  assert.equal(askMsg.source.role, 'ask_back')
  assert.equal(rt.workStateOf(req.source.exchangeId), 'need_input')

  // Chief answers with answer_work -> W1 resumes in Writer!
  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'user/message', { content: askMsg.content, source: askMsg.source })
  const answered = await tool('answer_work', { answer: '删 10 月的。' }, 'a')
  assert.match(answered, /Answered Writer on work #W1/)
  emit('a', 'assistant/message', assistantText('[PASS]'))
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Chief's silent [PASS] turn is hidden in exchangeTurns!
  assert.equal((rt.state.exchangeTurns.a ?? []).includes(1), true)

  assert.equal(agents.get('b').calls.length, 2)
  const answerMsg = agents.get('b').calls[1][1]
  assert.equal(answerMsg.source.role, 'answer')
  assert.equal(rt.workStateOf(req.source.exchangeId), 'open')

  // Writer finishes W1 -> closes and returns final answer to Chief!
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: answerMsg.content, source: answerMsg.source })
  emit('b', 'assistant/message', assistantText('10 月备份已删干净。'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 2)
  assert.equal(agents.get('a').calls[1][1].source.role, 'reply')
  assert.equal(rt.state.works[req.source.exchangeId], undefined)

  // Calling answer_work on closed #W1 is refused cleanly.
  await assert.rejects(() => tool('answer_work', { work_id: 'W1', answer: '收到' }, 'a'), /already closed/)
})

test('cancel_work and stop_bot cancel silently via agent.inject without waking the target or echoing back', async (t) => {
  const { agents, emit, tool, stop } = await start()
  t.after(stop)

  await tool('delegate_work', { to: 'Writer', goal: 'update sidebar' }, 'a')
  const req = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req.content, source: req.source })

  const out = await tool('cancel_work', { target: 'Writer', reason: '手机端边栏不用改了' }, 'a')
  assert.match(out, /Cancelled #W1 silently/)
  // While Writer's turn is still ending, cancel is issued and the silent notice is buffered
  // (never injected into a running agent, which would trigger an extra DSH step).
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'cancel'])

  // When Writer's cancelled turn emits aborted turn/end, the silent notice flushes via
  // agent.inject() without waking Writer, and Chief is NOT woken with an echo.
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await delay(20)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'cancel', 'inject'])
  assert.equal(agents.get('b').calls[2][1].source.role, 'cancelled')
  assert.equal(agents.get('b').calls[2][1].source.silent, true)
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)

  // stop_bot also stops without waking the stopped Bot to reply, flushing once idle.
  emit('c', 'turn/start', { turn: 1 })
  const stopped = await tool('stop_bot', { bot: 'Reviewer', reason: '别动备份' }, 'a')
  assert.match(stopped, /not woken to reply/)
  assert.deepEqual(agents.get('c').calls.map(([kind]) => kind), ['cancel'])
  emit('c', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await delay(20)
  assert.deepEqual(agents.get('c').calls.map(([kind]) => kind), ['cancel', 'inject'])
  assert.equal(agents.get('c').calls[1][1].source.role, 'stopped')
  assert.equal(agents.get('c').calls[1][1].source.silent, true)
})

test('silent stubs like （静默。）/（收工。）/（完。） on Bot-triggered own-chat turns are hidden; user turns stay visible', async (t) => {
  const { rt, emit, stop } = await start()
  t.after(stop)

  // Bot-triggered reply turn outputting "（静默。）" or "（收工。）" -> hidden in exchangeTurns.
  for (const [turn, text] of [[1, '（静默。）'], [2, '（收工。）'], [3, '（完。）'], [4, '[PASS]']]) {
    emit('a', 'turn/start', { turn })
    emit('a', 'user/message', { content: textBlock('[Work #W1 completed by Writer · closed]\ndone'), source: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b', exchangeId: `r${turn}` } })
    emit('a', 'assistant/message', assistantText(text))
    emit('a', 'turn/end', { turn, reason: { kind: 'completed' } })
    assert.equal((rt.state.exchangeTurns.a ?? []).includes(turn), true, `turn ${turn} (${text}) should be hidden`)
  }

  // Bot-triggered reply turn with real report to user -> stays visible!
  emit('a', 'turn/start', { turn: 5 })
  emit('a', 'user/message', { content: textBlock('[Work #W1 completed by Writer · closed]\ndone'), source: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b', exchangeId: 'r5' } })
  emit('a', 'assistant/message', assistantText('Writer 已经把备份清理完了。'))
  emit('a', 'turn/end', { turn: 5, reason: { kind: 'completed' } })
  assert.equal((rt.state.exchangeTurns.a ?? []).includes(5), false)

  // User-triggered turn outputting "（收工。）" -> NEVER hidden!
  emit('a', 'turn/start', { turn: 6 })
  emit('a', 'user/message', { content: textBlock('收工了吗'), source: { kind: 'user' } })
  emit('a', 'assistant/message', assistantText('（收工。）'))
  emit('a', 'turn/end', { turn: 6, reason: { kind: 'completed' } })
  assert.equal((rt.state.exchangeTurns.a ?? []).includes(6), false)
})

test('nested ask_back tree keeps parent waiting, pauses on 2nd zero-work ask_back, and finishes after resume-work', async (t) => {
  const { rt, agents, emit, tool, call, stop } = await start()
  t.after(stop)

  // Chief delegates #W1 to Writer.
  await tool('delegate_work', { to: 'Writer', goal: 'audit host backups' }, 'a')
  const req1 = agents.get('b').calls[0][1]

  // Writer delegates child #W2 to Reviewer and ends turn waiting.
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req1.content, source: req1.source })
  await tool('delegate_work', { to: 'Reviewer', goal: 'check /var/backups on host' }, 'b')
  emit('b', 'assistant/message', assistantText('asked Reviewer to check'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(agents.get('a')?.calls.length ?? 0, 0, 'Chief must wait while child #W2 is open')

  const req2 = agents.get('c').calls[0][1]
  // Reviewer calls ask_back #1 with 0 work tools -> wakes Writer inside #W1 (hidden!).
  emit('c', 'turn/start', { turn: 1 })
  emit('c', 'user/message', { content: req2.content, source: req2.source })
  const ask1 = await tool('ask_back', { question: '查哪台宿主机？' }, 'c')
  assert.match(ask1, /Sent your question on work #W2 to Writer/)
  emit('c', 'assistant/message', assistantText('waiting for host name'))
  emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => agents.get('b').calls.length >= 2)

  const askMsg1 = agents.get('b').calls[1][1]
  assert.equal(askMsg1.source.role, 'ask_back')
  assert.equal(askMsg1.source.work, req1.source.exchangeId)

  // Writer answers #W2 without prematurely closing #W1 to Chief!
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: askMsg1.content, source: askMsg1.source })
  assert.equal((rt.state.exchangeTurns.b ?? []).includes(2), true, 'nested ask_back turn in Writer stays hidden')
  await tool('answer_work', { answer: '查 host-01 宿主机。' }, 'b')
  emit('b', 'assistant/message', assistantText('[PASS]'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(agents.get('a')?.calls.length ?? 0, 0, 'answering child ask_back must not prematurely close parent #W1')

  const ansMsg1 = agents.get('c').calls[1][1]
  assert.equal(ansMsg1.source.role, 'answer')

  // Reviewer calls ask_back #2 STILL with 0 work tools -> pauses at ask_back_limit!
  emit('c', 'turn/start', { turn: 2 })
  emit('c', 'user/message', { content: ansMsg1.content, source: ansMsg1.source })
  const ask2 = await tool('ask_back', { question: '那目录路径是 /var 还是 /opt？' }, 'c')
  assert.match(ask2, /^Paused your question on work #W2 for the user/)
  emit('c', 'assistant/message', assistantText('paused for user'))
  emit('c', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(agents.get('b').calls.length, 2, 'Writer must NOT be woken while #W2 is paused')

  const paused = (await call('state', {})).value.work.paused
  assert.equal(paused.length, 1)
  assert.equal(paused[0].ref, 'W2')
  assert.equal(paused[0].reason, 'ask_back_limit')

  // User clicks Continue on the pause card -> delivers ask_back #2 to Writer.
  assert.equal((await call('resume-work', { id: paused[0].id })).ok, true)
  await settled(() => agents.get('b').calls.length >= 3)
  const askMsg2 = agents.get('b').calls[2][1]
  assert.equal(askMsg2.source.role, 'ask_back')
  assert.match(textOf(askMsg2.content), /\/var 还是 \/opt/)

  // Writer answers #2, Reviewer finishes #W2, Writer finishes #W1 -> Chief receives combined answer!
  emit('b', 'turn/start', { turn: 3 })
  emit('b', 'user/message', { content: askMsg2.content, source: askMsg2.source })
  await tool('answer_work', { answer: '查 /var/backups。' }, 'b')
  emit('b', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  const ansMsg2 = agents.get('c').calls[2][1]

  emit('c', 'turn/start', { turn: 3 })
  emit('c', 'user/message', { content: ansMsg2.content, source: ansMsg2.source })
  emit('c', 'tool/call', { callId: 'ssh1', name: 'bash', arguments: '{"command":"ls /var/backups"}' })
  emit('c', 'tool/result', { callId: 'ssh1' })
  emit('c', 'assistant/message', assistantText('/var/backups 已清空。'))
  emit('c', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await settled(() => agents.get('b').calls.length >= 4)

  const reply2 = agents.get('b').calls[3][1]
  emit('b', 'turn/start', { turn: 4 })
  emit('b', 'user/message', { content: reply2.content, source: reply2.source })
  emit('b', 'assistant/message', assistantText('宿主机备份核对完成。'))
  emit('b', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 1)

  const finalToChief = textOf(agents.get('a').calls[0][1].content)
  assert.match(finalToChief, /宿主机备份核对完成/)
  assert.match(finalToChief, /\/var\/backups 已清空/)
  assert.deepEqual(Object.keys(rt.state.works ?? {}), [])
})

test('group zero-work cycle pauses (even with bot_remember), preserves 1-hop Q&A, and supports resume-room-pause', async (t) => {
  const seed = team()
  seed.rooms = {
    r1: {
      id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
      sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {},
    },
  }
  const { rt, agentOf, emit, tool, call, stop } = await start(seed)
  t.after(stop)
  const turns = new Map()
  const begin = (sid) => {
    const [, msg] = agentOf(sid).calls.at(-1)
    const turn = (turns.get(sid) ?? 0) + 1
    turns.set(sid, turn)
    emit(sid, 'turn/start', { turn })
    emit(sid, 'user/message', { content: msg.content, source: msg.source })
    return turn
  }
  const finish = (sid, reply) => {
    emit(sid, 'assistant/message', assistantText(reply))
    emit(sid, 'turn/end', { turn: turns.get(sid), reason: { kind: 'completed' } })
  }
  const runRound = (callId, message) => {
    emit('r1', 'user/message', message)
    let out
    const ac = new AbortController()
    t.after(() => ac.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: ac.signal }).then(async v => { out = await afterRound(rt, 'r1', v) })
    return () => out
  }

  // Case A: legitimate 1-hop Q&A (User -> Chief -> Writer -> Chief -> User) with 0 tools completes without pausing!
  const qa = runRound('c1', { content: textBlock('@Chief 问下 Writer 配置在哪'), source: { kind: 'user' } })
  await settled(() => agentOf('ga').calls.length === 1)
  begin('ga')
  finish('ga', '@Writer 配置在哪？')
  await settled(() => agentOf('gb').calls.length === 1)
  begin('gb')
  finish('gb', '@Chief 在 /etc/app.conf')
  await settled(() => agentOf('ga').calls.length === 2)
  begin('ga')
  finish('ga', 'Writer 说在 /etc/app.conf。')
  await settled(() => qa() !== undefined)
  assert.equal(qa().replies.filter(r => r.kind === 'paused').length, 0, '1-hop Q&A must NOT pause')
  assert.equal(rt.state.rooms.r1.idlePaused, undefined)

  // Case B: zero-work cycle (Chief -> Writer -> Chief -> Writer) calling ONLY bot_remember pauses immediately!
  const cycle = runRound('c2', { content: textBlock('@Chief 核对一下'), source: { kind: 'user' } })
  await settled(() => agentOf('ga').calls.length === 3)
  begin('ga')
  finish('ga', '@Writer 核对一下')
  await settled(() => agentOf('gb').calls.length === 2)
  begin('gb')
  emit('gb', 'tool/call', { callId: 'mem1', name: 'bot_remember', arguments: '{}' })
  emit('gb', 'tool/result', { callId: 'mem1' })
  finish('gb', '@Chief 我记住规则了，你再核对下')
  await settled(() => agentOf('ga').calls.length === 4)
  begin('ga')
  emit('ga', 'tool/call', { callId: 'mem2', name: 'bot_remember', arguments: '{}' })
  emit('ga', 'tool/result', { callId: 'mem2' })
  finish('ga', '@Writer 好，你确认一下')
  await settled(() => cycle() !== undefined)

  assert.equal(cycle().replies.filter(r => r.kind === 'paused').length, 1, 'zero-work cycle with bot_remember must pause')
  assert.equal(agentOf('gb').calls.length, 2, 'Writer must NOT be woken again on cycle pause')
  assert.ok(rt.state.rooms.r1.idlePaused !== undefined)
  assert.equal(rt.state.rooms.r1.paused?.length, 1)

  // Case C: clicking Continue (resume-room-pause) clears idlePaused and triggers a new round with parked @Writer.
  const res = await call('resume-room-pause', { roomId: 'r1' })
  assert.equal(res.ok, true)
  assert.equal(res.value, true)
  assert.equal(rt.state.rooms.r1.idlePaused, undefined)
  assert.equal(agentOf('r1').calls.length, 1, 'resume-room-pause posts a quiet resume trigger to the room Session')
  const resumePost = agentOf('r1').calls[0][1]
  const resumedRound = runRound('c3', { content: resumePost.content, source: resumePost.source })
  await settled(() => agentOf('gb').calls.length === 3)
  begin('gb')
  finish('gb', '已继续核对完成。')
  await settled(() => resumedRound() !== undefined)
  assert.equal(rt.state.rooms.r1.paused, undefined)
})

test('part-switch forward preserves zero-wake agent.inject for silent notes and cancellations', async (t) => {
  const { agentOf, emit, fire, stop } = await start()
  t.after(stop)

  const oldAgent = agentOf('b')
  oldAgent.inbox.nextStep.push(
    { id: 'm-note', role: 'user', content: textBlock('[Note from Chief · FYI only, no reply needed]\n备份已删'), source: { kind: SOURCE_KIND, role: 'note', silent: true, exchangeId: 'ex-note' } },
    { id: 'm-cancel', role: 'user', content: textBlock('[Work #W1 cancelled by Chief · no reply needed]\n不用做了'), source: { kind: SOURCE_KIND, role: 'cancelled', silent: true, exchangeId: 'ex-cancel' } },
  )
  oldAgent.inbox.nextTurn.push(
    { id: 'm-req', role: 'user', content: textBlock('[Work #W2 from Chief]\n开始下一个任务'), source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'ex-req', senderSessionId: 'a', senderName: 'Chief' } },
  )
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('earlier task'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('halfway'))
  await fire('agent/request-error', { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000), agent: oldAgent })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })

  await settled(() => (agentOf('s1').calls.some(([, m]) => m.source?.exchangeId === 'ex-req')))
  const forwarded = agentOf('s1').calls.filter(([, m]) => ['ex-note', 'ex-cancel', 'ex-req'].includes(m.source?.exchangeId))
  const byId = Object.fromEntries(forwarded.map(([kind, m]) => [m.source.exchangeId, kind]))
  assert.equal(byId['ex-note'], 'inject', 'silent note must forward via inject (zero-wake)')
  assert.equal(byId['ex-cancel'], 'inject', 'silent cancellation must forward via inject (zero-wake)')
  assert.equal(byId['ex-req'], 'followup', 'normal work request must forward via followup (waking)')
})
