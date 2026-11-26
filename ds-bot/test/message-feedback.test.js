import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installFeedback } from '../src/host/message-feedback.js'
import { remoteAccessError } from '../src/host/phone.js'

function createFakeMessageFeedbackService() {
  const store = new Map()
  let seq = 0
  return {
    async list({ sessionId }) {
      const items = []
      for (const item of store.values()) {
        if (item.sessionId === sessionId) items.push({ ...item })
      }
      return { ok: true, value: { items } }
    },
    async put({ sessionId, messageId, rating, note, category, ifVersion }) {
      const key = `${sessionId}:${messageId}`
      const cur = store.get(key) ?? null
      const curVer = cur?.version ?? null
      if (ifVersion !== curVer) {
        return { ok: false, error: { code: 'CONFLICT', message: 'Version mismatch', current: cur ? { ...cur } : null } }
      }
      const next = {
        sessionId,
        messageId,
        rating,
        ...(note ? { note } : {}),
        ...(category ? { category } : {}),
        version: `v${++seq}`,
        updatedAt: Date.now(),
      }
      store.set(key, next)
      return { ok: true, value: { ...next } }
    },
    async delete({ sessionId, messageId, ifVersion }) {
      const key = `${sessionId}:${messageId}`
      const cur = store.get(key) ?? null
      if (!cur || cur.version !== ifVersion) {
        return { ok: false, error: { code: 'CONFLICT', message: 'Version mismatch', current: cur ? { ...cur } : null } }
      }
      store.delete(key)
      return { ok: true, value: { absent: true } }
    },
  }
}

test('message-feedback bridge lists, submits, updates with CAS conflict reconciliation, and retracts feedback', async () => {
  const service = createFakeMessageFeedbackService()
  let readOnlyReason = null
  const rt = {
    ctx: { get: name => (name === 'messageFeedback' ? service : undefined) },
    readOnly: () => readOnlyReason,
  }
  installFeedback(rt)

  const initial = await rt.feedbackEndpoint('list', { sessionId: 'sess-1' })
  assert.deepEqual(initial, { available: true, items: [] })

  const created = await rt.feedbackEndpoint('put', {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    rating: 'negative',
    category: 'task-result',
    note: 'Missed edge case',
    ifVersion: null,
  })
  assert.equal(created.ok, true)
  assert.equal(created.item.rating, 'negative')
  assert.equal(created.item.category, 'task-result')
  assert.equal(created.item.note, 'Missed edge case')
  const v1 = created.item.version

  // Stale ifVersion returns structured CONFLICT with current snapshot.
  const conflict = await rt.feedbackEndpoint('put', {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    rating: 'positive',
    ifVersion: null,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'CONFLICT')
  assert.equal(conflict.error.current.version, v1)

  const listed = await rt.feedbackEndpoint('list', { sessionId: 'sess-1' })
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].version, v1)

  // Retract with current version succeeds.
  const removed = await rt.feedbackEndpoint('delete', { sessionId: 'sess-1', messageId: 'msg-1', ifVersion: v1 })
  assert.deepEqual(removed, { ok: true, absent: true })
  assert.deepEqual((await rt.feedbackEndpoint('list', { sessionId: 'sess-1' })).items, [])

  // Validation and read-only checks.
  await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'sess-1', messageId: 'msg-1', rating: 'meh' }), { code: 'bot/invalid' })
  await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'sess-1', messageId: 'msg-1', rating: 'positive', category: 'bogus' }), { code: 'bot/invalid' })
  await assert.rejects(() => rt.feedbackEndpoint('delete', { sessionId: 'sess-1', messageId: 'msg-1' }), { code: 'bot/invalid' })
  readOnlyReason = 'Team is open in another window'
  await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'sess-1', messageId: 'msg-1', rating: 'positive' }), { code: 'bot/read-only' })
})

test('message-feedback bridge degrades cleanly when engine service is unavailable and stays computer-only', async () => {
  const rt = { ctx: { get: () => undefined }, readOnly: () => null }
  installFeedback(rt)

  assert.deepEqual(await rt.feedbackEndpoint('list', { sessionId: 'sess-1' }), { available: false, items: [] })
  await assert.rejects(
    () => rt.feedbackEndpoint('put', { sessionId: 'sess-1', messageId: 'msg-1', rating: 'positive', ifVersion: null }),
    { code: 'bot/unavailable' },
  )

  const denied = remoteAccessError({ kind: 'phone', id: 'p1' }, 'engine-feedback-put')
  assert.equal(denied?.code, 'bot/refused')
})
