// The window and the tray share one life: the close hides the window, the tray is the way
// back to it, and only the app itself ends the app.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createShell } from '../src/shell.mjs'

/** A window like Electron's: the shell shows, hides, focuses and minimizes it. */
class FakeWindow extends EventEmitter {
  constructor() {
    super()
    this.visible = true
    this.minimized = false
    this.fullScreen = false
    this.destroyed = false
    this.shown = 0
    this.focused = 0
  }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  isFullScreen() { return this.fullScreen }
  setFullScreen(value) { this.fullScreen = value; if (!value && !this.deferFullScreen) this.emit('leave-full-screen') }
  hide() { this.visible = false }
  show() { this.visible = true; this.shown += 1 }
  focus() { this.focused += 1 }
  restore() { this.minimized = false }
  minimize() { this.minimized = true }
}

// The notice answers in its own turn; the tests wait for it.
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness({ platform = 'win32', trayFails = false, busy = false, ready = true, answer = 0, acknowledged = true, fallbackAnswer = 1 } = {}) {
  const app = new EventEmitter()
  const powerMonitor = new EventEmitter()
  const trays = []
  const menus = []
  const calls = { quit: 0, build: 0, reveal: 0 }
  const folder = mkdtempSync(join(tmpdir(), 'ds-bot-shell-'))
  const marker = join(folder, 'acknowledged')
  if (acknowledged) writeFileSync(marker, '')
  const asked = []
  const questions = []
  let window = new FakeWindow()
  const shell = createShell({
    electron: {
      app,
      powerMonitor,
      Menu: { buildFromTemplate: template => template },
      Tray: class {
        constructor(image) { this.image = image; this.handlers = {}; trays.push(this) }
        on(event, handler) { (this.handlers[event] ??= []).push(handler) }
        setToolTip(value) { this.tooltip = value }
        setContextMenu(menu) { this.menu = menu; menus.push(menu) }
        destroy() { this.destroyed = true }
        click() { for (const handler of this.handlers.click ?? []) handler() }
      },
    },
    platform,
    messages: () => ({
      tooltip: 'DeepSeek Bot', open: 'Open', quit: 'Quit', notice: 'The app goes on.', noticeConfirm: 'OK',
      fallback: 'The system tray is not available, so the app cannot stay in the background. Do you want to end it?', cancel: 'Cancel',
    }),
    trayImage: () => {
      if (trayFails) throw new Error('no system tray here')
      return { empty: false }
    },
    window: () => window,
    build: () => {
      calls.build += 1
      window = new FakeWindow()
      shell.watch(window)
      return window
    },
    reveal: (target) => { calls.reveal += 1; target.show(); target.focus() },
    quit: () => { calls.quit += 1 },
    busy: () => busy,
    ready: () => ready,
    notice: {
      marker: () => marker,
      show: async (options) => { asked.push(options); return { response: answer } },
    },
    // Without a tray the close asks whether the app should end.
    fallback: { show: async (options) => { questions.push(options); return { response: fallbackAnswer } } },
    log: { warn: () => {} },
  })
  shell.install()
  shell.watch(window)
  return {
    shell,
    app,
    powerMonitor,
    trays,
    menus,
    calls,
    asked,
    questions,
    marker,
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
    window: () => window,
    close: () => {
      let prevented = false
      shell.close({ preventDefault: () => { prevented = true } })
      return prevented
    },
  }
}

