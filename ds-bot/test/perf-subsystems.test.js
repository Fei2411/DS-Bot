import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { createSession } from '../src/host/browser/session.js'
import { runIsolatedScript } from '../src/host/browser/script-runner.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'
import { lineSplitter } from '../src/host/local-agents/lines.js'
import { terminateChild } from '../src/host/local-agents/discover.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import { install as installMail } from '../src/host/connectors/mail/index.js'
import { connectGmail, connectImap } from '../src/host/connectors/mail/transport.js'
import { createGateway } from '../src/host/connectors/gateway.js'
import qq from '../src/host/im/platforms/qq.js'
import slack from '../src/host/im/platforms/slack.js'
import weixin from '../src/host/im/platforms/weixin.js'
import discord from '../src/host/im/platforms/discord.js'
import wecom from '../src/host/im/platforms/wecom.js'
import { install as installIm } from '../src/host/im/index.js'
import { shrink } from '../src/host/preview-worker.js'
import { previewImage } from '../src/host/preview.js'
import { createCatalogManager, hasExecutable } from '../src/host/plugins/catalog.js'
import { defaultRegistryUrl } from '../src/host/plugins/registry-url.js'
import { install as installDeepseekServices } from '../src/host/deepseek-services.js'
import { createAutoSearchProvider } from '../web-search.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { fakeWsServer } from './fake-ws.js'
import { PNG } from 'pngjs'
import { WebSocketServer } from 'ws'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (fn, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const val = await fn()
    if (val !== undefined && val !== false) return val
    await delay(25)
  }
  return undefined
}

// ============================================================================
// 1. Browser Subsystem
// ============================================================================

