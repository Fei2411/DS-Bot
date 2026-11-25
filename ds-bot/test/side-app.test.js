import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/side-app.js'

// A minimal runtime: the realpath helpers behave like folders.js, ownership maps
// hold one Bot chat `s1` working in `root`, and the listeners ctx.on collects are
// fired by hand.
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
  const fireExecute = async (exec, result) => {
    for (const listener of listeners.get('tools/execute') ?? []) {
      await listener(exec, async () => result)
    }
  }
  return { rt, listeners, fireExecute }
}

function fixture(t) {
  // Realpath it at once: every comparison in the module happens on real paths,
  // and macOS tempdirs are symlinks.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-side-app-')))
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
  const [json] = text.split('\n')
  return JSON.parse(json)
}

test('open_canvas validates the file, leaves a descriptor and a pending open', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  assert.equal(descriptor.v, 1)
  assert.equal(descriptor.app, 'canvas')
  assert.equal(descriptor.sessionId, 's1')
  assert.equal(descriptor.displayPath, 'draft.html')
  assert.equal(typeof descriptor.workspaceTag, 'string')
  assert.equal(rt.sideAppInternals.pendingOpens.size, 1)
  const view = rt.sideAppOpensView()
  assert.equal(view.s1.displayPath, 'draft.html')
  // consumed once
  assert.deepEqual(await rt.sideAppEndpoint('side-app-opened', { openId: view.s1.openId }), { consumed: true })
  assert.deepEqual(await rt.sideAppEndpoint('side-app-opened', { openId: view.s1.openId }), { consumed: false })
})

test('open_canvas refuses wrong extensions, missing files and traversal, registering nothing', async (t) => {
  const root = fixture(t)
  write(root, 'notes.md', '# hi')
  writeFileSync(join(root, 'outside.txt'), 'x')
  const { rt } = harness({ root })
  assert.match(await tool(rt, 'open_canvas').execute({ path: 'notes.md' }, execIn('s1', root)), /Could not open the file: Canvas opens HTML files/)
  assert.match(await tool(rt, 'open_canvas').execute({ path: 'gone.html' }, execIn('s1', root)), /Could not open the file: The file is no longer there/)
  assert.match(await tool(rt, 'open_canvas').execute({ path: '../outside.txt' }, execIn('s1', root)), /Could not open the file: That path leaves the working folder/)
  assert.match(await tool(rt, 'open_canvas').execute({ path: 'https://evil.example/x.html' }, execIn('s1', root)), /not a URL/)
  assert.equal(rt.sideAppInternals.pendingOpens.size, 0)
})

test('open_reader accepts md, markdown and mdx but not txt', async (t) => {
  const root = fixture(t)
  write(root, 'a.md', '# a')
  write(root, 'b.markdown', '# b')
  write(root, 'c.mdx', '# c')
  write(root, 'd.txt', 'd')
  const { rt } = harness({ root })
  for (const path of ['a.md', 'b.markdown', 'c.mdx']) {
    const text = await tool(rt, 'open_reader').execute({ path }, execIn('s1', root))
    assert.match(text, /^Reader opened for /m, path)
  }
  assert.match(await tool(rt, 'open_reader').execute({ path: 'd.txt' }, execIn('s1', root)), /Reader opens Markdown files/)
})

test('background tasks and plain group sessions cannot open a panel', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  rt.taskOwners.set('task1', { botId: 'b1', taskId: 't1' })
  assert.match(await tool(rt, 'open_canvas').execute({ path: 'draft.html' }, execIn('task1', root)), /Background tasks cannot open/)
  rt.groupOwners.set('g1', { botId: 'b1', roomId: 'r1' })
  rt.roomOf = id => (id === 'r1' || id === 'g1' ? { id: 'r1', members: ['b1'] } : undefined)
  assert.match(await tool(rt, 'open_canvas').execute({ path: 'draft.html' }, execIn('g1', root)), /only opens from your own chat/)
  assert.equal(rt.sideAppInternals.pendingOpens.size, 0)
})

test('side-app-read returns text with a content revision and honors knownRevision', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>one</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const first = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor))
  assert.equal(first.kind, 'text')
  assert.equal(first.text, '<h1>one</h1>')
  const again = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor, { knownRevision: first.revision }))
  assert.deepEqual(again, { kind: 'unchanged', revision: first.revision })
  await writeFile(join(root, 'draft.html'), '<h1>two</h1>')
  const changed = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor, { knownRevision: first.revision }))
  assert.equal(changed.kind, 'text')
  assert.equal(changed.text, '<h1>two</h1>')
  assert.notEqual(changed.revision, first.revision)
})