describe('the window and the tray', () => {
  test('a normal close hides the window; the app goes on', (t) => {
    const app = harness()
    t.after(app.cleanup)
    assert.equal(app.close(), true, 'the close is held')
    assert.equal(app.window().visible, false, 'the window is hidden')
    assert.equal(app.calls.quit, 0, 'the app is still running')
  })

  test('the first close asks once, and a cancelled answer leaves the window visible', async (t) => {
    const app = harness({ acknowledged: false, answer: -1 })
    t.after(app.cleanup)
    app.close()
    await settle()
    assert.equal(app.asked.length, 1, 'the notice is shown')
    assert.equal(app.asked[0].cancelId, -1, 'the notice can be called off')
    assert.equal(app.window().visible, true, 'the window stays where it is')
    assert.equal(app.calls.quit, 0, 'the app is still running')
  })

  test('an answered notice hides the window and is remembered', async (t) => {
    const app = harness({ acknowledged: false })
    t.after(app.cleanup)
    app.close()
    await settle()
    assert.equal(app.window().visible, false, 'the window is hidden')
    assert.equal(existsSync(app.marker), true, 'the answer is kept')
    // The next close hides the window without another box.
    app.close()
    await settle()
    assert.equal(app.asked.length, 1, 'the notice is not shown again')
    assert.equal(app.window().visible, false)
  })

  test('two closes while the box is open ask once', async (t) => {
    const app = harness({ acknowledged: false })
    t.after(app.cleanup)
    app.close()
    app.close()
    await settle()
    assert.equal(app.asked.length, 1, 'the notice is shown once')
  })

  test('a close during an import or a data move ends the app instead of hiding', async (t) => {
    const app = harness({ busy: true })
    t.after(app.cleanup)
    app.close()
    assert.equal(app.calls.quit, 1, 'the copy is cancelled and the app ends')
    assert.equal(app.asked.length, 0, 'the notice is not shown')
    assert.equal(app.window().visible, true, 'the window is not hidden')
  })

  test('the tray opens the window again', (t) => {
    const app = harness()
    t.after(app.cleanup)
    app.close()
    assert.equal(app.window().visible, false)
    app.trays[0].click()
    assert.equal(app.window().visible, true, 'the window is back')
    assert.equal(app.window().focused, 1, 'the window has the focus')
    assert.equal(app.calls.build, 0, 'the window was not built again')
  })

  test('a window that is gone for good is built anew, and the app does not end', (t) => {
    const app = harness()
    t.after(app.cleanup)
    app.window().destroyed = true
    app.trays[0].click()
    assert.equal(app.calls.build, 1, 'a new window takes its place')
    assert.equal(app.calls.quit, 0, 'the app goes on')
  })

  test('before the first run has chosen its places there is no window to show', (t) => {
    const app = harness({ ready: false })
    t.after(app.cleanup)
    app.window().destroyed = true
    app.trays[0].click()
    assert.equal(app.calls.build, 0, 'no window is built while the app starts')
  })

  test('the tray quits the app once', (t) => {
    const app = harness()
    t.after(app.cleanup)
    const menu = app.menus.at(-1)
    assert.equal(menu[0].label, 'Open')
    assert.equal(menu.at(-1).label, 'Quit')
    menu.at(-1).click()
    menu.at(-1).click()
    assert.equal(app.calls.quit, 1, 'the app ends once')
  })

  test('without a tray the close keeps the window in the task bar', async (t) => {
    const app = harness({ trayFails: true })
    t.after(app.cleanup)
    assert.equal(app.shell.hasTray(), false)
    app.close()
    await settle()
    assert.equal(app.window().minimized, true, 'the window stays reachable')
    assert.equal(app.calls.quit, 0, 'the app does not end')
  })

  test('without a tray the close asks whether the app should end', async (t) => {
    const app = harness({ trayFails: true, fallbackAnswer: 0 })
    t.after(app.cleanup)
    app.close()
    await settle()
    assert.equal(app.questions.length, 1, 'the question is asked')
    assert.match(app.questions[0].message, /system tray/u, 'the question says why')
    assert.equal(app.calls.quit, 1, 'the app ends when the user says so')
  })

  test('without a tray a called-off question leaves the app alone', async (t) => {
    const app = harness({ trayFails: true, fallbackAnswer: 1 })
    t.after(app.cleanup)
    app.close()
    await settle()
    assert.equal(app.questions.length, 1, 'the question is asked')
    assert.equal(app.calls.quit, 0, 'the app goes on')
  })

  test('a refused quit leaves the tray at work', (t) => {
    const app = harness()
    t.after(app.cleanup)
    app.shell.beginQuit()
    app.shell.cancelQuit()
    const menu = app.menus.at(-1)
    menu.at(-1).click()
    assert.equal(app.calls.quit, 1, 'the tray ends the app')
  })

  test('no window closed does not end the app', (t) => {
    const app = harness()
    t.after(app.cleanup)
    app.app.emit('window-all-closed')
    assert.equal(app.calls.quit, 0, 'the app stays in the tray')
  })

  test('the end of the Windows session lets the window close', (t) => {
    const app = harness({ platform: 'win32' })
    t.after(app.cleanup)
    app.window().emit('session-end')
    assert.equal(app.close(), false, 'the window closes for good')
    assert.equal(app.window().visible, true, 'the window is not hidden')
  })

  test('a cancelled macOS shutdown leaves the app running', (t) => {
    const app = harness({ platform: 'darwin' })
    t.after(app.cleanup)
    app.powerMonitor.emit('shutdown')
    assert.equal(app.close(), false, 'the window closes for good')
    // Another application called the shutdown off; the user comes back to the window.
    app.window().emit('focus')
    assert.equal(app.close(), true, 'the window hides again')
    assert.equal(app.window().visible, false)
  })

  test('on macOS the Dock icon opens the window, and a fullscreen window leaves fullscreen first', (t) => {
    const app = harness({ platform: 'darwin' })
    t.after(app.cleanup)
    app.close()
    assert.equal(app.window().visible, false)
    app.app.emit('activate')
    assert.equal(app.window().visible, true, 'the window is back')

    const window = app.window()
    window.fullScreen = true
    app.close()
    assert.equal(window.fullScreen, false, 'the window left fullscreen')
    assert.equal(window.visible, false, 'the window is hidden after it')
  })

  test('the tray of macOS has no click of its own; its menu is the way back', (t) => {
    const app = harness({ platform: 'darwin' })
    t.after(app.cleanup)
    app.trays[0].click()
    assert.equal(app.calls.reveal, 0, 'the click does not open the window')
    app.menus.at(-1)[0].click()
    assert.equal(app.calls.reveal, 1, 'the menu opens it')
  })

  test('a window that is opened again while it leaves fullscreen stays', (t) => {
    const app = harness({ platform: 'darwin' })
    t.after(app.cleanup)
    const window = app.window()
    window.fullScreen = true
    window.deferFullScreen = true
    app.close()
    assert.equal(window.visible, true, 'the window waits for the fullscreen to end')
    // The tray opens the window again before the fullscreen has ended.
    app.menus.at(-1)[0].click()
    assert.equal(window.visible, true, 'the window is back')
    window.emit('leave-full-screen')
    assert.equal(window.visible, true, 'the window is not hidden after all')
  })
})
