import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { redactor } from '../src/logs.mjs'
import {
  DEFAULT_PROXY_PREFS,
  isLoopbackHost,
  matchesBypass,
  parsePacProxyList,
  parseProxyUrl,
  readEnvProxyConfig,
  readProxyPrefs,
  redactProxyUrl,
  toChromiumProxyConfig,
  validateProxyPrefs,
  writeProxyPrefs,
} from '../src/proxy-prefs.mjs'

test('parseProxyUrl normalizes supported schemes, bare host:port, IPv6, and credentials', () => {
  assert.deepEqual(parseProxyUrl('127.0.0.1:7890'), {
    normalized: 'http://127.0.0.1:7890',
    protocol: 'http:',
    type: 'http',
    host: '127.0.0.1',
    port: 7890,
    username: '',
    password: '',
  })
  assert.deepEqual(parseProxyUrl('socks5://alice:s3cret@127.0.0.1:1080'), {
    normalized: 'socks5://alice:s3cret@127.0.0.1:1080',
    protocol: 'socks5:',
    type: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'alice',
    password: 's3cret',
  })
  assert.equal(parseProxyUrl('socks5h://[::1]:7891').normalized, 'socks5h://[::1]:7891')
  assert.equal(parseProxyUrl('socks4a://127.0.0.1:1080').type, 'socks4')
  assert.equal(parseProxyUrl('https://proxy.example.com').port, 443)

  for (const bad of ['', '   ', 'ftp://127.0.0.1:21', 'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890?a=1', 'http://127.0.0.1:99999', 'http://127.0.0.1:7890\nfoo']) {
    assert.throws(() => parseProxyUrl(bad), `expected rejection for ${JSON.stringify(bad)}`)
  }
})

test('validateProxyPrefs and read/writeProxyPrefs round-trip atomically and preserve saved URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-proxy-prefs-'))
  try {
    const file = join(dir, 'proxy-prefs.json')
    assert.deepEqual(readProxyPrefs(file), DEFAULT_PROXY_PREFS)

    const savedCustom = writeProxyPrefs(file, { mode: 'custom', url: '127.0.0.1:7890', bypass: 'localhost, .corp.local' })
    assert.deepEqual(savedCustom, { mode: 'custom', url: 'http://127.0.0.1:7890', bypass: 'localhost, .corp.local' })
    assert.deepEqual(readProxyPrefs(file), savedCustom)

    // Switching to direct preserves a previously valid custom URL so toggling back is effortless.
    const savedDirect = writeProxyPrefs(file, { mode: 'direct', url: savedCustom.url, bypass: savedCustom.bypass })
    assert.deepEqual(savedDirect, { mode: 'direct', url: 'http://127.0.0.1:7890', bypass: 'localhost, .corp.local' })

    // Invalid custom URL is rejected without corrupting disk state.
    assert.throws(() => writeProxyPrefs(file, { mode: 'custom', url: 'not-a-valid-url://bad', bypass: '' }))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), savedDirect)

    // Corrupt JSON on disk falls back safely to system mode.
    writeFileSync(file, '{broken json')
    assert.deepEqual(readProxyPrefs(file), DEFAULT_PROXY_PREFS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isLoopbackHost and matchesBypass cover loopback, wildcards, suffixes, ports, and IPv4 CIDR', () => {
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('foo.localhost'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('127.9.8.7'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackHost('api.openai.com'), false)

  assert.equal(matchesBypass('127.0.0.1', 3080, ''), true)
  assert.equal(matchesBypass('api.corp.local', 443, '.corp.local, 10.0.0.0/8, *.internal.net:8443'), true)
  assert.equal(matchesBypass('corp.local', 443, '.corp.local'), true)
  assert.equal(matchesBypass('10.23.45.6', 80, '10.0.0.0/8'), true)
  assert.equal(matchesBypass('11.23.45.6', 80, '10.0.0.0/8'), false)
  assert.equal(matchesBypass('svc.internal.net', 8443, '*.internal.net:8443'), true)
  assert.equal(matchesBypass('svc.internal.net', 443, '*.internal.net:8443'), false)
  assert.equal(matchesBypass('intranet', 80, '<local>'), true)
  assert.equal(matchesBypass('api.openai.com', 443, '<local>'), false)
  assert.equal(matchesBypass('api.openai.com', 443, '*'), true)
})

