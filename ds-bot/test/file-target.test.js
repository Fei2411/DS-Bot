import assert from 'node:assert/strict'
import { test } from 'node:test'
import { presentedFileTarget } from '../src/client/file-target.js'

// #1443: a delivered-file card's Save action reads the card's own present route; the
// host then reads exactly that presented file back.
test('a delivered-file action yields the session, seq and index it names', () => {
  assert.deepEqual(presentedFileTarget('api/present.open?sessionId=s1&seq=12&index=2'), { sessionId: 's1', seq: 12, index: 2 })
})

test('another action or a broken route yields nothing', () => {
  for (const value of [undefined, '', 'api/present.open', 'api/present.open?seq=1&index=0', 'api/present.open?sessionId=s1&index=0', 'api/present.open?sessionId=s1&seq=x&index=0']) {
    assert.equal(presentedFileTarget(value), null)
  }
})
