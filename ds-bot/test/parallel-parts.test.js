import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1501: a Bot's own chat can keep a second part live. The current part stays
// `chatOf`; parts opened while the Bot was busy stay live in `openParts` with their own
// earlier parts, and neither is archived or stopped when the other one takes over.

const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

async function dshRegistry(t, root, live, plugin) {
  const host = new Context()
  t.after(() => host.fiber.dispose())
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  await host.plugin(SessionPersistence, { root: join(root, 'sessions') })
  await host.plugin({ name: 'live-sessions', apply: inner => inner.provide('sessions', { list: () => [], get: id => (live.includes(id) ? {} : undefined) }) })
  await host.plugin({
    name: 'plugin-hooks',
    apply: (inner) => {
      const hooks = name => plugin.listeners.get(name) ?? []
      inner.on('workspace/session-stop', payload => Promise.all(hooks('workspace/session-stop').map(listener => listener(payload))))
      inner.on('workspace/session-activity', (payload, next) => hooks('workspace/session-activity').reduceRight((rest, listener) => () => listener(payload, rest), next)())
    },
  })
  await host.plugin(WorkspaceRegistry)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Workspace registry did not start')), 5000)
    host.inject(['workspaceRegistry'], (inner) => {
      clearTimeout(timer)
      resolve(inner.workspaceRegistry)
    })
  })
}

// Writer's foreground thread is `w2` (earlier part `w1`); a part opened while it was
// busy is `w3`, with its own earlier part `w4`.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: {
      id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2,
      segments: [{ sessionId: 'w1', endedAt: 3 }],
      openParts: [{ sessionId: 'w3', segments: [{ sessionId: 'w4', endedAt: 5 }], startedAt: 6 }],
    },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function team(t, archived = [], state = TEAM, live = ['m1', 'w1', 'w2', 'w3', 'w4']) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-parallel-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({})
  const registry = await dshRegistry(t, join(home, 'dsh'), live, ctx)
  for (const id of archived) await registry.archiveSession(SessionId(id), { stopActivity: true })
  ctx.workspaceRegistry = registry
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { home, registry, call, ctx, rt }
}

const saved = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('the state lists the live open part and reads its run state, while chatOf stays the current part', async (t) => {
  const { call, rt } = await team(t)
  const first = (await call('state')).value
  assert.equal(first.bots.find(bot => bot.id === 'w1').sessionId, 'w2')
  assert.deepEqual(first.bots.find(bot => bot.id === 'w1').openParts.map(part => part.sessionId), ['w3'])
  assert.equal(first.partsRunning.w3, undefined)
  rt.live.set('w3', { turn: {} })
  const second = (await call('state')).value
  const writer = second.bots.find(bot => bot.id === 'w1')
  assert.equal(writer.sessionId, 'w2')
  // The run state comes from the live turns, not from the stored part.
  assert.equal(second.partsRunning.w3, true)
  assert.equal(second.partsRunning.w2, undefined)
  assert.deepEqual(writer.openParts[0].parts, ['w4'])
  // A read inside a thread lists that thread's own parts, not the foreground chain.
  assert.deepEqual(rt.partsOfThread('w1', 'w2').map(part => part.sessionId), ['w1', 'w2'])
  assert.deepEqual(rt.partsOfThread('w1', 'w3').map(part => part.sessionId), ['w4', 'w3'])
})

// A background thread that moved on twice keeps its own earlier parts: reading one of
// them goes on in that thread, not in the foreground chain.
const MOVED_BACK = {
  ...TEAM,
  bots: {
    ...TEAM.bots,
    w1: {
      ...TEAM.bots.w1,
      openParts: [{ sessionId: 'w3', segments: [{ sessionId: 'w4', endedAt: 5 }, { sessionId: 'w5', endedAt: 6 }], startedAt: 7 }],
    },
  },
}

test('an earlier part of a background thread reads that thread\'s history', async (t) => {
  const { ctx, call, rt } = await team(t, [], MOVED_BACK, ['m1', 'w1', 'w2', 'w3', 'w4', 'w5'])
  await call('state')
  // The part is the Bot's, so its history can be resolved at all.
  assert.deepEqual(rt.pastOwners.get('w4'), { botId: 'w1' })
  assert.deepEqual(rt.partsOfThread('w1', 'w5').map(part => part.sessionId), ['w4', 'w5', 'w3'])
  // Every part says what it is when it is read, so the page shows which one was read.
  ctx.sessionController = { page: async ({ address }) => ({
    records: [{ event: { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: address.sessionId }], source: { kind: 'user' } } } }],
    hasMore: false,
  }) }
  const page = await rt.earlierPage('w5')
  assert.deepEqual(page.items.map(item => [item.kind, item.text]), [['user', 'w4']])
})

test('opening a live part swaps the threads and archives nothing', async (t) => {
  const { home, registry, call } = await team(t, ['w1'])
  await call('state')
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w3' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w3')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w4'])
  assert.equal(writer.openParts[0].sessionId, 'w2')
  assert.deepEqual(writer.openParts[0].segments.map(segment => segment.sessionId), ['w1'])
  // Neither part was archived or stopped: both are still live.
  assert.deepEqual([...registry.archivedSessionIds], ['w1'])
})

