// `memory-view` on the computer returns `summary` as `{ text, at } | null`
// (ds-bot/src/host/memory.js), never a bare string unless an older fixture sends one.
// Passing the object straight into React Native `<Text>` throws at render time.
export function memorySummaryText(summary: unknown): string | null {
  if (typeof summary === 'string') return summary.trim() === '' ? null : summary
  if (summary !== null && typeof summary === 'object') {
    const text = (summary as { text?: unknown }).text
    if (typeof text === 'string' && text.trim() !== '') return text
  }
  return null
}
