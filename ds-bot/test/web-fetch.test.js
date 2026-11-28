import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { describe, test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  AUTO_FETCH_PROVIDER_ID,
  apply,
  classifyContentType,
  createAutoFetchProvider,
  createElectronBrowserFetch,
  decoderForCharset,
  extractVisibleText,
  isPrivateHost,
  preferBrowserResult,
  resolveConfig,
  shouldFallbackToBrowser,
  sniffHtmlCharset,
  validateFetchUrl,
} from '../web-fetch.js'

function mockResponse(body, { status = 200, headers = {} } = {}) {
  const normalized = new Headers(headers)
  if (!normalized.has('content-type') && status >= 200 && status < 300) {
    normalized.set('content-type', 'text/html; charset=utf-8')
  }
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? ''))
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    status,
    headers: normalized,
    body: stream,
    get cancelled() { return cancelled },
  }
}

describe('web-fetch-auto URL validation and host classification', () => {
  test('accepts http and https URLs and rejects invalid schemes, length, and credentials', () => {
    assert.equal(validateFetchUrl('https://example.com/docs').href, 'https://example.com/docs')
    assert.equal(validateFetchUrl('http://localhost:3000/api').href, 'http://localhost:3000/api')
    assert.throws(() => validateFetchUrl(''), err => err instanceof WebError && err.code === 'WEB_INVALID_URL')
    assert.throws(() => validateFetchUrl('file:///etc/passwd'), err => err instanceof WebError && err.code === 'WEB_INVALID_URL')
    assert.throws(() => validateFetchUrl(`https://example.com/${'a'.repeat(2100)}`), err => err instanceof WebError && err.code === 'WEB_INVALID_URL')
    assert.throws(() => validateFetchUrl('https://user:pass@example.com/'), err => err instanceof WebError && err.code === 'WEB_BLOCKED_URL')
  })

  test('classifies loopback, RFC1918, link-local, CGNAT, ULA, and IPv4-mapped IPv6 hosts as private', () => {
    for (const host of [
      'localhost', 'sub.localhost', 'LOCALHOST.', 'printer.local', 'meta.internal',
      '127.0.0.1', '127.255.255.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '[::1]', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    ]) {
      assert.equal(isPrivateHost(host), true, `expected private: ${host}`)
    }
    for (const host of ['example.com', 'www.bybit.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateHost(host), false, `expected public: ${host}`)
    }
  })
})

describe('web-fetch-auto content decoding and heuristics', () => {
  test('classifies content types and sniffs HTML meta charset', () => {
    assert.equal(classifyContentType('text/html; charset=utf-8'), 'html')
    assert.equal(classifyContentType('application/xhtml+xml'), 'html')
    assert.equal(classifyContentType('application/json; charset=utf-8'), 'text')
    assert.equal(classifyContentType('application/atom+xml'), 'text')
    assert.equal(classifyContentType('text/markdown'), 'text')
    assert.equal(classifyContentType('application/pdf'), undefined)
    assert.equal(classifyContentType('image/png'), undefined)

    const metaBytes = new TextEncoder().encode('<html><head><meta charset="gb18030"></head></html>')
    assert.equal(sniffHtmlCharset(metaBytes), 'gb18030')
    const equivBytes = new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')
    assert.equal(sniffHtmlCharset(equivBytes), 'shift_jis')
    assert.equal(decoderForCharset('utf-8, gbk').fatal, true)
  })

  test('detects WAF blocks, challenge pages, and empty SPA shells without false positives on normal pages', () => {
    assert.equal(shouldFallbackToBrowser({ statusCode: 403, body: { kind: 'html', content: 'Access Denied' } }).needed, true)
    assert.equal(shouldFallbackToBrowser({ statusCode: 429, body: { kind: 'html', content: 'Too many requests' } }).needed, true)
    assert.equal(shouldFallbackToBrowser({ statusCode: 503, body: { kind: 'html', content: 'Service unavailable' } }).needed, true)
    assert.equal(shouldFallbackToBrowser({ statusCode: 202, body: { kind: 'html', content: '<form id="challenge-form">verify</form>' } }).needed, true)
    assert.equal(shouldFallbackToBrowser({
      statusCode: 200,
      body: { kind: 'html', content: '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>' },
    }).needed, true)
    assert.equal(shouldFallbackToBrowser({
      statusCode: 200,
      body: { kind: 'html', content: '<html><head><title>Help</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>' },
    }).needed, true)

    // Normal static HTML, 404, and JSON APIs do NOT trigger browser fallback.
    assert.equal(shouldFallbackToBrowser({
      statusCode: 200,
      body: { kind: 'html', content: '<html><body><h1>Docs</h1><p>This is a normal article with real documentation content that needs no browser rendering at all.</p></body></html>' },
    }).needed, false)
    assert.equal(shouldFallbackToBrowser({ statusCode: 404, body: { kind: 'html', content: '<h1>Not Found</h1>' } }).needed, false)
    assert.equal(shouldFallbackToBrowser({ statusCode: 200, body: { kind: 'text', content: '{"ok":true}' } }).needed, false)
    assert.equal(extractVisibleText('<html><script>var x=1;</script><style>a{}</style><body><h1>Hello</h1><p>World</p></body></html>'), 'Hello World')
  })

  test('prefers browser result when it recovers from 403 or hydrates a SPA shell, otherwise preserves Tier 1', () => {
    const blocked = { url: 'https://example.com', statusCode: 403, body: { kind: 'html', content: 'Access Denied' }, truncated: false }
    const ok = { url: 'https://example.com', statusCode: 200, body: { kind: 'html', content: '<h1>Real article content</h1>' }, truncated: false }
    assert.equal(preferBrowserResult(blocked, ok), ok)

    const spa = { url: 'https://example.com', statusCode: 200, body: { kind: 'html', content: '<div id="__next"></div><script id="__NEXT_DATA__">{}</script>' }, truncated: false }
    const hydrated = { url: 'https://example.com', statusCode: 200, body: { kind: 'html', content: `<article>${'Bybit AI Trading OAuth flow documentation. '.repeat(6)}</article>` }, truncated: false }
    assert.equal(preferBrowserResult(spa, hydrated), hydrated)

    const stillEmpty = { url: 'https://example.com', statusCode: 200, body: { kind: 'html', content: '<div></div>' }, truncated: false }
    assert.equal(preferBrowserResult(spa, stillEmpty), spa)
  })
})

describe('createAutoFetchProvider Tier 1 & Tier 2 behavior', () => {
  test('sends browser-compatible headers and follows safe cross-origin redirects', async () => {
    const seen = []
    const provider = createAutoFetchProvider({
      fetch: async (url, init) => {
        seen.push({ url: url.toString(), headers: init.headers })
        if (url.hostname === 'bybit.com') {
          return mockResponse('', { status: 301, headers: { location: 'https://www.bybit.com/en/help' } })
        }
        return mockResponse('<html><body><h1>Bybit AI Trading</h1><p>Connect and trade with natural language via OAuth subaccount.</p></body></html>')
      },
      browserFetch: async () => { throw new Error('should not invoke browser fallback on 200 static page') },
    })

    const res = await provider.fetch({ url: 'https://bybit.com/en/help' })
    assert.equal(provider.id, AUTO_FETCH_PROVIDER_ID)
    assert.equal(res.statusCode, 200)
    assert.equal(res.url, 'https://www.bybit.com/en/help')
    assert.match(res.body.content, /Bybit AI Trading/)
    assert.equal(seen.length, 2)
    assert.match(seen[0].headers['user-agent'], /Mozilla\/5\.0/)
    assert.ok(seen[0].headers['accept-language'])
  })

  test('blocks public-to-private SSRF redirects without falling back to browser', async () => {
    let browserCalled = false
    const provider = createAutoFetchProvider({
      fetch: async () => mockResponse('', { status: 302, headers: { location: 'http://127.0.0.1:8797/secret' } }),
      browserFetch: async () => { browserCalled = true; return null },
    })

    await assert.rejects(
      () => provider.fetch({ url: 'https://public.example.com/start' }),
      err => err instanceof WebError && err.code === 'WEB_REDIRECT_BLOCKED',
    )
    assert.equal(browserCalled, false)
  })

  test('allows direct local/private fetches and private-to-private redirects', async () => {
    const provider = createAutoFetchProvider({
      fetch: async (url) => {
        if (url.pathname === '/old') return mockResponse('', { status: 302, headers: { location: 'http://127.0.0.1:3000/new' } })
        return mockResponse('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      },
    })
    const res = await provider.fetch({ url: 'http://localhost:3000/old' })
    assert.equal(res.url, 'http://127.0.0.1:3000/new')
    assert.equal(res.body.kind, 'text')
    assert.equal(res.body.content, '{"ok":true}')
  })

  test('falls back to browser on 403 WAF block and returns rendered page', async () => {
    const browserCalls = []
    const provider = createAutoFetchProvider({
      fetch: async () => mockResponse('<html><body>Access Denied by CDN WAF</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
      browserFetch: async (req) => {
        browserCalls.push(req)
        return {
          url: req.url,
          statusCode: 200,
          body: { kind: 'html', content: '<html><body><h1>Bybit AI Trading</h1><p>Full article via real browser</p></body></html>' },
          truncated: false,
        }
      },
    })

    const res = await provider.fetch({ url: 'https://learn.bybit.com/ai-trading' })
    assert.equal(browserCalls.length, 1)
    assert.equal(browserCalls[0].initialPrivate, false)
    assert.equal(res.statusCode, 200)
    assert.match(res.body.content, /Full article via real browser/)
  })

  test('falls back to browser on empty Next.js SPA shell and preserves Tier 1 if browser fails', async () => {
    const spaHtml = '<html><head><title> - Help Center</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>'
    let failBrowser = false
    const provider = createAutoFetchProvider({
      fetch: async () => mockResponse(spaHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      browserFetch: async (req) => {
        if (failBrowser) throw new WebError('browser failed', 'WEB_PROVIDER_ERROR')
        return {
          url: req.url,
          statusCode: 200,
          body: { kind: 'html', content: `<html><body><main><h1>Bybit AI Trading</h1><p>${'Connect and trade with natural language. '.repeat(5)}</p></main></body></html>` },
          truncated: false,
        }
      },
    })

    const hydrated = await provider.fetch({ url: 'https://www.bybit.com/en/help-center/article/Bybit-AI-Trading' })
    assert.match(hydrated.body.content, /Connect and trade with natural language/)

    failBrowser = true
    const fallbackToTier1 = await provider.fetch({ url: 'https://www.bybit.com/en/help-center/article/Bybit-AI-Trading' })
    assert.equal(fallbackToTier1.statusCode, 200)
    assert.equal(fallbackToTier1.body.content, spaHtml)
  })

  test('falls back to browser on Tier 1 transport failure (e.g. missing proxy env), but not on binary content or abort', async () => {
    const provider = createAutoFetchProvider({
      fetch: async () => { throw new TypeError('fetch failed') },
      browserFetch: async req => ({ url: req.url, statusCode: 200, body: { kind: 'html', content: '<h1>Via system proxy</h1>' }, truncated: false }),
    })
    const res = await provider.fetch({ url: 'https://www.bybit.com/en/' })
    assert.equal(res.statusCode, 200)
    assert.match(res.body.content, /Via system proxy/)

    let binaryBrowserCalled = false
    const binaryProvider = createAutoFetchProvider({
      fetch: async () => mockResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
      browserFetch: async () => { binaryBrowserCalled = true; return null },
    })
    await assert.rejects(
      () => binaryProvider.fetch({ url: 'https://example.com/file.pdf' }),
      err => err instanceof WebError && err.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
    )
    assert.equal(binaryBrowserCalled, false)
  })

  test('enforces byte and character caps and config validation', async () => {
    assert.throws(() => resolveConfig({ maxRedirects: -1 }), /non-negative integer/)
    assert.throws(() => resolveConfig({ maxResponseBytes: 0 }), /positive finite/)
    assert.throws(() => resolveConfig({ browserFallback: 'yes' }), /boolean/)

    const provider = createAutoFetchProvider({
      fetch: async () => mockResponse('a'.repeat(500), { status: 200, headers: { 'content-type': 'text/plain' } }),
    }, { maxResponseBytes: 200, maxBodyChars: 100, browserFallback: false })
    const res = await provider.fetch({ url: 'https://example.com/large.txt' })
    assert.equal(res.truncated, true)
    assert.equal(res.body.content.length, 100)
  })

  test('createElectronBrowserFetch forwards IPC request, resolves result, and sends abort on signal cancel', async () => {
    const bus = new EventEmitter()
    const sent = []
    const browserFetch = createElectronBrowserFetch({
      send(msg, cb) {
        sent.push(msg)
        cb?.(null)
        if (msg.type === 'ds-bot:web-fetch' && msg.url.includes('/ok')) {
          queueMicrotask(() => bus.emit('message', {
            type: 'ds-bot:web-fetch-response',
            id: msg.id,
            result: { url: msg.url, statusCode: 200, body: { kind: 'html', content: '<h1>OK</h1>' }, truncated: false },
          }))
        }
      },
      on: (ev, fn) => bus.on(ev, fn),
      off: (ev, fn) => bus.off(ev, fn),
    })

    const ok = await browserFetch({ url: 'https://example.com/ok', timeoutMs: 5000, maxBodyChars: 10000, initialPrivate: false })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.body.content, '<h1>OK</h1>')

    const ac = new AbortController()
    const pending = browserFetch({ url: 'https://example.com/hang', timeoutMs: 5000, maxBodyChars: 10000, initialPrivate: false }, ac.signal)
    ac.abort()
    await assert.rejects(() => pending, err => err instanceof WebError && err.code === 'WEB_ABORTED')
    assert.ok(sent.some(m => m.type === 'ds-bot:web-fetch-abort'))
    assert.equal(bus.listenerCount('message'), 0)
  })

  test('real loopback HTTP contract: registers via apply(ctx), follows redirect, and falls back on 403', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/article' })
        res.end()
        return
      }
      if (req.url === '/article') {
        if (!/Mozilla\/5\.0/.test(String(req.headers['user-agent'] ?? ''))) {
          res.writeHead(403, { 'Content-Type': 'text/html' })
          res.end('Forbidden bot UA')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Live Contract</h1><p>Browser-compatible headers passed.</p></body></html>')
        return
      }
      res.writeHead(403, { 'Content-Type': 'text/html' })
      res.end('WAF Blocked')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      let registered
      apply({ web: { registerFetchProvider(p) { registered = p } } })
      assert.equal(registered.id, 'auto')
      const res = await registered.fetch({ url: `http://127.0.0.1:${port}/redirect` })
      assert.equal(res.statusCode, 200)
      assert.equal(res.url, `http://127.0.0.1:${port}/article`)
      assert.match(res.body.content, /Browser-compatible headers passed/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