test('browser mount reclaims idle standalone sessions, pauses during hold, and enforces LRU maxSessions', async () => {
  const closed = []
  let activeHold = null
  const registered = new Map()
  const ctx = {
    effect: () => () => {},
    tools: {
      register: (def) => {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
  const openSession = async ({ botId }) => ({
    botId,
    frame: async () => ({ image: 'img', url: `https://${botId}.test`, title: botId }),
    close: async () => { closed.push(botId) },
  })
  const api = {}
  mountBrowserPlugin(ctx, {
    toolDefs: [{
      name: 'browser_ping',
      description: 'ping',
      parameters: {},
      needsBrowser: true,
      execute: async (_args, { session }) => `ok:${session.botId}`,
    }],
    defineTool: spec => spec,
    keyOf: exec => exec.agent.id,
    profileRoot: tmpdir(),
    idleTimeoutMs: 60,
    maxSessions: 2,
    getHold: botId => (activeHold === botId ? { reason: 'login' } : null),
    openSession,
    api,
  })
  try {
    const ping = registered.get('browser_ping')
    // Hold prevents idle reclamation on bot-1.
    activeHold = 'bot-1'
    assert.equal(await ping.execute({}, { agent: { id: 'bot-1' } }), 'ok:bot-1')
    await delay(100)
    assert.deepEqual(closed, [], 'held session must not be reclaimed while idle')

    // Opening bot-2 and bot-3 exceeds maxSessions=2: bot-1 is held so bot-2 (LRU idle) is evicted.
    assert.equal(await ping.execute({}, { agent: { id: 'bot-2' } }), 'ok:bot-2')
    assert.equal(await ping.execute({}, { agent: { id: 'bot-3' } }), 'ok:bot-3')
    assert.deepEqual(closed, ['bot-2'], 'LRU cap evicts idle unheld session')

    // Release hold on bot-1 and verify idle timeout reclaims both remaining standalone sessions.
    activeHold = null
    await delay(130)
    assert.ok(closed.includes('bot-1'), 'bot-1 reclaimed after hold released')
    assert.ok(closed.includes('bot-3'), 'bot-3 reclaimed after idle timeout')
  } finally {
    await api.dispose()
  }
})

test('browser mount respects session.hold when standalone caller omits getHold', async () => {
  const closed = []
  const openedByBot = new Map()
  const registered = new Map()
  const ctx = {
    effect: () => () => {},
    tools: {
      register: (def) => {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
  const openSession = async ({ botId }) => {
    const session = {
      botId,
      hold: null,
      close: async () => { closed.push(botId) },
    }
    openedByBot.set(botId, session)
    return session
  }
  const api = {}
  mountBrowserPlugin(ctx, {
    toolDefs: [{
      name: 'browser_ping',
      description: 'ping',
      parameters: {},
      needsBrowser: true,
      execute: async (_args, { session }) => `ok:${session.botId}`,
    }],
    defineTool: spec => spec,
    keyOf: exec => exec.agent.id,
    profileRoot: tmpdir(),
    idleTimeoutMs: 60,
    maxSessions: 1,
    openSession,
    api,
  })
  try {
    const ping = registered.get('browser_ping')
    await ping.execute({}, { agent: { id: 'bot-1' } })
    openedByBot.get('bot-1').hold = { reason: 'login' }
    await delay(100)
    assert.deepEqual(closed, [], 'standalone session with session.hold must not be evicted on idle')
    await ping.execute({}, { agent: { id: 'bot-2' } })
    assert.deepEqual(closed, [], 'standalone session with session.hold must not be evicted by maxSessions')
    openedByBot.get('bot-1').hold = null
    await delay(130)
    assert.ok(closed.includes('bot-1'), 'standalone session reclaimed once session.hold clears')
  } finally {
    await api.dispose()
  }
})

test('browser createSession.close removes context and browser event listeners', async () => {
  const browser = new EventEmitter()
  browser.close = async () => {}
  const context = new EventEmitter()
  context.pages = () => []
  context.cookies = async () => []
  context.close = async () => {}
  const page = new EventEmitter()
  page.isClosed = () => false
  page.url = () => 'about:blank'

  const session = createSession({ context, browser, page, botId: 'b1' })
  assert.equal(context.listenerCount('close'), 1)
  assert.equal(context.listenerCount('page'), 1)
  assert.equal(browser.listenerCount('disconnected'), 1)
  await session.close()
  assert.equal(context.listenerCount('close'), 0)
  assert.equal(context.listenerCount('page'), 0)
  assert.equal(browser.listenerCount('disconnected'), 0)
})

test('runIsolatedScript aborts promptly on signal and clearTimeout cancels callback and host timer', async () => {
  // 1. AbortSignal kills hung script promptly.
  const ac = new AbortController()
  const started = Date.now()
  setTimeout(() => ac.abort(new Error('turn stopped')), 80)
  await assert.rejects(
    () => runIsolatedScript('await new Promise(r => setTimeout(r, 30000)); return "late"', {}, { timeout: 10_000, signal: ac.signal }),
    /aborted|turn stopped/i,
  )
  assert.ok(Date.now() - started < 3000, 'aborted script should exit promptly')

  // 2. clearTimeout cancels host timer and guarantees callback does NOT fire.
  let fired = false
  const t0 = Date.now()
  const result = await runIsolatedScript(
    'let hit = false; const id = setTimeout(() => { hit = true; mark() }, 40); clearTimeout(id); await new Promise(r => setTimeout(r, 120)); return hit ? "fired" : "cancelled"',
    { mark: async () => { fired = true } },
    { timeout: 5000 },
  )
  assert.equal(result, 'cancelled')
  assert.equal(fired, false, 'cancelled timer callback must NOT fire')
  assert.ok(Date.now() - t0 < 3000, 'clearTimeout should finish promptly')
})

// ============================================================================
// 2. Local Agents
// ============================================================================

test('ClaudeSession.kill captures child before clearing so SIGKILL escalation fires on SIGTERM-ignoring process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-kill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const holdScript = 'if (process.platform !== "win32") process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'

  const engine = new ClaudeEngine(
    'local-claude-code',
    { id: 'claude-code', kind: 'claude', command: process.execPath, args: ['-e', holdScript, '--'] },
    { findExecutable: () => process.execPath },
  )
  const session = await engine.open('s1', { cwd: dir })
  const realChild = session.child
  assert.ok(realChild && typeof realChild.pid === 'number', 'real child spawned with pid')
  const exited = new Promise((resolve) => {
    if (realChild.exitCode !== null || realChild.signalCode !== null) resolve()
    else realChild.once('exit', resolve)
  })
  const kills = []
  const origKill = realChild.kill.bind(realChild)
  realChild.kill = (sig) => {
    kills.push(sig)
    if (sig === 'SIGKILL') origKill(sig)
    return true
  }
  const realSetTimeout = globalThis.setTimeout
  let sigkillCallback
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 5_000) {
      sigkillCallback = () => fn(...args)
      return { unref() {} }
    }
    return realSetTimeout(fn, ms, ...args)
  }
  try {
    session.kill()
    assert.equal(session.child, undefined)
    if (process.platform === 'win32') {
      await exited
    } else {
      assert.deepEqual(kills, ['SIGTERM'])
      assert.equal(typeof sigkillCallback, 'function')
      sigkillCallback()
      assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'])
    }
  } finally {
    globalThis.setTimeout = realSetTimeout
    try { origKill('SIGKILL') } catch {}
    await exited
  }
  await engine.close()
  assert.equal(engine.sessions.size, 0)
})

test('terminateChild clears SIGKILL timer on exit and error and skips unspawned children', () => {
  for (const eventName of ['exit', 'error']) {
    const child = new EventEmitter()
    child.pid = 4242
    child.exitCode = null
    child.signalCode = null
    const signals = []
    child.kill = sig => signals.push(sig)
    let cleared = false
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const token = { unref() {} }
    globalThis.setTimeout = () => token
    globalThis.clearTimeout = (id) => { if (id === token) cleared = true }
    try {
      terminateChild(child, { platform: 'linux' })
      assert.deepEqual(signals, ['SIGTERM'])
      if (eventName === 'exit') child.emit('exit', 0, null)
      else child.emit('error', new Error('spawn ENOENT'))
      assert.equal(cleared, true, `SIGKILL timer must clear on ${eventName}`)
      assert.equal(child.listenerCount('exit'), 0, `exit listener cleaned after ${eventName}`)
      assert.equal(child.listenerCount('error'), 0, `error listener cleaned after ${eventName}`)
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  }

  // Unspawned child (pid === undefined) must not signal or arm a timer.
  const unspawned = new EventEmitter()
  unspawned.exitCode = null
  unspawned.signalCode = null
  let killCalled = false
  unspawned.kill = () => { killCalled = true }
  terminateChild(unspawned)
  assert.equal(killCalled, false)
  assert.equal(unspawned.listenerCount('exit'), 0)
  assert.equal(unspawned.listenerCount('error'), 0)
})

test('lineSplitter drops oversized newline-less chunks safely and recovers at next newline', () => {
  const lines = []
  const push = lineSplitter(line => lines.push(line), { maxLineChars: 16 })
  push('x'.repeat(20))
  push('y'.repeat(10))
  push('\nok\n')
  assert.deepEqual(lines, ['ok'])
})

test('AcpEngine evicts terminal toolCalls, caps cache, cleans maps in forget(), and closes peer', async () => {
  let peerClosed = false
  const engine = new AcpEngine('local-acp-fake', { id: 'acp-fake', kind: 'acp', command: 'acp-fake', args: [] }, { findExecutable: () => 'acp-fake' })
  engine.peer = {
    close: () => { peerClosed = true },
    notify: () => {},
    request: async () => ({}),
  }
  const session = engine.createSession('s1')
  session.acpSessionId = 'acp-1'
  engine.sessions.set('s1', session)
  engine.commands.set('acp-1', ['cmd'])
  engine.sessionEfforts.set('acp-1', 'high')

  // Feed 130 active tool_call updates; cache must stay <= 100.
  for (let i = 0; i < 130; i += 1) {
    engine.onNotice('session/update', {
      sessionId: 'acp-1',
      update: { sessionUpdate: 'tool_call', toolCallId: `tc-${i}`, title: 'Write', rawInput: { content: 'a'.repeat(50) } },
    })
  }
  assert.ok(session.toolCalls.size <= 100, `toolCalls capped at 100, got ${session.toolCalls.size}`)

  // Completing a tool_call evicts its heavy payload from toolCalls.
  engine.onNotice('session/update', {
    sessionId: 'acp-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-129', status: 'completed' },
  })
  assert.equal(session.toolCalls.has('tc-129'), false)

  engine.forget('s1')
  assert.equal(engine.commands.has('acp-1'), false)
  assert.equal(engine.sessionEfforts.has('acp-1'), false)

  await engine.close()
  assert.equal(peerClosed, true)
})

test('CodexEngine rejects approval requests for unknown threads and closes peer on close()', async () => {
  let peerClosed = false
  const engine = new CodexEngine('local-codex', { id: 'codex', kind: 'codex', command: 'codex' }, { findExecutable: () => 'codex' })
  engine.peer = { close: () => { peerClosed = true } }
  await assert.rejects(
    () => engine.onRequest('item/commandExecution/requestApproval', { threadId: 'unknown-thread', command: 'ls' }),
    { code: -32603, message: 'unknown thread' },
  )
  await engine.close()
  assert.equal(peerClosed, true)
})

test('LoopbackMcp cleans calls on client disconnect and flushes final error SSE frame on close()', async (t) => {
  let resolveCall
  const mcp = new LoopbackMcp(
    () => [{ name: 'slow', description: 'slow', parameters: {} }],
    () => new Promise(r => { resolveCall = r }),
  )
  await mcp.listen()
  t.after(() => mcp.close())

  // 1. Client disconnect removes entry from mcp.calls immediately.
  const ac = new AbortController()
  const reqPromise = fetch(mcp.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
    signal: ac.signal,
  }).catch(() => {})
  await until(() => mcp.calls.size === 1)
  assert.equal(mcp.calls.size, 1, 'in-flight call must be tracked')
  ac.abort()
  await reqPromise
  await until(() => mcp.calls.size === 0)
  assert.equal(mcp.calls.size, 0, 'aborted client must clear mcp.calls entry')
  resolveCall?.({ text: 'late', isError: false })

  // 2. close() flushes final error SSE frame to an active caller before closing sockets.
  const activeRespP = fetch(mcp.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
  })
  await until(() => mcp.calls.size === 1)
  const t0 = Date.now()
  mcp.close()
  const activeResp = await activeRespP
  assert.equal(activeResp.status, 200)
  const sseBody = await activeResp.text()
  assert.match(sseBody, /the session closed/, 'close() must allow final error SSE frame to flush')
  assert.equal(mcp.calls.size, 0)
  assert.ok(Date.now() - t0 < 2000)
})

test('mcp-stdio delivers response for piped one-shot stdin request after immediate stdin close', async (t) => {
  const mcp = new LoopbackMcp(
    () => [{ name: 'ping_tool', description: 'ping', parameters: { type: 'object', properties: {} } }],
    async () => ({ text: 'pong', isError: false }),
  )
  await mcp.listen()
  t.after(() => mcp.close())

  const bridgePath = fileURLToPath(new URL('../src/host/local-agents/mcp-stdio.js', import.meta.url))
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, DSBOT_MCP_URL: mcp.url, DSBOT_MCP_TOKEN: mcp.token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`)

  const [code] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)))
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout.trim())
  assert.equal(parsed.id, 7)
  assert.ok(parsed.result.tools.some(tool => tool.name === 'ping_tool'))
})

test('LocalAgentAdapter cleans up dsb-probe temp dir, preserves suspended sessions, and handles idleCloseMs <= 0', async (t) => {
  let probeDirSeen
  let closedCount = 0
  const fakeEngine = {
    listModels: async ({ cwd }) => {
      probeDirSeen = cwd
      return [{ id: 'm1', name: 'M1' }]
    },
    close: async () => { closedCount += 1 },
    forget: async () => {},
  }
  const adapter = new LocalAgentAdapter({
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'fake', args: [] }],
    spawnEngine: () => fakeEngine,
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    record: () => undefined,
    dropRecord: () => {},
    idleCloseMs: 40,
  })
  t.after(() => adapter.dispose())

  const models = await adapter.probeModels('local-acp-fake')
  assert.ok(models.some(m => m.id === 'm1'), 'probed model m1 should be listed')
  assert.ok(probeDirSeen && probeDirSeen.includes('dsb-probe-'))
  assert.equal(existsSync(probeDirSeen), false, 'dsb-probe-* temp dir must be cleaned in finally')

  // Suspended session must survive idle timer without being closed.
  closedCount = 0
  const live = await adapter.liveFor({ sessionId: 'sess-1', provider: 'local-acp-fake', model: 'default' }, 'default')
  live.state = 'suspended'
  live.push({ type: 'status', text: 'waiting approval' })
  await delay(100)
  assert.equal(live.dead, false, 'suspended session must not be torn down by idle timer')
  assert.equal(closedCount, 0)

  // Once idle, timer reclaims it cleanly.
  live.state = 'idle'
  await delay(100)
  assert.equal(live.dead, true, 'idle session reclaimed after returning from suspended state')
  assert.equal(closedCount, 1)

  // idleCloseMs <= 0 must never schedule an idle timer or tight-loop on suspended sessions.
  const noIdleAdapter = new LocalAgentAdapter({
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'fake', args: [] }],
    spawnEngine: () => fakeEngine,
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    record: () => undefined,
    dropRecord: () => {},
    idleCloseMs: 0,
  })
  t.after(() => noIdleAdapter.dispose())
  const noIdleLive = await noIdleAdapter.liveFor({ sessionId: 'sess-0', provider: 'local-acp-fake', model: 'default' }, 'default')
  noIdleLive.state = 'suspended'
  noIdleLive.push({ type: 'status', text: 'waiting' })
  assert.equal(noIdleLive.idle, undefined, 'idleCloseMs <= 0 must not arm idle timer')
})

test('local-agents install deduplicates concurrent probeVersions and aborts superseded force probeSignIns', async (t) => {
  const binDir = mkdtempSync(join(tmpdir(), 'dsb-fake-cli-'))
  t.after(() => rmSync(binDir, { recursive: true, force: true }))
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\necho 1.0.0\r\n')
  } else {
    const fakeClaude = join(binDir, 'claude')
    writeFileSync(fakeClaude, '#!/bin/sh\necho 1.0.0\n')
    chmodSync(fakeClaude, 0o755)
  }
  const origPath = process.env.PATH
  process.env.PATH = `${binDir}${delimiter}${origPath ?? ''}`
  t.after(() => { process.env.PATH = origPath })

  let versionCalls = 0
  let nowMs = 1_000_000
  const seenSignals = []
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const rt = {
    ctx,
    config: {},
    state: { prefs: {}, bots: {}, rooms: {} },
    load: async () => {},
    save: async () => {},
    warn: () => {},
    botOf: () => undefined,
    selfOf: () => undefined,
    catalog: async () => [],
  }
  installLocalAgents(rt, {
    now: () => nowMs,
    probeVersion: async () => {
      versionCalls += 1
      await delay(30)
      return undefined // failure gets cached briefly
    },
    probeSignIn: async (_exe, _check, { signal }) => {
      seenSignals.push(signal)
      await delay(80)
      return true
    },
  })

  // Concurrent local-agents scans deduplicate version probes.
  const [listA] = await Promise.all([
    rt.localAgentsEndpoint('local-agents', {}),
    rt.localAgentsEndpoint('local-agents', {}),
  ])
  const afterFirst = versionCalls
  assert.ok(afterFirst >= 1, 'should have probed installed fake claude')
  const claudeEntry = listA.detected.find(entry => entry.route === 'local-claude-code')
  assert.equal(claudeEntry?.signedIn, true, 'real probeSignIn boolean contract should be reflected')

  // Within failure cache TTL (30s), another call does not re-probe version.
  await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(versionCalls, afterFirst, 'version failure should be briefly cached')

  // Superseded force sign-in probes abort the earlier signal.
  nowMs += 31_000
  const beforeRefresh = seenSignals.length
  const p1 = rt.localAgentsEndpoint('local-agent-refresh', {})
  await delay(15)
  const p2 = rt.localAgentsEndpoint('local-agent-refresh', {})
  await Promise.all([p1, p2])
  const refreshSignals = seenSignals.slice(beforeRefresh)
  assert.ok(refreshSignals.length >= 2)
  assert.equal(refreshSignals[0].aborted, true, 'superseded force sign-in probe must abort')
})

// ============================================================================
// 3. Connectors
// ============================================================================

test('connectors/mail Google OAuth callback delivers complete 200 HTML without TCP RST and dispose aborts in-flight beginGoogle', async (t) => {
  const prevId = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
  const prevSecret = process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = 'google-client-id'
  process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = 'google-client-secret'
  t.after(() => {
    if (prevId === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID = prevId
    if (prevSecret === undefined) delete process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET
    else process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET = prevSecret
  })

  const writtenSecrets = new Map()
  let savedCount = 0
  const discoveryDoc = {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  }
  const rt = {
    state: {},
    config: {
      mail: {
        fetch: async (url) => {
          const href = String(url)
          if (href.includes('.well-known/openid-configuration')) {
            return new Response(JSON.stringify(discoveryDoc), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (href === discoveryDoc.token_endpoint) {
            return new Response(JSON.stringify({ access_token: 'tok-access', refresh_token: 'tok-refresh', token_type: 'Bearer' }), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          }
          return new Response('not found', { status: 404 })
        },
      },
    },
    loadSecrets: async () => {},
    save: async () => { savedCount += 1 },
    warn: () => {},
    secretValue: name => writtenSecrets.get(name),
    addTeamTool: () => {},
    removeTeamTool: () => {},
    botOf: () => undefined,
  }
  const mail = installMail(rt, {
    secrets: { writeSecret: async (name, value) => { writtenSecrets.set(name, value) } },
    reason: err => String(err?.message ?? err),
  })
  t.after(() => mail.dispose())

  const view = await mail.endpoint('mail-account-add', { google: true, address: 'alice@example.com' })
  assert.equal(view.pending?.length, 1)
  const authUrl = new URL(view.pending[0].url)
  const redirectUri = authUrl.searchParams.get('redirect_uri')
  const stateParam = authUrl.searchParams.get('state')
  assert.ok(redirectUri && stateParam)

  // Real loopback callback must deliver complete 200 HTML without TCP RST.
  const cbResp = await fetch(`${redirectUri}?code=auth-code-1&state=${encodeURIComponent(stateParam)}`)
  assert.equal(cbResp.status, 200)
  const html = await cbResp.text()
  assert.match(html, /Signed in — you can close this tab/)

  // Wait for async token exchange to persist account & secrets.
  for (let i = 0; i < 40 && savedCount === 0; i += 1) await delay(20)
  assert.equal(savedCount, 1)
  assert.equal(mail.hasAccounts(), true)
  assert.equal(mail.mailView().pending, undefined)

  // Callback port must shut down cleanly after completion.
  await delay(300)
  await assert.rejects(() => fetch(redirectUri), /ECONNREFUSED|fetch failed/i)

  // dispose() during an in-flight beginGoogle await must abort cleanly and not leak pending state.
  let releaseDiscover
  const discoverStarted = new Promise(resolve => {
    rt.config.mail.fetch = (url) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Promise(res => {
          resolve()
          releaseDiscover = () => res(new Response(JSON.stringify(discoveryDoc), { status: 200, headers: { 'content-type': 'application/json' } }))
        })
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }
  })
  const raceMail = installMail({ ...rt, state: {} }, {
    secrets: { writeSecret: async () => {} },
    reason: err => String(err?.message ?? err),
  })
  const beginP = raceMail.endpoint('mail-account-add', { google: true, address: 'bob@example.com' })
  await discoverStarted
  await raceMail.dispose()
  releaseDiscover()
  await assert.rejects(() => beginP, /Mail connector is closed/i)
  assert.equal(raceMail.mailView().pending, undefined)
})

test('IMAP read({ thread: true }) handles string UIDs, caps References seeds, and early-stops rejected SEARCH HEADER', async () => {
  const fakeNodemailer = {
    createTransport: () => Object.assign(new EventEmitter(), {
      verify: async () => true,
      close() {},
    }),
  }

  // 1. Non-reentrant lock + string UIDs returned from imap.search matched against numeric msg.uid.
  let locked = false
  let fetchAllCalled = false
  let searchCalls = 0
  const raw1 = Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nSubject: Hello\r\nMessage-ID: <m1@example.com>\r\nDate: Mon, 01 Jan 2026 00:00:00 +0000\r\n\r\nFirst')
  const raw2 = Buffer.from('From: b@example.com\r\nTo: a@example.com\r\nSubject: Re: Hello\r\nMessage-ID: <m2@example.com>\r\nIn-Reply-To: <m1@example.com>\r\nReferences: <m1@example.com>\r\nDate: Mon, 01 Jan 2026 01:00:00 +0000\r\n\r\nSecond')
  const messages = new Map([
    [10, { uid: 10, source: raw1, flags: new Set() }],
    [11, { uid: 11, source: raw2, flags: new Set() }],
  ])

  class NonReentrantImap extends EventEmitter {
    async connect() {}
    async logout() {}
    close() {}
    async getMailboxLock() {
      if (locked) throw new Error('DEADLOCK: getMailboxLock is non-reentrant!')
      locked = true
      return { release: () => { locked = false } }
    }
    async fetchOne(uid) {
      return messages.get(Number(uid))
    }
    async search(query) {
      searchCalls += 1
      if (query?.header?.references === '<m1@example.com>' || query?.header?.['in-reply-to'] === '<m1@example.com>') return ['11']
      return []
    }
    async *fetch(range) {
      if (range === '1:*') fetchAllCalled = true
      const uids = Array.isArray(range) ? range.map(Number) : String(range).split(',').map(Number)
      for (const u of uids) {
        if (messages.has(u)) yield messages.get(u)
      }
    }
  }

  const session = await connectImap(
    { address: 'a@example.com', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465, secure: true } },
    { password: 'pw', modules: { ImapFlow: NonReentrantImap, nodemailer: fakeNodemailer } },
  )
  const result = await session.read({ uid: 10, folder: 'INBOX', thread: true })
  assert.equal(fetchAllCalled, false, 'must NOT fetch 1:* across entire mailbox')
  assert.ok(searchCalls > 0, 'must use targeted IMAP search')
  assert.deepEqual(result.messages.map(m => m.uid), [10, 11], 'string UID search hit must match numeric msg.uid')
  await session.close()

  // 2. 100-reply References header is capped at <= 10 seed IDs (<= 30 searches), keeping root & latest.
  const hundredRefs = Array.from({ length: 100 }, (_, i) => `<ref-${i}@example.com>`)
  const rawDeep = Buffer.from(
    `From: a@example.com\r\nTo: b@example.com\r\nSubject: Re: Deep\r\nMessage-ID: <leaf@example.com>\r\nIn-Reply-To: <ref-99@example.com>\r\nReferences: ${hundredRefs.join(' ')}\r\nDate: Mon, 01 Jan 2026 02:00:00 +0000\r\n\r\nDeep`,
  )
  const queriedIds = new Set()
  let deepSearchCount = 0
  class DeepThreadImap extends EventEmitter {
    async connect() {}
    async logout() {}
    close() {}
    async getMailboxLock() { return { release: () => {} } }
    async fetchOne() { return { uid: 50, source: rawDeep, flags: new Set() } }
    async search(query) {
      deepSearchCount += 1
      const id = query?.header?.references ?? query?.header?.['in-reply-to'] ?? query?.header?.['message-id']
      if (id) queriedIds.add(id)
      return []
    }
    async *fetch() {}
  }
  const deepSession = await connectImap(
    { address: 'a@example.com', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465, secure: true } },
    { password: 'pw', modules: { ImapFlow: DeepThreadImap, nodemailer: fakeNodemailer } },
  )
  await deepSession.read({ uid: 50, folder: 'INBOX', thread: true })
  assert.ok(queriedIds.size <= 10, `seedIds must be capped at 10, got ${queriedIds.size}`)
  assert.ok(deepSearchCount <= 30, `search count must be <= 30, got ${deepSearchCount}`)
  assert.ok(queriedIds.has('<leaf@example.com>'), 'preserves main.messageId')
  assert.ok(queriedIds.has('<ref-99@example.com>'), 'preserves main._inReplyTo')
  assert.ok(queriedIds.has('<ref-0@example.com>'), 'preserves root reference')
  assert.ok(queriedIds.has('<ref-98@example.com>'), 'preserves most recent references')
  await deepSession.close()

  // 3. Server rejecting SEARCH HEADER early-stops each header type and falls back to bounded recent window.
  let rejectedSearchCalls = 0
  let fallbackRange
  class RejectHeaderImap extends EventEmitter {
    mailbox = { exists: 500 }
    async connect() {}
    async logout() {}
    close() {}
    async getMailboxLock() { return { release: () => {} } }
    async fetchOne(u) {
      if (Number(u) === 50) return { uid: 50, source: rawDeep, flags: new Set() }
      return { uid: 49, source: raw1, flags: new Set() }
    }
    async search() {
      rejectedSearchCalls += 1
      throw new Error('NO SEARCH HEADER unsupported')
    }
    async *fetch(range) {
      fallbackRange = range
      yield { uid: 49, envelope: { messageId: '<ref-0@example.com>' } }
    }
  }
  const rejectSession = await connectImap(
    { address: 'a@example.com', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465, secure: true } },
    { password: 'pw', modules: { ImapFlow: RejectHeaderImap, nodemailer: fakeNodemailer } },
  )
  const fallbackRes = await rejectSession.read({ uid: 50, folder: 'INBOX', thread: true })
  assert.equal(rejectedSearchCalls, 3, 'must early-stop each of the 3 rejected header types after 1 failure')
  assert.equal(fallbackRange, '301:*', 'must fall back to bounded 200-message window, not 1:*')
  assert.deepEqual(fallbackRes.messages.map(m => m.uid), [50, 49])
  await rejectSession.close()
})

test('connectGmail 401 refresh retries at most once instead of recursing infinitely', async () => {
  let fetchCount = 0
  let refreshCount = 0
  const session = connectGmail(
    { address: 'test-user@example.com' },
    {
      token: () => 'tok-initial',
      refresh: async () => { refreshCount += 1; return true },
      fetch: async () => {
        fetchCount += 1
        return new Response('Unauthorized', { status: 401 })
      },
    },
  )
  await assert.rejects(() => session.search({ limit: 5 }), /Gmail answered 401/)
  assert.equal(refreshCount, 1, 'refresh must run at most once per call')
  assert.equal(fetchCount, 2, 'fetch must run initial + single retry only')
  await session.close()
})

test('connectors gateway.close() aborts active upstream SSE requests without hanging', async (t) => {
  let upstreamClosed = false
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': keepalive\n\n')
    res.on('close', () => { upstreamClosed = true })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections?.(); upstream.close() })

  const gw = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}/mcp`, headers: { authorization: 'Bearer tok' } }),
    readOnly: () => false,
    onUnauthorized: async () => false,
  })
  await gw.listen()
  t.after(() => gw.close())

  const clientAbort = new AbortController()
  const resp = await fetch(gw.urlFor('c1'), { headers: gw.headers(), signal: clientAbort.signal })
  const reader = resp.body.getReader()
  await reader.read()
  const t0 = Date.now()
  await gw.close()
  assert.ok(Date.now() - t0 < 2000, 'gateway.close() must not hang on open SSE streams')
  await reader.cancel().catch(() => {})
  clientAbort.abort()
  await delay(50)
  assert.equal(upstreamClosed, true, 'upstream SSE stream must be closed on gateway.close()')
})

