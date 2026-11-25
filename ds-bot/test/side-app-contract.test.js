import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { install } from '../src/host/side-app.js'

// Contract-level host checks on real fixture files. These intentionally overlap the
// implementation's own tests only where the V1 plan makes the behavior an acceptance
// gate: bounds, capability containment, history revalidation and lifecycle pruning.
const fixtureRoot = fileURLToPath(new URL('./fixtures/side-app', import.meta.url))

function harness({ root, webServer, sessionCwd } = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    effect: (execute, label) => { effects.push({ execute, label }) },
    get: name => (name === 'webServer' ? webServer : undefined),
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
    resolveAgent: async id => ({ id, session: { id, header: { cwd: sessionCwd ?? root } } }),
    sessionFolder: session => (session?.id === 's1' ? (sessionCwd ?? root) : undefined),
  }
  install(rt)
  for (const { execute } of effects) execute()
  const fireExecute = async (exec, result) => {
    for (const listener of listeners.get('tools/execute') ?? []) {
      await listener(exec, async () => result)
    }
  }
  return { rt, listeners, effects, fireExecute }
}

function tempRoot(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-side-contract-')))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

function copyFixture(t, name, into = '') {
  const root = tempRoot(t)
  const target = into === '' ? root : join(root, into)
  mkdirSync(target, { recursive: true })
  cpSync(join(fixtureRoot, name), target, { recursive: true })
  return { root, target }
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

test('fixture-backed canvas serves the entry and nested allowed assets', async (t) => {
  const { root, target: site } = copyFixture(t, 'canvas-basic', 'site')
  const { rt } = harness({ root })
  const entryReal = await realpath(join(site, 'index.html'))
  const ticket = rt.sideAppInternals.issueTicket({ entryReal, displayPath: 'site/index.html', sessionId: 's1' })
  const serve = path => rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/${path}`)
  for (const [path, type] of [
    ['index.html', 'text/html; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['nested/extra.js', 'text/javascript; charset=utf-8'],
    ['assets/badge.svg', 'image/svg+xml'],
  ]) {
    const response = await serve(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), type, path)
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/, path)
  }
})

test('fixture-backed sensitive neighbors are never served, even with allowed extensions', async (t) => {
  const { root, target: site } = copyFixture(t, 'canvas-sensitive', 'site')
  const { rt } = harness({ root })
  const entryReal = await realpath(join(site, 'entry.html'))
  const ticket = rt.sideAppInternals.issueTicket({ entryReal, displayPath: 'site/entry.html', sessionId: 's1' })
  const serve = path => rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/${path}`)
  assert.equal((await serve('visible.css')).status, 200)
  assert.equal((await serve('visible.js')).status, 200)
  for (const path of ['.env', 'credentials.json', 'server-key.pem', 'nested/../credentials.json']) {
    assert.equal((await serve(path)).status, 404, path)
  }
})

test('a junction inside the asset tree cannot escape to a real file outside it', async (t) => {
  const { root, target: site } = copyFixture(t, 'canvas-sensitive', 'site')
  write(root, 'secret.html', '<h1>outside secret</h1>')
  const link = join(site, 'linked')
  let made = false
  try {
    symlinkSync(root, link, 'junction')
    made = true
  } catch {
    try {
      symlinkSync(root, link, 'dir')
      made = true
    } catch { /* Windows can refuse both without developer mode */ }
  }
  if (!made) {
    t.skip('directory links are unavailable here')
    return
  }
  const { rt } = harness({ root })
  const entryReal = await realpath(join(site, 'entry.html'))
  const ticket = rt.sideAppInternals.issueTicket({ entryReal, displayPath: 'site/entry.html', sessionId: 's1' })
  const response = await rt.sideAppInternals.serveAsset(ticket, `/api/bot-canvas/${ticket.id}/linked/secret.html`)
  assert.equal(response.status, 404)
})

test('the registered canvas route answers GET and HEAD, rejects writes and expires cleanly', async (t) => {
  const { root } = copyFixture(t, 'canvas-basic', 'site')
  let handler
  const webServer = {
    register(route) {
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, '/api/bot-canvas')
      handler = route.handler
      return () => {}
    },
    getOrigin: () => 'http://unit.test',
  }
  const { rt } = harness({ root, webServer })
  assert.equal(typeof handler, 'function', 'the route registers when webServer is present')
  const answer = (method, pathname) => new Promise((resolvePromise, reject) => {
    const chunks = []
    const res = {
      status: undefined,
      headers: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
        resolvePromise({ status: this.status, headers: this.headers ?? {}, body: Buffer.concat(chunks) })
      },
    }
    Promise.resolve(handler({ method, url: pathname }, res)).catch(reject)
  })
  const descriptor = await openWithTool(rt, root, 'site/index.html')
  const preview = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor))
  const url = new URL(preview.frameUrl)
  const get = await answer('GET', url.pathname)
  assert.equal(get.status, 200)
  assert.match(get.body.toString('utf8'), /Draft counter/)
  const head = await answer('HEAD', url.pathname)
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], get.headers['content-length'])
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const denied = await answer(method, url.pathname)
    assert.equal(denied.status, 405, method)
    assert.equal(denied.headers.allow, 'GET, HEAD')
  }
  const ticket = [...rt.sideAppInternals.tickets.values()][0]
  ticket.expiresAt = Date.now() - 1
  const expired = await answer('GET', url.pathname)
  assert.equal(expired.status, 404)
})

