import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installAgentForks } from '../src/client/agent-fork.js'

function fixture({ failure, adoptFailure = false } = {}) {
  const owners = new Map([['source', 'agent']])
  const pending = new Map()
  const stored = new Map()
  const adopted = []
  const reported = []
  const rows = { source: { id: 'source', blank: false } }
  let counter = 0
  const sessions = Object.create({
    async fork(options) {
      const id = `child-${++counter}`
      // DSH 0.2.2 forks have neither parentId nor parentSessionId.
      rows[id] = { id, blank: false }
      options.onCreated?.(id)
      if (failure) throw failure
      return id
    },
  })
  sessions.list = { getSnapshot: () => ({ byId: rows }) }
  const original = sessions.fork
  const options = {
    sessions, pending,
    ownerOf: id => owners.get(id),
    hasAgent: id => id === 'agent',
    ready: async () => {},
    adopt: async (agentId, sessionId) => {
      adopted.push([agentId, sessionId])
      if (adoptFailure) throw new Error('save failed')
      owners.set(sessionId, agentId)
    },
    refresh: async () => {},
    report: (error, source) => reported.push([error, source]),
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
  }
  return { owners, pending, stored, adopted, reported, rows, sessions, original, options }
}

test('a nonblank fork without parent metadata joins its source Agent before navigation', async (t) => {
  const f = fixture()
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  const options = { sessionId: 'source', atSeq: 0, increaseTitle: true, allowMigration: false, onCreated(id) {
    assert.equal(this, options)
    assert.equal(f.pending.get(id), 'agent')
  } }
  const child = await f.sessions.fork(options)
  assert.equal(child, 'child-1')
  assert.equal(f.owners.get(child), 'agent')
  assert.deepEqual(f.adopted, [['agent', child]])
  assert.equal(JSON.parse([...f.stored.values()][0]).length, 0)
})

test('forking a non-current source and switching views during the RPC keep the source owner', async (t) => {
  const f = fixture()
  let release
  f.sessions.fork = async function (options) {
    assert.equal(this, f.sessions)
    await new Promise(resolve => { release = resolve })
    options.onCreated('child')
    return 'child'
  }
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  const call = f.sessions.fork({ sessionId: 'source' })
  f.owners.set('source', 'different-agent')
  release()
  assert.equal(await call, 'child')
  assert.equal(f.owners.get('child'), 'agent')
})

test('Bot, group, subagent and unowned sources pass through without adoption', async (t) => {
  const f = fixture()
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  for (const sessionId of ['bot', 'group', 'subagent', 'unowned']) {
    let callbacks = 0
    await f.sessions.fork({ sessionId, onCreated() { callbacks += 1 } })
    assert.equal(callbacks, 1)
  }
  assert.equal(f.adopted.length, 0)
})

test('a cold roster loads before deciding the source owner', async (t) => {
  const f = fixture()
  f.owners.clear()
  f.options.ready = async () => { f.owners.set('source', 'agent') }
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  await f.sessions.fork({ sessionId: 'source' })
  assert.equal(f.owners.get('child-1'), 'agent')
})

test('callback or title-rename failure still adopts the already-created child', async () => {
  for (const callbackThrows of [false, true]) {
    const failure = new Error(callbackThrows ? 'callback failed' : 'rename failed')
    const f = fixture({ failure: callbackThrows ? undefined : failure })
    const fix = installAgentForks(f.options)
    let callbacks = 0
    await assert.rejects(f.sessions.fork({ sessionId: 'source', onCreated() {
      callbacks += 1
      if (callbackThrows) throw failure
    } }), error => error === failure)
    assert.equal(callbacks, 1)
    assert.equal(f.owners.get('child-1'), 'agent')
    await fix.dispose()
  }
})

test('workspace-attach partial failure adopts the published child and preserves the error', async (t) => {
  const f = fixture()
  const failure = Object.assign(new Error('attach failed'), { rpcError: { code: 'session/workspace-attach-failed', details: { sessionId: 'partial' } } })
  f.sessions.fork = async () => { throw failure }
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  await assert.rejects(f.sessions.fork({ sessionId: 'source' }), error => error === failure)
  assert.equal(f.owners.get('partial'), 'agent')
})

test('fork RPC failure does not adopt a child', async (t) => {
  const f = fixture()
  const failure = new Error('fork failed')
  f.sessions.fork = async () => { throw failure }
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  await assert.rejects(f.sessions.fork({ sessionId: 'source' }), error => error === failure)
  assert.equal(f.adopted.length, 0)
})

test('failed adoption preserves a retry record across reinstall and deduplicates retries', async () => {
  const f = fixture({ adoptFailure: true })
  const fix = installAgentForks(f.options)
  assert.equal(await f.sessions.fork({ sessionId: 'source' }), 'child-1')
  assert.equal(f.reported[0][1], 'agent-fork-adopt')
  assert.equal(JSON.parse([...f.stored.values()][0])[0].sessionId, 'child-1')
  await fix.dispose()
  f.options.adopt = async (agentId, sessionId) => { f.adopted.push([agentId, sessionId]); f.owners.set(sessionId, agentId) }
  const retry = installAgentForks(f.options)
  await Promise.all([retry.reconcile(), retry.reconcile()])
  assert.equal(f.owners.get('child-1'), 'agent')
  assert.equal(f.adopted.length, 2)
  await retry.dispose()
})

test('a roster refresh failure is reported separately after successful adoption', async (t) => {
  const f = fixture()
  f.options.refresh = async () => { throw new Error('refresh failed') }
  const fix = installAgentForks(f.options)
  t.after(() => fix.dispose())
  assert.equal(await f.sessions.fork({ sessionId: 'source' }), 'child-1')
  assert.equal(f.owners.get('child-1'), 'agent')
  assert.equal(f.reported[0][1], 'agent-fork-refresh')
  assert.equal(JSON.parse([...f.stored.values()][0]).length, 0)
})

test('HMR waits for a fork already in flight without updating the disposed UI', async () => {
  const f = fixture()
  let release
  let refreshes = 0
  f.sessions.fork = async (options) => { await new Promise(resolve => { release = resolve }); options.onCreated('child'); return 'child' }
  f.options.refresh = async () => { refreshes += 1 }
  const original = f.sessions.fork
  const fix = installAgentForks(f.options)
  const call = f.sessions.fork({ sessionId: 'source' })
  const disposed = fix.dispose()
  release()
  await disposed
  assert.equal(await call, 'child')
  assert.equal(f.owners.get('child'), 'agent')
  assert.equal(refreshes, 0)
  assert.equal(f.sessions.fork, original)
})

test('cleanup restores the prototype method and leaves another wrapper intact', async () => {
  const f = fixture()
  const fix = installAgentForks(f.options)
  await fix.dispose()
  assert.equal(f.sessions.fork, f.original)
  assert.equal(Object.hasOwn(f.sessions, 'fork'), false)
  const next = installAgentForks(f.options)
  const replacement = () => {}
  f.sessions.fork = replacement
  await next.dispose()
  assert.equal(f.sessions.fork, replacement)
})
