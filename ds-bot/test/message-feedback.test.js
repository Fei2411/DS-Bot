import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import MessageFeedbackService from '@deepseek-ai/dsh-message-feedback'
import { install as installFeedback } from '../src/host/message-feedback.js'
import { install as installStore } from '../src/host/store.js'
import { remoteAccessError } from '../src/host/phone.js'

/**
 * Runs the real `@deepseek-ai/dsh-message-feedback` MessageFeedbackService against a
 * lightweight in-memory session log implementing DSH's `sessionPersistence` + `sessions` contract.
 */
async function createRealMessageFeedbackHost({ maxNoteBytes = 32 } = {}) {
  const logs = new Map()
  const seedSession = (sessionId, assistantMessageIds = ['msg-1']) => {
    const events = assistantMessageIds.map((id, idx) => ({
      type: 'assistant/message',
      surfaceOp: 'append',
      seq: idx,
      time: 1_700_000_000_000 + idx,
      data: {
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text: `Reply ${idx + 1}` }],
        },
      },
    }))
    logs.set(sessionId, {
      header: { id: sessionId, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
      events,
    })
  }

  const ctx = new Context()
  ctx.provide('sessions', { get: () => undefined, flush: async () => false })
  ctx.provide('sessionPersistence', {
    async stat(sessionId) {
      const entry = logs.get(sessionId)
      return entry ? { ...entry.header } : undefined
    },
    async open(sessionId) {
      const entry = logs.get(sessionId)
      if (!entry) throw new Error(`Missing session ${sessionId}`)
      return {
        header: entry.header,
        inheritedEventCount: entry.inheritedEventCount,
        async read(offset = 0, limit = entry.events.length) {
          return { events: entry.events.slice(offset, offset + limit) }
        },
        async append(more) {
          entry.events.push(...more)
        },
        async flush() {},
        async close() {},
      }
    },
  })
  const fiber = ctx.plugin(MessageFeedbackService, { maxNoteBytes })
  await fiber
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, fiber, seedSession }
}

