import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installAgentForks } from '../src/client/agent-fork.js'

const clientStore = {
  createSnapshotStore: (initial) => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      set: next => { value = next; for (const listener of listeners) listener() },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
  },
  notifySubscribers: listeners => { for (const listener of listeners) listener() },
}

// Load the pinned DSH's public client entry, as the module loader does. History
// and connection streams stay idle; fork goes through its real client service.
const registration = await (async () => {
  let value
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: entry => { value = entry } } }
  try { await import('@deepseek-ai/dsh-api-session-controller/client') } finally { globalThis.window = previous }
  return value
})()
const idleStream = class { restart() {} start() {} async dispose() {} }
const gateway = { RemoteJournalStream: idleStream, RemoteSnapshotStream: idleStream }
const controller = registration.factory(name => {
  if (name === '@deepseek-ai/dsh-client-store') return clientStore
  if (name === '@deepseek-ai/cordis') return { Context: { filter: Symbol('filter') } }
  if (name === '@deepseek-ai/dsh-api-gateway/client') return gateway
  throw new Error(`Unexpected client dependency: ${name}`)
})

test('the pinned DSH client fork captures the catalogued child and returns its bare id', async (t) => {
  let sessions
  const effects = []
  let request
  const remote = {
    $on() {},
    $stream: () => ({}),
    session: {
      fork: async (value) => { request = value; return { ok: true, value: { sessionId: 'fork' } } },
    },
  }
  const ctx = {
    remote,
    get: () => ({ generation: { getSnapshot: () => undefined, subscribe: () => () => {} } }),
    effect: make => { const stop = make(); if (stop) effects.push(stop) },
    reflect: { provide: (name, value) => { if (name === 'sessions') sessions = value } },
    typert: { contexts: { registerClient() {} } },
  }
  controller.apply(ctx)
  t.after(async () => { for (const stop of effects.reverse()) await stop() })
  const owners = new Map([['source', 'agent']])
  const pending = new Map()
  const fix = installAgentForks({
    sessions, pending,
    ownerOf: id => owners.get(id), hasAgent: () => true,
    ready: async () => {}, refresh: async () => {},
    adopt: async (agentId, id) => { owners.set(id, agentId) },
    report: error => { throw error },
  })
  t.after(() => fix.dispose())
  let callbacks = 0
  const result = await sessions.fork({ sessionId: 'source', atSeq: 0, allowMigration: false, onCreated(id) {
    callbacks += 1
    assert.equal(id, 'fork')
    assert.equal(pending.get(id), 'agent')
    const row = sessions.list.getSnapshot().byId[id]
    assert.ok(row, 'child is catalogued before callback')
    assert.equal(row.parentId, undefined)
  } })
  assert.equal(result, 'fork')
  assert.equal(callbacks, 1)
  assert.equal(owners.get(result), 'agent')
  assert.deepEqual(request, { sessionId: 'source', atSeq: 0, allowMigration: false })
})
