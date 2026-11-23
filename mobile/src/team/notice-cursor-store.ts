import * as SecureStore from '../storage'

export interface StoredNoticeCursor {
  boot: string
  seq: number
  updatedAt: number
}

const KEY = 'dsbot.noticeCursors'
const LOCAL = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
const MAX_HOSTS = 20

let cache: Record<string, StoredNoticeCursor> | null = null

async function readAll(): Promise<Record<string, StoredNoticeCursor>> {
  if (cache !== null) return cache
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
  const all = await readAll()
  const entry = all[hostDeviceId]
  return entry && typeof entry.boot === 'string' && typeof entry.seq === 'number' ? entry : null
}

/**
 * Advances the persisted cursor for `hostDeviceId`. Returns `true` when `seq` is newer
 * (or belongs to a new boot epoch) and should be notified; `false` when already seen.
 */
export async function recordNoticeSeen(hostDeviceId: string, boot: string | undefined, seq: number | undefined): Promise<boolean> {
  if (!hostDeviceId || typeof seq !== 'number') return true
  const all = await readAll()
  const prev = all[hostDeviceId]
  if (prev !== undefined && (boot === undefined || boot === prev.boot) && seq <= prev.seq) {
    return false
  }
  const nextBoot = boot ?? prev?.boot ?? ''
  await writeAll({
    ...all,
    [hostDeviceId]: { boot: nextBoot, seq, updatedAt: Date.now() },
  })
  return true
}

export async function saveNoticeCursor(hostDeviceId: string, boot: string, seq: number): Promise<void> {
  if (!hostDeviceId || !boot || typeof seq !== 'number') return
  const all = await readAll()
  const prev = all[hostDeviceId]
  if (prev !== undefined && prev.boot === boot && prev.seq >= seq) return
  await writeAll({
    ...all,
    [hostDeviceId]: { boot, seq, updatedAt: Date.now() },
  })
}
