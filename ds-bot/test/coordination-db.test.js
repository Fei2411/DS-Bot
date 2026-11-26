import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  CoordinationError,
  SCHEMA_VERSION,
  computeProgressSignature,
  install,
  openCoordinationDb,
} from '../src/host/coordination-db.js'

function makeDb(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-coord-db-'))
  let tick = 1_700_000_000_000
  const db = openCoordinationDb({
    home: dir,
    now: () => {
      tick += 10
      return tick
    },
    ...opts,
  })
  t.after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir, path: join(dir, 'coordination.sqlite') }
}

test('schema initialization, WAL mode, foreground uniqueness, and logical address rebinding', (t) => {
  const { db, path } = makeDb(t)
  assert.equal(db.schemaVersion(), SCHEMA_VERSION)
  assert.equal(db.readonly, false)

  const raw = new DatabaseSync(path)
  t.after(() => raw.close())
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')

  const fg1 = db.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-1' })
  assert.equal(fg1.created, true)
  assert.equal(fg1.work.kind, 'foreground')
  assert.equal(fg1.work.priority, 'foreground')
  assert.equal(fg1.work.logicalAddress, 'foreground:botA')
  assert.equal(fg1.work.sessionId, 'sess-1')

  const fg2 = db.ensureForegroundWork({ botId: 'botA', sessionId: 'sess-other' })
  assert.equal(fg2.created, false)
  assert.equal(fg2.work.workId, fg1.work.workId)

  assert.throws(
    () => db.createWork({ botId: 'botA', kind: 'foreground', workId: 'fg-dup' }),
    err => err instanceof CoordinationError && err.code === 'coordination/foreground_exists',
  )

  // Part switch rebinds session_id without changing logicalAddress.
  const rebound = db.rebindSession(fg1.work.workId, 'sess-2')
  assert.equal(rebound.sessionId, 'sess-2')
  assert.equal(rebound.logicalAddress, 'foreground:botA')
  assert.equal(db.getWorkBySessionId('sess-2').workId, fg1.work.workId)
  assert.equal(db.getWorkByLogicalAddress('foreground:botA').workId, fg1.work.workId)

  // External API Run maps 1:1 to a work with idempotency key deduplication.
  const run1 = db.createWork({
    botId: 'botA',
    kind: 'task',
    originKind: 'api',
    apiRunId: 'run_abc123',
    apiIdempotencyKey: 'tok1:botA:req-42',
    apiMeta: { tokenName: 'ci-bot', mode: 'task' },
  })
  assert.equal(run1.created, true)
  const runDup = db.createWork({
    botId: 'botA',
    kind: 'task',
    originKind: 'api',
    apiRunId: 'run_should_ignore',
    apiIdempotencyKey: 'tok1:botA:req-42',
  })
  assert.equal(runDup.created, false)
  assert.equal(runDup.deduplicated, true)
  assert.equal(runDup.work.workId, run1.work.workId)
  assert.equal(db.getWorkByApiRunId('run_abc123').workId, run1.work.workId)
  assert.equal(db.getWorkByApiIdempotencyKey('tok1:botA:req-42').workId, run1.work.workId)
})

test('inbox ordering, dedupKey idempotency, ready deduplication, priority order, and zero-wake note invariant', (t) => {
  const { db } = makeDb(t)
  const fg = db.ensureForegroundWork({ botId: 'botA' }).work
  const bg = db.createWork({ botId: 'botA', kind: 'task', priority: 'background', title: 'bg' }).work
  const inter = db.createWork({ botId: 'botA', kind: 'task', priority: 'interactive', title: 'inter' }).work

  // 10 rapid revisions -> 10 ordered seq rows, revision bumped 10 times, strictly 1 ready card.
  for (let i = 1; i <= 10; i += 1) {
    const res = db.receiveMessage({
      workId: bg.workId,
      kind: 'revise',
      dedupKey: `rev-${i}`,
      bodyPreview: `update #${i}`,
    })
    assert.equal(res.accepted, true)
    assert.equal(res.deduplicated, false)
    assert.equal(res.message.seq, i)
  }
  const dup = db.receiveMessage({
    workId: bg.workId,
    kind: 'revise',
    dedupKey: 'rev-5',
    bodyPreview: 'update #5 retry',
  })
  assert.equal(dup.deduplicated, true)
  assert.equal(dup.message.seq, 5)

  const bgAfter = db.getWork(bg.workId)
  assert.equal(bgAfter.revision, 11)
  assert.equal(db.listInbox(bg.workId).length, 10)
  assert.equal(db.peekReady({ botId: 'botA' }).filter(r => r.workId === bg.workId).length, 1)

  // `note` NEVER sets ready and NEVER wakes an idle work (even if wake: true is mistakenly passed).
  const noteRes = db.receiveMessage({
    workId: fg.workId,
    kind: 'note',
    dedupKey: 'note-1',
    bodyPreview: 'FYI only',
    wake: true,
  })
  assert.equal(noteRes.accepted, true)
  assert.equal(noteRes.readyEnqueued, false)
  assert.equal(db.getWork(fg.workId).status, 'idle')
  assert.equal(db.peekReady({ botId: 'botA' }).some(r => r.workId === fg.workId), false)

  const bg2 = db.createWork({ botId: 'botA', kind: 'task', priority: 'background', title: 'bg2' }).work
  db.receiveMessage({ workId: bg2.workId, kind: 'request', bodyPreview: 'bg2 start' })
  db.receiveMessage({ workId: inter.workId, kind: 'request', bodyPreview: 'inter start' })
  db.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'user chat' })

  const readyOrder = db.peekReady({ botId: 'botA' }).map(r => r.workId)
  assert.equal(readyOrder[0], fg.workId)
  assert.equal(readyOrder.at(-1), bg2.workId)

  const claimedFg = db.claimReady({ botId: 'botA' })
  assert.equal(claimedFg.work.workId, fg.workId)
  assert.equal(claimedFg.unreadMessages.length, 1)
  assert.equal(claimedFg.notes.length, 1)
  assert.equal(claimedFg.notes[0].kind, 'note')
})

test('claim/yield atomic race check: revision or new waking inbox blocks stale yield, silent note does not', (t) => {
  const { db } = makeDb(t)
  const w = db.createWork({ botId: 'botB', kind: 'task', title: 'pricing' }).work
  db.receiveMessage({ workId: w.workId, kind: 'request', bodyPreview: 'check price' })

  const claim1 = db.claimReady({ botId: 'botB' })
  assert.equal(claim1.claimedRevision, 1)
  assert.equal(claim1.claimedInboxSeq, 1)

  // A silent note arriving mid-run MUST NOT block yield or re-queue the work.
  db.receiveMessage({ workId: w.workId, kind: 'note', bodyPreview: 'FYI sibling update' })
  const cleanYield = db.yieldWork({
    workId: w.workId,
    claimToken: claim1.claimToken,
    nextStatus: 'idle',
    expectedRevision: claim1.claimedRevision,
    expectedInboxSeq: claim1.claimedInboxSeq,
    ackThroughSeq: 1,
  })
  assert.equal(cleanYield.yielded, true)
  assert.equal(cleanYield.work.status, 'idle')
  assert.equal(db.peekReady({ botId: 'botB' }).length, 0)

  db.receiveMessage({ workId: w.workId, kind: 'request', bodyPreview: 'round 2' })
  const claim2 = db.claimReady({ botId: 'botB' })
  db.receiveMessage({ workId: w.workId, kind: 'revise', bodyPreview: 'include tax' })

  const staleYield = db.yieldWork({
    workId: w.workId,
    claimToken: claim2.claimToken,
    nextStatus: 'idle',
    expectedRevision: claim2.claimedRevision,
    expectedInboxSeq: claim2.claimedInboxSeq,
  })
  assert.equal(staleYield.yielded, false)
  assert.equal(staleYield.conflict, true)
  assert.equal(staleYield.reason, 'revision_changed')
  assert.equal(staleYield.requeued, true)
  assert.equal(staleYield.currentRevision, 2)
  assert.equal(db.getWork(w.workId).status, 'queued')
  assert.equal(db.peekReady({ botId: 'botB' }).length, 1)

  const claim3 = db.claimReady({ botId: 'botB' })
  assert.equal(claim3.claimedRevision, 2)
  assert.ok(claim3.unreadMessages.some(m => m.kind === 'revise' && m.bodyPreview === 'include tax'))
})

