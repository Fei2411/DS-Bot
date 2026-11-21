import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, LANGUAGES, dateLocale, hostText, installLocale, language, t } from '../src/client/i18n.js'
import { DSH_JA, HOST_ERRORS_JA } from '../src/client/locales/ja.js'
import { DSH_KO, HOST_ERRORS_KO } from '../src/client/locales/ko.js'
import { DSH_ES, HOST_ERRORS_ES } from '../src/client/locales/es.js'
import { DSH_FR, HOST_ERRORS_FR } from '../src/client/locales/fr.js'
import { DSH_DE, HOST_ERRORS_DE } from '../src/client/locales/de.js'

function fakeLocale(initial = 'zh') {
  let active = initial
  const dicts = new Map()
  const listeners = new Set()
  const catalog = [{ id: 'zh', label: '中文', fallback: 'en' }, { id: 'en', label: 'English' }]
  const publish = () => { for (const fn of listeners) fn() }
  return {
    dicts,
    setActive: (next) => { active = next; publish() },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    addLanguage: (def) => {
      catalog.push(def)
      publish()
      return () => {
        const idx = catalog.indexOf(def)
        if (idx >= 0) catalog.splice(idx, 1)
        publish()
      }
    },
    register: (ns, localeOrMap, dict) => {
      const pairs = typeof localeOrMap === 'string' ? [[localeOrMap, dict]] : Object.entries(localeOrMap ?? {})
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      const map = dicts.get(ns)
      for (const [loc] of pairs) {
        if (map.has(loc.toLowerCase())) throw new Error(`locale namespace "${ns}" already has locale "${loc}"`)
      }
      for (const [loc, d] of pairs) {
        map.set(loc.toLowerCase(), d)
      }
      publish()
      return () => {
        for (const [loc] of pairs) map.delete(loc.toLowerCase())
        if (map.size === 0) dicts.delete(ns)
        publish()
      }
    },
    bind: ns => (key, params) => {
      const text = (active !== 'en' ? dicts.get(ns)?.get(active.toLowerCase())?.[key] : undefined) ?? key
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

test('every DICTIONARY.zh key exists in all other supported locales', () => {
  const missing = []
  const locales = ['zh-TW', 'ja', 'ko', 'es', 'fr', 'de']
  for (const key of Object.keys(DICTIONARY.zh)) {
    for (const loc of locales) {
      if (!Object.hasOwn(DICTIONARY[loc] ?? {}, key)) missing.push(`${loc}: ${key}`)
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

    // Async DSH plugins registering their own namespaces after installLocale must not collide,
    // and immediately receive missing locale supplements (e.g. ko and zh-TW).
    assert.equal(mock.dicts.has('open-in-app'), false)
    mock.register('open-in-app', {
      zh: { 'open.title': '在 {app} 中打开' },
      en: { 'open.title': 'Open in {app}' },
      ja: { 'open.title': '{app} で開く' },
    })
    assert.equal(mock.dicts.get('open-in-app')?.get('zh-tw')?.['open.title'], '在 {app} 中打開')
    assert.equal(mock.dicts.get('open-in-app')?.get('ko')?.['open.title'], '{app}에서 열기')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})

test('HOST_ERRORS and DSH_LOCALE_PACKS stay aligned across all locales', () => {
  const hostTables = {
    ja: HOST_ERRORS_JA,
    ko: HOST_ERRORS_KO,
    es: HOST_ERRORS_ES,
    fr: HOST_ERRORS_FR,
    de: HOST_ERRORS_DE,
  }
  const base = HOST_ERRORS_JA
  assert.ok(Array.isArray(base) && base.length > 0)
  const groupCount = re => new RegExp(`${re.source}|`).exec('').length - 1
  for (const [loc, table] of Object.entries(hostTables)) {
    assert.equal(table.length, base.length, `HOST_ERRORS length mismatch for ${loc}`)
    for (let i = 0; i < base.length; i++) {
      assert.equal(table[i][0].source, base[i][0].source, `HOST_ERRORS[${i}] regex source mismatch for ${loc}`)
      assert.equal(table[i][0].flags, base[i][0].flags, `HOST_ERRORS[${i}] regex flags mismatch for ${loc}`)
      const groups = groupCount(table[i][0])
      for (const m of table[i][1].matchAll(/\$(\d+)/g)) {
        assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= groups, `HOST_ERRORS[${i}] bad $${m[1]} ref for ${loc}`)
      }
    }
  }

  const dshPacks = { ko: DSH_KO, es: DSH_ES, fr: DSH_FR, de: DSH_DE }
  const jaNamespaces = Object.keys(DSH_JA)
  for (const [loc, pack] of Object.entries(dshPacks)) {
    assert.deepEqual(Object.keys(pack), jaNamespaces, `DSH namespaces mismatch for ${loc}`)
    for (const ns of jaNamespaces) {
      assert.deepEqual(
        Object.keys(pack[ns]),
        Object.keys(DSH_JA[ns]),
        `DSH namespace ${ns} keys mismatch for ${loc}`,
      )
    }
  }
})

test('user-facing host errors translate across all non-English locales', () => {
  const samples = [
    // channel.js & roster.js
    'This message is no longer kept',
    'No file named',
    'This file cannot be read here',
    'That wait is no longer open',
    'Nothing to send',
    'This view is no longer open',
    'This is not a photo DS Bot can send',
    'A photo did not arrive. Send it again.',
    'Nothing to delete',
    'Bot browsers are off on this host',
    'This Bot has no open browser',
    'A browser poll needs a clientId',
    'This browser is not held',
    'This handoff is no longer open',
    'Avatar images must be PNG, JPEG, WebP, GIF, or SVG',
    'Pick a model before choosing a thinking level',
    'Unknown section',
    'Unknown section color',
    'Write the to-do first.',
    'That to-do is no longer on the list.',
    'Keep a to-do under 240 characters.',
    'The shared to-do list is full (40). Remove one or clear the completed items.',
    // goals.js & tasks.js
    'Write what this group should achieve, in at most 2000 characters.',
    'This group has no admin. Set one in the group settings first.',
    'This group already has a goal. Stop it first.',
    'The goal has changed. Look again.',
    'Nothing to do',
    'Write a note first.',
    'That task is already finished.',
    'No such group.',
    'No such task.',
    'No open task to cancel.',
    'The goal of "Team" is active; clear needs it to be drafting, complete or stopped.',
    // connectors & mail
    'Sign-in timed out',
    'The sign-in answer did not match this attempt (state mismatch). Try again.',
    'This connector does not sign in',
    'This connector has no server address',
    'Connector addresses must start with https://',
    'This service does not publish OAuth sign-in metadata',
    'Paste a key first',
    'No sign-in is waiting',
    'Paste the address or the code',
    'This address is not from this sign-in attempt (state mismatch). Copy the whole address again.',
    'The address has no code',
    'Enter the client ID',
    'Name the connector',
    'Enter an address or a command',
    'Only added connectors can be removed',
    'The mail connection closed during verification',
    'Google sign-in is not available in this build',
    'Enter an email address',
    'Enter the IMAP and SMTP hosts',
    'No such account',
    'This card was already answered',
    'No Google sign-in is waiting',
    'The sign-in answer is not for this attempt',
    'Google did not say which account this is',
    'The password for user@example.com is not saved',
    // im
    'This platform is not available yet',
    'Choose a Bot first',
    'This platform signs in by scanning a code; not available yet',
    'No such IM bot',
    'No such platform',
    'No such chat',
    'Choose a Bot or a group',
    'This platform has no QR login',
    'Paste the bot token first',
    'Telegram did not say who this token belongs to',
    'A webhook or another program uses this bot',
    'This token does not belong to a Discord bot',
    'Discord gave no usable gateway URL',
    'These credentials do not belong to a Slack bot',
    'WeChat answered an unreadable response',
    'WeChat rate limited the request',
    'WeChat refused the token',
    'WeChat answered 500',
    'WeChat refused the reply (invalid)',
    'Discord could not open a socket: ECONNRESET',
    'Feishu could not open a socket: ETIMEDOUT',
    'WeCom socket failed: ECONNREFUSED',
    'Bot token is required',
    'App ID must be text',
    // capabilities, secrets, learning, computer, avatar-library, models
    'Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.',
    'Arguments must be a list of text values.',
    'Choose an MCP server, skill, or pack.',
    'A capability cannot change its kind. Delete it and save a new one.',
    'Enter a command for the MCP server.',
    'Enter a valid HTTP or HTTPS URL.',
    'Only Bots on the team can change capabilities.',
    'Only a Main Bot can change another Bot’s capabilities.',
    'This DSH cannot load MCP servers.',
    'Unknown capability operation.',
    'No capability named my-tool.',
    'The secrets file is not encrypted.',
    'Secrets are already encrypted.',
    'Secrets are not encrypted.',
    'Learning is turned off on this host',
    'AGENTS.md changed since this was proposed',
    'The Bot that learned this skill is gone',
    'my-skill changed since this was proposed',
    'A skill named my-skill exists now',
    'System permissions are not available here',
    'This host keeps no Bot data folder, so it has no avatar library.',
    'DS Bot is shutting down',
  ]
  const mock = fakeLocale('zh')
  const off = installLocale(mock)
  try {
    for (const loc of ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']) {
      mock.setActive(loc)
      const missing = samples.filter(msg => hostText(msg) === msg)
      assert.deepEqual(missing, [], `${loc} left host errors untranslated`)
    }
  } finally {
    off()
  }
})

// DSH's own locale runtime, loaded as its browser module would be; rendering
// dependencies are stubs because only the dictionary registry is exercised.
const localeRuntime = (async () => {
  let registration
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: entry => { registration = entry } } }
  try { await import('@deepseek-ai/dsh-client-locale/client') } catch { return null } finally { globalThis.window = previous }
  const stub = () => new Proxy(function () {}, { get: (_, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : stub()), apply: () => stub(), construct: () => stub() })
  const runtime = registration?.factory(() => stub()).LocaleRuntime
  return typeof runtime === 'function' ? runtime : null
})()

async function realLocale() {
  const LocaleRuntime = await localeRuntime
  if (!LocaleRuntime) return null
  return new LocaleRuntime({ emit() {}, effect: fn => fn() })
}

test('a generated zh-TW dictionary leaves with the namespace owner', async (t) => {
  const locale = await realLocale()
  if (!locale) return t.skip('this DSH has no locale runtime to load')
  const off = installLocale(locale)
  try {
    locale.setLocale('zh-TW')
    const text = locale.bind('locale-owner')
    const removeOwner = locale.register('locale-owner', { en: { label: 'Old settings' }, zh: { label: '旧设置' } })
    assert.equal(text('label'), '舊設定')
    removeOwner()
    assert.equal(text('label'), 'label')

    const removeNative = locale.register('locale-owner', {
      en: { label: 'New settings' },
      zh: { label: '新设置' },
      'zh-TW': { label: '原生設定' },
    })
    assert.equal(text('label'), '原生設定')
    removeNative()
    assert.equal(text('label'), 'label')

    const removeBase = locale.register('locale-owner', { en: { label: 'Settings' }, zh: { label: '设置' } })
    assert.equal(text('label'), '設定')
    removeBase()
    assert.equal(text('label'), 'label')
  } finally {
    off()
  }
})

test('a generated language pack leaves with the namespace owner', async (t) => {
  const locale = await realLocale()
  if (!locale) return t.skip('this DSH has no locale runtime to load')
  const [ns, dict] = Object.entries(DSH_KO)[0]
  const [key, translated] = Object.entries(dict)[0]
  const off = installLocale(locale)
  try {
    locale.setLocale('ko')
    const text = locale.bind(ns)
    const before = text(key)
    const removeOwner = locale.register(ns, { en: { [key]: 'English' }, zh: { [key]: '中文' } })
    assert.equal(text(key), translated)
    removeOwner()
    assert.equal(text(key), before)
    const removeNative = locale.register(ns, { en: { [key]: 'English' }, zh: { [key]: '中文' }, ko: { [key]: '원본' } })
    assert.equal(text(key), '원본')
    removeNative()
  } finally {
    off()
  }
})

test('unloading DS Bot removes only its own dictionaries', async (t) => {
  const locale = await realLocale()
  if (!locale) return t.skip('this DSH has no locale runtime to load')
  const removeOwner = locale.register('locale-owner', { en: { label: 'Settings' }, zh: { label: '设置' } })
  const off = installLocale(locale)
  locale.setLocale('zh-TW')
  const text = locale.bind('locale-owner')
  assert.equal(text('label'), '設定')
  off()
  assert.equal(locale.bind('ds-bot')('Settings'), 'Settings')
  locale.setLocale('zh')
  assert.equal(text('label'), '设置')
  assert.doesNotThrow(() => locale.register('locale-owner', 'zh-TW', { label: '原生設定' }))
  removeOwner()
})