test('message-feedback bridge matches the real @deepseek-ai/dsh-message-feedback service contract', async () => {
  const { ctx, fiber, seedSession } = await createRealMessageFeedbackHost({ maxNoteBytes: 32 })
  try {
    seedSession('classic-1', ['msg-1'])
    let readOnlyReason = null
    const rt = {
      ctx,
      readOnly: () => readOnlyReason,
      isBotSession: id => id === 'bot-sess',
      roomOf: id => (id === 'room-sess' ? { id: 'room-sess' } : undefined),
    }
    installFeedback(rt)

    // Blank / unpersisted classic session reports available with empty list instead of failing.
    assert.deepEqual(await rt.feedbackEndpoint('list', { sessionId: 'brand-new-classic' }), { available: true, items: [] })

    // Existing classic session starts empty.
    assert.deepEqual(await rt.feedbackEndpoint('list', { sessionId: 'classic-1' }), { available: true, items: [] })

    // Real create via MessageFeedbackService.put.
    const created = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
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
    assert.equal(typeof v1, 'string')
    assert.ok(v1.length > 0)

    // Real CAS conflict on put returns `version-conflict` with authoritative `current`.
    const putConflict = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      rating: 'positive',
      ifVersion: null,
    })
    assert.equal(putConflict.ok, false)
    assert.equal(putConflict.error.code, 'version-conflict')
    assert.equal(putConflict.error.current.version, v1)
    assert.equal(putConflict.error.current.rating, 'negative')

    // Retrying with the reconciled version succeeds.
    const updated = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      rating: 'positive',
      category: 'instruction-following',
      note: 'Fixed now',
      ifVersion: putConflict.error.current.version,
    })
    assert.equal(updated.ok, true)
    assert.equal(updated.item.rating, 'positive')
    const v2 = updated.item.version
    assert.notEqual(v2, v1)

    // Real `note-too-large` carries `maxBytes` and `actualBytes`.
    const tooLarge = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      rating: 'negative',
      note: 'x'.repeat(40),
      ifVersion: v2,
    })
    assert.equal(tooLarge.ok, false)
    assert.equal(tooLarge.error.code, 'note-too-large')
    assert.equal(tooLarge.error.maxBytes, 32)
    assert.equal(tooLarge.error.actualBytes, 40)

    // Real `note-blank` rejects whitespace-only notes.
    const blankNote = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      rating: 'negative',
      note: '   \t  ',
      ifVersion: v2,
    })
    assert.equal(blankNote.ok, false)
    assert.equal(blankNote.error.code, 'note-blank')

    // Real `target-not-found` for non-existent assistant messageId.
    const missingTarget = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-does-not-exist',
      rating: 'positive',
      ifVersion: null,
    })
    assert.equal(missingTarget.ok, false)
    assert.equal(missingTarget.error.code, 'target-not-found')

    // Real `session-not-found` on put and delete for missing session.
    const missingSessionPut = await rt.feedbackEndpoint('put', {
      sessionId: 'missing-session',
      messageId: 'msg-1',
      rating: 'positive',
      ifVersion: null,
    })
    assert.equal(missingSessionPut.ok, false)
    assert.equal(missingSessionPut.error.code, 'session-not-found')

    const missingSessionDel = await rt.feedbackEndpoint('delete', {
      sessionId: 'missing-session',
      messageId: 'msg-1',
      ifVersion: v2,
    })
    assert.equal(missingSessionDel.ok, false)
    assert.equal(missingSessionDel.error.code, 'session-not-found')

    // Real `version-conflict` on delete with stale version returns authoritative `current`.
    const delConflict = await rt.feedbackEndpoint('delete', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      ifVersion: v1,
    })
    assert.equal(delConflict.ok, false)
    assert.equal(delConflict.error.code, 'version-conflict')
    assert.equal(delConflict.error.current.version, v2)

    // Real delete with reconciled version succeeds.
    const removed = await rt.feedbackEndpoint('delete', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      ifVersion: delConflict.error.current.version,
    })
    assert.deepEqual(removed, { ok: true, absent: true })
    assert.deepEqual((await rt.feedbackEndpoint('list', { sessionId: 'classic-1' })).items, [])

    // Stale `ifVersion` on put when item is now absent returns `version-conflict` with `current: null`.
    const absentConflict = await rt.feedbackEndpoint('put', {
      sessionId: 'classic-1',
      messageId: 'msg-1',
      rating: 'positive',
      ifVersion: v2,
    })
    assert.equal(absentConflict.ok, false)
    assert.equal(absentConflict.error.code, 'version-conflict')
    assert.equal(absentConflict.error.current, null)

    // Server-side defense-in-depth rejects known Bot and room sessions.
    await assert.rejects(() => rt.feedbackEndpoint('list', { sessionId: 'bot-sess' }), { code: 'bot/refused' })
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'bot-sess', messageId: 'msg-1', rating: 'positive', ifVersion: null }), { code: 'bot/refused' })
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'room-sess', messageId: 'msg-1', rating: 'positive', ifVersion: null }), { code: 'bot/refused' })
    await assert.rejects(() => rt.feedbackEndpoint('delete', { sessionId: 'room-sess', messageId: 'msg-1', ifVersion: v2 }), { code: 'bot/refused' })

    // Validation and read-only checks.
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'classic-1', messageId: 'msg-1', rating: 'meh' }), { code: 'bot/invalid' })
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'classic-1', messageId: 'msg-1', rating: 'positive', category: 'bogus' }), { code: 'bot/invalid' })
    await assert.rejects(() => rt.feedbackEndpoint('delete', { sessionId: 'classic-1', messageId: 'msg-1' }), { code: 'bot/invalid' })
    readOnlyReason = 'Team is open in another window'
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: 'classic-1', messageId: 'msg-1', rating: 'positive' }), { code: 'bot/read-only' })
  } finally {
    await fiber.dispose()
  }
})

test('message-feedback bridge degrades cleanly when engine service is unavailable and stays computer-only', async () => {
  const rt = { ctx: { get: () => undefined }, readOnly: () => null }
  installFeedback(rt)

  assert.deepEqual(await rt.feedbackEndpoint('list', { sessionId: 'classic-1' }), { available: false, items: [] })
  await assert.rejects(
    () => rt.feedbackEndpoint('put', { sessionId: 'classic-1', messageId: 'msg-1', rating: 'positive', ifVersion: null }),
    { code: 'bot/unavailable' },
  )

  const denied = remoteAccessError({ kind: 'phone', id: 'p1' }, 'engine-feedback-put')
  assert.equal(denied?.code, 'bot/refused')
})

