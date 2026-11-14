import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #814: DSH 0.2.2 attaches the tool list after the system-prompt/assemble
// waterfall, so a listener is handed a presentation of sections and contexts
// only. The per-Bot filter used to read .filter off the missing list, which
// failed every turn of a Bot Session before its first model request. The suite
// never caught it: the shared fake Agent drops agent-scoped listeners, and every
// assembly it drives carries a `tools` array.
test("a Bot's assembly without a tool list passes its filter", async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-assemble-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const listeners = []
  const agent = {
    id: 'a',
    session: { id: 'a', header: { cwd: '/team' }, requestHeader: () => undefined, deriveMessages: () => [] },
    ctx: {
      tools: { register: () => () => {}, restrict: () => () => {} },
      effect: () => {},
      on: (name, listener) => {
        listeners.push({ name, listener })
        return () => {}
      },
    },
    status: 'idle',
    followup() {},
    steer() {},
    cancel() {},
    inbox: { nextStep: [], nextTurn: [], prepend() {}, append() {}, remove: () => false },
  }
  const services = {
    agents: { list: () => [agent], get: id => (id === 'a' ? agent : undefined) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: '/team' }),
      list: () => [{ id: 'w1', path: '/team' }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async () => ({ agent }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  }
  const ctx = fakeContext({ services })
  t.after(() => ctx.dispose())
  const rt = createRuntime(ctx, { home })
  await rt.load()
  rt.hideBotUnusedTools(agent)
  const filter = listeners.find(entry => entry.name === 'system-prompt/assemble')
  assert.ok(filter !== undefined, 'the hidden-tool filter is attached to the Agent')
  const presentation = {
    sections: [{ name: 'tool:goal', text: 'goal guidance' }, { name: 'bot-identity', text: 'identity' }],
    contexts: [],
    variables: {},
  }
  const assembled = await filter.listener(presentation, { agent }, async () => presentation)
  // The hidden tool's guidance still goes; only the tool list is missing.
  assert.deepEqual(assembled.sections.map(section => section.name), ['bot-identity'])
  assert.equal('tools' in assembled, false)
})