test('parsePacProxyList parses Chromium resolveProxy directives and fallback chains', () => {
  assert.deepEqual(parsePacProxyList('DIRECT'), [{ type: 'direct' }])
  assert.deepEqual(parsePacProxyList(''), [{ type: 'direct' }])
  assert.deepEqual(parsePacProxyList('PROXY 127.0.0.1:7890; SOCKS5 [::1]:1080; HTTPS corp.proxy:443; DIRECT'), [
    { type: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
    { type: 'socks5', host: '::1', port: 1080, username: '', password: '' },
    { type: 'https', host: 'corp.proxy', port: 443, username: '', password: '' },
    { type: 'direct' },
  ])
})

test('toChromiumProxyConfig strips credentials into auth and always bypasses loopback', () => {
  assert.deepEqual(toChromiumProxyConfig({ mode: 'system', url: '', bypass: '' }), { config: { mode: 'system' }, auth: null })
  assert.deepEqual(toChromiumProxyConfig({ mode: 'direct', url: '', bypass: '' }), { config: { mode: 'direct' }, auth: null })

  const customHttp = toChromiumProxyConfig({ mode: 'custom', url: 'http://user:pw@127.0.0.1:7890', bypass: '.corp.local' })
  assert.deepEqual(customHttp, {
    config: {
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:7890;https=127.0.0.1:7890',
      proxyBypassRules: '<local>,localhost,127.0.0.1,[::1],.corp.local',
    },
    auth: { host: '127.0.0.1', port: 7890, username: 'user', password: 'pw' },
  })

  const customSocks = toChromiumProxyConfig({ mode: 'custom', url: 'socks5://127.0.0.1:1080', bypass: '' })
  assert.equal(customSocks.config.proxyRules, 'socks5://127.0.0.1:1080')
  assert.equal(customSocks.auth, null)
})

test('readEnvProxyConfig honors process env over dotenv and supports SOCKS ALL_PROXY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-proxy-env-'))
  try {
    const dotEnv = join(dir, '.env')
    writeFileSync(dotEnv, 'HTTPS_PROXY=http://127.0.0.1:8888\nNO_PROXY=.internal\n')
    const fromDotEnv = readEnvProxyConfig({}, dotEnv)
    assert.equal(fromDotEnv.https?.normalized, 'http://127.0.0.1:8888')
    assert.equal(fromDotEnv.noProxy, '.internal')

    const fromEnv = readEnvProxyConfig({ all_proxy: 'socks5://127.0.0.1:7891' }, dotEnv)
    assert.equal(fromEnv.http?.normalized, 'socks5://127.0.0.1:7891')
    assert.equal(fromEnv.https?.normalized, 'http://127.0.0.1:8888')

    const fromEnvOverride = readEnvProxyConfig({ HTTPS_PROXY: 'http://127.0.0.1:9999' }, dotEnv)
    assert.equal(fromEnvOverride.https?.normalized, 'http://127.0.0.1:9999')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redactProxyUrl and log redactor hide embedded proxy credentials', () => {
  assert.equal(redactProxyUrl('http://dsbot:secret123@127.0.0.1:7890'), 'http://<hidden>@127.0.0.1:7890')
  const redact = redactor({ home: '/Users/alice', platform: 'darwin' })
  assert.equal(
    redact('HTTP_PROXY=http://dsbot:secret123@127.0.0.1:7890 socks5://bob:pw@proxy:1080'),
    'HTTP_PROXY=http://<hidden>@127.0.0.1:7890 socks5://<hidden>@proxy:1080',
  )
})
