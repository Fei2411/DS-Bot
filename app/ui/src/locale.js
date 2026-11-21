// The part of DSH's locale service that the plugin's copy (ds-bot/src/client/i18n.js)
// uses: it registers its dictionary and translates through a bound namespace.
const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

const SUPPORTED = new Set(['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de'])

function resolveLocale(tag) {
  const lower = String(tag ?? '').toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh'
  const primary = lower.split('-')[0]
  return SUPPORTED.has(primary) ? primary : 'en'
}

export function createLocale(tag) {
  const active = resolveLocale(tag)
  const dictionaries = new Map()
  return {
    getLocale: () => ({ active }),
    register(namespace, language, dictionary) {
      const key = `${namespace}:${language}`
      dictionaries.set(key, dictionary)
      return () => { dictionaries.delete(key) }
    },
    bind: namespace => (key, params) => fill(dictionaries.get(`${namespace}:${active}`)?.[key] ?? key, params),
  }
}
