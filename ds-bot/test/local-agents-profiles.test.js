import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { cleanEnv, probeSignIn, refreshSearchDirs } from '../src/host/local-agents/discover.js'
import {
  ENGINES,
  cliMode,
  defaultProfileDir,
  engineOf,
  ensureProfileDir,
  isLocalAgentRoute,
  isProfileRoute,
  profileEnvFor,
  profileRoute,
  signInFor,
  splitProfileRoute,
  validateProfile,
} from '../src/host/local-agents/engines.js'
import { errorCode } from '../src/host/channel.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import {
  agentAvatar,
  badgeOf,
  isLocalRoute,
  logoOf,
  modelsFor,
  splitProfileRoute as clientSplitProfileRoute,
} from '../src/client/agent-routes.js'
import { fakeContext } from './fake-ctx.js'

function writeNodeModule(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, `${body}\n`)
  return file
}

function makeNodeScript(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(file, 0o755)
  if (process.platform === 'win32') {
    const cmd = `${file}.cmd`
    writeFileSync(cmd, `@ECHO off\r\n"${process.execPath}" "${file}" %*\r\n`)
    return cmd
  }
  return file
}

async function collect(stream) {
  const out = { text: '', finish: undefined }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}

const userMsg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

test('profile route parsing, validation, env isolation, and sign-in hints', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-prof-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  // Valid routes & backward compatibility
  assert.equal(profileRoute('local-claude-code', 'work'), 'local-claude-code@work')
  assert.equal(profileRoute('local-codex-cli', 'personal_2'), 'local-codex-cli@personal_2')
  assert.deepEqual(splitProfileRoute('local-claude-code@work'), { baseRoute: 'local-claude-code', profileId: 'work' })
  assert.equal(isProfileRoute('local-claude-code@work'), true)
  assert.equal(isProfileRoute('local-claude-code'), false)
  assert.equal(isLocalAgentRoute('local-claude-code'), true)
  assert.equal(isLocalAgentRoute('local-claude-code@work'), true)
  assert.equal(isLocalAgentRoute('local-codex-cli@team-a'), true)

  // Invalid routes must fail closed
  for (const bad of [
    'local-claude-code@',
    'local-claude-code@Work',
    'local-claude-code@../escape',
    'local-claude-code@a/b',
    'local-claude-code@a@b',
    'local-claude-code@-dash',
    'local-unknown@work',
    'local-acp-custom@work',
    'deepseek@work',
    '@work',
  ]) {
    assert.equal(splitProfileRoute(bad), null, `splitProfileRoute rejects ${bad}`)
    assert.equal(isProfileRoute(bad), false, `isProfileRoute rejects ${bad}`)
    if (!bad.startsWith('local-acp-')) assert.equal(isLocalAgentRoute(bad), false, `isLocalAgentRoute rejects ${bad}`)
  }
  assert.throws(() => profileRoute('local-unknown', 'work'))
  assert.throws(() => profileRoute('local-claude-code', '../bad'))

  // Isolated env vars per engine
  const dir = join(home, 'cli-profiles', 'test')
  assert.deepEqual(profileEnvFor('local-claude-code', dir), { CLAUDE_CONFIG_DIR: dir })
  assert.deepEqual(profileEnvFor('local-codex-cli', dir), { CODEX_HOME: dir })
  assert.deepEqual(profileEnvFor('local-devin-cli', dir), { XDG_CONFIG_HOME: dir })
  assert.deepEqual(profileEnvFor('local-gemini-cli', dir, { CUSTOM_FLAG: 'yes' }), { CUSTOM_FLAG: 'yes', XDG_CONFIG_HOME: dir })
  // Isolation key cannot be clobbered by extraEnv (including case-variant keys through cleanEnv)
  assert.deepEqual(profileEnvFor('local-claude-code', dir, { CLAUDE_CONFIG_DIR: '/wrong' }), { CLAUDE_CONFIG_DIR: dir })
  const caseClobber = profileEnvFor('local-claude-code', dir, { CLAUDE_CONFIG_DIR: '/a', claude_config_dir: '/evil', Claude_Config_Dir: '/evil2', CUSTOM_OK: '1' })
  assert.deepEqual(caseClobber, { CUSTOM_OK: '1', CLAUDE_CONFIG_DIR: dir })
  const cleaned = cleanEnv(caseClobber)
  const matchingClaudeKeys = Object.keys(cleaned).filter(key => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')
  assert.deepEqual(matchingClaudeKeys, ['CLAUDE_CONFIG_DIR'])
  assert.equal(cleaned.CLAUDE_CONFIG_DIR, dir)
  // Control characters / newlines in profileDir rejected
  assert.throws(() => profileEnvFor('local-claude-code', `${dir}\nEVIL=1`))
  assert.throws(() => profileEnvFor('local-claude-code', `${dir}\rEVIL=1`))
  assert.throws(() => profileEnvFor('local-claude-code', `${dir}\0evil`))

  // ensureProfileDir: rejects non-directories and control chars; preserves existing custom folder mode
  const regularFile = join(home, 'not-a-dir.txt')
  writeFileSync(regularFile, 'hi')
  let fileErr
  try {
    ensureProfileDir(regularFile)
  } catch (err) {
    fileErr = err
  }
  assert.ok(fileErr instanceof Error)
  assert.match(fileErr.message, /directory, not a file/i)
  assert.equal(errorCode(fileErr), 'bot/refused', 'file path rejection must be user-facing, not raw EEXIST')
  assert.throws(() => ensureProfileDir(`${dir}\n`))
  assert.throws(() => ensureProfileDir(`${dir}\r`))
  assert.throws(() => ensureProfileDir(`${dir}\0`))

  const existingCustomDir = join(home, 'existing-custom')
  mkdirSync(existingCustomDir, { recursive: true, mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(existingCustomDir, 0o755)
  ensureProfileDir(existingCustomDir, { managed: false })
  if (process.platform !== 'win32') {
    assert.equal(statSync(existingCustomDir).mode & 0o777, 0o755, 'existing custom folder permissions must not be overwritten')
  }
  const freshCustomDir = join(home, 'fresh-custom')
  ensureProfileDir(freshCustomDir, { managed: false })
  if (process.platform !== 'win32') {
    assert.equal(statSync(freshCustomDir).mode & 0o777, 0o700, 'newly created folder receives 0o700')
  }
  const managedDefaultDir = join(home, 'managed-default')
  mkdirSync(managedDefaultDir, { recursive: true, mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(managedDefaultDir, 0o755)
  ensureProfileDir(managedDefaultDir, { managed: true })
  if (process.platform !== 'win32') {
    assert.equal(statSync(managedDefaultDir).mode & 0o777, 0o700, 'managed default profile dir enforces 0o700')
  }

  // Blocked env keys rejected
  for (const badEnv of [
    { PATH: '/evil' },
    { NODE_OPTIONS: '--require=/evil.js' },
    { LD_PRELOAD: '/evil.so' },
    { DYLD_INSERT_LIBRARIES: '/evil.dylib' },
    { ANTHROPIC_API_KEY: 'sk-leak' },
    { DS_BOT_SECRET: '1' },
    { DEEPSEEK_API_KEY: '1' },
    { 'BAD KEY': '1' },
    { OK_KEY: 'line1\nline2' },
  ]) {
    assert.throws(() => profileEnvFor('local-claude-code', dir, badEnv), `blocks ${JSON.stringify(badEnv)}`)
  }

  // Default profile directory stays strictly under <home>/cli-profiles/
  assert.equal(defaultProfileDir(home, 'local-claude-code', 'work'), join(home, 'cli-profiles', 'claude-code-work'))
  assert.equal(defaultProfileDir(home, 'local-codex-cli', 'personal'), join(home, 'cli-profiles', 'codex-cli-personal'))

  // validateProfile checks
  const valid = validateProfile({ baseRoute: 'local-claude-code', name: 'Work Account' })
  assert.equal(valid.id, 'work-account')
  assert.equal(valid.name, 'Work Account')
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: '' }))
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'X', configDir: 'relative/path' }))
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'X', configDir: '/' }))

  // engineOf resolves profile specs with merged env, display name, and sign-in hints
  const profiles = [{ id: 'work', baseRoute: 'local-claude-code', name: 'Work', env: { MY_PROFILE_TAG: 'w1' } }]
  const spec = engineOf('local-claude-code@work', [], profiles, { home })
  assert.equal(spec.name, 'Claude Code (Work)')
  assert.equal(spec.kind, 'claude')
  assert.equal(spec.profile, true)
  assert.equal(spec.profileDir, join(home, 'cli-profiles', 'claude-code-work'))
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, spec.profileDir)
  assert.equal(spec.env.MY_PROFILE_TAG, 'w1')
  assert.equal(cliMode(spec.kind, 'workspace-write'), 'acceptEdits')

  // Profile-aware sign-in hints on POSIX and Windows (platform-explicit paths & single-quoting)
  const posixSpec = { ...spec, profileDir: '/tmp/cli-profiles/claude-code-work' }
  const winSpec = { ...spec, profileDir: 'C:\\Users\\Public\\cli-profiles\\claude-code-work' }
  assert.equal(signInFor(posixSpec, '/usr/local/bin/claude', { platform: 'darwin' }), "CLAUDE_CONFIG_DIR='/tmp/cli-profiles/claude-code-work' claude")
  assert.equal(signInFor(posixSpec, '/usr/local/bin/claude', { platform: 'linux' }), "CLAUDE_CONFIG_DIR='/tmp/cli-profiles/claude-code-work' claude")
  assert.equal(signInFor(winSpec, 'C:\\bin\\claude.exe', { platform: 'win32' }), "$env:CLAUDE_CONFIG_DIR='C:\\Users\\Public\\cli-profiles\\claude-code-work'; claude")

  // Shell quoting hardening: spaces, $HOME, !, ', ", backslashes, and Unicode single quotes
  const trickyPosix = { ...spec, profileDir: `/tmp/my dir/$HOME/a!b/it's/"q"/c\\d` }
  assert.equal(
    signInFor(trickyPosix, '/usr/local/bin/claude', { platform: 'darwin' }),
    `CLAUDE_CONFIG_DIR='/tmp/my dir/$HOME/a!b/it'\\''s/"q"/c\\d' claude`,
  )
  const trickyWin = { ...spec, profileDir: `C:\\Program Data\\$HOME\\a!b\\it's\\‘curly’\\"q"` }
  assert.equal(
    signInFor(trickyWin, 'C:\\bin\\claude.exe', { platform: 'win32' }),
    `$env:CLAUDE_CONFIG_DIR='C:\\Program Data\\$HOME\\a!b\\it''s\\‘‘curly’’\\"q"'; claude`,
  )
  // Control characters / newlines in profileDir never emit an injectable shell snippet
  assert.equal(signInFor({ ...spec, profileDir: '/tmp/ok\nrm -rf /' }, '/usr/local/bin/claude', { platform: 'darwin' }), undefined)
  assert.equal(signInFor({ ...spec, profileDir: 'C:\\tmp\\ok\r\ncalc' }, 'C:\\bin\\claude.exe', { platform: 'win32' }), undefined)
  assert.equal(signInFor({ ...spec, profileDir: '/tmp/ok\0bad' }, '/usr/local/bin/claude', { platform: 'linux' }), undefined)

  // Default global engine stays unchanged
  assert.equal(signInFor(ENGINES['local-claude-code'], '/usr/local/bin/claude', { platform: 'darwin' }), 'claude')
})

