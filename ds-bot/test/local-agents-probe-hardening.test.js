import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
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
  // Explicit extra override wins.
  assert.equal(probeEnv({ MISE_OFFLINE: '0' }).MISE_OFFLINE, '0')
  assert.equal(withProbeEnv({ MISE_OFFLINE: '0' }).MISE_OFFLINE, '0')
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
  const runningTimeout = runProbeCommand(process.execPath, [stubborn], { timeoutMs: 300, forceKillAfterMs: 120 })
  const pids = JSON.parse(await waitForFile(pidFile, 3_000))
  const result = await runningTimeout
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL', 'must escalate to SIGKILL after SIGTERM is ignored')
  assert.match(readFileSync(sigFile, 'utf8'), /SIGTERM/, 'child must have received and ignored SIGTERM first')
  assert.ok(elapsed < 2_500, `expected force-kill within grace period, took ${elapsed}ms`)
  assert.equal(await waitForPidExit(pids.parent), true, `parent pid ${pids.parent} should be dead`)
  assert.equal(await waitForPidExit(pids.child), true, `grandchild pid ${pids.child} should be dead`)

  // Abort path also escalates SIGTERM -> SIGKILL cleanly.
  const abortPidFile = join(root, 'abort-pid.txt')
  const abortSigFile = join(root, 'abort-sig.log')
  const stubbornAbort = makeNodeScript(root, 'stubborn-abort.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(abortSigFile)}, 'SIGTERM\\n') })
    writeFileSync(${JSON.stringify(abortPidFile)}, String(process.pid))
    setInterval(() => {}, 1000)
  `)
  const controller = new AbortController()
  const running = runProbeCommand(process.execPath, [stubbornAbort], { timeoutMs: 10_000, forceKillAfterMs: 120, signal: controller.signal })
  const abortPid = Number(await waitForFile(abortPidFile, 3_000))
  const abortStart = Date.now()
  controller.abort()
  const abortedResult = await running
  assert.equal(abortedResult.ok, false)
  assert.equal(abortedResult.aborted, true)
  assert.equal(abortedResult.signal, 'SIGKILL')
  assert.match(readFileSync(abortSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - abortStart < 2_500, 'aborted SIGTERM-ignoring child must be force-killed promptly')
  assert.equal(await waitForPidExit(abortPid), true, `aborted pid ${abortPid} should be dead`)

  // Output overflow terminates noisy probe cleanly.
  const noisy = makeNodeScript(root, 'noisy.mjs', 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)')
  const overflow = await runProbeCommand(process.execPath, [noisy], { timeoutMs: 5_000, forceKillAfterMs: 100, maxOutputBytes: 512 })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.overflowed, true)
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

  // 1. probeVersion does not hang on a SIGTERM-ignoring CLI.
  const verPidFile = join(root, 'ver-pid.txt')
  const verSigFile = join(root, 'ver-sig.log')
  const verScript = makeHangingScript('hanging-ver.mjs', verPidFile, verSigFile)
  const verStart = Date.now()
  const verPromise = probeVersion(process.execPath, [verScript], undefined, { timeoutMs: 300, forceKillAfterMs: 120 })
  const verPid = Number(await waitForFile(verPidFile, 3_000))
  const ver = await verPromise
  assert.equal(ver.ok, false)
  assert.equal(ver.version, undefined)
  assert.match(readFileSync(verSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - verStart < 2_500)
  assert.equal(await waitForPidExit(verPid), true, 'probeVersion child must be dead')

  // 2. probeSignIn force-kills the hanging status command and falls back to credentials.toml.
  const signPidFile = join(root, 'sign-pid.txt')
  const signSigFile = join(root, 'sign-sig.log')
  const signScript = makeHangingScript('hanging-sign.mjs', signPidFile, signSigFile)
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
    timeoutMs: 300,
    forceKillAfterMs: 120,
  })
  const signPid = Number(await waitForFile(signPidFile, 3_000))
  const signedIn = await signPromise
  assert.equal(signedIn, true, 'must fall back to credentials.toml after force-killing hanging status CLI')
  assert.match(readFileSync(signSigFile, 'utf8'), /SIGTERM/)
  assert.ok(Date.now() - signStart < 2_500)
  assert.equal(await waitForPidExit(signPid), true, 'probeSignIn child must be dead')

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
  assert.ok(Date.now() - killStart < 2_500)
  assert.equal(await waitForPidExit(child.pid), true)
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
  const gate1 = join(root, 'release-1')
  const gateLive = join(root, 'release-live-probe')

  // Real ACP subprocess script that holds specific session/new probes behind gate files
  // so we can deterministically trigger out-of-order completion against refresh & live sessions.
  const acpScript = join(root, 'epoch-acp.mjs')
  writeFileSync(acpScript, `
    import { appendFileSync, existsSync } from 'node:fs'
    const mode = process.argv[2] ?? 'refresh'
    appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ mode, mise: process.env.MISE_OFFLINE ?? null }) + '\\n')
    let buf = '', count = 0
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    const waitFile = (file, cb) => {
      if (existsSync(file)) { cb(); return }
      const iv = setInterval(() => { if (existsSync(file)) { clearInterval(iv); cb() } }, 15)
    }
    const modelReply = (sessionId, id, name) => ({
      sessionId,
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
          count += 1
          if (mode === 'refresh') {
            if (count === 1) {
              waitFile(${JSON.stringify(gate1)}, () => send({ jsonrpc: '2.0', id, result: modelReply('s-stale', 'stale-v1', 'Stale V1') }))
            } else {
              send({ jsonrpc: '2.0', id, result: modelReply('s-fresh', 'fresh-v2', 'Fresh V2') })
            }
          } else if (mode === 'live') {
            if (count === 1) {
              waitFile(${JSON.stringify(gateLive)}, () => send({ jsonrpc: '2.0', id, result: modelReply('s-probe', 'probe-old', 'Probe Old') }))
            } else {
              send({ jsonrpc: '2.0', id, result: modelReply('s-live', 'live-v2', 'Live V2') })
            }
          } else if (mode === 'env-only') {
            send({ jsonrpc: '2.0', id, result: modelReply('s-env', 'env-m', 'Env M') })
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
  // Wait until session/new #1 is in flight on the real subprocess.
  while ((refreshEngines[0]?.peer?.nextId ?? 0) < 2) await new Promise(resolve => setTimeout(resolve, 10))

  // User triggers refresh (drops cache + bumps epoch).
  refreshAdapter.dropModelCache('local-acp-epoch')
  const freshModels = await refreshAdapter.probeModels('local-acp-epoch')
  assert.deepEqual(freshModels.map(m => m.id), ['default', 'fresh-v2'])

  // Now release the stale probe that started before refresh.
  writeFileSync(gate1, 'go')
  await staleProbe
  const afterStale = await refreshAdapter.listModels('local-acp-epoch')
  assert.deepEqual(afterStale.map(m => m.id), ['default', 'fresh-v2'], 'stale pre-refresh probe must not overwrite fresh-v2')
  assert.equal(refreshEngines[0].listed.configOptions[0].options[0].id, 'fresh-v2', 'AcpEngine.listed must retain fresh-v2')

  // Case 2: Slow background probe resolves AFTER a live session already opened and discovered newer models.
  const liveEngines = []
  const liveAdapter = makeAdapter('live', liveEngines)
  t.after(() => liveAdapter.dispose())

  const slowBackgroundProbe = liveAdapter.probeModels('local-acp-epoch')
  while ((liveEngines[0]?.peer?.nextId ?? 0) < 2) await new Promise(resolve => setTimeout(resolve, 10))

  // Start a live turn on the same route; its session/new advertises 'live-v2'.
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

  // Now release the older background probe returning 'probe-old'.
  writeFileSync(gateLive, 'go')
  await slowBackgroundProbe
  assert.deepEqual((await liveAdapter.listModels('local-acp-epoch')).map(m => m.id), ['default', 'live-v2'], 'late probe must not overwrite live-discovered models')
  assert.equal(liveEngines[0].listed.configOptions[0].options[0].id, 'live-v2', 'AcpEngine.listed must retain live-v2')

  // Case 3: Verify probe spawn received MISE_OFFLINE=1 whereas a fresh live session did not force MISE_OFFLINE.
  const envAdapter = makeAdapter('env-only')
  t.after(() => envAdapter.dispose())
  const envChunks = []
  for await (const chunk of envAdapter.stream({
    sessionId: 'sess-env-1',
    provider: 'local-acp-epoch',
    model: 'default',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  })) { envChunks.push(chunk) }
  assert.ok(envChunks.length > 0)

  const entries = readFileSync(envLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const refreshEntry = entries.find(e => e.mode === 'refresh')
  const liveOnlyEntry = entries.find(e => e.mode === 'env-only')
  assert.equal(refreshEntry?.mise, '1', 'ACP model probe spawn must set MISE_OFFLINE=1')
  assert.equal(liveOnlyEntry?.mise, null, 'live ACP session spawn must not force MISE_OFFLINE')
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
