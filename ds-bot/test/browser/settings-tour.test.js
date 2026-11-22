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
      import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
      import { createPortal } from 'react-dom'
      import { createRoot } from 'react-dom/client'
      import { SettingsTour } from './src/client/settings-tour.js'
      import { ModelMenu } from './src/client/model-menu.js'
      import { FolderMenu } from './src/client/folder-menu.js'
      import { registerPopupOwner } from './src/client/popup-ownership.js'
      function PopupFixture() {
        const dialogRef = useRef(null)
        const [tour, setTour] = useState(null)
        const [prefs, setPrefs] = useState({ enterToSend: true })
        const [writes, setWrites] = useState([])
        const [workspace, setWorkspace] = useState('/alpha')
        const actions = {
          setPrefs: async patch => { setPrefs(value => ({ ...value, ...patch })); setWrites(value => [...value, patch]) },
          folders: async () => ({ team: workspace, folders: [{ path: '/alpha', title: 'Alpha workspace' }, { path: '/beta', title: 'Beta workspace' }] }),
          setTeamWorkspace: async path => { setWorkspace(path); setWrites(value => [...value, { workspace: path }]); return { team: path } },
        }
        const roster = { defaultModel: 'official/alpha', models: [
          { ref: 'official/alpha', provider: 'official', providerName: 'Mock', name: 'Alpha' },
          { ref: 'official/beta', provider: 'official', providerName: 'Mock', name: 'Beta' },
        ] }
        const run = task => Promise.resolve(task)
        return h('div', { className: 'bt-settings-layer' },
          h('div', { className: 'bt-settings', ref: dialogRef },
            h('main', { className: 'bt-settings-main' },
              h('button', { onClick: () => setTour({ mode: 'general', nonce: 1 }) }, 'Open General guide'),
              h('div', { className: 'bt-set-row', 'data-tour': 'default-model' },
                h(ModelMenu, { bot: { id: 'new-bots', name: 'New Bots', model: prefs.defaultBotModel }, roster, actions, run, wide: true, withEfforts: false, fallbackModel: roster.defaultModel,
                  onPick: ref => run(actions.setPrefs({ defaultBotModel: ref })) })),
              h('div', { className: 'bt-set-row', 'data-tour': 'locations' },
                h(FolderMenu, { value: workspace, team: true, wide: true, actions, run, onPick: path => run(actions.setTeamWorkspace(path)) })),
              h('button', { id: 'enter-sends', role: 'switch', 'aria-checked': prefs.enterToSend, onClick: () => run(actions.setPrefs({ enterToSend: !prefs.enterToSend })) }, 'Enter sends message'),
              h('output', { id: 'prefs' }, JSON.stringify(prefs)),
              h('output', { id: 'writes' }, JSON.stringify(writes)),
              h('output', { id: 'workspace' }, workspace)),
            h(SettingsTour, { tour, currentPage: 'general', dialogRef, onNavigate: () => {}, onDismiss: () => setTour(null) })))
      }
      function Fixture() {
        const dialogRef = useRef(null)
        const portalOwner = useRef(null)
        const portalRoot = useRef(null)
        useLayoutEffect(() => registerPopupOwner(portalOwner, portalRoot), [])
        const [tour, setTour] = useState(null)
        const [query, setQuery] = useState('')
        const [clicks, setClicks] = useState(0)
        const [page, setPage] = useState('general')
        const [enterSends, setEnterSends] = useState(true)
        const [saves, setSaves] = useState(0)
        const [menuOpen, setMenuOpen] = useState(false)
        const [pickedModel, setPickedModel] = useState('')
        const trimmed = query.trim().toLowerCase()
        const pickIm = () => { setQuery(''); setTour(null); setPage('im') }
        return h('div', { className: 'bt-settings-layer' },
          h('div', { className: 'bt-settings', ref: dialogRef },
            h('div', { className: 'bt-settings-rail' },
              h('div', { className: 'bt-set-search-wrap', 'data-tour': 'search', 'data-open': trimmed !== '' || undefined },
                h('div', { className: 'bt-set-search' },
                  h('input', {
                    id: 'search',
                    className: 'bt-set-search-input',
                    value: query,
                    'aria-label': 'Search settings',
                    onChange: event => setQuery(event.target.value),
                    onKeyDown: event => { if (event.key === 'Enter' && trimmed === 'im') { event.preventDefault(); pickIm() } },
                  })),
                trimmed !== '' ? h('div', { className: 'bt-set-search-list', role: 'listbox', 'aria-label': 'Search settings' },
                  h('button', { type: 'button', role: 'option', className: 'bt-set-search-hit', onClick: pickIm }, 'IM')) : null),
              trimmed === '' ? h('nav', { className: 'bt-settings-nav' }) : null),
            h('main', { className: 'bt-settings-main' },
              h('output', { id: 'current-page' }, page),
              h('button', { onClick: () => setTour({ mode: 'full', nonce: 1 }) }, 'Open guide'),
              h('button', { id: 'enter-sends', role: 'switch', 'aria-checked': enterSends, onClick: () => { setEnterSends(value => !value); setSaves(value => value + 1) } }, 'Enter sends message'),
              h('output', { id: 'preference' }, String(enterSends)),
              h('output', { id: 'saves' }, saves),
              h('div', { 'data-tour': 'bm-bar' },
                h('button', { id: 'model-target', ref: portalOwner, onClick: () => setMenuOpen(open => !open) }, 'Highlighted model control'),
                h('output', { id: 'picked-model' }, pickedModel)),
              h('div', { id: 'already-inert', inert: true }, h('button', null, 'Unavailable')),
              h('button', { id: 'dimmed', style: { marginTop: 350 }, onClick: () => setClicks(n => n + 1) }, 'Dimmed control'),
              h('output', { id: 'clicks' }, clicks)),
            h(SettingsTour, { tour, currentPage: page, dialogRef, hasProviders: false, onNavigate: setPage, onDismiss: () => setTour(null) })),
          menuOpen ? createPortal(
            h('div', { id: 'portal-menu', ref: portalRoot, className: 'bt-menu bt-model-menu', role: 'menu', style: { top: 120, left: 240 } },
              h('input', { id: 'portal-search', type: 'search', 'aria-label': 'Search models', autoFocus: true }),
              h('button', { id: 'portal-pick', type: 'button', role: 'menuitemradio', onClick: () => { setPickedModel('DeepSeek Pro'); setMenuOpen(false) } }, 'DeepSeek Pro')),
            document.body) : null)
      }
      createRoot(document.getElementById('root')).render(h(document.getElementById('root').dataset.fixture === 'popups' ? PopupFixture : Fixture))
    `,
  },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) })
  } catch (error) {
    if (process.env.BROWSER_EXECUTABLE_PATH) throw error
    return chromium.launch({ channel: 'chrome', headless: true }).catch(() => { throw error })
  }
}

test('Settings guide allows saving through owned model and workspace popups', async (t) => {
  const browser = await launchBrowser()
  try {
    for (const width of [1280, 390]) {
      for (const method of ['mouse', 'keyboard']) {
        await t.test(`${width} ${method}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 860 } })
          try {
            await page.setContent(`<style>${botOwnCss(SHELL_CSS)} *{animation:none!important;transition:none!important}</style><div id="root" data-fixture="popups"></div>`)
            await page.addScriptTag({ content: fixture.outputFiles[0].text })
            await page.getByRole('button', { name: 'Open General guide', exact: true }).click()
            await page.locator('.bt-tour-layer[data-tour-step="default-model"] .bt-tour-spot').waitFor()
            const open = async target => {
              const trigger = page.locator(`[data-tour="${target}"] .bt-model-trigger`)
              if (method === 'mouse') await trigger.click()
              else { await trigger.focus(); await page.keyboard.press('Enter') }
              assert.equal(await page.locator('#enter-sends').evaluate(element => Boolean(element.closest('[inert]'))), true)
            }
            const choose = async (name, target) => {
              const option = page.getByRole('menuitemradio', { name, exact: true, includeHidden: true })
              await option.waitFor()
              assert.equal(await option.evaluate(element => Boolean(element.closest('[inert]'))), false, 'owned popup must not be inert')
              if (method === 'mouse') await option.click({ timeout: 2500 })
              else {
                let reached = false
                for (let i = 0; i < 24; i += 1) {
                  await page.keyboard.press('Tab')
                  const focus = await page.evaluate(target => {
                    const element = document.activeElement
                    return { text: element.textContent, allowed: Boolean(element.closest(`[data-tour="${target}"]`) || element.closest('.bt-tour-card') || element.closest('[role="menu"]')), dimmed: element.id === 'enter-sends' }
                  }, target)
                  if (focus.dimmed) await page.keyboard.press('Space')
                  assert.equal(focus.allowed, true, 'Tab must not reach dimmed controls while a popup is open')
                  if (await option.evaluate(element => document.activeElement === element)) { reached = true; break }
                }
                assert.equal(reached, true, 'owned popup option must be reachable by Tab')
                await page.keyboard.press('Enter')
              }
            }
            await open('default-model')
            if (method === 'keyboard') assert.equal(await page.getByRole('searchbox', { name: 'Search models', exact: true }).evaluate(element => document.activeElement === element), true, 'portal autofocus must be preserved')
            await choose('Beta', 'default-model')
            assert.equal(JSON.parse(await page.locator('#prefs').textContent()).defaultBotModel, 'official/beta')
            assert.deepEqual(JSON.parse(await page.locator('#writes').textContent()), [{ defaultBotModel: 'official/beta' }])
            await page.getByRole('button', { name: 'Next', exact: true }).click()
            await page.locator('.bt-tour-layer[data-tour-step="locations"] .bt-tour-spot').waitFor()
            await open('locations')
            await choose(/^Beta workspace/, 'locations')
            assert.equal(await page.locator('#workspace').textContent(), '/beta')
            assert.deepEqual(JSON.parse(await page.locator('#writes').textContent()), [{ defaultBotModel: 'official/beta' }, { workspace: '/beta' }])
            assert.equal(JSON.parse(await page.locator('#prefs').textContent()).enterToSend, true)
          } finally { await page.close() }
        })
      }
    }
  } finally { await browser.close() }
})

