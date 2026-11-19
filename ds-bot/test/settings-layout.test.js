import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS, botOwnCss } from './src/client/styles.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: () => ({ createContext: () => ({}) }),
})
const { SHELL_CSS, botOwnCss } = module.exports

// Match SettingsDialog and DSH's boxless slot wrapper. The plugin styles are a
// minimal size-contained / self-scrolling page, not a third-party plugin copy.
const fixture = (content, error = '', after = '') => `<!doctype html><style>
  ${botOwnCss(SHELL_CSS)}
  *{animation:none!important;transition:none!important}
  [data-slot]{display:contents}
  .plugin-page{height:100%;min-height:0;display:flex;flex-direction:column;container-type:size}
  .plugin-body{flex:1;min-height:0;overflow-y:auto;padding:8px}
  .plugin-actions{flex:none;height:32px}
  .plugin-panel{height:1200px}
</style>
<div class="bt-settings-layer"><div class="bt-settings">
  <nav class="bt-settings-nav">Settings</nav>
  <div class="bt-settings-main">
    <div class="bt-settings-head"><h2>Plugin settings</h2></div>
    <div class="bt-settings-scroll bt-settings-page">${error}
      <div class="bt-dsh-section"><div data-slot="settings.section">${content}</div></div>${after}
    </div>
  </div>
</div></div>`

const fullHeightPage = `<div class="plugin-page">
  <div class="plugin-body">
    <div role="tablist"><button role="tab">Overview</button><button role="tab">Accounts</button></div>
    <div class="plugin-panel">Settings panel</div><button id="last">Last setting</button>
  </div>
  <div class="plugin-actions"><button>Save</button><button>Discard</button></div>
</div>`

test('DSH settings pages keep usable height and scrolling (#1359)', async (t) => {
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  } catch (error) {
    // GitHub's Linux and Windows runners include Chrome. Local contributors
    // without it can still run the non-browser suite.
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chrome is required for the settings layout regression')
      return
    }
    throw error
  }
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 390, height: 844 }]) {
      await t.test(`percentage-height plugin at ${viewport.width}×${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport })
        try {
          await page.setContent(fixture(fullHeightPage))
          const layout = await page.evaluate(() => {
            const height = selector => document.querySelector(selector).getBoundingClientRect().height
            return { body: height('.plugin-body'), page: height('.plugin-page'), section: height('.bt-dsh-section'), main: height('.bt-settings-main') }
          })
          assert.ok(layout.body > layout.main / 2, JSON.stringify(layout))
          assert.ok(Math.abs(layout.page - layout.section) <= 1, JSON.stringify(layout))
          await page.locator('.plugin-body').evaluate(node => { node.scrollTop = node.scrollHeight })
          const scroll = await page.evaluate(() => {
            const body = document.querySelector('.plugin-body')
            const outer = document.querySelector('.bt-settings-scroll')
            const last = document.querySelector('#last').getBoundingClientRect()
            const footer = document.querySelector('.plugin-actions').getBoundingClientRect()
            return { inner: body.scrollTop, outer: outer.scrollTop, last: last.bottom, footerTop: footer.top, footerBottom: footer.bottom, outerBottom: outer.getBoundingClientRect().bottom }
          })
          assert.ok(scroll.inner > 0)
          assert.equal(scroll.outer, 0)
          assert.ok(scroll.last <= scroll.footerTop + 1, JSON.stringify(scroll))
          assert.ok(scroll.footerBottom <= scroll.outerBottom, JSON.stringify(scroll))
        } finally { await page.close() }
      })
    }
    await t.test('an error above the plugin leaves its actions reachable', async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      try {
        await page.setContent(fixture(fullHeightPage, '<div class="bt-error" role="alert">Could not save</div>'))
        const layout = await page.evaluate(() => ({
          body: document.querySelector('.plugin-body').clientHeight,
          footer: document.querySelector('.plugin-actions').getBoundingClientRect().bottom,
          outer: document.querySelector('.bt-settings-scroll').getBoundingClientRect().bottom,
        }))
        assert.ok(layout.body > 100, JSON.stringify(layout))
        assert.ok(layout.footer <= layout.outer, JSON.stringify(layout))
      } finally { await page.close() }
    })
    await t.test('natural-height sections keep short content and scroll long content', async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      try {
        await page.setContent(fixture('<div id="natural" style="height:80px">Short settings</div>'))
        assert.equal(await page.locator('#natural').evaluate(node => node.clientHeight), 80)
        await page.setContent(fixture('<div id="natural"><div style="height:1200px">Advanced models</div><button id="last">Last model</button></div>'))
        await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
        const layout = await page.evaluate(() => {
          const outer = document.querySelector('.bt-settings-scroll')
          const last = document.querySelector('#last').getBoundingClientRect()
          const box = outer.getBoundingClientRect()
          return { height: document.querySelector('#natural').clientHeight, section: document.querySelector('.bt-dsh-section').clientHeight, scroll: outer.scrollTop, lastTop: last.top, lastBottom: last.bottom, top: box.top, bottom: box.bottom, padding: parseFloat(getComputedStyle(outer).paddingBottom) }
        })
        assert.ok(layout.height > 1200, JSON.stringify(layout))
        assert.ok(layout.section >= layout.height, JSON.stringify(layout))
        assert.ok(layout.scroll > 0, JSON.stringify(layout))
        assert.ok(layout.lastTop >= layout.top && layout.lastBottom <= layout.bottom, JSON.stringify(layout))
        assert.ok(Math.abs(layout.bottom - layout.lastBottom - layout.padding) <= 1, JSON.stringify(layout))
      } finally { await page.close() }
    })
    await t.test('content after a natural-height section does not overlap it', async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      try {
        await page.setContent(fixture('<div id="natural" style="height:1200px;flex:none">Long settings</div>', '', '<button id="following" style="flex:none">Following action</button>'))
        const layout = await page.evaluate(() => ({
          contentBottom: document.querySelector('#natural').getBoundingClientRect().bottom,
          followingTop: document.querySelector('#following').getBoundingClientRect().top,
        }))
        assert.ok(layout.followingTop >= layout.contentBottom, JSON.stringify(layout))
      } finally { await page.close() }
    })
  } finally { await browser.close() }
})
