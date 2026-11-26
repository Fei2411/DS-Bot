import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
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

function setup(t, { privateBot = false, existingExtraDirs = [], readOnly = false, privateClashFn = null, withRoom = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-always-')))
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
  const rooms = withRoom
    ? {
        r1: {
          id: 'r1',
          sessionId: 'r1-own',
          name: 'Design',
          workDir: ws,
          members: ['b1'],
          sessions: { b1: 'g-b1' },
        },
      }
    : {}
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
  const clashCalls = []
  const rt = {
    ctx,
    home,
    dshHome,
    config: {},
    readOnly: () => (readOnly ? 'This window is read-only. Close the other DS Bot window to make changes here.' : undefined),
    phoneServe: () => {},
    state: { version: 1, revision: 1, workspaceId: 'ws-1', bots, rooms, prefs: {} },
    chatOwners: new Map([['b1', 'b1'], ...(withRoom ? [['g-b1', 'b1']] : [])]),
    groupOwners: new Map(withRoom ? [['g-b1', { roomId: 'r1', botId: 'b1' }]] : []),
    pastOwners: new Map(),
    botOf: id => bots[id],
    roomOf: id => rooms[id],
    selfOf: id => (id === 'b1' ? 'b1' : undefined),
    chatOf: id => (id === 'b1' ? 'b1' : undefined),
    bootstrap: async () => {},
    catalog: async () => [],
    cachedCatalog: () => [],
    cachedDefault: () => null,
    loadSecrets: async () => {},
    secretStoreStatus: () => ({}),
    secretsView: () => [],
    activityView: () => ({}),
    roomWorkView: () => ({}),
    memoryNews: () => ({}),
    memoryReviews: () => [],
    learningView: () => ({}),
    learningSettledView: () => ({}),
    connectorsView: () => ({}),
    capabilityStatusesView: () => ({}),
    phoneView: () => ({}),
    load: async () => {},
    refresh: async () => {},
    save: async () => { saved += 1 },
    warn() {},
    stateView: () => ({}),
    workView: () => ({}),
    ...(privateClashFn
      ? {
          privateClash: async (dir, opts) => {
            clashCalls.push({ dir, opts })
            return privateClashFn(dir, opts)
          },
        }
      : {}),
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
    root, home, ws, extraDir, rt, bots, rooms, clashCalls,
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
  assert.deepEqual(resolved, { kind: 'extra-dir', dirs: [env.extraDir], scope: 'bot' })

  // Remote channel calls strip alwaysAllow from state and refuse choice === 'always'.
  const remoteState = await env.rt.channelCall('state', { since: 1 }, undefined, true)
  assert.equal(remoteState.ok, true)
  assert.equal(remoteState.value.work.approvals[0].alwaysAllow, undefined)
  const remoteAlways = await env.rt.channelCall('approval-answer', { id: env.rt.approvalsView()[0].id, choice: 'always' }, undefined, true)
  assert.equal(remoteAlways.ok, false)
  assert.equal(remoteAlways.error.code, 'bot/refused')

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

test('extra-folder Always allow never walks up missing ancestors, refuses root/home, passes options object to privateClash, and scopes group grants', async (t) => {
  const privateDir = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-priv-'))), 'secret-bot')
  mkdirSync(privateDir, { recursive: true })
  t.after(() => rmSync(join(privateDir, '..'), { recursive: true, force: true, maxRetries: 5 }))

  const env = setup(t, {
    withRoom: true,
    privateClashFn: (dir, opts) => {
      assert.equal(typeof opts, 'object', 'privateClash must receive an options object, not a string')
      assert.notEqual(opts, null)
      if (dir === privateDir) return 'Another private Bot owns that folder'
      return undefined
    },
  })
  const agent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: env.ws } } }

  // 1. Missing parent folder: NEVER walks up to an existing ancestor (root); must withhold Always allow.
  const missingTarget = join(env.root, 'does-not-exist', 'nested', 'out.md')
  assert.deepEqual(await env.rt.resolvableExtraDirs({ session: agent.session, botId: 'b1', name: 'write', args: { file_path: missingTarget } }), [])
  await assert.rejects(
    () => env.rt.grantExtraDirs({ botId: 'b1', dirs: [join(env.root, 'does-not-exist', 'nested')] }),
    { code: 'bot/refused' },
  )

  // 2. Filesystem root and user home directory are ALWAYS refused.
  const fsRoot = parse(env.root).root
  assert.deepEqual(await env.rt.resolvableExtraDirs({ session: agent.session, botId: 'b1', name: 'write', args: { file_path: join(fsRoot, 'foo.txt') } }), [])
  await assert.rejects(() => env.rt.grantExtraDirs({ botId: 'b1', dirs: [fsRoot] }), { code: 'bot/refused' })

  const userHome = homedir()
  assert.deepEqual(await env.rt.resolvableExtraDirs({ session: agent.session, botId: 'b1', name: 'write', args: { file_path: join(userHome, 'foo.txt') } }), [])
  await assert.rejects(() => env.rt.grantExtraDirs({ botId: 'b1', dirs: [userHome] }), { code: 'bot/refused' })

  // Ancestor above homedir() (e.g. /Users, /home, C:\Users) is also refused even when DSH_HOME is isolated elsewhere.
  const homeReal = realpathSync.native(userHome)
  const homeAncestor = dirname(homeReal)
  if (homeAncestor && homeAncestor !== homeReal) {
    assert.deepEqual(await env.rt.resolvableExtraDirs({ session: agent.session, botId: 'b1', name: 'write', args: { file_path: join(homeAncestor, 'foo.txt') } }), [])
    await assert.rejects(() => env.rt.grantExtraDirs({ botId: 'b1', dirs: [homeAncestor] }), { code: 'bot/refused' })
  }

  // 3. Private folder clash receives `{ except: 'b1' }` and blocks Always allow.
  assert.deepEqual(await env.rt.resolvableExtraDirs({ session: agent.session, botId: 'b1', name: 'write', args: { file_path: join(privateDir, 'doc.md') } }), [])
  assert.deepEqual(env.clashCalls.at(-1)?.opts, { except: 'b1' })
  await assert.rejects(() => env.rt.grantExtraDirs({ botId: 'b1', dirs: [privateDir] }), { code: 'bot/refused' })

  // 4. Group-scoped approval passes `{}` (no `except`) to privateClash and marks `scope: 'group'` with `scopeName`.
  const groupAgent = { id: 'g-b1', session: { id: 'g-b1', header: { id: 'g-b1', cwd: env.ws } } }
  env.rt.resolveAgent = async id => (id === 'g-b1' ? groupAgent : agent)
  await env.firePreExecute({
    agent: groupAgent,
    callId: 'c-group-write',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'shared.md'), content: 'group', sandbox_permissions: 'danger-full-access' },
  })
  const groupPromise = env.requestApproval({
    agent: groupAgent,
    toolName: 'write',
    callId: 'c-group-write',
    reason: `${ESCALATION} write group file`,
  })
  const groupAlways = await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  assert.deepEqual(groupAlways, { kind: 'extra-dir', dirs: [env.extraDir], scope: 'group', scopeName: 'Design' })
  assert.deepEqual(env.clashCalls.at(-1)?.opts, {})
  await env.rt.answerApproval(env.rt.approvalsView()[0].id, 'always')
  assert.equal(await groupPromise, 'allowed-once')
  assert.deepEqual(env.rooms.r1.extraDirs, [env.extraDir])
  assert.equal(env.bots.b1.extraDirs, undefined)
})

