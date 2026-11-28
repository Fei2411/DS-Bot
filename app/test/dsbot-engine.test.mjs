import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as enginePlugin from '../engine/index.js'
import { createUiPluginsResource, discoverUiPlugins, inspectPackageUiMeta } from '../engine/ui-plugins.js'

const { createUiResource, resolveDistDir, shouldUseNativeDirectoryPicker } = enginePlugin

describe('dsbot-engine UI static resource', () => {
  let root
  let distDir
  let secretFile

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-engine-ui-'))
    distDir = join(root, 'dist')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>DS Bot</title><div id="root"></div>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("ok")')
    writeFileSync(join(distDir, 'assets', 'app.css'), 'body{margin:0}')
    secretFile = join(root, 'secret.txt')
    writeFileSync(secretFile, 'do-not-serve')
    try {
      symlinkSync(secretFile, join(distDir, 'assets', 'leak.js'))
    } catch { /* symlink unsupported on restricted Windows runners */ }
  })

  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('gates index & HTML requests case-insensitively and blocks NTFS aliases / symlink escapes', async () => {
    let authCalls = 0
    const resource = createUiResource({
      distDir,
      authorizeIndex: (request) => {
        authCalls += 1
        const url = new URL(request.url)
        if (url.searchParams.get('token') === 'good') {
          return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': 'dsh=1; HttpOnly' } })
        }
        if (request.headers.get('cookie') === 'dsh=1') return undefined
        return new Response('unauthorized', { status: 401 })
      },
    })

    // Unauthenticated index -> 401.
    const unauth = await resource(new Request('http://127.0.0.1:4123/'))
    assert.equal(unauth.status, 401)
    assert.equal(authCalls, 1)

    // Launch token exchange -> 302 with cookie.
    const exchange = await resource(new Request('http://127.0.0.1:4123/?token=good'))
    assert.equal(exchange.status, 302)
    assert.equal(exchange.headers.get('location'), '/')
    assert.equal(exchange.headers.get('set-cookie'), 'dsh=1; HttpOnly')

    // Authenticated index -> 200 HTML, no-store, nosniff.
    const indexRes = await resource(new Request('http://127.0.0.1:4123/', { headers: { cookie: 'dsh=1' } }))
    assert.equal(indexRes.status, 200)
    assert.equal(indexRes.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(indexRes.headers.get('cache-control'), 'no-store')
    assert.equal(indexRes.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await indexRes.text(), /DS Bot/)

    // Direct /index.html and case variants (/Index.html, /INDEX.HTML) MUST run authorizeIndex (never fall through).
    for (const path of ['/index.html', '/Index.html', '/INDEX.HTML', '/other.html']) {
      const res = await resource(new Request(`http://127.0.0.1:4123${path}`))
      assert.equal(res.status, 401, `${path} without auth must return 401`)
    }
    const authCase = await resource(new Request('http://127.0.0.1:4123/Index.html', { headers: { cookie: 'dsh=1' } }))
    assert.equal(authCase.status, 200)
    assert.equal(authCase.headers.get('cache-control'), 'no-store')

    // Windows NTFS filename aliases, Alternate Data Streams, backslashes, and leading double-slash are blocked.
    for (const bad of [
      '/index.html.',
      '/index.html%20',
      '/index.html::$DATA',
      '/%5cindex.html',
      '//index.html',
    ]) {
      const res = await resource(new Request(`http://127.0.0.1:4123${bad}`))
      assert.equal(res.status, 403, `${bad} must be rejected with 403`)
    }

    // Symlink escaping distDir is rejected via realpath containment.
    if (process.platform !== 'win32') {
      const symRes = await resource(new Request('http://127.0.0.1:4123/assets/leak.js'))
      assert.equal(symRes.status, 403, 'symlink pointing outside distDir must return 403')
    }

    // HEAD returns headers and an empty body.
    const headRes = await resource(new Request('http://127.0.0.1:4123/', { method: 'HEAD', headers: { cookie: 'dsh=1' } }))
    assert.equal(headRes.status, 200)
    assert.equal(await headRes.text(), '')
  })

  test('serves static assets with MIME types, weak ETags, RFC 9110 304 lists, and blocks traversal/bad methods', async () => {
    const resource = createUiResource({ distDir, authorizeIndex: () => undefined })

    const jsRes = await resource(new Request('http://127.0.0.1:4123/assets/app.js'))
    assert.equal(jsRes.status, 200)
    assert.equal(jsRes.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(jsRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(jsRes.headers.get('cache-control'), 'no-cache')
    const etag = jsRes.headers.get('etag')
    assert.match(etag, /^W\/"[^"]+"$/)
    assert.equal(await jsRes.text(), 'console.log("ok")')

    // Matching ETag (exact, comma-separated list, and `*`) returns 304 without body.
    for (const inm of [etag, `W/"other", ${etag}`, '*']) {
      const notMod = await resource(new Request('http://127.0.0.1:4123/assets/app.js', { headers: { 'if-none-match': inm } }))
      assert.equal(notMod.status, 304, `If-None-Match: ${inm} must return 304`)
      assert.equal(await notMod.text(), '')
    }

    // CSS MIME check.
    const cssRes = await resource(new Request('http://127.0.0.1:4123/assets/app.css'))
    assert.equal(cssRes.status, 200)
    assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8')

    // Missing file -> 404; directory -> 404; trailing slash on non-root path -> 404.
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets/missing.js'))).status, 404)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets'))).status, 404)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/other.html/'))).status, 404)

    // Path traversal (encoded ..%2f surviving URL normalization) -> 403; malformed URI / null byte -> 400; POST -> 405.
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets/..%2f..%2fsecret.txt'))).status, 403)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/%2e%2e/secret.txt'))).status, 404)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/%E0%A4%A'))).status, 400)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets/app.js%00.png'))).status, 400)
    const postRes = await resource(new Request('http://127.0.0.1:4123/', { method: 'POST' }))
    assert.equal(postRes.status, 405)
    assert.equal(postRes.headers.get('allow'), 'GET, HEAD')
  })

  test('resolveDistDir honors explicit config, DS_BOT_UI_DIR env, and node_modules/engine layouts', () => {
    assert.equal(resolveDistDir({ distDir: '/custom/ui' }, { env: {} }), resolve('/custom/ui'))
    assert.equal(resolveDistDir({}, { env: { DS_BOT_UI_DIR: '/env/ui' } }), resolve('/env/ui'))

    const nmModule = pathToFileURL(join(root, 'app', 'node_modules', 'dsbot-engine', 'index.js')).href
    const nmDist = join(root, 'app', 'ui', 'dist')
    assert.equal(
      resolveDistDir({}, { env: {}, moduleUrl: nmModule, exists: p => p === join(nmDist, 'index.html') }),
      nmDist,
    )

    const directModule = pathToFileURL(join(root, 'app', 'engine', 'index.js')).href
    assert.equal(
      resolveDistDir({}, { env: {}, moduleUrl: directModule, exists: p => p === join(nmDist, 'index.html') }),
      nmDist,
    )
  })

  test('shouldUseNativeDirectoryPicker picks native on macOS/Windows or Linux with chooser, browse otherwise', () => {
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'darwin', env: {} }), true)
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'win32', env: {} }), true)
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'linux', env: { PATH: '/usr/bin' }, executable: () => true }), false)
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'linux', env: { DISPLAY: ':0', PATH: '/usr/bin' }, executable: () => false }), false)
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'linux', env: { DISPLAY: ':0', PATH: '/usr/bin' }, executable: f => f.endsWith('zenity') }), true)
    assert.equal(shouldUseNativeDirectoryPicker({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', PATH: '/usr/bin' }, executable: f => f.endsWith('kdialog') }), true)
  })

  test('apply(ctx, config) integrates with real WebServer + HostConnectionService (cookie exchange, route precedence, host-only directoryPicker)', async () => {
    const ctx = new Context()
    const records = new Map()
    ctx.provide('credentials', {
      modifyRecord: async (key, fn) => {
        const next = await fn(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
    })
    const uiPluginsDir = join(root, 'live-ui-plugins')
    mkdirSync(join(uiPluginsDir, 'demo-skin'), { recursive: true })
    writeFileSync(join(uiPluginsDir, 'demo-skin', 'manifest.json'), JSON.stringify({
      id: 'demo-skin',
      name: 'Demo Skin',
      entry: './index.js',
    }))
    writeFileSync(join(uiPluginsDir, 'demo-skin', 'index.js'), 'export function apply() {}')
    try {
      const ws = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const conn = ctx.plugin(connectionPlugin, { trustedHosts: [] })
      const eng = ctx.plugin(enginePlugin, { distDir, uiPluginsDir })
      await Promise.all([ws.await(), conn.await(), eng.await()])
      // Wait one turn for child plugin (`NativeDirectoryPicker`/`BrowseDirectoryPicker`) mounted inside `eng`.
      await new Promise(resolve => setImmediate(resolve))

      // Host-only directoryPicker is registered without mounting any client UI rows.
      const cap = ctx.get('directoryPicker')?.capability()
      assert.ok(cap && (cap.kind === 'native' || cap.kind === 'browse'), 'host directoryPicker capability must be registered')

      // Exact route (/api/bot) outranks the UI fallback.
      const stopApi = ctx.connection.fetch.register({
        path: '/api/bot',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => new Response(JSON.stringify({ ok: true, value: { ping: 'pong' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      })
      try {
        const launchUrl = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
        const origin = new URL(launchUrl).origin

        // 1. Unauthenticated / and /Index.html both return 401.
        assert.equal((await fetch(`${origin}/`)).status, 401)
        assert.equal((await fetch(`${origin}/Index.html`)).status, 401)

        // 2. Real launch token exchanges for HttpOnly cookie + 303 redirect to /.
        const exchange = await fetch(launchUrl, { redirect: 'manual' })
        assert.equal(exchange.status, 303)
        const setCookie = exchange.headers.get('set-cookie')
        assert.ok(setCookie, 'launch token exchange must set session cookie')
        const cookie = setCookie.split(';')[0]

        // 3. Authenticated / serves index.html with no-store; /assets/app.js serves JS.
        const htmlRes = await fetch(`${origin}/`, { headers: { cookie } })
        assert.equal(htmlRes.status, 200)
        assert.equal(htmlRes.headers.get('cache-control'), 'no-store')
        assert.match(await htmlRes.text(), /DS Bot/)

        const assetRes = await fetch(`${origin}/assets/app.js`)
        assert.equal(assetRes.status, 200)
        assert.equal(await assetRes.text(), 'console.log("ok")')

        // 4. POST /api/bot reaches the registered route instead of the fallback's 405.
        const apiRes = await fetch(`${origin}/api/bot`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', origin },
          body: JSON.stringify({ endpoint: 'ping', payload: {} }),
        })
        assert.equal(apiRes.status, 200)
        assert.deepEqual(await apiRes.json(), { ok: true, value: { ping: 'pong' } })

        // 5. /api/ui-plugins/* outranks connection's /api prefix, enforces Host/Origin/CSRF/owner fences, and serves local UI plugins.
        assert.equal((await fetch(`${origin}/api/ui-plugins/manifest`)).status, 401)
        assert.equal((await fetch(`${origin}/api/ui-plugins/manifest?token=bad`, { headers: { cookie } })).status, 401)
        assert.equal((await fetch(`${origin}/api/ui-plugins/manifest`, {
          headers: { cookie, 'sec-fetch-site': 'cross-site' },
        })).status, 403, 'cross-site Sec-Fetch-Site must be rejected by connection.admit')
        assert.equal((await fetch(`${origin}/api/ui-plugins/manifest`, {
          headers: { cookie, origin: 'https://evil.example' },
        })).status, 403, 'foreign Origin must be rejected by connection.admit')
        const badHostStatus = await new Promise((resolveStatus, rejectReq) => {
          const req = http.request({
            host: '127.0.0.1',
            port: ctx.webServer.port,
            path: '/api/ui-plugins/manifest',
            method: 'GET',
            headers: { host: 'evil.example', cookie },
          }, (res) => {
            res.resume()
            resolveStatus(res.statusCode)
          })
          req.on('error', rejectReq)
          req.end()
        })
        assert.equal(badHostStatus, 403, 'untrusted Host header must be rejected (DNS rebinding fence)')

        // Non-owner peer passed through WebServer.readResource must be denied with 403; owner peer succeeds.
        const nonOwnerRes = await ctx.webServer.readResource(
          new Request(`${origin}/api/ui-plugins/manifest`),
          { principal: { kind: 'guest' } },
        )
        assert.equal(nonOwnerRes.status, 403, 'non-owner peer must be denied')
        const ownerPeerRes = await ctx.webServer.readResource(
          new Request(`${origin}/api/ui-plugins/manifest`),
          { principal: { kind: 'owner' } },
        )
        assert.equal(ownerPeerRes.status, 200, 'owner peer must succeed')

        const manifestRes = await fetch(`${origin}/api/ui-plugins/manifest`, { headers: { cookie } })
        assert.equal(manifestRes.status, 200)
        const manifest = await manifestRes.json()
        assert.equal(manifest.plugins.length, 1)
        assert.equal(manifest.plugins[0].id, 'local:demo-skin')
        const entryRes = await fetch(`${origin}${manifest.plugins[0].url}`, { headers: { cookie } })
        assert.equal(entryRes.status, 200)
        assert.match(await entryRes.text(), /export function apply/)
      } finally {
        stopApi?.()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  test('discoverUiPlugins and /api/ui-plugins serve local themes, ESM plugins, and dsBot.ui bundles safely with auth and containment', async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'ds-bot-ui-plugins-'))
    try {
      const uiDir = join(pluginRoot, 'ui-plugins')
      const themeDir = join(uiDir, 'ocean-skin')
      const esmDir = join(uiDir, 'hello-widget')
      const badDir = join(uiDir, 'broken-plugin')
      const symManifestDir = join(uiDir, 'symlink-manifest')
      const bundleDir = join(pluginRoot, 'bundle-with-ui')
      const scopedBundleDir = join(pluginRoot, 'scoped-bundle-with-ui')
      const outsideFile = join(pluginRoot, 'outside.js')
      const outsideManifest = join(pluginRoot, 'outside-manifest.json')
      mkdirSync(themeDir, { recursive: true })
      mkdirSync(esmDir, { recursive: true })
      mkdirSync(badDir, { recursive: true })
      mkdirSync(join(bundleDir, 'ui'), { recursive: true })
      mkdirSync(join(scopedBundleDir, 'ui'), { recursive: true })
      writeFileSync(outsideFile, 'export const leak = true')
      writeFileSync(outsideManifest, JSON.stringify({ id: 'escaped', name: 'Escaped', entry: './index.js' }))
      let createdManifestSymlink = false
      if (process.platform !== 'win32') {
        mkdirSync(symManifestDir, { recursive: true })
        try {
          symlinkSync(outsideManifest, join(symManifestDir, 'manifest.json'))
          createdManifestSymlink = true
        } catch { /* symlink unsupported */ }
      }

      writeFileSync(join(themeDir, 'manifest.json'), JSON.stringify({
        id: 'ocean-skin',
        name: 'Ocean Skin',
        theme: {
          id: 'ocean',
          label: 'Ocean',
          light: { bg: '#f4f8fc', sidebar: '#e9f1f8', bubble: '#dfeaf5', card: '#ffffff', text: '#102030', user: '#1d4ed8', userText: '#ffffff', accent: '#2563eb' },
          dark: { bg: '#0c1420', sidebar: '#121d2e', bubble: '#192840', card: '#142033', text: '#e8f0fa', user: '#3b82f6', userText: '#ffffff', accent: '#60a5fa' },
          css: '.bt-bubble { letter-spacing: 0.01em; }',
        },
      }))
      writeFileSync(join(esmDir, 'manifest.json'), JSON.stringify({
        id: 'hello-widget',
        name: 'Hello Widget',
        entry: './index.js',
        pages: ['chat'],
      }))
      writeFileSync(join(esmDir, 'index.js'), 'export function apply(ctx) { return () => {} }')
      writeFileSync(join(esmDir, 'notes.txt'), 'not allowed mime')
      try { symlinkSync(outsideFile, join(esmDir, 'escape.js')) } catch { /* Windows without symlink perms */ }

      // Broken plugin manifest must surface an error record without aborting other plugins.
      writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ id: 'broken-plugin', entry: '../outside.js' }))

      // Enabled profile bundles with dsBot.ui (unscoped + scoped @scope/pkg)
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: 'community-desktop-ext',
        dsBot: { ui: { entry: './ui/panel.js', name: 'Community Panel' } },
      }))
      writeFileSync(join(bundleDir, 'ui', 'panel.js'), 'export function apply() {}')
      writeFileSync(join(scopedBundleDir, 'package.json'), JSON.stringify({
        name: '@scope/desktop-skin',
        dsBot: { ui: { entry: './ui/index.js', name: 'Scoped Skin' } },
      }))
      writeFileSync(join(scopedBundleDir, 'ui', 'index.js'), 'export function apply() { return "scoped" }')

      assert.equal(inspectPackageUiMeta(bundleDir).hasDshClient, false)
      assert.equal(inspectPackageUiMeta(bundleDir).dsBotUi?.entry, './ui/panel.js')

      const snapshot = await discoverUiPlugins({
        uiPluginsDir: uiDir,
        bundles: [
          { name: 'community-desktop-ext', enabled: true },
          { name: '@scope/desktop-skin', enabled: true },
          { name: 'disabled-desktop-ext', enabled: false },
        ],
        resolveBundleDir: (name) => {
          if (name === 'community-desktop-ext') return bundleDir
          if (name === '@scope/desktop-skin') return scopedBundleDir
          return null
        },
      })

      const expectedCount = createdManifestSymlink ? 6 : 5
      assert.equal(snapshot.plugins.length, expectedCount)
      const ocean = snapshot.plugins.find(p => p.id === 'local:ocean-skin')
      assert.equal(ocean?.kind, 'theme')
      assert.equal(ocean?.theme?.id, 'ocean')
      const widget = snapshot.plugins.find(p => p.id === 'local:hello-widget')
      assert.equal(widget?.kind, 'esm')
      assert.equal(widget?.url, '/api/ui-plugins/files/local%3Ahello-widget/index.js')
      const broken = snapshot.plugins.find(p => p.id === 'local:broken-plugin')
      assert.ok(broken?.error)
      if (createdManifestSymlink) {
        const symManifestRec = snapshot.plugins.find(p => p.id === 'local:symlink-manifest')
        assert.ok(symManifestRec?.error, 'symlinked manifest.json pointing outside plugin folder must fail with error')
        assert.equal(symManifestRec?.url, undefined)
      }
      const bundleUi = snapshot.plugins.find(p => p.id === 'bundle:community-desktop-ext')
      assert.equal(bundleUi?.source, 'bundle')
      assert.equal(bundleUi?.url, '/api/ui-plugins/files/bundle%3Acommunity-desktop-ext/ui/panel.js')
      const scopedUi = snapshot.plugins.find(p => p.id === 'bundle:@scope/desktop-skin')
      assert.equal(scopedUi?.source, 'bundle')
      assert.equal(scopedUi?.url, '/api/ui-plugins/files/bundle%3A%40scope%2Fdesktop-skin/ui/index.js')

      const authGate = request => (request.headers.get('cookie') === 'dsh=1' ? undefined : new Response('unauthorized', { status: 401 }))
      const uiPluginsResource = createUiPluginsResource({
        getSnapshot: async () => snapshot,
        authorizeRequest: authGate,
      })
      const resource = createUiResource({ distDir, authorizeIndex: authGate, uiPluginsResource })

      // Unauthenticated, query-token, and non-owner peer requests to /api/ui-plugins/* must be rejected.
      assert.equal((await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/manifest'))).status, 401)
      assert.equal((await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/manifest?token=good', { headers: { cookie: 'dsh=1' } }))).status, 401)
      assert.equal((await uiPluginsResource(new Request('http://127.0.0.1:4123/api/ui-plugins/manifest'), { principal: { kind: 'guest' } })).status, 403)
      assert.equal((await uiPluginsResource(new Request('http://127.0.0.1:4123/api/ui-plugins/manifest'), { principal: { kind: 'owner' } })).status, 200)

      // Authenticated manifest returns discovered plugins with no-store.
      const manifestRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/manifest', { headers: { cookie: 'dsh=1' } }))
      assert.equal(manifestRes.status, 200)
      assert.equal(manifestRes.headers.get('cache-control'), 'no-store')
      assert.equal(manifestRes.headers.get('x-content-type-options'), 'nosniff')
      const manifestJson = await manifestRes.json()
      assert.equal(manifestJson.plugins.length, expectedCount)

      // Authenticated JS entry serves cleanly for both local and scoped @scope/pkg bundles.
      const jsRes = await resource(new Request(`http://127.0.0.1:4123${widget.url}`, { headers: { cookie: 'dsh=1' } }))
      assert.equal(jsRes.status, 200)
      assert.equal(jsRes.headers.get('content-type'), 'text/javascript; charset=utf-8')
      assert.match(await jsRes.text(), /export function apply/)

      const scopedRes = await resource(new Request(`http://127.0.0.1:4123${scopedUi.url}`, { headers: { cookie: 'dsh=1' } }))
      assert.equal(scopedRes.status, 200, 'scoped @scope/pkg bundle entry must serve 200 instead of 404')
      assert.match(await scopedRes.text(), /return "scoped"/)

      // Disallowed extensions, encoded separators (%2F/%5C), traversal, and symlink escapes are blocked.
      const txtRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/files/local%3Ahello-widget/notes.txt', { headers: { cookie: 'dsh=1' } }))
      assert.equal(txtRes.status, 403)
      const travRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/files/local%3Ahello-widget/..%2F..%2Foutside.js', { headers: { cookie: 'dsh=1' } }))
      assert.equal(travRes.status, 403)
      const encSlashRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/files/bundle%3A%40scope%2Fdesktop-skin/ui%2Findex.js', { headers: { cookie: 'dsh=1' } }))
      assert.equal(encSlashRes.status, 403, 'encoded %2F inside relative path segment must return 403')
      const encBackslashRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/files/local%3Ahello-widget/..%5Coutside.js', { headers: { cookie: 'dsh=1' } }))
      assert.equal(encBackslashRes.status, 403, 'encoded %5C inside relative path segment must return 403')
      if (process.platform !== 'win32') {
        const symRes = await resource(new Request('http://127.0.0.1:4123/api/ui-plugins/files/local%3Ahello-widget/escape.js', { headers: { cookie: 'dsh=1' } }))
        assert.equal(symRes.status, 403)
      }
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true })
    }
  })

  test('discoverUiPlugins blocks incompatible unexempted and errored bundles while allowing compatible/exempted bundles', async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'ds-bot-ui-incompat-'))
    try {
      const incompatDir = join(pluginRoot, 'incompat-ui-bundle')
      const platformDir = join(pluginRoot, 'wrong-platform-bundle')
      const missingDir = join(pluginRoot, 'missing-bundle')
      const exemptedDir = join(pluginRoot, 'exempted-ui-bundle')
      for (const [dir, name] of [
        [incompatDir, 'incompat-ui-bundle'],
        [platformDir, 'wrong-platform-bundle'],
        [missingDir, 'missing-bundle'],
        [exemptedDir, 'exempted-ui-bundle'],
      ]) {
        mkdirSync(join(dir, 'ui'), { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
          name,
          dsBot: { ui: { entry: './ui/index.js', name } },
        }))
        writeFileSync(join(dir, 'ui', 'index.js'), `export function apply() { return ${JSON.stringify(name)} }`)
      }

      const dirByName = {
        'incompat-ui-bundle': incompatDir,
        'wrong-platform-bundle': platformDir,
        'missing-bundle': missingDir,
        'exempted-ui-bundle': exemptedDir,
      }
      const resolveBundleDir = name => dirByName[name] ?? null

      // DSH rejects unexempted incompatible bundles via `bundle.error = { code: 'incompatible-version', incompatible: [...] }`.
      const blockedSnapshot = await discoverUiPlugins({
        bundles: [
          {
            name: 'incompat-ui-bundle',
            enabled: true,
            availability: 'profile',
            error: {
              code: 'incompatible-version',
              incompatible: [{
                name: 'incompat-ui-bundle',
                version: '1.0.0',
                runtimeVersion: '0.2.2-rc.5',
                requirements: { 'engines.dsh': '^0.1.0' },
              }],
            },
            rows: [],
          },
          {
            name: 'wrong-platform-bundle',
            enabled: true,
            availability: 'profile',
            error: { code: 'unsupported-platform', diagnostic: 'linux only' },
            rows: [],
          },
          {
            name: 'missing-bundle',
            enabled: true,
            availability: 'missing',
            rows: [],
          },
          {
            name: 'exempted-ui-bundle',
            enabled: true,
            availability: 'profile',
            // Metadata diagnostics on `meta.error` are not load errors in DSH.
            meta: { error: 'dsh.bundle.listedByDefault must be a boolean' },
            rows: [],
          },
        ],
        resolveBundleDir,
      })

      assert.deepEqual(
        blockedSnapshot.plugins.map(p => p.id),
        ['bundle:exempted-ui-bundle'],
        'only enabled, loadable compatible/exempted bundles may publish dsBot.ui entries',
      )
      assert.equal(blockedSnapshot.roots.has('bundle:incompat-ui-bundle'), false)
      assert.equal(blockedSnapshot.roots.has('bundle:wrong-platform-bundle'), false)
      assert.equal(blockedSnapshot.roots.has('bundle:missing-bundle'), false)
      assert.equal(blockedSnapshot.roots.has('bundle:exempted-ui-bundle'), true)

      const authGate = request => (request.headers.get('cookie') === 'dsh=1' ? undefined : new Response('unauthorized', { status: 401 }))
      let currentSnapshot = blockedSnapshot
      const uiPluginsResource = createUiPluginsResource({
        getSnapshot: async () => currentSnapshot,
        authorizeRequest: authGate,
      })

      const blockedFileRes = await uiPluginsResource(new Request(
        'http://127.0.0.1:4123/api/ui-plugins/files/bundle%3Aincompat-ui-bundle/ui/index.js',
        { headers: { cookie: 'dsh=1' } },
      ))
      assert.equal(blockedFileRes.status, 404, 'incompatible unexempted bundle JS must not be served')

      const allowedFileRes = await uiPluginsResource(new Request(
        'http://127.0.0.1:4123/api/ui-plugins/files/bundle%3Aexempted-ui-bundle/ui/index.js',
        { headers: { cookie: 'dsh=1' } },
      ))
      assert.equal(allowedFileRes.status, 200)
      assert.match(await allowedFileRes.text(), /exempted-ui-bundle/)

      // Once the user grants a version exemption, DSH clears `bundle.error` and dsBot.ui publishes and serves normally.
      currentSnapshot = await discoverUiPlugins({
        bundles: [
          { name: 'incompat-ui-bundle', enabled: true, availability: 'profile', rows: [] },
        ],
        resolveBundleDir,
      })
      assert.deepEqual(currentSnapshot.plugins.map(p => p.id), ['bundle:incompat-ui-bundle'])
      const exemptedFileRes = await uiPluginsResource(new Request(
        'http://127.0.0.1:4123/api/ui-plugins/files/bundle%3Aincompat-ui-bundle/ui/index.js',
        { headers: { cookie: 'dsh=1' } },
      ))
      assert.equal(exemptedFileRes.status, 200)
      assert.match(await exemptedFileRes.text(), /incompat-ui-bundle/)
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true })
    }
  })
})
