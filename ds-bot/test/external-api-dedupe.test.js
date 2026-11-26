import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApiRoutes } from '../src/host/api/routes.js'

test('event dedupe is isolated by token, source and target book across reloads', async t => {
  const books = new Map()
  const bots = { b1: { id: 'b1' }, b2: { id: 'b2' }, bp: { id: 'bp', private: true } }
  const rt = {
    home: '/unused', ctx: {}, state: { bots, rooms: {} },
    botOf: id => bots[id],
    ledger: {
      records: book => books.get(book) ?? [],
      lastSeq: book => (books.get(book) ?? []).length,
      append: (book, record) => books.set(book, [...(books.get(book) ?? []), record]),
      written: async () => {},
    },
  }
  const principal = keyId => ({ keyId, name: keyId, hasScope: () => true, assertBotAccess: () => ({ ok: true }), canAccessBot: () => true })
  const first = principal('token-one')
  const second = principal('token-two')
  const body = { source: 'same-source', eventId: 'same-event', summary: 'External input', target: { kind: 'bot', id: 'b1' } }
  const open = () => {
    const routes = createApiRoutes(rt, { auth: {}, runs: {}, sseClients: new Set() })
    t.after(() => routes.dispose())
    return routes.service
  }
  const service = open()
  const initial = await service.ingestEvent(first, body)
  assert.equal(initial.status, 'accepted')
  assert.equal((await service.ingestEvent(first, body)).ledgerEventId, initial.ledgerEventId)
  assert.equal((await service.ingestEvent(first, body)).status, 'duplicate')
  const independent = await service.ingestEvent(second, body)
  assert.equal(independent.status, 'accepted')
  assert.notEqual(independent.ledgerEventId, initial.ledgerEventId)
  assert.equal((await service.ingestEvent(first, { ...body, target: { kind: 'bot', id: 'b2' } })).ledgerEventId, initial.ledgerEventId)
  const privateBody = { ...body, target: { kind: 'bot', id: 'bp' } }
  assert.equal((await service.ingestEvent(first, privateBody)).status, 'accepted')
  assert.equal((await service.ingestEvent(first, privateBody)).status, 'duplicate')
  assert.equal((await service.ingestEvent(first, { ...body, source: 'other-source' })).status, 'accepted')
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await service.ingestEvent(first, { ...body, eventId: '' })).status, 'accepted')
  }
  const reloaded = open()
  assert.equal((await reloaded.ingestEvent(first, body)).ledgerEventId, initial.ledgerEventId)
  assert.equal((await reloaded.ingestEvent(second, body)).ledgerEventId, independent.ledgerEventId)
  assert.equal((await reloaded.ingestEvent(principal('third-token'), body)).status, 'accepted')
  await assert.rejects(service.ingestEvent({ ...first, hasScope: () => false }, body), { status: 403 })
})
