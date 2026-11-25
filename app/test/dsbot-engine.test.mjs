import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createUiResource, resolveDistDir } from '../engine/index.js'

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
  })

  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('gates index requests through authorizeIndex and serves HTML with no-store and nosniff', async () => {
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

    // Direct /index.html also runs authorizeIndex.
    const unauthDirect = await resource(new Request('http://127.0.0.1:4123/index.html'))
    assert.equal(unauthDirect.status, 401)

    // HEAD returns headers and an empty body.
    const headRes = await resource(new Request('http://127.0.0.1:4123/', { method: 'HEAD', headers: { cookie: 'dsh=1' } }))
    assert.equal(headRes.status, 200)
    assert.equal(await headRes.text(), '')
  })

  test('serves static assets with MIME types, weak ETags, 304 validation, and blocks traversal/bad methods', async () => {
    const resource = createUiResource({ distDir, authorizeIndex: () => undefined })

    const jsRes = await resource(new Request('http://127.0.0.1:4123/assets/app.js'))
    assert.equal(jsRes.status, 200)
    assert.equal(jsRes.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(jsRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(jsRes.headers.get('cache-control'), 'no-cache')
    const etag = jsRes.headers.get('etag')
    assert.match(etag, /^W\/"[^"]+"$/)
    assert.equal(await jsRes.text(), 'console.log("ok")')

    // Matching ETag returns 304 without body.
    const notMod = await resource(new Request('http://127.0.0.1:4123/assets/app.js', { headers: { 'if-none-match': etag } }))
    assert.equal(notMod.status, 304)
    assert.equal(await notMod.text(), '')

    // CSS MIME check.
    const cssRes = await resource(new Request('http://127.0.0.1:4123/assets/app.css'))
    assert.equal(cssRes.status, 200)
    assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8')

    // Missing file -> 404; directory -> 404.
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets/missing.js'))).status, 404)
    assert.equal((await resource(new Request('http://127.0.0.1:4123/assets'))).status, 404)

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
    assert.equal(resolveDistDir({ distDir: '/custom/ui' }, { env: {} }), '/custom/ui')
    assert.equal(resolveDistDir({}, { env: { DS_BOT_UI_DIR: '/env/ui' } }), '/env/ui')

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
})