test('a same-length rewrite still changes the revision', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', 'aaaa')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const first = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor))
  await writeFile(join(root, 'draft.html'), 'bbbb')
  const changed = await rt.sideAppEndpoint('side-app-read', fileBody(descriptor, { knownRevision: first.revision }))
  assert.equal(changed.kind, 'text', 'a content revision never collapses same-size writes')
})

test('reads refuse binary and oversized files with the documented error codes', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  await writeFile(join(root, 'draft.html'), Buffer.from([0xff, 0xfe, 0x00, 0x61]))
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(descriptor)), error => error?.code === 'bot/invalid' && /UTF-8/.test(error.message))
  await writeFile(join(root, 'draft.html'), 'x'.repeat(4 * 1024 * 1024 + 1))
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(descriptor)), error => error?.code === 'bot/too-large')
})

test('a stale workspaceTag is refused as workspace-changed', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const stale = { ...descriptor, workspaceTag: 'deadbeef' }
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(stale)), error => error?.code === 'bot/workspace-changed')
})

test('endpoint reads cannot escape the root even when the descriptor lies', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const lying = { ...descriptor, displayPath: '../../etc/passwd' }
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(lying)), error => error?.code === 'bot/forbidden')
  const lyingApp = { ...descriptor, app: 'reader' }
  await assert.rejects(rt.sideAppEndpoint('side-app-preview', fileBody(lyingApp)), error => error?.code === 'bot/invalid')
})

test('write/edit results feed the diff base once per turn, first before to last after', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', 'v1')
  const { rt, fireExecute } = harness({ root })
  rt.live.set('s1', { turn: 7 })
  const exec = { name: 'edit', arguments: { file_path: 'draft.html' }, agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } }
  await fireExecute(exec, { value: { before: 'v1', after: 'v2' } })
  await fireExecute(exec, { value: { before: 'v2', after: 'v3' } })
  // The module keys bases by the real path as the platform spells it; tests must
  // seed with the same key, never a hand-folded one (Linux does not fold case).
  const entries = [...rt.sideAppInternals.diffBases.entries()]
  assert.equal(entries.length, 1)
  const [baseKey, entry] = entries[0]
  assert.equal(entry.before, 'v1')
  assert.equal(entry.after, 'v3')
  assert.equal(entry.turn, 7)
  // served only when the requested revision matches the captured after text
  const { rt: rt2 } = harness({ root })
  rt2.sideAppInternals.diffBases.set(baseKey, entry)
  const descriptor = { app: 'canvas', sessionId: 's1', displayPath: 'draft.html', workspaceTag: rt2.sideAppInternals.rootTag(root) }
  const miss = await rt2.sideAppEndpoint('side-app-diff', { file: descriptor, revision: 'nope' })
  assert.equal(miss.kind, 'unavailable')
  const hit = await rt2.sideAppEndpoint('side-app-diff', { file: descriptor, revision: entry.afterRevision })
  assert.equal(hit.kind, 'host')
  assert.equal(hit.before, 'v1')
})

test('created files use an empty before as their base', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', 'x')
  const { rt, fireExecute } = harness({ root })
  rt.live.set('s1', { turn: 1 })
  const exec = { name: 'write', arguments: { file_path: 'draft.html' }, agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } }
  await fireExecute(exec, { value: { before: null, after: 'whole file' } })
  const entries = [...rt.sideAppInternals.diffBases.values()]
  assert.equal(entries.length, 1)
  assert.equal(entries[0].before, '')
  assert.equal(entries[0].after, 'whole file')
})

test('apply_patch per-file changes feed bases for each written file', async (t) => {
  const root = fixture(t)
  write(root, 'one.html', 'a')
  write(root, 'two.html', 'b')
  const { rt, fireExecute } = harness({ root })
  rt.live.set('s1', { turn: 3 })
  const exec = { name: 'apply_patch', arguments: { patch: '***' }, agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } }
  await fireExecute(exec, {
    value: {
      operations: [
        { changes: [{ path: join(root, 'one.html'), before: 'a', after: 'a2' }] },
        { changes: [{ path: join(root, 'two.html'), before: null, after: 'b2' }, { path: join(root, 'gone.html'), before: 'x', after: null }] },
      ],
    },
  })
  const bases = [...rt.sideAppInternals.diffBases.values()]
  assert.equal(bases.length, 2, 'deletions produce no base and each file gets its own entry')
  assert.deepEqual(bases.map(entry => [entry.before, entry.after]).sort(), [['', 'b2'], ['a', 'a2']])
})

