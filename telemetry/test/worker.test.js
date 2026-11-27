import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleRequest } from '../src/index.js'
import { validatePayload } from '../src/validate.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const UUID = '11111111-2222-4333-8444-555555555555'

function makeDaily(overrides = {}) {
  return {
    schema_v: 1,
    type: 'daily',
    anon_id: UUID,
    day: '2026-11-25',
    app_version: '0.3.10',
    dsh_version: '0.2.2-rc.5',
    surface: 'desktop',
    os: 'darwin 24',
    arch: 'arm64',
    locale: 'zh',
    is_first_day: true,
    bot_count_bucket: '2-3',
    group_count_bucket: '1-2',
    turns_bucket: '6-20',
    connectors_count_bucket: '1-2',
    theme: 'deepseek',
    layout: 'bubble',
    providers_used: ['deepseek-official', 'custom'],
    local_agents_used: ['claude-code'],
    features_active: ['group_chat', 'memory_recall'],
    im_platforms: ['telegram'],
    ...overrides,
  }
}

function makeError(overrides = {}) {
  return {
    schema_v: 1,
    type: 'error',
    anon_id: UUID,
    day: '2026-11-25',
    app_version: '0.3.10',
    dsh_version: '0.2.2-rc.5',
    surface: 'desktop',
    os: 'darwin 24',
    arch: 'arm64',
    source: 'host',
    error_name: 'TypeError',
    error_code: 'ENOENT',
    where: 'turns',
    stack_frames: ['ds-bot/src/host/turns.js:412:15'],
    fingerprint: '0123456789abcdef',
    count: 2,
    ...overrides,
  }
}

function mockDb() {
  const calls = []
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args })
              return { success: true }
            },
          }
        },
      }
    },
  }
}

test('accepts valid daily summary and normalizes sorted arrays', () => {
  const res = validatePayload(makeDaily({ providers_used: ['custom', 'deepseek-official', 'custom'] }), NOW)
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.providers_used, ['custom', 'deepseek-official'])
})

test('rejects unknown fields on both daily and error payloads', () => {
  assert.equal(validatePayload(makeDaily({ ip: '192.0.2.1' }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ message: 'ENOENT /Users/<user>/secret.pdf' }), NOW).ok, false)
})

test('rejects absolute paths, function names, non-source files, and traversal in stack frames', () => {
  assert.equal(validatePayload(makeError({ stack_frames: ['/Users/<user>/ds-bot/src/host/turns.js:10:1'] }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ stack_frames: ['C:\\Users\\<user>\\ds-bot\\src\\host\\turns.js:10:1'] }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ stack_frames: ['ds-bot/../secrets.json:1:1'] }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ stack_frames: ['secretFn @ ds-bot/src/host/turns.js:10:1'] }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ stack_frames: ['ds-bot/src/host/secret.pdf:1:1'] }), NOW).ok, false)
})

test('rejects unknown providers, features, error names, error codes, where values, or out-of-range days', () => {
  assert.equal(validatePayload(makeDaily({ providers_used: ['my-private-llm.corp'] }), NOW).ok, false)
  assert.equal(validatePayload(makeDaily({ features_active: ['private-plugin-name'] }), NOW).ok, false)
  assert.equal(validatePayload(makeDaily({ day: '2026-10-01' }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ where: 'secretgroupname' }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ error_name: 'ArbitraryCustomError' }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ error_code: 'LEAKED_IDENTIFIER' }), NOW).ok, false)
  assert.equal(validatePayload(makeError({ error_code: 'HTTP_502' }), NOW).ok, true)
  assert.equal(validatePayload(makeError({ error_code: 'bot/refused' }), NOW).ok, true)
  assert.equal(validatePayload(makeError({ error_code: 'SERVER' }), NOW).ok, true)
  assert.equal(validatePayload(makeError({ error_code: 'gateway/internal' }), NOW).ok, true)
})

test('handleRequest stores daily and error payloads without touching client IP headers', async () => {
  const db = mockDb()
  const headers = {
    'content-type': 'application/json',
    'cf-connecting-ip': '203.0.113.9',
    'user-agent': 'SecretAgent/1.0',
  }
  const r1 = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
    method: 'POST', headers, body: JSON.stringify(makeDaily()),
  }), { DB: db }, NOW)
  assert.equal(r1.status, 204)

  const r2 = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
    method: 'POST', headers, body: JSON.stringify(makeError()),
  }), { DB: db }, NOW)
  assert.equal(r2.status, 204)

  assert.equal(db.calls.length, 2)
  const serialized = JSON.stringify(db.calls)
  assert.equal(serialized.includes('203.0.113.9'), false)
  assert.equal(serialized.includes('SecretAgent'), false)
})

test('handleRequest enforces size cap, content-type, method, and healthz', async () => {
  const db = mockDb()
  const health = await handleRequest(new Request('https://telemetry.dsbot.app/healthz'), { DB: db }, NOW)
  assert.equal(health.status, 200)

  const oversized = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'a'.repeat(9000) }),
  }), { DB: db }, NOW)
  assert.equal(oversized.status, 413)

  const wrongMethod = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', { method: 'GET' }), { DB: db }, NOW)
  assert.equal(wrongMethod.status, 405)

  const crossOrigin = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify(makeDaily()),
  }), { DB: db }, NOW)
  assert.equal(crossOrigin.status, 403)
})

test('rejected invalid payloads do not exhaust the write rate limit', async () => {
  const db = mockDb()
  const windowNow = NOW + 120_000
  for (let i = 0; i < 650; i++) {
    const bad = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bad: true }),
    }), { DB: db }, windowNow)
    assert.equal(bad.status, 400)
  }
  const ok = await handleRequest(new Request('https://telemetry.dsbot.app/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(makeDaily()),
  }), { DB: db }, windowNow)
  assert.equal(ok.status, 204)
  assert.equal(db.calls.length, 1)
})
