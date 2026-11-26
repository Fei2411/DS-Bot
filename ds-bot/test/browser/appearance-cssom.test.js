import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// The user stylesheet's zero-exfiltration boundary, in a real browser: adversarial CSS is
// mounted through the same path the appearance wiring uses, and the local server counts
// every request. If any remote reference survives sanitization, the server sees it. A raw
// <style> control proves the server would notice.

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
let bundlePromise
const getBundle = () => (bundlePromise ??= build({
  stdin: {
    contents: `
      import { mountUserStylesheet, sanitizeUserSheet, userStylesheetSupported } from './src/client/theme-css.js'
      window.__themecss = { mountUserStylesheet, sanitizeUserSheet, userStylesheetSupported }
    `,
    resolveDir: PLUGIN,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
}).then(result => result.outputFiles[0].text))

async function startServer() {
  const hits = []
  const server = createServer((request, response) => {
    hits.push(request.url)
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/' || request.url === '/index.html') {
      const cells = Array.from({ length: 9 }, (_, index) => `<div class="p${index + 1}">p${index + 1}</div>`).join('')
      response.end(`<!doctype html><title>cssom</title><body><div class="probe">probe</div><div class="keep">keep</div>${cells}</body>`)
      return
    }
    // Any other URL is a fetch the user stylesheet caused; answer it so nothing hangs.
    response.setHeader('content-type', 'image/png')
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, hits, origin: `http://127.0.0.1:${server.address().port}` }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the sanitized user stylesheet loads no file, in a real browser', async (t) => {
  const { server, hits, origin } = await startServer()
  t.after(() => server.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${origin}/`)
  await page.addScriptTag({ content: await getBundle() })
  // Hits before the mount are the harness itself; the count after it is what matters, so
  // even a same-document refetch by a fragment could not hide as the page load.
  const before = hits.length

  const hostile = `
@import "${origin}/imported.css";
@im\\70 ort "${origin}/escaped-import.css";
.probe { background-image: url(${origin}/probe.png); color: rgb(1, 2, 3) }
.probe { outline-color: red; list-style-image: u\\72 l(${origin}/escaped.png) }
.probe { border-image-source: image-set(url(${origin}/imageset.png) 1x) }
.keep { background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==") }
.keep { fill: url('#fragment') }
@font-face { font-family: evil; src: url(${origin}/font.woff2) }
@property --evil { syntax: "<color>"; inherits: false; initial-value: url(${origin}/prop.png) }
@media (min-width: 1px) { .probe { background: url(${origin}/nested.png) } }
.p1 { background: var(--nope, url(${origin}/background-var.png)) }
.p2 { border-image: var(--nope, url(${origin}/border-image-var.png)) 30 fill }
.p3 { list-style: var(--nope, url(${origin}/list-style-var.png)) }
.p4 { mask: var(--nope, url(${origin}/mask-var.png)) }
.p5 { -webkit-mask: var(--nope, url(${origin}/webkit-mask-var.png)) }
.p6 { background: var(--a, var(--b, url(${origin}/nested-var.png))) }
.p7 { background: var(--nope, image-set(url(${origin}/imageset-var.png) 1x)) }
.p8 { background: var(--nope, u\\72 l(${origin}/escaped-var.png)) }
.p9 { animation: evilframes 1s infinite }
@keyframes evilframes { from { background: var(--nope, url(${origin}/keyframe-var.png)) } to { opacity: 0.5 } }
`
  const mounted = await page.evaluate(async ({ css }) => {
    const { mountUserStylesheet, userStylesheetSupported } = window.__themecss
    if (!userStylesheetSupported(document)) return { supported: false }
    const ok = mountUserStylesheet(document, css)
    const sheet = document.adoptedStyleSheets.at(-1)
    return {
      supported: true,
      ok,
      rules: sheet.cssRules.length,
      serialized: Array.from(sheet.cssRules).map(rule => rule.cssText),
      probeBg: getComputedStyle(document.querySelector('.probe')).backgroundImage,
      probeColor: getComputedStyle(document.querySelector('.probe')).color,
      keepBg: getComputedStyle(document.querySelector('.keep')).backgroundImage,
    }
  }, { css: hostile })
  await sleep(600)
  assert.equal(mounted.supported, true)
  assert.equal(mounted.ok, true)
  // Nothing loaded beyond the page itself: no import, no url, no escape trick, and no
  // same-document refetch through a fragment either.
  assert.deepEqual(hits.slice(before).filter(hit => hit !== '/favicon.ico'), [], `server hits: ${hits.slice(before).join(', ')}`)
  // The sanitized tree keeps the clean declarations and drops the fetching ones.
  const text = mounted.serialized.join('\n')
  assert.equal(text.includes(origin), false, `no remote reference survives:\n${text}`)
  assert.equal(mounted.probeBg, 'none', 'no remote background applies')
  assert.equal(mounted.probeColor, 'rgb(1, 2, 3)', 'clean declarations still apply')
  assert.ok(mounted.keepBg.includes('data:image/png'), 'an inline data: image survives and applies')

  // Control: the same vectors in a raw <style> element do reach the server, proving the
  // harness would have caught a leak -- the plain form and the var() shorthand form alike.
  hits.length = 0
  await page.evaluate(async ({ css }) => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  }, { css: `.probe { background-image: url(${origin}/control.png) }
.p1 { background: var(--nope, url(${origin}/control-var.png)) }` })
  await sleep(600)
  assert.ok(hits.some(hit => hit === '/control.png'), `plain control must hit the server: ${hits.join(', ')}`)
  assert.ok(hits.some(hit => hit === '/control-var.png'), `var() control must hit the server: ${hits.join(', ')}`)
})

test('constructed stylesheets order after <style> elements: the user rules stay last', async () => {
  const { server, origin } = await startServer()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await (await browser.newContext()).newPage()
    await page.goto(`${origin}/`)
    await page.addScriptTag({ content: await getBundle() })
    const order = await page.evaluate(async () => {
      const style = document.createElement('style')
      style.textContent = '.probe { color: rgb(10, 10, 10) }'
      document.head.appendChild(style)
      window.__themecss.mountUserStylesheet(document, '.probe { color: rgb(20, 20, 20) }')
      return {
        color: getComputedStyle(document.querySelector('.probe')).color,
        sheets: document.adoptedStyleSheets.length,
      }
    })
    assert.equal(order.color, 'rgb(20, 20, 20)', 'the user rule wins over the <style> rules, as loaded last')
    assert.equal(order.sheets, 1)
  } finally {
    await browser.close()
    server.close()
  }
})

test('replaceSync drops @import and normalizes escapes into CSSOM', async () => {
  const { server, origin } = await startServer()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await (await browser.newContext()).newPage()
    await page.goto(`${origin}/`)
    const behavior = await page.evaluate(async (base) => {
      const sheet = new CSSStyleSheet()
      let threw = false
      try { sheet.replaceSync(`@import "${base}/x.css"; .a{color:red}`) } catch { threw = true }
      const escaped = new CSSStyleSheet()
      escaped.replaceSync(`.a{background:u\\72 l(${base}/e.png);color:blue}`)
      const decl = escaped.cssRules[0].style
      return {
        threw,
        importRules: sheet.cssRules.length,
        // The browser normalizes the escape; the value as CSSOM reports it.
        backgroundValue: decl.getPropertyValue('background'),
      }
    }, origin)
    assert.equal(behavior.threw, false, 'replaceSync does not throw on @import here; the blanking keeps it portable')
    assert.equal(behavior.importRules, 1, 'the @import rule itself never parses')
    // Whatever the escape spelled, CSSOM hands the sanitizer the decoded form, which the
    // lexical scan flags. This asserts the normalization premise the design relies on.
    assert.ok(/^url\(/.test(behavior.backgroundValue), `escape normalized to url(): ${behavior.backgroundValue}`)
  } finally {
    await browser.close()
    server.close()
  }
})

test('empty @layer blocks survive sanitization so cascade layer order stays intact', async () => {
  const { server, origin } = await startServer()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await (await browser.newContext()).newPage()
    await page.goto(`${origin}/`)
    await page.addScriptTag({ content: await getBundle() })
    const css = '@layer first {} @layer second { .probe { color: rgb(0, 0, 255) } } @layer first { .probe { color: rgb(255, 0, 0) } }'
    const color = await page.evaluate((source) => {
      window.__themecss.mountUserStylesheet(document, source)
      return getComputedStyle(document.querySelector('.probe')).color
    }, css)
    // Because `first` was declared before `second`, `second` wins (blue) — dropping the
    // empty `@layer first {}` block would invert layer order and turn `.probe` red.
    assert.equal(color, 'rgb(0, 0, 255)')
  } finally {
    await browser.close()
    server.close()
  }
})

