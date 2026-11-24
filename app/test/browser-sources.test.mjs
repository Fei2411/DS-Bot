// Browser profile enumeration (Chromium user-data roots, Firefox profiles.ini), the clone
// layout a harvest needs, and the process match for closing a running source on Windows.
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import {
  appBoundRows,
  checkSourceLiveDebug,
  chromiumCloneArgs,
  chromiumProfiles,
  cloneCookieStore,
  cloneWorkDir,
  closeBrowser,
  countSqliteCookies,
  decryptChromiumV10,
  deriveLinuxChromiumKey,
  deriveMacChromiumKey,
  firefoxProfiles,
  harvestCookies,
  harvestLinuxChromiumV10,
  harvestLiveChromium,
  harvestMacChromium,
  hasAppBoundKey,
  importFromBrowser,
  isLoopbackPortOpen,
  kindOfExe,
  locksProfile,
  probeSource,
  readChromiumSqliteCookies,
  readDevToolsActivePort,
  readFirefoxSqliteCookies,
  snapshotSqliteDatabase,
  userDataRoots,
} from '../src/browser-sources.mjs'

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-sources-test-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) }
}

test('chromiumProfiles reads info_cache names, emails, last_used, and skips profiles without cookies', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 1', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Profile 1', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 2'), { recursive: true }) // no cookie db: not listed
    await mkdir(join(root.dir, 'System Profile', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'System Profile', 'Network', 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: {
        last_used: 'Profile 1',
        info_cache: {
          Default: { name: 'Person 1', user_name: 'personal@example.com' },
          'Profile 1': { name: 'Work', user_name: 'work@example.com' },
        },
      },
    }))
    const profiles = await chromiumProfiles(root.dir)
    assert.deepEqual(profiles.map((p) => p.dir), ['Default', 'Profile 1'])
    assert.deepEqual(profiles.map((p) => p.name), ['Person 1', 'Work'])
    assert.deepEqual(profiles.map((p) => p.email), ['personal@example.com', 'work@example.com'])
    assert.deepEqual(profiles.map((p) => p.isLastUsed), [false, true])
    assert.equal(profiles[0].cookieDb, join(root.dir, 'Default', 'Network', 'Cookies'))
    assert.equal(profiles[0].hasCookies, true)
  } finally { await root.remove() }
})

test('chromiumProfiles handles flat Opera cookie store layout', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root.dir, 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Network', 'Cookies'), 'x')
    const profiles = await chromiumProfiles(root.dir, { flat: true })
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].dir, '')
    assert.equal(profiles[0].cookieDb, join(root.dir, 'Network', 'Cookies'))
    assert.equal(profiles[0].hasCookies, true)
  } finally { await root.remove() }
})

test('chromiumCloneArgs passes --profile-directory for non-Default profiles and omits it for flat profiles', () => {
  const work = '/tmp/clone-work'
  const profile1 = chromiumCloneArgs({
    userDataDir: '/u/Chrome',
    profilePath: '/u/Chrome/Profile 1',
    profileDir: 'Profile 1',
    cookieDb: '/u/Chrome/Profile 1/Network/Cookies',
  }, work)
  assert.ok(profile1.includes(`--user-data-dir=${work}`))
  assert.ok(profile1.includes('--profile-directory=Profile 1'))

  const flat = chromiumCloneArgs({
    userDataDir: '/u/Opera',
    profilePath: '/u/Opera',
    profileDir: '',
    flat: true,
    cookieDb: '/u/Opera/Network/Cookies',
  }, work)
  assert.ok(flat.includes(`--user-data-dir=${work}`))
  assert.equal(flat.some((a) => a.startsWith('--profile-directory=')), false)
})

test('firefoxProfiles reads profiles.ini', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root.dir, 'Profiles', 'abc.default-release'), { recursive: true })
    await writeFile(join(root.dir, 'Profiles', 'abc.default-release', 'cookies.sqlite'), 'x')
    await writeFile(join(root.dir, 'profiles.ini'), [
      '[Profile0]', 'Name=default-release', 'IsRelative=1', 'Path=Profiles/abc.default-release', 'Default=1',
      '[Profile1]', 'Name=other', 'IsRelative=0', `Path=${join(root.dir, 'elsewhere')}`,
    ].join('\n'))
    const profiles = await firefoxProfiles(root.dir)
    assert.equal(profiles.length, 2)
    assert.equal(profiles[0].name, 'default-release')
    assert.equal(profiles[0].path, join(root.dir, 'Profiles', 'abc.default-release'))
    assert.equal(profiles[0].hasCookies, true)
    assert.equal(profiles[1].path, join(root.dir, 'elsewhere'))
    assert.equal(profiles[1].hasCookies, false)
  } finally { await root.remove() }
})

test('readDevToolsActivePort and hasAppBoundKey inspect Chromium user-data roots', async () => {
  const root = await tempRoot()
  try {
    assert.equal(readDevToolsActivePort(root.dir), null)
    assert.equal(hasAppBoundKey(root.dir), false)

    await writeFile(join(root.dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc-123\n')
    assert.deepEqual(readDevToolsActivePort(root.dir), {
      port: 9222,
      wsPath: '/devtools/browser/abc-123',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
    })

    await writeFile(join(root.dir, 'DevToolsActivePort'), 'not-a-port\n/bad\n')
    assert.equal(readDevToolsActivePort(root.dir), null)

    await writeFile(join(root.dir, 'Local State'), JSON.stringify({ os_crypt: { app_bound_encrypted_key: 'QVBQQg==' } }))
    assert.equal(hasAppBoundKey(root.dir), true)
  } finally { await root.remove() }
})

test('cloneCookieStore lays out Local State plus the profile cookie db', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'db')
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies-wal'), 'wal')
    await writeFile(join(root.dir, 'Local State'), '{}')
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(root.dir, 'Default', 'Network', 'Cookies') }
    const copied = await cloneCookieStore(source, work.dir)
    assert.equal(copied.length, 3)
    assert.ok(existsSync(join(work.dir, 'Local State')))
    assert.ok(existsSync(join(work.dir, 'Default', 'Network', 'Cookies')))
    assert.ok(existsSync(join(work.dir, 'Default', 'Network', 'Cookies-wal')))
  } finally { await work.remove(); await root.remove() }
})

test('cloneCookieStore needs Local State: without it the clone cannot decrypt', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'db')
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(root.dir, 'Default', 'Network', 'Cookies') }
    await assert.rejects(() => cloneCookieStore(source, work.dir))
  } finally { await work.remove(); await root.remove() }
})

test('cloneCookieStore for Firefox copies the sqlite family', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const profile = join(root.dir, 'Profiles', 'abc.default')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cookies.sqlite'), 'db')
    const source = { engine: 'firefox', profilePath: profile }
    const copied = await cloneCookieStore(source, work.dir)
    assert.deepEqual(copied, [join(profile, 'cookies.sqlite')])
    assert.ok(existsSync(join(work.dir, 'cookies.sqlite')))
  } finally { await work.remove(); await root.remove() }
})

async function cookieDb(dir, rows) {
  const db = new DatabaseSync(join(dir, 'Cookies'))
  db.exec('CREATE TABLE cookies (name TEXT, host_key TEXT, path TEXT, encrypted_value BLOB)')
  const insert = db.prepare('INSERT INTO cookies (name, host_key, path, encrypted_value) VALUES (?, ?, ?, ?)')
  for (const [name, host, blob] of rows) insert.run(name, host, '/', blob)
  db.close()
}

function encryptMacV10(plaintext, key, { hostKey, withDomainHash = false } = {}) {
  const payload = withDomainHash
    ? Buffer.concat([createHash('sha256').update(hostKey, 'utf8').digest(), Buffer.from(plaintext, 'utf8')])
    : Buffer.from(plaintext, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(payload), cipher.final()])
}