test('Always allow never persists extraDirs if the approval is aborted, already settled, or cancelled before settlement', async (t) => {
  const env = setup(t)
  const agent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: env.ws } } }
  env.rt.resolveAgent = async () => agent

  // 1. Aborted signal before answering 'always' must NOT persist extraDirs.
  const controller = new AbortController()
  await env.firePreExecute({
    agent,
    callId: 'c-race-abort',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'abort.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const pAbort = env.requestApproval({
    agent,
    toolName: 'write',
    callId: 'c-race-abort',
    reason: `${ESCALATION} write abort`,
    signal: controller.signal,
  })
  await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  const abortId = env.rt.approvalsView()[0].id
  controller.abort()
  await tick()
  assert.throws(() => env.rt.answerApproval(abortId, 'always'), { code: 'bot/stale' })
  assert.equal(await pAbort, 'cancelled')
  assert.equal(env.bots.b1.extraDirs, undefined)
  assert.equal(env.saved, 0)

  // 2. Answering 'reject' then immediately 'always' must NOT persist extraDirs.
  await env.firePreExecute({
    agent,
    callId: 'c-race-double',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'double.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const pDouble = env.requestApproval({
    agent,
    toolName: 'write',
    callId: 'c-race-double',
    reason: `${ESCALATION} write double`,
  })
  await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  const doubleId = env.rt.approvalsView()[0].id
  env.rt.answerApproval(doubleId, 'reject')
  assert.throws(() => env.rt.answerApproval(doubleId, 'always'), { code: 'bot/stale' })
  assert.equal(await pDouble, 'rejected')
  assert.equal(env.bots.b1.extraDirs, undefined)
  assert.equal(env.saved, 0)

  // 3. cancelApprovals winning before user clicks 'always' leaves extraDirs untouched.
  await env.firePreExecute({
    agent,
    callId: 'c-race-cancel',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'cancel.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const pCancel = env.requestApproval({
    agent,
    toolName: 'write',
    callId: 'c-race-cancel',
    reason: `${ESCALATION} write cancel`,
  })
  await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  const cancelId = env.rt.approvalsView()[0].id
  env.rt.cancelApprovals('b1')
  assert.throws(() => env.rt.answerApproval(cancelId, 'always'), { code: 'bot/stale' })
  assert.equal(await pCancel, 'cancelled')
  assert.equal(env.bots.b1.extraDirs, undefined)
  assert.equal(env.saved, 0)

  // 4. Synchronous double 'always' settles once, rejects the second with bot/stale, and persists once.
  await env.firePreExecute({
    agent,
    callId: 'c-race-twice',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'twice.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const pTwice = env.requestApproval({
    agent,
    toolName: 'write',
    callId: 'c-race-twice',
    reason: `${ESCALATION} write twice`,
  })
  await waitFor(() => env.rt.approvalsView()[0]?.alwaysAllow)
  const twiceId = env.rt.approvalsView()[0].id
  const firstAlways = env.rt.answerApproval(twiceId, 'always')
  assert.throws(() => env.rt.answerApproval(twiceId, 'always'), { code: 'bot/stale' })
  await firstAlways
  assert.equal(await pTwice, 'allowed-once')
  assert.deepEqual(env.bots.b1.extraDirs, [env.extraDir])
  assert.equal(env.saved, 1)
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

