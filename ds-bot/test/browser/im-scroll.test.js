import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

test('IM setup and connection details start at the top of the settings pane', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { ImPage, IM_CSS } from './src/client/im-page.js'
        import { CONNECTORS_PAGE_CSS } from './src/client/connectors-page.js'
        import { SHELL_CSS } from './src/client/styles.js'
        const style = document.createElement('style')
        style.textContent = SHELL_CSS + CONNECTORS_PAGE_CSS + IM_CSS
        document.head.append(style)
        const bots = Array.from({length: 10}, (_, i) => ({id: String(i), name: 'Example ' + i}))
        const connections = bots.map(bot => ({
          id: 'im-' + bot.id, platform: 'telegram', botId: bot.id, enabled: true, paired: [], requests: [], chats: {},
        }))
        const roster = {bots, rooms: [], im: {connections, platforms: ['telegram', 'discord']}, imStatus: {}}
        const actions = {imAdd: () => new Promise((_resolve, reject) => { window.failCheck = () => reject(new Error('Account check timed out')) })}
        createRoot(document.getElementById('root')).render(React.createElement(ImPage, {roster, actions}))`,
      resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    },
    external: ['@deepseek-ai/dsh-client-ui-primitives'],
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  })
  const options = {headless: true}
  const browser = process.env.BROWSER_EXECUTABLE_PATH
    ? await chromium.launch({...options, executablePath: process.env.BROWSER_EXECUTABLE_PATH})
    : await chromium.launch(options).catch(() => chromium.launch({...options, channel: 'chrome'}))
  try {
    const page = await browser.newPage({viewport: {width: 800, height: 600}})
    await page.setContent(`<style>
        body {margin: 0; min-height: 1600px}
        #frame {margin-top: 320px; width: 520px; padding: 12px}
        #pane {height: 280px; display: block; overflow-y: auto; box-sizing: border-box}
      </style><section id="frame"><div id="pane" class="bt-settings-scroll"><div id="root"></div></div></section>`)
    // The standalone fixture only uses the plugin's IM controls.
    await page.evaluate(() => { window.require = () => ({}) })
    await page.addScriptTag({content: outputFiles[0].text})
    const pane = page.locator('#pane')
    await page.evaluate(() => window.scrollTo(0, 240))
    const outer = await page.evaluate(() => window.scrollY)
    const tile = name => page.locator('.bt-app').filter({hasText: name}).getByRole('button', {name: 'Connect'})
    const top = () => pane.evaluate(el => el.scrollTop)
    const insidePane = locator => locator.evaluate(el => {
      const box = el.getBoundingClientRect()
      const paneBox = el.closest('.bt-settings-scroll').getBoundingClientRect()
      return box.height > 0 && box.top >= paneBox.top && box.bottom <= paneBox.bottom
    })

    await tile('Telegram').scrollIntoViewIfNeeded()
    assert.ok(await top() > 0)
    await tile('Telegram').click()
    const token = page.getByLabel('Bot token', {exact: true})
    await token.waitFor()
    assert.equal(await top(), 0)
    assert.ok(await insidePane(token))
    assert.equal(await page.evaluate(() => window.scrollY), outer)

    await token.fill('fixture')
    const submit = page.getByRole('button', {name: 'Connect', exact: true})
    await submit.click()
    await page.getByRole('button', {name: 'Connecting…'}).waitFor()
    await page.evaluate(() => window.failCheck())
    await page.getByRole('alert').waitFor()
    assert.ok(await submit.isEnabled())

    await page.getByRole('button', {name: 'Back'}).click()
    await tile('Discord').focus()
    await tile('Discord').press('Enter')
    await page.getByRole('heading', {name: 'Discord'}).waitFor()
    assert.equal(await top(), 0)

    await page.getByRole('button', {name: 'Back'}).click()
    const connection = page.locator('.bt-im-bot').last()
    await connection.focus()
    await connection.press('Enter')
    const heading = page.locator('.bt-app-sub-head h3')
    await heading.waitFor()
    assert.equal(await top(), 0)
    assert.ok(await insidePane(heading))
    assert.equal(await page.evaluate(() => window.scrollY), outer)
  } finally {
    await browser.close()
  }
})
