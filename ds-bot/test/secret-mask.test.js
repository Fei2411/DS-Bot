import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectSecrets, maskSecrets, projectSecretsToSlice, redactSecretsForLog } from '../src/shared/secret-mask.js'
import { cleanText } from '../src/host/diagnostics.js'

const join = (...parts) => parts.join('')

test('detectSecrets matches all supported credential formats and preserves prefixes/boundaries', () => {
  const samples = [
    ['sk', join('sk-', 'proj1234', 'AbCdEfGhIjKlMnOpQrStUv')],
    ['aiza', join('AIza', 'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q')],
    ['ghp', join('ghp_', '1234567890', 'abcdefABCDEF1234567890abcdef')],
    ['gho', join('gho_', '1234567890', 'abcdefABCDEF1234567890abcdef')],
    ['github_pat', join('github_pat_', '11AAAAAA00000000000000_bbbbbbbbbbbb')],
    ['glpat', join('glpat-', '1234567890', 'abcdefghijkl')],
    ['npm', join('npm_', '1234567890', 'abcdefABCDEF1234567890abcdef')],
    ['hf', join('hf_', '1234567890', 'abcdefABCDEF1234567890')],
    ['akia', join('AKIA', '0123456789ABCDEF')],
    ['asia', join('ASIA', 'FEDCBA9876543210')],
    ['ltai', join('LTAI', '5tAbCdEf12345678')],
    ['akid', join('AKID', '1234567890abcdef1234567890abcdef')],
    ['xoxb', join('xoxb-', '1234567890-abcdef')],
    ['stripe', join('sk_live_', '1234567890abcdef1234')],
    ['stripe_rk', join('rk_test_', '1234567890abcdef1234')],
    ['whsec', join('whsec_', '1234567890abcdef1234567890')],
    ['jwt', join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3OCJ9', '.', 'signaturePart12345')],
  ]

  for (const [name, token] of samples) {
    const text = `Use ${token} now`
    const spans = detectSecrets(text)
    assert.equal(spans.length, 1, `expected 1 span for ${name}`)
    assert.equal(spans[0].raw, token)
    assert.equal(spans[0].masked.slice(0, 8), token.slice(0, 8), `${name} keeps first 8 chars`)
    assert.equal(spans[0].masked.slice(8), '*'.repeat(token.length - 8), `${name} masks remainder`)
    assert.equal(maskSecrets(text), `Use ${spans[0].masked} now`)
    assert.equal(maskSecrets(text, new Set([spans[0].key])), text, `${name} reveals only when key is in set`)
  }
})

test('detectSecrets masks PEM private key blocks and URL passwords precisely', () => {
  const pemBegin = join('-----BEGIN ', 'RSA PRIVATE KEY-----')
  const pemEnd = join('-----END ', 'RSA PRIVATE KEY-----')
  const pem = [
    pemBegin,
    'MIIEowIBAAKCAQEAtestline1',
    'secondLineOfSyntheticBody',
    pemEnd,
  ].join('\n')
  const pemSpans = detectSecrets(`Key:\n${pem}\nDone`)
  assert.equal(pemSpans.length, 1)
  assert.equal(pemSpans[0].kind, 'private-key')
  assert.equal(pemSpans[0].masked, [
    pemBegin,
    '*'.repeat('MIIEowIBAAKCAQEAtestline1'.length),
    '*'.repeat('secondLineOfSyntheticBody'.length),
    pemEnd,
  ].join('\n'))

  const url = 'Connect to postgres://admin:s3cr3tPass!@db.example.internal:5432/app'
  const urlSpans = detectSecrets(url)
  assert.equal(urlSpans.length, 1)
  assert.equal(urlSpans[0].kind, 'url-password')
  assert.equal(urlSpans[0].raw, 's3cr3tPass!')
  assert.equal(maskSecrets(url), 'Connect to postgres://admin:***********@db.example.internal:5432/app')
})

test('detectSecrets avoids false positives and handles multiple independent secrets & selective reveal', () => {
  assert.deepEqual(detectSecrets(join('sk-', 'without-any-digits-in-this-token-string')), [])
  assert.deepEqual(detectSecrets('my_ghp_1234567890abcdefABCDEF1234567890abcdef'), [])
  assert.deepEqual(detectSecrets('Normal text with https://example.com/path and foo@bar.com'), [])

  const first = join('ghp_', '111111111122222222223333333333444444')
  const second = join('AKIA', '0000111122223333')
  const msg = `First ${first} and second ${second}`
  const spans = detectSecrets(msg)
  assert.equal(spans.length, 2)
  // Reveal only the second secret; first must stay masked.
  const partial = maskSecrets(msg, new Set([spans[1].key]))
  assert.equal(partial.includes(first), false)
  assert.equal(partial.includes(spans[0].masked), true)
  assert.equal(partial.includes(second), true)
})

test('projectSecretsToSlice keeps fold-truncated secrets masked with stable full-text keys', () => {
  const tok = join('ghp_', '1234567890', 'abcdefABCDEF1234567890abcdef')
  const pad = `${'a'.repeat(589)} `
  const fullTok = `${pad}${tok} trailing`
  const shownTok = fullTok.slice(0, 602) // cuts mid-token at 12 chars (4 chars past 8-char prefix)
  const tokSpans = projectSecretsToSlice(fullTok, shownTok)
  assert.equal(tokSpans.length, 1)
  assert.equal(tokSpans[0].clipped, true)
  assert.equal(tokSpans[0].masked, `${tok.slice(0, 8)}****`)
  assert.equal(tokSpans[0].key, `${pad.length}:${tok}`)
  assert.equal(maskSecrets(fullTok, new Set([tokSpans[0].key])), fullTok)

  // URL credential cut before `@host` still masks every password char while folded.
  const urlFull = `${'b'.repeat(584)} https://admin:s3cr3tPass!@db.example.internal/src/demo.js`
  const urlShown = urlFull.slice(0, 605) // cuts inside `s3cr3tPass!` before `@db.example.internal`
  const urlSpans = projectSecretsToSlice(urlFull, urlShown)
  assert.equal(urlSpans.length, 1)
  assert.equal(urlSpans[0].kind, 'url-password')
  assert.equal(urlSpans[0].clipped, true)
  assert.equal(/^\*+$/.test(urlSpans[0].masked), true)
  assert.equal(urlSpans[0].masked.length, urlSpans[0].raw.length)
  assert.equal(maskSecrets(urlFull, new Set([urlSpans[0].key])), urlFull)

  // PEM private key cut before `-----END` retains the full-text span key so reveal-then-copy matches.
  const pemBegin = join('-----BEGIN ', 'RSA PRIVATE KEY-----')
  const pemEnd = join('-----END ', 'RSA PRIVATE KEY-----')
  const pemFull = `Lead:\n${pemBegin}\nMIIEowIBAAKCAQEAtestline1\nsecondLineOfSyntheticBody\n${pemEnd}\nDone`
  const pemShown = pemFull.slice(0, pemFull.indexOf(pemEnd) - 5)
  const pemSpans = projectSecretsToSlice(pemFull, pemShown)
  assert.equal(pemSpans.length, 1)
  assert.equal(pemSpans[0].kind, 'private-key')
  assert.equal(pemSpans[0].clipped, true)
  assert.equal(pemSpans[0].masked.includes('MIIEowIBAAKCAQEA'), false)
  assert.equal(pemSpans[0].masked.startsWith(pemBegin), true)
  assert.equal(maskSecrets(pemFull, new Set([pemSpans[0].key])), pemFull)
})

test('diagnostics cleanText shares the secret-mask source of truth', () => {
  const gl = join('glpat-', '1234567890abcdefghijkl')
  const npm = join('npm_', '1234567890abcdefABCDEF1234567890abcdef')
  const wh = join('whsec_', '1234567890abcdef1234567890')
  const url = 'https://alice:hunter2pw@api.example.com/hook'
  const out = cleanText(`${gl} ${npm} ${wh} ${url}`, { home: '' })
  assert.equal(out, '[hidden] [hidden] [hidden] https://alice:[hidden]@api.example.com/hook')
  assert.equal(redactSecretsForLog(join('sk-', '1234567890abcdefghijkl')), 'sk-[hidden]')
})
