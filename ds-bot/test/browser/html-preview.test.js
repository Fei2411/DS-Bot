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

const modules = new Map([
  ['/html-preview.js', new URL('../../../app/ui/src/html-preview.js', import.meta.url)],
  ['/ds-bot/src/shared/theme-css.js', new URL('../../src/shared/theme-css.js', import.meta.url)],
  ['/ds-bot/src/client/theme-css.js', new URL('../../src/client/theme-css.js', import.meta.url)],
])

async function withAttackServer(t, run) {
  const attacks = []
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body><script type="module" src="/run.js"></script></body></html>')
      return
    }
    if (path === '/run.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(run.replaceAll('PORT', String(server.address().port)))
      return
    }
    const module = modules.get(path)
    if (module !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(readFileSync(module, 'utf8'))
      return
    }
    attacks.push(path)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('evil')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await launchBrowser()
  t.after(async () => { await browser.close(); server.close() })
  const page = await browser.newPage()
  return { attacks, browser, page, port: server.address().port }
}

test('HTML preview strips remote references, keeps safe inline rendering, and CSP blocks injected resources', async (t) => {
  const { attacks, page, port } = await withAttackServer(t, `
    import { prepareHtmlPreview } from '/html-preview.js'
    const input = ${JSON.stringify(`<!doctype html><html><head>
      <meta http-equiv=" refresh " content="0;url=http://127.0.0.1:PORT/evil-meta">
      <link rel="stylesheet" href="http://127.0.0.1:PORT/evil-css">
      <script src="http://127.0.0.1:PORT/evil-script"></script>
      <style>body{color:rgb(1,2,3)}</style>
    </head><body style="background:#111111">
      <img id="remote" src="http://127.0.0.1:PORT/evil-img">
      <img id="attributed" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" attributionsrc="http://127.0.0.1:PORT/evil-attribution">
      <img id="data" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">
      <a id="out" href="http://127.0.0.1:PORT/evil-link">out</a>
      <form action="http://127.0.0.1:PORT/evil-form"><button>go</button></form>
      <iframe src="http://127.0.0.1:PORT/evil-frame"></iframe>
      <svg><a xlink:href="http://127.0.0.1:PORT/evil-xlink">x</a><set attributeName="xlink:href" to="http://127.0.0.1:PORT/evil-smil" /></svg>
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
      <script>window.pwned=true;fetch('http://127.0.0.1:PORT/evil-fetch');parent.window.pwned=true</script>
    </body></html>`).replaceAll('PORT', 'PORT')}
    window.cleanPreview = prepareHtmlPreview(input)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', '')
    frame.srcdoc = window.cleanPreview.html
    document.body.append(frame)
    const injected = window.cleanPreview.html.replace('</body>', \`
      <img src="http://127.0.0.1:PORT/injected-img">
      <script src="http://127.0.0.1:PORT/injected-script"><\\/script>
      <link rel="stylesheet" href="http://127.0.0.1:PORT/injected-css">
    </body>\`)
    const second = document.createElement('iframe')
    second.setAttribute('sandbox', '')
    second.srcdoc = injected
    document.body.append(second)
    window.ready = true
  `)
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.ready === true)
  await page.waitForTimeout(700)

  const clean = await page.evaluate(() => window.cleanPreview)
  assert.equal(clean.blocked, true)
  assert.match(clean.html, /Content-Security-Policy/)
  assert.equal(clean.html.includes('evil-'), false)
  assert.equal(clean.html.includes('<script'), false)
  assert.equal(clean.html.includes('<iframe'), false)
  assert.equal(clean.html.includes('http-equiv=" refresh "'), false)
  assert.equal(clean.html.includes('data:image/svg'), false)
  assert.equal(clean.html.includes('blob:'), false)
  assert.equal(clean.html.includes('attributionsrc'), false)

  const frames = page.frames()
  assert.equal(frames.length >= 3, true)
  const first = frames[1]
  assert.equal(await first.evaluate(() => window.pwned ?? null), null)
  assert.equal(await first.evaluate(() => document.querySelector('#data')?.naturalWidth ?? 0), 1)
  assert.equal(await first.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)')
  assert.equal(await first.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(17, 17, 17)')
  assert.equal(await first.evaluate(() => document.querySelector('#remote')?.hasAttribute('src') ?? true), false)
  assert.equal(await first.evaluate(() => document.querySelector('#attributed')?.hasAttribute('attributionsrc') ?? true), false)
  assert.equal(await first.evaluate(() => document.querySelector('#out')?.hasAttribute('href') ?? true), false)
  assert.deepEqual(attacks, [])
})

