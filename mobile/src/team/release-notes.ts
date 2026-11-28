import { useSyncExternalStore } from 'react'
import * as SecureStore from '../storage'
import {
  cleanSemver,
  compareSemver,
  pendingReleaseVersions,
  RELEASE_NOTES,
} from '../../../ds-bot/src/shared/release-notes.js'

export const RELEASE_NOTES_SEEN_KEY = 'dsbot.release-notes.last-seen-version'
const LOCAL = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

export interface ReleaseNotesStorage {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
}

export interface MobileReleaseNotesEntry {
  version: string
  date?: string
  notes: Record<string, { intro?: string; items: string[]; outro?: string } | string[] | undefined>
}

export interface MobileReleaseNotesCheckResult {
  show: boolean
  current: string | null
  versions: string[]
}

const defaultStorage: ReleaseNotesStorage = {
  getItemAsync: key => SecureStore.getItemAsync(key, LOCAL),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, LOCAL),
}

/**
 * Record the installed version silently on a fresh install (when no identity existed yet)
 * so closing the app on the pairing screen never turns the next launch into a false upgrade.
 */
export async function seedFreshInstallReleaseNotes({
  currentVersion,
  storage = defaultStorage,
}: {
  currentVersion: string
  storage?: ReleaseNotesStorage
}): Promise<void> {
  const current = cleanSemver(currentVersion)
  if (current === null) return
  const rawSeen = await storage.getItemAsync(RELEASE_NOTES_SEEN_KEY).catch(() => null)
  if (rawSeen && cleanSemver(rawSeen) !== null) return
  await storage.setItemAsync(RELEASE_NOTES_SEEN_KEY, current).catch(() => {})
}

/**
 * Evaluate whether the phone app should auto-show post-upgrade release notes and update
 * the device-local `lastSeenVersion` key:
 * - Fresh install (no seen key and no existing identity): silently record current version.
 * - Upgrade from older build without seen key (`hadExistingIdentity === true`) or from
 *   any older version (`lastSeen < current`): show only the current release once (never pile
 *   earlier versions).
 * - Same version, build-metadata-only change, or downgrade: silent, never roll back `lastSeenVersion`.
 * - Storage write failure: leave unseen and do not show so the next launch retries cleanly.
 */
export async function checkMobileReleaseNotes({
  currentVersion,
  hadExistingIdentity,
  storage = defaultStorage,
  releases = RELEASE_NOTES as MobileReleaseNotesEntry[],
}: {
  currentVersion: string
  hadExistingIdentity: boolean
  storage?: ReleaseNotesStorage
  releases?: MobileReleaseNotesEntry[]
}): Promise<MobileReleaseNotesCheckResult> {
  const current = cleanSemver(currentVersion)
  if (current === null) return { show: false, current: null, versions: [] }

  const rawSeen = await storage.getItemAsync(RELEASE_NOTES_SEEN_KEY).catch(() => null)
  const lastSeen = rawSeen ? cleanSemver(rawSeen) : null

  if (lastSeen === null && !hadExistingIdentity) {
    await storage.setItemAsync(RELEASE_NOTES_SEEN_KEY, current).catch(() => {})
    return { show: false, current, versions: [] }
  }

  if (lastSeen !== null && compareSemver(current, lastSeen) <= 0) {
    return { show: false, current, versions: [] }
  }

  const versions = pendingReleaseVersions({ current, lastSeenVersion: lastSeen, releases })
  if (versions.length === 0) {
    await storage.setItemAsync(RELEASE_NOTES_SEEN_KEY, current).catch(() => {})
    return { show: false, current, versions: [] }
  }
  try {
    await storage.setItemAsync(RELEASE_NOTES_SEEN_KEY, current)
  } catch {
    return { show: false, current, versions: [] }
  }
  return { show: true, current, versions }
}

export interface MobileReleaseNotesModalState {
  open: boolean
  mode: 'auto' | 'manual'
  current: string | null
}

let modalState: MobileReleaseNotesModalState = {
  open: false,
  mode: 'manual',
  current: null,
}
const listeners = new Set<() => void>()

function publish(next: MobileReleaseNotesModalState): void {
  modalState = next
  listeners.forEach(fn => fn())
}

function subscribeModal(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getModalSnapshot(): MobileReleaseNotesModalState {
  return modalState
}

export function openMobileReleaseNotes(options: { current?: string | null; mode?: 'auto' | 'manual' } = {}): void {
  publish({
    open: true,
    mode: options.mode ?? 'manual',
    current: options.current ?? null,
  })
}

export function closeMobileReleaseNotes(mode?: 'auto' | 'manual'): void {
  if (!modalState.open) return
  if (mode !== undefined && modalState.mode !== mode) return
  publish({ ...modalState, open: false })
}

export function useMobileReleaseNotes(): MobileReleaseNotesModalState {
  return useSyncExternalStore(subscribeModal, getModalSnapshot, getModalSnapshot)
}
