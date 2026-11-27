// Request identities: a request a Bot names itself is sent once, however often it repeats it.
//
// Backed by SQLite (`rt.coordDb` inbox `dedup_key`) on a per-caller terminal anchor work
// (`reqlog:<caller>`, `status='done'`, `originKind='request_dedup'`). Same key + same content
// replays the saved receipt; same key + different content is refused (`conflict`); an
// interrupted admission from an earlier host run returns `uncertain` so side effects are
// never repeated blindly. Falls back to `state.requests` only when `rt.coordDb` is absent.
import { createHash, randomUUID } from 'node:crypto'

// A request name this long is a mistake, not an identity.
export const NAME_MAX = 200

const reqWorkId = caller => `reqlog:${caller}`
const encodeKey = key => createHash('sha256').update(key).digest('hex').slice(0, 32)
const admitDedupKey = (key, epoch) => `req:${encodeKey(key)}:admit:${epoch}`
const settleDedupKey = (key, epoch) => `req:${encodeKey(key)}:settle:${epoch}`

export function install(rt) {
  const { state } = rt
  // This run's name: a receipt left pending by another run has an unknown outcome.
  const run = randomUUID()
  // Requests being admitted now, so that two at once admit one.
  const inflight = new Map()
  // Per-caller hydrated cache from SQLite `reqlog:<caller>` inbox rows.
  // Map<caller, { loaded: boolean, lastSeq: number, records: Map<string, { fingerprint, outcome, receipt?, run?, at, epoch }> }>
  const callerCache = new Map()

  const hasCoordDb = () => rt.coordDb != null && !rt.coordDb.isClosed?.()
  const existingCoordDb = () => (typeof rt.existingCoordDb === 'function' ? rt.existingCoordDb() : (hasCoordDb() ? rt.coordDb : null))
  const writableCoordDb = () => hasCoordDb() && rt.coordDb.readonly !== true
  const legacyReceipts = () => (state.requests ??= {})

  const print = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  // The name of a request in the caller's own space: its Bot, the conversation the request
  // was made from, and the name the caller gave it. The Bot, not its Session: a Bot that
  // moves to a fresh part of its conversation keeps its name.
  const identity = ({ caller, context, name, payload }) => ({
    caller,
    context,
    name,
    key: `${caller}\u0000${context}\u0000${name}`,
    dedupKey: `req:${caller}:${context}:${name}`,
    print: print(payload),
  })

  const syncCallerFromDb = (caller) => {
    const db = existingCoordDb()
    if (!db || typeof caller !== 'string' || caller === '') return undefined
    let bucket = callerCache.get(caller)
    if (bucket === undefined) {
      bucket = { loaded: false, lastSeq: 0, records: new Map() }
      callerCache.set(caller, bucket)
    }
    const workId = reqWorkId(caller)
    if (db.getWork(workId) === undefined) {
      bucket.loaded = true
      return bucket
    }
    // Pull any new rows since lastSeq (supports read-only windows seeing new commits).
    let afterSeq = bucket.lastSeq
    while (true) {
      const rows = db.listInbox(workId, { afterSeq, limit: 500 })
      if (rows.length === 0) break
      for (const row of rows) {
        if (row.seq > afterSeq) afterSeq = row.seq
        const data = row.payload
        if (!data || typeof data !== 'object' || typeof data.key !== 'string') continue
        const epoch = Number.isInteger(data.epoch) ? data.epoch : 1
        const prev = bucket.records.get(data.key)
        if (data.op === 'admit') {
          if (prev === undefined || epoch >= prev.epoch) {
            bucket.records.set(data.key, {
              fingerprint: data.fingerprint,
              outcome: 'pending',
              run: data.run,
              at: data.at ?? row.createdAt,
              epoch,
            })
          }
        } else if (data.op === 'settle') {
          if (prev !== undefined && epoch < prev.epoch) continue
          if (data.outcome === 'unsent') {
            bucket.records.set(data.key, {
              fingerprint: undefined,
              outcome: 'unsent',
              at: data.at ?? row.createdAt,
              epoch,
            })
          } else {
            bucket.records.set(data.key, {
              fingerprint: prev?.fingerprint ?? data.fingerprint,
              outcome: data.outcome,
              ...(data.receipt !== undefined ? { receipt: data.receipt } : {}),
              run: prev?.run ?? data.run,
              at: data.at ?? row.createdAt,
              epoch,
            })
          }
        }
      }
      if (rows.length < 500) break
    }
    bucket.lastSeq = afterSeq
    bucket.loaded = true
    return bucket
  }

  const readRecord = (request) => {
    if (hasCoordDb()) {
      const bucket = syncCallerFromDb(request.caller)
      const hit = bucket?.records.get(request.key)
      if (hit !== undefined && hit.outcome !== 'unsent') return hit
    }
    if (state.requests == null) return undefined
    return rt.own(state.requests, request.key)
  }

  const nextEpochFor = (request) => {
    if (!hasCoordDb()) return 1
    const bucket = syncCallerFromDb(request.caller)
    const hit = bucket?.records.get(request.key)
    return hit === undefined ? 1 : hit.epoch + 1
  }

  const ensureReqWork = (caller) => {
    const workId = reqWorkId(caller)
    if (rt.coordDb.getWork(workId) !== undefined) return workId
    rt.coordDb.createWork({
      workId,
      botId: caller,
      kind: 'task',
      logicalAddress: workId,
      status: 'done',
      priority: 'background',
      originKind: 'request_dedup',
      visibility: 'private',
      privacyScoped: false,
      meta: { internal: true, purpose: 'request_idempotency' },
    })
    return workId
  }

  const writeDbEvent = (caller, dedupKey, payload) => {
    const workId = ensureReqWork(caller)
    return rt.coordDb.receiveMessage({
      workId,
      kind: 'note',
      dedupKey,
      senderAddress: `foreground:${caller}`,
      senderBotId: caller,
      payload,
      wake: false,
    })
  }

  // What a request that was admitted before means for the caller now: its receipt, a
  // conflict, or an outcome that is not known. Undefined when it was never admitted.
  const verdict = (request, record) => {
    if (record.fingerprint !== request.print) return { status: 'conflict' }
    if (record.outcome === 'delivered') {
      // The receipt is gone, but the name stays taken: it is not used again by accident.
      return record.receipt === undefined ? { status: 'expired' } : { status: 'replay', receipt: record.receipt }
    }
    if (record.outcome === 'uncertain') return { status: 'uncertain' }
    // Admitted, not settled: the call is still going, or it was cut short.
    return undefined
  }

  // What is known about a request that was admitted before. Undefined when the request
  // was never admitted.
  const known = async (request) => {
    const record = readRecord(request)
    if (record === undefined) return undefined
    const seen = verdict(request, record)
    if (seen !== undefined) return seen
    // Admitted, not settled: the call is still going in this run, or another run left it
    // in the air, and then its outcome is not known.
    if (record.run !== run) return { status: 'uncertain' }
    const promise = inflight.get(request.key)
    if (promise === undefined) return { status: 'uncertain' }
    await promise.catch(() => {})
    const settled = readRecord(request)
    if (settled === undefined) return undefined
    return verdict(request, settled) ?? { status: 'uncertain' }
  }

  // Admits the request once and runs it. The admission record is durably written before
  // `work` executes, so a crash never turns a lost reply into a duplicate side effect.
  const admit = async (request, work) => {
    const activeInflight = inflight.get(request.key)
    if (activeInflight !== undefined) {
      await activeInflight.catch(() => {})
      const after = readRecord(request)
      if (after === undefined) return admit(request, work)
      return known(request)
    }
    const record = readRecord(request)
    if (record !== undefined) {
      const seen = verdict(request, record)
      if (seen !== undefined) return seen
      if (record.run !== run) return { status: 'uncertain' }
      const promise = inflight.get(request.key)
      if (promise === undefined) return { status: 'uncertain' }
      await promise.catch(() => {})
      const after = readRecord(request)
      if (after === undefined) return admit(request, work)
      return known(request)
    }
    if (rt.readOnly?.() !== undefined || (hasCoordDb() && rt.coordDb.readonly === true)) {
      return { status: 'readonly' }
    }

    if (writableCoordDb()) {
      const promise = (async () => {
        // Fail-closed ownership & persistence check: if the host is stopping, state.lock was
        // stolen by another writer, or storage cannot be written, refuse BEFORE admitting.
        if (typeof rt.save === 'function') {
          await rt.save({ required: true })
        }
        if (!writableCoordDb()) {
          throw new Error('The Bot team cannot be saved while stopping.')
        }
        const rechecked = readRecord(request)
        if (rechecked !== undefined) return { __recheck: true }
        const epoch = nextEpochFor(request)
        const now = Date.now()
        const admitRes = writeDbEvent(request.caller, admitDedupKey(request.key, epoch), {
          op: 'admit',
          key: request.key,
          fingerprint: request.print,
          run,
          at: now,
          epoch,
        })
        syncCallerFromDb(request.caller)
        if (admitRes.deduplicated) return { __recheck: true }

        try {
          const receipt = await work()
          if (request.unsent === true) {
            try {
              writeDbEvent(request.caller, settleDedupKey(request.key, epoch), {
                op: 'settle',
                key: request.key,
                outcome: 'unsent',
                at: Date.now(),
                epoch,
              })
            } catch (error) {
              rt.warn?.('ds-bot: the removal of the request receipt was not saved: %s', error)
              try {
                writeDbEvent(request.caller, settleDedupKey(request.key, epoch), {
                  op: 'settle',
                  key: request.key,
                  fingerprint: request.print,
                  outcome: 'uncertain',
                  at: Date.now(),
                  epoch,
                })
              } catch {}
            }
            syncCallerFromDb(request.caller)
            return receipt
          }
          try {
            writeDbEvent(request.caller, settleDedupKey(request.key, epoch), {
              op: 'settle',
              key: request.key,
              fingerprint: request.print,
              outcome: 'delivered',
              receipt,
              at: Date.now(),
              epoch,
            })
            syncCallerFromDb(request.caller)
          } catch (error) {
            rt.warn?.('ds-bot: saving delivered request receipt failed: %s', error)
          }
          return receipt
        } catch (error) {
          try {
            writeDbEvent(request.caller, settleDedupKey(request.key, epoch), {
              op: 'settle',
              key: request.key,
              fingerprint: request.print,
              outcome: 'uncertain',
              at: Date.now(),
              epoch,
            })
            syncCallerFromDb(request.caller)
          } catch {}
          throw error
        }
      })()
      inflight.set(request.key, promise)
      try {
        const result = await promise
        if (result && typeof result === 'object' && result.__recheck === true) {
          return known(request)
        }
        return { status: 'sent', receipt: result }
      } finally {
        inflight.delete(request.key)
      }
    }

    // Fallback path when `rt.coordDb` is unavailable (narrow unit tests).
    const fresh = { fingerprint: request.print, outcome: 'pending', at: Date.now(), run }
    legacyReceipts()[request.key] = fresh
    const promise = (async () => {
      try {
        await rt.save({ required: true })
      } catch (error) {
        delete legacyReceipts()[request.key]
        rt.warn?.('ds-bot: the receipt of the request was not saved: %s', error)
        throw error
      }
      try {
        const receipt = await work()
        if (request.unsent === true) {
          delete legacyReceipts()[request.key]
          try {
            await rt.save({ required: true })
          } catch (error) {
            fresh.outcome = 'uncertain'
            fresh.at = Date.now()
            legacyReceipts()[request.key] = fresh
            rt.warn?.('ds-bot: the removal of the request receipt was not saved: %s', error)
          }
          return receipt
        }
        fresh.outcome = 'delivered'
        fresh.receipt = receipt
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        return receipt
      } catch (error) {
        fresh.outcome = 'uncertain'
        fresh.at = Date.now()
        await rt.save().catch(() => {})
        throw error
      }
    })()
    inflight.set(request.key, promise)
    try {
      return { status: 'sent', receipt: await promise }
    } finally {
      inflight.delete(request.key)
    }
  }

  // Reclaim request identities owned by a deleted Bot (a deleted Bot can never retry).
  const forgetBotRequests = (botId) => {
    if (typeof botId !== 'string' || botId === '') return 0
    callerCache.delete(botId)
    if (state.requests == null) return 0
    const prefix = `${botId}\u0000`
    let removed = 0
    for (const key of Object.keys(state.requests)) {
      if (key.startsWith(prefix)) {
        delete state.requests[key]
        removed += 1
      }
    }
    return removed
  }

  // Prune orphaned legacy request entries whose calling Bot no longer exists in state.bots.
  const pruneOrphanRequests = () => {
    if (rt.readOnly?.() !== undefined || state.bots == null) return 0
    for (const caller of callerCache.keys()) {
      if (rt.own(state.bots, caller) === undefined) callerCache.delete(caller)
    }
    if (state.requests == null) return 0
    let removed = 0
    for (const key of Object.keys(state.requests)) {
      const sep = key.indexOf('\u0000')
      if (sep <= 0) continue
      const caller = key.slice(0, sep)
      if (rt.own(state.bots, caller) === undefined) {
        delete state.requests[key]
        removed += 1
      }
    }
    if (removed > 0) void rt.save?.().catch(() => {})
    return removed
  }

  const offAdopted = rt.onAdopted?.(() => { callerCache.clear() })
  rt.ctx?.effect?.(() => () => {
    offAdopted?.()
    callerCache.clear()
  }, 'ds-bot: requests dedup cache')

  Object.assign(rt, { requestIdentity: identity, knownRequest: known, admitRequest: admit, forgetBotRequests, pruneOrphanRequests })
}