test('message-feedback refuses every current and archived team Session indexed by store.js while allowing Classic sessions', async (t) => {
  const { ctx, fiber, seedSession } = await createRealMessageFeedbackHost({ maxNoteBytes: 64 })
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-feedback-store-'))
  const statePath = join(home, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    bots: {
      'bot-orig': {
        id: 'bot-orig',
        name: 'Chief',
        sessionId: 'bot-cur',
        segments: [{ sessionId: 'bot-prev-part', endedAt: 100 }],
        tasks: [
          {
            id: 't-active',
            status: 'running',
            sessionId: 'task-active',
            segments: [{ sessionId: 'task-active-prev', endedAt: 110 }],
          },
          {
            id: 't-settled',
            status: 'done',
            sessionId: 'task-settled',
            roomId: 'room-orig',
            segments: [{ sessionId: 'task-settled-prev', endedAt: 120 }],
          },
        ],
      },
    },
    rooms: {
      'room-orig': {
        id: 'room-orig',
        name: 'Team Room',
        sessionId: 'room-cur',
        members: ['bot-orig'],
        parts: [{ sessionId: 'room-prev-part', endedAt: 130 }],
        sessions: { 'bot-orig': 'group-hidden-cur' },
        segments: { 'bot-orig': [{ sessionId: 'group-hidden-prev', endedAt: 140 }] },
      },
    },
    agents: {
      'agent-1': {
        id: 'agent-1',
        name: 'Classic',
        sessions: ['classic-owned'],
      },
    },
  }))

  const disposers = []
  const storeCtx = {
    get: name => ctx.get(name),
    logger: { warn: () => {} },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx: storeCtx,
    home,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: () => {},
  }
  installStore(rt)
  installFeedback(rt)

  t.after(async () => {
    await Promise.allSettled(disposers.splice(0).map(fn => fn()))
    await fiber.dispose()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const teamSessionIds = [
    'bot-orig',
    'bot-cur',
    'bot-prev-part',
    'task-active',
    'task-active-prev',
    'task-settled',
    'task-settled-prev',
    'room-orig',
    'room-cur',
    'room-prev-part',
    'group-hidden-cur',
    'group-hidden-prev',
  ]
  const classicSessionIds = ['classic-owned', 'classic-unowned']

  // Seed every session into the real DSH feedback service so acceptance/refusal comes solely from the host guard.
  for (const sid of [...teamSessionIds, ...classicSessionIds]) seedSession(sid, ['msg-1'])

  // Trigger cold-start load automatically via the first feedback call (no pre-call to rt.load()).
  for (const sid of teamSessionIds) {
    await assert.rejects(() => rt.feedbackEndpoint('list', { sessionId: sid }), { code: 'bot/refused' }, `${sid}: list refused`)
    await assert.rejects(() => rt.feedbackEndpoint('put', { sessionId: sid, messageId: 'msg-1', rating: 'positive', ifVersion: null }), { code: 'bot/refused' }, `${sid}: put refused`)
    await assert.rejects(() => rt.feedbackEndpoint('delete', { sessionId: sid, messageId: 'msg-1', ifVersion: 'v1' }), { code: 'bot/refused' }, `${sid}: delete refused`)
    assert.equal(rt.isTeamSession(sid), true, `${sid} classified as team session`)
  }

  for (const sid of classicSessionIds) {
    assert.equal(rt.isTeamSession(sid), false, `${sid} classified as classic session`)
    assert.deepEqual(await rt.feedbackEndpoint('list', { sessionId: sid }), { available: true, items: [] })
    const created = await rt.feedbackEndpoint('put', { sessionId: sid, messageId: 'msg-1', rating: 'positive', ifVersion: null })
    assert.equal(created.ok, true)
    const deleted = await rt.feedbackEndpoint('delete', { sessionId: sid, messageId: 'msg-1', ifVersion: created.item.version })
    assert.deepEqual(deleted, { ok: true, absent: true })
  }
})
