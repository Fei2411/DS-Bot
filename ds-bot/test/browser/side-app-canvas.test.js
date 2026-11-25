import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { install } from '../../src/host/side-app.js'

// Real Chromium evidence for the Canvas shell: the host's ticketed route serves a
// real fixture into a real iframe using the same sandbox flags the app sets. This is
// not the full DS Bot shell (no bench checkout exists on this machine); it proves the
// browser-visible isolation and resource contract the panel relies on.
const fixtureRoot = fileURLToPath(new URL('../fixtures/side-app', import.meta.url))
const browserOptions = {
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
}

async function launchBrowser(t) {
  try {
    return await chromium.launch(browserOptions)
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the canvas browser regression')
      return undefined
    }
    throw error
  }
}

function harness({ root }) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    effect: (execute, label) => { effects.push({ execute, label }) },
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
  for (const { execute } of effects) execute()
  return { rt }
}

function tempRoot(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-canvas-browser-')))
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

const tool = (rt, name) => rt.teamTools.find(entry => entry.name === name)
const execIn = (sessionId, root) => ({ agent: { id: sessionId, session: { id: sessionId, header: { cwd: root } } }, callId: 'c1' })
const fileBody = (descriptor, extra = {}) => ({ file: { app: descriptor.app, sessionId: descriptor.sessionId, displayPath: descriptor.displayPath, workspaceTag: descriptor.workspaceTag }, ...extra })

async function openCanvas(rt, root, path) {
  const text = await tool(rt, 'open_canvas').execute({ path }, execIn('s1', root))
  return JSON.parse(text.split('\n')[0])
}

// Serve exactly what the registered webServer handler would, with the ticket still
// checked by the host. Requests outside that handler are logged as external probes.
async function canvasServer(rt) {
  const { createServer } = await import('node:http')
  const external = []
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://canvas.invalid')
    if (!url.pathname.startsWith('/api/bot-canvas/')) {
      external.push(`${req.method} ${url.pathname}`)
      res.writeHead(599, { 'content-type': 'text/plain' })
      res.end('external probe')
      return
    }
    const segments = url.pathname.slice('/api/bot-canvas'.length).split('/').filter(part => part !== '')
    const ticket = rt.sideAppInternals.tickets.get(segments[0] ?? '')
    if (ticket === undefined || ticket.expiresAt <= Date.now() || segments.length < 2) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('expired')
      return
    }
    const response = await rt.sideAppInternals.serveAsset(ticket, url.pathname)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    if (String(req.method).toUpperCase() === 'HEAD') {
      res.end()
      return
    }
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    external,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

test('a real canvas iframe loads same-directory assets and scripts but keeps network, forms, top access and external images shut', async (t) => {
  const { root } = copyFixture(t, 'canvas-basic', 'site')
  const { rt } = harness({ root })
  const descriptor = await openCanvas(rt, root, 'site/index.html')
  const preview = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor))
  assert.equal(preview.kind, 'preview')
  const server = await canvasServer(rt)
  t.after(server.close)
  const browser = await launchBrowser(t)
  if (browser === undefined) return
  t.after(() => browser.close())

  const framePath = preview.frameUrl.startsWith('/') ? preview.frameUrl : new URL(preview.frameUrl).pathname
  const frameUrl = `${server.baseUrl}${framePath}?r=${encodeURIComponent(preview.previewRevision)}`
  const page = await browser.newPage()
  const failedRequests = []
  page.on('requestfailed', request => failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`))
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><iframe title="Canvas preview" sandbox="allow-scripts" src="${frameUrl}"></iframe>`, { waitUntil: 'load' })
    const frame = page.frameLocator('iframe[title="Canvas preview"]')
    await frame.locator('body[data-fixture-ready="app"]').waitFor({ timeout: 5000 })
    await frame.locator('body[data-fixture-nested="loaded"]').waitFor({ timeout: 5000 })
    assert.equal(await frame.locator('body').evaluate(node => node.dataset.inlineReady), 'yes', 'inline scripts still run')
    assert.equal(await frame.locator('body').evaluate(node => node.dataset.topAccess), 'blocked', 'the sandbox has no same-origin access to the parent')
    await frame.locator('#increment').click()
    assert.equal(await frame.locator('body').evaluate(node => node.dataset.fixtureClicks), '1', 'the same-directory app.js ran and stayed interactive')
    assert.match(await frame.locator('body').evaluate(node => getComputedStyle(node.querySelector('.shell')).borderRadius), /18px/, 'the same-directory stylesheet applied')
    await frame.locator('body').evaluate(() => window.probeNetwork())
    await frame.locator('body[data-fetch-result]').waitFor({ timeout: 5000 })
    assert.equal(await frame.locator('body').evaluate(node => node.dataset.fetchResult), 'rejected', 'connect-src none rejects fetch')
    assert.equal(server.external.length, 0, 'no external network request left the browser context')
    await frame.locator('#submit-probe').click({ force: true })
    await page.waitForTimeout(300)
    assert.equal(await frame.locator('body').evaluate(node => node.dataset.formSubmitted ?? 'no'), 'no', 'form submission stays blocked')
    assert.equal(await frame.locator('#external-image').evaluate(node => node.complete && node.naturalWidth > 0), false, 'external images do not load')
    assert.equal(failedRequests.some(entry => entry.includes('external.invalid')), true, `the external probes were attempted and blocked by the browser: ${failedRequests.join(' | ')}`)
  } finally {
    await page.close()
  }
})

test('an expired canvas ticket in a real browser shows the unavailable page rather than the file', async (t) => {
  const { root } = copyFixture(t, 'canvas-basic', 'site')
  const { rt } = harness({ root })
  const descriptor = await openCanvas(rt, root, 'site/index.html')
  const preview = await rt.sideAppEndpoint('side-app-preview', fileBody(descriptor))
  const server = await canvasServer(rt)
  t.after(server.close)
  const browser = await launchBrowser(t)
  if (browser === undefined) return
  t.after(() => browser.close())
  const ticket = [...rt.sideAppInternals.tickets.values()][0]
  ticket.expiresAt = Date.now() - 1
  const page = await browser.newPage()
  try {
    const framePath = preview.frameUrl.startsWith('/') ? preview.frameUrl : new URL(preview.frameUrl).pathname
    await page.goto(`${server.baseUrl}${framePath}`)
    assert.match(await page.locator('body').textContent(), /expired|no longer available/i)
    assert.equal(await page.locator('h1').count(), 0, 'the draft itself is not served after expiry')
  } finally {
    await page.close()
  }
})
