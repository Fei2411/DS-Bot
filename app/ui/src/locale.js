// Reactive locale service for the desktop app's own interface, matching DSH's locale
// contract (`getLocale`, `register`, `bind`) while adding user language selection and
// persistence in `localStorage`. Kept free of React imports so non-React modules and
// host-side tests (`ds-bot/test/frontend-audit-regressions.test.js`) can import it directly.

import { pickPreferredLanguageTag, resolveLocale } from '../../src/locale-match.mjs'

export { pickPreferredLanguageTag, resolveLocale }

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
  const target = options.target !== undefined
    ? options.target
    : (typeof globalThis.window !== 'undefined' ? globalThis.window : null)
  const getSystemTag = typeof options.getSystemTag === 'function'
    ? options.getSystemTag
    : () => (typeof globalThis.navigator?.language === 'string' && globalThis.navigator.language !== ''
      ? globalThis.navigator.language
      : tag)
  const refreshSystemTag = typeof options.refreshSystemTag === 'function' ? options.refreshSystemTag : null
  let systemActive = resolveLocale(tag)
  let preference = readStoredPreference(storage)
  let active = preference === 'auto' ? systemActive : resolveLocale(preference)
  // Keep rendering in the previous loaded language while a newly chosen locale's
  // dictionary chunk is still fetching, avoiding a mid-session flash to English.
  let displayActive = active
  let revision = 0
  let refreshSeq = 0
  const dictionaries = new Map()
  const listeners = new Set()

  const hasDictionaryFor = (lang) => {
    const suffix = `:${lang}`
    for (const key of dictionaries.keys()) {
      if (key.endsWith(suffix)) return true
    }
    return false
  }

  const syncDocumentLang = () => {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = displayActive
    }
  }

  const notify = () => {
    for (const listener of Array.from(listeners)) {
      try { listener({ active, preference }) } catch { /* listener error isolated */ }
    }
  }

  const applySystemTag = (rawTag) => {
    const nextSystem = resolveLocale(rawTag)
    if (nextSystem === systemActive) return
    systemActive = nextSystem
    if (preference !== 'auto' || systemActive === active) return
    active = systemActive
    if (active === 'en' || hasDictionaryFor(active)) {
      displayActive = active
    }
    revision += 1
    syncDocumentLang()
    notify()
  }

  const querySystemTag = () => {
    if (!refreshSystemTag) return
    const seq = ++refreshSeq
    void Promise.resolve(refreshSystemTag()).then((next) => {
      if (seq !== refreshSeq) return
      if (typeof next === 'string' && next.trim() !== '') applySystemTag(next)
    }).catch(() => {})
  }

  const onLanguageChange = () => {
    applySystemTag(getSystemTag())
    querySystemTag()
  }

  if (typeof target?.addEventListener === 'function') {
    target.addEventListener('languagechange', onLanguageChange)
  }

  return {
    getLocale: () => ({ active, preference }),
    getSnapshot: () => ({ active, preference, revision }),
    syncSystemTag(nextTag) {
      applySystemTag(nextTag !== undefined ? nextTag : getSystemTag())
      return { active, preference }
    },
    setLocale(nextPreference) {
      const clean = VALID_PREFERENCES.has(nextPreference) ? nextPreference : 'auto'
      if (clean === 'auto') systemActive = resolveLocale(getSystemTag())
      const nextActive = clean === 'auto' ? systemActive : resolveLocale(clean)
      const changed = clean !== preference || nextActive !== active
      if (changed) {
        preference = clean
        active = nextActive
        if (nextActive === 'en' || hasDictionaryFor(nextActive)) {
          displayActive = nextActive
        }
        revision += 1
        writeStoredPreference(storage, preference)
        syncDocumentLang()
        notify()
      }
      if (clean === 'auto') querySystemTag()
      return { active, preference }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    register(namespace, language, dictionary) {
      const key = `${namespace}:${language}`
      const prev = dictionaries.get(key)
      dictionaries.set(key, dictionary)
      if (resolveLocale(language) === active && (prev !== dictionary || displayActive !== active)) {
        displayActive = active
        revision += 1
        syncDocumentLang()
        notify()
      }
      return () => { dictionaries.delete(key) }
    },
    bind: namespace => (key, params) => fill(dictionaries.get(`${namespace}:${displayActive}`)?.[key] ?? key, params),
    dispose() {
      refreshSeq += 1
      if (typeof target?.removeEventListener === 'function') {
        target.removeEventListener('languagechange', onLanguageChange)
      }
    },
  }
}

let appLocaleService = null

export function setAppLocaleService(service) {
  appLocaleService = service
}

export function getAppLocale() {
  return appLocaleService
}