test('three-way race ordering: revise vs settle(done) vs stopWork, plus late result archival', (t) => {
  const { db } = makeDb(t)
  const parent = db.createWork({ botId: 'botA', kind: 'task', title: 'quote' }).work

  // Case 1: Revise commits BEFORE settle(done) -> settle is rejected and work re-queued.
  const child1 = db.createWork({ botId: 'botB', kind: 'task', title: 'price' }).work
  const call1 = db.createCall({
    parentWorkId: parent.workId,
    childWorkId: child1.workId,
    callerBotId: 'botA',
    calleeBotId: 'botB',
    initialMessage: { bodyPreview: 'compute price' },
  }).call
  const c1Claim = db.claimReady({ workId: child1.workId })
  db.receiveMessage({ workId: child1.workId, kind: 'revise', bodyPreview: 'with VAT' })

  const staleSettle = db.settleWork({
    workId: child1.workId,
    outcome: 'done',
    claimToken: c1Claim.claimToken,
    expectedRevision: c1Claim.claimedRevision,
    expectedInboxSeq: c1Claim.claimedInboxSeq,
    summary: 'old price without VAT',
  })
  assert.equal(staleSettle.settled, false)
  assert.equal(staleSettle.conflict, true)
  assert.equal(staleSettle.reason, 'revision_changed')
  assert.equal(db.getCall(call1.callId).status, 'open')

  const c1Claim2 = db.claimReady({ workId: child1.workId })
  const okSettle = db.settleWork({
    workId: child1.workId,
    outcome: 'done',
    claimToken: c1Claim2.claimToken,
    expectedRevision: c1Claim2.claimedRevision,
    expectedInboxSeq: c1Claim2.claimedInboxSeq,
    summary: 'price with VAT = 120',
  })
  assert.equal(okSettle.settled, true)
  assert.equal(db.getCall(call1.callId).status, 'done')
  assert.equal(db.getCall(call1.callId).targetRevision, 2)

  // Case 2: Revise AFTER settle(done) -> rejected as work_terminal, never resurrects.
  const lateRevise = db.receiveMessage({ workId: child1.workId, kind: 'revise', bodyPreview: 'too late' })
  assert.equal(lateRevise.accepted, false)
  assert.equal(lateRevise.reason, 'work_terminal')
  assert.equal(db.getWork(child1.workId).status, 'done')
  assert.equal(db.peekReady({ botId: 'botB' }).some(r => r.workId === child1.workId), false)

  // Case 3: stopWork commits BEFORE old executor reports done -> stopped wins, late done archived only.
  const child2 = db.createWork({ botId: 'botC', kind: 'task', title: 'shipping' }).work
  const call2 = db.createCall({
    parentWorkId: parent.workId,
    childWorkId: child2.workId,
    callerBotId: 'botA',
    calleeBotId: 'botC',
    initialMessage: { bodyPreview: 'compute shipping' },
  }).call
  const c2Claim = db.claimReady({ workId: child2.workId })

  const stopped = db.stopWork(child2.workId, { reason: 'user cancelled', by: 'user' })
  assert.equal(stopped.settled, true)
  assert.equal(stopped.work.status, 'stopped')
  assert.equal(db.getCall(call2.callId).status, 'stopped')

  const lateDone = db.settleWork({
    workId: child2.workId,
    outcome: 'done',
    claimToken: c2Claim.claimToken,
    summary: 'late shipping result',
  })
  assert.equal(lateDone.settled, false)
  assert.equal(lateDone.alreadyTerminal, true)
  assert.equal(lateDone.status, 'stopped')
  assert.equal(lateDone.lateArchived, true)
  assert.equal(db.getWork(child2.workId).status, 'stopped')
  assert.equal(db.getCall(call2.callId).status, 'stopped')

  // Case 4: Cancelled parent receives late child result -> archived without resurrecting parent.
  const parentCancelled = db.createWork({ botId: 'botD', kind: 'task', title: 'cancelled parent' }).work
  const child3 = db.createWork({ botId: 'botE', kind: 'task', title: 'orphan child' }).work
  const call3 = db.createCall({
    parentWorkId: parentCancelled.workId,
    childWorkId: child3.workId,
    callerBotId: 'botD',
    calleeBotId: 'botE',
    initialMessage: { bodyPreview: 'run slow job' },
  }).call
  db.stopWork(parentCancelled.workId, { reason: 'parent stopped' })
  const lateChildSettle = db.settleWork({ workId: child3.workId, outcome: 'done', force: true, summary: 'done late' })
  assert.equal(lateChildSettle.settled, true)
  assert.deepEqual(lateChildSettle.wokenParents, [])
  assert.equal(db.getCall(call3.callId).deliveryStatus, 'archived')
  assert.equal(db.getWork(parentCancelled.workId).status, 'stopped')
  assert.equal(db.peekReady({ botId: 'botD' }).length, 0)
})

test('multi-child fan-out settlement wakes parent exactly once when all required waits resolve, with replay idempotency', (t) => {
  const { db } = makeDb(t)
  const parent = db.createWork({ botId: 'botA', kind: 'task', title: 'quote' }).work
  db.receiveMessage({ workId: parent.workId, kind: 'request', bodyPreview: 'build quote' })
  const pClaim = db.claimReady({ workId: parent.workId })

  const childB = db.createWork({ botId: 'botB', kind: 'task', title: 'price' }).work
  const childC = db.createWork({ botId: 'botC', kind: 'task', title: 'freight' }).work

  const callB = db.createCall({
    parentWorkId: parent.workId,
    childWorkId: childB.workId,
    callerBotId: 'botA',
    calleeBotId: 'botB',
    initialMessage: { bodyPreview: 'check price' },
  }).call
  const callC = db.createCall({
    parentWorkId: parent.workId,
    childWorkId: childC.workId,
    callerBotId: 'botA',
    calleeBotId: 'botC',
    initialMessage: { bodyPreview: 'check freight' },
  }).call

  const pYield = db.yieldWork({
    workId: parent.workId,
    claimToken: pClaim.claimToken,
    expectedRevision: pClaim.claimedRevision,
    expectedInboxSeq: pClaim.claimedInboxSeq,
    ackThroughSeq: pClaim.claimedInboxSeq,
  })
  assert.equal(pYield.yielded, true)
  assert.equal(pYield.work.status, 'waiting')

  const bClaim = db.claimReady({ workId: childB.workId })
  const bSettle = db.settleWork({
    workId: childB.workId,
    outcome: 'done',
    claimToken: bClaim.claimToken,
    expectedRevision: bClaim.claimedRevision,
    expectedInboxSeq: bClaim.claimedInboxSeq,
    summary: 'price=100',
  })
  assert.equal(bSettle.settled, true)
  assert.deepEqual(bSettle.wokenParents, [])
  assert.equal(db.getWork(parent.workId).status, 'waiting')
  assert.equal(db.peekReady({ botId: 'botA' }).length, 0)

  const bReplay = db.settleWork({ workId: childB.workId, outcome: 'done', force: true, summary: 'price=100' })
  assert.equal(bReplay.settled, false)
  assert.equal(bReplay.alreadyTerminal, true)
  assert.equal(db.listInbox(parent.workId).filter(m => m.kind === 'result').length, 1)

  const raw = new DatabaseSync(db.path)
  t.after(() => raw.close())
  assert.throws(
    () => raw.prepare("UPDATE calls SET return_address = 'foreground:hijack' WHERE call_id = ?").run(callB.callId),
    /calls routing fields are immutable/,
  )
  assert.throws(
    () => raw.prepare("UPDATE calls SET status = 'failed' WHERE call_id = ?").run(callB.callId),
    /call already settled/,
  )
  assert.equal(callC.returnAddress, parent.logicalAddress)

  const cClaim = db.claimReady({ workId: childC.workId })
  const cSettle = db.settleWork({
    workId: childC.workId,
    outcome: 'done',
    claimToken: cClaim.claimToken,
    expectedRevision: cClaim.claimedRevision,
    expectedInboxSeq: cClaim.claimedInboxSeq,
    summary: 'freight=20',
  })
  assert.equal(cSettle.settled, true)
  assert.deepEqual(cSettle.wokenParents, [parent.workId])
  assert.equal(db.getWork(parent.workId).status, 'queued')
  assert.equal(db.peekReady({ botId: 'botA' }).length, 1)
  assert.equal(db.listInbox(parent.workId, { unreadOnly: true }).length, 2)
})