// ============================================================================
// 4. IM Bridges
// ============================================================================

test('weixin applies backoff on fast timeout and HTTP 429 without Retry-After header', async (t) => {
  // 1. Fast timeout error backs off instead of spinning.
  let pollCalls = 0
  const env = {
    fetch: async (url) => {
      if (String(url).includes('notifystart')) {
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      }
      pollCalls += 1
      throw Object.assign(new Error('timeout'), { name: 'AbortError' })
    },
    config: { api: 'https://ilink.invalid/' },
    runtime: { get: () => ({}), set: () => {} },
    log: { warn: () => {} },
  }
  const handle = weixin.connect({ token: 'tok' }, env, { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => handle.stop())
  await delay(180)
  handle.stop()
  assert.ok(pollCalls >= 1 && pollCalls <= 3, `expected backoff (<=3 calls in 180ms), got ${pollCalls}`)

  // 2. HTTP 429 without Retry-After (or blank Retry-After) must back off, NOT 0ms spin.
  let rateLimitCalls = 0
  const rlEnv = {
    fetch: async (url) => {
      if (String(url).includes('notifystart')) {
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      }
      rateLimitCalls += 1
      return new Response('', { status: 429, headers: rateLimitCalls === 1 ? {} : { 'retry-after': '   ' } })
    },
    config: { api: 'https://ilink.invalid/' },
    runtime: { get: () => ({}), set: () => {} },
    log: { warn: () => {} },
  }
  const rlHandle = weixin.connect({ token: 'tok' }, rlEnv, { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => rlHandle.stop())
  await delay(180)
  rlHandle.stop()
  assert.ok(rateLimitCalls >= 1 && rateLimitCalls <= 3, `weixin 429 without Retry-After must back off (<=3 calls in 180ms), got ${rateLimitCalls}`)
})

test('slack backs off on HTTP 429 without Retry-After header instead of 0ms spin loop', async (t) => {
  let openCalls = 0
  const env = {
    fetch: async (url) => {
      if (String(url).endsWith('auth.test')) {
        return new Response(JSON.stringify({ ok: true, user_id: 'U1' }), { status: 200 })
      }
      openCalls += 1
      return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: openCalls === 1 ? {} : { 'retry-after': '' },
      })
    },
    WebSocket: class {},
    config: { api: 'https://slack.invalid/api' },
    runtime: { get: () => ({}), set: () => {} },
    log: { warn: () => {} },
  }
  const handle = slack.connect({ appToken: 'xapp-1', botToken: 'xoxb-1' }, env, {
    onMessage: () => {},
    onAction: () => {},
    onStatus: () => {},
  })
  t.after(() => handle.stop())
  await delay(180)
  handle.stop()
  assert.ok(openCalls >= 1 && openCalls <= 3, `slack 429 without Retry-After must back off (<=3 calls in 180ms), got ${openCalls}`)
})

