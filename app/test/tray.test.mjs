// The system tray: the icon, its menu and the way it goes away.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { createTray } from '../src/tray.mjs'

function harness({ platform = 'win32' } = {}) {
  const trays = []
  const menus = []
  const Menu = { buildFromTemplate: template => template }
  const Tray = class extends EventEmitter {
    constructor(image) { super(); this.image = image; trays.push(this) }
    setToolTip(value) { this.tooltip = value }
    setContextMenu(menu) { this.menu = menu; menus.push(menu) }
    destroy() { this.destroyed = true }
  }
  const calls = { open: 0, quit: 0 }
  const tray = createTray({
    Tray, Menu, platform, image: { empty: false }, tooltip: 'DeepSeek Bot',
    open: { label: 'Open', run: () => { calls.open += 1 } },
    quit: { label: 'Quit', run: () => { calls.quit += 1 } },
    log: { warn: () => {} },
  })
  return { tray, trays, menus, calls }
}

describe('the tray', () => {
  test('the icon carries the tooltip and a menu with Open and Quit', () => {
    const app = harness()
    assert.equal(app.trays.length, 1)
    assert.equal(app.trays[0].tooltip, 'DeepSeek Bot')
    assert.deepEqual(app.menus[0].map(item => item.label ?? 'separator'), ['Open', 'separator', 'Quit'])
  })

  test('a click opens the window, and the menu opens and quits it', () => {
    const app = harness()
    app.trays[0].emit('click')
    assert.equal(app.calls.open, 1)
    app.menus[0][0].click()
    assert.equal(app.calls.open, 2)
    app.menus[0].at(-1).click()
    assert.equal(app.calls.quit, 1)
  })

  test('on macOS the menu of the icon is the way back, not a click', () => {
    const app = harness({ platform: 'darwin' })
    assert.equal(app.trays[0].listenerCount('click'), 0, 'the icon has no click of its own')
    app.menus[0][0].click()
    assert.equal(app.calls.open, 1)
  })

  test('the icon goes away once', () => {
    const app = harness()
    app.tray.dispose()
    app.tray.dispose()
    assert.equal(app.trays[0].destroyed, true)
  })
})
