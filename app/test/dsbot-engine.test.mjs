import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as enginePlugin from '../engine/index.js'

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
    try {
      const ws = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const conn = ctx.plugin(connectionPlugin, { trustedHosts: [] })
      const eng = ctx.plugin(enginePlugin, { distDir })
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
      } finally {
        stopApi?.()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
