import Constants from 'expo-constants'

/** Current installed mobile app version (shared across iOS, Android, and web). */
export function currentAppVersion(): string {
  return String(
    Constants.expoConfig?.version
    ?? (Constants as { manifest?: { version?: string } }).manifest?.version
    ?? '0.0.0',
  )
}
