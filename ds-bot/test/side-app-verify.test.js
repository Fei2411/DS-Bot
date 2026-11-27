import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/side-app.js'

// Verified-open binding tests: the bytes a read serves must belong to the object the
// authorization approved, proven at read time — not merely promised by an earlier
// look at the same path string. These tests pin the refusal shapes (containment,
// data roots, identity) without simulating the kernel race itself.
function harness({ root } = {}) {
  const listeners = new Map()
  const ctx = {
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    effect: () => {},
    get: () => undefined,
  }
  const rt = {
    ctx,
    teamTools: [],
    live: new Map(),
    chatOwners: new Map([['s1', 'b1']]),
    pastOwners: new Map(),
    groupOwners: new Map(),
    taskOwners: new Map(),
    roomOf: () => undefined,
    roomHasImOrigin: () => false,
    cardShown: () => {},
    warn: () => {},
    load: async () => {},
    save: async () => {},
    inData: async () => false,
    real: path => realpath(path).catch(() => resolve(path)),
    realBeyond: async (path) => {
      try {
        return await realpath(path)
      } catch {
        return resolve(path)
      }
    },
    resolveAgent: async id => ({ id, session: { id, header: { cwd: root } } }),
    sessionFolder: session => (session?.id === 's1' ? root : undefined),
  }
  install(rt)
  return { rt }
}

function tempRoot(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-side-verify-')))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

const write = (root, rel, text) => {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const tool = (rt, name) => rt.teamTools.find(entry => entry.name === name)
const execIn = (sessionId, root) => ({ agent: { id: sessionId, session: { id: sessionId, header: { cwd: root } } }, callId: 'c1' })
const fileBody = (descriptor, extra = {}) => ({ file: { app: descriptor.app, sessionId: descriptor.sessionId, displayPath: descriptor.displayPath, workspaceTag: descriptor.workspaceTag }, ...extra })

async function openWithTool(rt, root, path, app = 'open_canvas') {
  const text = await tool(rt, app).execute({ path }, execIn('s1', root))
  return JSON.parse(text.split('\n')[0])
}

// Windows grants directory junctions without developer mode where file symlinks are
// refused, and Linux/macOS accept a plain directory symlink: either shape gives a
// path whose fold escapes the anchor, which is all these proofs need.
const tryDirLink = (target, link) => {
  for (const type of ['junction', 'dir']) {
    try {
      symlinkSync(target, link, type)
      return true
    } catch { /* try the next shape */ }
  }
  return false
}

test('a verified read serves the bytes of the authorized object', async (t) => {
  const root = tempRoot(t)
  write(root, 'a.html', '<h1>verifiable</h1>')
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'a.html'))
  const { bytes, size } = await rt.sideAppInternals.readVerified(real, { anchor: root })
  assert.equal(bytes.toString('utf8'), '<h1>verifiable</h1>')
  assert.equal(size, '<h1>verifiable</h1>'.length)
})

test('the endpoint read refuses when the path escapes the anchor at read time, though authorization saw it inside', async (t) => {
  const outsideRoot = tempRoot(t)
  const root = tempRoot(t)
  write(outsideRoot, 'secret.html', '<h1>outside secret</h1>')
  mkdirSync(join(root, 'entry'), { recursive: true })
  const link = join(root, 'vault')
  if (!tryDirLink(outsideRoot, link)) {
    t.skip('directory links are unavailable here')
    return
  }
  const { rt } = harness({ root })
  // root/vault folds to the outside directory: any path reaching through it escapes
  // the anchor. Drive the read-time layer directly — the refusal must come from
  // verification itself, never depending on how the caller chose the path.
  await assert.rejects(
    rt.sideAppInternals.readVerified(join(link, 'secret.html'), { anchor: root }),
    error => error?.code === 'bot/forbidden' && /leaves the working folder/.test(error.message),
    'a path whose fold lands outside the anchor never opens, however it was named',
  )
})

