import assert from 'node:assert/strict'
import test from 'node:test'
import { brandHtml, install } from '../src/host/branding.js'
import { installTitle } from '../src/client/branding.js'

test('the browser title stays DS Bot after the host script updates it', () => {
  let callback
  let disconnected = false
  class Observer {
    constructor(fn) { callback = fn }
    observe() {}
    disconnect() { disconnected = true }
  }
  const document = { title: 'DeepSeek Harness', head: { querySelector: () => ({}) } }
  const dispose = installTitle(document, Observer)
  assert.equal(document.title, 'DS Bot')
  document.title = 'DeepSeek Harness'
  callback()
  assert.equal(document.title, 'DS Bot')
  dispose()
  assert.equal(disconnected, true)
})

test('the Web index and install metadata use DS Bot branding', () => {
  const html = brandHtml(`<!doctype html><head>
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-title" content="DSH" />
    <link rel="icon" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>DeepSeek Harness</title>
  </head>`)
  assert.match(html, /<title>DS Bot<\/title>/)
  assert.match(html, /content="DS Bot"/)
  assert.match(html, /href="\.\/ds-bot\/manifest\.webmanifest"/)
  assert.match(html, /href="\.\/ds-bot\/apple-touch-icon\.png"/)
  assert.equal(html.match(/href="\.\/ds-bot\/icon\.svg"/g)?.length, 2)
  assert.doesNotMatch(html, /DeepSeek Harness|content="DSH"/)
})

test('the PWA routes serve a scoped manifest and original DS Bot icons', () => {
  const routes = new Map()
  let transform
  const web = {
    tapIndex(fn) { transform = fn; return () => {} },
    register(route) { routes.set(route.path, route); return () => {} },
  }
  const ctx = { get: name => name === 'webServer' ? web : undefined, effect: fn => fn() }
  install({ ctx })
  assert.equal(typeof transform, 'function')
  for (const path of [
    '/ds-bot/apple-touch-icon.png',
    '/ds-bot/icon.svg',
    '/ds-bot/icon-192.png',
    '/ds-bot/icon-512.png',
    '/ds-bot/icon-maskable-512.png',
    '/ds-bot/manifest.webmanifest',
  ]) assert.ok(routes.has(path), path)
  assert.equal(routes.size, 6)

  let body
  let headers
  routes.get('/ds-bot/manifest.webmanifest').handler({}, {
    writeHead(status, value) { assert.equal(status, 200); headers = value },
    end(value) { body = value },
  })
  assert.equal(headers['Content-Type'], 'application/manifest+json; charset=utf-8')
  const manifest = JSON.parse(body)
  assert.equal(manifest.name, 'DS Bot')
  assert.equal(manifest.short_name, 'DS Bot')
  assert.equal(manifest.start_url, '../')
  assert.equal(manifest.scope, '../')
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512', '512x512'])

  for (const path of routes.keys()) {
    if (path.endsWith('.png')) assert.ok(routes.get(path).handler)
  }
  install({ ctx: { get: () => undefined } })
})
