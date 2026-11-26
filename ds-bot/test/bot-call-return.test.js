import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { afterRound } from './relay-rows.js'
import { fakeContext } from './fake-ctx.js'
import { isAckLikeText, isSilentTurnText, isWorkTool, PAIR_LOOP_TTL_MS, SOURCE_KIND } from '../src/host/constants.js'
import { isRelayContext, stripHeader } from '../src/client/text.js'
import { BROWSER_ALLOWED } from '../src/shared/browser-endpoints.js'
import { roomItems } from '../src/host/mobile.js'
import { extractGroupSessionLines } from '../src/host/groups.js'

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
    sessions: { flush: async () => {}, messageProjections: [], get: id => agentOf(id).session },
  })
  ctx.get = key => (key === 'agents' ? agents : undefined)
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

const settled = async (pred, timeoutMs = 5000, label = 'condition did not settle') => {
  const deadline = Date.now() + timeoutMs
  while (!pred() && Date.now() < deadline) await delay(10)
  assert.ok(pred(), label)
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

test('a closed result cannot create another root delegation without its work reference', async (t) => {
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
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: '好。' }, 'a'), /Not sent: this is a result/)
  await assert.rejects(tool('delegate_work', { to: 'Writer', goal: 'check again', follow_up_to: 'W99' }, 'a'), /must identify the completed work/)
  assert.equal(agents.get('b').calls.length, 1)
  assert.deepEqual((await call('state', {})).value.work.paused, [])
  assert.equal(rt.pausedWorksView().length, 0)
  const next = await tool('delegate_work', { to: 'Writer', goal: 'Which backup can be restored?', follow_up_to: '#W1' }, 'a')
  assert.match(next, /^Delegated work #W2/)
  assert.equal(agents.get('b').calls.at(-1)[1].source.follows, 'W1')
})

