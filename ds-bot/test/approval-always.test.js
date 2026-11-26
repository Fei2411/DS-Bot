import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installApprovals } from '../src/host/approvals.js'
import { install as installChannel } from '../src/host/channel.js'
import { ESCALATION, MAX_EXTRA_DIRS, install as installExtraFolders } from '../src/host/extra-folders.js'
import { install as installFolders } from '../src/host/folders.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await tick()
  }
  return predicate()
}

function setup(t, { privateBot = false, existingExtraDirs = [], readOnly = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-always-')))
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const ws = join(root, 'workspace')
  const extraDir = join(root, 'external-docs')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(extraDir, { recursive: true })

  const listeners = new Map()
  const routes = {}
  const dispose = []
  const bots = {
    b1: {
      id: 'b1',
      sessionId: 'b1',
      name: 'Helper',
      role: 'Assistant',
      instructions: '',
      createdAt: 1,
      ...(privateBot ? { private: true } : {}),
      ...(existingExtraDirs.length ? { extraDirs: existingExtraDirs } : {}),
    },
  }
  const rooms = {}
  const services = {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws }) },
    fs: {
      resolve: async target => target,
      processPath: p => p,
      processPathFromHostPath: p => p,
    },
  }
  const runChain = (name, arg) => {
    const list = listeners.get(name) ?? []
    let i = 0
    const next = () => {
      const fn = list[i++]
      return fn ? fn(arg, next) : 'unavailable'
    }
    return Promise.resolve(next())
  }
  services.approval = { request: req => runChain('approval/request', req) }

  const ctx = {
    logger: { warn() {}, info() {} },
    get: name => services[name],
    reflect: { get: name => services[name] },
    on(name, fn, opts) {
      const prev = listeners.get(name) ?? []
      listeners.set(name, opts?.prepend ? [fn, ...prev] : [...prev, fn])
      return () => {}
    },
    effect(fn) { dispose.push(fn()) },
    systemPrompt: { section: () => () => {} },
    workspaceRegistry: { get: id => (id === 'ws-1' ? { id: 'ws-1', path: ws } : undefined) },
    connection: { fetch: { register: (opts) => { routes[opts.path] = opts; return () => {} } } },
  }

  let saved = 0
  const rt = {
    ctx,
    home,
    dshHome,
    config: {},
    readOnly: () => (readOnly ? 'This window is read-only. Close the other DS Bot window to make changes here.' : undefined),
    phoneServe: () => {},
    state: { version: 1, workspaceId: 'ws-1', bots, rooms, prefs: {} },
    chatOwners: new Map([['b1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    botOf: id => bots[id],
    roomOf: id => rooms[id],
    selfOf: id => (id === 'b1' ? 'b1' : undefined),
    chatOf: id => (id === 'b1' ? 'b1' : undefined),
    load: async () => {},
    refresh: async () => {},
    save: async () => { saved += 1 },
    warn() {},
    stateView: () => ({}),
    workView: () => ({}),
  }

  installFolders(rt)
  installExtraFolders(rt)
  installApprovals(rt)
  installChannel(rt)

  t.after(() => {
    for (const fn of dispose) fn?.()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })

  const callApi = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  return {
    root, home, ws, extraDir, rt, bots,
    get saved() { return saved },
    requestApproval: req => runChain('approval/request', req),
    firePreExecute: exec => runChain('tools/pre-execute', exec),
    callApi,
  }
}

test('browser write approval stays strictly one-time while exposing localized displayReason', async (t) => {
  const env = setup(t)
  const agent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: env.ws } } }
  const promise = env.rt.requestActionApproval({
    agent,
    toolName: 'browser_click',
    callId: 'c-browser-1',
    reason: 'Let Helper download a file on github.com: "Release asset"?',
    displayReason: { en: 'Let Helper download a file on github.com: "Release asset"?', zh: '允许 Helper 在 github.com 上下载文件“Release asset”吗？' },
  }, { kind: 'browser', action: { kind: 'download', host: 'github.com', label: 'Release asset' } })

  const open = env.rt.approvalsView()
  assert.equal(open.length, 1)
  assert.equal(open[0].alwaysAllow, undefined)
  assert.equal(open[0].displayReason.zh, '允许 Helper 在 github.com 上下载文件“Release asset”吗？')

  const refused = await env.callApi('approval-answer', { id: open[0].id, choice: 'always' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/refused')
  assert.equal(env.bots.b1.browserGrants, undefined)

  const res = await env.callApi('approval-answer', { id: open[0].id, choice: 'allow' })
  assert.equal(res.ok, true)
  assert.equal(await promise, 'allowed-once')
})

test('file-tool sandbox escalation offers Always allow for direct Bot sessions, persists extraDirs, and withholds Always allow for subagents', async (t) => {
  const env = setup(t)
  const targetFile = join(env.extraDir, 'notes.md')
  const agent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: env.ws } } }
  env.rt.resolveAgent = async id => (id === 'b1' ? agent : undefined)

  // Direct Bot session gets Always allow for eligible extra folder.
  await env.firePreExecute({
    agent,
    callId: 'c-write-1',
    name: 'write',
    arguments: { file_path: targetFile, content: 'hello', sandbox_permissions: 'danger-full-access' },
  })
  const promise = env.requestApproval({
    agent,
    toolName: 'write',
    callId: 'c-write-1',
    reason: `${ESCALATION} write notes outside workspace`,
  })
  const resolved = await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  assert.deepEqual(resolved, { kind: 'extra-dir', dirs: [env.extraDir] })

  const open = env.rt.approvalsView()
  assert.equal(open.length, 1)
  await env.rt.answerApproval(open[0].id, 'always')
  assert.equal(await promise, 'allowed-once')
  assert.deepEqual(env.bots.b1.extraDirs, [env.extraDir])

  // Subagent child session under the same Bot must NOT receive Always allow, since extraDirsOfSession does not index child sessions.
  // Hold the fallback DSH approval handler open (matching DSH's real waiter) until cancelled or answered.
  env.rt.ctx.on('approval/request', req => new Promise((resolve) => {
    req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))
  const subDir = join(env.root, 'sub-docs')
  mkdirSync(subDir, { recursive: true })
  const childAgent = { id: 'sub-child-1', session: { id: 'sub-child-1', header: { id: 'sub-child-1', cwd: env.ws, origin: 'subagent', parentSession: 'b1' } } }
  await env.firePreExecute({
    agent: childAgent,
    callId: 'c-sub-write',
    name: 'write',
    arguments: { file_path: join(subDir, 'out.md'), content: 'child', sandbox_permissions: 'danger-full-access' },
  })
  const subPromise = env.requestApproval({
    agent: childAgent,
    toolName: 'write',
    callId: 'c-sub-write',
    reason: `${ESCALATION} write from subagent`,
  })
  await tick()
  await tick()
  const subOpen = env.rt.approvalsView()
  assert.equal(subOpen.length, 1)
  assert.equal(subOpen[0].alwaysAllow, undefined)
  env.rt.answerApproval(subOpen[0].id, 'reject')
  assert.equal(await subPromise, 'rejected')
})

