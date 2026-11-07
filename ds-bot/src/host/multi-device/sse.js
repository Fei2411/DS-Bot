// The wire format the hub and a worker share: newline-delimited server-sent events.
// A task can carry any JSON, so every event is one `data:` line.

export function writeEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function writePing(response) {
  response.write(': ping\n\n')
}

// Splits the events already complete in `buffer`; the returned `rest` is what is left of
// a partly received event and is handed back on the next chunk.
export function parseEvents(buffer) {
  const events = []
  let rest = buffer.replace(/\r\n/g, '\n')
  for (;;) {
    const at = rest.indexOf('\n\n')
    if (at === -1) break
    const block = rest.slice(0, at)
    rest = rest.slice(at + 2)
    let event = 'message'
    const data = []
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length === 0) continue
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) })
    } catch {
      // A frame this version cannot read is dropped rather than ending the stream.
    }
  }
  return { events, rest }
}
