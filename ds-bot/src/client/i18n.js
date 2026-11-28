// Interface copy follows the active locale. Keys are the English text so English needs no
// dictionary; `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr` and `de` load dynamically on demand.
// Single-file consumers (such as the DSH plugin bundle) import `./locales/all.js` to
// pre-register every pack synchronously.

export const NAMESPACE = 'ds-bot'

export const LANGUAGES = [
  { id: 'zh-TW', label: '繁體中文', fallback: 'zh' },
  { id: 'ja', label: '日本語', fallback: 'en' },
  { id: 'ko', label: '한국어', fallback: 'en' },
  { id: 'es', label: 'Español', fallback: 'en' },
  { id: 'fr', label: 'Français', fallback: 'en' },
  { id: 'de', label: 'Deutsch', fallback: 'en' },
]

export const DICTIONARY = {}

const HOST_ERROR_TABLE = {}
const DSH_LOCALE_PACKS = {}

const SUPPORTED_LOCALES = new Set(['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de'])

const DATE_LOCALES = {
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  ja: 'ja-JP',
  ko: 'ko-KR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  en: 'en-US',
}

const DEFAULT_LOCALE_RETRIES = 2
const DEFAULT_LOCALE_RETRY_DELAY_MS = 150

const lastFailedChunkUrls = new Map()
const localeAttempts = new Map()
let localeTestHooks = null

