// A round's result names where its rows are in the group's book of the ledger; a test
// reads them the way the group chat does.
export const withRows = (rt, sessionId, result) => (Number.isInteger(result?.from)
  ? { ...result, replies: rt.groupRows(rt.roomOf(sessionId)?.id ?? sessionId, result.from, result.to) }
  : result)
