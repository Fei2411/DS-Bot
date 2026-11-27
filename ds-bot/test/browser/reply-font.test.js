import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { chromium } from 'playwright-core'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { FONT_DIR } from '../../src/host/fonts.js'
import { REPLY_FAMILY } from '../../src/shared/reply-fonts.js'

// DSH's own style sheets, from the DSH this checkout tests against: the Web front end
// (the Markdown rules) and the theme package's token sheets, which it ships as strings.
const packageDir = name => dirname(fileURLToPath(import.meta.resolve(`@deepseek-ai/${name}/package.json`)))
const assets = join(packageDir('dsh-web-frontend'), 'dist', 'assets')
const frontendCss = readdirSync(assets).filter(file => file.endsWith('.css')).map(file => readFileSync(join(assets, file), 'utf8')).join('\n')
const themeSource = readFileSync(join(packageDir('dsh-client-ui-theme'), 'lib', 'client.js'), 'utf8')
// The bundle keeps each sheet in a `var <name>_css_default` string; builds differ in quotes
// and spacing. The literal is evaluated alone, as a string, after checking it interpolates nothing.
const tokenSheet = (name) => {
  const literal = themeSource.match(new RegExp(`var ${name}\\s*=\\s*(\`(?:[^\`\\\\]|\\\\.)*\`|"(?:[^"\\\\]|\\\\.)*")`))?.[1]
  assert.ok(literal, `DSH theme sheet ${name}`)
  assert.ok(!literal.includes('${'), `DSH theme sheet ${name} is a plain string`)
  const css = runInNewContext(literal)
  assert.equal(typeof css, 'string')
  return css
}
const tokensCss = [tokenSheet('base_css_default'), tokenSheet('gradient_shadow_text_css_default')].join('\n')
assert.match(tokensCss, /--dsw-font-markdown-base:/)
// The hashed class names of this DSH build, found by the rules that define them: the
// Markdown renderer draws its text with the base token (another `_markdown_` class only
// colors a file icon).
const markdown = frontendCss.match(/\.(_markdown_\w+?_\d+)\{[^}]*font:var\(--dsw-font-markdown-base\)/)?.[1]
const tableScroll = frontendCss.match(/\.(_tableScroll_[\w]+?_\d+) td\{/)?.[1]

const reply = `<div class="${markdown}">
  <p id="p">Hello 你好，世界 <strong id="strong">粗体 bold</strong> <em id="em">italic 斜体</em> <code id="code">inline()</code></p>
  <h2 id="h2">标题 Heading</h2>
  <div class="${tableScroll}"><table><tr><th id="th">表头</th></tr><tr><td id="td">单元格 cell</td></tr></table></div>
  <pre id="pre"><code>const x = 1</code></pre>
</div>`
const page = (css) => `<!doctype html><html lang="zh-CN"><head><style>${tokensCss}</style><style>${frontendCss}</style><style>${css}</style></head>
<body><div class="bt-bubble">${reply}<span class="bt-fold"><span class="bt-fold-note" id="note">显示全部 · Show all</span></span></div><div class="bt-model-dock"><div class="bt-bubble" id="greeting">你好，我是 Bot。Pick a model</div></div><div class="${markdown}"><p id="outside">Not a reply 不是回复</p></div></body></html>`

async function launchBrowser() {
  const options = { headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) }
  try {
    return await chromium.launch(options)
  } catch (error) {
    if (process.env.BROWSER_EXECUTABLE_PATH) throw error
    return chromium.launch({ channel: 'chrome', headless: true }).catch(() => { throw error })
  }
}

test('Fei draws Bot replies in its bundled serif under DSH\'s own Markdown styles', async (t) => {
  assert.ok(markdown && tableScroll, 'DSH Markdown classes found')
  let browser
  try {
    browser = await launchBrowser()
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the reply font check')
      return
    }
    throw error
  }
  try {
    const tab = await browser.newPage()
    const fontRequests = []
    await tab.route('http://dsbot.test/**', async (route) => {
      const { pathname } = new URL(route.request().url())
      if (pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page(themeCss(allThemes().fei)) })
      if (pathname.startsWith('/api/bot/fonts/')) {
        const file = pathname.slice('/api/bot/fonts/'.length)
        fontRequests.push(file)
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(new URL(file, FONT_DIR)) })
      }
      return route.fulfill({ status: 404, body: '' })
    })
    await tab.goto('http://dsbot.test/')
    const fonts = await tab.evaluate(async () => {
      await document.fonts.ready
      const family = id => getComputedStyle(document.getElementById(id)).fontFamily
      return {
        ...Object.fromEntries(['p', 'strong', 'em', 'h2', 'th', 'td', 'code', 'pre', 'outside', 'note', 'greeting'].map(id => [id, family(id)])),
        bodyVariable: getComputedStyle(document.body).getPropertyValue('--dsw-font-family'),
        replyVariable: getComputedStyle(document.querySelector('.bt-bubble')).getPropertyValue('--dsw-font-family'),
        loaded: [...document.fonts].filter(face => face.status === 'loaded').map(face => `${face.style} ${face.weight} ${face.unicodeRange.startsWith('U+3000') ? 'cjk' : 'latin'}`),
      }
    })
    const serif = `"${REPLY_FAMILY}"`
    for (const id of ['p', 'strong', 'em', 'h2', 'th', 'td', 'greeting']) assert.ok(fonts[id].startsWith(serif), `${id}: ${fonts[id]}`)
    for (const id of ['code', 'pre', 'outside', 'note']) assert.ok(!fonts[id].includes(REPLY_FAMILY), `${id}: ${fonts[id]}`)
    // DSH's own font variable is left alone, so code-block chrome keeps the interface font.
    assert.equal(fonts.replyVariable, fonts.bodyVariable)
    // Latin and Chinese load together, upright and bold, and italic Latin.
    for (const face of ['normal 100 500 latin', 'normal 100 500 cjk', 'normal 600 900 latin', 'normal 600 900 cjk', 'italic 100 500 latin']) {
      assert.ok(fonts.loaded.includes(face), `${face} loaded: ${fonts.loaded.join(', ')}`)
    }
    assert.ok(fontRequests.length > 0)

    // A text font the user set in Settings goes first.
    const custom = await tab.evaluate(() => {
      document.body.style.setProperty('--dsh-font-family-text', '"Reader Font"')
      return getComputedStyle(document.getElementById('p')).fontFamily
    })
    assert.ok(custom.startsWith('"Reader Font"'), custom)
  } finally {
    await browser.close()
  }
})