test('different goals with real results do not hit a fixed rework limit', async (t) => {
  const { agents, emit, tool, call, stop } = await start()
  t.after(stop)

  // Distinct steps of a project keep going without an arbitrary fixed turn cutoff.
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

  const r5 = await tool('delegate_work', { to: 'Writer', goal: 'fix step 5' }, 'a')
  assert.match(r5, /^Delegated work #W5 to Writer/)
  const paused = (await call('state', {})).value.work.paused
  assert.equal(paused.length, 0)

  assert.equal((await call('cancel-work', { id: 'W5' })).ok, true)
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
  await settled(() => agents.get('b').calls.length >= 3)
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
  await settled(() => agents.get('c').calls.length >= 2)
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

test('a group answer returns once; mentioning the worker while reporting a result does not call it', async (t) => {
  const seed = team()
  seed.rooms = {
    r1: {
      id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
      sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {},
    },
  }
  const { rt, agentOf, emit, tool, stop } = await start(seed)
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
    const ac = new AbortController()
    t.after(() => ac.abort())
    return tool('group_relay', {}, 'r1', { callId, signal: ac.signal }).then(v => afterRound(rt, 'r1', v))
  }

  // Case A: legitimate 1-hop Q&A (User -> Chief -> Writer -> Chief -> User) with 0 tools completes without pausing!
  const qaPromise = runRound('c1', { content: textBlock('@Chief 问下 Writer 配置在哪'), source: { kind: 'user' } })
  await settled(() => agentOf('ga').calls.length === 1)
  begin('ga')
  finish('ga', '@Writer 配置在哪？')
  await settled(() => agentOf('gb').calls.length === 1)
  begin('gb')
  finish('gb', '@Chief 在 /etc/app.conf')
  await settled(() => agentOf('ga').calls.length === 2)
  begin('ga')
  finish('ga', 'Writer 说在 /etc/app.conf。')
  const qa = await qaPromise
  assert.equal(qa.replies.filter(r => r.kind === 'paused').length, 0, '1-hop Q&A must NOT pause')
  assert.equal(rt.state.rooms.r1.idlePaused, undefined)

  // Even if both Bots use another tool, their receipt cannot turn back into a request.
  const cyclePromise = runRound('c2', { content: textBlock('@Chief 核对一下'), source: { kind: 'user' } })
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
  const cycle = await cyclePromise

  assert.equal(cycle.replies.filter(r => r.kind === 'paused').length, 0)
  assert.equal(agentOf('gb').calls.length, 2)
  assert.equal(rt.state.rooms.r1.idlePaused, undefined)
  assert.equal(rt.state.rooms.r1.log.at(-1).route.kind, 'note')
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

test('P0 #1: note_bot on a running Bot buffers silently until idle (never injects mid-turn, never enters unreadOf)', async (t) => {
  const { rt, agentOf, emit, tool, stop } = await start()
  t.after(stop)

  const writer = agentOf('b')
  writer.status = 'running'
  let resolveIdle
  writer.whenIdle = () => new Promise((resolve) => { resolveIdle = resolve })
  emit('b', 'turn/start', { turn: 1 })

  await tool('note_bot', { to: 'Writer', note: '宿主机备份已清空，供下次参考' }, 'a')
  // Must NOT inject while Writer is running (would trigger extra DSH step) and must NOT pollute unreadOf.
  assert.equal(writer.calls.length, 0)
  assert.deepEqual(rt.unreadOf('b'), [])

  // Once Writer finishes its turn and becomes idle, the buffered silent note flushes via inject.
  writer.status = 'idle'
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  resolveIdle?.()
  await settled(() => writer.calls.length === 1)
  assert.equal(writer.calls[0][0], 'inject')
  assert.equal(writer.calls[0][1].source.role, 'note')
  assert.equal(writer.calls[0][1].source.silent, true)
  assert.deepEqual(rt.unreadOf('b'), [])
})

test('P0 #2: bot-handoff background task stays waiting_work on ask_back and receives answer_work in its task session', async (t) => {
  const { rt, agentOf, emit, tool, stop } = await start()
  t.after(stop)

  // Writer's foreground chat is busy running a tool for the user, so Chief's delegation spawns a bot-handoff task ('s1').
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('用户正在和 Writer 聊天'), source: { kind: 'user' } })
  emit('b', 'tool/call', { callId: 'fg-bash', name: 'bash', arguments: '{"command":"ls"}' })

  const delegated = await tool('delegate_work', { to: 'Writer', goal: '整理部署清单' }, 'a')
  assert.match(delegated, /background task/)
  const task = rt.state.bots.b.tasks.find(item => item.origin === 'bot-handoff')
  assert.ok(task, 'bot-handoff task created')
  const work = rt.resolveWork('W1')?.work
  assert.equal(work?.toSession, task.sessionId)
  assert.equal(work?.toTaskId, task.id)

  // Task runs and calls ask_back, then its turn ends cleanly.
  const req = agentOf(task.sessionId).calls[0][1]
  emit(task.sessionId, 'turn/start', { turn: 1 })
  emit(task.sessionId, 'user/message', { content: req.content, source: req.source })
  await tool('ask_back', { question: '要包含灰度环境吗？' }, task.sessionId)
  emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)

  // Task must remain waiting_work (NOT completed), and restart reconciliation must keep it waiting_work (NOT interrupted).
  assert.equal(task.status, 'waiting_work')
  assert.equal(rt.workStateOf(task.exchangeId), 'need_input')
  await rt.reconcileTasksAfterRestart(new Set())
  assert.equal(task.status, 'waiting_work')
  assert.equal(rt.workStateOf(task.exchangeId), 'need_input')

  // Chief answers via answer_work -> delivered to the background task session, NOT Writer's foreground chat!
  const fgCallsBefore = agentOf('b').calls.length
  await tool('answer_work', { answer: '只包含生产环境。' }, 'a')
  assert.equal(agentOf('b').calls.length, fgCallsBefore, 'foreground chat must NOT receive background task answer')
  const taskAnswer = agentOf(task.sessionId).calls.find(([, m]) => m.source?.role === 'answer')
  assert.ok(taskAnswer, 'background task session must receive answer_work')
  assert.match(textOf(taskAnswer[1].content), /\[Work #W1 · Chief answered your question/)
})

test('P0 #4: concurrent resumePausedWork dispatches once, cancel_work/stop_bot wake waiting parent, and mid-turn ask_back defers cleanly', async (t) => {
  const { rt, agentOf, emit, tool, stop } = await start()
  t.after(stop)

  // 1) Concurrent resumePausedWork dispatches only once.
  rt.openWork('w-paused', {
    from: 'a', to: 'b', goal: 'run once', state: 'paused',
    paused: { reason: 'idle_loop', kind: 'delegate', text: 'run once', when: 'now', bounces: 2, at: Date.now() },
  })
  const [r1, r2] = await Promise.all([rt.resumePausedWork('w-paused'), rt.resumePausedWork('w-paused')])
  assert.deepEqual([r1, r2].sort(), [false, true])
  assert.equal(agentOf('b').calls.filter(([, m]) => m.source?.exchangeId === 'w-paused').length, 1)

  // 2) Cancel child work #W2 via cancel_work wakes waiting parent #W1 on Writer.
  await tool('delegate_work', { to: 'Writer', goal: 'parent task' }, 'a')
  const parentReq = agentOf('b').calls.at(-1)[1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: parentReq.content, source: parentReq.source })
  await tool('delegate_work', { to: 'Reviewer', goal: 'child task' }, 'b')
  const childId = agentOf('c').calls.at(-1)[1].source.exchangeId
  const childRef = rt.workRefOf(childId)
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Chief (Main Bot) cancels Reviewer's child work while Writer is idle waiting for it.
  const writerBefore = agentOf('b').calls.length
  await tool('cancel_work', { target: childRef, reason: 'skip reviewer step' }, 'a')
  assert.equal(agentOf('b').calls.length, writerBefore + 1, 'waiting parent Writer must be woken when child is cancelled')
  const parentWake = agentOf('b').calls.at(-1)[1]
  assert.equal(parentWake.source.work, parentReq.source.exchangeId)
  assert.match(textOf(parentWake.content), /cancelled by Chief/)
  assert.deepEqual(rt.unreadOf('c'), [], 'cancelled child work must be cleared from unreadOf')

  // 3) Mid-turn top-level ask_back on a busy caller defers to a follow-up turn with askWork + workRef preserved.
  await tool('delegate_work', { to: 'Reviewer', goal: 'check config' }, 'a')
  const topReq = agentOf('c').calls.at(-1)[1]
  const topWorkId = topReq.source.exchangeId
  const topWorkRef = topReq.source.workRef
  // Chief is busy in a user turn when Reviewer calls ask_back.
  emit('a', 'turn/start', { turn: 10 })
  emit('a', 'user/message', { content: textBlock('用户正在和 Chief 聊别的'), source: { kind: 'user' } })
  emit('c', 'turn/start', { turn: 10 })
  emit('c', 'user/message', { content: topReq.content, source: topReq.source })
  await tool('ask_back', { question: '确认端口号？' }, 'c')
  const askMsg = agentOf('a').calls.at(-1)[1]
  emit('a', 'user/message', { content: askMsg.content, source: askMsg.source })
  emit('a', 'turn/end', { turn: 10, reason: { kind: 'completed' } })
  await settled(() => agentOf('a').calls.some(([, m]) => m.source?.role === 'ask_back' && m.source?.deferred === true))
  const deferredAsk = agentOf('a').calls.find(([, m]) => m.source?.role === 'ask_back' && m.source?.deferred === true)[1]
  assert.equal(deferredAsk.source.askWork, topWorkId)
  assert.equal(deferredAsk.source.workRef, topWorkRef)
  assert.match(textOf(deferredAsk.content), new RegExp(`\\[Work #${topWorkRef} · Reviewer asked during your last task`))

  // 4) Cancelled joined request is NOT re-delivered as deferred at turn/end.
  emit('c', 'turn/end', { turn: 10, reason: { kind: 'completed' } })
  emit('c', 'turn/start', { turn: 11 })
  emit('c', 'user/message', { content: textBlock('doing user work'), source: { kind: 'user' } })
  await tool('delegate_work', { to: 'Reviewer', goal: 'will be cancelled mid-turn' }, 'a')
  const joinedReq = agentOf('c').calls.at(-1)[1]
  emit('c', 'user/message', { content: joinedReq.content, source: joinedReq.source })
  await tool('cancel_work', { target: joinedReq.source.workRef, reason: 'no longer needed' }, 'a')
  const cCallsBeforeEnd = agentOf('c').calls.length
  emit('c', 'turn/end', { turn: 11, reason: { kind: 'completed' } })
  await delay(30)
  const deferredJoined = agentOf('c').calls.slice(cCallsBeforeEnd).filter(([, m]) => m.source?.exchangeId === joinedReq.source.exchangeId && m.source?.deferred === true)
  assert.equal(deferredJoined.length, 0, 'cancelled joined request must not be re-delivered')
})

test('P0 #5 & P1 #1: group fan-out completes without pause, alreadyPaused holds non-ack calls, and resumedPause stays invisible', async (t) => {
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
    const ac = new AbortController()
    t.after(() => ac.abort())
    return tool('group_relay', {}, 'r1', { callId, signal: ac.signal }).then(v => afterRound(rt, 'r1', v))
  }

  // Parallel fan-out: User -> Chief -> @Writer @Reviewer -> both answer @Chief (0 tools) -> Chief answers user.
  const fanoutPromise = runRound('f1', { content: textBlock('@Chief 让 Writer 和 Reviewer 各自说下结论'), source: { kind: 'user' } })
  await settled(() => agentOf('ga').calls.length === 1)
  begin('ga')
  finish('ga', '@Writer @Reviewer 各自给下结论')
  await settled(() => agentOf('gb').calls.length === 1 && agentOf('gc').calls.length === 1)
  begin('gb')
  finish('gb', '@Chief 我这边文案部分 OK')
  begin('gc')
  finish('gc', '@Chief 我这边运维部分 OK')
  await settled(() => agentOf('ga').calls.length === 2)
  begin('ga')
  finish('ga', '两边都确认 OK，汇总完毕。')
  const fanout = await fanoutPromise
  assert.equal(fanout.replies.filter(r => r.kind === 'paused').length, 0, 'parallel fan-out must NOT false-pause')
  assert.equal(rt.state.rooms.r1.idlePaused, undefined)

  // Already-paused room holds even non-ack byBot calls instead of leaking them.
  rt.state.rooms.r1.idlePaused = { from: 'a', count: 2, noticed: true }
  const heldRoundPromise = runRound('f2', { content: textBlock('@Writer 顺便问一句'), source: { kind: 'bot', role: 'post', senderSessionId: 'a', senderName: 'Chief', roomId: 'r1' } })
  await settled(() => agentOf('gb').calls.length === 2)
  begin('gb')
  finish('gb', '@Reviewer 帮我看一下接口文档第三节细节')
  await heldRoundPromise
  assert.equal(agentOf('gc').calls.length, 1, 'non-ack byBot call in already-paused room must be held, not leaked')
  assert.ok(rt.state.rooms.r1.paused?.some(p => p.id === 'c'))

  // resumedPause event is hidden in displayItems and never logged as a User line in joinRound.
  const resumeRes = await call('resume-room-pause', { roomId: 'r1' })
  assert.equal(resumeRes.ok, true)
  const resumeMsg = agentOf('r1').calls.at(-1)[1]
  assert.equal(resumeMsg.source.resumedPause, true)
  const displayed = rt.displayItems('r1', [{ type: 'user/message', seq: 99, time: Date.now(), data: { content: resumeMsg.content, source: resumeMsg.source } }])
  assert.deepEqual(displayed, [], 'resumedPause must NOT emit a visible post in displayItems')
})

test('P0 #6, P0 #7, P0 #8: privacy guards, show_view non-hiding, and prototype key safety', async (t) => {
  const seed = team()
  seed.bots.c.private = true
  const { rt, ctx, emit, call, stop } = await start(seed)
  t.after(stop)
  const approvalPrompts = []
  const prevGet = ctx.get
  ctx.get = key => (key === 'approval'
    ? { request: async (req) => { approvalPrompts.push(req); return 'rejected' } }
    : prevGet(key))
  const invokeGuarded = async (name, args, sessionId) => {
    const exec = {
      name,
      arguments: args,
      agent: { id: sessionId, session: { id: sessionId } },
    }
    for (const listener of ctx.listeners.get('tools/execute') ?? []) {
      await listener(exec, () => Promise.resolve())
    }
    return rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  }

  // P0 #6: cancel_work by work ref targeting a private Bot is blocked;
  // private Bot cancelling work on another Bot with reason requests user approval;
  // answer_work checks turn.info.askWork first so approval names the exact worker.
  rt.openWork('priv-w', { from: 'a', to: 'c', goal: 'secret work' })
  const privRef = rt.workRefOf('priv-w')
  await assert.rejects(() => invokeGuarded('cancel_work', { target: privRef, reason: 'stop' }, 'a'), /private Bot/)

  rt.openWork('priv-out', { from: 'c', to: 'b', goal: 'private out' })
  const privOutRef = rt.workRefOf('priv-out')
  await assert.rejects(() => invokeGuarded('cancel_work', { target: privOutRef, reason: 'private detail' }, 'c'), /did not allow|denied|approval/i)
  assert.equal(approvalPrompts.length, 1)
  assert.match(approvalPrompts[0].reason, /Writer/)
  assert.match(approvalPrompts[0].reason, /private detail/)

  // Two need_input works for private Bot c (to 'a' and to 'b'): during a turn whose askWork is 'w-ask-b',
  // privacy.js must ask approval to send to Writer ('b'), NOT Chief ('a').
  rt.openWork('w-ask-a', { from: 'c', to: 'a', goal: 'ask a', state: 'need_input' })
  rt.openWork('w-ask-b', { from: 'c', to: 'b', goal: 'ask b', state: 'need_input' })
  emit('c', 'turn/start', { turn: 30 })
  emit('c', 'user/message', { content: textBlock('[Work · Writer asks before continuing]\nq'), source: { kind: SOURCE_KIND, role: 'ask_back', askWork: 'w-ask-b', senderSessionId: 'b', exchangeId: 'ex-ask-b' } })
  approvalPrompts.length = 0
  await assert.rejects(() => invokeGuarded('answer_work', { answer: 'secret answer for B' }, 'c'), /did not allow|denied|approval/i)
  assert.equal(approvalPrompts.length, 1)
  assert.match(approvalPrompts[0].reason, /Writer/, 'answer_work approval must align with turn.info.askWork (Writer), not first need_input work (Chief)')
  emit('c', 'turn/end', { turn: 30, reason: { kind: 'completed' } })

  // P0 #7: show_view turn with empty text is NOT auto-hidden in exchangeTurns.
  emit('a', 'turn/start', { turn: 21 })
  emit('a', 'user/message', { content: textBlock('[Work #W1 completed by Writer · closed]\ndone'), source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-view', senderSessionId: 'b' } })
  emit('a', 'tool/call', { callId: 'v1', name: 'show_view', arguments: '{"title":"Chart"}' })
  emit('a', 'tool/result', { callId: 'v1' })
  emit('a', 'assistant/message', assistantText(''))
  emit('a', 'turn/end', { turn: 21, reason: { kind: 'completed' } })
  assert.ok(!(rt.state.exchangeTurns.a ?? []).includes(21), 'turn with show_view must NOT be auto-hidden')

  // P0 #8: prototype keys cannot resolve works or pollute closedWorks.
  assert.equal(rt.resolveWork('toString'), undefined)
  assert.equal(rt.resolveWork('constructor'), undefined)
  assert.equal(rt.closedWorkOf('__proto__'), undefined)
  const badResume = await call('resume-work', { id: 'toString' })
  const badCancel = await call('cancel-work', { id: 'constructor' })
  assert.equal(badResume.ok, false)
  assert.equal(badCancel.ok, false)
  assert.equal(Object.hasOwn(rt.state.closedWorks ?? {}, 'constructor'), false)
})

test('P1 #2, P1 #3, P1 #5: deliver_to user loop guard, substantive pure-LLM 2-step flow, TTL, client HEADER/RELAY_ROLES, BROWSER_ALLOWED', async (t) => {
  const { rt, emit, tool, stop } = await start()
  t.after(stop)

  // Distinct sections of text are progress even without a tool call.
  rt.noteWorkCompleted('a', 'b', { worked: false, text: 'Here is the complete first draft of section one with detailed technical rationale and examples.' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Please expand section two with migration steps and edge cases.' }), { ok: true })
  rt.noteWorkCompleted('a', 'b', { worked: false, text: 'Here is the expanded section two draft covering all migration steps.' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Now refine section three with rollout checklists.' }), { ok: true })
  rt.noteWorkCompleted('a', 'b', { worked: false, text: 'Here is the complete section three rollout checklist.' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Now translate section four into concise release notes.' }), { ok: true })
  rt.noteWorkCompleted('a', 'b', { worked: false, text: 'Here is the translated section four release note draft.' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Now review section five appendix.' }), { ok: true })

  // True ack-like or reciprocal alternating zero-work ping-pong still pauses immediately at 2 (idle_loop).
  rt.resetPairLoop('a', 'b')
  rt.noteWorkCompleted('a', 'b', { worked: false, text: 'Here is the complete first draft of section one.' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: '收到，谢谢！' }), { pause: 'idle_loop', bounces: 2 })
  assert.deepEqual(rt.checkPairLoop('b', 'a', { callerWorked: false, text: 'Please review the attached section outline.' }), { pause: 'idle_loop', bounces: 2 })
  rt.resetPairLoop('a', 'b')
  rt.noteWorkCompleted('a', 'b', { worked: false, text: '收到，已收工。' })
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Please translate section two into Japanese.' }), { pause: 'idle_loop', bounces: 2 })

  // Expired pairLoops entry (> PAIR_LOOP_TTL_MS) resets cleanly.
  rt.state.pairLoops['a:b'].lastAt = Date.now() - PAIR_LOOP_TTL_MS - 1000
  assert.deepEqual(rt.checkPairLoop('a', 'b', { callerWorked: false, text: 'Fresh task after 15 minutes' }), { ok: true })

  // deliver_to: 'user' reciprocal ping-pong pauses immediately on bounce back and preserves toUser: true.
  rt.resetPairLoop('a', 'b')
  await tool('delegate_work', { to: 'Writer', goal: 'Tell the user status A', deliver_to: 'user' }, 'a')
  const bounced = await tool('delegate_work', { to: 'Chief', goal: 'Tell the user status B', deliver_to: 'user' }, 'b')
  assert.match(bounced, /Paused work/)
  const pausedWork = Object.values(rt.state.works).find(w => w.state === 'paused')
  assert.equal(pausedWork?.paused?.toUser, true)

  // Client HEADER stripping, RELAY_ROLES, BROWSER_ALLOWED, and displayItems silent hiding parity.
  assert.equal(stripHeader('[Work #W1 completed by Writer · closed]\n实际结果'), '实际结果')
  assert.equal(stripHeader('[Note from Chief · FYI only, no reply needed]\n备忘内容'), '备忘内容')
  assert.equal(stripHeader('[Stopped by Chief · no reply needed]\n停止原因'), '停止原因')
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'ask_back', senderSessionId: 'b' } }), true)
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'answer', senderSessionId: 'a' } }), true)
  assert.equal(BROWSER_ALLOWED.has('resume-work'), true)
  assert.equal(BROWSER_ALLOWED.has('cancel-work'), true)
  assert.equal(BROWSER_ALLOWED.has('resume-room-pause'), true)

  const silentItems = rt.displayItems('b', [
    { type: 'user/message', seq: 1, time: 1, data: { content: textBlock('[Note from Chief · FYI only, no reply needed]\nhi'), source: { kind: SOURCE_KIND, role: 'note', silent: true, senderSessionId: 'a', senderName: 'Chief' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: textBlock('[Work #W1 cancelled by Chief · no reply needed]\nstop'), source: { kind: SOURCE_KIND, role: 'cancelled', silent: true, senderSessionId: 'a', senderName: 'Chief' } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: textBlock('[Stopped by Chief · no reply needed]\nstop'), source: { kind: SOURCE_KIND, role: 'stopped', silent: true, senderSessionId: 'a', senderName: 'Chief' } } },
  ])
  assert.deepEqual(silentItems, [], 'silent note/cancelled/stopped must stay hidden in displayItems just like live TriggerCell')
  void emit
})

test('P0 #3: reload reconciliation keeps need_input work open instead of prematurely closing it, and skips cancelled works', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reload-callret-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const seed = team()
  seed.works = {
    'w-need': { ref: 'W1', state: 'need_input', from: 'a', to: 'b', question: '哪台机器？', rounds: 1, worked: false, open: [], results: [], at: Date.now() },
  }
  seed.closedWorks = {
    'w-canc': { id: 'w-canc', ref: 'W2', from: 'a', to: 'b', status: 'cancelled', at: Date.now() },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  // Simulate inflight.json left behind right after Writer called ask_back and DS Bot reloaded.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      b: {
        botId: 'b',
        since: Date.now() - 1000,
        trigger: { role: 'request', exchangeId: 'w-need', senderSessionId: 'a', workRef: 'W1' },
      },
    },
    queued: {
      b: [
        { at: Date.now() - 500, args: { fromId: 'a', toId: 'b', role: 'note', wake: false, text: 'legacy silent note', exchangeId: 'ex-legacy-note' } },
        { at: Date.now() - 400, args: { fromId: 'a', toId: 'b', role: 'request', text: 'already cancelled', exchangeId: 'w-canc' } },
      ],
    },
  }))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => [] },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      inspect: async (sessionId) => ({
        events: sessionId === 'b' ? [
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
          { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w-need', senderSessionId: 'a', workRef: 'W1' }, content: textBlock('deploy') } },
          { type: 'assistant/message', seq: 3, data: { message: { content: textBlock('等待 Chief 回复中') } } },
          { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
        ] : [],
      }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [], get: id => agentOf(id).session },
  })
  const origSetTimeout = globalThis.setTimeout
  // Trigger resumeAll immediately instead of waiting RESUME_DELAY_MS (3000ms).
  let resumeFn
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 3000) { resumeFn = fn; return { unref() {} } }
    return origSetTimeout(fn, ms, ...rest)
  }
  const rt = createRuntime(ctx, { home })
  globalThis.setTimeout = origSetTimeout
  t.after(async () => { await ctx.dispose() })
  assert.ok(typeof resumeFn === 'function', 'resumeAll scheduled')
  await resumeFn()
  await delay(50)

  // Work #W1 in need_input MUST still be open (NOT prematurely closed with "等待 Chief 回复中"!),
  // Chief must NOT have received a fake closing reply, and Writer must NOT have been resent legacy silent/cancelled items.
  assert.equal(rt.workStateOf('w-need'), 'need_input')
  assert.equal(agents.get('a')?.calls.length ?? 0, 0, 'Chief must NOT get premature closing reply on reload while need_input')
  assert.equal(agents.get('b')?.calls.length ?? 0, 0, 'Writer must NOT be resent silent notes or cancelled work on reload')
})