function bustLocaleUrl(url, attempt) {
  if (typeof url !== 'string' || !url) return url
  try {
    const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost/')
    parsed.searchParams.set('retry', String(attempt))
    return parsed.href
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}retry=${attempt}`
  }
}

function findLocaleChunkUrl(error, chunkKey) {
  const escaped = chunkKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`/${escaped}(?:-[^/?#]+)?\\.js(?:$|[?#])`, 'i')
  const msg = String(error?.message ?? error ?? '')
  const matches = msg.match(/(?:https?|dsh-app|file):\/\/[^\s'")]+/gi) ?? []
  for (const candidate of matches) {
    if (pattern.test(candidate)) return candidate
  }
  try {
    const entries = globalThis.performance?.getEntriesByType?.('resource') ?? []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = String(entries[i]?.name ?? '')
      if (pattern.test(name)) return name
    }
  } catch {
    // Ignore restricted performance API environments.
  }
  return null
}

function importLocaleChunk(chunkKey, defaultImport, attempt) {
  const knownUrl = attempt > 0
    ? (lastFailedChunkUrls.get(chunkKey) || findLocaleChunkUrl(null, chunkKey))
    : null
  const bustedUrl = knownUrl ? bustLocaleUrl(knownUrl, attempt) : null
  const invoke = localeTestHooks?.importChunk
    ? () => localeTestHooks.importChunk(chunkKey, defaultImport, attempt, bustedUrl)
    : () => (bustedUrl ? import(/* @vite-ignore */ bustedUrl) : defaultImport())
  return Promise.resolve().then(invoke).catch((err) => {
    const discovered = findLocaleChunkUrl(err, chunkKey)
    if (discovered) lastFailedChunkUrls.set(chunkKey, discovered)
    throw err
  })
}

const LOCALE_LOADERS = {
  zh: async (attempt = 0) => {
    const { ZH, HOST_ERRORS } = await importLocaleChunk('zh', () => import('./locales/zh.js'), attempt)
    return { dict: ZH, hostErrors: HOST_ERRORS }
  },
  'zh-TW': async (attempt = 0) => {
    const [{ ZH, HOST_ERRORS }, { convertDict, convertHostErrors, toTraditional }] = await Promise.all([
      importLocaleChunk('zh', () => import('./locales/zh.js'), attempt),
      importLocaleChunk('zh-tw', () => import('./locales/zh-tw.js'), attempt),
    ])
    return {
      dict: convertDict(ZH),
      hostErrors: convertHostErrors(HOST_ERRORS),
      convertDict,
      toTraditional,
    }
  },
  ja: async (attempt = 0) => {
    const { DSH_JA, HOST_ERRORS_JA, JA } = await importLocaleChunk('ja', () => import('./locales/ja.js'), attempt)
    return { dict: JA, hostErrors: HOST_ERRORS_JA, dsh: DSH_JA }
  },
  ko: async (attempt = 0) => {
    const { DSH_KO, HOST_ERRORS_KO, KO } = await importLocaleChunk('ko', () => import('./locales/ko.js'), attempt)
    return { dict: KO, hostErrors: HOST_ERRORS_KO, dsh: DSH_KO }
  },
  es: async (attempt = 0) => {
    const { DSH_ES, HOST_ERRORS_ES, ES } = await importLocaleChunk('es', () => import('./locales/es.js'), attempt)
    return { dict: ES, hostErrors: HOST_ERRORS_ES, dsh: DSH_ES }
  },
  fr: async (attempt = 0) => {
    const { DSH_FR, HOST_ERRORS_FR, FR } = await importLocaleChunk('fr', () => import('./locales/fr.js'), attempt)
    return { dict: FR, hostErrors: HOST_ERRORS_FR, dsh: DSH_FR }
  },
  de: async (attempt = 0) => {
    const { DSH_DE, HOST_ERRORS_DE, DE } = await importLocaleChunk('de', () => import('./locales/de.js'), attempt)
    return { dict: DE, hostErrors: HOST_ERRORS_DE, dsh: DSH_DE }
  },
}

const loadedPacks = new Map()
const pendingLoads = new Map()
const activeSyncHooks = new Set()
let zhTwTools = null

/** Test seam: override locale chunk import / retry timing in unit tests. */
export function setLocaleTestHooks(hooks) {
  localeTestHooks = hooks ?? null
  for (const lang of hooks?.resetLangs ?? []) {
    loadedPacks.delete(lang)
    pendingLoads.delete(lang)
    localeAttempts.delete(lang)
    lastFailedChunkUrls.delete(lang.toLowerCase())
    delete DICTIONARY[lang]
    delete HOST_ERROR_TABLE[lang]
    delete DSH_LOCALE_PACKS[lang]
  }
}

function resolveLangKey(tag) {
  const lower = String(tag ?? '').toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh'
  const primary = lower.split('-')[0]
  return SUPPORTED_LOCALES.has(primary) ? primary : 'en'
}

export function isLocaleLoaded(tag) {
  const lang = resolveLangKey(tag)
  return lang === 'en' || loadedPacks.has(lang)
}

export function registerLocalePack(langId, pack) {
  if (!SUPPORTED_LOCALES.has(langId) || !pack?.dict) return
  loadedPacks.set(langId, pack)
  DICTIONARY[langId] = pack.dict
  if (pack.hostErrors) HOST_ERROR_TABLE[langId] = pack.hostErrors
  if (pack.dsh) DSH_LOCALE_PACKS[langId] = pack.dsh
  if (pack.convertDict || pack.toTraditional) {
    zhTwTools = { convertDict: pack.convertDict, toTraditional: pack.toTraditional }
  }
  for (const hook of Array.from(activeSyncHooks)) hook(langId)
}

export function ensureLocale(tag, options = {}) {
  const lang = resolveLangKey(tag)
  if (lang === 'en') return Promise.resolve(null)
  if (loadedPacks.has(lang)) return Promise.resolve(loadedPacks.get(lang))
  const inflight = pendingLoads.get(lang)
  if (inflight) return inflight
  const loader = LOCALE_LOADERS[lang]
  if (!loader) return Promise.resolve(null)
  const retries = options.retries ?? localeTestHooks?.retries ?? DEFAULT_LOCALE_RETRIES
  const retryDelayMs = options.retryDelayMs ?? localeTestHooks?.retryDelayMs ?? DEFAULT_LOCALE_RETRY_DELAY_MS
  const promise = (async () => {
    let lastErr
    for (let tries = 0; tries <= retries; tries += 1) {
      const attempt = localeAttempts.get(lang) ?? 0
      try {
        const pack = await loader(attempt)
        registerLocalePack(lang, pack)
        return loadedPacks.get(lang) ?? pack
      } catch (err) {
        lastErr = err
        localeAttempts.set(lang, attempt + 1)
        if (tries < retries && retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs * (tries + 1)))
        }
      }
    }
    throw lastErr
  })().finally(() => {
    pendingLoads.delete(lang)
  })
  pendingLoads.set(lang, promise)
  return promise
}

export function loadAllLocales() {
  return Promise.all(Object.keys(LOCALE_LOADERS).map(lang => ensureLocale(lang)))
}

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

let service = null
let bound = null

// `locale` is the DSH locale service; without one, copy stays English.
export function installLocale(locale, options = {}) {
  if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return () => {}
  const onLoadError = typeof options?.onError === 'function' ? options.onError : null
  service = locale
  bound = locale.bind(NAMESPACE)
  const offs = []
  const pushOff = (fn) => { if (typeof fn === 'function') offs.push(fn) }

  if (typeof locale.addLanguage === 'function') {
    const existing = new Set((locale.getLocale?.()?.locales ?? []).map(item => String(item.id).toLowerCase()))
    for (const def of LANGUAGES) {
      if (!existing.has(def.id.toLowerCase())) {
        try { pushOff(locale.addLanguage(def)) } catch { /* already added */ }
      }
    }
  }

  // DS Bot fills locales that other plugins' namespaces lack. Each supplement is tied to
  // the owner dictionary it was made from, so it leaves when that owner unloads or
  // re-registers. DSH has no lower-priority registration, so an owner's own locale
  // registered while the supplement stands still collides with it.
  const supplements = new Map()
  const supplementKey = (ns, langId) => `${ns}\0${langId.toLowerCase()}`
  const dropSupplement = (key) => {
    const entry = supplements.get(key)
    if (!entry) return
    supplements.delete(key)
    entry.off()
  }
  const supplement = (ns, langId, source, make) => {
    const key = supplementKey(ns, langId)
    if (supplements.has(key) || locale.dicts.get(ns)?.has(langId.toLowerCase())) return
    try {
      const off = locale.register(ns, langId, make())
      if (typeof off === 'function') supplements.set(key, { ns, source, off })
    } catch { /* already registered */ }
  }

  let syncing = false
  let disposed = false
  const registeredLangs = new Set()

  const syncDshNamespaces = () => {
    if (disposed || syncing || !(locale.dicts instanceof Map)) return
    syncing = true
    try {
      for (const [key, entry] of supplements) {
        const map = locale.dicts.get(entry.ns)
        if (![...(map?.values() ?? [])].includes(entry.source)) dropSupplement(key)
      }
      for (const [langId, namespaces] of Object.entries(DSH_LOCALE_PACKS)) {
        for (const [ns, dict] of Object.entries(namespaces ?? {})) {
          const map = locale.dicts.get(ns)
          const source = map?.get('en') ?? map?.get('zh')
          if (source) supplement(ns, langId, source, () => dict)
        }
      }
      if (zhTwTools?.convertDict) {
        for (const [ns, map] of locale.dicts.entries()) {
          const zhDict = map.get('zh')
          if (ns !== NAMESPACE && zhDict) supplement(ns, 'zh-TW', zhDict, () => zhTwTools.convertDict(zhDict))
        }
      }
    } finally {
      syncing = false
    }
  }

  const syncPack = (langId) => {
    if (disposed) return
    const pack = loadedPacks.get(langId)
    if (pack?.dict && !registeredLangs.has(langId)) {
      registeredLangs.add(langId)
      pushOff(locale.register(NAMESPACE, langId, pack.dict))
    }
    syncDshNamespaces()
  }

  const ensureActive = () => {
    if (disposed) return
    const active = locale.getLocale?.()?.active
    const lang = resolveLangKey(active)
    if (lang !== 'en' && !loadedPacks.has(lang)) {
      void ensureLocale(lang).catch((err) => {
        console.error(`ds-bot: failed to load locale "${lang}"`, err)
        onLoadError?.(lang, err)
      })
    }
  }

  for (const langId of loadedPacks.keys()) syncPack(langId)
  syncDshNamespaces()
  activeSyncHooks.add(syncPack)
  offs.push(() => { activeSyncHooks.delete(syncPack) })

  if (typeof locale.subscribe === 'function') {
    pushOff(locale.subscribe(() => {
      syncDshNamespaces()
      ensureActive()
    }))
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onFocus = () => { ensureActive() }
    window.addEventListener('focus', onFocus)
    offs.push(() => { window.removeEventListener('focus', onFocus) })
  }
  offs.push(() => {
    for (const key of supplements.keys()) dropSupplement(key)
  })

  const origResolveText = typeof locale.resolveText === 'function' ? locale.resolveText.bind(locale) : null
  if (origResolveText) {
    locale.resolveText = (text) => {
      const resolved = origResolveText(text)
      if (resolveLangKey(language()) === 'zh-TW' && typeof text === 'object' && text !== null && !('zh-tw' in text) && zhTwTools?.toTraditional) {
        return zhTwTools.toTraditional(resolved)
      }
      return resolved
    }
    offs.push(() => { locale.resolveText = origResolveText })
  }

  ensureActive()

  return () => {
    disposed = true
    if (service === locale) { service = null; bound = null }
    for (let i = offs.length - 1; i >= 0; i--) offs[i]()
  }
}

export function t(key, params) {
  return bound ? bound(key, params) : fill(key, params)
}

// The host owns built-in preset copy, including languages DS Bot does not translate.
export function presetText(key) {
  const value = service?.bind('settings.agentPreset')(key)
  return typeof value === 'string' && value !== key ? value : undefined
}

// A message from the host, in the interface language.
export function hostText(message) {
  const lang = resolveLangKey(language())
  if (lang === 'en') return message
  const pack = loadedPacks.get(lang)
  if (pack?.dict && Object.hasOwn(pack.dict, message)) return t(message)
  for (const [pattern, template] of HOST_ERROR_TABLE[lang] ?? []) {
    if (pattern.test(message)) return message.replace(pattern, template)
  }
  return message
}

// The active DSH language tag, for dates and times.
export function language() {
  const active = service?.getLocale?.().active
  return typeof active === 'string' ? active : 'en'
}

export const dateLocale = () => DATE_LOCALES[resolveLangKey(language())] ?? 'en-US'

// MarkdownText re-parses when `labels` changes identity, and a streaming message starts
// over, so one object serves until the language changes the text.
let labels = null
export function mdLabels() {
  const [copyLabel, copiedLabel, footnotes] = [t('Copy'), t('Copied'), t('Footnotes')]
  if (labels?.code.copyLabel !== copyLabel || labels.code.copiedLabel !== copiedLabel || labels.footnotes !== footnotes) {
    labels = { code: { copyLabel, copiedLabel }, footnotes }
  }
  return labels
}
