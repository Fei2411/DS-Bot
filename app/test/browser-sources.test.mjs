// Browser profile enumeration (Chromium user-data roots, Firefox profiles.ini), the clone
// layout a harvest needs, and the process match for closing a running source on Windows.
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import {
  appBoundRows,
  chromiumCloneArgs,
  chromiumProfiles,
  cloneCookieStore,
  cloneWorkDir,
  decryptChromiumV10,
  deriveMacChromiumKey,
  firefoxProfiles,
  harvestCookies,
  harvestLiveChromium,
  hasAppBoundKey,
  importFromBrowser,
  locksProfile,
  readChromiumSqliteCookies,
  readDevToolsActivePort,
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
              { name: 'stale', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: false, session: false, expires: 1000000000 },
            ],
          },
        }))
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
    assert.equal(out.cookies.length, 1)
    assert.equal(out.cookies[0].name, 'sid')
    assert.equal(out.cookies[0].value, 'live-cookie-val')
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
