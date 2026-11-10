import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installLocale } from '../src/client/i18n.js'
import { pluginStatusText } from '../src/client/plugin-status.js'

// Plugin pages show manager status codes as sentences: the user reads a reason, not the
// engine's identifier. Unknown codes keep the sentence generic instead of leaking through.

const MANAGED = 'Managed by the installation. It cannot be switched here.'
const GENERIC = 'This plugin cannot be used here.'

function fakeLocale(active = 'zh') {
  const dicts = new Map()
  return {
    setActive(next) { active = next },
    register(ns, localeOrMap, dict) {
      const pairs = typeof localeOrMap === 'string' ? [[localeOrMap, dict]] : Object.entries(localeOrMap ?? {})
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      for (const [loc, d] of pairs) dicts.get(ns).set(loc.toLowerCase(), d)
      return () => {}
    },
    bind: ns => (key, params) => {
      const text = (active !== 'en' ? dicts.get(ns)?.get(active.toLowerCase())?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active, locales: [] }),
  }
}

test('the manager status code becomes a sentence and never the raw code', () => {
  assert.equal(pluginStatusText('management-required'), MANAGED)
  for (const code of ['some-engine-code', 'plugin/load-failed', '']) {
    assert.equal(pluginStatusText(code), GENERIC)
    assert.doesNotMatch(pluginStatusText(code), /some-engine-code|plugin\/load-failed/)
  }
})

test('the sentences follow the interface language', () => {
  const mock = fakeLocale('zh')
  const off = installLocale(mock)
  try {
    assert.equal(pluginStatusText('management-required'), '由安装管理，不能在应用内开关')
    assert.equal(pluginStatusText('unknown-code'), '这个插件在这里无法使用')
    mock.setActive('zh-TW')
    assert.equal(pluginStatusText('management-required'), '由安裝管理，不能在應用內開關')
    mock.setActive('ja')
    assert.equal(pluginStatusText('management-required'), 'インストール側で管理されています。ここでは切り替えできません')
    for (const loc of ['ko', 'es', 'fr', 'de']) {
      mock.setActive(loc)
      const managed = pluginStatusText('management-required')
      assert.notEqual(managed, MANAGED, `${loc} left the sentence in English`)
      assert.notEqual(pluginStatusText('unknown-code'), GENERIC, `${loc} left the fallback in English`)
    }
  } finally {
    off()
  }
})
