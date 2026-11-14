// Reading a settled group_relay result back into the group's conversation rows,
// shared by the live chat (client/cells.js) and the earlier-parts page
// (host/parts.js). A result names where its rows are in the group's book of the
// ledger (relayRange); one from before the ledger holds the round's `replies`
// itself, in the order the live view draws them.

// The seq range of a round's rows, or undefined for a result from before the ledger.
export function relayRange(text) {
  try {
    const value = JSON.parse(text)
    if (Number.isInteger(value?.from)) return { from: value.from, ...(Number.isInteger(value.to) ? { to: value.to } : {}), ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}) }
  } catch { /* an older result, or one cut short */ }
  return undefined
}

// Compaction can prune the middle of a long tool result, which leaves invalid
// JSON: then every complete reply object that survived is recovered so the turn
// still draws what it can.
const RELAY_LIST = /"replies"\s*:\s*\[/
// Compaction marks a pruned span with a literal bracketed note like
// "[... tool result middle pruned ...]". Its "]" looks like the end of the
// replies array to a naive scan, so the text is split on the marker first.
const PRUNE_MARKER = /\[\.\.\. tool result middle pruned \.\.\.\]/
export function parseReplies(text) {
  try { return { replies: JSON.parse(text).replies ?? [], broken: false } } catch { /* fall through */ }
  const replies = []
  const head = RELAY_LIST.exec(text)
  if (head) {
    for (const piece of text.slice(head.index + head[0].length).split(PRUNE_MARKER)) {
      // The cut can start inside a string, leaving a fragment that keeps the
      // scanner inside quotes: restart at the first complete reply instead.
      const first = piece.indexOf('{"')
      if (first !== -1) scanReplies(piece, first, replies)
    }
  }
  return { replies, broken: true }
}

function scanReplies(text, start, replies) {
  let depth = 0
  let from = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) from = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && from >= 0) {
        try { replies.push(JSON.parse(text.slice(from, i + 1))) } catch { /* partial object */ }
        from = -1
      }
    } else if (ch === ']' && depth === 0) break
  }
}

// A member's messages in a row, as one block under its name: what it says while it
// works comes one message at a time. A block carries the last message's time and run.
export function stackReplies(replies) {
  const items = []
  replies.forEach((reply, index) => {
    const last = items.at(-1)
    if (reply.kind === undefined && last?.reply.kind === undefined && last?.reply.botId === reply.botId
      && last.claims === undefined) {
      last.texts.push(reply.text)
      last.time = reply.time
      last.duration = reply.duration
      if (reply.claims !== undefined) last.claims = reply.claims
      // The change line belongs to the turn, so a later message of the same turn replaces
      // it rather than stacking a second one.
      if (reply.changes !== undefined) last.changes = reply.changes
    } else {
      items.push({
        reply, index,
        texts: reply.kind === undefined ? [reply.text] : [],
        time: reply.time, duration: reply.duration,
        ...(reply.claims === undefined ? {} : { claims: reply.claims }),
        ...(reply.changes === undefined ? {} : { changes: reply.changes }),
      })
    }
  })
  return items
}