test('qq refreshes expired token on 4004 reconnect and stops with refreshTimer cleared on permanent auth failure', async (t) => {
  const startWs = async (onConnection) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('connection', onConnection)
    await new Promise(resolve => wss.once('listening', resolve))
    const url = `ws://127.0.0.1:${wss.address().port}`
    return {
      url,
      close: () => {
        for (const client of wss.clients) client.terminate()
        wss.close()
      },
    }
  }

  // 1. Expired token receives 4004 -> refreshes token via getAppAccessToken -> reconnects and reaches ready.
  let tokenIssuance = 0
  const seenTokens = []
  const statuses1 = []
  const wss1 = await startWs((ws) => {
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw))
      if (packet.op === 2) {
        seenTokens.push(packet.d.token)
        if (packet.d.token === 'QQBot expired-tok') {
          ws.close(4004, 'Authentication failed')
        } else {
          ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's-new', user: { id: '1', username: 'qqbot' } } }))
        }
      }
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
  })
  t.after(() => wss1.close())

  const handle1 = qq.connect(
    { appId: '100', appSecret: 'sec' },
    {
      fetch: async (url) => {
        if (String(url).endsWith('/app/getAppAccessToken')) {
          tokenIssuance += 1
          return new Response(JSON.stringify({ access_token: tokenIssuance === 1 ? 'expired-tok' : 'fresh-tok', expires_in: 7200 }), { status: 200 })
        }
        return new Response(JSON.stringify({ url: wss1.url }), { status: 200 })
      },
      WebSocket: globalThis.WebSocket,
      config: { api: 'https://qq.invalid', token: 'https://qq.invalid' },
      runtime: { get: () => ({}), set: () => {} },
      log: { warn: () => {} },
    },
    { onMessage: () => {}, onAction: () => {}, onStatus: s => statuses1.push(s) },
  )
  t.after(() => handle1.stop())
  await until(() => statuses1.some(s => s.state === 'ready'))
  assert.ok(statuses1.some(s => s.state === 'ready'), 'QQ must recover from expired-token 4004 after refreshing token')
  assert.equal(tokenIssuance, 2, 'must refresh token via getToken')
  assert.deepEqual(seenTokens, ['QQBot expired-tok', 'QQBot fresh-tok'])
  handle1.stop()

  // 2. Freshly minted token STILL receiving 4004 stops permanently and clears 2h refreshTimer.
  const refreshTimers = []
  const clearedTimers = new Set()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(fn, ms, ...args)
    if (ms >= 60_000) refreshTimers.push(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    clearedTimers.add(id)
    return realClearTimeout(id)
  }
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })

  let permanentTokenCalls = 0
  let socketsOpened = 0
  const statuses2 = []
  const wss2 = await startWs((ws) => {
    socketsOpened += 1
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw))
      if (packet.op === 2) ws.close(4004, 'Invalid token')
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
  })
  t.after(() => wss2.close())

  const handle2 = qq.connect(
    { appId: '100', appSecret: 'sec' },
    {
      fetch: async (url) => {
        if (String(url).endsWith('/app/getAppAccessToken')) {
          permanentTokenCalls += 1
          return new Response(JSON.stringify({ access_token: `tok-${permanentTokenCalls}`, expires_in: 7200 }), { status: 200 })
        }
        return new Response(JSON.stringify({ url: wss2.url }), { status: 200 })
      },
      WebSocket: globalThis.WebSocket,
      config: { api: 'https://qq.invalid', token: 'https://qq.invalid' },
      runtime: { get: () => ({}), set: () => {} },
      log: { warn: () => {} },
    },
    { onMessage: () => {}, onAction: () => {}, onStatus: s => statuses2.push(s) },
  )
  t.after(() => handle2.stop())
  await until(() => statuses2.some(s => s.state === 'error'))
  await delay(400)
  assert.ok(statuses2.some(s => s.state === 'error' && /4004/.test(s.error)), 'fresh-token 4004 must surface error')
  assert.equal(socketsOpened, 2, 'must retry once with refreshed token then stop permanently')
  assert.ok(refreshTimers.length >= 1, 'refreshTimer was scheduled')
  assert.ok(refreshTimers.every(id => clearedTimers.has(id)), 'all 2h refreshTimers must be cleared on permanent exit')

  // 3. 4004 followed by permanent getToken refusal (HTTP 401) stops permanently and clears refreshTimer.
  refreshTimers.length = 0
  clearedTimers.clear()
  let tokAttempts3 = 0
  let sockets3 = 0
  const statuses3 = []
  const wss3 = await startWs((ws) => {
    sockets3 += 1
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw))
      if (packet.op === 2) ws.close(4004, 'Token revoked')
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
  })
  t.after(() => wss3.close())

  const handle3 = qq.connect(
    { appId: '100', appSecret: 'revoked' },
    {
      fetch: async (url) => {
        if (String(url).endsWith('/app/getAppAccessToken')) {
          tokAttempts3 += 1
          if (tokAttempts3 === 1) return new Response(JSON.stringify({ access_token: 'old-tok', expires_in: 7200 }), { status: 200 })
          return new Response(JSON.stringify({ error_reason: 'invalid clientSecret' }), { status: 401 })
        }
        return new Response(JSON.stringify({ url: wss3.url }), { status: 200 })
      },
      WebSocket: globalThis.WebSocket,
      config: { api: 'https://qq.invalid', token: 'https://qq.invalid' },
      runtime: { get: () => ({}), set: () => {} },
      log: { warn: () => {} },
    },
    { onMessage: () => {}, onAction: () => {}, onStatus: s => statuses3.push(s) },
  )
  t.after(() => handle3.stop())
  await until(() => statuses3.some(s => s.state === 'error'))
  await delay(400)
  assert.equal(sockets3, 1, 'permanent getToken refusal must stop without opening another socket')
  assert.ok(statuses3.some(s => s.state === 'error' && /invalid clientSecret/.test(s.error)))
  assert.ok(refreshTimers.length >= 1)
  assert.ok(refreshTimers.every(id => clearedTimers.has(id)), 'refreshTimer must be cleared on permanent getToken failure')
})

