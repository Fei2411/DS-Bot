// The cookie-file parser: format detection by content, decoding variants, normalization,
// and per-entry skip reporting. Fixtures are the P0 sample set (fake data only).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseCookieFile, summarizeBySite } from '../src/cookie-parse.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cookies')
const parse = (name) => parseCookieFile(readFileSync(join(fixtures, name)))

// Every file carries the same eight fake cookies in a different spelling; all of them
// must parse to 8 entries with none skipped, and carry the warnings the spelling costs.
const CASES = [
  ['cookies.txt', 'netscape', 'utf-8', []],
  ['cookie-editor.json', 'cookie-editor', 'utf-8', []],
  ['playwright-storage-state.json', 'playwright', 'utf-8', []],
  ['cookies.crlf-bom.txt', 'netscape', 'utf-8', []],
  ['cookies.utf16le-bom.txt', 'netscape', 'utf-16le', []],
  ['cookies.spaces.txt', 'netscape', 'utf-8', ['spaces-not-tabs']],
  ['cookies.no-header.txt', 'netscape', 'utf-8', []],
  ['cookies.dotted.txt', 'netscape', 'utf-8', []],
  ['cookies.cookie-editor-export.txt', 'netscape', 'utf-8', []],
  ['cookie-editor.current.json', 'cookie-editor', 'utf-8', []],
  ['cookie-editor.ms-expiry.json', 'cookie-editor', 'utf-8', ['expiry-milliseconds']],
  ['cookie-editor.minimal.json', 'cookie-editor', 'utf-8', ['missing-field']],
  ['playwright.crlf-bom.json', 'playwright', 'utf-8', []],
  ['selenium.json', 'cookie-editor', 'utf-8', []],
]

test('every format and encoding variant parses all eight cookies', () => {
  for (const [file, format, encoding, warningCodes] of CASES) {
    const parsed = parse(file)
    assert.equal(parsed.ok, true, `${file}: ${parsed.error}`)
    assert.equal(parsed.format, format, file)
    assert.equal(parsed.encoding, encoding, file)
    assert.equal(parsed.cookies.length, 8, file)
    assert.equal(parsed.skipped.length, 0, file)
    const codes = new Set(parsed.warnings.map((w) => w.code))
    for (const code of warningCodes) assert.ok(codes.has(code), `${file}: warning ${code}`)
  }
})

test('flags survive: HttpOnly prefix, Secure, SameSite, session', () => {
  const byName = (parsed, name) => parsed.cookies.find((c) => c.name === name)
  const editor = parse('cookie-editor.json')
  assert.equal(byName(editor, 'p_http').httpOnly, true)
  assert.equal(byName(editor, 'p_none').sameSite, 'None')
  assert.equal(byName(editor, 'p_none').secure, true)
  assert.equal(byName(editor, 'p_session').expires, undefined)
  const txt = parse('cookies.txt')
  assert.equal(byName(txt, 'p_http').httpOnly, true, '#HttpOnly_ is data, not a comment')
  assert.equal(byName(txt, 'p_session').expires, undefined, 'expiry 0 is a session cookie')
  const pw = parse('playwright-storage-state.json')
  assert.equal(byName(pw, 'p_session').expires, undefined, 'expires -1 is a session cookie')
  assert.equal(byName(pw, 'p_persist').sameSite, 'Lax')
})

test('a cookie header string is recognized and refused: it has no domain or path', () => {
  const parsed = parse('header-string.txt')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.format, 'header-string')
  assert.match(parsed.error, /no domain/i)
})

test('malformed lines are skipped with reasons; the good ones still parse', () => {
  const parsed = parse('malformed.cookies.txt')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.format, 'netscape')
  assert.equal(parsed.cookies.length, 5)
  const codes = parsed.skipped.map((s) => s.code)
  for (const code of ['field-count', 'bad-expiry', 'missing-domain', 'bad-char-name', 'prefix', 'expired']) {
    assert.ok(codes.includes(code), `missing skip code ${code}`)
  }
  // A skipped entry names where it was and why; never the value.
  for (const item of parsed.skipped) {
    assert.ok(item.where)
    assert.ok(item.reason)
    assert.equal(item.value, undefined)
  }
})

test('malformed JSON entries are skipped with reasons', () => {
  const parsed = parse('malformed.cookie-editor.json')
  assert.equal(parsed.ok, true)
  assert.ok(parsed.cookies.length > 0)
  assert.ok(parsed.skipped.length > 0)
})

test('malformed Playwright entries are skipped with reasons; the good ones still parse', () => {
  const parsed = parse('malformed.playwright.json')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.format, 'playwright')
  assert.deepEqual(parsed.cookies.map(item => item.name), ['m_ok1', 'm_url', 'm_ok2'])
  assert.deepEqual(parsed.skipped.map(item => [item.name, item.code]), [['m_nodomain', 'missing-domain'], ['m_badexpires', 'bad-expiry']])
})

test('truncated JSON reports unreadable', () => {
  const parsed = parse('truncated.json')
  assert.equal(parsed.ok, false)
})

test('duplicates resolve last-entry-wins with a warning', () => {
  const parsed = parseCookieFile(JSON.stringify([
    { name: 'n', value: 'one', domain: 'example.com', path: '/' },
    { name: 'n', value: 'two', domain: 'example.com', path: '/' },
  ]))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cookies.length, 1)
  assert.equal(parsed.cookies[0].value, 'two')
  assert.ok(parsed.warnings.some((w) => w.code === 'duplicate'))
})

test('SameSite=None without Secure is dropped to unspecified with a warning, not skipped', () => {
  const parsed = parseCookieFile(JSON.stringify([{ name: 'n', value: 'v', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'None', expirationDate: 1893456000 }]))
  assert.equal(parsed.cookies.length, 1)
  assert.equal(parsed.cookies[0].sameSite, undefined)
  assert.ok(parsed.warnings.some((w) => w.code === 'samesite-none-insecure'))
})

