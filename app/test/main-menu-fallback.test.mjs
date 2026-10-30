// Without a system tray the app has no ordinary way out, so the application menu of macOS
// carries a Quit of its own. It is the only case in which the menu has one.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// The menu of macOS is the menu of the app on macOS.
Object.defineProperty(process, 'platform', { value: 'darwin' })

before(async () => {
  // The desktop has no tray.
  state.trayFails = true
  await startApp({ packaged: false })
})

test('the application menu of macOS carries a Quit when there is no tray', async () => {
  await waitFor(() => state.menus.length > 0, 'set the menu')
  assert.equal(state.tray, undefined, 'there is no tray')
  const items = state.menus.at(-1).template[0].submenu
  const quit = items.at(-1)
  assert.equal(quit.label, 'Quit DeepSeek Bot', 'the menu ends the app')
  assert.equal(typeof quit.click, 'function', 'the entry works')
  quit.click()
  await waitFor(() => state.quits > 0, 'end the app')
})
