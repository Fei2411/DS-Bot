import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  loginShellCandidates, mergeLoginShellEnvironment, parseLoginShellOutput, readLoginShellEnvironment,
  resolveLoginShellConfig,
} from '../src/login-shell-env.mjs'

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const config = { timeoutMs: 5_000 }
const POSIX = process.platform !== 'win32'

let directory
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ds-bot-login-shell-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** Whether `pid` has exited; Linux can keep a killed process as a zombie until its new parent reaps it. */
function exited(pid) {
  try {
    if (process.platform === 'linux') return /^State:\s+[ZXx]\b/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code ?? '')) return true
    throw error
  }
}

/** A stand-in login shell: `body` plays the rc files, then the dump command runs under /bin/sh. */
function shell(name, body) {
  const path = join(directory, name)
  writeFileSync(path, `#!/bin/sh\n[ "$1" = -ilc ] || exit 64\n${body}\nexec /bin/sh -c "$2"\n`)
  chmodSync(path, 0o755)
  return path
}

const waitFor = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const account = (shellValue, throws = false) => () => { if (throws) throw new Error('ENOENT: no such user'); return { shell: shellValue } }

describe('resolveLoginShellConfig', () => {
  test('defaults to ten seconds and accepts an override', () => {
    assert.deepEqual(resolveLoginShellConfig({}), { timeoutMs: 10_000 })
    assert.deepEqual(resolveLoginShellConfig({ DS_BOT_LOGIN_SHELL_TIMEOUT_MS: '2500' }), { timeoutMs: 2_500 })
  })

  for (const value of ['999', '1.5', 'soon', '2147483648']) {
    test(`rejects ${value}`, () => {
      assert.throws(() => resolveLoginShellConfig({ DS_BOT_LOGIN_SHELL_TIMEOUT_MS: value }),
        { message: 'DS_BOT_LOGIN_SHELL_TIMEOUT_MS must be an integer from 1000 through 2147483647' })
    })
  }
})

describe('loginShellCandidates', () => {
  for (const [value, candidates] of [
    ['/opt/homebrew/bin/fish', ['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash', '/bin/sh']],
    ['/bin/bash', ['/bin/bash', '/bin/zsh', '/bin/sh']],
    ['', ['/bin/zsh', '/bin/bash', '/bin/sh']],
    [null, ['/bin/zsh', '/bin/bash', '/bin/sh']],
  ]) {
    test(`tries account shell ${String(value)} before distinct system shells`, () => {
      assert.deepEqual(loginShellCandidates(account(value)), candidates)
    })
  }

  test('uses only system shells when the account record is unreadable', () => {
    assert.deepEqual(loginShellCandidates(account(undefined, true)), ['/bin/zsh', '/bin/bash', '/bin/sh'])
  })
})

describe('parseLoginShellOutput', () => {
  test('reads only the variables between the delimiters', () => {
    const output = `motd\0${DELIMITER}\0A=1\0MULTI=x\ny=z\0=ignored\0NOEQUALS\0\0${DELIMITER}\0trailing`
    assert.deepEqual(parseLoginShellOutput(output), { A: '1', MULTI: 'x\ny=z' })
  })

  test('rejects output without both delimiters', () => {
    assert.equal(parseLoginShellOutput('A=1\0'), undefined)
    assert.equal(parseLoginShellOutput(`\0${DELIMITER}\0A=1\0`), undefined)
  })
})

describe('mergeLoginShellEnvironment', () => {
  test('lets shell values win except probe-session and launcher-owned names', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/user', DS_BOT_HOME: '/launcher', DSH_HOME: '/launcher-dsh', PWD: '/' }
    const merged = mergeLoginShellEnvironment(base, {
      PATH: '/login/bin:/usr/bin', XDG_CACHE_HOME: '/cache', PWD: '/home/user', OLDPWD: '/', SHLVL: '2', _: '/usr/bin/env',
      DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false',
      DS_BOT_HOME: '/rc', DSH_HOME: '/rc-home', ELECTRON_RUN_AS_NODE: '1',
    })
    assert.deepEqual(merged, { PATH: '/login/bin:/usr/bin', HOME: '/home/user', DS_BOT_HOME: '/launcher', DSH_HOME: '/launcher-dsh', PWD: '/', XDG_CACHE_HOME: '/cache' })
    assert.equal(base.PATH, '/usr/bin')
  })
})

