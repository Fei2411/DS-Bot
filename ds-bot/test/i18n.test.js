import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, LANGUAGES, dateLocale, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(initial = 'zh') {
  let active = initial
  const dicts = new Map()
  const catalog = [{ id: 'zh', label: '中文', fallback: 'en' }, { id: 'en', label: 'English' }]
  return {
    dicts,
    setActive: (next) => { active = next },
    addLanguage: (def) => {
      catalog.push(def)
      return () => {
        const idx = catalog.indexOf(def)
        if (idx >= 0) catalog.splice(idx, 1)
      }
    },
    register: (ns, locale, dict) => {
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      dicts.get(ns).set(locale, dict)
      return () => dicts.get(ns)?.delete(locale)
    },
    bind: ns => (key, params) => {
      const text = (active !== 'en' ? dicts.get(ns)?.get(active)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active, locales: catalog }),
  }
}

test('every literal the client translates has an entry in all supported locales', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  const locales = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'")
      for (const loc of locales) {
        if (!Object.hasOwn(DICTIONARY[loc] ?? {}, key)) missing.push(`${loc}:${name}: ${key}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language across all locales and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  assert.equal(dateLocale(), 'en-US')
  const mock = fakeLocale('zh')
  const off = installLocale(mock)
  try {
    assert.equal(LANGUAGES.length, 6)
    assert.equal(mock.getLocale().locales.length, 8)
    assert.equal(language(), 'zh')
    assert.equal(dateLocale(), 'zh-CN')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')

    mock.setActive('zh-TW')
    assert.equal(dateLocale(), 'zh-TW')
    assert.equal(t('Settings'), '設定')
    assert.equal(hostText('There is no entry 9.'), '沒有第 9 條')

    for (const [loc, expectedDate] of [['ja', 'ja-JP'], ['ko', 'ko-KR'], ['es', 'es-ES'], ['fr', 'fr-FR'], ['de', 'de-DE']]) {
      mock.setActive(loc)
      assert.equal(dateLocale(), expectedDate)
      assert.notEqual(t('Settings'), 'Settings')
      assert.notEqual(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
      assert.notEqual(hostText('The team needs at least one Main Bot'), 'The team needs at least one Main Bot')
    }
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})
