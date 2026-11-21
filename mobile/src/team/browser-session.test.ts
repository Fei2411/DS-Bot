import assert from 'node:assert/strict'
import { test } from 'node:test'
import { holdBrowserSession, type SessionLocks } from './browser-session.ts'

function exclusiveLocks(): SessionLocks {
  let previous = Promise.resolve()
  return {
    request(name, { signal }, acquired) {
      assert.equal(name, 'dsbot.link')
      const next = previous.then(async () => {
        if (signal.aborted) throw new Error('aborted')
        await acquired()
      })
      previous = next.catch(() => {})
      return next
    },
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('only one browser tab owns the session and the next takes over after release', async () => {
  const locks = exclusiveLocks()
  const owners: string[] = []
  const failed = () => assert.fail('lock failed')
  const stopFirst = holdBrowserSession(locks, () => owners.push('first'), failed)
  const stopSecond = holdBrowserSession(locks, () => owners.push('second'), failed)
  await tick()
  assert.deepEqual(owners, ['first'])
  stopFirst()
  await tick()
  assert.deepEqual(owners, ['first', 'second'])
  stopSecond()
})

test('closing a waiting tab cancels its turn without reporting an error', async () => {
  const locks = exclusiveLocks()
  const stopFirst = holdBrowserSession(locks, () => {}, () => assert.fail('lock failed'))
  const stopWaiting = holdBrowserSession(locks, () => assert.fail('closed tab acquired'), () => assert.fail('cancel reported'))
  await tick()
  stopWaiting()
  stopFirst()
  await tick()
})

test('unexpected lock failures are reported rather than opening a competing link', async () => {
  let failures = 0
  const stop = holdBrowserSession({ request: async () => { throw new Error('unavailable') } }, () => assert.fail('acquired'), () => { failures++ })
  await tick()
  assert.equal(failures, 1)
  stop()
})