test('deriveMacChromiumKey, decryptChromiumV10, and readChromiumSqliteCookies decrypt pre-v24 and v24+ macOS cookies', async () => {
  const root = await tempRoot()
  try {
    const key = deriveMacChromiumKey('synthetic-safe-storage-pass')
    assert.equal(key.length, 16)

    const pre24 = encryptMacV10('fake-session-token', key)
    assert.equal(decryptChromiumV10(pre24, key, { hostKey: '.example.com', stripDomainHash: false }), 'fake-session-token')

    const v24 = encryptMacV10('fake-v24-value', key, { hostKey: '.example.com', withDomainHash: true })
    assert.equal(decryptChromiumV10(v24, key, { hostKey: '.example.com', stripDomainHash: true }), 'fake-v24-value')

    const dbPath = join(root.dir, 'Cookies')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '24')
    const futureWebkit = (1900000000 + 11644473600) * 1e6
    const pastWebkit = (1000000000 + 11644473600) * 1e6
    const ins = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    ins.run('.example.com', 'auth', '', v24, '/', 1, 1, futureWebkit, 1, 1, '')
    ins.run('app.example.com', 'sess', '', encryptMacV10('sess-val', key, { hostKey: 'app.example.com', withDomainHash: true }), '/app', 1, 0, 0, 2, 0, 'https://example.com')
    ins.run('.example.com', 'old', '', v24, '/', 1, 0, pastWebkit, 1, 1, '')
    ins.run('.example.com', 'abe', '', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)]), '/', 1, 0, futureWebkit, 0, 1, '')
    db.close()

    const { cookies, skipped } = readChromiumSqliteCookies(dbPath, { key, now: 1700000000 })
    assert.equal(cookies.length, 2)
    assert.equal(cookies[0].name, 'auth')
    assert.equal(cookies[0].value, 'fake-v24-value')
    assert.equal(cookies[0].sameSite, 'Lax')
    assert.equal(cookies[0].httpOnly, true)
    assert.equal(cookies[0].expires, 1900000000)

    assert.equal(cookies[1].name, 'sess')
    assert.equal(cookies[1].value, 'sess-val')
    assert.equal(cookies[1].sameSite, 'Strict')
    assert.equal(cookies[1].expires, undefined)
    assert.deepEqual(cookies[1].partitionKey, { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true })

    assert.deepEqual(skipped.map((s) => [s.name, s.code]), [['old', 'expired'], ['abe', 'app-bound']])
  } finally { await root.remove() }
})

test('harvestLiveChromium reads cookies and open-tab localStorage via WebSocket CDP without closing the browser', async () => {
  const root = await tempRoot()
  const methods = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      methods.push(msg.method)
      if (msg.method === 'Storage.getCookies') {
        ws.send(JSON.stringify({
          id: msg.id,
          result: {
            cookies: [
              { name: 'sid', value: 'live-cookie-val', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', session: false, expires: 1900000000 },
              { name: 'MUIDB', value: 'insecure-none', domain: 'www.bing.com', path: '/', secure: false, httpOnly: true, sameSite: 'None', session: false, expires: 1900000000 },
              { name: 'sec_none', value: 'secure-none', domain: 'www.bing.com', path: '/', secure: true, httpOnly: false, sameSite: 'None', session: false, expires: 1900000000 },
              { name: 'stale', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: false, session: false, expires: 1000000000 },
            ],
          },
        }))
      } else if (msg.method === 'Target.getBrowserContexts') {
        ws.send(JSON.stringify({ id: msg.id, result: { browserContextIds: [], defaultBrowserContextId: 'ctx-1' } }))
      } else if (msg.method === 'Target.getTargets') {
        ws.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfos: [
              { targetId: 't1', type: 'page', url: 'https://app.example.com/dashboard' },
              { targetId: 't2', type: 'page', url: 'chrome://settings' },
            ],
          },
        }))
      } else if (msg.method === 'Target.attachToTarget') {
        ws.send(JSON.stringify({ id: msg.id, result: { sessionId: 'sess-1' } }))
      } else if (msg.method === 'Runtime.evaluate') {
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify([{ name: 'auth_token', value: 'tok-123' }]) } } }))
      } else if (msg.method === 'Target.detachFromTarget') {
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
      }
    })
  })
  try {
    const activePort = { port, path: '/devtools/browser/test', wsUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }
    const source = { engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default' }
    const out = await harvestLiveChromium(source, { activePort, skipFocus: true, now: 1700000000 })
    assert.equal(out.cookies.length, 3)
    assert.equal(out.cookies[0].name, 'sid')
    assert.equal(out.cookies[0].value, 'live-cookie-val')
    assert.equal(out.cookies[1].name, 'MUIDB')
    assert.equal(out.cookies[1].sameSite, undefined, 'SameSite=None without Secure is dropped')
    assert.equal(out.cookies[2].name, 'sec_none')
    assert.equal(out.cookies[2].sameSite, 'None')
    assert.equal(out.skipped.length, 1)
    assert.equal(out.skipped[0].code, 'expired')
    assert.deepEqual(out.origins, [{ origin: 'https://app.example.com', localStorage: [{ name: 'auth_token', value: 'tok-123' }] }])
    assert.equal(methods.includes('Browser.close'), false, 'must never close the user browser')
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})

test('harvestLiveChromium reports devtools-stale when DevToolsActivePort refuses connections', async () => {
  const root = await tempRoot()
  // Grab an unused ephemeral port by binding and closing immediately.
  const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => probe.once('listening', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  try {
    const source = { engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default' }
    await assert.rejects(
      () => harvestLiveChromium(source, { activePort: { port, path: '/devtools/browser/x', wsUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }, skipFocus: true, connectTimeoutMs: 2000 }),
      (error) => error.code === 'devtools-stale',
    )
  } finally { await root.remove() }
})

test('importFromBrowser prefers live CDP, uses macOS Keychain on darwin, and guides Windows v20 without closing Chrome', async () => {
  const root = await tempRoot()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({ os_crypt: { app_bound_encrypted_key: 'QVBQQg==' } }))
    await cookieDb(net, [['sid', '.example.com', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)])]])

    const source = {
      id: 'chrome:Default',
      kind: 'chrome',
      name: 'Chrome',
      label: 'Chrome — Default',
      engine: 'chromium',
      userDataDir: root.dir,
      profilePath: join(root.dir, 'Default'),
      profileDir: 'Default',
      cookieDb: join(net, 'Cookies'),
      inspectUrl: 'chrome://inspect/#remote-debugging',
      keychainServices: ['Chrome Safe Storage'],
      exe: null,
    }

    // 1. Live DevToolsActivePort takes priority.
    await writeFile(join(root.dir, 'DevToolsActivePort'), '9222\n/devtools/browser/live\n')
    const live = await importFromBrowser(source, {
      platformOverride: 'win32',
      liveHarvester: async () => ({ cookies: [{ name: 'sid', value: 'ok', domain: '.example.com', path: '/' }], origins: [], skipped: [] }),
    })
    assert.equal(live.method, 'live-cdp')
    assert.equal(live.result.cookies.length, 1)
    await rm(join(root.dir, 'DevToolsActivePort'))

    // 2. macOS uses Keychain path directly without closing or launching the browser.
    const mac = await importFromBrowser(source, {
      platformOverride: 'darwin',
      macHarvester: async () => ({ cookies: [{ name: 'sid', value: 'mac-ok', domain: '.example.com', path: '/' }], origins: [], skipped: [] }),
    })
    assert.equal(mac.method, 'keychain')
    assert.equal(mac.result.cookies[0].value, 'mac-ok')

    // 3. Windows locked + app_bound_encrypted_key returns needsRemoteDebugging without closing browser.
    const winLocked = await importFromBrowser(source, {
      platformOverride: 'win32',
      cloner: async () => { const e = new Error('locked'); e.code = 'locked'; throw e },
    })
    assert.equal(winLocked.needsRemoteDebugging, true)
    assert.equal(winLocked.running, true)
    assert.equal(winLocked.inspectUrl, 'chrome://inspect/#remote-debugging')

    // 4. Windows unlocked all-v20 DB also returns needsRemoteDebugging (running: false).
    const winUnlocked = await importFromBrowser(source, { platformOverride: 'win32' })
    assert.equal(winUnlocked.needsRemoteDebugging, true)
    assert.equal(winUnlocked.running, false)
    assert.equal(winUnlocked.lockedCount, 1)
  } finally { await root.remove() }
})

test('appBoundRows lists v20 rows by name and domain, and counts the rest readable', async () => {
  const root = await tempRoot()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await cookieDb(net, [
      ['sid', '.example.com', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)])],
      ['old', '.example.org', Buffer.concat([Buffer.from('v10'), Buffer.alloc(20)])],
    ])
    const census = appBoundRows(join(net, 'Cookies'))
    assert.equal(census.readable, 1)
    assert.equal(census.locked.length, 1)
    assert.equal(census.locked[0].name, 'sid')
    assert.equal(census.locked[0].domain, '.example.com')
    assert.equal(census.locked[0].code, 'app-bound')
    assert.equal(appBoundRows(join(root.dir, 'nowhere')), null)
  } finally { await root.remove() }
})

test('harvestCookies refuses an all-v20 clone: launching the browser would read nothing', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), '{}')
    await cookieDb(net, [['sid', '.example.com', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)])]])
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(net, 'Cookies') }
    await assert.rejects(() => harvestCookies(source, work.dir), (error) => error.code === 'app-bound')
  } finally { await work.remove(); await root.remove() }
})

