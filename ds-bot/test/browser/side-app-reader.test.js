import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { install } from '../../src/host/side-app.js'

// Real Chromium evidence for the Reader: the production ReaderView is bundled with
// the real client modules, mounted by React in a browser page, and backed by the real
// host endpoints over a local /api/bot server. The only substitutions are the DSH UI
// primitives (a narrow test implementation) and the composer actions, because there
// is no DeepSeek Harness checkout on this machine to boot the whole shell.
const browserOptions = {
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
}
const workspace = fileURLToPath(new URL('../..', import.meta.url))

async function launchBrowser(t) {
  try {
    return await chromium.launch(browserOptions)
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the reader browser regression')
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-reader-browser-')))
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

async function openReader(rt, root, path) {
  const text = await tool(rt, 'open_reader').execute({ path }, execIn('s1', root))
  return JSON.parse(text.split('\n')[0])
}

// Host the real /api/bot endpoints the client calls. The response shape mirrors
// channel.js closely enough for this focused harness: ok/value or ok:false/error.
async function apiServer(rt) {
  const { createServer } = await import('node:http')
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://reader.invalid')
    if (url.pathname !== '/api/bot' || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const { endpoint, payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      try {
        const value = await rt.sideAppEndpoint(endpoint, payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value }))
      } catch (error) {
        server.errors.push({ endpoint, payload, code: error?.code ?? 'bot/error', message: error?.message ?? 'failed' })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? 'failed' } }))
      }
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.errors = []
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    errors: server.errors,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

async function bundleReaderHarness(t, tab) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-reader-bundle-')))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const entry = join(dir, 'entry.jsx')
  const outfile = join(dir, 'bundle.js')
  writeFileSync(entry, `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ReaderView } from './src/client/reader-app.js'
import { tabFromDescriptor } from './src/client/side-apps.js'

const descriptor = ${JSON.stringify(tab)}
const fileTab = tabFromDescriptor(descriptor)
const drafts = []
const sent = []
window.__readerHarness = { drafts, sent, mode: 'preview' }
function actions() {
  return {
    draftInsert: (sessionId, text) => drafts.push({ sessionId, text }),
    send: async (sessionId, text) => { sent.push({ sessionId, text }) },
    reportError: error => { window.__readerHarness.error = String(error?.message ?? error) },
  }
}
function App() {
  const [mode, setMode] = React.useState('preview')
  window.__readerHarness.setMode = setMode
  return React.createElement(ReaderView, {
    tab: fileTab,
    mode,
    onMode: setMode,
    visible: true,
    actions: actions(),
    openFile: path => { window.__readerHarness.opened = path },
  })
}
createRoot(document.getElementById('root')).render(React.createElement(App))
`)
  const source = readFileSync(entry, 'utf8')
  await build({
    stdin: { contents: source, resolveDir: workspace, loader: 'jsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile,
    logLevel: 'silent',
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('../fixtures/side-app/reader-browser-primitives.js', import.meta.url)),
    },
    define: { 'process.env.NODE_ENV': '"test"' },
  })
  return readFileSync(outfile, 'utf8')
}

const waitFrames = async (page, count = 3) => {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
  }
}

