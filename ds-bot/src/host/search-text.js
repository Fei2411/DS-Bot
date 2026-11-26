const books = new WeakMap()

export function searchTextFor(records) {
  const known = books.get(records)
  if (known !== undefined) {
    if (known.slots.length > records.length * 2) known.slots.length = records.length * 2
    return known.lower
  }
  const slots = []
  // Reserve holes for newest-first scans; text is populated only when searched.
  slots.length = records.length * 2
  const lower = (at, text) => {
    const source = at * 2
    if (typeof text !== 'string') {
      slots[source] = undefined
      slots[source + 1] = undefined
      return ''
    }
    if (slots[source] === text) return slots[source + 1]
    const value = text.toLowerCase()
    slots[source] = text
    slots[source + 1] = value
    return value
  }
  books.set(records, { slots, lower })
  return lower
}
