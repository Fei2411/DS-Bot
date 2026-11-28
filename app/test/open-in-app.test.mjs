import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildLaunchSpec, collectWorkspaceRoots, detectInstalledApps, openInExternalApp, OpenInAppStore, validateWorkspaceTarget } from '../src/open-in-app.mjs'

test('detectInstalledApps detects macOS bundles/CLI, Windows programs/JetBrains/wt.exe, and Linux PATH binaries', () => {
  // 1. macOS
  const macPaths = new Set([
    '/Applications/Cursor.app',
    '/Applications/Visual Studio Code.app',
    '/mock-home/Applications/Zed.app',
    '/Applications/WebStorm.app',
    '/Applications/iTerm.app',
    '/Applications/Ghostty.app',
    '/System/Applications/Utilities/Terminal.app',
  ])
  const macApps = detectInstalledApps({
    platform: 'darwin',
    home: '/mock-home',
    env: { PATH: '/usr/bin:/bin' },
    existsFn: p => macPaths.has(p),
  })
  assert.deepEqual(
    macApps.map(a => a.id),
    ['cursor', 'vscode', 'zed', 'webstorm', 'iterm', 'ghostty', 'terminal', 'finder'],
  )
  const macEditorSpec = buildLaunchSpec(macApps.find(a => a.id === 'cursor'), '/repo/src/a.js', { platform: 'darwin', isDirectory: false })
  assert.equal(macEditorSpec.command, 'open')
  assert.deepEqual(macEditorSpec.args, ['-a', '/Applications/Cursor.app', '/repo/src/a.js'])
  assert.equal(macEditorSpec.options.shell, false)

  // Terminal opens parent folder when invoked on a file.
  const macTermSpec = buildLaunchSpec(macApps.find(a => a.id === 'ghostty'), '/repo/src/a.js', { platform: 'darwin', isDirectory: false })
  assert.deepEqual(macTermSpec.args, ['-a', '/Applications/Ghostty.app', '/repo/src'])

  // 2. Windows
  const winPaths = new Set([
    'x:\\mockhome\\appdata\\local\\programs\\microsoft vs code\\code.exe',
    'x:\\mockhome\\appdata\\local\\programs\\cursor\\cursor.exe',
    'c:\\program files\\jetbrains',
    'c:\\program files\\jetbrains\\intellij idea 2026.1\\bin\\idea64.exe',
    'x:\\mockhome\\appdata\\local\\microsoft\\windowsapps\\wt.exe',
  ])
  const winApps = detectInstalledApps({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'X:\\MockHome\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
    },
    existsFn: p => winPaths.has(p.toLowerCase()),
    readdirFn: dir => (dir.toLowerCase() === 'c:\\program files\\jetbrains' ? ['IntelliJ IDEA 2026.1'] : []),
  })
  assert.deepEqual(
    winApps.map(a => a.id),
    ['cursor', 'vscode', 'intellij', 'windows-terminal', 'explorer'],
  )
  const wtSpec = buildLaunchSpec(winApps.find(a => a.id === 'windows-terminal'), 'C:\\repo\\src\\a.js', { platform: 'win32', isDirectory: false })
  assert.equal(wtSpec.args[0], '-d')
  assert.equal(wtSpec.options.shell, false)

  // 3. Linux
  const linuxPaths = new Set(['/usr/bin/code', '/usr/local/bin/zed', '/usr/bin/ghostty', '/usr/bin/gnome-terminal'])
  const linuxApps = detectInstalledApps({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    existsFn: p => linuxPaths.has(p),
  })
  assert.deepEqual(linuxApps.map(a => a.id), ['vscode', 'zed', 'ghostty', 'gnome-terminal', 'file-manager'])
  const gnomeSpec = buildLaunchSpec(linuxApps.find(a => a.id === 'gnome-terminal'), '/repo', { platform: 'linux', isDirectory: true })
  assert.deepEqual(gnomeSpec.args, ['--working-directory=/repo'])
})

test('OpenInAppStore remembers per-directory default apps across reloads and openInExternalApp scrubs secrets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-oia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'open-in-app-defaults.json')

  const store1 = new OpenInAppStore(file)
  assert.equal(store1.getDefault('/work/alpha'), null)
  store1.setDefault('/work/alpha/', 'cursor')
  store1.setDefault('/work/beta', 'zed')
  assert.equal(store1.getDefault('/work/alpha'), 'cursor')
  assert.equal(store1.getDefault('/work/beta'), 'zed')

  // Reload from disk in a new store instance.
  const store2 = new OpenInAppStore(file)
  assert.equal(store2.getDefault('/work/alpha'), 'cursor')
  assert.equal(store2.getDefault('/work/beta'), 'zed')

  // openInExternalApp strips secret env keys and spawns shell-free.
  let captured = null
  const spawnFn = (command, args, options) => {
    captured = { command, args, options }
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('spawn'))
    return child
  }
  await openInExternalApp(
    { id: 'vscode', name: 'VS Code', category: 'editor', kind: 'mac-bundle', target: '/Applications/Visual Studio Code.app' },
    dir,
    {
      platform: 'darwin',
      env: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-secret',
        DS_BOT_TOKEN: 'hidden',
        GITHUB_AUTH: 'gh-auth',
        MY_CREDENTIAL: 'cred',
        SESSION_COOKIE: 'sid=1',
        SSH_PRIVATE_PEM: 'priv',
      },
      spawnFn,
      statFn: () => ({ isDirectory: () => true }),
    },
  )
  assert.equal(captured.command, 'open')
  assert.equal(captured.options.shell, false)
  for (const leaked of ['OPENAI_API_KEY', 'DS_BOT_TOKEN', 'GITHUB_AUTH', 'MY_CREDENTIAL', 'SESSION_COOKIE', 'SSH_PRIVATE_PEM']) {
    assert.equal(Object.hasOwn(captured.options.env, leaked), false, `must scrub ${leaked}`)
  }
  assert.equal(readdirSync(dir).some(f => f.endsWith('.tmp')), false, 'atomic store write leaves no leftover .tmp files')
})