test('a new part made while the Bot works starts at once and leaves the running part live', async (t) => {
  const { home, registry, call, rt } = await team(t)
  await call('state')
  rt.live.set('w2', { turn: {} })
  rt.resolveAgent = async () => ({ id: 'w2', status: 'running', session: { requestHeader: () => undefined } })
  rt.createSession = async () => 'w5'
  const result = await call('bot-new-part', { botId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w5')
  assert.deepEqual(writer.segments, [])
  assert.deepEqual(writer.openParts.map(part => part.sessionId), ['w3', 'w2'])
  assert.deepEqual(writer.openParts.at(-1).segments.map(segment => segment.sessionId), ['w1'])
  // The running part is not archived and its turn is left alone.
  assert.deepEqual([...registry.archivedSessionIds], [])
  assert.deepEqual(rt.live.get('w2'), { turn: {} })
  assert.equal(rt.chatOwners.get('w5'), 'w1')
})

// A model picked while the new part is being made must reach it: at that moment it is
// not registered as the Bot's yet, so the sync that ran meanwhile did not see it (and
// recorded the new model as applied), and the route this part was made with is the old
// one. The part reads the route again once it is the Bot's, as a switch does.
test('a new part takes a model picked while the part was being made', async (t) => {
  const { call, rt } = await team(t)
  await call('state')
  const bot = rt.botOf('w1')
  const selections = []
  rt.createSession = async () => 'w5'
  rt.resolveAgent = async () => ({ id: 'w2', status: 'running', session: { id: 'w2', requestHeader: () => undefined } })
  rt.desiredModel = async owner => owner.model
  rt.desiredEffort = async () => undefined
  rt.selectSessionModel = async (sessionId, route) => { selections.push(`${sessionId}:${route.provider}/${route.model}`) }
  // The permission write is where the user's model change lands, before the part is the
  // Bot's.
  let release
  rt.applyPermission = () => new Promise(resolve => { release = resolve })
  bot.model = 'deepseek/old'
  const opened = call('bot-new-part', { botId: 'w1' })
  await until(() => release !== undefined)
  // The user picks another model now: the sync applies it to what is registered (the
  // foreground part) and records it as the Bot's applied model.
  bot.model = 'deepseek/new'
  bot.appliedModel = 'deepseek/new'
  await rt.selectSessionModel('w2', { provider: 'deepseek', model: 'new' })
  release()
  assert.equal((await opened).ok, true)
  assert.equal(bot.sessionId, 'w5')
  // The new part was made with the old model, then given the newer one: it does not stay
  // on the route the sync never reached.
  assert.deepEqual(selections, ['w5:deepseek/old', 'w2:deepseek/new', 'w5:deepseek/new'])
})

test('a foreground switch to an archived part does not touch the background part', async (t) => {
  const { home, registry, call, rt } = await team(t, ['w1'])
  await call('state')
  rt.live.set('w3', { turn: {} })
  const result = await call('bot-open-part', { botId: 'w1', sessionId: 'w1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const writer = saved(home).bots.w1
  assert.equal(writer.sessionId, 'w1')
  assert.deepEqual(writer.segments.map(segment => segment.sessionId), ['w2'])
  // The background part and its chain stay exactly where they were.
  assert.equal(writer.openParts[0].sessionId, 'w3')
  assert.deepEqual(writer.openParts[0].segments.map(segment => segment.sessionId), ['w4'])
  // Only the part the foreground left is archived; the background part stays live.
  assert.deepEqual([...registry.archivedSessionIds], ['w2'])
})


test('send, answer-question, and view-reply on an earlier segment of an openPart route to that openPart', async (t) => {
  const seed = {
    ...MOVED_BACK,
    questions: {
      w3: {
        id: 'q1',
        callId: 'q-call',
        question: 'Which option?',
        options: [{ label: 'yes' }, { label: 'no' }],
        askedAt: 1,
      },
    },
    views: {
      w3: {
        id: 'v1',
        callId: 'v-call',
        title: 'Pick',
        view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] },
        askedAt: 1,
      },
    },
  }
  const { call, ctx } = await team(t, [], seed)
  const routed = []
  ctx.sessionController = {
    ...ctx.sessionController,
    prompt: async (address) => {
      routed.push(['send', address.sessionId])
    },
    resolveAgent: async (sessionId) => ({
      agent: {
        id: sessionId,
        session: { id: sessionId },
        followup() {
          routed.push(['followup', sessionId])
        },
      },
    }),
  }
  ctx.sessions = { flush: async () => {} }

  const sent = await call('send', { sessionId: 'w4', text: 'continue bg part' })
  assert.equal(sent.ok, true, JSON.stringify(sent))

  const answered = await call('answer-question', { sessionId: 'w4', questionId: 'q1', answer: { selected: ['yes'] } })
  assert.equal(answered.ok, true, JSON.stringify(answered))

  const replied = await call('view-reply', { sessionId: 'w4', viewId: 'v1', action: 'pick', values: { selected: ['A'] } })
  assert.equal(replied.ok, true, JSON.stringify(replied))

  assert.deepEqual(routed, [
    ['send', 'w3'],
    ['followup', 'w3'],
    ['followup', 'w3'],
  ])
})
