import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { install as installFolders } from '../src/host/folders.js'
import { isInjectedGitConfigEnvKey } from '../src/host/git-config-env.js'
import * as workspacePanel from '../src/host/workspace-panel.js'

const TRACKED_ENV_RE = /^(?:GIT_CONFIG_(?:COUNT|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM|(?:KEY|VALUE)_\d+)|OPENAI_API_KEY)$/i

function saveAndClearTrackedEnv(t) {
  const original = new Map(Object.entries(process.env).filter(([key]) => TRACKED_ENV_RE.test(key)))
  for (const key of original.keys()) delete process.env[key]
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (TRACKED_ENV_RE.test(key)) delete process.env[key]
    }
    for (const [key, value] of original) process.env[key] = value
  })
}

function applyChildOverrides(base, overrides) {
  const out = { ...base }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    for (const existing of Object.keys(out)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete out[existing]
    }
    if (value !== undefined) out[key] = value
  }
  return out
}

function makeWorkspaceRuntime(workDir, dshHome, { subprocess, onLocalFeed } = {}) {
  const botMap = { b1: { id: 'b1', name: 'Bot', sessionId: 'b1' } }
  const chatOwners = new Map([['b1', 'b1']])
  const rt = {
    ctx: {
      get: name => (name === 'subprocess' ? subprocess : undefined),
      workspaceRegistry: {
        get: id => (id === 'ws-1' ? { id: 'ws-1', path: workDir, title: 'Team' } : undefined),
        list: () => [{ id: 'ws-1', path: workDir, title: 'Team' }],
      },
      sessions: { get: () => undefined },
      on: () => () => {},
      effect: () => () => {},
      connection: { fetch: { register: () => () => {} } },
    },
    config: {},
    dshHome,
    home: join(dshHome, 'bot'),
    state: { revision: 1, workspaceId: 'ws-1', bots: botMap, rooms: {} },
    load: async () => {},
    onSaved: () => () => {},
    botOf: id => botMap[id],
    selfOf: id => chatOwners.get(id),
    chatOwners,
    roomOf: () => undefined,
    groupOwners: new Map(),
    taskOwners: new Map(),
    pastOwners: new Map(),
    publishFeed: () => {},
    publishLocalFeed: (event, data) => { onLocalFeed?.(event, data) },
  }
  installFolders(rt)
  workspacePanel.install(rt)
  return rt
}

test('isInjectedGitConfigEnvKey matches only the command-line Git config group case-insensitively', () => {
  for (const key of [
    'GIT_CONFIG_COUNT', 'git_config_count',
    'GIT_CONFIG_PARAMETERS', 'Git_Config_Parameters',
    'GIT_CONFIG_KEY_0', 'Git_Config_Key_10',
    'GIT_CONFIG_VALUE_0', 'git_config_value_10',
  ]) {
    assert.equal(isInjectedGitConfigEnvKey(key), true, key)
  }
  for (const key of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_KEY_', 'GIT_CONFIG_KEY_foo', 'PATH', '', null, undefined,
  ]) {
    assert.equal(isInjectedGitConfigEnvKey(key), false, String(key))
  }
})