test('locksProfile matches a browser process to the user-data root it locks', () => {
  const source = { profilePath: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default' }
  assert.equal(locksProfile({ commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' }, source), true)
  assert.equal(locksProfile({ commandLine: 'chrome.exe --user-data-dir="C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data" --restore' }, source), true)
  assert.equal(locksProfile({ commandLine: 'chrome.exe --user-data-dir=D:\\other\\dir' }, source), false)
})

test('kindOfExe identifies browsers across Linux, macOS, and Windows paths including Zen, Firefox, and Arc', () => {
  assert.equal(kindOfExe('/usr/bin/zen-browser'), 'zen')
  assert.equal(kindOfExe('/opt/zen-browser/zen'), 'zen')
  assert.equal(kindOfExe('/usr/bin/firefox'), 'firefox')
  assert.equal(kindOfExe('/Applications/Firefox.app/Contents/MacOS/firefox'), 'firefox')
  assert.equal(kindOfExe('/Applications/Zen.app/Contents/MacOS/zen'), 'zen')
  assert.equal(kindOfExe('/Applications/Arc.app/Contents/MacOS/Arc'), 'arc')
  assert.equal(kindOfExe('C:\\Users\\Public\\AppData\\Local\\Microsoft\\WindowsApps\\Arc.exe'), 'arc')
  assert.equal(kindOfExe('/usr/bin/microsoft-edge-beta'), 'edge-beta')
  assert.equal(kindOfExe('/usr/bin/google-chrome'), 'chrome')
})

test('harvestLiveChromium isolates localStorage to defaultBrowserContextId and retries suspended tabs of the same origin', async () => {
  const root = await tempRoot()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  wss.on('connection', (ws) => {
    const sessions = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Storage.getCookies') {
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: [] } }))
      } else if (msg.method === 'Target.getBrowserContexts') {
        ws.send(JSON.stringify({ id: msg.id, result: { browserContextIds: [], defaultBrowserContextId: 'ctx-active' } }))
      } else if (msg.method === 'Target.getTargets') {
        ws.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfos: [
              // Other profile's tab must be ignored even though it appears first.
              { targetId: 't-other', type: 'page', url: 'https://other-profile.example/home', browserContextId: 'ctx-other' },
              // Active profile: first tab is suspended/fails, second tab of same origin succeeds.
              { targetId: 't-suspended', type: 'page', url: 'https://app.example.com/old', browserContextId: 'ctx-active' },
              { targetId: 't-active', type: 'page', url: 'https://app.example.com/home', browserContextId: 'ctx-active' },
            ],
          },
        }))
      } else if (msg.method === 'Target.attachToTarget') {
        const sid = `sid-${msg.params.targetId}`
        sessions.set(sid, msg.params.targetId)
        ws.send(JSON.stringify({ id: msg.id, result: { sessionId: sid } }))
      } else if (msg.method === 'Runtime.evaluate') {
        const targetId = sessions.get(msg.sessionId)
        if (targetId === 't-suspended') {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Target is frozen' } }))
        } else if (targetId === 't-active') {
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify([{ name: 'tok', value: 'active-profile-tok' }]) } } }))
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify([{ name: 'leak', value: 'wrong-profile' }]) } } }))
        }
      } else if (msg.method === 'Target.detachFromTarget') {
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
      }
    })
  })
  try {
    const activePort = { port, wsPath: '/devtools/browser/test', wsUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }
    const source = { engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default' }
    const out = await harvestLiveChromium(source, { activePort, skipFocus: true })
    assert.deepEqual(out.origins, [
      { origin: 'https://app.example.com', localStorage: [{ name: 'tok', value: 'active-profile-tok' }] },
    ])
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})

test('harvestLiveChromium fails closed when a different profile is active and cannot be switched', async () => {
  const root = await tempRoot()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 1', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Profile 1', 'Network', 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } },
      os_crypt: { app_bound_encrypted_key: 'QVBQQg==' },
    }))
    await writeFile(join(root.dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/live\n`)

    const sourceNoExe = {
      engine: 'chromium', name: 'Arc', profileName: 'Personal',
      userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default',
      cookieDb: join(root.dir, 'Default', 'Network', 'Cookies'),
      keychainServices: ['Arc Safe Storage'],
      exe: null,
    }
    await assert.rejects(
      () => harvestLiveChromium(sourceNoExe),
      (error) => error.code === 'devtools-wrong-profile',
    )

    // On Windows ABE, importFromBrowser surfaces devtools-wrong-profile instead of reading the wrong profile.
    await assert.rejects(
      () => importFromBrowser(sourceNoExe, { platformOverride: 'win32' }),
      (error) => error.code === 'devtools-wrong-profile',
    )

    // On macOS, importFromBrowser falls back to profile-isolated Keychain decryption instead of failing.
    const macFallback = await importFromBrowser(sourceNoExe, {
      platformOverride: 'darwin',
      macHarvester: async () => ({ cookies: [{ name: 'personal_sid', value: 'ok', domain: '.example.com', path: '/' }], origins: [], skipped: [] }),
    })
    assert.equal(macFallback.method, 'keychain')
    assert.equal(macFallback.result.cookies[0].name, 'personal_sid')
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})

test('stale DevToolsActivePort fails fast with devtools-stale without ever spawning the browser exe', async () => {
  const root = await tempRoot()
  const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => probe.once('listening', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 1', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Profile 1', 'Network', 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } },
    }))
    await writeFile(join(root.dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/stale\n`)

    let spawnCalls = 0
    const spawnImpl = () => {
      spawnCalls += 1
      const c = new EventEmitter()
      c.unref = () => {}
      return c
    }
    const source = {
      engine: 'chromium', name: 'Chrome', profileName: 'Personal',
      userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default',
      cookieDb: join(root.dir, 'Default', 'Network', 'Cookies'),
      exe: '/fake/chrome',
    }
    await assert.rejects(
      () => harvestLiveChromium(source, { spawnImpl }),
      (error) => error.code === 'devtools-stale',
    )
    assert.equal(spawnCalls, 0, 'stale DevToolsActivePort must never spawn browser binary')
  } finally { await root.remove() }
})