test('HTML preview closes shadow-DOM and foreign-content mutation bypasses and sends no request on clicks', async (t) => {
  const { attacks, page, port } = await withAttackServer(t, `
    import { prepareHtmlPreview } from '/html-preview.js'
    const cases = {
      shadow: '<template shadowrootmode="open"><a id="shadow-link" href="http://127.0.0.1:PORT/evil-shadow-link">shadow</a><img src="http://127.0.0.1:PORT/evil-shadow-img"><style>@import url(http://127.0.0.1:PORT/evil-shadow-css)</style></template><p>shadow host</p>',
      mxss: '<form><math><mtext></form><form><mglyph><style></math><img src="http://127.0.0.1:PORT/evil-mxss-img"><a id="mxss-link" href="http://127.0.0.1:PORT/evil-mxss-link">click</a>',
      plain: '<a id="plain-link" href="http://127.0.0.1:PORT/evil-plain-link">click</a>'
    }
    window.previews = Object.fromEntries(Object.entries(cases).map(([name, html]) => [name, prepareHtmlPreview(html)]))
    for (const [name, preview] of Object.entries(window.previews)) {
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', '')
      frame.dataset.name = name
      frame.srcdoc = preview.html
      document.body.append(frame)
    }
    window.ready = true
  `)
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.ready === true)
  await page.waitForTimeout(700)
  const previews = await page.evaluate(() => window.previews)
  for (const preview of Object.values(previews)) {
    assert.equal(preview.blocked, true)
    assert.equal(preview.html.includes('evil-'), false)
    assert.equal(preview.html.includes('<template'), false)
    assert.equal(preview.html.includes('<math'), false)
  }
  for (const frame of page.frames().slice(1)) {
    await frame.evaluate(() => { for (const link of [...document.querySelectorAll('a')]) link.click() })
  }
  await page.waitForTimeout(500)
  assert.deepEqual(attacks, [])
})

test('HTML preview sanitizes CSS and SVG resource references while keeping same-document fragments', async (t) => {
  const { attacks, page, port } = await withAttackServer(t, `
    import { prepareHtmlPreview } from '/html-preview.js'
    const input = \`<style>
      @import url(http://127.0.0.1:PORT/evil-import);
      @font-face { font-family: evil; src: url(http://127.0.0.1:PORT/evil-font) }
      .a { color: rgb(4, 5, 6); background: url(http://127.0.0.1:PORT/evil-bg) }
      .b { background-image: image-set(url(http://127.0.0.1:PORT/evil-set) 1x) }
      .c { background-image: url(data:image/svg+xml,%3Csvg%3E) }
    </style><body>
      <p class="a" style="color:rgb(7,8,9);background:url(http://127.0.0.1:PORT/evil-inline)">css</p>
      <svg viewBox="0 0 10 10">
        <defs><linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient></defs>
        <use href="#grad"></use>
        <rect fill="url(#grad)" filter="url(http://127.0.0.1:PORT/evil-filter)" width="10" height="10"></rect>
        <image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></image>
        <image xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></image>
      </svg>
    </body>\`
    window.preview = prepareHtmlPreview(input)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', '')
    frame.srcdoc = window.preview.html
    document.body.append(frame)
    window.ready = true
  `)
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.ready === true)
  await page.waitForTimeout(700)
  const preview = await page.evaluate(() => window.preview)
  assert.equal(preview.blocked, true)
  assert.equal(preview.html.includes('evil-'), false)
  assert.equal(preview.html.includes('image-set'), false)
  assert.equal(preview.html.includes('data:image/svg'), false)
  assert.equal(preview.html.includes('href="#grad"'), true)
  assert.equal(preview.html.includes('fill="url(#grad)"'), true)
  assert.equal((preview.html.match(/data:image\/png/g) ?? []).length >= 2, true)
  assert.match(preview.html, /rgb\(7, ?8, ?9\)|rgb\(7,8,9\)/)
  const frame = page.frames()[1]
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('p')).color), 'rgb(7, 8, 9)')
  assert.deepEqual(attacks, [])
})