test('text and HTML size boundaries follow the V1 contract', async (t) => {
  const root = tempRoot(t)
  const html = size => `<${'a'.repeat(Math.max(0, size - 2))}>`
  write(root, 'exact4.html', html(4 * 1024 * 1024))
  write(root, 'over4.html', html(4 * 1024 * 1024 + 1))
  write(root, 'over8.html', html(8 * 1024 * 1024 + 1))
  write(root, 'exact4.md', 'a'.repeat(4 * 1024 * 1024))
  const { rt } = harness({ root })

  const exact = await openWithTool(rt, root, 'exact4.html')
  const exactOpen = await rt.sideAppEndpoint('side-app-open', { ...fileBody(exact), app: 'canvas' })
  assert.equal(exactOpen.size, 4 * 1024 * 1024)
  assert.equal(exactOpen.textLimited, false)
  const exactRead = await rt.sideAppEndpoint('side-app-read', fileBody(exact))
  assert.equal(exactRead.kind, 'text')

  const over4 = await openWithTool(rt, root, 'over4.html')
  const over4Open = await rt.sideAppEndpoint('side-app-open', { ...fileBody(over4), app: 'canvas' })
  assert.equal(over4Open.previewAvailable, true)
  assert.equal(over4Open.textLimited, true)
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(over4)), error => error?.code === 'bot/too-large' && /4 MiB/.test(error.message))

  const md = await openWithTool(rt, root, 'exact4.md', 'open_reader')
  const mdRead = await rt.sideAppEndpoint('side-app-read', fileBody(md))
  assert.equal(mdRead.kind, 'text')

  assert.match(await tool(rt, 'open_canvas').execute({ path: 'over8.html' }, execIn('s1', root)), /larger than the 8 MiB Canvas limit/)
})

test('authorization accepts current and past session ownership, then rejects tag and cwd rebinding', async (t) => {
  const { root } = copyFixture(t, 'reader-long')
  const otherRoot = tempRoot(t)
  const { rt } = harness({ root })
  rt.pastOwners.set('old-part', { botId: 'b1' })
  const live = await openWithTool(rt, root, 'article.md', 'open_reader')
  const historical = { ...live, sessionId: 'old-part' }
  const read = await rt.sideAppEndpoint('side-app-read', fileBody(historical))
  assert.equal(read.kind, 'text')

  const stale = { ...historical, workspaceTag: 'not-the-current-root' }
  await assert.rejects(rt.sideAppEndpoint('side-app-read', fileBody(stale)), error => error?.code === 'bot/workspace-changed')

  const rebound = harness({ root, sessionCwd: otherRoot })
  rebound.rt.pastOwners.set('old-part', { botId: 'b1' })
  await assert.rejects(rebound.rt.sideAppEndpoint('side-app-read', fileBody(historical)), error => error?.code === 'bot/workspace-changed')
})