test('ensureLiveProfileActive always spawns handoff when exe is present, fails closed on timeout/unconfirmed state, and rejects sibling cookies even with shared cookie names', async () => {
  const root = await tempRoot()
  let cdpCookies = [
    { name: 'NID', value: 'shared-name-sibling-exp', domain: '.google.com', path: '/', secure: true, httpOnly: true, session: false, expires: 1900000200 },
    { name: 'work_only', value: 'w', domain: '.work.example', path: '/', secure: true, httpOnly: true, session: true },
  ]
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Storage.getCookies') {
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: cdpCookies } }))
      }
    })
  })
  const writeRichCookieDb = (dir, rows) => {
    const db = new DatabaseSync(join(dir, 'Cookies'))
    db.exec('CREATE TABLE cookies (name TEXT, host_key TEXT, path TEXT, encrypted_value BLOB, expires_utc INTEGER, has_expires INTEGER)')
    const ins = db.prepare('INSERT INTO cookies (name, host_key, path, encrypted_value, expires_utc, has_expires) VALUES (?, ?, ?, ?, ?, ?)')
    for (const [name, host, expSec] of rows) {
      ins.run(name, host, '/', Buffer.from('v10abc'), expSec ? (expSec + 11644473600) * 1e6 : 0, expSec ? 1 : 0)
    }
    db.close()
  }
  try {
    const defNet = join(root.dir, 'Default', 'Network')
    const p1Net = join(root.dir, 'Profile 1', 'Network')
    await mkdir(defNet, { recursive: true })
    await mkdir(p1Net, { recursive: true })
    // Both profiles share (.google.com, NID) with different expiry timestamps.
    writeRichCookieDb(defNet, [
      ['NID', '.google.com', 1900000100],
      ['personal_only', '.personal.example', 1900000150],
    ])
    writeRichCookieDb(p1Net, [
      ['NID', '.google.com', 1900000200],
      ['work_only', '.work.example', 1900000250],
    ])
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } },
    }))
    await writeFile(join(root.dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/live\n`)

    const source = {
      engine: 'chromium', name: 'Chrome', profileName: 'Personal',
      userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default',
      cookieDb: join(defNet, 'Cookies'),
      exe: '/fake/chrome',
    }
    const okSpawn = () => {
      const c = new EventEmitter()
      c.unref = () => {}
      setTimeout(() => c.emit('exit', 0), 5)
      return c
    }

    // 1. Handoff child hangs past focusTimeoutMs -> must reject devtools-wrong-profile (never treat timeout as success).
    await assert.rejects(
      () => harvestLiveChromium(source, {
        focusTimeoutMs: 50,
        spawnImpl: () => { const c = new EventEmitter(); c.unref = () => {}; return c },
      }),
      (error) => error.code === 'devtools-wrong-profile',
    )

    // 2. Handoff exits 0, but Local State never updates to Default -> must reject devtools-wrong-profile.
    await assert.rejects(
      () => harvestLiveChromium(source, {
        focusTimeoutMs: 200,
        focusVerifyMs: 80,
        focusPollMs: 20,
        spawnImpl: okSpawn,
      }),
      (error) => error.code === 'devtools-wrong-profile',
    )

    // 3. Local State.last_used is stale ('Default'), source.exe is present:
    //    must STILL invoke spawnImpl, and even with shared (.google.com, NID) + sibling work_only, must reject!
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Default', info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } },
    }))
    let spawnCount = 0
    await assert.rejects(
      () => harvestLiveChromium(source, {
        spawnImpl: () => { spawnCount += 1; return okSpawn() },
      }),
      (error) => error.code === 'devtools-wrong-profile',
    )
    assert.equal(spawnCount, 1, 'must always run focus handoff when exe is present even if disk Local State matches')

    // 4. Even when CDP returns ONLY the shared cookie name (.google.com, NID) with sibling's expiry fingerprint, reject!
    cdpCookies = [
      { name: 'NID', value: 'shared-name-sibling-exp', domain: '.google.com', path: '/', secure: true, httpOnly: true, session: false, expires: 1900000200 },
    ]
    await assert.rejects(
      () => harvestLiveChromium(source, { spawnImpl: okSpawn }),
      (error) => error.code === 'devtools-wrong-profile',
    )

    // 5. When CDP returns target profile's own cookies (shared name with target expiry + personal_only), accept!
    cdpCookies = [
      { name: 'NID', value: 'target-val', domain: '.google.com', path: '/', secure: true, httpOnly: true, session: false, expires: 1900000100 },
      { name: 'personal_only', value: 'p', domain: '.personal.example', path: '/', secure: true, httpOnly: true, session: false, expires: 1900000150 },
    ]
    const ok = await harvestLiveChromium(source, { spawnImpl: okSpawn, includeLocalStorage: false, now: 1700000000 })
    assert.deepEqual(ok.cookies.map((c) => c.name), ['NID', 'personal_only'])
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})

test('Windows cancellation after taskkill still relaunches the closed browser and cleans up workDir', async () => {
  const root = await tempRoot()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(net, 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), '{}')

    const source = {
      engine: 'chromium', kind: 'chrome', name: 'Chrome', label: 'Chrome — Default',
      userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default',
      cookieDb: join(net, 'Cookies'), exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    }
    const ctrl = new AbortController()
    const killedPids = []
    const relaunched = []
    let pollStep = 0

    await assert.rejects(
      () => importFromBrowser(source, {
        close: true,
        platformOverride: 'win32',
        signal: ctrl.signal,
        cloner: async () => { const e = new Error('locked'); e.code = 'locked'; throw e },
        browserCloser: (exe, src, opts) => closeBrowser(exe, src, {
          ...opts,
          platformOverride: 'win32',
          pollMs: 10,
          listProcesses: async () => {
            pollStep += 1
            // Still alive on initial discovery and first exit poll, gone on second exit poll.
            return pollStep <= 2 ? [{ pid: 4242, commandLine: `"${exe}"` }] : []
          },
          killPid: async (pid) => {
            killedPids.push(pid)
            // User clicks Cancel right after taskkill is issued.
            ctrl.abort()
          },
        }),
        browserRelauncher: (exe, kind) => { relaunched.push({ exe, kind }) },
      }),
      (error) => error.code === 'import-cancelled',
    )

    assert.deepEqual(killedPids, [4242])
    assert.deepEqual(relaunched, [{ exe: source.exe, kind: 'chrome' }], 'browser closed via taskkill must be relaunched even when cancelled mid-close')
  } finally { await root.remove() }
})

test('checkSourceLiveDebug probes only the target source DevToolsActivePort liveness', async () => {
  const root = await tempRoot()
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const source = { engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default' }
    assert.equal(await checkSourceLiveDebug(source), false)

    await writeFile(join(root.dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`)
    assert.equal(await checkSourceLiveDebug(source), true)
    assert.equal(await isLoopbackPortOpen(port), true)

    await new Promise((resolve) => server.close(resolve))
    assert.equal(await checkSourceLiveDebug(source), false)
    assert.equal(await checkSourceLiveDebug({ engine: 'firefox', profilePath: root.dir }), false)
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await root.remove()
  }
})

test('readChromiumSqliteCookies skips unknown encrypted_value prefixes and reads Chrome 125+ has_cross_site_ancestor', async () => {
  const root = await tempRoot()
  try {
    const key = deriveMacChromiumKey('test-pass')
    const dbPath = join(root.dir, 'Cookies')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT, has_cross_site_ancestor INTEGER
      );
    `)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '24')
    const futureWebkit = (1900000000 + 11644473600) * 1e6
    const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run('.example.com', 'same_site_part', '', encryptMacV10('ok-val', key, { hostKey: '.example.com', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, 'https://example.com', 0)
    ins.run('.example.com', 'cross_site_part', '', encryptMacV10('ok-val-2', key, { hostKey: '.example.com', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, 'https://other.example', 1)
    ins.run('.example.com', 'linux_v11', '', Buffer.concat([Buffer.from('v11'), Buffer.alloc(16, 1)]), '/', 1, 1, futureWebkit, 1, 1, '', 0)
    ins.run('.example.com', 'short_blob', '', Buffer.from([0x01, 0x02]), '/', 1, 1, futureWebkit, 1, 1, '', 0)
    db.close()

    const { cookies, skipped } = readChromiumSqliteCookies(dbPath, { key, now: 1700000000 })
    assert.deepEqual(cookies.map((c) => c.name), ['same_site_part', 'cross_site_part'])
    assert.deepEqual(cookies[0].partitionKey, { topLevelSite: 'https://example.com', hasCrossSiteAncestor: false })
    assert.deepEqual(cookies[1].partitionKey, { topLevelSite: 'https://other.example', hasCrossSiteAncestor: true })
    assert.deepEqual(skipped.map((s) => [s.name, s.code]), [
      ['linux_v11', 'unsupported-encryption'],
      ['short_blob', 'unsupported-encryption'],
    ])
  } finally { await root.remove() }
})

test('harvestMacChromium returns null when wrong Keychain password fails all encrypted rows, falling back to clone+CDP', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), '{}')
    const rightKey = deriveMacChromiumKey('right-keychain-pass')
    const dbPath = join(net, 'Cookies')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    const futureWebkit = (1900000000 + 11644473600) * 1e6
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.example.com', 'sid', '', encryptMacV10('secret-cookie', rightKey), '/', 1, 1, futureWebkit, 1, 1, '')
    db.close()

    const source = {
      id: 'chrome:Default', kind: 'chrome', name: 'Chrome', label: 'Chrome — Default',
      engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'),
      profileDir: 'Default', cookieDb: dbPath, keychainServices: ['Chrome Safe Storage'], exe: '/fake/chrome',
    }
    await cloneCookieStore(source, work.dir, { needLocalState: false })

    // Wrong password -> 0 decrypted rows -> must return null instead of empty success.
    const wrongResult = await harvestMacChromium(source, work.dir, { readPassword: async () => 'wrong-pass', now: 1700000000 })
    assert.equal(wrongResult, null)

    // importFromBrowser falls back to clone+CDP when macHarvester returns null.
    const fallback = await importFromBrowser(source, {
      platformOverride: 'darwin',
      macHarvester: (src, dir) => harvestMacChromium(src, dir, { readPassword: async () => 'wrong-pass', now: 1700000000 }),
      cloneHarvester: async () => ({ cookies: [{ name: 'sid', value: 'cloned-ok', domain: '.example.com', path: '/' }], origins: [], skipped: [] }),
    })
    assert.equal(fallback.method, 'clone-cdp')
    assert.equal(fallback.result.cookies[0].value, 'cloned-ok')
  } finally {
    await work.remove()
    await root.remove()
  }
})

test('importFromBrowser propagates AbortSignal cancellation to pending live CDP / keychain and cleans up workDir', async () => {
  const root = await tempRoot()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  // Accept connection and intentionally never reply to Storage.getCookies so AbortSignal must interrupt it.
  wss.on('connection', () => {})
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(net, 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), '{}')
    await writeFile(join(root.dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/hang\n`)

    const source = {
      engine: 'chromium', name: 'Chrome', userDataDir: root.dir,
      profilePath: join(root.dir, 'Default'), profileDir: 'Default',
      cookieDb: join(net, 'Cookies'), keychainServices: ['Chrome Safe Storage'], exe: null,
    }
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 40)
    await assert.rejects(
      () => importFromBrowser(source, { platformOverride: 'win32', signal: ctrl.signal }),
      (error) => error.code === 'import-cancelled',
    )

    // Also verify cancellation during macOS Keychain harvest cleans up temp workDir.
    await rm(join(root.dir, 'DevToolsActivePort'))
    let seenWorkDir = null
    const ctrl2 = new AbortController()
    await assert.rejects(
      () => importFromBrowser(source, {
        platformOverride: 'darwin',
        signal: ctrl2.signal,
        macHarvester: async (_src, dir, { signal }) => {
          seenWorkDir = dir
          assert.equal(existsSync(dir), true)
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const e = new Error('cancelled')
              e.code = 'import-cancelled'
              reject(e)
            }, { once: true })
            setTimeout(() => ctrl2.abort(), 30)
          })
        },
      }),
      (error) => error.code === 'import-cancelled',
    )
    assert.ok(seenWorkDir)
    assert.equal(existsSync(seenWorkDir), false, 'temporary workDir must be deleted after cancellation')
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})