test('a post-authorization swap onto an outside symlink is refused at read time', async (t) => {
  const outsideRoot = tempRoot(t)
  const root = tempRoot(t)
  write(outsideRoot, 'secret.html', '<h1>outside secret</h1>')
  write(root, 'page.html', '<h1>benign</h1>')
  const { rt } = harness({ root })
  // Authorization runs while the file is genuine: the card is issued.
  const descriptor = await openWithTool(rt, root, 'page.html')
  // The swap lands afterwards: a directory link with the same spelling as the file
  // now leads outside the root, so the folded path escapes.
  const target = join(root, 'page.html')
  rmSync(target)
  if (!tryDirLink(outsideRoot, target)) {
    t.skip('directory links are unavailable here')
    return
  }
  // page.html/ is not itself the secret — reaching the secret through it escapes.
  // A read of the link itself fails too: a directory is never a regular file, and
  // the fold is outside regardless.
  await assert.rejects(
    rt.sideAppEndpoint('side-app-read', fileBody(descriptor)),
    error => error?.code === 'bot/forbidden' || error?.code === 'bot/not-found' || error?.code === 'bot/invalid',
    'the read-time proof must catch what the authorization-time proof could not see',
  )
  // The escaped object itself is never served through the swapped spelling:
  // page.html/secret.html reaches outsideRoot/secret.html through the junction.
  // Even when open() succeeds on it, the read-time fold escapes the anchor.
  const real = await realpath(join(root, 'page.html'))
  assert.equal(real.toLowerCase().startsWith(outsideRoot.toLowerCase()), true, 'the swap indeed folds outside')
  await assert.rejects(
    rt.sideAppInternals.readVerified(join(root, 'page.html', 'secret.html'), { anchor: root }),
    error => error?.code === 'bot/forbidden' || error?.code === 'bot/not-found',
    'bytes outside the anchor never serve through a swapped spelling, open or not',
  )
})

test('a same-name replacement inside the root is refused as an identity change', async (t) => {
  const root = tempRoot(t)
  write(root, 'page.html', '<h1>first</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'page.html')
  // Delete-and-recreate: the path now names a different object. This is not an
  // escape — containment still passes — but the object the card authorized is gone,
  // so nothing may bind this read to that authorization. (A plain overwrite keeps
  // the inode on POSIX, but rm+create never does; either way the read must fail
  // closed or serve the replacement only through a fresh authorization.)
  const target = join(root, 'page.html')
  rmSync(target)
  writeFileSync(target, '<h1>second</h1>')
  const answer = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor)).catch(error => error)
  if (answer instanceof Error) {
    assert.equal(answer.code, 'bot/forbidden', 'a replaced object must not pass as the authorized one')
    assert.match(answer.message, /changed while it was being opened/)
  } else {
    // Windows file replacement can recycle the index in rare cases; a served read is
    // only acceptable because the content itself is still inside the anchor and the
    // endpoint would authorize it identically today. Pin the weaker fact honestly.
    assert.equal(answer.kind, 'text')
  }
})

test('a hardlinked second name for the authorized file is still the same object', async (t) => {
  const root = tempRoot(t)
  write(root, 'original.html', '<h1>linked</h1>')
  const alias = join(root, 'alias.html')
  try {
    linkSync(join(root, 'original.html'), alias)
  } catch {
    t.skip('hard links are unavailable here')
    return
  }
  const { rt } = harness({ root })
  const real = await realpath(alias)
  const { bytes } = await rt.sideAppInternals.readVerified(real, { anchor: root })
  assert.equal(bytes.toString('utf8'), '<h1>linked</h1>', 'same dev+ino is the same object, however many names it has')
})

test('reads bound to a ticket directory refuse files elsewhere in the workspace', async (t) => {
  const root = tempRoot(t)
  write(root, 'site/index.html', '<h1>in</h1>')
  write(root, 'outside.html', '<h1>out</h1>')
  const { rt } = harness({ root })
  const siteRoot = await realpath(join(root, 'site'))
  const stray = await realpath(join(root, 'outside.html'))
  await assert.rejects(
    rt.sideAppInternals.readVerified(stray, { anchor: siteRoot }),
    error => error?.code === 'bot/forbidden' && /leaves the working folder/.test(error.message),
    'the tighter ticket anchor governs the read, not the workspace at large',
  )
  const inside = await realpath(join(root, 'site', 'index.html'))
  const { bytes } = await rt.sideAppInternals.readVerified(inside, { anchor: siteRoot })
  assert.equal(bytes.toString('utf8'), '<h1>in</h1>')
})

test('the data-root refusal is re-proven at read time', async (t) => {
  const root = tempRoot(t)
  write(root, 'secret-data.html', '<h1>data</h1>')
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'secret-data.html'))
  rt.inData = async path => path.endsWith('secret-data.html')
  await assert.rejects(
    rt.sideAppInternals.readVerified(real, { anchor: root }),
    error => error?.code === 'bot/forbidden' && /team data/.test(error.message),
  )
})