test('failed Always allow validation (MAX_EXTRA_DIRS filled, deleted saved folder, scope drift, or async cancel) never releases the tool or leaves a grant', async (t) => {
  // 1. Filling MAX_EXTRA_DIRS to 8 while an approval is open rejects 'always' BEFORE settling,
  // keeping the approval open and the tool blocked so the user can still Reject or Allow once.
  const maxEnv = setup(t)
  const slotDirs = Array.from({ length: MAX_EXTRA_DIRS }, (_, i) => {
    const dir = join(maxEnv.root, `slot-${i}`)
    mkdirSync(dir, { recursive: true })
    return dir
  })
  maxEnv.bots.b1.extraDirs = slotDirs.slice(0, MAX_EXTRA_DIRS - 1)
  const maxAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: maxEnv.ws } } }
  await maxEnv.firePreExecute({
    agent: maxAgent,
    callId: 'c-fill-max',
    name: 'write',
    arguments: { file_path: join(maxEnv.extraDir, 'report.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  let maxSettled = false
  const pMax = maxEnv.requestApproval({
    agent: maxAgent,
    toolName: 'write',
    callId: 'c-fill-max',
    reason: `${ESCALATION} write report`,
  }).then(res => { maxSettled = true; return res })
  await waitFor(() => maxEnv.rt.approvalsView()[0]?.alwaysAllow)
  const maxId = maxEnv.rt.approvalsView()[0].id
  // User adds an 8th folder in Settings while the approval is open.
  maxEnv.bots.b1.extraDirs = [...slotDirs]
  await assert.rejects(() => maxEnv.rt.answerApproval(maxId, 'always'), /at most 8 extra folders/)
  await tick()
  assert.equal(maxSettled, false, 'failed MAX_EXTRA_DIRS grant must NOT release the tool write')
  assert.equal(maxEnv.rt.approvalsView().length, 1, 'approval must remain open after failed grant')
  assert.equal(maxEnv.bots.b1.extraDirs.length, MAX_EXTRA_DIRS)
  assert.equal(maxEnv.saved, 0)
  // User can still explicitly reject the still-open approval.
  maxEnv.rt.answerApproval(maxId, 'reject')
  assert.equal(await pMax, 'rejected')

  // 2. Deleted/renamed saved folder in existing holder.extraDirs:
  //    (a) If deleted after approval opens, Always allow fails cleanly BEFORE settling, keeping the approval answerable.
  const staleEnv = setup(t)
  const savedDir = join(staleEnv.root, 'saved-notes')
  mkdirSync(savedDir, { recursive: true })
  staleEnv.bots.b1.extraDirs = [savedDir]
  const staleAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: staleEnv.ws } } }
  await staleEnv.firePreExecute({
    agent: staleAgent,
    callId: 'c-stale-1',
    name: 'write',
    arguments: { file_path: join(staleEnv.extraDir, 'out.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  let staleSettled = false
  const pStale = staleEnv.requestApproval({
    agent: staleAgent,
    toolName: 'write',
    callId: 'c-stale-1',
    reason: `${ESCALATION} write out`,
  }).then(res => { staleSettled = true; return res })
  await waitFor(() => staleEnv.rt.approvalsView()[0]?.alwaysAllow)
  const staleId = staleEnv.rt.approvalsView()[0].id
  rmSync(savedDir, { recursive: true, force: true })
  await assert.rejects(() => staleEnv.rt.answerApproval(staleId, 'always'), /There is no folder at/)
  await tick()
  assert.equal(staleSettled, false, 'failed stale-folder grant must NOT release the tool write')
  assert.equal(staleEnv.rt.approvalsView().length, 1)
  assert.deepEqual(staleEnv.bots.b1.extraDirs, [savedDir])
  assert.equal(staleEnv.saved, 0)
  // User can still choose Allow once after the failed Always allow.
  staleEnv.rt.answerApproval(staleId, 'allow')
  assert.equal(await pStale, 'allowed-once')
  //    (b) If already missing before open, resolvableExtraDirs consistently withholds Always allow.
  assert.deepEqual(await staleEnv.rt.resolvableExtraDirs({
    session: staleAgent.session,
    botId: 'b1',
    name: 'write',
    args: { file_path: join(staleEnv.extraDir, 'out2.md') },
  }), [])

  // 3. room.workDir toggled between approval open and click (Bot <-> Group scope TOCTOU) refuses BEFORE settling.
  const scopeEnv = setup(t, { withRoom: true })
  // (a) Starts Bot-scoped (room.workDir undefined), then room.workDir is set before click.
  scopeEnv.rooms.r1.workDir = undefined
  const groupAgent = { id: 'g-b1', session: { id: 'g-b1', header: { id: 'g-b1', cwd: scopeEnv.ws } } }
  await scopeEnv.firePreExecute({
    agent: groupAgent,
    callId: 'c-scope-1',
    name: 'write',
    arguments: { file_path: join(scopeEnv.extraDir, 'a.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  let scope1Settled = false
  const pScope1 = scopeEnv.requestApproval({
    agent: groupAgent,
    toolName: 'write',
    callId: 'c-scope-1',
    reason: `${ESCALATION} write a`,
  }).then(res => { scope1Settled = true; return res })
  const scope1Always = await waitFor(() => scopeEnv.rt.approvalsView()[0]?.alwaysAllow)
  assert.equal(scope1Always.scope, 'bot')
  const scope1Id = scopeEnv.rt.approvalsView()[0].id
  scopeEnv.rooms.r1.workDir = scopeEnv.ws
  await assert.rejects(() => scopeEnv.rt.answerApproval(scope1Id, 'always'), { code: 'bot/refused' })
  await tick()
  assert.equal(scope1Settled, false)
  assert.equal(scopeEnv.rooms.r1.extraDirs, undefined)
  assert.equal(scopeEnv.bots.b1.extraDirs, undefined)
  scopeEnv.rt.answerApproval(scope1Id, 'reject')
  assert.equal(await pScope1, 'rejected')

  // (b) Starts Group-scoped (room.workDir set), then room.workDir is cleared before click.
  await scopeEnv.firePreExecute({
    agent: groupAgent,
    callId: 'c-scope-2',
    name: 'write',
    arguments: { file_path: join(scopeEnv.extraDir, 'b.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  let scope2Settled = false
  const pScope2 = scopeEnv.requestApproval({
    agent: groupAgent,
    toolName: 'write',
    callId: 'c-scope-2',
    reason: `${ESCALATION} write b`,
  }).then(res => { scope2Settled = true; return res })
  const scope2Always = await waitFor(() => scopeEnv.rt.approvalsView()[0]?.alwaysAllow)
  assert.equal(scope2Always.scope, 'group')
  const scope2Id = scopeEnv.rt.approvalsView()[0].id
  scopeEnv.rooms.r1.workDir = undefined
  await assert.rejects(() => scopeEnv.rt.answerApproval(scope2Id, 'always'), { code: 'bot/refused' })
  await tick()
  assert.equal(scope2Settled, false)
  assert.equal(scopeEnv.rooms.r1.extraDirs, undefined)
  assert.equal(scopeEnv.bots.b1.extraDirs, undefined)
  scopeEnv.rt.answerApproval(scope2Id, 'reject')
  assert.equal(await pScope2, 'rejected')

  // 4. Cancellation during async Phase 1 validation never settles as allowed and never commits extraDirs.
  const asyncEnv = setup(t)
  let releaseLoad
  const loadGate = new Promise(resolve => { releaseLoad = resolve })
  const origLoad = asyncEnv.rt.load
  asyncEnv.rt.load = async () => { await loadGate; return origLoad() }
  const asyncAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: asyncEnv.ws } } }
  await asyncEnv.firePreExecute({
    agent: asyncAgent,
    callId: 'c-async-cancel',
    name: 'write',
    arguments: { file_path: join(asyncEnv.extraDir, 'c.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const pAsync = asyncEnv.requestApproval({
    agent: asyncAgent,
    toolName: 'write',
    callId: 'c-async-cancel',
    reason: `${ESCALATION} write c`,
  })
  await waitFor(() => asyncEnv.rt.approvalsView()[0]?.alwaysAllow)
  const asyncId = asyncEnv.rt.approvalsView()[0].id
  const alwaysPending = asyncEnv.rt.answerApproval(asyncId, 'always')
  // Competing click while Phase 1 validation is in flight is rejected synchronously.
  assert.throws(() => asyncEnv.rt.answerApproval(asyncId, 'allow'), { code: 'bot/stale' })
  // Session cancellation fires while Phase 1 validation is awaiting load().
  asyncEnv.rt.cancelApprovals('b1')
  releaseLoad()
  await assert.rejects(() => alwaysPending, { code: 'bot/stale' })
  assert.equal(await pAsync, 'cancelled')
  assert.equal(asyncEnv.bots.b1.extraDirs, undefined)
  assert.equal(asyncEnv.saved, 0)
})

test('Classic Agent subagent approval exposes ownerSessionId without botId or alwaysAllow and stays answerable', async (t) => {
  const env = setup(t)
  const classicParent = { id: 'classic-1', session: { id: 'classic-1', header: { id: 'classic-1', cwd: env.ws } } }
  const classicChild = { id: 'classic-sub-1', session: { id: 'classic-sub-1', header: { id: 'classic-sub-1', cwd: env.ws, origin: 'subagent', parentSession: 'classic-1' } } }
  env.rt.agentOf = id => (id === 'classic-1' ? { id: 'agent-1', sessionId: 'classic-1' } : undefined)
  env.rt.resolveAgent = async id => (id === 'classic-1' ? classicParent : undefined)
  // Keep DSH fallback waiter open (matching real gateway approval waiter) until answered or cancelled.
  env.rt.ctx.on('approval/request', req => new Promise((resolve) => {
    req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))

  await env.firePreExecute({
    agent: classicChild,
    callId: 'c-classic-sub',
    name: 'write',
    arguments: { file_path: join(env.extraDir, 'sub.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const promise = env.requestApproval({
    agent: classicChild,
    toolName: 'write',
    callId: 'c-classic-sub',
    reason: `${ESCALATION} subagent write`,
  })
  const entry = await waitFor(() => env.rt.approvalsView()[0])
  assert.equal(entry.sessionId, 'classic-sub-1')
  assert.equal(entry.ownerSessionId, 'classic-1')
  assert.equal(entry.botId, undefined)
  assert.equal(entry.alwaysAllow, undefined)
  assert.equal(entry.answerable, true)

  const res = await env.callApi('approval-answer', { id: entry.id, choice: 'allow' })
  assert.equal(res.ok, true)
  assert.equal(await promise, 'allowed-once')
})

test('failed grant save rollback never overwrites newer Settings extraDirs, and failed grant during auto-review transitions approval to manual', async (t) => {
  // 1. Deferred save failure does not clobber a concurrent Settings extraDirs update.
  const saveEnv = setup(t)
  const notesDir = join(saveEnv.root, 'notes')
  const archiveDir = join(saveEnv.root, 'archive')
  mkdirSync(notesDir, { recursive: true })
  mkdirSync(archiveDir, { recursive: true })
  saveEnv.bots.b1.extraDirs = [notesDir]

  let rejectGrantSave
  const origSave = saveEnv.rt.save
  let saveCount = 0
  saveEnv.rt.save = () => {
    saveCount += 1
    if (saveCount === 1) {
      return new Promise((_, reject) => { rejectGrantSave = reject })
    }
    return origSave()
  }

  const prepared = await saveEnv.rt.prepareGrantExtraDirs({ botId: 'b1', dirs: [saveEnv.extraDir], scope: 'bot' })
  const pendingCommit = prepared.commit()
  // Concurrent Settings update replaces bot.extraDirs with [archiveDir] and saves cleanly.
  saveEnv.bots.b1.extraDirs = [archiveDir]
  await saveEnv.rt.save()
  // Earlier grant save now fails: rollback must NOT restore [notesDir] over [archiveDir].
  rejectGrantSave(new Error('disk full'))
  await assert.rejects(() => pendingCommit, /disk full/)
  assert.deepEqual(saveEnv.bots.b1.extraDirs, [archiveDir])

  // 2. Failed Always allow clicked while automatic review is still 'reviewing' transitions
  // review.status from 'reviewing' to 'manual' and emits an update so Inbox and manual UI
  // never strand or hide the still-pending approval.
  const revEnv = setup(t)
  const staleDir = join(revEnv.root, 'stale-dir')
  mkdirSync(staleDir, { recursive: true })
  revEnv.bots.b1.permission = 'review'
  revEnv.bots.b1.extraDirs = [staleDir]
  const revAgent = { id: 'b1', session: { id: 'b1', header: { id: 'b1', cwd: revEnv.ws } } }
  revEnv.rt.resolveAgent = async () => revAgent
  // Resolve extraDirs synchronously on the next microtask so alwaysAllow lands while review.status === 'reviewing'.
  const origResolvable = revEnv.rt.resolvableExtraDirs
  revEnv.rt.resolvableExtraDirs = () => Promise.resolve([revEnv.extraDir])
  t.after(() => { revEnv.rt.resolvableExtraDirs = origResolvable })

  let clickedDuringReview = false
  let alwaysAttempt
  let reviewStatusAtClick
  const approvalEvents = []
  const offApproval = revEnv.rt.onApproval((kind, data) => {
    approvalEvents.push({ kind, status: data?.review?.status })
    if (!clickedDuringReview && kind === 'updated' && data?.alwaysAllow) {
      clickedDuringReview = true
      reviewStatusAtClick = data.review?.status
      // Delete saved extra folder so Phase 1 validation fails after reviewer is cancelled.
      rmSync(staleDir, { recursive: true, force: true })
      alwaysAttempt = revEnv.rt.answerApproval(data.id, 'always').then(() => null, error => error)
    }
  })
  t.after(offApproval)

  await revEnv.firePreExecute({
    agent: revAgent,
    callId: 'c-rev-fail',
    name: 'write',
    arguments: { file_path: join(revEnv.extraDir, 'r.md'), content: 'x', sandbox_permissions: 'danger-full-access' },
  })
  const revPromise = revEnv.requestApproval({
    agent: revAgent,
    toolName: 'write',
    callId: 'c-rev-fail',
    reason: `${ESCALATION} write during review`,
  })
  await waitFor(() => clickedDuringReview)
  assert.equal(reviewStatusAtClick, 'reviewing', 'test must trigger Always allow while review is still reviewing')
  const failErr = await alwaysAttempt
  assert.match(String(failErr?.message ?? ''), /There is no folder at/)
  const afterFail = revEnv.rt.approvalsView()[0]
  assert.ok(afterFail, 'approval must remain open after failed grant')
  assert.equal(afterFail.review?.status, 'manual', 'failed grant during automatic review must transition approval to manual review')
  assert.equal(approvalEvents.some(e => e.kind === 'updated' && e.status === 'manual'), true, 'manual transition must be published to listeners (including Inbox)')
  revEnv.rt.answerApproval(afterFail.id, 'reject')
  assert.equal(await revPromise, 'rejected')
})
