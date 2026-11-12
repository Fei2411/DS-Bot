// Screenshots for the local-agents feature, against a manual bench:
// mock-llm on 8876, dsh web on 3176, home .dsh-test-la. One custom ACP agent
// points at test/fixtures/fake-acp.mjs so an abot can chat.
//   node dev/shots-local-agents.mjs <dsh-repo> <out-dir>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, playwright, waitTeam } from './desktop-linux/lib.mjs'

const [repo, outDir] = process.argv.slice(2)
if (!repo || !outDir) { console.error('usage: node dev/shots-local-agents.mjs <dsh-repo> <out-dir>'); process.exit(2) }
const HOME = join(dirname(dirname(fileURLToPath(import.meta.url))), '..', '.dsh-test-la')
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'fake-acp.mjs')

const { chromium } = playwright(repo)
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } })
const login = readFileSync(join(HOME, 'web.log'), 'utf8').match(/http:\/\/127\.0\.0\.1:3176\/\?token=\S+/)?.[0]
await page.goto(login)
await waitTeam(page)
await page.waitForTimeout(1500)

let index = 0
const shot = async name => { await page.waitForTimeout(600); await capture(page, join(outDir, `${String(++index).padStart(2, '0')}-${name}.png`)); console.log('shot', name) }
const api = async (endpoint, payload) => {
  const result = await page.evaluate(([e, p]) => fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e, payload: p }) }).then(r => r.json()), [endpoint, payload])
  return result.value ?? result
}
// DOM clicks ignore every overlay; the notice and drawers never intercept them.
const clickText = (text, scope = '') => page.evaluate(([t, s]) => {
  for (const el of document.querySelectorAll(`${s} button, ${s} [role=menuitem], ${s} a`)) if (el.innerText.trim() === t || el.innerText.trim().includes(t)) { el.click(); return true }
  return false
}, [text, scope])
const clickSel = sel => page.evaluate(s => { const el = document.querySelector(s); if (el) { el.click(); return true } return false }, sel)

// Dismiss the preview notice (any dialog's last button), then give the Main Bot a model.
await page.evaluate(() => { const d = document.querySelector('[role=dialog]'); const b = d?.querySelectorAll('button'); b?.[b.length - 1]?.click() })
await page.waitForTimeout(800)
let state = await api('state', {})
const main = state.bots.find(bot => bot.id === state.mainBotId)
const card = page.locator('.bt-model-card')
if (main && !main.model && await card.isVisible().catch(() => false)) {
  await clickSel('.bt-model-card .bt-model-opt')
  await page.waitForTimeout(2500)
}

// Settings -> Local agents.
await clickSel('.bt-account')
await page.waitForTimeout(600)
await clickText('Bot settings') || await clickText('Bot 设置')
await page.waitForTimeout(1000)
await clickText('Local agents', '.bt-settings-nav') || await clickText('本地 Agent', '.bt-settings-nav')
await page.waitForTimeout(2500)
await shot('settings-local-agents')

// Custom ACP agent at the fake fixture: Add opens the form, Save commits it.
await page.evaluate(() => { for (const el of document.querySelectorAll('button')) if (/Add agent|添加 Agent/.test(el.getAttribute('aria-label') ?? '') && el.offsetParent !== null) { el.click(); return } })
await page.waitForTimeout(600)
await page.evaluate((fixture) => {
  const [name, command, args] = [...document.querySelectorAll('.bt-set-form .bt-input')]
  const set = (el, value) => { const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) }
  if (name) set(name, 'Fake ACP')
  if (command) set(command, 'node')
  if (args) set(args, fixture)
}, FIXTURE)
await page.waitForTimeout(400)
await page.evaluate(() => { for (const el of document.querySelectorAll('button')) if (/^Save|保存/.test(el.innerText) && el.offsetParent !== null) { el.click(); return } })
await page.waitForTimeout(2500)
await shot('local-agents-custom')
await page.evaluate(() => document.querySelector('.bt-settings-nav')?.closest('[role=dialog]')?.querySelector('button')?.click())

// An abot on the fake agent's route.
await api('create-bot', { name: 'Kai' })
state = await api('state', {})
const kai = state.bots.find(bot => bot.name === 'Kai')
const upd = await api('update-bot', { id: kai.id, model: 'acp-fake/default' })
console.log('update-bot:', JSON.stringify(upd).slice(0, 120))
await clickSel(`.bt-row[data-bot-id="${kai.id}"]`) || await clickSel(`.bt-tile[data-bot-id="${kai.id}"]`)
await page.waitForTimeout(1500)

// Model picker showing the local-agent routes.
await clickText('conversation details') || await clickText('详情')
await page.waitForTimeout(800)
await clickSel('.bt-panel .bt-model-trigger')
await page.waitForTimeout(1200)
await shot('model-picker-local-routes')
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
await clickText('Close') || await clickText('关闭')
await page.waitForTimeout(600)

// Chat: streamed text plus thought rows and the badge.
const box = page.locator('[contenteditable="true"], textarea').last()
await page.evaluate(() => { const el = [...document.querySelectorAll('[contenteditable="true"], textarea')].at(-1); el?.focus() })
await box.click().catch(() => {})
await page.keyboard.type('hello abot')
await page.keyboard.press('Enter')
await page.waitForTimeout(8000)
await shot('abot-chat-badge-thoughts')

// Sessions control in the details drawer.
await clickText('conversation details') || await clickText('详情')
await page.waitForTimeout(800)
await shot('abot-sessions')

await browser.close()
console.log('done')
