import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startRelayServer } from '../server/server.ts'

test('relay optionally serves the web app with confined paths and security headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-web-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const webDir = join(directory, 'web')
  await mkdir(webDir)
  await writeFile(join(webDir, 'index.html'), '<html>app</html>')
  await writeFile(join(webDir, 'app.js'), 'console.log("app")')
  await writeFile(join(webDir, 'app.css'), 'body {}')
  await writeFile(join(directory, 'private.txt'), 'private')
  await symlink(join(directory, 'private.txt'), join(webDir, 'escape.txt'))
  const server = await startRelayServer({ webDir })
  t.after(() => server.close())
  const origin = new URL(server.url.replace('ws:', 'http:')).origin
  const get = (path: string, method = 'GET', host?: string) => new Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>((resolve, reject) => {
    const req = request(origin, { method, path, setHost: host === undefined, ...(host === undefined ? {} : { headers: { Host: host } }) }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  const index = await get('/web/')
  assert.equal(index.status, 200)
  assert.equal(index.body, '<html>app</html>')
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(index.headers['cache-control'], 'no-cache')
  assert.equal(index.headers['x-content-type-options'], 'nosniff')
  assert.equal(index.headers['referrer-policy'], 'no-referrer')
  const host = new URL(origin).host
  assert.equal(index.headers['content-security-policy'], `default-src 'self'; connect-src 'self' ws://${host} wss://${host}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`)
  for (const host of ['localhost', 'relay.example:443', '127.0.0.1:18787', '[::1]:8787', '[2001:db8::1]', 'relay.example.']) {
    const response = await get('/web/', 'GET', host)
    assert.equal(response.status, 200, host)
    assert.ok(response.headers['content-security-policy']?.includes(`ws://${host} wss://${host}`))
  }
  for (const host of ['', 'x;script-src *', 'user@host', 'host/path', 'host?query', 'host:65536', 'host:abc', '[not-ipv6]', '999.999.999.999', '-bad.example', 'a..example']) {
    const response = await get('/web/', 'GET', host)
    assert.equal(response.status, 400, host)
    assert.equal(response.headers['content-security-policy'], undefined)
  }
  const redirect = await get('/web')
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.location, '/web/')
  const script = await get('/web/app.js?v=1')
  assert.equal(script.body, 'console.log("app")')
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal((await get('/web/app.css')).headers['content-type'], 'text/css; charset=utf-8')
  const head = await get('/web/app.js', 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(head.headers['content-length'], script.headers['content-length'])
  for (const path of ['/web/team/chat', '/web/team/', '/web/?q=1']) {
    const response = await get(path)
    assert.equal(response.status, 200)
    assert.equal(response.body, index.body)
    assert.equal(response.headers['cache-control'], 'no-cache')
  }
  assert.equal((await get('/web/missing.js')).status, 404)
  assert.equal((await get('/web/', 'POST')).status, 404)
  assert.equal((await get('/other')).status, 404)
  assert.equal((await get('/healthz')).body, 'ok\n')
  for (const path of ['/web/%2e%2e/private.txt', '/web/..%2fprivate.txt', '/web/%5c..%5cprivate.txt', '/web/%2fprivate.txt', '/web/%00', '/web/escape.txt']) {
    const response = await get(path)
    assert.equal(response.status, 403, path)
    assert.equal(response.body, '')
  }
  assert.equal((await get('/web/%ZZ')).status, 400)
  await rm(join(webDir, 'index.html'))
  assert.equal((await get('/web/team')).status, 404)
})

test('relay leaves web routes disabled by default', async t => {
  const server = await startRelayServer()
  t.after(() => server.close())
  const origin = new URL(server.url.replace('ws:', 'http:')).origin
  for (const path of ['/web', '/web/', '/web/index.html', '/web/team']) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 404)
  }
})