test('the real Reader component reads a workspace image, selects a passage, and fills the chat draft in Chromium', async (t) => {
  const root = tempRoot(t)
  write(root, 'docs/article.md', [
    '# The careful launch checklist',
    '',
    'Opening words.',
    '',
    '![Fixture diagram](img/diagram.png)',
    '',
    '## Editing contract',
    '',
    'The unique passage that should be revised sits here.',
    '',
    'A following paragraph keeps the article long enough for a stable selection.',
  ].join('\n'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  write(root, 'docs/img/diagram.png', png)
  const { rt } = harness({ root })
  const descriptor = await openReader(rt, root, 'docs/article.md')
  const server = await apiServer(rt)
  t.after(server.close)
  const script = await bundleReaderHarness(t, fileBody(descriptor).file)
  const browser = await launchBrowser(t)
  if (browser === undefined) return
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const consoleErrors = []
  page.on('pageerror', error => consoleErrors.push(String(error)))
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of 404/.test(text)) consoleErrors.push(text)
  })
  try {
    await page.goto(`${server.baseUrl}/harness`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>')
    await page.addScriptTag({ content: script })
    await page.locator('.bt-sapp-article').waitFor({ timeout: 8000 })
    try {
      await page.locator('.bt-sapp-figure[data-state="ready"] img').waitFor({ timeout: 8000 })
    } catch (error) {
      const debug = await page.evaluate(() => ({
        body: document.body.innerHTML.slice(0, 3000),
        harness: window.__readerHarness,
        figures: [...document.querySelectorAll('.bt-sapp-figure')].map(node => ({ state: node.getAttribute('data-state'), text: node.textContent, title: node.getAttribute('title') })),
      }))
      debug.hostErrors = server.errors
      throw Object.assign(new Error(`reader image never became ready: ${error.message}\n${JSON.stringify(debug, null, 2)}`), { cause: error })
    }
    assert.match(await page.locator('.bt-sapp-figure img').getAttribute('src'), /^blob:/, 'the article image is a Blob URL, not a network or file path')

    const selectPassage = async () => {
      await page.evaluate(() => {
        const article = document.querySelector('.bt-sapp-article')
        const target = [...article.querySelectorAll('p')].find(node => node.textContent.includes('The unique passage'))
        const textNode = [...target.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('The unique passage'))
        const start = textNode.textContent.indexOf('The unique passage')
        const range = document.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, start + 'The unique passage that should be revised sits here.'.length)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      await page.locator('.bt-sapp-pill', { hasText: 'Ask Bot' }).waitFor({ timeout: 4000 })
    }
    await selectPassage()
    const beforeClick = await page.evaluate(() => ({ selection: String(window.getSelection() ?? ''), pill: document.querySelectorAll('.bt-sapp-pill').length }))
    await page.locator('.bt-sapp-pill').evaluate(node => node.click())
    try {
      await page.locator('.bt-sapp-ask-input').waitFor({ timeout: 4000 })
    } catch (error) {
      const debug = await page.evaluate(() => ({
        portals: [...document.body.children].map(node => ({ tag: node.tagName, cls: node.className, text: node.textContent?.slice(0, 160) })),
        pill: [...document.querySelectorAll('.bt-sapp-pill')].map(node => node.textContent),
        harness: window.__readerHarness,
      }))
      debug.beforeClick = beforeClick
      throw Object.assign(new Error(`ask card did not open: ${error.message}\n${JSON.stringify(debug, null, 2)}`), { cause: error })
    }
    await page.locator('.bt-sapp-ask-input').fill('Tighten this passage.')
    await page.locator('.bt-sapp-ask-actions button', { hasText: 'Add to chat' }).click()
    await waitFrames(page)
    const drafts = await page.evaluate(() => window.__readerHarness.drafts)
    assert.equal(drafts.length, 1, 'Add to chat leaves exactly one composer draft')
    assert.match(drafts[0].text, /^\[Reader revision\] docs\/article\.md §"Editing contract" \(lines 9-9\)/)
    assert.match(drafts[0].text, /> The unique passage that should be revised sits here\./)
    assert.match(drafts[0].text, /Tighten this passage\.$/)
    assert.equal(drafts[0].sessionId, 's1')

    await selectPassage()
    await page.locator('.bt-sapp-pill').evaluate(node => node.click())
    await page.locator('.bt-sapp-ask-input').fill('Send this revision now.')
    await page.locator('.bt-sapp-ask-actions button', { hasText: 'Send' }).click()
    await waitFrames(page)
    const sent = await page.evaluate(() => window.__readerHarness.sent)
    assert.equal(sent.length, 1, 'Send is a separate explicit action')
    assert.match(sent[0].text, /Send this revision now\.$/)
    const meaningfulErrors = consoleErrors.filter(text => !/Illegal invocation/.test(text))
    assert.deepEqual(meaningfulErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`)
  } finally {
    await page.close()
  }
})