test('client agent-routes inherit logos/badges for profiles and isolate model menus per profile', () => {
  assert.deepEqual(clientSplitProfileRoute('local-claude-code@work'), { baseRoute: 'local-claude-code', profileId: 'work' })
  assert.equal(clientSplitProfileRoute('local-claude-code@bad/id'), null)
  assert.equal(isLocalRoute('local-claude-code@work/default'), true)
  assert.equal(isLocalRoute('local-claude-code@bad..id/default'), false)
  assert.equal(isLocalRoute('local-claude-code@UPPER/default'), false)
  assert.deepEqual(badgeOf('local-claude-code@work'), badgeOf('local-claude-code'))
  assert.deepEqual(logoOf('local-codex-cli@personal'), logoOf('local-codex-cli'))
  assert.deepEqual(agentAvatar('local-claude-code@work'), agentAvatar('local-claude-code'))

  const catalog = [
    { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash' },
    { ref: 'local-claude-code/default', provider: 'local-claude-code', id: 'default', name: 'CLI default' },
    { ref: 'local-claude-code/opus', provider: 'local-claude-code', id: 'opus', name: 'opus' },
    { ref: 'local-claude-code@work/default', provider: 'local-claude-code@work', id: 'default', name: 'CLI default' },
    { ref: 'local-claude-code@work/sonnet', provider: 'local-claude-code@work', id: 'sonnet', name: 'sonnet' },
    { ref: 'local-codex-cli@personal/default', provider: 'local-codex-cli@personal', id: 'default', name: 'CLI default' },
  ]
  assert.deepEqual(modelsFor(catalog, 'local-claude-code@work/default').map(m => m.ref), [
    'local-claude-code@work/default',
    'local-claude-code@work/sonnet',
  ])
  assert.deepEqual(modelsFor(catalog, 'local-claude-code/default').map(m => m.ref), [
    'local-claude-code/default',
    'local-claude-code/opus',
  ])
  assert.deepEqual(modelsFor(catalog, 'ds/flash').map(m => m.ref), ['ds/flash'])
})

test('two concurrent profiles of the same CLI spawn isolated processes with distinct config dirs (Claude, Codex, ACP)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-multi-prof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')

  // Real spawned Claude stream-json fixture that echoes its PID and CLAUDE_CONFIG_DIR.
  const fakeClaude = writeNodeModule(root, 'fake-claude-env.mjs', `
    let buf = ''
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.type === 'user') {
          send({ type: 'system', subtype: 'init', session_id: 'cl-' + process.pid, model: 'sonnet' })
          send({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, claudeDir: process.env.CLAUDE_CONFIG_DIR ?? null, tag: process.env.PROFILE_TAG ?? null }) }] } })
          send({ type: 'result', subtype: 'success', is_error: false })
        }
      }
    })
  `)

  // Real spawned Codex app-server fixture that echoes its PID, CODEX_HOME, and distinct models per CODEX_HOME.
  const fakeCodex = writeNodeModule(root, 'fake-codex-env.mjs', `
    let buf = ''
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'model/list') {
          const suffix = (process.env.CODEX_HOME ?? 'global').split(/[\\\\/]/).at(-1)
          send({ jsonrpc: '2.0', id, result: { data: [{ id: 'model-' + suffix, displayName: 'Model ' + suffix }] } })
        } else if (method === 'thread/start') {
          send({ jsonrpc: '2.0', id, result: { thread: { id: 'thr-' + process.pid } } })
        } else if (method === 'turn/start') {
          const text = JSON.stringify({ pid: process.pid, codexHome: process.env.CODEX_HOME ?? null })
          send({ jsonrpc: '2.0', id, result: { turn: { id: 't1' } } })
          send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: params.threadId, turnId: 't1', item: { type: 'agentMessage', text } } })
          send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 't1', status: 'completed' } } })
        }
      }
    })
  `)

  // Real spawned ACP fixture that echoes its PID and XDG_CONFIG_HOME.
  const fakeAcp = writeNodeModule(root, 'fake-acp-env.mjs', `
    let buf = ''
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        const { id, method, params = {} } = JSON.parse(line)
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
        } else if (method === 'session/new') {
          send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-' + process.pid, configOptions: [] } })
        } else if (method === 'session/prompt') {
          const text = JSON.stringify({ pid: process.pid, xdg: process.env.XDG_CONFIG_HOME ?? null })
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
        }
      }
    })
  `)

  const profiles = [
    { id: 'work', baseRoute: 'local-claude-code', name: 'Work', env: { PROFILE_TAG: 'work-tag' } },
    { id: 'personal', baseRoute: 'local-claude-code', name: 'Personal', env: { PROFILE_TAG: 'personal-tag' } },
    { id: 'work', baseRoute: 'local-codex-cli', name: 'Work' },
    { id: 'personal', baseRoute: 'local-codex-cli', name: 'Personal' },
    { id: 'work', baseRoute: 'local-devin-cli', name: 'Work' },
    { id: 'personal', baseRoute: 'local-devin-cli', name: 'Personal' },
  ]
  const records = {}
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    home,
    customAgents: () => [],
    profiles: () => profiles,
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const fixture = kind === 'claude' ? fakeClaude : kind === 'codex' ? fakeCodex : fakeAcp
      const overridden = { ...spec, command: process.execPath, args: [fixture] }
      return kind === 'claude' ? new ClaudeEngine(route, overridden, { findExecutable: p => p })
        : kind === 'codex' ? new CodexEngine(route, overridden, { findExecutable: p => p })
          : new AcpEngine(route, overridden, { findExecutable: p => p })
    },
    record: id => records[id],
    saveRecord: (id, rec) => { records[id] = rec },
    presetFor: () => 'workspace-write',
    cwdFor: async () => root,
    probeCwd: () => root,
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  // 1. Two concurrent Claude profiles receive distinct CLAUDE_CONFIG_DIR & custom env vars
  const [clWork, clPersonal] = await Promise.all([
    collect(adapter.stream({ provider: 'local-claude-code@work', model: 'default', sessionId: 's-cl-w', messages: [userMsg('m1', 'hi')], tools: [] })),
    collect(adapter.stream({ provider: 'local-claude-code@personal', model: 'default', sessionId: 's-cl-p', messages: [userMsg('m1', 'hi')], tools: [] })),
  ])
  const parsedClW = JSON.parse(clWork.text)
  const parsedClP = JSON.parse(clPersonal.text)
  assert.equal(parsedClW.claudeDir, join(home, 'cli-profiles', 'claude-code-work'))
  assert.equal(parsedClP.claudeDir, join(home, 'cli-profiles', 'claude-code-personal'))
  assert.equal(parsedClW.tag, 'work-tag')
  assert.equal(parsedClP.tag, 'personal-tag')
  assert.notEqual(parsedClW.pid, parsedClP.pid)

  // 2. Two concurrent Codex profiles spawn separate app-server processes with distinct CODEX_HOME & model caches
  const [cxModelsW, cxModelsP] = await Promise.all([
    adapter.probeModels('local-codex-cli@work'),
    adapter.probeModels('local-codex-cli@personal'),
  ])
  assert.deepEqual(cxModelsW.map(m => m.id), ['default', 'model-codex-cli-work'])
  assert.deepEqual(cxModelsP.map(m => m.id), ['default', 'model-codex-cli-personal'])

  const [cxWork, cxPersonal] = await Promise.all([
    collect(adapter.stream({ provider: 'local-codex-cli@work', model: 'default', sessionId: 's-cx-w', messages: [userMsg('m1', 'hi')], tools: [] })),
    collect(adapter.stream({ provider: 'local-codex-cli@personal', model: 'default', sessionId: 's-cx-p', messages: [userMsg('m1', 'hi')], tools: [] })),
  ])
  const parsedCxW = JSON.parse(cxWork.text)
  const parsedCxP = JSON.parse(cxPersonal.text)
  assert.equal(parsedCxW.codexHome, join(home, 'cli-profiles', 'codex-cli-work'))
  assert.equal(parsedCxP.codexHome, join(home, 'cli-profiles', 'codex-cli-personal'))
  assert.notEqual(parsedCxW.pid, parsedCxP.pid)
  assert.notEqual(adapter.engines.get('local-codex-cli@work'), adapter.engines.get('local-codex-cli@personal'))

  // 3. Two concurrent ACP profiles spawn separate processes with distinct XDG_CONFIG_HOME
  const [acpWork, acpPersonal] = await Promise.all([
    collect(adapter.stream({ provider: 'local-devin-cli@work', model: 'default', sessionId: 's-acp-w', messages: [userMsg('m1', 'hi')], tools: [] })),
    collect(adapter.stream({ provider: 'local-devin-cli@personal', model: 'default', sessionId: 's-acp-p', messages: [userMsg('m1', 'hi')], tools: [] })),
  ])
  const parsedAcpW = JSON.parse(acpWork.text)
  const parsedAcpP = JSON.parse(acpPersonal.text)
  assert.equal(parsedAcpW.xdg, join(home, 'cli-profiles', 'devin-cli-work'))
  assert.equal(parsedAcpP.xdg, join(home, 'cli-profiles', 'devin-cli-personal'))
  assert.notEqual(parsedAcpW.pid, parsedAcpP.pid)
})

