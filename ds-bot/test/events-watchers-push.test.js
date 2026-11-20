import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function setup(eventsConfig = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-events-watch-'))
  const privDir = join(home, 'priv-dir')
  const watchDir = join(home, 'watched-dir')
  mkdirSync(privDir, { recursive: true })
  mkdirSync(watchDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
      w1: { id: 'w1', sessionId: 'w1', name: 'Dev', role: 'Engineer', instructions: '', createdAt: 2 },
      p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', instructions: '', createdAt: 3, private: true, workDir: privDir },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext()
  const delivered = []
  ctx.sessionController = {
    resolveAgent: async (sessionId) => ({
      agent: {
        id: sessionId,
        status: 'idle',
        session: { id: sessionId },
        followup(msg) { delivered.push({ sessionId, msg }) },
        steer(msg) { delivered.push({ sessionId, msg }) },
      },
    }),
  }
  ctx.sessions = { flush: async () => {} }

  const rt = createRuntime(ctx, { home, events: { disableTimers: true, ...eventsConfig } })
  return {
    home,
    watchDir,
    rt,
    delivered,
    async cleanup() {
      await rt.eventPush.stop()
      await rt.ledger.flush()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('GitHub watcher baselines first, honors ETag 304, filters self-triggers, and auto-pauses on 401', async () => {
  let call = 0
  const seenHeaders = []
  const fakeFetch = async (url, init = {}) => {
    seenHeaders.push({ url, etag: init.headers?.['If-None-Match'] })
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'my-bot-user' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    call += 1
    if (call === 1) {
      // First run: existing historical event should only build baseline, never wake Bot.
      return new Response(JSON.stringify([
        { id: '100', type: 'IssueCommentEvent', actor: { login: 'alice' }, payload: { issue: { number: 1, title: 'Old' }, comment: { body: 'Old comment' } } },
      ]), { status: 200, headers: { etag: 'W/"e1"', 'content-type': 'application/json' } })
    }
    if (call === 2) {
      // Second run: ETag matches -> 304 Not Modified -> zero events.
      assert.equal(init.headers['If-None-Match'], 'W/"e1"')
      return new Response(null, { status: 304 })
    }
    if (call === 3) {
      // Third run: one self-authored event (filtered) and one external event (delivered).
      return new Response(JSON.stringify([
        { id: '102', type: 'IssueCommentEvent', actor: { login: 'bob' }, payload: { issue: { number: 9, title: 'Bug' }, comment: { body: 'Repro steps', html_url: 'https://github.com/org/repo/issues/9' } } },
        { id: '101', type: 'IssueCommentEvent', actor: { login: 'my-bot-user' }, payload: { issue: { number: 9, title: 'Bug' }, comment: { body: 'My own reply' } } },
        { id: '100', type: 'IssueCommentEvent', actor: { login: 'alice' }, payload: { issue: { number: 1, title: 'Old' }, comment: { body: 'Old comment' } } },
      ]), { status: 200, headers: { etag: 'W/"e2"', 'content-type': 'application/json' } })
    }
    // Fourth run: token expired -> 401 -> watcher pauses with alert.
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
  }

  const env = setup({ fetch: fakeFetch, githubToken: 'ghp_test_token' })
  try {
    await env.rt.load()
    const watcher = await env.rt.eventWatchers.saveWatcher({
      name: 'Repo PRs',
      kind: 'github',
      target: { kind: 'bot', botId: 'w1' },
      config: { repo: 'org/repo' },
    }, { isUser: true })

    // 1. Baseline check: 0 deliveries.
    const r1 = await env.rt.eventWatchers.checkNow(watcher.id)
    assert.equal(r1.count, 0)
    assert.equal(env.delivered.length, 0)

    // 2. 304 Not Modified: 0 deliveries.
    const r2 = await env.rt.eventWatchers.checkNow(watcher.id)
    assert.equal(r2.count, 0)
    assert.equal(env.delivered.length, 0)

    // 3. New events: self-trigger filtered, external comment delivered with untrusted envelope.
    const r3 = await env.rt.eventWatchers.checkNow(watcher.id)
    assert.equal(r3.count, 1)
    assert.equal(env.delivered.length, 1)
    assert.match(env.delivered[0].msg.content[0].text, /bob/)
    assert.match(env.delivered[0].msg.content[0].text, /untrusted data/)

    // 4. 401 pauses watcher and surfaces alert in Inbox.
    const r4 = await env.rt.eventWatchers.checkNow(watcher.id)
    assert.equal(r4.paused, true)
    const after = env.rt.eventWatchers.listWatchers({ isUser: true }).find(w => w.id === watcher.id)
    assert.equal(after.enabled, false)
    assert.match(after.runtime.pausedReason, /Authentication required/)
    assert.ok(env.rt.inboxView().items.some(i => i.kind === 'watcher_paused' && i.watcherId === watcher.id))
  } finally {
    await env.cleanup()
  }
})

test('HTTP watcher rejects non-HTTPS/loopback URLs and parses RSS feed additions', async () => {
  let feedVersion = 1
  const fakeFetch = async () => {
    const xml = feedVersion === 1
      ? '<rss><channel><item><guid>g1</guid><title>Old Post</title><link>https://example.com/1</link></item></channel></rss>'
      : '<rss><channel><item><guid>g2</guid><title>Fresh Release</title><link>https://example.com/2</link></item><item><guid>g1</guid><title>Old Post</title><link>https://example.com/1</link></item></channel></rss>'
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
  }
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const env = setup({ fetch: fakeFetch, lookup: fakeLookup })
  try {
    await env.rt.load()
    await assert.rejects(() => env.rt.eventWatchers.saveWatcher({
      name: 'Insecure',
      kind: 'http',
      target: { kind: 'bot', botId: 'w1' },
      config: { url: 'http://example.com/feed' },
    }, { isUser: true }), /https:\/\//)
    await assert.rejects(() => env.rt.eventWatchers.saveWatcher({
      name: 'SSRF',
      kind: 'http',
      target: { kind: 'bot', botId: 'w1' },
      config: { url: 'https://127.0.0.1:8080/internal' },
    }, { isUser: true }), /loopback|private/)

    const w = await env.rt.eventWatchers.saveWatcher({
      name: 'Blog RSS',
      kind: 'http',
      target: { kind: 'bot', botId: 'w1' },
      config: { url: 'https://example.com/feed.xml', format: 'rss' },
    }, { isUser: true })

    await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(env.delivered.length, 0)
    feedVersion = 2
    await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(env.delivered.length, 1)
    assert.match(env.delivered[0].msg.content[0].text, /Fresh Release/)
  } finally {
    await env.cleanup()
  }
})

test('Folder watcher detects real file creation/changes and Bot tools cannot create command or private watchers', async () => {
  const env = setup()
  try {
    await env.rt.load()
    writeFileSync(join(env.watchDir, 'existing.txt'), 'before')
    const w = await env.rt.eventWatchers.saveWatcher({
      name: 'Inbox folder',
      kind: 'folder',
      target: { kind: 'bot', botId: 'w1' },
      config: { path: env.watchDir },
    }, { isUser: true })

    await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(env.delivered.length, 0)

    writeFileSync(join(env.watchDir, 'report.md'), 'Q4 earnings')
    await env.rt.eventWatchers.checkNow(w.id)
    assert.equal(env.delivered.length, 1)
    assert.match(env.delivered[0].msg.content[0].text, /New file: report\.md/)

    // Main Bot tool security boundaries: cannot create command watchers (blocked at schema & host layers) or touch private Bots.
    const manage = env.rt.teamTools.find(t => t.name === 'manage_watcher')
    await assert.rejects(() => manage.execute({ action: 'create', name: 'Backdoor', kind: 'command', bot_id: 'w1' }, { agent: { id: 'm1' } }), /INVALID_ARGS|must be one of/)
    await assert.rejects(() => env.rt.eventWatchers.saveWatcher({
      name: 'Backdoor',
      kind: 'command',
      target: { kind: 'bot', botId: 'w1' },
      config: { executable: process.execPath, args: ['-v'] },
    }, { isUser: false, callerBotId: 'm1' }), /Only the user/)

    await assert.rejects(() => manage.execute({ action: 'create', name: 'Spy', kind: 'github', bot_id: 'p1', repo: 'org/repo' }, { agent: { id: 'm1' } }), /private Bot/i)

    // User CAN create a local command watcher and run it.
    const cw = await env.rt.eventWatchers.saveWatcher({
      name: 'Node version',
      kind: 'command',
      target: { kind: 'bot', botId: 'w1' },
      config: { executable: process.execPath, args: ['-e', 'console.log("ok-1")'] },
    }, { isUser: true })
    await env.rt.eventWatchers.checkNow(cw.id)
    assert.equal(env.delivered.length, 1) // baseline only
  } finally {
    await env.cleanup()
  }
})

test('Local 127.0.0.1 Push gateway (/v1/events) enforces Bearer auth, rejects query tokens, hides private Bots, and delivers', async () => {
  const env = setup()
  try {
    await env.rt.load()
    const status = await env.rt.eventPush.updateConfig({ enabled: true, port: 0 })
    assert.equal(status.listening, true)
    assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/events$/)

    const created = env.rt.eventPush.createToken({ name: 'Market monitor', scopes: ['events:write'] })
    assert.ok(created.token.startsWith('dsb_live_'))

    // Token file stores only salted hash, never plaintext.
    const tokenFile = readFileSync(join(env.home, 'api-tokens.json'), 'utf8')
    assert.equal(tokenFile.includes(created.token), false)

    // Discovery file carries URL without any token.
    const endpointFile = readFileSync(join(env.home, 'api-endpoint.json'), 'utf8')
    assert.equal(endpointFile.includes(created.token), false)
    assert.equal(JSON.parse(endpointFile).eventsUrl, status.url)

    // Missing auth -> 401
    const rNoAuth = await fetch(status.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'hi' }) })
    assert.equal(rNoAuth.status, 401)

    // Query parameter token -> 401 rejected
    const rQuery = await fetch(`${status.url}?token=${encodeURIComponent(created.token)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'hi' }),
    })
    assert.equal(rQuery.status, 401)

    // Private Bot target -> 404 (never reveals existence)
    const rPriv = await fetch(status.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'p1', summary: 'probe private' }),
    })
    assert.equal(rPriv.status, 404)

    // Valid event to regular Bot -> 202 and delivered with untrusted envelope
    const rOk = await fetch(status.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'w1', sourceId: 'market', threadKey: 'stock:NVDA', dedupeKey: 'nvda-1', summary: 'NVDA earnings out', body: 'EPS beat by 12%' }),
    })
    assert.equal(rOk.status, 202)
    const okJson = await rOk.json()
    assert.equal(okJson.ok, true)
    assert.equal(okJson.deduplicated, false)
    assert.equal(env.delivered.length, 1)
    assert.equal(env.delivered[0].sessionId, 'w1')
    assert.match(env.delivered[0].msg.content[0].text, /NVDA earnings out/)
    assert.match(env.delivered[0].msg.content[0].text, /untrusted data/)

    // Revoked token -> 401
    env.rt.eventPush.revokeToken(created.keyId)
    const rRevoked = await fetch(status.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'w1', summary: 'after revoke' }),
    })
    assert.equal(rRevoked.status, 401)
  } finally {
    await env.cleanup()
  }
})