test('discord stops reconnecting on fatal auth close code 4004 and skips oversized media', async (t) => {
  let socketsOpened = 0
  let mediaCancelled = false
  const statuses = []
  const messages = []

  class FakeWs extends EventTarget {
    constructor() {
      super()
      this.readyState = 1
      socketsOpened += 1
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) }))
        this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            op: 0,
            t: 'MESSAGE_CREATE',
            d: {
              id: 'm1', channel_id: 'dm1', content: 'hi',
              author: { id: 'u1', username: 'U1' },
              attachments: [{ url: 'https://cdn.discordapp.com/big.bin', filename: 'big.bin', content_type: 'application/octet-stream' }],
            },
          }),
        }))
        setTimeout(() => {
          const ev = new Event('close')
          ev.code = 4004
          ev.reason = 'Authentication failed'
          this.dispatchEvent(ev)
        }, 40)
      })
    }
    send() {}
    close() {}
  }

  const handle = discord.connect(
    { token: 'bad-token' },
    {
      fetch: async (url) => {
        if (String(url).includes('/gateway/bot')) {
          return new Response(JSON.stringify({ url: 'wss://gateway.invalid' }), { status: 200 })
        }
        return {
          ok: true,
          headers: { get: k => (k.toLowerCase() === 'content-length' ? String(100 * 1024 * 1024) : null) },
          body: { cancel: async () => { mediaCancelled = true } },
        }
      },
      WebSocket: FakeWs,
      config: { api: 'https://discord.invalid/api/v10' },
      runtime: { get: () => ({}), set: () => {} },
      log: { warn: () => {} },
    },
    { onMessage: m => messages.push(m), onAction: () => {}, onStatus: s => statuses.push(s) },
  )
  t.after(() => handle.stop())
  await delay(400)
  assert.equal(socketsOpened, 1, 'fatal auth code 4004 must not trigger reconnect loop')
  assert.ok(statuses.some(s => s.state === 'error' && /4004/.test(s.error)))
  assert.equal(mediaCancelled, true, 'oversized attachment must be cancelled')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].files.length, 0)
})

