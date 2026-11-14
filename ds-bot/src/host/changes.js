// The files a Bot changed in a turn, for the group chat to show and open.
//
// DSH's workspace-changes service keeps one summary per top-level turn and announces it
// with a `workspace/changes` Session event carrying only the turn number. A group row
// therefore carries the coordinates of that event (Session, seq, turn) and the counts the
// summary had when the turn ended; the review itself stays DSH's own changes-review tab,
// which reads the summary and each file's comparison from its routes while the Session
// lives. Nothing here reads another folder's files: the only Session read is the one whose
// turn is being posted into the group.
//
// Without the service (a composition that does not mount it) there are no rows, and the
// chat draws no change line rather than an empty one.
const EVENT = 'workspace/changes'
const MAX_FILES = 8
const PAGE_EVENTS = 80

export function install(rt) {
  const { ctx } = rt
  const latest = new Map()
  const turns = new Map()

  // The turn each Session announced last, from the live event. Cheap, and it covers a turn
  // whose page has not been read since.
  ctx.on('session/event', (session, event) => {
    // A turn that announced no changes must not inherit the previous turn's summary, so
    // the turn boundary is tracked beside the announcement.
    if (event?.type === 'turn/start' || event?.type === 'turn/end') {
      if (Number.isInteger(event.data?.turn)) turns.set(session.id, event.data.turn)
    }
    if (event?.type !== EVENT || !Number.isInteger(event.seq)) return
    const turn = event.data?.turn
    if (!Number.isInteger(turn)) return
    latest.set(session.id, { seq: event.seq, turn })
  })

  const service = () => rt.ctx.get?.('workspaceChanges')

  // The announced turn, from the live event or, for a Session whose event came before this
  // process listened, from the tail of its log.
  async function announcedTurn(sessionId) {
    const known = latest.get(sessionId)
    if (turns.has(sessionId)) return known?.turn === turns.get(sessionId) ? known : undefined
    if (known !== undefined) return known
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
  async function turnChanges(sessionId) {
    const changes = service()
    if (changes === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined
    const announced = await announcedTurn(sessionId)
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

  rt.turnChanges = turnChanges
  rt.changesAvailable = changesAvailable
  rt.changesMounted = () => service() !== undefined
}