test('re-review fixes: linear-time isAckLikeText, no duplicate deferred ask_back/answer, mobile/backfill resumedPause skip, silent isRelayContext', async (t) => {
  const { agentOf, emit, tool, stop } = await start()
  t.after(stop)

  // 1) isAckLikeText is O(n) with zero ReDoS backtracking and accurate classification.
  assert.equal(isAckLikeText('好，收工待命，没有待办。'), true)
  assert.equal(isAckLikeText('ok, got it, thanks!'), true)
  assert.equal(isAckLikeText('book a flight'), false)
  assert.equal(isAckLikeText('我我我我'), false)
  const started = performance.now()
  assert.equal(isAckLikeText(`收到${'我'.repeat(120)}X`), false)
  assert.ok(performance.now() - started < 50, 'isAckLikeText must finish in linear time without backtracking')

  // 2a) Mid-turn ask_back answered during the same turn must NOT re-deliver a duplicate deferred ask_back at turn/end.
  await tool('delegate_work', { to: 'Writer', goal: 'prepare release notes' }, 'a')
  const req1 = agentOf('b').calls.at(-1)[1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req1.content, source: req1.source })
  await tool('ask_back', { question: '是否包含内部修复？' }, 'b')
  const askMsg = agentOf('a').calls.at(-1)[1]

  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'user/message', { content: textBlock('用户在和 Chief 聊别的'), source: { kind: 'user' } })
  emit('a', 'user/message', { content: askMsg.content, source: askMsg.source })
  // Chief answers the ask_back mid-turn before turn 1 ends!
  await tool('answer_work', { answer: '只列公开变更。' }, 'a')
  const aCallsBeforeEnd = agentOf('a').calls.length
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)
  const dupDeferredAsk = agentOf('a').calls.slice(aCallsBeforeEnd).filter(([, m]) => m.source?.role === 'ask_back' && m.source?.deferred === true)
  assert.equal(dupDeferredAsk.length, 0, 'already-answered ask_back must NOT re-deliver as deferred at turn/end')

  // 2b) Same-work answer steered into Writer's active turn must NOT re-deliver as deferred at turn/end.
  const ansMsg = agentOf('b').calls.at(-1)[1]
  assert.equal(ansMsg.source.role, 'answer')
  emit('b', 'user/message', { content: ansMsg.content, source: ansMsg.source })
  emit('b', 'assistant/message', assistantText('发布说明已按公开变更整理完毕。'))
  const bCallsBeforeEnd = agentOf('b').calls.length
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(30)
  const dupDeferredAns = agentOf('b').calls.slice(bCallsBeforeEnd).filter(([, m]) => m.source?.role === 'answer' && m.source?.deferred === true)
  assert.equal(dupDeferredAns.length, 0, 'same-work answer already consumed in turn must NOT re-deliver as deferred')

  // 3) Mobile roomItems & group log backfill both skip source.resumedPause === true.
  const resumedEvt = {
    type: 'user/message',
    seq: 42,
    time: 1000,
    data: {
      content: textBlock('[Group chat · user continued paused calls]'),
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: 'ex-rp', roomId: 'r1', quiet: true, resumedPause: true },
    },
  }
  assert.deepEqual(roomItems([resumedEvt], {}, () => undefined).items, [], 'mobile roomItems must skip resumedPause')
  assert.deepEqual(extractGroupSessionLines([resumedEvt], () => undefined), [], 'extractGroupSessionLines must skip resumedPause')

  // 4) isRelayContext excludes silent stop/note/cancel notices so they never render inside an unrelated turn.
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'stopped', silent: true, senderSessionId: 'a' } }), false)
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'stopped', senderSessionId: 'a' } }), true)
})

