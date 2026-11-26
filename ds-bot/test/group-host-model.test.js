import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1310: a group's own Session never asks the model, but DSH resolves its selection before
// every step. A Session left on a model the provider no longer serves failed with
// UNKNOWN_MODEL, whatever the members ran on.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, model: 'deepseek/v4-flash' },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, model: 'deepseek/v4-flash' },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: { defaultBotModel: 'deepseek/v4-flash' },
  revision: 0,
}

async function start() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-group-host-model-')))
  const home = join(root, 'bot')
  mkdirSync(home)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const selected = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'v4-flash', name: 'v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: home } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async ({ sessionId, provider, model }) => { selected.push(`${sessionId}:${provider}/${model}`) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const stop = async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, selected, stop }
}

test('a new group chat\'s own Session is put on the team default model', async (t) => {
  const { rt, selected, stop } = await start()
  t.after(stop)
  const room = await rt.createRoom({ name: 'Pair', members: ['a', 'b'] })
  assert.ok(selected.includes(`${room.id}:deepseek/v4-flash`), `selections: ${selected.join(', ')}`)
})