test('Settings guide lets the spotlight receive clicks while blocking dimmed controls', async (t) => {
  const browser = await launchBrowser()
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
          await page.locator('.bt-tour-layer[data-tour-step="bm-bar"] .bt-tour-spot').waitFor()
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

test('Settings guide contains keyboard focus and prevents dimmed preference saves', async (t) => {
  const browser = await launchBrowser()
  try {
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport })
        try {
          await page.setContent(`<style>${botOwnCss(SHELL_CSS)} *{animation:none!important;transition:none!important}</style><div id="root"></div>`)
          await page.addScriptTag({ content: fixture.outputFiles[0].text })
          await page.getByRole('button', { name: 'Open guide', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()
          const cycle = async (target, key = 'Tab') => {
            const visited = new Set()
            const leaks = []
            for (let i = 0; i < 18; i += 1) {
              await page.keyboard.press(key)
              const focus = await page.evaluate(target => {
                const element = document.activeElement
                return { name: element.id || element.textContent, allowed: Boolean(element.closest(`[data-tour="${target}"]`) || element.closest('.bt-tour-card')), dimmed: element.id === 'enter-sends' }
              }, target)
              visited.add(focus.name)
              if (!focus.allowed) leaks.push(focus.name)
              if (focus.dimmed) await page.keyboard.press('Space')
            }
            assert.equal(await page.locator('#saves').textContent(), '0', 'Space must not save a dimmed preference')
            assert.equal(await page.locator('#preference').textContent(), 'true')
            assert.deepEqual(leaks, [], 'Tab must stay in the current spotlight and guide')
            assert.ok(visited.has(target === 'search' ? 'search' : 'model-target'), 'highlighted control must be keyboard reachable')
            assert.ok(visited.has('Skip') && visited.has('Next'), 'guide buttons must be keyboard reachable')
          }
          await cycle('search')
          await cycle('search', 'Shift+Tab')
          await page.locator('#search').focus()
          await page.locator('#enter-sends').evaluate(element => element.focus())
          await page.keyboard.press('Space')
          assert.equal(await page.locator('#saves').textContent(), '0')
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="bm-bar"] .bt-tour-spot').waitFor()
          await cycle('bm-bar')
          await page.getByRole('button', { name: 'Back', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()
          await cycle('search')
          await page.getByRole('button', { name: 'Skip', exact: true }).click()
          await page.locator('.bt-tour-layer').waitFor({ state: 'detached' })
          await page.getByRole('switch', { name: 'Enter sends message', exact: true }).focus()
          await page.keyboard.press('Space')
          assert.equal(await page.locator('#preference').textContent(), 'false')
          assert.equal(await page.locator('#saves').textContent(), '1')
          assert.equal(await page.locator('#already-inert').evaluate(element => element.inert), true)
          assert.equal(await page.locator('#search').evaluate(element => element.closest('[inert]')), null)
        } finally { await page.close() }
      })
    }
  } finally { await browser.close() }
})

