import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceIdFor, generateKeyPair, pairingUri } from '../../../link/src/index.ts'
import { parsePairingInput, parsePhonePairingInput, parseWebPairingInput } from './pair-input.ts'
import { takePairingFragment } from './pair-fragment.ts'
import { getLang, setLang, t } from '../ui/i18n.ts'

const keys = generateKeyPair()
const offer = { server: 'wss://relay.test/prefix/v1/link', hostKey: keys.publicKey, hostDeviceId: deviceIdFor(keys.publicKey), code: 'one-time', name: '电脑 + 100% & team' }
const uri = pairingUri(offer)

test('web paste and startup fragment paths accept browser offers and refuse phone offers', context => {
  const previous = getLang()
  context.after(() => setLang(previous))
  const browser = { ...offer, device: 'browser' as const }
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang)
    for (const candidate of [offer, browser]) {
      const raw = pairingUri(candidate)
      const fragment = takePairingFragment({ hash: `#pair=${encodeURIComponent(raw)}`, pathname: '/web/', search: '' }, { state: null, replaceState() {} })!
      for (const input of [raw, `https://relay.test/web/#pair=${encodeURIComponent(raw)}`, fragment]) {
        if (candidate === browser) assert.deepEqual(parseWebPairingInput(input), browser)
        else assert.throws(() => parseWebPairingInput(input), error => error instanceof Error && t(error.message) === (lang === 'en' ? "This is the phone app's code. In Settings → Phone on the computer, use Open in a browser or Copy browser link." : '这是手机 App 的配对码。请在电脑的设置 → 手机中选择“在浏览器中打开”或“复制浏览器链接”。'))
      }
    }
  }
  assert.deepEqual(parsePairingInput(uri), offer)
})

test('native phone pairing accepts phone offers and refuses browser offers to prevent downgrade', context => {
  const previous = getLang()
  context.after(() => setLang(previous))
  const browser = { ...offer, device: 'browser' as const }
  const browserRaw = pairingUri(browser)
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang)
    assert.deepEqual(parsePhonePairingInput(uri), offer)
    for (const input of [browserRaw, `https://relay.test/web/#pair=${encodeURIComponent(browserRaw)}`]) {
      assert.throws(
        () => parsePhonePairingInput(input),
        error => error instanceof Error && t(error.message) === (lang === 'en'
          ? 'This is a browser pairing link. In Settings → Phone on the computer, scan the QR code to pair the phone app.'
          : '这是浏览器配对链接。请在电脑的设置 → 手机中扫描二维码以配对手机 App。'),
      )
    }
  }
})

test('pair input accepts raw pairing URIs and copied browser links without changing the offer', () => {
  for (const input of [uri, `https://relay.test/prefix/web/#pair=${encodeURIComponent(uri)}`, `http://localhost:8787/web/#pair=${encodeURIComponent(uri)}`]) {
    assert.deepEqual(parsePairingInput(`  ${input}\n`), offer)
  }
})

test('pair input refuses empty, malformed and non-pairing browser links', () => {
  for (const input of ['', 'not a URL', 'https://relay.test/web/', 'https://relay.test/web/#pair=', 'https://relay.test/web/#pair=%ZZ', `https://relay.test/web/?pair=${encodeURIComponent(uri)}`, `javascript:ignored#pair=${encodeURIComponent(uri)}`, `https://relay.test/web/#pair=${encodeURIComponent('https://other.test')}`]) {
    assert.throws(() => parsePairingInput(input), { message: 'This is not a DS Bot pairing code.' }, input)
  }
})

test('browser pairing links still undergo the existing pairing validation', () => {
  const changed = new URL(uri)
  changed.searchParams.set('host', 'different-computer')
  assert.throws(() => parsePairingInput(`https://relay.test/web/#pair=${encodeURIComponent(changed.href)}`), { message: 'This is not a DS Bot pairing code.' })
})

test('invalid pairing input has friendly English and Chinese copy', context => {
  const previous = getLang()
  context.after(() => setLang(previous))
  for (const [lang, expected] of [['en', 'This is not a DS Bot pairing code.'], ['zh', '这不是 DS Bot 配对码。']] as const) {
    setLang(lang)
    assert.throws(() => parsePairingInput('invalid pasted text'), error => error instanceof Error && t(error.message) === expected)
  }
})
