import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ensureUnlock, GATED } from './gate.web.ts'
import { getLang, setLang } from '../ui/i18n.ts'

test('all gated endpoints are refused in the browser in English and Chinese', async context => {
  const previous = getLang()
  context.after(() => setLang(previous))
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang)
    for (const endpoint of GATED) {
      await assert.rejects(ensureUnlock(endpoint), { code: 'bot/refused', message: lang === 'en' ? 'Not available from a browser. Use the phone app or the computer.' : '浏览器不支持此操作。请使用手机 App 或电脑。' })
    }
    await ensureUnlock('state')
    await ensureUnlock('send')
    await ensureUnlock('')
  }
})

test('the host browser gate and mobile unlock gate cover the same endpoints', () => {
  const source = readFileSync(new URL('../../../ds-bot/src/host/phone.js', import.meta.url), 'utf8')
  const body = /BROWSER_GATED = new Set\(\[([\s\S]*?)\]\)/.exec(source)![1]
  assert.deepEqual(new Set([...body.matchAll(/'([^']+)'/g)].map(match => match[1])), GATED)
})
