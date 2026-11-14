export interface SeenStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

const KEY = 'dsbot.seenAt'

const defaultStorage: SeenStorage = {
  async getItem(key) {
    const SecureStore = await import('expo-secure-store')
    return SecureStore.getItemAsync(key)
  },
  async setItem(key, value) {
    const SecureStore = await import('expo-secure-store')
    await SecureStore.setItemAsync(key, value)
  },
}

function serialize(hosts: Map<string, Map<string, number>>): string {
  const out: Record<string, Record<string, number>> = {}
  for (const [hostId, entries] of hosts) {
    if (entries.size > 0) out[hostId] = Object.fromEntries(entries)
  }
  return JSON.stringify(out)
}

// Last-read time per (hostDeviceId, bot or room id), persisted on the phone.
// A row is unread when its host lastAt is newer than this and its chat is not open.
export function createSeenStore(storage: SeenStorage = defaultStorage) {
  const seen = new Map<string, Map<string, number>>()
  const listeners = new Set<() => void>()
  let loaded = false
  let loadPromise: Promise<void> | null = null
  let dirty = false
  let pendingPersist = false
  let flushing: Promise<void> | null = null
  let ver = 0

  const bump = () => {
    ver += 1
    for (const listener of listeners) listener()
  }

  const mergeHost = (hostId: string, entries: unknown): boolean => {
    if (hostId === '' || typeof entries !== 'object' || entries === null || Array.isArray(entries)) return false
    let changed = false
    let map = seen.get(hostId)
    for (const [id, at] of Object.entries(entries as Record<string, unknown>)) {
      if (id === '' || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
      if (map === undefined) {
        map = new Map<string, number>()
        seen.set(hostId, map)
      }
      const prev = map.get(id) ?? 0
      if (at > prev) {
        map.set(id, at)
        changed = true
      }
    }
    return changed
  }

  async function loadSeen(): Promise<void> {
    if (loaded) return
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      try {
        const text = await storage.getItem(KEY)
        if (text !== null) {
          const parsed = JSON.parse(text) as unknown
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            let changed = false
            for (const [hostId, entries] of Object.entries(parsed as Record<string, unknown>)) {
              if (mergeHost(hostId, entries)) changed = true
            }
            if (changed) bump()
          }
        }
      } catch { /* start fresh */ }
      finally {
        loaded = true
      }
    })()
    return loadPromise
  }

  function seenAt(hostId: string, id: string): number {
    if (hostId === '' || id === '') return 0
    return seen.get(hostId)?.get(id) ?? 0
  }

  function markSeen(hostId: string, id: string, at = Date.now()): Promise<void> {
    if (hostId === '' || id === '' || !Number.isFinite(at) || at <= 0) return Promise.resolve()
    let map = seen.get(hostId)
    if (map === undefined) {
      map = new Map<string, number>()
      seen.set(hostId, map)
    }
    const prev = map.get(id) ?? 0
    if (at <= prev && !pendingPersist) return flushing ?? Promise.resolve()
    if (at > prev) {
      map.set(id, at)
      bump()
    }
    dirty = true
    pendingPersist = true
    if (flushing === null) {
      flushing = (async () => {
        try {
          await loadSeen()
          while (dirty) {
            dirty = false
            try {
              await storage.setItem(KEY, serialize(seen))
              if (!dirty) pendingPersist = false
            } catch {
              pendingPersist = true
            }
          }
        } finally {
          flushing = null
        }
      })()
    }
    return flushing
  }

  function isUnread(hostId: string, id: string, lastAt: number | undefined, open: boolean): boolean {
    return !open && lastAt !== undefined && Number.isFinite(lastAt) && lastAt > seenAt(hostId, id)
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  return {
    loadSeen,
    seenAt,
    markSeen,
    isUnread,
    subscribe,
    version: () => ver,
  }
}

const defaultStore = createSeenStore()

export const loadSeen = () => defaultStore.loadSeen()
export const seenAt = (hostId: string, id: string) => defaultStore.seenAt(hostId, id)
export const markSeen = (hostId: string, id: string, at?: number) => defaultStore.markSeen(hostId, id, at)
export const isUnread = (hostId: string, id: string, lastAt: number | undefined, open: boolean) => defaultStore.isUnread(hostId, id, lastAt, open)
export const subscribeSeen = (listener: () => void) => defaultStore.subscribe(listener)
export const seenVersion = () => defaultStore.version()
