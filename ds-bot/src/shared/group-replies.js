// Reading a settled group_relay result back into the group's conversation rows,
// shared by the live chat (client/cells.js) and the earlier-parts page
// (host/parts.js). A result names where its rows are in the group's book of the
// ledger (relayRange); one from before the ledger holds the round's `replies`
// itself, in the order the live view draws them.

// A logged tool/result can open with a session handle ("§38§ ") before the JSON
// payload `group_relay` wrote.
const HANDLE_PREFIX = /^\s*§\d+§\s*/
export const stripRelayPrefix = text => (typeof text === 'string' ? text.replace(HANDLE_PREFIX, '') : text)

// The seq range of a round's rows, or undefined for a result from before the ledger.
export function relayRange(text) {
  try {
    const value = JSON.parse(stripRelayPrefix(text))
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
const SAVE_TOKEN_NOTICE = /\n\n\[save-token #[\da-z]+ (?:compressed|losslessly re-encoded): [\d,]+ -> [\d,]+ bytes[\s\S]*\]$/
export const compressedRelayPreview = text => {
  const body = stripRelayPrefix(text)
  if (typeof body !== 'string') return undefined
  const notice = SAVE_TOKEN_NOTICE.exec(body)
  return notice === null ? undefined : body.slice(0, notice.index)
}
export const REPLY_ELISION = / \.\.\.\[\+(\d+) chars\]\.\.\. /

export function parseReplies(text) {
  const body = stripRelayPrefix(text)
  const preview = compressedRelayPreview(body)
  if (preview !== undefined) {
    // The elision can splice two different Bots' text into a single valid JSON string.
    const replies = parseReplies(preview).replies.filter(reply => reply && typeof reply === 'object'
      && !reply.__omitted__ && (typeof reply.text !== 'string' || !REPLY_ELISION.test(reply.text)))
    return { replies, broken: true }
  }
  try {
    const replies = JSON.parse(body)?.replies
    return { replies: Array.isArray(replies) ? replies : [], broken: false }
  } catch { /* fall through */ }
  const replies = []
  const head = RELAY_LIST.exec(body)
  if (head) {
    for (const piece of body.slice(head.index + head[0].length).split(PRUNE_MARKER)) {
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
// works comes one message at a time. A block carries the last message's time and run,
// and the files its messages presented; a message of files only adds no bubble.
export function stackReplies(replies) {
  const items = []
  replies.forEach((reply, index) => {
    const last = items.at(-1)
    // A Bot can start several turns in a row (a wake-up, another call in the round, a
    // late turn), and every start writes its own "started on it" row. In the transcript
    // they are one event, not a wall of identical lines, so consecutive starts by the
    // same Bot fold into the first row. Any other row between them (a message, an
    // approval, done, the user) breaks the run.
    if (reply.kind === 'working' && last?.reply.kind === 'working'
      && reply.botId !== undefined && reply.botId === last.reply.botId) return
    const texts = reply.kind === undefined && typeof reply.text === 'string' && reply.text !== '' ? [reply.text] : []
    const files = reply.kind === undefined ? presentedFiles(reply.presented) : []
    if (reply.kind === undefined && last?.reply.kind === undefined && last?.reply.botId === reply.botId
      && last.claims === undefined && (last.changes === undefined
        || (reply.changes?.sessionId === last.changes.sessionId && reply.changes?.turn === last.changes.turn))) {
      last.texts.push(...texts)
      // A path presented again keeps one card, with its last description and locator.
      if (files.length > 0) {
        last.files = [...last.files.filter(file => !files.some(again => again.path === file.path)), ...files]
      }
      last.time = reply.time
      last.duration = reply.duration
      if (reply.claims !== undefined) last.claims = reply.claims
      // The change line belongs to the turn, so a later message of the same turn replaces
      // it rather than stacking a second one.
      if (reply.changes !== undefined) last.changes = reply.changes
    } else {
      items.push({
        reply, index,
        texts,
        files,
        time: reply.time, duration: reply.duration,
        ...(reply.claims === undefined ? {} : { claims: reply.claims }),
        ...(reply.changes === undefined ? {} : { changes: reply.changes }),
      })
    }
  })
  return items
}

// The basename of a presented path on POSIX or Windows.
export const presentedFileName = path => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) || String(path ?? '') || 'file'

// The files of a reply or post, as far as they name a path.
export const presentedFiles = value => (Array.isArray(value) ? value : [])
  .filter(file => typeof file?.path === 'string' && file.path.trim() !== '')
  .map(file => ({
    path: file.path,
    ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
    ...(typeof file.sessionId === 'string' && file.sessionId !== '' ? { sessionId: file.sessionId } : {}),
    ...(Number.isInteger(file.seq) ? { seq: file.seq } : {}),
    ...(Number.isInteger(file.index) ? { index: file.index } : {}),
  }))
