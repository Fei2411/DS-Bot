// A request the host never answers has to fail on its own: the roster poll schedules
// its next read after it, and a menu action has to say something.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { call, REQUEST_TIMEOUT_MS } from '../src/client/api.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const hangingFetch = () => (url, init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
})

test('a request with no answer fails after the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = hangingFetch()
  const settled = call('state', {}).then(() => 'resolved', error => error)
  t.mock.timers.tick(REQUEST_TIMEOUT_MS)
  const error = await settled
  assert.equal(error.code, 'REQUEST_TIMEOUT')
  assert.equal(error.message, 'DSH did not answer in time.')
})

test('the timeout is fifteen seconds', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 15000)
})

test('an answer before the timeout is used', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { ready: true } }) })
  assert.deepEqual(await call('state', {}), { ready: true })
  // Nothing is left to fire once the answer is in.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS)
})

test('a call that passes 0 waits as long as the host does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = hangingFetch()
  let settled = false
  void call('folder-pick', undefined, undefined, 0).then(() => { settled = true }, () => { settled = true })
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 10)
  await new Promise(resolve => setImmediate(resolve))
  // No timer was armed, so however long the host takes is still being waited for.
  assert.equal(settled, false)
})

test('a caller that aborts gets an AbortError, not a timeout', async () => {
  globalThis.fetch = hangingFetch()
  const control = new AbortController()
  const settled = call('state', {}, control.signal).then(() => 'resolved', error => error)
  control.abort()
  const error = await settled
  assert.equal(error.name, 'AbortError')
  assert.equal(error.code, undefined)
})
