import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityStatusFor } from './capabilities.ts'

test('capabilityStatusFor resolves nested per-bot capabilityStatuses with severity order', () => {
  const statuses = {
    botA: {
      github: { state: 'ready' },
      postgres: { state: 'connecting' },
    },
    botB: {
      github: { state: 'needs-approval' },
      postgres: { state: 'error', error: 'ECONNREFUSED' },
    },
  }
  assert.deepEqual(capabilityStatusFor(statuses, 'github', { bots: [{ id: 'botA' }, { id: 'botB' }] }), { state: 'needs-approval' })
  assert.deepEqual(capabilityStatusFor(statuses, 'postgres', { bots: [{ id: 'botA' }, { id: 'botB' }] }), { state: 'error', error: 'ECONNREFUSED' })
  assert.equal(capabilityStatusFor(statuses, 'missing'), undefined)
})

test('capabilityStatusFor supports legacy flat map and unapproved fallback', () => {
  assert.deepEqual(capabilityStatusFor({ fetch: { state: 'ready' } }, 'fetch'), { state: 'ready' })
  assert.deepEqual(capabilityStatusFor(undefined, 'fetch', { item: { approved: false } }), { state: 'needs-approval' })
  assert.deepEqual(capabilityStatusFor({}, 'fetch', { item: { status: 'needs-approval' } }), { state: 'needs-approval' })
})
