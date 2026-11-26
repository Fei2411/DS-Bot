import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
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
  profileEnvKeyFor,
  profileRoute,
  signInFor,
  splitProfileRoute,
  supportsProfiles,
  validateProfile,
  validateProfileDirUnique,
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

  // Only CLIs with verified env-var isolation support profiles (no blind XDG_CONFIG_HOME fallback)
  assert.equal(profileEnvKeyFor('local-claude-code'), 'CLAUDE_CONFIG_DIR')
  assert.equal(profileEnvKeyFor('local-codex-cli'), 'CODEX_HOME')
  assert.equal(supportsProfiles('local-claude-code'), true)
  assert.equal(supportsProfiles('local-codex-cli'), true)
  for (const unsupported of [
    'local-devin-cli',
    'local-cursor-cli',
    'local-gemini-cli',
    'local-qwen-code',
    'local-codebuddy',
    'local-antigravity',
    'local-opencode',
  ]) {
    assert.equal(profileEnvKeyFor(unsupported), null, `${unsupported} must not fall back to XDG_CONFIG_HOME`)
    assert.equal(supportsProfiles(unsupported), false, `${unsupported} must not advertise profile support`)
    assert.throws(() => profileEnvFor(unsupported, join(home, 'cli-profiles', 'test')), /does not support isolated profiles/)
    assert.throws(() => validateProfile({ baseRoute: unsupported, name: 'Work' }), /does not support isolated profiles/)
    assert.equal(engineOf(`${unsupported}@work`, [], [{ id: 'work', baseRoute: unsupported, name: 'Work' }], { home }), undefined)
  }

  // Isolated env vars per verified engine
  const dir = join(home, 'cli-profiles', 'test')
  assert.deepEqual(profileEnvFor('local-claude-code', dir), { CLAUDE_CONFIG_DIR: dir })
  assert.deepEqual(profileEnvFor('local-codex-cli', dir), { CODEX_HOME: dir })
  assert.deepEqual(profileEnvFor('local-codex-cli', dir, { CUSTOM_FLAG: 'yes' }), { CUSTOM_FLAG: 'yes', CODEX_HOME: dir })
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

  // validateProfile checks (including global default dir and duplicate dir guards)
  const valid = validateProfile({ baseRoute: 'local-claude-code', name: 'Work Account' })
  assert.equal(valid.id, 'work-account')
  assert.equal(valid.name, 'Work Account')
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: '' }))
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'X', configDir: 'relative/path' }))
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'X', configDir: '/' }))
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'Global', configDir: join(homedir(), '.claude') }), /default global directory/)
  assert.throws(() => validateProfile({ baseRoute: 'local-claude-code', name: 'GlobalTilde', configDir: '~/.claude' }), /default global directory/)
  assert.throws(() => validateProfile({ baseRoute: 'local-codex-cli', name: 'GlobalCodex', configDir: join(homedir(), '.codex') }), /default global directory/)
  const hostClaudeGlobal = join(home, 'host-global-claude')
  assert.throws(
    () => validateProfile({ baseRoute: 'local-claude-code', name: 'HostEnv', configDir: hostClaudeGlobal }, { env: { CLAUDE_CONFIG_DIR: hostClaudeGlobal } }),
    /default global directory/,
  )
  // Windows case-insensitive global & sibling directory collision checks
  assert.throws(
    () => validateProfile(
      { baseRoute: 'local-claude-code', name: 'WinGlobal', configDir: 'C:\\Users\\Public\\.CLAUDE\\' },
      { platform: 'win32', userHome: 'C:\\Users\\Public', env: {} },
    ),
    /default global directory/,
  )
  assert.throws(
    () => validateProfileDirUnique(
      'local-codex-cli',
      'c:\\profiles\\codex-work\\',
      [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: 'C:\\Profiles\\Codex-Work' }],
      { platform: 'win32', userHome: 'C:\\Users\\Public', env: {} },
    ),
    /already used by another Codex CLI profile/,
  )
  // Editing itself is allowed when ignoreId matches
  assert.doesNotThrow(() => validateProfileDirUnique(
    'local-codex-cli',
    'c:\\profiles\\codex-work\\',
    [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: 'C:\\Profiles\\Codex-Work' }],
    { platform: 'win32', userHome: 'C:\\Users\\Public', env: {}, ignoreId: 'work' },
  ))
  if (process.platform !== 'win32') {
    const fakeUserHome = join(home, 'fake-user-home')
    const realGlobalClaude = join(fakeUserHome, '.claude')
    const symlinkToGlobal = join(home, 'link-to-claude')
    mkdirSync(realGlobalClaude, { recursive: true })
    symlinkSync(realGlobalClaude, symlinkToGlobal)
    assert.throws(
      () => validateProfile({ baseRoute: 'local-claude-code', name: 'SymlinkGlobal', configDir: symlinkToGlobal }, { userHome: fakeUserHome, env: {} }),
      /default global directory/,
    )
  }

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
  assert.equal(
    signInFor(winSpec, 'C:\\bin\\claude.exe', { platform: 'win32' }),
    "$__p=$env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR='C:\\Users\\Public\\cli-profiles\\claude-code-work'; try { claude } finally { if ($null -eq $__p) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR=$__p } }",
  )

  // Shell quoting hardening: spaces, $HOME, !, ', ", backslashes, and Unicode single quotes
  const trickyPosix = { ...spec, profileDir: `/tmp/my dir/$HOME/a!b/it's/"q"/c\\d` }
  assert.equal(
    signInFor(trickyPosix, '/usr/local/bin/claude', { platform: 'darwin' }),
    `CLAUDE_CONFIG_DIR='/tmp/my dir/$HOME/a!b/it'\\''s/"q"/c\\d' claude`,
  )
  const trickyWin = { ...spec, profileDir: `C:\\Program Data\\$HOME\\a!b\\it's\\‘curly’\\"q"` }
  assert.equal(
    signInFor(trickyWin, 'C:\\bin\\claude.exe', { platform: 'win32' }),
    `$__p=$env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR='C:\\Program Data\\$HOME\\a!b\\it''s\\‘‘curly’’\\"q"'; try { claude } finally { if ($null -eq $__p) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR=$__p } }`,
  )
  // Control characters / newlines in profileDir and invalid env keys never emit an injectable shell snippet
  assert.equal(signInFor({ ...spec, profileDir: '/tmp/ok\nrm -rf /' }, '/usr/local/bin/claude', { platform: 'darwin' }), undefined)
  assert.equal(signInFor({ ...spec, profileDir: 'C:\\tmp\\ok\r\ncalc' }, 'C:\\bin\\claude.exe', { platform: 'win32' }), undefined)
  assert.equal(signInFor({ ...spec, profileDir: '/tmp/ok\0bad' }, '/usr/local/bin/claude', { platform: 'linux' }), undefined)
  assert.equal(signInFor({ ...winSpec, profileEnvKey: 'CLAUDE_CONFIG_DIR; calc' }, 'C:\\bin\\claude.exe', { platform: 'win32' }), undefined)

  // Codex Windows sign-in command scopes CODEX_HOME inside try/finally and handles both absent and preset values
  const codexWinSpec = engineOf('local-codex-cli@work', [], [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: 'C:\\Users\\Alice O\'Neil\\codex-work' }], { home, platform: 'win32' })
  const codexWinCmd = signInFor(codexWinSpec, 'C:\\bin\\codex.cmd', { platform: 'win32' })
  assert.equal(
    codexWinCmd,
    "$__p=$env:CODEX_HOME; $env:CODEX_HOME='C:\\Users\\Alice O''Neil\\codex-work'; try { codex login } finally { if ($null -eq $__p) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME=$__p } }",
  )
  assert.match(codexWinCmd, /^\$__p=\$env:CODEX_HOME; \$env:CODEX_HOME='[^']*(?:''[^']*)*'; try \{ codex login \} finally \{ if \(\$null -eq \$__p\) \{ Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue \} else \{ \$env:CODEX_HOME=\$__p \} \}$/)

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

test('two concurrent profiles of the same CLI spawn isolated processes with distinct config dirs (Claude, Codex)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-multi-prof-'))
  const home = join(root, 'home')
  const spawnedEngines = []

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

  const profiles = [
    { id: 'work', baseRoute: 'local-claude-code', name: 'Work', env: { PROFILE_TAG: 'work-tag' } },
    { id: 'personal', baseRoute: 'local-claude-code', name: 'Personal', env: { PROFILE_TAG: 'personal-tag' } },
    { id: 'work', baseRoute: 'local-codex-cli', name: 'Work' },
    { id: 'personal', baseRoute: 'local-codex-cli', name: 'Personal' },
  ]
  const records = {}
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    home,
    customAgents: () => [],
    profiles: () => profiles,
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const fixture = kind === 'claude' ? fakeClaude : fakeCodex
      const overridden = { ...spec, command: process.execPath, args: [fixture] }
      const engine = kind === 'claude'
        ? new ClaudeEngine(route, overridden, { findExecutable: p => p })
        : new CodexEngine(route, overridden, { findExecutable: p => p })
      spawnedEngines.push(engine)
      return engine
    },
    record: id => records[id],
    saveRecord: (id, rec) => { records[id] = rec },
    presetFor: () => 'workspace-write',
    cwdFor: async () => root,
    probeCwd: () => root,
    toolsFor: () => [],
  })
  t.after(async () => {
    const children = []
    for (const engine of spawnedEngines) {
      if (engine.child) children.push(engine.child)
      for (const session of engine.sessions?.values?.() ?? []) {
        if (session?.child) children.push(session.child)
      }
    }
    const exits = children.map(child => (child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
        const done = () => { child.off('exit', done); child.off('close', done); resolve() }
        child.once('exit', done)
        child.once('close', done)
      })))
    try {
      await adapter.dispose()
      let timer
      try {
        await Promise.race([
          Promise.all(exits),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 3_000)
            timer.unref?.()
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 })
    }
  })

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

  // Isolated Cursor profile on darwin must NOT fall back to fake XDG_CONFIG_HOME (or Keychain)
  mkdirSync(join(workDir, 'cursor'), { recursive: true })
  writeFileSync(join(workDir, 'cursor', 'auth.json'), JSON.stringify({ apiKey: 'work-key' }))
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'darwin', extraEnv: { XDG_CONFIG_HOME: workDir }, isolated: true, spawnKeychain: fakeKeychain,
  }), null)
  // On linux where Cursor explicitly declares `env: 'XDG_CONFIG_HOME'`, its declared entry.env resolves it
  assert.equal(await probeSignIn(cursorOffline, ENGINES['local-cursor-cli'].signedIn, {
    home: globalHome, platform: 'linux', extraEnv: { XDG_CONFIG_HOME: workDir }, isolated: true, spawnKeychain: fakeKeychain,
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
  const home = join(root, 'bot-home')
  const customDir = join(root, 'custom-work-dir')
  const savedEngines = { ...ENGINES }
  const fakeCli = makeNodeScript(root, 'fake-claude-cli.mjs', `
    if (process.argv.includes('--version')) { console.log('claude 2.0.0'); process.exit(0) }
    console.log(JSON.stringify({ loggedIn: Boolean(process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.includes('custom')) }))
  `)
  const fakeGemini = makeNodeScript(root, 'fake-gemini-cli.mjs', `
    if (process.argv.includes('--version')) { console.log('gemini 1.0.0'); process.exit(0) }
  `)
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-claude-code'] = { ...savedEngines['local-claude-code'], command: fakeCli, commands: [fakeCli], version: ['--version'] }
  ENGINES['local-gemini-cli'] = { ...savedEngines['local-gemini-cli'], command: fakeGemini, commands: [fakeGemini], version: ['--version'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, savedEngines)
  })

  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  let saves = 0
  let catalogRefreshes = 0
  const seenProbeEnvs = []
  const rt = {
    ctx,
    home,
    state: { bots: {}, localAgents: { custom: [], profiles: [], sessions: {} } },
    save: async () => { saves += 1 },
    catalog: async (opts) => { if (opts?.fresh) catalogRefreshes += 1; return [] },
  }
  t.after(async () => {
    try {
      await ctx.dispose()
      await owner.fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  installLocalAgents(rt, {
    probeVersion: async () => ({ ok: true, version: 'claude 2.0.0' }),
    probeSignIn: async (_path, _check, opts = {}) => {
      seenProbeEnvs.push({ isolated: opts.isolated ?? false, extraEnv: opts.extraEnv ?? null })
      const dir = opts.extraEnv?.CLAUDE_CONFIG_DIR
      if (!dir) return true
      return dir.includes('custom-work-dir')
    },
  })

  // Initial scan sees both CLIs with explicit supportsProfiles capability flag
  const initial = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(initial.detected.length, 2)
  const claudeDetected = initial.detected.find(entry => entry.route === 'local-claude-code')
  const geminiDetected = initial.detected.find(entry => entry.route === 'local-gemini-cli')
  assert.equal(claudeDetected.signedIn, true)
  assert.equal(claudeDetected.supportsProfiles, true)
  assert.equal(geminiDetected.supportsProfiles, false)
  assert.deepEqual(initial.profiles, [])

  // Non-isolated CLI must be explicitly rejected when attempting to add a profile
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-gemini-cli', name: 'Work' }),
    err => /does not support isolated profiles/i.test(err.message) && errorCode(err) === 'bot/refused',
  )

  // 1. Add profile with default dir -> creates 0o700 dir, registers route, refreshes catalog, probes independently
  const refreshesBeforeAdd = catalogRefreshes
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
  assert.equal(catalogRefreshes, refreshesBeforeAdd + 1, 'local-agent-profile-add must refresh model catalog')
  assert.ok(saves >= 1)

  // Duplicate ID rejected
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'work', name: 'Work 2' }),
    /already exists/,
  )

  // Rejecting global default directory (~/.claude) and duplicate directory across same-CLI profiles
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'global-dup', name: 'Global', configDir: join(homedir(), '.claude') }),
    err => /default global directory/i.test(err.message) && errorCode(err) === 'bot/refused',
  )
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'dir-dup', name: 'Dup Dir', configDir: added.configDir }),
    err => /already used by another Claude Code profile/i.test(err.message) && errorCode(err) === 'bot/refused',
  )

  // Add a second profile with its own folder so we can test cross-profile collision on update
  const secondDir = join(root, 'second-profile-dir')
  const second = await rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-claude-code', id: 'personal', name: 'Personal', configDir: secondDir })
  assert.equal(second.route, 'local-claude-code@personal')
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-update', { route: 'local-claude-code@work', configDir: secondDir }),
    err => /already used by another Claude Code profile/i.test(err.message) && errorCode(err) === 'bot/refused',
  )
  if (process.platform !== 'win32') {
    const symlinkToSecond = join(root, 'link-to-second')
    symlinkSync(secondDir, symlinkToSecond)
    await assert.rejects(
      rt.localAgentsEndpoint('local-agent-profile-update', { route: 'local-claude-code@work', configDir: symlinkToSecond }),
      err => /already used by another Claude Code profile/i.test(err.message) && errorCode(err) === 'bot/refused',
    )
  }
  await rt.localAgentsEndpoint('local-agent-profile-remove', { route: 'local-claude-code@personal' })

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

  // Uninstalling the base CLI and refreshing clears stale cached profileProbes (signedIn must not stay true)
  const savedClaudeSpec = ENGINES['local-claude-code']
  ENGINES['local-claude-code'] = { ...savedClaudeSpec, command: join(root, 'missing-claude'), commands: [join(root, 'missing-claude')] }
  const afterUninstall = await rt.localAgentsEndpoint('local-agent-refresh', {})
  assert.equal(afterUninstall.profiles.length, 1)
  assert.equal(afterUninstall.profiles[0].available, false)
  assert.equal(afterUninstall.profiles[0].signedIn, null, 'uninstalled CLI refresh must clear stale profile sign-in probe state')
  ENGINES['local-claude-code'] = savedClaudeSpec
  const afterReinstall = await rt.localAgentsEndpoint('local-agent-refresh', {})
  assert.equal(afterReinstall.profiles[0].available, true)
  assert.equal(afterReinstall.profiles[0].signedIn, true)

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