test('readFirefoxSqliteCookies adapts to schema 14, 15 (no rawSameSite), 16+ (ms expiry), fixes SameSite enum, and skips container/partitioned rows', async () => {
  const root = await tempRoot()
  try {
    // Schema 14: seconds expiry, has rawSameSite, nsICookie 0=None, 1=Lax, 2=Strict, 3=Unset
    const db14Path = join(root.dir, 'ff14.sqlite')
    const db14 = new DatabaseSync(db14Path)
    db14.exec(`
      PRAGMA user_version = 14;
      CREATE TABLE moz_cookies (
        host TEXT, name TEXT, value TEXT, path TEXT,
        isHttpOnly INTEGER, isSecure INTEGER, expiry INTEGER,
        sameSite INTEGER, rawSameSite INTEGER, originAttributes TEXT
      );
    `)
    const ins14 = db14.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ins14.run('.example.com', 'ss_none_sec', 'v0', '/', 1, 1, 1900000000, 0, 0, '')
    ins14.run('.example.com', 'ss_none_insec', 'v0i', '/', 0, 0, 1900000000, 0, 0, '')
    ins14.run('.example.com', 'ss_lax', 'v1', '/', 0, 1, 1900000000, 1, 1, '')
    ins14.run('.example.com', 'ss_strict', 'v2', '/', 1, 1, 1900000000, 2, 2, '')
    ins14.run('.example.com', 'ss_unset', 'v3', '/', 0, 1, 1900000000, 3, 0, '')
    ins14.run('.example.com', 'ss_lax_default_unset', 'v4', '/', 0, 1, 1900000000, 1, 0, '')
    ins14.run('.example.com', 'expired_old', 'old', '/', 0, 1, 1500000000, 1, 1, '')
    ins14.run('.example.com', 'container_tok', 'c', '/', 1, 1, 1900000000, 1, 1, '^userContextId=2')
    ins14.run('.example.com', 'container_and_part', 'cp', '/', 1, 1, 1900000000, 0, 0, '^userContextId=2&partitionKey=%28https%2Ctop.example%29')
    ins14.run('.example.com', 'dfpi_tok', 'p', '/', 1, 1, 1900000000, 0, 0, '^partitionKey=%28https%2Ctop.example%29')
    ins14.run('.example.com', 'dfpi_multi_attr', 'p2', '/', 1, 1, 1900000000, 0, 0, '^firstPartyDomain=a.example&partitionKey=%28https%2Ctop.example%29')
    db14.close()

    const r14 = readFirefoxSqliteCookies(db14Path, { now: 1700000000 })
    assert.deepEqual(r14.cookies.map((c) => [c.name, c.sameSite, c.expires]), [
      ['ss_none_sec', 'None', 1900000000],
      ['ss_none_insec', undefined, 1900000000],
      ['ss_lax', 'Lax', 1900000000],
      ['ss_strict', 'Strict', 1900000000],
      ['ss_unset', undefined, 1900000000],
      ['ss_lax_default_unset', undefined, 1900000000],
    ])
    assert.deepEqual(r14.skipped.map((s) => [s.name, s.code]), [
      ['expired_old', 'expired'],
      ['container_tok', 'container'],
      ['container_and_part', 'container'],
      ['dfpi_tok', 'partitioned'],
      ['dfpi_multi_attr', 'partitioned'],
    ])

    // Schema 15: rawSameSite column removed
    const db15Path = join(root.dir, 'ff15.sqlite')
    const db15 = new DatabaseSync(db15Path)
    db15.exec(`
      PRAGMA user_version = 15;
      CREATE TABLE moz_cookies (
        host TEXT, name TEXT, value TEXT, path TEXT,
        isHttpOnly INTEGER, isSecure INTEGER, expiry INTEGER,
        sameSite INTEGER, originAttributes TEXT
      );
    `)
    db15.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.ff15.example', 'auth', 'ok15', '/', 1, 1, 1900000000, 2, '')
    db15.close()
    const r15 = readFirefoxSqliteCookies(db15Path, { now: 1700000000 })
    assert.equal(r15.cookies.length, 1)
    assert.equal(r15.cookies[0].sameSite, 'Strict')
    assert.equal(r15.cookies[0].expires, 1900000000)

    // Schema 16+: expiry stored in milliseconds instead of seconds
    const db16Path = join(root.dir, 'ff16.sqlite')
    const db16 = new DatabaseSync(db16Path)
    db16.exec(`
      PRAGMA user_version = 16;
      CREATE TABLE moz_cookies (
        host TEXT, name TEXT, value TEXT, path TEXT,
        isHttpOnly INTEGER, isSecure INTEGER, expiry INTEGER,
        sameSite INTEGER, originAttributes TEXT
      );
    `)
    const ins16 = db16.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ins16.run('.ff16.example', 'live_ms', 'ok16', '/', 1, 1, 1900000000_000, 0, '')
    ins16.run('.ff16.example', 'past_ms', 'old16', '/', 1, 1, 1600000000_000, 1, '')
    ins16.run('.ff16.example', 'sess_zero', 's16', '/', 0, 1, 0, 3, '')
    db16.close()

    const r16 = readFirefoxSqliteCookies(db16Path, { now: 1700000000 })
    assert.deepEqual(r16.cookies.map((c) => [c.name, c.expires, c.sameSite]), [
      ['live_ms', 1900000000, 'None'],
      ['sess_zero', undefined, undefined],
    ])
    assert.deepEqual(r16.skipped.map((s) => [s.name, s.code]), [['past_ms', 'expired']])

    // Empty SQLite database with no moz_cookies table returns empty cleanly
    const emptyDbPath = join(root.dir, 'empty.sqlite')
    const emptyDb = new DatabaseSync(emptyDbPath)
    emptyDb.close()
    assert.deepEqual(readFirefoxSqliteCookies(emptyDbPath), { cookies: [], origins: [], skipped: [] })
    assert.equal(countSqliteCookies(emptyDbPath, 'moz_cookies'), 0)
    assert.equal(countSqliteCookies(db16Path, 'moz_cookies'), 3)
  } finally { await root.remove() }
})

test('userDataRoots includes Linux Snap and Flatpak paths for Firefox and Zen', async () => {
  const roots = await userDataRoots({ platformOverride: 'linux', homeOverride: '/home/user', envOverride: {} })
  assert.ok(roots.firefox.includes('/home/user/.mozilla/firefox'))
  assert.ok(roots.firefox.includes('/home/user/snap/firefox/common/.mozilla/firefox'))
  assert.ok(roots.firefox.includes('/home/user/.var/app/org.mozilla.firefox/.mozilla/firefox'))
  assert.ok(roots.zen.includes('/home/user/.zen'))
  assert.ok(roots.zen.includes('/home/user/.var/app/app.zen_browser.zen/.zen'))

  const winRoots = await userDataRoots({ platformOverride: 'win32', homeOverride: 'C:\\Users\\Public', envOverride: {} })
  assert.ok(winRoots.firefox.includes('C:\\Users\\Public\\AppData\\Roaming\\Mozilla\\Firefox'))
})

