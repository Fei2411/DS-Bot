import * as SecureStore from 'expo-secure-store'
import { parseSeen, seenKey } from './seen-core.ts'

// Last-read time per bot or room id, kept in memory and on the phone. A row is
// unread when its lastAt is newer than this and its chat is not open. The store
// belongs to the computer the app is linked to, so it is loaded before the team
// first renders.
const seen = new Map<string, number>()
let activeKey = seenKey('')
let loadedFor: string | null = null

export async function loadSeen(hostDeviceId: string): Promise<void> {
  if (loadedFor === hostDeviceId) return
  loadedFor = hostDeviceId
  activeKey = seenKey(hostDeviceId)
  seen.clear()
  try {
    for (const [id, at] of Object.entries(parseSeen(await SecureStore.getItemAsync(activeKey)))) seen.set(id, at)
  } catch { /* start fresh */ }
}

export function seenAt(id: string): number {
  return seen.get(id) ?? 0
}

export function markSeen(id: string, at = Date.now()): void {
  seen.set(id, at)
  void SecureStore.setItemAsync(activeKey, JSON.stringify(Object.fromEntries(seen)))
}

export function isUnread(id: string, lastAt: number | undefined, open: boolean): boolean {
  return !open && lastAt !== undefined && lastAt > seenAt(id)
}