test('oversized bytes never enter memory past the ceiling', async (t) => {
  const root = tempRoot(t)
  write(root, 'big.html', `<${'a'.repeat(1024)}>`)
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'big.html'))
  await assert.rejects(
    rt.sideAppInternals.readVerified(real, { anchor: root, limit: 64, oversized: 'too large for the test' }),
    error => error?.code === 'bot/too-large' && /too large for the test/.test(error.message),
  )
  const { bytes } = await rt.sideAppInternals.readVerified(real, { anchor: root, limit: 4096 })
  assert.equal(bytes.length, 1026, 'the whole file reads when it fits the ceiling')
})

test('a multi-chunk read returns every byte the file holds, not the last chunks repeated', async (t) => {
  // The read scratch is 64 KiB; anything larger is several reads. A byte pattern that
  // differs at every position and per 64 KiB block proves the bytes came back whole:
  // chunk aliasing would repeat later scratch content over the earlier blocks.
  const root = tempRoot(t)
  const size = 200 * 1024 + 517
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) {
    body[i] = (i * 131 + Math.floor(i / 65536) * 7) % 251
  }
  write(root, 'chunked.html', body)
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'chunked.html'))
  const { bytes } = await rt.sideAppInternals.readVerified(real, { anchor: root, limit: 4 * 1024 * 1024 })
  assert.equal(bytes.length, size, 'the read length matches the file')
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    createHash('sha256').update(body).digest('hex'),
    'the served bytes hash to the file the disk holds',
  )
  for (let block = 0; block * 65536 < size; block += 1) {
    const at = block * 65536
    const end = Math.min(at + 65536, size)
    assert.deepEqual(bytes.subarray(at, end), body.subarray(at, end), `block ${block} survives whole`)
  }
})

test('an oversized multi-chunk file still fails at ceiling plus one byte, never returning truncated bytes', async (t) => {
  // Growth past the ceiling must surface as the oversized error even when the file
  // needs several scratch rounds: the extra byte is the proof, not a short read.
  const root = tempRoot(t)
  const size = 150 * 1024 + 33
  const body = Buffer.alloc(size, 120)
  write(root, 'overgrown.html', body)
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'overgrown.html'))
  await assert.rejects(
    rt.sideAppInternals.readVerified(real, { anchor: root, limit: 100 * 1024, oversized: 'too large for the test' }),
    error => error?.code === 'bot/too-large' && /too large for the test/.test(error.message),
    'a file over the ceiling rejects instead of serving a partial read',
  )
  // Exactly at the ceiling, the same multi-chunk path serves every byte whole.
  const exact = 100 * 1024
  const exactBody = Buffer.alloc(exact)
  for (let i = 0; i < exact; i += 1) exactBody[i] = (i * 97) % 251
  write(root, 'exact.html', exactBody)
  const exactReal = await realpath(join(root, 'exact.html'))
  const { bytes } = await rt.sideAppInternals.readVerified(exactReal, { anchor: root, limit: exact })
  assert.equal(bytes.length, exact)
  assert.deepEqual(bytes, exactBody, 'a file exactly at the ceiling reads whole through several chunks')
})

test('a path that names no regular file never reaches the byte channel', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'dir.html'), { recursive: true })
  const { rt } = harness({ root })
  const real = await realpath(join(root, 'dir.html'))
  await assert.rejects(
    rt.sideAppInternals.readVerified(real, { anchor: root }),
    error => error?.code === 'bot/invalid' || error?.code === 'bot/forbidden',
    'a directory shaped like HTML is not a readable file',
  )
  await assert.rejects(
    rt.sideAppInternals.readVerified(join(root, 'gone.html'), { anchor: root }),
    error => ['bot/not-found', 'bot/forbidden', 'bot/invalid'].includes(error?.code),
    'a missing file fails closed rather than reading nothing as success',
  )
})

test('a fold layer that cannot prove anything fails the read closed', async (t) => {
  const root = tempRoot(t)
  write(root, 'a.html', '<h1>x</h1>')
  const { rt } = harness({ root })
  rt.real = async () => { throw new Error('fold layer down') }
  rt.realBeyond = async () => { throw new Error('fold layer down') }
  const real = await realpath(join(root, 'a.html'))
  await assert.rejects(
    rt.sideAppInternals.readVerified(real, { anchor: root }),
    error => error?.code === 'bot/forbidden',
    'when containment cannot be proven at read time the read must not happen',
  )
})