test('snapshotSqliteDatabase and cloneCookieStore use atomic VACUUM INTO to capture live WAL frames and preserve user_version', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  let writer
  try {
    const profileDir = join(root.dir, 'Profiles', 'live.default')
    await mkdir(profileDir, { recursive: true })
    const dbPath = join(profileDir, 'cookies.sqlite')
    writer = new DatabaseSync(dbPath)
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 16;
      CREATE TABLE moz_cookies (
        host TEXT, name TEXT, value TEXT, path TEXT,
        isHttpOnly INTEGER, isSecure INTEGER, expiry INTEGER,
        sameSite INTEGER, originAttributes TEXT
      );
      INSERT INTO moz_cookies VALUES ('.wal.example', 'from_wal', 'live-val', '/', 1, 1, 1900000000000, 1, '');
    `)
    assert.equal(existsSync(`${dbPath}-wal`), true)

    // Snapshot while writer still holds the WAL open.
    const copied = await cloneCookieStore({ engine: 'firefox', profilePath: profileDir }, work.dir)
    assert.deepEqual(copied, [dbPath])
    assert.equal(existsSync(join(work.dir, 'cookies.sqlite')), true)
    assert.equal(existsSync(join(work.dir, 'cookies.sqlite-wal')), false, 'VACUUM INTO produces a standalone single file without WAL sidecars')

    const parsed = readFirefoxSqliteCookies(join(work.dir, 'cookies.sqlite'), { now: 1700000000 })
    assert.equal(parsed.cookies.length, 1)
    assert.equal(parsed.cookies[0].name, 'from_wal')
    assert.equal(parsed.cookies[0].value, 'live-val')
    assert.equal(parsed.cookies[0].expires, 1900000000)

    // Re-running snapshotSqliteDatabase into an existing destination cleanly overwrites it.
    assert.equal(await snapshotSqliteDatabase(dbPath, join(work.dir, 'cookies.sqlite')), true)
  } finally {
    try { writer?.close() } catch { /* ignore */ }
    await work.remove()
    await root.remove()
  }
})

test('empty Chromium DB returns empty results cleanly in readChromiumSqliteCookies, appBoundRows, and countSqliteCookies', async () => {
  const root = await tempRoot()
  try {
    const dbPath = join(root.dir, 'EmptyCookies')
    const db = new DatabaseSync(dbPath)
    db.close()
    assert.deepEqual(readChromiumSqliteCookies(dbPath, { key: deriveMacChromiumKey('x') }), { cookies: [], origins: [], skipped: [] })
    assert.deepEqual(appBoundRows(dbPath), { locked: [], readable: 0 })
    assert.equal(countSqliteCookies(dbPath, 'cookies'), 0)
  } finally { await root.remove() }
})

test('harvestLinuxChromiumV10 decrypts peanuts/empty v10 cookies directly and falls back to clone-cdp when v11 exists with exe', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), '{}')
    const dbPath = join(net, 'Cookies')
    const peanutsKey = deriveLinuxChromiumKey('peanuts')
    const emptyKey = deriveLinuxChromiumKey('')
    const futureWebkit = (1900000000 + 11644473600) * 1e6

    // 1. peanuts v10 with Chrome v24 domain hash prefix
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '24')
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.linux.example', 'sid', '', encryptMacV10('peanuts-secret', peanutsKey, { hostKey: '.linux.example', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, '')
    db.close()

    const source = {
      id: 'chromium:Default', kind: 'chromium', name: 'Chromium', label: 'Chromium — Default',
      engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'),
      profileDir: 'Default', cookieDb: dbPath, exe: '/usr/bin/chromium',
    }
    const direct = await importFromBrowser(source, { platformOverride: 'linux' })
    assert.equal(direct.method, 'linux-v10')
    assert.equal(direct.result.cookies.length, 1)
    assert.equal(direct.result.cookies[0].value, 'peanuts-secret')

    // 2. Empty-password v10 cookie
    const db2 = new DatabaseSync(dbPath)
    db2.exec('DELETE FROM cookies')
    db2.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.linux.example', 'sid2', '', encryptMacV10('empty-pass-val', emptyKey, { hostKey: '.linux.example', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, '')
    db2.close()
    await cloneCookieStore(source, work.dir, { needLocalState: false })
    const emptyOut = await harvestLinuxChromiumV10(source, work.dir, { now: 1700000000 })
    assert.equal(emptyOut.cookies[0].value, 'empty-pass-val')

    // 3. Store with v11 + source.exe present -> harvestLinuxChromiumV10 returns null so importFromBrowser falls back to clone-cdp
    const db3 = new DatabaseSync(dbPath)
    db3.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.linux.example', 'keyring_tok', '', Buffer.concat([Buffer.from('v11'), Buffer.alloc(16, 7)]), '/', 1, 1, futureWebkit, 1, 1, '')
    db3.close()
    await cloneCookieStore(source, work.dir, { needLocalState: false })
    assert.equal(await harvestLinuxChromiumV10(source, work.dir, { now: 1700000000 }), null)

    const fallback = await importFromBrowser(source, {
      platformOverride: 'linux',
      cloneHarvester: async () => ({ cookies: [{ name: 'keyring_tok', value: 'via-pipe', domain: '.linux.example', path: '/' }], origins: [], skipped: [] }),
    })
    assert.equal(fallback.method, 'clone-cdp')
    assert.equal(fallback.result.cookies[0].value, 'via-pipe')

    // 4. Without exe, v11 rows are reported as skipped while decrypted v10 rows still return
    const noExeOut = await harvestLinuxChromiumV10({ ...source, exe: null }, work.dir, { now: 1700000000 })
    assert.equal(noExeOut.cookies.length, 1)
    assert.equal(noExeOut.skipped[0].code, 'unsupported-encryption')
  } finally {
    await work.remove()
    await root.remove()
  }
})

test('importFromBrowser and probeSource handle Safari binarycookies and Full Disk Access guidance', async () => {
  const source = {
    id: 'safari:Default', kind: 'safari', engine: 'safari', name: 'Safari', label: 'Safari',
    userDataDir: '/nonexistent/safari', profileDir: 'Default', cookieFile: null,
  }
  const ok = await importFromBrowser(source, {
    safariHarvester: async () => ({ cookies: [{ name: 's', value: 'v', domain: '.apple.com', path: '/' }], origins: [], skipped: [] }),
  })
  assert.equal(ok.method, 'safari-binarycookies')
  assert.equal(ok.result.cookies.length, 1)

  const denied = await importFromBrowser(source, {
    safariHarvester: async () => { const e = new Error('denied'); e.code = 'safari-permission'; throw e },
  })
  assert.equal(denied.needsFullDiskAccess, true)
  assert.equal(denied.browserName, 'Safari')

  const probed = await probeSource(source)
  assert.equal(probed.liveDebugReady, false)
  assert.equal(probed.permissionGranted, false)
})

test('snapshotSqliteDatabase throws locked on exclusive SQLite lock and cloneCookieStore clears stale WAL sidecars on non-SQLite fallback', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  let locker
  try {
    const profileDir = join(root.dir, 'Profiles', 'locked.default')
    await mkdir(profileDir, { recursive: true })
    const dbPath = join(profileDir, 'cookies.sqlite')
    locker = new DatabaseSync(dbPath)
    locker.exec("CREATE TABLE moz_cookies (host TEXT); INSERT INTO moz_cookies VALUES ('.a.example');")
    locker.exec("BEGIN EXCLUSIVE; INSERT INTO moz_cookies VALUES ('.b.example');")

    await assert.rejects(
      () => snapshotSqliteDatabase(dbPath, join(work.dir, 'cookies.sqlite'), { busyTimeoutMs: 40 }),
      (err) => err.code === 'locked',
    )
    await assert.rejects(
      () => cloneCookieStore({ engine: 'firefox', profilePath: profileDir }, work.dir, { busyTimeoutMs: 40 }),
      (err) => err.code === 'locked',
    )
    locker.exec('COMMIT')
    locker.close()
    locker = null

    // Non-SQLite fallback retry must clear a previously copied -wal when the source -wal is gone.
    const rawProfile = join(root.dir, 'Profiles', 'raw.default')
    await mkdir(rawProfile, { recursive: true })
    await writeFile(join(rawProfile, 'cookies.sqlite'), 'not-sqlite')
    await writeFile(join(rawProfile, 'cookies.sqlite-wal'), 'old-wal')
    await cloneCookieStore({ engine: 'firefox', profilePath: rawProfile }, work.dir)
    assert.equal(existsSync(join(work.dir, 'cookies.sqlite-wal')), true)

    await rm(join(rawProfile, 'cookies.sqlite-wal'))
    await cloneCookieStore({ engine: 'firefox', profilePath: rawProfile }, work.dir)
    assert.equal(existsSync(join(work.dir, 'cookies.sqlite-wal')), false, 'stale destination -wal must be removed on retry')
  } finally {
    try { locker?.close() } catch { /* ignore */ }
    await work.remove()
    await root.remove()
  }
})

test('decryptChromiumV10 enforces v24 domain hash and harvestLinuxChromiumV10 decrypts mixed peanuts and empty-password rows', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const peanutsKey = deriveLinuxChromiumKey('peanuts')
    const emptyKey = deriveLinuxChromiumKey('')

    // Mismatched domain hash in v24 mode must fail closed (return null), never return raw garbage.
    const wrongHostBlob = encryptMacV10('val', peanutsKey, { hostKey: '.other.example', withDomainHash: true })
    assert.equal(decryptChromiumV10(wrongHostBlob, peanutsKey, { hostKey: '.target.example', stripDomainHash: true }), null)
    const noHashBlob = encryptMacV10('short', peanutsKey, { withDomainHash: false })
    assert.equal(decryptChromiumV10(noHashBlob, peanutsKey, { hostKey: '.target.example', stripDomainHash: true }), null)

    // Leading UTF-8 BOM (U+FEFF) in cookie values must be preserved verbatim (pre-v24 and v24+).
    const bomPre24 = encryptMacV10('\uFEFFbom-val', peanutsKey, { withDomainHash: false })
    assert.equal(decryptChromiumV10(bomPre24, peanutsKey, { hostKey: '.bom.example', stripDomainHash: false }), '\uFEFFbom-val')
    const bomV24 = encryptMacV10('\uFEFFbom-v24', peanutsKey, { hostKey: '.bom.example', withDomainHash: true })
    assert.equal(decryptChromiumV10(bomV24, peanutsKey, { hostKey: '.bom.example', stripDomainHash: true }), '\uFEFFbom-v24')

    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), '{}')
    const dbPath = join(net, 'Cookies')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '24')
    const futureWebkit = (1900000000 + 11644473600) * 1e6
    const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run('.mixed.example', 'k_peanuts', '', encryptMacV10('v-peanuts', peanutsKey, { hostKey: '.mixed.example', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, '')
    ins.run('.mixed.example', 'k_empty', '', encryptMacV10('v-empty', emptyKey, { hostKey: '.mixed.example', withDomainHash: true }), '/', 1, 1, futureWebkit, 1, 1, '')
    db.close()

    const source = {
      id: 'chromium:Default', kind: 'chromium', name: 'Chromium', label: 'Chromium — Default',
      engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'),
      profileDir: 'Default', cookieDb: dbPath, exe: '/usr/bin/chromium',
    }
    await cloneCookieStore(source, work.dir, { needLocalState: false })
    const mixed = await harvestLinuxChromiumV10(source, work.dir, { now: 1700000000 })
    assert.deepEqual(mixed.cookies.map((c) => [c.name, c.value]), [
      ['k_peanuts', 'v-peanuts'],
      ['k_empty', 'v-empty'],
    ])

    // Pre-v24 empty-password Linux DB across 512 rows must never suffer 1/256 wrong-key PKCS#7 collisions.
    const pre24Path = join(root.dir, 'Pre24Cookies')
    const pre24Db = new DatabaseSync(pre24Path)
    pre24Db.exec(`
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    const insPre = pre24Db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const expectedValues = []
    for (let i = 0; i < 512; i += 1) {
      const val = `tok-${i}-empty-pass-value`
      expectedValues.push([`c_${i}`, val])
      insPre.run('.pre24.example', `c_${i}`, '', encryptMacV10(val, emptyKey, { withDomainHash: false }), '/', 1, 1, futureWebkit, 1, 1, '')
    }
    pre24Db.close()
    const pre24Source = { ...source, cookieDb: pre24Path }
    const pre24Res = await importFromBrowser(pre24Source, { platformOverride: 'linux' })
    assert.equal(pre24Res.method, 'linux-v10')
    assert.deepEqual(pre24Res.result.cookies.map((c) => [c.name, c.value]), expectedValues)

    // Pre-v24 mixed-key Linux DB delegates to clone-cdp when source.exe is present (no guessing without MAC),
    // and decrypts unambiguous rows when source.exe is unavailable.
    const pre24MixedPath = join(root.dir, 'Pre24MixedCookies')
    const pre24MixedDb = new DatabaseSync(pre24MixedPath)
    pre24MixedDb.exec(`
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    const insPreMixed = pre24MixedDb.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insPreMixed.run('.pre24mix.example', 'p1', '', encryptMacV10('peanuts-only-value-1', peanutsKey, { withDomainHash: false }), '/', 1, 1, futureWebkit, 1, 1, '')
    insPreMixed.run('.pre24mix.example', 'e1', '', encryptMacV10('empty-only-value-1', emptyKey, { withDomainHash: false }), '/', 1, 1, futureWebkit, 1, 1, '')
    pre24MixedDb.close()
    const pre24MixedSource = { ...source, cookieDb: pre24MixedPath }
    await cloneCookieStore(pre24MixedSource, work.dir, { needLocalState: false })
    assert.equal(await harvestLinuxChromiumV10(pre24MixedSource, work.dir, { now: 1700000000 }), null)
    const pre24MixedNoExe = await harvestLinuxChromiumV10({ ...pre24MixedSource, exe: null }, work.dir, { now: 1700000000 })
    assert.deepEqual(pre24MixedNoExe.cookies.map((c) => [c.name, c.value]), [
      ['p1', 'peanuts-only-value-1'],
      ['e1', 'empty-only-value-1'],
    ])

    // Pre-v24 wrong-key collision containing ';' is rejected by Chromium's IsValidCookieValue rule,
    // letting the valid empty-password decryption succeed cleanly without ambiguity.
    const semiBlob = Buffer.from('763130fa1f59d6cc4d6f882a6f3566b821a58f', 'hex')
    assert.equal(decryptChromiumV10(semiBlob, emptyKey, { stripDomainHash: false }), 'atjbBkaA')
    assert.equal(decryptChromiumV10(semiBlob, peanutsKey, { stripDomainHash: false }), null)

    // Pre-v24 HTAB (0x09) is also rejected to match Chromium 131 HttpUtil::IsControlChar (0x00–0x1F, 0x7F).
    const htabBlob = encryptMacV10('a\tb', peanutsKey, { withDomainHash: false })
    assert.equal(decryptChromiumV10(htabBlob, peanutsKey, { stripDomainHash: false }), null)

    // Real semicolon-free dual-decoding pre-v24 v10 ciphertext: decodes to two different Chromium-valid
    // cookie values under empty ("3iB3EkaA") and peanuts keys.
    const ambiguousBlob = Buffer.from('763130847a12a038abdaa8b85f31087ad058c4', 'hex')
    const ambEmptyVal = decryptChromiumV10(ambiguousBlob, emptyKey, { stripDomainHash: false })
    const ambPeanutsVal = decryptChromiumV10(ambiguousBlob, peanutsKey, { stripDomainHash: false })
    assert.equal(ambEmptyVal, '3iB3EkaA')
    assert.ok(ambPeanutsVal && ambPeanutsVal !== ambEmptyVal && !ambPeanutsVal.includes(';'))

    const pre24AmbPath = join(root.dir, 'Pre24AmbiguousCookies')
    const pre24AmbDb = new DatabaseSync(pre24AmbPath)
    pre24AmbDb.exec(`
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    const insAmb = pre24AmbDb.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insAmb.run('.amb.example', 'ambiguous', '', ambiguousBlob, '/', 1, 1, futureWebkit, 1, 1, '')
    insAmb.run('.amb.example', 'plain_ok', 'plain-val', Buffer.alloc(0), '/', 1, 1, futureWebkit, 1, 1, '')
    pre24AmbDb.close()

    // Without source.exe: an ambiguous encrypted row must NOT abort import or drop readable plaintext rows.
    const ambNoExe = await importFromBrowser({ ...source, cookieDb: pre24AmbPath, exe: null }, { platformOverride: 'linux' })
    assert.equal(ambNoExe.method, 'linux-v10')
    assert.deepEqual(ambNoExe.result.cookies.map((c) => [c.name, c.value]), [['plain_ok', 'plain-val']])
    assert.deepEqual(ambNoExe.result.skipped.map((s) => [s.name, s.code]), [['ambiguous', 'decrypt-failed']])

    // With source.exe + peanuts-only row (no v11/mixed keys): linux-v10 directly skips the ambiguous entry
    // and preserves readable rows without launching Chromium or importing a wrong guessed value.
    const pre24AmbMixedDb = new DatabaseSync(pre24AmbPath)
    pre24AmbMixedDb.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.amb.example', 'peanuts_only', '', encryptMacV10('peanuts-real-val', peanutsKey, { withDomainHash: false }), '/', 1, 1, futureWebkit, 1, 1, '')
    pre24AmbMixedDb.close()

    const ambDirectWithExe = await importFromBrowser({ ...source, cookieDb: pre24AmbPath }, {
      platformOverride: 'linux',
      cloneHarvester: async () => assert.fail('clone-cdp is unnecessary when no v11 or mixed keys exist'),
    })
    assert.equal(ambDirectWithExe.method, 'linux-v10')
    assert.deepEqual(ambDirectWithExe.result.cookies.map((c) => [c.name, c.value]), [
      ['plain_ok', 'plain-val'],
      ['peanuts_only', 'peanuts-real-val'],
    ])
    assert.deepEqual(ambDirectWithExe.result.skipped.map((s) => [s.name, s.code]), [['ambiguous', 'decrypt-failed']])

    // When a v11 row DOES require clone-cdp fallback, importFromBrowser must filter out any matching
    // ambiguous cookie Chromium returns (preventing wrong-key guesses) AND preserve its skipped reason
    // (whether Chromium returned a guessed value or silently dropped it).
    const pre24AmbV11Db = new DatabaseSync(pre24AmbPath)
    pre24AmbV11Db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('.amb.example', 'keyring_v11', '', Buffer.concat([Buffer.from('v11'), Buffer.alloc(16, 9)]), '/', 1, 1, futureWebkit, 1, 1, '')
    pre24AmbV11Db.close()

    const cdpGuessed = await importFromBrowser({ ...source, cookieDb: pre24AmbPath }, {
      platformOverride: 'linux',
      cloneHarvester: async () => ({
        cookies: [
          { name: 'ambiguous', value: ambPeanutsVal, domain: '.amb.example', path: '/', secure: true, httpOnly: true },
          { name: 'plain_ok', value: 'plain-val', domain: '.amb.example', path: '/', secure: true, httpOnly: true },
          { name: 'peanuts_only', value: 'peanuts-real-val', domain: '.amb.example', path: '/', secure: true, httpOnly: true },
          { name: 'keyring_v11', value: 'v11-ok', domain: '.amb.example', path: '/', secure: true, httpOnly: true },
        ],
        origins: [],
        skipped: [],
      }),
    })
    assert.equal(cdpGuessed.method, 'clone-cdp')
    assert.deepEqual(cdpGuessed.result.cookies.map((c) => [c.name, c.value]), [
      ['plain_ok', 'plain-val'],
      ['peanuts_only', 'peanuts-real-val'],
      ['keyring_v11', 'v11-ok'],
    ])
    assert.deepEqual(cdpGuessed.result.skipped.map((s) => [s.name, s.code]), [['ambiguous', 'decrypt-failed']])

    const cdpDropped = await importFromBrowser({ ...source, cookieDb: pre24AmbPath }, {
      platformOverride: 'linux',
      cloneHarvester: async () => ({
        cookies: [
          { name: 'plain_ok', value: 'plain-val', domain: '.amb.example', path: '/', secure: true, httpOnly: true },
          { name: 'keyring_v11', value: 'v11-ok', domain: '.amb.example', path: '/', secure: true, httpOnly: true },
        ],
        origins: [],
        skipped: [],
      }),
    })
    assert.equal(cdpDropped.method, 'clone-cdp')
    assert.deepEqual(cdpDropped.result.cookies.map((c) => [c.name, c.value]), [
      ['plain_ok', 'plain-val'],
      ['keyring_v11', 'v11-ok'],
    ])
    assert.deepEqual(cdpDropped.result.skipped.map((s) => [s.name, s.code]), [['ambiguous', 'decrypt-failed']])

    // Snapshot reuse TOCTOU test: a new ambiguous row written to the live DB after Step 3's snapshot
    // must NOT overwrite workDir's Cookies DB when falling back to Step 4 clone-cdp.
    const racePath = join(net, 'Pre24RaceCookies')
    const raceDb = new DatabaseSync(racePath)
    raceDb.exec(`
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
        has_expires INTEGER, top_frame_site_key TEXT
      );
    `)
    const insRace = raceDb.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insRace.run('.race.example', 'plain_ok', 'plain-val', Buffer.alloc(0), '/', 1, 1, futureWebkit, 1, 1, '')
    insRace.run('.race.example', 'keyring_v11', '', Buffer.concat([Buffer.from('v11'), Buffer.alloc(16, 5)]), '/', 1, 1, futureWebkit, 1, 1, '')
    raceDb.close()

    const clonerCalls = []
    let cdpObservedNames = []
    let cdpSawLocalState = false
    const raceRes = await importFromBrowser({ ...source, cookieDb: racePath }, {
      platformOverride: 'linux',
      cloner: async (src, dir, opts) => {
        clonerCalls.push({ ...(opts ?? {}) })
        const out = await cloneCookieStore(src, dir, opts)
        if (clonerCalls.length === 1) {
          // Mutate live DB AFTER Step 3's snapshot and BEFORE Step 4's fallback runs.
          const liveMut = new DatabaseSync(racePath)
          liveMut.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('.race.example', 'late_ambiguous', '', ambiguousBlob, '/', 1, 1, futureWebkit, 1, 1, '')
          liveMut.close()
        }
        return out
      },
      cloneHarvester: async (_src, dir) => {
        cdpSawLocalState = existsSync(join(dir, 'Local State'))
        const snap = new DatabaseSync(join(dir, 'Default', 'Network', 'Pre24RaceCookies'), { readOnly: true })
        cdpObservedNames = snap.prepare('SELECT name FROM cookies ORDER BY name').all().map((r) => r.name)
        snap.close()
        return {
          cookies: [{ name: 'plain_ok', value: 'plain-val', domain: '.race.example', path: '/', secure: true, httpOnly: true }],
          origins: [],
          skipped: [],
        }
      },
    })
    assert.equal(raceRes.method, 'clone-cdp')
    assert.equal(cdpSawLocalState, true, 'fallback must still copy Local State into workDir')
    assert.equal(clonerCalls.length, 2)
    assert.equal(clonerCalls[1].skipCookieDb, true, 'fallback must reuse Step 3 SQLite snapshot instead of re-cloning')
    assert.deepEqual(cdpObservedNames, ['keyring_v11', 'plain_ok'], 'CDP must read the exact same snapshot analyzed in Step 3')

    // On macOS and Linux (where closeBrowser is Windows-only), an exclusive SQLite lock rejects with
    // browser-locked instead of showing the broken Windows "Close and import" prompt.
    const locker = new DatabaseSync(dbPath)
    try {
      locker.exec("BEGIN EXCLUSIVE; UPDATE cookies SET path = '/locked';")
      const lockedCloner = (src, dir, opts) => cloneCookieStore(src, dir, { ...opts, busyTimeoutMs: 40 })
      await assert.rejects(
        () => importFromBrowser(source, { platformOverride: 'linux', cloner: lockedCloner }),
        (err) => err.code === 'browser-locked',
      )
      await assert.rejects(
        () => importFromBrowser({ ...source, keychainServices: ['Chrome Safe Storage'] }, { platformOverride: 'darwin', cloner: lockedCloner }),
        (err) => err.code === 'browser-locked',
      )
      locker.exec('ROLLBACK')
    } finally {
      locker.close()
    }
  } finally {
    await work.remove()
    await root.remove()
  }
})