test('wait graph cycle detection (2-node and 3-node call cycles), ask_back while parent waits, and ask cycle escalation', (t) => {
  const { db } = makeDb(t)
  const wA = db.createWork({ botId: 'botA', kind: 'task', title: 'A' }).work
  const wB = db.createWork({ botId: 'botB', kind: 'task', title: 'B' }).work
  const wC = db.createWork({ botId: 'botC', kind: 'task', title: 'C' }).work

  db.createCall({ parentWorkId: wA.workId, childWorkId: wB.workId, callerBotId: 'botA', calleeBotId: 'botB' })
  db.createCall({ parentWorkId: wB.workId, childWorkId: wC.workId, callerBotId: 'botB', calleeBotId: 'botC' })

  assert.throws(
    () => db.createCall({ parentWorkId: wB.workId, childWorkId: wA.workId, callerBotId: 'botB', calleeBotId: 'botA' }),
    err => err instanceof CoordinationError
      && err.code === 'coordination/wait_cycle'
      && err.details.suggestedAction === 'ask'
      && err.details.cycle[0] === wB.workId
      && err.details.cycle.at(-1) === wB.workId,
  )

  assert.throws(
    () => db.createCall({ parentWorkId: wC.workId, childWorkId: wA.workId, callerBotId: 'botC', calleeBotId: 'botA' }),
    err => err instanceof CoordinationError
      && err.code === 'coordination/wait_cycle'
      && err.details.cycle.length === 4,
  )
  assert.equal(db.listCalls({ parentWorkId: wC.workId }).length, 0)

  db.receiveMessage({ workId: wA.workId, kind: 'request', bodyPreview: 'start A' })
  const claimA = db.claimReady({ workId: wA.workId })
  db.yieldWork({ workId: wA.workId, claimToken: claimA.claimToken, ackThroughSeq: claimA.claimedInboxSeq })
  assert.equal(db.getWork(wA.workId).status, 'waiting')

  const ask = db.askBack({
    askerWorkId: wB.workId,
    targetWorkId: wA.workId,
    bodyPreview: 'Do you want tax included?',
  })
  assert.equal(ask.wait.kind, 'ask')
  assert.equal(ask.readyEnqueued, true)
  assert.equal(db.getWork(wA.workId).status, 'queued')

  assert.throws(
    () => db.askBack({ askerWorkId: wA.workId, targetWorkId: wB.workId, bodyPreview: 'Ask you back?' }),
    err => err instanceof CoordinationError
      && err.code === 'coordination/ask_cycle'
      && err.details.suggestedAction === 'user_question',
  )

  const claimA2 = db.claimReady({ workId: wA.workId })
  db.receiveMessage({ workId: wB.workId, kind: 'request', bodyPreview: 'start B' })
  const claimB = db.claimReady({ workId: wB.workId })
  db.yieldWork({ workId: wB.workId, claimToken: claimB.claimToken, ackThroughSeq: claimB.claimedInboxSeq })
  assert.equal(db.getWork(wB.workId).status, 'waiting')

  const resolved = db.resolveWait({
    waitId: ask.wait.waitId,
    resolution: { answer: 'Yes, include tax' },
    inboxMessage: { kind: 'answer', bodyPreview: 'Yes, include tax', senderBotId: 'botA' },
  })
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.remainingRequiredWaits, 1)
  assert.equal(resolved.workWoken, false)

  const yieldA2 = db.yieldWork({
    workId: wA.workId,
    claimToken: claimA2.claimToken,
    ackThroughSeq: claimA2.claimedInboxSeq,
  })
  assert.equal(yieldA2.yielded, true)
  assert.equal(yieldA2.work.status, 'waiting')
})

test('unified waits (approval, user_question, secret) and privacy boundary enforcement', (t) => {
  const { db } = makeDb(t)
  const w = db.createWork({ botId: 'botA', kind: 'task', title: 'deploy' }).work
  db.receiveMessage({ workId: w.workId, kind: 'request', bodyPreview: 'deploy app' })
  const claim = db.claimReady({ workId: w.workId })

  const appr = db.addWait({ workId: w.workId, kind: 'approval', targetId: 'appr-1' }).wait
  const uq = db.addWait({ workId: w.workId, kind: 'user_question', targetId: 'uq-1' }).wait
  const sec = db.addWait({ workId: w.workId, kind: 'secret', targetId: 'sec-1' }).wait
  db.yieldWork({ workId: w.workId, claimToken: claim.claimToken, ackThroughSeq: claim.claimedInboxSeq })
  assert.equal(db.getWork(w.workId).status, 'waiting')

  assert.equal(db.resolveWait({ waitId: appr.waitId }).workWoken, false)
  assert.equal(db.resolveWait({ waitId: uq.waitId }).workWoken, false)
  assert.equal(db.getWork(w.workId).status, 'waiting')

  const finalResolve = db.resolveWait({ waitId: sec.waitId })
  assert.equal(finalResolve.workWoken, true)
  assert.equal(db.getWork(w.workId).status, 'queued')
  assert.equal(db.peekReady({ botId: 'botA' }).length, 1)

  assert.equal(db.resolveWait({ waitId: sec.waitId }).alreadyClosed, true)

  assert.throws(
    () => db.createWork({ botId: 'botPriv', kind: 'room_work', roomId: 'room1', visibility: 'room', privacyScoped: true }),
    err => err instanceof CoordinationError && err.code === 'coordination/privacy_escalation',
  )
  const pubParent = db.createWork({ botId: 'botA', kind: 'room_work', roomId: 'room1', visibility: 'room' }).work
  const privChild = db.createWork({ botId: 'botPriv', kind: 'task', privacyScoped: true }).work
  assert.throws(
    () => db.createCall({
      parentWorkId: pubParent.workId,
      childWorkId: privChild.workId,
      callerBotId: 'botA',
      calleeBotId: 'botPriv',
      visibleScope: 'room',
      roomId: 'room1',
    }),
    err => err instanceof CoordinationError && err.code === 'coordination/privacy_escalation',
  )
  const explicitCall = db.createCall({
    parentWorkId: pubParent.workId,
    childWorkId: privChild.workId,
    callerBotId: 'botA',
    calleeBotId: 'botPriv',
    visibleScope: 'room',
    roomId: 'room1',
    explicitPublish: true,
  })
  assert.equal(explicitCall.created, true)
})