test('wecom stops on permanent auth errcode and retries with backoff on transient subscribe and 403 errors', async (t) => {
  // 1. Known permanent credential error (60111) stops reconnecting permanently.
  let permUpgrades = 0
  const wssPerm = await fakeWsServer({
    onSocket(ws) {
      permUpgrades += 1
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        if (packet.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 60111, errmsg: 'invalid bot' }))
        }
      })
    },
  })
  t.after(() => wssPerm.close())

  const permHandle = wecom.connect(
    { botId: 'b', secret: 's' },
    { fetch: globalThis.fetch, config: { gateway: wssPerm.url }, runtime: { get: () => ({}), set: () => {} }, log: { warn: () => {} } },
    { onMessage: () => {}, onAction: () => {}, onStatus: () => {} },
  )
  t.after(() => permHandle.stop())
  await delay(450)
  assert.equal(permUpgrades, 1, 'permanent subscribe refusal 60111 must not reconnect repeatedly')
  permHandle.stop()

  // 2. Transient non--1 errcode (45009 rate limit) AND transient handshake 403 retry with backoff and recover.
  let attempt = 0
  const statuses = []
  const wssTransient = await fakeWsServer({
    checkUpgrade() {
      attempt += 1
      if (attempt === 1) return 403 // transient proxy/captive-portal 403
      return undefined
    },
    onSocket(ws) {
      ws.on('message', (raw) => {
        const packet = JSON.parse(raw)
        if (packet.cmd === 'aibot_subscribe') {
          if (attempt === 2) {
            ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 45009, errmsg: 'api freq out of limit' }))
          } else {
            ws.send(JSON.stringify({ headers: { req_id: packet.headers.req_id }, errcode: 0, errmsg: 'ok' }))
          }
        }
      })
    },
  })
  t.after(() => wssTransient.close())

  const transientHandle = wecom.connect(
    { botId: 'b', secret: 's' },
    { fetch: globalThis.fetch, config: { gateway: wssTransient.url }, runtime: { get: () => ({}), set: () => {} }, log: { warn: () => {} } },
    { onMessage: () => {}, onAction: () => {}, onStatus: s => statuses.push(s) },
  )
  t.after(() => transientHandle.stop())
  for (let i = 0; i < 40 && !statuses.some(s => s.state === 'ready'); i += 1) await delay(50)
  assert.equal(attempt, 3, 'must retry past transient 403 and transient 45009 subscribe error')
  assert.ok(statuses.some(s => s.state === 'ready'), 'WeCom must reach ready after transient errors clear')
})

