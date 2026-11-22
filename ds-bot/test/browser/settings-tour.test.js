import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const resolveDir = fileURLToPath(new URL('../..', import.meta.url))
const css = await build({
  stdin: { contents: "export { SHELL_CSS, botOwnCss } from './src/client/styles.js'", resolveDir },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(css.outputFiles[0].text, { module, exports: module.exports, require: () => ({ createContext: () => ({}) }) })
const { SHELL_CSS, botOwnCss } = module.exports
const fixture = await build({
  stdin: {
    resolveDir,
    contents: `
      import { createElement as h, useRef, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { SettingsTour } from './src/client/settings-tour.js'
      function Fixture() {
        const dialogRef = useRef(null)
        const [tour, setTour] = useState(null)
        const [clicks, setClicks] = useState(0)
        return h('div', { className: 'bt-settings-layer' },
          h('div', { className: 'bt-settings', ref: dialogRef },
            h('nav', { className: 'bt-settings-nav' },
              h('input', { 'data-tour': 'search', 'aria-label': 'Search settings' })),
            h('main', { className: 'bt-settings-main' },
              h('button', { onClick: () => setTour({ mode: 'full', nonce: 1 }) }, 'Open guide'),
              h('button', { id: 'dimmed', style: { marginTop: 350 }, onClick: () => setClicks(n => n + 1) }, 'Dimmed control'),
              h('output', { id: 'clicks' }, clicks)),
            h(SettingsTour, { tour, currentPage: 'general', dialogRef, onNavigate: () => {}, onDismiss: () => setTour(null) })))
      }
      createRoot(document.getElementById('root')).render(h(Fixture))
    `,
  },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})

test('Settings guide lets the spotlight receive clicks while blocking dimmed controls', async (t) => {
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) })
  } catch (error) {
    if (process.env.BROWSER_EXECUTABLE_PATH) throw error
    try { browser = await chromium.launch({ channel: 'chrome', headless: true }) } catch { throw error }
  }
  try {
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport })
        try {
          await page.setContent(`<style>${botOwnCss(SHELL_CSS)} *{animation:none!important;transition:none!important}</style><div id="root"></div>`)
          await page.addScriptTag({ content: fixture.outputFiles[0].text })
          await page.getByRole('button', { name: 'Open guide', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()
          const search = page.getByRole('textbox', { name: 'Search settings', exact: true })
          await search.click({ timeout: 2500 })
          assert.equal(await search.evaluate(element => document.activeElement === element), true)
          await search.fill('model')
          assert.equal(await search.inputValue(), 'model')
          const blocked = await page.locator('#dimmed').boundingBox()
          await page.mouse.click(blocked.x + blocked.width / 2, blocked.y + blocked.height / 2)
          assert.equal(await page.locator('#clicks').textContent(), '0')
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          await page.locator('.bt-tour-backdrop-dim').waitFor()
          const box = await search.boundingBox()
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          assert.equal(await search.evaluate(element => document.activeElement === element), false)
        } finally { await page.close() }
      })
    }
  } finally { await browser.close() }
})