test('hard-signal no-progress detection: allows 1000 progressing steps, pauses only stagnant chain, and supports resume', (t) => {
  const { db } = makeDb(t)
  const chain1Root = db.createWork({ botId: 'botA', kind: 'task', title: 'chain1' }).work
  const chain1Child = db.createWork({
    botId: 'botB',
    kind: 'task',
    title: 'chain1-child',
    parentWorkId: chain1Root.workId,
  }).work
  const chain2Root = db.createWork({ botId: 'botC', kind: 'task', title: 'chain2-independent' }).work
  db.receiveMessage({ workId: chain1Root.workId, kind: 'request', bodyPreview: 'go 1' })
  db.receiveMessage({ workId: chain1Child.workId, kind: 'request', bodyPreview: 'go 1c' })
  db.receiveMessage({ workId: chain2Root.workId, kind: 'request', bodyPreview: 'go 2' })

  for (let step = 0; step < 1000; step += 1) {
    const check = db.recordProgressCheck({
      workId: chain1Root.workId,
      unresolvedKey: 'build-project',
      workspaceDigest: `sha-step-${step}`,
      outputDigest: `out-${step}`,
      threshold: 3,
    })
    assert.equal(check.progressed, true)
    assert.equal(check.paused, false)
  }
  assert.equal(db.getWork(chain1Root.workId).status, 'queued')

  const sigRev1 = computeProgressSignature({ revision: 1, workspaceDigest: 'same', outputDigest: 'same', errorSignature: 'E1' })
  const sigRev2 = computeProgressSignature({ revision: 2, workspaceDigest: 'same', outputDigest: 'same', errorSignature: 'E1' })
  assert.notEqual(sigRev1, sigRev2)

  const p1 = db.recordProgressCheck({
    workId: chain1Child.workId,
    unresolvedKey: 'test-failure:auth',
    workspaceDigest: 'ws-stuck',
    outputDigest: 'out-stuck',
    errorSignature: 'ERR_AUTH_401',
    threshold: 3,
  })
  assert.equal(p1.count, 1)
  assert.equal(p1.paused, false)

  const p2 = db.recordProgressCheck({
    workId: chain1Root.workId,
    unresolvedKey: 'test-failure:auth',
    workspaceDigest: 'ws-stuck',
    outputDigest: 'out-stuck',
    errorSignature: 'ERR_AUTH_401',
    threshold: 3,
  })
  assert.equal(p2.count, 2)
  assert.equal(p2.paused, false)

  const p3 = db.recordProgressCheck({
    workId: chain1Child.workId,
    unresolvedKey: 'test-failure:auth',
    workspaceDigest: 'ws-stuck',
    outputDigest: 'out-stuck',
    errorSignature: 'ERR_AUTH_401',
    threshold: 3,
  })
  assert.equal(p3.stagnant, true)
  assert.equal(p3.paused, true)
  assert.equal(db.getWork(chain1Root.workId).status, 'paused')
  assert.equal(db.getWork(chain1Child.workId).status, 'paused')
  assert.equal(db.getWork(chain1Root.workId).pauseReason, 'no_progress')
  assert.equal(db.getWork(chain2Root.workId).status, 'queued')
  assert.equal(db.peekReady({ botId: 'botC' }).length, 1)
  assert.equal(db.peekReady({ botId: 'botA' }).length, 0)

  const resumed = db.resumeWork(chain1Root.workId)
  assert.equal(resumed.resumed, true)
  assert.equal(db.getWork(chain1Root.workId).status, 'queued')
  assert.equal(db.getWork(chain1Child.workId).status, 'queued')
  assert.equal(db.getWork(chain1Root.workId).stagnationCount, 0)
  assert.equal(db.peekReady({ botId: 'botA' }).length, 1)
})

test('DSH D2 delivery attempt keys and crash reconciliation (not_found, interruptedTools, completed, yielded)', (t) => {
  const { db } = makeDb(t)
  const task1 = db.createWork({ botId: 'botA', kind: 'task', title: 't1', sessionId: 's-t1' }).work
  const task2 = db.createWork({ botId: 'botA', kind: 'task', title: 't2', sessionId: 's-t2' }).work
  const task3 = db.createWork({ botId: 'botA', kind: 'task', title: 't3', sessionId: 's-t3' }).work
  for (const w of [task1, task2, task3]) {
    db.receiveMessage({ workId: w.workId, kind: 'request', bodyPreview: 'go' })
  }

  // Task 1: crashed before DSH accepted -> not_found -> requeued to original task (never foreground).
  const c1 = db.claimReady({ workId: task1.workId })
  const d1 = db.beginDeliveryAttempt({ workId: task1.workId, claimToken: c1.claimToken, throughSeq: 1 })
  assert.match(d1.deliveryKey, /^coord:.*:a1$/)
  assert.equal(db.listInterruptedWorks().some(w => w.workId === task1.workId), true)
  const rec1 = db.reconcileDeliveryStatus({ workId: task1.workId, deliveryStatus: { status: 'not_found', consumed: false, toolCalls: 0, interruptedTools: [] } })
  assert.equal(rec1.action, 'requeue')
  assert.equal(rec1.work.status, 'queued')
  assert.equal(db.peekReady({ botId: 'botA' }).some(r => r.workId === task1.workId), true)

  // Task 2: crashed mid-tool -> aborted + consumed + interruptedTools -> needs_verification (not blindly re-run).
  const c2 = db.claimReady({ workId: task2.workId })
  db.beginDeliveryAttempt({ workId: task2.workId, claimToken: c2.claimToken, throughSeq: 1 })
  const rec2 = db.reconcileDeliveryStatus({
    workId: task2.workId,
    deliveryStatus: { status: 'aborted', consumed: true, turn: 4, toolCalls: 1, interruptedTools: ['bash'] },
  })
  assert.equal(rec2.action, 'needs_verification')
  assert.equal(rec2.work.status, 'needs_verification')
  assert.equal(rec2.work.pauseReason, 'interrupted_tools')
  assert.deepEqual(rec2.work.pauseDetail.interruptedTools, ['bash'])
  assert.equal(db.peekReady({ botId: 'botA' }).some(r => r.workId === task2.workId), false)

  // Task 3: completed before host ack -> autoSettle settles cleanly without duplicate turn.
  const c3 = db.claimReady({ workId: task3.workId })
  db.beginDeliveryAttempt({ workId: task3.workId, claimToken: c3.claimToken, throughSeq: 1 })
  const rec3 = db.reconcileDeliveryStatus({
    workId: task3.workId,
    deliveryStatus: { status: 'completed', consumed: true, turn: 2, assistantText: 'finished cleanly', toolCalls: 0, interruptedTools: [] },
    autoSettle: true,
  })
  assert.equal(rec3.action, 'settled')
  assert.equal(db.getWork(task3.workId).status, 'done')
  assert.equal(db.getWork(task3.workId).resultSummary, 'finished cleanly')

  // Paused work with aborted/!consumed must NOT be blindly requeued during restart reconciliation.
  const taskPaused = db.createWork({ botId: 'botA', kind: 'task', title: 'paused-t' }).work
  db.pauseWork(taskPaused.workId, { reason: 'user_paused' })
  const recPaused = db.reconcileDeliveryStatus({
    workId: taskPaused.workId,
    deliveryStatus: { status: 'aborted', consumed: false, toolCalls: 0, interruptedTools: [] },
  })
  assert.equal(recPaused.action, 'keep_paused')
  assert.equal(db.getWork(taskPaused.workId).status, 'paused')
  assert.equal(db.peekReady({ botId: 'botA' }).some(r => r.workId === taskPaused.workId), false)
})

