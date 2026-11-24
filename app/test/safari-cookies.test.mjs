// macOS Safari Cookies.binarycookies parsing, fast counting, SafariTabs.db multi-profile
// discovery, and Full Disk Access permission detection.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  checkSafariAccess,
  countBinaryCookies,
  harvestSafari,
  parseBinaryCookies,
  safariProfiles,
} from '../src/safari-cookies.mjs'

const MAC_EPOCH_OFFSET = 978307200

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-safari-test-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) }
}

function buildCookieRecord({ domain, name, path = '/', value = '', flags = 0, expires = 0, created = 0 }) {
  const domainBuf = Buffer.from(`${domain}\0`, 'utf8')
  const nameBuf = Buffer.from(`${name}\0`, 'utf8')
  const pathBuf = Buffer.from(`${path}\0`, 'utf8')
  const valueBuf = Buffer.from(`${value}\0`, 'utf8')
  const headerSize = 56
  const domainOff = headerSize
  const nameOff = domainOff + domainBuf.length
  const pathOff = nameOff + nameBuf.length
  const valueOff = pathOff + pathBuf.length
  const totalSize = valueOff + valueBuf.length

  const rec = Buffer.alloc(totalSize)
  rec.writeUInt32LE(totalSize, 0)
  rec.writeUInt32LE(0, 4) // version
  rec.writeUInt32LE(flags, 8)
  rec.writeUInt32LE(0, 12)
  rec.writeUInt32LE(domainOff, 16)
  rec.writeUInt32LE(nameOff, 20)
  rec.writeUInt32LE(pathOff, 24)
  rec.writeUInt32LE(valueOff, 28)
  rec.writeBigUInt64LE(0n, 32)
  rec.writeDoubleLE(expires ? expires - MAC_EPOCH_OFFSET : 0, 40)
  rec.writeDoubleLE(created ? created - MAC_EPOCH_OFFSET : 0, 48)

  domainBuf.copy(rec, domainOff)
  nameBuf.copy(rec, nameOff)
  pathBuf.copy(rec, pathOff)
  valueBuf.copy(rec, valueOff)
  return rec
}

function buildBinaryCookies(pages) {
  const pageBuffers = pages.map((cookies) => {
    const records = cookies.map(buildCookieRecord)
    const tableBytes = 8 + records.length * 4 + 4
    let cursor = tableBytes
    const offsets = records.map((rec) => {
      const off = cursor
      cursor += rec.length
      return off
    })
    const page = Buffer.alloc(cursor)
    page.writeUInt32BE(0x00000100, 0)
    page.writeUInt32LE(records.length, 4)
    offsets.forEach((off, idx) => page.writeUInt32LE(off, 8 + idx * 4))
    page.writeUInt32LE(0, 8 + records.length * 4)
    records.forEach((rec, idx) => rec.copy(page, offsets[idx]))
    return page
  })

  const header = Buffer.alloc(8 + pageBuffers.length * 4)
  header.write('cook', 0, 'ascii')
  header.writeUInt32BE(pageBuffers.length, 4)
  pageBuffers.forEach((p, idx) => header.writeUInt32BE(p.length, 8 + idx * 4))
  return Buffer.concat([header, ...pageBuffers])
}

test('parseBinaryCookies parses multi-page Apple Cookies.binarycookies with flags, epochs, session and expired entries', () => {
  const buf = buildBinaryCookies([
    [
      { domain: '.example.com', name: 'sid', path: '/', value: 'tok-1', flags: 0x05, expires: 1900000000 },
      { domain: 'app.example.com', name: 'sess', path: '/app', value: 's-2', flags: 0x01, expires: 0 },
    ],
    [
      { domain: '.old.example', name: 'expired_tok', path: '/', value: 'old', flags: 0x04, expires: 1500000000 },
      { domain: 'plain.example', name: 'prefs', path: '/', value: 'dark', flags: 0x00, expires: 1950000000 },
    ],
  ])

  const out = parseBinaryCookies(buf, { now: 1700000000 })
  assert.equal(out.cookies.length, 3)
  assert.deepEqual(out.cookies[0], {
    name: 'sid', value: 'tok-1', domain: '.example.com', path: '/',
    secure: true, httpOnly: true, expires: 1900000000,
  })
  assert.deepEqual(out.cookies[1], {
    name: 'sess', value: 's-2', domain: 'app.example.com', path: '/app',
    secure: true, httpOnly: false,
  })
  assert.equal(out.cookies[1].expires, undefined)
  assert.deepEqual(out.cookies[2], {
    name: 'prefs', value: 'dark', domain: 'plain.example', path: '/',
    secure: false, httpOnly: false, expires: 1950000000,
  })
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].name, 'expired_tok')
  assert.equal(out.skipped[0].code, 'expired')

  assert.deepEqual(parseBinaryCookies(Buffer.alloc(0)), { cookies: [], origins: [], skipped: [] })
  assert.throws(() => parseBinaryCookies(Buffer.from('not-a-cook-file')), (err) => err.code === 'safari-corrupt')
  assert.throws(() => parseBinaryCookies(buf.subarray(0, 20)), (err) => err.code === 'safari-corrupt')
})

