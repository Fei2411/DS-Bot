import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { install as installFolders } from '../src/host/folders.js'
import { installGitConfigEnvGuard, isInjectedGitConfigEnvKey } from '../src/host/git-config-env.js'
import * as workspacePanel from '../src/host/workspace-panel.js'
import { fakeContext } from './fake-ctx.js'

const TRACKED_ENV_RE = /^(?:GIT_CONFIG_(?:COUNT|PARAMETERS|GLOBAL|(?:KEY|VALUE)_\d+)|OPENAI_API_KEY)$/i

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

test('installGitConfigEnvGuard handles mixed casing, multi-digit indices, and shared Cordis scopes', async () => {
  const env = {
    git_config_count: '10',
    Git_Config_Key_0: 'core.quotePath',
    git_config_value_0: 'true',
    GIT_CONFIG_KEY_9: 'http.extraHeader',
    GIT_CONFIG_VALUE_9: 'Authorization: test',
    Git_Config_Parameters: "'user.name=Injected'",
    GIT_CONFIG_GLOBAL: '/tmp/user.gitconfig',
    GIT_CONFIG_SYSTEM: '/tmp/system.gitconfig',
    PATH: '/usr/bin',
  }
  const first = new Context()
  const second = new Context()
  first.effect(() => installGitConfigEnvGuard(env))
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'PATH'])

  // A second scope joins without losing the first scope's saved values, and also strips any new entries.
  env.GIT_CONFIG_COUNT = '2'
  second.effect(() => installGitConfigEnvGuard(env))
  assert.equal(env.GIT_CONFIG_COUNT, undefined)

  await first.fiber.dispose()
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'PATH'])

  // An entry explicitly set while active is preserved on final dispose.
  env.git_config_count = '0'
  await second.fiber.dispose()
  assert.equal(env.git_config_count, '0')
  assert.equal(env.Git_Config_Key_0, 'core.quotePath')
  assert.equal(env.git_config_value_0, 'true')
  assert.equal(env.GIT_CONFIG_KEY_9, 'http.extraHeader')
  assert.equal(env.GIT_CONFIG_VALUE_9, 'Authorization: test')
  assert.equal(env.Git_Config_Parameters, "'user.name=Injected'")
  assert.equal(env.GIT_CONFIG_GLOBAL, '/tmp/user.gitconfig')
})

test('ds-bot activation removes inherited GIT_CONFIG_* group so DSH scrubbedParentEnv keeps git working', async t => {
  saveAndClearTrackedEnv(t)
  const root = mkdtempSync(join(tmpdir(), 'dsb-git-cfg-'))
  const home = join(root, 'bot-home')
  const globalConfig = join(root, 'user.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = DS Bot User\n')
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_PARAMETERS = "'user.name=Injected'"
  process.env.OPENAI_API_KEY = 'sk-test-must-not-leak'

  // Importing the plugin alone must not mutate process.env before activation.
  const plugin = await import('../index.js')
  assert.equal(process.env.GIT_CONFIG_COUNT, '1')

  // Baseline: DSH's scrubbedParentEnv drops GIT_CONFIG_KEY_0 but keeps GIT_CONFIG_COUNT,
  // making git fail with exit 128 before ds-bot activates.
  const broken = spawnSync('git', ['config', '--list'], { cwd: root, env: scrubbedParentEnv(), encoding: 'utf8' })
  assert.equal(broken.status, 128)
  assert.match(broken.stderr, /missing config key GIT_CONFIG_KEY_0/)

  const ctx = fakeContext()
  try {
    await plugin.apply(ctx, { home })
    const env = scrubbedParentEnv()
    assert.equal(env.GIT_CONFIG_COUNT, undefined)
    assert.equal(env.GIT_CONFIG_KEY_0, undefined)
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined)
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.GIT_CONFIG_GLOBAL, globalConfig)

    const listed = spawnSync('git', ['config', '--list'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /user\.name=DS Bot User/)

    const init = spawnSync('git', ['init', '--quiet'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(status.status, 0, status.stderr)
  } finally {
    await ctx.dispose()
  }

  // Disposing the plugin restores the parent process environment.
  assert.equal(process.env.GIT_CONFIG_COUNT, '1')
  assert.equal(process.env.GIT_CONFIG_KEY_0, 'core.quotePath')
  assert.equal(process.env.GIT_CONFIG_VALUE_0, 'true')
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, "'user.name=Injected'")
  assert.equal(process.env.GIT_CONFIG_GLOBAL, globalConfig)
})

test('workspace-panel PTY terminal tombstones inherited GIT_CONFIG_* group while keeping GIT_CONFIG_GLOBAL', async t => {
  saveAndClearTrackedEnv(t)
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-git-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-git-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  process.env.GIT_CONFIG_GLOBAL = join(workDir, 'user.gitconfig')
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_PARAMETERS = "'core.quotePath=true'"
  process.env.OPENAI_API_KEY = 'sk-must-not-leak'

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
  assert.equal(Object.hasOwn(capturedSpec.env, 'OPENAI_API_KEY'), false)
})

test('workspace-panel fallback terminal drops inherited GIT_CONFIG_* group so git succeeds', async t => {
  saveAndClearTrackedEnv(t)
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-fb-git-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-fb-git-dsh-'))
  const globalConfig = join(workDir, 'user.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Fallback Terminal User\n')
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_PARAMETERS = "'user.name=Injected'"

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
  assert.match(output, /Fallback Terminal User/)
  assert.doesNotMatch(output, /missing config key GIT_CONFIG_KEY_0/)
})
