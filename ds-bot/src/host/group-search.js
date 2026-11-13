// Searching a group's own book. The ledger keeps every line of a group whole, so a
// search reads that book instead of a second store. A hit carries its neighbours so
// the message can be read in context. Text stays whole: the list snippets it, and
// opening a hit shows the line.
const SEARCH_MAX = 20
const TERMS_MAX = 8
const QUERY_MAX = 200

// One result line: what the chat shows of a record. Records without text (a pause, a
// failed turn) are skipped: there is nothing to find in them.
function lineOf(record) {
  if (typeof record?.text !== 'string' || record.text.trim() === '') return undefined
  const line = { seq: record.seq, time: record.time, text: record.text }
  if (record.botId !== undefined) line.botId = record.botId
  if (record.who !== undefined) line.name = record.who
  return line
}

// Newest first, every word must be in the line, at most SEARCH_MAX hits. Records are
// oldest first, as the ledger keeps them. `before` (oldest seq already shown) and
// `offset` continue into older hits. hasMore is true only when a further match
// exists: filling the page does not by itself mean the book was cut.
export function searchGroupBook(records, query, options) {
  const terms = [...new Set(String(query ?? '').toLowerCase().slice(0, QUERY_MAX).split(/\s+/).filter(Boolean))].slice(0, TERMS_MAX)
  if (terms.length === 0) return { results: [], hasMore: false }
  const page = options ?? {}
  const offset = Number.isInteger(page.offset) && page.offset > 0 ? page.offset : 0
  const before = Number.isInteger(page.before) ? page.before : undefined
  const results = []
  let skipped = 0
  let hasMore = false
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = records[at]
    if (before !== undefined && !(Number.isInteger(record?.seq) && record.seq < before)) continue
    const text = typeof record?.text === 'string' ? record.text.toLowerCase() : ''
    if (text === '' || !terms.every(term => text.includes(term))) continue
    const hit = lineOf(record)
    if (hit === undefined) continue
    if (skipped < offset) {
      skipped += 1
      continue
    }
    if (results.length === SEARCH_MAX) {
      hasMore = true
      break
    }
    results.push({
      ...hit,
      before: at > 0 ? lineOf(records[at - 1]) : undefined,
      after: at + 1 < records.length ? lineOf(records[at + 1]) : undefined,
    })
  }
  return { results, hasMore }
}