test('countBinaryCookies counts records across pages and handles empty or invalid files', async () => {
  const root = await tempRoot()
  try {
    const file = join(root.dir, 'Cookies.binarycookies')
    await writeFile(file, buildBinaryCookies([
      [{ domain: 'a.example', name: 'a', value: '1' }, { domain: 'b.example', name: 'b', value: '2' }],
      [{ domain: 'c.example', name: 'c', value: '3' }],
    ]))
    assert.equal(await countBinaryCookies(file), 3)

    const empty = join(root.dir, 'empty.binarycookies')
    await writeFile(empty, Buffer.alloc(0))
    assert.equal(await countBinaryCookies(empty), 0)

    const bad = join(root.dir, 'bad.binarycookies')
    await writeFile(bad, 'nope')
    assert.equal(await countBinaryCookies(bad), null)
    assert.equal(await countBinaryCookies(join(root.dir, 'missing')), null)
  } finally { await root.remove() }
})

test('safariProfiles discovers Default + named profiles from SafariTabs.db and harvests cookies', async () => {
  const root = await tempRoot()
  try {
    const containerLib = join(root.dir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library')
    const workUuid = '11111111-2222-3333-4444-555555555555'
    const deletedUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await mkdir(join(containerLib, 'Cookies'), { recursive: true })
    await mkdir(join(containerLib, 'Safari'), { recursive: true })
    await mkdir(join(containerLib, 'WebKit', 'WebsiteDataStore', workUuid, 'Cookies'), { recursive: true })

    const defaultFile = join(containerLib, 'Cookies', 'Cookies.binarycookies')
    const workFile = join(containerLib, 'WebKit', 'WebsiteDataStore', workUuid, 'Cookies', 'Cookies.binarycookies')
    await writeFile(defaultFile, buildBinaryCookies([[
      { domain: '.personal.example', name: 'p_sid', value: 'p1', flags: 0x05, expires: 1900000000 },
    ]]))
    await writeFile(workFile, buildBinaryCookies([[
      { domain: '.work.example', name: 'w_sid', value: 'w1', flags: 0x05, expires: 1900000000 },
      { domain: '.work.example', name: 'w_pref', value: 'w2', flags: 0x01, expires: 1900000000 },
    ]]))

    // Single profile without SafariTabs.db -> unnamed default ("Safari")
    const solo = await safariProfiles({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(solo.length, 2) // workUuid discovered by WebsiteDataStore scan even before SafariTabs.db exists
    assert.equal(solo[0].displayName, 'Personal')
    assert.equal(solo[0].cookieCount, 1)

    // Add SafariTabs.db naming profiles + a deleted profile entry that must be ignored
    const tabsDb = new DatabaseSync(join(containerLib, 'Safari', 'SafariTabs.db'))
    tabsDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, parent INTEGER, type INTEGER, subtype INTEGER, title TEXT, external_uuid TEXT, deleted INTEGER DEFAULT 0);
    `)
    const ins = tabsDb.prepare('INSERT INTO bookmarks (parent, type, subtype, title, external_uuid, deleted) VALUES (0, 1, 2, ?, ?, ?)')
    ins.run('Home', 'DefaultProfile', 0)
    ins.run('Work', workUuid, 0)
    ins.run('Old', deletedUuid, 1)
    tabsDb.close()

    const multi = await safariProfiles({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(multi.length, 2)
    assert.equal(multi[0].dir, 'Default')
    assert.equal(multi[0].displayName, 'Home')
    assert.equal(multi[0].cookieCount, 1)
    assert.equal(multi[1].dir, workUuid)
    assert.equal(multi[1].displayName, 'Work')
    assert.equal(multi[1].cookieCount, 2)

    const harvested = await harvestSafari({ cookieFile: workFile, userDataDir: containerLib }, { now: 1700000000 })
    assert.deepEqual(harvested.cookies.map((c) => [c.name, c.value]), [['w_sid', 'w1'], ['w_pref', 'w2']])
  } finally { await root.remove() }
})

test('checkSafariAccess and safariProfiles surface needsPermission on EACCES/EPERM when container is unreadable', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('POSIX non-root chmod permission test only')
    return
  }
  const root = await tempRoot()
  const cookiesDir = join(root.dir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies')
  try {
    const containerLib = join(root.dir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library')
    await mkdir(cookiesDir, { recursive: true })
    await writeFile(join(cookiesDir, 'Cookies.binarycookies'), buildBinaryCookies([]))
    await chmod(cookiesDir, 0o000)

    const access = await checkSafariAccess({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(access.accessible, false)
    assert.equal(access.needsPermission, true)

    const profiles = await safariProfiles({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].dir, 'permission')
    assert.equal(profiles[0].needsPermission, true)
    assert.equal(profiles[0].cookieFile, null)

    await assert.rejects(
      () => harvestSafari({ profileDir: 'Default', cookieFile: null, userDataDir: containerLib }, { home: root.dir, containerLib }),
      (err) => err.code === 'safari-permission',
    )
  } finally {
    await chmod(cookiesDir, 0o700).catch(() => {})
    await root.remove()
  }
})

test('checkSafariAccess and safariProfiles detect named-only Safari profiles without a default Cookies.binarycookies', async () => {
  const root = await tempRoot()
  try {
    const containerLib = join(root.dir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library')
    const workUuid = '22222222-3333-4444-5555-666666666666'
    await mkdir(join(containerLib, 'WebKit', 'WebsiteDataStore', workUuid, 'Cookies'), { recursive: true })
    await writeFile(
      join(containerLib, 'WebKit', 'WebsiteDataStore', workUuid, 'Cookies', 'Cookies.binarycookies'),
      buildBinaryCookies([[{ domain: '.named.example', name: 'tok', value: 'v1', flags: 0x05, expires: 1900000000 }]]),
    )

    const access = await checkSafariAccess({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(access.accessible, true)
    assert.equal(access.needsPermission, false)
    assert.equal(access.hasNamedProfiles, true)

    const profiles = await safariProfiles({ home: root.dir, containerLib, appPaths: [] })
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].dir, workUuid)
    assert.equal(profiles[0].cookieCount, 1)
  } finally { await root.remove() }
})

test('parseBinaryCookies skips corrupted records with out-of-bounds offsets, truncated sizes, or missing NUL terminators', () => {
  const goodRec = buildCookieRecord({ domain: '.ok.example', name: 'good', path: '/', value: 'real', flags: 0x05, expires: 1900000000 })

  // 1. Out-of-bounds value offset (must NOT emit value: '' and clobber real cookies)
  const badValueOff = Buffer.from(goodRec)
  badValueOff.writeUInt32LE(badValueOff.length + 10, 28)

  // 2. Record size claiming past page end
  const oversizedRec = Buffer.from(goodRec)
  oversizedRec.writeUInt32LE(oversizedRec.length + 200, 0)

  // 3. Missing NUL terminator on value string
  const noNulRec = Buffer.from(goodRec)
  noNulRec[noNulRec.length - 1] = 0x41 // overwrite final NUL with 'A'

  const records = [goodRec, badValueOff, noNulRec, oversizedRec]
  const tableBytes = 8 + records.length * 4 + 4
  let cursor = tableBytes
  const offsets = records.map((rec) => { const off = cursor; cursor += rec.length; return off })
  const page = Buffer.alloc(cursor)
  page.writeUInt32BE(0x00000100, 0)
  page.writeUInt32LE(records.length, 4)
  offsets.forEach((off, idx) => page.writeUInt32LE(off, 8 + idx * 4))
  page.writeUInt32LE(0, 8 + records.length * 4)
  records.forEach((rec, idx) => rec.copy(page, offsets[idx]))

  const header = Buffer.alloc(12)
  header.write('cook', 0, 'ascii')
  header.writeUInt32BE(1, 4)
  header.writeUInt32BE(page.length, 8)
  const buf = Buffer.concat([header, page])

  const parsed = parseBinaryCookies(buf, { now: 1700000000 })
  assert.deepEqual(parsed.cookies.map((c) => [c.name, c.value]), [['good', 'real']])
  assert.deepEqual(parsed.skipped.map((s) => s.code), ['corrupt', 'corrupt', 'corrupt'])
})
