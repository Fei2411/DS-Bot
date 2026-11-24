import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
let bundlePromise
const getBundle = () => (bundlePromise ??= build({
  stdin: {
    contents: `
      import React, { createElement as h, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { SHELL_CSS, botOwnCss } from './src/client/styles.js'
      import { SECRET_CSS, SecretCard, SecretsPage } from './src/client/secret-card.js'
      import { allThemes, themeCss } from './src/client/themes.js'

      const Section = ({ title, action, children }) => h('section', { className: 'bt-set-section' },
        h('div', { className: 'bt-set-section-head' }, h('h3', null, title), action),
        h('div', { className: 'bt-set-card' }, children))

      function Harness() {
        const [saved, setSaved] = useState([])
        const actions = {
          holdCard: () => () => {},
          secretSet: payload => {
            setSaved(list => [...list, payload])
            window.__saved = [...(window.__saved ?? []), payload]
            return Promise.resolve(true)
          },
          secretUpdate: () => Promise.resolve(true),
          secretDelete: () => Promise.resolve(true),
          secretCancel: () => Promise.resolve(true),
          secretAllow: () => Promise.resolve(true),
          secretEncrypt: () => Promise.resolve(true),
        }
        const roster = {
          bots: [{ id: 'b1', name: 'Chief', shape: 'whale', color: 'blue' }],
          byId: { b1: { id: 'b1', name: 'Chief', shape: 'whale', color: 'blue' } },
          secrets: [{ name: 'SSH_KEY', purpose: 'deploy key', scope: 'all', requestedBy: 'b1', createdAt: Date.now(), updatedAt: Date.now() }],
          secretStore: { mode: 'plaintext', locked: false },
        }
        return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 480px', gap: '24px', padding: '24px', alignItems: 'start' } },
          h('div', { id: 'settings-host', className: 'bt-settings-page' },
            h(SecretsPage, { roster, actions, run: p => Promise.resolve(p), Section })),
          h('div', { id: 'card-host' },
            h(SecretCard, {
              sessionId: 'b1',
              bot: roster.bots[0],
              request: { id: 'req-1', kind: 'fill', name: 'DEPLOY_PEM', purpose: 'Release signing key' },
              roster,
              actions,
            })),
          h('pre', { id: 'saved-log', style: { display: 'none' } }, JSON.stringify(saved)))
      }

      const css = [
        themeCss(allThemes().deepseek),
        'body{background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);margin:0}',
        botOwnCss(SHELL_CSS),
        SECRET_CSS,
        '*{animation:none!important;transition:none!important}',
      ].join('\\n')
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
      createRoot(document.getElementById('root')).render(h(Harness))
    `,
    resolveDir: PLUGIN,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
}).then(({ outputFiles }) => outputFiles[0].text))

async function launchBrowser() {
  const options = {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
  }
  try {
    return await chromium.launch(options)
  } catch (error) {
    if (process.env.BROWSER_EXECUTABLE_PATH) throw error
    return chromium.launch({ channel: 'chrome', headless: true }).catch(() => { throw error })
  }
}

test('secret inputs preserve multiline typing and pasting, stay masked, and grow without clipping', async (t) => {
  let browser
  try {
    browser = await launchBrowser()
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the multiline secret browser test')
      return
    }
    throw error
  }
  const bundle = await getBundle()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error))
    try {
      await page.setContent('<!doctype html><div id="root"></div>')
      await page.addScriptTag({ content: bundle })
      assert.deepEqual(pageErrors, [])
      await page.waitForSelector('#settings-host')

      // 1. Settings -> Add a key: type multi-line text using Enter and submit with Ctrl+Enter.
      await page.getByRole('button', { name: 'Add a key' }).click()
      const nameInput = page.getByLabel('Key name')
      await nameInput.fill('MULTI_CERT')
      const addArea = page.locator('#settings-host .bt-secret-add textarea')
      const initialBox = await addArea.boundingBox()
      await addArea.click()
      await page.keyboard.type('line-one-alpha')
      await page.keyboard.press('Enter')
      await page.keyboard.type('  line-two-beta')
      await page.keyboard.press('Enter')
      await page.keyboard.type('line-three-gamma')

      const typedMetrics = await page.evaluate(() => {
        const area = document.querySelector('#settings-host .bt-secret-add textarea')
        const field = area.closest('.bt-secret-field')
        const areaRect = area.getBoundingClientRect()
        const fieldRect = field.getBoundingClientRect()
        return {
          value: area.value,
          masked: getComputedStyle(area).webkitTextSecurity,
          placeholderMasked: getComputedStyle(area, '::placeholder').webkitTextSecurity,
          areaHeight: areaRect.height,
          fieldHeight: fieldRect.height,
          fitsInsideField: areaRect.top >= fieldRect.top && areaRect.bottom <= fieldRect.bottom + 1,
          savedCount: (window.__saved ?? []).length,
        }
      })
      assert.equal(typedMetrics.value, 'line-one-alpha\n  line-two-beta\nline-three-gamma')
      assert.equal(typedMetrics.masked, 'disc')
      assert.equal(typedMetrics.placeholderMasked, 'none')
      assert.equal(typedMetrics.savedCount, 0, 'pressing Enter must not submit prematurely')
      assert.ok(typedMetrics.areaHeight > initialBox.height + 20, `textarea should grow (${initialBox.height} -> ${typedMetrics.areaHeight})`)
      assert.ok(typedMetrics.fieldHeight >= typedMetrics.areaHeight + 10, `field wrapper must grow with textarea (${typedMetrics.fieldHeight} vs ${typedMetrics.areaHeight})`)
      assert.equal(typedMetrics.fitsInsideField, true, 'textarea must not overflow its border wrapper')

      await page.keyboard.press('Control+Enter')
      await page.waitForFunction(() => (window.__saved ?? []).length === 1)
      const firstSaved = await page.evaluate(() => window.__saved[0])
      assert.equal(firstSaved.name, 'MULTI_CERT')
      assert.equal(firstSaved.value, 'line-one-alpha\n  line-two-beta\nline-three-gamma')

      // 2. Settings -> Expand SSH_KEY -> Replace value: paste 20 lines and verify max-height clamping + scroll.
      await page.locator('#settings-host .bt-secret-summary').click()
      const replaceArea = page.locator('#settings-host .bt-secret-edit textarea')
      const longMultiline = Array.from({ length: 20 }, (_, i) => `segment-${String(i + 1).padStart(2, '0')}-payload`).join('\n')
      await replaceArea.fill(longMultiline)
      const longMetrics = await page.evaluate(() => {
        const area = document.querySelector('#settings-host .bt-secret-edit textarea')
        const field = area.closest('.bt-secret-field')
        const areaRect = area.getBoundingClientRect()
        const fieldRect = field.getBoundingClientRect()
        return {
          value: area.value,
          areaHeight: areaRect.height,
          fieldHeight: fieldRect.height,
          overflowY: getComputedStyle(area).overflowY,
          scrollHeight: area.scrollHeight,
          fitsInsideField: areaRect.top >= fieldRect.top && areaRect.bottom <= fieldRect.bottom + 1,
        }
      })
      assert.equal(longMetrics.value, longMultiline)
      assert.ok(longMetrics.areaHeight <= 161 && longMetrics.areaHeight >= 158, `height clamps at 160px, got ${longMetrics.areaHeight}`)
      assert.equal(longMetrics.overflowY, 'auto')
      assert.ok(longMetrics.scrollHeight > longMetrics.areaHeight)
      assert.equal(longMetrics.fitsInsideField, true)
      await page.locator('#settings-host .bt-secret-edit').getByRole('button', { name: 'Replace' }).click()
      await page.waitForFunction(() => (window.__saved ?? []).length === 2)
      const secondSaved = await page.evaluate(() => window.__saved[1])
      assert.equal(secondSaved.value, longMultiline)

      // After saving, ValueEditor clears and shrinks back to one line.
      const shrunkHeight = await replaceArea.evaluate(el => el.getBoundingClientRect().height)
      assert.ok(shrunkHeight <= 24, `textarea should shrink back to single-line height, got ${shrunkHeight}`)

      // 3. Chat SecretCard: paste multi-line key, verify growth without clipping, and save.
      const cardArea = page.locator('#card-host textarea')
      const cardMulti = 'cert-header\ncert-body-line-1\ncert-body-line-2\ncert-footer'
      await cardArea.fill(cardMulti)
      const cardMetrics = await page.evaluate(() => {
        const area = document.querySelector('#card-host textarea')
        const field = area.closest('.bt-secret-field')
        const areaRect = area.getBoundingClientRect()
        const fieldRect = field.getBoundingClientRect()
        return {
          value: area.value,
          areaHeight: areaRect.height,
          fieldHeight: fieldRect.height,
          fitsInsideField: areaRect.top >= fieldRect.top && areaRect.bottom <= fieldRect.bottom + 1,
        }
      })
      assert.equal(cardMetrics.value, cardMulti)
      assert.ok(cardMetrics.areaHeight >= 76, `expected 4 lines (~80px), got ${cardMetrics.areaHeight}`)
      assert.equal(cardMetrics.fitsInsideField, true)
      await page.locator('#card-host .bt-q-submit').click()
      await page.waitForFunction(() => (window.__saved ?? []).length === 3)
      const thirdSaved = await page.evaluate(() => window.__saved[2])
      assert.equal(thirdSaved.requestId, 'req-1')
      assert.equal(thirdSaved.value, cardMulti)
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
