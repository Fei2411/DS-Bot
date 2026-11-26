// Ranking saved entries against a question. Entries are few, so this runs in memory over
// the scopes the caller may read: visibility is settled before anything is scored. FTS5's
// trigrams, which the chat index uses, cannot match a Chinese word of two characters.
import { wordsOf } from './memory-entries.js'

const K1 = 1.2
const B = 0.75

export const entryWords = entry => wordsOf(`${entry.text} ${entry.file?.topic ?? ''}`)

// An entry may bring its words along, worked out once while its file is unchanged.
export function rankEntries(entries, query) {
  const asked = wordsOf(query)
  if (asked.size === 0) return []
  const docs = entries.map(entry => ({ entry, words: entry.words ?? entryWords(entry), hits: [] }))
  const average = docs.reduce((sum, doc) => sum + doc.words.size, 0) / Math.max(docs.length, 1)
  const seenIn = new Map()
  for (const doc of docs) for (const word of doc.words) if (asked.has(word)) {
    doc.hits.push(word)
    seenIn.set(word, (seenIn.get(word) ?? 0) + 1)
  }
  const idf = word => Math.log(1 + (docs.length - seenIn.get(word) + 0.5) / (seenIn.get(word) + 0.5))
  return docs.flatMap((doc) => {
    const hits = doc.hits
    if (hits.length === 0) return []
    const norm = K1 * (1 - B + B * doc.words.size / Math.max(average, 1))
    const score = hits.reduce((sum, word) => sum + idf(word) * (K1 + 1) / (1 + norm), 0)
    return [{ entry: doc.entry, score, hits: hits.length, covers: hits.length / doc.words.size }]
  }).sort((a, b) => b.score - a.score)
}

// What the turn's first step brings along: only what shares enough signal with what was said,
// without disqualifying informative multi-clause CJK or English entries via raw doc length.
const AUTO_MIN_HITS = 2
const AUTO_MIN_COVER = 0.3
const AUTO_MIN_QUERY_COVER = 0.35
const AUTO_MIN_MULTI_HITS = 3
const AUTO_MIN_MULTI_SCORE = 2.5
const AUTO_HIGH_SCORE = 4.0

// Corpus-size-aware BM25 score floor for query-coverage hits: filters out low-IDF generic
// term collisions on larger corpora while keeping rare-term matches on tiny 1-3 doc corpora.
const queryCoverFloor = matchedCount => (matchedCount >= 4 ? 2.2 : matchedCount === 3 ? 1.4 : matchedCount === 2 ? 0.8 : 0.4)

export function pickRecalled(ranked, max, query) {
  const askedSize = query === undefined ? 0 : wordsOf(query).size
  const minQueryScore = queryCoverFloor(ranked.length)
  return ranked.filter((hit) => {
    if (hit.hits < AUTO_MIN_HITS) return false
    if (hit.covers >= AUTO_MIN_COVER) return true
    if (askedSize > 0 && hit.hits / askedSize >= AUTO_MIN_QUERY_COVER && hit.score >= minQueryScore) return true
    if (hit.hits >= AUTO_MIN_MULTI_HITS && hit.score >= AUTO_MIN_MULTI_SCORE) return true
    return hit.score >= AUTO_HIGH_SCORE
  }).slice(0, max)
}
