import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installTelemetry, sanitizeStack, envDisabledReason, botCountBucket, turnsBucket, normalizeProvider, normalizeWhere } from '../src/host/telemetry.js'
import { validatePayload } from '../../telemetry/src/validate.js'

function makeRt(home, opts = {}) {
  const listeners = new Map()
  const exclusions = []
  const sent = []
  const disposers = []
  const ctx = {
    sessions: { get: id => opts.sessions?.get(id) },
    get: name => (name === 'profileContext' ? { name: 'ds-bot' } : undefined),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    inject(deps, fn) {
      if (deps.includes('sessionLogDeepSeek')) {
        fn({
          sessionLogDeepSeek: {
            registerExclusion(pred) {
              exclusions.push(pred)
              return async () => {}
            },
          },
        })
      }
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home,
    config: {
      telemetryUrl: 'http://127.0.0.1:8787/v1/collect',
      telemetryNow: opts.now ?? (() => Date.parse('2026-11-25T10:00:00Z')),
      telemetryFetch: async (_url, init) => {
        const payload = JSON.parse(init.body)
        sent.push(payload)
        return { ok: true, status: 204 }
      },
      ...opts.config,
    },
    state: {
      bots: {
        pub1: { id: 'pub1', name: 'SecretBotName', model: 'deepseek-official/deepseek-chat', private: false },
        pub2: { id: 'pub2', name: 'CustomBot', model: 'my-corp-llm/internal-model', private: false },
        priv1: { id: 'priv1', name: 'PrivateDiary', model: 'anthropic/claude-opus', private: true, segments: [{ sessionId: 'priv-seg-1' }] },
      },
      rooms: { r1: { id: 'r1', name: 'SecretRoom', members: ['pub1', 'pub2'] } },
      prefs: { theme: 'deepseek', layout: 'bubble' },
      privateArchives: [{ id: 'archived-priv', sessionIds: ['archived-sess-1'] }],
      capabilities: { items: {} },
    },
    isPrivate: id => id === 'priv1',
    selfOf: sid => (sid === 'priv1' || sid === 'priv-seg-1' ? 'priv1' : sid === 'pub1' ? 'pub1' : undefined),
    chatOf: id => id,
    roomOf: sid => (sid === 'r1' ? { id: 'r1' } : undefined),
    readOnly: () => opts.readOnly,
    redactSecrets: text => String(text).replaceAll('super-secret-token-999', '[secret:DEMO]'),
    uiLocale: () => 'zh-CN',
    connectorsView: () => [{ id: 'github', connected: true }],
    imView: () => ({ connections: [{ platform: 'telegram' }, { platform: 'unknown-custom' }] }),
    computerView: () => ({ enabled: false }),
    phoneView: () => ({ paired: false, devices: [] }),
    apiView: () => ({ enabled: false }),
    secretsView: () => [{ name: 'DEMO' }],
    schedulesView: () => [],
    pluginsSummary: () => ({ installed: 0 }),
    browserEnabled: true,
    memoryEnabled: true,
  }
  installTelemetry(rt)
  return {
    rt,
    sent,
    exclusions,
    listeners,
    async dispose() {
      for (const fn of disposers) await fn()
    },
  }
}

test('sends nothing before noticeAccepted, then sends valid daily payload accepted by worker validator', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tel-'))
  const now = Date.parse('2026-11-25T10:00:00Z')
  const env = makeRt(home, { now: () => now })
  try {
    assert.equal(env.rt.telemetry.shouldPromptNotice(), true)
    assert.equal(await env.rt.telemetry.maybeSendDaily(), false)
    assert.equal(env.sent.length, 0)

    // Accepting notice with usage=true sends one daily summary.
    await env.rt.telemetry.update({ noticeAccepted: true, usage: true, errors: false })
    // Give async maybeSendDaily a tick to settle.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(env.sent.length, 1)

    const payload = env.sent[0]
    // Must pass the real Cloudflare Worker schema validator!
    const validated = validatePayload(payload, now)
    assert.equal(validated.ok, true, validated.error)

    // Private Bot (priv1, anthropic) must be completely excluded; custom provider mapped to 'custom'.
    assert.equal(payload.bot_count_bucket, '2-3')
    assert.deepEqual(payload.providers_used, ['custom', 'deepseek-official'])
    assert.deepEqual(payload.im_platforms, ['telegram'])
    assert.equal(JSON.stringify(payload).includes('SecretBotName'), false)
    assert.equal(JSON.stringify(payload).includes('PrivateDiary'), false)
    assert.equal(JSON.stringify(payload).includes('my-corp-llm'), false)

    // Same UTC day does not send a second daily ping.
    assert.equal(await env.rt.telemetry.maybeSendDaily(), false)
    assert.equal(env.sent.length, 1)

    // Recently sent JSON is persisted locally for user inspection.
    const status = env.rt.telemetry.status()
    assert.equal(status.recentSent.length, 1)
    assert.equal(status.noticeAccepted, true)
    assert.equal(env.rt.telemetry.shouldPromptNotice(), false)
    const onDisk = JSON.parse(readFileSync(join(home, 'telemetry.json'), 'utf8'))
    assert.equal(onDisk.noticeAccepted, true)
  } finally {
    await env.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('sanitizeStack strips absolute paths, drive letters, and third-party frames', () => {
  const stack = [
    'TypeError: ENOENT /Users/<user>/Confidential/contract.pdf',
    '    at runTurn (/Users/<user>/Work/DS-Bot/ds-bot/src/host/turns.js:412:15)',
    '    at winFn (C:\\Users\\<user>\\app\\src\\main.mjs:99:4)',
    '    at thirdParty (/Users/<user>/my-private-plugin/index.js:12:3)',
    '    at node:internal/timers:512:7',
    '    at file:///opt/ds-bot/ds-bot/src/host/groups.js?v=1:88:2',
  ].join('\n')
  const frames = sanitizeStack(stack)
  assert.deepEqual(frames, [
    'runTurn @ ds-bot/src/host/turns.js:412:15',
    'winFn @ app/src/main.mjs:99:4',
    'ds-bot/src/host/groups.js:88:2',
  ])
})

test('error telemetry is opt-in, omits raw error.message, excludes private Bots, and passes worker validator', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tel-err-'))
  const now = Date.parse('2026-11-25T10:00:00Z')
  const env = makeRt(home, { now: () => now })
  try {
    // Notice accepted with errors=false -> nothing sent.
    await env.rt.telemetry.update({ noticeAccepted: true, usage: false, errors: false })
    assert.equal(await env.rt.telemetry.noteError({ source: 'host', errorName: 'TypeError', code: 'ENOENT', where: 'turns', stack: 'at f (/x/ds-bot/src/host/turns.js:10:2)' }), false)
    assert.equal(env.sent.length, 0)

    // Enable error reporting.
    await env.rt.telemetry.update({ errors: true })

    // Private Bot error is always dropped.
    assert.equal(await env.rt.telemetry.noteError({ source: 'turn', errorName: 'TypeError', botId: 'priv1', stack: 'at f (/x/ds-bot/src/host/turns.js:10:2)' }), false)
    assert.equal(await env.rt.telemetry.noteError({ source: 'turn', errorName: 'TypeError', sessionId: 'priv-seg-1', stack: 'at f (/x/ds-bot/src/host/turns.js:10:2)' }), false)
    assert.equal(env.sent.length, 0)

    // Public error is sent once per fingerprint per day, strips group title from `where`, and passes worker validator.
    const ok1 = await env.rt.telemetry.noteError({
      source: 'turn',
      errorName: 'TypeError',
      code: 'ENOENT',
      where: 'group "Confidential Boardroom"',
      stack: 'TypeError: secret filename\n    at run (/Users/<user>/repo/ds-bot/src/host/turns.js:42:9)',
    })
    assert.equal(ok1, true)
    assert.equal(env.sent.length, 1)
    assert.equal(validatePayload(env.sent[0], now).ok, true)
    assert.equal(env.sent[0].where, 'group-chat')
    assert.equal('message' in env.sent[0], false)
    assert.equal(JSON.stringify(env.sent[0]).includes('secret filename'), false)
    assert.equal(JSON.stringify(env.sent[0]).includes('Confidential'), false)

    // Duplicate same-day fingerprint is deduplicated.
    const ok2 = await env.rt.telemetry.noteError({
      source: 'turn',
      errorName: 'TypeError',
      code: 'ENOENT',
      where: 'group "Another Secret Group"',
      stack: 'at run (/Users/<user>/repo/ds-bot/src/host/turns.js:42:9)',
    })
    assert.equal(ok2, false)
    assert.equal(env.sent.length, 1)
  } finally {
    await env.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH upstream safeguards block session-log-deepseek by default and permanently exclude private Bots', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tel-dsh-'))
  const env = makeRt(home)
  try {
    assert.equal(env.exclusions.length, 1)
    const excluded = env.exclusions[0]

    // Default off: both public and private sessions are excluded.
    assert.equal(excluded({ sessionId: 'pub1' }), true)
    assert.equal(excluded({ sessionId: 'priv1' }), true)
    assert.equal(excluded({ sessionId: 'priv-seg-1' }), true)
    assert.equal(excluded({ sessionId: 'archived-sess-1' }), true)

    // When user explicitly enables dshSessionLog, public is allowed while private stays excluded.
    await env.rt.telemetry.update({ dshSessionLog: true })
    assert.equal(excluded({ sessionId: 'pub1' }), false)
    assert.equal(excluded({ sessionId: 'priv1' }), true)
    assert.equal(excluded({ sessionId: 'priv-seg-1' }), true)
    assert.equal(excluded({ sessionId: 'archived-sess-1' }), true)

    // DSH session-telemetry/record listener withholds by default, withholds private Bots, and redacts secrets when enabled.
    const recordListener = env.listeners.get('session-telemetry/record')?.[0]
    assert.ok(recordListener)
    const sample = {
      sourceEvent: { sessionId: 'pub1', envelope: {} },
      attributes: { 'session.id': 'pub1', 'session.cwd': '/Users/<user>/secret-dir' },
      body: { text: 'token is super-secret-token-999' },
    }
    const blocked = recordListener(sample, () => sample)
    assert.equal(blocked.sourceEvent, undefined)

    await env.rt.telemetry.update({ dshFeedbackTelemetry: true })
    const privSample = { ...sample, sourceEvent: { sessionId: 'priv1', envelope: {} }, attributes: { 'session.id': 'priv1' } }
    const privBlocked = recordListener(privSample, () => privSample)
    assert.equal(privBlocked.sourceEvent, undefined)

    // Real Cordis waterfall `next()` takes zero arguments and returns the original record.
    const scrubbed = recordListener(sample, () => sample)
    assert.ok(scrubbed.sourceEvent)
    assert.equal(scrubbed.attributes['session.cwd'], '~')
    assert.equal(scrubbed.body.text.includes('super-secret-token-999'), false)
    assert.equal(scrubbed.body.text.includes('[secret:DEMO]'), true)
  } finally {
    await env.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('anonId rotates automatically across UTC months and can be manually reset', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-tel-rot-'))
  let clock = Date.parse('2026-11-30T23:59:00Z')
  const env = makeRt(home, { now: () => clock })
  try {
    const idNov = env.rt.telemetry.status().anonId
    clock = Date.parse('2026-12-01T00:01:00Z')
    const idDec = env.rt.telemetry.status().anonId
    assert.notEqual(idDec, idNov)
    assert.equal(env.rt.telemetry.status().anonMonth, '2026-12')

    const manual = (await env.rt.telemetry.resetId()).anonId
    assert.notEqual(manual, idDec)
  } finally {
    await env.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('envDisabledReason and bucketing helpers behave predictably', () => {
  assert.equal(envDisabledReason({}), null)
  assert.equal(envDisabledReason({ DS_BOT_TELEMETRY_DISABLED: '1' }), 'DS_BOT_TELEMETRY_DISABLED')
  assert.equal(envDisabledReason({ DS_BOT_TELEMETRY_DISABLED: '0' }), 'DS_BOT_TELEMETRY_DISABLED')
  assert.equal(envDisabledReason({ DO_NOT_TRACK: '1' }), 'DO_NOT_TRACK')
  assert.equal(envDisabledReason({ DO_NOT_TRACK: 'true' }), 'DO_NOT_TRACK')
  assert.equal(botCountBucket(0), '0')
  assert.equal(botCountBucket(1), '1')
  assert.equal(botCountBucket(3), '2-3')
  assert.equal(botCountBucket(7), '4-7')
  assert.equal(botCountBucket(8), '8+')
  assert.equal(turnsBucket(0), '0')
  assert.equal(turnsBucket(5), '1-5')
  assert.equal(turnsBucket(51), '51+')
  assert.equal(normalizeProvider('openai/gpt-5'), 'openai')
  assert.equal(normalizeProvider('private-host/my-model'), 'custom')
  assert.equal(normalizeWhere('group "My Secret Room"'), 'group-chat')
  assert.equal(normalizeWhere('own chat'), 'own-chat')
  assert.equal(normalizeWhere('overlay.settings'), 'overlay')
  assert.equal(normalizeWhere('turns'), 'turns')
  assert.equal(normalizeWhere('secret-custom-name'), undefined)
})
