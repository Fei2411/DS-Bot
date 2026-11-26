import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'playwright-core'

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) })
  } catch (error) {
    return chromium.launch({ channel: 'chrome', headless: true }).catch(() => { throw error })
  }
}

test('HTML preview strips remote references and its CSP blocks injected network resources', async (t) => {
  const attacks = []
  const moduleSource = readFileSync(new URL('../../../app/ui/src/html-preview.js', import.meta.url), 'utf8')
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body></body><script type="module" src="/run.js"></script></html>')
      return
    }
    if (req.url === '/run.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(`
        import { prepareHtmlPreview } from '/html-preview.js'
        const PORT = ${port}
        const input = ${JSON.stringify(`<!doctype html><html><head>
          <meta http-equiv="refresh" content="0;url=http://127.0.0.1:PORT/evil-meta">
          <link rel="stylesheet" href="http://127.0.0.1:PORT/evil-css">
          <script src="http://127.0.0.1:PORT/evil-script"></script>
          <style>body{color:rgb(1,2,3)}</style>
        </head><body>
          <img id="remote" src="http://127.0.0.1:PORT/evil-img">
          <img id="data" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">
          <a id="out" href="http://127.0.0.1:PORT/evil-link">out</a>
          <form action="http://127.0.0.1:PORT/evil-form"><button>go</button></form>
          <iframe src="http://127.0.0.1:PORT/evil-frame"></iframe>
          <script>window.pwned=true;fetch('http://127.0.0.1:PORT/evil-fetch');parent.window.pwned=true</script>
        </body></html>`).replaceAll('PORT', String(port))}
        const clean = prepareHtmlPreview(input)
        window.cleanPreview = clean
        const frame = document.createElement('iframe')
        frame.setAttribute('sandbox', '')
        frame.srcdoc = clean
        document.body.append(frame)
        // Simulate a sanitizer regression: CSP must still refuse network subresources.
        const injected = clean.replace('</body>', \`
          <img src="http://127.0.0.1:PORT/injected-img">
          <script src="http://127.0.0.1:PORT/injected-script"><\\/script>
          <link rel="stylesheet" href="http://127.0.0.1:PORT/injected-css">
        </body>\`.replaceAll('PORT', String(PORT)))
        const second = document.createElement('iframe')
        second.setAttribute('sandbox', '')
        second.srcdoc = injected
        document.body.append(second)
        window.ready = true
      `.replaceAll('PORT', 'PORT'))
      return
    }
    if (req.url === '/html-preview.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(moduleSource)
      return
    }
    attacks.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('evil')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const browser = await launchBrowser()
  t.after(async () => { await browser.close(); server.close() })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.ready === true)
  await page.waitForTimeout(700)

  const clean = await page.evaluate(() => window.cleanPreview)
  assert.match(clean, /Content-Security-Policy/)
  assert.equal(clean.includes('evil-'), false)
  assert.equal(clean.includes('<script'), false)
  assert.equal(clean.includes('<iframe'), false)
  assert.equal(clean.includes('http-equiv="refresh"'), false)

  const frames = page.frames()
  assert.equal(frames.length >= 3, true)
  const first = frames[1]
  assert.equal(await first.evaluate(() => window.pwned ?? null), null)
  assert.equal(await first.evaluate(() => document.querySelector('#data')?.naturalWidth ?? 0), 1)
  assert.equal(await first.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)')
  assert.equal(await first.evaluate(() => document.querySelector('#remote')?.hasAttribute('src') ?? true), false)
  assert.equal(await first.evaluate(() => document.querySelector('#out')?.hasAttribute('href') ?? true), false)
  assert.deepEqual(attacks, [])
})