test('Settings guide allows clicking search hits, avoids snap-back, and replays from step 0', async (t) => {
  const browser = await launchBrowser()
  try {
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport })
        try {
          await page.setContent(`<style>${botOwnCss(SHELL_CSS)} *{animation:none!important;transition:none!important}</style><div id="root"></div>`)
          await page.addScriptTag({ content: fixture.outputFiles[0].text })
          await page.getByRole('button', { name: 'Open guide', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()

          // Advance, dismiss, and replay → must restart at step 0 (search), not bm-bar.
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="bm-bar"] .bt-tour-spot').waitFor()
          await page.getByRole('button', { name: 'Skip', exact: true }).click()
          await page.locator('.bt-tour-layer').waitFor({ state: 'detached' })
          await page.getByRole('button', { name: 'Open guide', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()

          // Type in search and click the rendered hit inside [data-tour="search"].
          const search = page.getByRole('textbox', { name: 'Search settings', exact: true })
          await search.fill('im')
          const hit = page.getByRole('option', { name: 'IM', exact: true })
          await hit.waitFor()
          await hit.click({ timeout: 2500 })
          await page.locator('.bt-tour-layer').waitFor({ state: 'detached' })
          assert.equal(await page.locator('#current-page').textContent(), 'im')
        } finally { await page.close() }
      })
    }
  } finally { await browser.close() }
})

