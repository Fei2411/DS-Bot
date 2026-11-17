// Languages whose layout runs right to left, kept apart from React Native so the
// plain node tests can read them.
const RTL_LANGUAGES = /^(ar|arc|ckb|dv|fa|he|iw|ku|ps|sd|ug|ur|yi)([_-]|$)/i

/** Whether a locale identifier names a right-to-left language ("ar-EG", "he_IL"). */
export function readsRightToLeft(locale: string): boolean {
  return RTL_LANGUAGES.test(locale.trim())
}