test('prefix rules and expired entries are refused before they can fail the store', () => {
  const parsed = parseCookieFile(JSON.stringify([
    { name: '__Host-x', value: 'v', domain: 'example.com', path: '/app', secure: true, httpOnly: false, expirationDate: 1893456000 },
    { name: 'old', value: 'v', domain: 'example.com', path: '/', expirationDate: 1000000000 },
    { name: 'semi;name', value: 'v', domain: 'example.com', path: '/', expirationDate: 1893456000 },
    { name: 'good', value: 'v', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict', expirationDate: 1893456000 },
  ]))
  assert.equal(parsed.cookies.length, 1)
  assert.equal(parsed.cookies[0].name, 'good')
  const codes = parsed.skipped.map((s) => s.code)
  assert.ok(codes.includes('prefix') && codes.includes('expired') && codes.includes('bad-char-name'))
})

test('Copy as cURL (bash and cmd) parses cookies and prefers the cURL URL over defaultUrl', () => {
  const bashCurl = [
    "curl 'https://app.example.com/dashboard/settings' \\",
    "  -H 'accept: text/html' \\",
    "  -b 'sid=fake-sess-1; theme=dark' \\",
    "  -H 'Cookie: csrf=tok-2'",
  ].join('\n')
  const parsed = parseCookieFile(bashCurl, { defaultUrl: 'https://other.example.org/' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.format, 'curl')
  assert.deepEqual(parsed.cookies.map((c) => [c.name, c.value, c.domain, c.path, c.secure]), [
    ['sid', 'fake-sess-1', 'app.example.com', '/', true],
    ['theme', 'dark', 'app.example.com', '/', true],
    ['csrf', 'tok-2', 'app.example.com', '/', true],
  ])

  const cmdCurl = 'curl ^"https://portal.example.org/api^" ^\r\n  -H ^"Cookie: a=1; b=2^"'
  const parsedCmd = parseCookieFile(cmdCurl)
  assert.equal(parsedCmd.ok, true)
  assert.equal(parsedCmd.format, 'curl')
  assert.deepEqual(parsedCmd.cookies.map((c) => [c.name, c.domain]), [['a', 'portal.example.org'], ['b', 'portal.example.org']])

  const flagsBeforeUrl = "curl -X POST -e 'https://referer.example.net/from' --url=https://target.example.org/v1 --cookie='sid=ok'"
  const parsedFlags = parseCookieFile(flagsBeforeUrl)
  assert.equal(parsedFlags.ok, true)
  assert.deepEqual(parsedFlags.cookies.map((c) => [c.name, c.domain]), [['sid', 'target.example.org']])
})

test('a Cookie header string parses when defaultUrl is supplied (full URL or bare hostname)', () => {
  const parsed = parseCookieFile('Cookie: sid=fake123; lang=zh', { defaultUrl: 'https://docs.example.com/guide' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.format, 'header-string')
  assert.deepEqual(parsed.cookies.map((c) => [c.name, c.value, c.domain, c.path, c.secure]), [
    ['sid', 'fake123', 'docs.example.com', '/', true],
    ['lang', 'zh', 'docs.example.com', '/', true],
  ])

  const bareHost = parseCookieFile('sid=bare123', { defaultUrl: 'docs.example.com' })
  assert.equal(bareHost.ok, true)
  assert.equal(bareHost.cookies[0].domain, 'docs.example.com')
  assert.equal(bareHost.cookies[0].secure, true)
})

test('Playwright storageState preserves localStorage origins and summarizes them by site', () => {
  const state = JSON.stringify({
    cookies: [
      { name: 'sid', value: 'v1', domain: '.example.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ],
    origins: [
      { origin: 'https://app.example.com', localStorage: [{ name: 'jwt', value: 'fake-jwt' }, { name: 'ui', value: '1' }] },
      { origin: 'https://only-storage.example.org', localStorage: [{ name: 'k', value: 'v' }] },
    ],
  })
  const parsed = parseCookieFile(state)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.format, 'playwright')
  assert.equal(parsed.origins.length, 2)
  assert.equal(parsed.warnings.some((w) => w.code === 'local-storage-not-imported'), false)
  const sites = summarizeBySite(parsed)
  const appSite = sites.find((s) => s.site === 'app.example.com')
  const storageOnly = sites.find((s) => s.site === 'only-storage.example.org')
  assert.equal(appSite?.localStorage, 2)
  assert.equal(storageOnly?.cookies, 0)
  assert.equal(storageOnly?.localStorage, 1)
})

test('summarizeBySite omits pure-skipped domains (0 cookies and 0 localStorage) and no-domain rows', () => {
  const result = {
    cookies: [
      { name: 'sid', value: 'v1', domain: '.good.example', path: '/', secure: true, httpOnly: true },
    ],
    origins: [
      { origin: 'https://storage-only.example', localStorage: [{ name: 'k', value: 'v' }] },
    ],
    skipped: [
      { where: 'entry 1', name: 'old', domain: '.good.example', code: 'expired', reason: 'expired' },
      { where: 'entry 2', name: 'dead', domain: '.only-expired.example', code: 'expired', reason: 'expired' },
      { where: 'line 3', name: null, domain: null, code: 'field-count', reason: 'malformed' },
    ],
  }
  const sites = summarizeBySite(result)
  assert.deepEqual(sites.map((s) => s.site), ['good.example', 'storage-only.example'])
  const good = sites.find((s) => s.site === 'good.example')
  assert.equal(good.skipped, 1)
  assert.equal(good.skippedReasons.expired, 1)
})
