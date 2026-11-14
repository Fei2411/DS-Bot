import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { cleanEnv } from '../src/host/local-agents/discover.js'

test('inherited Git command-line config is removed as one group while normal user config remains usable', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-git-env-'))
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  const globalConfig = join(root, 'user.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Local Agent\n')
  const injected = /^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/i
  const original = new Map(Object.entries(process.env).filter(([key]) => injected.test(key) || key.toUpperCase() === 'GIT_CONFIG_GLOBAL'))
  for (const key of original.keys()) delete process.env[key]
  t.after(() => {
    for (const key of Object.keys(process.env)) if (injected.test(key) || key.toUpperCase() === 'GIT_CONFIG_GLOBAL') delete process.env[key]
    for (const [key, value] of original) process.env[key] = value
  })
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_COUNT = '2'
  process.env.GIT_CONFIG_KEY_0 = 'user.name'
  process.env.GIT_CONFIG_VALUE_0 = 'Inherited Host'
  process.env.GIT_CONFIG_KEY_1 = 'http.extraHeader'
  process.env.GIT_CONFIG_VALUE_1 = 'Authorization: fake-host-test-only'
  process.env.GIT_CONFIG_PARAMETERS = "'user.name=Injected Parameters'"
  const env = cleanEnv()
  assert.deepEqual(Object.keys(env).filter(key => injected.test(key)), [])
  assert.equal(env.GIT_CONFIG_GLOBAL, globalConfig)
  const named = spawnSync('git', ['config', '--get', 'user.name'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(named.status, 0, named.stderr)
  assert.equal(named.stdout.trim(), 'Local Agent')
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  delete process.env.GIT_CONFIG_PARAMETERS
  delete process.env.GIT_CONFIG_KEY_0
  process.env.GIT_CONFIG_COUNT = '1'
  const malformed = spawnSync('git', ['status', '--porcelain'], { cwd: root, env: process.env, encoding: 'utf8' })
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.stderr, /missing config key GIT_CONFIG_KEY_0/)
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, env: cleanEnv(), encoding: 'utf8' })
  assert.equal(status.status, 0, status.stderr)
})