test('Settings guide keeps owned portaled .bt-menu controls interactive while dimmed controls stay inert', async (t) => {
  const browser = await launchBrowser()
  try {
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport })
        try {
          await page.setContent(`<style>${botOwnCss(SHELL_CSS)} *{animation:none!important;transition:none!important}</style><div id="root"></div>`)
          await page.addScriptTag({ content: fixture.outputFiles[0].text })
          await page.getByRole('button', { name: 'Open guide', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="search"] .bt-tour-spot').waitFor()
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          await page.locator('.bt-tour-layer[data-tour-step="bm-bar"] .bt-tour-spot').waitFor()

          // Click the highlighted trigger to portal a .bt-menu into document.body.
          await page.locator('#model-target').click({ timeout: 2500 })
          await page.locator('#portal-menu').waitFor()
          assert.equal(await page.locator('#portal-menu').evaluate(element => element.closest('[inert]')), null, 'portaled .bt-menu must not be inert')
          assert.notEqual(await page.locator('#enter-sends').evaluate(element => element.closest('[inert]')), null, 'dimmed switch must stay inert')
          assert.notEqual(await page.locator('#dimmed').evaluate(element => element.closest('[inert]')), null, 'dimmed control must stay inert')

          // Auto-focused search inside the portaled menu keeps focus and accepts input.
          assert.equal(await page.locator('#portal-search').evaluate(element => document.activeElement === element), true)
          await page.locator('#portal-search').fill('pro')
          assert.equal(await page.locator('#portal-search').inputValue(), 'pro')

          // Tab cycles through spotlight, portaled menu, and guide card without leaking to dimmed controls.
          const visited = new Set()
          const leaks = []
          for (let i = 0; i < 12; i += 1) {
            await page.keyboard.press('Tab')
            const focus = await page.evaluate(() => {
              const element = document.activeElement
              return {
                name: element.id || element.textContent,
                allowed: Boolean(element.closest('[data-tour="bm-bar"]') || element.closest('#portal-menu') || element.closest('.bt-tour-card')),
              }
            })
            visited.add(focus.name)
            if (!focus.allowed) leaks.push(focus.name)
          }
          assert.deepEqual(leaks, [], 'Tab must stay inside spotlight, portaled menu, and guide card')
          assert.ok(visited.has('portal-search') && visited.has('portal-pick'), 'portaled menu controls must be keyboard reachable')
          assert.ok(visited.has('model-target'), 'spotlight control must stay keyboard reachable')

          // Clicking a portaled menu option succeeds while the guide is still open.
          await page.locator('#portal-pick').click({ timeout: 2500 })
          await page.locator('#portal-menu').waitFor({ state: 'detached' })
          assert.equal(await page.locator('#picked-model').textContent(), 'DeepSeek Pro')
          assert.notEqual(await page.locator('#enter-sends').evaluate(element => element.closest('[inert]')), null, 'dimmed switch stays inert after closing portaled menu')
        } finally { await page.close() }
      })
    }
  } finally { await browser.close() }
})