test('workspace-panel PTY terminal tombstones inherited GIT_CONFIG_* group so git succeeds without mutating process.env', async t => {
  saveAndClearTrackedEnv(t)
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-git-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-git-dsh-'))
  const globalConfig = join(workDir, 'user.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = DS Bot User\n')
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dshHome, { recursive: true, force: true, maxRetries: 5 })
  })

  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_PARAMETERS = "'user.name=Injected'"
  process.env.OPENAI_API_KEY = 'sk-must-not-leak'

  // Baseline: DSH's scrubbedParentEnv drops GIT_CONFIG_KEY_0 but keeps GIT_CONFIG_COUNT,
  // making git fail with exit 128 unless the child env tombstones the whole group.
  const broken = spawnSync('git', ['config', '--list'], { cwd: workDir, env: scrubbedParentEnv(), encoding: 'utf8' })
  assert.equal(broken.status, 128)
  assert.match(broken.stderr, /missing config key GIT_CONFIG_KEY_0/)

  let capturedSpec
  let resolveDone
  const subprocess = {
    spawnTerminal: async spec => {
      capturedSpec = spec
      return {
        pid: 42,
        output: new PassThrough(),
        done: new Promise(resolve => { resolveDone = resolve }),
        write: async () => {},
        resize: async () => {},
        terminate: async () => { resolveDone?.({ exitCode: 0 }) },
      }
    },
  }

  const rt = makeWorkspaceRuntime(workDir, dshHome, { subprocess })
  t.after(() => rt.terminalDispose())

  await rt.terminalEndpoint('open', { sessionId: 'b1', cols: 80, rows: 24 })
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_COUNT'), true)
  assert.equal(capturedSpec.env.GIT_CONFIG_COUNT, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_KEY_0'), true)
  assert.equal(capturedSpec.env.GIT_CONFIG_KEY_0, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_VALUE_0'), true)
  assert.equal(capturedSpec.env.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_PARAMETERS'), true)
  assert.equal(capturedSpec.env.GIT_CONFIG_PARAMETERS, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_GLOBAL'), false)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_NOSYSTEM'), false)
  assert.equal(Object.hasOwn(capturedSpec.env, 'OPENAI_API_KEY'), false)

  // Host process.env stays untouched for other plugins and non-terminal children.
  assert.equal(process.env.GIT_CONFIG_COUNT, '1')
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, "'user.name=Injected'")
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')

  const effectiveEnv = applyChildOverrides(scrubbedParentEnv(), capturedSpec.env)
  assert.equal(effectiveEnv.GIT_CONFIG_GLOBAL, globalConfig)
  assert.equal(effectiveEnv.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(effectiveEnv.OPENAI_API_KEY, undefined)
  const listed = spawnSync('git', ['config', '--list'], { cwd: workDir, env: effectiveEnv, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /user\.name=DS Bot User/)
  assert.doesNotMatch(listed.stdout, /user\.name=Injected/)
})

test('workspace-panel child env tombstones mixed-case GIT_CONFIG_* keys while preserving GIT_CONFIG_NOSYSTEM', async t => {
  saveAndClearTrackedEnv(t)
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-git-case-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-git-case-dsh-'))
  const globalConfig = join(workDir, 'user.gitconfig')
  const systemConfig = join(workDir, 'system.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Mixed Case User\n')
  writeFileSync(systemConfig, '[dsbot]\n\tsystemMarker = from-system\n')
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dshHome, { recursive: true, force: true, maxRetries: 5 })
  })

  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_SYSTEM = systemConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.Git_Config_Count = '1'
  process.env.git_config_value_0 = 'x'
  process.env.Git_Config_Parameters = "'a=b'"

  const scrubbed = scrubbedParentEnv()
  assert.equal(scrubbed.Git_Config_Count, '1')
  assert.equal(scrubbed.git_config_value_0, 'x')
  assert.equal(scrubbed.Git_Config_Parameters, "'a=b'")
  assert.equal(scrubbed.GIT_CONFIG_GLOBAL, globalConfig)
  assert.equal(scrubbed.GIT_CONFIG_SYSTEM, systemConfig)
  assert.equal(scrubbed.GIT_CONFIG_NOSYSTEM, '1')
  if (process.platform === 'win32') {
    const broken = spawnSync('git', ['config', '--list'], { cwd: workDir, env: scrubbed, encoding: 'utf8' })
    assert.equal(broken.status, 128)
    assert.match(broken.stderr, /missing config key GIT_CONFIG_KEY_0/)
  }

  let capturedSpec
  let resolveDone
  const subprocess = {
    spawnTerminal: async spec => {
      capturedSpec = spec
      return {
        pid: 43,
        output: new PassThrough(),
        done: new Promise(resolve => { resolveDone = resolve }),
        write: async () => {},
        resize: async () => {},
        terminate: async () => { resolveDone?.({ exitCode: 0 }) },
      }
    },
  }

  const rt = makeWorkspaceRuntime(workDir, dshHome, { subprocess })
  t.after(() => rt.terminalDispose())

  await rt.terminalEndpoint('open', { sessionId: 'b1', cols: 80, rows: 24 })
  assert.equal(Object.hasOwn(capturedSpec.env, 'Git_Config_Count'), true)
  assert.equal(capturedSpec.env.Git_Config_Count, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'git_config_value_0'), true)
  assert.equal(capturedSpec.env.git_config_value_0, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'Git_Config_Parameters'), true)
  assert.equal(capturedSpec.env.Git_Config_Parameters, undefined)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_GLOBAL'), false)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_SYSTEM'), false)
  assert.equal(Object.hasOwn(capturedSpec.env, 'GIT_CONFIG_NOSYSTEM'), false)

  const effectiveEnv = applyChildOverrides(scrubbed, capturedSpec.env)
  assert.deepEqual(Object.keys(effectiveEnv).filter(key => isInjectedGitConfigEnvKey(key)), [])
  assert.equal(effectiveEnv.GIT_CONFIG_GLOBAL, globalConfig)
  assert.equal(effectiveEnv.GIT_CONFIG_SYSTEM, systemConfig)
  assert.equal(effectiveEnv.GIT_CONFIG_NOSYSTEM, '1')

  const listed = spawnSync('git', ['config', '--list'], { cwd: workDir, env: effectiveEnv, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /user\.name=Mixed Case User/)
  assert.doesNotMatch(listed.stdout, /^a=b$/m)
  assert.doesNotMatch(listed.stdout, /dsbot\.systemmarker=from-system/)

  const openCmd = workspacePanel.buildOpenOsCommand(globalConfig, 'open', false, process.platform)
  assert.deepEqual(Object.keys(openCmd.options.env).filter(key => isInjectedGitConfigEnvKey(key)), [])
  assert.equal(openCmd.options.env.GIT_CONFIG_GLOBAL, globalConfig)
  assert.equal(openCmd.options.env.GIT_CONFIG_SYSTEM, systemConfig)
  assert.equal(openCmd.options.env.GIT_CONFIG_NOSYSTEM, '1')
  const openGit = spawnSync('git', ['config', '--list'], { cwd: workDir, env: openCmd.options.env, encoding: 'utf8' })
  assert.equal(openGit.status, 0, openGit.stderr)
  assert.match(openGit.stdout, /user\.name=Mixed Case User/)
  assert.doesNotMatch(openGit.stdout, /dsbot\.systemmarker=from-system/)

  // Host process.env stays untouched.
  assert.equal(process.env.Git_Config_Count, '1')
  assert.equal(process.env.git_config_value_0, 'x')
  assert.equal(process.env.Git_Config_Parameters, "'a=b'")
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
})