test('failed writes and writes outside the root leave no base', async (t) => {
  const root = fixture(t)
  const { rt, fireExecute } = harness({ root })
  const exec = { name: 'edit', arguments: { file_path: 'draft.html' }, agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } }
  await fireExecute(exec, { isError: true, value: { before: 'a', after: 'b' } })
  await fireExecute({ ...exec, arguments: { file_path: '../elsewhere.html' } }, { value: { before: 'a', after: 'b' } })
  assert.equal(rt.sideAppInternals.diffBases.size, 0)
})

test('preview tickets serve the entry and same-directory assets with the CSP', async (t) => {
  const root = fixture(t)
  write(root, 'page/draft.html', '<link rel="stylesheet" href="style.css"><h1>hi</h1>')
  write(root, 'page/style.css', 'body{color:red}')
  const { rt } = harness({ root })
  const ticket = rt.sideAppInternals.issueTicket({ entryReal: await realpath(join(root, 'page', 'draft.html')), displayPath: 'page/draft.html', sessionId: 's1' })
  const serve = path => rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/${path}`)
  const entry = await serve('draft.html')
  assert.equal(entry.status, 200)
  assert.equal(entry.headers.get('content-type'), 'text/html; charset=utf-8')
  const csp = entry.headers.get('content-security-policy')
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.equal(entry.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await entry.text()).includes('<h1>hi</h1>'), true)
  const css = await serve('style.css')
  assert.equal(css.status, 200)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
})

test('the canvas route never serves traversal, dotfiles, secrets or disallowed types', async (t) => {
  const root = fixture(t)
  write(root, 'page/draft.html', '<h1>hi</h1>')
  write(root, 'page/secret.pem', 'PRIVATE KEY')
  write(root, 'page/.env', 'TOKEN=1')
  write(root, 'page/data.bin', '\x00\x01')
  write(root, 'outside.html', '<h1>out</h1>')
  const { rt } = harness({ root })
  const ticket = rt.sideAppInternals.issueTicket({ entryReal: await realpath(join(root, 'page', 'draft.html')), displayPath: 'page/draft.html', sessionId: 's1' })
  const serve = path => rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/${path}`)
  assert.equal((await serve('secret.pem')).status, 404)
  assert.equal((await serve('.env')).status, 404)
  assert.equal((await serve('data.bin')).status, 404, 'unlisted extension')
  assert.equal((await serve('../outside.html')).status, 404, 'traversal never escapes the entry directory')
  assert.equal((await serve(encodeURIComponent('../outside.html'))).status, 404)
  assert.equal((await serve('sub/../../outside.html')).status, 404)
  assert.equal((await serve('')).status, 404, 'no directory listing')
})

