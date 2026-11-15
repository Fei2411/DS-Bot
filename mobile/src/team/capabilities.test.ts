import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityStatusFor, unapprovedCapabilitiesFor } from './capabilities.ts'

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

test('unapprovedCapabilitiesFor resolves stdio MCP targets for direct items and packs', () => {
  const items = [
    { name: 'local-a', kind: 'mcp', transport: 'stdio', approved: false },
    { name: 'local-b', kind: 'mcp', transport: 'stdio', approved: true },
    { name: 'remote-c', kind: 'mcp', transport: 'streamable-http', approved: false },
    { name: 'guide', kind: 'skill' },
    { name: 'pack-mixed', kind: 'pack', items: ['guide', 'remote-c', 'local-a', 'local-b', 'local-a'] },
  ]
  const statuses = {
    bot1: {
      'local-b': { state: 'needs-approval' },
      'pack-mixed': { state: 'needs-approval' },
    },
  }
  assert.deepEqual(unapprovedCapabilitiesFor(items, statuses, items[0]), ['local-a'])
  assert.deepEqual(unapprovedCapabilitiesFor(items, statuses, items[2]), [])
  assert.deepEqual(unapprovedCapabilitiesFor(items, statuses, items[3]), [])
  assert.deepEqual(unapprovedCapabilitiesFor(items, statuses, items[4], [{ id: 'bot1' }]), ['local-a', 'local-b'])
})