test('im/index.js sends typing for IM-originated DM and group turns while suppressing Desktop turns', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-typing-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const typed = []
  const disposers = []
  const sessionEventListeners = []
  let adapterHandlers
  const ctx = {
    on: (name, fn) => {
      if (name === 'session/event') sessionEventListeners.push(fn)
      return () => {}
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    get: () => undefined,
  }
  t.after(async () => { for (const d of disposers) await d() })
  const room = { id: 'r1', sessionId: 'r1-sess', name: 'Team' }
  const sentUsers = []
  const rt = {
    ctx, home, config: {},
    state: {
      bots: {
        a: { id: 'a', name: 'Alpha' },
        b: { id: 'b', name: 'Beta' },
      },
      rooms: { r1: room },
      im: {
        connections: {
          c1: {
            id: 'c1', platform: 'telegram', botId: 'a', enabled: true,
            settings: {}, secrets: { token: 'TOK' },
            paired: [{ id: 'u1', name: 'U1', at: 1 }],
            chats: {
              'dm-u1': { kind: 'direct', title: 'U1', target: { botId: 'a' }, at: 1 },
              'dm-desktop': { kind: 'direct', title: 'DesktopBot', target: { botId: 'b' }, at: 1 },
              'grp-1': { kind: 'group', title: 'TeamChat', target: { roomId: 'r1' }, at: 1 },
            },
          },
        },
      },
    },
    live: new Map([['a', { turn: 1 }], ['b', { turn: 1 }]]),
    chatOwners: new Map([['a', 'a'], ['b', 'b']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomWorkView: () => ({ r1: [{ botId: 'a' }] }),
    sessionOfRoom: r => r?.sessionId ?? r?.id,
    load: async () => {},
    save: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    secretValue: () => 'fake-token',
    redactSecrets: s => s,
    warn: () => {},
    botOf: id => rt.state.bots[id],
    roomOf: id => (id === 'r1' || id === 'r1-sess' ? room : undefined),
    chatOf: id => id,
    onRoomLine: () => {},
    onApproval: () => {},
    onSaved: () => {},
    approvalsView: () => [],
    displayItems: () => [],
    sendUser: async (req) => { sentUsers.push(req) },
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
  }
  const { adapters } = await import('../src/host/im/platforms/index.js')
  const origTelegram = adapters.telegram
  adapters.telegram = {
    id: 'telegram',
    connect: (_f, _e, h) => {
      adapterHandlers = h
      h.onStatus({ state: 'ready' })
      return {
        send: async () => ({ messageId: 'm1' }),
        typing: async (chat) => { typed.push(chat.key) },
        stop: () => {},
      }
    },
  }
  t.after(() => { adapters.telegram = origTelegram })

  installIm(rt)
  await until(() => adapterHandlers !== undefined)
  assert.ok(adapterHandlers, 'IM telegram adapter must connect before testing typing')

  // Before any IM message arrives, all busy bots/rooms are Desktop-originated -> no typing sent.
  t.mock.timers.tick(5_000)
  assert.deepEqual(typed, [], 'Desktop-originated busy turns must NOT send IM typing indicators')

  // Admit an IM DM message for bot 'a' and an IM group message for room 'r1'.
  await adapterHandlers.onMessage({
    chat: { key: 'dm-u1', kind: 'direct', title: 'U1' },
    sender: { id: 'u1', name: 'U1' },
    text: 'hello bot',
    images: [], files: [], mentioned: false, messageId: 'm1',
  })
  await adapterHandlers.onMessage({
    chat: { key: 'grp-1', kind: 'group', title: 'TeamChat' },
    sender: { id: 'u1', name: 'U1' },
    text: 'hello room',
    images: [], files: [], mentioned: true, messageId: 'm2',
  })
  assert.equal(sentUsers.length, 2)
  for (const fn of sessionEventListeners) {
    fn({ id: 'a' }, { type: 'user/message', seq: 1, data: { source: { rpcId: sentUsers[0].requestId } } })
    fn({ id: 'r1-sess' }, { type: 'user/message', seq: 1, data: { source: { rpcId: sentUsers[1].requestId } } })
  }

  t.mock.timers.tick(5_000)
  assert.ok(typed.includes('dm-u1'), 'IM-originated DM turn must send typing indicator')
  assert.ok(typed.includes('grp-1'), 'IM-originated group turn must send typing indicator')
  assert.equal(typed.includes('dm-desktop'), false, 'Desktop-originated busy bot must still not send typing')
})

test('im/index.js failedSends evicts oldest images when buffered image bytes exceed 20 MB cap', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-failed-img-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const disposers = []
  const sessionEventListeners = []
  let adapterHandlers
  let failSendImage = true
  const retriedImages = []
  const sentUsers = []
  const ctx = {
    on: (name, fn) => {
      if (name === 'session/event') sessionEventListeners.push(fn)
      return () => {}
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    get: () => undefined,
  }
  t.after(async () => { for (const d of disposers) await d() })

  // 9 MB PNG buffer per image: 3 failed images = 27 MB > 20 MB cap -> oldest image must be evicted.
  const bigPngB64 = Buffer.alloc(9 * 1024 * 1024, 7).toString('base64')
  const rt = {
    ctx, home, config: {},
    state: {
      bots: { a: { id: 'a', name: 'Alpha' } },
      rooms: {},
      im: {
        connections: {
          c1: {
            id: 'c1', platform: 'telegram', botId: 'a', enabled: true,
            settings: {}, secrets: { token: 'TOK' },
            paired: [{ id: 'u1', name: 'U1', at: 1 }],
            chats: { 'dm-u1': { kind: 'direct', title: 'U1', target: { botId: 'a' }, at: 1 } },
          },
        },
      },
    },
    live: new Map([['a', { turn: 1 }]]),
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    load: async () => {},
    save: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    secretValue: () => 'fake-token',
    redactSecrets: s => s,
    warn: () => {},
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: id => id,
    onRoomLine: () => {},
    onApproval: () => {},
    onSaved: () => {},
    approvalsView: () => [],
    displayItems: (_sid, events) => events.filter(e => e.type === 'test/bot').map(e => ({ kind: 'bot', text: e.text })),
    sendUser: async (req) => { sentUsers.push(req) },
    mobileEndpoint: async (_ep, { path }) => ({ mime: 'image/png', bytes: bigPngB64, path }),
    own: (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined),
  }
  const { adapters } = await import('../src/host/im/platforms/index.js')
  const origTelegram = adapters.telegram
  adapters.telegram = {
    id: 'telegram',
    connect: (_f, _e, h) => {
      adapterHandlers = h
      h.onStatus({ state: 'ready' })
      return {
        send: async () => ({ messageId: 'm1' }),
        sendImage: async (_chat, image) => {
          if (failSendImage) throw Object.assign(new Error('upload refused'), { permanent: true })
          retriedImages.push(image.name)
          return { messageId: `img-${image.name}` }
        },
        stop: () => {},
      }
    },
  }
  t.after(() => { adapters.telegram = origTelegram })

  installIm(rt)
  await until(() => adapterHandlers !== undefined)
  assert.ok(adapterHandlers, 'IM telegram adapter must connect before testing failedSends')

  await adapterHandlers.onMessage({
    chat: { key: 'dm-u1', kind: 'direct', title: 'U1' },
    sender: { id: 'u1', name: 'U1' },
    text: 'send images',
    images: [], files: [], mentioned: false, messageId: 'm1',
  })
  for (const fn of sessionEventListeners) {
    fn({ id: 'a' }, { type: 'user/message', seq: 1, data: { source: { rpcId: sentUsers[0].requestId } } })
  }

  for (const name of ['first.png', 'second.png', 'third.png']) {
    for (const fn of sessionEventListeners) {
      fn({ id: 'a' }, { type: 'test/bot', text: `![${name}](/tmp/${name})` })
    }
  }
  await delay(150)

  // Retry failed sends: oldest 9 MB image ('first.png') must have been evicted to stay under 20 MB.
  failSendImage = false
  await rt.imEndpoint('im-retry', { id: 'c1', chatKey: 'dm-u1' })
  for (let i = 0; i < 40 && retriedImages.length < 2; i += 1) await delay(20)
  await delay(50)
  assert.deepEqual(retriedImages, ['second.png', 'third.png'], 'oldest failed image must be evicted under 20 MB cap')
})

// ============================================================================
// 5. Computer Use, Plugins, Preview, DeepSeek Services, Web Search
// ============================================================================

test('preview-worker handles Buffer and plain Uint8Array (including subarrays) and rejects >64MP PNG bombs', () => {
  const bomb = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bomb, 0)
  bomb.writeUInt32BE(13, 8)
  bomb.write('IHDR', 12, 'ascii')
  bomb.writeUInt32BE(20_000, 16)
  bomb.writeUInt32BE(20_000, 20)
  assert.throws(() => shrink(bomb, 'image/png', 512, 72), /max resolution|64MP/i)

  // Plain Uint8Array bomb (no Buffer methods) must also be rejected via DataView.
  const bombU8 = new Uint8Array(bomb.length)
  bombU8.set(bomb)
  assert.throws(() => shrink(bombU8, 'image/png', 512, 72), /max resolution|64MP/i)

  // Real valid PNG as plain Uint8Array and sliced subarray with non-zero byteOffset must shrink cleanly.
  const png = new PNG({ width: 32, height: 32 })
  png.data.fill(200)
  const pngBuf = PNG.sync.write(png)
  const padded = new Uint8Array(pngBuf.length + 7)
  padded.set(pngBuf, 5)
  const slice = padded.subarray(5, 5 + pngBuf.length)
  const out = shrink(slice, 'image/png', 16, 72)
  assert.ok(Buffer.isBuffer(out) && out.length > 0 && out[0] === 0xff && out[1] === 0xd8)
})

test('previewImage processes concurrent large PNG jobs cleanly through bounded queue', async () => {
  const png = new PNG({ width: 600, height: 600 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i * 13) & 255
    png.data[i + 1] = (i * 29) & 255
    png.data[i + 2] = (i * 53) & 255
    png.data[i + 3] = 255
  }
  const bytes = PNG.sync.write(png)
  assert.ok(bytes.length >= 100_000, 'test PNG must exceed PREVIEW_MIN_BYTES')
  const results = await Promise.all([
    previewImage(bytes, 'image/png'),
    previewImage(bytes, 'image/png'),
    previewImage(bytes, 'image/png'),
  ])
  for (const out of results) {
    assert.ok(Buffer.isBuffer(out) && out.length > 0 && out[0] === 0xff && out[1] === 0xd8)
  }
})

test('computer/index.js cursor-wait aborts cleanly, onBotDelete cleans maps, and get_window_state replaces stale tokens', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-comp-perf-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['bot-a'],
    bots: {
      'bot-a': { id: 'bot-a', name: 'BotA', role: 'Lead', capabilities: [], packs: [] },
      'bot-b': { id: 'bot-b', name: 'BotB', role: 'Helper', capabilities: [], packs: [] },
    },
    rooms: {},
  }))
  const ctx = fakeContext()
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  const rt = createRuntime(ctx, { home, pluginFetch: async () => { throw new Error('offline') } })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()

  // 1. cursor-wait respects AbortSignal immediately.
  const ac = new AbortController()
  const waitP = rt.computerEndpoint('cursor-wait', { after: 0 }, ac.signal)
  const t0 = Date.now()
  ac.abort()
  const res = await waitP
  assert.deepEqual(res.events, [])
  assert.ok(Date.now() - t0 < 500, 'aborted cursor-wait must resolve immediately')

  // 2. get_window_state replaces old token:* entries for that window.
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'bot-b', level: 'background' })
  rt.botOf('bot-b').computer = { apps: { 'pid:77': { name: 'Editor', grantedAt: 0 } } }
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const sessionId = rt.chatOf('bot-b')
  await track(
    { name: 'cua_driver_native__get_window_state', arguments: { window_id: 9 }, agent: { id: sessionId }, callId: 'w1' },
    async () => ({ isError: false, value: { window_id: 9, pid: 77, name: 'Editor', elements: [{ element_token: 'old-tok' }] } }),
  )
  await track(
    { name: 'cua_driver_native__get_window_state', arguments: { window_id: 9 }, agent: { id: sessionId }, callId: 'w2' },
    async () => ({ isError: false, value: { window_id: 9, pid: 77, name: 'Editor', elements: [{ element_token: 'new-tok' }] } }),
  )
  const staleGate = await gate({ name: 'cua_driver_native__click', arguments: { element_token: 'old-tok' }, agent: { id: sessionId }, callId: 'c1' }, async () => 'ok')
  assert.equal(staleGate.kind, 'deny')
  const freshGate = await gate({ name: 'cua_driver_native__click', arguments: { element_token: 'new-tok' }, agent: { id: sessionId }, callId: 'c2' }, async () => 'ok')
  assert.equal(freshGate, 'ok')

  // 3. Deleting bot cleans control & holds in computerLive().
  await rt.computerEndpoint('takeover', { botId: 'bot-b' })
  assert.ok(rt.computerLive().holds['bot-b'])
  assert.ok(rt.computerLive().bots['bot-b'])
  await rt.deleteBot('bot-b')
  assert.equal(rt.botOf('bot-b'), undefined)
  assert.equal(rt.computerLive().holds['bot-b'], undefined)
  assert.equal(rt.computerLive().bots['bot-b'], undefined)
})

