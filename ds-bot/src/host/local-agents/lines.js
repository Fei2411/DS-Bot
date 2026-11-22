// Splits a text stream into trimmed, non-empty lines. A tool result can put
// megabytes on one line, arriving in 64 KB chunks: only each new chunk is
// scanned and the pieces are joined once, so the cost stays linear.
export function lineSplitter(onLine) {
  let pieces = []
  return (chunk) => {
    let start = 0
    let at
    while ((at = chunk.indexOf('\n', start)) !== -1) {
      pieces.push(chunk.slice(start, at))
      const line = pieces.join('').trim()
      pieces = []
      start = at + 1
      if (line !== '') onLine(line)
    }
    if (start < chunk.length) pieces.push(chunk.slice(start))
  }
}