test('harvestLiveChromium preserves CDP partitionKeyOpaque and string partitionKey', async () => {
  const root = await tempRoot()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Storage.getCookies') {
        ws.send(JSON.stringify({
          id: msg.id,
          result: {
            cookies: [
              { name: 'plain', value: 'ok', domain: '.example.com', path: '/', secure: true, httpOnly: true, session: true },
              { name: 'opaque_part', value: 'o', domain: '.embed.example', path: '/', secure: true, httpOnly: false, session: true, partitionKeyOpaque: true },
              { name: 'str_part', value: 's', domain: '.embed.example', path: '/', secure: true, httpOnly: false, session: true, partitionKey: 'https://top.example' },
            ],
          },
        }))
      }
    })
  })
  try {
    const activePort = { port, wsPath: '/devtools/browser/test', wsUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }
    const source = { engine: 'chromium', userDataDir: root.dir, profilePath: join(root.dir, 'Default'), profileDir: 'Default' }
    const out = await harvestLiveChromium(source, { activePort, skipFocus: true, includeLocalStorage: false })
    assert.equal(out.cookies.length, 3)
    assert.equal(out.cookies[1].partitionKeyOpaque, true)
    assert.deepEqual(out.cookies[2].partitionKey, { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true })
  } finally {
    await new Promise((resolve) => wss.close(resolve))
    await root.remove()
  }
})