test('plugins catalog hasExecutable handles POSIX X_OK, Windows PATHEXT, and separate force vs cache in-flight loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-path-'))
  try {
    // 1. POSIX X_OK checks (only on non-Windows).
    if (process.platform !== 'win32') {
      const binDir = join(dir, 'bin')
      mkdirSync(binDir)
      const exePath = join(binDir, 'my-tool')
      const nonExePath = join(binDir, 'not-exe')
      writeFileSync(exePath, '#!/bin/sh\n')
      chmodSync(exePath, 0o755)
      writeFileSync(nonExePath, 'plain text')
      chmodSync(nonExePath, 0o644)

      let clock = 10_000
      assert.equal(hasExecutable('my-tool', { env: { PATH: binDir }, platform: 'linux', now: () => clock }), true)
      assert.equal(hasExecutable('not-exe', { env: { PATH: binDir }, platform: 'linux', now: () => clock }), false)
      assert.equal(hasExecutable('missing-bin', { env: { PATH: binDir }, platform: 'linux', now: () => clock }), false)

      // Owner-without-x but other-with-x (0o601) has (mode & 0o111) !== 0 yet fails real X_OK for non-root owner.
      if (process.getuid?.() !== 0) {
        const otherExecOnly = join(binDir, 'other-exec-only')
        writeFileSync(otherExecOnly, '#!/bin/sh\n')
        chmodSync(otherExecOnly, 0o601)
        assert.equal(hasExecutable('other-exec-only', { env: { PATH: binDir }, platform: 'linux', now: () => clock }), false)
      }

      // Negative cache holds for 30s even if file appears, then clears after TTL.
      const latePath = join(binDir, 'missing-bin')
      writeFileSync(latePath, '#!/bin/sh\n')
      chmodSync(latePath, 0o755)
      assert.equal(hasExecutable('missing-bin', { env: { PATH: binDir }, platform: 'linux', now: () => clock + 5_000 }), false)
      assert.equal(hasExecutable('missing-bin', { env: { PATH: binDir }, platform: 'linux', now: () => clock + 31_000 }), true)
    }

    // 2. Windows PATH/PATHEXT case-insensitivity, dotted command names, and skipping extensionless POSIX shims.
    const winFiles = new Set([
      'c:\\tools\\only-shim',
      'c:\\tools\\npx',
      'c:\\tools\\npx.cmd',
      'c:\\tools\\foo.v2.cmd',
    ])
    const winEnv = { Path: '"C:\\Tools"', pathext: '.EXE;.CMD;.BAT' }
    const winCheck = p => winFiles.has(p.toLowerCase())
    assert.equal(hasExecutable('only-shim', { env: winEnv, platform: 'win32', isFile: winCheck }), false, 'must skip extensionless POSIX shim on Windows')
    assert.equal(hasExecutable('npx', { env: winEnv, platform: 'win32', isFile: winCheck }), true, 'resolves npx via case-insensitive Path and pathext')
    assert.equal(hasExecutable('npx.cmd', { env: winEnv, platform: 'win32', isFile: winCheck }), true, 'resolves explicit PATHEXT command')
    assert.equal(hasExecutable('foo.v2', { env: winEnv, platform: 'win32', isFile: winCheck }), true, 'appends PATHEXT when dot extension is not in PATHEXT')
    assert.equal(hasExecutable('C:\\Tools\\foo.v2', { env: winEnv, platform: 'win32', isFile: winCheck }), true, 'handles win32 absolute path with non-PATHEXT dot')

    // 3. force: true must NOT reuse an in-flight force: false disk-cache load; force: false MAY reuse in-flight force: true.
    const cachePath = join(dir, 'cat.json')
    const sig = `official:${defaultRegistryUrl(process.env)}`
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: 100_000,
      signature: sig,
      entries: [{ id: 'stale-disk-plugin', name: 'Stale', kind: 'mcp', sourceId: 'official' }],
      errors: [],
      offline: false,
    }))

    let clockMs = 101_000
    let fetches = 0
    const mgr = createCatalogManager({
      cachePath,
      now: () => clockMs,
      fetchImpl: async () => {
        fetches += 1
        await delay(40)
        return new Response(JSON.stringify({
          schemaVersion: 1,
          plugins: [{ id: `fresh-live-plugin-${fetches}`, name: 'Fresh', kind: 'mcp', install: { mcp: { packageSpec: '@test/fresh@1.0.0' } } }],
        }), { status: 200 })
      },
    })
    const pCache = mgr.load({ force: false })
    const pForce = mgr.load({ force: true })
    const [diskRes, liveRes] = await Promise.all([pCache, pForce])
    assert.equal(fetches, 1, 'force: true must hit network instead of reusing in-flight force: false disk load')
    assert.ok(diskRes.entries.some(e => e.id === 'stale-disk-plugin'))
    assert.ok(liveRes.entries.some(e => e.id === 'fresh-live-plugin-1'))

    // Advance past 1h cache TTL so force: false cannot return stale memoryCache and must join in-flight force: true.
    clockMs += 2 * 60 * 60 * 1000
    const pForce2 = mgr.load({ force: true })
    const pForce3 = mgr.load({ force: true })
    const pNormalJoin = mgr.load({ force: false })
    const [r1, r2, r3] = await Promise.all([pForce2, pForce3, pNormalJoin])
    assert.equal(fetches, 2, 'concurrent force: true and force: false loads must share the live fetch')
    assert.equal(r1, r2)
    assert.equal(r3, r1, 'force: false must reuse in-flight force: true load')
    assert.ok(r3.entries.some(e => e.id === 'fresh-live-plugin-2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugins setSlot disables a browser DSH bundle we enabled when switching away', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-plug-slot-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const bundle = {
    name: 'dsh-ego-browser',
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: false,
    installed: true,
    optional: false,
    removable: true,
    updatable: false,
    rows: [],
    overrides: [],
  }
  const toggles = []
  const fakePm = {
    async listBundles() { return [{ ...bundle }] },
    async setBundleEnabled(name, enabled) {
      toggles.push([name, enabled])
      bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: enabled ? 'enable' : 'disable', target: name, enabled }
    },
  }
  const ctx = fakeContext({ services: { pluginManager: fakePm } })
  t.after(() => ctx.dispose())
  const rt = createRuntime(ctx, { home, pluginFetch: async () => { throw new Error('offline') } })
  await rt.load()

  await rt.plugins.setSlot('browser', 'dsh:dsh-ego-browser')
  assert.deepEqual(toggles, [['dsh-ego-browser', true]])
  await rt.plugins.setSlot('browser', 'builtin:readonly')
  assert.deepEqual(toggles, [['dsh-ego-browser', true], ['dsh-ego-browser', false]])
})

test('deepseek-services cancels and releases reader lock on oversized stream', async (t) => {
  let cancelled = false
  let released = false
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      cancel: async () => {},
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(10 * 1024 * 1024) }),
        cancel: async () => { cancelled = true },
        releaseLock: () => { released = true },
      }),
    },
  })
  const ctx = {
    effect: fn => fn(),
    get: name => (name === 'credentials' ? {
      describe: async () => ({ configured: true }),
      resolve: async () => ({ value: 'sk-test' }),
    } : undefined),
    llm: { listConfigurableProviders: () => [] },
  }
  const rt = {
    ctx,
    state: { prefs: { deepseekServices: { tts: 'deepseek', voice: 'stella' } } },
    teamTools: [],
    load: async () => {},
    warn: () => {},
  }
  installDeepseekServices(rt)
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: 'hello' }), /more data than expected/i)
  assert.equal(cancelled, true)
  assert.equal(released, true)
})

test('web-search caps native response body size and cancels oversized stream', async () => {
  let cancelled = false
  let released = false
  const provider = createAutoSearchProvider({
    route: () => ({
      provider: 'moonshotai-cn', model: 'kimi-k3', api: 'openai-completions',
      baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY',
    }),
    resolveKey: async () => 'sk-test',
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(4 * 1024 * 1024) }),
          cancel: async () => { cancelled = true },
          releaseLock: () => { released = true },
        }),
      },
    }),
    webFetch: async () => { throw new Error('fallback off') },
  }, { fallback: false })

  await assert.rejects(() => provider.search({ query: 'huge' }), /over 10 MB/i)
  assert.equal(cancelled, true)
  assert.equal(released, true)
})
