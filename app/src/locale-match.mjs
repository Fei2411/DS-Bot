// Pure UI locale matching helpers shared between the Electron main process (app/src/main.mjs)
// and the desktop renderer (app/ui/src/locale.js). Lives under app/src/ so electron-builder
// ships it inside packaged desktop builds.

const SUPPORTED = new Set(['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de'])

export function matchSupportedLocale(tag) {
  const lower = String(tag ?? '').trim().toLowerCase()
  if (lower === '') return null
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh'
  const primary = lower.split('-')[0]
  if (primary === 'en') return 'en'
  return SUPPORTED.has(primary) ? primary : null
}

export function resolveLocale(tag) {
  return matchSupportedLocale(tag) ?? 'en'
}

/** Picks the first OS preferred language tag that maps to a supported UI locale. */
export function pickPreferredLanguageTag(tags, fallback = '') {
  if (Array.isArray(tags)) {
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      const clean = raw.trim()
      if (clean !== '' && matchSupportedLocale(clean) !== null) return clean
    }
    const first = tags.find(raw => typeof raw === 'string' && raw.trim() !== '')
    if (first !== undefined) return first.trim()
  }
  return typeof fallback === 'string' ? fallback.trim() : ''
}
