import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildLaunchSpec, detectInstalledApps, openInExternalApp, OpenInAppStore } from '../src/open-in-app.mjs'

test('detectInstalledApps detects macOS bundles/CLI, Windows programs/JetBrains/wt.exe, and Linux PATH binaries', () => {
  // 1. macOS
  const macPaths = new Set([
    '/Applications/Cursor.app',
    '/Applications/Visual Studio Code.app',
    '/Users/dev/Applications/Zed.app',
    '/Applications/WebStorm.app',
    '/Applications/iTerm.app',
    '/Applications/Ghostty.app',
    '/System/Applications/Utilities/Terminal.app',
  ])
  const macApps = detectInstalledApps({
    platform: 'darwin',
    home: '/Users/dev',
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
    'c:\\users\\dev\\appdata\\local\\programs\\microsoft vs code\\code.exe',
    'c:\\users\\dev\\appdata\\local\\programs\\cursor\\cursor.exe',
    'c:\\program files\\jetbrains',
    'c:\\program files\\jetbrains\\intellij idea 2026.1\\bin\\idea64.exe',
    'c:\\users\\dev\\appdata\\local\\microsoft\\windowsapps\\wt.exe',
  ])
  const winApps = detectInstalledApps({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
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
      env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-secret', DS_BOT_TOKEN: 'hidden' },
      spawnFn,
      statFn: () => ({ isDirectory: () => true }),
    },
  )
  assert.equal(captured.command, 'open')
  assert.equal(captured.options.shell, false)
  assert.equal(Object.hasOwn(captured.options.env, 'OPENAI_API_KEY'), false)
  assert.equal(Object.hasOwn(captured.options.env, 'DS_BOT_TOKEN'), false)
})
