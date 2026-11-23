import * as SecureStore from '../storage'

export interface StoredNoticeCursor {
  boot: string
  seq: number
  updatedAt: number
  /** Highest seen sequence per recent boot epoch so delayed pushes from an older boot cannot roll back or duplicate alerts. */
  seenBoots?: Record<string, number>
}

const KEY = 'dsbot.noticeCursors'
const LOCAL = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
const MAX_HOSTS = 20
const MAX_SEEN_BOOTS = 6

let cache: Record<string, StoredNoticeCursor> | null = null
let initPromise: Promise<Record<string, StoredNoticeCursor>> | null = null
let opQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = opQueue.then(fn, fn)
  opQueue = next.then(() => {}, () => {})
  return next
}

/** Resets module-level cache and queue (for deterministic unit tests). */
export function resetNoticeCursorStoreForTest(): void {
  cache = null
  initPromise = null
  opQueue = Promise.resolve()
}

function trimSeenBoots(boots: Record<string, number>, currentBoot: string): Record<string, number> {
  const keys = Object.keys(boots)
  if (keys.length <= MAX_SEEN_BOOTS) return boots
  const kept: Record<string, number> = {}
  if (currentBoot && typeof boots[currentBoot] === 'number') kept[currentBoot] = boots[currentBoot]
  for (const k of keys.slice(-(MAX_SEEN_BOOTS - 1))) {
    if (k !== currentBoot) kept[k] = boots[k]
  }
  return kept
}

async function readAll(): Promise<Record<string, StoredNoticeCursor>> {
  if (cache !== null) return cache
  if (initPromise !== null) return initPromise
  initPromise = (async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY, LOCAL)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cache = parsed as Record<string, StoredNoticeCursor>
          return cache
        }
      }
    } catch { /* ignore corrupted cache */ }
    cache = {}
    return cache
  })()
  try {
    return await initPromise
  } finally {
    initPromise = null
  }
}

async function writeAll(map: Record<string, StoredNoticeCursor>): Promise<void> {
  const entries = Object.entries(map)
  if (entries.length > MAX_HOSTS) {
    entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    map = Object.fromEntries(entries.slice(0, MAX_HOSTS))
  }
  cache = map
  await SecureStore.setItemAsync(KEY, JSON.stringify(map), LOCAL).catch(() => {})
}

export async function loadNoticeCursor(hostDeviceId: string): Promise<StoredNoticeCursor | null> {
  if (!hostDeviceId) return null
  return enqueue(async () => {
    const all = await readAll()
    const entry = all[hostDeviceId]
    return entry && typeof entry.boot === 'string' && typeof entry.seq === 'number' ? entry : null
  })
}

/**
 * Advances the persisted watermark for `(hostDeviceId, boot, seq)`.
 * Returns `true` when `seq` is unseen in `boot` and should be notified; `false` when already seen.
 * Delayed pushes belonging to an already-known older boot never roll back the active boot cursor.
 */
export async function recordNoticeSeen(hostDeviceId: string, boot: string | undefined, seq: number | undefined): Promise<boolean> {
  if (!hostDeviceId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return true
  return enqueue(async () => {
    const all = await readAll()
    const prev = all[hostDeviceId]
    const effectiveBoot = boot && boot.length > 0 ? boot : (prev?.boot ?? '')
    const prevBoots: Record<string, number> = {
      ...(prev?.seenBoots ?? {}),
      ...(prev?.boot ? { [prev.boot]: Math.max(prev.seq, prev.seenBoots?.[prev.boot] ?? -1) } : {}),
    }

    const seenInBoot = effectiveBoot ? prevBoots[effectiveBoot] : prev?.seq
    if (typeof seenInBoot === 'number' && seq <= seenInBoot) {
      return false
    }

    // If this boot was already recorded previously and is NOT the active boot, it is a delayed old-boot notice:
    // update its per-boot watermark without rolling back the active boot cursor.
    const isStaleKnownBoot = prev !== undefined && effectiveBoot !== '' && effectiveBoot !== prev.boot && Object.prototype.hasOwnProperty.call(prevBoots, effectiveBoot)
    const nextBoots = effectiveBoot ? trimSeenBoots({ ...prevBoots, [effectiveBoot]: seq }, isStaleKnownBoot ? prev.boot : effectiveBoot) : prevBoots

    const nextEntry: StoredNoticeCursor = isStaleKnownBoot
      ? { boot: prev.boot, seq: prev.seq, updatedAt: Date.now(), seenBoots: nextBoots }
      : { boot: effectiveBoot, seq, updatedAt: Date.now(), seenBoots: nextBoots }

    await writeAll({ ...all, [hostDeviceId]: nextEntry })
    return true
  })
}

/** Authoritative cursor update from live/periodic host RPC (`hello` / `notices`). */
export async function saveNoticeCursor(hostDeviceId: string, boot: string, seq: number): Promise<void> {
  if (!hostDeviceId || !boot || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return
  return enqueue(async () => {
    const all = await readAll()
    const prev = all[hostDeviceId]
    const prevBoots: Record<string, number> = {
      ...(prev?.seenBoots ?? {}),
      ...(prev?.boot ? { [prev.boot]: Math.max(prev.seq, prev.seenBoots?.[prev.boot] ?? -1) } : {}),
    }
    const mergedSeq = prev !== undefined && prev.boot === boot ? Math.max(prev.seq, seq) : Math.max(seq, prevBoots[boot] ?? -1)
    if (prev !== undefined && prev.boot === boot && prev.seq >= mergedSeq && prevBoots[boot] >= mergedSeq) return
    const nextBoots = trimSeenBoots({ ...prevBoots, [boot]: mergedSeq }, boot)
    await writeAll({
      ...all,
      [hostDeviceId]: { boot, seq: mergedSeq, updatedAt: Date.now(), seenBoots: nextBoots },
    })
  })
}