test('symlink and junction escapes are refused even when the link itself sits inside the tree', async (t) => {
  const root = fixture(t)
  write(root, 'page/draft.html', '<h1>hi</h1>')
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-side-out-'))
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(outside, 'stolen.txt'), 'top secret')
  let linked = false
  try {
    symlinkSync(join(outside, 'stolen.txt'), join(root, 'page', 'linked.txt'))
    linked = true
  } catch {
    try {
      // Directory junctions need no privilege on Windows; the escape vector is the same.
      symlinkSync(outside, join(root, 'page', 'linked-dir'), 'junction')
      linked = true
    } catch (error) {
      t.skip(`links unavailable here: ${error.message}`)
      return
    }
  }
  assert.equal(linked, true)
  const { rt } = harness({ root })
  const ticket = rt.sideAppInternals.issueTicket({ entryReal: await realpath(join(root, 'page', 'draft.html')), displayPath: 'page/draft.html', sessionId: 's1' })
  for (const rel of ['linked.txt', 'linked-dir/stolen.txt']) {
    const response = await rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/${rel}`)
    assert.equal(response.status, 404, `${rel} must not escape the tree`)
  }
})

test('expired tickets answer nothing and renewal only extends a live ticket', async (t) => {
  const root = fixture(t)
  write(root, 'page/draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const ticket = rt.sideAppInternals.issueTicket({ entryReal: await realpath(join(root, 'page', 'draft.html')), displayPath: 'page/draft.html', sessionId: 's1' })
  assert.ok(rt.sideAppInternals.renewTicket(ticket.id, 's1'))
  assert.equal(rt.sideAppInternals.renewTicket(ticket.id, 'other-session'), undefined, 'another session cannot renew it')
  ticket.expiresAt = Date.now() - 1
  assert.equal(rt.sideAppInternals.renewTicket(ticket.id, 's1'), undefined, 'an expired ticket stays dead')
  assert.equal(rt.sideAppInternals.tickets.has(ticket.id), false)
})

test('the preview revision follows entry bytes and asset changes', async (t) => {
  const root = fixture(t)
  write(root, 'page/draft.html', '<h1>one</h1>')
  write(root, 'page/app.js', 'console.log(1)')
  const { rt } = harness({ root })
  const ticket = rt.sideAppInternals.issueTicket({ entryReal: await realpath(join(root, 'page', 'draft.html')), displayPath: 'page/draft.html', sessionId: 's1' })
  const first = await rt.sideAppInternals.previewRevision(ticket)
  const same = await rt.sideAppInternals.previewRevision(ticket)
  assert.equal(same.revision, first.revision)
  await writeFile(join(root, 'page', 'app.js'), 'console.log(2)')
  const changed = await rt.sideAppInternals.previewRevision(ticket)
  assert.notEqual(changed.revision, first.revision, 'asset bytes participate in the preview revision')
  await writeFile(join(root, 'page', 'draft.html'), '<h1>two</h1>')
  const entryChanged = await rt.sideAppInternals.previewRevision(ticket)
  assert.notEqual(entryChanged.revision, changed.revision)
})

test('side-app-preview issues a ticketed frameUrl and honors knownPreviewRevision', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const first = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor))
  assert.equal(first.kind, 'preview')
  assert.match(first.frameUrl, new RegExp(`^/api/bot-canvas/[^/]+/${encodeURIComponent('draft.html')}$`))
  assert.equal(typeof first.expiresAt, 'number')
  const again = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor, { knownPreviewRevision: first.previewRevision }))
  assert.equal(again.kind, 'unchanged')
  assert.equal(again.previewRevision, first.previewRevision)
  await writeFile(join(root, 'draft.html'), '<h1>changed</h1>')
  const changed = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor, { knownPreviewRevision: first.previewRevision }))
  assert.equal(changed.kind, 'preview')
})

test('side-app-open revalidates and reports size limits honestly', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'draft.html')
  const answer = await rt.sideAppEndpoint('side-app-open', { ...fileBody(descriptor), app: 'canvas' })
  assert.equal(answer.file.displayPath, 'draft.html')
  assert.equal(answer.previewAvailable, true)
  assert.equal(answer.textLimited, false)
  assert.equal(typeof answer.revision, 'string')
  await assert.rejects(rt.sideAppEndpoint('side-app-open', { ...fileBody(descriptor), app: 'reader' }), error => error?.code === 'bot/invalid')
})

test('the tab argument lands in the descriptor and bad values die at schema validation', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  const text = await tool(rt, 'open_canvas').execute({ path: 'draft.html', tab: 'source' }, execIn('s1', root))
  assert.equal(JSON.parse(text.split('\n')[0]).tab, 'source')
  await assert.rejects(tool(rt, 'open_canvas').execute({ path: 'draft.html', tab: 'weird' }, execIn('s1', root)), /must be one of/)
})

test('isUtf8 accepts real text and rejects truncation and surrogates', async (t) => {
  const root = fixture(t)
  const { rt } = harness({ root })
  const { isUtf8 } = rt.sideAppInternals
  assert.equal(isUtf8(Buffer.from('hello 世界 ✓', 'utf8')), true)
  assert.equal(isUtf8(Buffer.from([0xe4, 0xb8])), false, 'truncated sequence')
  assert.equal(isUtf8(Buffer.from([0xed, 0xa0, 0x80])), false, 'lone surrogate half')
  assert.equal(isUtf8(Buffer.from([0x61, 0xff, 0x62])), false)
})

test('side-app-bytes serves whitelisted images and refuses other types, escapes and oversized files', async (t) => {
  const root = fixture(t)
  write(root, 'guide.md', '# guide')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  writeFileSync(join(root, 'pic.png'), png)
  write(root, 'page.html', '<h1>x</h1>')
  write(root, '.env', 'TOKEN=1')
  write(root, 'cert.pem', 'KEY')
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'guide.md', 'open_reader')
  const image = { app: 'reader', sessionId: 's1', displayPath: 'pic.png', workspaceTag: descriptor.workspaceTag }
  const first = await rt.sideAppEndpoint('side-app-bytes', { file: image })
  assert.equal(first.kind, 'bytes')
  assert.equal(first.mime, 'image/png')
  assert.equal(Buffer.from(first.data, 'base64').equals(png), true)
  assert.deepEqual(await rt.sideAppEndpoint('side-app-bytes', { file: image, knownRevision: first.revision }), { kind: 'unchanged', revision: first.revision })
  for (const rel of ['page.html', '.env', 'cert.pem', 'guide.md']) {
    await assert.rejects(
      rt.sideAppEndpoint('side-app-bytes', { file: { ...image, displayPath: rel } }),
      error => error?.code === 'bot/invalid' && /image files/.test(error.message),
      `${rel} must not be served as bytes`,
    )
  }
  await assert.rejects(
    rt.sideAppEndpoint('side-app-bytes', { file: { ...image, displayPath: '../outside.png' } }),
    error => error?.code === 'bot/forbidden',
  )
  writeFileSync(join(root, 'huge.png'), Buffer.alloc(4 * 1024 * 1024 + 1, 1))
  await assert.rejects(
    rt.sideAppEndpoint('side-app-bytes', { file: { ...image, displayPath: 'huge.png' } }),
    error => error?.code === 'bot/too-large',
  )
  const wrongTag = await rt.sideAppEndpoint('side-app-bytes', { file: { ...image, workspaceTag: 'wrong' } }).catch(error => error)
  assert.equal(wrongTag.code, 'bot/workspace-changed')
})

test('side-app-bytes accepts the body the Reader sends for an image beside a nested article', async (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'docs', 'img'), { recursive: true })
  write(root, 'docs/post.md', '![fig](img/a.png)')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  writeFileSync(join(root, 'docs', 'img', 'a.png'), png)
  const { rt } = harness({ root })
  const descriptor = await openWithTool(rt, root, 'docs/post.md', 'open_reader')
  // Shape of ds-bot/src/client/side-file-source.js fetchImage: sessionId beside `file`, not inside it.
  const body = { sessionId: 's1', file: { app: descriptor.app, displayPath: 'docs/img/a.png', workspaceTag: descriptor.workspaceTag } }
  const got = await rt.sideAppEndpoint('side-app-bytes', body)
  assert.equal(got.kind, 'bytes')
  assert.equal(got.mime, 'image/png')
  assert.equal(Buffer.from(got.data, 'base64').equals(png), true)
  assert.deepEqual(await rt.sideAppEndpoint('side-app-bytes', { ...body, knownRevision: got.revision }), { kind: 'unchanged', revision: got.revision })
})

test('the channel routes side-app endpoints and unknown ones fail closed', async (t) => {
  const root = fixture(t)
  write(root, 'draft.html', '<h1>hi</h1>')
  const { rt } = harness({ root })
  await assert.rejects(rt.sideAppEndpoint('side-app-nope', {}), error => error?.code === 'bot/not-found')
  // consumption is idempotent and unknown opens never fail the caller
  assert.deepEqual(await rt.sideAppEndpoint('side-app-opened', { openId: 'never-issued' }), { consumed: false })
  assert.deepEqual(await rt.sideAppEndpoint('side-app-opened', {}), { consumed: false })
})

test('tools are listed for the team catalog and count as user-facing instant work', async () => {
  const { TEAM_TOOLS, USER_UI_TOOLS, INSTANT_WORK_TOOLS } = await import('../src/host/constants.js')
  assert.ok(TEAM_TOOLS.includes('open_canvas') && TEAM_TOOLS.includes('open_reader'))
  assert.ok(USER_UI_TOOLS.has('open_canvas') && USER_UI_TOOLS.has('open_reader'))
  assert.ok(INSTANT_WORK_TOOLS.has('open_canvas') && INSTANT_WORK_TOOLS.has('open_reader'))
})