test('Windows detection resolves bin/*.cmd to native .exe and never spawns .cmd with shell:false', async () => {
  // Custom install where PATH contains `D:\Apps\VSCode\bin` with `code.cmd` and sibling `D:\Apps\VSCode\Code.exe`,
  // plus an orphan `windsurf.cmd` with NO sibling `.exe` that must be skipped.
  const winPaths = new Set([
    'd:\\apps\\vscode\\bin\\code.cmd',
    'd:\\apps\\vscode\\code.exe',
    'd:\\apps\\orphan\\bin\\windsurf.cmd',
  ])
  const apps = detectInstalledApps({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'X:\\MockHome\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\Apps\\VSCode\\bin;D:\\Apps\\Orphan\\bin',
    },
    existsFn: p => winPaths.has(p.toLowerCase()),
    readdirFn: () => [],
  })
  const vscode = apps.find(a => a.id === 'vscode')
  assert.ok(vscode, 'resolves VS Code from bin/code.cmd to sibling Code.exe')
  assert.equal(vscode.target.toLowerCase(), 'd:\\apps\\vscode\\code.exe')
  assert.equal(apps.some(a => /\.cmd$/i.test(a.target)), false, 'must never return .cmd wrappers on win32')
  assert.equal(apps.some(a => a.id === 'windsurf'), false, 'orphan .cmd without sibling .exe must not be advertised')

  assert.throws(
    () => openInExternalApp(
      { id: 'vscode', name: 'VS Code', category: 'editor', kind: 'win-exe', target: 'C:\\VSCode\\bin\\code.cmd' },
      'C:\\repo',
      { platform: 'win32', statFn: () => ({ isDirectory: () => true }) },
    ),
    /batch wrapper/i,
  )
})

test('validateWorkspaceTarget enforces realpath workspace containment, blocks symlink escapes and protected data directories', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsb-oia-sec-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))

  const dataDir = join(base, 'data')
  const userData = join(base, 'userData')
  const dshHome = join(base, 'dsh-home')
  const workspace = join(base, 'workspace')
  const botWorkDir = join(base, 'bot-extra-repo')
  const outside = join(base, 'outside-secret')
  mkdirSync(join(dataDir, 'bot'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(botWorkDir, { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(join(workspace, 'hello.txt'), 'ok')
  writeFileSync(join(botWorkDir, 'bot-file.txt'), 'ok')
  writeFileSync(join(outside, 'id_rsa'), 'secret')
  writeFileSync(join(dataDir, 'bot', 'state.json'), JSON.stringify({
    bots: { b1: { workDir: botWorkDir } },
    rooms: {},
  }))
  writeFileSync(join(dshHome, 'config.json'), '{}')

  let hasSymlink = false
  try {
    symlinkSync(join(outside, 'id_rsa'), join(workspace, 'escape-link'))
    symlinkSync(dataDir, join(workspace, 'data-link'))
    hasSymlink = true
  } catch { /* Windows without symlink privilege */ }

  const roots = collectWorkspaceRoots({
    places: { dataDir, workspace },
    userDshHome: dshHome,
    userData,
    env: { DSH_HOME: dshHome },
  })

  // Legitimate workspace and configured Bot workDir targets succeed.
  assert.ok(validateWorkspaceTarget(join(workspace, 'hello.txt'), roots).endsWith('hello.txt'))
  assert.ok(validateWorkspaceTarget(join(botWorkDir, 'bot-file.txt'), roots).endsWith('bot-file.txt'))

  // Outside paths and protected directories are rejected.
  assert.throws(() => validateWorkspaceTarget(join(outside, 'id_rsa'), roots), /outside the active workspace/i)
  assert.throws(() => validateWorkspaceTarget(join(dataDir, 'bot', 'state.json'), roots), /outside|protected/i)
  assert.throws(() => validateWorkspaceTarget(join(dshHome, 'config.json'), roots), /outside|protected/i)
  assert.throws(() => validateWorkspaceTarget(userData, roots), /outside|protected/i)

  // Symlink inside workspace escaping to outside or protected dataDir is rejected via realpath.
  if (hasSymlink) {
    assert.throws(() => validateWorkspaceTarget(join(workspace, 'escape-link'), roots), /outside the active workspace/i)
    assert.throws(() => validateWorkspaceTarget(join(workspace, 'data-link'), roots), /outside|protected/i)
  }

  // Default workspace lying inside dataDir (`<dataDir>/workspace`) is permitted while sibling dataDir files remain blocked.
  const nestedWs = join(dataDir, 'workspace')
  mkdirSync(nestedWs, { recursive: true })
  writeFileSync(join(nestedWs, 'nested.txt'), 'ok')
  const nestedRoots = collectWorkspaceRoots({
    places: { dataDir, workspace: nestedWs },
    userDshHome: dshHome,
    userData,
    env: {},
  })
  assert.ok(validateWorkspaceTarget(join(nestedWs, 'nested.txt'), nestedRoots).endsWith('nested.txt'))
  assert.throws(() => validateWorkspaceTarget(join(dataDir, 'bot', 'state.json'), nestedRoots), /outside|protected/i)
})
