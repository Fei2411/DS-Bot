import { I18nManager, NativeModules } from 'react-native'
import { readsRightToLeft } from './direction-core.ts'

let known: string | null = null

/** The device's locale, read once: it does not change while the app runs. */
export function deviceLocale(): string {
  if (known !== null) return known
  // Intl knows the device language through the platform's ICU data, which the app
  // already relies on for its Chinese check; the native constant is the fallback.
  try { known = Intl.DateTimeFormat().resolvedOptions().locale ?? '' } catch { known = '' }
  if (known === '') {
    const manager = NativeModules.I18nManager as { getConstants?: () => { localeIdentifier?: string } } | undefined
    known = manager?.getConstants?.()?.localeIdentifier ?? ''
  }
  return known
}

// The side the interface should take: React Native's own flag, or the device's
// language when the platform still says left to right (a fresh install on an
// Arabic tablet answers false here, which used to park the drawer mid-screen).
export function rightToLeft(): boolean {
  return I18nManager.isRTL || readsRightToLeft(deviceLocale())
}
