// Reactive locale service for the desktop app's own interface, matching DSH's locale
// contract (`getLocale`, `register`, `bind`) while adding user language selection and
// persistence in `localStorage`. Kept free of React imports so non-React modules and
// host-side tests (`ds-bot/test/frontend-audit-regressions.test.js`) can import it directly.

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

export const LANGUAGE_STORAGE_KEY = 'ds-bot:language'

// Native labels stay in each language's own script so a user can always find theirs.
export const LANGUAGE_OPTIONS = [
  ['auto', null],
  ['en', 'English'],
  ['zh', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
]

const VALID_PREFERENCES = new Set(LANGUAGE_OPTIONS.map(([id]) => id))
const SUPPORTED = new Set(['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de'])

export function resolveLocale(tag) {
  const lower = String(tag ?? '').toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh'
  const primary = lower.split('-')[0]
  return SUPPORTED.has(primary) ? primary : 'en'
}

function readStoredPreference(storage) {
  try {
    const raw = storage?.getItem?.(LANGUAGE_STORAGE_KEY)
    return VALID_PREFERENCES.has(raw) ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

function writeStoredPreference(storage, pref) {
  try {
    if (pref === 'auto') storage?.removeItem?.(LANGUAGE_STORAGE_KEY)
    else storage?.setItem?.(LANGUAGE_STORAGE_KEY, pref)
  } catch { /* private or unavailable storage */ }
}

export function createLocale(tag, options = {}) {
  const storage = options.storage !== undefined ? options.storage : globalThis.localStorage
  const systemActive = resolveLocale(tag)
  let preference = readStoredPreference(storage)
  let active = preference === 'auto' ? systemActive : resolveLocale(preference)
  const dictionaries = new Map()
  const listeners = new Set()

  const syncDocumentLang = () => {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = active
    }
  }

  return {
    getLocale: () => ({ active, preference }),
    setLocale(nextPreference) {
      const clean = VALID_PREFERENCES.has(nextPreference) ? nextPreference : 'auto'
      const nextActive = clean === 'auto' ? systemActive : resolveLocale(clean)
      if (clean === preference && nextActive === active) return { active, preference }
      preference = clean
      active = nextActive
      writeStoredPreference(storage, preference)
      syncDocumentLang()
      for (const listener of Array.from(listeners)) {
        try { listener({ active, preference }) } catch { /* listener error isolated */ }
      }
      return { active, preference }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    register(namespace, language, dictionary) {
      const key = `${namespace}:${language}`
      dictionaries.set(key, dictionary)
      return () => { dictionaries.delete(key) }
    },
    bind: namespace => (key, params) => fill(dictionaries.get(`${namespace}:${active}`)?.[key] ?? key, params),
  }
}

let appLocaleService = null

export function setAppLocaleService(service) {
  appLocaleService = service
}

export function getAppLocale() {
  return appLocaleService
}
