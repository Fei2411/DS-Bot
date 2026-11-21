import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpEngine } from '../src/host/local-agents/acp.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not become true')
}

function sharedWorker() {
  const cwd = process.cwd()
  const engine = new AcpEngine('local-test', {
    name: 'Test ACP', kind: 'acp', cwdPerProcess: true, command: process.execPath,
  }, { findExecutable: path => path })
  const worker = engine.spawnWorker(cwd)
  engine.workers.set(cwd, worker)
  worker.keepWarm = true
  worker.committed.set('other', { session: worker.createSession('other'), ephemeral: false })
  return { engine, worker, cwd }
}

for (const order of ['old-first', 'replacement-first']) {
  test(`a forgotten ACP open cannot unregister its replacement (${order})`, async t => {
    const { engine, worker, cwd } = sharedWorker()
    t.after(() => engine.close())
    const peer = {}
    worker.ensure = async () => peer
    const opens = []
    worker.newSession = () => {
      const pending = deferred()
      opens.push(pending)
      return pending.promise
    }
    const args = { cwd, preset: undefined, model: 'default', ephemeral: false }
    const first = engine.open('target', args)
    const firstRejected = assert.rejects(first, /session closed while opening/)
    await waitFor(() => opens.length === 1)
    engine.forget('target')
    const replacement = engine.open('target', args)
    await waitFor(() => opens.length === 2)
    if (order === 'old-first') {
      opens[0].resolve({ sessionId: 'acp-old', configOptions: [] })
      await firstRejected
      opens[1].resolve({ sessionId: 'acp-new', configOptions: [] })
    } else {
      opens[1].resolve({ sessionId: 'acp-new', configOptions: [] })
      await replacement
      opens[0].resolve({ sessionId: 'acp-old', configOptions: [] })
      await firstRejected
    }
    const session = await replacement
    assert.equal(session.acpSessionId, 'acp-new')
    assert.equal(worker.sessions.get('target'), session)
    assert.equal(engine.workerOf(session), worker)
    assert.notEqual(session.acpSessionId, 'acp-old')
  })
}

test('closing a coordinator during mode setup cannot spawn a replacement worker for model setup', async t => {
  const { engine, worker, cwd } = sharedWorker()
  t.after(() => engine.close())
  const mode = deferred()
  let starts = 0
  let modelRequests = 0
  const peer = {
    async request(method, params) {
      if (method === 'session/set_config_option' && params.configId === 'mode') return mode.promise
      if (method === 'session/set_model' || (method === 'session/set_config_option' && params.configId === 'model')) {
        modelRequests += 1
        return {}
      }
      return {}
    },
  }
  worker.peer = peer
  worker.startPeer = async () => { starts += 1; return peer }
  worker.newSession = async () => ({
    sessionId: 'acp-target', configOptions: [],
    modes: { availableModes: [{ id: 'ask' }, { id: 'accept-edits' }] },
  })
  const opening = engine.open('target', { cwd, preset: 'workspace-write', model: 'named', ephemeral: true })
  const rejected = assert.rejects(opening, /worker is closed|did not switch to the model/)
  await waitFor(() => worker.sessions.has('target'))
  await engine.close()
  assert.equal(worker.retired, true)
  mode.reject(new Error('the old process exited'))
  await rejected
  assert.equal(starts, 0, 'a retired worker never starts a new child')
  assert.equal(modelRequests, 0, 'model setup never reaches a replacement peer')
  assert.equal(engine.workers.size, 0)
})
