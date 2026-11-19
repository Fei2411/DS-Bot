import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentEnv, cleanEnv, findEngineExecutable, findExecutable, launchOf, refreshSearchDirs, spawnAgent } from '../src/host/local-agents/discover.js'

test('Windows pi-acp resolves standalone Pi through PATH and PATHEXT (#1795)', () => {
  const exe = 'F:\\Pi\\pi.exe'
  const env = { Path: 'C:\\empty;F:\\Pi', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const find = name => findExecutable(name, { platform: 'win32', env, isFile: path => path === exe })
  assert.equal(find('pi'), exe)
  assert.equal(agentEnv('C:\\npm\\pi-acp.cmd', env, { platform: 'win32', find }).PI_ACP_PI_COMMAND, exe)
  for (const ext of ['cmd', 'bat', 'exe']) {
    const path = `F:\\Pi\\pi.${ext}`
    const lookup = name => findExecutable(name, { platform: 'win32', env, isFile: candidate => candidate === path })
    assert.equal(agentEnv('pi-acp', env, { platform: 'win32', find: lookup }).PI_ACP_PI_COMMAND, path)
  }
  assert.equal(agentEnv('pi-acp.exe', env, { platform: 'win32', find: () => undefined }), env)
  const explicit = { ...env, PI_ACP_PI_COMMAND: 'D:\\custom\\pi.exe' }
  assert.equal(agentEnv('pi-acp', explicit, { platform: 'win32', find }), explicit)
  assert.equal(agentEnv('other.cmd', env, { platform: 'win32', find }), env)
  assert.equal(agentEnv('pi-acp', env, { platform: 'darwin', find }), env)
})

test('Windows lookup skips relative PATH directories', () => {
  const env = { PATH: '.;bin;C:relative;C:\\tools', PATHEXT: '.EXE' }
  const checked = []
  const find = name => findExecutable(name, { platform: 'win32', env, isFile: path => { checked.push(path); return path.endsWith('.exe') } })
  assert.equal(find('pi'), 'C:\\tools\\pi.exe')
  assert.deepEqual(checked, ['C:\\tools\\pi.exe'])
  assert.equal(findExecutable('pi', { platform: 'win32', env: { PATH: '.;bin', PATHEXT: '.EXE' }, isFile: path => ['pi.exe', 'bin\\pi.exe'].includes(path) }), undefined)
})

test('Windows lookup only returns executable or batch extensions', () => {
  const lookup = (name, files, PATHEXT) => findExecutable(name, {
    platform: 'win32', env: { PATH: 'C:\\tools', ...(PATHEXT === undefined ? {} : { PATHEXT }) }, isFile: path => files.includes(path),
  })
  for (const ext of ['js', 'vbs', 'ps1', '']) {
    const file = `C:\\tools\\agent${ext ? `.${ext}` : ''}`
    assert.equal(lookup('agent', [file], '.JS;.VBS;.PS1;.EXE'), undefined)
    assert.equal(lookup(file, [file]), undefined)
  }
  assert.equal(lookup('agent', ['C:\\tools\\agent.cmd', 'C:\\tools\\agent.exe'], '.JS;.EXE;.CMD'), 'C:\\tools\\agent.exe')
  assert.equal(lookup('agent', ['C:\\tools\\agent.cmd'], '.JS'), undefined)
  assert.equal(lookup('agent', ['C:\\tools\\agent.cmd'], ''), undefined)
  assert.equal(lookup('agent', ['C:\\tools\\agent.com']), 'C:\\tools\\agent.com')
  assert.equal(lookup('agent.js', ['C:\\tools\\agent.js.cmd'], '.JS;.CMD'), 'C:\\tools\\agent.js.cmd')
  assert.equal(lookup('agent.CmD', ['C:\\tools\\agent.CmD'], '.EXE'), 'C:\\tools\\agent.CmD')
})

test('Windows pi-acp preserves environment overrides regardless of key casing', () => {
  for (const key of ['Pi_Acp_Pi_Command', 'pi_acp_pi_command', 'PI_ACP_PI_COMMAND']) {
    const env = { [key]: 'D:\\custom\\pi.exe' }
    assert.equal(agentEnv('pi-acp.cmd', env, { platform: 'win32', find: () => assert.fail('must not resolve an overridden Pi') }), env)
  }
})

test('Windows resolves dotted command names unless their suffix is already in PATHEXT', () => {
  const env = { PATH: 'C:\\agents', PATHEXT: '.EXE;.CMD' }
  const lookup = (name, file) => findExecutable(name, { platform: 'win32', env, isFile: path => path === file })
  assert.equal(lookup('agent.v2', 'C:\\agents\\agent.v2.cmd'), 'C:\\agents\\agent.v2.cmd')
  assert.equal(lookup('agent.CmD', 'C:\\agents\\agent.CmD'), 'C:\\agents\\agent.CmD')
  assert.equal(lookup('agent.CmD', 'C:\\agents\\agent.CmD.cmd'), undefined)
})

// npm-*.cmd are what npm 11's cmd-shim writes for a Node script and for an .exe;
// pnpm-node.cmd follows pnpm 11's shim template with a NODE_PATH.
const shim = name => readFileSync(new URL(`./fixtures/windows-shims/${name}`, import.meta.url), 'utf8')
const onWindows = (name, { exists = () => false, find = () => undefined } = {}) => ({
  platform: 'win32', readFile: () => shim(name), exists, find,
})
const SYSTEM = 'Line one.\nSay "hi" & 100% done | <ok>'

test('on Windows an npm shim starts its Node script with the arguments intact (spawn EINVAL)', () => {
  const exe = 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd'
  const script = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode'
  assert.deepEqual(launchOf(exe, ['acp', SYSTEM], onWindows('npm-node.cmd', { find: name => (name === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : undefined) })),
    { file: 'C:\\Program Files\\nodejs\\node.exe', args: [script, 'acp', SYSTEM] })
  const beside = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe'
  assert.deepEqual(launchOf(exe, ['acp'], onWindows('npm-node.cmd', { exists: path => path === beside })), { file: beside, args: [script, 'acp'] })
})

test('on Windows an npm shim for a program starts the program', () => {
  assert.deepEqual(launchOf('C:\\tools\\fake.cmd', ['--version'], onWindows('npm-exe.cmd')),
    { file: 'C:\\tools\\node_modules\\fake\\bin\\fake.exe', args: ['--version'] })
})

test('on Windows a pnpm shim starts its Node script', () => {
  const exe = 'C:\\Users\\me\\AppData\\Local\\pnpm\\opencode.cmd'
  assert.deepEqual(launchOf(exe, ['acp'], onWindows('pnpm-node.cmd', { find: () => 'C:\\nodejs\\node.exe' })),
    { file: 'C:\\nodejs\\node.exe', args: ['C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\opencode-ai\\bin\\opencode', 'acp'] })
})

test('another batch file runs through cmd.exe only with plain arguments', () => {
  const other = { platform: 'win32', readFile: () => '@echo off\r\nstart-agent\r\n', exists: () => false, find: () => undefined }
  const launch = launchOf('C:\\agents\\my agent.bat', ['acp'], other)
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(launch.args[3], '""C:\\agents\\my agent.bat" acp"')
  assert.equal(launch.options.windowsVerbatimArguments, true)
  assert.throws(() => launchOf('C:\\agents\\agent.bat', ['--append-system-prompt', SYSTEM], other), /batch file/)
})

test('elsewhere, and for an .exe, the executable starts as found', () => {
  assert.deepEqual(launchOf('/usr/local/bin/opencode', ['acp']), { file: '/usr/local/bin/opencode', args: ['acp'] })
  assert.deepEqual(launchOf('C:\\bin\\opencode.exe', ['acp'], { platform: 'win32' }), { file: 'C:\\bin\\opencode.exe', args: ['acp'] })
})

// The real thing on the Windows runner: npm's shim, a Node script behind it, and an
// argument that cmd.exe would have cut or expanded.
test('an agent CLI installed by npm starts on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-shim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules', 'opencode-ai', 'bin'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('./fixtures/echo-argv-env.mjs', import.meta.url)), join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode'))
  writeFileSync(join(root, 'opencode.cmd'), shim('npm-node.cmd'))
  const child = spawnAgent(join(root, 'opencode.cmd'), ['acp', SYSTEM], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out).argv, ['acp', SYSTEM])
})

