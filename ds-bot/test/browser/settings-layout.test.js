import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS, botOwnCss } from './src/client/styles.js'",
    resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
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

async function launchBrowser() {
  const options = {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
  }
  try {
    return await chromium.launch(options)
  } catch (error) {
    if (process.env.BROWSER_EXECUTABLE_PATH) throw error
    // Local contributors who have Chrome installed but did not run playwright install.
    return chromium.launch({ channel: 'chrome', headless: true }).catch(() => { throw error })
  }
}

test('DS Bot preference rows keep one divider each and empty items vanish (#1815)', async (t) => {
  let browser
  try {
    browser = await launchBrowser()
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the settings layout regression')
      return
    }
    throw error
  }
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    try {
      const row = text => `<div class="bt-set-row"><div class="bt-set-copy">${text}</div></div>`
      // SettingsPreferences renders straight into .bt-dsh-item (no [data-slot] wrapper): an item may
      // be empty, hold several rows, or hold a row followed by an error note.
      await page.setContent(fixture(`<section class="bt-set-section"><div class="bt-set-card">
        <div class="bt-dsh-item">${row('language')}</div>
        <div class="bt-dsh-item" id="empty-a"></div>
        <div class="bt-dsh-item">${row('transcript')}${row('collapse')}${row('folded')}</div>
        <div class="bt-dsh-item" id="empty-b"></div>
        <div class="bt-dsh-item">${row('permission')}<div class="bt-set-note" role="alert">Unavailable</div></div>
        <div class="bt-dsh-item" id="empty-c"></div>
      </div></section>`))
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.bt-set-card')
        const visible = element => getComputedStyle(element).display !== 'none'
        const lines = [...card.querySelectorAll('.bt-dsh-item, .bt-set-row, .bt-set-note')]
          .filter(element => visible(element) && parseFloat(getComputedStyle(element).borderTopWidth) > 0)
        return {
          hidden: ['#empty-a', '#empty-b', '#empty-c'].map(selector => visible(document.querySelector(selector))),
          blocks: card.querySelectorAll('.bt-set-row, .bt-set-note').length,
          lines: lines.length,
          note: getComputedStyle(card.querySelector('.bt-set-note')).paddingLeft,
        }
      })
      assert.deepEqual(layout.hidden, [false, false, false], JSON.stringify(layout))
      assert.equal(layout.lines, layout.blocks - 1, JSON.stringify(layout))
      assert.equal(layout.note, '16px', JSON.stringify(layout))
    } finally { await page.close() }
  } finally { await browser.close() }
})

test('DSH settings pages keep usable height and scrolling (#1359)', async (t) => {
  let browser
  try {
    browser = await launchBrowser()
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the settings layout regression')
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
    await t.test('direct .bt-set-card children keep natural height and scroll in short viewports', async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 420 } })
      try {
        await page.setContent(`<!doctype html><style>
          ${botOwnCss(SHELL_CSS)}
          *{animation:none!important;transition:none!important}
        </style>
        <div class="bt-settings-layer"><div class="bt-settings">
          <nav class="bt-settings-nav">Settings</nav>
          <div class="bt-settings-main">
            <div class="bt-settings-head"><h2>Models</h2></div>
            <div class="bt-settings-scroll bt-settings-page">
              <section class="bt-set-section"><div class="bt-set-card" style="height:520px"><div class="bt-set-row">Provider list</div></div></section>
              <div class="bt-set-card" id="advanced-card">
                <button type="button" class="bt-set-row" id="advanced-btn"><span class="bt-set-copy"><span>Advanced settings</span></span></button>
              </div>
            </div>
          </div>
        </div></div>`)
        await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
        const layout = await page.evaluate(() => {
          const scroll = document.querySelector('.bt-settings-scroll')
          const card = document.querySelector('#advanced-card')
          const btn = document.querySelector('#advanced-btn')
          const scrollRect = scroll.getBoundingClientRect()
          const cardRect = card.getBoundingClientRect()
          const btnRect = btn.getBoundingClientRect()
          return {
            scrollTop: scroll.scrollTop,
            cardHeight: cardRect.height,
            btnHeight: btnRect.height,
            btnTop: btnRect.top,
            btnBottom: btnRect.bottom,
            scrollTopEdge: scrollRect.top,
            scrollBottomEdge: scrollRect.bottom,
          }
        })
        assert.ok(layout.scrollTop > 0, JSON.stringify(layout))
        assert.ok(layout.cardHeight >= 48, `direct .bt-set-card must not collapse: ${JSON.stringify(layout)}`)
        assert.ok(layout.btnHeight >= 48, `button inside .bt-set-card must not be clipped: ${JSON.stringify(layout)}`)
        assert.ok(layout.btnTop >= layout.scrollTopEdge && layout.btnBottom <= layout.scrollBottomEdge, JSON.stringify(layout))
      } finally { await page.close() }
    })
  } finally { await browser.close() }
})

