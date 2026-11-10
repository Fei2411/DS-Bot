// Searching a group's own book. The ledger keeps every line of a group whole, so a
// search reads that book instead of a second store. A hit carries its neighbours so
// the message can be read in context.
const SEARCH_MAX = 20
const TERMS_MAX = 8
const QUERY_MAX = 200
const TEXT_MAX = 4_000

const clip = text => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text)

// One result line: what the chat shows of a record. Records without text (a pause, a
// failed turn) are skipped: there is nothing to find in them.
function lineOf(record) {
  if (typeof record?.text !== 'string' || record.text.trim() === '') return undefined
  const line = { seq: record.seq, time: record.time, text: clip(record.text) }
  if (record.botId !== undefined) line.botId = record.botId
  if (record.who !== undefined) line.name = record.who
  return line
}

// Newest first, every word must be in the line, at most SEARCH_MAX hits. Records are
// oldest first, as the ledger keeps them.
export function searchGroupBook(records, query) {
  const terms = [...new Set(String(query ?? '').toLowerCase().slice(0, QUERY_MAX).split(/\s+/).filter(Boolean))].slice(0, TERMS_MAX)
  if (terms.length === 0) return { results: [], capped: false }
  const results = []
  for (let at = records.length - 1; at >= 0 && results.length < SEARCH_MAX; at -= 1) {
    const record = records[at]
    const text = typeof record?.text === 'string' ? record.text.toLowerCase() : ''
    if (text === '' || !terms.every(term => text.includes(term))) continue
    const hit = lineOf(record)
    if (hit === undefined) continue
    results.push({
      ...hit,
      before: at > 0 ? lineOf(records[at - 1]) : undefined,
      after: at + 1 < records.length ? lineOf(records[at + 1]) : undefined,
    })
  }
  return { results, capped: results.length === SEARCH_MAX }
}
