import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_ALLOWED as HOST_BROWSER_ALLOWED } from '../../../ds-bot/src/host/phone.js'
import { BROWSER_ALLOWED, ensureUnlock, GATED } from './gate.web.ts'
import { getLang, setLang } from '../ui/i18n.ts'

test('all gated, privileged, and unlisted endpoints are refused in the browser in English and Chinese', async context => {
  const previous = getLang()
  context.after(() => setLang(previous))
  const denied = [
    ...GATED,
    'connector-add', 'connector-remove', 'connector-set', 'connector-import', 'connector-cancel',
    'secret-encrypt', 'secret-decrypt', 'secret-unlock', 'secret-store',
    'provider-models', 'provider-models-save',
    'im-add', 'local-agent-add', 'mail-account-add',
    'computer-app-answer', 'computer-stop', 'phone-pair',
    '', 'unknown-endpoint',
  ]
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang)
    for (const endpoint of denied) {
      await assert.rejects(ensureUnlock(endpoint), { code: 'bot/refused', message: lang === 'en' ? 'Not available from a browser. Use the phone app or the computer.' : '浏览器不支持此操作。请使用手机 App 或电脑。' }, endpoint)
    }
    for (const endpoint of BROWSER_ALLOWED) {
      await ensureUnlock(endpoint)
    }
  }
})

test('the host and browser client share the exact same allowlist, strictly disjoint from GATED', () => {
  assert.deepEqual(BROWSER_ALLOWED, HOST_BROWSER_ALLOWED)
  for (const endpoint of GATED) {
    assert.equal(BROWSER_ALLOWED.has(endpoint), false, `${endpoint} must not be in BROWSER_ALLOWED`)
  }
})

test('the web client lets a browser stop a Bot background task', async () => {
  await ensureUnlock('bot-stop-task')
})
