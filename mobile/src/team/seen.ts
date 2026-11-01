import * as SecureStore from 'expo-secure-store'

const KEY = 'dsbot.seenAt'
// Last-read time per bot or room id, kept in memory and on the phone. A row is
// unread when its lastAt is newer than this and its chat is not open.
const seen = new Map<string, number>()
let loaded = false

export async function loadSeen(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const text = await SecureStore.getItemAsync(KEY)
    if (text !== null) for (const [id, at] of Object.entries(JSON.parse(text) as Record<string, number>)) seen.set(id, at)
  } catch { /* start fresh */ }
}

export function seenAt(id: string): number {
  return seen.get(id) ?? 0
}

export function markSeen(id: string, at = Date.now()): void {
  seen.set(id, at)
  void SecureStore.setItemAsync(KEY, JSON.stringify(Object.fromEntries(seen)))
}

export function isUnread(id: string, lastAt: number | undefined, open: boolean): boolean {
  return !open && lastAt !== undefined && lastAt > seenAt(id)
}