test('probeSignIn isolates profile env, file fallbacks, and skips macOS Keychain for isolated profiles', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-prof-signin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const globalHome = join(root, 'global-home')
  const workDir = join(root, 'work-profile')
  const personalDir = join(root, 'personal-profile')
  mkdirSync(join(globalHome, '.claude'), { recursive: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(personalDir, { recursive: true })

  // Global account has credentials; workDir has credentials; personalDir does NOT.
  writeFileSync(join(globalHome, '.claude', '.credentials.json'), '{"token":"global"}')
  writeFileSync(join(workDir, '.credentials.json'), '{"token":"work"}')

  // Command probe that checks CLAUDE_CONFIG_DIR and MISE_OFFLINE
  const claudeStatus = makeNodeScript(root, 'claude-status.mjs', `
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    const dir = process.env.CLAUDE_CONFIG_DIR
    if (process.env.MISE_OFFLINE !== '1') { console.log('missing mise'); process.exit(1) }
    if (dir && existsSync(join(dir, '.credentials.json'))) console.log(JSON.stringify({ loggedIn: true }))
    else console.log(JSON.stringify({ loggedIn: false }))
  `)
  const claudeInconclusive = makeNodeScript(root, 'claude-inconclusive.mjs', 'console.log("ok")')

  // 1. Command-based check receives profile's CLAUDE_CONFIG_DIR and MISE_OFFLINE=1
  assert.equal(await probeSignIn(claudeStatus, ENGINES['local-claude-code'].signedIn, { home: globalHome, extraEnv: { CLAUDE_CONFIG_DIR: workDir }, isolated: true }), true)
  assert.equal(await probeSignIn(claudeStatus, ENGINES['local-claude-code'].signedIn, { home: globalHome, extraEnv: { CLAUDE_CONFIG_DIR: personalDir }, isolated: true }), false)

  // 2. Fallback file check uses CLAUDE_CONFIG_DIR/.credentials.json, NOT globalHome/.claude/.credentials.json
  assert.equal(await probeSignIn(claudeInconclusive, ENGINES['local-claude-code'].signedIn, { home: globalHome, extraEnv: { CLAUDE_CONFIG_DIR: workDir }, isolated: true }), true)
  assert.equal(await probeSignIn(claudeInconclusive, ENGINES['local-claude-code'].signedIn, { home: globalHome, extraEnv: { CLAUDE_CONFIG_DIR: personalDir }, isolated: true }), null)
  // Global (non-isolated) still checks globalHome/.claude/.credentials.json
  assert.equal(await probeSignIn(claudeInconclusive, ENGINES['local-claude-code'].signedIn, { home: globalHome }), true)

  // 3. macOS Keychain is NEVER falsely attributed to an isolated profile (Cursor & Antigravity)
  let keychainCalls = 0
  const fakeKeychain = () => {
    keychainCalls += 1
    throw new Error('keychain must not be called for isolated profiles')
  }
  const cursorOffline = makeNodeScript(root, 'cursor-offline.mjs', 'console.error("network offline")')
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'darwin', extraEnv: { XDG_CONFIG_HOME: personalDir }, isolated: true, spawnKeychain: fakeKeychain,
  }), null)
  assert.equal(await probeSignIn('/usr/bin/agy', ENGINES['local-antigravity'].signedIn, {
    home: globalHome, platform: 'darwin', extraEnv: { XDG_CONFIG_HOME: personalDir }, isolated: true, spawnKeychain: fakeKeychain,
  }), null)
  assert.equal(keychainCalls, 0)

  // Isolated Cursor profile with auth.json inside XDG_CONFIG_HOME/cursor/auth.json IS detected
  mkdirSync(join(workDir, 'cursor'), { recursive: true })
  writeFileSync(join(workDir, 'cursor', 'auth.json'), JSON.stringify({ apiKey: 'work-key' }))
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'darwin', extraEnv: { XDG_CONFIG_HOME: workDir }, isolated: true, spawnKeychain: fakeKeychain,
  }), true)
  assert.equal(keychainCalls, 0)

  // 4. Isolated profiles MUST NOT inherit host APPDATA / XDG_DATA_HOME / CLAUDE_CONFIG_DIR credentials
  const hostAppData = join(root, 'host-appdata')
  const hostXdgData = join(root, 'host-xdg-data')
  mkdirSync(join(hostAppData, 'devin'), { recursive: true })
  writeFileSync(join(hostAppData, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-win-key"\n')
  mkdirSync(join(hostAppData, 'Cursor'), { recursive: true })
  writeFileSync(join(hostAppData, 'Cursor', 'auth.json'), JSON.stringify({ apiKey: 'test-win-key' }))
  mkdirSync(join(hostXdgData, 'devin'), { recursive: true })
  writeFileSync(join(hostXdgData, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-linux-key"\n')

  const devinOffline = makeNodeScript(root, 'devin-offline.mjs', 'console.error("network offline")')
  // Windows host APPDATA must not leak into empty isolated Devin or Cursor profile
  assert.equal(await probeSignIn(devinOffline, ENGINES['local-devin-cli'].signedIn, {
    home: globalHome, platform: 'win32', env: { APPDATA: hostAppData }, extraEnv: { XDG_CONFIG_HOME: personalDir }, isolated: true,
  }), null, 'isolated Devin profile on win32 must ignore host APPDATA')
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'win32', env: { APPDATA: hostAppData }, extraEnv: { XDG_CONFIG_HOME: personalDir }, isolated: true,
  }), null, 'isolated Cursor profile on win32 must ignore host APPDATA')
  // POSIX host XDG_DATA_HOME must not leak into empty isolated Devin profile
  assert.equal(await probeSignIn(devinOffline, ENGINES['local-devin-cli'].signedIn, {
    home: globalHome, platform: 'linux', env: { XDG_DATA_HOME: hostXdgData }, extraEnv: { XDG_CONFIG_HOME: personalDir }, isolated: true,
  }), null, 'isolated Devin profile on linux must ignore host XDG_DATA_HOME')
  // Host CLAUDE_CONFIG_DIR (including lowercase variant on Windows) must not leak into isolated profile
  assert.equal(await probeSignIn(claudeInconclusive, ENGINES['local-claude-code'].signedIn, {
    home: globalHome, platform: 'win32', env: { claude_config_dir: workDir }, extraEnv: { CLAUDE_CONFIG_DIR: personalDir }, isolated: true,
  }), null, 'isolated Claude profile must ignore host claude_config_dir')
  // Non-isolated global Devin/Cursor still read host XDG_DATA_HOME / APPDATA (proving isolated tests above are non-vacuous)
  assert.equal(await probeSignIn(devinOffline, ENGINES['local-devin-cli'].signedIn, {
    home: globalHome, platform: 'linux', env: { XDG_DATA_HOME: hostXdgData },
  }), true, 'global non-isolated Devin profile still reads host XDG_DATA_HOME')
  assert.equal(await probeSignIn(devinOffline, ENGINES['local-devin-cli'].signedIn, {
    home: globalHome, platform: 'win32', env: { APPDATA: hostAppData },
  }), true, 'global non-isolated Devin profile still reads host APPDATA')
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'win32', env: { APPDATA: hostAppData },
  }), true, 'global non-isolated Cursor profile still reads host APPDATA')
})

