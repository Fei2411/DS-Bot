import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { capabilityStatusFor, connectorList } from './selectors.ts'

const team = (extra: Record<string, unknown>): TeamState => ({ revision: 1, bots: [], ...extra }) as unknown as TeamState

test('connectors are read from the host view object, and from an older bare array', () => {
  const rows = [{ id: 'github', name: 'GitHub', state: 'ready' }]
  assert.deepEqual(connectorList(team({ connectors: { connectors: rows, mail: { accounts: [] } } })), rows)
  assert.deepEqual(connectorList(team({ connectors: rows })), rows)
  assert.deepEqual(connectorList(team({})), [])
  assert.deepEqual(connectorList(null), [])
})

test('a capability status is the worst among the Bots that have it', () => {
  const state = team({
    capabilityStatuses: {
      b1: { GitHub: { state: 'ready' }, Search: { state: 'connecting' } },
      b2: { GitHub: { state: 'error', error: 'token expired' } },
    },
  })
  assert.deepEqual(capabilityStatusFor(state, 'GitHub'), { state: 'error', error: 'token expired' })
  assert.deepEqual(capabilityStatusFor(state, 'Search'), { state: 'connecting' })
  assert.equal(capabilityStatusFor(state, 'Missing'), undefined)
})