test('opening through data roots and malformed descriptors is refused uniformly', async (t) => {
  const { root } = copyFixture(t, 'reader-long')
  const { rt } = harness({ root })
  rt.inData = async path => path.endsWith('article.md')
  assert.match(await tool(rt, 'open_reader').execute({ path: 'article.md' }, execIn('s1', root)), /inside DeepSeek Harness or team data/)
  const descriptor = await openWithTool(rt, root, 'alias.markdown', 'open_reader')
  const valid = fileBody(descriptor).file
  await assert.rejects(rt.sideAppEndpoint('side-app-read', { file: { ...valid, displayPath: '' } }), error => error?.code === 'bot/invalid')
  await assert.rejects(rt.sideAppEndpoint('side-app-read', { file: { ...valid, workspaceTag: '' } }), error => error?.code === 'bot/workspace-changed')
  await assert.rejects(rt.sideAppEndpoint('side-app-read', { file: { ...valid, sessionId: 'unknown' } }), error => error?.code === 'bot/not-found')
})

test('diff bases are retained per time and merged only for a known shared turn', async (t) => {
  const root = tempRoot(t)
  const { rt, fireExecute } = harness({ root })
  write(root, 'a.html', 'a0')
  write(root, 'b.html', 'b0')
  const execFor = path => ({ name: 'edit', arguments: { file_path: path }, agent: { id: 's1', session: { id: 's1', header: { cwd: root } } } })
  rt.live.set('s1', { turn: 9 })
  await fireExecute(execFor('a.html'), { value: { before: 'a0', after: 'a1' } })
  await fireExecute(execFor('a.html'), { value: { before: 'a1', after: 'a2' } })
  let entry = [...rt.sideAppInternals.diffBases.values()].find(item => item.realPath.endsWith('a.html'))
  assert.equal(entry.before, 'a0', 'same-turn writes merge from the first before')
  assert.equal(entry.after, 'a2', 'same-turn writes merge to the last after')

  rt.live.set('s1', { turn: 10 })
  await fireExecute(execFor('a.html'), { value: { before: 'a2', after: 'a3' } })
  entry = [...rt.sideAppInternals.diffBases.values()].find(item => item.realPath.endsWith('a.html'))
  assert.equal(entry.before, 'a2', 'a new turn starts a fresh base instead of extending the old one')
  assert.equal(entry.after, 'a3')

  for (const stale of rt.sideAppInternals.diffBases.values()) stale.at = Date.now() - 61 * 60_000
  await writeFile(join(root, 'b.html'), 'b-live')
  await fireExecute(execFor('b.html'), { value: { before: 'b0', after: 'b1' } })
  assert.equal(rt.sideAppInternals.diffBases.size, 1, 'stale bases are swept while the fresh one is kept')
  assert.equal([...rt.sideAppInternals.diffBases.values()][0].realPath.endsWith('b.html'), true)
})

test('preview tickets bind to one entry directory and cannot be transferred across sessions or files', async (t) => {
  const { root, target: site } = copyFixture(t, 'canvas-basic', 'site')
  write(root, 'other/other.html', '<h1>other</h1>')
  const { rt } = harness({ root })
  const firstReal = await realpath(join(site, 'index.html'))
  const otherReal = await realpath(join(root, 'other', 'other.html'))
  const first = rt.sideAppInternals.issueTicket({ entryReal: firstReal, displayPath: 'site/index.html', sessionId: 's1' })
  const other = rt.sideAppInternals.issueTicket({ entryReal: otherReal, displayPath: 'other/other.html', sessionId: 's1' })
  assert.equal((await rt.sideAppInternals.serveAsset(first, `/api/bot-canvas/${first.id}/other/other.html`)).status, 404)
  assert.equal((await rt.sideAppInternals.serveAsset(other, `/api/bot-canvas/${other.id}/site/index.html`)).status, 404)
  assert.equal(rt.sideAppInternals.renewTicket(first.id, 's2'), undefined)
  assert.notEqual(first.id, other.id)
  assert.match(first.id, /^[A-Za-z0-9_-]{32}$/)
})

test('fixture reader files exercise the extension matrix without weakening .txt refusal', async (t) => {
  const { root } = copyFixture(t, 'reader-long')
  const { rt } = harness({ root })
  for (const [path, ext] of [['article.md', '.md'], ['alias.markdown', '.markdown'], ['component.mdx', '.mdx']]) {
    const descriptor = await openWithTool(rt, root, path, 'open_reader')
    assert.equal(descriptor.app, 'reader')
    const opened = await rt.sideAppEndpoint('side-app-open', { ...fileBody(descriptor), app: 'reader' })
    assert.equal(opened.extension, ext)
  }
  assert.match(await tool(rt, 'open_reader').execute({ path: 'notes.txt' }, execIn('s1', root)), /Reader opens Markdown files/)
})