test('workspace serial policy for writable tasks vs parallel readonly/isolated tasks', (t) => {
  const { db } = makeDb(t)
  const wWrite1 = db.createWork({ botId: 'botA', kind: 'task', workspaceDir: '/repo', workspaceMode: 'write' }).work
  const wWrite2 = db.createWork({ botId: 'botB', kind: 'task', workspaceDir: '/repo', workspaceMode: 'write' }).work
  const wRead = db.createWork({ botId: 'botC', kind: 'task', workspaceDir: '/repo', workspaceMode: 'read' }).work
  const wIso = db.createWork({ botId: 'botD', kind: 'task', workspaceDir: '/repo-wt', workspaceMode: 'isolated' }).work

  for (const w of [wWrite1, wWrite2, wRead, wIso]) {
    db.receiveMessage({ workId: w.workId, kind: 'request', bodyPreview: 'run' })
  }

  const c1 = db.claimReady({ respectWorkspaceLock: true })
  assert.equal(c1.work.workId, wWrite1.workId)

  const c2 = db.claimReady({ respectWorkspaceLock: true })
  assert.equal(c2.work.workId, wRead.workId)
  const c3 = db.claimReady({ respectWorkspaceLock: true })
  assert.equal(c3.work.workId, wIso.workId)
  const c4 = db.claimReady({ respectWorkspaceLock: true })
  assert.equal(c4, undefined)

  db.yieldWork({ workId: wWrite1.workId, claimToken: c1.claimToken, ackThroughSeq: c1.claimedInboxSeq })
  const c5 = db.claimReady({ respectWorkspaceLock: true })
  assert.equal(c5.work.workId, wWrite2.workId)
})

test('readonly mode safely reads WAL snapshot from active writer, blocks all mutations, and install(rt) upgrades on adopt', (t) => {
  const { db: writer, dir, path } = makeDb(t)
  const fg = writer.ensureForegroundWork({ botId: 'botA', sessionId: 's1' }).work
  writer.receiveMessage({ workId: fg.workId, kind: 'request', dedupKey: 'm1', bodyPreview: 'hello' })

  const reader = openCoordinationDb({ path, readonly: true })
  t.after(() => reader.close())
  assert.equal(reader.readonly, true)

  const snap = reader.getSnapshot({ botId: 'botA' })
  assert.equal(snap.works.length, 1)
  assert.equal(snap.ready.length, 1)
  assert.equal(reader.listInbox(fg.workId).length, 1)

  writer.receiveMessage({ workId: fg.workId, kind: 'revise', dedupKey: 'm2', bodyPreview: 'rev 2' })
  assert.equal(reader.getWork(fg.workId).revision, 2)
  assert.equal(reader.listInbox(fg.workId).length, 2)

  assert.throws(
    () => reader.receiveMessage({ workId: fg.workId, kind: 'note', bodyPreview: 'illegal' }),
    err => err instanceof CoordinationError && err.code === 'coordination/readonly',
  )
  assert.throws(
    () => reader.claimReady({ botId: 'botA' }),
    err => err instanceof CoordinationError && err.code === 'coordination/readonly',
  )
  assert.throws(
    () => reader.stopWork(fg.workId),
    err => err instanceof CoordinationError && err.code === 'coordination/readonly',
  )

  let roReason = 'locked by another host'
  const listeners = new Set()
  const disposes = []
  const rt = {
    home: dir,
    readOnly: () => roReason,
    onAdopted: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    ctx: { effect: fn => disposes.push(fn()) },
    warn: (...args) => assert.fail(args.join(' ')),
  }
  install(rt)
  assert.equal(rt.coordDb.readonly, true)
  roReason = undefined
  for (const fn of listeners) fn()
  assert.equal(rt.coordDb.readonly, false)
  for (const fn of disposes) fn()
  assert.equal(rt.coordDb, null)
})

test('crash/restart persistence and idempotent replay across reopened database handles', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-coord-crash-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const db1 = openCoordinationDb({ home: dir })
  const parent = db1.createWork({ workId: 'w-parent', botId: 'botA', kind: 'task' }).work
  const child = db1.createWork({ workId: 'w-child', botId: 'botB', kind: 'task' }).work
  db1.receiveMessage({ workId: parent.workId, kind: 'request', dedupKey: 'req-p' })
  const pClaim = db1.claimReady({ workId: parent.workId })
  const call = db1.createCall({
    callId: 'c-1',
    parentWorkId: parent.workId,
    childWorkId: child.workId,
    callerBotId: 'botA',
    calleeBotId: 'botB',
    initialMessage: { dedupKey: 'req-c1', bodyPreview: 'work' },
  }).call
  db1.yieldWork({ workId: parent.workId, claimToken: pClaim.claimToken, ackThroughSeq: pClaim.claimedInboxSeq })
  db1.settleWork({ workId: child.workId, outcome: 'done', force: true, summary: 'result-once' })
  db1.close()

  const db2 = openCoordinationDb({ home: dir })
  t.after(() => db2.close())
  assert.equal(db2.getWork(parent.workId).status, 'queued')
  assert.equal(db2.getCall(call.callId).status, 'done')
  assert.equal(db2.peekReady({ botId: 'botA' }).length, 1)

  const replaySettle = db2.settleWork({ workId: child.workId, outcome: 'done', force: true, summary: 'result-once' })
  assert.equal(replaySettle.alreadyTerminal, true)
  assert.equal(db2.listInbox(parent.workId).filter(m => m.kind === 'result').length, 1)
  assert.equal(db2.peekReady({ botId: 'botA' }).length, 1)
})

