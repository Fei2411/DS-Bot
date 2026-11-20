const books = new WeakMap()

export function searchTextFor(records) {
  const known = books.get(records)
  if (known !== undefined) {
    if (known.texts.length > records.length) {
      known.texts.length = records.length
      known.lowered.length = records.length
    }
    return known.lower
  }
  const texts = Array.from({ length: records.length })
  const lowered = Array.from({ length: records.length })
  const lower = (at, text) => {
    if (typeof text !== 'string') {
      texts[at] = undefined
      lowered[at] = undefined
      return ''
    }
    if (texts[at] === text) return lowered[at]
    const value = text.toLowerCase()
    texts[at] = text
    lowered[at] = value
    return value
  }
  books.set(records, { texts, lowered, lower })
  return lower
}