test('workspace-panel fallback terminal drops inherited GIT_CONFIG_* group so git succeeds', async t => {
  saveAndClearTrackedEnv(t)
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-fb-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-fb-dsh-'))
  const globalConfig = join(workDir, 'user.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Fallback Git User\n')
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dshHome, { recursive: true, force: true, maxRetries: 5 })
  })

  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_PARAMETERS = "'user.name=Injected'"
  process.env.OPENAI_API_KEY = 'sk-must-not-leak'

  let output = ''
  let resolveExit
  const exited = new Promise(resolve => { resolveExit = resolve })
  const rt = makeWorkspaceRuntime(workDir, dshHome, {
    onLocalFeed: (event, data) => {
      if (event === 'terminal') output += data.chunk
      if (event === 'terminal-exit') resolveExit(data.code)
    },
  })
  t.after(() => rt.terminalDispose())

  const opened = await rt.terminalEndpoint('open', { sessionId: 'b1', cols: 80, rows: 24 })
  assert.equal(opened.pty, false)
  const nl = process.platform === 'win32' ? '\r\n' : '\n'
  await rt.terminalEndpoint('input', { id: opened.id, data: `git config --get user.name${nl}exit${nl}` })

  const code = await exited
  assert.equal(code, 0, output)
  assert.match(output, /Fallback Git User/)
  assert.doesNotMatch(output, /missing config key GIT_CONFIG_KEY_0/)
  assert.equal(process.env.GIT_CONFIG_COUNT, '1')
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, "'user.name=Injected'")
})
