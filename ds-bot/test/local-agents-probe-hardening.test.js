import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import {
  cleanEnv,
  probeEnv,
  probeSignIn,
  probeVersion,
  refreshSearchDirs,
  runProbeCommand,
  terminateChild,
  withProbeEnv,
} from '../src/host/local-agents/discover.js'
import { ENGINES } from '../src/host/local-agents/engines.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import { fakeContext } from './fake-ctx.js'

function makeNodeScript(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, `${body}\n`)
  return file
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(file, 'utf8').trim()
      if (content !== '') return content
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`timed out waiting for ${file}`)
}

async function waitForPidExit(pid, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return !isPidAlive(pid)
}

test('probeEnv injects MISE_OFFLINE=1 without affecting cleanEnv, and respects explicit overrides', async (t) => {
  const savedMise = process.env.MISE_OFFLINE
  delete process.env.MISE_OFFLINE
  t.after(() => {
    if (savedMise === undefined) delete process.env.MISE_OFFLINE
    else process.env.MISE_OFFLINE = savedMise
  })

  // Live session cleanEnv does not force MISE_OFFLINE when unset.
  assert.equal(cleanEnv().MISE_OFFLINE, undefined)
  // Background probeEnv injects MISE_OFFLINE=1 by default.
  assert.equal(probeEnv().MISE_OFFLINE, '1')
  assert.equal(withProbeEnv({ PATH: '/usr/bin' }).MISE_OFFLINE, '1')
  // Explicit extra override wins; empty string counts as unset; case-insensitive keys do not duplicate.
  assert.equal(probeEnv({ MISE_OFFLINE: '0' }).MISE_OFFLINE, '0')
  assert.equal(withProbeEnv({ MISE_OFFLINE: '0' }).MISE_OFFLINE, '0')
  assert.equal(withProbeEnv({ MISE_OFFLINE: '' }).MISE_OFFLINE, '1')
  assert.equal(withProbeEnv({ MISE_OFFLINE: '   ' }).MISE_OFFLINE, '1')
  const lowerEnv = withProbeEnv({ mise_offline: '0' })
  assert.equal(lowerEnv.mise_offline, '0')
  assert.equal(Object.keys(lowerEnv).filter(k => k.toUpperCase() === 'MISE_OFFLINE').length, 1)
  process.env.mise_offline = '0'
  const cleanOverride = probeEnv({ MISE_OFFLINE: '1' })
  assert.equal(cleanOverride.MISE_OFFLINE, '1')
  assert.equal(Object.keys(cleanOverride).filter(k => k.toUpperCase() === 'MISE_OFFLINE').length, 1)
  delete process.env.mise_offline
  // Explicit host process.env override is respected.
  process.env.MISE_OFFLINE = '0'
  assert.equal(probeEnv().MISE_OFFLINE, '0')
  delete process.env.MISE_OFFLINE

  // Real subprocess verification for probeVersion and probeSignIn.
  const root = mkdtempSync(join(tmpdir(), 'dsb-mise-env-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const versionEcho = makeNodeScript(root, 'echo-mise-version.mjs', 'console.log("mise=" + String(process.env.MISE_OFFLINE))')
  const signInEcho = makeNodeScript(root, 'echo-mise-signin.mjs', `
    const val = process.env.MISE_OFFLINE
    console.log(JSON.stringify({ loggedIn: val === '1', mise: val }))
  `)

  const defaultVer = await probeVersion(process.execPath, [versionEcho])
  assert.equal(defaultVer.ok, true)
  assert.equal(defaultVer.version, 'mise=1')

  const overrideVer = await probeVersion(process.execPath, [versionEcho], cleanEnv({ MISE_OFFLINE: '0' }))
  assert.equal(overrideVer.ok, true)
  assert.equal(overrideVer.version, 'mise=0')

  assert.equal(await probeSignIn(process.execPath, { args: [signInEcho] }), true)
  assert.equal(await probeSignIn(process.execPath, { args: [signInEcho] }, { env: { MISE_OFFLINE: '0' } }), false)
})

test('runProbeCommand force-kills SIGTERM-ignoring child and grandchild processes on timeout, abort, and output overflow', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-forcekill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const pidFile = join(root, 'pids.json')
  const sigFile = join(root, 'sigterm.log')
  const stubborn = makeNodeScript(root, 'stubborn.mjs', `
    import { spawn } from 'node:child_process'
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(sigFile)}, 'SIGTERM\\n') })
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
    writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))
    setInterval(() => {}, 1000)
  `)

  const started = Date.now()
  const timeoutMs = 1_200
  const forceKillAfterMs = 400
  const runningTimeout = runProbeCommand(process.execPath, [stubborn], { timeoutMs, forceKillAfterMs })
  const pids = JSON.parse(await waitForFile(pidFile, 3_000))
  const result = await runningTimeout
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL', 'must escalate to SIGKILL after SIGTERM is ignored')
  assert.match(readFileSync(sigFile, 'utf8'), /SIGTERM/, 'child must have received and ignored SIGTERM first')
  assert.ok(elapsed < timeoutMs + forceKillAfterMs + 3_000, `expected force-kill within grace period, took ${elapsed}ms`)
  assert.equal(await waitForPidExit(pids.parent), true, `parent pid ${pids.parent} should be dead`)
  assert.equal(await waitForPidExit(pids.child), true, `grandchild pid ${pids.child} should be dead`)

  // Abort path also escalates SIGTERM -> SIGKILL cleanly, and does not flip to timedOut when timeoutMs < forceKillAfterMs.
  const abortPidFile = join(root, 'abort-pid.txt')
  const abortSigFile = join(root, 'abort-sig.log')
  const stubbornAbort = makeNodeScript(root, 'stubborn-abort.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(abortSigFile)}, 'SIGTERM\\n') })
    writeFileSync(${JSON.stringify(abortPidFile)}, String(process.pid))
    setInterval(() => {}, 1000)
  `)
  const controller = new AbortController()
  const running = runProbeCommand(process.execPath, [stubbornAbort], { timeoutMs: 600, forceKillAfterMs: 1_200, signal: controller.signal })
  const abortPid = Number(await waitForFile(abortPidFile, 3_000))
  const abortStart = Date.now()
  controller.abort()
  const abortedResult = await running
  assert.equal(abortedResult.ok, false)
  assert.equal(abortedResult.aborted, true)
  assert.equal(abortedResult.timedOut, false, 'timeoutTimer must be cleared on abort before forceKillAfterMs elapses')
  assert.equal(abortedResult.signal, 'SIGKILL')
  assert.match(readFileSync(abortSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - abortStart < 4_000, 'aborted SIGTERM-ignoring child must be force-killed promptly')
  assert.equal(await waitForPidExit(abortPid), true, `aborted pid ${abortPid} should be dead`)

  // Output overflow terminates noisy probe cleanly and stops accumulating smaller trailing chunks.
  const noisy = makeNodeScript(root, 'noisy.mjs', `
    process.stdout.write('FIRST_CHUNK\\n')
    setTimeout(() => {
      process.stdout.write('x'.repeat(2048))
      process.stdout.write('TRAILING_MARKER')
    }, 20)
    setInterval(() => {}, 1000)
  `)
  const overflow = await runProbeCommand(process.execPath, [noisy], { timeoutMs: 5_000, forceKillAfterMs: 120, maxOutputBytes: 512 })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.overflowed, true)
  assert.doesNotMatch(overflow.stdout, /TRAILING_MARKER/, 'smaller chunks arriving after overflow must not be appended')
})

test('probeVersion, probeSignIn fallback, and terminateChild force-kill SIGTERM-ignoring processes', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-probe-kill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const makeHangingScript = (name, pidFile, sigFile) => makeNodeScript(root, name, `
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(sigFile)}, 'SIGTERM\\n') })
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
    setInterval(() => {}, 1000)
  `)

  // 1. probeVersion does not hang on a SIGTERM-ignoring CLI, and drops truncated version output on overflow/timeout.
  const verPidFile = join(root, 'ver-pid.txt')
  const verSigFile = join(root, 'ver-sig.log')
  const verScript = makeNodeScript(root, 'hanging-ver.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(verSigFile)}, 'SIGTERM\\n') })
    process.stdout.write('partial 0.0.1\\n')
    writeFileSync(${JSON.stringify(verPidFile)}, String(process.pid))
    setInterval(() => {}, 1000)
  `)
  const verStart = Date.now()
  const verPromise = probeVersion(process.execPath, [verScript], undefined, { timeoutMs: 1_200, forceKillAfterMs: 400 })
  const verPid = Number(await waitForFile(verPidFile, 3_000))
  const ver = await verPromise
  assert.equal(ver.ok, false)
  assert.equal(ver.version, undefined, 'timed-out truncated stdout must not be parsed as a version')
  assert.match(readFileSync(verSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - verStart < 5_000)
  assert.equal(await waitForPidExit(verPid), true, 'probeVersion child must be dead')

  const overflowVerScript = makeNodeScript(root, 'overflow-ver.mjs', 'process.stdout.write("fake 9.9.9\\n" + "z".repeat(4096))')
  const overflowVer = await probeVersion(process.execPath, [overflowVerScript], undefined, { timeoutMs: 5_000, forceKillAfterMs: 100, maxOutputBytes: 256 })
  assert.equal(overflowVer.ok, false)
  assert.equal(overflowVer.version, undefined, 'overflowed stdout must not be cached as a version')

  // 2. probeSignIn force-kills the hanging/overflowing status command, ignores truncated stdout, and falls back to credentials.toml.
  const signPidFile = join(root, 'sign-pid.txt')
  const signSigFile = join(root, 'sign-sig.log')
  const signScript = makeNodeScript(root, 'hanging-sign.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(signSigFile)}, 'SIGTERM\\n') })
    process.stdout.write('not logged in\\n')
    writeFileSync(${JSON.stringify(signPidFile)}, String(process.pid))
    setInterval(() => {}, 1000)
  `)
  const home = join(root, 'home')
  const devinDir = join(home, '.local', 'share', 'devin')
  mkdirSync(devinDir, { recursive: true })
  writeFileSync(join(devinDir, 'credentials.toml'), 'windsurf_api_key = "tok-fallback"\n')

  const signStart = Date.now()
  const check = { args: [signScript], fallback: ENGINES['local-devin-cli'].signedIn.fallback }
  const signPromise = probeSignIn(process.execPath, check, {
    home,
    platform: 'linux',
    env: {},
    timeoutMs: 1_200,
    forceKillAfterMs: 400,
  })
  const signPid = Number(await waitForFile(signPidFile, 3_000))
  const signedIn = await signPromise
  assert.equal(signedIn, true, 'must ignore truncated timed-out stdout and fall back to credentials.toml')
  assert.match(readFileSync(signSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - signStart < 5_000)
  assert.equal(await waitForPidExit(signPid), true, 'probeSignIn child must be dead')

  // Overflowed sign-in output also returns null and falls back instead of trusting truncated output.
  const overflowSign = makeNodeScript(root, 'overflow-sign.mjs', 'process.stdout.write("not logged in\\n" + "y".repeat(4096))')
  const overflowSignedIn = await probeSignIn(process.execPath, { args: [overflowSign], fallback: ENGINES['local-devin-cli'].signedIn.fallback }, {
    home,
    platform: 'linux',
    env: {},
    timeoutMs: 5_000,
    forceKillAfterMs: 100,
    maxOutputBytes: 256,
  })
  assert.equal(overflowSignedIn, true, 'overflowed sign-in probe must fall back instead of misclassifying truncated text')

  // Aborted probeSignIn exits immediately without consulting fallback stores.
  const abortedController = new AbortController()
  abortedController.abort()
  assert.equal(await probeSignIn(process.execPath, check, { home, platform: 'linux', env: {}, signal: abortedController.signal }), null)

  // 3. terminateChild escalates to SIGKILL after grace period.
  const termPidFile = join(root, 'term-pid.txt')
  const termSigFile = join(root, 'term-sig.log')
  const termScript = makeHangingScript('hanging-term.mjs', termPidFile, termSigFile)
  const child = spawn(process.execPath, [termScript], { stdio: 'ignore' })
  await waitForFile(termPidFile, 3_000)
  const killStart = Date.now()
  terminateChild(child, { forceKillAfterMs: 120 })
  const [, sig] = await new Promise(resolve => child.once('exit', (code, signal) => resolve([code, signal])))
  assert.equal(sig, 'SIGKILL')
  assert.match(readFileSync(termSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - killStart < 3_000)
  assert.equal(await waitForPidExit(child.pid), true)
})

test('terminateChild on win32 invokes taskkill /T /F first without prematurely calling child.kill()', () => {
  // Success path: taskkill exits 0 -> child.kill() is never called.
  const calls = []
  let childKills = 0
  const killerSuccess = new EventEmitter()
  const child1 = { pid: 4242, exitCode: null, signalCode: null, kill: () => { childKills += 1 } }
  terminateChild(child1, {
    platform: 'win32',
    spawnKiller: (cmd, args) => {
      calls.push([cmd, args])
      return killerSuccess
    },
  })
  assert.deepEqual(calls, [['taskkill', ['/pid', '4242', '/T', '/F']]])
  assert.equal(childKills, 0, 'must not call synchronous child.kill() while taskkill is running')
  killerSuccess.emit('close', 0)
  assert.equal(childKills, 0)

  // Failure path: taskkill exits non-zero while child is still alive -> falls back to child.kill() once.
  const killerFail = new EventEmitter()
  let child2Kills = 0
  const child2 = { pid: 5252, exitCode: null, signalCode: null, kill: () => { child2Kills += 1 } }
  terminateChild(child2, {
    platform: 'win32',
    spawnKiller: () => killerFail,
  })
  assert.equal(child2Kills, 0)
  killerFail.emit('close', 1)
  killerFail.emit('error', new Error('enoent'))
  assert.equal(child2Kills, 1, 'fallback child.kill() runs once if taskkill fails while child is alive')
})

test('ACP model probe injects MISE_OFFLINE=1 while live session keeps cleanEnv, and stale probes never overwrite refresh or live session models', async (t) => {
  const savedMise = process.env.MISE_OFFLINE
  delete process.env.MISE_OFFLINE
  t.after(() => {
    if (savedMise === undefined) delete process.env.MISE_OFFLINE
    else process.env.MISE_OFFLINE = savedMise
  })

  const root = mkdtempSync(join(tmpdir(), 'dsb-acp-epoch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const envLog = join(root, 'env-log.jsonl')
  const readyRefresh = join(root, 'ready-refresh')
  const readyLive = join(root, 'ready-live')
  const gate1 = join(root, 'release-1')
  const gateLive = join(root, 'release-live-probe')

  // Real ACP subprocess script that holds specific session/new probes behind gate files
  // so we can deterministically trigger out-of-order completion against refresh & live sessions.
  const acpScript = join(root, 'epoch-acp.mjs')
  writeFileSync(acpScript, `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
    const mode = process.argv[2] ?? 'refresh'
    const isProbe = process.env.MISE_OFFLINE === '1'
    appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ mode, mise: process.env.MISE_OFFLINE ?? null }) + '\\n')
    let buf = ''
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    const waitFile = (file, cb) => {
      if (existsSync(file)) { cb(); return }
      const iv = setInterval(() => { if (existsSync(file)) { clearInterval(iv); cb() } }, 15)
    }
    const modelReply = (sessionId, id, name) => ({
      sessionId,
      modes: { availableModes: [{ id: 'code', name: 'Code' }] },
      configOptions: [{ id: 'model', category: 'model', name: 'Model', options: [{ id, name }] }],
    })
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
        } else if (method === 'session/new') {
          if (mode === 'refresh') {
            if (!existsSync(${JSON.stringify(readyRefresh)})) {
              writeFileSync(${JSON.stringify(readyRefresh)}, '1')
              waitFile(${JSON.stringify(gate1)}, () => send({ jsonrpc: '2.0', id, result: modelReply('s-stale', 'stale-v1', 'Stale V1') }))
            } else {
              send({ jsonrpc: '2.0', id, result: modelReply('s-fresh', 'fresh-v2', 'Fresh V2') })
            }
          } else if (mode === 'live') {
            if (isProbe) {
              writeFileSync(${JSON.stringify(readyLive)}, '1')
              waitFile(${JSON.stringify(gateLive)}, () => send({ jsonrpc: '2.0', id, result: modelReply('s-probe', 'probe-old', 'Probe Old') }))
            } else {
              send({ jsonrpc: '2.0', id, result: modelReply('s-live', 'live-v2', 'Live V2') })
            }
          }
        } else if (method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
        } else if (method === 'session/close') {
          send({ jsonrpc: '2.0', id, result: {} })
        } else if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        }
      }
    })
  `)

  const makeAdapter = (mode, engines = []) => new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'epoch', name: 'Epoch ACP', command: process.execPath, args: [acpScript, mode] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => {
      const engine = new AcpEngine(route, spec, { findExecutable: path => path })
      engines.push(engine)
      return engine
    },
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => root,
    probeCwd: () => root,
    toolsFor: () => [],
  })

  // Case 1: Slow pre-refresh probe resolves AFTER fast post-refresh probe -> must NOT overwrite fresh-v2.
  const refreshEngines = []
  const refreshAdapter = makeAdapter('refresh', refreshEngines)
  t.after(() => refreshAdapter.dispose())

  const staleProbe = refreshAdapter.probeModels('local-acp-epoch')
  await waitForFile(readyRefresh, 3_000)

  // User triggers refresh (drops cache + bumps epoch).
  refreshAdapter.dropModelCache('local-acp-epoch')
  const freshModels = await refreshAdapter.probeModels('local-acp-epoch')
  assert.deepEqual(freshModels.map(m => m.id), ['default', 'fresh-v2'])
  assert.deepEqual(refreshEngines[0].listed.modes.map(m => m.id), ['code'])
  // invalidateListed preserves modes for concurrent session/load resumes while advancing epoch.
  refreshEngines[0].invalidateListed()
  assert.deepEqual(refreshEngines[0].listed.modes.map(m => m.id), ['code'])

  // Now release the stale probe that started before refresh.
  writeFileSync(gate1, 'go')
  await staleProbe
  const afterStale = await refreshAdapter.listModels('local-acp-epoch')
  assert.deepEqual(afterStale.map(m => m.id), ['default', 'fresh-v2'], 'stale pre-refresh probe must not overwrite fresh-v2')
  assert.equal(refreshEngines[0].listed.configOptions[0].options[0].id, 'fresh-v2', 'AcpEngine.listed must retain fresh-v2')

  // Case 2: Concurrent background probe + live session open on shared (non-cwdPerProcess) ACP engine:
  // probe runs in an isolated process with MISE_OFFLINE=1, live session spawns clean without MISE_OFFLINE,
  // and late probe never overwrites live-discovered models.
  const liveEngines = []
  const liveAdapter = makeAdapter('live', liveEngines)
  t.after(() => liveAdapter.dispose())

  const slowBackgroundProbe = liveAdapter.probeModels('local-acp-epoch')
  await waitForFile(readyLive, 3_000)

  const chunks = []
  for await (const chunk of liveAdapter.stream({
    sessionId: 'sess-live-1',
    provider: 'local-acp-epoch',
    model: 'default',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  })) {
    chunks.push(chunk)
  }
  assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'ok'))
  assert.deepEqual((await liveAdapter.listModels('local-acp-epoch')).map(m => m.id), ['default', 'live-v2'])

  // Release the older background probe returning 'probe-old'.
  writeFileSync(gateLive, 'go')
  await slowBackgroundProbe
  assert.deepEqual((await liveAdapter.listModels('local-acp-epoch')).map(m => m.id), ['default', 'live-v2'], 'late probe must not overwrite live-discovered models')
  assert.equal(liveEngines[0].listed.configOptions[0].options[0].id, 'live-v2', 'AcpEngine.listed must retain live-v2')

  const entries = readFileSync(envLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const liveEntries = entries.filter(e => e.mode === 'live')
  assert.ok(liveEntries.some(e => e.mise === '1'), 'background ACP probe must spawn with MISE_OFFLINE=1')
  assert.ok(liveEntries.some(e => e.mise === null), 'concurrent live ACP session must NOT inherit MISE_OFFLINE=1 from probe')

  // Case 3: CodexEngine concurrent model probe + live peer isolation (MISE_OFFLINE=1 never leaks to live Codex peer).
  const codexEnvLog = join(root, 'codex-env.jsonl')
  const codexReady = join(root, 'codex-probe-ready')
  const codexGate = join(root, 'codex-probe-release')
  const codexScript = makeNodeScript(root, 'fake-codex-probe.mjs', `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
    const isProbe = process.env.MISE_OFFLINE === '1'
    appendFileSync(${JSON.stringify(codexEnvLog)}, JSON.stringify({ mise: process.env.MISE_OFFLINE ?? null }) + '\\n')
    let buf = ''
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    const waitFile = (file, cb) => {
      if (existsSync(file)) { cb(); return }
      const iv = setInterval(() => { if (existsSync(file)) { clearInterval(iv); cb() } }, 15)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const { id, method } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'model/list') {
          if (isProbe) {
            writeFileSync(${JSON.stringify(codexReady)}, '1')
            waitFile(${JSON.stringify(codexGate)}, () => send({ jsonrpc: '2.0', id, result: { data: [{ id: 'codex-m1', displayName: 'Codex M1' }] } }))
          } else {
            send({ jsonrpc: '2.0', id, result: { data: [{ id: 'codex-m1', displayName: 'Codex M1' }] } })
          }
        }
      }
    })
  `)
  const codexEngine = new CodexEngine('local-codex-cli', { name: 'Codex', command: process.execPath, args: [codexScript] }, { findExecutable: p => p })
  t.after(() => codexEngine.close())
  const codexProbe = codexEngine.listModels()
  await waitForFile(codexReady, 3_000)
  // Concurrent live ensure() on the same CodexEngine spawns its own clean process without MISE_OFFLINE=1.
  await codexEngine.ensure()
  writeFileSync(codexGate, 'go')
  const codexModels = await codexProbe
  assert.deepEqual(codexModels.map(m => m.id), ['codex-m1'])
  const codexEntries = readFileSync(codexEnvLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(codexEntries.some(e => e.mise === '1'), 'Codex background probe must run with MISE_OFFLINE=1')
  assert.ok(codexEntries.some(e => e.mise === null), 'Codex live peer must NOT inherit MISE_OFFLINE=1 from concurrent probe')
})

test('dropModelCache without immediate re-probe still discards an in-flight pre-refresh probe', async (t) => {
  let releaseOld
  let calls = 0
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'drop', name: 'Drop ACP', command: 'drop', args: [] }],
    findExecutable: path => path,
    spawnEngine: () => ({
      listModels: async () => {
        calls += 1
        if (calls === 1) {
          await new Promise((resolve) => { releaseOld = resolve })
          return [{ id: 'stale-before-drop', name: 'Stale' }]
        }
        return [{ id: 'fresh-after-drop', name: 'Fresh' }]
      },
      close: async () => {},
    }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    probeCwd: () => tmpdir(),
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  const inFlight = adapter.probeModels('local-acp-drop')
  await new Promise(resolve => setTimeout(resolve, 10))
  adapter.dropModelCache()
  releaseOld()
  await inFlight

  assert.equal(adapter.modelCache.has('local-acp-drop'), false, 'stale probe must not repopulate cache after dropModelCache')
  const fresh = await adapter.probeModels('local-acp-drop')
  assert.deepEqual(fresh.map(m => m.id), ['default', 'fresh-after-drop'])
  assert.equal(calls, 2)
})

test('index.js probeVersions uses epoch guards so a slow pre-refresh version probe cannot overwrite refreshed version', async (t) => {
  await refreshSearchDirs()
  const saved = { ...ENGINES }
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-devin-cli'] = { ...saved['local-devin-cli'], command: process.execPath, commands: [process.execPath], version: ['-v'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, saved)
  })

  let releaseSlowVersion
  let versionCalls = 0
  const seenEnvs = []
  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  const rt = { ctx, state: { bots: {}, localAgents: { custom: [], sessions: {} } }, save: async () => {} }
  t.after(async () => { await ctx.dispose(); await owner.fiber.dispose() })

  installLocalAgents(rt, {
    probeSignIn: async () => true,
    probeVersion: async (_path, _args, env) => {
      seenEnvs.push(env)
      versionCalls += 1
      if (versionCalls === 1) {
        return new Promise((resolve) => { releaseSlowVersion = () => resolve({ ok: true, version: 'devin 1.0.0' }) })
      }
      return { ok: true, version: 'devin 2.0.0' }
    },
  })

  const slowList = rt.localAgentsEndpoint('local-agents', {})
  while (releaseSlowVersion === undefined) await new Promise(resolve => setTimeout(resolve, 10))

  const refreshed = await rt.localAgentsEndpoint('local-agent-refresh', {})
  assert.equal(refreshed.detected.find(entry => entry.route === 'local-devin-cli')?.version, 'devin 2.0.0')

  // Late pre-refresh version probe resolves after refresh completed.
  releaseSlowVersion()
  await slowList

  const after = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(after.detected.find(entry => entry.route === 'local-devin-cli')?.version, 'devin 2.0.0')
  assert.equal(seenEnvs[0]?.MISE_OFFLINE, '1')
})