test('idempotent migration from legacy state.json, inflight.json, and api-runs.json', (t) => {
  const { db } = makeDb(t)
  const legacyState = {
    version: 1,
    bots: {
      botA: {
        id: 'botA',
        name: 'Alice',
        sessionId: 'sess-a',
        workDir: '/ws/a',
        tasks: [
          { id: 'k_run', title: 'Build', status: 'running', sessionId: 'sess-task-1', origin: 'task' },
          { id: 'k_appr', title: 'Deploy', status: 'waiting_approval', sessionId: 'sess-task-2' },
          { id: 'k_done', title: 'Old', status: 'completed', sessionId: 'sess-task-old' },
        ],
      },
      botB: {
        id: 'botB',
        name: 'Bob',
        sessionId: 'sess-b',
        privacy: true,
        tasks: [],
      },
    },
    works: {
      w_open: { ref: 'W1', state: 'open', from: 'botA', to: 'botB', goal: 'Audit privacy', toSession: 'sess-b' },
      w_ask: { ref: 'W2', state: 'need_input', from: 'botA', to: 'botB', question: 'Which env?' },
      w_paused: { ref: 'W3', state: 'paused', from: 'botA', to: 'botB', paused: { reason: 'rework_limit' } },
    },
    roomBatches: {
      'room1:b1': { key: 'room1:b1', roomId: 'room1', botId: 'botA', pending: ['botB'], done: [], results: [] },
    },
    roomReports: {
      rep1: { id: 'rep1', roomId: 'room1', botId: 'botA', status: 'tracking', fromSeq: 5, imOrigin: { connId: 'tg1', chatKey: 'c1' } },
    },
    questions: {
      'sess-a': { text: 'Confirm region?' },
    },
    secretRequests: {
      botA: [{ id: 'sec_openai', name: 'OPENAI_KEY', status: 'pending', sessionId: 'sess-a' }],
    },
  }
  const legacyInflight = {
    turns: {
      'sess-task-1': { botId: 'botA', turn: 3, since: 1000 },
      'sess-task-2': { botId: 'botA', turn: 1, since: 1001, approval: { tool: 'bash', reason: 'rm' } },
    },
    queued: {
      'sess-a': [
        { at: 1002, args: { exchangeId: 'ex-1', toId: 'botA', fromId: 'botB', role: 'request', text: 'please review' } },
        { at: 1003, args: { exchangeId: 'ex-note', toId: 'botA', fromId: 'botB', role: 'note', wake: false, text: 'fyi' } },
      ],
      // Stale queued delivery for an already-settled task MUST NOT leak into fg:botA.
      'sess-task-old': [
        { at: 1004, args: { exchangeId: 'ex-stale-task', toId: 'botA', role: 'task', text: 'ghost task prompt' } },
      ],
    },
    silent: {
      'sess-b': [
        { message: { id: 'sil-1', source: { exchangeId: 'ex-sil-1', fromId: 'botA', toId: 'botB' } } },
      ],
    },
  }
  const legacyApiRuns = {
    version: 1,
    runs: [
      { runId: 'run_legacy_1', target: { kind: 'bot', id: 'botA', name: 'Alice' }, mode: 'task', status: 'completed' },
    ],
  }

  const first = db.importLegacyState({ state: legacyState, inflight: legacyInflight, apiRuns: legacyApiRuns })
  assert.ok(first.imported.works >= 8)
  assert.ok(first.imported.calls >= 4)
  assert.ok(first.imported.waits >= 6)
  assert.equal(first.imported.inbox, 3)

  assert.equal(db.getForegroundWork('botA').sessionId, 'sess-a')
  // Interrupted inflight turn is marked `running` with activeTurn (zero synthetic inbox request) for D2 reconciliation.
  const kRun = db.getWork('task:k_run')
  assert.equal(kRun.status, 'running')
  assert.equal(kRun.activeTurn, 3)
  assert.equal(db.listInbox('task:k_run').length, 0)
  assert.equal(db.getWork('task:k_done'), undefined)
  // Settled task's stale queued message never leaked into foreground inbox.
  const fgAInbox = db.listInbox('fg:botA')
  assert.equal(fgAInbox.length, 2)
  assert.equal(fgAInbox[0].dshIdempotencyKey, 'ex-1')
  assert.equal(fgAInbox.some(m => m.bodyPreview === 'ghost task prompt'), false)
  assert.equal(db.getWork('handoff:w_paused').status, 'paused')
  assert.equal(db.getWorkByApiRunId('run_legacy_1').status, 'done')
  assert.deepEqual(db.getWork('room-report:rep1').imOrigin, { connId: 'tg1', chatKey: 'c1' })

  const botBInbox = db.listInbox('fg:botB')
  assert.equal(botBInbox.length, 1)
  assert.equal(botBInbox[0].kind, 'note')
  assert.equal(db.getForegroundWork('botB').status, 'idle')

  assert.equal(db.getCall('call_batch:room1:b1:botB').visibleScope, 'private')

  const snapBefore = db.getSnapshot()
  const second = db.importLegacyState({ state: legacyState, inflight: legacyInflight, apiRuns: legacyApiRuns })
  assert.equal(second.imported.works, 0)
  assert.equal(second.imported.calls, 0)
  assert.equal(second.imported.inbox, 0)
  assert.equal(second.imported.waits, 0)
  assert.equal(second.imported.ready, 0)
  const snapAfter = db.getSnapshot()
  assert.equal(snapAfter.works.length, snapBefore.works.length)
  assert.equal(snapAfter.calls.length, snapBefore.calls.length)
  assert.equal(snapAfter.waits.length, snapBefore.waits.length)
  assert.equal(snapAfter.ready.length, snapBefore.ready.length)
})

