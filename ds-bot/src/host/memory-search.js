// Ranking saved entries against a question. Entries are few, so this runs in memory over
// the scopes the caller may read: visibility is settled before anything is scored. FTS5's
// trigrams, which the chat index uses, cannot match a Chinese word of two characters.
import { wordsOf } from './memory-entries.js'

const K1 = 1.2
const B = 0.75

export function rankEntries(entries, query) {
  const asked = wordsOf(query)
  if (asked.size === 0) return []
  const docs = entries.map(entry => ({ entry, words: wordsOf(`${entry.text} ${entry.file?.topic ?? ''}`) }))
  const average = docs.reduce((sum, doc) => sum + doc.words.size, 0) / Math.max(docs.length, 1)
  const seenIn = new Map()
  for (const doc of docs) for (const word of doc.words) if (asked.has(word)) seenIn.set(word, (seenIn.get(word) ?? 0) + 1)
  const idf = word => Math.log(1 + (docs.length - seenIn.get(word) + 0.5) / (seenIn.get(word) + 0.5))
  return docs.flatMap((doc) => {
    const hits = [...doc.words].filter(word => asked.has(word))
    if (hits.length === 0) return []
    const norm = K1 * (1 - B + B * doc.words.size / Math.max(average, 1))
    const score = hits.reduce((sum, word) => sum + idf(word) * (K1 + 1) / (1 + norm), 0)
    return [{ entry: doc.entry, score, hits: hits.length, covers: hits.length / doc.words.size }]
  }).sort((a, b) => b.score - a.score)
}

// What the turn's first step brings along: only what shares enough with what was said.
const AUTO_MIN_HITS = 2
const AUTO_MIN_COVER = 0.3
export const pickRecalled = (ranked, max) => ranked.filter(hit => hit.hits >= AUTO_MIN_HITS && hit.covers >= AUTO_MIN_COVER).slice(0, max)