test('extractGroupSessionLines preserves the channel of backfilled user lines', () => {
  // A line backfilled from the Session keeps the via its live intake would have
  // written: an IM or API post is no owner's line after a rebuild either.
  const eventOf = (rpcId, text) => ({
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { content: textBlock(text), source: { kind: 'user', rpcId } },
  })
  assert.deepEqual(
    extractGroupSessionLines([eventOf('im:telegram:deadbeef', 'im words')], () => undefined).map(line => [line.who, line.via]),
    [['User', 'telegram']],
  )
  assert.deepEqual(
    extractGroupSessionLines([eventOf('api:token123:run_abc', 'api words')], () => undefined).map(line => [line.who, line.via]),
    [['User', 'api']],
  )
  assert.deepEqual(
    extractGroupSessionLines([eventOf('web-f47ac10b', 'own words')], () => undefined).map(line => [line.who, line.via]),
    [['User', undefined]],
  )
})

test('soak findings: resumeRoomPause signals Continue to woken member, and superseded waiterless joined room calls coalesce per room', async (t) => {
  const { rt, agentOf, emit, stop } = await start()
  t.after(stop)

  // 1) resumeRoomPause adds explicit Continue note to parked entries so woken member knows user clicked Continue.
  const room = await rt.createRoom({ name: 'CycleGroup', members: ['a', 'b'], admin: 'a', greet: false })
  room.idlePaused = { from: 'b', count: 2, noticed: true }
  room.paused = [{ id: 'a', name: 'Chief', note: 'Writer mentioned you', by: 'b', idle: true }]
  const resumed = await rt.resumeRoomPause(room.id)
  assert.equal(resumed, true)
  assert.equal(room.idlePaused, undefined)
  assert.equal(room.paused[0].idle, false)
  assert.match(room.paused[0].note, /Writer mentioned you; the user clicked Continue after a pause/)

  // 2) Coalescing waiterless `role: 'room'` calls respects `(roomId, askedBy)` batch ownership:
  //    - Repeated waiterless calls from the same `askedBy` coalesce to the newest one.
  //    - Waiterless calls from different `askedBy` callers in the same room are BOTH preserved
  //      so neither caller's `state.roomBatches` entry is orphaned.
  //    - Waiterless calls with `askedBy: undefined` coalesce when a newer/live call exists in that room.
  //    - Calls from another room and Bot-to-Bot `request` calls are always preserved.
  const groupSid = 'grp-a-session'
  rt.groupOwners.set(groupSid, { botId: 'a', roomId: room.id })
  const grpAgent = agentOf(groupSid)
  emit(groupSid, 'turn/start', { turn: 1 })
  emit(groupSid, 'user/message', {
    content: textBlock('[Group chat "CycleGroup" · your turn]\nfirst message'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'room', roomId: room.id, exchangeId: 'ex-primary', senderSessionId: 'b' },
  })
  for (const [exId, rId, role, askedBy, text] of [
    ['ex-unscoped-old', room.id, 'room', undefined, '[Group chat "CycleGroup" · your turn]\nold unscoped'],
    ['ex-caller-b-1', room.id, 'room', 'b', '[Group chat "CycleGroup" · b mentioned you]\nstale from b'],
    ['ex-caller-b-2', room.id, 'room', 'b', '[Group chat "CycleGroup" · b mentioned you]\nlatest from b'],
    ['ex-caller-c-1', room.id, 'room', 'c', '[Group chat "CycleGroup" · c mentioned you]\nonly call from c'],
    ['ex-unscoped-new', room.id, 'room', undefined, '[Group chat "CycleGroup" · your turn]\nnewer unscoped'],
    ['ex-other-room', 'r-other', 'room', 'b', '[Group chat "Other" · b mentioned you]\nother room msg'],
    ['ex-direct-req', undefined, 'request', undefined, '[Work #W9 from Writer]\ndirect work'],
  ]) {
    emit(groupSid, 'user/message', {
      content: textBlock(text),
      source: {
        kind: SOURCE_KIND,
        form: 'relay',
        role,
        ...(rId ? { roomId: rId } : {}),
        ...(askedBy !== undefined ? { askedBy } : {}),
        exchangeId: exId,
        senderSessionId: askedBy ?? 'b',
      },
    })
  }
  const beforeEnd = grpAgent.calls.length
  emit(groupSid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(40)
  const deferredIds = grpAgent.calls.slice(beforeEnd).map(([, m]) => m.source?.exchangeId)
  assert.equal(deferredIds.includes('ex-unscoped-old'), false, 'older askedBy:undefined room call must be coalesced')
  assert.equal(deferredIds.includes('ex-caller-b-1'), false, 'older waiterless call from same askedBy must be coalesced')
  assert.equal(deferredIds.includes('ex-caller-b-2'), true, 'latest waiterless call from askedBy b must be delivered')
  assert.equal(deferredIds.includes('ex-caller-c-1'), true, 'waiterless call from distinct askedBy c must NOT be dropped')
  assert.equal(deferredIds.includes('ex-unscoped-new'), true, 'latest overall waiterless unscoped call must be delivered')
  assert.equal(deferredIds.includes('ex-other-room'), true, 'room call for a different room must be preserved')
  assert.equal(deferredIds.includes('ex-direct-req'), true, 'Bot-to-Bot work request must never be coalesced with room calls')
})

test('text-only translations continue beyond four sections while repeated no-progress and ping-pong still pause', async (t) => {
  const { rt, agents, emit, tool, call, stop } = await start()
  t.after(stop)

  // 4 consecutive same-direction pure-LLM delegations (0 work tools, non-ack call & reply) succeed without false idle_loop.
  for (let i = 1; i <= 4; i += 1) {
    const out = await tool('delegate_work', { to: 'Writer', goal: `Translate section ${i} of the architecture document and preserve technical terms.` }, 'a')
    assert.match(out, new RegExp(`^Delegated work #W${i} to Writer`), `section ${i} must not falsely pause as idle_loop`)
    const req = agents.get('b').calls.at(-1)[1]
    emit('b', 'turn/start', { turn: i })
    emit('b', 'user/message', { content: req.content, source: req.source })
    emit('b', 'assistant/message', assistantText(`Completed translation of section ${i} with glossary alignment and formatting notes.`))
    emit('b', 'turn/end', { turn: i, reason: { kind: 'completed' } })
    await settled(() => (agents.get('a')?.calls.length ?? 0) >= i)
  }

  // Distinct section 5 continues cleanly without a fixed 4-turn cutoff.
  const r5 = await tool('delegate_work', { to: 'Writer', goal: 'Translate section 5 of the architecture document.' }, 'a')
  assert.match(r5, /^Delegated work #W5 to Writer/)
  let paused = (await call('state', {})).value.work.paused
  assert.equal(paused.length, 0)
  assert.equal((await call('cancel-work', { id: 'W5' })).ok, true)

  // Reciprocal alternating zero-work ping-pong (A -> B then B -> A) still pauses immediately at 2 as idle_loop.
  rt.resetPairLoop('a', 'b')
  const aToB = await tool('delegate_work', { to: 'Writer', goal: 'Draft the release summary for review.' }, 'a')
  assert.match(aToB, /^Delegated work #W6 to Writer/)
  const req6 = agents.get('b').calls.at(-1)[1]
  emit('b', 'turn/start', { turn: 10 })
  emit('b', 'user/message', { content: req6.content, source: req6.source })
  emit('b', 'assistant/message', assistantText('Here is the drafted release summary ready for your feedback.'))
  emit('b', 'turn/end', { turn: 10, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 5)

  const bToA = await tool('delegate_work', { to: 'Chief', goal: 'Please double-check my drafted release summary.' }, 'b')
  assert.match(bToA, /^Paused work #W7 before waking Chief/)
  paused = (await call('state', {})).value.work.paused
  assert.equal(paused.length, 1)
  assert.equal(paused[0].reason, 'idle_loop')
  assert.equal(paused[0].bounces, 2)
})

test('STEER_CUT during a private reply turn preserves userInput, ordinary user turns allow historical follow_up_to, and ref-less late replies never deadlock', async (t) => {
  const { rt, agents, emit, tool, stop } = await start()
  t.after(stop)

  // Work #W1 finishes and wakes Chief with a role: 'reply' turn.
  await tool('delegate_work', { to: 'Writer', goal: 'Check logs' }, 'a')
  const req1 = agents.get('b').calls[0][1]
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: req1.content, source: req1.source })
  emit('b', 'assistant/message', assistantText('Logs look clean.'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => (agents.get('a')?.calls.length ?? 0) >= 1)
  const reply1 = agents.get('a').calls[0][1]

  // (a) Human steers during Chief's reply turn -> STEER_CUT carries userInput: true into the fresh turn.
  emit('a', 'turn/start', { turn: 2 })
  emit('a', 'user/message', { content: reply1.content, source: reply1.source })
  rt.markSteerCut('a')
  emit('a', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'steer' } } })
  emit('a', 'turn/start', { turn: 3 })
  // Even before any new user/message event is logged, carry preserves userInput so Chief can delegate freely.
  const afterSteer = await tool('delegate_work', { to: 'Writer', goal: 'New task requested by human steer' }, 'a')
  assert.match(afterSteer, /^Delegated work #W2/)
  emit('a', 'turn/end', { turn: 3, reason: { kind: 'completed' } })

  // (b) Ordinary human turn mentioning a historical work ref in follow_up_to is NOT rejected.
  emit('a', 'turn/start', { turn: 4 })
  emit('a', 'user/message', { content: textBlock('Follow up on W1 please'), source: { kind: 'user' } })
  const withHistoricalRef = await tool('delegate_work', { to: 'Writer', goal: 'Run second pass', follow_up_to: 'W1' }, 'a')
  assert.match(withHistoricalRef, /^Delegated work #W3/)
  emit('a', 'turn/end', { turn: 4, reason: { kind: 'completed' } })

  // (c) A legacy/ref-less role: 'reply' turn (no workRef, no replyTo) must NOT deadlock delegate_work.
  emit('a', 'turn/start', { turn: 5 })
  emit('a', 'user/message', { content: textBlock('[Late subagent output]\ndone'), source: { kind: 'bot', role: 'reply', exchangeId: 'late-no-ref' } })
  const fromReflessLate = await tool('delegate_work', { to: 'Writer', goal: 'Act on late subagent output' }, 'a')
  assert.match(fromReflessLate, /^Delegated work #W4/)
  emit('a', 'turn/end', { turn: 5, reason: { kind: 'completed' } })
})