describe('readLoginShellEnvironment', () => {
  test('returns the inherited environment on Windows without running a shell', async () => {
    const base = { Path: 'C:\\Windows' }
    assert.deepEqual(
      await readLoginShellEnvironment(base, config, { platform: 'win32', shells: [shell('unused', 'exit 1')] }),
      { environment: base, failures: [] },
    )
  })

  test('records a candidate whose path cannot be passed to spawn', async () => {
    const result = await readLoginShellEnvironment({}, config, { platform: 'linux', shells: ['/bin/sh\0'] })
    assert.deepEqual(result.environment, {})
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0].reason, /null bytes/u)
  })

  test('skips every candidate when already aborted', async () => {
    const base = { PATH: '/usr/bin' }
    const signal = AbortSignal.abort()
    assert.deepEqual(
      await readLoginShellEnvironment(base, config, { platform: 'darwin', shells: ['/a', '/b'], signal }),
      { environment: base, failures: [{ shell: '/a', reason: 'aborted' }] },
    )
  })
})

// Stand-in shells are POSIX scripts; Windows returns before spawning.
describe('readLoginShellEnvironment on POSIX', { skip: !POSIX && 'needs a POSIX login shell' }, () => {
  test('merges variables exported by rc files, ignoring their other output', async () => {
    const login = shell('login', [
      'echo "rc banner"',
      '[ "$DISABLE_AUTO_UPDATE" = true ] && [ "$ZSH_TMUX_AUTOSTART" = false ] || exit 65',
      'read -r answer; export ANSWER="${answer:-eof}"',
      'export PATH="/login/bin:$PATH" MULTI=\'a\nb\' STARTED_IN="$PWD"',
    ].join('\n'))
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin:/bin', KEPT: '1' }, config, { platform: 'darwin', shells: [login] })
    assert.deepEqual(result.failures, [])
    assert.equal(result.environment.PATH, '/login/bin:/usr/bin:/bin')
    assert.equal(result.environment.KEPT, '1')
    assert.equal(result.environment.MULTI, 'a\nb')
    assert.equal(result.environment.ANSWER, 'eof')
    assert.equal(result.environment.STARTED_IN, homedir())
    assert.equal(Object.hasOwn(result.environment, 'DISABLE_AUTO_UPDATE'), false)
  })

  test('records each failing candidate and uses the next one', async () => {
    const candidates = [
      join(directory, 'missing'),
      shell('exits', 'exit 3'),
      shell('signalled', 'kill -TERM $$'),
      shell('silent', 'exit 0'),
      shell('working', 'export FROM=working'),
    ]
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin:/bin' }, config, { platform: 'linux', shells: candidates })
    assert.equal(result.environment.FROM, 'working')
    assert.equal(result.failures.length, 4)
    assert.match(result.failures[0].reason, /ENOENT/u)
    assert.equal(result.failures[1].reason, 'exit 3')
    assert.equal(result.failures[2].reason, 'SIGTERM')
    assert.equal(result.failures[3].reason, 'unparsed')
  })

  test('completes at the closing delimiter while an rc-started child keeps stdout open', async (t) => {
    const pidFile = join(directory, 'child.pid')
    const detaching = shell('detaching', `sleep 30 & echo $! > '${pidFile}'\nexport FROM=detaching`)
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin:/bin' }, config, { platform: 'darwin', shells: [detaching] })
    const child = Number(readFileSync(pidFile, 'utf8'))
    t.after(() => { try { process.kill(child, 'SIGKILL') } catch { /* already gone */ } })
    assert.deepEqual(result.failures, [])
    assert.equal(result.environment.FROM, 'detaching')
    assert.equal(exited(child), false)
  })

  test('ends a timed-out shell with its background children and keeps the inherited environment', async () => {
    const pidFile = join(directory, 'child.pid')
    const hanging = shell('hanging', `sleep 30 & echo $! > '${pidFile}'; wait`)
    const base = { PATH: '/usr/bin:/bin' }
    const result = await readLoginShellEnvironment(base, { timeoutMs: 2_000 }, { platform: 'darwin', shells: [hanging] })
    assert.deepEqual(result, { environment: base, failures: [{ shell: hanging, reason: 'timeout' }] })
    const child = Number(readFileSync(pidFile, 'utf8'))
    await waitFor(() => exited(child))
  })

  test('ends the running shell group on abort and skips the remaining candidates', async () => {
    const pidFile = join(directory, 'child.pid')
    const hanging = shell('hanging', `sleep 30 & echo $! > '${pidFile}'; wait`)
    const base = { PATH: '/usr/bin:/bin' }
    const controller = new AbortController()
    const read = readLoginShellEnvironment(base, config, {
      platform: 'linux', shells: [hanging, shell('unused', 'export FROM=unused')], signal: controller.signal,
    })
    const child = await waitFor(() => {
      try { return Number(readFileSync(pidFile, 'utf8')) > 0 } catch { return false }
    })
    controller.abort()
    assert.deepEqual(await read, { environment: base, failures: [{ shell: hanging, reason: 'aborted' }] })
    await waitFor(() => exited(Number(readFileSync(pidFile, 'utf8'))))
    assert.ok(child)
  })
})