test('Segmented adapts without clipping across narrow/wide panels, services actions, unbreakable words, and AvatarEditor fits 320px drawer', async (t) => {
  let browser
  try {
    browser = await launchBrowser()
  } catch (error) {
    if (!process.env.CI && /not found|doesn't exist|not installed/i.test(error.message)) {
      t.skip('Chromium or Chrome is required for the segmented layout regression')
      return
    }
    throw error
  }
  const { outputFiles: bundleFiles } = await build({
    stdin: {
      contents: `
        import React, { createElement as h, useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { Segmented } from './src/client/motion.js'
        import { SHELL_CSS } from './src/client/styles.js'
        import { BOT_SETTINGS_CSS } from './src/client/bot-settings.js'
        import { SERVICES_CSS } from './src/client/services-settings.js'
        function Seg({ options, className, initial = 0 }) {
          const [val, setVal] = useState(options[initial][0])
          return h(Segmented, { label: 'Choice', value: val, className },
            options.map(([id, text]) => h('button', { key: id, type: 'button', 'aria-pressed': val === id, onClick: () => setVal(id) }, text)))
        }
        window.__SEG_TEST__ = {
          CSS: [SHELL_CSS, BOT_SETTINGS_CSS, SERVICES_CSS].join('\\n'),
          mount(rootEl, props) {
            if (!rootEl._root) rootEl._root = createRoot(rootEl)
            rootEl._root.render(
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px' } },
                h('div', { id: 'panel-wrap', style: { width: props.panelW + 'px' } },
                  h('div', { className: 'bt-drawer-body', style: { padding: '16px', boxSizing: 'border-box' } },
                    h('div', { className: 'bt-drawer-permission' },
                      h(Seg, { className: 'bt-permissions', initial: 1, options: [['a', 'Read only'], ['b', 'Workspace'], ['c', 'Full access'], ['d', 'Review for me']] })))),
                h('div', { id: 'svc-wrap', style: { width: '288px' } },
                  h('div', { className: 'bt-svc' },
                    h('div', { className: 'bt-set-card' },
                      h('div', { className: 'bt-set-row' },
                        h('div', { className: 'bt-set-copy' }, h('span', null, 'Read replies aloud')),
                        h('div', { className: 'bt-set-control' },
                          h('div', { className: 'bt-svc-actions' },
                            h('span', { className: 'bt-svc-state' }, 'Ready'),
                            h(Seg, { className: 'bt-svc-seg', options: [['a', 'System voice option'], ['b', 'DeepSeek voice option'], ['c', 'Custom provider'], ['d', 'Local offline']] }))))))),
                h('div', { id: 'long-wrap', style: { width: '200px' } },
                  h(Seg, { options: [['a', 'First choice'], ['b', 'WiderWord123456']] })),
                h('div', { id: 'font-wrap', style: { width: '360px' } },
                  h(Seg, { options: [['a', 'Light mode'], ['b', 'Dark mode'], ['c', 'System']] })),
                h('div', { id: 'avedit-panel', className: 'bt-panel', style: { width: '320px', height: '400px', position: 'relative', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #ccc' } },
                  h('div', { className: 'bt-drawer-body bt-set-body' },
                    h('div', { className: 'bt-bs' },
                      h('div', { className: 'bt-bs-hero' },
                        h('div', { className: 'bt-avatar-anchor' },
                          h('button', { type: 'button', className: 'bt-avatar-trigger' }),
                          h('div', { className: 'bt-avedit' },
                            h('div', { className: 'bt-avedit-top' },
                              h('div', { className: 'bt-avedit-tabs' },
                                h('button', { type: 'button', className: 'bt-avedit-tab', 'aria-selected': true }, 'Bot'),
                                h('button', { type: 'button', className: 'bt-avedit-tab' }, 'Hochladen'),
                                h('button', { type: 'button', className: 'bt-avedit-tab' }, 'Mediathek')),
                              h('button', { type: 'button', className: 'bt-avedit-tab bt-avedit-reset' }, 'Zurücksetzen'))))))))))
          },
        }
      `,
      resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.setContent('<!doctype html><html><head><style id="s"></style></head><body data-bt-effects="off" style="margin:0;font-family:var(--bt-font)"><div id="root"></div></body></html>')
      await page.addScriptTag({ content: bundleFiles[0].text })
      const res = await page.evaluate(async () => {
        document.getElementById('s').textContent = window.__SEG_TEST__.CSS
        const root = document.getElementById('root')
        const wait = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))
        window.__SEG_TEST__.mount(root, { panelW: 320, fontSize: 13 })
        await wait()

        const perm = root.querySelector('#panel-wrap .bt-seg')
        const layout320 = perm.dataset.layout || 'row'
        // Click row 2 button ("Review for me") and verify 2D thumb rect matches button rect.
        const lastBtn = perm.querySelectorAll('button')[3]
        lastBtn.click()
        await wait()
        const tr320 = perm.querySelector('.bt-thumb').getBoundingClientRect()
        const br320 = lastBtn.getBoundingClientRect()
        const thumb320Ok = Math.abs(tr320.left - br320.left) < 1.5 && Math.abs(tr320.top - br320.top) < 1.5 && Math.abs(tr320.width - br320.width) < 1.5 && Math.abs(tr320.height - br320.height) < 1.5

        // Widen 320 -> 520 (back to 1 row) then shrink 520 -> 320 (must return to grid-2, not stack).
        window.__SEG_TEST__.mount(root, { panelW: 520, fontSize: 13 })
        await wait()
        const layout520 = perm.dataset.layout || 'row'
        window.__SEG_TEST__.mount(root, { panelW: 320, fontSize: 13 })
        await wait()
        const layoutBack320 = perm.dataset.layout || 'row'

        // Live font-size change (same container width & textContent) re-evaluates Segmented layout.
        const fontWrap = root.querySelector('#font-wrap')
        const fontSeg = fontWrap.querySelector('.bt-seg')
        const initialSegW = Math.ceil(fontSeg.getBoundingClientRect().width)
        fontWrap.style.width = `${initialSegW + 12}px`
        await wait()
        const fontBefore = fontSeg.dataset.layout || 'row'
        const fontStyle = document.createElement('style')
        fontStyle.textContent = '#font-wrap .bt-seg button{font-size:20px}'
        document.head.appendChild(fontStyle)
        window.__SEG_TEST__.mount(root, { panelW: 320, fontSize: 20 })
        await wait()
        const fontAfter = fontSeg.dataset.layout || 'row'
        fontStyle.remove()

        // Services .bt-svc-actions must stay inside 288px card with zero clipping.
        const svcCard = root.querySelector('#svc-wrap .bt-set-card')
        const svcSeg = root.querySelector('#svc-wrap .bt-svc-seg')
        const svcClipped = svcSeg.getBoundingClientRect().right > svcCard.getBoundingClientRect().right + 1.5

        // Unbreakable word in 200px grid-2 must promote to stack with zero text overflow.
        const longSeg = root.querySelector('#long-wrap .bt-seg')
        const longLayout = longSeg.dataset.layout || 'row'
        const longOver = [...longSeg.querySelectorAll('button')].some(b => b.scrollWidth > b.clientWidth + 1)

        // Verify no redundant data-layout mutation thrash after mount settles (line-height invariant).
        let mutations = 0
        const mo = new MutationObserver(() => { mutations += 1 })
        mo.observe(perm, { attributes: true, attributeFilter: ['data-layout'] })
        perm.querySelectorAll('button')[0].click()
        await wait()
        mo.disconnect()

        // AvatarEditor inside 320px right panel must not cause horizontal scroll or left/right clipping.
        const avBody = root.querySelector('#avedit-panel .bt-drawer-body')
        const avPop = root.querySelector('#avedit-panel .bt-avedit')
        const avBodyRect = avBody.getBoundingClientRect()
        const avPopRect = avPop.getBoundingClientRect()
        const avOverflow = avBody.scrollWidth > avBody.clientWidth + 1
        const avClipped = avPopRect.right > avBodyRect.right + 1 || avPopRect.left < avBodyRect.left - 1

        return { layout320, thumb320Ok, layout520, layoutBack320, mutations, fontBefore, fontAfter, svcLayout: svcSeg.dataset.layout, svcClipped, longLayout, longOver, avOverflow, avClipped }
      })
      assert.equal(res.layout320, 'grid-2', JSON.stringify(res))
      assert.equal(res.thumb320Ok, true, JSON.stringify(res))
      assert.equal(res.layout520, 'row', JSON.stringify(res))
      assert.equal(res.layoutBack320, 'grid-2', JSON.stringify(res))
      assert.equal(res.mutations, 0, JSON.stringify(res))
      assert.equal(res.fontBefore, 'row', JSON.stringify(res))
      assert.equal(res.fontAfter, 'wrap', JSON.stringify(res))
      assert.equal(res.svcClipped, false, JSON.stringify(res))
      assert.equal(res.longLayout, 'stack', JSON.stringify(res))
      assert.equal(res.longOver, false, JSON.stringify(res))
      assert.equal(res.avOverflow, false, JSON.stringify(res))
      assert.equal(res.avClipped, false, JSON.stringify(res))
    } finally { await page.close() }
  } finally { await browser.close() }
})