// A held npm on PATH stands for the real one: it has not answered when the lookup
// starts, so the host must not wait for it on the way to a Session, and its global
// folder joins once the answer arrives. The test lets npm answer itself; a fixed
// `sleep 2` raced the lookup's own 5 s child timeout whenever the suite was busy
// enough to delay the child past it.
test('finding a CLI never waits on npm, and npm\'s global folder joins in the background', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-'))
  const fakeBin = join(root, 'bin')
  const prefix = join(root, 'npm-global')
  const release = join(root, 'npm-release')
  t.after(() => {
    // Let a held npm exit even when an assertion above failed before releasing it.
    writeFileSync(release, '')
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(fakeBin)
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nprintf '%s\\n' '${prefix}'\n`)
  writeFileSync(join(prefix, 'bin', 'dsb-fake-agent'), '#!/bin/sh\n')
  chmodSync(join(fakeBin, 'npm'), 0o755)
  chmodSync(join(prefix, 'bin', 'dsb-fake-agent'), 0o755)
  const { PATH, SHELL } = process.env
  process.env.PATH = `${fakeBin}${delimiter}${PATH}`
  process.env.SHELL = '/bin/false'
  t.after(() => { process.env.PATH = PATH; process.env.SHELL = SHELL })

  const started = Date.now()
  assert.equal(findExecutable('dsb-fake-agent'), undefined)
  const refresh = refreshSearchDirs()
  assert.ok(Date.now() - started < 1000, 'the lookup waited on npm')
  writeFileSync(release, '')
  await refresh
  assert.equal(findExecutable('dsb-fake-agent'), join(prefix, 'bin', 'dsb-fake-agent'))
})

test('on Windows an Antigravity .exe in LocalAppData launches directly', () => {
  const exe = 'C:\\Users\\user\\AppData\\Local\\agy\\bin\\agy.exe'
  assert.deepEqual(launchOf(exe, ['acp'], { platform: 'win32' }), { file: exe, args: ['acp'] })
})

test('findExecutable skips a directory matching the binary name (#1407) and findEngineExecutable resolves aliases', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-dir-'))
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(dirA, 'kilocode'), { recursive: true })
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'kilocode'), '#!/bin/sh\n')
  chmodSync(join(dirB, 'kilocode'), 0o755)
  const { PATH } = process.env
  process.env.PATH = `${dirA}${delimiter}${dirB}${delimiter}${PATH}`
  t.after(() => { process.env.PATH = PATH })

  assert.equal(findExecutable('kilocode'), join(dirB, 'kilocode'))
  assert.equal(findEngineExecutable({ command: 'kilo', commands: ['kilo', 'kilocode'] }), join(dirB, 'kilocode'))
})

test('cleanEnv strips DEEPSEEK_ variables along with agent tokens', () => {
  const prev = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DSB_KEEP_CHECK: process.env.DSB_KEEP_CHECK }
  process.env.DEEPSEEK_API_KEY = 'secret-deepseek'
  process.env.DSB_KEEP_CHECK = 'kept'
  try {
    const cleaned = cleanEnv({ EXTRA_FLAG: '1' })
    assert.equal(cleaned.DEEPSEEK_API_KEY, undefined)
    assert.equal(cleaned.DSB_KEEP_CHECK, 'kept')
    assert.equal(cleaned.EXTRA_FLAG, '1')
  } finally {
    if (prev.DEEPSEEK_API_KEY === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prev.DEEPSEEK_API_KEY
    if (prev.DSB_KEEP_CHECK === undefined) delete process.env.DSB_KEEP_CHECK
    else process.env.DSB_KEEP_CHECK = prev.DSB_KEEP_CHECK
  }
})