test('updating or removing a profile during an active reply fails the stream explicitly and rolls back unread markers', async (t) => {
  await refreshSearchDirs()
  const root = mkdtempSync(join(tmpdir(), 'dsb-prof-active-close-'))
  const home = join(root, 'home')
  const spawnedEngines = []

  // Real Claude fixture: stalls BEFORE system/init when prompt contains 'stall-pre-init'
  // (exercises pre-init unread rollback), and completes normally otherwise.
  const fakeClaudeStall = writeNodeModule(root, 'fake-claude-stall.mjs', `
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
          const text = JSON.stringify(msg.message ?? '')
          if (text.includes('stall-pre-init')) {
            // Stay alive waiting without system/init or result.
            continue
          }
          send({ type: 'system', subtype: 'init', session_id: 'cl-ok-' + process.pid, model: 'sonnet' })
          send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Complete reply' }] } })
          send({ type: 'result', subtype: 'success', is_error: false })
        }
      }
    })
  `)

  // Real Codex app-server fixture: emits partial text and waits for more CLI output
  // without sending turn/completed so we can update or remove the profile mid-reply.
  const fakeCodexPartial = writeNodeModule(root, 'fake-codex-partial.mjs', `
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
        } else if (method === 'thread/start') {
          send({ jsonrpc: '2.0', id, result: { thread: { id: 'thr-' + process.pid } } })
        } else if (method === 'turn/start') {
          send({ jsonrpc: '2.0', id, result: { turn: { id: 't1' } } })
          send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: params.threadId, turnId: 't1', item: { type: 'agentMessage', text: 'Half answer before profile change' } } })
          // Intentionally stay open waiting for next CLI output (no turn/completed).
        }
      }
    })
  `)

  // Part 1: Direct adapter.closeRoute during pre-init Claude stream -> explicit failure + unread rollback;
  // idle session closes quietly without rolling back handedId.
  const profiles = [{ id: 'work', baseRoute: 'local-claude-code', name: 'Work' }]
  const records = {
    's-preinit': { route: 'local-claude-code@work', handedId: 'm1' },
  }
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    home,
    customAgents: () => [],
    profiles: () => profiles,
    findExecutable: p => p,
    spawnEngine: (kind, route, spec) => {
      const overridden = { ...spec, command: process.execPath, args: [fakeClaudeStall] }
      const engine = new ClaudeEngine(route, overridden, { findExecutable: p => p })
      spawnedEngines.push(engine)
      return engine
    },
    record: id => records[id],
    saveRecord: (id, rec) => { records[id] = rec },
    presetFor: () => 'workspace-write',
    cwdFor: async () => root,
    probeCwd: () => root,
    toolsFor: () => [],
  })

  const waitUntil = async (fn, label) => {
    for (let i = 0; i < 300; i += 1) {
      if (fn()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  // Idle session completes normally and closes quietly on closeRoute without altering handedId
  const completed = await collect(adapter.stream({
    provider: 'local-claude-code@work',
    model: 'default',
    sessionId: 's-idle',
    messages: [userMsg('m-idle', 'say hi')],
    tools: [],
  }))
  assert.equal(completed.text, 'Complete reply')
  assert.equal(completed.finish?.kind, 'stop')
  assert.equal(records['s-idle'].handedId, 'm-idle')
  await adapter.closeRoute('local-claude-code@work')
  assert.equal(records['s-idle'].handedId, 'm-idle', 'closing an idle session must stay quiet and keep handedId')

  // Active pre-init stream waiting for CLI output -> closeRoute fails stream explicitly and rolls back handedId
  const preInitPromise = collect(adapter.stream({
    provider: 'local-claude-code@work',
    model: 'default',
    sessionId: 's-preinit',
    messages: [userMsg('m1', 'earlier'), userMsg('m2', 'stall-pre-init')],
    tools: [],
  }))
  await waitUntil(() => adapter.live.get('s-preinit')?.waiters.length > 0 && records['s-preinit']?.handedId === 'm2', 'pre-init stream to park in drain')
  await adapter.closeRoute('local-claude-code@work', 'the local agent configuration changed', { code: 'LOCAL_AGENT_EXIT' })
  await assert.rejects(
    preInitPromise,
    err => err.code === 'LOCAL_AGENT_EXIT' && /configuration changed/i.test(err.message),
  )
  assert.equal(records['s-preinit'].handedId, 'm1', 'unread marker must roll back to handedBefore when interrupted pre-init')
  await adapter.dispose()

  // Part 2: End-to-end local-agent-profile-update (configDir change) and local-agent-profile-remove
  // while a Codex reply stream is waiting for its next CLI output after emitting partial text.
  const savedEngines = { ...ENGINES }
  const fakeCodexBin = makeNodeScript(root, 'fake-codex-bin.mjs', `
    if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0) }
    await import(${JSON.stringify(new URL(`file://${fakeCodexPartial}`).href)})
  `)
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-codex-cli'] = { ...savedEngines['local-codex-cli'], command: fakeCodexBin, commands: [fakeCodexBin], args: [], version: ['--version'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, savedEngines)
  })

  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  const rt = {
    ctx,
    home,
    state: { bots: {}, localAgents: { custom: [], profiles: [], retiredProfiles: [], sessions: {} } },
    save: async () => {},
    catalog: async () => [],
    teamTools: [],
    botOf: () => undefined,
    roomOf: () => undefined,
    selfOf: () => undefined,
    groupOwners: new Map(),
    resolveAgent: async () => ({ session: { header: { cwd: root } } }),
    teamFolder: () => root,
  }
  t.after(async () => {
    try {
      await ctx.dispose()
      await owner.fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 })
    }
  })

  installLocalAgents(rt, {
    probeVersion: async () => ({ ok: true, version: 'codex 1.0.0' }),
    probeSignIn: async () => true,
  })
  await rt.localAgentsEndpoint('local-agents', {})
  const workProfile = await rt.localAgentsEndpoint('local-agent-profile-add', { baseRoute: 'local-codex-cli', name: 'Work' })
  assert.equal(workProfile.route, 'local-codex-cli@work')

  // 2a. Update profile configDir while Codex reply stream is waiting for next CLI output
  const streamForUpdate = llm.stream({
    provider: 'local-codex-cli@work',
    model: 'default',
    sessionId: 's-codex-upd',
    messages: [userMsg('m1', 'generate report')],
    tools: [],
  })
  const firstUpdateChunks = []
  const iterUpdate = streamForUpdate[Symbol.asyncIterator]()
  let sawHalfUpdate = false
  while (!sawHalfUpdate) {
    const step = await iterUpdate.next()
    assert.equal(step.done, false, 'stream must not end before profile update')
    firstUpdateChunks.push(step.value)
    if (step.value.type === 'text-delta' && step.value.text.includes('Half answer')) sawHalfUpdate = true
  }
  // Start waiting for the next event, then change configDir mid-reply
  const restUpdate = (async () => {
    for (;;) {
      const step = await iterUpdate.next()
      if (step.done) return firstUpdateChunks
      firstUpdateChunks.push(step.value)
    }
  })()
  await new Promise(resolve => setTimeout(resolve, 30))
  const updatedDir = join(root, 'codex-work-v2')
  await rt.localAgentsEndpoint('local-agent-profile-update', { route: 'local-codex-cli@work', configDir: updatedDir })
  const updateChunks = await restUpdate
  const updateFinish = updateChunks.find(chunk => chunk.type === 'finish')?.reason
  assert.equal(updateFinish?.kind, 'error', 'interrupted reply must finish as an explicit error, never kind=stop')
  assert.equal(updateFinish?.failure?.code, 'LOCAL_AGENT_EXIT')
  assert.match(updateFinish?.failure?.message ?? '', /configuration changed/i)
  assert.equal(rt.state.localAgents.sessions['s-codex-upd'], undefined, 'configDir update must clear stale route session record')

  // 2b. Remove profile while Codex reply stream is waiting for next CLI output
  const streamForRemove = llm.stream({
    provider: 'local-codex-cli@work',
    model: 'default',
    sessionId: 's-codex-rem',
    messages: [userMsg('m1', 'another report')],
    tools: [],
  })
  const firstRemoveChunks = []
  const iterRemove = streamForRemove[Symbol.asyncIterator]()
  let sawHalfRemove = false
  while (!sawHalfRemove) {
    const step = await iterRemove.next()
    assert.equal(step.done, false, 'stream must not end before profile removal')
    firstRemoveChunks.push(step.value)
    if (step.value.type === 'text-delta' && step.value.text.includes('Half answer')) sawHalfRemove = true
  }
  const restRemove = (async () => {
    for (;;) {
      const step = await iterRemove.next()
      if (step.done) return firstRemoveChunks
      firstRemoveChunks.push(step.value)
    }
  })()
  await new Promise(resolve => setTimeout(resolve, 30))
  await rt.localAgentsEndpoint('local-agent-profile-remove', { route: 'local-codex-cli@work' })
  const removeChunks = await restRemove
  const removeFinish = removeChunks.find(chunk => chunk.type === 'finish')?.reason
  assert.equal(removeFinish?.kind, 'error', 'removed profile reply must finish as an explicit error, never kind=stop')
  assert.equal(removeFinish?.failure?.code, 'LOCAL_AGENT_MISSING')
  assert.match(removeFinish?.failure?.message ?? '', /profile was removed/i)
  assert.equal(rt.state.localAgents.sessions['s-codex-rem'], undefined, 'profile removal must clear route session record')
})

test('removing and recreating a profile with the same name allocates a fresh route and never silently rebinds existing Bots', async (t) => {
  await refreshSearchDirs()
  const root = mkdtempSync(join(tmpdir(), 'dsb-prof-no-rebind-'))
  const home = join(root, 'home')
  const accountADir = join(root, 'codex-account-a')
  const accountBDir = join(root, 'codex-account-b')
  const savedEngines = { ...ENGINES }
  const fakeCodex = makeNodeScript(root, 'fake-codex-cli.mjs', `
    if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0) }
    console.log('Logged in')
  `)
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-codex-cli'] = { ...savedEngines['local-codex-cli'], command: fakeCodex, commands: [fakeCodex], version: ['--version'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, savedEngines)
  })

  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  const rt = {
    ctx,
    home,
    state: {
      bots: {
        // Legacy pre-existing Bot referencing a profile route not yet in retiredProfiles
        bLegacy: { id: 'bLegacy', name: 'LegacyBot', model: 'local-codex-cli@legacy/default', appliedModel: 'local-codex-cli@legacy/default' },
      },
      localAgents: { custom: [], profiles: [], retiredProfiles: [], sessions: {} },
    },
    save: async () => {},
    catalog: async () => [],
    teamTools: [],
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => undefined,
    groupOwners: new Map(),
  }
  t.after(async () => {
    try {
      await ctx.dispose()
      await owner.fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  installLocalAgents(rt, {
    probeVersion: async () => ({ ok: true, version: 'codex 1.0.0' }),
    probeSignIn: async () => true,
  })
  await rt.localAgentsEndpoint('local-agents', {})

  // 1. Create Codex profile "Work" and bind Bot b1 to it
  const firstWork = await rt.localAgentsEndpoint('local-agent-profile-add', {
    baseRoute: 'local-codex-cli',
    name: 'Work',
    configDir: accountADir,
  })
  assert.equal(firstWork.id, 'work')
  assert.equal(firstWork.route, 'local-codex-cli@work')
  rt.state.bots.b1 = {
    id: 'b1',
    name: 'WorkBot',
    model: 'local-codex-cli@work/default',
    appliedModel: 'local-codex-cli@work/default',
  }

  // 2. Remove "Work" -> route is retired; Bot b1 still retains its old selection
  await rt.localAgentsEndpoint('local-agent-profile-remove', { route: 'local-codex-cli@work' })
  assert.ok(rt.state.localAgents.retiredProfiles.includes('local-codex-cli@work'))
  assert.equal(engineOf('local-codex-cli@work', [], rt.state.localAgents.profiles, { home }), undefined)

  // 3. Recreating a profile with the same name "Work" MUST allocate a brand-new route (never reuse @work)
  const recreatedWork = await rt.localAgentsEndpoint('local-agent-profile-add', {
    baseRoute: 'local-codex-cli',
    name: 'Work',
    configDir: accountBDir,
  })
  assert.notEqual(recreatedWork.route, 'local-codex-cli@work')
  assert.equal(recreatedWork.route, 'local-codex-cli@work-2')
  assert.equal(recreatedWork.id, 'work-2')
  assert.equal(recreatedWork.configDir, accountBDir)

  // Existing Bot b1 is NOT silently rebound to accountBDir; its old route still fails as LOCAL_AGENT_MISSING
  assert.equal(rt.state.bots.b1.model, 'local-codex-cli@work/default')
  assert.equal(engineOf('local-codex-cli@work', [], rt.state.localAgents.profiles, { home }), undefined)
  const missingResult = await collect(llm.stream({
    provider: 'local-codex-cli@work',
    model: 'default',
    sessionId: 's-b1',
    messages: [userMsg('m1', 'secret history')],
    tools: [],
  }))
  assert.equal(missingResult.finish?.kind, 'error')
  assert.equal(missingResult.finish?.failure?.code, 'LOCAL_AGENT_MISSING')

  // 4. Explicitly passing retired ID "work" is refused with bot/invalid
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', {
      baseRoute: 'local-codex-cli',
      id: 'work',
      name: 'Work Hijack',
    }),
    err => errorCode(err) === 'bot/invalid' && /previously removed|referenced by a Bot/i.test(err.message),
  )

  // 5. Even without retiredProfiles, a route still referenced by an existing Bot cannot be hijacked
  const recreatedLegacy = await rt.localAgentsEndpoint('local-agent-profile-add', {
    baseRoute: 'local-codex-cli',
    name: 'Legacy',
  })
  assert.equal(recreatedLegacy.route, 'local-codex-cli@legacy-2', 'auto-generated ID must skip routes referenced by existing Bots')
  await assert.rejects(
    rt.localAgentsEndpoint('local-agent-profile-add', {
      baseRoute: 'local-codex-cli',
      id: 'legacy',
      name: 'Legacy Hijack',
    }),
    err => errorCode(err) === 'bot/invalid' && /previously removed|referenced by a Bot/i.test(err.message),
  )
})

test('liveFor re-resolves Codex profile after async secret preparation so retired CODEX_HOME is never spawned', async () => {
  const dirA = '/tmp/codex-profile-a'
  const dirB = '/tmp/codex-profile-b'
  let profiles = [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: dirA }]
  const spawnedSpecs = []
  let releaseSecrets
  const adapter = new LocalAgentAdapter({
    customAgents: () => [],
    profiles: () => profiles,
    home: '/tmp/dsbot-home',
    record: () => undefined,
    saveRecord: () => {},
    dropRecord: () => {},
    presetFor: () => 'default',
    toolsFor: () => [],
    signInHint: () => '',
    usedModels: () => [],
    prepareSecretEnvForSession: async () => new Promise(resolve => { releaseSecrets = resolve }),
    secretEnvForSession: () => ({ API_KEY: 'secret-1' }),
    spawnEngine: (_kind, _route, spec) => {
      spawnedSpecs.push(spec)
      return { close: async () => {} }
    },
  })

  // 1. Update profile configDir while secret loading is held open -> must spawn with dirB, never dirA
  const updatePending = adapter.liveFor({ sessionId: 's1', provider: 'local-codex-cli@work', model: 'default' }, 'default')
  await new Promise(resolve => setTimeout(resolve, 10))
  profiles = [{ id: 'work', baseRoute: 'local-codex-cli', name: 'Work', configDir: dirB }]
  await adapter.closeRoute('local-codex-cli@work', 'profile updated')
  releaseSecrets()
  const live = await updatePending
  assert.equal(spawnedSpecs.length, 1)
  assert.equal(spawnedSpecs[0].env.CODEX_HOME, dirB, 'Codex must spawn with updated CODEX_HOME, never stale dirA')
  assert.equal(spawnedSpecs[0].env.API_KEY, 'secret-1')
  assert.equal(live.spec.env.CODEX_HOME, dirB)

  // 2. Remove profile while secret loading is held open -> must NOT spawn and must reject with LOCAL_AGENT_MISSING
  const removePending = adapter.liveFor({ sessionId: 's2', provider: 'local-codex-cli@work', model: 'default' }, 'default')
  await new Promise(resolve => setTimeout(resolve, 10))
  profiles = []
  await adapter.closeRoute('local-codex-cli@work', 'profile removed', { code: 'LOCAL_AGENT_MISSING' })
  releaseSecrets()
  await assert.rejects(removePending, err => err?.code === 'LOCAL_AGENT_MISSING')
  assert.equal(spawnedSpecs.length, 1, 'removed profile must never spawn a Codex process')
})
