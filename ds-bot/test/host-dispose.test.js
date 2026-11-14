import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1545: a model listing that a Bot's startup started can still be in flight when its
// host is disposed. It must then stop quietly: reading an injected service on the
// disposed context throws ("cannot get property "llm" without inject"), which used to
// surface as an unhandled rejection and fail whatever test happened to be running.
// The same code once seeded the test state with a Bot that already has a model.

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

function stateWithModel() {
  return {
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: {
      b1: { id: 'b1', sessionId: 'b1', name: 'Writer', role: 'Writer', instructions: '', createdAt: 1, model: 'deepseek/deepseek-v4-flash' },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }
}

async function startHost(t, { listDelayMs }) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-host-dispose-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(stateWithModel()))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const fake = fakeContext()
  root.provide('events', fake.events)
  root.provide('tools', fake.tools)
  root.provide('systemPrompt', fake.systemPrompt)
  root.provide('connection', fake.connection)
  root.provide('llm', {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => { await tick(listDelayMs); return [{ id: 'deepseek-v4-flash' }] },
    resolveModelInfo: async () => ({}),
  })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} })
  root.provide('sessionController', {
    create: async () => ({ sessionId: 's1' }),
    resolveAgent: async id => ({ agent: { session: { id, seq: 1 }, followup() {}, status: 'idle' } }),
    selectModel: async () => {},
    prompt: async () => {},
    page: async () => ({ records: [], hasMore: false }),
  })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('sessions', { flush: async () => {} })
  let rt
  const fork = await root.plugin((sub) => { rt = createRuntime(sub, { home }) })
  return { root, fork, rt, home }
}

test('a model listing that outlives its host stops quietly instead of touching disposed services', async (t) => {
  const leaks = []
  const onRejection = error => leaks.push(error)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))

  const { root, rt } = await startHost(t, { listDelayMs: 80 })
  // Bootstrap starts a model sync in the background; its listing is still in flight.
  const reply = await rt.channelCall('state', {})
  assert.equal(reply.ok, true, JSON.stringify(reply))
  await root.fiber.dispose()
  // Let the in-flight listing finish after the host is gone.
  await tick(250)
  assert.deepEqual(leaks.map(error => error?.message ?? String(error)), [])
})

test('a Bot created with a model does not greet through a disposed host', async (t) => {
  const leaks = []
  const onRejection = error => leaks.push(error)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))

  const { root, rt } = await startHost(t, { listDelayMs: 300 })
  // A Bot made from inside the running host starts waiting for its model; the listing
  // is still in flight when the host goes away.
  const bot = await rt.createBot({ name: 'Coder', role: 'Engineer', instructions: '', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(bot.model, 'deepseek/deepseek-v4-flash')
  const warnings = []
  rt.warn = (...args) => { warnings.push(args.join(' ')) }
  await root.fiber.dispose()
  await tick(600)
  assert.deepEqual(leaks.map(error => error?.message ?? String(error)), [])
  // The work that outlives the host stops instead of reaching for a service that is gone.
  assert.deepEqual(warnings.filter(line => line.includes('without inject')), [])
})

test('a model catalog asked for after the host is gone returns its last answer', async (t) => {
  const { root, rt } = await startHost(t, { listDelayMs: 1 })
  await rt.channelCall('state', {})
  await root.fiber.dispose()
  // Fresh would list providers again; a disposed host reads no service for it.
  await assert.doesNotReject(() => rt.catalog({ fresh: true }))
})