test('verifier regressions: foreground chain isolation, reconcileDeliveryStatus edge cases, ask unblock on terminal target, chain revision stagnation, workspace lock vs foreground, and readonly schema check', (t) => {
  const { db, path } = makeDb(t)

  // 1. P0 #1: Tasks spawned from foreground own independent causal chains; pausing task1 never pauses foreground or task2.
  const fg = db.ensureForegroundWork({ botId: 'botA', sessionId: 'fg-s', workspaceDir: '/ws' }).work
  const task1 = db.createWork({ botId: 'botA', kind: 'task', parentWorkId: fg.workId, workspaceDir: '/ws', workspaceMode: 'write' }).work
  const task1Sub = db.createWork({ botId: 'botB', kind: 'task', parentWorkId: task1.workId }).work
  const task2 = db.createWork({ botId: 'botA', kind: 'task', parentWorkId: fg.workId, workspaceDir: '/ws', workspaceMode: 'read' }).work
  assert.equal(task1.rootWorkId, task1.workId)
  assert.equal(task1Sub.rootWorkId, task1.workId)
  assert.equal(task2.rootWorkId, task2.workId)

  db.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'quick question' })
  db.receiveMessage({ workId: task1.workId, kind: 'request', bodyPreview: 'long task 1' })
  db.receiveMessage({ workId: task2.workId, kind: 'request', bodyPreview: 'task 2' })

  // 6. P1 #6: Parent (revision=2) and child (revision=1) alternating identical hard signals still trigger stagnation.
  db.receiveMessage({ workId: task1.workId, kind: 'revise', bodyPreview: 'rev 2 on parent' })
  assert.equal(db.getWork(task1.workId).revision, 2)
  assert.equal(db.getWork(task1Sub.workId).revision, 1)
  db.recordProgressCheck({ workId: task1.workId, unresolvedKey: 'stuck-item', workspaceDigest: 'd1', outputDigest: 'o1', threshold: 3 })
  db.recordProgressCheck({ workId: task1Sub.workId, unresolvedKey: 'stuck-item', workspaceDigest: 'd1', outputDigest: 'o1', threshold: 3 })
  const stag3 = db.recordProgressCheck({ workId: task1.workId, unresolvedKey: 'stuck-item', workspaceDigest: 'd1', outputDigest: 'o1', threshold: 3 })
  assert.equal(stag3.paused, true)
  assert.equal(db.getWork(task1.workId).status, 'paused')
  assert.equal(db.getWork(task1Sub.workId).status, 'paused')
  // Foreground and sibling task2 MUST remain unaffected!
  assert.equal(db.getWork(fg.workId).status, 'queued')
  assert.equal(db.getWork(task2.workId).status, 'queued')

  // 4. P0 #4: Running background write task does NOT block foreground chat on same workspaceDir.
  const bgWrite = db.createWork({ botId: 'botA', kind: 'task', workspaceDir: '/ws', workspaceMode: 'write' }).work
  db.receiveMessage({ workId: bgWrite.workId, kind: 'request', bodyPreview: 'bg write' })
  const bgWriteClaim = db.claimReady({ workId: bgWrite.workId, respectWorkspaceLock: true })
  assert.equal(bgWriteClaim.work.workId, bgWrite.workId)
  const fgClaim = db.claimReady({ botId: 'botA', respectWorkspaceLock: true })
  assert.equal(fgClaim.work.workId, fg.workId)

  // 2. P0 #2: reconcileDeliveryStatus on failed foreground releases claim (never sticks in running).
  db.beginDeliveryAttempt({ workId: fg.workId, claimToken: fgClaim.claimToken, throughSeq: 1 })
  const recFailedFg = db.reconcileDeliveryStatus({
    workId: fg.workId,
    deliveryStatus: { status: 'failed', consumed: true, error: { code: 'llm/500', message: 'boom' }, toolCalls: 0, interruptedTools: [] },
    autoSettle: true,
  })
  assert.equal(recFailedFg.action, 'failed')
  assert.equal(db.getWork(fg.workId).status, 'idle')
  assert.equal(db.getWork(fg.workId).claimToken, null)

  // P0 #2b: completed foreground with newly arrived unread waking message requeues instead of dropping wake.
  db.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'msg 2' })
  const fgClaim2 = db.claimReady({ workId: fg.workId })
  db.beginDeliveryAttempt({ workId: fg.workId, claimToken: fgClaim2.claimToken, throughSeq: fgClaim2.claimedInboxSeq })
  db.receiveMessage({ workId: fg.workId, kind: 'request', bodyPreview: 'msg 3 arrived mid-turn' })
  const recCompletedFg = db.reconcileDeliveryStatus({
    workId: fg.workId,
    deliveryStatus: { status: 'completed', consumed: true, assistantText: 'reply 2', toolCalls: 0, interruptedTools: [] },
  })
  assert.equal(recCompletedFg.action, 'requeue')
  assert.equal(db.getWork(fg.workId).status, 'queued')

  // P0 #2c: completed background task with autoSettle:true does NOT swallow a pre-crash revision.
  db.beginDeliveryAttempt({ workId: bgWrite.workId, claimToken: bgWriteClaim.claimToken, throughSeq: bgWriteClaim.claimedInboxSeq })
  db.receiveMessage({ workId: bgWrite.workId, kind: 'revise', bodyPreview: 'must include tax' })
  const recCompletedStale = db.reconcileDeliveryStatus({
    workId: bgWrite.workId,
    deliveryStatus: { status: 'completed', consumed: true, assistantText: 'stale pre-tax draft', toolCalls: 0, interruptedTools: [] },
    autoSettle: true,
  })
  assert.equal(recCompletedStale.action, 'requeue')
  assert.equal(db.getWork(bgWrite.workId).status, 'queued')

  // 5. P1 #5: Terminating target work unblocks incoming `ask` waiter so asker never hangs.
  const targetA = db.createWork({ botId: 'botA', kind: 'task', title: 'targetA' }).work
  const askerB = db.createWork({ botId: 'botB', kind: 'task', title: 'askerB' }).work
  db.receiveMessage({ workId: askerB.workId, kind: 'request', bodyPreview: 'do work' })
  const bClaim = db.claimReady({ workId: askerB.workId })
  db.askBack({ askerWorkId: askerB.workId, targetWorkId: targetA.workId, bodyPreview: 'need clarify' })
  db.yieldWork({ workId: askerB.workId, claimToken: bClaim.claimToken, ackThroughSeq: bClaim.claimedInboxSeq })
  assert.equal(db.getWork(askerB.workId).status, 'waiting')
  const stopA = db.stopWork(targetA.workId, { reason: 'user stopped A' })
  assert.deepEqual(stopA.wokenAskers, [askerB.workId])
  assert.equal(db.getWork(askerB.workId).status, 'queued')
  assert.equal(db.listWaits({ workId: askerB.workId, status: 'open' }).length, 0)

  // 7. P1 #7: claimReady scans past >100 workspace-blocked writable tasks to find a readonly task,
  //    and readonly openCoordinationDb enforces PRAGMA user_version check.
  const holder = db.createWork({ botId: 'botX', kind: 'task', workspaceDir: '/busy-ws', workspaceMode: 'write' }).work
  db.receiveMessage({ workId: holder.workId, kind: 'request', bodyPreview: 'hold lock' })
  db.claimReady({ workId: holder.workId, respectWorkspaceLock: true })
  for (let i = 0; i < 105; i += 1) {
    const blocked = db.createWork({ botId: 'botX', kind: 'task', workspaceDir: '/busy-ws', workspaceMode: 'write' }).work
    db.receiveMessage({ workId: blocked.workId, kind: 'request', bodyPreview: `blocked-${i}` })
  }
  const tailRead = db.createWork({ botId: 'botX', kind: 'task', workspaceDir: '/busy-ws', workspaceMode: 'read' }).work
  db.receiveMessage({ workId: tailRead.workId, kind: 'request', bodyPreview: 'readonly tail' })
  const tailClaim = db.claimReady({ botId: 'botX', respectWorkspaceLock: true })
  assert.equal(tailClaim.work.workId, tailRead.workId)

  // Readonly schema version guard: newer user_version throws structured coordination/schema_newer.
  const futureDir = mkdtempSync(join(tmpdir(), 'dsb-coord-future-'))
  t.after(() => rmSync(futureDir, { recursive: true, force: true }))
  const futurePath = join(futureDir, 'coordination.sqlite')
  const rawFuture = new DatabaseSync(futurePath)
  rawFuture.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`)
  rawFuture.close()
  assert.throws(
    () => openCoordinationDb({ path: futurePath, readonly: true }),
    err => err instanceof CoordinationError && err.code === 'coordination/schema_newer',
  )
  // Existing valid DB still opens readonly without error.
  const validRo = openCoordinationDb({ path, readonly: true })
  assert.equal(validRo.schemaVersion(), SCHEMA_VERSION)
  validRo.close()

  // 8. parkWaiting only transitions `running -> waiting` and never clobbers `paused` / `needs_verification`.
  const pVerify = db.createWork({ botId: 'botX', kind: 'room_work', status: 'running' }).work
  db.pauseWork(pVerify.workId, { status: 'needs_verification', reason: 'claimed_before_restart' })
  assert.equal(db.parkWaiting(pVerify.workId).status, 'needs_verification')
  const pPaused = db.createWork({ botId: 'botX', kind: 'room_work', status: 'running' }).work
  db.pauseWork(pPaused.workId, { status: 'paused', reason: 'no_progress' })
  assert.equal(db.parkWaiting(pPaused.workId).status, 'paused')
  const pRun = db.createWork({ botId: 'botX', kind: 'room_work', status: 'running' }).work
  assert.equal(db.parkWaiting(pRun.workId).status, 'waiting')

  // 9. P1-2: paused / needs_verification parents never enter `satisfiedParents` or `wokenParents`
  //    when a child settles, and `recordDirectDeliveryAttempt` refuses paused/needs_verification works.
  for (const blockedStatus of ['paused', 'needs_verification']) {
    const parent = db.createWork({ botId: 'botX', kind: 'room_work', status: 'running' }).work
    const child = db.createWork({ botId: 'botY', kind: 'room_work', status: 'running', parentWorkId: parent.workId }).work
    db.createCall({
      parentWorkId: parent.workId,
      childWorkId: child.workId,
      callerBotId: 'botX',
      calleeBotId: 'botY',
      returnAddress: parent.logicalAddress,
    })
    db.pauseWork(parent.workId, { status: blockedStatus, reason: 'explicit_hold' })
    const settleChild = db.settleWork({ workId: child.workId, outcome: 'done', force: true, summary: 'child finished' })
    assert.deepEqual(settleChild.wokenParents, [])
    assert.deepEqual(settleChild.satisfiedParents, [])
    assert.equal(db.getWork(parent.workId).status, blockedStatus)
    assert.equal(db.listInbox(parent.workId, { unreadOnly: true }).some(m => m.kind === 'result'), true)
    assert.throws(
      () => db.recordDirectDeliveryAttempt({ workId: parent.workId, idempotencyKey: `k-${blockedStatus}`, sessionId: 's-hold' }),
      err => err instanceof CoordinationError && err.code === 'coordination/work_paused',
    )
  }

  // 10. Clean single-track upgrade from prior sidecar coordination schema (`user_version = 2`)
  //     and corrupt SQLite quarantine/rebuild on writable open (readonly still fails closed).
  const legacyV2Path = join(futureDir, 'legacy-v2.sqlite')
  const legacyRaw = new DatabaseSync(legacyV2Path)
  legacyRaw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE obligations (obligation_id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE deliveries (exchange_id TEXT PRIMARY KEY);
    CREATE TABLE active_turns (session_id TEXT PRIMARY KEY);
    CREATE TABLE silent_notes (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE terminal_markers (kind TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (kind, owner_id));
    PRAGMA user_version = 2;
  `)
  legacyRaw.close()
  const upgraded = openCoordinationDb({ path: legacyV2Path })
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION)
  const wUp = upgraded.createWork({ botId: 'botUp', kind: 'task', title: 'after upgrade' }).work
  assert.equal(upgraded.getWork(wUp.workId).title, 'after upgrade')
  upgraded.close()
  const verifyUpgraded = new DatabaseSync(legacyV2Path, { readOnly: true })
  const remainingLegacy = verifyUpgraded
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('obligations','deliveries','active_turns','silent_notes','terminal_markers','meta')")
    .all()
  assert.deepEqual(remainingLegacy, [])
  verifyUpgraded.close()

  const corruptPath = join(futureDir, 'corrupt.sqlite')
  writeFileSync(corruptPath, 'definitely not a valid sqlite database header!!!')
  writeFileSync(`${corruptPath}-wal`, 'simulated-wal-bytes')
  assert.throws(() => openCoordinationDb({ path: corruptPath, readonly: true }))
  const warnings = []
  const recovered = openCoordinationDb({ path: corruptPath, onWarn: (...args) => warnings.push(args) })
  assert.equal(recovered.schemaVersion(), SCHEMA_VERSION)
  recovered.close()
  const preservedFiles = readdirSync(futureDir).filter(name => name.startsWith('corrupt.sqlite.corrupt-'))
  assert.equal(preservedFiles.length, 2, 'corrupt db and wal must be renamed to .corrupt-* backups instead of deleted')
  assert.ok(preservedFiles.some(name => !name.endsWith('-wal')), 'corrupt db backup preserved')
  assert.ok(preservedFiles.some(name => name.endsWith('-wal')), 'corrupt wal backup preserved')
  assert.equal(warnings.length, 1, 'corrupt reset must emit a diagnostic warning')

  // 11. Direct-delivery exact-key vs batch-throughSeq binding:
  //     (a) Single-message direct delivery (no `throughSeq`, e.g. `deliverToTask`) binds ONLY its
  //         own inbox row via `dsh_idempotency_key`, NEVER stamping or swallowing earlier unread rows;
  //     (b) Batch direct delivery (`throughSeq`, e.g. group `room_work` synthesis) stamps `<= throughSeq`
  //         and advances `lastDeliveredSeq`.
  const ddTask = db.createWork({ botId: 'botA', kind: 'task', logicalAddress: 'task:dd1', sessionId: 'sess-dd1' }).work
  const rev1 = db.receiveMessage({
    workId: ddTask.workId,
    kind: 'revise',
    bodyPreview: 'follow up 1',
    dshIdempotencyKey: 'task-send:dd1:k1',
    wake: false,
  })
  const afterAttempt = db.recordDirectDeliveryAttempt({
    workId: ddTask.workId,
    idempotencyKey: 'task-send:dd1:k1',
    sessionId: 'sess-dd1',
  })
  assert.equal(afterAttempt.lastDeliveredSeq, 0, 'single-message direct delivery must not advance batch lastDeliveredSeq')
  const recDone = db.reconcileDeliveryStatus({
    workId: ddTask.workId,
    deliveryStatus: { status: 'completed', consumed: true, idempotencyKey: 'task-send:dd1:k1', assistantText: 'done' },
    autoSettle: true,
  })
  assert.equal(recDone.action, 'settled')
  assert.equal(db.getWork(ddTask.workId).status, 'done')
  assert.equal(db.listInbox(ddTask.workId, { unreadOnly: true }).length, 0)
  assert.equal(db.getWork(ddTask.workId).lastConsumedSeq, rev1.message.seq)

  // Mixed inbox probe: unread seq=1 child result + direct seq=2 revise(key='k-follow') ->
  // consuming 'k-follow' marks ONLY seq=2 read, preserves seq=1 unread, and requeues work for seq=1!
  const ddMixed = db.createWork({ botId: 'botA', kind: 'task', logicalAddress: 'task:dd-mixed', sessionId: 'sess-dd-mixed' }).work
  db.receiveMessage({ workId: ddMixed.workId, kind: 'result', bodyPreview: 'child result 1', wake: false })
  db.receiveMessage({ workId: ddMixed.workId, kind: 'revise', bodyPreview: 'follow up 2', dshIdempotencyKey: 'k-follow', wake: false })
  db.recordDirectDeliveryAttempt({ workId: ddMixed.workId, idempotencyKey: 'k-follow', sessionId: 'sess-dd-mixed' })
  const beforeMixed = db.listInbox(ddMixed.workId)
  assert.equal(beforeMixed[0].dshIdempotencyKey, null, 'recordDirectDeliveryAttempt without throughSeq must NOT stamp earlier seq=1')
  assert.equal(beforeMixed[1].dshIdempotencyKey, 'k-follow')
  const recMixed = db.reconcileDeliveryStatus({
    workId: ddMixed.workId,
    deliveryStatus: { status: 'completed', consumed: true, idempotencyKey: 'k-follow', assistantText: 'follow-up done' },
    autoSettle: true,
  })
  assert.equal(recMixed.action, 'requeue', 'unread seq=1 result must prevent settling done')
  const afterMixed = db.listInbox(ddMixed.workId)
  assert.equal(afterMixed[0].readAt, null, 'seq=1 result must remain unread')
  assert.ok(afterMixed[1].readAt !== null, 'seq=2 revise must be marked read')
  assert.equal(db.getWork(ddMixed.workId).lastConsumedSeq, 0, 'contiguous watermark must stay at 0 while seq=1 is unread')
  const nextClaim = db.claimReady({ workId: ddMixed.workId })
  assert.deepEqual(nextClaim.unreadMessages.map(m => m.seq), [1], 'next claim delivers ONLY unread seq=1 result')

  // Group `room_work` batch direct delivery with explicit `throughSeq` binds unread child results up to throughSeq.
  const ddRoom = db.createWork({ botId: 'botB', kind: 'room_work', roomId: 'r1', originKind: 'group', sessionId: 'sess-r1-b' }).work
  const childRes = db.receiveMessage({
    workId: ddRoom.workId,
    kind: 'result',
    bodyPreview: 'child done',
    wake: false,
  })
  const roomAttempt = db.recordDirectDeliveryAttempt({
    workId: ddRoom.workId,
    idempotencyKey: 'room-call:r1:k1',
    sessionId: 'sess-r1-b',
    throughSeq: childRes.message.seq,
  })
  assert.equal(roomAttempt.lastDeliveredSeq, childRes.message.seq)
  const recRoom = db.reconcileDeliveryStatus({
    workId: ddRoom.workId,
    deliveryStatus: { status: 'completed', consumed: true, idempotencyKey: 'room-call:r1:k1', assistantText: 'synthesized' },
    autoSettle: true,
  })
  assert.equal(recRoom.action, 'settled')
  assert.equal(db.listInbox(ddRoom.workId, { unreadOnly: true }).length, 0)
})
