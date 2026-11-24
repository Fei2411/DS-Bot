// Group change rows and reviews use the documented workspaceChanges service.
const EVENT = 'workspace/changes'
const MAX_FILES = 8
const PAGE_EVENTS = 80
const MAX_TURNS_PER_SESSION = 8
const MAX_TRACKED_SESSIONS = 256

export function install(rt) {
  const { ctx } = rt
  // Per-session LRU ring buffer tracking live observed turns (`seen`), latest turn number,
  // and announced `workspace/changes` seqs keyed by turn. Tracking `seen` prevents live
  // unchanged turns from triggering an unnecessary `sessionController.page()` I/O call while
  // still allowing cold/forgotten/evicted turns to fall back to the session log.
  const sessions = new Map()

  const touch = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (entry !== undefined) {
      sessions.delete(sessionId)
    } else {
      entry = { latestTurn: undefined, changes: new Map(), seen: new Set() }
    }
    sessions.set(sessionId, entry)
    if (sessions.size > MAX_TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value)
    return entry
  }

  const recordTurnChange = (sessionId, turn, seq) => {
    const entry = touch(sessionId)
    if (entry.changes.has(turn)) entry.changes.delete(turn)
    entry.changes.set(turn, seq)
    while (entry.changes.size > MAX_TURNS_PER_SESSION) entry.changes.delete(entry.changes.keys().next().value)
  }

  const recordSeenTurn = (sessionId, turn) => {
    const entry = touch(sessionId)
    if (entry.seen.has(turn)) entry.seen.delete(turn)
    entry.seen.add(turn)
    while (entry.seen.size > MAX_TURNS_PER_SESSION) entry.seen.delete(entry.seen.values().next().value)
  }

  // The turn each Session announced, from the live event. Cheap, and it covers a turn
  // whose page has not been read since.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start' || event?.type === 'turn/end') {
      const turn = event.data?.turn
      if (Number.isInteger(turn)) {
        const entry = touch(session.id)
        entry.latestTurn = turn
        if (event.type === 'turn/end') recordSeenTurn(session.id, turn)
      }
    }
    if (event?.type !== EVENT || !Number.isInteger(event.seq)) return
    const turn = event.data?.turn
    if (!Number.isInteger(turn)) return
    recordTurnChange(session.id, turn, event.seq)
  })

  const service = () => rt.ctx.get?.('workspaceChanges')

  // The announced turn, from the per-turn ring buffer or, on a genuine cache miss (cold
  // session after reload, evicted turn, or forgotten session), from the tail of its log.
  async function announcedTurn(sessionId, targetTurn) {
    const entry = sessions.get(sessionId)
    if (Number.isInteger(targetTurn)) {
      const seq = entry?.changes.get(targetTurn)
      if (seq !== undefined) return { seq, turn: targetTurn }
      if (entry?.seen.has(targetTurn)) return undefined
      try {
        const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, maxMessages: PAGE_EVENTS }, AbortSignal.timeout(4000))
        const events = page.records.map(record => record.event)
        const event = events.findLast(item => item.type === EVENT && Number.isInteger(item.seq) && item.data?.turn === targetTurn)
        if (event !== undefined) {
          recordTurnChange(sessionId, targetTurn, event.seq)
          return { seq: event.seq, turn: targetTurn }
        }
        if (events.some(item => item.type === 'turn/end' && item.data?.turn === targetTurn)) {
          recordSeenTurn(sessionId, targetTurn)
        }
        return undefined
      } catch {
        return undefined
      }
    }
    if (entry?.latestTurn !== undefined) {
      const seq = entry.changes.get(entry.latestTurn)
      return seq === undefined ? undefined : { seq, turn: entry.latestTurn }
    }
    if (entry !== undefined && entry.changes.size > 0) {
      let lastTurn
      let lastSeq
      for (const [turn, seq] of entry.changes) {
        lastTurn = turn
        lastSeq = seq
      }
      return { seq: lastSeq, turn: lastTurn }
    }
    try {
      const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, maxMessages: PAGE_EVENTS }, AbortSignal.timeout(4000))
      const events = page.records.map(record => record.event)
      const event = events.findLast(item => item.type === EVENT && Number.isInteger(item.seq))
      const turn = event?.data?.turn
      const lastTurn = events.findLast(item => item.type === 'turn/start' || item.type === 'turn/end')?.data?.turn
      if (lastTurn !== undefined && lastTurn !== turn) return undefined
      return event === undefined || !Number.isInteger(turn) ? undefined : { seq: event.seq, turn }
    } catch {
      return undefined
    }
  }

  // A row's change line: the coordinates the review tab needs plus what the group shows.
  // Undefined when the turn changed nothing, when the service is absent, or when the
  // summary is already gone.
  async function turnChanges(sessionId, targetTurn) {
    const changes = service()
    if (changes === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined
    const announced = await announcedTurn(sessionId, targetTurn)
    if (announced === undefined) return undefined
    let summary
    try {
      summary = changes.summary(sessionId, announced.seq)
    } catch {
      return undefined
    }
    if (summary === undefined || summary.turn !== announced.turn || !Array.isArray(summary.files) || summary.files.length === 0) return undefined
    return {
      sessionId,
      seq: announced.seq,
      turn: summary.turn,
      total: summary.total,
      added: summary.added,
      deleted: summary.deleted,
      files: summary.files.slice(0, MAX_FILES).map(file => ({
        path: file.display ?? file.path,
        added: file.added,
        deleted: file.deleted,
        ...(file.binary === true ? { binary: true } : {}),
        ...(file.oversized === true ? { oversized: true } : {}),
      })),
    }
  }

  // Whether the review can still be opened: the Host still serves this turn's summary.
  // A Session disposed by a part switch or a restart takes its summary with it.
  function changesAvailable(sessionId, seq) {
    const changes = service()
    if (changes === undefined || typeof sessionId !== 'string' || !Number.isInteger(seq)) return false
    try {
      return changes.summary(sessionId, seq) !== undefined
    } catch {
      return false
    }
  }

  const forgetSessionChanges = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    sessions.delete(sessionId)
  }

  rt.turnChanges = turnChanges
  rt.changesAvailable = changesAvailable
  rt.forgetSessionChanges = forgetSessionChanges
}
