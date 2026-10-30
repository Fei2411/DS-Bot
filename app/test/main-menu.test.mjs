// The application menu of macOS: the tray's Quit is the one ordinary way out, so the menu
// has none. Only when the tray is not there does the menu carry one.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// The menu of macOS is the menu of the app on macOS.
Object.defineProperty(process, 'platform', { value: 'darwin' })

before(async () => { await startApp({ packaged: false }) })

test('the application menu of macOS has no Quit', async () => {
  await waitFor(() => state.menus.length > 0, 'set the menu')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const menu = state.menus.at(-1).template
  const items = menu[0].submenu
  assert.equal(menu[0].label, 'DeepSeek Bot', 'the menu of the app')
  assert.equal(items.some(item => item.role === 'quit'), false, 'no Quit of its own')
  assert.equal(items.some(item => item.accelerator === 'CmdOrCtrl+Q' || item.accelerator === 'Command+Q'), false, 'no shortcut for it')
  assert.equal(items.some(item => item.label === 'Quit DeepSeek Bot'), false, 'no entry for it')
  // The menu keeps the rest of macOS: about, services and the hiding of the app.
  const roles = items.map(item => item.role).filter(Boolean)
  for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide']) assert.ok(roles.includes(role), `the menu keeps ${role}`)
})

test('the app ends', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
