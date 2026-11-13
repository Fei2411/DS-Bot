import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findExecutable, launchOf, refreshSearchDirs, spawnAgent } from '../src/host/local-agents/discover.js'

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

// A data folder can share a CLI's name: a PATH entry may hold an app's data root,
// where `Devin/` and `devin` are the same name on Windows. A directory is not a CLI;
// the scan must skip it and keep going to the real file behind it.
test('a directory on PATH does not shadow the CLI file after it', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-shadow-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shadow = join(root, 'shadow')
  const bin = join(root, 'bin')
  const name = `dsb-shadow-${process.pid}`
  mkdirSync(join(shadow, name), { recursive: true })
  mkdirSync(bin)
  const executable = join(bin, name)
  writeFileSync(executable, '#!/bin/sh\nexit 0\n')
  chmodSync(executable, 0o755)
  const { PATH } = process.env
  process.env.PATH = [shadow, bin, PATH].join(delimiter)
  t.after(() => { process.env.PATH = PATH })

  assert.equal(findExecutable(name), executable)
})

// The same name with no file behind it is not an installed CLI: registering the
// directory would only make every call to it fail with ENOENT.
test('a directory alone on PATH is not an installed CLI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-dir-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const name = `dsb-dir-only-${process.pid}`
  mkdirSync(join(root, name), { recursive: true })
  const { PATH } = process.env
  process.env.PATH = [root, PATH].join(delimiter)
  t.after(() => { process.env.PATH = PATH })

  assert.equal(findExecutable(name), undefined)
})

// The Windows shape of the same bug: the data folder is `devin` and the real CLI is
// `devin.exe` in another PATH entry. The bare directory must not win.
test('a directory on PATH does not shadow a .exe CLI on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-win-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shadow = join(root, 'shadow')
  const bin = join(root, 'bin')
  const name = `dsb-shadow-${process.pid}`
  mkdirSync(join(shadow, name), { recursive: true })
  mkdirSync(bin)
  const executable = join(bin, `${name}.exe`)
  writeFileSync(executable, '')
  const { PATH } = process.env
  process.env.PATH = [shadow, bin, PATH].join(delimiter)
  t.after(() => { process.env.PATH = PATH })

  assert.equal(findExecutable(name), executable)
})

// An absolute path has the same rule: a directory is refused, a file is returned.
test('an absolute path is an executable only when it is a file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-abs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'dsb-abs-agent')
  mkdirSync(directory)
  assert.equal(findExecutable(directory), undefined)
  const file = join(root, 'dsb-abs-agent-file')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  assert.equal(findExecutable(file), file)
})
