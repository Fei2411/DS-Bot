import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app } from './helpers/fake-electron.mjs'
import { startApp, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
Object.defineProperty(process, 'platform', { value: 'win32' })

before(async () => {
  await startApp()
  await waitFor(() => window() !== undefined, 'open the window')
})

test('the packaged main window handles zoom before the page receives the key', () => {
  assert.equal(app.isPackaged, true)
  const contents = window().webContents
  let level = 0
  let prevented = 0
  contents.getZoomLevel = () => level
  contents.setZoomLevel = value => { level = value }
  const press = change => contents.emit('before-input-event', { preventDefault: () => { prevented++ } }, { type: 'keyDown', control: true, key: '=', ...change })
  press({})
  assert.equal(level, 0.5)
  press({ key: '+', shift: true, isAutoRepeat: true })
  assert.equal(level, 1)
  press({ key: '-', code: 'NumpadSubtract' })
  assert.equal(level, 0.5)
  press({ key: '0' })
  assert.equal(level, 0)
  assert.equal(prevented, 4)
  press({ type: 'keyUp' })
  press({ control: false })
  press({ alt: true })
  press({ key: 'x' })
  assert.equal(level, 0)
  assert.equal(prevented, 4)
})

test('the app ends', async () => {
  app.quit()
})
