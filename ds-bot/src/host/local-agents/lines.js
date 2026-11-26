// Splits a text stream into trimmed, non-empty lines. A tool result can put
// megabytes on one line, arriving in 64 KB chunks: only each new chunk is
// scanned and the pieces are joined once, so the cost stays linear.
export const MAX_LINE_CHARS = 64 * 1024 * 1024

export function lineSplitter(onLine, { maxLineChars = MAX_LINE_CHARS } = {}) {
  let pieces = []
  let pendingChars = 0
  let dropping = false
  return (chunk) => {
    let start = 0
    let at
    while ((at = chunk.indexOf('\n', start)) !== -1) {
      const slice = chunk.slice(start, at)
      start = at + 1
      if (dropping) {
        dropping = false
        pieces = []
        pendingChars = 0
        continue
      }
      if (pendingChars + slice.length > maxLineChars) {
        pieces = []
        pendingChars = 0
        continue
      }
      pieces.push(slice)
      const line = pieces.join('').trim()
      pieces = []
      pendingChars = 0
      if (line !== '') onLine(line)
    }
    if (start < chunk.length) {
      if (dropping) return
      const tail = chunk.slice(start)
      if (pendingChars + tail.length > maxLineChars) {
        dropping = true
        pieces = []
        pendingChars = 0
        return
      }
      pieces.push(tail)
      pendingChars += tail.length
    }
  }
}
