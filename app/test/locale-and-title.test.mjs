import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocale, pickPreferredLanguageTag } from '../ui/src/locale.js'
import { conversationTitleOf, formatWindowTitle } from '../ui/src/window-title.js'
import { isAllowedWindowTitle } from '../src/window-bounds.mjs'

function makeTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type) {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn({ type })
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function makeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

test('createLocale follows system languagechange events in auto mode and updates document lang and bindings', () => {
  const prevDoc = globalThis.document
  globalThis.document = { documentElement: { lang: '' } }
  try {
    let sysLang = 'en-US'
    const target = makeTarget()
    const storage = makeStorage()
    const locale = createLocale(sysLang, {
      storage,
      target,
      getSystemTag: () => sysLang,
    })
    locale.register('ui', 'en', { hi: 'Hello' })
    locale.register('ui', 'zh', { hi: '你好' })
    locale.register('ui', 'ja', { hi: 'こんにちは' })
    const t = locale.bind('ui')

    const seen = []
    locale.subscribe(state => seen.push(state))

    assert.equal(target.count('languagechange'), 1)
    assert.deepEqual(locale.getLocale(), { active: 'en', preference: 'auto' })
    assert.equal(t('hi'), 'Hello')

    // System switches to Simplified Chinese.
    sysLang = 'zh-CN'
    target.dispatch('languagechange')
    assert.deepEqual(locale.getLocale(), { active: 'zh', preference: 'auto' })
    assert.equal(globalThis.document.documentElement.lang, 'zh')
    assert.equal(t('hi'), '你好')
    assert.deepEqual(seen, [{ active: 'zh', preference: 'auto' }])

    // Duplicate event with same resolved locale does not re-notify.
    sysLang = 'zh-SG'
    target.dispatch('languagechange')
    assert.equal(seen.length, 1)

    // Explicit manual preference ignores languagechange, but returning to auto picks up the latest system language.
    locale.setLocale('ja')
    assert.deepEqual(locale.getLocale(), { active: 'ja', preference: 'ja' })
    assert.equal(t('hi'), 'こんにちは')

    sysLang = 'en-GB'
    target.dispatch('languagechange')
    assert.deepEqual(locale.getLocale(), { active: 'ja', preference: 'ja' })
    assert.equal(t('hi'), 'こんにちは')

    locale.setLocale('auto')
    assert.deepEqual(locale.getLocale(), { active: 'en', preference: 'auto' })
    assert.equal(t('hi'), 'Hello')

    // Switching back to auto reads getSystemTag() freshly even without a languagechange event,
    // and syncSystemTag() pushes live OS language updates from Electron main.
    locale.setLocale('ja')
    sysLang = 'fr-FR'
    locale.setLocale('auto')
    assert.deepEqual(locale.getLocale(), { active: 'fr', preference: 'auto' })
    locale.syncSystemTag('de-DE')
    assert.deepEqual(locale.getLocale(), { active: 'de', preference: 'auto' })

    // Dispose detaches listener cleanly.
    locale.dispose()
    assert.equal(target.count('languagechange'), 0)
    sysLang = 'zh-CN'
    target.dispatch('languagechange')
    assert.deepEqual(locale.getLocale(), { active: 'de', preference: 'auto' })
  } finally {
    globalThis.document = prevDoc
  }
})

test('createLocale tracks revision across system changes and lazy register, refreshes async IPC on languagechange/auto, and picks first supported OS language', async () => {
  const prevDoc = globalThis.document
  globalThis.document = { documentElement: { lang: '' } }
  try {
    let ipcLang = 'en-US'
    let refreshCalls = 0
    const target = makeTarget()
    const storage = makeStorage()
    const locale = createLocale('en-US', {
      storage,
      target,
      getSystemTag: () => 'en-US',
      refreshSystemTag: async () => {
        refreshCalls += 1
        return ipcLang
      },
    })
    const seen = []
    locale.subscribe(state => seen.push({ ...state, rev: locale.getSnapshot().revision }))

    const rev0 = locale.getSnapshot().revision
    // languagechange triggers async refreshSystemTag so Electron updates even when navigator.language stays frozen.
    ipcLang = 'fr-FR'
    target.dispatch('languagechange')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(refreshCalls, 1)
    assert.equal(locale.getLocale().active, 'fr')
    assert.ok(locale.getSnapshot().revision > rev0, 'applySystemTag increments revision')

    // Registering a lazy dictionary for the active language increments revision and notifies subscribers.
    const revBeforeReg = locale.getSnapshot().revision
    const countBeforeReg = seen.length
    locale.register('ds-bot', 'fr', { Settings: 'Paramètres' })
    assert.equal(locale.getSnapshot().revision, revBeforeReg + 1)
    assert.equal(seen.length, countBeforeReg + 1)
    assert.equal(locale.bind('ds-bot')('Settings'), 'Paramètres')

    // Switching manual -> auto actively queries refreshSystemTag even if window stayed focused.
    locale.setLocale('ja')
    ipcLang = 'ko-KR'
    locale.setLocale('auto')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(refreshCalls, 2)
    assert.equal(locale.getLocale().active, 'ko')

    locale.dispose()
  } finally {
    globalThis.document = prevDoc
  }

  // Preferred system language matching picks the first supported entry rather than only index 0.
  assert.equal(pickPreferredLanguageTag(['pt-BR', 'zh-Hans-CN', 'en-US'], 'en-US'), 'zh-Hans-CN')
  assert.equal(pickPreferredLanguageTag(['ru-RU', 'ja-JP'], 'en-US'), 'ja-JP')
  assert.equal(pickPreferredLanguageTag(['pt-BR', 'ru-RU'], 'en-US'), 'pt-BR')
  assert.equal(pickPreferredLanguageTag([], 'fr-CA'), 'fr-CA')
})

test('window title formatting covers Bot DM, group chat, classic sessions, and empty fallback', () => {
  assert.equal(formatWindowTitle(''), 'DS Bot')
  assert.equal(formatWindowTitle('   '), 'DS Bot')
  assert.equal(formatWindowTitle('Chief'), 'Chief — DS Bot')
  assert.equal(formatWindowTitle('  Product Team  '), 'Product Team — DS Bot')

  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: null, chat: { name: 'Chief' }, shownAgent: null, sessionTitle: '' })),
    'DS Bot',
  )
  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: 'bot-1', chat: { name: 'Chief' }, shownAgent: null, sessionTitle: '' })),
    'Chief — DS Bot',
  )
  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: 'room-1', chat: { name: 'Design Group' }, shownAgent: null, sessionTitle: '' })),
    'Design Group — DS Bot',
  )
  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: 'sess-1', chat: undefined, shownAgent: { name: 'Coder' }, sessionTitle: 'Refactor auth' })),
    'Refactor auth — DS Bot',
  )
  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: 'sess-2', chat: undefined, shownAgent: { name: 'Coder' }, sessionTitle: '' })),
    'Coder — DS Bot',
  )
  assert.equal(
    formatWindowTitle(conversationTitleOf({ shown: 'sess-3', chat: undefined, shownAgent: undefined, sessionTitle: '' })),
    'DS Bot',
  )
})

test('isAllowedWindowTitle accepts DS Bot titles and rejects blank, whitespace-only, control-char, or arbitrary page titles', () => {
  assert.equal(formatWindowTitle('Chief\n\tOps\r'), 'Chief Ops — DS Bot')
  assert.equal(formatWindowTitle('\n\t\r'), 'DS Bot')
  assert.equal(isAllowedWindowTitle('DS Bot'), true)
  assert.equal(isAllowedWindowTitle('Chief — DS Bot'), true)
  assert.equal(isAllowedWindowTitle(''), false)
  assert.equal(isAllowedWindowTitle(' — DS Bot'), false)
  assert.equal(isAllowedWindowTitle('   — DS Bot'), false)
  assert.equal(isAllowedWindowTitle('Chief\n — DS Bot'), false)
  assert.equal(isAllowedWindowTitle('Chief\u0000 — DS Bot'), false)
  assert.equal(isAllowedWindowTitle('http://127.0.0.1:41234/'), false)
  assert.equal(isAllowedWindowTitle('Sign in — DeepSeek'), false)
})