test('Always allow is strictly withheld for bash, privacy approvals, private Bots, guarded dirs, MAX_EXTRA_DIRS, and read-only windows', async (t) => {
  const env = setup(t)
  const agent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: env.ws } } }

  // 1. bash escalation never gets Always allow.
  const bashPromise = env.requestApproval({
    agent,
    toolName: 'bash',
    callId: 'c-bash-1',
    reason: `${ESCALATION} run curl`,
  })
  await tick()
  const bashEntry = env.rt.approvalsView()[0]
  assert.equal(bashEntry.alwaysAllow, undefined)
  assert.throws(() => env.rt.answerApproval(bashEntry.id, 'always'), { code: 'bot/refused' })
  env.rt.answerApproval(bashEntry.id, 'reject')
  assert.equal(await bashPromise, 'rejected')

  // 2. Privacy approval never gets Always allow even with browser evidence.
  const privPromise = env.rt.requestActionApproval({
    agent,
    toolName: 'browser_click',
    callId: 'c-priv-1',
    reason: 'Privacy gate',
    privacy: true,
  }, { kind: 'browser', action: { kind: 'post', host: 'example.com', label: 'Post' } })
  const privEntry = env.rt.approvalsView()[0]
  assert.equal(privEntry.alwaysAllow, undefined)
  env.rt.answerApproval(privEntry.id, 'reject')
  assert.equal(await privPromise, 'rejected')

  // 3. Guarded data directory escalation never gets Always allow.
  const guardedFile = join(env.home, 'state.json')
  await env.firePreExecute({
    agent,
    callId: 'c-guard-1',
    name: 'edit',
    arguments: { file_path: guardedFile, old_string: 'a', new_string: 'b', sandbox_permissions: 'danger-full-access' },
  })
  const guardPromise = env.requestApproval({
    agent,
    toolName: 'edit',
    callId: 'c-guard-1',
    reason: `${ESCALATION} edit state.json`,
  })
  await tick()
  const guardEntry = env.rt.approvalsView()[0]
  assert.equal(guardEntry.alwaysAllow, undefined)
  env.rt.answerApproval(guardEntry.id, 'reject')
  assert.equal(await guardPromise, 'rejected')

  // 4. Private Bot never gets Always allow.
  const privEnv = setup(t, { privateBot: true })
  const privAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: privEnv.ws } } }
  const p4 = privEnv.rt.requestActionApproval({
    agent: privAgent,
    toolName: 'browser_click',
    callId: 'c-pbot-1',
    reason: 'Download',
  }, { kind: 'browser', action: { kind: 'download', host: 'example.com', label: 'File' } })
  assert.equal(privEnv.rt.approvalsView()[0].alwaysAllow, undefined)
  privEnv.rt.answerApproval(privEnv.rt.approvalsView()[0].id, 'reject')
  assert.equal(await p4, 'rejected')

  // 5. Read-only window refuses choice === 'always' through api/bot.
  const roEnv = setup(t, { readOnly: true })
  const roAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: roEnv.ws } } }
  const p5 = roEnv.rt.requestActionApproval({
    agent: roAgent,
    toolName: 'browser_click',
    callId: 'c-ro-1',
    reason: 'Download',
  }, { kind: 'browser', action: { kind: 'download', host: 'example.com', label: 'File' } })
  const roEntry = roEnv.rt.approvalsView()[0]
  const res = await roEnv.callApi('approval-answer', { id: roEntry.id, choice: 'always' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bot/read-only')
  roEnv.rt.answerApproval(roEntry.id, 'reject')
  assert.equal(await p5, 'rejected')

  // 6. Bot already at MAX_EXTRA_DIRS does not offer Always allow for another folder.
  const fullEnv = setup(t, { existingExtraDirs: Array.from({ length: MAX_EXTRA_DIRS }, (_, i) => `/tmp/dir-${i}`) })
  const fullAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: fullEnv.ws } } }
  await fullEnv.firePreExecute({
    agent: fullAgent,
    callId: 'c-max-1',
    name: 'write',
    arguments: { file_path: join(fullEnv.extraDir, 'extra.txt'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const p6 = fullEnv.requestApproval({
    agent: fullAgent,
    toolName: 'write',
    callId: 'c-max-1',
    reason: `${ESCALATION} write extra`,
  })
  await tick()
  assert.equal(fullEnv.rt.approvalsView()[0].alwaysAllow, undefined)
  fullEnv.rt.answerApproval(fullEnv.rt.approvalsView()[0].id, 'reject')
  assert.equal(await p6, 'rejected')
})
