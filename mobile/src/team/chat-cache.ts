// In-memory LRU cache of the latest page per chat (`<computer>:<kind>:<id>`), so
// returning to a Bot or group shows its messages on the first frame while a fresh
// read brings anything new. Each write carries the key that loaded the page so an
// in-place route param switch can never overwrite the next chat's cache with the
// previous chat's items.
export interface CachedChatEntry<P, I> {
  page: P
  older: I[]
  cursor: unknown
}

export function roomHeadPart(cursor: unknown): number | undefined {
  if (cursor === null) return 0
  if (typeof cursor !== 'object' || cursor === null || !('part' in cursor)
    || typeof cursor.part !== 'number' || !Number.isInteger(cursor.part)) return undefined
  // A beforeSeq cursor continues inside the head part; a bare part starts the previous one.
  return 'beforeSeq' in cursor && typeof cursor.beforeSeq === 'number' && Number.isInteger(cursor.beforeSeq)
    ? cursor.part : cursor.part + 1
}

export function createChatHistory(cursor: unknown, part: number | undefined) {
  return { cursor, part, loading: false }
}

export function refreshChatHistory(history: ReturnType<typeof createChatHistory>, cursor: unknown, part: number | undefined) {
  if (history.part !== undefined && part !== undefined && history.part !== part) return createChatHistory(cursor, part)
  history.part = part
  if (history.cursor === undefined) history.cursor = cursor
  return history
}

export function createChatCache<P, I>(limit = 16) {
  const map = new Map<string, CachedChatEntry<P, I>>()
  return {
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    keep(chatKey: string, ownerKey: string, entry: CachedChatEntry<P, I>) {
      if (chatKey === '' || ownerKey !== chatKey) return false
      map.delete(chatKey)
      map.set(chatKey, entry)
      if (map.size > limit) map.delete(map.keys().next().value as string)
      return true
    },
    size: () => map.size,
    clear: () => map.clear(),
  }
}
