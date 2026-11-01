// A message a Bot already read mid-turn is handed back to answer in a turn of its
// own. The body is already in that Session above, so the hand-back carries a pointer
// to it instead of the whole text again; otherwise the model reads one message twice.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
import { SOURCE_KIND } from '../src/host/constants.js'

// The line a hand-back carries in place of the body, which is above it in the same Session.
const HANDED_BACK = 'You read its text during that task; it is above in this session. Answer it now.'

// A turn host that records what turns.js asks delivery to do, without delivering it.
function turnHost({ workOf } = {}) {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    dropKickoff() {},
    ...(workOf === undefined ? {} : { workOf }),
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered }
}

const relaySource = (role, extra = {}) => ({
  kind: SOURCE_KIND, form: 'relay', role, senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', ...extra,
})
const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const textOf = content => content.map(block => block.text ?? '').join('\n')
// The deferred deliveries: the hand-backs this change is about.
const handBacks = delivered => delivered.filter(job => job.deferred === true)

test('a joined request is handed back as a pointer, not the body again', () => {
  const { emit, delivered } = turnHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmake it shorter'), source: relaySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  const [handBack] = handBacks(delivered)
  assert.equal(handBacks(delivered).length, 1)
  // Everything about the hand-back is as it was; only the text is not the body.
  assert.equal(handBack.fromId, 'a')
  assert.equal(handBack.toId, 'b')
  assert.equal(handBack.sessionId, 'b')
  assert.equal(handBack.role, 'request')
  assert.equal(handBack.exchangeId, 'e1')
  assert.equal(handBack.text, HANDED_BACK)
  assert.equal(handBack.handedBack, true)
  assert.doesNotMatch(handBack.text, /make it shorter/)
})

test('a reply handed back for other work is a pointer too', () => {
  const { emit, delivered } = turnHost({ workOf: source => source?.work })
  // The turn answers the work Chief asked for under w1; the reply below belongs to w2.
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: relaySource('request', { exchangeId: 'e0', work: 'w1' }) })
  emit('b', 'assistant/message', assistantText('worked on w1'))
  emit('b', 'user/message', { content: textBlock('[Reply from Chief]\nreviewed'), source: relaySource('reply', { exchangeId: 'e1', work: 'w2', replyTo: 'r0' }) })
  emit('b', 'assistant/message', assistantText('still on w1'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  const [handBack] = handBacks(delivered)
  assert.equal(handBack.role, 'reply')
  assert.equal(handBack.exchangeId, 'e1')
  assert.equal(handBack.replyTo, 'r0')
  assert.equal(handBack.work, 'w2')
  assert.equal(handBack.text, HANDED_BACK)
  assert.equal(handBack.handedBack, true)
  assert.doesNotMatch(handBack.text, /reviewed/)
})

// The rest runs the real relay, so the assertions are on the message the model is given.

// A two-Bot team: a is Chief, b is Writer.
function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
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

// Services for a full apply(): resolveAgent returns a per-Session agent that records
// followup/steer calls, so the test sees what the model is actually handed.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handback-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
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
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, emit, tool, home, stop }
}

test('one message reaches the model once: steered with its body, then handed back as a pointer', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await tool('message_bot', { to: 'Writer', message: 'which year is the data?' }, 'a')

  // What the running turn was shown, cut in at its next step.
  const steered = agents.get('b').calls[0][1]
  assert.ok(steered, 'the running turn was steered')
  assert.match(textOf(steered.content), /which year is the data\?/)
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter, for the user'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)

  // It is still handed back, so the sender still gets its answer.
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'followup'])
  const [, handBack] = agents.get('b').calls[1]
  assert.equal(handBack.source.exchangeId, steered.source.exchangeId)
  assert.equal(handBack.source.deferred, true)
  assert.equal(handBack.source.handedBack, true)
  // The body is in the steer and not in the hand-back: the model reads it once.
  assert.doesNotMatch(textOf(handBack.content), /which year is the data\?/)
  assert.match(textOf(handBack.content), /it is above in this session/)
  const shown = [steered, handBack].filter(message => textOf(message.content).includes('which year is the data?'))
  assert.equal(shown.length, 1)
})

test('a message that arrives while the Bot is idle keeps its whole body', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)

  await tool('message_bot', { to: 'Writer', message: 'how are you' }, 'a')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  const [, only] = agents.get('b').calls[0]
  // Nothing was read before it, so nothing is handed back: no pointer, no flag.
  assert.equal(textOf(only.content), '[Message from Chief]\nhow are you')
  assert.equal(only.source.handedBack, undefined)
  assert.equal(only.source.deferred, undefined)
})