test('profile CRUD endpoints create 0o700 dirs, register routes, probe independently, reload on update, and preserve files on remove', async (t) => {
  await refreshSearchDirs()
  const root = mkdtempSync(join(tmpdir(), 'dsb-prof-crud-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'bot-home')
  const customDir = join(root, 'custom-work-dir')
  const savedEngines = { ...ENGINES }
  const fakeCli = makeNodeScript(root, 'fake-claude-cli.mjs', `
    if (process.argv.includes('--version')) { console.log('claude 2.0.0'); process.exit(0) }
    console.log(JSON.stringify({ loggedIn: Boolean(process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.includes('custom')) }))
  `)
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-claude-code'] = { ...savedEngines['local-claude-code'], command: fakeCli, commands: [fakeCli], version: ['--version'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, savedEngines)
  })

  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  let saves = 0
  const seenProbeEnvs = []
  const rt = {
    ctx,
    home,
    state: { bots: {}, localAgents: { custom: [], profiles: [], sessions: {} } },
    save: async () => { saves += 1 },
  }
  t.after(async () => { await ctx.dispose(); await owner.fiber.dispose() })

  installLocalAgents(rt, {
    probeVersion: async () => ({ ok: true, version: 'claude 2.0.0' }),
    probeSignIn: async (_path, _check, opts = {}) => {
      seenProbeEnvs.push({ isolated: opts.isolated ?? false, extraEnv: opts.extraEnv ?? null })
      const dir = opts.extraEnv?.CLAUDE_CONFIG_DIR
      if (!dir) return true
      return dir.includes('custom-work-dir')
    },
  })

  // Initial scan sees default global route and empty profiles
  const initial = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(initial.detected.length, 1)
  assert.equal(initial.detected[0].route, 'local-claude-code')
  assert.equal(initial.detected[0].signedIn, true)
  assert.deepEqual(initial.profiles, [])

  // 1. Add profile with default dir -> creates 0o700 dir, registers route, probes independently (signedIn: false while global is true!)
  const added = await rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', name: 'Work' })
  assert.equal(added.route, 'local-claude-code@work')
  assert.equal(added.displayName, 'Claude Code (Work)')
  assert.equal(added.configDir, join(home, 'cli-profiles', 'claude-code-work'))
  assert.equal(added.available, true)
  assert.equal(added.signedIn, false)
  assert.equal(added.version, 'claude 2.0.0')
  assert.ok(added.signIn.includes(added.configDir))
  assert.equal(existsSync(added.configDir), true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(added.configDir).mode & 0o777, 0o700)
  }
  assert.equal(rt.isLocalAgentAvailable('local-claude-code@work'), true)
  assert.equal(rt.engineNameOf('local-claude-code@work/default'), 'Claude Code (Work)')
  assert.ok(saves >= 1)

  // Duplicate ID rejected
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'work', name: 'Work 2' }),
    /already exists/,
  )

  // Rejecting regular file as configDir returns clean validation error (not raw EEXIST)
  const filePath = join(root, 'not-a-folder')
  writeFileSync(filePath, 'plain file')
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'bad-file', name: 'Bad File', configDir: filePath }),
    err => /directory, not a file/i.test(err.message) && errorCode(err) === 'bot/refused',
  )

  // findProfile requires route OR both baseRoute and id (never ambiguously matching by bare id)
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-update', { id: 'work', name: 'Ambiguous' }),
    /Unknown profile/,
  )
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-remove', { id: 'work' }),
    /Unknown profile/,
  )

  // List includes both global detected & isolated profile
  const listed = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(listed.profiles.length, 1)
  assert.equal(listed.profiles[0].route, 'local-claude-code@work')
  assert.equal(listed.profiles[0].signedIn, false)

  // Seed persisted CLI session records for this profile and another route
  rt.state.localAgents.sessions['sess-work-1'] = { route: 'local-claude-code@work', cliSessionId: 'cli-old-work', handedId: 'm-old' }
  rt.state.localAgents.sessions['sess-global-1'] = { route: 'local-claude-code', cliSessionId: 'cli-global', handedId: 'm-g' }

  // Updating only display name (without changing configDir) keeps existing session records intact
  await rt.localAgentsEndpoint('local-agent-profile-update', {
    baseRoute: 'local-claude-code',
    id: 'work',
    name: 'Work Renamed',
  })
  assert.equal(rt.state.localAgents.sessions['sess-work-1']?.cliSessionId, 'cli-old-work')

  // 2. Update profile configDir -> preserves existing customDir mode, clears stale session records, and re-probes with new dir
  const credFile = join(customDir, '.credentials.json')
  mkdirSync(customDir, { recursive: true, mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(customDir, 0o755)
  writeFileSync(credFile, '{"keep":"me"}')
  const updated = await rt.localAgentsEndpoint('local-agent-profile-update', {
    route: 'local-claude-code@work',
    name: 'Work Pro',
    configDir: customDir,
    env: { TEAM_ORG: 'acme' },
  })
  assert.equal(updated.displayName, 'Claude Code (Work Pro)')
  assert.equal(updated.configDir, customDir)
  assert.equal(updated.customConfigDir, customDir)
  assert.deepEqual(updated.env, { TEAM_ORG: 'acme' })
  assert.equal(updated.signedIn, true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(customDir).mode & 0o777, 0o755, 'updating to an existing custom dir must preserve its permissions')
  }
  assert.equal(rt.state.localAgents.sessions['sess-work-1'], undefined, 'configDir change must clear stale sessions for that route')
  assert.equal(rt.state.localAgents.sessions['sess-global-1']?.cliSessionId, 'cli-global', 'other routes sessions must stay untouched')

  // 3. Remove profile -> clears route sessions, unregisters route, keeps user's credential files intact on disk
  rt.state.localAgents.sessions['sess-work-2'] = { route: 'local-claude-code@work', cliSessionId: 'cli-new-work', handedId: 'm-new' }
  const afterRemove = await rt.localAgentsEndpoint('local-agent-profile-remove', { route: 'local-claude-code@work' })
  assert.deepEqual(afterRemove, [])
  assert.equal(rt.state.localAgents.sessions['sess-work-2'], undefined, 'removing a profile must clear its persisted sessions')
  assert.equal(rt.state.localAgents.sessions['sess-global-1']?.cliSessionId, 'cli-global', 'other routes sessions must stay untouched on remove')
  assert.equal(rt.isLocalAgentAvailable('local-claude-code@work'), false)
  assert.equal(rt.isLocalAgentAvailable('local-claude-code'), true, 'global route stays intact')
  assert.equal(readFileSync(credFile, 'utf8'), '{"keep":"me"}', 'removing a profile must not delete credential files on disk')
  assert.ok(seenProbeEnvs.some(entry => entry.isolated === true && entry.extraEnv?.CLAUDE_CONFIG_DIR === customDir))
})
